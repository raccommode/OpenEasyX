import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import type { CommandDownloadRequest, MediaCandidate, MediaSource, PluginContext } from "../../packages/plugin-sdk/index.js";

/*
 * BongaCams fix (continuous, repeated live recording).
 *
 * The generic live-cam plugin asked yt-dlp for the room and built the item ID from
 * the stream address. For BongaCams that address is always
 * <server>/hls/stream_<username>/playlist.m3u8, so every broadcast got the same ID
 * and only the first one was ever recorded (same problem as Stripchat, #25).
 * yt-dlp also failed with an unrecognised error whenever a room was offline or in a
 * private/group show, which made every scheduled sync fail.
 *
 * This plugin asks the BongaCams room API (tools/amf.php, getRoomData) directly:
 * - offline / private / group show -> empty scan, no error;
 * - public -> one item per broadcast, sessions driven by the app database;
 * - recording continues through short breaks and ends up as one video.
 */
const plugin = createLiveCamPlugin({
  id: "org.easyx.bongacams", name: "BongaCams Live", prefix: "bongacams", homepage: "https://bongacams.com",
  discovery: "bongacams",
  description: "Check a public BongaCams room and play or record its active live stream with yt-dlp and FFmpeg.",
  sourceUrlPatterns: ["http://bongacams.com/*", "https://bongacams.com/*", "http://www.bongacams.com/*", "https://www.bongacams.com/*", "http://*.bongacams.com/*", "https://*.bongacams.com/*", "http://*.bongacams.net/*", "https://*.bongacams.net/*"],
  cookieDomains: ["bongacams.com", "bongacams.net"], loginUrl: "https://bongacams.com/login", minimumIntervalSeconds: 5, defaultIntervalSeconds: 10,
});

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36";
const FALLBACK_HOST = "de.bongacams.net";

// --- Room API ----------------------------------------------------------------
export type BongaRoom =
  | { state: "missing" }
  | { state: "offline"; username: string }
  | { state: "private"; username: string; showType: string }
  | { state: "public"; username: string; displayName?: string; masterUrl: string };

export function bongacamsUsername(profileUrl: string): string {
  const url = new URL(profileUrl);
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const markers = new Set(["profile", "profiles", "model", "models", "chat"]);
  const username = parts.length > 1 && markers.has(parts[0].toLowerCase()) ? parts[1] : parts[0];
  if (!username) throw new Error(`No BongaCams username in ${profileUrl}`);
  return username.replace(/^@/, "");
}

function apiHosts(profileUrl: string): string[] {
  const host = new URL(profileUrl).hostname.toLowerCase();
  const own = /(^|\.)bongacams\d*\.(com|net)$/.test(host) ? host : "bongacams.com";
  return [...new Set([own, FALLBACK_HOST])];
}

function roomHeaders(host: string, username: string): Record<string, string> {
  return {
    accept: "application/json, text/javascript, */*; q=0.01", "content-type": "application/x-www-form-urlencoded",
    "x-requested-with": "XMLHttpRequest", referer: `https://${host}/${encodeURIComponent(username)}`, "user-agent": USER_AGENT,
  };
}

export function streamHeaders(): Record<string, string> {
  return { referer: "https://bongacams.com/", origin: "https://bongacams.com" };
}

