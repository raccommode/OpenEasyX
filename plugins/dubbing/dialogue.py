"""Isolate film dialogue and transcribe each speaker on the original timeline."""
import gc
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.optimize import linear_sum_assignment
from scipy.signal import resample_poly

from cinematic import cinematic_separator, isolate_dialogue
from inference_memory import cuda_allocation_failed, free_cuda_bytes, release_models
from runtime import device, ffmpeg, model_path, progress, save_json
from whisper_recognizer import WhisperRecognizer


def separate_dialogue(source, work, model_cache=None):
    from dialogue_repair import repair_dialogue
    mix, cinematic = separate_cinematic(source, work)
    # Return the separator's GPU workspace before CTranslate2 checks for
    # enough free memory to verify words in the remaining soundtrack.
    release_models()
    return mix, repair_dialogue(mix, cinematic, work/"dialogue-repaired-v2.wav", model_cache)


def separate_cinematic(source, work):
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
            progress("Separating dialogue from music and effects", 2 + 11*(start+count)/len(src))
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
    original = resample_poly(audio, 1, 2).astype("float32")
    def separate(backend):
        if count not in cache:
            name = f"speechbrain/sepformer-wsj0{count}mix"
            revision = "3a2826343a10e2d2e8a75f79aeab5ff3a2473531" if count == 2 else "21e78b44a378092c34fff32ba8e788a73584f474"
            local = Path(os.environ.get("EASYX_DUBBING_MODELS", "")) / name.split("/")[-1]
            source = str(local.resolve()) if (local/"hyperparams.yaml").is_file() else name
            cache[count] = SepformerSeparation.from_hparams(source=source, fetch_config=FetchConfig(revision=revision),
                    savedir=str(Path(os.environ["HF_HOME"]) / f"sepformer-{count}-{revision[:8]}"), run_opts={"device": backend})
        with torch.inference_mode():
            return cache[count].separate_batch(torch.from_numpy(original).unsqueeze(0).to(backend))[0].cpu().numpy()

    backend = str(cache[count].device) if count in cache else device()
    if count not in cache and backend == "cuda" and free_cuda_bytes() < 1536*1024**2:
        backend = "cpu"
    try:
        signals = separate(backend)
    except RuntimeError as error:
        if not backend.startswith("cuda") or not cuda_allocation_failed(error):
            raise
        signals = None
    if signals is None:
        cache.pop(count, None)
        gc.collect()
        torch.cuda.empty_cache()
        signals = separate("cpu")
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
            if cue.get("verifiedSource") or cue["language"] == language or cue["end"]-cue["start"] > 4:
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


def join_restored_fragments(turns, original_turns, words, origin):
    """Rejoin a split word when the intact soundtrack independently supports one continuous speaker."""
    for word in words:
        a, b = (round((word[key]-origin)*16000) for key in ("start", "end"))
        owners = [(l, r, s) for l, r, s in original_turns if l < b and r > a]
        if len(owners) != 1:
            continue
        left, right, _ = owners[0]
        if left > a or right < b or right-left > 8*16000:
            continue
        if any(l < right and r > left for l, r, s in original_turns if s != owners[0][2]):
            continue
        fragments = [(l, r, s) for l, r, s in turns if l < right and r > left]
        if len(fragments) < 2 or len({s for _, _, s in fragments}) != 1:
            continue
        if any(l < left-.25*16000 or r > right+.25*16000 for l, r, _ in fragments):
            continue
        # Leave unrelated boundaries alone. The original word itself must
        # sit at the split, and the original diarizer must cover that split.
        if not any(later[0]-earlier[1] <= 16000 and earlier[1] <= b and later[0] >= a
                   for earlier, later in zip(fragments, fragments[1:])):
            continue
        combined = (min(left, fragments[0][0]), max(right, fragments[-1][1]), fragments[0][2])
        turns = sorted([turn for turn in turns if turn not in fragments] + [combined])
    return turns


