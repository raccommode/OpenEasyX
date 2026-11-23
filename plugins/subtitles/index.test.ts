import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { Database } from "../../server/database.js";
import { LibraryDatabase } from "../../server/library-database.js";
import { PluginManager } from "../../server/plugin-manager.js";

const hasMediaTools = ["python3", "ffmpeg", "ffprobe"].every((name) => spawnSync(name, [name === "python3" ? "-V" : "-version"]).status === 0);

it.skipIf(!hasMediaTools)("discovers and resumes a library job only after plugin installation, without downloading models for silent video", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-subtitle-plugin-"));
  const dataDir = path.join(root, "data");
  const mediaDir = path.join(root, "media");
  const db = new Database(dataDir);
  const library = new LibraryDatabase(dataDir);
  const controller = new AbortController();
  let done: Promise<void> | undefined;
  try {
    const pluginRoot = path.join(root, "plugins");
    fs.mkdirSync(path.join(pluginRoot, "subtitles"), { recursive: true });
    const entrypoint = pathToFileURL(path.resolve("plugins/subtitles/index.ts"));
    fs.writeFileSync(path.join(pluginRoot, "subtitles", "index.mjs"), `export { default } from ${JSON.stringify(entrypoint.href)};`);
    const manager = new PluginManager(db, [pluginRoot]);
    await manager.load();
    expect(manager.subtitleProvider()).toBeUndefined();
    const id = "org.easyx.subtitles";
    expect(manager.get(id, false).manifest.capabilities).toContain("subtitle-generation");
    manager.install(id);
    const plugin = manager.subtitleProvider()!;
    expect(plugin.manifest.id).toBe(id);
    fs.mkdirSync(mediaDir);
    const relativePath = "sample.mp4";
    const source = path.join(mediaDir, relativePath);
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=size=32x32:duration=0.2", "-an", "-c:v", "mpeg4", source]);
    const size = fs.statSync(source).size;
    const modifiedAt = "2026-01-01";
    library.upsertMedia({ id: "silent", relativePath, kind: "video", title: "Silent", performer: "", source: "", extension: "mp4", mimeType: "video/mp4",
      size, modifiedAt, addedAt: modifiedAt, duration: 0, width: 32, height: 32, metadata: {}, scanId: "test" });
    library.sqlite.prepare("INSERT INTO subtitle_jobs(media_id,fingerprint,requested_languages_json,status,attempts,updated_at) VALUES(?,?,?,'running',1,?)")
      .run("silent", `${size}:${modifiedAt}`, '["fr"]', modifiedAt);
    done = plugin.runSubtitleWorker!(manager.context(id, controller.signal), { dataDir, mediaDir, databasePath: library.databasePath, languages: ["fr"] });
    await Promise.race([done, vi.waitFor(() => {
      expect(library.subtitleStatus("silent", true)).toMatchObject({ status: "no_audio", progress: 100 });
    }, { timeout: 15000, interval: 100 })]);
    expect(library.sqlite.prepare("SELECT attempts FROM subtitle_jobs WHERE media_id='silent'").get()).toEqual({ attempts: 1 });
    expect(fs.existsSync(path.join(dataDir, "subtitle-models"))).toBe(false);
    manager.uninstall(id);
    expect(manager.subtitleProvider()).toBeUndefined();
  } finally {
    controller.abort();
    try { await done; }
    finally { library.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
}, 20000);
