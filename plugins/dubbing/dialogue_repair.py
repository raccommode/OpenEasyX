"""Recover speech missed by the cinematic separator, before speaker assignment."""
from dataclasses import dataclass, replace
from functools import cache
from zipfile import ZipFile

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from model_assets import verified_asset
from runtime import progress, save_json


def event_classifier():
    from ai_edge_litert.interpreter import Interpreter
    url = "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite"
    path = verified_asset("yamnet", "yamnet.tflite", url, 4_126_810,
                          "4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf", label="YAMNet")
    with ZipFile(path) as archive:
        labels = archive.read("yamnet_label_list.txt").decode().splitlines()
    indices = [labels.index(label) for label in ("Speech", "Music", "Singing", "Choir", "Chant",
                                                  "Child singing", "Synthetic singing", "Rapping")]
    model = Interpreter(str(path), num_threads=1)
    model.allocate_tensors()
    source = model.get_input_details()[0]["index"]
    output = model.get_output_details()[0]["index"]

    def score(audio):
        # The release accepts exactly 975 ms of mono audio at 16 kHz.
        scores = []
        for i in range(0, max(1, len(audio)-7800), 3900):
            block = audio[i:i+15600]
            model.set_tensor(source, np.pad(block, (0, 15600-len(block))))
            model.invoke()
            scores.append(model.get_tensor(output)[0, indices])
        values = np.asarray(scores)
        speech, music, singing = values[:, 0], values[:, 1], values[:, 2:].max(axis=1)
        eligible = (speech >= .24) & (speech > 2*music) & (speech > 3*singing)
        return float(speech[eligible].max(initial=0)), float(music.max()), float(singing.max())
    return score


def vad_ranges(signal):
    from faster_whisper.vad import get_speech_timestamps
    return [(s["start"]/16000, s["end"]/16000) for s in get_speech_timestamps(
        signal, threshold=.45, min_speech_duration_ms=120, min_silence_duration_ms=160, speech_pad_ms=50)]


def source_ranges(signal):
    spans = vad_ranges(signal)
    # Silero carries recurrent state. Its long view may overlook a quiet
    # reply following a loud passage. Re-evaluate the same samples in
    # overlapping short contexts before applying any source edits.
    window, hop = 12*16000, 6*16000
    if len(signal) > window:
        for start in range(0, len(signal)-hop, hop):
            clip = signal[start:start+window]
            offset = start/16000
            for first, last in vad_ranges(clip):
                middle = (first+last)/2
                if (start and middle < 1.) or (start+len(clip) < len(signal) and middle > 11.):
                    continue
                spans.append((first+offset, last+offset))
    distinct = []
    for first, last in sorted(spans):
        if not distinct or abs(first-distinct[-1][0]) > .12 or abs(last-distinct[-1][1]) > .12:
            distinct.append((first, last))
    return distinct


def cut(first, last, rate):
    return slice(max(0, round(first*rate)), max(0, round(last*rate)))


@dataclass(frozen=True)
class Word:
    text: str
    language: str
    start: float
    end: float
    confidence: float

    def matches(self, other):
        token = lambda s: "".join(c for c in s.casefold() if c.isalnum())
        return (self.language == other.language and token(self.text) == token(other.text) and
                abs((self.start+self.end-other.start-other.end)/2) <= .65)

    def corroborates(self, other):
        # Two weak guesses on the same breath can coincide. A transcript
        # landmark needs one clear reading plus the independent repeat.
        return max(self.confidence, other.confidence) >= .78 and self.matches(other)

    def shifted(self, offset):
        return replace(self, start=self.start+offset, end=self.end+offset)


def lexical_times(recognizer, signal, first, last, pad):
    start = max(0, first-pad)
    audio = signal[cut(start, last+pad, 16000)]
    segments, info = recognizer.transcribe(audio, beam_size=4, temperature=0., word_timestamps=True,
                                            condition_on_previous_text=False, max_new_tokens=96)
    result = []
    for seg in segments:
        if seg.no_speech_prob >= .65 or seg.avg_logprob < -1.1:
            continue
        for word in seg.words or []:
            u, v = start+word.start, start+word.end
            token = "".join(c for c in word.word.casefold() if c.isalnum())
            if token and .025 < v-u < 2.1 and v >= first-.35 and u <= last+.35 and word.probability >= .60:
                result.append(Word(word.word.strip(), info.language, float(u), float(v), float(word.probability)))
    return result


def confirmed_words(short, context, strong_evidence):
    accepted, corroborated = [], []
    for words, other in ((short, context), (context, short)):
        for word in words:
            repeats = [w for w in other if word.corroborates(w)]
            if repeats:
                accepted.append(word)
                best = max([word, *repeats], key=lambda w: w.confidence)
                if best not in corroborated:
                    corroborated.append(best)
            elif strong_evidence and word.confidence >= .88:
                accepted.append(word)
    return accepted, corroborated


