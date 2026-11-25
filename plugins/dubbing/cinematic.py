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


def _bounded_backbone(backbone, features, positions):
    # In this pinned Bandit v2 graph each bidirectional GRU is followed by a
    # transpose. Its second axis contains independent sequences. Split only
    # that axis, keeping the full time or frequency context in each direction.
    stages = backbone.seqband
    for i in range(0, len(stages), 2):
        rows = max(1, positions//features.shape[2])
        for group in features.split(rows, dim=1):
            group.copy_(stages[i](group))
        features = stages[i+1](features)
    return features


def _speech(model, audio, accelerator, positions=None):
    # The trained model processes mono signals. Keep film channels independent,
    # including opposite-phase stereo, with at most two channels per forward.
    wave = torch.from_numpy(np.ascontiguousarray(audio.T))[:, None, :].to(accelerator)
    with torch.inference_mode():
        if positions is None:
            stems = model({"mixture": {"audio": wave}})["estimates"]
            speech = stems["speech"]["spectrogram"]
            background = stems["music"]["spectrogram"].abs().square() + stems["sfx"]["spectrogram"].abs().square()
        else:
            spectrum = model.stft(wave)
            features = _bounded_backbone(model.tf_model, model.band_split(spectrum), positions)
            speech = model.mask_estim["speech"](features)*spectrum
            background = torch.zeros_like(speech.real)
            for name in ("music", "sfx"):
                background.add_((model.mask_estim[name](features)*spectrum).abs().square())
        power = speech.abs().square()
        # Preserve background-dominant bins without aggressively suppressing a
        # quieter second voice. Work with the model's complex phase estimates.
        confidence = power / (power + .05*background + 1e-12)
        return model.istft(speech * confidence, wave.shape[-1])[:, 0, :].cpu().numpy().T


def _cuda_speech(model, audio, accelerator):
    # Keep the working shape for the rest of this resident model's film.
    # None selects the upstream graph, the numbers bound its GRU workspace.
    modes = ((2, None), (1, None), (1, 4096), (1, 1024))
    previous = getattr(model, "_easyx_cuda_mode", 0)
    for i in range(previous, len(modes)):
        channels, positions = modes[i]
        if i == 0 and audio.shape[1] == 1:
            continue
        try:
            estimates = [_speech(model, audio[:, ch:ch+channels], accelerator, positions)
                         for ch in range(0, audio.shape[1], channels)]
        except torch.cuda.OutOfMemoryError:
            pass
        else:
            if i != 1 or audio.shape[1] > 1:
                model._easyx_cuda_mode = i
            return np.concatenate(estimates, axis=1) if len(estimates) > 1 else estimates[0]
        # Inside the except block the traceback still owns the failed forward's tensors.
        torch.cuda.empty_cache()
    return None


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
        if accelerator.type == "cuda":
            estimate = _cuda_speech(model, native, accelerator)
            if estimate is None:
                model.cpu()
                torch.cuda.empty_cache()
                progress("Separating dialogue on CPU while GPU memory is busy", 2)
                estimate = _speech(model, native, torch.device("cpu"))
        else:
            estimate = _speech(model, native, accelerator)
        speech[:, ch:ch+2] = resample_poly(estimate, 147, 160, axis=0)[:len(samples)]
    return speech
