"""Estimate a channel-aligned speech stem using Sherpa's 48 kHz DPDFNet2 model."""
import hashlib
import math
import os
import tempfile
from pathlib import Path
from urllib.request import urlopen

import numpy as np
from scipy.signal import resample_poly


MODEL = "dpdfnet2_48khz_hr.onnx"
MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/" + MODEL
MODEL_SIZE = 10_596_848
MODEL_SHA256 = "0b399f8a58dc4d70d8cd97541f5c39869406145193b957d00a03b66070944928"
MODEL_RATE = 48_000
FRAME_SHIFT = 480


def _verified(path):
    return (path.is_file() and path.stat().st_size == MODEL_SIZE
            and hashlib.sha256(path.read_bytes()).hexdigest() == MODEL_SHA256)


def _model_file():
    override = os.environ.get("EASYX_DUBBING_MODELS")
    if override:
        local = Path(override) / "sherpa-onnx" / MODEL
        if local.exists():
            if not _verified(local):
                raise RuntimeError(f"Invalid DPDFNet model checksum at {local}")
            return local

    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")).parent / "sherpa-onnx"
    target = cache / MODEL
    if _verified(target):
        return target
    if os.environ.get("HF_HUB_OFFLINE", "").upper() in {"1", "ON", "YES", "TRUE"}:
        raise RuntimeError(f"DPDFNet model is unavailable offline. Place a verified copy at {target}")

    with urlopen(MODEL_URL, timeout=60) as response:
        data = response.read(MODEL_SIZE + 1)
    if len(data) != MODEL_SIZE or hashlib.sha256(data).hexdigest() != MODEL_SHA256:
        raise RuntimeError("Downloaded DPDFNet model has an invalid checksum")
    cache.mkdir(parents=True, exist_ok=True)
    pending = tempfile.NamedTemporaryFile(dir=cache, prefix=MODEL + ".", delete=False)
    partial = Path(pending.name)
    try:
        with pending:
            pending.write(data)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def speech_enhancer():
    import sherpa_onnx as so
    model = so.OfflineSpeechDenoiserDpdfNetModelConfig(model=str(_model_file()))
    config = so.OfflineSpeechDenoiserModelConfig(dpdfnet=model, num_threads=2, provider="cpu")
    return so.OfflineSpeechDenoiser(so.OfflineSpeechDenoiserConfig(model=config))


def enhance_speech(model, samples, rate):
    """Return the speech estimate in the input's channel layout and sample clock."""
    samples = np.asarray(samples, dtype=np.float32)
    result = np.zeros_like(samples)
    if not len(samples):
        return result
    divisor = math.gcd(rate, MODEL_RATE)
    up, down = MODEL_RATE // divisor, rate // divisor
    for channel in range(samples.shape[1]):
        original = samples[:, channel]
        if not np.any(original):
            continue
        input_audio = resample_poly(original, up, down)
        # Sherpa emits whole 10 ms frames. Keep the final partial frame and
        # provide a complete analysis window even for a very short clip.
        padded = max(2 * FRAME_SHIFT, math.ceil(len(input_audio) / FRAME_SHIFT) * FRAME_SHIFT)
        input_audio = np.pad(input_audio, (0, padded - len(input_audio)))
        prediction = model.run(input_audio, MODEL_RATE)
        raw = np.asarray(prediction.samples, dtype=np.float32)
        result[:, channel] = resample_poly(raw, down, up)[:len(samples)]
    return result
