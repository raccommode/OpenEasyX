"""Translate dialogue and mix time-aligned speaker-conditioned audio into the original film."""
import gc
import json
import math
import os
import subprocess
import sys
from functools import cache
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

from runtime import device, model_path, progress, save_json
from inference_memory import compact_cpu, cuda_allocation_failed, free_cuda_bytes
from whisper_recognizer import model_directory

CATALOG = Path(__file__).resolve().parents[2] / "packages"
LANGUAGES = {lang["code"]: lang for file in ("translation-languages.json", "other-speech-languages.json")
             for lang in json.loads((CATALOG / file).read_text())}


def load_translation_model(model_class, directory, accelerator):
    if accelerator != "cuda":
        return model_class.from_pretrained(directory).eval().to(accelerator)
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16
    model = model_class.from_pretrained(directory, dtype=dtype).eval()
    # NLLB ties its 500 MiB vocabulary matrix across four modules. Materialize
    # and tie on CPU first, then preserve the shared Parameter during transfer.
    previous = torch.__future__.get_swap_module_params_on_conversion()
    try:
        torch.__future__.set_swap_module_params_on_conversion(True)
        return model.to("cuda")
    finally:
        torch.__future__.set_swap_module_params_on_conversion(previous)


def translate_batch(model, tokenizer, lines, target_token, accelerator):
    encoded = tokenizer(lines, return_tensors="pt", padding=True).to(accelerator)
    with torch.inference_mode():
        result = model.generate(**encoded, forced_bos_token_id=target_token, max_new_tokens=256)
    return tokenizer.batch_decode(result, skip_special_tokens=True)


def translate(cues, target, cache):
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    cached = None
    if cache.is_file():
        try:
            candidate = json.loads(cache.read_text())
        except (ValueError, UnicodeError):
            candidate = None
        if isinstance(candidate, list) and len(candidate) == len(cues):
            cached = candidate
    texts = [cue["text"] if cue["language"] == target or cue.get("preserveOriginal") else
             (cached[i] if cached and isinstance(cached[i], str) and cached[i].strip() else None)
             for i, cue in enumerate(cues)]
    if all(text is not None for text in texts):
        return texts
    model_dir = model_path("translation")
    accelerator = device()
    model = None
    batch_size = 8
    compact = accelerator == "cpu" and compact_cpu()
    if accelerator == "cuda" and free_cuda_bytes() < 1536*1024**2:
        # The tied half-precision weights alone require more than 1.1 GiB.
        accelerator, compact = "cpu", True
        progress("Translating on CPU while GPU memory is busy", 30)
    if compact:
        batch_size = 1
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    target_token = tokenizer.convert_tokens_to_ids(LANGUAGES[target]["nllb"])
    total = texts.count(None)
    translated = 0
    for source in dict.fromkeys(cue["language"] for cue, text in zip(cues, texts) if text is None):
        if source not in LANGUAGES:
            raise ValueError(f"Translation from detected language {source} is unavailable")
        tokenizer.src_lang = LANGUAGES[source]["nllb"]
        positions = [idx for idx, cue in enumerate(cues) if cue["language"] == source and texts[idx] is None]
        offset = 0
        while offset < len(positions):
            selected = positions[offset:offset+batch_size]
            try:
                if model is None:
                    if compact:
                        # Tie vocabulary weights from the mapped archive before allocating the smaller CPU tensors.
                        model = AutoModelForSeq2SeqLM.from_pretrained(model_dir).eval().to(dtype=torch.bfloat16)
                    else:
                        model = load_translation_model(AutoModelForSeq2SeqLM, model_dir, accelerator)
                generated = translate_batch(model, tokenizer, [cues[idx]["text"] for idx in selected], target_token, accelerator)
                for pos, text in enumerate(generated):
                    if not text.strip():
                        # Retry only this sentence without padded neighbours or an
                        # unknown-token loop. Never invent a token to force speech.
                        idx = selected[pos]
                        encoded = tokenizer([cues[idx]["text"]], return_tensors="pt").to(accelerator)
                        with torch.inference_mode():
                            result = model.generate(**encoded, forced_bos_token_id=target_token,
                                                    num_beams=4, no_repeat_ngram_size=3,
                                                    suppress_tokens=[tokenizer.unk_token_id], max_new_tokens=256)
                        generated[pos] = tokenizer.batch_decode(result, skip_special_tokens=True)[0]
            except RuntimeError as error:
                if accelerator != "cuda" or not cuda_allocation_failed(error):
                    raise
            else:
                for idx, text in zip(selected, generated, strict=True):
                    if not text.strip():
                        raise ValueError(f"Translation from {source} to {target} produced no text at {cues[idx].get('start', 0):.2f}s")
                    texts[idx] = text.strip()
                save_json(cache, texts)
                offset += len(selected)
                translated += len(selected)
                progress(f"Translating {source} to {target}", 30 + 7 * translated/total)
                continue
            # Exit the exception handler before releasing the failed model:
            # the traceback can retain GPU tensors from loading or generation.
            model = None
            gc.collect()
            torch.cuda.empty_cache()
            accelerator, batch_size, compact = "cpu", 1, True
            progress("Translating on CPU while GPU memory is busy", 30 + 7 * translated/total)
    return texts


