"""Memory placement for the local speech models."""
import gc
import os
from pathlib import Path


def release_models():
    import torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()


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


def compact_cpu():
    # cgroup v2 and v1 can impose a tighter limit than the physical host.
    limits = []
    for name in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            limits.append(int(Path(name).read_text().strip()))
        except (OSError, ValueError):
            pass
    try:
        limits.append(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
    except (AttributeError, OSError, ValueError):
        pass
    return any(0 < limit <= 8 * 1024**3 for limit in limits)
