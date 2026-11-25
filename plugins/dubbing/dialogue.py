"""Isolate film dialogue and transcribe each speaker on the original timeline."""
import json
import os
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.optimize import linear_sum_assignment
from scipy.signal import resample_poly

from cinematic import cinematic_separator, isolate_dialogue
from runtime import device, ffmpeg, model_path, progress, save_json, whisper_device


def separate_dialogue(source, work):
    mix, dialogue = work / "mix.wav", work / "dialogue-bandit-v2.wav"
    if dialogue.is_file() and mix.is_file():
        return mix, dialogue
    pending = work / "mix.partial.wav"
    ffmpeg("-i", source, "-map", "0:a:0", "-vn", "-ar", 44100, "-c:a", "pcm_f32le", "-rf64", "auto", pending)
    pending.replace(mix)
    partial = dialogue.with_suffix(".partial.wav")
    model = cinematic_separator()
    with sf.SoundFile(mix) as src, sf.SoundFile(partial, "w", samplerate=src.samplerate,
            channels=src.channels, subtype="FLOAT", format="RF64") as dst:
        hop, overlap = 6*src.samplerate, 2*src.samplerate
        tail = None
        for start in range(0, len(src), hop):
            src.seek(start)
            original = src.read(hop+overlap, dtype="float32", always_2d=True)
            speech = isolate_dialogue(model, original)
            if tail is not None:
                n = min(len(tail), len(speech))
                fade = (.5-.5*np.cos(np.pi*(np.arange(n)+.5)/n)).astype("float32")[:, None]
                speech[:n] = tail[:n]*(1-fade) + speech[:n]*fade
            final = start+len(original) == len(src)
            count = len(speech) if final else hop
            dst.write(speech[:count])
            progress("Separating dialogue from music and effects", 2 + 13*(start+count)/len(src))
            if final:
                break
            tail = speech[count:].copy()
    partial.replace(dialogue)
    return mix, dialogue


def embedding_config():
    import sherpa_onnx as so
    return so.SpeakerEmbeddingExtractorConfig(
        model=model_path("embedding", "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"), num_threads=2)


def diarizer():
    import sherpa_onnx as so
    embedding = embedding_config()
    segmentation = so.OfflineSpeakerSegmentationModelConfig(pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(
        model=model_path("segmentation", "model.onnx")), num_threads=2)
    cfg = so.OfflineSpeakerDiarizationConfig(segmentation=segmentation, embedding=embedding,
        clustering=so.FastClusteringConfig(num_clusters=-1, threshold=0.5), min_duration_on=0.22, min_duration_off=0.24)
    if not cfg.validate():
        raise RuntimeError("Invalid local speaker diarization models")
    return so.OfflineSpeakerDiarization(cfg), so.SpeakerEmbeddingExtractor(embedding)


def embedding(extractor, audio):
    stream = extractor.create_stream()
    stream.accept_waveform(16000, audio)
    stream.input_finished()
    if not extractor.is_ready(stream):
        return None
    vector = np.array(extractor.compute(stream))
    return vector / max(np.linalg.norm(vector), 1e-8)


def spans(turns):
    """Disjoint sample spans with the indices of all audible turns."""
    events = {}
    for idx, (left, right, _) in enumerate(turns):
        events.setdefault(left, []).append((idx, True))
        events.setdefault(right, []).append((idx, False))
    active = set()
    last = 0
    for pos in sorted(events):
        if active and pos > last:
            yield last, pos, sorted(active)
        for idx, start in events[pos]:
            if start:
                active.add(idx)
            else:
                active.discard(idx)
        last = pos


def separate_overlap(audio, count, cache):
    from speechbrain.inference.separation import SepformerSeparation
    from speechbrain.utils.fetching import FetchConfig
    if count not in (2, 3):
        raise ValueError(f"Detected {count} simultaneous speakers; local separation supports up to three at once")
    if count not in cache:
        name = f"speechbrain/sepformer-wsj0{count}mix"
        revision = "3a2826343a10e2d2e8a75f79aeab5ff3a2473531" if count == 2 else "21e78b44a378092c34fff32ba8e788a73584f474"
        local = Path(os.environ.get("EASYX_DUBBING_MODELS", "")) / name.split("/")[-1]
        source = str(local.resolve()) if (local/"hyperparams.yaml").is_file() else name
        cache[count] = SepformerSeparation.from_hparams(source=source, fetch_config=FetchConfig(revision=revision),
                savedir=str(Path(os.environ["HF_HOME"]) / f"sepformer-{count}-{revision[:8]}"), run_opts={"device": device()})
    original = resample_poly(audio, 1, 2).astype("float32")
    with torch.inference_mode():
        signals = cache[count].separate_batch(torch.from_numpy(original).unsqueeze(0).to(device()))[0].cpu().numpy()
    # SepFormer is trained with a scale-invariant loss. Restore the original
    # relative levels and polarity before splicing its output into each turn.
    gains = np.linalg.lstsq(signals, original[:len(signals)], rcond=1e-4)[0]
    return [resample_poly(channel * gain, 2, 1).astype("float32")[:len(audio)]
            for channel, gain in zip(signals.T, gains)]


