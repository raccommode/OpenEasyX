"""Lazy environment and model files shared by dubbing jobs on this server."""
from collections import deque
import hashlib
from importlib import metadata
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
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


def run_installer(stage, command):
    """Keep the nested resolver failure when pip finishes with a generic build-error footer."""
    diagnoses, recent = [], deque(maxlen=4)
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace") as process:
        for line in process.stdout:
            sys.stderr.write(line)
            message = line.strip()
            if not message:
                continue
            recent.append(message)
            if len(diagnoses) < 3 and any(part in message.lower() for part in (
                    "error:", "fatal error", "no matching distribution", "no space left",
                    "certificate_verify_failed", "timed out", "connection refused")):
                if message not in diagnoses and "subprocess-exited-with-error" not in message.lower():
                    diagnoses.append(message)
        if process.wait():
            details = " / ".join(s[:240] for s in (diagnoses or recent)) or "pip exited without a diagnostic"
            raise RuntimeError(f"{stage} failed: {details}")


def install_dependencies(requirements, cuda):
    pip = [sys.executable, "-m", "pip", "--disable-pip-version-check", "--no-cache-dir"]
    install = [*pip, "install", "--progress-bar", "off"]
    # Bookworm's pip 23 rejects some normalized project names in wheel metadata.
    run_installer("Updating the dubbing installer", [*install, "pip>=24"])
    packages = ["torch==2.9.1", "torchaudio==2.9.1"]
    if sys.platform != "linux":
        run_installer("Installing dubbing dependencies", [*install, *packages, "-r", str(requirements)])
        return
    # Choose only the two platform wheels at PyTorch. Its CUDA and CPU indexes
    # are not complete package indexes for dependencies or isolated builds.
    variant = "cu128" if cuda else "cpu"
    try:
        already_installed = all(metadata.version(name) == f"2.9.1+{variant}" for name in ("torch", "torchaudio"))
    except metadata.PackageNotFoundError:
        already_installed = False
    if already_installed:
        # A model or plugin dependency changed while the platform wheels stayed pinned.
        run_installer("Installing dubbing dependencies", [*install, *packages, "-r", str(requirements)])
        return
    index = "https://download.pytorch.org/whl/" + variant
    with tempfile.TemporaryDirectory(prefix="easyx-torch-") as folder:
        run_installer("Downloading PyTorch wheels", [*pip, "download", "--progress-bar", "off",
            "--index-url", index, "--only-binary=:all:", "--no-deps", "--dest", folder, *packages])
        wheels = sorted(Path(folder).glob("*.whl"))
        if len(wheels) != 2:
            raise RuntimeError("The PyTorch index did not provide both requested wheels")
        run_installer("Installing dubbing dependencies", [*install, *map(str, wheels), "-r", str(requirements)])


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
                run_installer("Restoring pip", [sys.executable, "-m", "ensurepip", "--upgrade"])
            install_dependencies(requirements, cuda)
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
    "translation_en_fr": ("Helsinki-NLP/opus-mt-tc-big-en-fr", "6e062862ced6f5622a589ab2aadc2a1d4978db78"),
    "speech_translation": ("facebook/seamless-m4t-v2-large", "5f8cc790b19fc3f67a61c105133b20b34e3dcb76"),
    "voice": ("k2-fsa/OmniVoice", "3fc979d1cd72492cd679c5ac2611e0d7ac047ba1"),
    "translation": ("facebook/nllb-200-distilled-600M", "f8d333a098d19b4fd9a8b18f94170487ad3f821d"),
    "segmentation": ("csukuangfj/sherpa-onnx-pyannote-segmentation-3-0", "9403a6902bb58e3d5ae8c7e77c3422de279db2e0"),
    "embedding": ("csukuangfj/speaker-embedding-models", "a8055d6daef723a6a4ecf4de233708575bf4994f"),
    "detector": ("opencv/face_detection_yunet", "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310"),
    "face": ("opencv/face_recognition_sface", "3d7082438a6e4551e840c9b2bb60b71e8da4b524"),
    "lips": ("facefusion/models-3.3.0", "6271ab1c4619ceb2e534d65e0ec973f22a9aec38"),
    "mouth": ("facefusion/models-3.0.0", "728b9659bd9691bf32cbf7f61af478d94b7ba81e"),
}

# Exact inference files in each pinned snapshot. An interrupted download can
# leave a valid snapshot directory containing only a tokenizer or one shard.
SNAPSHOT_FILES = {
    "translation_en_fr": ["config.json", "generation_config.json", "model.safetensors", "source.spm",
        "target.spm", "tokenizer_config.json", "special_tokens_map.json", "vocab.json"],
    "speech_translation": ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer_config.json",
        "special_tokens_map.json", "added_tokens.json", "tokenizer.model", "sentencepiece.bpe.model",
        "model.safetensors.index.json", "model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"],
    "translation": ["config.json", "generation_config.json", "pytorch_model.bin", "sentencepiece.bpe.model",
        "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"],
    "voice": ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja",
        "audio_tokenizer/config.json", "audio_tokenizer/model.safetensors", "audio_tokenizer/preprocessor_config.json"],
}


def model_path(key, filename=None):
    from huggingface_hub import hf_hub_download, snapshot_download, try_to_load_from_cache
    repo, revision = MODELS[key]
    root = os.environ.get("EASYX_DUBBING_MODELS")
    if root:
        local = Path(root) / repo.split("/")[-1]
        if filename:
            local /= filename
        if local.exists():
            return str(local)
    offline = os.environ.get("HF_HUB_OFFLINE", "").upper() in {"1", "YES", "ON", "TRUE"}
    files = [filename] if filename else SNAPSHOT_FILES[key]
    cached = [try_to_load_from_cache(repo, name, revision=revision) for name in files]
    if all(isinstance(path, str) for path in cached):
        return cached[0] if filename else str(Path(cached[0]).parent)
    if filename:
        return hf_hub_download(repo, filename, revision=revision, local_files_only=offline)
    return snapshot_download(repo, revision=revision, allow_patterns=files, local_files_only=offline)


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def save_json(path, value):
    partial = path.with_suffix(".partial.json")
    partial.write_text(json.dumps(value, ensure_ascii=False))
    partial.replace(path)
