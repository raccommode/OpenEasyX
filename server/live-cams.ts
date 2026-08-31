import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { LiveCam, LiveCamQuery, LiveStream } from "../packages/plugin-sdk/index.js";
import type { Database, LiveCamFavorite } from "./database.js";
import { PluginManager, pluginMatchesSource } from "./plugin-manager.js";

export type PublicLiveCam = LiveCam & { providerId: string; providerName: string; favorite: boolean };
export type LiveCamProviderStatus = { id: string; name: string; ok: boolean; count: number; pending?: boolean; error?: string };
export type LiveCamResult = {
  items: PublicLiveCam[]; total: number; page: number; pageSize: number; pages: number;
  providers: LiveCamProviderStatus[]; complete?: boolean;
};

type ProxyEntry = { url?: string; body?: string; headers: Record<string, string>; expiresAt: number };
type ProviderResult = { items: PublicLiveCam[]; total: number; status: LiveCamProviderStatus };
type LiveCamListQuery = LiveCamQuery & { providerId?: string; favoritesOnly?: boolean };

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function whole(value: unknown): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0; }
function usernameFromUrl(value: string): string {
  try { return new URL(value).pathname.split("/").filter(Boolean).at(-1)?.replace(/^@/, "") || "live"; }
  catch { return "live"; }
}

export class LiveCamService {
  private proxyEntries = new Map<string, ProxyEntry>();
  private proxyReverse = new Map<string, string>();
  private recentCams = new Map<string, { cam: PublicLiveCam; expiresAt: number }>();

  constructor(private readonly db: Database, private readonly plugins: PluginManager, private readonly request: typeof fetch = fetch) {}

  private livePlugins(providerId?: string) {
    return this.plugins.list().filter((entry) => entry.installed && entry.enabled
      && entry.manifest.capabilities.includes("live-cam")
      && (!providerId || entry.manifest.id === providerId));
  }