def verified_turns(words, turns, origin):
    """Associate a restored word only with an exclusive diarized speaker turn."""
    result = [[] for _ in turns]
    for word in words:
        if any(other is not word and other["text"].casefold() != word["text"].casefold() and
               min(other["end"], word["end"])-max(other["start"], word["start"]) >
               .5*min(other["end"]-other["start"], word["end"]-word["start"]) for other in words):
            continue
        left, right = word["start"]-origin, word["end"]-origin
        hits = [(i, min(right, b/16000)-max(left, a/16000)) for i, (a, b, _) in enumerate(turns)
                if a/16000 < right and b/16000 > left]
        if len(hits) != 1:
            continue
        idx, overlap = hits[0]
        if overlap >= .65*(right-left):
            offset = turns[idx][0]/16000
            result[idx].append(dict(word, start=max(0., left-offset), end=min(right, turns[idx][1]/16000)-offset))
    return result


def turn_transcript(whisper, audio, restored, original_audio=None, *, exclusive=True):
    """Keep confirmed words on their isolated voice, with timing from the original audio."""
    duration = len(audio)/16000
    chunks, info = whisper.transcribe(audio, beam_size=2, condition_on_previous_text=False, word_timestamps=bool(restored))
    chunks = [c for c in chunks if c.text.strip() and not (c.no_speech_prob > .65 and c.avg_logprob < -1)]
    original = [(max(0., c.start), min(duration, c.end), c.text.strip(), info.language, info.language_probability, False)
                for c in chunks]
    if not restored:
        return original

    def token(text):
        return "".join(c for c in text.casefold() if c.isalnum())

    heard = [w for c in chunks for w in (c.words or []) if token(w.word) and w.end > w.start]
    confirmed = []
    for word in restored:
        start, end = word["start"], word["end"]
        # Two different high-confidence voices may be audible in a supposedly
        # solo turn. Keep the isolated transcript whenever the assignment conflicts.
        if any(token(w.word) != token(word["text"]) and w.probability >= .75 and
               min(end, w.end)-max(start, w.start) > .5*min(end-start, w.end-w.start) for w in heard):
            continue
        confirmed.append(word)
    if not confirmed:
        return original
    pieces = [(w["start"], w["end"], w["text"], w["language"],
               info.language_probability if w["language"] == info.language else None, True) for w in confirmed]
    support = None
    for w in heard:
        adjacent = [v for v in confirmed if v["start"]-1 < w.end and w.start < v["end"]+1]
        if any(token(v["text"]) == token(w.word) or
               min(v["end"], w.end) > max(v["start"], w.start) for v in adjacent):
            continue
        if adjacent and w.probability < .6:
            # The adjacent weak syllable may be another real word. Check it
            # on the original turn before accepting or dropping that neighbor.
            if support is None:
                support = []
                if original_audio is not None:
                    decoded, _ = whisper.transcribe(original_audio, language=info.language, beam_size=3,
                                                    word_timestamps=True, condition_on_previous_text=False)
                    support = [v for c in decoded if c.avg_logprob >= -1.1 and c.no_speech_prob < .65
                               for v in c.words or [] if v.probability >= .6]
            if not any(token(v.word) == token(w.word) and abs(v.start+v.end-w.start-w.end) <= .7 for v in support):
                continue
        pieces.append((w.start, w.end, w.word, info.language, info.language_probability, False))
    groups = []
    for start, end, text, lang, confidence, verified in sorted(pieces, key=lambda p: p[0]):
        if groups and groups[-1][3] == lang and start-groups[-1][1] <= .45:
            first, last, words, _, _, checked = groups[-1]
            space = "" if lang in {"ja", "zh", "th", "lo", "km", "my"} else " "
            groups[-1] = (first, max(last, end), words+space+text.strip(), lang, confidence, checked or verified)
        else:
            groups.append((start, end, text.strip(), lang, confidence, verified))
    if len(groups) == 1 and groups[0][5] and exclusive and duration <= 3:
        # A faint word can be timestamped on its stressed syllable alone. If
        # this is the only utterance in a short exclusive turn, retain its
        # acoustic onset and tail for the voice reference as well.
        return [(0., duration, *groups[0][2:])]
    return [(max(0., a-.12), min(duration, b+.14), text, lang, confidence, verified)
            for a, b, text, lang, confidence, verified in groups]


