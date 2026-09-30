import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
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

// A room that has just (re)started often needs a few seconds before its public HLS
// manifest is available. Retry briefly instead of failing the recording at once.
const STRIPCHAT_HLS_ATTEMPTS = 4;
const STRIPCHAT_HLS_RETRY_MS = 10_000;
async function resolveStripchatHlsWithRetry(context: PluginContext, pageUrl: string): Promise<ResolvedStripchatHls> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STRIPCHAT_HLS_ATTEMPTS; attempt += 1) {
    try { return await resolveStripchatHls(context, pageUrl); }
    catch (error) {
      lastError = error;
      if (attempt === STRIPCHAT_HLS_ATTEMPTS || context.signal?.aborted) break;
      context.log("debug", `Stripchat HLS not ready (attempt ${attempt}/${STRIPCHAT_HLS_ATTEMPTS}); retrying`, error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, STRIPCHAT_HLS_RETRY_MS));
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
 * logic below keeps the same session and no second recording is queued.
 */
const mergeGapMinutes = Number(process.env.STRIPCHAT_MERGE_GAP_MINUTES ?? 10);
const STRIPCHAT_MERGE_GAP_MS = Number.isFinite(mergeGapMinutes) && mergeGapMinutes > 0 ? mergeGapMinutes * 60_000 : 0;
const STRIPCHAT_MERGE_POLL_MS = 20_000;

/** Standalone recorder run with `node -e`; it must not contain the server's output placeholders. */
export const STRIPCHAT_RECORDER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [mediaUrl, masterUrl, headersJson, output, gapArg, pollArg, userAgent] = process.argv.slice(1);
const headers = JSON.parse(headersJson);
const gapMs = Number(gapArg) || 0;
const pollMs = Number(pollArg) || 20000;
const partsDir = path.join(path.dirname(output), "stripchat-parts");
fs.rmSync(partsDir, { recursive: true, force: true });
fs.mkdirSync(partsDir, { recursive: true });
let stopping = false, cancelled = false, child, wake = () => {};
const say = (text) => process.stderr.write("[stripchat-recorder] " + text + "\n");
process.on("SIGINT", () => { stopping = true; child?.kill("SIGINT"); wake(); });
process.on("SIGTERM", () => { stopping = true; cancelled = true; child?.kill("SIGKILL"); wake(); });
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
const run = (args) => new Promise((resolve) => {
  child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  child.once("error", () => { child = undefined; resolve(-1); });
  child.once("close", (code) => { child = undefined; resolve(code); });
});
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const isLive = (text) => text.trimStart().startsWith("#EXTM3U") && !text.includes("#EXT-X-MOUFLON-ADVERT")
  && (text.includes("#EXT-X-MEDIA-SEQUENCE:") || text.includes("#EXT-X-PART:"));
async function get(url) {
  const response = await fetch(url, { headers: { ...headers, "user-agent": userAgent }, signal: AbortSignal.timeout(15000) });
  return response.ok ? response.text() : undefined;
}
async function variants() {
  const text = await get(masterUrl);
  if (!text || !text.trimStart().startsWith("#EXTM3U") || text.includes("#EXT-X-MOUFLON-ADVERT")) return [];
  const pkey = new URL(masterUrl).searchParams.get("pkey");
  const list = []; let info = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) { info = line; continue; }
    if (!line || line.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(line)) continue;
    const url = new URL(line, masterUrl);
    if (pkey && !url.searchParams.has("pkey")) url.searchParams.set("pkey", pkey);
    list.push({ url: url.toString(), resolution: (info.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || "" });
    info = "";
  }
  return list;
}
async function liveVariant(resolution) {
  const list = await variants();
  const ordered = resolution ? list.filter((item) => item.resolution === resolution) : list;
  for (const item of ordered) {
    try { const text = await get(item.url); if (text && isLive(text)) return item; } catch {}
  }
  if (!resolution || ordered.length) return undefined;
  for (const item of list) {
    try { const text = await get(item.url); if (text && isLive(text)) return { url: "", resolution: "changed" }; } catch {}
  }
  return undefined;
}
(async () => {
  const parts = [];
  let url = mediaUrl, resolution;
  while (!stopping) {
    const part = path.join(partsDir, "part-" + String(parts.length + 1).padStart(3, "0") + ".ts");
    const headerLines = Object.entries(headers).map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n";
    const code = await run(["-hide_banner", "-loglevel", "warning", "-headers", headerLines, "-i", url,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mpegts", "-y", part]);
    if (size(part) > 0) parts.push(part); else fs.rmSync(part, { force: true });
    if (stopping || !parts.length || gapMs <= 0) break;
    if (resolution === undefined) {
      try {
        const first = new URL(mediaUrl).pathname;
        resolution = (await variants()).find((item) => new URL(item.url).pathname === first)?.resolution || "";
      } catch { resolution = ""; }
    }
    say("stream stopped (ffmpeg exit " + code + "); waiting up to " + (gapMs >= 60000 ? Math.round(gapMs / 60000) + " min" : Math.round(gapMs / 1000) + " s") + " for the room to return");
    const deadline = Date.now() + gapMs;
    url = "";
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      if (stopping) break;
      let found;
      try { found = await liveVariant(resolution); } catch {}
      if (found && found.resolution === "changed") { say("room is back in a different quality; finishing this video"); break; }
      if (found) { url = found.url; say("room is public again; continuing the recording"); break; }
    }
    if (!url) break;
  }
  if (cancelled) { fs.rmSync(partsDir, { recursive: true, force: true }); process.exit(143); }
  if (!parts.length) { fs.rmSync(partsDir, { recursive: true, force: true }); say("no video was recorded"); process.exit(1); }
  const list = path.join(partsDir, "parts.txt");
  fs.writeFileSync(list, parts.map((part) => "file '" + part + "'").join("\n") + "\n");
  stopping = false;
  const joined = await run(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", output]);
  if (joined !== 0 || size(output) === 0) { say("joining " + parts.length + " part(s) failed"); process.exit(1); }
  fs.rmSync(partsDir, { recursive: true, force: true });
  if (parts.length > 1) say("joined " + parts.length + " parts into one video");
  process.exit(0);
})().catch((error) => { say(String((error && error.stack) || error)); process.exit(1); });
`;

export async function resolveStripchatDownload(context: PluginContext, item: MediaCandidate): Promise<CommandDownloadRequest> {
  if (!item.pageUrl) throw new Error("Stripchat recording is missing its public room URL");
  const stream = await resolveStripchatHlsWithRetry(context, item.pageUrl);
  return {
    kind: "command", command: process.execPath, filename: item.filename ?? "stripchat-live.mp4",
    args: [
      "-e", STRIPCHAT_RECORDER_SCRIPT, stream.mediaUrl, stream.masterUrl, JSON.stringify(stream.headers), "{output}",
      String(STRIPCHAT_MERGE_GAP_MS), String(STRIPCHAT_MERGE_POLL_MS), USER_AGENT,
    ],
  };
}

/*
 * Broadcast sessions (fix for OpenEasyX issue #25).
 *
 * Stripchat used one stable external id per room, so after the first recording
 * every later broadcast was skipped by the server. Each broadcast now gets its own
 * session id (`stripchat:<user>:live:<session>`). Whether a new session is needed
 * is decided from the item's real state in the app database (read-only):
 *  - item not ingested yet, queued or downloading  -> keep the session (no duplicates)
 *  - item finished (completed/failed)              -> new session, so the server queues
 *    a new recording; short or failed recordings back off 45s, 90s, ... up to 15 min
 *  - item cancelled/deleted by the user            -> new session only after the room
 *    has been seen offline or non-public
 */
const LEGACY_SESSION = "legacy";
const STRIPCHAT_HEALTHY_RECORDING_MS = 5 * 60_000;
const STRIPCHAT_FIRST_BACKOFF_MS = 45_000;
const STRIPCHAT_MAX_BACKOFF_MS = 15 * 60_000;
const ACTIVE_ITEM_STATUSES = new Set(["available", "queued", "downloading", "paused", "stopping", "cancelling"]);
const USER_ENDED_ITEM_STATUSES = new Set(["cancelled", "deleted"]);

export type StripchatItemState = {
  externalId: string; status: string;
  startedAt?: string | null; finishedAt?: string | null; updatedAt?: string | null;
};
type StripchatSession = { session: string; restarts: number; seenOfflineSince?: number };

const dataDir = path.resolve(process.env.EASYX_DATA_DIR ?? "data");
const sessionFile = path.join(dataDir, "stripchat-live-sessions.json");
const sessions = loadStripchatSessions();

function loadStripchatSessions(): Map<string, StripchatSession> {
  try {
    const stored = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Record<string, Partial<StripchatSession>>;
    return new Map(Object.entries(stored)
      .filter(([, value]) => typeof value?.session === "string")
      .map(([key, value]) => [key, { session: value.session!, restarts: Number(value.restarts) || 0 }]));
  } catch { return new Map(); }
}

function saveStripchatSessions() {
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions)));
  } catch { /* Sessions still work in memory. */ }
}

// --- Read-only view on the app database -------------------------------------
type ItemLookup = (username: string) => StripchatItemState | undefined | null;
let itemDb: DatabaseSync | null | undefined;
let lookupLatestItem: ItemLookup = (username) => {
  if (itemDb === undefined) {
    try {
      itemDb = new DatabaseSync(path.join(dataDir, "easyx.sqlite"), { readOnly: true });
    } catch { itemDb = null; }
  }
  if (!itemDb) return null;
  const base = `stripchat:${username}:live`;
  try {
    const row = itemDb.prepare(`SELECT external_id AS externalId, status, download_started_at AS startedAt,
        download_finished_at AS finishedAt, updated_at AS updatedAt FROM items
      WHERE plugin_id = 'org.easyx.stripchat' AND (external_id = ? OR substr(external_id, 1, length(?) + 1) = ? || ':')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(base, base, base) as unknown as StripchatItemState | undefined;
    return row ?? undefined;
  } catch { return null; }
};
export function setStripchatItemLookup(lookup: ItemLookup) { lookupLatestItem = lookup; }

