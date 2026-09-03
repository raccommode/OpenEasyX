import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
async function fixture(settings: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-output-test-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugins", "test"); fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "index.mjs"), `export default { manifest: { id: 'test.output', name: 'Output', version: '1', description: 'Test', author: 'Test', capabilities: ['download-resolver'] }, resolveDownload: async () => ({kind:'command', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', '{output}', 'test bytes'], filename:'original.mp4'}) };`);
  const db = new Database(path.join(root, "data")); cleanup.push(() => db.close());
  const plugins = new PluginManager(db, [path.join(root, "plugins")]); await plugins.load(); plugins.install("test.output");
  db.updateSettings({ autoQueueDiscovered: false, ...settings });
  const performer = db.upsertPerformer({ externalId: "alice", name: "Alice" }, "test.output");
  const source = db.addSource(performer.id, "test.output", { externalId: "source", label: "Example", domain: "example.test", profileUrl: "https://example.test/Alice" });
  const media = path.join(root, "media"); fs.mkdirSync(media);
  const queue = new DownloadQueue(db, plugins, media); cleanup.push(() => queue.stop());
  const add = (externalId: string, live = false) => {
    db.ingestItems(source, [{ externalId, filename: "original.mp4", mediaType: "video", title: "Recording", metadata: { live } }]);
    const item = db.listItems().find((entry) => entry.externalId === externalId)!; db.setItemStatus(item.id, "queued"); return item;
  };
  return { root, db, plugins, performer, source, media, queue, add };
}
async function complete(db: Database, id: string) {
  const deadline = Date.now() + 25_000;
  while (!["completed", "failed"].includes(db.getItem(id)?.status ?? "")) {
    if (Date.now() > deadline) throw new Error(`Download timed out: ${JSON.stringify(db.getItem(id))}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const item = db.getItem(id)!; expect(item.error).toBeUndefined(); expect(item.status).toBe("completed"); return item;
}

describe("custom download output", () => {
  it("writes directly into a model folder and keeps the library's source metadata", async () => {
    const { root, db, media, queue, add } = await fixture({ outputPathTemplate: "{performer}", outputFilenameTemplate: "{site}-{filename}" });
    const item = add("one"); expect(queue.outputPath(item.id)).toBe("Alice/example.test-original.mp4");
    queue.start(); const done = await complete(db, item.id); queue.stop();
    expect(done.storagePath).toBe("Alice/example.test-original.mp4");
    expect(fs.readFileSync(path.join(media, done.storagePath!), "utf8")).toBe("test bytes");
    const library = new LibraryDatabase(path.join(root, "data")); cleanup.push(() => library.close());
    const catalog = new Catalog(library, media, path.join(root, "data"), false, (file) => db.storedMediaMetadata(file)); await catalog.scan();
    expect(library.listMedia({}).items[0]).toMatchObject({ performer: "Alice", source: "example.test", title: "Recording" });
  });
  it("does not overwrite colliding names, even when an old suffix is already occupied", async () => {
    const { db, media, queue, add } = await fixture({ outputPathTemplate: "", outputFilenameTemplate: "same" });
    const item = add("one");
    fs.writeFileSync(path.join(media, "same.mp4"), "existing"); fs.writeFileSync(path.join(media, `same-${item.id.slice(-6)}.mp4`), "also existing");
    queue.start(); const done = await complete(db, item.id); queue.stop();
    expect(done.storagePath).toBe(`same-${item.id.slice(-6)}-2.mp4`);
    expect(fs.readFileSync(path.join(media, "same.mp4"), "utf8")).toBe("existing");
  });
  it("rejects a symlinked destination instead of writing outside the media volume", async () => {
    const { root, db, media, queue, add } = await fixture({ outputPathTemplate: "escape" });
    const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(media, "escape"));
    const item = add("one"); queue.start();
    await expect(complete(db, item.id)).rejects.toThrow(); queue.stop();
    expect(db.getItem(item.id)?.error).toContain("symbolic links"); expect(fs.readdirSync(outside)).toEqual([]);
  });
  it.each(["source", "h264-high", "h264-small", "h265"])("produces a playable live recording with the %s preset", async (recordingPreset) => {
    const { db, plugins, media, queue, add } = await fixture({ recordingPreset, outputPathTemplate: "{performer}", outputFilenameTemplate: "{site}-live" });
    plugins.get("test.output").resolveDownload = async () => ({ kind: "command", command: "ffmpeg", filename: "live.webm", args: ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1440x810:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.3", "-c:v", "libvpx-vp9", "-cpu-used", "8", "-c:a", "libopus", "{output}"] });
    const item = add("one", true); queue.start(); const done = await complete(db, item.id); queue.stop();
    const filename = path.join(media, done.storagePath!);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", filename], { encoding: "utf8" }));
    const video = probe.streams.find((stream: any) => stream.codec_type === "video"); const audio = probe.streams.find((stream: any) => stream.codec_type === "audio");
    expect(video.codec_name).toBe(recordingPreset === "source" ? "vp9" : recordingPreset === "h265" ? "hevc" : "h264");
    expect(audio.codec_name).toBe(recordingPreset === "source" ? "opus" : "aac");
    expect(video.height).toBe(recordingPreset === "h264-small" ? 720 : 810);
    expect(done.storagePath).toBe(`Alice/example.test-live.${recordingPreset === "source" ? "webm" : "mp4"}`);
    expect(fs.readdirSync(path.join(media, ".downloads"))).toEqual([]);
  }, 30_000);
  it("encodes and saves a manually stopped recording", async () => {
    const { db, plugins, media, queue, add } = await fixture({ recordingPreset: "h264-high" });
    plugins.get("test.output").resolveDownload = async () => ({ kind: "command", command: "ffmpeg", filename: "live.mkv", args: ["-y", "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-c:v", "libx264", "-preset", "ultrafast", "{output}"] });
    const item = add("stopped", true); queue.start();
    await new Promise((resolve) => setTimeout(resolve, 900));
    queue.stopRecording(item.id);
    const done = await complete(db, item.id); queue.stop();
    const filename = path.join(media, done.storagePath!);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", filename], { encoding: "utf8" }));
    expect(probe.streams[0].codec_name).toBe("h264"); expect(done.storagePath).toMatch(/\.mp4$/);
  }, 30_000);
  it("preserves the captured source for recovery if encoding fails", async () => {
    const { db, media, queue, add } = await fixture({ recordingPreset: "h264-high" });
    const item = add("broken", true); queue.start();
    await expect(complete(db, item.id)).rejects.toThrow(); queue.stop();
    expect(db.getItem(item.id)?.error).toContain("Recording preserved for recovery");
    expect(fs.readFileSync(path.join(media, ".recording-recovery", item.id, "original.mp4"), "utf8")).toBe("test bytes");
  });
});
