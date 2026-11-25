"""Split film dialogue, music and effects with the multilingual Bandit v2 checkpoint."""
import numpy as np
import torch
from scipy.signal import resample_poly

from model_assets import verified_asset
from runtime import device, progress


# Watcharasupat, Wu & Orife, 2024. Official DnR v3 multilingual weights, CC BY-SA 4.0.
MODEL = "checkpoint-multi.ckpt"
URL = "https://zenodo.org/records/12701995/files/" + MODEL
SHA256 = "abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc"


def cinematic_separator():
    from bandit_infer._v2.runtime import V2Runtime
    path = verified_asset("bandit-v2", MODEL, URL, 446_680_129, SHA256, label="Bandit v2")
    # Stream the trained graph directly. The upstream file handler pads each
    # call by 14 seconds per side; our film reader overlaps adjacent calls.
    accelerator = torch.device("cuda" if device() == "cuda" else "cpu")
    try:
        return V2Runtime(path, accelerator).model
    except torch.cuda.OutOfMemoryError:
        if accelerator.type != "cuda":
            raise
    torch.cuda.empty_cache()
    progress("Separating dialogue on CPU while GPU memory is busy", 2)
    return V2Runtime(path, torch.device("cpu")).model


def _speech(model, audio, accelerator):
    # The trained model processes mono signals. Keep film channels independent,
    # including opposite-phase stereo, with at most two channels per forward.
    wave = torch.from_numpy(np.ascontiguousarray(audio.T))[:, None, :].to(accelerator)
    with torch.inference_mode():
        stems = model({"mixture": {"audio": wave}})["estimates"]
        speech = stems["speech"]["spectrogram"]
        power = speech.abs().square()
        background = stems["music"]["spectrogram"].abs().square() + stems["sfx"]["spectrogram"].abs().square()
        # Preserve background-dominant bins without aggressively suppressing a
        # quieter second voice. Work with the model's complex phase estimates.
        confidence = power / (power + .05*background + 1e-12)
        return model.istft(speech * confidence, wave.shape[-1])[:, 0, :].cpu().numpy().T


def isolate_dialogue(model, samples):
    """Return only removable speech, sample-aligned with the 44.1 kHz source."""
    speech = np.zeros_like(samples, dtype=np.float32)
    if not len(samples) or np.max(np.abs(samples)) < 1e-7:
        return speech
    for ch in range(0, samples.shape[1], 2):
        pair = samples[:, ch:ch+2]
        native = resample_poly(pair, 160, 147, axis=0).astype("float32", copy=False)
        # Reflect-padding in the network STFT needs at least a half-window.
        if len(native) < 2048:
            native = np.pad(native, ((0, 2048-len(native)), (0, 0)))
        accelerator = next(model.parameters()).device
        try:
            estimate = _speech(model, native, accelerator)
        except torch.cuda.OutOfMemoryError:
            if accelerator.type != "cuda":
                raise
            estimate = None
        if estimate is None:
            model.cpu()
            torch.cuda.empty_cache()
            progress("Separating dialogue on CPU while GPU memory is busy", 2)
            estimate = _speech(model, native, torch.device("cpu"))
        speech[:, ch:ch+2] = resample_poly(estimate, 147, 160, axis=0)[:len(samples)]
    return speech