function sessionFromExternalId(externalId: string): string {
  const match = /^stripchat:.+:live:(.+)$/.exec(externalId);
  return match ? match[1] : LEGACY_SESSION;
}

function newSessionId(nowMs: number, previous?: string): string {
  const id = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return id === previous ? `${id}-2` : id;
}

/** Session id to report for a room that is live and public right now. */
export function stripchatLiveSession(username: string, nowMs = Date.now()): string {
  const key = username.toLowerCase();
  let current = sessions.get(key);
  const item = lookupLatestItem(key);

  // Database not readable: keep one session per broadcast (reset when seen offline).
  if (item === null) {
    if (current && current.seenOfflineSince === undefined) return current.session;
    return startSession(key, nowMs, current, 0);
  }
  if (!item) return current?.session ?? startSession(key, nowMs, current, 0);

  // The database is the source of truth: follow the latest recording of this room.
  const itemSession = sessionFromExternalId(item.externalId);
  if (!current || current.session !== itemSession) {
    current = { session: itemSession, restarts: current?.restarts ?? 0, seenOfflineSince: current?.seenOfflineSince };
    sessions.set(key, current);
    saveStripchatSessions();
  }
  if (ACTIVE_ITEM_STATUSES.has(item.status)) {
    current.seenOfflineSince = undefined;
    return current.session;
  }
  if (USER_ENDED_ITEM_STATUSES.has(item.status)) {
    return current.seenOfflineSince === undefined ? current.session : startSession(key, nowMs, current, 0);
  }

  // Recording finished (completed/failed/...) while the room is live again.
  const started = Date.parse(item.startedAt ?? "");
  const ended = Date.parse(item.finishedAt ?? item.updatedAt ?? "") || nowMs;
  const ranMs = Number.isFinite(started) ? ended - started : 0;
  const short = item.status === "failed" || ranMs < STRIPCHAT_HEALTHY_RECORDING_MS;
  if (!short) return startSession(key, nowMs, current, 0);
  const wait = Math.min(STRIPCHAT_MAX_BACKOFF_MS, STRIPCHAT_FIRST_BACKOFF_MS * 2 ** Math.min(current.restarts, 6));
  if (nowMs - ended < wait) return current.session;
  return startSession(key, nowMs, current, current.restarts + 1);
}

