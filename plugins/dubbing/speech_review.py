"""Check suspect speaker transcripts against the original soundtrack before dubbing."""
import hashlib
import json
import math
import unicodedata

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


def source_window(source, cue, padding):
    rate = source.samplerate
    first = max(0, round((cue["start"] - padding) * rate))
    last = min(len(source), round((cue["end"] + padding) * rate))
    if first >= last:
        raise ValueError(f"No source audio available at {cue['start']:.2f}s")
    source.seek(first)
    block = source.read(last-first, dtype="float32", always_2d=True)
    channel = np.argmax(np.mean(block**2, axis=0))
    return at16(block[:, channel], rate), first/rate


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


def review_weak_turn(recognizer, original, separation, cue, isolated):
    # Whisper can confidently guess a word from a breath cut out of its context.
    # A word must also belong to this speaker's time slot in a contextual decode.
    # The separator can erase quiet speech completely, so check the original mix.
    previous = []
    crop, origin = source_window(original, cue, 0.)
    if not np.any(crop):
        return None, crop
    if cue.get("overlapping"):
        # The live mix contains other speakers. Only the separated turn can
        # corroborate that these words belong to this particular speaker.
        if not np.any(isolated):
            return None, isolated
        speaker_words = aligned_words(recognizer, isolated, cue["start"], cue)
        if not speaker_words[2]:
            return None, isolated
    contexts = set()
    for padding in (3.5, 6.):
        audio, first = source_window(original, cue, padding)
        identity = (first, len(audio))
        if identity in contexts:
            continue
        contexts.add(identity)
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
            checks.append(source_window(stem, cue, 3.5))
    for audio, first in checks:
        result = aligned_words(recognizer, audio, first, cue)
        for other in previous:
            repaired = matching_words(result, other)
            if repaired:
                return repaired, crop
    if all(result[2] for result in previous):
        raise ValueError(f"Could not recover a reliable source transcript at {cue['start']:.2f}s")
    return None, crop


def save_repair(cue, audio, work, stage, index):
    stage.mkdir(exist_ok=True)
    path = stage/f"recovered-{index}.flac"
    sf.write(path, audio*.75/max(float(np.max(np.abs(audio))), 1e-6), 16000)
    return dict(cue, clip=str(path.relative_to(work)))


