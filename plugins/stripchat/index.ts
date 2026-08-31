import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import { accountSignal, cookieHeader, readAccountCookies } from "../account-cookies.js";
import { browserHtml } from "../browser-html-utils.js";
import { stripchatFavoriteCams, stripchatProfileLiveCams, stripchatStreamConfig } from "../live-cam-discovery.js";
import type { CommandDownloadRequest, LiveCam, LiveCamFavoriteSnapshot, LiveStream, MediaCandidate, MediaSource, PluginContext } from "../../packages/plugin-sdk/index.js";

const plugin = createLiveCamPlugin({
  id: "org.easyx.stripchat", name: "Stripchat Live", prefix: "stripchat", homepage: "https://stripchat.com",
  discovery: "stripchat",
  description: "Check a public Stripchat room and play or record its active live stream with yt-dlp and FFmpeg.",
  sourceUrlPatterns: ["http://stripchat.com/*", "https://stripchat.com/*", "http://www.stripchat.com/*", "https://www.stripchat.com/*"],
  cookieDomains: ["stripchat.com"], loginUrl: "https://stripchat.com/login", minimumIntervalSeconds: 5, defaultIntervalSeconds: 10,
});

const genericResolveLiveStream = plugin.resolveLiveStream!;
const genericTestConnection = plugin.testConnection!;
const PLAYBACK_KEY_PATTERN = /\.set\(\s*["']pkey["']\s*,\s*["']([a-z0-9_-]{12,128})["']\s*\)/i;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36";
const MAX_FAVORITES = 5_000;

type StripchatAccount = { cookies: Map<string, string>; userId: number; frontVersion: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function balancedObject(value: string, from: number): string | undefined {
  const start = value.indexOf("{", from); if (start < 0) return undefined;
  let depth = 0; let quoted = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted && character === "\\") { index += 1; continue; }
    if (character === "\"") quoted = !quoted;
    else if (!quoted && character === "{") depth += 1;
    else if (!quoted && character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return undefined;
}

function findCurrentUser(value: unknown): Record<string, unknown> | undefined {
  const item = record(value);
  if (item) {
    if (Number.isInteger(Number(item.id)) && Number(item.id) > 0 && (typeof item.username === "string" || typeof item.login === "string")) return item;
    for (const key of ["currentUser", "current_user"]) {
      const current = record(item[key]);
      if (current && Number.isInteger(Number(current.id)) && Number(current.id) > 0) return current;
    }
    for (const child of Object.values(item)) { const found = findCurrentUser(child); if (found) return found; }
  } else if (Array.isArray(value)) {
    for (const child of value) { const found = findCurrentUser(child); if (found) return found; }
  }
  return undefined;
}

function apiHeaders(account: StripchatAccount, referer = "https://stripchat.com/favorites", hasBody = false): Record<string, string> {
  return {
    accept: "application/json", "accept-language": "en-US,en;q=0.8", cookie: cookieHeader(account.cookies),
    origin: "https://stripchat.com", referer, "front-version": account.frontVersion, "user-agent": USER_AGENT,
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

async function stripchatAccount(context: PluginContext): Promise<StripchatAccount | undefined> {
  const cookies = readAccountCookies(context, "stripchat.com", "Stripchat");
  if (!cookies) return undefined;
  const response = await context.fetch("https://stripchat.com/favorites", {
    headers: { cookie: cookieHeader(cookies), "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "manual", signal: accountSignal(context),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("The Stripchat session redirected to login. Reconnect the account.");
  if (!response.ok) throw new Error(`The Stripchat account session could not be verified (HTTP ${response.status})`);
  const html = await response.text();
  const marker = html.indexOf("window.__PRELOADED_STATE__");
  const rawState = marker >= 0 ? balancedObject(html, marker) : undefined;
  let state: unknown;
  try { state = rawState ? JSON.parse(rawState) : undefined; } catch { state = undefined; }
  const frontVersion = html.match(/"releaseVersion"\s*:\s*"([^"]+)"/)?.[1] ?? "11.7.28";
  let user = findCurrentUser(state);
  if (!user) {
    const configResponse = await context.fetch("https://stripchat.com/api/front/v3/config/initial-dynamic?requestPath=%2Ffavorites", {
      headers: {
        accept: "application/json", "accept-language": "en-US,en;q=0.8", cookie: cookieHeader(cookies),
        origin: "https://stripchat.com", referer: "https://stripchat.com/favorites", "front-version": frontVersion, "user-agent": USER_AGENT,
      },
      redirect: "manual", signal: accountSignal(context),
    });
    if (configResponse.status === 401 || configResponse.status === 403) throw new Error("The Stripchat session is expired. Reconnect the account.");
    if (!configResponse.ok) throw new Error(`Stripchat could not verify the connected account (HTTP ${configResponse.status})`);
    let config: unknown;
    try { config = await configResponse.json(); } catch { throw new Error("Stripchat returned an invalid account response"); }
    user = findCurrentUser(config);
  }
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Stripchat did not identify the connected account. Open Favorites after signing in, then capture the session again.");
  return { cookies, userId, frontVersion };
}

async function stripchatApi(context: PluginContext, account: StripchatAccount, method: string, path: string, options: { params?: URLSearchParams; body?: unknown; referer?: string } = {}): Promise<unknown> {
  const url = new URL(`https://stripchat.com/api/front${path.startsWith("/") ? path : `/${path}`}`);
  if (options.params) url.search = options.params.toString();
  const response = await context.fetch(url, {
    method, headers: apiHeaders(account, options.referer, options.body !== undefined),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: "manual", signal: accountSignal(context),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error("The Stripchat session is expired or was refused. Reconnect the account.");
  }
  if (!response.ok) throw new Error(`Stripchat API returned HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { throw new Error("Stripchat returned an invalid favorites response"); }
}

async function stripchatFavoriteIds(context: PluginContext, account: StripchatAccount): Promise<number[]> {
  const payload = await stripchatApi(context, account, "GET", `/users/${account.userId}/favorites`);
  const rawIds = record(payload)?.modelIds;
  if (!Array.isArray(rawIds)) throw new Error("Stripchat returned an invalid followed ID list");
  const ids = rawIds.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error("Stripchat returned an invalid followed model ID");
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new Error("Stripchat returned duplicate followed model IDs");
  if (unique.length > MAX_FAVORITES) throw new Error("The Stripchat followed list exceeded its safety limit");
  return unique;
}

async function favoriteSnapshot(context: PluginContext, account: StripchatAccount): Promise<LiveCamFavoriteSnapshot> {
  const ids = await stripchatFavoriteIds(context, account);
  const unique = new Map<string, LiveCam & { online: boolean }>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const payload = await stripchatApi(context, account, "GET", "/models/list", {
      params: new URLSearchParams({ modelIds: chunk.join(",") }),
    });
    for (const cam of stripchatFavoriteCams(payload)) unique.set(cam.username.toLowerCase(), cam);
  }
  return { cams: [...unique.values()], authoritative: true };
}

export async function stripchatFollowedSnapshot(context: PluginContext): Promise<LiveCamFavoriteSnapshot> {
  let account: StripchatAccount | undefined;
  try { account = await stripchatAccount(context); }
  catch (error) { return { cams: [], authoritative: false, skippedReason: error instanceof Error ? error.message : String(error) }; }
  if (!account) return { cams: [], authoritative: false, skippedReason: "Connect a Stripchat account to synchronize followed creators." };
  try { return await favoriteSnapshot(context, account); }
  catch (error) {
    const skippedReason = error instanceof Error ? error.message : String(error);
    context.log("warn", "Stripchat favorite synchronization skipped", { reason: skippedReason });
    return { cams: [], authoritative: false, skippedReason };
  }
}

function findModel(value: unknown, username: string): Record<string, unknown> | undefined {
  const item = record(value);
  if (item) {
    if (String(item.username ?? item.login ?? "").toLowerCase() === username.toLowerCase() && (item.id !== undefined || item.streamName !== undefined)) return item;
    for (const child of Object.values(item)) { const found = findModel(child, username); if (found) return found; }
  } else if (Array.isArray(value)) {
    for (const child of value) { const found = findModel(child, username); if (found) return found; }
  }
  return undefined;
}

export async function setStripchatFavorite(context: PluginContext, cam: LiveCam, favorite: boolean): Promise<{ synchronized: boolean }> {
  const account = await stripchatAccount(context);
  if (!account) return { synchronized: false };
  if (!/^[a-z0-9_.-]{2,64}$/i.test(cam.username)) throw new Error("Stripchat received an invalid room name");
  let modelId = 0;
  const followedIds = await stripchatFavoriteIds(context, account);
  for (let offset = 0; offset < followedIds.length && !modelId; offset += 100) {
    const payload = await stripchatApi(context, account, "GET", "/models/list", {
      params: new URLSearchParams({ modelIds: followedIds.slice(offset, offset + 100).join(",") }),
    });
    const followedModel = findModel(payload, cam.username);
    const followedModelId = Number(followedModel?.id ?? followedModel?.streamName);
    if (Number.isInteger(followedModelId) && followedModelId > 0) modelId = followedModelId;
  }
  if ((modelId > 0) === favorite) return { synchronized: true };
  let browserFallback = false;
  try {
    if (!modelId) {
      const profile = await stripchatApi(context, account, "GET", `/v2/models/username/${encodeURIComponent(cam.username)}/cam`, { referer: cam.pageUrl });
      const model = findModel(profile, cam.username);
      modelId = Number(model?.id ?? model?.streamName);
    }
    if (!Number.isInteger(modelId) || modelId <= 0) throw new Error(`Stripchat could not identify ${cam.username}`);
    if (favorite) {
      await stripchatApi(context, account, "PUT", `/users/${account.userId}/favorites/${modelId}`, { body: { uniq: Date.now() }, referer: cam.pageUrl });
    } else {
      await stripchatApi(context, account, "DELETE", `/users/${account.userId}/favorites`, { body: { favoriteIds: [modelId], uniq: Date.now() }, referer: cam.pageUrl });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("HTTP 418")) throw error;
    browserFallback = true;
  }
  if (browserFallback) {
    const cookiesFile = typeof context.config.cookiesFile === "string" ? context.config.cookiesFile.trim() : "";
    if (!cookiesFile) throw new Error("The Stripchat browser session is unavailable");
    const result = await context.runCommand("easyx-browser-fetch", [
      "--stripchat-favorite", cam.pageUrl, cookiesFile, String(modelId), favorite ? "follow" : "unfollow",
    ], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Stripchat could not ${favorite ? "follow" : "unfollow"} ${cam.username}`);
    let browserResult: unknown;
    try { browserResult = JSON.parse(result.stdout); } catch { browserResult = undefined; }
    const browserValue = record(browserResult);
    if (!browserValue?.success) throw new Error(`Stripchat could not ${favorite ? "follow" : "unfollow"} ${cam.username}`);
    const browserModelId = Number(browserValue.modelId);
    if ((!Number.isInteger(modelId) || modelId <= 0) && Number.isInteger(browserModelId) && browserModelId > 0) modelId = browserModelId;
  }
  if (!Number.isInteger(modelId) || modelId <= 0) throw new Error(`Stripchat could not identify ${cam.username}`);
  let followed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    followed = (await stripchatFavoriteIds(context, account)).includes(modelId);
    if (followed === favorite) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (followed !== favorite) throw new Error(`Stripchat did not confirm that ${cam.username} was ${favorite ? "followed" : "unfollowed"}`);
  return { synchronized: true };
}

export function stripchatPublicPlaybackKey(playerSource: string): string | undefined {
  return playerSource.match(PLAYBACK_KEY_PATTERN)?.[1];
}

function playlistUrls(manifest: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const line of manifest.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(value)) continue;
    try { urls.push(new URL(value, baseUrl).toString()); } catch { /* Ignore malformed variants. */ }
  }
  return urls;
}

function isLivePlaylist(manifest: string): boolean {
  return manifest.trimStart().startsWith("#EXTM3U")
    && !manifest.includes("#EXT-X-MOUFLON-ADVERT")
    && (manifest.includes("#EXT-X-MEDIA-SEQUENCE:") || manifest.includes("#EXT-X-PART:"));
}

type ResolvedStripchatHls = { masterUrl: string; mediaUrl: string; headers: Record<string, string> };

async function resolveStripchatHls(context: PluginContext, pageUrl: string): Promise<ResolvedStripchatHls> {
  const stream = stripchatStreamConfig(await browserHtml(context, pageUrl));
  if (!stream?.domains.length) throw new Error("The public room did not expose an HLS host");
  if (!stream.playerScriptUrl) throw new Error("The public room did not expose its player module");
  const headers = { referer: "https://stripchat.com/", origin: "https://stripchat.com" };
  const playerResponse = await context.fetch(stream.playerScriptUrl, { headers, signal: context.signal ?? AbortSignal.timeout(15_000) });
  if (!playerResponse.ok) throw new Error(`Stripchat player module returned HTTP ${playerResponse.status}`);
  const playbackKey = stripchatPublicPlaybackKey(await playerResponse.text());
  if (!playbackKey) throw new Error("Stripchat player module did not expose a public playback key");

  for (const domain of stream.domains) {
    const master = new URL(`https://edge-hls.${domain}/hls/${encodeURIComponent(stream.modelId)}/master/${encodeURIComponent(stream.modelId)}_auto.m3u8`);
    master.searchParams.set("pkey", playbackKey);
    try {
      const response = await context.fetch(master, { headers, signal: context.signal ?? AbortSignal.timeout(15_000) });
      if (!response.ok) continue;
      const manifest = await response.text();
      if (!manifest.trimStart().startsWith("#EXTM3U") || manifest.includes("#EXT-X-MOUFLON-ADVERT")) continue;
      for (const candidate of playlistUrls(manifest, master.toString())) {
        const variant = new URL(candidate);
        if (!variant.searchParams.has("pkey")) variant.searchParams.set("pkey", playbackKey);
        const variantResponse = await context.fetch(variant, { headers, signal: context.signal ?? AbortSignal.timeout(15_000) });
        if (variantResponse.ok && isLivePlaylist(await variantResponse.text())) {
          return { masterUrl: master.toString(), mediaUrl: variant.toString(), headers };
        }
      }
    } catch { /* Try the next CDN host. */ }
  }
  throw new Error("No public Stripchat HLS host returned a live manifest");
}

export async function resolveStripchatDirect(context: PluginContext, pageUrl: string): Promise<LiveStream> {
  const stream = await resolveStripchatHls(context, pageUrl);
  return { url: stream.masterUrl, headers: stream.headers, contentType: "application/vnd.apple.mpegurl" };
}

export async function resolveStripchatDownload(context: PluginContext, item: MediaCandidate): Promise<CommandDownloadRequest> {
  if (!item.pageUrl) throw new Error("Stripchat recording is missing its public room URL");
  const stream = await resolveStripchatHls(context, item.pageUrl);
  const headerLines = Object.entries(stream.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
  return {
    kind: "command", command: "ffmpeg", filename: item.filename ?? "stripchat-live.mp4",
    args: [
      "-hide_banner", "-loglevel", "warning", "-headers", `${headerLines}\r\n`, "-i", stream.mediaUrl,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", "{output}",
    ],
  };
}

export async function listStripchatMedia(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]> {
  const username = new URL(source.profileUrl).pathname.split("/").filter(Boolean).at(-1)?.replace(/^@/, "") ?? "live";
  const cam = stripchatProfileLiveCams(await browserHtml(context, source.profileUrl), username)[0];
  if (!cam) return [];
  const safeName = cam.username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  return [{
    externalId: `stripchat:${cam.username.toLowerCase()}:live`,
    title: cam.title ?? `${cam.username} live`, pageUrl: cam.pageUrl, mediaType: "video", filename: `${safeName}-live.mp4`,
    metadata: { extractorUrl: cam.pageUrl, live: true, viewers: cam.viewers, gender: cam.gender, tags: cam.tags ?? [] },
  }];
}

plugin.resolveLiveStream = async (context, cam) => {
  try {
    return await resolveStripchatDirect(context, cam.pageUrl);
  } catch (error) {
    context.log("debug", "Stripchat direct HLS resolution failed; trying generic extraction", error instanceof Error ? error.message : String(error));
    return genericResolveLiveStream(context, cam);
  }
};
plugin.resolveDownload = resolveStripchatDownload;
plugin.listMedia = listStripchatMedia;
plugin.testConnection = async (context) => {
  const extractor = await genericTestConnection(context);
  if (!extractor.ok || !context.config.cookiesFile) return extractor;
  try {
    const account = await stripchatAccount(context);
    if (!account) return { ok: false, message: "Connect a Stripchat account in the integrated browser." };
    return { ok: true, message: `${extractor.message} Stripchat account session verified.` };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
};
plugin.listFollowedLiveCams = stripchatFollowedSnapshot;
plugin.setLiveCamFavorite = setStripchatFavorite;

export default plugin;
