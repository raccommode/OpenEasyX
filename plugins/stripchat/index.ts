import { LIVE_RECORDER_SCRIPT, retryDelay } from "../live-recorder.js";
import { orderVariantsForRecording, parseHlsVariants, recordingMaxHeight } from "../hls-quality.js";
import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import { accountSignal, cookieHeader, readAccountCookies } from "../account-cookies.js";
import { browserHtml } from "../browser-html-utils.js";
import { stripchatFavoriteCams, stripchatProfileLiveCams, stripchatStreamConfig } from "../live-cam-discovery.js";
import type { CommandDownloadRequest, LiveCam, LiveCamFavoriteSnapshot, LiveStream, MediaCandidate, MediaSource, PerformerRecord, PersonCandidate, PluginContext, SourceCandidate } from "../../packages/plugin-sdk/index.js";

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
  let browserFallback = false;
  try {
    if (!modelId) {
      const profile = await stripchatApi(context, account, "GET", `/v2/models/username/${encodeURIComponent(cam.username)}/cam`, { referer: cam.pageUrl });
      const model = findModel(profile, cam.username);
      modelId = Number(model?.id ?? model?.streamName);
    }
    if (!Number.isInteger(modelId) || modelId <= 0) throw new Error(`Stripchat could not identify ${cam.username}`);
    if (followedIds.includes(modelId) === favorite) return { synchronized: true };
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

/** Variant URLs in recording preference order: manifest order (highest first) or the best at or below maxHeight. */
export function stripchatVariantUrls(manifest: string, baseUrl: string, maxHeight = 0): string[] {
  const variants = parseHlsVariants(manifest, baseUrl);
  return (maxHeight ? orderVariantsForRecording(variants, maxHeight) : variants).map((variant) => variant.url);
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
  const maxHeight = recordingMaxHeight(context.config);
  if (!playbackKey) throw new Error("Stripchat player module did not expose a public playback key");

  for (const domain of stream.domains) {
    const master = new URL(`https://edge-hls.${domain}/hls/${encodeURIComponent(stream.modelId)}/master/${encodeURIComponent(stream.modelId)}_auto.m3u8`);
    master.searchParams.set("pkey", playbackKey);
    try {
      const response = await context.fetch(master, { headers, signal: context.signal ?? AbortSignal.timeout(15_000) });
      if (!response.ok) continue;
      const manifest = await response.text();
      if (!manifest.trimStart().startsWith("#EXTM3U") || manifest.includes("#EXT-X-MOUFLON-ADVERT")) continue;
      for (const candidate of stripchatVariantUrls(manifest, master.toString(), maxHeight)) {
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

// A room that has just (re)started often needs a few seconds before its public HLS
// manifest is available. Retry briefly instead of failing the recording at once.
const STRIPCHAT_HLS_ATTEMPTS = 4;
const STRIPCHAT_HLS_RETRY_MS = 10_000;
async function resolveStripchatHlsWithRetry(context: PluginContext, pageUrl: string): Promise<ResolvedStripchatHls> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STRIPCHAT_HLS_ATTEMPTS; attempt += 1) {
    context.signal?.throwIfAborted();
    try { return await resolveStripchatHls(context, pageUrl); }
    catch (error) {
      lastError = error;
      if (attempt === STRIPCHAT_HLS_ATTEMPTS || context.signal?.aborted) break;
      context.log("debug", `Stripchat HLS not ready (attempt ${attempt}/${STRIPCHAT_HLS_ATTEMPTS}); retrying`, error instanceof Error ? error.message : String(error));
      await retryDelay(STRIPCHAT_HLS_RETRY_MS, context.signal);
    }
  }
  throw lastError;
}

/*
 * Continuous recording across short breaks.
 *
 * A Stripchat room that goes private, into a group show or briefly offline stops
 * its public HLS stream, which used to end the recording; every return then became
 * a separate video. The recording now runs through a small wrapper: each public
 * stretch is recorded as a part, and when the stream stops the wrapper keeps
 * polling the same public manifest for up to STRIPCHAT_MERGE_GAP_MINUTES (default
 * 10). If the room comes back in time, recording continues with a new part; when
 * the gap runs out (or the recording is stopped) all parts are joined into one
 * video. While the wrapper waits, the item stays "downloading", so the session
 * source scanner keeps the same session and no second recording is queued.
 */
const mergeGapMinutes = Number(process.env.STRIPCHAT_MERGE_GAP_MINUTES ?? 10);
const STRIPCHAT_MERGE_GAP_MS = Number.isFinite(mergeGapMinutes) && mergeGapMinutes > 0 ? mergeGapMinutes * 60_000 : 0;
const STRIPCHAT_MERGE_POLL_MS = 20_000;

/** Standalone recorder run with `node -e`; it must not contain the server's output placeholders. */

export async function resolveStripchatDownload(context: PluginContext, item: MediaCandidate): Promise<CommandDownloadRequest> {
  if (!item.pageUrl) throw new Error("Stripchat recording is missing its public room URL");
  const stream = await resolveStripchatHlsWithRetry(context, item.pageUrl);
  return {
    kind: "command", command: process.execPath, requireSuccessfulExit: true, filename: item.filename ?? "stripchat-live.mp4",
    args: [
      "-e", LIVE_RECORDER_SCRIPT, stream.mediaUrl, stream.masterUrl, JSON.stringify(stream.headers), "{output}",
      String(STRIPCHAT_MERGE_GAP_MS), String(STRIPCHAT_MERGE_POLL_MS), USER_AGENT,
    ],
  };
}

/** Room status from the profile page, e.g. "public", "private", "p2p", "groupShow", "idle", "off". */
export function stripchatRoomStatus(html: string): string | undefined {
  const marker = html.indexOf("window.__PRELOADED_STATE__");
  const start = marker >= 0 ? html.indexOf("{", marker) : -1;
  if (start < 0) return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try {
        const state = JSON.parse(html.slice(start, index + 1));
        const status = state?.viewCam?.model?.status;
        return typeof status === "string" && status.trim() ? status.trim().toLowerCase() : undefined;
      } catch { return undefined; }
    }
  }
  return undefined;
}

// Only statuses known to have no public stream; anything unknown is still recorded.
const STRIPCHAT_NON_PUBLIC_STATUSES = new Set(["private", "p2p", "groupshow", "virtualprivate", "idle", "off", "offline"]);

export async function listStripchatMedia(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]> {
  const username = new URL(source.profileUrl).pathname.split("/").filter(Boolean).at(-1)?.replace(/^@/, "") ?? "live";
  const html = await browserHtml(context, source.profileUrl);
  const cam = stripchatProfileLiveCams(html, username)[0];
  if (!cam) { return []; }
  // "Online" is not enough: in a private, group or away state there is no public
  // stream, so a recording would fail. Treat it as offline; when the room returns
  // to a public show a new session (and recording) starts.
  const status = stripchatRoomStatus(html);
  if (status && STRIPCHAT_NON_PUBLIC_STATUSES.has(status)) {
    context.log("debug", `Stripchat room ${cam.username} is online but not public (${status}); not recording`);
    return [];
  }
  const safeName = cam.username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  return [{
    externalId: `stripchat:${cam.username.toLowerCase()}:live`,
    title: `${cam.username} live`, pageUrl: cam.pageUrl, mediaType: "video",
    filename: `${safeName}-live.mp4`,
    metadata: { extractorUrl: cam.pageUrl, live: true, viewers: cam.viewers, gender: cam.gender, tags: cam.tags ?? [], roomTitle: cam.title, status },
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

/*
 * Performer search ("Find a performer").
 *
 * Stripchat has no public name search, so this looks up exact usernames: the text
 * as typed and, for multi-word input, the words joined with nothing, "_" and "-"
 * ("Jane Doe" -> JaneDoe, Jane_Doe, Jane-Doe). Every result is a model confirmed
 * by its Stripchat profile page; the user reviews and picks one. Picking it stores the Stripchat username
 * on the performer, and source discovery then adds exactly that room as a source.
 */
const STRIPCHAT_USERNAME = /^[A-Za-z0-9_-]{3,40}$/;

export function stripchatSearchUsernames(query: string): string[] {
  let text = query.trim();
  try { if (/^https?:\/\//i.test(text)) text = new URL(text).pathname.split("/").filter(Boolean).at(-1) ?? ""; } catch { return []; }
  text = text.replace(/^@/, "");
  const words = text.split(/\s+/).filter(Boolean);
  const names = words.length > 1 ? [words.join(""), words.join("_"), words.join("-")] : [text];
  return [...new Map(names.filter((name) => STRIPCHAT_USERNAME.test(name)).map((name) => [name.toLowerCase(), name])).values()];
}

type StripchatModel = { username: string; avatarUrl?: string; online?: boolean; gender?: string; country?: string; renamedFrom?: string };

const textValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Stripchat blocks its JSON API for server requests (HTTP 403 plain, 418 even with
 * a Chrome fingerprint), but serves the public profile page through the browser-
 * compatible helper of the EasyX image, the same page the plugin loads to record.
 * That page embeds window.__PRELOADED_STATE__, which describes the model whether
 * the room is online or not.
 */
function preloadedState(html: string): unknown {
  const marker = html.indexOf("window.__PRELOADED_STATE__");
  if (marker < 0) return undefined;
  const start = html.indexOf("{", marker);
  if (start < 0) return undefined;
  let depth = 0; let quoted = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quoted && character === "\\") { index += 1; continue; }
    if (character === "\"") quoted = !quoted;
    else if (!quoted && character === "{") depth += 1;
    else if (!quoted && character === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

/** Model objects in the page state with exactly this username (any nesting depth). */
export function stripchatModelsInState(state: unknown, username: string): Record<string, any>[] {
  const wanted = username.toLowerCase();
  const found: Record<string, any>[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const item = value as Record<string, any>;
    const name = textValue(item.username) ?? textValue(item.login);
    if (name?.toLowerCase() === wanted && (item.id !== undefined || item.isModel !== undefined)) found.push(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(state, 0);
  // Model records first, then the ones with the most detail.
  return found.sort((left, right) => Number(right.isModel === true) - Number(left.isModel === true) || Object.keys(right).length - Object.keys(left).length);
}

export function stripchatModelFromPage(html: string, username: string): StripchatModel | undefined {
  const models = stripchatModelsInState(preloadedState(html), username);
  const state = preloadedState(html) as { viewCam?: { model?: Record<string, unknown> } } | undefined;
  const roomModel = state?.viewCam?.model;
  const confirmed = models.some((item) => item.isModel === true)
    || (roomModel && roomModel.isModel !== false && String(roomModel.username ?? roomModel.login ?? "").toLowerCase() === username.toLowerCase());
  if (!models.length || !confirmed) return undefined;
  const pick = (key: string) => models.map((item) => textValue(item[key])).find(Boolean);
  return {
    username: pick("username") ?? pick("login") ?? username,
    avatarUrl: pick("avatarUrl") ?? pick("previewUrlThumbSmall") ?? pick("previewUrl"),
    online: models.some((item) => item.isLive === true || item.isOnline === true) ? true
      : models.some((item) => item.isLive === false || item.isOnline === false) ? false : undefined,
    gender: pick("gender"), country: pick("country"),
  };
}

/** Exact username lookup (online or offline) via the public profile page. Undefined when there is no such model. */
export async function stripchatModelByUsername(context: PluginContext, username: string): Promise<StripchatModel | undefined> {
  let html: string;
  try {
    html = await browserHtml(context, `https://stripchat.com/${encodeURIComponent(username)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 404/.test(message)) return undefined;
    throw new Error(`Stripchat profile lookup for ${username} failed: ${message}`);
  }
  return stripchatModelFromPage(html, username);
}

function personFromModel(model: StripchatModel): PersonCandidate {
  const profileUrl = `https://stripchat.com/${encodeURIComponent(model.username)}`;
  return {
    externalId: model.username.toLowerCase(), name: model.username,
    ...(model.renamedFrom ? { aliases: [model.renamedFrom] } : {}),
    ...(model.avatarUrl ? { imageUrl: model.avatarUrl } : {}),
    profileUrls: [profileUrl],
    metadata: { site: "stripchat.com", ...(model.online !== undefined ? { online: model.online } : {}), ...(model.gender ? { gender: model.gender } : {}), ...(model.country ? { country: model.country } : {}), ...(model.renamedFrom ? { renamedFrom: model.renamedFrom } : {}) },
  };
}

export async function searchStripchatPeople(context: PluginContext, query: string): Promise<PersonCandidate[]> {
  const results = new Map<string, PersonCandidate>();
  let firstError: unknown;
  for (const username of stripchatSearchUsernames(query)) {
    try {
      const model = await stripchatModelByUsername(context, username);
      if (model) results.set(model.username.toLowerCase(), personFromModel(model));
    } catch (error) { context.signal?.throwIfAborted(); firstError ??= error; }
  }
  if (!results.size && firstError) throw firstError instanceof Error ? firstError : new Error(String(firstError));
  return [...results.values()];
}

/** Adds the Stripchat room of a performer picked in "Find a performer" (or linked to Stripchat before). */
export async function discoverStripchatSources(_context: PluginContext, performer: PerformerRecord): Promise<SourceCandidate[]> {
  const linked = textValue(performer.externalRefs?.["org.easyx.stripchat"]);
  const found = linked ? stripchatSearchUsernames(linked.replace(/^live:/i, ""))[0] : undefined;
  if (!found) return [];
  // Prefer the spelling of the performer name (the stored reference is lower case).
  const username = performer.name.toLowerCase() === found.toLowerCase() ? performer.name : found;
  const profileUrl = `https://stripchat.com/${encodeURIComponent(username)}`;
  // Same external ID as a source added by hand (its profile URL), so nothing is added twice.
  return [{ externalId: profileUrl, label: "stripchat.com", profileUrl, domain: "stripchat.com" }];
}

plugin.manifest.capabilities = [...new Set([...plugin.manifest.capabilities, "identity-search" as const, "source-discovery" as const])];
plugin.searchPeople = searchStripchatPeople;
plugin.discoverSources = discoverStripchatSources;

export default plugin;