function startSession(key: string, nowMs: number, previous: StripchatSession | undefined, restarts: number): string {
  const session = newSessionId(nowMs, previous?.session);
  sessions.set(key, { session, restarts });
  saveStripchatSessions();
  return session;
}

/** The room is offline, private, in a group show, away, ... */
export function stripchatSeenOffline(username: string, nowMs = Date.now()) {
  const current = sessions.get(username.toLowerCase());
  if (!current || current.seenOfflineSince !== undefined) return;
  current.seenOfflineSince = nowMs;
  saveStripchatSessions();
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

function stripchatSessionLabel(session: string, nowMs = Date.now()): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(session);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  return new Date(nowMs).toISOString().slice(0, 16).replace("T", " ");
}

export async function listStripchatMedia(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]> {
  const username = new URL(source.profileUrl).pathname.split("/").filter(Boolean).at(-1)?.replace(/^@/, "") ?? "live";
  const html = await browserHtml(context, source.profileUrl);
  const cam = stripchatProfileLiveCams(html, username)[0];
  if (!cam) { stripchatSeenOffline(username); return []; }
  // "Online" is not enough: in a private, group or away state there is no public
  // stream, so a recording would fail. Treat it as offline; when the room returns
  // to a public show a new session (and recording) starts.
  const status = stripchatRoomStatus(html);
  if (status && STRIPCHAT_NON_PUBLIC_STATUSES.has(status)) {
    context.log("debug", `Stripchat room ${cam.username} is online but not public (${status}); not recording`);
    stripchatSeenOffline(username);
    return [];
  }
  const safeName = cam.username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  const session = stripchatLiveSession(cam.username);
  const legacy = session === LEGACY_SESSION;
  return [{
    externalId: legacy ? `stripchat:${cam.username.toLowerCase()}:live` : `stripchat:${cam.username.toLowerCase()}:live:${session}`,
    title: `${cam.username} ${stripchatSessionLabel(session)}`, pageUrl: cam.pageUrl, mediaType: "video",
    filename: legacy ? `${safeName}-live.mp4` : `${safeName}-live-${session}.mp4`,
    metadata: { extractorUrl: cam.pageUrl, live: true, viewers: cam.viewers, gender: cam.gender, tags: cam.tags ?? [], session, roomTitle: cam.title, status },
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
