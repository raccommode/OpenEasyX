import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import Fastify from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import pino from "pino";
import { z } from "zod";
import { Database } from "./database.js";
import { PluginManager, pluginMatchesSource } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { discoverPeople } from "./discovery.js";
import { deletePerformerFiles, ensurePerformerDirectory, renamePerformerDirectory } from "./performer-files.js";
import { domainFromUrl } from "./utils.js";
import { BrowserLoginManager } from "./browser-login.js";
import { LogStore, type LogWriter } from "./log-store.js";
import { LiveCamService } from "./live-cams.js";
import { PluginRepositoryManager } from "./plugin-repositories.js";
import { LibraryDatabase } from "./library-database.js";
import { Catalog } from "./catalog.js";
import { registerLibraryRoutes } from "./library-routes.js";

const port = Number(process.env.PORT ?? 3210);
const dataDir = path.resolve(process.env.EASYX_DATA_DIR ?? "data");
const mediaDir = path.resolve(process.env.EASYX_MEDIA_DIR ?? "media");
const externalPluginsDir = path.resolve(process.env.EASYX_EXTERNAL_PLUGINS_DIR ?? "plugins-external");
const scanIntervalMinutes = Math.max(1, Number(process.env.EASYX_SCAN_INTERVAL_MINUTES ?? 10));
const appVersion = process.env.APP_VERSION?.trim() || "dev";
const logStore = new LogStore();
const appLogger = pino({ level: process.env.EASYX_LOG_LEVEL ?? "info" }, logStore.stream);
const writeLog: LogWriter = (level, scope, message, details) => appLogger[level]({ scope, ...(details === undefined ? {} : { details }) }, message);
const db = new Database(dataDir);
const libraryDb = new LibraryDatabase(dataDir);
const catalog = new Catalog(libraryDb, mediaDir, dataDir);
const pluginRepositories = new PluginRepositoryManager(dataDir, path.resolve("plugins"), externalPluginsDir);
const plugins = new PluginManager(db, pluginRepositories.roots(), path.join(dataDir, "sessions"), writeLog);
await plugins.load();
const queue = new DownloadQueue(
  db, plugins, mediaDir, writeLog, () => catalog.scan(),
  (item) => catalog.deleteStoredMedia(item.storagePath!),
);
const browserLogin = new BrowserLoginManager(dataDir);
const liveCams = new LiveCamService(db, plugins);
queue.start();

const app = Fastify({ loggerInstance: appLogger, bodyLimit: 8 * 1024 * 1024 });
const discoveryStatus = { running: false, completed: 0, total: 0, progress: 0, query: "", error: "" };

app.setErrorHandler((error, request, reply) => {
  const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
  const message = error instanceof Error ? error.message : String(error);
  app.log[status >= 500 ? "error" : "warn"]({ err: error, method: request.method, url: request.url, scope: "http" }, "Request failed");
  reply.status(status >= 400 && status < 600 ? status : 500).send({ error: message });
});

await app.register(fastifyHttpProxy, { upstream: "http://127.0.0.1:6080", prefix: "/browser", websocket: true });
const library = registerLibraryRoutes(app, libraryDb, catalog, db, dataDir);

app.get("/api/health", async () => ({ ok: true, product: "Open EasyX", version: appVersion, plugins: plugins.list().length, library: libraryDb.stats().total, scan: catalog.status }));
app.get("/api/version", async () => ({ version: appVersion }));
app.get("/api/dashboard", async () => ({ stats: db.stats(), performers: db.listPerformers(), sources: db.listSources(), items: db.listItems(30) }));
app.get<{ Querystring: Record<string, string | undefined> }>("/api/logs", async (request) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(1_000).default(500), level: z.enum(["debug", "info", "warn", "error"]).optional(), search: z.string().trim().max(200).optional() }).parse(request.query);
  return { entries: logStore.list(query) };
});
app.get("/api/logs/stream", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.raw.write(": connected\n\n");
  const lastId = Number(request.headers["last-event-id"] ?? 0);
  const send = (entry: ReturnType<typeof logStore.add>) => {
    if (entry.id <= lastId || reply.raw.destroyed) return;
    reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
  };
  for (const entry of logStore.list({ limit: 1_000, afterId: Number.isFinite(lastId) ? lastId : 0 })) send(entry);
  const unsubscribe = logStore.subscribe(send);
  const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  request.raw.once("close", cleanup); reply.raw.once("close", cleanup);
});