  private async listProvider(entry: ReturnType<PluginManager["list"]>[number], query: LiveCamQuery, signal?: AbortSignal, favoritesOnly = false): Promise<ProviderResult> {
    const plugin = this.plugins.get(entry.manifest.id);
    try {
      let cams: LiveCam[] = [];
      let total = 0;
      if (plugin.listLiveCams) {
        if (favoritesOnly) {
          const favorites = this.db.listLiveCamFavorites(entry.manifest.id);
          const discovered = await Promise.all(favorites.map(async (favorite) => {
            const result = await plugin.listLiveCams!(this.plugins.context(entry.manifest.id, signal), { page: 1, pageSize: 8, search: favorite.username });
            const needle = favorite.username.toLowerCase();
            return result.cams.find((cam) => cam.username.toLowerCase() === needle || cam.id.toLowerCase() === favorite.camId.toLowerCase());
          }));
          const unique = new Map(discovered.filter(Boolean).map((cam) => [cam!.username.toLowerCase(), cam!]));
          const online = [...unique.values()].sort((left, right) => whole(right.viewers) - whole(left.viewers));
          total = online.length;
          cams = online.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
        } else {
          const result = await plugin.listLiveCams(this.plugins.context(entry.manifest.id, signal), query);
          cams = result.cams.slice(0, query.pageSize);
          total = result.total;
        }
      } else if (plugin.listMedia) {
        const sources = this.db.listSources().filter((source) => source.enabled && source.scraperPluginId === entry.manifest.id);
        const discovered = await Promise.all(sources.map(async (source) => {
          const candidates = await plugin.listMedia!(this.plugins.context(entry.manifest.id, signal), source);
          const candidate = candidates.find((item) => item.metadata?.live === true);
          if (!candidate) return undefined;
          const performer = this.db.getPerformer(source.performerId);
          const username = usernameFromUrl(source.profileUrl);
          const metadata = candidate.metadata ?? {};
          return {
            id: source.id, username, title: candidate.title ?? performer?.name ?? username, pageUrl: candidate.pageUrl ?? source.profileUrl,
            thumbnailUrl: performer?.imageUrl, viewers: whole(metadata.viewers), gender: text(metadata.gender),
            tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
          } satisfies LiveCam;
        }));
        cams = discovered.filter(Boolean) as LiveCam[];
        if (query.search) {
          const needle = query.search.toLowerCase();
          cams = cams.filter((cam) => `${cam.username} ${cam.title ?? ""} ${(cam.tags ?? []).join(" ")}`.toLowerCase().includes(needle));
        }
        const requestedGender = query.gender;
        if (requestedGender) cams = cams.filter((cam) => cam.gender === requestedGender || cam.gender === requestedGender[0]);
        if (favoritesOnly) cams = cams.filter((cam) => this.db.isLiveCamFavorite(entry.manifest.id, cam.username));
        total = cams.length;
        cams = cams.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
      }
      const normalized = cams.filter((cam) => pluginMatchesSource(entry.manifest, cam.pageUrl))
        .map((cam) => ({ ...cam, providerId: entry.manifest.id, providerName: entry.manifest.name, favorite: this.db.isLiveCamFavorite(entry.manifest.id, cam.username) }));
      for (const cam of normalized) this.recentCams.set(`${entry.manifest.id}:${cam.id.toLowerCase()}`, { cam, expiresAt: Date.now() + 120_000 });
      return {
        items: normalized,
        total,
        status: { id: entry.manifest.id, name: entry.manifest.name, ok: true, count: total },
      };
    } catch (error) {
      return {
        items: [], total: 0,
        status: { id: entry.manifest.id, name: entry.manifest.name, ok: false, count: 0, error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private snapshot(
    query: LiveCamListQuery,
    entries: ReturnType<PluginManager["list"]>,
    results: Map<string, ProviderResult>,
    complete: boolean,
  ): LiveCamResult {
    const selected = query.providerId ? results.get(query.providerId) : undefined;
    const providerResults = query.providerId ? (selected ? [selected] : []) : [...results.values()];
    const unique = new Map<string, PublicLiveCam>();
    for (const cam of providerResults.flatMap((result) => result.items)) unique.set(`${cam.providerId}:${cam.username.toLowerCase()}`, cam);
    let ranked = [...unique.values()].sort((left, right) => whole(right.viewers) - whole(left.viewers) || left.username.localeCompare(right.username));
    if (!query.providerId) ranked = ranked.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    const total = providerResults.reduce((sum, result) => sum + result.total, 0);
    const providers = entries.map((entry) => results.get(entry.manifest.id)?.status ?? {
      id: entry.manifest.id, name: entry.manifest.name, ok: true, count: 0, pending: true,
    });
    return {
      items: ranked, total, page: query.page, pageSize: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)), providers, complete,
    };
  }

  async *stream(query: LiveCamListQuery, signal?: AbortSignal): AsyncGenerator<LiveCamResult> {
    const entries = this.livePlugins();
    const requestedItems = query.page * query.pageSize;
    const results = new Map<string, ProviderResult>();
    const pending = new Map<string, Promise<{ id: string; result: ProviderResult }>>();
    for (const entry of entries) {
      const selected = query.providerId === entry.manifest.id;
      const providerQuery = query.providerId && !selected
        ? { page: 1, pageSize: 1, search: query.search, gender: query.gender }
        : { page: selected ? query.page : 1, pageSize: selected ? query.pageSize : requestedItems, search: query.search, gender: query.gender };
      pending.set(entry.manifest.id, this.listProvider(entry, providerQuery, signal, query.favoritesOnly).then((result) => ({ id: entry.manifest.id, result })));
    }
    yield this.snapshot(query, entries, results, pending.size === 0);
    while (pending.size && !signal?.aborted) {
      const completed = await Promise.race(pending.values());
      pending.delete(completed.id);
      results.set(completed.id, completed.result);
      yield this.snapshot(query, entries, results, pending.size === 0);
    }
  }

  async list(query: LiveCamListQuery): Promise<LiveCamResult> {
    let latest: LiveCamResult | undefined;
    for await (const result of this.stream(query)) latest = result;
    return latest ?? { items: [], total: 0, page: query.page, pageSize: query.pageSize, pages: 1, providers: [], complete: true };
  }

  async get(providerId: string, camId: string): Promise<PublicLiveCam> {
    const entry = this.livePlugins(providerId)[0];
    if (!entry) throw Object.assign(new Error("The selected live-cam plugin is not installed"), { statusCode: 404 });
    const cached = this.recentCams.get(`${providerId}:${camId.toLowerCase()}`);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.cam, favorite: this.db.isLiveCamFavorite(providerId, cached.cam.username) };
    const result = await this.listProvider(entry, { page: 1, pageSize: 48, search: camId });
    if (!result.status.ok) throw Object.assign(new Error(result.status.error ?? "The live provider could not be reached"), { statusCode: 502 });
    const needle = camId.toLowerCase();
    const cam = result.items.find((item) => item.id.toLowerCase() === needle || item.username.toLowerCase() === needle);
    if (!cam) throw Object.assign(new Error("This cam is no longer live"), { statusCode: 404 });
    return cam;
  }

  listFavorites(): LiveCamFavorite[] {
    return this.db.listLiveCamFavorites();
  }

  setFavorite(providerId: string, cam: LiveCam, favorite: boolean): { favorite: boolean; item?: LiveCamFavorite } {
    const entry = this.livePlugins(providerId)[0];
    if (!entry) throw Object.assign(new Error("The selected live-cam plugin is not installed"), { statusCode: 404 });
    if (!pluginMatchesSource(entry.manifest, cam.pageUrl)) throw Object.assign(new Error(`${entry.manifest.name} does not support this live URL`), { statusCode: 400 });
    const item = this.db.setLiveCamFavorite(providerId, {
      camId: cam.id, username: cam.username, title: cam.title, pageUrl: cam.pageUrl, thumbnailUrl: cam.thumbnailUrl,
    }, favorite);
    const key = `${providerId}:${cam.id.toLowerCase()}`; const cached = this.recentCams.get(key);
    if (cached) cached.cam.favorite = favorite;
    return { favorite, ...(item ? { item } : {}) };
  }

  record(providerId: string, cam: LiveCam): { itemId: string; status: string } {
    const entry = this.livePlugins(providerId)[0];
    if (!entry) throw Object.assign(new Error("The selected live-cam plugin is not installed"), { statusCode: 404 });
    const plugin = this.plugins.get(providerId);
    if (!entry.manifest.capabilities.includes("download-resolver") || !plugin.resolveDownload) {
      throw Object.assign(new Error(`${entry.manifest.name} cannot record live streams`), { statusCode: 409 });
    }
    if (!pluginMatchesSource(entry.manifest, cam.pageUrl)) throw Object.assign(new Error(`${entry.manifest.name} does not support this live URL`), { statusCode: 400 });
    const username = cam.username.trim();
    const startedAt = new Date();
    const session = startedAt.toISOString().replace(/[:.]/g, "-");
    const externalId = `manual-live:${username.toLowerCase()}:${session}`;
    const safeName = username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
    const performer = this.db.upsertPerformer({ externalId: `live:${username.toLowerCase()}`, name: username, imageUrl: cam.thumbnailUrl }, providerId);
    const source = this.db.addSource(performer.id, providerId, {
      externalId: `live:${username.toLowerCase()}`, label: `${username} live`, profileUrl: cam.pageUrl, domain: new URL(cam.pageUrl).hostname.replace(/^www\./i, ""),
    });
    this.db.ingestItems(source, [{
      externalId, title: cam.title ?? `${username} live`, pageUrl: cam.pageUrl, mediaType: "video",
      publishedAt: startedAt.toISOString(), filename: `${safeName}-${session}.mp4`, metadata: { extractorUrl: cam.pageUrl, live: true },
    }]);
    const item = this.db.getItemBySourceExternalId(source.id, externalId);
    if (!item) throw new Error("The live recording could not be added to the download queue");
    const queued = this.db.setItemStatus(item.id, "queued", { progress: 0 });
    return { itemId: item.id, status: queued?.status ?? "queued" };
  }

  async resolve(providerId: string, cam: LiveCam): Promise<{ streamUrl: string }> {
    const entry = this.livePlugins(providerId)[0];
    if (!entry) throw Object.assign(new Error("The selected live-cam plugin is not installed"), { statusCode: 404 });
    const plugin = this.plugins.get(providerId);
    if (!plugin.resolveLiveStream) throw Object.assign(new Error(`${entry.manifest.name} cannot play live streams`), { statusCode: 409 });
    if (!pluginMatchesSource(entry.manifest, cam.pageUrl)) throw Object.assign(new Error(`${entry.manifest.name} does not support this live URL`), { statusCode: 400 });
    const stream = await plugin.resolveLiveStream(this.plugins.context(providerId), cam);
    return { streamUrl: this.registerProxy(stream) };
  }

  private registerProxy(stream: LiveStream): string {
    if (stream.audioUrl) {
      const videoUrl = this.proxyUrl(stream.url, stream.headers ?? {}, ".m3u8");
      const audioUrl = this.proxyUrl(stream.audioUrl, stream.headers ?? {}, ".m3u8");
      return this.proxyBody([
        "#EXTM3U", "#EXT-X-VERSION:6",
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUrl}"`,
        "#EXT-X-STREAM-INF:BANDWIDTH=6500000,AUDIO=\"audio\"", videoUrl, "",
      ].join("\n"), ".m3u8");
    }
    return this.proxyUrl(stream.url, stream.headers ?? {}, ".m3u8");
  }

