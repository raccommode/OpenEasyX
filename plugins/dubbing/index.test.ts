import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("reads the number of actively synchronized frames from the completed render event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-render-result-"));
  try {
    const exe = path.join(root, "python");
    fs.writeFileSync(exe, '#!/usr/bin/env python3\nprint(\'EASYX {"outcome":"rendered","lipSyncFrames":17}\')\n', { mode: 0o700 });
    vi.stubEnv("EASYX_DUBBING_PYTHON", exe);
    const result = await plugin.renderDub!(
      { config: {}, signal: new AbortController().signal, fetch, runCommand: vi.fn(), log: vi.fn() },
      { mediaId: "example", fingerprint: "sample", language: "fr", source: root, dataDir: root, workDir: root, output: path.join(root, "out.mp4") }, vi.fn(),
    );
    expect(result).toEqual({ outcome: "rendered", lipSyncFrames: 17 });
  } finally {
    vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
  }
});

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

it("upgrades a published dub without inference, preserving frame timestamps and compressed audio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-delivery-"));
  try {
    const source = path.join(root, "revision3.mp4"), output = path.join(root, "revision4.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=5",
      "-itsoffset", "0.2", "-f", "lavfi", "-i", "sine=d=4.8", "-vf", "select='not(eq(mod(n,9),2))'",
      "-fps_mode", "vfr", "-c:v", "libx264", "-bf", "0", "-c:a", "aac", "-movie_timescale", "90000", source]);
    const result = await plugin.renderDub!(
      { config: {}, signal: new AbortController().signal, fetch, runCommand: vi.fn(), log: vi.fn() },
      { mediaId: "sample", fingerprint: "sample", language: "fr", source: path.join(root, "unused-original"),
        dataDir: root, workDir: root, output, previousOutput: { path: source, renderVersion: "3", lipSyncFrames: 12 } }, vi.fn(),
    );
    expect(result).toEqual({ outcome: "rendered", lipSyncFrames: 12 });
    function packets(file: string, stream: string, fields: string) {
      return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_packets",
        "-show_data_hash", "sha256", "-show_entries", "packet="+fields, "-of", "json", file], { encoding: "utf8" })).packets;
    }
    expect(packets(output, "v:0", "pts_time")).toEqual(packets(source, "v:0", "pts_time"));
    expect(packets(output, "a:0", "pts_time,data_hash")).toEqual(packets(source, "a:0", "pts_time,data_hash"));
    const bytes = fs.readFileSync(output);
    expect(bytes.indexOf("moov")).toBeGreaterThan(0);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
