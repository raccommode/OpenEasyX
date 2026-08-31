import fs from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Catalog } from "./catalog.js";
import type { Database } from "./database.js";
import { LibraryDatabase, type LibraryQuery, type MediaKind } from "./library-database.js";
import { SUBTITLE_LANGUAGES, subtitleFilePath, subtitleLanguageCodes, subtitleLanguageLabel, writeManualSubtitle } from "./subtitles.js";

function positive(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(1, Math.floor(number))) : fallback;
}

function libraryQuery(value: Record<string, string | undefined>): LibraryQuery {
  return {
    q: value.q?.slice(0, 200),
    kind: (["video", "image"].includes(value.kind ?? "") ? value.kind : "") as MediaKind | "",
    performer: value.performer?.slice(0, 200), source: value.source?.slice(0, 200),
    favorite: value.favorite === "true", history: value.history === "true",
    watched: (["unseen", "progress", "unfinished", "completed"].includes(value.watched ?? "") ? value.watched : "") as LibraryQuery["watched"],
    sort: (["recent", "oldest", "title", "largest", "most-viewed", "history"].includes(value.sort ?? "") ? value.sort : "recent") as LibraryQuery["sort"],
    page: positive(value.page, 1), pageSize: positive(value.pageSize, 48, 100),
  };
}

function payload<T extends { id: string }>(media: T) {
  const version = "modifiedAt" in media && "size" in media
    ? `${Date.parse(String(media.modifiedAt)).toString(36)}-${Number(media.size).toString(36)}` : "1";
  return {
    ...media,
    thumbnailUrl: `/api/media/${media.id}/thumbnail?v=${version}`,
    previewUrl: "kind" in media && media.kind === "video" ? `/api/media/${media.id}/preview.gif?v=${version}` : "",
    streamUrl: `/api/media/${media.id}/stream`,
  };
}

