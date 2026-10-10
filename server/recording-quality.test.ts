import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue, recordingConfig } from "./downloader.js";
import { LiveCamService } from "./live-cams.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

describe("per-source recording quality", () => {
  it("defaults to automatic and stores a maximum height per source", () => {
    const db = new Database(temp("easyx-quality-db"));
    try {
      const alice = db.createPerformer({ name: "Alice" });
      const one = db.addSource(alice.id, "test.a", { externalId: "a", label: "a.test", profileUrl: "https://a.test/alice", domain: "a.test" });
      const two = db.addSource(alice.id, "test.b", { externalId: "b", label: "b.test", profileUrl: "https://b.test/alice", domain: "b.test" });
      expect(one.recordingMaxHeight).toBe(0);
      expect(db.updateSource(one.id, { recordingMaxHeight: 720 })?.recordingMaxHeight).toBe(720);
      expect(db.updateSource(one.id, { autoDownload: true })?.recordingMaxHeight).toBe(720);
      expect(db.getSource(two.id)?.recordingMaxHeight).toBe(0);
      expect(db.updateSource(one.id, { recordingMaxHeight: 0 })?.recordingMaxHeight).toBe(0);
    } finally { db.close(); }
  });

  it("adds the column to an existing database", () => {
    const dir = temp("easyx-quality-migrate");
    new Database(dir).close();
    const raw = new DatabaseSync(path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(".sqlite"))!));
    raw.exec("ALTER TABLE sources DROP COLUMN recording_max_height"); raw.close();
    const db = new Database(dir);
    try {
      const alice = db.createPerformer({ name: "Alice" });
      expect(db.addSource(alice.id, "test.a", { externalId: "a", label: "a", profileUrl: "https://a.test/alice", domain: "a.test" }).recordingMaxHeight).toBe(0);
    } finally { db.close(); }
  });

  it("only overrides the plugin setting when a maximum is chosen", () => {
    const config = { cookiesFile: "/x", recordingMaxHeight: 1080 };
    expect(recordingConfig(config, { recordingMaxHeight: 0 })).toBe(config);
    expect(recordingConfig(config, { recordingMaxHeight: 480 })).toEqual({ cookiesFile: "/x", recordingMaxHeight: 480 });
    expect(config.recordingMaxHeight).toBe(1080);
  });

  it("passes the source's quality to the plugin that records it", async () => {
    const dataDir = temp("easyx-quality-data"); const mediaDir = temp("easyx-quality-media"); const pluginDir = temp("easyx-quality-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    const seen = path.join(pluginDir, "seen.json");
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `import fs from "node:fs";
      export default {
        manifest: { id: "test.quality", name: "Quality", version: "1", description: "Test", author: "Test", capabilities: ["live-cam", "download-resolver"], sourceUrlPatterns: ["https://live.test/*"],
          settings: [{ key: "cookiesFile", label: "Session", type: "text" }] },
        resolveLiveStream: async () => ({ url: "https://cdn.test/live.m3u8" }),
        resolveDownload: async (context) => {
          fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(context.config));
          return { kind: "command", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'video')", "{output}"], filename: "recording.mp4" };
        }
      };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load(); manager.install("test.quality", { cookiesFile: "/session.txt" });
    const { itemId } = new LiveCamService(db, manager).record("test.quality", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" });
    db.updateSource(db.getItem(itemId)!.sourceId, { recordingMaxHeight: 480 });
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    try {
      await waitFor(() => fs.existsSync(seen));
      expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toEqual({ cookiesFile: "/session.txt", recordingMaxHeight: 480 });
      expect(db.getPluginState("test.quality").config).toEqual({ cookiesFile: "/session.txt" });
      await waitFor(() => ["completed", "failed"].includes(db.getItem(itemId)?.status ?? ""));
    } finally { queue.stop(); db.close(); }
  });
});
