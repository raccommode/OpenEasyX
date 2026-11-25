"""CPU-only tests for local Whisper checkpoint selection and atomic CUDA recovery."""
import gc
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import weakref
from unittest.mock import Mock, patch

import whisper_recognizer as recognition


@unittest.skipUnless(importlib.util.find_spec("faster_whisper") and importlib.util.find_spec("torch"), "requires dubbing runtime")
class WhisperRecognizerTests(unittest.TestCase):
    def setUp(self):
        self.cache = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.cache/"models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120"
        self.path.mkdir(parents=True)
        for file in ("config.json", "model.bin", "vocabulary.txt", "tokenizer.json"):
            (self.path/file).write_bytes(b"ready")
        self.enterContext(patch.dict(os.environ, {"EASYX_WHISPER_MODEL": "small", "HF_HUB_OFFLINE": ""}))

    def gpu(self, free=5):
        self.enterContext(patch.object(recognition, "model_directory", return_value=self.path))
        self.enterContext(patch.object(recognition, "whisper_device", return_value="cuda"))
        self.enterContext(patch("torch.cuda.mem_get_info", return_value=(free*1024**3, 8*1024**3)))
        return recognition.WhisperRecognizer(self.cache)

    def test_complete_cache_is_offline_and_partial_cache_fetches_missing_files(self):
        with patch("faster_whisper.utils.download_model", return_value=self.path) as fetch:
            self.assertEqual(recognition.model_directory(self.cache), self.path)
            fetch.assert_called_once_with("small", cache_dir=str(self.cache), local_files_only=True)
        (self.path/"tokenizer.json").unlink()
        def repair(name, *, cache_dir, local_files_only):
            if not local_files_only:
                (self.path/"tokenizer.json").write_text("{}")
            return self.path
        with patch("faster_whisper.utils.download_model", side_effect=repair) as fetch:
            self.assertEqual(recognition.model_directory(self.cache), self.path)
            self.assertEqual([c.kwargs["local_files_only"] for c in fetch.call_args_list], [True, False])
        (self.path/"model.bin").write_bytes(b"")
        with patch("faster_whisper.utils.download_model", return_value=self.path), self.assertRaisesRegex(RuntimeError, "Incomplete"):
            recognition.model_directory(self.cache)

    def test_low_cuda_headroom_uses_same_weights_with_int8(self):
        recognizer = self.gpu(free=1)
        with patch("faster_whisper.WhisperModel") as create:
            create.return_value.transcribe.return_value = (iter(["cpu"]), "english")
            self.assertEqual(recognizer.transcribe("audio", beam_size=2), (["cpu"], "english"))
            create.assert_called_once_with(str(self.path), device="cpu", compute_type="int8", cpu_threads=2)

    def test_standard_feature_config_and_default_hub_cache(self):
        with patch.dict(os.environ, {"EASYX_WHISPER_MODEL": "medium"}), \
             patch("faster_whisper.utils.download_model", return_value=self.path) as download:
            self.assertEqual(recognition.model_directory(None), self.path)
            download.assert_called_once_with("medium", cache_dir=None, local_files_only=True)
        with patch.dict(os.environ, {"EASYX_WHISPER_MODEL": "large-v3"}), \
             patch("faster_whisper.utils.download_model", return_value=self.path) as download:
            with self.assertRaisesRegex(RuntimeError, "Incomplete"):
                recognition.model_directory(None)
            (self.path/"vocabulary.txt").rename(self.path/"vocabulary.json")
            (self.path/"preprocessor_config.json").write_text("{}")
            download.reset_mock()
            self.assertEqual(recognition.model_directory(None), self.path)
            download.assert_called_once_with("large-v3", cache_dir=None, local_files_only=True)

    def test_cuda_oom_at_loading_or_lazy_decode_replays_only_the_current_turn(self):
        for where in ("load", "iterator", "detect"):
            with self.subTest(where=where):
                recognizer = self.gpu()
                cpu = Mock()
                cpu.transcribe.return_value = (iter(["new first", "final"]), "cpu language")
                cpu.detect_language.return_value = ("en", .91, [])
                calls, finished = [], []
                def broken():
                    yield "partial CUDA turn"
                    raise RuntimeError("CUDA failed with error out of memory")
                def load(path, *, device, compute_type, cpu_threads):
                    calls.append((path, device, compute_type))
                    if device == "cpu":
                        if where != "load":
                            gc.collect()
                            self.assertIsNone(finished[0]())
                        return cpu
                    if where == "load":
                        raise RuntimeError("CUDA_ERROR_OUT_OF_MEMORY")
                    gpu = Mock()
                    finished.append(weakref.ref(gpu))
                    gpu.transcribe.return_value = (broken(), "gpu language")
                    gpu.detect_language.side_effect = RuntimeError("CUBLAS_STATUS_ALLOC_FAILED")
                    return gpu
                with patch("faster_whisper.WhisperModel", side_effect=load):
                    if where == "detect":
                        self.assertEqual(recognizer.detect_language(audio="a"), ("en", .91, []))
                    self.assertEqual(recognizer.transcribe("audio", beam_size=2), (["new first", "final"], "cpu language"))
                    cpu.transcribe.assert_called_once_with("audio", beam_size=2)
                    self.assertEqual(recognizer.detect_language(audio="b"), ("en", .91, []))
                self.assertEqual(calls, [(str(self.path), "cuda", "float16"), (str(self.path), "cpu", "int8")])

    def test_custom_snapshot_observes_cached_absence_and_does_not_treat_dns_failure_as_absence(self):
        from huggingface_hub import _CACHED_NO_EXIST
        from huggingface_hub.errors import LocalEntryNotFoundError
        with patch.dict(os.environ, {"EASYX_WHISPER_MODEL": "custom/checkpoint"}), \
             patch("faster_whisper.utils.download_model", return_value=self.path) as download, \
             patch("huggingface_hub.try_to_load_from_cache", return_value=_CACHED_NO_EXIST) as lookup:
            self.assertEqual(recognition.model_directory(None), self.path)
            self.assertEqual(download.call_count, 1)
            lookup.return_value = None
            with patch("huggingface_hub.hf_hub_download", side_effect=LocalEntryNotFoundError("offline")), \
                 self.assertRaises(LocalEntryNotFoundError):
                recognition.model_directory(None)

    def test_unrelated_gpu_failure_and_cpu_errors_are_not_retried(self):
        recognizer = self.gpu()
        with patch("faster_whisper.WhisperModel", side_effect=RuntimeError("invalid CUDA device")) as create:
            with self.assertRaisesRegex(RuntimeError, "invalid CUDA device"):
                recognizer.detect_language(audio="x")
            self.assertEqual(create.call_count, 1)
        recognizer = self.gpu(free=1)
        with patch("faster_whisper.WhisperModel", side_effect=MemoryError("bad_alloc")) as create:
            with self.assertRaisesRegex(MemoryError, "bad_alloc"):
                recognizer.detect_language(audio="x")
            self.assertEqual(create.call_count, 1)
