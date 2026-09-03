import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { asJson, id, now } from "./utils.js";
import type { MediaCandidate, PersonCandidate, SourceCandidate } from "../packages/plugin-sdk/index.js";
import { outputDefaults } from "../packages/output-settings.js";

export type Performer = {
  id: string; name: string; aliases: string[]; imageUrl?: string; externalRefs: Record<string, string>;
  createdAt: string; updatedAt: string;
};

export type Source = {
  id: string; performerId: string; pluginId: string; externalId: string; label: string;
  profileUrl: string; domain: string; enabled: boolean; autoDownload: boolean;
  scraperPluginId?: string; scrapeEnabled: boolean;
  syncIntervalSeconds: number; lastSyncedAt?: string; nextSyncAt?: string; lastError?: string;
};

export type PerformerInput = { name: string; aliases?: string[]; imageUrl?: string | null };

export type DownloadItem = {
  id: string; performerId: string; sourceId: string; pluginId: string; externalId: string;
  identityKey?: string; title?: string; pageUrl?: string; mediaType: string; filename?: string;
  qualityScore: number; expectedBytes?: number; publishedAt?: string; metadata: Record<string, unknown>;
  status: string; progress: number; downloadedBytes: number; checksumSha256?: string; visualHash?: string; storagePath?: string; error?: string;
  downloadStartedAt?: string; downloadFinishedAt?: string;
  createdAt: string; updatedAt: string;
};

export type ItemCategory = "active" | "ready" | "downloaded" | "errors" | "other";
export type ItemPageOptions = {
  page?: number; pageSize?: number; category?: ItemCategory; status?: string;
  mediaType?: string; sourceId?: string; sourceDomain?: string; performerId?: string; search?: string;
};
export type ItemPage = {
  items: DownloadItem[]; page: number; pageSize: number; total: number; totalPages: number;
  statusCounts: Record<string, number>; mediaTypes: string[];
};

export type LiveCamFavorite = {
  providerId: string; camId: string; username: string; title?: string; pageUrl: string; thumbnailUrl?: string;
  createdAt: string; updatedAt: string;
};
export type LiveCamFavoriteInput = Pick<LiveCamFavorite, "camId" | "username" | "pageUrl"> & Partial<Pick<LiveCamFavorite, "title" | "thumbnailUrl">>;
export type LiveCamFavoriteChange = { providerId: string; cam: LiveCamFavoriteInput; favorite: boolean; revision: string; state: "pending" | "sent" | "local" | "failed"; error?: string };

