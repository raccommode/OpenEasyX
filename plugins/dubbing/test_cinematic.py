"""Check the low-memory CUDA path independently of the availability of a GPU."""
import importlib.util
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ENABLED = all(importlib.util.find_spec(name) for name in ("torch", "numpy", "scipy"))
if ENABLED:
    import numpy as np
    import torch
    from torch import nn
    import cinematic


@unittest.skipUnless(ENABLED, "requires the optional dubbing runtime")
class LowMemorySeparationTests(unittest.TestCase):
    def test_bounded_bidirectional_layers_match_the_full_graph_on_both_axes(self):
        class Recurrent(nn.Module):
            def __init__(self):
                super().__init__()
                self.rnn = nn.GRU(4, 2, bidirectional=True, batch_first=True)
                self.norm = nn.LayerNorm(4)
                self.shapes = []

            def forward(self, x):
                self.shapes.append(tuple(x.shape))
                normalized = self.norm(x).flatten(0, 1)
                return x + self.rnn(normalized)[0].reshape_as(x)

        class Transpose(nn.Module):
            def forward(self, x):
                return x.transpose(1, 2)

        first, second = Recurrent(), Recurrent()
        stages = nn.Sequential(first, Transpose(), second, Transpose()).eval()
        x = torch.arange(2*7*19*4, dtype=torch.float32).reshape(2, 7, 19, 4).sin()
        with torch.inference_mode():
            expected = stages(x)
            first.shapes.clear()
            second.shapes.clear()
            result = cinematic._bounded_backbone(SimpleNamespace(seqband=stages), x.clone(), 38)
        torch.testing.assert_close(result, expected, rtol=2e-5, atol=2e-6)
        self.assertTrue(all(rows <= 2 and length == 19 for _, rows, length, _ in first.shapes))
        self.assertTrue(all(rows <= 5 and length == 7 for _, rows, length, _ in second.shapes))

    def test_stereo_retries_each_channel_then_remembers_the_successful_workspace(self):
        samples = np.arange(600, dtype=np.float32).reshape(300, 2)
        gpu = torch.device("cuda")
        for minimum_mode in (1, 2, 3, 4):
            with self.subTest(minimum_mode=minimum_mode):
                model = SimpleNamespace()
                calls = []

                def estimate(_model, audio, _device, positions):
                    mode = (0 if audio.shape[1] == 2 else
                            {None: 1, 4096: 2, 1024: 3}[positions])
                    calls.append(mode)
                    if mode < minimum_mode:
                        raise torch.cuda.OutOfMemoryError("busy")
                    return audio.copy()

                with patch.object(cinematic, "_speech", side_effect=estimate), patch.object(torch.cuda, "empty_cache"):
                    first = cinematic._cuda_speech(model, samples, gpu)
                    if minimum_mode == 4:
                        self.assertIsNone(first)
                        self.assertEqual(calls, [0, 1, 2, 3])
                        continue
                    np.testing.assert_array_equal(first, samples)
                    self.assertEqual(calls, [*range(minimum_mode), minimum_mode, minimum_mode])
                    calls.clear()
                    second = cinematic._cuda_speech(model, samples, gpu)
                    np.testing.assert_array_equal(second, samples)
                    self.assertEqual(calls, [minimum_mode, minimum_mode])

    def test_exhausting_cuda_replays_the_current_channels_on_cpu_and_keeps_that_device(self):
        class Model:
            device = torch.device("cuda")

            def parameters(self):
                return iter([SimpleNamespace(device=self.device)])

            def cpu(self):
                self.device = torch.device("cpu")

        model = Model()
        samples = np.full((4410, 2), .1, dtype=np.float32)
        with patch.object(cinematic, "_cuda_speech", return_value=None) as cuda, \
             patch.object(cinematic, "_speech", side_effect=lambda _m, x, device: x) as cpu, \
             patch.object(torch.cuda, "empty_cache"), patch.object(cinematic, "progress"):
            first = cinematic.isolate_dialogue(model, samples)
            second = cinematic.isolate_dialogue(model, samples)
        np.testing.assert_array_equal(first, second)
        self.assertGreater(float(np.max(first)), .09)
        self.assertEqual(cuda.call_count, 1)
        self.assertEqual([c.args[-1].type for c in cpu.call_args_list], ["cpu", "cpu"])


if __name__ == "__main__":
    unittest.main()