def transcribe(dialogue, work, model_cache):
    index = work / "speakers.json"
    sidecar = dialogue.with_suffix(".words.json")
    marks, signature = [], ""
    if sidecar.is_file():
        marks = json.loads(sidecar.read_text())
        stem = dialogue.stat()
        signature = hashlib.sha256(json.dumps([dialogue.name, stem.st_size, stem.st_mtime_ns, marks],
                                              sort_keys=True).encode()).hexdigest()
    stamp = work/"speakers-source-words.sha256"
    cached = None
    if index.is_file() and (stamp.read_text() if stamp.is_file() else "") == signature:
        result = json.loads(index.read_text())
        if all((work / f"speaker-{c['speaker']}.wav").is_file() and c.get("clip") and (work / c["clip"]).is_file() for c in result):
            if all("languageProbability" in c for c in result):
                return result
            cached = result
    whisper = WhisperRecognizer(model_cache)
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
            origin = start/44100
            words = [w for w in marks if w["end"] > origin and w["start"] < origin+len(samples)/16000]
            # Where the stem failed, its changing level can split one original
            # word into two apparent turns. Use the intact source for that context.
            for w in words:
                left = max(0, round((w["start"]-origin-1)*16000))
                right = min(len(samples), round((w["end"]-origin+1)*16000))
                guide[left:right] = original[left:right].mean(axis=1)
            def detect(signal):
                segments = sd.process(signal).sort_by_start_time()
                return [(max(0, round(s.start*16000)), min(len(samples), round(s.end*16000)), s.speaker)
                        for s in segments if s.end > s.start]
            turns = detect(guide)
            if words:
                turns = join_restored_fragments(turns, detect(original.mean(axis=1)), words, origin)
            annotations = verified_turns(words, turns, origin)
            turns_audio = speaker_audio(samples, original, turns, extractor, voices, separators)
            last_percent = -1
            for (offset, speaker, audio, direction, overlapping), restored in zip(turns_audio, annotations, strict=True):
                percent = int(15 + 12 * (start + offset * 44100 / 16000) / len(src))
                if percent > last_percent:
                    progress("Identifying and transcribing speakers", percent)
                    last_percent = percent
                if len(audio) < 1600:
                    continue
                source_turn = original[offset:offset+len(audio)].mean(axis=1) if restored else None
                transcript = turn_transcript(whisper, audio, restored, source_turn, exclusive=not overlapping)
                for t0, t1, text, language, confidence, verified in transcript:
                    if t1-t0 < .08:
                        continue
                    at = start/44100 + offset/16000
                    clip = f"turn-{len(cues)}.flac"
                    sf.write(work/clip, audio[round(t0*16000):round(t1*16000)], 16000)
                    cue = dict(start=at+t0, end=at+t1, speaker=speaker, language=language,
                               languageProbability=confidence, text=text, clip=clip, direction=direction, overlapping=overlapping)
                    if verified:
                        cue["verifiedSource"] = True
                    cues.append(cue)
            progress("Identifying and transcribing speakers", 15 + 12 * min(1, (start + len(samples)*44100/16000)/len(src)))
    cues.sort(key=lambda c: c["start"])
    resolve_short_languages(cues, work, whisper)
    speaker_references(cues, work)
    save_json(index, cues)
    if signature or stamp.is_file():
        partial = stamp.with_suffix(".partial")
        partial.write_text(signature)
        partial.replace(stamp)
    return cues
