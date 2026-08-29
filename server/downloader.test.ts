import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

describe("DownloadQueue", () => {
  it("keeps an active download under media/.downloads until it is complete", async () => {
    const dataDir = temp("easyx-staging-data"); const mediaDir = temp("easyx-staging-media"); const pluginDir = temp("easyx-staging-plugins");
    let finishResponse: (() => void) | undefined;
    const server = http.createServer((_request, response) => {
      response.setHeader("content-length", "10");
      response.write("first");
      finishResponse = () => response.end("last!");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.staging", name: "Staging", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.staging", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Staging Performer" }, "test.staging");
    const source = db.addSource(person.id, "test.staging", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "asset", mediaType: "video", filename: "asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/asset.mp4` } }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    const staged = path.join(mediaDir, ".downloads", item.id, "asset.mp4");
    const completed = path.join(mediaDir, "Staging Performer", "example.test", "asset.mp4");
    await waitFor(() => fs.existsSync(staged) && fs.statSync(staged).size === 5);
    expect(fs.existsSync(completed)).toBe(false);
    finishResponse?.();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop(); server.close();
    expect(fs.readFileSync(completed, "utf8")).toBe("firstlast!");
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  });

  it("restarts an interrupted download after the server starts again", async () => {
    const dataDir = temp("easyx-restart-data"); const mediaDir = temp("easyx-restart-media"); const pluginDir = temp("easyx-restart-plugins");
    const server = http.createServer((_request, response) => response.end("fresh media"));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.restart", name: "Restart", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.restart", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Restart Performer" }, "test.restart");
    const source = db.addSource(person.id, "test.restart", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "asset", mediaType: "video", filename: "asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/asset.mp4` } }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "downloading", { progress: 0.5 });
    const staleDirectory = path.join(mediaDir, ".downloads", item.id);
    fs.mkdirSync(staleDirectory, { recursive: true }); fs.writeFileSync(path.join(staleDirectory, "asset.mp4"), "stale partial media");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop(); server.close();
    expect(fs.readFileSync(path.join(mediaDir, "Restart Performer", "example.test", "asset.mp4"), "utf8")).toBe("fresh media");
    expect(fs.existsSync(staleDirectory)).toBe(false);
  });

  it("stores by performer/domain and removes byte-identical duplicates", async () => {
    const dataDir = temp("easyx-data"); const mediaDir = temp("easyx-media"); const pluginDir = temp("easyx-plugins");
    const server = http.createServer((_request, response) => { response.setHeader("content-length", "11"); response.end("hello media"); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const url = `http://127.0.0.1:${address.port}/asset.jpg`;
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.download", name: "Test", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.download", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "A/B Performer" }, "test.download");
    const source = db.addSource(person.id, "test.download", { externalId: "source", label: "Source", profileUrl: "https://www.Example.test/profile", domain: "example.test" });
    db.ingestItems(source, [
      { externalId: "one", mediaType: "image", filename: "one.jpg", publishedAt: "2024-01-01T00:00:00Z", metadata: { url } },
      { externalId: "two", mediaType: "image", filename: "two.jpg", publishedAt: "2020-01-01T00:00:00Z", metadata: { url } },
    ]);
    for (const item of db.listItems()) db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.listItems().every((item) => ["completed", "duplicate"].includes(item.status)));
    queue.stop(); server.close();
    expect(db.listItems().filter((item) => item.status === "completed")).toHaveLength(1);
    expect(db.listItems().filter((item) => item.status === "duplicate")).toHaveLength(1);
    const completed = db.listItems().find((item) => item.status === "completed")!;
    expect(completed.publishedAt).toBe("2020-01-01T00:00:00.000Z");
    const files = fs.readdirSync(path.join(mediaDir, "A-B Performer", "example.test"));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(mediaDir, "A-B Performer", "example.test", files[0])).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(fs.readdirSync(path.join(mediaDir, ".downloads"))).toEqual([]);
  });

  it("accepts trusted command-based extractor downloads", async () => {
    const dataDir = temp("easyx-command-data"); const mediaDir = temp("easyx-command-media"); const pluginDir = temp("easyx-command-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.command", name: "Command", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'command media')", "{output}"], filename: "clip.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.command", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Command Performer" }, "test.command");
    const source = db.addSource(person.id, "test.command", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "clip", pageUrl: "https://example.test/clip", mediaType: "video", filename: "clip.mp4", publishedAt: "2021-03-04T12:30:00Z" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop();
    const completed = path.join(mediaDir, "Command Performer", "example.test", "clip.mp4");
    expect(fs.readFileSync(completed, "utf8")).toBe("command media");
    expect(fs.statSync(completed).mtime.toISOString()).toBe("2021-03-04T12:30:00.000Z");
  });

  it("persists command extractor percentage and downloaded bytes while running", async () => {
    const dataDir = temp("easyx-progress-data"); const mediaDir = temp("easyx-progress-media"); const pluginDir = temp("easyx-progress-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.progress", name: "Progress", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", "const fs=require('node:fs'),file=process.argv[1];process.stdout.write('easyx-bytes:5:10');setTimeout(()=>{fs.writeFileSync(file,'1234567890');process.stdout.write('easyx-progress: 100%')},700)", "{output}"], filename: "progress.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.progress", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Progress Performer" }, "test.progress");
    const source = db.addSource(person.id, "test.progress", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "progress", pageUrl: "https://example.test/progress", mediaType: "video", filename: "progress.mp4", expectedBytes: 10 }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => { const active = db.getItem(item.id); return active?.status === "downloading" && active.progress >= 0.5 && active.downloadedBytes >= 5; });
    const active = db.getItem(item.id)!;
    expect(active.progress).toBeGreaterThanOrEqual(0.5); expect(active.progress).toBeLessThan(1); expect(active.downloadedBytes).toBe(5);
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop();
    expect(db.getItem(item.id)).toMatchObject({ progress: 1, downloadedBytes: 10 });
  });

  it("expands command output directory and filename placeholders", async () => {
    const dataDir = temp("easyx-command-parts-data"); const mediaDir = temp("easyx-command-parts-media"); const pluginDir = temp("easyx-command-parts-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.command-parts", name: "Command parts", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", "const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(p.join(process.argv[1],process.argv[2]),'parts media')", "{outputDir}", "{outputName}"], filename: "parts.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.command-parts", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Parts Performer" }, "test.command-parts");
    const source = db.addSource(person.id, "test.command-parts", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "parts", pageUrl: "https://example.test/parts", mediaType: "video", filename: "parts.mp4" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop();
    expect(fs.readFileSync(path.join(mediaDir, "Parts Performer", "example.test", "parts.mp4"), "utf8")).toBe("parts media");
  });

  it("pauses, resumes, stops, and deletes an active recording", async () => {
    const dataDir = temp("easyx-controls-data"); const mediaDir = temp("easyx-controls-media"); const pluginDir = temp("easyx-controls-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    const recorder = "const fs=require('node:fs'),file=process.argv[1];fs.writeFileSync(file,'start');const timer=setInterval(()=>fs.appendFileSync(file,'x'),50);process.on('SIGINT',()=>{clearInterval(timer);process.exit(0)})";
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.controls", name: "Controls", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", ${JSON.stringify(recorder)}, "{output}"], filename: "recording.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.controls", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Live Performer" }, "test.controls");
    const source = db.addSource(person.id, "test.controls", { externalId: "source", label: "Live", profileUrl: "https://example.test/live", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "recording", pageUrl: "https://example.test/live", mediaType: "video", filename: "recording.mp4" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    const staged = path.join(mediaDir, ".downloads", item.id, "recording.mp4");
    await waitFor(() => fs.existsSync(staged) && fs.statSync(staged).size > 5);
    queue.pause(item.id); expect(db.getItem(item.id)?.status).toBe("paused");
    const pausedSize = fs.statSync(staged).size; await new Promise((resolve) => setTimeout(resolve, 180)); expect(fs.statSync(staged).size).toBe(pausedSize);
    queue.resume(item.id); await waitFor(() => fs.statSync(staged).size > pausedSize); expect(db.getItem(item.id)?.status).toBe("downloading");
    queue.stopRecording(item.id); expect(db.getItem(item.id)?.status).toBe("stopping");
    await waitFor(() => db.getItem(item.id)?.status === "completed");
    expect(fs.statSync(path.join(mediaDir, "Live Performer", "example.test", "recording.mp4")).size).toBeGreaterThan(pausedSize);

    db.ingestItems(source, [{ externalId: "delete-me", pageUrl: "https://example.test/live", mediaType: "video", filename: "delete-me.mp4" }]);
    const doomed = db.getItemBySourceExternalId(source.id, "delete-me")!; db.setItemStatus(doomed.id, "queued");
    await waitFor(() => db.getItem(doomed.id)?.status === "downloading"); queue.delete(doomed.id);
    await waitFor(() => db.getItem(doomed.id) === undefined); queue.stop();
    expect(fs.existsSync(path.join(mediaDir, ".downloads", doomed.id))).toBe(false);
  });

  it("deletes both a completed item and its recorded media file", async () => {
    const dataDir = temp("easyx-completed-delete-data"); const mediaDir = temp("easyx-completed-delete-media"); const pluginDir = temp("easyx-completed-delete-plugins");
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    const person = db.upsertPerformer({ externalId: "person", name: "Recorded Performer" }, "test.completed-delete");
    const source = db.addSource(person.id, "test.completed-delete", { externalId: "source", label: "Live", profileUrl: "https://example.test/live", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "recording", mediaType: "video", filename: "recording.mp4" }]);
    const item = db.listItems()[0]; const relativePath = "Recorded Performer/example.test/recording.mp4";
    db.setItemStatus(item.id, "completed", { progress: 1, storagePath: relativePath });
    const file = path.join(mediaDir, ...relativePath.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "recording");
    const libraryDb = new LibraryDatabase(dataDir); const catalog = new Catalog(libraryDb, mediaDir, dataDir, false); await catalog.scan();
    const queue = new DownloadQueue(db, manager, mediaDir, undefined, undefined, (completed) => catalog.deleteStoredMedia(completed.storagePath!));

    expect(queue.delete(item.id)).toMatchObject({ deleted: true, id: item.id, bytes: 9, missing: false });
    expect(db.getItem(item.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(libraryDb.listMedia().total).toBe(0);
    libraryDb.close();
  });
});
