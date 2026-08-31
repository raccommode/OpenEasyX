import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { LiveCamService } from "./live-cams.js";
import { PluginManager } from "./plugin-manager.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-live-cams-")); temporaryDirectories.push(root);
  const pluginRoot = path.join(root, "plugins"); fs.mkdirSync(path.join(pluginRoot, "viewer"), { recursive: true }); fs.mkdirSync(path.join(pluginRoot, "live"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "viewer", "index.mjs"), `export default { manifest: { id: "org.easyx.viewer", name: "Viewer", version: "1", description: "Test", author: "Test", capabilities: ["library-hook"] }, acceptLibraryDeletion: async (_context, deletion) => deletion };`);
  fs.writeFileSync(path.join(pluginRoot, "live", "index.mjs"), `export default {
    manifest: { id: "test.live", name: "Test Live", version: "1", description: "Test", author: "Test", capabilities: ["live-cam", "download-resolver"], sourceUrlPatterns: ["https://live.test/*"] },
    listLiveCams: async (_context, query) => ({ cams: [{ id: "alice", username: "alice", title: "Alice live", pageUrl: "https://live.test/alice", viewers: 25 }], total: 1, page: query.page, pageSize: query.pageSize, pages: 1 }),
    resolveLiveStream: async () => ({ url: "https://cdn.test/alice/master.m3u8", headers: { Referer: "https://live.test/" } }),
    resolveDownload: async (_context, item) => ({ url: "https://cdn.test/alice/master.m3u8", filename: item.filename })
  };`);
  const database = new Database(path.join(root, "data")); const plugins = new PluginManager(database, [pluginRoot]); await plugins.load();
  return { database, plugins, service: new LiveCamService(database, plugins) };
}

describe("Open EasyX live cams", () => {
  it("aggregates every installed live provider without a Viewer bridge", async () => {
    const { plugins, service } = await fixture();
    plugins.install("test.live");
    await expect(service.list({ page: 1, pageSize: 24 })).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", providerId: "test.live", providerName: "Test Live", viewers: 25 }], providers: [{ id: "test.live", ok: true }],
    });
  });

  it("persists favorite creators and lists only favorites that are currently online", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.listLiveCams = async (_context, query) => {
      const cams = [
        { id: "alice", username: "alice", pageUrl: "https://live.test/alice", viewers: 25 },
        { id: "bob", username: "bob", pageUrl: "https://live.test/bob", viewers: 10 },
      ].filter((cam) => !query.search || cam.username.includes(query.search));
      return { cams, total: cams.length, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    const alice = (await service.list({ page: 1, pageSize: 24 })).items[0];
    expect(service.setFavorite("test.live", alice, true)).toMatchObject({ favorite: true, item: { username: "alice" } });
    expect(database.listLiveCamFavorites()).toHaveLength(1);
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", favorite: true }],
    });
    expect(service.listFavorites()).toEqual([expect.objectContaining({ username: "alice" })]);
    expect(service.setFavorite("test.live", alice, false)).toEqual({ favorite: false });
  });

  it("resolves provider streams behind a short-lived Downloader proxy URL", async () => {
    const { plugins, service } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    await expect(service.resolve("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }))
      .resolves.toEqual({ streamUrl: expect.stringMatching(/^\/api\/live-cams\/proxy\/[A-Za-z0-9_-]+\.m3u8$/) });
  });

  it("uses provider totals and returns only the requested aggregate page", async () => {
    const { plugins, service } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.listLiveCams = async (_context, query) => {
      const matching = Array.from({ length: 125 }, (_, index) => ({
        id: `cam-${index + 1}`, username: `cam-${index + 1}`, pageUrl: `https://live.test/cam-${index + 1}`, viewers: 125 - index,
      })).filter((cam) => !query.search || cam.username.includes(query.search));
      return {
        cams: matching.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        total: matching.length, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(matching.length / query.pageSize)),
      };
    };
    const page = await service.list({ page: 3, pageSize: 24 });
    expect(page).toMatchObject({ total: 125, page: 3, pages: 6, providers: [{ id: "test.live", count: 125 }] });
    expect(page.items).toHaveLength(24);
    expect(page.items[0]).toMatchObject({ username: "cam-49" });
    await expect(service.list({ page: 1, pageSize: 24, search: "cam-12" })).resolves.toMatchObject({
      total: 7, providers: [{ id: "test.live", count: 7 }],
    });
    await expect(service.get("test.live", "cam-125")).resolves.toMatchObject({ id: "cam-125", providerId: "test.live" });
  });

  it("reuses the fresh catalogue entry when opening a room and queues direct recordings", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live"); let searched = false;
    plugin.listLiveCams = async (_context, query) => {
      if (query.search) { searched = true; throw new Error("The provider search endpoint rejected the request"); }
      return { cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", thumbnailUrl: "https://live.test/alice.jpg" }], total: 1, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    await service.list({ page: 1, pageSize: 24 });
    const cam = await service.get("test.live", "alice");
    expect(searched).toBe(false);
    expect(cam).toMatchObject({ username: "alice", providerId: "test.live" });
    const recording = service.record("test.live", cam);
    expect(recording.status).toBe("queued");
    expect(database.getItem(recording.itemId)).toMatchObject({ status: "queued", mediaType: "video", pageUrl: "https://live.test/alice", filename: expect.stringMatching(/^alice-.*\.mp4$/) });
  });

  it("streams an initial snapshot and then updates as each provider completes", async () => {
    const { plugins, service } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    plugins.get("test.live").listLiveCams = async (_context, query) => {
      await waiting;
      return { cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice" }], total: 1, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    const iterator = service.stream({ page: 1, pageSize: 24 });
    await expect(iterator.next()).resolves.toMatchObject({ value: { total: 0, complete: false, providers: [{ id: "test.live", pending: true }] } });
    const completed = iterator.next(); release();
    await expect(completed).resolves.toMatchObject({ value: { total: 1, complete: true, items: [{ username: "alice" }], providers: [{ count: 1 }] } });
  });
});
