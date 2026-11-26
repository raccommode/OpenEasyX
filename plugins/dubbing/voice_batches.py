"""Run bounded OmniVoice batches without keeping any inference libraries in the parent."""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory

from inference_memory import cgroup_oom_kills
from runtime import progress


# This status belongs only to our CUDA worker. Other model failures carry their diagnostic.
RETRY_ON_CPU = 75


def cached_voice(path):
    if not path.is_file():
        return False
    import soundfile as sf
    try:
        with sf.SoundFile(path) as take:
            if take.channels != 1 or len(take) < .04*take.samplerate:
                return False
            energy, peak, count = 0., 0., 0
            while data := take.buffer_read(32768, dtype="float32"):
                samples = memoryview(data).cast("f")
                energy += sum(x*x for x in samples)
                peak = max(peak, max(samples), -min(samples))
                count += len(samples)
            return count == len(take) and math.isfinite(energy) and peak >= 1e-5 and energy >= 1e-12*count
    except (OSError, RuntimeError, ValueError):
        return False


def needs_take(wav_dir, index):
    return not (wav_dir/f"{index}.original").is_file() and not cached_voice(wav_dir/f"{index}.wav")


def run_voice_batches(cues, texts, target, work, wav_dir, references=None, model_cache=None):
    pending = [i for i, cue in enumerate(cues) if not cue.get("preserveOriginal")
               and cue["language"] != target and needs_take(wav_dir, i)]
    if not pending:
        return
    with TemporaryDirectory(prefix=".voice-batch-", dir=wav_dir) as temp:
        control = Path(temp)
        (control/"input.json").write_text(json.dumps([cues, texts]))
        env = {**os.environ, "EASYX_DUBBING_VOICE_BATCH": temp, "EASYX_DUBBING_VOICE_REFS": str(references or work),
               "EASYX_DUBBING_VERIFY_MODEL_CACHE": str(model_cache or ""), "MALLOC_ARENA_MAX": "2"}
        for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
            configured = env.get(name, "")
            env[name] = str(min(2, int(configured))) if configured.isdecimal() and int(configured) > 0 else "2"

        batch_size = 3

        def run(indices, *, cpu=False):
            nonlocal batch_size
            indices = [i for i in indices if needs_take(wav_dir, i)]
            if not indices:
                return
            for name in ("device", "error"):
                (control/name).unlink(missing_ok=True)
            before = cgroup_oom_kills()
            command = [sys.executable, str(Path(__file__).with_name("voices.py")), str(work), str(wav_dir),
                       target, *map(str, indices)]
            environment = {**env, "EASYX_DUBBING_DEVICE": "cpu"} if cpu else env
            status = subprocess.run(command, stdin=subprocess.DEVNULL, env=environment).returncode
            missing = [i for i in indices if needs_take(wav_dir, i)]
            if status == 0:
                if missing:
                    raise RuntimeError(f"Voice worker exited without saving take {missing[0]+1}")
                return
            if status == RETRY_ON_CPU and not cpu:
                if missing:
                    progress("Cloning voices on CPU while GPU memory is busy", 38+30*missing[0]/len(cues))
                    run(missing, cpu=True)
                return
            after = cgroup_oom_kills() if status == -signal.SIGKILL else None
            if before is not None and after is not None and after > before:
                batch_size = 1
                if not missing:
                    return
                if len(indices) > 1:
                    progress("Retrying unfinished voices individually after the container memory limit", 38+30*missing[0]/len(cues))
                    for index in missing:
                        run([index], cpu=cpu)
                    return
                device = control/"device"
                if not cpu and device.is_file() and device.read_text() == "cuda":
                    run(missing, cpu=True)
                    return
                i = missing[0]
                raise RuntimeError(f"Container memory limit exceeded cloning take {i+1} at "
                                   f"{cues[i]['start']:.2f}–{cues[i]['end']:.2f}s in an isolated process")
            diagnostic = control/"error"
            if diagnostic.is_file():
                raise RuntimeError(diagnostic.read_text())
            raise RuntimeError(f"Voice worker stopped with status {status} at take {indices[0]+1}")

        first = 0
        while first < len(pending):
            batch = pending[first:first+batch_size]
            run(batch)
            first += len(batch)
