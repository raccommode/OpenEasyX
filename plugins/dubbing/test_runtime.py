import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import runtime


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

                with patch.object(runtime, "run_installer", side_effect=pip):
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


if __name__ == "__main__":
    unittest.main()
