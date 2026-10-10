import { LIVE_RECORDER_SCRIPT, retryDelay } from "../live-recorder.js";
import { orderVariantsForRecording, parseHlsVariants, recordingMaxHeight } from "../hls-quality.js";
import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import { accountSignal, cookieHeader, readAccountCookies } from "../account-cookies.js";
import { browserHtml } from "../browser-html-utils.js";
import type { CommandDownloadRequest, DownloadRequest, LiveCam, LiveCamFavoriteSnapshot, MediaCandidate, PerformerRecord, PersonCandidate, PluginContext, SourceCandidate } from "../../packages/plugin-sdk/index.js";

const plugin = createLiveCamPlugin({
  id: "org.easyx.cam4", name: "CAM4 Live", prefix: "cam4", homepage: "https://www.cam4.com",
  discovery: "cam4",
  description: "Check a public CAM4 room and play or record its active live stream with yt-dlp and FFmpeg.",
  sourceUrlPatterns: ["http://cam4.com/*", "https://cam4.com/*", "http://www.cam4.com/*", "https://www.cam4.com/*"],
  cookieDomains: ["cam4.com"], loginUrl: "https://www.cam4.com/login", minimumIntervalSeconds: 5, defaultIntervalSeconds: 10,
});

const genericTestConnection = plugin.testConnection!;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36";

function headers(cookies: Map<string, string>, referer = "https://www.cam4.com/friends_favorites"): Record<string, string> {
  return {
    accept: "application/json, text/html;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.8",
    cookie: cookieHeader(cookies), referer, "user-agent": USER_AGENT, "x-requested-with": "XMLHttpRequest",
  };
}

function findString(value: unknown, keys: Set<string>): string | undefined {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const child of value) { const found = findString(child, keys); if (found) return found; }
    } else {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (keys.has(key.toLowerCase()) && typeof child === "string" && child.trim()) return child.trim();
      }
      for (const child of Object.values(value as Record<string, unknown>)) { const found = findString(child, keys); if (found) return found; }
    }
  }
  return undefined;
}