def delivery_durations(cues, media_duration):
    """Allow a line to finish naturally in an available pause, without delaying another voice."""
    durations = []
    busy_until = 0.
    for i, cue in enumerate(cues):
        start, end = cue["start"], cue["end"]
        next_start = cues[i+1]["start"] if i+1 < len(cues) else media_duration
        gap = max(0., min(next_start, media_duration)-end)
        # The last speaker in an overlap can finish in the following silence.
        extra = min(1.25, max(0., gap-.08)) if busy_until <= end else 0.
        durations.append(end-start+extra)
        busy_until = max(busy_until, end)
    return durations


def audible(wave, rate):
    return (wave.ndim == 1 and len(wave) >= .04*rate and np.isfinite(wave).all()
            and np.max(abs(wave)) >= 1e-5 and np.sqrt(np.mean(wave**2)) >= 1e-6)


def cached_voice(path):
    if not path.is_file():
        return False
    try:
        wave, rate = sf.read(path, dtype="float32")
    except (OSError, RuntimeError, ValueError):
        return False
    return audible(wave, rate)


def speak(cues, texts, language, work, wav_dir, references=None, model_cache=None):
    def needs_take(i):
        return not (wav_dir/f"{i}.original").exists() and not cached_voice(wav_dir/f"{i}.wav")

    pending = [i for i, cue in enumerate(cues) if not cue.get("preserveOriginal") and
               cue["language"] != language and needs_take(i)]
    if not pending:
        return
    accelerator = device()
    if accelerator == "cuda":
        if free_cuda_bytes() >= 1536*1024**2:
            try:
                synthesize(cues, texts, language, work, wav_dir, pending, accelerator, references, model_cache)
                return
            except RuntimeError as error:
                if not cuda_allocation_failed(error):
                    raise
            # Dropping the traceback first releases the failed clone prompts, codec and generation buffers.
            gc.collect()
            torch.cuda.empty_cache()
            pending = [i for i in pending if needs_take(i)]
        if pending:
            progress("Cloning voices on CPU while GPU memory is busy", 38 + 30*pending[0]/len(cues))
            synthesize(cues, texts, language, work, wav_dir, pending, "cpu", references, model_cache)
        return
    if accelerator != "mps":
        synthesize(cues, texts, language, work, wav_dir, pending, accelerator, references, model_cache)
        return
    # Metal retains compiled decoder graphs for varying utterance lengths. A
    # fresh process releases those allocations on Macs with shared GPU memory.
    for start in range(0, len(pending), 6):
        batch = pending[start:start+6]
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(work), str(wav_dir),
                                 language, *map(str, batch)], stdin=subprocess.DEVNULL,
                                env={**os.environ, "EASYX_DUBBING_VOICE_REFS": str(references or work),
                                     "EASYX_DUBBING_VERIFY_MODEL_CACHE": str(model_cache or "")})
        if result.returncode:
            # The child already wrote the model's diagnostic to the shared stderr.
            raise SystemExit(f"Voice synthesis stopped with status {result.returncode}")


def load_voice_model(model_class, directory, accelerator, dtype, percent):
    if accelerator != "cuda":
        return model_class.from_pretrained(directory, device_map=accelerator, dtype=dtype)
    # The BF16 backbone uses 1,168 MiB and the FP32 audio codec another 764 MiB.
    # Leave space for the CUDA context and decoding on a busy or shared card.
    if free_cuda_bytes() >= 3*1024**3:
        try:
            return model_class.from_pretrained(directory, device_map="cuda", dtype=dtype)
        except RuntimeError as error:
            if not cuda_allocation_failed(error):
                raise
        # Another application can allocate VRAM between the check and the load.
        # Release the failed model and traceback before retrying once.
        gc.collect()
        torch.cuda.empty_cache()
    progress("Loading the voice model on CUDA with the audio codec on CPU", percent)
    model = model_class.from_pretrained(directory, device_map="cpu", dtype=dtype)
    codec = model.audio_tokenizer
    model.audio_tokenizer = None
    try:
        model.to("cuda")
    finally:
        model.audio_tokenizer = codec
    return model