export class Database {
  readonly sqlite: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path.join(dataDir, "easyx.sqlite"));
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close() { this.sqlite.close(); }

  private migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id TEXT PRIMARY KEY, installed INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS performers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, aliases_json TEXT NOT NULL DEFAULT '[]',
        image_url TEXT, external_refs_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS performers_name_unique ON performers(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, performer_id TEXT NOT NULL REFERENCES performers(id) ON DELETE CASCADE,
        plugin_id TEXT NOT NULL, external_id TEXT NOT NULL, label TEXT NOT NULL, profile_url TEXT NOT NULL,
        domain TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, auto_download INTEGER NOT NULL DEFAULT 0,
        scraper_plugin_id TEXT, scrape_enabled INTEGER NOT NULL DEFAULT 0,
        sync_interval_minutes INTEGER NOT NULL DEFAULT 360, sync_interval_seconds INTEGER NOT NULL DEFAULT 21600,
        last_synced_at TEXT, next_sync_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(performer_id, plugin_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, performer_id TEXT NOT NULL REFERENCES performers(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, plugin_id TEXT NOT NULL,
        external_id TEXT NOT NULL, identity_key TEXT, title TEXT, page_url TEXT, media_type TEXT NOT NULL,
        filename TEXT, quality_score REAL NOT NULL DEFAULT 0, expected_bytes INTEGER, published_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'available', progress REAL NOT NULL DEFAULT 0, downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        checksum_sha256 TEXT, visual_hash TEXT, storage_path TEXT, error TEXT, duplicate_of TEXT,
        download_started_at TEXT, download_finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(source_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS items_status_idx ON items(status, updated_at);
      CREATE INDEX IF NOT EXISTS items_identity_idx ON items(identity_key, quality_score DESC);
      CREATE INDEX IF NOT EXISTS items_checksum_idx ON items(checksum_sha256);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_cam_favorites (
        provider_id TEXT NOT NULL, username_key TEXT NOT NULL, cam_id TEXT NOT NULL, username TEXT NOT NULL,
        title TEXT, page_url TEXT NOT NULL, thumbnail_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(provider_id, username_key)
      );
      CREATE TABLE IF NOT EXISTS live_cam_favorite_changes (
        provider_id TEXT NOT NULL, username_key TEXT NOT NULL, cam_json TEXT NOT NULL,
        favorite INTEGER NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT,
        PRIMARY KEY(provider_id, username_key)
      );
    `);
    const sourceColumns = new Set((this.sqlite.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!sourceColumns.has("scraper_plugin_id")) this.sqlite.exec("ALTER TABLE sources ADD COLUMN scraper_plugin_id TEXT");
    if (!sourceColumns.has("scrape_enabled")) this.sqlite.exec("ALTER TABLE sources ADD COLUMN scrape_enabled INTEGER NOT NULL DEFAULT 0");
    if (!sourceColumns.has("sync_interval_seconds")) {
      this.sqlite.exec("ALTER TABLE sources ADD COLUMN sync_interval_seconds INTEGER NOT NULL DEFAULT 21600");
      this.sqlite.exec("UPDATE sources SET sync_interval_seconds=sync_interval_minutes*60");
    }
    const itemColumns = new Set((this.sqlite.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!itemColumns.has("visual_hash")) this.sqlite.exec("ALTER TABLE items ADD COLUMN visual_hash TEXT");
    if (!itemColumns.has("download_started_at")) this.sqlite.exec("ALTER TABLE items ADD COLUMN download_started_at TEXT");
    if (!itemColumns.has("download_finished_at")) this.sqlite.exec("ALTER TABLE items ADD COLUMN download_finished_at TEXT");
    if (!itemColumns.has("downloaded_bytes")) this.sqlite.exec("ALTER TABLE items ADD COLUMN downloaded_bytes INTEGER NOT NULL DEFAULT 0");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS items_visual_hash_idx ON items(performer_id,media_type,visual_hash)");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS items_storage_path_idx ON items(storage_path)");
    this.migrateNitterToPublicX();
    this.setDefault("retentionDays", 0);
    this.setDefault("maxConcurrentDownloads", 2);
    this.setDefault("autoQueueDiscovered", true);
    this.setDefault("defaultScrapeIntervalMinutes", 360);
    this.setDefault("defaultLiveIntervalSeconds", 10);
    for (const [key, value] of Object.entries(outputDefaults)) this.setDefault(key, value);
  }

  private migrateNitterToPublicX() {
    const legacyId = "org.easyx.nitter-rss"; const publicId = "org.easyx.x";
    const legacy = this.sqlite.prepare("SELECT * FROM plugin_state WHERE plugin_id=?").get(legacyId) as any;
    if (legacy) {
      const current = this.sqlite.prepare("SELECT * FROM plugin_state WHERE plugin_id=?").get(publicId) as any;
      const legacyConfig = asJson<Record<string, unknown>>(legacy.config_json, {});
      const currentConfig = asJson<Record<string, unknown>>(current?.config_json, {});
      const migratedConfig = {
        ...Object.fromEntries(["maxItems", "includeImages", "includeVideos"].flatMap((key) => legacyConfig[key] === undefined ? [] : [[key, legacyConfig[key]]])),
        ...currentConfig,
      };
      this.sqlite.prepare(`INSERT INTO plugin_state(plugin_id,installed,enabled,config_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(plugin_id) DO UPDATE SET installed=excluded.installed,enabled=excluded.enabled,config_json=excluded.config_json,updated_at=excluded.updated_at`)
        .run(publicId, current?.installed || legacy.installed ? 1 : 0, current?.enabled || legacy.enabled ? 1 : 0, JSON.stringify(migratedConfig), now());
      this.sqlite.prepare("DELETE FROM plugin_state WHERE plugin_id=?").run(legacyId);
    }
    this.sqlite.prepare("UPDATE sources SET scraper_plugin_id=? WHERE scraper_plugin_id=?").run(publicId, legacyId);
    this.sqlite.prepare("UPDATE items SET plugin_id=? WHERE plugin_id=?").run(publicId, legacyId);
  }

  private setDefault(key: string, value: unknown) {
    this.sqlite.prepare("INSERT OR IGNORE INTO settings(key,value_json,updated_at) VALUES(?,?,?)")
      .run(key, JSON.stringify(value), now());
  }

  getSettings(): Record<string, unknown> {
    return Object.fromEntries((this.sqlite.prepare("SELECT * FROM settings").all() as any[])
      .map((row) => [row.key, asJson(row.value_json, null)]));
  }

  storedMediaMetadata(relativePath: string): Record<string, unknown> {
    const row = this.sqlite.prepare(`SELECT p.name AS performer,s.domain AS source,i.title FROM items i
      JOIN performers p ON p.id=i.performer_id JOIN sources s ON s.id=i.source_id
      WHERE i.storage_path=? AND i.status='completed' LIMIT 1`).get(relativePath) as { performer: string; source: string; title?: string } | undefined;
    return row ? { performer: row.performer, source: row.source, ...(row.title ? { title: row.title } : {}) } : {};
  }

  updateSettings(values: Record<string, unknown>) {
    const stmt = this.sqlite.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at");
    for (const [key, value] of Object.entries(values)) stmt.run(key, JSON.stringify(value), now());
    return this.getSettings();
  }

  listLiveCamFavorites(providerId?: string): LiveCamFavorite[] {
    const rows = providerId
      ? this.sqlite.prepare("SELECT * FROM live_cam_favorites WHERE provider_id=? ORDER BY username COLLATE NOCASE").all(providerId)
      : this.sqlite.prepare("SELECT * FROM live_cam_favorites ORDER BY username COLLATE NOCASE").all();
    return (rows as any[]).map(this.mapLiveCamFavorite);
  }

  isLiveCamFavorite(providerId: string, username: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 FROM live_cam_favorites WHERE provider_id=? AND username_key=?").get(providerId, username.trim().toLowerCase()));
  }

  setLiveCamFavorite(providerId: string, cam: LiveCamFavoriteInput, favorite: boolean): LiveCamFavorite | undefined {
    const usernameKey = cam.username.trim().toLowerCase();
    if (!favorite) {
      this.sqlite.prepare("DELETE FROM live_cam_favorites WHERE provider_id=? AND username_key=?").run(providerId, usernameKey);
      return undefined;
    }
    const stamp = now();
    this.sqlite.prepare(`INSERT INTO live_cam_favorites(provider_id,username_key,cam_id,username,title,page_url,thumbnail_url,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,username_key) DO UPDATE SET
      cam_id=excluded.cam_id,username=excluded.username,title=excluded.title,page_url=excluded.page_url,
      thumbnail_url=COALESCE(excluded.thumbnail_url,live_cam_favorites.thumbnail_url),updated_at=excluded.updated_at`)
      .run(providerId, usernameKey, cam.camId, cam.username, cam.title ?? null, cam.pageUrl, cam.thumbnailUrl ?? null, stamp, stamp);
    const row = this.sqlite.prepare("SELECT * FROM live_cam_favorites WHERE provider_id=? AND username_key=?").get(providerId, usernameKey) as any;
    return row ? this.mapLiveCamFavorite(row) : undefined;
  }

  saveLiveCamFavoriteChange(providerId: string, cam: LiveCamFavoriteInput, favorite: boolean) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const item = this.setLiveCamFavorite(providerId, cam, favorite);
      this.sqlite.prepare(`INSERT INTO live_cam_favorite_changes(provider_id,username_key,cam_json,favorite,revision,state)
        VALUES(?,?,?,?,?,'pending') ON CONFLICT(provider_id,username_key) DO UPDATE SET
        cam_json=excluded.cam_json,favorite=excluded.favorite,revision=excluded.revision,state='pending',error=NULL`)
        .run(providerId, cam.username.toLowerCase(), JSON.stringify(cam), favorite ? 1 : 0, id("favorite"));
      this.sqlite.exec("COMMIT"); return item;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }

  listLiveCamFavoriteChanges(providerId?: string): LiveCamFavoriteChange[] {
    const rows = providerId ? this.sqlite.prepare("SELECT * FROM live_cam_favorite_changes WHERE provider_id=?").all(providerId)
      : this.sqlite.prepare("SELECT * FROM live_cam_favorite_changes").all();
    return (rows as any[]).map((row) => ({ providerId: row.provider_id, cam: asJson<LiveCamFavoriteInput>(row.cam_json, { camId: "", username: "", pageUrl: "" }), favorite: !!row.favorite, revision: row.revision, state: row.state, ...(row.error ? { error: row.error } : {}) }));
  }

  updateLiveCamFavoriteChange(revision: string, state: LiveCamFavoriteChange["state"], error?: string) {
    this.sqlite.prepare("UPDATE live_cam_favorite_changes SET state=?,error=? WHERE revision=?").run(state, error ?? null, revision);
  }

  confirmLiveCamFavoriteChange(revision: string) {
    this.sqlite.prepare("DELETE FROM live_cam_favorite_changes WHERE revision=?").run(revision);
  }

  getPluginState(pluginId: string) {
    const row = this.sqlite.prepare("SELECT * FROM plugin_state WHERE plugin_id=?").get(pluginId) as any;
    return row ? { installed: !!row.installed, enabled: !!row.enabled, config: asJson<Record<string, unknown>>(row.config_json, {}) } : { installed: false, enabled: false, config: {} };
  }

  setPluginState(pluginId: string, patch: { installed?: boolean; enabled?: boolean; config?: Record<string, unknown> }) {
    const old = this.getPluginState(pluginId);
    const next = { ...old, ...patch };
    this.sqlite.prepare(`INSERT INTO plugin_state(plugin_id,installed,enabled,config_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(plugin_id) DO UPDATE SET installed=excluded.installed, enabled=excluded.enabled, config_json=excluded.config_json, updated_at=excluded.updated_at`)
      .run(pluginId, next.installed ? 1 : 0, next.enabled ? 1 : 0, JSON.stringify(next.config), now());
    return next;
  }

  listPerformers(): Performer[] {
    return (this.sqlite.prepare("SELECT * FROM performers ORDER BY name").all() as any[]).map(this.mapPerformer);
  }

  getPerformer(performerId: string): Performer | undefined {
    const row = this.sqlite.prepare("SELECT * FROM performers WHERE id=?").get(performerId) as any;
    return row ? this.mapPerformer(row) : undefined;
  }

  getPerformerByName(name: string): Performer | undefined {
    const row = this.sqlite.prepare("SELECT * FROM performers WHERE name=? COLLATE NOCASE").get(name) as any;
    return row ? this.mapPerformer(row) : undefined;
  }

  createPerformer(values: PerformerInput): Performer {
    const performerId = id("person"); const stamp = now();
    this.sqlite.prepare("INSERT INTO performers VALUES(?,?,?,?,?,?,?)")
      .run(performerId, values.name, JSON.stringify(values.aliases ?? []), values.imageUrl ?? null, "{}", stamp, stamp);
    return this.getPerformer(performerId)!;
  }

  updatePerformer(performerId: string, values: PerformerInput): Performer | undefined {
    const performer = this.getPerformer(performerId);
    if (!performer) return undefined;
    this.sqlite.prepare("UPDATE performers SET name=?,aliases_json=?,image_url=?,updated_at=? WHERE id=?")
      .run(values.name, JSON.stringify(values.aliases ?? []), values.imageUrl ?? null, now(), performerId);
    return this.getPerformer(performerId);
  }

  deletePerformer(performerId: string): boolean {
    return this.sqlite.prepare("DELETE FROM performers WHERE id=?").run(performerId).changes > 0;
  }

  upsertPerformer(candidate: PersonCandidate, pluginId: string, targetPerformerId?: string): Performer {
    const existing = (targetPerformerId
      ? this.sqlite.prepare("SELECT * FROM performers WHERE id=?").get(targetPerformerId)
      : this.sqlite.prepare("SELECT * FROM performers WHERE name=? COLLATE NOCASE").get(candidate.name)) as any;
    const stamp = now();
    if (existing) {
      const aliases = [...new Set([...asJson<string[]>(existing.aliases_json, []), ...(candidate.aliases ?? [])])];
      const refs = { ...asJson<Record<string, string>>(existing.external_refs_json, {}), [pluginId]: candidate.externalId };
      this.sqlite.prepare("UPDATE performers SET aliases_json=?, image_url=COALESCE(?,image_url), external_refs_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(aliases), candidate.imageUrl ?? null, JSON.stringify(refs), stamp, existing.id);
      return this.getPerformer(existing.id)!;
    }
    const performerId = id("person");
    this.sqlite.prepare("INSERT INTO performers VALUES(?,?,?,?,?,?,?)")
      .run(performerId, candidate.name, JSON.stringify(candidate.aliases ?? []), candidate.imageUrl ?? null, JSON.stringify({ [pluginId]: candidate.externalId }), stamp, stamp);
    return this.getPerformer(performerId)!;
  }

  private mapPerformer(row: any): Performer {
    return { id: row.id, name: row.name, aliases: asJson(row.aliases_json, []), imageUrl: row.image_url ?? undefined,
      externalRefs: asJson(row.external_refs_json, {}), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  addSource(performerId: string, pluginId: string, candidate: SourceCandidate): Source {
    const sourceId = id("source"); const stamp = now();
    this.sqlite.prepare(`INSERT INTO sources(id,performer_id,plugin_id,external_id,label,profile_url,domain,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(performer_id,plugin_id,external_id) DO UPDATE SET label=excluded.label,profile_url=excluded.profile_url,domain=excluded.domain,updated_at=excluded.updated_at`)
      .run(sourceId, performerId, pluginId, candidate.externalId, candidate.label, candidate.profileUrl, candidate.domain, stamp, stamp);
    const row = this.sqlite.prepare("SELECT * FROM sources WHERE performer_id=? AND plugin_id=? AND external_id=?").get(performerId, pluginId, candidate.externalId) as any;
    return this.mapSource(row);
  }

  listSources(performerId?: string): Source[] {
    const rows = performerId
      ? this.sqlite.prepare("SELECT * FROM sources WHERE performer_id=? ORDER BY domain").all(performerId)
      : this.sqlite.prepare("SELECT * FROM sources ORDER BY updated_at DESC").all();
    return (rows as any[]).map(this.mapSource);
  }

  getSource(sourceId: string): Source | undefined {
    const row = this.sqlite.prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as any;
    return row ? this.mapSource(row) : undefined;
  }

  updateSource(sourceId: string, values: Partial<Pick<Source, "pluginId" | "label" | "profileUrl" | "domain" | "enabled" | "autoDownload" | "scrapeEnabled" | "syncIntervalSeconds">> & { scraperPluginId?: string | null }) {
    const source = this.getSource(sourceId); if (!source) return undefined;
    this.sqlite.prepare("UPDATE sources SET plugin_id=?,label=?,profile_url=?,domain=?,enabled=?,auto_download=?,scraper_plugin_id=?,scrape_enabled=?,sync_interval_seconds=?,sync_interval_minutes=?,updated_at=? WHERE id=?")
      .run(values.pluginId ?? source.pluginId, values.label ?? source.label, values.profileUrl ?? source.profileUrl, values.domain ?? source.domain,
        (values.enabled ?? source.enabled) ? 1 : 0, (values.autoDownload ?? source.autoDownload) ? 1 : 0,
        values.scraperPluginId === undefined ? source.scraperPluginId ?? null : values.scraperPluginId,
        (values.scrapeEnabled ?? source.scrapeEnabled) ? 1 : 0, values.syncIntervalSeconds ?? source.syncIntervalSeconds,
        Math.max(1, Math.round((values.syncIntervalSeconds ?? source.syncIntervalSeconds) / 60)), now(), sourceId);
    return this.getSource(sourceId);
  }

  deleteSource(sourceId: string): boolean {
    return this.sqlite.prepare("DELETE FROM sources WHERE id=?").run(sourceId).changes > 0;
  }

  resetSourceSchedule(sourceId: string): Source | undefined {
    this.sqlite.prepare("UPDATE sources SET next_sync_at=NULL,last_error=NULL,updated_at=? WHERE id=?").run(now(), sourceId);
    return this.getSource(sourceId);
  }

  markSourceSynced(sourceId: string, intervalSeconds: number, error?: string) {
    const stamp = now(); const next = new Date(Date.now() + intervalSeconds * 1000).toISOString();
    this.sqlite.prepare("UPDATE sources SET last_synced_at=?,next_sync_at=?,last_error=?,updated_at=? WHERE id=?").run(stamp, next, error ?? null, stamp, sourceId);
  }

  dueSources(): Source[] {
    return (this.sqlite.prepare("SELECT * FROM sources WHERE enabled=1 AND scrape_enabled=1 AND scraper_plugin_id IS NOT NULL AND (next_sync_at IS NULL OR next_sync_at<=?) ORDER BY COALESCE(next_sync_at,'') LIMIT 100").all(now()) as any[]).map(this.mapSource);
  }

  private mapSource(row: any): Source {
    return { id: row.id, performerId: row.performer_id, pluginId: row.plugin_id, externalId: row.external_id,
      label: row.label, profileUrl: row.profile_url, domain: row.domain, enabled: !!row.enabled, autoDownload: !!row.auto_download,
      scraperPluginId: row.scraper_plugin_id ?? undefined, scrapeEnabled: !!row.scrape_enabled,
      syncIntervalSeconds: row.sync_interval_seconds ?? row.sync_interval_minutes * 60, lastSyncedAt: row.last_synced_at ?? undefined, nextSyncAt: row.next_sync_at ?? undefined, lastError: row.last_error ?? undefined };
  }

  ingestItems(source: Source, candidates: MediaCandidate[], onStoredDateChange?: (itemId: string, publishedAt: string) => void): { added: number; upgraded: number; skipped: number } {
    let added = 0, upgraded = 0, skipped = 0; const autoGlobal = !!this.getSettings().autoQueueDiscovered;
    for (const candidate of candidates) {
      let canonicalDate = validMediaDate(candidate.publishedAt);
      const existing = this.sqlite.prepare("SELECT id,published_at,status,storage_path FROM items WHERE source_id=? AND external_id=?").get(source.id, candidate.externalId) as any;
      if (existing) {
        canonicalDate = oldestMediaDate(existing.published_at, canonicalDate);
        if (canonicalDate && canonicalDate !== existing.published_at) {
          this.sqlite.prepare("UPDATE items SET published_at=?,updated_at=? WHERE id=?").run(canonicalDate, now(), existing.id);
          if (existing.status === "completed" && existing.storage_path) onStoredDateChange?.(existing.id, canonicalDate);
        }
        skipped++; continue;
      }
      if (candidate.identityKey) {
        const deleted = this.sqlite.prepare("SELECT id FROM items WHERE performer_id=? AND identity_key=? AND status='deleted' LIMIT 1").get(source.performerId, candidate.identityKey);
        if (deleted) { skipped++; continue; }
        const best = this.sqlite.prepare("SELECT id,quality_score,status,published_at,storage_path FROM items WHERE performer_id=? AND identity_key=? AND status NOT IN ('failed','superseded') ORDER BY quality_score DESC LIMIT 1").get(source.performerId, candidate.identityKey) as any;
        canonicalDate = oldestMediaDate(best?.published_at, canonicalDate);
        if (best && Number(best.quality_score) >= (candidate.qualityScore ?? 0)) {
          if (canonicalDate && canonicalDate !== best.published_at) {
            this.sqlite.prepare("UPDATE items SET published_at=?,updated_at=? WHERE id=?").run(canonicalDate, now(), best.id);
            if (best.status === "completed" && best.storage_path) onStoredDateChange?.(best.id, canonicalDate);
          }
          skipped++; continue;
        }
        if (best) {
          if (!["completed", "downloading"].includes(best.status)) this.sqlite.prepare("UPDATE items SET status='superseded',updated_at=? WHERE id=?").run(now(), best.id);
          upgraded++;
        }
      }
      const stamp = now();
      this.sqlite.prepare(`INSERT INTO items(id,performer_id,source_id,plugin_id,external_id,identity_key,title,page_url,media_type,filename,quality_score,expected_bytes,published_at,metadata_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id("item"), source.performerId, source.id, source.scraperPluginId ?? source.pluginId, candidate.externalId, candidate.identityKey ?? null,
          candidate.title ?? null, candidate.pageUrl ?? null, candidate.mediaType, candidate.filename ?? null, candidate.qualityScore ?? 0,
          candidate.expectedBytes ?? null, canonicalDate ?? null, JSON.stringify(candidate.metadata ?? {}), (source.autoDownload || autoGlobal) ? "queued" : "available", stamp, stamp);
      added++;
    }
    return { added, upgraded, skipped };
  }

  listItems(limit = 100): DownloadItem[] {
    return (this.sqlite.prepare("SELECT * FROM items ORDER BY updated_at DESC LIMIT ?").all(limit) as any[]).map(this.mapItem);
  }

  listItemsPage(options: ItemPageOptions = {}): ItemPage {
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 50)));
    const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const categoryStatuses: Record<ItemCategory, string[]> = {
      active: ["queued", "downloading", "paused", "stopping", "cancelling"], ready: ["available"], downloaded: ["completed"],
      errors: ["failed"], other: ["cancelled", "duplicate", "superseded", "deleted"],
    };
    if (options.category) {
      const statuses = categoryStatuses[options.category];
      clauses.push(`i.status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    if (options.status) { clauses.push("i.status=?"); parameters.push(options.status); }
    if (options.mediaType) { clauses.push("i.media_type=?"); parameters.push(options.mediaType); }
    if (options.sourceId) { clauses.push("i.source_id=?"); parameters.push(options.sourceId); }
    if (options.sourceDomain) { clauses.push("lower(s.domain)=?"); parameters.push(options.sourceDomain.trim().toLowerCase()); }
    if (options.performerId) { clauses.push("i.performer_id=?"); parameters.push(options.performerId); }
    const search = options.search?.trim().toLowerCase();
    if (search) {
      clauses.push("(lower(i.id) LIKE ? OR lower(COALESCE(i.title,'')) LIKE ? OR lower(i.external_id) LIKE ? OR lower(p.name) LIKE ? OR lower(s.label) LIKE ? OR lower(s.domain) LIKE ?)");
      parameters.push(...Array(6).fill(`%${search}%`));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const joins = "FROM items i JOIN performers p ON p.id=i.performer_id JOIN sources s ON s.id=i.source_id";
    const total = Number((this.sqlite.prepare(`SELECT count(*) value ${joins} ${where}`).get(...parameters) as { value: number }).value);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = this.sqlite.prepare(`SELECT i.* ${joins} ${where}
      ORDER BY CASE i.status WHEN 'downloading' THEN 0 WHEN 'queued' THEN 1 WHEN 'available' THEN 2 WHEN 'failed' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END,
      i.updated_at DESC LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize) as any[];
    const statusCounts = Object.fromEntries((this.sqlite.prepare("SELECT status,count(*) count FROM items GROUP BY status").all() as Array<{ status: string; count: number }>)
      .map((row) => [row.status, Number(row.count)]));
    const mediaTypes = (this.sqlite.prepare("SELECT DISTINCT media_type value FROM items ORDER BY media_type").all() as Array<{ value: string }>).map((row) => row.value);
    return { items: rows.map(this.mapItem), page, pageSize, total, totalPages, statusCounts, mediaTypes };
  }

  getItem(itemId: string): DownloadItem | undefined {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE id=?").get(itemId) as any;
    return row ? this.mapItem(row) : undefined;
  }

  getItemBySourceExternalId(sourceId: string, externalId: string): DownloadItem | undefined {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE source_id=? AND external_id=?").get(sourceId, externalId) as any;
    return row ? this.mapItem(row) : undefined;
  }

  markStoredItemDeleted(relativePath: string): DownloadItem | undefined {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const row = this.sqlite.prepare("SELECT id FROM items WHERE replace(storage_path,'\\','/')=? AND status='completed' ORDER BY updated_at DESC LIMIT 1").get(normalized) as { id: string } | undefined;
    if (!row) return undefined;
    this.sqlite.prepare("UPDATE items SET status='deleted',progress=1,error=NULL,updated_at=? WHERE id=?").run(now(), row.id);
    return this.getItem(row.id);
  }

  nextQueued(): DownloadItem | undefined {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE status='queued' ORDER BY created_at LIMIT 1").get() as any;
    return row ? this.mapItem(row) : undefined;
  }

  requeueInterruptedDownloads() {
    const stamp = now();
    const queued = this.sqlite.prepare("UPDATE items SET status='queued',progress=0,downloaded_bytes=0,error=NULL,download_started_at=NULL,download_finished_at=NULL,updated_at=? WHERE status='downloading'").run(stamp);
    const cancelled = this.sqlite.prepare("UPDATE items SET status='cancelled',error=NULL,download_finished_at=?,updated_at=? WHERE status IN ('stopping','cancelling')").run(stamp, stamp);
    return Number(queued.changes) + Number(cancelled.changes);
  }

  retryFailedItems() {
    const result = this.sqlite.prepare("UPDATE items SET status='queued',progress=0,downloaded_bytes=0,error=NULL,download_started_at=NULL,download_finished_at=NULL,updated_at=? WHERE status='failed'").run(now());
    return Number(result.changes);
  }

  setItemStatus(itemId: string, status: string, values: { progress?: number; downloadedBytes?: number; error?: string | null; checksum?: string; storagePath?: string; duplicateOf?: string } = {}) {
    const stamp = now();
    this.sqlite.prepare(`UPDATE items SET status=?,progress=COALESCE(?,progress),downloaded_bytes=CASE WHEN ?='queued' THEN 0 ELSE COALESCE(?,downloaded_bytes) END,error=?,checksum_sha256=COALESCE(?,checksum_sha256),storage_path=COALESCE(?,storage_path),duplicate_of=COALESCE(?,duplicate_of),
      download_started_at=CASE WHEN ?='queued' THEN NULL WHEN ?='downloading' AND download_started_at IS NULL THEN ? ELSE download_started_at END,
      download_finished_at=CASE WHEN ? IN ('queued','downloading','paused','stopping','cancelling') THEN NULL WHEN ? IN ('completed','duplicate','failed','cancelled','deleted') THEN ? ELSE download_finished_at END,
      updated_at=? WHERE id=?`)
      .run(status, values.progress ?? null, status, values.downloadedBytes ?? null, values.error ?? null, values.checksum ?? null, values.storagePath ?? null, values.duplicateOf ?? null,
        status, status, stamp, status, status, stamp, stamp, itemId);
    return this.getItem(itemId);
  }

  findByChecksum(checksum: string, exceptId: string, performerId: string): DownloadItem | undefined {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE checksum_sha256=? AND id<>? AND performer_id=? AND status='completed' ORDER BY quality_score DESC LIMIT 1").get(checksum, exceptId, performerId) as any;
    return row ? this.mapItem(row) : undefined;
  }

  findByIdentity(identityKey: string, exceptId: string, performerId: string): DownloadItem | undefined {
    const row = this.sqlite.prepare("SELECT * FROM items WHERE identity_key=? AND id<>? AND performer_id=? AND status='completed' ORDER BY quality_score DESC LIMIT 1").get(identityKey, exceptId, performerId) as any;
    return row ? this.mapItem(row) : undefined;
  }

  findVisualDuplicate(visualHash: string, exceptId: string, performerId: string, mediaType: string, maximumDistance = 5): DownloadItem | undefined {
    const candidates = (this.sqlite.prepare("SELECT * FROM items WHERE performer_id=? AND media_type=? AND visual_hash IS NOT NULL AND id<>? AND status='completed'").all(performerId, mediaType, exceptId) as any[])
      .map((row) => ({ row, distance: hammingDistance(visualHash, String(row.visual_hash)) }))
      .filter((candidate) => candidate.distance <= maximumDistance)
      .sort((left, right) => left.distance - right.distance || Number(right.row.quality_score) - Number(left.row.quality_score));
    return candidates[0] ? this.mapItem(candidates[0].row) : undefined;
  }

  setDownloadFingerprint(itemId: string, visualHash: string | undefined, qualityScore: number) {
    this.sqlite.prepare("UPDATE items SET visual_hash=COALESCE(?,visual_hash),quality_score=MAX(quality_score,?),updated_at=? WHERE id=?")
      .run(visualHash ?? null, qualityScore, now(), itemId);
    return this.getItem(itemId);
  }

  setCanonicalMediaDate(itemId: string, publishedAt?: string) {
    const canonical = oldestMediaDate(this.getItem(itemId)?.publishedAt, publishedAt);
    if (canonical) this.sqlite.prepare("UPDATE items SET published_at=?,updated_at=? WHERE id=?").run(canonical, now(), itemId);
    return canonical;
  }

  supersedeDownload(itemId: string, betterItemId: string) {
    this.sqlite.prepare("UPDATE items SET status='superseded',duplicate_of=?,storage_path=NULL,updated_at=? WHERE id=?").run(betterItemId, now(), itemId);
  }

  deleteItem(itemId: string) {
    return Number(this.sqlite.prepare("DELETE FROM items WHERE id=?").run(itemId).changes) > 0;
  }

  stats() {
    const scalar = (sql: string) => Number((this.sqlite.prepare(sql).get() as any).value);
    return { performers: scalar("SELECT count(*) value FROM performers"), sources: scalar("SELECT count(*) value FROM sources"),
      available: scalar("SELECT count(*) value FROM items WHERE status='available'"), queued: scalar("SELECT count(*) value FROM items WHERE status IN ('queued','downloading','paused','stopping','cancelling')"),
      completed: scalar("SELECT count(*) value FROM items WHERE status='completed'"), bytes: scalar("SELECT COALESCE(sum(expected_bytes),0) value FROM items WHERE status='completed'") };
  }

  private mapItem(row: any): DownloadItem {
    return { id: row.id, performerId: row.performer_id, sourceId: row.source_id, pluginId: row.plugin_id, externalId: row.external_id,
      identityKey: row.identity_key ?? undefined, title: row.title ?? undefined, pageUrl: row.page_url ?? undefined, mediaType: row.media_type,
      filename: row.filename ?? undefined, qualityScore: row.quality_score, expectedBytes: row.expected_bytes ?? undefined, publishedAt: row.published_at ?? undefined,
      metadata: asJson(row.metadata_json, {}), status: row.status, progress: row.progress, downloadedBytes: Number(row.downloaded_bytes ?? 0), checksumSha256: row.checksum_sha256 ?? undefined, visualHash: row.visual_hash ?? undefined,
      storagePath: row.storage_path ?? undefined, error: row.error ?? undefined,
      downloadStartedAt: row.download_started_at ?? undefined, downloadFinishedAt: row.download_finished_at ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private mapLiveCamFavorite(row: any): LiveCamFavorite {
    return {
      providerId: row.provider_id, camId: row.cam_id, username: row.username, title: row.title ?? undefined,
      pageUrl: row.page_url, thumbnailUrl: row.thumbnail_url ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

function validMediaDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  const year = date.getUTCFullYear();
  return Number.isNaN(date.valueOf()) || year < 1900 || date.valueOf() > Date.now() + 86_400_000 ? undefined : date.toISOString();
}

function oldestMediaDate(...values: Array<string | undefined>): string | undefined {
  return values.map(validMediaDate).filter((value): value is string => Boolean(value)).sort()[0];
}

function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let value = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (value) { distance += value & 1; value >>>= 1; }
  }
  return distance;
}
