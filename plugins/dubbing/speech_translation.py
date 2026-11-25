"""Translate the isolated audio of one speaker at a time, keeping the cue order."""
import gc
import json
import re
from collections import Counter
from difflib import SequenceMatcher

import soundfile as sf
import torch

from runtime import device, model_path, progress, save_json
from speech_review import at16
from voices import LANGUAGES, translate

# Source speech coverage of the pinned SeamlessM4T v2 checkpoint.
SPEECH_INPUTS = set("""
afr amh arb ary arz asm ast azj bel ben bos bul cat ceb ces ckb cmn cym dan deu ell eng est eus fin
fra fuv gaz gle glg guj heb hin hrv hun hye ibo ind isl ita jav jpn kam kan kat kaz kea khk khm
kir kor lao lit ltz lug luo lvs mai mal mar mkd mlt mni mya nld nno nob npi nya oci ory pan
pbt pes pol por ron rus slk slv sna snd som spa srp swe swh tam tel tgk tgl tha tur ukr urd uzn
vie xho yor yue zlm zul
""".split())


def model_language(code):
    if code == "zh":
        return "cmn"
    return LANGUAGES.get(code, {}).get("nllb", "").split("_")[0]


def same_utterance(first, second):
    a, b = ("".join(c for c in text.casefold() if c.isalnum()) for text in (first, second))
    return bool(a and b) and SequenceMatcher(None, a, b, autojunk=False).ratio() >= .72


def translate_line(model, processor, cue, work, target, backend, dtype):
    samples, rate = sf.read(work / cue["clip"], dtype="float32", always_2d=True)
    audio = at16(samples.mean(axis=1), rate)
    if len(audio) < 1600:
        return None
    features = processor(audio=audio, sampling_rate=16000, return_tensors="pt").to(backend, dtype)
    def generate(language):
        tokens = model.generate(**features, tgt_lang=language, num_beams=4, max_new_tokens=192, no_repeat_ngram_size=3)
        return processor.batch_decode(tokens, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0].strip()
    with torch.inference_mode():
        result = generate(model_language(target))
        if not any(c.isalnum() for c in result):
            return None
        # No other voice may supply the words in an overlap. Compare independent
        # source-language decodes before using a direct translation of that clip.
        source = model_language(cue["language"])
        if cue.get("overlapping") and source in model.generation_config.text_decoder_lang_to_code_id:
            if not same_utterance(cue["text"], generate(source)):
                return None
    # Read addresses, times and other numbers from the verified transcript if
    # the direct translation dropped them. NLLB handles the fallback locally.
    if Counter(re.findall(r"\d+", cue["text"])) - Counter(re.findall(r"\d+", result)):
        return None
    return result


def translate_speech(cues, target, work, cache):
    from transformers import SeamlessM4TProcessor, SeamlessM4Tv2ForSpeechToText
    texts = [None] * len(cues)
    if cache.is_file():
        try:
            saved = json.loads(cache.read_text())
        except (ValueError, UnicodeError):
            saved = None
        if isinstance(saved, list) and len(saved) == len(cues):
            texts = [v if isinstance(v, str) and v.strip() else None for v in saved]
    pending = []
    for i, cue in enumerate(cues):
        if cue["language"] == target:
            texts[i] = cue["text"]
        elif texts[i] is None and model_language(cue["language"]) in SPEECH_INPUTS:
            pending.append(i)
    backend = device()
    if pending:
        model_dir = model_path("speech_translation")
        processor = SeamlessM4TProcessor.from_pretrained(model_dir)
        if backend == "cuda" and torch.cuda.mem_get_info()[0] < 4 * 1024**3:
            backend = "cpu"
        model = None
        done = 0
        while done < len(pending):
            dtype = torch.float32 if backend == "cpu" else torch.float16
            try:
                if model is None:
                    model = SeamlessM4Tv2ForSpeechToText.from_pretrained(model_dir, dtype=dtype).eval().to(backend)
                for idx in pending[done:]:
                    cue = cues[idx]
                    progress(f"Translating speaker {cue['speaker']+1} from audio into {target}", 30+7*idx/len(cues))
                    texts[idx] = translate_line(model, processor, cue, work, target, backend, dtype)
                    save_json(cache, texts)
                    done += 1
            except RuntimeError as error:
                memory_error = isinstance(error, torch.OutOfMemoryError) or (
                    backend == "mps" and "mps backend out of memory" in str(error).lower())
                if backend == "cpu" or not memory_error:
                    raise
            else:
                break
            model = None
            gc.collect()
            if backend == "cuda":
                torch.cuda.empty_cache()
            elif backend == "mps":
                torch.mps.empty_cache()
            backend = "cpu"
        del model, processor
        gc.collect()
        if backend == "mps":
            torch.mps.empty_cache()
        elif backend == "cuda":
            torch.cuda.empty_cache()
    if any(text is None for text in texts):
        save_json(cache, texts)
        progress("Translating verified speaker transcripts", 36)
        texts = translate(cues, target, cache)
    save_json(cache, texts)
    return texts