def verifies_words(recognizer, wave, rate, language, expected):
    from difflib import SequenceMatcher
    import re
    import unicodedata
    from speech_review import at16
    audio = at16(wave, rate)
    audio = audio * (.65 / max(float(np.max(abs(audio))), 1e-6))
    segments, _ = recognizer.transcribe(audio, language=language, beam_size=3, max_new_tokens=192,
                                        condition_on_previous_text=False)
    words = " ".join(s.text for s in segments if s.avg_logprob > -1.4 and s.no_speech_prob < .8)
    def tokens(text):
        decomposed = unicodedata.normalize("NFKD", text.casefold())
        return re.findall(r"[^\W_]+", "".join(c for c in decomposed if not unicodedata.combining(c)))

    wanted, heard = tokens(expected), tokens(words)
    if not wanted or not heard:
        return False
    target_text, spoken_text = "".join(wanted), "".join(heard)
    if target_text == spoken_text:
        return True
    # A high character score can hide a lost opening or extra phrase.
    # Longer lines can still tolerate isolated recognition errors.
    for tag, a, b, c, d in SequenceMatcher(None, wanted, heard, autojunk=False).get_opcodes():
        if len(wanted) <= 8 and tag in {"insert", "delete"}:
            return False
        if abs((b-a)-(d-c)) >= 2 and "".join(wanted[a:b]) != "".join(heard[c:d]):
            return False
    return SequenceMatcher(None, target_text, spoken_text, autojunk=False).ratio() >= .65


class MissingVoiceReference(ValueError):
    pass


def speaker_reference(speaker, folders, start):
    # Prefer a repaired reference when available, keeping the waveform and
    # transcript of a single original speaker together on every attempt.
    for folder in dict.fromkeys(folders):
        if not folder:
            continue
        path = folder/f"speaker-{speaker}.wav"
        words_path = path.with_suffix(".txt")
        if not path.is_file() or not words_path.is_file():
            continue
        try:
            audio, rate = sf.read(path, dtype="float32")
            text = words_path.read_text().strip()
        except (OSError, RuntimeError, UnicodeError):
            continue
        if text and audible(audio, rate):
            return audio, rate, text
    raise MissingVoiceReference(f"No audible original voice reference for speaker {speaker+1} at {start:.2f}s")


