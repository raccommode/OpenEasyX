"""Cgroup-limited cloning restarts only incomplete, validated work."""
import importlib.util
import json
from pathlib import Path
import signal
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import inference_memory
import voice_batches as batches


@unittest.skipUnless(importlib.util.find_spec("soundfile"), "requires the dubbing audio runtime")
class VoiceBatchTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        self.cues = [dict(start=float(i), end=i+.8, language="en", speaker=1) for i in range(9)]
        self.texts = ["D’accord"] * len(self.cues)
        self.calls = []
        self.kills = 0

    def save_take(self, i, name=None):
        with wave.open(str(self.root/(name or f"{i}.wav")), "wb") as out:
            out.setparams((1, 2, 16000, 0, "NONE", ""))
            out.writeframes(b"\x00\x10"*1600)

    def run_batches(self, child):
        def spawn(args, *, stdin, env):
            indices = list(map(int, args[5:]))
            control = Path(env["EASYX_DUBBING_VOICE_BATCH"])
            self.assertEqual(json.loads((control/"input.json").read_text()), [self.cues, self.texts])
            self.assertEqual(env["MALLOC_ARENA_MAX"], "2")
            self.assertLessEqual(int(env["OPENBLAS_NUM_THREADS"]), 2)
            cpu = env["EASYX_DUBBING_DEVICE"] == "cpu"
            self.calls.append((indices, cpu))
            return SimpleNamespace(returncode=child(indices, cpu, control))

        with patch.dict(batches.os.environ, {"EASYX_DUBBING_DEVICE": "cuda"}), \
             patch.object(batches, "cgroup_oom_kills", side_effect=lambda: self.kills), \
             patch.object(batches.subprocess, "run", side_effect=spawn):
            batches.run_voice_batches(self.cues, self.texts, "fr", self.root, self.root)

    def test_bounds_batches_and_resumes_only_pending_files(self):
        self.save_take(0)
        (self.root/"1.wav").write_bytes(b"invalid")
        (self.root/"2.original").touch()
        self.cues[3]["preserveOriginal"] = "unverified-source"
        self.cues[4]["language"] = "fr"
        def finish(indices, cpu, control):
            # A previously verified take can arrive while a sibling batch runs.
            if len(self.calls) == 1:
                self.save_take(7)
            for i in indices:
                self.save_take(i)
            return 0
        self.run_batches(finish)
        self.assertEqual(self.calls, [([1,5,6], False), ([8], False)])

    def test_oom_reuses_completed_files_and_switches_remaining_batches_to_individuals(self):
        def child(indices, cpu, control):
            if len(self.calls) == 1:
                self.save_take(0)
                self.save_take(1, "1.partial.wav")
                self.kills += 1
                return -signal.SIGKILL
            for i in indices:
                self.save_take(i)
            return 0
        self.run_batches(child)
        self.assertEqual(self.calls, [([0,1,2], False), *[([i], False) for i in range(1,9)]])

    def test_cuda_oom_releases_failed_process_before_cpu_retry(self):
        self.cues, self.texts = self.cues[:2], self.texts[:2]
        def child(indices, cpu, control):
            if not cpu:
                self.save_take(0)
                return batches.RETRY_ON_CPU
            self.save_take(1)
            return 0
        self.run_batches(child)
        self.assertEqual(self.calls, [([0,1], False), ([1], True)])

    def test_singleton_killed_on_gpu_tries_cpu_once_and_reports_interval(self):
        self.cues, self.texts = self.cues[:1], self.texts[:1]
        self.cues[0].update(start=42., end=220.)
        def killed(indices, cpu, control):
            (control/"device").write_text("cpu" if cpu else "cuda")
            self.kills += 1
            return -signal.SIGKILL
        with self.assertRaisesRegex(RuntimeError, "take 1 at 42.00–220.00s"):
            self.run_batches(killed)
        self.assertEqual(self.calls, [([0], False), ([0], True)])
        self.assertFalse(list(self.root.glob("*.original")))

    def test_signal_without_kernel_oom_or_a_model_error_is_not_retried(self):
        for code, message in ((-signal.SIGKILL, "status -9"), (1, "missing model weights")):
            with self.subTest(code=code):
                self.calls.clear()
                def failed(indices, cpu, control):
                    if code == 1:
                        (control/"error").write_text(message)
                    return code
                with self.assertRaisesRegex(RuntimeError, message):
                    self.run_batches(failed)
                self.assertEqual(len(self.calls), 1)


class CgroupCounters(unittest.TestCase):
    def test_v2_v1_and_unavailable_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            group = Path(temp)
            with patch.object(inference_memory, "memory_cgroups", return_value=[group]):
                self.assertIsNone(inference_memory.cgroup_oom_kills())
                (group/"memory.oom_control").write_text("under_oom 0\noom_kill 4\n")
                self.assertEqual(inference_memory.cgroup_oom_kills(), 4)
                (group/"memory.events").write_text("max 153\noom 7\noom_kill 6\n")
                self.assertEqual(inference_memory.cgroup_oom_kills(), 6)
                (group/"memory.max").write_text(str(7*1024**3))
                self.assertTrue(inference_memory.compact_cpu())


if __name__ == "__main__":
    unittest.main()
