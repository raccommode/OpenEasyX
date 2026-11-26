"""Check suspect speaker transcripts against the original soundtrack before dubbing."""
import hashlib
import json
import math
import unicodedata
from functools import cache

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from runtime import progress, save_json
from whisper_recognizer import WhisperRecognizer as whisper_model


def suspect_text(cue):
    from voices import LANGUAGES
    text = cue["text"]
    if not text.strip() or any(c == "\ufffd" or unicodedata.category(c) == "Cn" for c in text):
        return True
    # A low-confidence Latin-language guess consisting exclusively of another
    # script is worth checking acoustically. Confident code switches survive.
    letters = [c for c in text if c.isalpha()]
    language = LANGUAGES.get(cue["language"], {}).get("nllb", "")
    return (language.endswith("_Latn") and (cue.get("languageProbability") or 0) < .60
            and bool(letters) and not any("LATIN" in unicodedata.name(c, "") for c in letters))


def at16(samples, rate):
    div = math.gcd(rate, 16000)
    return resample_poly(samples, 16000//div, rate//div) if rate != 16000 else samples


def speech_spans(samples, start, end, *, normalize=True):
    if len(samples) == 0 or not np.isfinite(samples).all() or np.max(np.abs(samples)) < 1e-6:
        return []
    from faster_whisper.vad import get_speech_timestamps
    gain = min(64., .4 / np.max(np.abs(samples))) if normalize else 1.
    detected = get_speech_timestamps(samples * gain, threshold=.5, min_speech_duration_ms=100,
                                     min_silence_duration_ms=150, speech_pad_ms=0)
    return [(max(span["start"], start), min(span["end"], end)) for span in detected
            if min(span["end"], end) - max(span["start"], start) >= min(1280, (end-start)*.5)]


def original_channels(source, cue, padding):
    rate = source.samplerate
    first = max(0, round((cue["start"] - padding) * rate))
    last = min(len(source), round((cue["end"] + padding) * rate))
    if first >= last:
        raise ValueError(f"No source audio available at {cue['start']:.2f}s")
    source.seek(first)
    block = source.read(last-first, dtype="float32", always_2d=True)
    if not np.isfinite(block).all():
        raise ValueError(f"Non-finite source audio at {cue['start']:.2f}s")
    return block, first/rate


def source_window(source, cue, padding):
    block, start = original_channels(source, cue, padding)
    channel = np.argmax(np.mean(block**2, axis=0))
    return at16(block[:, channel], source.samplerate), start


def vocal_evidence(samples, get_classifier):
    if not len(samples) or np.ptp(samples) < 1e-6:
        return False
    spans = speech_spans(samples, 0, len(samples), normalize=False)
    # A momentary VAD hit alone also occurs on animal calls and transients.
    # For short interjections the speech classifier can corroborate the sound.
    voiced = sum(last-first for first, last in spans)
    if voiced >= min(8000, len(samples)*.5) or get_classifier()(samples)[0]:
        return True
    # When raising the level, require a speech event (excludes singing and
    # music) and an independent VAD hit on that same amplified waveform.
    gain = min(16., .4 / np.max(np.abs(samples)))
    if gain <= 1.:
        return False
    louder = samples*gain
    return bool(speech_spans(louder, 0, len(louder), normalize=False) and get_classifier()(louder)[0])


def may_contain_speech(original, cue, isolated, get_classifier):
    # The active microphone need not be the loudest channel. Check the cue
    # itself so speech outside its bounds cannot turn a sound effect into a line.
    block, _ = original_channels(original, cue, 0.)
    if not np.ptp(block, axis=0).any():
        return False
    if vocal_evidence(isolated, get_classifier):
        return True
    return any(vocal_evidence(at16(channel, original.samplerate), get_classifier) for channel in block.T)


def duplicate_overlap(cue, isolated, cues, work, get_classifier):
    # A phantom second speaker can be a short, leaked copy of a real line.
    # Require a separately transcribed, longer turn covering the entire clip.
    if not cue.get("overlapping") or not np.any(isolated):
        return False
    for other in cues:
        if (other["speaker"] == cue["speaker"] or other["start"] > cue["start"] or other["end"] < cue["end"]
                or other["end"]-other["start"] <= cue["end"]-cue["start"]
                or (other.get("languageProbability") or 0) < .8 or suspect_text(other)
                or impossible_word_rate(other["text"], other["end"]-other["start"])):
            continue
        with sf.SoundFile(work/other["clip"]) as track:
            offset = round((cue["start"]-other["start"])*track.samplerate)
            count = round(len(isolated)*track.samplerate/16000)
            if count <= 0 or offset + count > len(track):
                continue
            track.seek(offset)
            candidate = at16(track.read(count, dtype="float32"), track.samplerate)
        length = min(len(candidate), len(isolated))
        source = candidate[:length]
        target = isolated[:length]
        energy = np.dot(source, source)
        if energy < 1e-8:
            continue
        residual = target - source*(np.dot(target, source)/energy)
        # At least 84% of the power must be explained by the other voice. A
        # distinct quiet voice in the remainder still warrants preserving it.
        if np.dot(residual, residual) <= .16*np.dot(target, target) and not vocal_evidence(residual, get_classifier):
            return True
    return False


def aligned_words(recognizer, audio, origin, cue):
    segments, info = recognizer.transcribe(audio, beam_size=4, temperature=0., max_new_tokens=96,
                                           condition_on_previous_text=False, word_timestamps=True)
    words = []
    for segment in segments:
        if segment.avg_logprob < -1.1 or segment.no_speech_prob >= .65:
            continue
        for word in segment.words or []:
            start, end = origin + word.start, origin + word.end
            duration = end-start
            overlap = min(end, cue["end"]) - max(start, cue["start"])
            if duration <= 0 or overlap < duration*.6 or word.probability < .6:
                continue
            token = "".join(c for c in unicodedata.normalize("NFKC", word.word).casefold() if c.isalnum())
            if token:
                words.append((token, (start + end)/2, word.word))
    return info.language, info.language_probability, words


def matching_words(first, second):
    language, confidence, words = first
    if not words or language != second[0] or len(words) != len(second[2]):
        return None
    if any(a[0] != b[0] or abs(a[1]-b[1]) > .6 for a, b in zip(words, second[2])):
        return None
    return dict(text="".join(w[2] for w in words).strip(), language=language,
                languageProbability=max(confidence, second[1]))


def impossible_word_rate(text, duration):
    # Count lexical tokens, not punctuation. A single quick interjection and
    # unspaced writing systems must not trigger the fast-speech check.
    words = sum(any(ch.isalnum() for ch in token) for token in text.split())
    return words >= 3 and words > 10 * duration


def review_weak_turn(get_recognizer, original, separation, cue, isolated):
    # Whisper can confidently guess a word from a breath cut out of its context.
    # A word must also belong to this speaker's time slot in a contextual decode.
    # The separator can erase quiet speech completely, so check the original mix.
    previous = []
    crop, origin = source_window(original, cue, 0.)
    if not np.any(crop):
        return None, crop
    if cue.get("overlapping") and not np.any(isolated):
        return None, isolated
    recognizer = get_recognizer()
    if cue.get("overlapping"):
        # The live mix contains other speakers. Only the separated turn can
        # corroborate that these words belong to this particular speaker.
        speaker_words = aligned_words(recognizer, isolated, cue["start"], cue)
        if not speaker_words[2]:
            return None, isolated
    contexts = {}
    for padding in (3.5, 6.):
        audio, first = source_window(original, cue, padding)
        identity = (first, len(audio))
        if identity in contexts:
            continue
        contexts[identity] = audio
        result = aligned_words(recognizer, audio, first, cue)
        if cue.get("overlapping"):
            repaired = matching_words(result, speaker_words)
            if repaired:
                return repaired, isolated
            continue
        for other in previous:
            repaired = matching_words(result, other)
            if repaired:
                return repaired, crop
        previous.append(result)
    if not any(result[2] for result in previous):
        return None, crop
    # If the two contexts disagree, seek corroboration in the exact turn or
    # in the independently separated dialogue. Never count the same input twice.
    checks = []
    if (origin, len(crop)) not in contexts:
        checks.append((crop, origin))
    if separation.is_file():
        with sf.SoundFile(separation) as stem:
            audio, first = source_window(stem, cue, 3.5)
            same_window = contexts.get((first, len(audio)))
            if np.any(audio) and not np.array_equal(audio, same_window):
                checks.append((audio, first))
    for audio, first in checks:
        result = aligned_words(recognizer, audio, first, cue)
        for other in previous:
            repaired = matching_words(result, other)
            if repaired:
                return repaired, crop
    return None, crop


def save_repair(cue, audio, work, stage, index):
    stage.mkdir(exist_ok=True)
    path = stage/f"recovered-{index}.flac"
    sf.write(path, audio*.75/max(float(np.max(np.abs(audio))), 1e-6), 16000)
    return dict(cue, clip=str(path.relative_to(work)))


def review_transcript(cues, work, model_cache, *, dialogue=None):
    """Keep legacy translation/WAV indices intact when a defective analysis changes."""
    from dialogue import speaker_references
    from dialogue_repair import event_classifier
    if not cues:
        return cues, work
    if dialogue is None:
        dialogue = work/"dialogue-bandit-v2.wav"
    fingerprint = hashlib.sha256(json.dumps(["reviewed-original-intervals", dialogue.name, cues], sort_keys=True).encode())
    landmarks = dialogue.with_suffix(".words.json")
    if landmarks.is_file():
        fingerprint.update(landmarks.read_bytes())
    for cue in cues:
        with (work/cue["clip"]).open("rb") as clip:
            fingerprint.update(hashlib.file_digest(clip, "sha256").digest())
    stage = work / ("verified-speech-v3-" + fingerprint.hexdigest()[:16])
    index = stage / "speakers.json"
    if index.is_file():
        try:
            cached = json.loads(index.read_text())
            if isinstance(cached, list) and all((work/c["clip"]).is_file() for c in cached):
                return cached, stage
        except (KeyError, TypeError, ValueError, UnicodeError):
            pass
    reviewed, touched = [], set()
    get_recognizer = cache(lambda: whisper_model(model_cache))
    get_classifier = cache(event_classifier)
    with sf.SoundFile(work/"mix.wav") as original:
        for i, cue in enumerate(cues):
            clip, rate = sf.read(work/cue["clip"], dtype="float32")
            if not np.isfinite(clip).all():
                raise ValueError(f"Non-finite source audio at {cue['start']:.2f}s")
            peak = np.max(np.abs(clip), initial=0.)
            confidence = cue.get("languageProbability")
            duration = cue["end"]-cue["start"]
            weak = (peak <= .001 and confidence is not None and confidence < .6
                    and duration <= 3 and len(cue["text"].split()) <= 3)
            impossible = impossible_word_rate(cue["text"], duration)
            if peak > 0. and not (weak or suspect_text(cue) or impossible):
                reviewed.append(cue)
                continue
            # Words and language guessed from a zero-valued isolate are equally
            # unreliable. Redetect both on independently framed original audio.
            progress(f"Checking uncertain speech in context at {cue['start']:.2f}s", 28)
            isolated = at16(clip, rate)
            repair, audio = review_weak_turn(get_recognizer, original, dialogue, cue, isolated)
            touched.add(cue["speaker"])
            if repair:
                repaired = dict(cue, **repair)
                if not suspect_text(repaired) and not impossible_word_rate(repaired["text"], duration):
                    reviewed.append(save_repair(repaired, audio, work, stage, i))
                    continue
            if impossible and duplicate_overlap(cue, isolated, cues, work, get_classifier):
                continue
            if may_contain_speech(original, cue, isolated, get_classifier):
                progress(f"Keeping unverified original speech at {cue['start']:.2f}–{cue['end']:.2f}s", 28)
                reviewed.append(dict(cue, text="", preserveOriginal="unverified-source"))
    stage.mkdir(exist_ok=True)
    affected = [c for c in reviewed if c["speaker"] in touched and not c.get("preserveOriginal")]
    if affected:
        speaker_references(affected, work, stage)
    save_json(index, reviewed)
    return reviewed, stage
