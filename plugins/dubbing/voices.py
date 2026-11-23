"""Translate dialogue and mix time-aligned speaker-conditioned audio into the original film."""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

from runtime import device, model_path, progress, save_json

CATALOG = Path(__file__).resolve().parents[2] / "packages"
LANGUAGES = {lang["code"]: lang for file in ("translation-languages.json", "other-speech-languages.json")
             for lang in json.loads((CATALOG / file).read_text())}


def translate(cues, target, cache):
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    if cache.is_file():
        texts = json.loads(cache.read_text())
        if len(texts) == len(cues):
            return texts
    model_dir = model_path("translation")
    accelerator = device()
    model = AutoModelForSeq2SeqLM.from_pretrained(model_dir).eval().to(accelerator)
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    texts = [cue["text"] for cue in cues]
    total = sum(cue["language"] != target for cue in cues)
    translated = 0
    for source in dict.fromkeys(cue["language"] for cue in cues):
        if source == target:
            continue
        if source not in LANGUAGES:
            raise ValueError(f"Translation from detected language {source} is unavailable")
        tokenizer.src_lang = LANGUAGES[source]["nllb"]
        positions = [idx for idx, cue in enumerate(cues) if cue["language"] == source]
        for offset in range(0, len(positions), 8):
            selected = positions[offset:offset+8]
            encoded = tokenizer([cues[idx]["text"] for idx in selected], return_tensors="pt", padding=True)
            with torch.inference_mode():
                result = model.generate(**encoded.to(accelerator), forced_bos_token_id=tokenizer.convert_tokens_to_ids(LANGUAGES[target]["nllb"]), max_new_tokens=256)
            for idx, text in zip(selected, tokenizer.batch_decode(result, skip_special_tokens=True)):
                if not text.strip():
                    raise ValueError("Translation produced an empty phrase")
                texts[idx] = text.strip()
            translated += len(selected)
            progress(f"Translating {source} to {target}", 30 + 7 * translated/total)
    save_json(cache, texts)
    return texts


def delivery_durations(cues, media_duration):
    """Allow a line to finish naturally in an available pause, without delaying another voice."""
    durations = []
    busy_until = 0.
    for i, cue in enumerate(cues):
        start, end = cue["start"], cue["end"]
        next_start = cues[i+1]["start"] if i+1 < len(cues) else media_duration
        gap = max(0., min(next_start, media_duration)-end)
        extra = min(1.25, max(0., gap-.08)) if busy_until <= start else 0.
        durations.append(end-start+extra)
        busy_until = max(busy_until, end)
    return durations


def speak(cues, texts, language, work, wav_dir):
    pending = [i for i, cue in enumerate(cues) if cue["language"] != language and not (wav_dir/f"{i}.wav").is_file()]
    if not pending:
        return
    accelerator = device()
    if accelerator != "mps":
        synthesize(cues, texts, language, work, wav_dir, pending, accelerator)
        return
    # Metal retains compiled decoder graphs for varying utterance lengths. A
    # fresh process releases those allocations on Macs with shared GPU memory.
    for start in range(0, len(pending), 6):
        batch = pending[start:start+6]
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(work), str(wav_dir),
                                 language, *map(str, batch)], stdin=subprocess.DEVNULL)
        if result.returncode:
            # The child already wrote the model's diagnostic to the shared stderr.
            raise SystemExit(f"Voice synthesis stopped with status {result.returncode}")


