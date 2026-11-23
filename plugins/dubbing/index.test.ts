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
