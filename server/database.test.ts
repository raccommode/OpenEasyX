import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "./database.js";

const dirs: string[] = [];
function createDb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-test-")); dirs.push(dir); return new Database(dir); }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Database", () => {
  it("persists live creator favorites independently from recorded media", () => {
    const db = createDb();
    expect(db.setLiveCamFavorite("test.live", { camId: "alice-id", username: "Alice", title: "Alice live", pageUrl: "https://live.test/Alice", thumbnailUrl: "https://live.test/alice.jpg" }, true))
      .toMatchObject({ providerId: "test.live", camId: "alice-id", username: "Alice" });
    expect(db.isLiveCamFavorite("test.live", "alice")).toBe(true);
    expect(db.listLiveCamFavorites()).toEqual([expect.objectContaining({ username: "Alice", pageUrl: "https://live.test/Alice" })]);
    expect(db.setLiveCamFavorite("test.live", { camId: "alice-id", username: "ALICE", pageUrl: "https://live.test/Alice" }, false)).toBeUndefined();
    expect(db.listLiveCamFavorites()).toEqual([]);
  });

  it("queues discovered media by default without overriding a saved preference", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-test-")); dirs.push(dir);
    const initial = new Database(dir);
    expect(initial.getSettings().autoQueueDiscovered).toBe(true);
    initial.updateSettings({ autoQueueDiscovered: false });
    initial.sqlite.close();

    const reopened = new Database(dir);
    expect(reopened.getSettings().autoQueueDiscovered).toBe(false);
  });

  it("migrates pre-scraper databases without losing source schedules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-test-")); dirs.push(dir);
    const sqlite = new DatabaseSync(path.join(dir, "easyx.sqlite"));
    sqlite.exec(`
      CREATE TABLE performers (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, aliases_json TEXT NOT NULL DEFAULT '[]', image_url TEXT, external_refs_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE sources (id TEXT PRIMARY KEY, performer_id TEXT NOT NULL REFERENCES performers(id) ON DELETE CASCADE, plugin_id TEXT NOT NULL, external_id TEXT NOT NULL, label TEXT NOT NULL, profile_url TEXT NOT NULL, domain TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, auto_download INTEGER NOT NULL DEFAULT 0, sync_interval_minutes INTEGER NOT NULL DEFAULT 360, last_synced_at TEXT, next_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(performer_id, plugin_id, external_id));
      INSERT INTO performers VALUES('person_old','Old Performer','[]',NULL,'{}','2026-01-01','2026-01-01');
      INSERT INTO sources VALUES('source_old','person_old','plugin.old','profile','Old URL','https://example.test/profile','example.test',1,0,7,NULL,NULL,NULL,'2026-01-01','2026-01-01');
    `);
    sqlite.close();
    const db = new Database(dir);
    expect(db.getSource("source_old")).toMatchObject({ scraperPluginId: undefined, scrapeEnabled: false, syncIntervalSeconds: 420 });
  });

  it("migrates installed Nitter RSS state and assignments to the public X plugin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-test-")); dirs.push(dir);
    const initial = new Database(dir);
    initial.setPluginState("org.easyx.nitter-rss", { installed: true, enabled: true, config: { instanceUrl: "https://obsolete.test", maxItems: 42, includeImages: false } });
    const person = initial.createPerformer({ name: "Public X" });
    const source = initial.addSource(person.id, "org.easyx.manual", { externalId: "https://x.com/example", label: "X", profileUrl: "https://x.com/example", domain: "x.com" });
    const selected = initial.updateSource(source.id, { scraperPluginId: "org.easyx.nitter-rss", scrapeEnabled: true })!;
    initial.ingestItems(selected, [{ externalId: "old", mediaType: "image" }]);
    initial.sqlite.close();

    const migrated = new Database(dir);
    expect(migrated.getSource(source.id)?.scraperPluginId).toBe("org.easyx.x");
    expect(migrated.listItems()[0].pluginId).toBe("org.easyx.x");
    expect(migrated.getPluginState("org.easyx.x")).toMatchObject({ installed: true, enabled: true, config: { maxItems: 42, includeImages: false } });
    expect(migrated.getPluginState("org.easyx.nitter-rss")).toEqual({ installed: false, enabled: false, config: {} });
  });

  it("merges performers by case-insensitive name and retains external references", () => {
    const db = createDb();
    const first = db.upsertPerformer({ externalId: "1", name: "Example", aliases: ["One"] }, "plugin.one");
    const second = db.upsertPerformer({ externalId: "2", name: "example", aliases: ["Two"] }, "plugin.two");
    expect(second.id).toBe(first.id);
    expect(second.aliases).toEqual(["One", "Two"]);
    expect(second.externalRefs).toEqual({ "plugin.one": "1", "plugin.two": "2" });
  });

  it("merges an explicitly grouped provider match into the selected performer", () => {
    const db = createDb();
    const first = db.upsertPerformer({ externalId: "1", name: "Example-Star", aliases: ["One"] }, "plugin.one");
    const merged = db.upsertPerformer({ externalId: "2", name: "Example Star", aliases: ["Two"] }, "plugin.two", first.id);
    expect(merged.id).toBe(first.id);
    expect(merged.name).toBe("Example-Star");
    expect(merged.externalRefs).toEqual({ "plugin.one": "1", "plugin.two": "2" });
  });

  it("keeps the highest quality candidate for a shared identity", () => {
    const db = createDb();
    const person = db.upsertPerformer({ externalId: "p", name: "Example" }, "plugin.one");
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test/a", domain: "example.test" });
    expect(db.ingestItems(source, [{ externalId: "low", identityKey: "same-work", mediaType: "image", qualityScore: 100, publishedAt: "2022-01-01T00:00:00Z" }])).toEqual({ added: 1, upgraded: 0, skipped: 0 });
    expect(db.ingestItems(source, [{ externalId: "worse", identityKey: "same-work", mediaType: "image", qualityScore: 50, publishedAt: "2020-01-01T00:00:00Z" }])).toEqual({ added: 0, upgraded: 0, skipped: 1 });
    expect(db.ingestItems(source, [{ externalId: "high", identityKey: "same-work", mediaType: "image", qualityScore: 200, publishedAt: "2021-01-01T00:00:00Z" }])).toEqual({ added: 1, upgraded: 1, skipped: 0 });
    expect(db.listItems().map((item) => item.status)).toContain("superseded");
    expect(db.listItems().find((item) => item.status !== "superseded")?.publishedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("reports an older date discovered for an already stored item", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Stored" });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "one", mediaType: "image", publishedAt: "2024-01-01T00:00:00Z" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "completed", { storagePath: "Stored/example.test/one.jpg" });
    const changed: string[] = [];
    db.ingestItems(source, [{ externalId: "one", mediaType: "image", publishedAt: "2020-01-01T00:00:00Z" }], (itemId) => changed.push(itemId));
    expect(changed).toEqual([item.id]);
    expect(db.getItem(item.id)?.publishedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("keeps viewer-deleted downloads as durable no-redownload tombstones", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Deleted" });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "original", identityKey: "same-media", mediaType: "video", qualityScore: 100 }]);
    const item = db.listItems()[0];
    db.setItemStatus(item.id, "completed", { storagePath: "Deleted\\example.test\\clip.mp4" });

    expect(db.markStoredItemDeleted("Deleted/example.test/clip.mp4")).toMatchObject({ id: item.id, status: "deleted" });
    expect(db.markStoredItemDeleted("Deleted/example.test/missing.mp4")).toBeUndefined();
    expect(db.ingestItems(source, [{ externalId: "original", identityKey: "same-media", mediaType: "video", qualityScore: 100 }]))
      .toEqual({ added: 0, upgraded: 0, skipped: 1 });
    expect(db.ingestItems(source, [{ externalId: "higher-quality-variant", identityKey: "same-media", mediaType: "video", qualityScore: 1000 }]))
      .toEqual({ added: 0, upgraded: 0, skipped: 1 });
    expect(db.getItem(item.id)?.storagePath).toBe("Deleted\\example.test\\clip.mp4");
  });

  it("finds visually equivalent images for the same performer", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Visual" });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "one", mediaType: "image", qualityScore: 100 }]);
    const item = db.listItems()[0]; db.setDownloadFingerprint(item.id, "0123456789abcdef", 100); db.setItemStatus(item.id, "completed", { checksum: "one", storagePath: "one.jpg" });
    expect(db.findVisualDuplicate("0123456789abcdee", "other", person.id, "image")?.id).toBe(item.id);
    expect(db.findVisualDuplicate("fedcba9876543210", "other", person.id, "image")).toBeUndefined();
  });

  it("records download timing and resets it before a retry", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Timed" });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "one", mediaType: "video" }]);
    const item = db.listItems()[0];

    db.setItemStatus(item.id, "queued");
    expect(db.getItem(item.id)).toMatchObject({ downloadStartedAt: undefined, downloadFinishedAt: undefined });
    const started = db.setItemStatus(item.id, "downloading", { progress: 0 })!;
    expect(started.downloadStartedAt).toBeDefined();
    expect(started.downloadFinishedAt).toBeUndefined();
    const progress = db.setItemStatus(item.id, "downloading", { progress: 0.5 })!;
    expect(progress.downloadStartedAt).toBe(started.downloadStartedAt);
    const failed = db.setItemStatus(item.id, "failed", { error: "network" })!;
    expect(failed.downloadFinishedAt).toBeDefined();

    const retried = db.setItemStatus(item.id, "queued", { progress: 0 })!;
    expect(retried.downloadStartedAt).toBeUndefined();
    expect(retried.downloadFinishedAt).toBeUndefined();
  });

  it("paginates and filters every activity item", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Paged Creator" });
    db.updateSettings({ autoQueueDiscovered: false });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Main feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, Array.from({ length: 65 }, (_, index) => ({
      externalId: `media-${index}`, title: `Media ${index}`, mediaType: index % 2 ? "video" : "image",
    })));
    const all = db.listItems(100);
    db.setItemStatus(all[0].id, "failed", { error: "network" });
    db.setItemStatus(all[1].id, "downloading", { progress: 0.4 });

    const first = db.listItemsPage({ page: 1, pageSize: 25 });
    const last = db.listItemsPage({ page: 3, pageSize: 25 });
    expect(first).toMatchObject({ page: 1, pageSize: 25, total: 65, totalPages: 3 });
    expect(first.items).toHaveLength(25);
    expect(last.items).toHaveLength(15);
    expect(new Set([...first.items, ...db.listItemsPage({ page: 2, pageSize: 25 }).items, ...last.items]).size).toBe(65);
    expect(db.listItemsPage({ category: "active" }).items).toHaveLength(1);
    expect(db.listItemsPage({ category: "errors" }).items).toHaveLength(1);
    expect(db.listItemsPage({ mediaType: "video" }).total).toBe(32);
    expect(db.listItemsPage({ search: "Paged Creator" }).total).toBe(65);
    expect(first.statusCounts).toMatchObject({ available: 63, downloading: 1, failed: 1 });
    expect(first.mediaTypes).toEqual(["image", "video"]);
  });

  it("filters activity across every source sharing a domain", () => {
    const db = createDb();
    const firstPerson = db.createPerformer({ name: "First creator" });
    const secondPerson = db.createPerformer({ name: "Second creator" });
    const firstSource = db.addSource(firstPerson.id, "plugin.one", { externalId: "first", label: "First feed", profileUrl: "https://example.test/first", domain: "Example.Test" });
    const secondSource = db.addSource(secondPerson.id, "plugin.two", { externalId: "second", label: "Second feed", profileUrl: "https://example.test/second", domain: "example.test" });
    const otherSource = db.addSource(secondPerson.id, "plugin.three", { externalId: "other", label: "Other feed", profileUrl: "https://other.test/second", domain: "other.test" });
    db.ingestItems(firstSource, [{ externalId: "one", mediaType: "image" }]);
    db.ingestItems(secondSource, [{ externalId: "two", mediaType: "video" }]);
    db.ingestItems(otherSource, [{ externalId: "three", mediaType: "image" }]);

    const result = db.listItemsPage({ sourceDomain: " EXAMPLE.TEST " });
    expect(result.total).toBe(2);
    expect(new Set(result.items.map((item) => item.sourceId))).toEqual(new Set([firstSource.id, secondSource.id]));
  });

  it("finds an activity item by its exact id for direct management links", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Direct link" });
    const source = db.addSource(person.id, "plugin.one", { externalId: "source", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "asset", mediaType: "video", title: "A different title" }]);
    const item = db.listItems()[0];
    expect(db.listItemsPage({ search: item.id })).toMatchObject({ total: 1, items: [{ id: item.id }] });
  });

  it("requeues every failed item and clears stale retry state", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Retries" });
    db.updateSettings({ autoQueueDiscovered: false });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [
      { externalId: "failed-one", mediaType: "video" }, { externalId: "failed-two", mediaType: "image" }, { externalId: "available", mediaType: "image" },
    ]);
    const [first, second] = db.listItems();
    db.setItemStatus(first.id, "downloading", { progress: 0.7 }); db.setItemStatus(first.id, "failed", { error: "network" });
    db.setItemStatus(second.id, "downloading", { progress: 0.2 }); db.setItemStatus(second.id, "failed", { error: "timeout" });

    expect(db.retryFailedItems()).toBe(2);
    expect(db.listItemsPage({ category: "active" }).items).toHaveLength(2);
    expect(db.getItem(first.id)).toMatchObject({ status: "queued", progress: 0, error: undefined, downloadStartedAt: undefined, downloadFinishedAt: undefined });
    expect(db.retryFailedItems()).toBe(0);
  });

  it("keeps paused work paused and does not restart interrupted cancellation", () => {
    const db = createDb(); const person = db.createPerformer({ name: "Recovery" });
    db.updateSettings({ autoQueueDiscovered: false });
    const source = db.addSource(person.id, "plugin.one", { externalId: "s", label: "Feed", profileUrl: "https://example.test", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "paused", mediaType: "video" }, { externalId: "stopping", mediaType: "video" }, { externalId: "running", mediaType: "video" }]);
    const [running, stopping, paused] = db.listItems();
    db.setItemStatus(paused.id, "paused"); db.setItemStatus(stopping.id, "stopping"); db.setItemStatus(running.id, "downloading");
    expect(db.requeueInterruptedDownloads()).toBe(2);
    expect(db.getItem(paused.id)?.status).toBe("paused");
    expect(db.getItem(stopping.id)?.status).toBe("cancelled");
    expect(db.getItem(running.id)?.status).toBe("queued");
  });

  it("stores media sources with automation defaults", () => {
    const db = createDb();
    const person = db.upsertPerformer({ externalId: "p", name: "Example" }, "plugin.one");
    const source = db.addSource(person.id, "plugin.one", { externalId: "source", label: "Site", profileUrl: "https://media.example.test/example", domain: "media.example.test" });
    expect(source.autoDownload).toBe(false);
    expect(source.scraperPluginId).toBeUndefined();
    expect(source.scrapeEnabled).toBe(false);
    expect(source.syncIntervalSeconds).toBe(21600);
    expect(db.listSources(person.id)).toHaveLength(1);
  });

  it("keeps URL provenance separate from the selected scraper plugin", () => {
    const db = createDb();
    const person = db.createPerformer({ name: "Example" });
    const source = db.addSource(person.id, "plugin.discovery", { externalId: "profile", label: "Profile", profileUrl: "https://example.test/profile", domain: "example.test" });
    const selected = db.updateSource(source.id, { scraperPluginId: "plugin.scraper", scrapeEnabled: true, syncIntervalSeconds: 10 })!;
    expect(selected).toMatchObject({ pluginId: "plugin.discovery", scraperPluginId: "plugin.scraper", scrapeEnabled: true, syncIntervalSeconds: 10 });
    expect(db.dueSources().map((entry) => entry.id)).toContain(source.id);
    db.markSourceSynced(source.id, 10);
    expect(db.getSource(source.id)?.nextSyncAt).toBeDefined();
    expect(db.resetSourceSchedule(source.id)?.nextSyncAt).toBeUndefined();
    db.ingestItems(selected, [{ externalId: "media", mediaType: "image" }]);
    expect(db.listItems()[0].pluginId).toBe("plugin.scraper");
    expect(db.updateSource(source.id, { scraperPluginId: null, scrapeEnabled: false })).toMatchObject({ scraperPluginId: undefined, scrapeEnabled: false });
  });

  it("creates, edits, and deletes a manual performer with cascading sources", () => {
    const db = createDb();
    const person = db.createPerformer({ name: "Manual Star", aliases: ["Alias"], imageUrl: "https://example.test/photo.jpg" });
    expect(person.externalRefs).toEqual({});
    const edited = db.updatePerformer(person.id, { name: "Updated Star", aliases: ["One", "Two"], imageUrl: null });
    expect(edited).toMatchObject({ name: "Updated Star", aliases: ["One", "Two"], imageUrl: undefined });
    db.addSource(person.id, "org.easyx.manual", { externalId: "https://example.test/profile", label: "Profile", profileUrl: "https://example.test/profile", domain: "example.test" });
    expect(db.deletePerformer(person.id)).toBe(true);
    expect(db.getPerformer(person.id)).toBeUndefined();
    expect(db.listSources(person.id)).toEqual([]);
  });

  it("updates and removes a URL association", () => {
    const db = createDb();
    const person = db.createPerformer({ name: "Example" });
    const source = db.addSource(person.id, "org.easyx.manual", { externalId: "https://old.test/a", label: "Old", profileUrl: "https://old.test/a", domain: "old.test" });
    expect(db.updateSource(source.id, { pluginId: "plugin.one", label: "New", profileUrl: "https://new.test/b", domain: "new.test" }))
      .toMatchObject({ pluginId: "plugin.one", label: "New", profileUrl: "https://new.test/b", domain: "new.test" });
    expect(db.deleteSource(source.id)).toBe(true);
    expect(db.getSource(source.id)).toBeUndefined();
  });
});