def fit_natural_take(wave, rate, limit):
    """Fit a complete utterance in its slot without cutting the last word or shifting pitch."""
    count = round(rate*limit)
    if len(wave) <= count:
        return wave
    peaks = np.flatnonzero(abs(wave) > max(1e-5, .014*float(np.max(abs(wave)))))
    if len(peaks):
        pad = round(.045*rate)
        wave = wave[max(0, peaks[0]-pad):peaks[-1]+pad+1]
    if len(wave) <= count:
        return wave
    if count < 1 or len(wave) > 1.45*count:
        return np.empty(0, dtype="float32")
    command = ["ffmpeg", "-nostdin", "-v", "error", "-f", "f32le", "-ar", str(rate), "-ac", "1",
               "-i", "pipe:0", "-af", f"atempo={len(wave)/count:.8f}", "-f", "f32le", "pipe:1"]
    data = subprocess.run(command, input=wave.astype("<f4").tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(data, dtype="<f4")[:count]


def wrong_speaker(vector, speaker, anchors):
    """Reject clear matches to another original speaker, even when the words are right."""
    if vector is None or anchors.get(speaker) is None:
        return False
    own = float(vector @ anchors[speaker])
    return any(other != speaker and anchor is not None and float(vector @ anchor) > max(.45, own+.08)
               for other, anchor in anchors.items())


def synthesize(cues, texts, language, work, wav_dir, indices, accelerator, references=None, model_cache=None):
    from omnivoice import OmniVoice
    percent = 38 + 30*indices[0]/len(cues)
    progress("Loading local voice model", percent)
    # The native FP32 checkpoint maps directly into CPU memory. The codec and word verification also run on CPU there.
    dtype = torch.float32
    if accelerator == "mps" and torch.backends.mps.is_macos_or_newer(14, 0):
        dtype = torch.bfloat16
    elif accelerator == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16
    model = load_voice_model(OmniVoice, model_path("voice"), accelerator, dtype, percent)
    limits = delivery_durations(cues, sf.info(work/"mix.wav").duration)
    prompts, repaired_prompts, alternate_prompts = {}, {}, {}
    folders = [references if references != work else None, wav_dir.parent, work]
    speakers = {cue["speaker"]: cue["start"] for cue in cues if not cue.get("preserveOriginal")}

    @cache
    def reference(speaker):
        return speaker_reference(speaker, folders, speakers[speaker])

    @cache
    def identities():
        import sherpa_onnx
        from dialogue import embedding, embedding_config
        from speech_review import at16
        extractor = sherpa_onnx.SpeakerEmbeddingExtractor(embedding_config())
        anchors = {}
        for speaker in speakers:
            try:
                samples, rate, _ = reference(speaker)
            except ValueError:
                continue
            if len(samples) >= .8 * rate:
                anchors[speaker] = embedding(extractor, at16(samples, rate))
        return extractor, anchors

    @cache
    def recognizer():
        from faster_whisper import WhisperModel
        return WhisperModel(str(model_directory(model_cache)), device="cpu", compute_type="int8", cpu_threads=2)

    for idx in indices:
        cue, text = cues[idx], texts[idx]
        speaker = cue["speaker"]
        if speaker not in prompts:
            try:
                ref_audio, sr, ref_text = reference(speaker)
            except MissingVoiceReference:
                (wav_dir/f"{idx}.original").touch()
                continue
            prompt = model.create_voice_clone_prompt(
                (torch.from_numpy(ref_audio)[None, :], sr), ref_text, preprocess_prompt=False)
            prompts[speaker] = prompt, ref_audio, sr
        prompt, ref_audio, sr = prompts[speaker]
        original_duration = cue["end"]-cue["start"]
        limit = limits[idx]
        for attempt in range(4):
            if attempt:
                if speaker not in repaired_prompts:
                    from voice_samples import align_clone_reference
                    aligned = align_clone_reference(recognizer(), ref_audio, sr, cue["language"])
                    if aligned is not None:
                        ref, ref_text = aligned
                        prompt = model.create_voice_clone_prompt((torch.from_numpy(ref)[None, :], sr), ref_text,
                                                                 preprocess_prompt=False)
                    repaired_prompts[speaker] = prompt
                prompt = repaired_prompts[speaker]
                if attempt >= 2:
                    if speaker not in alternate_prompts:
                        from voice_samples import alternate_clone_reference
                        alternative = alternate_clone_reference(recognizer(), cues, work, speaker)
                        if alternative is not None:
                            ref, rate, ref_text = alternative
                            prompt = model.create_voice_clone_prompt((torch.from_numpy(ref)[None, :], rate), ref_text,
                                                                     preprocess_prompt=False)
                        alternate_prompts[speaker] = prompt
                    prompt = alternate_prompts[speaker]
            frames = model.duration_estimator.estimate_duration(text, prompt.ref_text, prompt.ref_audio_tokens.shape[-1])
            natural = frames/model.audio_tokenizer.config.frame_rate
            duration = min(limit, max(natural, .8*original_duration, len(text.split())/(2.7 if attempt else 3.5)))
            if attempt == 2:
                # On a final retry let the same voice finish in the available
                # pause rather than repeatedly requesting a clipped delivery.
                duration = min(limit, max(1.1, duration*1.2+.12))
            elif attempt == 3:
                duration = min(1.45*limit+.2, max(1.15, natural, len(text.split())/2.5))
            wave = model.generate(text=text, language=language, voice_clone_prompt=prompt, duration=duration,
                                  num_step=48, pad_duration=0., preprocess_prompt=False)[0]
            wave = np.asarray(wave, dtype="float32").reshape(-1)
            wave = fit_natural_take(wave, model.sampling_rate, limit)
            if not audible(wave, model.sampling_rate):
                continue
            if not verifies_words(recognizer(), wave, model.sampling_rate, language, text):
                from voice_trim import trim_verified_take
                trimmed = trim_verified_take(recognizer(), wave, model.sampling_rate, language, text)
                if trimmed is None:
                    continue
                wave = trimmed
            if len(speakers) > 1 and len(wave) >= .8 * model.sampling_rate:
                from dialogue import embedding
                from speech_review import at16
                extractor, anchors = identities()
                vector = embedding(extractor, at16(wave, model.sampling_rate))
                if wrong_speaker(vector, speaker, anchors):
                    continue
            if attempt:
                prompts[speaker] = prompt, ref_audio, sr
            break
        else:
            (wav_dir/f"{idx}.original").touch()
            progress(f"Keeping original speech for speaker {speaker+1} at {cue['start']:.2f}s", 38+30*(idx+1)/len(cues))
            continue
        output = wav_dir/f"{idx}.wav"
        temporary = output.with_suffix(".partial.wav")
        sf.write(temporary, wave, model.sampling_rate, subtype="FLOAT")
        temporary.replace(output)
        if accelerator == "mps":
            torch.mps.empty_cache()
        progress(f"Synthesizing speaker {speaker+1} in {language}", 38 + 30*(idx+1)/len(cues))


def position_overlap(original, speech, directions):
    """Place a centered speech estimate within the measured speaker directions."""
    from scipy.signal import istft, stft
    if original.shape[1] == 1 or any(direction is None for direction in directions):
        return speech
    pans = np.asarray(directions)
    center = speech.mean(axis=1)
    spread = np.mean((speech-center[:, None])**2)
    expected = np.mean(center**2) * np.mean((pans-1)**2)
    if spread >= expected*.25 or expected < 1e-10:
        return speech
    # The dominant talker varies by time and frequency. Bound the measured
    # channel gains to the speakers' pans to protect offscreen effects.
    size = min(1024, len(original))
    options = dict(nperseg=size, noverlap=size*3//4)
    spectra = stft(original.T, **options)[2]
    mono = spectra.mean(axis=0)
    pan = (spectra * mono.conj()).real / (np.abs(mono)**2 + 1e-12)
    pan = np.clip(pan, pans.min(axis=0)[:, None, None], pans.max(axis=0)[:, None, None])
    pan /= np.maximum(pan.mean(axis=0), 1e-5)
    voice = stft(center, **options)[2]
    return istft(pan * voice, **options)[1].T[:len(speech)].astype("float32")


def residual_overlaps(mix, dialogue, cues, work):
    """Find voices left behind by the cinematic separator during simultaneous speech."""
    from dialogue import cinematic_separator, isolate_dialogue, spans
    corrections, session = [], None
    with sf.SoundFile(mix) as src, sf.SoundFile(dialogue) as speech:
        rate = src.samplerate
        turns = [(round(c["start"]*rate), round(c["end"]*rate), c["speaker"]) for c in cues]
        intervals = list(spans(turns))
        in_overlap = {i for a, b, active in intervals if b-a >= rate//10 and
                      len({turns[i][2] for i in active}) > 1 for i in active}
        for start, end, active in intervals:
            if end-start < rate//10 or not any(i in in_overlap for i in active):
                continue
            for left in range(start, end, rate*4):
                right = min(end, left+rate*4)
                path = work / f"overlap-bandit-v2-{left}-{right}.wav"
                if not path.is_file():
                    # The residual contains the quieter speaker and background.
                    # Isolate its speech, keeping its original channel placement.
                    first, last = max(0, left-2*rate), min(len(src), right+2*rate)
                    src.seek(first)
                    speech.seek(first)
                    original = src.read(last-first, dtype="float32", always_2d=True)
                    first_pass = speech.read(last-first, dtype="float32", always_2d=True)
                    region = slice(left-first, right-first)
                    residual = original-first_pass
                    if np.mean(residual[region]**2) <= .05*np.mean(original[region]**2):
                        continue
                    if len(active) == 1:
                        # A quieter speaker may still be missing after the other
                        # turn ends. Recheck only flanks with a weak speech stem.
                        if np.mean(first_pass[region]**2) >= .15*np.mean(original[region]**2):
                            continue
                    if session is None:
                        session = cinematic_separator()
                    extra = isolate_dialogue(session, residual)
                    directions = [cues[i].get("direction") for i in active]
                    extra = position_overlap(original, first_pass + extra, directions) - first_pass
                    part = path.with_suffix(".partial.wav")
                    sf.write(part, extra[left-first:right-first], rate, subtype="FLOAT")
                    part.replace(path)
                corrections.append((left, right, path))
    return corrections


def active_level(samples):
    """Speech level in the louder short-time frames, independent of padded pauses."""
    width = min(512, len(samples))
    if not width:
        return 0.
    frames = samples[:len(samples)//width*width].reshape(-1, width)
    powers = np.mean(frames**2, axis=1)
    return float(np.sqrt(np.mean(powers[powers >= np.quantile(powers, .60)])))


def soundtrack_windows(turns, corrections, chunk):
    """Split speaker intervals at cinematic correction and cached model boundaries."""
    from dialogue import spans
    corrections = iter(corrections)
    prior = next(corrections, None)
    for left, end, active in spans(turns):
        while left < end:
            while prior and prior[1] <= left:
                prior = next(corrections, None)
            tile = left//chunk*chunk
            right = min(end, tile+chunk)
            extra = None
            if prior and prior[0] <= left:
                right = min(right, prior[1])
                extra = (prior[2], left-prior[0])
            elif prior:
                right = min(right, prior[0])
            yield left, right, tile, active, extra
            left = right


def microphone_tile(source, work, tile, chunk, load_model):
    """Share channel-aligned speech windows across cues and requested languages."""
    from enhance import enhance_speech
    path = work/f"microphone-{tile}.wav"
    if not path.is_file():
        first = max(0, tile-2*source.samplerate)
        last = min(len(source), tile+chunk+2*source.samplerate)
        source.seek(first)
        data = source.read(last-first, dtype="float32", always_2d=True)
        estimate = enhance_speech(load_model(), data, source.samplerate)
        pending = path.with_suffix(".partial.wav")
        sf.write(pending, estimate[tile-first:tile-first+chunk], source.samplerate, subtype="FLOAT")
        pending.replace(path)
    return path


def soundtrack_regions(mix, dialogue, cues, work):
    """Keep the cinematic estimate unless an independent speech model finds a missing voice."""
    from functools import cache
    from scipy.signal import butter, sosfilt
    from enhance import speech_enhancer
    prior = residual_overlaps(mix, dialogue, cues, work)
    load_model = cache(speech_enhancer)
    regions, levels = [], {}
    with sf.SoundFile(mix) as src, sf.SoundFile(dialogue) as cinematic:
        rate = src.samplerate
        band = butter(3, (140, 6500), fs=rate, btype="bandpass", output="sos")
        turns = [(round(c["start"]*rate), round(c["end"]*rate), c["speaker"]) for c in cues]
        chunk = 30*rate
        for left, right, tile, active, extra in soundtrack_windows(turns, prior, chunk):
            frames = right-left
            src.seek(left)
            cinematic.seek(left)
            original = src.read(frames, dtype="float32", always_2d=True)
            base = cinematic.read(frames, dtype="float32", always_2d=True)
            correction = None
            if extra:
                path, offset = extra
                with sf.SoundFile(path) as file:
                    file.seek(offset)
                    base += file.read(frames, dtype="float32", always_2d=True)
                correction = (left, right, path, offset, False)
            if len(active) == 1 and cues[active[0]].get("direction") is not None:
                base = base.mean(axis=1, keepdims=True)*cues[active[0]]["direction"]
            x = sosfilt(band, original, axis=0)
            old = sosfilt(band, base, axis=0)
            power = np.sum(x*x)
            if power > 1e-8 and np.sum(old*x) < .75*power:
                path = microphone_tile(src, work, tile, chunk, load_model)
                with sf.SoundFile(path) as file:
                    file.seek(left-tile)
                    candidate = file.read(frames, dtype="float32", always_2d=True)
                h = sosfilt(band, candidate, axis=0)
                matches = np.sum(x*h)
                # A loud score alone can also obscure the dialogue stem. Switch
                # only when the residual contains the denoiser's speech.
                if matches > .015*power and np.sum((x-old)*h) > .25*matches:
                    correction = (left, right, path, left-tile, True)
                    voice = active_level(candidate.mean(axis=1))
                    room = active_level((original-candidate).mean(axis=1))
                    target = max(1.3*voice, 1.3*active_level(original.mean(axis=1)), 1.65*room)
                    for i in active:
                        energy, duration = levels.get(i, (0., 0))
                        levels[i] = (energy + target**2*frames/len(active), duration+frames)
            if correction is not None:
                regions.append(correction)
    return iter(regions), {i: math.sqrt(energy/frames) for i, (energy, frames) in levels.items()}


def dialogue_loudness(path, filters=()):
    chain = ",".join((*filters, "loudnorm=I=-18:TP=-1.3:LRA=11:print_format=json"))
    result = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", str(path),
                             "-af", chain, "-f", "null", "-"], check=True, capture_output=True, text=True)
    return float(json.loads(result.stderr[result.stderr.rfind("{"):result.stderr.rfind("}")+1])["input_i"])


def add_leveled_dialogue(dry_path, output):
    """Measure the complete speech bus under BS.1770, preserving relative line levels."""
    measured = dialogue_loudness(dry_path)
    if not math.isfinite(measured):
        # BS.1770 needs a 400 ms gating block. Keep even a single short reply.
        with sf.SoundFile(dry_path) as dry:
            peak = max((float(np.max(np.abs(block))) for block in dry.blocks(blocksize=65536)), default=0.)
        if not peak:
            return
        measured = 20*math.log10(peak)-6
    limiter = "alimiter=limit=0.86:attack=5:release=60:level=false:latency=true"
    gain = -18-measured
    if gain > 0:
        limited = dialogue_loudness(dry_path, (f"volume={gain:.4f}dB", limiter))
        if math.isfinite(limited):
            gain += min(4., max(0., -18-limited))
    command = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(dry_path),
               "-af", f"volume={gain:.4f}dB,{limiter}", "-f", "f32le", "-c:a", "pcm_f32le", "-"]
    with sf.SoundFile(output, "r+") as background, subprocess.Popen(command, stdout=subprocess.PIPE) as ff:
        try:
            while True:
                data = ff.stdout.read(background.samplerate * background.channels * 4)
                if not data:
                    break
                replacement = np.frombuffer(data, dtype="<f4").reshape(-1, background.channels)
                start = background.tell()
                bed = background.read(len(replacement), dtype="float32", always_2d=True)
                background.seek(start)
                # Reserve headroom for effects already in the original soundtrack.
                headroom = np.maximum(0., .94 - np.sign(replacement)*bed)
                scale = np.minimum(1., headroom / np.maximum(np.abs(replacement), 1e-8)).min(axis=1)
                background.write(bed + replacement*scale[:, None])
        finally:
            ff.stdout.close()
        if ff.wait():
            raise RuntimeError("Could not level the synthesized speech")


