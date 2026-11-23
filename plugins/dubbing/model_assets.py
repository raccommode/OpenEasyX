"""Cache pinned model assets shared by local dubbing jobs."""
import hashlib
import os
import tempfile
from pathlib import Path
from urllib.request import urlopen


def _verified(path, size, sha256):
    try:
        if not path.is_file() or path.stat().st_size != size:
            return False
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest() == sha256
    except FileNotFoundError:
        return False


def verified_asset(group, filename, url, size, sha256, *, label=None) -> Path:
    """Resolve an override or cache a verified download, publishing only complete files."""
    label = label or f"{group} model"
    override = os.environ.get("EASYX_DUBBING_MODELS")
    if override:
        local = Path(override) / group / filename
        if local.exists():
            if not _verified(local, size, sha256):
                raise RuntimeError(f"Invalid {label} checksum at {local}")
            return local

    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")).parent / group
    target = cache / filename
    if _verified(target, size, sha256):
        return target
    if os.environ.get("HF_HUB_OFFLINE", "").upper() in {"1", "ON", "YES", "TRUE"}:
        raise RuntimeError(f"{label} is unavailable offline. Place a verified copy at {target}")

    cache.mkdir(parents=True, exist_ok=True)
    with urlopen(url, timeout=60) as response:
        pending = tempfile.NamedTemporaryFile(dir=cache, prefix=filename + ".", delete=False)
        partial = Path(pending.name)
        try:
            digest = hashlib.sha256()
            received = 0
            with pending:
                while chunk := response.read(min(1024 * 1024, size - received + 1)):
                    received += len(chunk)
                    if received > size:
                        break
                    digest.update(chunk)
                    pending.write(chunk)
            if received != size or digest.hexdigest() != sha256:
                raise RuntimeError(f"Downloaded {label} has an invalid checksum")
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    return target