async function accountUsername(context: PluginContext, cookies: Map<string, string>): Promise<string> {
  const response = await context.fetch("https://www.cam4.com/rest/v2.0/login/user", {
    headers: headers(cookies, "https://www.cam4.com/"), redirect: "manual", signal: accountSignal(context),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("The CAM4 session redirected to login. Reconnect the account.");
  if (!response.ok) throw new Error(`The CAM4 account session could not be verified (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("CAM4 returned an invalid account response"); }
  const username = findString(payload, new Set(["username", "screenname", "login"]));
  if (!username || !/^[a-z0-9_]{2,64}$/i.test(username)) throw new Error("CAM4 did not identify the connected account.");
  return username;
}

export async function cam4FollowedSnapshot(context: PluginContext): Promise<LiveCamFavoriteSnapshot> {
  let cookies: Map<string, string> | undefined;
  try { cookies = readAccountCookies(context, "cam4.com", "CAM4"); }
  catch (error) { return { cams: [], authoritative: false, skippedReason: error instanceof Error ? error.message : String(error) }; }
  if (!cookies) return { cams: [], authoritative: false, skippedReason: "Connect a CAM4 account to synchronize followed creators." };

  try {
    const authUsername = await accountUsername(context, cookies);
    const followed: Array<Record<string, unknown>> = [];
    let offset = 0;
    let expectedTotal: number | undefined;
    while (true) {
      const response = await context.fetch(`https://www.cam4.com/rest/v1.0/favorites/${encodeURIComponent(authUsername.toLowerCase())}?limit=100&offset=${offset}`, {
        headers: headers(cookies), redirect: "manual", signal: accountSignal(context),
      });
      if (!response.ok) throw new Error(`The CAM4 followed list returned HTTP ${response.status}`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error("CAM4 returned an invalid followed list response"); }
      const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
      const total = Number(value?.totalUsersCount);
      const users = value?.usersList;
      if (!Number.isInteger(total) || total < 0 || total > 5_000 || !Array.isArray(users) || users.length > 100) {
        throw new Error("CAM4 returned an invalid followed list response");
      }
      if (expectedTotal === undefined) expectedTotal = total;
      else if (expectedTotal !== total) throw new Error("The CAM4 followed list changed during synchronization");
      for (const user of users) {
        if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("CAM4 returned an invalid followed creator");
        followed.push(user as Record<string, unknown>);
      }
      if (offset + 100 >= total) break;
      offset += 100;
    }
    const cams: Array<LiveCam & { online: boolean }> = [];
    for (let offset = 0; offset < followed.length; offset += 20) {
      const batch = followed.slice(offset, offset + 20);
      const resolved = await Promise.all(batch.map(async (user): Promise<LiveCam & { online: boolean }> => {
        const username = typeof user.username === "string" ? user.username.trim() : "";
        if (!/^[a-z0-9_]{2,64}$/i.test(username)) throw new Error("CAM4 returned an invalid followed creator name");
        let info: Record<string, unknown> = {};
        try {
          const response = await context.fetch(`https://www.cam4.com/rest/v1.0/profile/${encodeURIComponent(username)}/streamInfo`, {
            headers: headers(cookies, `https://www.cam4.com/${encodeURIComponent(username)}`), signal: accountSignal(context),
          });
          if (response.ok) {
            const payload = await response.json();
            if (payload && typeof payload === "object" && !Array.isArray(payload)) info = payload as Record<string, unknown>;
          }
        } catch { /* A temporarily unavailable profile remains an offline followed creator. */ }
        const online = info.isLive === true || info.isCamming === true || info.online === true
          || typeof info.cdnURL === "string" || typeof info.hlsPlaylistUrl === "string" || typeof info.edgeURL === "string";
        const thumbnail = [info.previewImageURL, info.profileImageURL, user.profileThumbnailUrl].find((value) => typeof value === "string" && value.trim()) as string | undefined;
        const viewers = Number(info.viewerCount ?? info.viewers ?? 0);
        return {
          id: username.toLowerCase(), username, title: username,
          pageUrl: `https://www.cam4.com/${encodeURIComponent(username)}`, thumbnailUrl: thumbnail,
          viewers: online && Number.isInteger(viewers) && viewers >= 0 ? viewers : 0,
          online,
        };
      }));
      cams.push(...resolved);
    }
    return { cams, authoritative: true };
  } catch (error) {
    const skippedReason = error instanceof Error ? error.message : String(error);
    context.log("warn", "CAM4 favorite synchronization skipped", { reason: skippedReason });
    return { cams: [], authoritative: false, skippedReason };
  }
}

async function favoriteState(context: PluginContext, cookies: Map<string, string>, authUsername: string, performer: string): Promise<boolean> {
  const url = `https://www.cam4.com/rest/v1.0/favorites/${encodeURIComponent(authUsername.toLowerCase())}/${encodeURIComponent(performer)}`;
  const response = await context.fetch(url, { headers: headers(cookies, `https://www.cam4.com/${encodeURIComponent(performer)}`), redirect: "manual", signal: accountSignal(context) });
  if (!response.ok) throw new Error(`CAM4 could not verify the favorite (HTTP ${response.status})`);
  const body = (await response.text()).trim();
  if (/^"?true"?$/i.test(body)) return true;
  if (/^"?false"?$/i.test(body)) return false;
  try {
    const payload = JSON.parse(body) as unknown;
    if (typeof payload === "boolean") return payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const value = payload as Record<string, unknown>;
      if (typeof value.favorite === "boolean") return value.favorite;
      if (typeof value.isFavorite === "boolean") return value.isFavorite;
      return String(value.status ?? "").toUpperCase() === "FAVORITE";
    }
  } catch { /* The response was not JSON. */ }
  throw new Error("CAM4 returned an invalid favorite status");
}