  private proxyBody(body: string, suffix: string) {
    const token = randomBytes(24).toString("base64url");
    this.proxyEntries.set(token, { body, headers: {}, expiresAt: Date.now() + 15 * 60_000 });
    return `/api/live-cams/proxy/${token}${suffix}`;
  }

  private proxyUrl(url: string, headers: Record<string, string>, suffix = "") {
    this.pruneProxyEntries();
    const key = JSON.stringify([url, Object.entries(headers).sort(), suffix]);
    const existingToken = this.proxyReverse.get(key); const existing = existingToken ? this.proxyEntries.get(existingToken) : undefined;
    if (existing && existing.expiresAt > Date.now()) {
      existing.expiresAt = Date.now() + 15 * 60_000;
      return `/api/live-cams/proxy/${existingToken}${suffix}`;
    }
    const token = randomBytes(24).toString("base64url");
    this.proxyEntries.set(token, { url, headers, expiresAt: Date.now() + 15 * 60_000 });
    this.proxyReverse.set(key, token);
    return `/api/live-cams/proxy/${token}${suffix}`;
  }

  private pruneProxyEntries() {
    const now = Date.now();
    for (const [token, entry] of this.proxyEntries) if (entry.expiresAt <= now) this.proxyEntries.delete(token);
    for (const [key, token] of this.proxyReverse) if (!this.proxyEntries.has(token)) this.proxyReverse.delete(key);
  }