app.get("/api/plugins", async () => plugins.list());
app.get("/api/plugin-repositories", async () => pluginRepositories.list());
app.post<{ Body: { url?: unknown; name?: unknown } }>("/api/plugin-repositories", async (request) => {
  if (typeof request.body?.url !== "string") throw Object.assign(new Error("A Git repository URL is required"), { statusCode: 400 });
  const repository = await pluginRepositories.add(request.body.url, typeof request.body.name === "string" ? request.body.name : undefined);
  plugins.setRoots(pluginRepositories.roots()); await plugins.load(); return { repository, plugins: plugins.list() };
});
app.post<{ Params: { id: string } }>("/api/plugin-repositories/:id/refresh", async (request) => {
  if (request.params.id === "official") throw Object.assign(new Error("The official store is updated with OpenEasyX"), { statusCode: 409 });
  const repository = await pluginRepositories.refresh(request.params.id); plugins.setRoots(pluginRepositories.roots()); await plugins.load(); return { repository, plugins: plugins.list() };
});
app.delete<{ Params: { id: string } }>("/api/plugin-repositories/:id", async (request) => {
  if (request.params.id === "official") throw Object.assign(new Error("The official store cannot be removed"), { statusCode: 409 });
  const result = pluginRepositories.remove(request.params.id); plugins.setRoots(pluginRepositories.roots()); await plugins.load(); return { ...result, plugins: plugins.list() };
});
app.post<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>("/api/plugins/:id/install", async (request) => {
  plugins.install(request.params.id, request.body ?? {});
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.delete<{ Params: { id: string } }>("/api/plugins/:id", async (request) => {
  plugins.uninstall(request.params.id);
  await browserLogin.removeProfile(request.params.id);
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/plugins/:id/enable", async (request) => {
  // Backwards-compatible endpoint for older clients. Disabling now means
  // uninstalling; enabling performs the same validated install operation.
  if (request.body?.enabled === false) plugins.uninstall(request.params.id); else plugins.install(request.params.id);
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/plugins/:id/config", async (request) => {
  plugins.configure(request.params.id, request.body ?? {});
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.post<{ Params: { id: string } }>("/api/plugins/:id/test", async (request) => {
  const plugin = plugins.get(request.params.id, false);
  if (!db.getPluginState(request.params.id).installed) throw Object.assign(new Error("Install the plugin before testing it"), { statusCode: 409 });
  plugins.ensureConfigured(request.params.id);
  if (!plugin.testConnection) return { ok: true, message: "Ready. This plugin validates each configured source URL when scraping starts." };
  return plugin.testConnection(plugins.context(request.params.id));
});
app.post<{ Params: { id: string } }>("/api/plugins/:id/browser-login/start", async (request) => {
  const plugin = plugins.get(request.params.id, false);
  return browserLogin.start(request.params.id, plugin.manifest);
});
app.get<{ Params: { id: string } }>("/api/plugins/:id/browser-login/status", async (request) => {
  plugins.get(request.params.id, false);
  return browserLogin.status(request.params.id);
});
app.post<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>("/api/plugins/:id/browser-login/capture", async (request) => {
  const plugin = plugins.get(request.params.id, false);
  const browserAuth = plugin.manifest.browserAuth;
  if (!browserAuth) throw Object.assign(new Error(`${plugin.manifest.name} does not support integrated browser login`), { statusCode: 409 });
  const session = await browserLogin.capture(request.params.id, plugin.manifest);
  const incoming = { ...(request.body ?? {}), [browserAuth.sessionSetting]: session };
  let test = { ok: true, message: "Session captured and plugin activated." };
  if (plugin.testConnection) {
    const temporaryRoot = fs.mkdtempSync(path.join(dataDir, ".browser-auth-test-"));
    try {
      const sessionField = plugin.manifest.settings?.find((field) => field.key === browserAuth.sessionSetting);
      const temporarySession = sessionField?.type === "session" ? path.join(temporaryRoot, sessionField.sessionFormat === "raw-json" ? "session.json" : "cookies.txt") : session;
      if (sessionField?.type === "session") fs.writeFileSync(temporarySession, `${session}\n`, { mode: 0o600 });
      test = await plugin.testConnection(plugins.context(request.params.id, undefined, {
        ...db.getPluginState(request.params.id).config, ...incoming, [browserAuth.sessionSetting]: temporarySession,
      }));
    } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
    if (!test.ok) throw Object.assign(new Error(test.message || `${plugin.manifest.name} rejected the captured session`), { statusCode: 409 });
  }
  const installed = db.getPluginState(request.params.id).installed;
  if (installed) plugins.configure(request.params.id, incoming); else plugins.install(request.params.id, incoming);
  await browserLogin.removeProfile(request.params.id);
  return { plugin: plugins.list().find((entry) => entry.manifest.id === request.params.id), test };
});
app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/api/plugins/:id/browser-login/paste", async (request) => {
  plugins.get(request.params.id, false);
  const value = z.string().min(1).max(100_000).parse(request.body?.text);
  return browserLogin.paste(request.params.id, value);
});
app.delete<{ Params: { id: string } }>("/api/plugins/:id/browser-login", async (request) => {
  plugins.get(request.params.id, false);
  if (browserLogin.status(request.params.id).active) await browserLogin.stop();
  return { stopped: true };
});
app.post("/api/plugins/reload", async () => { await plugins.load(); return plugins.list(); });
app.post<{ Params: { id: string }; Body: unknown }>("/api/plugins/:id/library/deletions", async (request) => {
  const plugin = plugins.get(request.params.id);
  if (!plugin.manifest.capabilities.includes("library-hook") || !plugin.acceptLibraryDeletion) {
    throw Object.assign(new Error("This plugin does not accept library deletions"), { statusCode: 409 });
  }
  const deletion = z.object({ relativePath: z.string().trim().min(1).max(4096) }).parse(request.body);
  const accepted = await plugin.acceptLibraryDeletion(plugins.context(request.params.id), deletion);
  const item = db.markStoredItemDeleted(accepted.relativePath);
  if (!item) throw Object.assign(new Error("No completed download matches this library path"), { statusCode: 404 });
  return { deleted: true, itemId: item.id, status: item.status, relativePath: item.storagePath };
});

const liveCamQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(48).default(24),
  providerId: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()), search: z.string().trim().max(120).optional(),
  gender: z.preprocess((value) => value === "" ? undefined : value, z.enum(["female", "male", "couple", "trans"]).optional()),
  favoritesOnly: z.preprocess((value) => value === "1" || value === "true" || value === true, z.boolean()).default(false),
});
const liveCamBodySchema = z.object({
  providerId: z.string().trim().min(1),
  cam: z.object({
    id: z.string().trim().min(1).max(300), username: z.string().trim().min(1).max(160), title: z.string().max(300).optional(),
    pageUrl: z.string().url().max(4096), thumbnailUrl: z.string().url().max(4096).optional(), viewers: z.number().int().min(0).optional(),
    age: z.number().int().min(18).max(120).optional(), gender: z.string().max(40).optional(), tags: z.array(z.string().max(80)).max(50).optional(),
  }),
});

