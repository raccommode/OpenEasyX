import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    await expect(service.setFavorite("test.live", alice, true)).resolves.toMatchObject({ favorite: true, item: { username: "alice" } });
    expect(database.listLiveCamFavorites()).toHaveLength(1);
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", favorite: true }],
    });
    expect(service.listFavorites()).toEqual([expect.objectContaining({ username: "alice" })]);
    await expect(service.setFavorite("test.live", alice, false)).resolves.toEqual({ favorite: false });
  });

  it("reconciles an authoritative account snapshot without touching other providers", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "old", username: "old", pageUrl: "https://live.test/old" }, true);
    database.setLiveCamFavorite("other.live", { camId: "keep", username: "keep", pageUrl: "https://other.test/keep" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => ({
      authoritative: true,
      cams: [
        { id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true },
        { id: "bob", username: "bob", pageUrl: "https://live.test/bob", online: false },
      ],
    });

    await expect(service.syncFavorites("test.live")).resolves.toEqual({
      providerId: "test.live", synced: 2, added: 2, removed: 1, authoritative: true,
    });
    expect(database.listLiveCamFavorites("test.live").map((item) => item.username)).toEqual(["alice", "bob"]);
    expect(database.listLiveCamFavorites("other.live").map((item) => item.username)).toEqual(["keep"]);
  });

  it("keeps existing favorites when an account snapshot is not authoritative", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => ({ cams: [], authoritative: false, skippedReason: "Session expired" });
    await expect(service.syncFavorites("test.live")).resolves.toMatchObject({ authoritative: false, skippedReason: "Session expired" });
    expect(database.listLiveCamFavorites("test.live").map((item) => item.username)).toEqual(["alice"]);
  });

  it("uses one followed snapshot to list online favorites without per-creator searches", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.listLiveCams = async () => { throw new Error("Per-creator search should not run"); };
    plugin.listFollowedLiveCams = async () => ({ authoritative: true, cams: [
      { id: "alice", username: "alice", pageUrl: "https://live.test/alice", viewers: 25, online: true },
      { id: "bob", username: "bob", pageUrl: "https://live.test/bob", viewers: 0, online: false },
    ] });
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 2, items: [{ username: "alice", favorite: true, online: true }, { username: "bob", favorite: true, online: false }], providers: [{ ok: true, count: 2 }],
    });
    expect(service.listFavorites().map((favorite) => favorite.username)).toEqual(["alice", "bob"]);
  });

  it("saves locally immediately and synchronizes the provider account in the background", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    let remoteFavorite: boolean | undefined;
    plugins.get("test.live").setLiveCamFavorite = async (_context, _cam, favorite) => { remoteFavorite = favorite; return { synchronized: true }; };
    await expect(service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true))
      .resolves.toMatchObject({ favorite: true, synchronization: "pending" });
    await service.flushFavoriteChanges("test.live");
    expect(remoteFavorite).toBe(true);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
  });

  it("does not wait for a slow provider and protects the saved favorite from a stale snapshot", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    let finish!: (value: { synchronized: boolean }) => void;
    plugins.get("test.live").setLiveCamFavorite = () => new Promise((resolve) => { finish = resolve; });
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: true, cams: [] });
    const cam = (await service.list({ page: 1, pageSize: 24 })).items[0];
    await expect(service.setFavorite("test.live", cam, true)).resolves.toMatchObject({ favorite: true });
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({ items: [{ username: "alice", favorite: true }], total: 1 });
    finish({ synchronized: true }); await service.flushFavoriteChanges("test.live");
  });

  it("retains failed and disconnected local favorites across service restarts and retries them", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    plugins.get("test.live").setLiveCamFavorite = async () => { throw new Error("Session expired"); };
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: false, cams: [], skippedReason: "Session expired" });
    await service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    await service.flushFavoriteChanges("test.live");
    expect(service.favoriteChanges()).toEqual([expect.objectContaining({ state: "failed", error: "Session expired" })]);
    const restarted = new LiveCamService(database, plugins);
    await expect(restarted.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({ total: 1, items: [{ username: "alice", favorite: true }] });
    plugins.get("test.live").setLiveCamFavorite = async () => ({ synchronized: true });
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: true, cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true }] });
    await restarted.syncFavorites("test.live");
    expect(restarted.favoriteChanges()).toEqual([]);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
  });

  it("serializes rapid toggles and never lets an older follow override a newer unfollow", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    let finish!: (value: { synchronized: boolean }) => void; const writes: boolean[] = [];
    plugins.get("test.live").setLiveCamFavorite = async (_context, _cam, favorite) => {
      writes.push(favorite);
      if (favorite) return new Promise((resolve) => { finish = resolve; });
      return { synchronized: true };
    };
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice" };
    await service.setFavorite("test.live", cam, true);
    await service.setFavorite("test.live", cam, false);
    finish({ synchronized: true }); await service.flushFavoriteChanges("test.live");
    expect(writes).toEqual([true, false]);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(false);
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: true, cams: [{ ...cam, online: true }] });
    await service.syncFavorites("test.live");
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(false);
  });

  it("bounds a stuck provider operation, aborts its context, and preserves the local choice", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      plugins.get("test.live").setLiveCamFavorite = (context) => { signal = context.signal; return new Promise(() => {}); };
      await service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      const pending = service.flushFavoriteChanges("test.live");
      await vi.advanceTimersByTimeAsync(45_001); await pending;
      expect(signal?.aborted).toBe(true); expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
      expect(service.favoriteChanges()[0]).toMatchObject({ state: "failed", error: expect.stringContaining("timed out") });
    } finally { vi.useRealTimers(); }
  });

  it("still lists saved favorites when the provider's snapshot throws", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => { throw new Error("Network unreachable"); };
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({ total: 1, items: [{ username: "alice", favorite: true }] });
  });

  it("creates one reusable performer profile directly from a live room", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice", thumbnailUrl: "https://live.test/alice.jpg" };
    expect(service.createPerformer("test.live", cam)).toMatchObject({
      created: true, sourceCreated: true,
      performer: { name: "alice", imageUrl: "https://live.test/alice.jpg", externalRefs: { "test.live": "alice" } },
      source: { pluginId: "test.live", profileUrl: "https://live.test/alice" },
    });
    expect(service.createPerformer("test.live", { ...cam, pageUrl: "https://live.test/alice/" })).toMatchObject({ created: false, sourceCreated: false });
    expect(database.listPerformers()).toHaveLength(1);
    expect(database.listSources()).toHaveLength(1);
    await expect(service.get("test.live", "alice")).resolves.toMatchObject({ performerId: database.listPerformers()[0].id });
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
