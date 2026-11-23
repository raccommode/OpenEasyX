import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Database, type Source } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue, recordedInput } from "./downloader.js";
import { SourceSync } from "./source-sync.js";

const dirs: string[] = [];
const defaults = { kill: DownloadQueue.cancelKillAfterMs, repeat: DownloadQueue.stopRepeatAfterMs };
afterEach(() => {
  DownloadQueue.cancelKillAfterMs = defaults.kill; DownloadQueue.stopRepeatAfterMs = defaults.repeat;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
async function waitFor(check: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

// Recorder doubles: "recorder" finishes on SIGINT (stop and save) and exits 143 on SIGTERM;
// "stubborn" ignores both, like a process stuck on the network.
const scripts = {
  recorder: "const fs=require('node:fs'),f=process.argv[1];fs.writeFileSync(f,'start');const t=setInterval(()=>fs.appendFileSync(f,'x'),25);process.on('SIGINT',()=>{clearInterval(t);process.exit(0)});process.on('SIGTERM',()=>process.exit(143))",
  stubborn: "const fs=require('node:fs'),f=process.argv[1];fs.writeFileSync(f,'start');setInterval(()=>fs.appendFileSync(f,'x'),25);process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{})",
};

async function setup(matroskaCapture = false, filename = "recording.mp4") {
  const root = temp("easyx-live-restart"); const mediaDir = path.join(root, "media"); const pluginDir = path.join(root, "plugins");
  fs.mkdirSync(path.join(pluginDir, "test"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "test", "index.mjs"), `export default {
    manifest: { id: "test.live", name: "Live", version: "1", description: "Test", author: "Test", capabilities: ["media-listing", "download-resolver", "live-cam"], sourceUrlPatterns: ["https://live.test/*"], polling: { mode: "live", defaultIntervalSeconds: 10, minimumIntervalSeconds: 5 } },
    listMedia: async () => [],
    resolveLiveStream: async () => ({ url: "https://cdn.test/live.m3u8" }),
    resolveDownload: async (_context, item) => ({ kind: "command", command: process.execPath, liveCaptureContainer: ${matroskaCapture ? '"matroska"' : "undefined"}, args: ["-e", item.metadata.script ?? ${JSON.stringify(scripts.recorder)}, "{output}"], filename: ${JSON.stringify(filename)} })
  };`);
  const db = new Database(path.join(root, "data")); const plugins = new PluginManager(db, [pluginDir]); await plugins.load(); plugins.install("test.live");
  const performer = db.createPerformer({ name: "Alice" });
  const added = db.addSource(performer.id, "test.live", { externalId: "https://live.test/alice", label: "live.test", profileUrl: "https://live.test/alice", domain: "live.test" });
  const source = db.updateSource(added.id, { autoDownload: true, scraperPluginId: "test.live", scrapeEnabled: true, syncIntervalSeconds: 10 })!;
  return { root, mediaDir, db, plugins, source };
}
const candidate = (script?: string) => ({ externalId: "live:alice", title: "Alice live", pageUrl: "https://live.test/alice", mediaType: "video" as const, filename: "alice.mp4", metadata: { live: true, ...(script ? { script } : {}) } });
function scan(db: Database, source: Source, script?: string, nowMs?: number) {
  const scanned = db.liveScanCandidates(source, [candidate(script)], nowMs);
  db.ingestItems(source, scanned);
  return scanned;
}
const liveItems = (db: Database) => db.listItems().filter((item) => item.metadata.live === true);

describe("live recordings after stop, cancel and hard refresh", () => {
  it("records a performer again after Stop and save while they stay online", async () => {
    const { db, plugins, mediaDir, source } = await setup();
    const queue = new DownloadQueue(db, plugins, mediaDir); queue.start();
    try {
      scan(db, source);
      await waitFor(() => liveItems(db)[0]?.status === "downloading");
      const [first] = liveItems(db);
      await waitFor(() => fs.existsSync(path.join(mediaDir, ".downloads", first.id, "recording.mp4")));
      queue.stopRecording(first.id);
      await waitFor(() => db.getItem(first.id)?.status === "completed");
      // The next check (after the short-recording backoff) starts a new video.
      expect(scan(db, db.getSource(source.id)!, undefined, Date.now() + 60_000)).toHaveLength(1);
      expect(liveItems(db)).toHaveLength(2);
    } finally { queue.stop(); await waitFor(() => liveItems(db).every((item) => !["downloading", "stopping"].includes(item.status))).catch(() => {}); db.close(); }
  });

  it("keeps a cancelled room blocked while it stays online, until a hard refresh", async () => {
    const { db, plugins, mediaDir, source } = await setup();
    const queue = new DownloadQueue(db, plugins, mediaDir); queue.start();
    try {
      scan(db, source);
      await waitFor(() => liveItems(db)[0]?.status === "downloading");
      queue.cancel(liveItems(db)[0].id);
      await waitFor(() => liveItems(db)[0]?.status === "cancelled");
      expect(scan(db, db.getSource(source.id)!, undefined, Date.now() + 3_600_000)).toEqual([]);
      queue.stop();
      const sync = new SourceSync(db, mediaDir, () => ({ manifest: plugins.get("test.live").manifest, listMedia: async () => [candidate()] }) as any,
        (pluginId) => plugins.context(pluginId), async () => undefined);
      const result = await sync.sync(source.id, true);
      expect(result.added).toBe(1);
      expect(liveItems(db).filter((item) => item.status === "queued")).toHaveLength(1);
    } finally { queue.stop(); db.close(); }
  });

  it("ends a cancel that the recording process ignores", async () => {
    DownloadQueue.cancelKillAfterMs = 300;
    const { db, plugins, mediaDir, source } = await setup();
    const queue = new DownloadQueue(db, plugins, mediaDir); queue.start();
    try {
      scan(db, source, scripts.stubborn);
      await waitFor(() => liveItems(db)[0]?.status === "downloading");
      const [item] = liveItems(db);
      await waitFor(() => fs.existsSync(path.join(mediaDir, ".downloads", item.id, "recording.mp4")));
      queue.cancel(item.id);
      expect(db.getItem(item.id)?.status).toBe("cancelling");
      await waitFor(() => db.getItem(item.id)?.status === "cancelled", 4000);
    } finally { queue.stop(); db.close(); }
  });
});

/** Truncate a real clustered recording partway through its final cluster (before its index). */
function interruptedCapture(root: string) {
  const file = path.join(root, "capture.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=6:size=96x64:rate=10", "-f", "lavfi", "-i", "sine=duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a", "aac", "-cluster_time_limit", "2000", "-y", file]);
  fs.truncateSync(file, Math.floor(fs.statSync(file).size * 0.85));
  return file;
}

function expectPlayableMp4(file: string) {
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:format=format_name,duration", "-of", "json", file], { encoding: "utf8" }));
  expect(info.format.format_name.split(",")).toContain("mp4");
  expect(Number(info.format.duration)).toBeGreaterThan(3);
  expect(info.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual(["h264", "aac"]);
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { stdio: "pipe" });
}

describe("unfinished live capture files", () => {
  it.each(["manual stop", "stalled capture"] as const)("saves a playable MP4 after a %s even when the extractor ignores SIGINT", async (reason) => {
    DownloadQueue.stopRepeatAfterMs = 300;
    vi.stubEnv("EASYX_LIVE_STALL_SECONDS", "1");
    const { root, db, plugins, mediaDir, source } = await setup(true, "live-capture.mkv");
    const file = interruptedCapture(root);
    const script = `process.on("SIGINT", () => {}); require("node:fs").copyFileSync(${JSON.stringify(file)}, process.argv[1] + ".part"); setInterval(() => {}, 1000)`;
    scan(db, source, script);
    const item = liveItems(db)[0];
    const indexed = vi.fn();
    const queue = new DownloadQueue(db, plugins, mediaDir, undefined, indexed);
    try {
      await queue.start();
      await waitFor(() => fs.existsSync(path.join(mediaDir, ".downloads", item.id, "live-capture.mkv.part")));
      if (reason === "manual stop") queue.stopRecording(item.id);
      await waitFor(() => db.getItem(item.id)?.status === "completed");
      const stored = db.getItem(item.id)!.storagePath!;
      expect(path.extname(stored)).toBe(".mp4");
      expectPlayableMp4(path.join(mediaDir, stored));
      expect(indexed).toHaveBeenCalledExactlyOnceWith(stored, undefined);
    } finally { queue.stop(); db.close(); vi.unstubAllEnvs(); }
  }, 15_000);

  it("fails an extractor that opens a part and never writes media", async () => {
    vi.stubEnv("EASYX_LIVE_STALL_SECONDS", "1");
    const { db, plugins, mediaDir, source } = await setup(true);
    scan(db, source, "require('node:fs').writeFileSync(process.argv[1] + '.part', ''); setInterval(() => {}, 1000)");
    const item = liveItems(db)[0];
    const queue = new DownloadQueue(db, plugins, mediaDir);
    try {
      await queue.start();
      await waitFor(() => db.getItem(item.id)?.status === "failed");
      expect(db.getItem(item.id)?.error).toContain("timed out before any media");
      expect(fs.existsSync(path.join(mediaDir, ".downloads", item.id))).toBe(false);
    } finally { queue.stop(); db.close(); vi.unstubAllEnvs(); }
  }, 12_000);

  it("retains the original part when a failed extractor leaves unreadable bytes", async () => {
    const { db, plugins, mediaDir, source } = await setup(true);
    scan(db, source, "require('node:fs').writeFileSync(process.argv[1] + '.part', 'broken capture'); process.exit(1)");
    const item = liveItems(db)[0];
    const queue = new DownloadQueue(db, plugins, mediaDir);
    try {
      await queue.start();
      await waitFor(() => db.getItem(item.id)?.status === "failed");
      const saved = db.getItem(item.id)!;
      expect(saved.error).toContain(".recording-recovery");
      expect(fs.readFileSync(path.join(mediaDir, ".recording-recovery", item.id, "live-capture.mkv.part"), "utf8")).toBe("broken capture");
    } finally { queue.stop(); db.close(); }
  });

  it("recovers a crashed capture before retrying, even with a larger unfinished final MP4", async () => {
    const { root, db, plugins, mediaDir, source } = await setup(true);
    scan(db, source);
    const item = liveItems(db)[0];
    db.setItemStatus(item.id, "downloading");
    const directory = path.join(mediaDir, ".downloads", item.id);
    fs.mkdirSync(directory, { recursive: true });
    const file = interruptedCapture(root);
    fs.copyFileSync(file, path.join(directory, "live-capture.mkv.part"));
    fs.writeFileSync(path.join(directory, "unfinished.mp4"), Buffer.alloc(fs.statSync(file).size + 1));
    const queue = new DownloadQueue(db, plugins, mediaDir);
    try {
      await queue.start();
      const saved = db.getItem(item.id)!;
      expect(saved.status, saved.error).toBe("completed");
      expectPlayableMp4(path.join(mediaDir, saved.storagePath!));
    } finally { queue.stop(); db.close(); }
  });
});

describe("live recordings across an application restart", () => {
  it("saves running live recordings on shutdown instead of discarding them", async () => {
    const { db, plugins, mediaDir, source } = await setup();
    const queue = new DownloadQueue(db, plugins, mediaDir); queue.start();
    try {
      scan(db, source);
      await waitFor(() => liveItems(db)[0]?.status === "downloading");
      const [item] = liveItems(db);
      await waitFor(() => (fs.statSync(path.join(mediaDir, ".downloads", item.id, "recording.mp4"), { throwIfNoEntry: false })?.size ?? 0) > 10);
      await queue.shutdown(5_000);
      const saved = db.getItem(item.id)!;
      expect(saved.status).toBe("completed");
      expect(fs.statSync(path.join(mediaDir, saved.storagePath!)).size).toBeGreaterThan(10);
      // Shutdown is not a manual stop: the room stays eligible for a new session.
      expect(scan(db, db.getSource(source.id)!, undefined, Date.now() + 60_000)).toHaveLength(1);
    } finally { queue.stop(); db.close(); }
  });

  it("turns the recorded parts of a killed recording into a library video on the next start", async () => {
    const { db, plugins, mediaDir, source } = await setup();
    scan(db, source);
    const [item] = liveItems(db);
    db.setItemStatus(item.id, "downloading", { progress: 0 });
    const parts = path.join(mediaDir, ".downloads", item.id, "live-parts"); fs.mkdirSync(parts, { recursive: true });
    for (const name of ["part-001.ts", "part-002.ts"]) {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=duration=1",
        "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-f", "mpegts", "-y", path.join(parts, name)]);
    }
    const indexed = vi.fn();
    const queue = new DownloadQueue(db, plugins, mediaDir, undefined, indexed);
    try {
      await queue.start();
      const saved = db.getItem(item.id)!;
      expect(saved.status).toBe("completed");
      const file = path.join(mediaDir, saved.storagePath!);
      const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
      expect(duration).toBeGreaterThan(1.5);
      expect(fs.existsSync(path.join(mediaDir, ".downloads", item.id))).toBe(false);
      expect(indexed).toHaveBeenCalledExactlyOnceWith(saved.storagePath, undefined);
    } finally { queue.stop(); db.close(); }
  });

  it("keeps unreadable recorded data for manual recovery instead of deleting it", async () => {
    const { db, plugins, mediaDir, source } = await setup();
    scan(db, source);
    const [item] = liveItems(db);
    db.setItemStatus(item.id, "stopping");
    const staging = path.join(mediaDir, ".downloads", item.id); fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "recording.mp4"), "not a video");
    const queue = new DownloadQueue(db, plugins, mediaDir);
    try {
      await queue.start();
      expect(db.getItem(item.id)).toMatchObject({ status: "failed" });
      expect(db.getItem(item.id)?.error).toContain(".recording-recovery");
      expect(fs.readFileSync(path.join(mediaDir, ".recording-recovery", item.id, "recording.mp4"), "utf8")).toBe("not a video");
    } finally { queue.stop(); db.close(); }
  });

  it("finds recorder parts first and otherwise the largest partial file", () => {
    const root = temp("easyx-recorded-input");
    expect(recordedInput(root)).toBeUndefined();
    fs.writeFileSync(path.join(root, "small.mp4"), "1"); fs.writeFileSync(path.join(root, "large.mp4.part"), "12345"); fs.writeFileSync(path.join(root, "notes.txt"), "123456789");
    expect(recordedInput(root)).toEqual({ file: path.join(root, "large.mp4.part") });
    fs.mkdirSync(path.join(root, "live-parts")); fs.writeFileSync(path.join(root, "live-parts", "part-002.ts"), "b"); fs.writeFileSync(path.join(root, "live-parts", "part-001.ts"), "a");
    fs.writeFileSync(path.join(root, "live-parts", "part-003.ts"), "");
    expect(recordedInput(root)).toEqual({ parts: [path.join(root, "live-parts", "part-001.ts"), path.join(root, "live-parts", "part-002.ts")] });
  });
});