def review_transcript(cues, work, model_cache, *, dialogue=None):
    """Keep legacy translation/WAV indices intact when a defective analysis changes."""
    from dialogue import speaker_references
    if not cues:
        return cues, work
    if dialogue is None:
        dialogue = work/"dialogue-bandit-v2.wav"
    fingerprint = hashlib.sha256(json.dumps([dialogue.name, cues], sort_keys=True).encode())
    landmarks = dialogue.with_suffix(".words.json")
    if landmarks.is_file():
        fingerprint.update(landmarks.read_bytes())
    for cue in cues:
        with (work/cue["clip"]).open("rb") as clip:
            fingerprint.update(hashlib.file_digest(clip, "sha256").digest())
    stage = work / ("verified-speech-v2-" + fingerprint.hexdigest()[:16])
    index = stage / "speakers.json"
    if index.is_file():
        try:
            cached = json.loads(index.read_text())
            if isinstance(cached, list) and all((work/c["clip"]).is_file() for c in cached):
                return cached, stage
        except (KeyError, TypeError, ValueError, UnicodeError):
            pass
    reviewed, touched, recognizer = [], set(), None
    # Whisper can emit a sequence of script-incompatible fragments in one
    # background sound. Keep the surrounding acoustic context for Silero.
    suspicious = [suspect_text(cue) for cue in cues]
    with sf.SoundFile(work/"mix.wav") as original:
        for i, cue in enumerate(cues):
            malformed = suspicious[i]
            clip, rate = sf.read(work/cue["clip"], dtype="float32")
            if not np.isfinite(clip).all():
                raise ValueError(f"Non-finite source audio at {cue['start']:.2f}s")
            peak = np.max(np.abs(clip), initial=0.)
            confidence = cue.get("languageProbability")
            duration = cue["end"]-cue["start"]
            weak = (peak <= .001 and confidence is not None and confidence < .6 and not malformed
                    and duration <= 3 and len(cue["text"].split()) <= 3)
            if weak or impossible_word_rate(cue["text"], duration):
                progress(f"Checking uncertain speech in context at {cue['start']:.2f}s", 28)
                if recognizer is None:
                    recognizer = whisper_model(model_cache)
                repair, audio = review_weak_turn(recognizer, original, dialogue, cue, at16(clip, rate))
                touched.add(cue["speaker"])
                if repair:
                    repaired = dict(cue, **repair)
                    if suspect_text(repaired) or impossible_word_rate(repair["text"], duration):
                        raise ValueError(f"Could not recover a reliable source transcript at {cue['start']:.2f}s")
                    reviewed.append(save_repair(repaired, audio, work, stage, i))
                continue
            if not malformed and peak > 0.:
                reviewed.append(cue)
                continue
            progress(f"Verifying source speech at {cue['start']:.2f}s", 28)
            start = round(cue["start"] * original.samplerate)
            stop = round(cue["end"] * original.samplerate)
            pad = round(.4 * original.samplerate)
            before = after = i
            if malformed:
                while (before > 0 and suspicious[before-1] and cues[before-1]["speaker"] == cue["speaker"]
                       and cues[before]["start"]-cues[before-1]["end"] <= .25
                       and cue["start"]-cues[before-1]["start"] < 12):
                    before -= 1
                while (after+1 < len(cues) and suspicious[after+1] and cues[after+1]["speaker"] == cue["speaker"]
                       and cues[after+1]["start"]-cues[after]["end"] <= .25
                       and cues[after+1]["end"]-cue["end"] < 12):
                    after += 1
            first = max(0, round(cues[before]["start"]*original.samplerate)-pad)
            last = round(cues[after]["end"]*original.samplerate)+pad
            original.seek(min(len(original), first))
            block = original.read(last-first, dtype="float32", always_2d=True)
            if not len(block):
                raise ValueError(f"No source audio available at {cue['start']:.2f}s")
            channel = np.argmax(np.mean(block**2, axis=0))
            raw = at16(block[:, channel], original.samplerate)
            left = round((start-first)*16000/original.samplerate)
            right = round((stop-first)*16000/original.samplerate)
            isolated = at16(clip, rate)
            has_isolated = speech_spans(isolated, 0, len(isolated))
            has_original = speech_spans(raw, left, right)
            if not has_isolated and not has_original and peak <= .001:
                # Two independent audio observations contradict a silent clip's
                # guessed transcript. Retain this interval's original soundtrack.
                touched.add(cue["speaker"])
                continue
            if has_isolated:
                audio = isolated
            elif has_original and not cue.get("overlapping"):
                audio = raw[left:right]
            else:
                raise ValueError(f"Could not verify the original speaker at {cue['start']:.2f}s")
            if recognizer is None:
                recognizer = whisper_model(model_cache)
            # For a malformed transcript redetect the language from the recording.
            # A zero-valued clip's provisional words can also be corroborated by
            # a fresh decode of the original speaker in the original language.
            expected = None if malformed else cue["language"]
            repaired = None
            for gain in dict.fromkeys([1., min(16., .4/max(float(np.max(np.abs(audio))), 1e-6))]):
                segments, info = recognizer.transcribe(audio*gain, language=expected, beam_size=3,
                                                       max_new_tokens=128, condition_on_previous_text=False)
                segments = list(segments)
                text = " ".join(s.text.strip() for s in segments).strip()
                if not text:
                    continue
                candidate = dict(cue, text=text, language=info.language, languageProbability=info.language_probability)
                if suspect_text(candidate):
                    continue
                same_words = not malformed and text.casefold().strip() == cue["text"].casefold().strip()
                corroborated = same_words and all(s.avg_logprob > -1.2 and s.no_speech_prob < .8 for s in segments)
                if corroborated or all(s.avg_logprob > -1 and s.no_speech_prob < .65 for s in segments):
                    repaired = candidate
                    break
            if (repaired is None and malformed and peak <= .001 and not has_isolated
                    and not speech_spans(raw, left, right, normalize=False)):
                # A brief VAD hit only after heavy gain can also be a sound
                # effect. Check the full acoustic context before ignoring it.
                context, _ = recognizer.transcribe(raw, beam_size=3, max_new_tokens=192,
                                                   condition_on_previous_text=False, word_timestamps=True)
                words = [w.word.strip() for s in context if s.avg_logprob > -1 and s.no_speech_prob < .65
                         for w in s.words or [] if w.probability >= .5
                         and any(a <= (w.start+w.end)*8000 < b for a, b in has_original)]
                if not words:
                    touched.add(cue["speaker"])
                    continue
            if repaired is None:
                raise ValueError(f"Could not recover a reliable source transcript at {cue['start']:.2f}s")
            reviewed.append(save_repair(repaired, audio, work, stage, i))
            touched.add(cue["speaker"])
    stage.mkdir(exist_ok=True)
    affected = [c for c in reviewed if c["speaker"] in touched]
    if affected:
        speaker_references(affected, work, stage)
    save_json(index, reviewed)
    return reviewed, stage
