"""Estimate a channel-aligned speech stem using Sherpa's 48 kHz DPDFNet2 model."""
import math

import numpy as np
from scipy.signal import resample_poly
from model_assets import verified_asset


MODEL = "dpdfnet2_48khz_hr.onnx"
MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/" + MODEL
MODEL_SIZE = 10_596_848
MODEL_SHA256 = "0b399f8a58dc4d70d8cd97541f5c39869406145193b957d00a03b66070944928"
MODEL_RATE = 48_000
FRAME_SHIFT = 480


def _model_file():
    return verified_asset("sherpa-onnx", MODEL, MODEL_URL, MODEL_SIZE, MODEL_SHA256, label="DPDFNet model")


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
