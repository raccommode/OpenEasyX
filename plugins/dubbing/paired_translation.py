"""Sentence-level text translation for locally tested source/target pairs."""
import gc
import hashlib
import json
import re
from collections import Counter

import torch

from inference_memory import cuda_allocation_failed, free_cuda_bytes
from runtime import device, model_path, progress, save_json


# Increment the recipe if the checkpoint or decoding changes. Legacy audio or
# NLLB translations must not bypass the new reader when a job resumes.
PAIRS = {("en", "fr"): ("translation_en_fr", "opus-en-fr-v1")}
ABBREVIATION = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr|St|[A-Z])\.$")
NUMERAL = re.compile(r"\d+(?:[.,:/-]\d+)*")
ADDRESS = re.compile(r"^(.*?)(,\s*|\s+)([A-Z][\w'’-]*(?:\.[A-Z][\w'’-]*)*)([!?.]*)$")


def sentences(text):
    # OPUS is a sentence translator. Feeding a second sentence in the same
    # input can cause it to silently drop a greeting, question or response.
    parts, start = [], 0
    for match in re.finditer(r"(?<=[.!?])\s+(?=\S)", text):
        part = text[start:match.start()]
        if ABBREVIATION.search(part):
            continue
        parts.append(part)
        start = match.end()
    return [part for part in (*parts, text[start:]) if part.strip()]


def numeric_values(text):
    # Different typography can express the same number: 1,200 → 1 200 and
    # 8:15 → 8h15. Preserve numeric values and multiplicity across the cue.
    text = re.sub(r"(?<=\d)[, \u00a0\u202f](?=\d{3}(?!\d))", "", text)
    return Counter(re.findall(r"\d+", text))


def finish_fragment(source, result):
    result = result.strip()
    if not re.search(r"[.!?…]\s*$", source):
        result = result.rstrip(".!?… ").rstrip()
    return result


def translate_sentences(lines, generate):
    split = [sentences(line.strip()) for line in lines]
    unique = list(dict.fromkeys(part for line in split for part in line))
    outputs = dict(zip(unique, generate(unique), strict=True)) if unique else {}

    def fragment(part):
        clean = part.strip()
        if not any(c.isalpha() for c in clean):
            return clean
        if clean not in outputs:
            outputs[clean] = generate([clean])[0]
        result = finish_fragment(clean, outputs[clean])
        if not any(c.isalnum() for c in result):
            raise ValueError("The pair translation model returned an empty phrase")
        return result

    def checked(part):
        translated = fragment(part)
        # A vocative can be replaced by an unrelated stock phrase. Translate
        # the form of address separately if the full sentence dropped it.
        match = ADDRESS.fullmatch(part)
        if match:
            prefix, separator, name, ending = match.groups()
            explicit = "," in separator or (len(name) >= 2 and name.isupper())
            if explicit and any(c.isalpha() for c in prefix) and not re.search(
                    rf"(?<!\w){re.escape(name)}(?!\w)", translated, re.IGNORECASE):
                address = fragment(name)
                translated = f"{fragment(prefix)}, {address}{ending}"
        expected = numeric_values(part)
        if expected - numeric_values(translated):
            # Keep the positions of numbers when the model omits or changes
            # one, translating the surrounding language on either side.
            chunks, cursor = [], 0
            for number in NUMERAL.finditer(part):
                before = part[cursor:number.start()]
                if before:
                    chunks.extend((before[:len(before)-len(before.lstrip())], fragment(before),
                                   before[len(before.rstrip()):] if before.strip() else ""))
                chunks.append(number.group())
                cursor = number.end()
            after = part[cursor:]
            if after:
                chunks.extend((after[:len(after)-len(after.lstrip())], fragment(after)))
            translated = "".join(chunks).strip()
            if expected - numeric_values(translated):
                raise ValueError("The pair translation model changed a number")
        return translated

    return [" ".join(checked(part) for part in line) for line in split]


def translate_pair_lines(lines, model_key):
    from transformers import MarianMTModel, MarianTokenizer
    directory = model_path(model_key)
    tokenizer = MarianTokenizer.from_pretrained(directory, local_files_only=True)
    backend = device()
    if backend == "cuda" and free_cuda_bytes() < 1536*1024**2:
        backend = "cpu"
    while True:
        model = None
        try:
            model = MarianMTModel.from_pretrained(directory, dtype=torch.float32, local_files_only=True).eval().to(backend)

            def generate(parts):
                values = []
                with torch.inference_mode():
                    for start in range(0, len(parts), 8):
                        encoded = tokenizer(parts[start:start+8], padding=True, return_tensors="pt").to(backend)
                        ids = model.generate(**encoded, num_beams=4, max_new_tokens=256)
                        values.extend(tokenizer.batch_decode(ids, skip_special_tokens=True))
                return values

            return translate_sentences(lines, generate)
        except RuntimeError as error:
            exhausted = cuda_allocation_failed(error) if backend == "cuda" else (
                isinstance(error, torch.OutOfMemoryError) or "mps backend out of memory" in str(error).lower())
            if backend == "cpu" or not exhausted:
                raise
        model = None
        gc.collect()
        if backend == "cuda":
            torch.cuda.empty_cache()
        elif backend == "mps":
            torch.mps.empty_cache()
        backend = "cpu"


def apply_pairs(cues, target, cache, texts):
    groups = {}
    for i, cue in enumerate(cues):
        pair = PAIRS.get((cue["language"], target))
        if pair and not cue.get("preserveOriginal"):
            groups.setdefault(pair, []).append(i)
    if not groups:
        return
    checkpoint = cache.with_suffix(".pairs.json")
    try:
        saved = json.loads(checkpoint.read_text())
    except (FileNotFoundError, ValueError, UnicodeError):
        saved = {}
    if not isinstance(saved, dict):
        saved = {}
    for (model_key, recipe), indices in groups.items():
        def key(text):
            return hashlib.sha256((recipe+"\0"+text).encode()).hexdigest()

        missing = list(dict.fromkeys(cues[i]["text"] for i in indices
                                     if not isinstance(saved.get(key(cues[i]["text"])), str) or
                                     not saved[key(cues[i]["text"])].strip()))
        if missing:
            progress("Translating speaker transcripts with OPUS-MT", 30)
            translated = translate_pair_lines(missing, model_key)
            for source, result in zip(missing, translated, strict=True):
                if not result.strip():
                    raise ValueError("The pair translation model returned an empty phrase")
                saved[key(source)] = result
            save_json(checkpoint, saved)
        for i in indices:
            texts[i] = saved[key(cues[i]["text"])]