app.get<{ Querystring: Record<string, unknown> }>("/api/live-cams", async (request) => {
  const query = liveCamQuerySchema.parse(request.query);
  return liveCams.list(query);
});
app.get<{ Querystring: Record<string, unknown> }>("/api/live-cams/events", async (request, reply) => {
  const query = liveCamQuerySchema.parse(request.query);
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.raw.write(": connected\n\n");
  const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
  try {
    for await (const result of liveCams.stream(query, controller.signal)) {
      if (reply.raw.destroyed) break;
      reply.raw.write(`data: ${JSON.stringify(result)}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    if (!reply.raw.destroyed) reply.raw.end();
  }
});
app.get("/api/live-cams/favorites", async () => ({ items: liveCams.listFavorites() }));
app.put<{ Body: unknown }>("/api/live-cams/favorites", async (request) => {
  const body = liveCamBodySchema.extend({ favorite: z.boolean() }).parse(request.body);
  return liveCams.setFavorite(body.providerId, body.cam, body.favorite);
});
app.get<{ Params: { providerId: string; camId: string } }>("/api/live-cams/:providerId/:camId", async (request) => {
  const params = z.object({
    providerId: z.string().trim().min(1).max(200),
    camId: z.string().trim().min(1).max(300),
  }).parse(request.params);
  return liveCams.get(params.providerId, params.camId);
});
app.post<{ Body: unknown }>("/api/live-cams/stream", async (request) => {
  const body = liveCamBodySchema.parse(request.body);
  return liveCams.resolve(body.providerId, body.cam);
});
app.post<{ Body: unknown }>("/api/live-cams/record", async (request) => {
  const body = liveCamBodySchema.parse(request.body);
  return liveCams.record(body.providerId, body.cam);
});
app.get<{ Params: { tokenPath: string }; Querystring: Record<string, unknown> }>("/api/live-cams/proxy/:tokenPath", async (request, reply) => {
  return liveCams.proxy(request.params.tokenPath, reply, request.query, typeof request.headers.range === "string" ? request.headers.range : undefined);
});

app.get<{ Querystring: { q?: string } }>("/api/discover", async (request) => {
  const query = z.string().trim().min(2).max(120).parse(request.query.q);
  Object.assign(discoveryStatus, { running: true, completed: 0, total: 0, progress: 0, query, error: "" });
  try {
    const result = await discoverPeople(plugins, query, (progress) => Object.assign(discoveryStatus, progress));
    discoveryStatus.progress = 100;
    return result;
  } catch (error) {
    discoveryStatus.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    discoveryStatus.running = false;
  }
});
app.get("/api/discover/status", async () => discoveryStatus);

const candidateSchema = z.object({
  externalId: z.string().min(1), name: z.string().trim().min(1).max(160), aliases: z.array(z.string()).optional(),
  imageUrl: z.string().url().optional(), profileUrls: z.array(z.string().url()).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
});
const discoveryMatchSchema = z.object({ pluginId: z.string().min(1), candidate: candidateSchema });
const localPerformerImageUrl = z.string().regex(/^\/api\/media\/[a-f0-9]{24}\/thumbnail$/, "Invalid local performer image");
const storedPerformerImageUrl = z.string().regex(/^\/api\/performers\/person_[a-f0-9]{20}\/image$/, "Invalid stored performer image");
const performerEditorSchema = z.object({
  name: z.string().trim().min(1).max(160), aliases: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  imageUrl: z.union([z.string().url().max(4096), localPerformerImageUrl, storedPerformerImageUrl, z.literal(""), z.null()]).optional(),
});
const manualPluginId = "org.easyx.manual";
const performerImagesDir = path.join(dataDir, "performer-images");

function performerImageFile(performerId: string) {
  return path.join(performerImagesDir, `${performerId}.jpg`);
}

async function resolvePerformerImageUrl(performerId: string, previousName: string, nextName: string, imageUrl?: string | null) {
  const storedUrl = `/api/performers/${performerId}/image`;
  if (imageUrl === storedUrl) return storedUrl;
  const selected = /^\/api\/media\/([a-f0-9]{24})\/thumbnail$/.exec(imageUrl ?? "");
  if (selected) {
    const media = libraryDb.getMedia(selected[1]);
    const performerNames = new Set([previousName, nextName].map((value) => value.toLocaleLowerCase()));
    if (!media || media.kind !== "image" || !performerNames.has(media.performer.toLocaleLowerCase())) {
      throw Object.assign(new Error("The selected image does not belong to this performer"), { statusCode: 400 });
    }
    fs.mkdirSync(performerImagesDir, { recursive: true, mode: 0o700 });
    const target = performerImageFile(performerId); const temporary = `${target}.${process.pid}.tmp`;
    try { fs.copyFileSync(await catalog.thumbnail(media), temporary); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
    return storedUrl;
  }
  fs.rmSync(performerImageFile(performerId), { force: true });
  return imageUrl || null;
}

function ensureSourcePlugin(pluginId: string) {
  if (pluginId === manualPluginId) return;
  plugins.get(pluginId, false);
  if (!db.getPluginState(pluginId).installed) throw Object.assign(new Error("Install the selected plugin before associating it"), { statusCode: 409 });
}

function ensureScraperPlugin(pluginId: string, profileUrl?: string) {
  const entry = plugins.list().find((candidate) => candidate.manifest.id === pluginId);
  if (!entry?.installed || !entry.enabled) throw Object.assign(new Error("Install and enable the selected scraper plugin first"), { statusCode: 409 });
  if (!entry.manifest.capabilities.includes("media-listing")) throw Object.assign(new Error(`${entry.manifest.name} cannot scrape media URLs`), { statusCode: 409 });
  if (profileUrl && !pluginMatchesSource(entry.manifest, profileUrl)) throw Object.assign(new Error(`${entry.manifest.name} does not support this URL`), { statusCode: 409 });
  return plugins.get(pluginId);
}

function scraperInterval(pluginId: string): number {
  const manifest = plugins.list().find((candidate) => candidate.manifest.id === pluginId)?.manifest;
  if (manifest?.polling?.mode === "live") return Math.max(manifest.polling.minimumIntervalSeconds, Number(db.getSettings().defaultLiveIntervalSeconds ?? manifest.polling.defaultIntervalSeconds));
  if (manifest?.polling) return manifest.polling.defaultIntervalSeconds;
  return Math.max(300, Number(db.getSettings().defaultScrapeIntervalMinutes ?? 360) * 60);
}

function validateScraperInterval(pluginId: string, intervalSeconds: number): number {
  const manifest = plugins.list().find((candidate) => candidate.manifest.id === pluginId)?.manifest;
  const minimum = manifest?.polling?.minimumIntervalSeconds ?? 300;
  if (intervalSeconds < minimum) throw Object.assign(new Error(`${manifest?.name ?? pluginId} requires an interval of at least ${minimum} seconds`), { statusCode: 409 });
  return intervalSeconds;
}

app.post<{ Body: unknown }>("/api/performers/import", async (request) => {
  const body = z.union([
    z.object({ matches: z.array(discoveryMatchSchema).min(1).max(12) }),
    discoveryMatchSchema.transform((match) => ({ matches: [match] })),
  ]).parse(request.body);
  let performer: ReturnType<typeof db.upsertPerformer> | undefined;
  const sources = [];
  const providers: Array<{ pluginId: string; ok: boolean; error?: string }> = [];
  for (const match of body.matches) {
    const plugin = plugins.get(match.pluginId);
    performer = db.upsertPerformer(match.candidate, match.pluginId, performer?.id);
    try {
      const discovered = plugin.discoverSources ? await plugin.discoverSources(plugins.context(match.pluginId), performer) : [];
      for (const source of discovered) sources.push(db.addSource(performer.id, match.pluginId, source));
      providers.push({ pluginId: match.pluginId, ok: true });
    } catch (error) {
      providers.push({ pluginId: match.pluginId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (performer) ensurePerformerDirectory(mediaDir, performer.name);
  return { performer, sources, providers };
});
app.get("/api/performers", async () => db.listPerformers());
app.post<{ Body: unknown }>("/api/performers", async (request) => {
  const body = performerEditorSchema.parse(request.body);
  if (typeof body.imageUrl === "string" && body.imageUrl.startsWith("/api/")) throw Object.assign(new Error("Choose a local image after creating the performer"), { statusCode: 400 });
  if (db.getPerformerByName(body.name)) throw Object.assign(new Error("A performer with this name already exists"), { statusCode: 409 });
  const performer = db.createPerformer({ ...body, imageUrl: body.imageUrl || null });
  ensurePerformerDirectory(mediaDir, performer.name);
  return performer;
});
app.get<{ Params: { id: string } }>("/api/performers/:id/image", async (request, reply) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const file = performerImageFile(performer.id);
  if (!fs.existsSync(file)) return reply.status(404).send({ error: "Performer image not found" });
  return reply.type("image/jpeg").header("cache-control", "private, no-cache").send(fs.createReadStream(file));
});
app.get<{ Params: { id: string } }>("/api/performers/:id", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  return { performer, sources: db.listSources(performer.id), items: db.listItems(10000).filter((item) => item.performerId === performer.id) };
});
app.patch<{ Params: { id: string }; Body: unknown }>("/api/performers/:id", async (request) => {
  const current = db.getPerformer(request.params.id);
  if (!current) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const body = performerEditorSchema.parse(request.body);
  const sameName = db.getPerformerByName(body.name);
  if (sameName && sameName.id !== current.id) throw Object.assign(new Error("A performer with this name already exists"), { statusCode: 409 });
  const imageUrl = await resolvePerformerImageUrl(current.id, current.name, body.name, body.imageUrl);
  const performer = db.updatePerformer(current.id, { ...body, imageUrl })!;
  renamePerformerDirectory(mediaDir, current.name, performer.name);
  return performer;
});
app.post<{ Params: { id: string } }>("/api/performers/:id/refresh", async (request) => {
  let performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const providers: Array<{ pluginId: string; ok: boolean; error?: string }> = [];
  const sources = [];
  for (const [pluginId, externalId] of Object.entries(performer.externalRefs)) {
    const entry = plugins.list().find((candidate) => candidate.manifest.id === pluginId);
    if (!entry?.installed || !entry.enabled) continue;
    try {
      const plugin = plugins.get(pluginId);
      if (plugin.searchPeople) {
        const candidates = await plugin.searchPeople(plugins.context(pluginId), externalId);
        const candidate = candidates.find((item) => item.externalId === externalId) ?? candidates[0];
        if (candidate) {
          const previousName = performer.name;
          performer = db.updatePerformer(performer.id, {
            name: candidate.name,
            aliases: [...new Set([...performer.aliases, ...(candidate.aliases ?? [])])],
            imageUrl: candidate.imageUrl ?? performer.imageUrl ?? null,
          })!;
          renamePerformerDirectory(mediaDir, previousName, performer.name);
        }
      }
      if (plugin.discoverSources) {
        for (const source of await plugin.discoverSources(plugins.context(pluginId), performer)) sources.push(db.addSource(performer.id, pluginId, source));
      }
      providers.push({ pluginId, ok: true });
    } catch (error) {
      providers.push({ pluginId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  ensurePerformerDirectory(mediaDir, performer.name);
  return { performer, sources, providers };
});
app.post<{ Params: { id: string } }>("/api/performers/:id/discover-sources", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const added = [];
  for (const entry of plugins.list().filter((item) => item.installed && item.enabled && item.manifest.capabilities.includes("source-discovery"))) {
    const plugin = plugins.get(entry.manifest.id);
    if (!plugin.discoverSources) continue;
    for (const source of await plugin.discoverSources(plugins.context(entry.manifest.id), performer)) added.push(db.addSource(performer.id, entry.manifest.id, source));
  }
  return { sources: added };
});
app.post<{ Params: { id: string }; Body: unknown }>("/api/performers/:id/sources", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const body = z.object({
    profileUrl: z.string().url(), pluginId: z.string().min(1).default(manualPluginId), label: z.string().trim().max(160).optional(),
    scraperPluginId: z.string().min(1).optional(), scrapeEnabled: z.boolean().optional(), enabled: z.boolean().optional(), autoDownload: z.boolean().optional(),
  }).parse(request.body);
  ensureSourcePlugin(body.pluginId);
  if (body.scraperPluginId) ensureScraperPlugin(body.scraperPluginId, body.profileUrl);
  if (body.scrapeEnabled && !body.scraperPluginId) throw Object.assign(new Error("Select a scraper plugin before enabling scraping"), { statusCode: 409 });
  const domain = domainFromUrl(body.profileUrl);
  const source = db.addSource(performer.id, body.pluginId, { externalId: body.profileUrl, profileUrl: body.profileUrl, domain, label: body.label || domain });
  return db.updateSource(source.id, { scraperPluginId: body.scraperPluginId, scrapeEnabled: body.scrapeEnabled, enabled: body.enabled, autoDownload: body.autoDownload, ...(body.scraperPluginId ? { syncIntervalSeconds: scraperInterval(body.scraperPluginId) } : {}) });
});
app.delete<{ Params: { id: string }; Body: unknown }>("/api/performers/:id", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const body = z.object({ deleteFiles: z.boolean().default(false) }).parse(request.body ?? {});
  const items = db.listItems(10000).filter((item) => item.performerId === performer.id);
  if (items.some((item) => ["queued", "downloading"].includes(item.status))) {
    throw Object.assign(new Error("Wait for active downloads to finish before deleting this performer"), { statusCode: 409 });
  }
  const deletedFiles = body.deleteFiles ? deletePerformerFiles(mediaDir, performer, items) : 0;
  db.deletePerformer(performer.id);
  fs.rmSync(performerImageFile(performer.id), { force: true });
  return { deleted: true, deletedFiles, filesKept: !body.deleteFiles };
});

app.patch<{ Params: { id: string }; Body: unknown }>("/api/sources/:id", async (request) => {
  const body = z.object({
    scraperPluginId: z.union([z.string().min(1), z.null()]).optional(), scrapeEnabled: z.boolean().optional(),
    pluginId: z.string().min(1).optional(), label: z.string().trim().min(1).max(160).optional(), profileUrl: z.string().url().optional(), enabled: z.boolean().optional(),
    autoDownload: z.boolean().optional(), syncIntervalSeconds: z.number().int().min(5).max(31_536_000).optional(), syncIntervalMinutes: z.number().int().min(1).max(525600).optional(),
  }).parse(request.body);
  const current = db.getSource(request.params.id);
  if (!current) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  if (body.pluginId) ensureSourcePlugin(body.pluginId);
  const scraperPluginId = body.scraperPluginId === undefined ? current.scraperPluginId : body.scraperPluginId ?? undefined;
  const profileUrl = body.profileUrl ?? current.profileUrl;
  if (scraperPluginId) ensureScraperPlugin(scraperPluginId, profileUrl);
  if (body.scrapeEnabled && !scraperPluginId) throw Object.assign(new Error("Select a scraper plugin before enabling scraping"), { statusCode: 409 });
  const requestedInterval = body.syncIntervalSeconds ?? (body.syncIntervalMinutes === undefined ? undefined : body.syncIntervalMinutes * 60);
  const syncIntervalSeconds = scraperPluginId
    ? validateScraperInterval(scraperPluginId, requestedInterval ?? (body.scraperPluginId && body.scraperPluginId !== current.scraperPluginId ? scraperInterval(scraperPluginId) : current.syncIntervalSeconds))
    : current.syncIntervalSeconds;
  const { syncIntervalMinutes: _legacyInterval, ...patch } = body;
  const values = { ...patch, syncIntervalSeconds, ...(body.scraperPluginId === null ? { scraperPluginId: null, scrapeEnabled: false } : {}), ...(body.profileUrl ? { domain: domainFromUrl(body.profileUrl) } : {}) };
  const source = db.updateSource(request.params.id, values);
  const shouldRunSoon = body.scraperPluginId !== undefined && body.scraperPluginId !== current.scraperPluginId
    || body.scrapeEnabled === true && !current.scrapeEnabled
    || requestedInterval !== undefined && requestedInterval !== current.syncIntervalSeconds;
  return shouldRunSoon ? db.resetSourceSchedule(request.params.id) : source;
});
app.delete<{ Params: { id: string } }>("/api/sources/:id", async (request) => {
  const source = db.getSource(request.params.id);
  if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  const active = db.listItems(10000).some((item) => item.sourceId === source.id && ["queued", "downloading"].includes(item.status));
  if (active) throw Object.assign(new Error("Wait for active downloads to finish before deleting this URL"), { statusCode: 409 });
  db.deleteSource(source.id);
  return { deleted: true };
});

async function syncSource(sourceId: string) {
  const source = db.getSource(sourceId);
  if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  if (!source.scraperPluginId) throw Object.assign(new Error("Select a scraper plugin for this URL first"), { statusCode: 409 });
  const plugin = ensureScraperPlugin(source.scraperPluginId, source.profileUrl);
  if (!plugin.listMedia) throw Object.assign(new Error("This source is informational; its plugin does not list media"), { statusCode: 409 });
  try {
    const candidates = await plugin.listMedia(plugins.context(source.scraperPluginId), source);
    const storedDateChanges: string[] = [];
    const result = db.ingestItems(source, candidates, (itemId) => storedDateChanges.push(itemId));
    await queue.applyStoredMediaDates(storedDateChanges);
    db.markSourceSynced(source.id, source.syncIntervalSeconds);
    return { ...result, total: candidates.length };
  } catch (error) {
    db.markSourceSynced(source.id, source.syncIntervalSeconds, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

app.post<{ Params: { id: string } }>("/api/sources/:id/sync", async (request) => syncSource(request.params.id));
app.get<{ Querystring: Record<string, string | undefined> }>("/api/items", async (request) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
    category: z.enum(["active", "ready", "downloaded", "errors", "other"]).optional(),
    status: z.string().trim().min(1).optional(), mediaType: z.string().trim().min(1).optional(),
    sourceId: z.string().trim().min(1).optional(), sourceDomain: z.string().trim().min(1).optional(), performerId: z.string().trim().min(1).optional(),
    search: z.string().trim().max(200).optional(),
  }).parse(request.query);
  const result = db.listItemsPage(query);
  return { ...result, items: result.items.map((item) => ({ ...item, outputPath: queue.outputPath(item.id) })) };
});
app.post("/api/items/retry-failed", async () => ({ queued: db.retryFailedItems() }));
app.post<{ Params: { id: string } }>("/api/items/:id/queue", async (request) => {
  const item = db.getItem(request.params.id);
  if (!item) throw Object.assign(new Error("Item not found"), { statusCode: 404 });
  if (!["available", "failed"].includes(item.status)) throw Object.assign(new Error(`Cannot queue an item with status '${item.status}'`), { statusCode: 409 });
  return db.setItemStatus(item.id, "queued", { progress: 0 });
});
app.post<{ Params: { id: string } }>("/api/items/:id/pause", async (request) => queue.pause(request.params.id));
app.post<{ Params: { id: string } }>("/api/items/:id/resume", async (request) => queue.resume(request.params.id));
app.post<{ Params: { id: string } }>("/api/items/:id/stop", async (request) => queue.stopRecording(request.params.id));
app.post<{ Params: { id: string } }>("/api/items/:id/cancel", async (request) => queue.cancel(request.params.id));
app.delete<{ Params: { id: string } }>("/api/items/:id", async (request) => queue.delete(request.params.id));

app.get("/api/settings", async () => ({ ...db.getSettings(), mediaRoot: mediaDir, ...library.settings() }));
app.put<{ Body: Record<string, unknown> }>("/api/settings", async (request) => {
  const settings = z.object({ retentionDays: z.number().int().min(0).max(36500).optional(), maxConcurrentDownloads: z.number().int().min(1).max(8).optional(), autoQueueDiscovered: z.boolean().optional(), legalAccepted: z.boolean().optional(), defaultScrapeIntervalMinutes: z.number().int().min(5).max(525600).optional(), defaultLiveIntervalSeconds: z.number().int().min(5).max(3600).optional() }).parse(request.body);
  return db.updateSettings(settings);
});

const scheduledInFlight = new Set<string>();
setInterval(() => {
  for (const source of db.dueSources()) {
    if (scheduledInFlight.size >= 4) break;
    if (scheduledInFlight.has(source.id)) continue;
    const owner = plugins.list().find((entry) => entry.manifest.id === source.scraperPluginId);
    if (!owner?.installed || !owner.enabled || !owner.manifest.capabilities.includes("media-listing")) continue;
    scheduledInFlight.add(source.id);
    void syncSource(source.id).catch((error) => app.log.warn({ error, sourceId: source.id }, "Scheduled source sync failed")).finally(() => scheduledInFlight.delete(source.id));
  }
}, 1000).unref();

const webRoot = path.resolve("dist/web");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
}

let subtitleWorker: ChildProcess | undefined;
let subtitleWorkerRestart: NodeJS.Timeout | undefined;
let shuttingDown = false;
function startEmbeddedSubtitleWorker() {
  if (process.env.EASYX_EMBEDDED_SUBTITLE_WORKER !== "true" || shuttingDown) return;
  subtitleWorker = spawn(process.env.EASYX_SUBTITLE_PYTHON || "/opt/subtitles/bin/python", ["-m", "worker.subtitles"], { cwd: path.resolve("."), env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  subtitleWorker.on("error", (error) => app.log.error(error, "Embedded subtitle worker could not start"));
  subtitleWorker.on("close", (code, signal) => {
    subtitleWorker = undefined;
    if (shuttingDown) return;
    app.log.error({ code, signal }, "Embedded subtitle worker stopped; restarting in five seconds");
    subtitleWorkerRestart = setTimeout(startEmbeddedSubtitleWorker, 5000);
  });
}

const shutdown = async () => {
  shuttingDown = true; queue.stop(); if (subtitleWorkerRestart) clearTimeout(subtitleWorkerRestart); subtitleWorker?.kill("SIGTERM");
  await browserLogin.stop(); await app.close(); libraryDb.close(); db.close(); process.exit(0);
};
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
await app.listen({ port, host: "0.0.0.0" });
startEmbeddedSubtitleWorker();
setTimeout(() => void catalog.scan().catch((error) => app.log.error(error, "Initial library scan failed")), 250).unref();
setInterval(() => void catalog.scan().catch((error) => app.log.error(error, "Scheduled library scan failed")), scanIntervalMinutes * 60_000).unref();