def assign(candidates, known, threshold):
    """One-to-one matching; never assign two simultaneous voices to one identity."""
    if not candidates or not known:
        return {}
    keys, ids = list(candidates), list(known)
    scores = np.array([[np.dot(candidates[k], known[i]) for i in ids] for k in keys])
    rows, cols = linear_sum_assignment(-scores)
    return {keys[r]: ids[c] for r, c in zip(rows, cols) if scores[r, c] >= threshold}


def speaker_aliases(intervals, turns, vectors):
    """Merge fragmented labels only when their clean voices match and never co-occur."""
    groups = {speaker: {speaker} for _, _, speaker in turns}
    conflicts = set()
    for _, _, indices in intervals:
        active = [turns[i][2] for i in indices]
        conflicts.update((a, b) for a in active for b in active if a != b)
    pairs = sorted(((float(vectors[a] @ vectors[b]), a, b) for a in vectors for b in vectors if a < b),
                   reverse=True)
    for score, a, b in pairs:
        if score < .60:
            break
        if groups[a] == groups[b] or any((x, y) in conflicts for x in groups[a] for y in groups[b]):
            continue
        joined = groups[a] | groups[b]
        for label in joined:
            groups[label] = joined
    return {label: min(group) for label, group in groups.items()}


def speaker_direction(speech, mix):
    """Estimate channel gains from clean solo speech, independent of its level."""
    energy = np.sum(np.square(speech), dtype=np.float64)
    if energy < 1e-6:
        return None
    gains = np.einsum("t,tc->c", speech, mix, dtype=np.float64) / energy
    if not np.isfinite(gains).all() or gains.mean() < .05 or gains.min() < -.1*gains.max():
        return None
    gains = gains.clip(min=0)
    return gains / gains.mean()


def speaker_audio(samples, original, turns, extractor, global_vectors, separators):
    output = [samples[a:b].copy() for a, b, _ in turns]
    intervals = list(spans(turns))
    # The longest isolated phrase supplies the most reliable identity and pan.
    local_vectors, directions, solo_lengths = {}, {}, {}
    for a, b, indices in sorted(intervals, key=lambda s: s[0]-s[1]):
        speaker = turns[indices[0]][2]
        if len(indices) == 1 and b-a >= 6400 and speaker not in local_vectors:
            end = min(b, a+128000)
            vec = embedding(extractor, samples[a:end])
            if vec is not None:
                local_vectors[speaker] = vec
                solo_lengths[speaker] = end-a
                direction = speaker_direction(samples[a:end], original[a:end])
                if direction is not None:
                    directions[speaker] = direction
    aliases = speaker_aliases(intervals, turns, local_vectors)
    turns = [(a, b, aliases[s]) for a, b, s in turns]
    # Prefer a complete unaccompanied turn over the tail of an interrupted one.
    by_duration = sorted(local_vectors, key=solo_lengths.get)
    directions = {aliases[s]: directions[s] for s in by_duration if s in directions}
    local_vectors = {aliases[s]: local_vectors[s] for s in by_duration}
    overlapping = {idx for a, b, indices in intervals if len(indices) > 1 and b-a >= 1600 for idx in indices}
    for a, b, indices in intervals:
        if len(indices) == 1 and indices[0] in overlapping:
            # Suppression of a quiet talker can persist beyond the detected
            # overlap. Retain their words on the unaccompanied flank too.
            idx = indices[0]
            offset = turns[idx][0]
            output[idx][a-offset:b-offset] = (samples[a:b] + original[a:b].mean(axis=1)) * .5
        if len(indices) < 2 or b-a < 1600:
            continue
        speakers = [turns[i][2] for i in indices]
        # Voices panned to distinct directions can be isolated from the original
        # channels, even when the film dialogue model suppressed a quieter voice.
        if original.shape[1] >= len(speakers) and all(s in directions for s in speakers):
            matrix = np.stack([directions[s] for s in speakers])
            if np.linalg.cond(matrix) < 10:
                streams = np.einsum("tc,cs->ts", original[a:b], np.linalg.pinv(matrix))
                for idx, audio in zip(indices, streams.T):
                    offset = turns[idx][0]
                    output[idx][a-offset:b-offset] = audio
                continue
        # Include clean flanks for identity matching. Use the original mixture
        # here too, including speech which the cinematic separator missed.
        for left in range(a, b, 16000 * 8):
            right = min(b, left + 16000 * 8)
            pad_left = max(0, min(turns[i][0] for i in indices)-1600, left-32000)
            pad_right = min(len(samples), max(turns[i][1] for i in indices)+1600, right+32000)
            streams = separate_overlap(original[pad_left:pad_right].mean(axis=1), len(indices), separators)
            vectors = {n: vec for n, audio in enumerate(streams) if (vec := embedding(extractor, audio)) is not None}
            match = assign(vectors, {s: local_vectors[s] for s in speakers if s in local_vectors}, -1)
            unassigned = iter(s for s in speakers if s not in match.values())
            for n, audio in enumerate(streams):
                speaker = match[n] if n in match else next(unassigned)
                idx = indices[speakers.index(speaker)]
                offset = turns[idx][0]
                output[idx][left-offset:right-offset] = audio[left-pad_left:right-pad_left]
                if speaker not in local_vectors and n in vectors:
                    local_vectors[speaker] = vectors[n]
    identities = assign(local_vectors, global_vectors, 0.48)
    next_id = max(global_vectors, default=-1) + 1
    for _, _, speaker in turns:
        if speaker not in identities:
            identities[speaker] = next_id
            next_id += 1
        if speaker in local_vectors:
            global_vectors[identities[speaker]] = local_vectors[speaker]
    return [(a, identities[s], audio, directions[s].tolist() if s in directions else None, idx in overlapping)
            for idx, ((a, _, s), audio) in enumerate(zip(turns, output))]