export function parseMediaRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return undefined;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return undefined;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function registerLibraryRoutes(app: FastifyInstance<any, any, any, any>, libraryDb: LibraryDatabase, catalog: Catalog, downloadDb: Database, dataDir: string) {
  const requiredMedia = (id: string) => {
    const media = libraryDb.getMedia(id);
    if (!media) throw Object.assign(new Error("Media not found"), { statusCode: 404 });
    return media;
  };

  app.get("/api/library-dashboard", async () => {
    const continueWatching = libraryDb.listMedia({ kind: "video", watched: "progress", sort: "history", pageSize: 20 }).items.map(payload);
    const oldestUnfinished = libraryDb.listMedia({ kind: "video", watched: "unfinished", sort: "oldest", pageSize: 20 }).items.map(payload);
    const recentContent = libraryDb.listMedia({ sort: "recent", pageSize: 20 }).items.map(payload);
    const recentVideos = libraryDb.listMedia({ kind: "video", sort: "recent", pageSize: 20 }).items.map(payload);
    const recentImages = libraryDb.listMedia({ kind: "image", sort: "recent", pageSize: 20 }).items.map(payload);
    return {
      stats: libraryDb.stats(), scan: catalog.status,
      featured: continueWatching[0] ?? recentVideos[0] ?? oldestUnfinished[0] ?? recentImages[0],
      featuredReason: continueWatching.length ? "continue" : "recent",
      continueWatching, oldestUnfinished, recentContent, recentVideos, recentImages,
      favorites: libraryDb.listMedia({ favorite: true, sort: "recent", pageSize: 20 }).items.map(payload),
    };
  });
  app.post("/api/scan", async () => catalog.scan());
  app.get("/api/scan/status", async () => catalog.status);
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/library", async (request) => {
    const result = libraryDb.listMedia(libraryQuery(request.query));
    return { ...result, items: result.items.map(payload) };
  });
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/library/playlist", async (request) => ({ ids: libraryDb.playlist(libraryQuery(request.query)) }));
  app.get("/api/library-performers", async () => libraryDb.performers().map((performer) => {
    const cover = libraryDb.getMedia(performer.coverId);
    return { ...performer, coverUrl: cover ? payload(cover).thumbnailUrl : "" };
  }));
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/facets", async (request) => {
    const query = libraryQuery(request.query);
    return libraryDb.facets({ performer: query.performer, watched: query.watched });
  });
  app.get<{ Params: { id: string } }>("/api/media/:id", async (request) => payload(requiredMedia(request.params.id)));

  app.put<{ Body: { enabled?: unknown; languages?: unknown } }>("/api/settings/subtitles", async (request) => {
    if (typeof request.body?.enabled !== "boolean" || !Array.isArray(request.body.languages)) throw Object.assign(new Error("enabled must be a boolean and languages must be an array"), { statusCode: 400 });
    const languages = request.body.languages.filter((item): item is string => typeof item === "string");
    if (languages.some((language) => !subtitleLanguageCodes.has(language))) throw Object.assign(new Error("One or more subtitle languages are not supported"), { statusCode: 400 });
    return libraryDb.setSubtitleSettings({ enabled: request.body.enabled, languages });
  });
  app.get("/api/subtitles/status", async () => libraryDb.subtitleOverview());
  app.get<{ Params: { id: string } }>("/api/media/:id/subtitles", async (request) => libraryDb.subtitleStatus(request.params.id) ?? requiredMedia(request.params.id));
  app.put<{ Params: { id: string; language: string }; Body: { content?: unknown; label?: unknown } }>("/api/media/:id/subtitles/:language", async (request) => {
    const media = requiredMedia(request.params.id);
    if (media.kind !== "video") throw Object.assign(new Error("Subtitles can only be added to videos"), { statusCode: 400 });
    if (!subtitleLanguageCodes.has(request.params.language)) throw Object.assign(new Error("Unsupported subtitle language"), { statusCode: 400 });
    if (typeof request.body?.content !== "string" || request.body.content.length > 6 * 1024 * 1024) throw Object.assign(new Error("A subtitle file up to 6 MB is required"), { statusCode: 400 });
    let result: { trackId: string };
    try { result = writeManualSubtitle(dataDir, media.id, request.params.language, request.body.content); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { statusCode: 400 }); }
    const label = typeof request.body.label === "string" && request.body.label.trim() ? request.body.label.trim().slice(0, 80) : subtitleLanguageLabel(request.params.language);
    libraryDb.upsertSubtitleTrack(media.id, result.trackId, request.params.language, label, "manual", request.params.language);
    return libraryDb.subtitleStatus(media.id);
  });
  app.get<{ Params: { id: string; track: string } }>("/api/media/:id/subtitles/:track.vtt", async (request, reply) => {
    requiredMedia(request.params.id);
    if (!libraryDb.subtitleTracks(request.params.id).some((track) => track.id === request.params.track)) return reply.status(404).send({ error: "Subtitle track not found" });
    let file: string;
    try { file = subtitleFilePath(dataDir, request.params.id, request.params.track); } catch { return reply.status(404).send({ error: "Subtitle track not found" }); }
    if (!fs.existsSync(file)) return reply.status(404).send({ error: "Subtitle track not found" });
    return reply.type("text/vtt; charset=utf-8").header("cache-control", "no-store").send(fs.createReadStream(file));
  });
  app.put<{ Params: { id: string }; Body: { favorite?: unknown } }>("/api/media/:id/favorite", async (request) => {
    if (typeof request.body?.favorite !== "boolean") throw Object.assign(new Error("favorite must be a boolean"), { statusCode: 400 });
    return payload(libraryDb.setFavorite(request.params.id, request.body.favorite) ?? requiredMedia(request.params.id));
  });
  app.put<{ Params: { id: string }; Body: { position?: unknown; duration?: unknown; completed?: unknown } }>("/api/media/:id/progress", async (request) => {
    const position = Number(request.body?.position); const duration = Number(request.body?.duration);
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration < 0) throw Object.assign(new Error("position and duration must be non-negative numbers"), { statusCode: 400 });
    return payload(libraryDb.updateProgress(request.params.id, position, duration, request.body.completed === true) ?? requiredMedia(request.params.id));
  });
  app.post<{ Body: { ids?: unknown } }>("/api/media/delete", async (request) => {
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id))) throw Object.assign(new Error("ids must contain between 1 and 100 media IDs"), { statusCode: 400 });
    const deleted: Array<{ id: string; bytes: number; downloaderTracked: boolean }> = []; const failed: Array<{ id: string; error: string }> = [];
    for (const id of [...new Set(ids as string[])]) {
      try {
        const media = requiredMedia(id); const result = catalog.deleteMedia(media); const tracked = Boolean(downloadDb.markStoredItemDeleted(media.relativePath));
        deleted.push({ id, bytes: result.bytes, downloaderTracked: tracked });
      } catch (error) { failed.push({ id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { deleted, failed };
  });
  app.get<{ Params: { id: string } }>("/api/media/:id/thumbnail", async (request, reply) => {
    const media = requiredMedia(request.params.id);
    try { return reply.type("image/jpeg").header("cache-control", "public, max-age=31536000, immutable").send(fs.createReadStream(await catalog.thumbnail(media))); }
    catch { libraryDb.markMediaUnplayable(media.id); return reply.status(404).send({ error: "Thumbnail is not available" }); }
  });
  app.get<{ Params: { id: string } }>("/api/media/:id/preview.gif", async (request, reply) => {
    const media = requiredMedia(request.params.id);
    if (media.kind !== "video") return reply.status(400).send({ error: "Animated previews are only available for videos" });
    try { return reply.type("image/gif").header("cache-control", "public, max-age=31536000, immutable").send(fs.createReadStream(await catalog.preview(media))); }
    catch (error) { app.log.warn(error, "Animated preview could not be generated"); return reply.status(422).send({ error: "Animated preview is not available" }); }
  });

  const sendMedia = async (request: FastifyRequest, reply: FastifyReply, id: string) => {
    const media = requiredMedia(id); const playback = await catalog.playbackFile(media); const file = playback.file; let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { throw Object.assign(new Error("Media file is not available"), { statusCode: 404 }); }
    if (!stat.isFile() || stat.size <= 0) { libraryDb.markMediaUnplayable(media.id); throw Object.assign(new Error("Media file is not playable"), { statusCode: 404 }); }
    const range = request.headers.range;
    reply.header("accept-ranges", "bytes").header("content-type", playback.mimeType).header("cache-control", "private, max-age=3600");
    if (!range) return reply.header("content-length", stat.size).send(fs.createReadStream(file));
    const parsed = parseMediaRange(range, stat.size);
    if (!parsed) return reply.status(416).header("content-range", `bytes */${stat.size}`).send();
    const { start, end } = parsed;
    return reply.status(206).header("content-range", `bytes ${start}-${end}/${stat.size}`).header("content-length", end - start + 1).send(fs.createReadStream(file, { start, end }));
  };
  app.get<{ Params: { id: string } }>("/api/media/:id/stream", async (request, reply) => sendMedia(request, reply, request.params.id));

  return { settings: () => ({ subtitles: libraryDb.subtitleSettings(), subtitleLanguages: SUBTITLE_LANGUAGES }), scan: () => catalog.scan() };
}