async function roomData(context: PluginContext, profileUrl: string, username: string): Promise<Record<string, any>> {
  const body = new URLSearchParams([["method", "getRoomData"], ["args[]", username], ["args[]", "false"]]).toString();
  let lastError: unknown;
  for (const host of apiHosts(profileUrl)) {
    try {
      const response = await context.fetch(`https://${host}/tools/amf.php`, {
        method: "POST", headers: roomHeaders(host, username), body, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`BongaCams room API returned HTTP ${response.status} on ${host}`);
      const data = await response.json() as Record<string, any>;
      if (data && typeof data === "object") return data;
      throw new Error(`BongaCams room API returned no data on ${host}`);
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function serverUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const NON_PUBLIC = /private|group|ticket|exclusive|vip/i;

/** Room state straight from BongaCams (offline, private/group show, or public with its master playlist). */
export async function bongacamsRoom(context: PluginContext, profileUrl: string): Promise<BongaRoom> {
  const requested = bongacamsUsername(profileUrl);
  const data = await roomData(context, profileUrl, requested);
  if (data.status === "error" || !data.performerData) return { state: "missing" };
  const username = typeof data.performerData.username === "string" && data.performerData.username.trim() ? data.performerData.username.trim() : requested;
  const showType = typeof data.performerData.showType === "string" ? data.performerData.showType.trim() : "";
  if (showType && NON_PUBLIC.test(showType)) return { state: "private", username, showType };
  const server = serverUrl(data.localData?.videoServerUrl);
  if (!server) return { state: "offline", username };
  const masterUrl = `${server}/hls/stream_${encodeURIComponent(username)}/playlist.m3u8`;
  const master = await fetchText(context, masterUrl);
  if (!master || variantUrls(master, masterUrl).length === 0) return { state: "offline", username };
  const displayName = typeof data.performerData.displayName === "string" ? data.performerData.displayName : undefined;
  return { state: "public", username, displayName, masterUrl };
}

async function fetchText(context: PluginContext, url: string): Promise<string | undefined> {
  try {
    const response = await context.fetch(url, { headers: { ...streamHeaders(), "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    return response.ok ? await response.text() : undefined;
  } catch { return undefined; }
}

type Variant = { url: string; bandwidth: number };
export function variantUrls(manifest: string, baseUrl: string): Variant[] {
  if (!manifest.trimStart().startsWith("#EXTM3U")) return [];
  const variants: Variant[] = []; let info = "";
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) { info = line; continue; }
    if (!line || line.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(line)) continue;
    variants.push({ url: new URL(line, baseUrl).toString(), bandwidth: Number(/BANDWIDTH=(\d+)/i.exec(info)?.[1] ?? 0) });
    info = "";
  }
  // A media playlist (no variants) with segments is itself playable.
  if (!variants.length && /#EXTINF/i.test(manifest)) variants.push({ url: baseUrl, bandwidth: 0 });
  return variants.sort((left, right) => right.bandwidth - left.bandwidth);
}

function isLivePlaylist(manifest: string) {
  return manifest.trimStart().startsWith("#EXTM3U") && /#EXTINF/i.test(manifest) && !/#EXT-X-ENDLIST/i.test(manifest);
}

/** Best (highest bandwidth) variant that is actually serving segments. */
export async function bongacamsLiveVariant(context: PluginContext, masterUrl: string): Promise<string | undefined> {
  const master = await fetchText(context, masterUrl);
  if (!master) return undefined;
  for (const variant of variantUrls(master, masterUrl)) {
    if (variant.url === masterUrl) return isLivePlaylist(master) ? masterUrl : undefined;
    const playlist = await fetchText(context, variant.url);
    if (playlist && isLivePlaylist(playlist)) return variant.url;
  }
  return undefined;
}

// --- Recording ---------------------------------------------------------------
const mergeGapMinutes = Number(process.env.BONGACAMS_MERGE_GAP_MINUTES ?? process.env.STRIPCHAT_MERGE_GAP_MINUTES ?? 10);
const MERGE_GAP_MS = Number.isFinite(mergeGapMinutes) && mergeGapMinutes > 0 ? mergeGapMinutes * 60_000 : 0;
const MERGE_POLL_MS = 20_000;
const HLS_ATTEMPTS = 4;
const HLS_RETRY_MS = 10_000;

/** Standalone recorder run with `node -e` (same as the Stripchat fix); it must not contain the server's output placeholders. */
export const BONGACAMS_RECORDER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [mediaUrl, masterUrl, headersJson, output, gapArg, pollArg, userAgent] = process.argv.slice(1);
const headers = JSON.parse(headersJson);
const gapMs = Number(gapArg) || 0;
const pollMs = Number(pollArg) || 20000;
const partsDir = path.join(path.dirname(output), "bongacams-parts");
fs.rmSync(partsDir, { recursive: true, force: true });
fs.mkdirSync(partsDir, { recursive: true });
let stopping = false, cancelled = false, child, wake = () => {};
const say = (text) => process.stderr.write("[bongacams-recorder] " + text + "\n");
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

export async function resolveBongacamsDownload(context: PluginContext, item: MediaCandidate): Promise<CommandDownloadRequest> {
  if (!item.pageUrl) throw new Error("BongaCams recording is missing its room URL");
  let lastProblem = "The BongaCams room is not public";
  for (let attempt = 1; attempt <= HLS_ATTEMPTS; attempt += 1) {
    const room = await bongacamsRoom(context, item.pageUrl);
    if (room.state === "public") {
      const mediaUrl = await bongacamsLiveVariant(context, room.masterUrl);
      if (mediaUrl) {
        return {
          kind: "command", command: process.execPath, filename: item.filename ?? "bongacams-live.mp4",
          args: ["-e", BONGACAMS_RECORDER_SCRIPT, mediaUrl, room.masterUrl, JSON.stringify(streamHeaders()), "{output}", String(MERGE_GAP_MS), String(MERGE_POLL_MS), USER_AGENT],
        };
      }
      lastProblem = "The BongaCams stream has no live playlist yet";
    } else if (room.state === "missing") {
      throw new Error("BongaCams performer not found");
    } else {
      lastProblem = room.state === "private" ? `The BongaCams room is in a ${room.showType} show` : "The BongaCams room is offline";
    }
    if (attempt < HLS_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, HLS_RETRY_MS));
  }
  throw new Error(lastProblem);
}

// --- Broadcast sessions (database driven, same rules as the Stripchat fix) ---
const LEGACY_PREFIX = "legacy:";
const HEALTHY_RECORDING_MS = 5 * 60_000;
const FIRST_BACKOFF_MS = 45_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const ACTIVE_ITEM_STATUSES = new Set(["available", "queued", "downloading", "paused", "stopping", "cancelling"]);
const USER_ENDED_ITEM_STATUSES = new Set(["cancelled", "deleted"]);

export type BongaItemState = { externalId: string; status: string; startedAt?: string | null; finishedAt?: string | null; updatedAt?: string | null };
type BongaSession = { session: string; restarts: number; seenOfflineSince?: number };

const dataDir = path.resolve(process.env.EASYX_DATA_DIR ?? "data");
const sessionFile = path.join(dataDir, "bongacams-live-sessions.json");
const sessions = loadSessions();

function loadSessions(): Map<string, BongaSession> {
  try {
    const stored = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Record<string, Partial<BongaSession>>;
    return new Map(Object.entries(stored).filter(([, value]) => typeof value?.session === "string")
      .map(([key, value]) => [key, { session: value.session!, restarts: Number(value.restarts) || 0 }]));
  } catch { return new Map(); }
}
function saveSessions() {
  try { fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions))); }
  catch { /* Sessions still work in memory. */ }
}

type ItemLookup = (username: string) => BongaItemState | undefined | null;
let itemDb: DatabaseSync | null | undefined;
let lookupLatestItem: ItemLookup = (username) => {
  if (itemDb === undefined) {
    try { itemDb = new DatabaseSync(path.join(dataDir, "easyx.sqlite"), { readOnly: true }); } catch { itemDb = null; }
  }
  if (!itemDb) return null;
  const prefix = `bongacams:${username}:`;
  try {
    const row = itemDb.prepare(`SELECT external_id AS externalId, status, download_started_at AS startedAt,
        download_finished_at AS finishedAt, updated_at AS updatedAt FROM items
      WHERE plugin_id = 'org.easyx.bongacams' AND substr(external_id, 1, length(?)) = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(prefix, prefix) as unknown as BongaItemState | undefined;
    return row ?? undefined;
  } catch { return null; }
};
export function setBongacamsItemLookup(lookup: ItemLookup) { lookupLatestItem = lookup; }

/** "live:<time>" for sessions made by this plugin, "legacy:<hash>" for items made by the generic plugin. */
function sessionFromExternalId(externalId: string, username: string): string {
  const rest = externalId.slice(`bongacams:${username}:`.length);
  return rest.startsWith("live:") ? rest.slice(5) : `${LEGACY_PREFIX}${rest}`;
}
export function bongacamsExternalId(username: string, session: string) {
  return session.startsWith(LEGACY_PREFIX) ? `bongacams:${username}:${session.slice(LEGACY_PREFIX.length)}` : `bongacams:${username}:live:${session}`;
}
function newSessionId(nowMs: number, previous?: string) {
  const id = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return id === previous ? `${id}-2` : id;
}
function startSession(key: string, nowMs: number, previous: BongaSession | undefined, restarts: number) {
  const session = newSessionId(nowMs, previous?.session);
  sessions.set(key, { session, restarts }); saveSessions();
  return session;
}

/** Session to report for a room that is public right now. */
export function bongacamsLiveSession(username: string, nowMs = Date.now()): string {
  const key = username.toLowerCase();
  let current = sessions.get(key);
  const item = lookupLatestItem(key);
  if (item === null) {
    if (current && current.seenOfflineSince === undefined) return current.session;
    return startSession(key, nowMs, current, 0);
  }
  if (!item) return current?.session ?? startSession(key, nowMs, current, 0);
  const itemSession = sessionFromExternalId(item.externalId, key);
  if (!current || current.session !== itemSession) {
    current = { session: itemSession, restarts: current?.restarts ?? 0, seenOfflineSince: current?.seenOfflineSince };
    sessions.set(key, current); saveSessions();
  }
  if (ACTIVE_ITEM_STATUSES.has(item.status)) { current.seenOfflineSince = undefined; return current.session; }
  if (USER_ENDED_ITEM_STATUSES.has(item.status)) return current.seenOfflineSince === undefined ? current.session : startSession(key, nowMs, current, 0);
  const started = Date.parse(item.startedAt ?? "");
  const ended = Date.parse(item.finishedAt ?? item.updatedAt ?? "") || nowMs;
  const ranMs = Number.isFinite(started) ? ended - started : 0;
  const short = item.status === "failed" || ranMs < HEALTHY_RECORDING_MS;
  if (!short) return startSession(key, nowMs, current, 0);
  const wait = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(current.restarts, 6));
  if (nowMs - ended < wait) return current.session;
  return startSession(key, nowMs, current, current.restarts + 1);
}

/** The room is offline or in a private/group show. */
export function bongacamsSeenOffline(username: string, nowMs = Date.now()) {
  const current = sessions.get(username.toLowerCase());
  if (!current || current.seenOfflineSince !== undefined) return;
  current.seenOfflineSince = nowMs; saveSessions();
}

function sessionLabel(session: string, nowMs = Date.now()) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(session);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : new Date(nowMs).toISOString().slice(0, 16).replace("T", " ");
}

export async function listBongacamsMedia(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]> {
  const room = await bongacamsRoom(context, source.profileUrl);
  if (room.state === "missing") throw new Error(`BongaCams performer "${bongacamsUsername(source.profileUrl)}" was not found`);
  if (room.state !== "public") {
    if (room.state === "private") context.log("debug", `BongaCams room ${room.username} is in a ${room.showType} show; not recording`);
    bongacamsSeenOffline(room.username);
    return [];
  }
  const key = room.username.toLowerCase();
  const session = bongacamsLiveSession(room.username);
  const safeName = room.username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  const legacy = session.startsWith(LEGACY_PREFIX);
  const pageUrl = `https://bongacams.com/${encodeURIComponent(room.username)}`;
  return [{
    externalId: bongacamsExternalId(key, session),
    title: `${room.username} ${sessionLabel(session)}`, pageUrl, mediaType: "video",
    filename: legacy ? `${safeName}-${session.slice(LEGACY_PREFIX.length)}.mp4` : `${safeName}-live-${session}.mp4`,
    metadata: { extractorUrl: pageUrl, live: true, session, displayName: room.displayName },
  }];
}

plugin.listMedia = listBongacamsMedia;
plugin.resolveDownload = resolveBongacamsDownload;

export default plugin;
