"""Lazy environment and model files shared by dubbing jobs on this server."""
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import threading
from pathlib import Path


def publish(**values):
    print("EASYX " + json.dumps(values), flush=True)


def progress(phase, value):
    publish(phase=phase, progress=value)


def has_nvidia():
    from shutil import which
    return Path("/dev/nvidiactl").exists() or (which("nvidia-smi") and
           subprocess.run(["nvidia-smi", "-L"], capture_output=True).returncode == 0)


def provision(data):
    if not os.environ.get("EASYX_DUBBING_PYTHON") and sys.version_info[:2] not in ((3, 11), (3, 12)):
        from shutil import which
        compatible = which("python3.12") or which("python3.11")
        if compatible:
            os.execv(compatible, [compatible, *sys.argv])
        if sys.version_info < (3, 11) or sys.version_info >= (3, 14):
            raise RuntimeError("Install Python 3.11 or 3.12 with venv support to run Local Dubbing")
    device = os.environ.get("EASYX_DUBBING_DEVICE", "auto")
    cuda = device == "cuda" or (device == "auto" and has_nvidia())
    base = data / "dubbing-runtime" / f"{sys.platform}-{platform.machine()}-{sys.version_info.major}.{sys.version_info.minor}-{'cuda' if cuda else 'cpu'}"
    if not os.environ.get("EASYX_DUBBING_PYTHON"):
        if Path(sys.prefix).resolve() != base.resolve():
            exe = base / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            if not exe.is_file():
                subprocess.run([sys.executable, "-m", "venv", str(base)], check=True)
            os.execv(str(exe), [str(exe), *sys.argv])
        requirements = Path(__file__).with_name("requirements.txt")
        version = hashlib.sha256(requirements.read_bytes() + b"torch2.9.1").hexdigest()
        marker = base / ".ready"
        if not marker.exists() or marker.read_text() != version:
            progress("Installing local dubbing dependencies", 0)
            # venv writes bin/python before ensurepip finishes. A cancelled
            # first installation can leave a valid interpreter without pip.
            from importlib.util import find_spec
            if find_spec("pip") is None:
                subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"], check=True)
            pip = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir"]
            index = ["--index-url", "https://download.pytorch.org/whl/" + ("cu128" if cuda else "cpu")] if sys.platform == "linux" else []
            subprocess.run([*pip, *index, "torch==2.9.1", "torchaudio==2.9.1"], check=True)
            subprocess.run([*pip, "-r", str(requirements)], check=True)
            marker.write_text(version)
    if cuda and sys.platform == "linux":
        # CTranslate2 loads cuDNN and cuBLAS dynamically from the installed PyTorch wheels.
        import sysconfig
        vendor = Path(sysconfig.get_path("purelib")) / "nvidia"
        paths = [str(p) for p in sorted(vendor.glob("*/lib"))]
        previous = os.environ.get("LD_LIBRARY_PATH", "").split(os.pathsep)
        missing = [p for p in paths if p not in previous]
        if missing:
            os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(missing + [p for p in previous if p])
            os.execv(sys.executable, [sys.executable, *sys.argv])


def parent_watch():
    def watch():
        # A daemon blocked in BufferedReader.read holds the interpreter's stdin
        # lock during normal shutdown. A blocking file-descriptor read does not.
        while os.read(0, 4096):
            pass
        if hasattr(os, "killpg") and os.getpid() == os.getpgrp():
            os.killpg(os.getpid(), signal.SIGTERM)
        else:
            os._exit(1)
    if os.environ.get("EASYX_DUBBING_PARENT"):
        threading.Thread(target=watch, daemon=True).start()


def device():
    import torch
    selected = os.environ.get("EASYX_DUBBING_DEVICE", "auto")
    if selected == "auto":
        return "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    if selected not in ("cpu", "cuda", "mps"):
        raise ValueError("EASYX_DUBBING_DEVICE must be auto, cuda, mps or cpu")
    if selected == "cuda" and not torch.cuda.is_available() or selected == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError(f"The requested {selected} device is unavailable in the dubbing runtime")
    return selected


def whisper_device():
    # CTranslate2's Linux ARM64 wheels support CPU even on a CUDA-enabled
    # PyTorch host. Other stages can still run on that host's GPU.
    if device() == "cuda":
        import ctranslate2
        if ctranslate2.get_cuda_device_count() and "float16" in ctranslate2.get_supported_compute_types("cuda"):
            return "cuda"
    return "cpu"


MODELS = {
    "voice": ("k2-fsa/OmniVoice", "3fc979d1cd72492cd679c5ac2611e0d7ac047ba1"),
    "translation": ("facebook/nllb-200-distilled-600M", "f8d333a098d19b4fd9a8b18f94170487ad3f821d"),
    "segmentation": ("csukuangfj/sherpa-onnx-pyannote-segmentation-3-0", "9403a6902bb58e3d5ae8c7e77c3422de279db2e0"),
    "embedding": ("csukuangfj/speaker-embedding-models", "a8055d6daef723a6a4ecf4de233708575bf4994f"),
    "detector": ("opencv/face_detection_yunet", "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310"),
    "face": ("opencv/face_recognition_sface", "3d7082438a6e4551e840c9b2bb60b71e8da4b524"),
    "lips": ("facefusion/models-3.3.0", "6271ab1c4619ceb2e534d65e0ec973f22a9aec38"),
    "mouth": ("facefusion/models-3.0.0", "728b9659bd9691bf32cbf7f61af478d94b7ba81e"),
}


def model_path(key, filename=None):
    from huggingface_hub import hf_hub_download, snapshot_download
    repo, revision = MODELS[key]
    root = os.environ.get("EASYX_DUBBING_MODELS")
    if root:
        local = Path(root) / repo.split("/")[-1]
        if filename:
            local /= filename
        if local.exists():
            return str(local)
    if filename:
        return hf_hub_download(repo, filename, revision=revision)
    patterns = ["*.json", "*.jinja", "*.safetensors"] if key == "voice" else ["*.json", "*.model", "pytorch_model.bin"]
    return snapshot_download(repo, revision=revision, allow_patterns=patterns)


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def save_json(path, value):
    partial = path.with_suffix(".partial.json")
    partial.write_text(json.dumps(value, ensure_ascii=False))
    partial.replace(path)
