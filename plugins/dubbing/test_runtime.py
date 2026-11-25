import contextlib
import hashlib
import io
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import runtime
from model_assets import verified_asset


class DubbingRuntimeTests(unittest.TestCase):
    def test_linux_uses_matching_official_wheels_and_resolves_other_dependencies_normally(self):
        for cuda, variant in [(False, "cpu"), (True, "cu128")]:
            with self.subTest(variant=variant), patch.object(runtime.sys, "platform", "linux"):
                commands = []

                def pip(stage, command):
                    commands.append(command)
                    if "download" in command:
                        directory = Path(command[command.index("--dest")+1])
                        # The official ARM64 torchaudio filename has no local version suffix.
                        (directory/f"torch-2.9.1+{variant}-cp311-cp311-linux_aarch64.whl").touch()
                        (directory/"torchaudio-2.9.1-cp311-cp311-linux_aarch64.whl").touch()

                with patch.object(runtime.metadata, "version", side_effect=runtime.metadata.PackageNotFoundError), patch.object(runtime, "run_installer", side_effect=pip):
                    runtime.install_dependencies(Path("requirements.txt"), cuda)
                upgrade, download, install = commands
                self.assertIn("install", upgrade)
                self.assertNotIn("--index-url", upgrade)
                self.assertIn("https://download.pytorch.org/whl/"+variant, download)
                self.assertIn("--only-binary=:all:", download)
                self.assertIn("--no-deps", download)
                self.assertIn("torch==2.9.1", download)
                self.assertIn("torchaudio==2.9.1", download)
                self.assertNotIn("--index-url", install)
                self.assertNotIn("--no-deps", install)
                self.assertEqual(install[-2:], ["-r", "requirements.txt"])
                wheels = [Path(arg).name for arg in install if arg.endswith(".whl")]
                self.assertEqual(len(wheels), 2)
                self.assertTrue(any(wheel.startswith("torchaudio-") for wheel in wheels))

    def test_linux_reuses_already_installed_matching_platform_wheels(self):
        with patch.object(runtime.sys, "platform", "linux"), patch.object(runtime.metadata, "version", return_value="2.9.1+cu128"), patch.object(runtime, "run_installer") as run:
            runtime.install_dependencies(Path("requirements.txt"), True)
        self.assertEqual(run.call_count, 2)
        install = run.call_args.args[1]
        self.assertIn("torch==2.9.1", install)
        self.assertEqual(install[-2:], ["-r", "requirements.txt"])

    def test_macos_uses_platform_wheels_from_the_normal_package_index(self):
        with patch.object(runtime.sys, "platform", "darwin"), patch.object(runtime, "run_installer") as run:
            runtime.install_dependencies(Path("requirements.txt"), False)
        self.assertEqual(run.call_count, 2)
        command = run.call_args.args[1]
        self.assertIn("torch==2.9.1", command)
        self.assertIn("torchaudio==2.9.1", command)
        self.assertNotIn("--index-url", command)

    def test_nested_pip_diagnostic_survives_its_generic_build_error_footer(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp)/"failing.py"
            script.write_text("print('error: subprocess-exited-with-error')\n"
                              "print('   ERROR: No matching distribution found for flit_core')\n"
                              "for i in range(25): print('See above for output')\n"
                              "raise SystemExit(1)\n")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(RuntimeError) as error:
                runtime.run_installer("Installing dubbing dependencies", [sys.executable, str(script)])
            self.assertIn("No matching distribution found for flit_core", str(error.exception))
            self.assertNotIn("See above", str(error.exception))
            self.assertNotIn("subprocess-exited-with-error", str(error.exception))


class ModelAssetTests(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(tmp)
        self.enterContext(patch.dict(os.environ, {
            "HF_HOME": str(self.root / "cache" / "huggingface"),
            "EASYX_DUBBING_MODELS": str(self.root / "overrides"), "HF_HUB_OFFLINE": "",
        }))
        self.target = self.root / "cache" / "example" / "weights.bin"
        self.data = b"verified weights"
        self.args = ("example", "weights.bin", "https://example.invalid/weights.bin", len(self.data), hashlib.sha256(self.data).hexdigest())

    def test_offline_cache_and_override_are_verified(self):
        with patch.dict(os.environ, {"HF_HUB_OFFLINE": "on"}), patch("model_assets.urlopen") as download:
            with self.assertRaisesRegex(RuntimeError, "unavailable offline"):
                verified_asset(*self.args)
            self.target.parent.mkdir(parents=True)
            self.target.write_bytes(self.data)
            self.assertEqual(verified_asset(*self.args), self.target)
            override = self.root / "overrides" / "example" / "weights.bin"
            override.parent.mkdir(parents=True)
            override.write_bytes(b"X" * len(self.data))
            with self.assertRaisesRegex(RuntimeError, "Invalid DPDFNet model checksum"):
                verified_asset(*self.args, label="DPDFNet model")
            override.write_bytes(self.data)
            self.assertEqual(verified_asset(*self.args), override)
            download.assert_not_called()

    def test_invalid_download_preserves_the_existing_cache_and_cleans_temporary_files(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"previous")
        for response in (self.data[:-1], self.data + b"x", b"x" * len(self.data)):
            with self.subTest(response=response), patch("model_assets.urlopen", return_value=io.BytesIO(response)):
                with self.assertRaisesRegex(RuntimeError, "invalid checksum"):
                    verified_asset(*self.args)
            self.assertEqual(self.target.read_bytes(), b"previous")
            self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    def test_concurrent_downloads_only_publish_verified_complete_files(self):
        started = threading.Barrier(3)
        finish = threading.Event()

        class Response(io.BytesIO):
            def read(self, n):
                if self.tell() == 0:
                    started.wait(timeout=5)
                    if not finish.wait(timeout=5):
                        raise TimeoutError("test download did not resume")
                return super().read(n)

        with patch("model_assets.urlopen", side_effect=lambda *a, **kw: Response(self.data)) as download, ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(verified_asset, *self.args) for _ in range(2)]
            try:
                started.wait(timeout=5)
                self.assertFalse(self.target.exists())
            finally:
                finish.set()
            self.assertEqual([f.result() for f in futures], [self.target, self.target])
            self.assertEqual(verified_asset(*self.args), self.target)
            self.assertEqual(download.call_count, 2)
        self.assertEqual(self.target.read_bytes(), self.data)
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])


if __name__ == "__main__":
    unittest.main()