  private rewritePlaylist(body: string, sourceUrl: string, headers: Record<string, string>) {
    const proxied = (raw: string) => {
      const absolute = new URL(raw, sourceUrl).toString();
      let suffix = "";
      try { const ext = new URL(absolute).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0]; if (ext) suffix = ext; } catch { /* Keep the token extensionless. */ }
      return this.proxyUrl(absolute, headers, suffix);
    };
    return body.split(/\r?\n/).map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return proxied(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxied(uri)}"`);
    }).join("\n");
  }

  async proxy(tokenPath: string, reply: FastifyReply, query: Record<string, unknown> = {}, range?: string) {
    const token = tokenPath.split(".", 1)[0];
    const entry = this.proxyEntries.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.proxyEntries.delete(token); return reply.status(404).send({ error: "Live stream link expired" });
    }
    entry.expiresAt = Date.now() + 15 * 60_000;
    if (entry.body !== undefined) return reply.type("application/vnd.apple.mpegurl").header("cache-control", "no-store").send(entry.body);
    const sourceUrl = new URL(entry.url!);
    for (const key of ["_HLS_msn", "_HLS_part", "_HLS_skip"]) {
      const value = text(query[key]); if (value) sourceUrl.searchParams.set(key, value);
    }
    const response = await this.request(sourceUrl, { headers: { ...entry.headers, ...(range ? { range } : {}) }, signal: AbortSignal.timeout(25_000) });
    if (!response.ok) return reply.status(response.status).send({ error: `Live provider returned HTTP ${response.status}` });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    const playlist = contentType.includes("mpegurl") || buffer.subarray(0, 7).toString() === "#EXTM3U";
    reply.status(response.status).type(playlist ? "application/vnd.apple.mpegurl" : contentType).header("cache-control", "no-store");
    const contentRange = response.headers.get("content-range"); const acceptRanges = response.headers.get("accept-ranges");
    if (contentRange) reply.header("content-range", contentRange); if (acceptRanges) reply.header("accept-ranges", acceptRanges);
    return reply.send(playlist ? this.rewritePlaylist(buffer.toString("utf8"), response.url, entry.headers) : buffer);
  }
}
