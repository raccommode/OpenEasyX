"""Collect short, transcribed examples of one original speaker at a time."""
import base64
import io
import json
import os
import subprocess
from functools import cached_property

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from dialogue import diarizer, embedding, spans
from enhance import enhance_speech, speech_enhancer
from runtime import whisper_device


RATE = 24000


def profile(samples, text, language, confidence, extractor):
    """Verify different parts of the phrase, then keep one lossless copy for conditioning."""
    duration = len(samples) / RATE
    if not 1.9 <= duration <= 8.5 or not text.strip() or not any(c.isalnum() for c in text):
        return None
    samples = np.asarray(samples, dtype='float32')
    peak = np.max(abs(samples))
    if not np.isfinite(samples).all() or peak < .001 or np.mean(abs(samples) > .995) > .01:
        return None
    at16 = resample_poly(samples, 2, 3)
    levels = np.sqrt(np.mean(at16[:len(at16)//320*320].reshape(-1, 320)**2, axis=1))
    active = levels > max(.00025, np.percentile(levels, 90)*.065)
    if active.mean() < .48:
        return None
    # Split at the middle of the voiced material so a long pause doesn't become a verifier.
    split = (np.flatnonzero(active)[sum(active)//2]+1)*320
    vectors = [embedding(extractor, piece) for piece in (at16, at16[:split], at16[split:])]
    if any(v is None or not np.isfinite(v).all() for v in vectors):
        return None
    full, first, last = vectors
    if min(full@first, full@last) < .58 or first@last < .34:
        return None
    encoded = io.BytesIO()
    sf.write(encoded, samples*.78/peak, RATE, format="FLAC", subtype="PCM_16")
    quality = (.36*min(1., duration/4.5) + .24*active.mean()
               + .20*max(0., min(1., confidence)) + .20*max(0., float(first@last)))
    return dict(text=text.strip(), language=language, duration=duration, quality=float(quality),
                vectors=np.stack(vectors).round(6).tolist(), audio=base64.b64encode(encoded.getvalue()).decode('ascii'))


def decode(sample):
    return sf.read(io.BytesIO(base64.b64decode(sample["audio"])), dtype="float32")[0]


def original_audio(path):
    info = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_streams", "-show_format", "-of", "json", str(path)],
        timeout=12, stderr=subprocess.DEVNULL))
    streams = info.get("streams", [])
    eligible = []
    for stream in streams:
        flags = stream.get("disposition", {})
        tags = stream.get("tags", {})
        label = " ".join(str(tags.get(k, "")) for k in ("title", "handler_name")).casefold()
        if not any(flags.get(k) for k in ("dub", "comment", "descriptions", "visual_impaired")) and not any(
                word in label for word in ("dubbed", "doublage", "commentary", "audio description")):
            eligible.append(stream)
    duration = float(info.get("format", {}).get("duration") or 0.)
    if not eligible or not np.isfinite(duration) or duration < 2:
        return None
    chosen = max(eligible, key=lambda s: s.get("disposition", {}).get("original", 0))
    return chosen["index"], duration, any(s["index"] == streams[0]["index"] for s in eligible)


def read_window(path, stream, start, length, rate):
    raw = subprocess.check_output(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", str(start), "-i", str(path), "-map", f"0:{stream}",
         "-t", str(length), "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"],
        timeout=25, stderr=subprocess.DEVNULL)
    return np.frombuffer(raw, dtype=np.float32)


def speech_windows(path, stream, duration):
    if duration <= 45:
        return [(0., duration)]
    if duration <= 81:
        return [(p*(duration-15), 15.) for p in (.12, .49, .86)]
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    options = VadOptions(min_speech_duration_ms=200, min_silence_duration_ms=150, speech_pad_ms=0)
    windows = []
    # Four-second scouts cost at most 36 s of low-rate decoding. Look in each third
    # of a long recording rather than assuming the opening credits contain speech.
    for group in range(3):
        best, best_at = -1, (group+.5)*duration/3
        for frac in (.18, .50, .82):
            center = (group+frac)*duration/3
            scout = read_window(path, stream, max(0, center-2.), 4., 16000)
            if len(scout) < 3200:
                continue
            intervals = get_speech_timestamps(scout, vad_options=options)
            speech = sum(z["end"]-z["start"] for z in intervals)
            if speech > best:
                best, best_at = speech, center
        windows.append((max(0., min(duration-15, best_at-7.5)), 15.))
    return windows


def transcribed_phrases(chunks, clean):
    """Keep adjacent ASR segments from a single solo turn, clipped to real audio boundaries."""
    groups = []
    for chunk in chunks:
        a = max(0, round(chunk.start*RATE))
        z = min(len(clean), round(chunk.end*RATE))
        if chunk.avg_logprob < -.85 or chunk.no_speech_prob > .45 or z-a < .12*RATE or not chunk.text.strip():
            continue
        if groups and 0 <= a-groups[-1][1] <= .35*RATE and z-groups[-1][0] <= 8.5*RATE:
            first, _, text, confidence = groups.pop()
            groups.append((first, z, text+" "+chunk.text.strip(), min(confidence, np.exp(chunk.avg_logprob))))
        else:
            groups.append((a, z, chunk.text.strip(), np.exp(chunk.avg_logprob)))
    return [(clean[a:z], text, confidence) for a, z, text, confidence in groups if z-a >= .8*RATE]


class VoiceSampler:
    def __init__(self, model_cache):
        self.model_cache = model_cache

    @cached_property
    def speaker_models(self):
        return diarizer()

    @cached_property
    def enhancer(self):
        return speech_enhancer()

    @cached_property
    def recognizer(self):
        from faster_whisper import WhisperModel
        device = whisper_device()
        return WhisperModel(os.environ.get("EASYX_WHISPER_MODEL", "small"), device=device,
                            compute_type="float16" if device == "cuda" else "int8", cpu_threads=2,
                            download_root=str(self.model_cache))

    def from_work(self, work, cues):
        """Use complete solo turns. The existing per-clip prompt stays available as fallback."""
        voices = {}
        # Keep the test for competing speakers linear in the number of cue boundaries.
        turns = [(round(c["start"]*1000), round(c["end"]*1000), c["speaker"]) for c in cues]
        contested = set()
        for start, end, active in spans(turns):
            if end-start > 80 and len({turns[i][2] for i in active}) > 1:
                contested.update(active)
        solo = {}
        for i, cue in enumerate(cues):
            if i not in contested and not cue.get("overlapping"):
                solo.setdefault(cue["speaker"], []).append(cue)
        speakers = sorted(solo, key=lambda k: sum(c["end"]-c["start"] for c in solo[k]), reverse=True)
        with sf.SoundFile(work/"mix.wav") as mix:
            for speaker in speakers[:16]:
                eligible = (c for c in solo[speaker] if 1.9 <= c["end"]-c["start"] <= 8.5)
                chosen = sorted(eligible, key=lambda c: abs(c["end"]-c["start"]-4.5))[:3]
                options = []
                for cue in chosen:
                    first, last = (round(cue[k]*mix.samplerate) for k in ("start", "end"))
                    left = max(0, first-mix.samplerate//4)
                    mix.seek(left)
                    original = mix.read(last-left+mix.samplerate//4, dtype="float32", always_2d=True)
                    clean = enhance_speech(self.enhancer, original, mix.samplerate)[first-left:last-left]
                    if not len(clean):
                        continue
                    channel = clean[:, np.argmax(np.mean(clean**2, axis=0))]
                    record = profile(resample_poly(channel, RATE, mix.samplerate), cue["text"], cue["language"],
                                     cue.get("languageProbability") or .65, self.speaker_models[1])
                    if record:
                        options.append(record)
                # A local diarization label shared by two acoustically different people
                # cannot be used as a reliable anchor for searching their other videos.
                if options and all(np.dot(a["vectors"][0], b["vectors"][0]) >= .52
                                   for i, a in enumerate(options) for b in options[i+1:]):
                    voices[str(speaker)] = max(options, key=lambda row: row["quality"])
        return voices

    def from_video(self, path):
        """Run diarization and recognition on at most 45 s selected across the recording."""
        track = original_audio(path)
        if not track:
            return {}
        stream, duration, _ = track
        clips, regions, offset = [], [], 0
        for start, length in speech_windows(path, stream, duration):
            samples = read_window(path, stream, start, length, RATE)
            if len(samples) < RATE*2:
                continue
            clips.extend([samples, np.zeros(RATE//2, dtype="float32")])
            regions.append((offset, offset+len(samples)))
            offset += len(samples)+RATE//2
        if not clips:
            return {}
        audio = np.concatenate(clips)
        at16 = resample_poly(audio, 2, 3)
        diarization, extractor = self.speaker_models
        turns = [(round(s.start*RATE), round(s.end*RATE), s.speaker) for s in diarization.process(at16).sort_by_start_time()]
        solo = {}
        for start, end, active in spans(turns):
            if len(active) != 1:
                continue
            speaker = turns[active[0]][2]
            for left, right in regions:
                a, z = max(start, left), min(end, right)
                if z-a >= .85*RATE:
                    solo.setdefault(speaker, []).append((a, z))
        result = {}
        # Bound recognition even in a crowd. A short scan's speaker labels never escape this file.
        for speaker in sorted(solo, key=lambda i: sum(z-a for a, z in solo[i]), reverse=True)[:6]:
            phrases = []
            for a, z in sorted(solo[speaker], key=lambda t: abs(min(10, (t[1]-t[0])/RATE)-5))[:3]:
                raw = audio[a:min(z, a+10*RATE)]
                clean = enhance_speech(self.enhancer, raw[:, None], RATE)[:, 0]
                if np.max(abs(clean)) < .001:
                    continue
                chunks, info = self.recognizer.transcribe(resample_poly(clean, 2, 3), beam_size=2,
                    condition_on_previous_text=False, max_new_tokens=48, no_repeat_ngram_size=3)
                for sample, text, confidence in transcribed_phrases(chunks, clean):
                    phrases.append((sample, text, info.language, confidence))
            # Conversational replies are often individually too short. Combine complete
            # replies only when their own utterance-level embeddings corroborate the diarizer.
            small = [p for p in phrases if len(p[0]) < 2.3*RATE]
            vectors = [embedding(extractor, resample_poly(p[0], 2, 3)) for p in small]
            for i, first in enumerate(small):
                for j in range(i+1, len(small)):
                    second = small[j]
                    if (first[2] == second[2] and first[1].casefold() != second[1].casefold() and
                            vectors[i] is not None and vectors[j] is not None and vectors[i]@vectors[j] >= .60):
                        wave = np.concatenate((first[0], np.zeros(round(.12*RATE), dtype="float32"), second[0]))
                        phrases.append((wave, first[1]+" "+second[1], first[2], min(first[3], second[3])))
            for samples, text, language, confidence in phrases:
                candidate = profile(samples, text, language, confidence, extractor)
                current = result.get(str(speaker))
                if candidate and (current is None or candidate["quality"] > current["quality"]):
                    result[str(speaker)] = candidate
        return result


def align_clone_reference(recognizer, samples, rate, language):
    """Align the clone prompt to words the recognizer finds in that same voice."""
    from speech_review import at16
    audio = at16(samples, rate)
    segments, _ = recognizer.transcribe(audio, language=language, beam_size=3, condition_on_previous_text=False,
                                        word_timestamps=True, max_new_tokens=128)
    candidates = []
    for segment in segments:
        words = segment.words or []
        if not words or segment.avg_logprob < -1.1 or segment.no_speech_prob > .75:
            continue
        start = max(0, round((words[0].start-.08)*rate))
        stop = min(len(samples), round((words[-1].end+.12)*rate))
        if stop-start < .5*rate:
            continue
        # A long pause inside a reference adds no conditioning information.
        # Prefer the phrase with the most confidently aligned spoken words.
        evidence = sum(word.probability for word in words)
        candidates.append((evidence, start, stop, segment.text.strip()))
    if not candidates:
        return None
    _, start, stop, text = max(candidates)
    sample = samples[start:stop]
    peak = np.max(abs(sample))
    if not text or peak < 1e-6:
        return None
    return sample * (.7/peak), text


def alternate_clone_reference(recognizer, cues, work, speaker):
    """Find an independent, solo recording of the same diarized speaker."""
    from speech_review import at16, speech_spans
    solo = [c for c in cues if c["speaker"] == speaker and not c.get("overlapping") and c.get("clip")
            and 1.2 <= c["end"]-c["start"] <= 12]
    for cue in sorted(solo, key=lambda c: abs(5-(c["end"]-c["start"])))[:3]:
        try:
            samples, rate = sf.read(work/cue["clip"], dtype="float32")
        except (OSError, RuntimeError):
            continue
        signal = at16(samples, rate)
        if sum(b-a for a, b in speech_spans(signal, 0, len(signal))) < 9600:
            continue
        aligned = align_clone_reference(recognizer, samples, rate, cue["language"])
        if aligned:
            audio, words = aligned
            return audio, rate, words
    return None