def rescue_words(signal, group, decode_window, evidence):
    # A 30 ms change in VAD bounds can move a faint word in or out of
    # Whisper's first mel frames. Cross-check fixed-duration, overlapping
    # windows on a clock independent of the VAD segmentation.
    first, last = group[0][0], group[-1][1]
    checked = set()
    for lo, hi, (speech, music, singing) in sorted(group, key=lambda item: -item[2][0]):
        if speech < .55 or max(music, singing) > .05:
            continue
        anchor = int((lo+hi)/2 - 1.5)
        for start, leveled in ((anchor, True), (anchor+.5, True), (anchor+1, False), (anchor-.5, False)):
            start = max(0., start)
            key = start, leveled
            if key in checked or start*16000 >= len(signal):
                continue
            if len(checked) >= 8:
                return []
            checked.add(key)
            window = decode_window(start, leveled)
            words = [w.shifted(start) for w in window if
                     w.end+start >= first-.2 and w.start+start <= last+.2 and
                     any(w.end+start >= a-.35 and w.start+start <= b+.35 for a, b, _ in group)]
            _, matches = confirmed_words(words, evidence, False)
            if matches:
                return matches
            evidence = [*evidence, *words]
    return []


def repair_channel(original, base, rate, classifier, denoiser, recognizer, landmarks):
    from enhance import enhance_speech
    residual = original-base
    x = resample_poly(original, 16000, rate)
    v = resample_poly(base, 16000, rate)
    candidates = []
    for left, right in source_ranges(x-v):
        sl = cut(left, right, 16000)
        power = np.sum(x[sl]**2)
        if power < 1e-8 or np.sum(x[sl]*v[sl]) >= .22*power:
            continue
        scores = classifier()(x[cut(left-.30, right+.30, 16000)])
        if scores[0] <= 0:
            continue
        if candidates and left <= candidates[-1][1]:
            previous, prior_end, prior = candidates[-1]
            candidates[-1] = (previous, max(right, prior_end), tuple(max(a, b) for a, b in zip(scores, prior)))
        else:
            candidates.append((left, right, scores))
    if not candidates:
        return
    @cache
    def decode_window(start, leveled):
        audio = x[cut(start, start+3., 16000)]
        if leveled:
            gain = np.clip(.20/max(1e-4, np.quantile(np.abs(audio), .996)), 1., 12.)
            audio = audio*np.float32(gain)
        return lexical_times(recognizer(), audio, 0, len(audio)/16000, 0)

    groups = []
    for entry in candidates:
        if groups and entry[0]-groups[-1][-1][1] < 1.30 and entry[1]-groups[-1][0][0] < 6.5:
            groups[-1].append(entry)
        else:
            groups.append([entry])
    for index, group in enumerate(groups):
        left, right = group[0][0], group[-1][1]
        short = lexical_times(recognizer(), x, left, right, .55)
        context = lexical_times(recognizer(), x, left, right, 3.5)
        words, corroborated = confirmed_words(short, context, max(s[0] for _, _, s in group) >= .50)
        if not corroborated:
            more = rescue_words(x, group, decode_window, short + context)
            words.extend(more)
            corroborated.extend(more)
        if not words:
            continue
        # Enhance only a corroborated region plus acoustic model context. The
        # estimator works on the residual, so existing speech stays intact.
        start = max(0, round((left-1.5)*rate))
        stop = min(len(original), round((right+1.5)*rate))
        h = enhance_speech(denoiser(), residual[start:stop, None], rate)[:, 0]
        # Neighbouring long groups can share denoiser context. Each output
        # sample belongs to one group even when both confirm a boundary word.
        previous = (groups[index-1][-1][1]+left)/2 if index else 0
        following = (right+groups[index+1][0][0])/2 if index+1 < len(groups) else len(original)/rate
        weight = np.zeros(len(h), dtype="float32")
        direct = np.zeros_like(weight)
        regions = group
        quiet_short_turn = right-left < 2.7 and max(max(scores[1:]) for _, _, scores in group) < .035
        if quiet_short_turn:
            # Whisper can place a faint short word on its stressed vowel.
            # Its other syllables may form separate VAD islands in the same
            # quiet solo turn. Preserve the intervening articulation as well.
            regions = [(left, right, (1., 0., 0.))]
        for a, b, (_, music, singing) in regions:
            for word in words:
                u, z = word.start, word.end
                if z < a-.85 or u > b+.85:
                    continue
                first, last = a-.55, b+.38
                if not quiet_short_turn:
                    first, last = max(first, u-1.05), min(last, z+.62)
                first, last = max(start, round(max(previous, first)*rate)), min(stop, round(min(following, last)*rate))
                if last <= first:
                    continue
                sl = slice(first-start, last-start)
                raw = residual[first:last]
                if np.sum(raw*h[sl]) < .06*np.sum(raw*raw):
                    continue
                local = np.arange(last-first)
                fade = np.minimum(1., np.minimum(local, local[::-1])/(rate*.035))
                weight[sl] = np.maximum(weight[sl], fade)
                if music < .035 and singing < .035:
                    # A denoiser can suppress faint consonants in an otherwise
                    # speech-dominant room. Retain a small amount of the original
                    # waveform here only, where words and the event model agree.
                    direct[sl] = np.maximum(direct[sl], .20*fade)
        base[start:stop] += weight*h + direct*(residual[start:stop]-h)
        for word in corroborated:
            span = weight[cut(word.start-start/rate, word.end-start/rate, rate)]
            if np.sum(span) >= .6*(word.end-word.start)*rate:
                landmarks.append(word)


