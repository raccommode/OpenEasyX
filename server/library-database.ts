import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isSubtitleLanguageCode, subtitleFilePath } from "./subtitles.js";

export type MediaKind = "video" | "image";

export type Media = {
  id: string;
  relativePath: string;
  kind: MediaKind;
  title: string;
  performer: string;
  source: string;
  extension: string;
  mimeType: string;
  size: number;
  modifiedAt: string;
  addedAt: string;
  mediaDate?: string;
  duration: number;
  width: number;
  height: number;
  favorite: boolean;
  progressSeconds: number;
  completed: boolean;
  viewCount: number;
  lastViewedAt?: string;
};

const trackTable = { subtitles: "subtitle_tracks", dubbing: "dubbing_outputs" };
const trackMatch = {
  subtitles: "t.media_id=m.id",
  dubbing: "t.media_id=m.id AND t.fingerprint=(m.size || ':' || m.modified_at)",
};

export type LibraryQuery = {
  q?: string;
  subtitles?: string;
  dubbing?: string;
  kind?: MediaKind | "";
  performer?: string;
  source?: string;
  favorite?: boolean;
  history?: boolean;
  watched?: "unseen" | "progress" | "unfinished" | "completed" | "";
  sort?: "recent" | "oldest" | "title" | "largest" | "most-viewed" | "history";
  page?: number;
  pageSize?: number;
};

export type SubtitleSettings = { enabled: boolean; languages: string[]; oldestFirst?: boolean };
export type DownloaderSettings = { host: string; port: number };
export const DEFAULT_DOWNLOADER_SETTINGS: DownloaderSettings = { host: "localhost", port: 3210 };
export type PerformerSummary = { name: string; count: number; videos: number; images: number; coverId: string };
export type SubtitleTrack = {
  id: string;
  mediaId: string;
  language: string;
  label: string;
  origin: "original" | "generated" | "manual";
  sourceLanguage: string;
  updatedAt: string;
};

type IndexedMedia = Omit<Media, "favorite" | "progressSeconds" | "completed" | "viewCount" | "lastViewedAt"> & {
  metadata: Record<string, unknown>;
  scanId: string;
};

type ReferenceRow = Pick<Media, "id" | "relativePath" | "modifiedAt" | "size">;

function performerKey(name: string) {
  return name.trim().normalize("NFC").toLowerCase();
}

function performerCredits(performer: string, metadata: Record<string, unknown>, resolve: (name: string) => string) {
  const names: string[] = [];
  for (const field of [metadata.cast, metadata.performers, metadata.performer]) {
    if (!Array.isArray(field)) continue;
    for (const member of field) {
      const name = typeof member === "string" ? member : member?.name;
      if (typeof name === "string" && name.trim()) names.push(name.trim());
    }
  }
  // An explicit cast takes precedence over an inferred folder name.
  if (!names.length || typeof metadata.performer === "string" && metadata.performer.trim()) names.push(performer);
  return [...new Set(names.map((name) => performerKey(resolve(name))))].filter((name) => name && name !== "unsorted" && name !== "unknown").sort();
}

