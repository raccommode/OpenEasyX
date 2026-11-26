"""Memory placement for the local speech models."""
import gc
import os
import sys
from pathlib import Path


def release_models():
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None:
        if torch.cuda.is_initialized():
            torch.cuda.empty_cache()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    if sys.platform.startswith("linux"):
        import ctypes
        trim = getattr(ctypes.CDLL(None), "malloc_trim", None)
        if trim is not None:
            trim(0)


def cuda_allocation_failed(error):
    import torch
    if isinstance(error, torch.cuda.OutOfMemoryError):
        return True
    reason = str(error).lower()
    return (("cuda" in reason and "out of memory" in reason) or
            any(code in reason for code in ("cuda_error_out_of_memory", "cudaerrormemoryallocation",
                                            "cublas_status_alloc_failed", "cudnn_status_alloc_failed")))


def free_cuda_bytes():
    import torch
    try:
        return torch.cuda.mem_get_info()[0]
    except RuntimeError as error:
        # Creating a fresh CUDA context can itself fail on a shared card.
        if not cuda_allocation_failed(error):
            raise
        return 0


def memory_cgroups():
    # A private Docker namespace normally exposes the leaf at mount root.
    # With a shared namespace the process can have tighter nested limits.
    root = Path("/sys/fs/cgroup")
    roots = (root, root/"memory")
    try:
        membership = Path("/proc/self/cgroup").read_text().splitlines()
    except OSError:
        membership = []
    for line in membership:
        _, controllers, relative = line.split(":", 2)
        if controllers and "memory" not in controllers.split(","):
            continue
        mount = roots[int(bool(controllers))]
        path = Path(relative.lstrip("/"))
        if ".." not in path.parts:
            for suffix in (path, *path.parents):
                if suffix.parts:
                    yield mount/suffix
    yield from roots


def cgroup_oom_kills():
    for group in memory_cgroups():
        for filename in ("memory.events", "memory.oom_control"):
            try:
                counts = dict(line.split() for line in (group/filename).read_text().splitlines())
                return int(counts["oom_kill"])
            except (OSError, ValueError, KeyError):
                continue
    return None


def compact_cpu():
    limits = []
    for group in memory_cgroups():
        for name in ("memory.max", "memory.limit_in_bytes"):
            try:
                limits.append(int((group/name).read_text().strip()))
            except (OSError, ValueError):
                pass
    try:
        limits.append(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
    except (AttributeError, OSError, ValueError):
        pass
    return any(0 < limit <= 8 * 1024**3 for limit in limits)


def isolated_voice_batches():
    return sys.platform.startswith("linux") and compact_cpu()