def mix_voices(mix, dialogue, cues, wav_dir, work, output, *, language=None):
    """Mix translated and already-target-language voices over a continuous effects/music bed."""
    regions, targets = soundtrack_regions(mix, dialogue, cues, work)
    dry_path = wav_dir / "translated-bus.wav"
    try:
        render_voice_buses(mix, dialogue, cues, wav_dir, work, output, dry_path, regions, targets, language=language)
        add_leveled_dialogue(dry_path, output)
    finally:
        dry_path.unlink(missing_ok=True)


def original_intervals(cues):
    """Keep inseparable, overlapping speakers together on their original soundtrack."""
    groups = []
    for cue in sorted(cues, key=lambda c: c["start"]):
        if not groups or cue["start"] >= groups[-1][0]:
            groups.append([cue["end"], [cue]])
        else:
            groups[-1][0] = max(groups[-1][0], cue["end"])
            groups[-1][1].append(cue)
    intervals = []
    for end, turns in groups:
        reason = next((c["preserveOriginal"] for c in turns if c.get("preserveOriginal")), None)
        if reason:
            for cue in turns:
                cue.setdefault("preserveOriginal", reason)
            intervals.append({"start": turns[0]["start"], "end": end, "reason": reason})
    return intervals


def turn_fade(at, length, rate):
    return np.clip(np.minimum(at, length-1-at)/(rate*.01), 0, 1)