def synthesize(cues, texts, language, work, wav_dir, indices, accelerator):
    from omnivoice import OmniVoice
    progress("Loading local voice model", 38 + 30*indices[0]/len(cues))
    dtype = torch.float32
    if (accelerator == "mps" and torch.backends.mps.is_macos_or_newer(14, 0)) or (accelerator == "cuda" and torch.cuda.is_bf16_supported()):
        dtype = torch.bfloat16
    model = OmniVoice.from_pretrained(model_path("voice"), device_map=accelerator, dtype=dtype)
    limits = delivery_durations(cues, sf.info(work/"mix.wav").duration)
    prompts = {}
    for idx in indices:
        cue, text = cues[idx], texts[idx]
        speaker = cue["speaker"]
        if speaker not in prompts:
            ref_audio, sr = sf.read(work/f"speaker-{speaker}.wav", dtype="float32")
            ref_text = (work/f"speaker-{speaker}.txt").read_text().strip()
            prompts[speaker] = model.create_voice_clone_prompt(
                (torch.from_numpy(ref_audio)[None, :], sr), ref_text, preprocess_prompt=False)
        prompt = prompts[speaker]
        frames = model.duration_estimator.estimate_duration(text, prompt.ref_text, prompt.ref_audio_tokens.shape[-1])
        natural = frames/model.audio_tokenizer.config.frame_rate
        duration = min(limits[idx], max(natural, .8*(cue["end"]-cue["start"]), len(text.split())/3.5))
        # Request the timing from the model itself so syllables keep their prosody.
        wave = model.generate(text=text, language=language, voice_clone_prompt=prompt, duration=duration,
                              num_step=48, pad_duration=0., preprocess_prompt=False)[0]
        wave = np.asarray(wave, dtype="float32").reshape(-1)[:max(1, round(limits[idx]*model.sampling_rate))]
        if not len(wave) or not np.isfinite(wave).all() or np.max(np.abs(wave)) < 1e-6:
            raise ValueError("The voice model did not generate audible speech")
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
            for left in range(start, end, rate*30):
                right = min(end, left+rate*30)
                path = work / f"overlap-{left}-{right}.wav"
                if not path.is_file():
                    # The residual contains the quieter speaker and background.
                    # Isolate its speech, keeping its original channel placement.
                    first, last = max(0, left-2*rate), min(len(src), right+2*rate)
                    src.seek(first)
                    speech.seek(first)
                    original = src.read(last-first, dtype="float32", always_2d=True)
                    first_pass = speech.read(last-first, dtype="float32", always_2d=True)
                    if len(active) == 1:
                        # A quieter speaker may still be missing after the other
                        # turn ends. Recheck only flanks with a weak speech stem.
                        region = slice(left-first, right-first)
                        if np.mean(first_pass[region]**2) >= .15*np.mean(original[region]**2):
                            continue
                    if session is None:
                        session = cinematic_separator()
                    extra = isolate_dialogue(session, original - first_pass)
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


def mix_voices(mix, dialogue, cues, wav_dir, work, output):
    """Replace recognized dialogue while retaining the original ambience and channel layout."""
    regions, targets = soundtrack_regions(mix, dialogue, cues, work)
    dry_path = wav_dir / "translated-bus.wav"
    try:
        render_voice_buses(mix, dialogue, cues, wav_dir, work, output, dry_path, regions, targets)
        add_leveled_dialogue(dry_path, output)
    finally:
        dry_path.unlink(missing_ok=True)


def turn_fade(at, length, rate):
    return np.clip(np.minimum(at, length-1-at)/(rate*.01), 0, 1)


def render_voice_buses(mix, dialogue, cues, wav_dir, work, output, dry_path, regions, targets):
    region = next(regions, None)
    with sf.SoundFile(mix) as src, sf.SoundFile(dialogue) as speech, sf.SoundFile(output, "w", samplerate=src.samplerate,
            channels=src.channels, format="RF64", subtype="FLOAT") as dst, sf.SoundFile(
                dry_path, "w", samplerate=src.samplerate, channels=src.channels, format="RF64", subtype="FLOAT") as dry:
        rate = src.samplerate
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
                left = round(cue["start"]*rate)
                right = round(cue["end"]*rate)
                dub = wav_dir / f"{cursor}.wav"
                sample, sr = sf.read(dub if dub.exists() else work/cue["clip"], dtype="float32")
                div = math.gcd(sr, rate)
                resampled = resample_poly(sample, rate//div, sr//div).astype("float32")
                translated = dub.is_file()
                audio = resampled if translated else resampled[:right-left]
                if translated and cursor in targets:
                    audio *= min(128., targets[cursor]/max(active_level(audio), 1e-8))
                active.append((left, right, audio, translated, cue.get("direction")))
                cursor += 1
            mask = np.zeros(len(block), np.float32)
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
                    if translated:
                        fade = turn_fade(np.arange(a-left, source_right-left), source_end-left, rate)
                        mask[window] = np.maximum(mask[window], fade)
                # A translation may finish naturally in the gap after the source
                # turn. Its timing is independent of the subtraction mask above.
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
            vocal[solo] = vocal[solo].mean(axis=1, keepdims=True) * solo_pan[solo]
            # Keep original samples outside translated intervals, including untranscribed sounds.
            dst.write(block + mask[:, None]*(retained - vocal))
            dry.write(voices)


if __name__ == "__main__":
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    work, wav_dir = map(Path, sys.argv[1:3])
    language = sys.argv[3]
    synthesize(json.loads((work/"speakers.json").read_text()),
               json.loads((work/f"translation-{language}.json").read_text()),
               language, work, wav_dir, list(map(int, sys.argv[4:])), device())