export class LibraryDatabase {
  readonly sqlite: DatabaseSync;
  readonly databasePath: string;
  private closed = false;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.databasePath = path.resolve(dataDir, "open-easyx-library.sqlite");
    const legacyFile = path.join(dataDir, "easyx-viewer.sqlite");
    if (!fs.existsSync(this.databasePath) && fs.existsSync(legacyFile)) fs.copyFileSync(legacyFile, this.databasePath);
    this.sqlite = new DatabaseSync(this.databasePath);
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    if (fs.existsSync(legacyFile) && fs.existsSync(path.join(dataDir, "subtitles"))) this.recoverLegacySubtitleTracks(legacyFile, dataDir);
  }

  private recoverLegacySubtitleTracks(legacyFile: string, dataDir: string) {
    const marker = "recovered_legacy_subtitle_tracks_v1";
    if (this.sqlite.prepare("SELECT 1 FROM settings WHERE key=?").get(marker)) return;
    const legacyUrl = pathToFileURL(legacyFile);
    legacyUrl.searchParams.set("mode", "ro");
    // The former embedded worker continued to register tracks in the viewer database after the library was copied.
    try {
      this.sqlite.prepare("ATTACH DATABASE ? AS old_viewer").run(legacyUrl.href);
      try {
        this.sqlite.exec("SAVEPOINT recover_subtitles");
        try {
          const tables = this.sqlite.prepare("SELECT name FROM old_viewer.sqlite_schema WHERE type='table' AND name IN ('media','subtitle_tracks')").all();
          if (tables.length === 2) {
            const candidates = this.sqlite.prepare(`SELECT t.* FROM old_viewer.subtitle_tracks t
              JOIN old_viewer.media old ON old.id=t.media_id
              JOIN main.media m ON m.id=old.id AND m.relative_path=old.relative_path AND m.size=old.size AND m.modified_at=old.modified_at
              WHERE m.kind='video' AND t.origin IN ('original','generated')
              AND NOT EXISTS (SELECT 1 FROM main.subtitle_tracks s WHERE s.media_id=t.media_id AND s.id=t.id)
              AND NOT EXISTS (SELECT 1 FROM main.subtitle_jobs j WHERE j.media_id=t.media_id AND j.status IN ('complete','no_audio','no_speech')
                AND julianday(j.updated_at)>=julianday(t.updated_at))`).all();
            const insert = this.sqlite.prepare("INSERT OR IGNORE INTO main.subtitle_tracks(id,media_id,language,label,origin,source_language,updated_at) VALUES(?,?,?,?,?,?,?)");
            for (const track of candidates) {
              let file: string;
              try { file = subtitleFilePath(dataDir, String(track.media_id), String(track.id)); } catch { continue; }
              if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) insert.run(track.id, track.media_id, track.language, track.label, track.origin, track.source_language, track.updated_at);
            }
          }
          this.sqlite.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES(?, 'true', ?)").run(marker, new Date().toISOString());
          this.sqlite.exec("RELEASE recover_subtitles");
        } catch (error) {
          this.sqlite.exec("ROLLBACK TO recover_subtitles; RELEASE recover_subtitles");
          throw error;
        }
      } finally { this.sqlite.exec("DETACH DATABASE old_viewer"); }
    } catch (error) {
      console.warn("Could not recover subtitle tracks from the legacy viewer database", error);
    }
  }

  private migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('video','image')),
        title TEXT NOT NULL,
        performer TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        extension TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        added_at TEXT NOT NULL,
        duration REAL NOT NULL DEFAULT 0,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_seen_scan TEXT NOT NULL,
        missing INTEGER NOT NULL DEFAULT 0,
        playable INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS media_library_idx ON media(missing, kind, modified_at DESC);
      CREATE INDEX IF NOT EXISTS media_performer_idx ON media(missing, performer COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS playback (
        media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
        progress_seconds REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        view_count INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        last_counted_at TEXT,
        last_viewed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS video_dubs (
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT '',
        progress REAL NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        render_version TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(media_id, language)
      );
      CREATE TABLE IF NOT EXISTS dubbing_outputs (
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        provider TEXT NOT NULL,
        file_key TEXT NOT NULL,
        lip_sync_frames INTEGER,
        PRIMARY KEY(media_id, language)
      );
      CREATE TABLE IF NOT EXISTS subtitle_jobs (
        media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL DEFAULT '',
        requested_languages_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        phase TEXT NOT NULL DEFAULT 'detecting',
        target_language TEXT NOT NULL DEFAULT '',
        source_language TEXT NOT NULL DEFAULT '',
        source_language_probability REAL NOT NULL DEFAULT 0,
        progress REAL NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subtitle_jobs_status_idx ON subtitle_jobs(status, updated_at);
      CREATE TABLE IF NOT EXISTS subtitle_tracks (
        id TEXT NOT NULL,
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        label TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('original','generated','manual')),
        source_language TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(media_id,id)
      );
    `);
    const playbackColumns = new Set((this.sqlite.prepare("PRAGMA table_info(playback)").all() as Array<{ name: string }>).map((column) => column.name));
    const mediaColumns = new Set((this.sqlite.prepare("PRAGMA table_info(media)").all() as Array<{ name: string }>).map((column) => column.name));
    const subtitleColumns = new Set((this.sqlite.prepare("PRAGMA table_info(subtitle_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    const dubColumns = this.sqlite.prepare("PRAGMA table_info(video_dubs)").all();
    if (!dubColumns.some((column) => column.name === "render_version")) this.sqlite.exec("ALTER TABLE video_dubs ADD COLUMN render_version TEXT NOT NULL DEFAULT ''");
    this.sqlite.exec(`INSERT OR IGNORE INTO dubbing_outputs(media_id,language,fingerprint,provider,file_key)
      SELECT media_id,language,fingerprint,provider,'' FROM video_dubs WHERE status='ready'`);
    if (!subtitleColumns.has("phase")) this.sqlite.exec("ALTER TABLE subtitle_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'detecting'");
    if (!subtitleColumns.has("target_language")) this.sqlite.exec("ALTER TABLE subtitle_jobs ADD COLUMN target_language TEXT NOT NULL DEFAULT ''");
    if (!mediaColumns.has("playable")) this.sqlite.exec("ALTER TABLE media ADD COLUMN playable INTEGER NOT NULL DEFAULT 1");
    if (!mediaColumns.has("media_date")) this.sqlite.exec("ALTER TABLE media ADD COLUMN media_date TEXT");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS media_date_idx ON media(missing,kind,COALESCE(media_date,modified_at) DESC)");
    const needsCompletionBackfill = !playbackColumns.has("completed");
    if (needsCompletionBackfill) this.sqlite.exec("ALTER TABLE playback ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
    if (!playbackColumns.has("last_counted_at")) this.sqlite.exec("ALTER TABLE playback ADD COLUMN last_counted_at TEXT");
    if (needsCompletionBackfill) this.sqlite.exec("UPDATE playback SET completed=1 WHERE progress_seconds=0 AND view_count>0");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS playback_history_idx ON playback(last_viewed_at DESC)");
    if (!this.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='video_cast'").get()) {
      this.sqlite.exec("SAVEPOINT index_existing_cast");
      try {
        this.sqlite.exec(`CREATE TABLE video_cast (
          media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, performer_key TEXT NOT NULL,
          PRIMARY KEY(media_id,performer_key)
        ) WITHOUT ROWID;
        CREATE INDEX video_cast_performer_idx ON video_cast(performer_key,media_id)`);
        const rows = this.sqlite.prepare(`SELECT id,performer,CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END AS metadata
          FROM media WHERE kind='video'`).iterate();
        const insert = this.sqlite.prepare("INSERT INTO video_cast(media_id,performer_key) VALUES(?,?)");
        for (const row of rows) {
          const names = performerCredits(String(row.performer), JSON.parse(String(row.metadata)) ?? {}, (name) => name);
          for (const name of names) insert.run(row.id, name);
        }
        this.sqlite.exec("RELEASE index_existing_cast");
      } catch (error) {
        this.sqlite.exec("ROLLBACK TO index_existing_cast; RELEASE index_existing_cast");
        throw error;
      }
    }
  }

  close() {
    this.sqlite.close();
    this.closed = true;
  }

  mergePerformerNames(previousName: string, nextName: string) {
    this.sqlite.exec("SAVEPOINT merge_library_cast");
    try {
      this.sqlite.prepare("UPDATE media SET performer=? WHERE performer=? COLLATE NOCASE").run(nextName, previousName);
      const oldKey = performerKey(previousName);
      const newKey = performerKey(nextName);
      if (oldKey !== newKey) {
        this.sqlite.prepare("INSERT OR IGNORE INTO video_cast SELECT media_id,? FROM video_cast WHERE performer_key=?").run(newKey, oldKey);
        this.sqlite.prepare("DELETE FROM video_cast WHERE performer_key=?").run(oldKey);
      }
      this.sqlite.exec("RELEASE merge_library_cast");
    } catch (error) {
      this.sqlite.exec("ROLLBACK TO merge_library_cast; RELEASE merge_library_cast");
      throw error;
    }
  }

  upsertMedia(item: IndexedMedia, resolve: (name: string) => string = (name) => name) {
    this.sqlite.exec("SAVEPOINT index_library_media");
    try {
      const changed = this.writeMedia(item);
      // An old sidecar can still name a merged performer after the media itself stopped changing.
      const hasCast = [item.metadata.cast, item.metadata.performers, item.metadata.performer].some(Array.isArray);
      if (changed || hasCast) {
        const names = item.kind === "video" ? performerCredits(item.performer, item.metadata, resolve) : [];
        const existing = this.sqlite.prepare("SELECT performer_key FROM video_cast WHERE media_id=? ORDER BY performer_key").all(item.id);
        if (existing.length !== names.length || existing.some((row, i) => row.performer_key !== names[i])) {
          this.sqlite.prepare("DELETE FROM video_cast WHERE media_id=?").run(item.id);
          const insert = this.sqlite.prepare("INSERT INTO video_cast(media_id,performer_key) VALUES(?,?)");
          for (const name of names) insert.run(item.id, name);
        }
      }
      this.sqlite.exec("RELEASE index_library_media");
      return changed;
    } catch (error) {
      this.sqlite.exec("ROLLBACK TO index_library_media; RELEASE index_library_media");
      throw error;
    }
  }

  private writeMedia(item: IndexedMedia) {
    const result = this.sqlite.prepare(`
      INSERT INTO media(
        id,relative_path,kind,title,performer,source,extension,mime_type,size,modified_at,
        added_at,duration,width,height,metadata_json,last_seen_scan,media_date,missing
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(relative_path) DO UPDATE SET
        kind=excluded.kind,title=excluded.title,performer=excluded.performer,source=excluded.source,
        extension=excluded.extension,mime_type=excluded.mime_type,size=excluded.size,
        modified_at=excluded.modified_at,media_date=excluded.media_date,metadata_json=excluded.metadata_json,
        added_at=CASE WHEN julianday(media.added_at)>julianday('1970-01-01') THEN media.added_at ELSE excluded.added_at END,
        last_seen_scan=excluded.last_seen_scan,missing=0,
        playable=CASE WHEN media.size<>excluded.size OR media.modified_at<>excluded.modified_at THEN 1 ELSE media.playable END
      WHERE media.kind IS NOT excluded.kind OR media.title IS NOT excluded.title
        OR media.performer IS NOT excluded.performer OR media.source IS NOT excluded.source
        OR media.extension IS NOT excluded.extension OR media.mime_type IS NOT excluded.mime_type
        OR media.size IS NOT excluded.size OR media.modified_at IS NOT excluded.modified_at
        OR media.media_date IS NOT excluded.media_date OR media.metadata_json IS NOT excluded.metadata_json
        OR media.missing<>0
        OR (COALESCE(julianday(media.added_at),0)<=julianday('1970-01-01') AND media.added_at IS NOT excluded.added_at)
    `).run(
      item.id, item.relativePath, item.kind, item.title, item.performer, item.source,
      item.extension, item.mimeType, item.size, item.modifiedAt, item.addedAt,
      item.duration, item.width, item.height, JSON.stringify(item.metadata), item.scanId, item.mediaDate ?? item.modifiedAt,
    );
    return Number(result.changes) > 0;
  }

  finishScan(scanId: string, seenIds: ReadonlySet<string>) {
    // Presence is collected in memory so an unchanged scan does not rewrite every
    // catalog row. Targeted indexing during the scan also contributes to this set.
    const missing = (this.sqlite.prepare("SELECT id FROM media WHERE last_seen_scan<>? AND missing=0").all(scanId) as Array<{ id: string }>)
      .filter((row) => !seenIds.has(row.id));
    if (!missing.length) return;
    this.sqlite.exec("BEGIN");
    try {
      const mark = this.sqlite.prepare("UPDATE media SET missing=1 WHERE id=?");
      for (const row of missing) mark.run(row.id);
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }

  markMediaMissing(id: string) {
    return Number(this.sqlite.prepare("UPDATE media SET missing=1 WHERE id=? AND missing=0").run(id).changes) > 0;
  }

  markMediaUnplayable(id: string) {
    // Background thumbnail failures may arrive after shutdown closes SQLite.
    if (this.closed) return false;
    return Number(this.sqlite.prepare("UPDATE media SET playable=0 WHERE id=? AND playable=1").run(id).changes) > 0;
  }

  updateProbe(id: string, values: { duration?: number; width?: number; height?: number }) {
    this.sqlite.prepare(`UPDATE media SET duration=CASE WHEN ?>0 THEN ? ELSE duration END,
      width=CASE WHEN ?>0 THEN ? ELSE width END,height=CASE WHEN ?>0 THEN ? ELSE height END WHERE id=?`)
      .run(values.duration ?? 0, values.duration ?? 0, values.width ?? 0, values.width ?? 0, values.height ?? 0, values.height ?? 0, id);
  }

  private mapMedia(row: Record<string, unknown>): Media {
    return {
      id: String(row.id), relativePath: String(row.relative_path), kind: row.kind as MediaKind,
      title: String(row.title), performer: String(row.performer), source: String(row.source),
      extension: String(row.extension), mimeType: String(row.mime_type), size: Number(row.size),
      modifiedAt: String(row.modified_at), addedAt: String(row.added_at), mediaDate: row.media_date ? String(row.media_date) : undefined, duration: Number(row.effective_duration ?? row.duration),
      width: Number(row.width), height: Number(row.height), favorite: !!row.favorite,
      progressSeconds: Number(row.progress_seconds), completed: !!row.completed, viewCount: Number(row.view_count),
      lastViewedAt: row.last_viewed_at ? String(row.last_viewed_at) : undefined,
    };
  }

  getMedia(id: string): Media | undefined {
    const row = this.sqlite.prepare(`SELECT m.*,COALESCE(NULLIF(m.duration,0),p.duration,0) effective_duration,
      COALESCE(p.favorite,0) favorite,COALESCE(p.progress_seconds,0) progress_seconds,
      COALESCE(p.completed,0) completed,COALESCE(p.view_count,0) view_count,p.last_viewed_at
      FROM media m LEFT JOIN playback p ON p.media_id=m.id WHERE m.id=? AND m.missing=0 AND m.playable=1`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMedia(row) : undefined;
  }

  dubbingReferenceCandidates(id: string): ReferenceRow[] {
    const credits = this.sqlite.prepare("SELECT performer_key FROM video_cast WHERE media_id=? ORDER BY performer_key LIMIT 32").all(id);
    const videos = this.sqlite.prepare(`SELECT m.id,m.relative_path AS relativePath,m.size,m.modified_at AS modifiedAt
      FROM video_cast c JOIN media m ON m.id=c.media_id WHERE c.performer_key=? AND c.media_id<>?
      AND m.kind='video' AND m.missing=0 AND m.playable=1 AND m.size>0 ORDER BY c.media_id LIMIT 128`);
    const byPerformer = credits.map((row) => videos.all(row.performer_key, id) as ReferenceRow[]);
    // Interleave credits so a prolific co-star cannot use every reference slot.
    const candidates = new Map<string, ReferenceRow>();
    const length = Math.max(0, ...byPerformer.map((group) => group.length));
    for (let i = 0; i < length && candidates.size < 128; i++) {
      for (const group of byPerformer) {
        const item = group[i];
        if (item) candidates.set(item.id, item);
        if (candidates.size === 128) break;
      }
    }
    return [...candidates.values()];
  }

  private mediaQuery(query: LibraryQuery) {
    const where = ["m.missing=0", "m.playable=1"];
    const values: SQLInputValue[] = [];
    if (query.q?.trim()) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.performer LIKE ? ESCAPE '\\' OR m.source LIKE ? ESCAPE '\\')");
      const term = `%${query.q.trim().replace(/[\\%_]/g, "\\$&")}%`;
      values.push(term, term, term);
    }
    if (query.kind) { where.push("m.kind=?"); values.push(query.kind); }
    if (query.performer) { where.push("m.performer=? COLLATE NOCASE"); values.push(query.performer); }
    if (query.source) { where.push("m.source=? COLLATE NOCASE"); values.push(query.source); }
    if (query.favorite) where.push("COALESCE(p.favorite,0)=1");
    if (query.history) where.push("p.last_viewed_at IS NOT NULL");
    if (query.watched === "unseen") where.push("p.last_viewed_at IS NULL AND COALESCE(p.progress_seconds,0)=0 AND COALESCE(p.view_count,0)=0");
    if (query.watched === "progress") where.push("COALESCE(p.progress_seconds,0)>0 AND COALESCE(p.completed,0)=0");
    if (query.watched === "unfinished") where.push("COALESCE(p.completed,0)=0");
    if (query.watched === "completed") where.push("COALESCE(p.completed,0)=1");
    if (query.subtitles || query.dubbing) where.push("m.kind='video'");
    for (const type of ["subtitles", "dubbing"] as const) {
      const filter = query[type];
      if (!filter) continue;
      let match = trackMatch[type];
      if (filter !== "with" && filter !== "without") {
        match += " AND t.language=? COLLATE NOCASE";
        values.push(filter);
      }
      where.push(`${filter === "without" ? "NOT EXISTS" : "EXISTS"} (SELECT 1 FROM ${trackTable[type]} t WHERE ${match})`);
    }
    const order = {
      recent: "COALESCE(m.media_date,m.modified_at) DESC", oldest: "COALESCE(m.media_date,m.modified_at) ASC", title: "m.title COLLATE NOCASE ASC",
      largest: "m.size DESC", "most-viewed": "COALESCE(p.view_count,0) DESC,COALESCE(m.media_date,m.modified_at) DESC",
      history: "p.last_viewed_at DESC,COALESCE(m.media_date,m.modified_at) DESC",
    }[query.sort ?? "recent"];
    return { clause: where.join(" AND "), values, order };
  }

  listMedia(query: LibraryQuery = {}) {
    const { clause, values, order } = this.mediaQuery(query);
    const pageSize = Math.max(1, Math.min(100, query.pageSize ?? 48));
    const page = Math.max(1, query.page ?? 1);
    const total = Number((this.sqlite.prepare(`SELECT COUNT(*) count FROM media m LEFT JOIN playback p ON p.media_id=m.id WHERE ${clause}`).get(...values) as { count: number }).count);
    const rows = this.sqlite.prepare(`SELECT m.*,COALESCE(NULLIF(m.duration,0),p.duration,0) effective_duration,
      COALESCE(p.favorite,0) favorite,COALESCE(p.progress_seconds,0) progress_seconds,
      COALESCE(p.completed,0) completed,COALESCE(p.view_count,0) view_count,p.last_viewed_at
      FROM media m LEFT JOIN playback p ON p.media_id=m.id WHERE ${clause}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    return { items: rows.map((row) => this.mapMedia(row)), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  playlist(query: LibraryQuery = {}) {
    const { clause, values, order } = this.mediaQuery(query);
    return (this.sqlite.prepare(`SELECT m.id FROM media m LEFT JOIN playback p ON p.media_id=m.id
      WHERE ${clause} ORDER BY ${order}`).all(...values) as Array<{ id: string }>).map((row) => row.id);
  }

  setFavorite(id: string, favorite: boolean) {
    if (!this.getMedia(id)) return undefined;
    const stamp = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO playback(media_id,favorite,updated_at) VALUES(?,?,?)
      ON CONFLICT(media_id) DO UPDATE SET favorite=excluded.favorite,updated_at=excluded.updated_at`)
      .run(id, favorite ? 1 : 0, stamp);
    return this.getMedia(id);
  }

  updateProgress(id: string, position: number, duration: number, completed = false) {
    if (!this.getMedia(id)) return undefined;
    const stamp = new Date().toISOString();
    const safePosition = Math.max(0, position); const safeDuration = Math.max(0, duration);
    const isCompleted = completed || (safeDuration > 0 && safePosition / safeDuration >= 0.9);
    const countThreshold = safeDuration ? Math.min(30, Math.max(3, safeDuration * 0.1)) : 0;
    const previous = this.sqlite.prepare("SELECT last_counted_at FROM playback WHERE media_id=?").get(id) as { last_counted_at?: string } | undefined;
    const lastCounted = previous?.last_counted_at ? new Date(previous.last_counted_at).getTime() : 0;
    const shouldCount = (isCompleted || safePosition >= countThreshold) && (!lastCounted || Date.now() - lastCounted >= 30 * 60_000);
    this.sqlite.prepare(`INSERT INTO playback(media_id,progress_seconds,duration,view_count,favorite,completed,last_counted_at,last_viewed_at,updated_at)
      VALUES(?,?,?,?,0,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
      progress_seconds=excluded.progress_seconds,duration=excluded.duration,
      view_count=playback.view_count+?,completed=excluded.completed,
      last_counted_at=CASE WHEN ?=1 THEN excluded.last_counted_at ELSE playback.last_counted_at END,
      last_viewed_at=excluded.last_viewed_at,updated_at=excluded.updated_at`)
      .run(id, safePosition, safeDuration, shouldCount ? 1 : 0, isCompleted ? 1 : 0, shouldCount ? stamp : null, stamp, stamp,
        shouldCount ? 1 : 0, shouldCount ? 1 : 0);
    return this.getMedia(id);
  }

  stats() {
    const row = this.sqlite.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) videos,
      SUM(CASE WHEN kind='image' THEN 1 ELSE 0 END) images,
      COALESCE(SUM(size),0) bytes,
      COALESCE(SUM(CASE WHEN kind='video' THEN size ELSE 0 END),0) video_bytes,
      COALESCE(SUM(CASE WHEN kind='image' THEN size ELSE 0 END),0) image_bytes,
      SUM(CASE WHEN p.last_viewed_at IS NOT NULL OR COALESCE(p.view_count,0)>0 OR COALESCE(p.progress_seconds,0)>0 OR COALESCE(p.completed,0)=1 THEN 1 ELSE 0 END) viewed,
      SUM(CASE WHEN kind='video' AND (p.last_viewed_at IS NOT NULL OR COALESCE(p.view_count,0)>0 OR COALESCE(p.progress_seconds,0)>0 OR COALESCE(p.completed,0)=1) THEN 1 ELSE 0 END) viewed_videos,
      SUM(CASE WHEN kind='image' AND (p.last_viewed_at IS NOT NULL OR COALESCE(p.view_count,0)>0 OR COALESCE(p.completed,0)=1) THEN 1 ELSE 0 END) viewed_images,
      COALESCE(SUM(CASE WHEN kind='video' THEN COALESCE(NULLIF(m.duration,0),p.duration,0) ELSE 0 END),0) library_duration_seconds,
      COALESCE(SUM(CASE WHEN kind='video' AND COALESCE(p.completed,0)=1 THEN COALESCE(NULLIF(p.duration,0),m.duration,0)
        WHEN kind='video' THEN CASE
          WHEN COALESCE(NULLIF(p.duration,0),m.duration,0)>0 THEN MIN(COALESCE(p.progress_seconds,0),COALESCE(NULLIF(p.duration,0),m.duration,0))
          ELSE COALESCE(p.progress_seconds,0) END ELSE 0 END),0) watched_seconds,
      COALESCE(SUM(p.view_count),0) views
      FROM media m LEFT JOIN playback p ON p.media_id=m.id WHERE m.missing=0 AND m.playable=1`).get() as Record<string, number>;
    const performers = Number((this.sqlite.prepare("SELECT COUNT(DISTINCT performer) count FROM media WHERE missing=0 AND playable=1 AND performer<>''").get() as { count: number }).count);
    const favorites = Number((this.sqlite.prepare("SELECT COUNT(*) count FROM playback p JOIN media m ON m.id=p.media_id WHERE m.missing=0 AND m.playable=1 AND p.favorite=1").get() as { count: number }).count);
    const inProgress = Number((this.sqlite.prepare("SELECT COUNT(*) count FROM playback p JOIN media m ON m.id=p.media_id WHERE m.missing=0 AND m.playable=1 AND p.progress_seconds>0 AND p.completed=0").get() as { count: number }).count);
    const completed = Number((this.sqlite.prepare("SELECT COUNT(*) count FROM playback p JOIN media m ON m.id=p.media_id WHERE m.missing=0 AND m.playable=1 AND p.completed=1").get() as { count: number }).count);
    return {
      total: Number(row.total), videos: Number(row.videos), images: Number(row.images), bytes: Number(row.bytes),
      videoBytes: Number(row.video_bytes), imageBytes: Number(row.image_bytes), viewed: Number(row.viewed),
      viewedVideos: Number(row.viewed_videos), viewedImages: Number(row.viewed_images),
      libraryDurationSeconds: Number(row.library_duration_seconds), watchedSeconds: Number(row.watched_seconds),
      views: Number(row.views), performers, favorites, inProgress, completed,
    };
  }

  performers(): PerformerSummary[] {
    const rows = this.sqlite.prepare(`SELECT collection.performer name,COUNT(*) count,
      SUM(CASE WHEN collection.kind='video' THEN 1 ELSE 0 END) videos,
      SUM(CASE WHEN collection.kind='image' THEN 1 ELSE 0 END) images,
      (SELECT cover.id FROM media cover
        WHERE cover.missing=0 AND cover.playable=1 AND cover.performer=collection.performer COLLATE NOCASE
        ORDER BY CASE cover.kind WHEN 'image' THEN 0 ELSE 1 END,COALESCE(cover.media_date,cover.modified_at) DESC,cover.id ASC LIMIT 1) cover_id
      FROM media collection WHERE collection.missing=0 AND collection.playable=1 AND collection.performer<>''
      GROUP BY collection.performer COLLATE NOCASE ORDER BY collection.performer COLLATE NOCASE`).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      name: String(row.name), count: Number(row.count), videos: Number(row.videos), images: Number(row.images), coverId: String(row.cover_id),
    }));
  }

  trackLanguages(type: keyof typeof trackTable) {
    const rows = this.sqlite.prepare(`SELECT DISTINCT lower(t.language) language FROM ${trackTable[type]} t
      JOIN media m ON ${trackMatch[type]} WHERE m.kind='video' AND m.missing=0 AND m.playable=1
      ORDER BY language`).all() as Array<{ language: string }>;
    return rows.map((row) => row.language);
  }

  facets(query: Pick<LibraryQuery, "performer" | "watched" | "subtitles" | "dubbing"> = {}) {
    const performers = this.performers();
    const { clause, values } = this.mediaQuery(query);
    const sources = this.sqlite.prepare(`SELECT m.source name,COUNT(*) count FROM media m
      LEFT JOIN playback p ON p.media_id=m.id WHERE ${clause} AND m.source<>''
      GROUP BY m.source COLLATE NOCASE ORDER BY m.source COLLATE NOCASE`).all(...values);
    return { performers, sources };
  }

  subtitleSettings(defaultEnabled = false): SubtitleSettings {
    const row = this.sqlite.prepare("SELECT value_json FROM settings WHERE key='subtitles'").get() as { value_json: string } | undefined;
    if (!row) return { enabled: defaultEnabled, languages: [], oldestFirst: true };
    try {
      const value = JSON.parse(row.value_json) as Partial<SubtitleSettings>;
      return {
        enabled: value.enabled === true,
        oldestFirst: value.oldestFirst !== false,
        languages: Array.isArray(value.languages) ? [...new Set(value.languages.filter(isSubtitleLanguageCode))] : [],
      };
    } catch { return { enabled: false, languages: [], oldestFirst: true }; }
  }

  storedDownloaderSettings(): DownloaderSettings | undefined {
    const row = this.sqlite.prepare("SELECT value_json FROM settings WHERE key='downloader'").get() as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value_json) as Partial<DownloaderSettings>;
      if (typeof value.host !== "string" || !value.host.trim() || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) return undefined;
      return { host: value.host.trim(), port: Number(value.port) };
    } catch { return undefined; }
  }

  downloaderSettings(): DownloaderSettings {
    return this.storedDownloaderSettings() ?? { ...DEFAULT_DOWNLOADER_SETTINGS };
  }

  setDownloaderSettings(value: DownloaderSettings) {
    const normalized: DownloaderSettings = { host: value.host.trim(), port: Math.floor(value.port) };
    const stamp = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('downloader',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(JSON.stringify(normalized), stamp);
    return normalized;
  }

  setSubtitleSettings(value: SubtitleSettings) {
    const normalized: SubtitleSettings = {
      oldestFirst: value.oldestFirst ?? this.subtitleSettings().oldestFirst,
      enabled: value.enabled === true,
      languages: [...new Set(value.languages.filter(isSubtitleLanguageCode))],
    };
    const stamp = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('subtitles',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(JSON.stringify(normalized), stamp);
    return normalized;
  }

  subtitleTracks(mediaId: string): SubtitleTrack[] {
    return (this.sqlite.prepare(`SELECT id,media_id,language,label,origin,source_language,updated_at
      FROM subtitle_tracks WHERE media_id=? ORDER BY CASE origin WHEN 'original' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,label COLLATE NOCASE`)
      .all(mediaId) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id), mediaId: String(row.media_id), language: String(row.language), label: String(row.label),
        origin: row.origin as SubtitleTrack["origin"], sourceLanguage: String(row.source_language), updatedAt: String(row.updated_at),
      }));
  }

  subtitleStatus(mediaId: string, generationEnabled: boolean) {
    const media = this.getMedia(mediaId);
    if (!media) return undefined;
    if (media.kind !== "video") return { status: "not_applicable", progress: 0, sourceLanguage: "", error: "", tracks: [] };
    const job = this.sqlite.prepare("SELECT * FROM subtitle_jobs WHERE media_id=?").get(mediaId) as Record<string, unknown> | undefined;
    const tracks = this.subtitleTracks(mediaId).map((track) => ({ ...track, url: `/api/media/${mediaId}/subtitles/${track.id}.vtt` }));
    return {
      status: generationEnabled ? String(job?.status ?? "queued") : "disabled",
      progress: generationEnabled && job ? Number(job.progress) : 0,
      sourceLanguage: job ? String(job.source_language) : "",
      error: generationEnabled && job ? String(job.last_error) : "",
      tracks,
    };
  }

  upsertSubtitleTrack(mediaId: string, id: string, language: string, label: string, origin: SubtitleTrack["origin"], sourceLanguage = "") {
    const stamp = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO subtitle_tracks(id,media_id,language,label,origin,source_language,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(media_id,id) DO UPDATE SET language=excluded.language,label=excluded.label,
      origin=excluded.origin,source_language=excluded.source_language,updated_at=excluded.updated_at`)
      .run(id, mediaId, language, label, origin, sourceLanguage, stamp);
    return this.subtitleTracks(mediaId).find((track) => track.id === id);
  }

  retrySubtitleJob(mediaId: string) {
    return this.sqlite.prepare(`UPDATE subtitle_jobs SET status='queued', attempts=0, progress=0, last_error='', completed_at=NULL, updated_at=?
      WHERE media_id=? AND status='error'`).run(new Date().toISOString(), mediaId).changes > 0;
  }

  setSubtitleWorkerState(state: "starting" | "error", error?: string) {
    const heartbeat = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('subtitle_worker_runtime',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(JSON.stringify({ state, error, heartbeat }), heartbeat);
  }

  subtitleOverview(settings: SubtitleSettings) {
    const counts = this.sqlite.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) complete,
      SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status IN ('no_audio','no_speech') THEN 1 ELSE 0 END) skipped,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM subtitle_jobs j
      JOIN media m ON m.id=j.media_id WHERE m.missing=0 AND m.kind='video'`).get() as Record<string, number>;
    const runtime = this.sqlite.prepare("SELECT value_json FROM settings WHERE key='subtitle_worker_runtime'").get() as { value_json: string } | undefined;
    let worker: Record<string, unknown> = {};
    try { worker = runtime ? JSON.parse(runtime.value_json) ?? {} : {}; } catch { /* Ignore a partial heartbeat write. */ }
    const active = settings.enabled && worker.state === "processing" && typeof worker.heartbeat === "string"
      && Date.now() - Date.parse(worker.heartbeat) < 30_000;
    const currentJob = active && typeof worker.mediaId === "string" ? this.sqlite.prepare(`SELECT m.title,j.progress,j.phase,
      j.source_language AS sourceLanguage,j.target_language AS targetLanguage FROM subtitle_jobs j JOIN media m ON m.id=j.media_id
      WHERE j.media_id=? AND j.status='running' AND m.missing=0 AND m.kind='video'`).get(worker.mediaId) : null;
    return {
      settings,
      counts: { total: Number(counts.total ?? 0), complete: Number(counts.complete ?? 0), skipped: Number(counts.skipped ?? 0), pending: Number(counts.pending ?? 0), errors: Number(counts.errors ?? 0) },
      currentJob: currentJob ?? null,
      worker: settings.enabled ? worker : { state: "disabled" },
    };
  }
}