def repair_block(original, base, rate, classifier, denoiser, recognizer, landmarks=None):
    # A quiet voice in one channel can sit opposite loud music in another.
    # Keep evidence and edits independent, including on antiphase recordings.
    frozen = base.copy()
    if landmarks is None:
        landmarks = []
    for ch in range(original.shape[1]):
        if ch:
            # Codec/resampler roundoff is common even in a dual-mono source.
            # Check the entire channel before sharing inference so a short
            # distinct speaker is not lost in a long-term correlation score.
            index = np.argmax(np.abs(original[:, 0]))
            if original[index, 0] != 0:
                gain = original[index, ch]/original[index, 0]
                tolerance = max(1e-8, 3e-5*np.max(np.abs(original[:, ch])))
                if (np.max(np.abs(original[:, ch]-gain*original[:, 0])) < tolerance and
                        np.max(np.abs(frozen[:, ch]-gain*frozen[:, 0])) < tolerance):
                    base[:, ch] += gain*(base[:, 0]-frozen[:, 0])
                    continue
        if np.any(original[:, ch] != frozen[:, ch]):
            repair_channel(original[:, ch], base[:, ch], rate, classifier, denoiser, recognizer, landmarks)
    return base


def repair_dialogue(mix, cinematic, output, model_cache=None):
    from enhance import speech_enhancer
    from whisper_recognizer import WhisperRecognizer
    manifest = output.with_suffix(".words.json")
    if output.is_file() and manifest.is_file():
        return output
    # The word manifest marks a completed pair. A failed previous attempt
    # may leave only one file and must never make a new WAV appear complete.
    manifest.unlink(missing_ok=True)
    classifier = cache(event_classifier)
    denoiser = cache(speech_enhancer)
    recognizer = cache(lambda: WhisperRecognizer(model_cache))
    partial = output.with_suffix(".partial.wav")
    progress("Checking the soundtrack for missed dialogue", 13)
    try:
        with sf.SoundFile(mix) as src, sf.SoundFile(cinematic) as base, sf.SoundFile(
                partial, "w", samplerate=src.samplerate, channels=src.channels, format="RF64", subtype="FLOAT") as dst:
            rate = src.samplerate
            tail = None
            words = []
            for left in range(0, len(src), 24*rate):
                right = min(len(src), left+24*rate)
                start, stop = max(0, left-4*rate), min(len(src), right+4*rate)
                src.seek(start)
                base.seek(start)
                block = src.read(stop-start, dtype="float32", always_2d=True)
                stem = base.read(stop-start, dtype="float32", always_2d=True)
                local = []
                repaired = repair_block(block, stem, rate, classifier, denoiser, recognizer, local)
                for word in local:
                    shifted = word.shifted(start/rate)
                    if left <= (shifted.start+shifted.end)*rate/2 < right:
                        words.append(shifted)
                current = repaired[left-start:right-start]
                if tail is not None:
                    n = min(len(tail), len(current))
                    fade = (.5-.5*np.cos(np.pi*(np.arange(n)+.5)/n)).astype("float32")[:, None]
                    current[:n] = tail[:n] + fade*(current[:n]-tail[:n])
                dst.write(current)
                tail = repaired[right-start:right-start+round(.12*rate)].copy()
                progress("Checking the soundtrack for missed dialogue", 13 + 2*right/len(src))
        # Select the most confident timestamp for a word found on two channels
        # or at a read boundary. Keep repetitions with disjoint time spans.
        unique = []
        for word in sorted(words, key=lambda w: w.start):
            duplicate = None
            for i in range(len(unique)-1, -1, -1):
                previous = unique[i]
                if previous.start < word.start-2.1:
                    break
                if word.matches(previous) and min(word.end, previous.end) > max(word.start, previous.start):
                    duplicate = i
                    break
            if duplicate is None:
                unique.append(word)
            elif word.confidence > unique[duplicate].confidence:
                unique[duplicate] = word
        partial.replace(output)
        save_json(manifest, [vars(w) for w in sorted(unique, key=lambda w: w.start)])
    finally:
        partial.unlink(missing_ok=True)
    return output