export async function setCam4Favorite(context: PluginContext, cam: LiveCam, favorite: boolean): Promise<{ synchronized: boolean }> {
  const cookies = readAccountCookies(context, "cam4.com", "CAM4");
  if (!cookies) return { synchronized: false };
  if (!/^[a-z0-9_]{2,64}$/i.test(cam.username)) throw new Error("CAM4 received an invalid room name");
  const authUsername = await accountUsername(context, cookies);
  if (await favoriteState(context, cookies, authUsername, cam.username) === favorite) return { synchronized: true };
  const referer = `https://www.cam4.com/${encodeURIComponent(cam.username)}`;
  const url = `https://www.cam4.com/rest/v1.0/favorites/${encodeURIComponent(authUsername.toLowerCase())}/${encodeURIComponent(cam.username)}`;
  const method = favorite ? "POST" : "DELETE";
  const response = await context.fetch(url, {
    method, headers: { ...headers(cookies, referer), origin: "https://www.cam4.com", "content-type": "application/json" },
    body: "", redirect: "manual", signal: accountSignal(context),
  });
  if (!response.ok) throw new Error(`CAM4 could not ${favorite ? "follow" : "unfollow"} ${cam.username} (HTTP ${response.status})`);
  if (await favoriteState(context, cookies, authUsername, cam.username) !== favorite) {
    throw new Error(`CAM4 did not confirm that ${cam.username} was ${favorite ? "followed" : "unfollowed"}`);
  }
  return { synchronized: true };
}

