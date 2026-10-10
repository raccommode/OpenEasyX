import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { BACKUP_FORMAT, exportBackup, importBackup, parseBackup } from "./backup.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };

async function library() {
  const pluginDir = temp("easyx-backup-plugins"); const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default {
    manifest: { id: "test.live", name: "Live", version: "1", description: "Test", author: "Test", capabilities: ["media-listing"], sourceUrlPatterns: ["https://live.test/*"],
      polling: { mode: "live", minimumIntervalSeconds: 5, defaultIntervalSeconds: 10 }, settings: [{ key: "password", label: "Password", type: "password" }] },
    listMedia: async () => []
  };`);
  const db = new Database(temp("easyx-backup-data")); const plugins = new PluginManager(db, [pluginDir]); await plugins.load();
  return { db, plugins };
}

async function filledLibrary() {
  const lib = await library();
  lib.plugins.install("test.live", { password: "secret-value" });
  lib.db.updateSettings({ maxConcurrentDownloads: 6, defaultLiveIntervalSeconds: 30 });
  const alice = lib.db.createPerformer({ name: "Alice", aliases: ["Ally"], imageUrl: "https://img.test/alice.jpg" });
  lib.db.mergePerformerDetails(alice.id, { externalRefs: { "test.live": "alice" } });
  lib.db.setPerformerPriority(alice.id, 1);
  const source = lib.db.addSource(alice.id, "test.live", { externalId: "https://live.test/alice", label: "live.test", profileUrl: "https://live.test/alice", domain: "live.test" });
  lib.db.updateSource(source.id, { autoDownload: true, scraperPluginId: "test.live", scrapeEnabled: true, syncIntervalSeconds: 30, recordingMaxHeight: 720 });
  lib.db.createPerformer({ name: "Bob" });
  return lib;
}

describe("backup export and import", () => {
  it("exports performers, sources, settings and installed plugins without plugin secrets", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      const backup = exportBackup(db, plugins, "test");
      expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: 1, appVersion: "test", settings: { maxConcurrentDownloads: 6, defaultLiveIntervalSeconds: 30 }, plugins: [{ id: "test.live", enabled: true }] });
      expect(backup.performers).toHaveLength(2);
      expect(backup.performers[0]).toMatchObject({
        name: "Alice", aliases: ["Ally"], imageUrl: "https://img.test/alice.jpg", externalRefs: { "test.live": "alice" }, priority: 1,
        sources: [{ pluginId: "test.live", profileUrl: "https://live.test/alice", autoDownload: true, scraperPluginId: "test.live", scrapeEnabled: true, syncIntervalSeconds: 30, recordingMaxHeight: 720 }],
      });
      expect(JSON.stringify(backup)).not.toContain("secret-value");
    } finally { db.close(); }
  });

  it("restores everything into an empty library", async () => {
    const source = await filledLibrary();
    const backup = JSON.parse(JSON.stringify(exportBackup(source.db, source.plugins)));
    source.db.close();
    const { db, plugins } = await library();
    try {
      const result = importBackup(db, plugins, parseBackup(backup));
      expect(result).toMatchObject({ performers: { created: 2, updated: 0 }, sources: { added: 1, updated: 0, skipped: [] }, plugins: { installed: ["test.live"], skipped: [] } });
      expect(db.getPluginState("test.live")).toMatchObject({ installed: true, enabled: true, config: {} });
      expect(db.getSettings()).toMatchObject({ maxConcurrentDownloads: 6, defaultLiveIntervalSeconds: 30 });
      const alice = db.getPerformerByName("Alice")!;
      expect(alice).toMatchObject({ aliases: ["Ally"], imageUrl: "https://img.test/alice.jpg", externalRefs: { "test.live": "alice" }, priority: 1 });
      expect(db.findPerformerByIdentity("test.live", "alice")?.id).toBe(alice.id);
      expect(db.listSources(alice.id)).toMatchObject([{ profileUrl: "https://live.test/alice", autoDownload: true, scrapeEnabled: true, scraperPluginId: "test.live", syncIntervalSeconds: 30, recordingMaxHeight: 720 }]);
    } finally { db.close(); }
  });

  it("merges into an existing library and is safe to import twice", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      const backup = parseBackup(JSON.parse(JSON.stringify(exportBackup(db, plugins))));
      backup.performers[0].aliases.push("Alicia");
      const result = importBackup(db, plugins, backup, { settings: false });
      expect(result).toMatchObject({ performers: { created: 0, updated: 2 }, sources: { added: 0, updated: 1, skipped: [] }, settings: { applied: [] } });
      expect(db.listPerformers()).toHaveLength(2);
      expect(db.listSources()).toHaveLength(1);
      expect(db.getPerformerByName("Alice")?.aliases).toEqual(["Ally", "Alicia"]);
    } finally { db.close(); }
  });

  it("skips a source that already belongs to another performer", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      const result = importBackup(db, plugins, parseBackup({ format: BACKUP_FORMAT, version: 1, performers: [{ name: "Carol", sources: [{ pluginId: "test.live", externalId: "x", profileUrl: "https://live.test/alice", domain: "live.test" }] }] }));
      expect(result.performers.created).toBe(1);
      expect(result.sources.skipped).toEqual([{ performer: "Carol", profileUrl: "https://live.test/alice", reason: "Already belongs to Alice" }]);
    } finally { db.close(); }
  });

  it("restores all linked identities after performers were merged", async () => {
    const source = await filledLibrary(); const alice = source.db.getPerformerByName("Alice")!;
    source.db.upsertPerformer({ externalId: "second-alice", name: "Alice" }, "test.live", alice.id);
    const backup = parseBackup(exportBackup(source.db, source.plugins)); source.db.close();
    const { db, plugins } = await library();
    try {
      importBackup(db, plugins, backup);
      expect(db.findPerformerByIdentity("test.live", "alice")?.id).toBe(db.findPerformerByIdentity("test.live", "second-alice")?.id);
      expect(db.performerIdentities(db.getPerformerByName("Alice")!.id)).toHaveLength(2);
    } finally { db.close(); }
  });

  it("matches a renamed performer by identity and reports conflicting identities without changing records", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      const backup = parseBackup(exportBackup(db, plugins)); backup.performers[0].name = "Alicia";
      const result = importBackup(db, plugins, backup);
      expect(result.performers.created).toBe(0); expect(db.listPerformers()).toHaveLength(2);
      expect(db.getPerformerByName("Alice")?.aliases).toContain("Alicia");
      const bob = db.getPerformerByName("Bob")!; db.mergePerformerDetails(bob.id, { externalRefs: { "test.live": "bob" } });
      backup.performers[0].name = "Alice"; backup.performers[0].externalRefs = { "test.live": "bob" };
      const conflicted = importBackup(db, plugins, backup);
      expect(conflicted.performers.skipped).toMatchObject([{ name: "Alice" }]);
      expect(db.getPerformerByName("Alice")?.externalRefs).toEqual({ "test.live": "alice" });
      expect(() => db.mergePerformerDetails(bob.id, { externalRefs: { "test.live": "alice" } })).toThrow();
      expect(db.getPerformer(bob.id)?.externalRefs).toEqual({ "test.live": "bob" });
    } finally { db.close(); }
  });

  it("deduplicates sources by normalized account URL even when external IDs differ", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      const backup = parseBackup(exportBackup(db, plugins)); const source = backup.performers[0].sources[0];
      source.externalId = "manual-alice"; source.profileUrl += "/";
      const result = importBackup(db, plugins, backup);
      expect(result.sources).toMatchObject({ added: 0, updated: 1 }); expect(db.listSources()).toHaveLength(1);
    } finally { db.close(); }
  });

  it("keeps other settings when a persisted value exceeds this server's ceiling", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      db.updateSettings({ maxConcurrentDownloads: 100_000, retentionDays: 7, secretValue: "not-exported" });
      const backup = parseBackup(exportBackup(db, plugins));
      expect(backup.settings).toMatchObject({ maxConcurrentDownloads: 100_000, retentionDays: 7 });
      expect(backup.settings).not.toHaveProperty("secretValue");
      const result = importBackup(db, plugins, backup); expect(result.settings.skipped).toContain("maxConcurrentDownloads");
      expect(result.settings.applied).toContain("retentionDays");
    } finally { db.close(); }
  });

  it("restores unavailable sources with scraping disabled and enforces plugin polling minimums", async () => {
    const { db, plugins } = await filledLibrary();
    try {
      const backup = parseBackup(exportBackup(db, plugins)); const source = backup.performers[0].sources[0];
      source.scraperPluginId = "unknown"; source.syncIntervalSeconds = 5;
      const result = importBackup(db, plugins, backup);
      expect(result.sources.warnings).toHaveLength(2);
      expect(db.listSources()[0]).toMatchObject({ scrapeEnabled: false, syncIntervalSeconds: 300 });
    } finally { db.close(); }
  });

  it("rolls back unexpected import errors instead of leaving a partial restore", async () => {
    const { db, plugins } = await library();
    try {
      const backup = parseBackup({ format: BACKUP_FORMAT, version: 1, settings: { retentionDays: 7 }, performers: [{ name: "Alice" }, { name: "Bob" }] });
      const original = db.createPerformer.bind(db);
      vi.spyOn(db, "createPerformer").mockImplementation((values) => { if (values.name === "Bob") throw new Error("Database error"); return original(values); });
      expect(() => importBackup(db, plugins, backup)).toThrow("Database error");
      expect(db.listPerformers()).toEqual([]); expect(db.getSettings().retentionDays).not.toBe(7);
    } finally { db.close(); }
  });

  it("rejects files that are not a backup", () => {
    expect(() => parseBackup({ hello: "world" })).toThrow("This file is not an Open EasyX backup");
    expect(() => parseBackup({ format: BACKUP_FORMAT, version: 99, performers: [] })).toThrow(/newer Open EasyX/);
  });
});
