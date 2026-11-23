import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("exits cleanly for a video with no audio before provisioning models", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-silent-"));
  try {
    const source = path.join(root, "silent.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=64x64", "-frames:v", "1", "-an", source]);
    const output = path.join(root, "fr.mp4");
    const outcome = await plugin.renderDub!(
      { config: {}, signal: new AbortController().signal, fetch, runCommand: vi.fn(), log: vi.fn() },
      { mediaId: "silent", fingerprint: "test", language: "fr", source, dataDir: root, workDir: path.join(root, "work"), output },
      vi.fn(),
    );
    expect(outcome).toBe("silent");
    expect(fs.readdirSync(root).sort()).toEqual(["silent.mp4", "work"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reports the provisioning cause to the queue even when a longer traceback follows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-provision-error-"));
  try {
    const source = path.join(root, "speech.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=d=0.1", source]);
    const executable = path.join(root, "python");
    fs.writeFileSync(executable, `#!/usr/bin/env python3
import os, runpy, sys
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(sys.argv[0]))
import runtime
def offline(data):
    raise RuntimeError("Cannot install the torch CPU wheel")
runtime.provision = offline
try:
    runpy.run_path(sys.argv[0], run_name="__main__")
finally:
    sys.stderr.write("traceback details " * 200)
`, { mode: 0o700 });
    vi.stubEnv("EASYX_DUBBING_PYTHON", executable);
    const workDir = path.join(root, "work");
    await expect(plugin.renderDub!(
      { config: {}, signal: new AbortController().signal, fetch, runCommand: vi.fn(), log: vi.fn() },
      { mediaId: "test", fingerprint: "test", language: "fr", source, dataDir: root, workDir, output: path.join(root, "fr.mp4") },
      vi.fn(),
    )).rejects.toMatchObject({ code: "DUBBING_RUNTIME_SETUP", message: "Cannot install the torch CPU wheel" });
    expect(fs.readdirSync(workDir)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