plugin.testConnection = async (context) => {
  const extractor = await genericTestConnection(context);
  if (!extractor.ok || !context.config.cookiesFile) return extractor;
  try {
    const cookies = readAccountCookies(context, "cam4.com", "CAM4");
    if (!cookies) return { ok: false, message: "Connect a CAM4 account in the integrated browser." };
    const username = await accountUsername(context, cookies);
    return { ok: true, message: `${extractor.message} CAM4 account ${username} verified.` };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
};
plugin.listFollowedLiveCams = cam4FollowedSnapshot;
plugin.setLiveCamFavorite = setCam4Favorite;

// --- Performer search ("Find a performer") --------------------------------------
/*
 * CAM4 has no public name search, so this looks up exact usernames: the text as
 * typed and, for multi-word input, the words joined with nothing and "_"
 * ("Jane Doe" -> JaneDoe, Jane_Doe). The profile API confirms the account; the user
 * reviews and picks a result. Picking it stores the CAM4 username on the performer,
 * and source discovery then adds exactly that room as a source.
 */
const CAM4_USERNAME = /^[a-z0-9_]{2,64}$/i;

export function cam4SearchUsernames(query: string): string[] {
  let text = query.trim();
  try { if (/^https?:\/\//i.test(text)) text = new URL(text).pathname.split("/").filter(Boolean).at(-1) ?? ""; } catch { return []; }
  text = text.replace(/^@/, "");
  const words = text.split(/\s+/).filter(Boolean);
  const names = words.length > 1 ? [words.join(""), words.join("_")] : [text];
  return [...new Map(names.filter((name) => CAM4_USERNAME.test(name)).map((name) => [name.toLowerCase(), name])).values()];
}

function profileHeaders(username: string): Record<string, string> {
  return { accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.8", referer: `https://www.cam4.com/${encodeURIComponent(username)}`, "user-agent": USER_AGENT };
}

/**
 * GET a CAM4 JSON endpoint. A plain request first (CAM4 normally allows it); when it
 * is blocked (403/429), the browser-compatible helper of the EasyX image.
 */
async function cam4Json(context: PluginContext, url: string, username: string): Promise<{ status: number; data?: Record<string, unknown> }> {
  let status = 0;
  try {
    const response = await context.fetch(url, { headers: profileHeaders(username), signal: accountSignal(context, 20_000) });
    status = response.status;
    if (response.status !== 403 && response.status !== 429) {
      if (!response.ok || response.status === 204) return { status: response.status };
      try {
        const data = await response.json() as unknown;
        return { status: response.status, ...(data && typeof data === "object" && !Array.isArray(data) ? { data: data as Record<string, unknown> } : {}) };
      } catch { return { status: 502 }; }
    }
  } catch (error) { if (context.signal?.aborted) throw error; }
  try {
    const body = await browserHtml(context, url);
    if (!body.trim()) return { status: 204 };
    try { const data = JSON.parse(body) as unknown; return { status: 200, ...(data && typeof data === "object" && !Array.isArray(data) ? { data: data as Record<string, unknown> } : {}) }; }
    catch { return { status: 502 }; }
  } catch (error) {
    context.signal?.throwIfAborted();
    const code = /HTTP (\d{3})/.exec(error instanceof Error ? error.message : String(error))?.[1];
    return { status: code ? Number(code) : status || 502 };
  }
}

type Cam4Profile = { username: string; imageUrl?: string; online?: boolean; gender?: string; country?: string };

function profileFromInfo(data: Record<string, unknown>, username: string): Cam4Profile | undefined {
  const found = findString(data, new Set(["username", "screenname", "login"]));
  if (!found || found.toLowerCase() !== username.toLowerCase()) return undefined;
  const imageUrl = findString(data, new Set(["profileimagelink", "profileimageurl", "profilepictureurl", "avatarurl", "avatar", "photourl"]));
  const gender = findString(data, new Set(["gender", "sex"]));
  const country = findString(data, new Set(["country", "countrycode"]));
  return {
    username: found ?? username,
    ...(imageUrl && /^https?:\/\//i.test(imageUrl) ? { imageUrl } : {}),
    ...(typeof data.online === "boolean" ? { online: data.online } : {}),
    ...(gender ? { gender } : {}), ...(country ? { country } : {}),
  };
}

/** The username as written in the profile page data, when the page describes that performer. */
export function cam4UsernameInPage(html: string, username: string): string | undefined {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"(?:username|screenName|nickname)"\\s*:\\s*"(${escaped})"`, "i").exec(html);
  return match?.[1];
}

/**
 * Exact username lookup. Undefined when there is no such performer.
 *
 * CAM4's profile info API now answers HTTP 401 without a login on www.cam4.com, so
 * this tries, in order: the info API on hu.cam4.com (used by other recorders), the
 * public stream API (confirms rooms that are live), and the public profile page.
 */
export async function cam4ProfileByUsername(context: PluginContext, username: string): Promise<Cam4Profile | undefined> {
  const problems: string[] = [];
  for (const host of ["hu.cam4.com", "www.cam4.com"]) {
    const { status, data } = await cam4Json(context, `https://${host}/rest/v1.0/profile/${encodeURIComponent(username)}/info`, username);
    if (data && status >= 200 && status < 300) { const profile = profileFromInfo(data, username); if (profile) return profile; }
    if (status === 404 || status === 410) return undefined;
    problems.push(`info on ${host}: HTTP ${status}`);
  }
  const stream = await cam4Json(context, `https://www.cam4.com/rest/v1.0/profile/${encodeURIComponent(username)}/streamInfo`, username);
  if (stream.data && typeof stream.data.cdnURL === "string" && /^https?:\/\//i.test(stream.data.cdnURL)) return { username, online: true };
  if (stream.status !== 204 && !(stream.status >= 200 && stream.status < 300)) problems.push(`streamInfo: HTTP ${stream.status}`);
  try {
    const html = await browserHtml(context, `https://www.cam4.com/${encodeURIComponent(username)}`);
    const found = cam4UsernameInPage(html, username);
    if (found) return { username: found, ...(stream.status === 204 ? { online: false } : {}) };
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 404/.test(message)) return undefined;
    problems.push(`profile page: ${message}`);
  }
  throw new Error(`CAM4 profile lookup for ${username} failed (${problems.join("; ")})`);
}

export async function searchCam4People(context: PluginContext, query: string): Promise<PersonCandidate[]> {
  const results = new Map<string, PersonCandidate>();
  let firstError: unknown;
  for (const username of cam4SearchUsernames(query)) {
    let profile: Cam4Profile | undefined;
    try { profile = await cam4ProfileByUsername(context, username); } catch (error) { context.signal?.throwIfAborted(); firstError ??= error; continue; }
    if (!profile) continue;
    const profileUrl = `https://www.cam4.com/${encodeURIComponent(profile.username)}`;
    results.set(profile.username.toLowerCase(), {
      externalId: profile.username.toLowerCase(), name: profile.username,
      ...(profile.imageUrl ? { imageUrl: profile.imageUrl } : {}),
      profileUrls: [profileUrl],
      metadata: { site: "cam4.com", ...(profile.online !== undefined ? { online: profile.online } : {}), ...(profile.gender ? { gender: profile.gender } : {}), ...(profile.country ? { country: profile.country } : {}) },
    });
  }
  if (!results.size && firstError) throw firstError instanceof Error ? firstError : new Error(String(firstError));
  return [...results.values()];
}

/** Adds the CAM4 room of a performer picked in "Find a performer" (or linked to CAM4 before). */
export async function discoverCam4Sources(_context: PluginContext, performer: PerformerRecord): Promise<SourceCandidate[]> {
  const linked = performer.externalRefs?.["org.easyx.cam4"];
  const found = typeof linked === "string" ? cam4SearchUsernames(linked.replace(/^live:/i, ""))[0] : undefined;
  if (!found) return [];
  // Prefer the spelling of the performer name (the stored reference is lower case).
  const username = performer.name.toLowerCase() === found.toLowerCase() ? performer.name : found;
  const profileUrl = `https://www.cam4.com/${encodeURIComponent(username)}`;
  // Same external ID as a source added by hand (its profile URL), so nothing is added twice.
  return [{ externalId: profileUrl, label: "cam4.com", profileUrl, domain: "cam4.com" }];
}

// --- Continuous recording ---------------------------------------------------------
/*
 * A CAM4 room that goes private or briefly offline stops its public stream, which
 * used to end the recording; every return became a separate video. Recordings now
 * run through the shared live recorder: when the stream stops it keeps checking
 * the room for up to CAM4_MERGE_GAP_MINUTES (default: STRIPCHAT_MERGE_GAP_MINUTES,
 * otherwise 10). CAM4 gives a returning room a new stream address, so the recorder
 * asks streamInfo for the current one. Breaks within the limit end up in one video.
 */
const mergeGapMinutes = Number(process.env.CAM4_MERGE_GAP_MINUTES ?? process.env.STRIPCHAT_MERGE_GAP_MINUTES ?? 10);
const MERGE_GAP_MS = Number.isFinite(mergeGapMinutes) && mergeGapMinutes > 0 ? mergeGapMinutes * 60_000 : 0;
const MERGE_POLL_MS = 20_000;
const HLS_ATTEMPTS = 4;
const HLS_RETRY_MS = 10_000;

export function cam4StreamHeaders(): Record<string, string> {
  return { referer: "https://www.cam4.com/", origin: "https://www.cam4.com" };
}

function cam4RoomName(pageUrl: string): string | undefined {
  try { const name = new URL(pageUrl).pathname.split("/").filter(Boolean)[0]; return name && CAM4_USERNAME.test(name) ? name : undefined; }
  catch { return undefined; }
}

/** Variant URLs in recording preference order: highest bandwidth, or the best at or below maxHeight. */
export function cam4VariantUrls(manifest: string, baseUrl: string, maxHeight = 0): string[] {
  return orderVariantsForRecording(parseHlsVariants(manifest, baseUrl), maxHeight).map((variant) => variant.url);
}

const isLivePlaylist = (text: string) => text.trimStart().startsWith("#EXTM3U") && /#EXTINF:/i.test(text) && !/#EXT-X-ENDLIST/i.test(text);

async function playlistText(context: PluginContext, url: string): Promise<string | undefined> {
  try {
    const response = await context.fetch(url, { headers: { ...cam4StreamHeaders(), "user-agent": USER_AGENT }, signal: accountSignal(context, 15_000) });
    return response.ok ? await response.text() : undefined;
  } catch (error) { if (context.signal?.aborted) throw error; return undefined; }
}

/** Current public master playlist and its best live variant; undefined while the room is not public. */
export async function cam4LiveStream(context: PluginContext, username: string): Promise<{ masterUrl: string; mediaUrl: string } | undefined> {
  const { status, data } = await cam4Json(context, `https://www.cam4.com/rest/v1.0/profile/${encodeURIComponent(username)}/streamInfo`, username);
  if (status === 204 || status === 404) return undefined;
  const masterUrl = typeof data?.cdnURL === "string" && /^https?:\/\//i.test(data.cdnURL) ? data.cdnURL : undefined;
  if (!masterUrl) {
    if (status >= 200 && status < 300) return undefined;
    throw new Error(`CAM4 stream lookup for ${username} returned HTTP ${status}`);
  }
  const master = await playlistText(context, masterUrl);
  if (!master) return undefined;
  if (isLivePlaylist(master)) return { masterUrl, mediaUrl: masterUrl };
  for (const variant of cam4VariantUrls(master, masterUrl, recordingMaxHeight(context.config))) {
    const playlist = await playlistText(context, variant);
    if (playlist && isLivePlaylist(playlist)) return { masterUrl, mediaUrl: variant };
  }
  return undefined;
}

const genericResolveDownload = plugin.resolveDownload!;

export async function resolveCam4Download(context: PluginContext, item: MediaCandidate): Promise<DownloadRequest> {
  const username = item.pageUrl ? cam4RoomName(item.pageUrl) : undefined;
  if (!username || item.mediaType !== "video") return genericResolveDownload(context, item);
  let lastError: unknown;
  for (let attempt = 1; attempt <= HLS_ATTEMPTS; attempt += 1) {
    context.signal?.throwIfAborted();
    try {
      const stream = await cam4LiveStream(context, username);
      if (stream) {
        return {
          kind: "command", command: process.execPath, requireSuccessfulExit: true, filename: item.filename ?? `${username}-live.mp4`,
          args: [
            "-e", LIVE_RECORDER_SCRIPT, stream.mediaUrl, stream.masterUrl, JSON.stringify(cam4StreamHeaders()), "{output}",
            String(MERGE_GAP_MS), String(MERGE_POLL_MS), USER_AGENT,
            `https://www.cam4.com/rest/v1.0/profile/${encodeURIComponent(username)}/streamInfo`, "cdnURL",
          ],
        } satisfies CommandDownloadRequest;
      }
      lastError = undefined;
    } catch (error) { lastError = error; }
    if (attempt < HLS_ATTEMPTS) await retryDelay(HLS_RETRY_MS, context.signal);
  }
  context.signal?.throwIfAborted();
  // CAM4 answered, but the room has no public stream.
  if (!lastError) throw new Error("The CAM4 room is not public");
  // The room API could not be used: let yt-dlp try, as before this change.
  context.log("debug", "CAM4 stream lookup failed; falling back to yt-dlp", lastError instanceof Error ? lastError.message : String(lastError));
  return genericResolveDownload(context, item);
}

plugin.manifest.capabilities = [...new Set([...plugin.manifest.capabilities, "identity-search" as const, "source-discovery" as const])];
plugin.searchPeople = searchCam4People;
plugin.discoverSources = discoverCam4Sources;
plugin.resolveDownload = resolveCam4Download;

export default plugin;
