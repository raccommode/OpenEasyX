import { LIVE_RECORDER_SCRIPT, retryDelay } from "../live-recorder.js";
import { orderVariantsForRecording, parseHlsVariants, recordingMaxHeight } from "../hls-quality.js";
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
 * - public -> one item per broadcast, sessions managed by the source scanner;
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
        method: "POST", headers: roomHeaders(host, username), body, signal: requestSignal(context, 20_000),
      });
      if (!response.ok) throw new Error(`BongaCams room API returned HTTP ${response.status} on ${host}`);
      const data = await response.json() as Record<string, any>;
      if (data && typeof data === "object") return data;
      throw new Error(`BongaCams room API returned no data on ${host}`);
    } catch (error) { context.signal?.throwIfAborted(); lastError = error; }
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
  if (data.status === "error") return { state: "missing" };
  if (!data.performerData || typeof data.performerData !== "object") throw new Error("Invalid BongaCams room API response");
  const username = typeof data.performerData.username === "string" && data.performerData.username.trim() ? data.performerData.username.trim() : requested;
  const showType = typeof data.performerData.showType === "string" ? data.performerData.showType.trim() : "";
  if (showType && NON_PUBLIC.test(showType)) return { state: "private", username, showType };
  const server = serverUrl(data.localData?.videoServerUrl);
  if (!server) return { state: "offline", username };
  const masterUrl = `${server}/hls/stream_${encodeURIComponent(username)}/playlist.m3u8`;
  const master = await fetchText(context, masterUrl);
  if (!master) return { state: "offline", username };
  let publicStream = false;
  for (const variant of variantUrls(master, masterUrl)) {
    const playlist = variant.url === masterUrl ? master : await fetchText(context, variant.url);
    if (playlist && isLivePlaylist(playlist)) { publicStream = true; break; }
  }
  if (!publicStream) return { state: "offline", username };
  const displayName = typeof data.performerData.displayName === "string" ? data.performerData.displayName : undefined;
  return { state: "public", username, displayName, masterUrl };
}

async function fetchText(context: PluginContext, url: string): Promise<string | undefined> {
  try {
    const response = await context.fetch(url, { headers: { ...streamHeaders(), "user-agent": USER_AGENT }, signal: requestSignal(context, 15_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`BongaCams playlist returned HTTP ${response.status}`);
    return await response.text();
  } catch (error) { context.signal?.throwIfAborted(); throw error; }
}

type Variant = { url: string; bandwidth: number; height: number };
/** Variants in recording preference order: highest bandwidth, or the best at or below maxHeight. */
export function variantUrls(manifest: string, baseUrl: string, maxHeight = 0): Variant[] {
  if (!manifest.trimStart().startsWith("#EXTM3U")) return [];
  const variants = parseHlsVariants(manifest, baseUrl);
  // A media playlist (no variants) with segments is itself playable.
  if (!variants.length && /#EXTINF/i.test(manifest)) return [{ url: baseUrl, bandwidth: 0, height: 0 }];
  return orderVariantsForRecording(variants, maxHeight);
}

function isLivePlaylist(manifest: string) {
  return manifest.trimStart().startsWith("#EXTM3U") && /#EXTINF/i.test(manifest) && !/#EXT-X-ENDLIST/i.test(manifest);
}

/** Preferred variant (highest, or the best at or below the source's maximum height) that is actually serving segments. */
export async function bongacamsLiveVariant(context: PluginContext, masterUrl: string): Promise<string | undefined> {
  const master = await fetchText(context, masterUrl);
  if (!master) return undefined;
  for (const variant of variantUrls(master, masterUrl, recordingMaxHeight(context.config))) {
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

export async function resolveBongacamsDownload(context: PluginContext, item: MediaCandidate): Promise<CommandDownloadRequest> {
  if (!item.pageUrl) throw new Error("BongaCams recording is missing its room URL");
  let lastProblem = "The BongaCams room is not public";
  for (let attempt = 1; attempt <= HLS_ATTEMPTS; attempt += 1) {
    context.signal?.throwIfAborted();
    const room = await bongacamsRoom(context, item.pageUrl);
    if (room.state === "public") {
      const mediaUrl = await bongacamsLiveVariant(context, room.masterUrl);
      if (mediaUrl) {
        return {
          kind: "command", command: process.execPath, requireSuccessfulExit: true, filename: item.filename ?? "bongacams-live.mp4",
          args: ["-e", LIVE_RECORDER_SCRIPT, mediaUrl, room.masterUrl, JSON.stringify(streamHeaders()), "{output}", String(MERGE_GAP_MS), String(MERGE_POLL_MS), USER_AGENT],
        };
      }
      lastProblem = "The BongaCams stream has no live playlist yet";
    } else if (room.state === "missing") {
      throw new Error("BongaCams performer not found");
    } else {
      lastProblem = room.state === "private" ? `The BongaCams room is in a ${room.showType} show` : "The BongaCams room is offline";
    }
    if (attempt < HLS_ATTEMPTS) await retryDelay(HLS_RETRY_MS, context.signal);
  }
  throw new Error(lastProblem);
}

export async function listBongacamsMedia(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]> {
  const room = await bongacamsRoom(context, source.profileUrl);
  if (room.state === "missing") throw new Error(`BongaCams performer "${bongacamsUsername(source.profileUrl)}" was not found`);
  if (room.state !== "public") {
    if (room.state === "private") context.log("debug", `BongaCams room ${room.username} is in a ${room.showType} show; not recording`);
    return [];
  }
  const key = room.username.toLowerCase();
  const safeName = room.username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  const pageUrl = source.profileUrl;
  return [{
    externalId: `bongacams:${key}:live`,
    title: `${room.username} live`, pageUrl, mediaType: "video",
    filename: `${safeName}-live.mp4`,
    metadata: { extractorUrl: pageUrl, live: true, displayName: room.displayName },
  }];
}

plugin.listMedia = listBongacamsMedia;
plugin.resolveDownload = resolveBongacamsDownload;

export default plugin;

function requestSignal(context: PluginContext, timeout: number) {
  return context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