def preserve_repaired_speech(candidate, cinematic, repaired, start, rate):
    """Keep independently confirmed speech when a microphone estimate replaces the rest of a turn."""
    from scipy.ndimage import distance_transform_edt
    fade = max(1, round(.01*rate))
    first = max(0, start-fade)
    frames = start-first+len(candidate)+fade
    old = sf.read(cinematic, start=first, frames=frames, dtype="float32", always_2d=True)[0]
    verified = sf.read(repaired, start=first, frames=frames, dtype="float32", always_2d=True)[0]
    window = slice(start-first, start-first+len(candidate))
    # The repair is channel-specific. Read a short overlap so crossings and
    # transitions use the same gain on either side of a one-second output block.
    for channel in range(candidate.shape[1]):
        corrected = np.abs(verified[:, channel]-old[:, channel]) > 1e-7
        if corrected.any():
            blend = np.minimum(1., distance_transform_edt(~corrected)[window]/fade)
            keep = blend < 1
            voice = verified[window, channel][keep]
            candidate[keep, channel] = voice + blend[keep]*(candidate[keep, channel]-voice)
    return candidate


def render_voice_buses(mix, dialogue, cues, wav_dir, work, output, dry_path, regions, targets, *, language=None):
    region = next(regions, None)
    originals = original_intervals(cues)
    cinematic = work/"dialogue-bandit-v2.wav"
    has_repairs = cinematic.is_file() and not cinematic.samefile(dialogue)
    with sf.SoundFile(mix) as src, sf.SoundFile(dialogue) as speech, sf.SoundFile(output, "w", samplerate=src.samplerate,
            channels=src.channels, format="RF64", subtype="FLOAT") as dst, sf.SoundFile(
                dry_path, "w", samplerate=src.samplerate, channels=src.channels, format="RF64", subtype="FLOAT") as dry:
        rate = src.samplerate
        edges = [(round(r["start"]*rate), round(r["end"]*rate)) for r in originals]
        edge = 0
        active, cursor = [], 0
        for start in range(0, len(src), rate):
            block = src.read(rate, dtype="float32", always_2d=True)
            vocal = speech.read(len(block), dtype="float32", always_2d=True)
            end = start + len(block)
            positioned = np.zeros(len(block), dtype=bool)
            while region and region[0] < end:
                left, right, path, offset, replace = region
                a, b = max(start, left), min(end, right)
                with sf.SoundFile(path) as extra:
                    extra.seek(offset+a-left)
                    part = extra.read(b-a, dtype="float32", always_2d=True)
                at = np.arange(a, b)
                fade = np.clip(np.minimum(at-left, right-1-at)/(rate*.01), 0, 1)
                if replace:
                    if has_repairs:
                        part = preserve_repaired_speech(part, cinematic, dialogue, a, rate)
                    vocal[a-start:b-start] = part
                    positioned[a-start:b-start] = True
                else:
                    vocal[a-start:b-start] += part * fade[:, None]
                if right > end:
                    break
                region = next(regions, None)
            active = [item for item in active if max(item[1], item[0]+len(item[2])) > start]
            while cursor < len(cues) and round(cues[cursor]["start"]*rate) < end:
                cue = cues[cursor]
                if cue.get("preserveOriginal"):
                    cursor += 1
                    continue
                left = round(cue["start"]*rate)
                right = round(cue["end"]*rate)
                dub = wav_dir / f"{cursor}.wav"
                translated = cue["language"] != language if language else dub.is_file()
                if translated and not dub.is_file():
                    raise ValueError(f"Missing translated voice at {cue['start']:.2f}s")
                sample, sr = sf.read(dub if translated else work/cue["clip"], dtype="float32")
                div = math.gcd(sr, rate)
                resampled = resample_poly(sample, rate//div, sr//div).astype("float32")
                audio = resampled if translated else resampled[:right-left]
                if translated and cursor in targets:
                    audio *= min(128., targets[cursor]/max(active_level(audio), 1e-8))
                active.append((left, right, audio, translated, cue.get("direction")))
                cursor += 1
            voices = np.zeros_like(block)
            retained = np.zeros_like(block)
            count = np.zeros(len(block), dtype=np.int16)
            solo_pan = np.zeros_like(block)
            level = np.sqrt(np.mean(vocal**2, axis=0))
            default_pan = level / level.max() if level.max() > 1e-7 else np.ones(src.channels)
            for left, source_end, audio, translated, direction in active:
                a = max(left, start)
                source_right = min(source_end, end)
                if source_right > a:
                    window = slice(a-start, source_right-start)
                    count[window] += 1
                    if direction is not None:
                        solo_pan[window] = direction
                # A translation can finish naturally in the gap after the source turn.
                delivery_right = min(end, left+len(audio))
                if delivery_right > a:
                    at = np.arange(a-left, delivery_right-left)
                    fade = turn_fade(at, len(audio), rate)
                    pan = direction if direction is not None else default_pan
                    bus = voices if translated else retained
                    bus[a-start:delivery_right-start] += (audio[at] * fade)[:, None] * pan
            # Film separators often return centered dialogue even for a panned
            # speaker. Restore its measured placement before subtraction.
            solo = (count == 1) & ~positioned & np.any(solo_pan, axis=1)
            if np.any(solo):
                estimate = vocal[solo]
                center = estimate.mean(axis=1, keepdims=True)
                panned = center*solo_pan[solo]
                if np.sum((estimate-center)**2) < .25*np.sum((panned-center)**2):
                    vocal[solo] = panned
            # Keep the native channels and phase of music and effects at every
            # sample. ASR gaps and translated pauses must not reopen the source voice.
            bed = block - vocal + retained
            fade_samples = max(1, round(.008*rate))
            while edge < len(edges) and edges[edge][1]+fade_samples <= start:
                edge += 1
            if edge < len(edges) and edges[edge][0]-fade_samples < end:
                at = np.arange(start, end)
                dubbed = np.ones(len(block), dtype="float32")
                for index in range(edge, len(edges)):
                    left, right = edges[index]
                    if left-fade_samples >= end:
                        break
                    distance = np.maximum(left-at, at-right+1)
                    np.minimum(dubbed, np.clip(distance/fade_samples, 0, 1), out=dubbed)
                bed = block + (bed-block)*dubbed[:, None]
                voices *= dubbed[:, None]
            dst.write(bed)
            dry.write(voices)


if __name__ == "__main__":
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    work, wav_dir = map(Path, sys.argv[1:3])
    language = sys.argv[3]
    try:
        cues = json.loads((wav_dir.parent/"speakers.json").read_text())
        original_intervals(cues)
        synthesize(cues,
                   json.loads((wav_dir.parent/f"translation-{language}.json").read_text()),
                   language, work, wav_dir, list(map(int, sys.argv[4:])), device(),
                   Path(os.environ.get("EASYX_DUBBING_VOICE_REFS", work)),
                   os.environ.get("EASYX_DUBBING_VERIFY_MODEL_CACHE") or None)
    except Exception as error:
        from runtime import publish
        publish(errorCode="DUBBING_RENDER_FAILED", message=str(error) or type(error).__name__)
        raise
