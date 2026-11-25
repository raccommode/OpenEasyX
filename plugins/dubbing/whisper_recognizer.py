"""Resolve one Whisper checkpoint and retry an interrupted CUDA turn on CPU."""
import gc
import os
from pathlib import Path
import sys

from inference_memory import cuda_allocation_failed, free_cuda_bytes
from runtime import whisper_device


# Systran's original conversions use Whisper's default 80-bin feature extractor
# and vocabulary.txt. Its v3 and distilled conversions ship feature settings.
CLASSIC_MODELS = {"tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v1", "large-v2"}


def complete_snapshot(root, name, *, custom=False, feature_optional=False):
    classic = name.removeprefix("Systran/faster-whisper-") in CLASSIC_MODELS
    files = ["config.json", "model.bin", "tokenizer.json"]
    if classic:
        files.append("vocabulary.txt")
    else:
        files.append("vocabulary.txt" if custom and not (root/"vocabulary.json").is_file() else "vocabulary.json")
        if not feature_optional:
            files.append("preprocessor_config.json")
    return all((root/f).is_file() and (root/f).stat().st_size > 0 for f in files)


def model_directory(cache):
    from faster_whisper.utils import _MODELS, download_model
    from huggingface_hub import _CACHED_NO_EXIST, hf_hub_download, try_to_load_from_cache
    from huggingface_hub.errors import EntryNotFoundError, LocalEntryNotFoundError

    name = os.getenv("EASYX_WHISPER_MODEL", "small")
    configured = Path(name)
    if configured.is_dir():
        if configured.parent.name == "snapshots":
            repo = configured.parent.parent.name.removeprefix("models--").replace("--", "/")
            custom = repo not in _MODELS.values()
            absent = custom and try_to_load_from_cache(repo, "preprocessor_config.json", revision=configured.name,
                                                       cache_dir=configured.parents[2]) is _CACHED_NO_EXIST
            if not complete_snapshot(configured, repo, custom=custom, feature_optional=absent):
                raise RuntimeError(f"Incomplete Whisper checkpoint in {configured}")
        return configured
    directory = None if cache is None else str(cache)
    custom = "/" in name and name not in _MODELS.values()
    feature = "preprocessor_config.json"

    def ready(path):
        if complete_snapshot(path, name, custom=custom):
            return True
        if custom and complete_snapshot(path, name, custom=True, feature_optional=True):
            absent = try_to_load_from_cache(name, feature, revision=path.name, cache_dir=directory)
            return absent is _CACHED_NO_EXIST
        return False

    try:
        cached = Path(download_model(name, cache_dir=directory, local_files_only=True))
    except LocalEntryNotFoundError:
        cached = None
    if cached is not None and ready(cached):
        return cached
    offline = os.getenv("HF_HUB_OFFLINE", "").upper() in {"1", "ON", "YES", "TRUE"}
    resolved = Path(download_model(name, cache_dir=directory, local_files_only=offline))
    if custom and complete_snapshot(resolved, name, custom=True, feature_optional=True) and not (resolved/feature).is_file():
        # A custom conversion can legitimately use the default feature settings.
        # The Hub caches a definitive 404 per revision, separately from network errors.
        try:
            hf_hub_download(name, feature, revision=resolved.name, cache_dir=directory, local_files_only=offline)
        except LocalEntryNotFoundError:
            raise
        except EntryNotFoundError:
            return resolved
    if not complete_snapshot(resolved, name, custom=custom):
        raise RuntimeError(f"Incomplete Whisper checkpoint for {name} in {resolved}")
    return resolved


class WhisperRecognizer:
    def __init__(self, cache):
        self.path = model_directory(cache)
        try:
            self.device = whisper_device()
            if self.device == "cuda":
                # Reserve room for CTranslate2's workspace as well as weights.
                required = max(2*1024**3, (self.path/"model.bin").stat().st_size + 1024**3)
                if free_cuda_bytes() < required:
                    self.device = "cpu"
                    print("Whisper is using CPU int8 because CUDA memory is low", file=sys.stderr, flush=True)
        except (RuntimeError, MemoryError) as error:
            if not cuda_allocation_failed(error):
                raise
            self.device = "cpu"
            print("Whisper is using CPU int8 after a CUDA allocation failure", file=sys.stderr, flush=True)
        self.model = None

    def _load(self):
        from faster_whisper import WhisperModel
        if self.model is None:
            self.model = WhisperModel(str(self.path), device=self.device,
                                      compute_type="float16" if self.device == "cuda" else "int8", cpu_threads=2)
        return self.model

    def _run(self, operation):
        try:
            return operation(self._load())
        except (RuntimeError, MemoryError) as error:
            if self.device != "cuda" or not cuda_allocation_failed(error):
                raise
        # Leave the except block first so its traceback no longer owns the
        # failed decoder/generator. Subsequent turns reuse the CPU model.
        import torch
        self.model = None
        gc.collect()
        torch.cuda.empty_cache()
        self.device = "cpu"
        print("Whisper is retrying on CPU int8 after a CUDA allocation failure", file=sys.stderr, flush=True)
        return operation(self._load())

    def transcribe(self, audio, **options):
        def decode(model):
            segments, info = model.transcribe(audio, **options)
            # CTranslate2 may fail halfway through this lazy iterator. Expose
            # segments only once the complete turn and its language are known.
            return list(segments), info
        return self._run(decode)

    def detect_language(self, **options):
        return self._run(lambda model: model.detect_language(**options))