def speaker_references(cues, work, output=None):
    from enhance import enhance_speech, speech_enhancer
    rate = 24000
    enhancer = None
    with sf.SoundFile(work/"mix.wav") as source:
        for speaker in {cue["speaker"] for cue in cues}:
            turns = [cue for cue in cues if cue["speaker"] == speaker]
            solo = [cue for cue in turns if not cue.get("overlapping")]
            candidates = solo if sum(c["end"]-c["start"] for c in solo) >= 2.5 else turns
            # Prefer complete, clean phrases. Keep their chronology and transcript
            # intact, including when a long turn is the only available example.
            candidates.sort(key=lambda c: (c["end"]-c["start"] <= 12, c["end"]-c["start"]), reverse=True)
            chosen, seconds = [], 0
            for cue in candidates:
                duration = cue["end"]-cue["start"]
                if chosen and seconds + duration > 12:
                    continue
                chosen.append(cue)
                seconds += duration
                if seconds >= 6:
                    break
            clips, texts = [], []
            for cue in sorted(chosen, key=lambda c: c["start"]):
                clip, sr = sf.read(work/cue["clip"], dtype="float32")
                if not cue.get("overlapping"):
                    if enhancer is None:
                        enhancer = speech_enhancer()
                    first = round(cue["start"]*source.samplerate)
                    last = min(len(source), round(cue["end"]*source.samplerate))
                    left = max(0, first-source.samplerate//4)
                    source.seek(left)
                    segment = source.read(last-left+source.samplerate//4, dtype="float32", always_2d=True)
                    enhanced = enhance_speech(enhancer, segment, source.samplerate)[first-left:last-left]
                    if enhanced.size and np.max(np.abs(enhanced)) > 1e-4:
                        # Use the microphone channel with the clearest speech.
                        strongest = np.argmax(np.mean(enhanced**2, axis=0))
                        clip, sr = enhanced[:, strongest], source.samplerate
                if clips:
                    clips.append(np.zeros(round(.1*rate), dtype="float32"))
                clips.append(resample_poly(clip, rate, sr))
                texts.append(cue["text"])
            reference = np.concatenate(clips)
            peak = np.max(np.abs(reference))
            if peak > 1e-6:
                reference *= .8 / peak
            sf.write((output or work)/f"speaker-{speaker}.wav", reference, rate)
            ((output or work)/f"speaker-{speaker}.txt").write_text(" ".join(texts))


def resolve_short_languages(cues, work, whisper):
    # A word or two often yields an uncertain language guess. Use evidence
    # from this speaker's longer conversation while allowing code switching.
    for speaker in {c["speaker"] for c in cues}:
        turns = [c for c in cues if c["speaker"] == speaker]
        votes = {}
        for cue in turns:
            confidence = cue.get("languageProbability")
            if confidence is None or confidence >= .5:
                code = cue["language"]
                votes[code] = votes.get(code, 0) + min(8, cue["end"]-cue["start"])
        if not votes:
            continue
        language = max(votes, key=votes.get)
        if votes[language] < 6 or votes[language] < .8 * sum(votes.values()):
            continue
        for cue in turns:
            if cue["language"] == language or cue["end"]-cue["start"] > 4:
                continue
            audio, _ = sf.read(work/cue["clip"], dtype="float32")
            # The turn-level guess can differ from this particular clip.
            # A high confidence for a different label does not confirm the turn label.
            detected, confidence, _ = whisper.detect_language(audio=audio)
            if detected == cue["language"] and confidence >= .65:
                continue
            if (cue.get("languageProbability") or 0) >= .8 and (detected != language or confidence < .65):
                continue
            chunks, _ = whisper.transcribe(audio, language=language, beam_size=2, condition_on_previous_text=False)
            words = " ".join(c.text.strip() for c in chunks if c.avg_logprob > -1 and c.no_speech_prob < .65).strip()
            if words:
                cue.update(text=words, language=language)


def transcribe(dialogue, work, model_cache):
    from faster_whisper import WhisperModel
    index = work / "speakers.json"
    cached = None
    if index.exists():
        result = json.loads(index.read_text())
        if all((work / f"speaker-{c['speaker']}.wav").is_file() and c.get("clip") and (work / c["clip"]).is_file() for c in result):
            if all("languageProbability" in c for c in result):
                return result
            cached = result
    backend = whisper_device()
    whisper = WhisperModel(os.getenv("EASYX_WHISPER_MODEL", "small"), device=backend,
                           compute_type="float16" if backend == "cuda" else "int8", cpu_threads=2, download_root=str(model_cache))
    if cached is not None:
        resolve_short_languages(cached, work, whisper)
        for cue in cached:
            cue.setdefault("languageProbability", None)
        speaker_references(cached, work)
        save_json(index, cached)
        return cached
    sd, extractor = diarizer()
    cues, voices, separators = [], {}, {}
    with sf.SoundFile(dialogue) as src, sf.SoundFile(work / "mix.wav") as mix:
        for start in range(0, len(src), 44100 * 180):
            src.seek(start)
            samples = resample_poly(src.read(44100*180, dtype="float32", always_2d=True).mean(axis=1), 160, 441).astype("float32")
            mix.seek(start)
            original = resample_poly(mix.read(44100*180, dtype="float32", always_2d=True), 160, 441, axis=0)
            # Retain quiet simultaneous voices in the diarization input even
            # when the cinematic separator classifies one of them as background.
            guide = (samples + original.mean(axis=1)) * .5
            segments = sd.process(guide).sort_by_start_time()
            turns = [(max(0, round(s.start*16000)), min(len(samples), round(s.end*16000)), s.speaker) for s in segments if s.end > s.start]
            turns_audio = speaker_audio(samples, original, turns, extractor, voices, separators)
            last_percent = -1
            for offset, speaker, audio, direction, overlapping in turns_audio:
                percent = int(15 + 12 * (start + offset * 44100 / 16000) / len(src))
                if percent > last_percent:
                    progress("Identifying and transcribing speakers", percent)
                    last_percent = percent
                if len(audio) < 1600:
                    continue
                chunks, info = whisper.transcribe(audio, beam_size=2, condition_on_previous_text=False)
                for chunk in chunks:
                    text = chunk.text.strip()
                    if not text or chunk.no_speech_prob > .65 and chunk.avg_logprob < -1:
                        continue
                    t0 = max(0, chunk.start)
                    t1 = min(len(audio)/16000, chunk.end)
                    if t1-t0 < .08:
                        continue
                    at = start/44100 + offset/16000
                    clip = f"turn-{len(cues)}.flac"
                    sf.write(work/clip, audio[round(t0*16000):round(t1*16000)], 16000)
                    cues.append(dict(start=at+t0, end=at+t1, speaker=speaker, language=info.language,
                                     languageProbability=info.language_probability, text=text, clip=clip,
                                     direction=direction, overlapping=overlapping))
            progress("Identifying and transcribing speakers", 15 + 12 * min(1, (start + len(samples)*44100/16000)/len(src)))
    cues.sort(key=lambda c: c["start"])
    resolve_short_languages(cues, work, whisper)
    speaker_references(cues, work)
    save_json(index, cues)
    return cues
