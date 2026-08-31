import fs from "node:fs";
import { createHash } from "node:crypto";
import { definePlugin, type LiveCam, type LiveCamFavoriteSnapshot, type LiveCamPage, type MediaCandidate, type PluginContext } from "../../packages/plugin-sdk/index.js";
import { configuredArgs, runYtDlpJson, testYtDlp, ytDlpDownload, ytDlpLiveStream } from "../yt-dlp-utils.js";

const OFFLINE = ["offline", "not currently broadcasting", "room is currently away", "no videos found", "not live"];
const FOLLOW_PAGE_SIZE = 90;
const MAX_FOLLOWED_CAMS = 5_000;
const verifiedAccountSessions = new Set<string>();
let liveSearchCache: { key: string; expiresAt: number; cams: LiveCam[] } | undefined;

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function stamp(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }

export function normalizedChaturbateUrl(value: string): string {
  const url = new URL(value);
  const room = url.pathname.split("/").filter(Boolean)[0];
  if (room) url.pathname = `/${room.toLowerCase()}/`;
  return url.toString();
}

function stableStreamKey(value: string): string {
  try {
    const url = new URL(value);
    const stream = url.pathname.match(/\/streams\/([^/]+)/)?.[1];
    return stream ?? `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function whole(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function tags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,#]+/) : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function requestSignal(context: PluginContext): AbortSignal {
  const timeout = AbortSignal.timeout(20_000);
  return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}

function accountCookies(config: Record<string, unknown>): Map<string, string> | undefined {
  const cookiesFile = text(config.cookiesFile);
  if (!cookiesFile) return undefined;
  let contents: string;
  try { contents = fs.readFileSync(cookiesFile, "utf8"); }
  catch { throw new Error("The stored Chaturbate session could not be read. Reconnect the account in the integrated browser."); }
  const now = Date.now() / 1000;
  const cookies = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.startsWith("#HttpOnly_") ? rawLine.slice("#HttpOnly_".length) : rawLine;
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0].replace(/^\./, "").toLowerCase();
    const expiry = Number(parts[4]);
    if (!(domain === "chaturbate.com" || domain.endsWith(".chaturbate.com")) || (Number.isFinite(expiry) && expiry > 0 && expiry <= now)) continue;
    cookies.set(parts[5], parts.slice(6).join("\t"));
  }
  if (!cookies.has("sessionid")) throw new Error("The Chaturbate session is missing or expired. Reconnect the account in the integrated browser.");
  return cookies;
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function accountHeaders(cookies: Map<string, string>, referer = "https://chaturbate.com/followed-cams/"): Record<string, string> {
  return {
    accept: "application/json", "accept-language": "en-US,en;q=0.8", cookie: cookieHeader(cookies), referer,
    "x-requested-with": "XMLHttpRequest",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  };
}

function strictTotal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

async function validateAccountSession(context: PluginContext, cookies: Map<string, string>): Promise<void> {
  const fingerprint = createHash("sha256").update(cookies.get("sessionid") ?? "").digest("hex");
  if (verifiedAccountSessions.has(fingerprint)) return;
  const validation = await context.fetch("https://chaturbate.com/api/ts/chatmessages/pm_users/?offset=0", {
    headers: accountHeaders(cookies), redirect: "manual", signal: requestSignal(context),
  });
  if (validation.status >= 300 && validation.status < 400) throw new Error("The Chaturbate session redirected to login. Reconnect the account.");
  if (!validation.ok) throw new Error(`The Chaturbate account session could not be verified (HTTP ${validation.status})`);
  verifiedAccountSessions.add(fingerprint);
}

function followedCam(room: Record<string, unknown>, offline: boolean): (LiveCam & { online: boolean }) | undefined {
  const cam = chaturbateLiveCam({ ...room, current_show: "public" });
  if (!cam) return undefined;
  const suppliedThumbnail = text(room.img) ?? text(room.thumbnail) ?? text(room.thumbnail_url);
  return offline && !suppliedThumbnail
    ? { ...cam, thumbnailUrl: undefined, viewers: 0, online: false }
    : { ...cam, viewers: offline ? 0 : cam.viewers, online: !offline };
}

async function followedSnapshot(context: PluginContext): Promise<LiveCamFavoriteSnapshot> {
  let cookies: Map<string, string> | undefined;
  try { cookies = accountCookies(context.config); }
  catch (error) { return { cams: [], authoritative: false, skippedReason: error instanceof Error ? error.message : String(error) }; }
  if (!cookies) return { cams: [], authoritative: false, skippedReason: "Connect a Chaturbate account to synchronize followed creators." };

  const cams = new Map<string, LiveCam & { online: boolean }>();
  try {
    for (const offline of [false, true]) {
      let offset = 0;
      let expectedTotal: number | undefined;
      const categorySeen = new Set<string>();
      while (true) {
        const params = new URLSearchParams({ limit: String(FOLLOW_PAGE_SIZE), offset: String(offset), follow: "true" });
        if (offline) params.set("offline", "true");
        const response = await context.fetch(`https://chaturbate.com/api/ts/roomlist/room-list/?${params}`, {
          headers: accountHeaders(cookies), redirect: "manual", signal: requestSignal(context),
        });
        if (response.status >= 300 && response.status < 400) throw new Error("The Chaturbate followed list redirected to login. Reconnect the account.");
        if (!response.ok) throw new Error(`The Chaturbate followed list returned HTTP ${response.status}`);
        let payload: unknown;
        try { payload = await response.json(); }
        catch { throw new Error("Chaturbate returned an invalid followed list response"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Chaturbate returned an invalid followed list response");
        const value = payload as Record<string, unknown>;
        if (!("total_count" in value)) throw new Error("Chaturbate did not report the followed list total");
        const total = strictTotal(value.total_count);
        if (total === undefined || total > MAX_FOLLOWED_CAMS) throw new Error("The Chaturbate followed list total failed its safety check");
        if (expectedTotal === undefined) expectedTotal = total;
        else if (total !== expectedTotal) throw new Error("The Chaturbate followed list changed during synchronization");
        if (!Array.isArray(value.rooms)) throw new Error("Chaturbate returned an invalid followed room list");
        const rooms = value.rooms;
        if (rooms.length > FOLLOW_PAGE_SIZE) throw new Error("The Chaturbate followed list exceeded its requested page size");
        for (const room of rooms) {
          if (!room || typeof room !== "object" || Array.isArray(room) || (room as Record<string, unknown>).is_following !== true) {
            throw new Error("Chaturbate ignored the followed-only filter");
          }
          const cam = followedCam(room as Record<string, unknown>, offline);
          if (!cam) throw new Error("The Chaturbate followed list contains an invalid room");
          const key = cam.username.toLowerCase();
          if (categorySeen.has(key)) throw new Error("The Chaturbate followed list contains duplicate rooms");
          categorySeen.add(key);
          if (!cams.has(key)) cams.set(key, cam);
          if (cams.size > MAX_FOLLOWED_CAMS) throw new Error("The Chaturbate followed list exceeded its safety limit");
        }
        // The offset advances over Chaturbate's raw result window. Some
        // unavailable/deleted followed rooms count toward total_count but are
        // omitted from `rooms`, so advancing by rooms.length skips or loops.
        if (offset + FOLLOW_PAGE_SIZE >= total) break;
        offset += FOLLOW_PAGE_SIZE;
      }
    }
    if (cams.size) verifiedAccountSessions.add(createHash("sha256").update(cookies.get("sessionid") ?? "").digest("hex"));
    else await validateAccountSession(context, cookies);
    return { cams: [...cams.values()], authoritative: true };
  } catch (error) {
    const skippedReason = error instanceof Error ? error.message : String(error);
    context.log("warn", "Chaturbate favorite synchronization skipped", { reason: skippedReason });
    return { cams: [], authoritative: false, skippedReason };
  }
}

async function setRemoteFavorite(context: PluginContext, cam: LiveCam, favorite: boolean): Promise<{ synchronized: boolean }> {
  const cookies = accountCookies(context.config);
  if (!cookies) return { synchronized: false };
  if (!/^[a-z0-9_]+$/i.test(cam.username)) throw new Error("Chaturbate received an invalid room name");
  const username = cam.username;
  const roomUrl = `https://chaturbate.com/${username}/`;
  const headers = accountHeaders(cookies, roomUrl);
  const primed = await context.fetch(roomUrl, { headers, redirect: "manual", signal: requestSignal(context) });
  if (!primed.ok) throw new Error(`Chaturbate could not open the room (HTTP ${primed.status})`);
  const csrf = cookies.get("csrftoken");
  const response = await context.fetch(`https://chaturbate.com/follow/${favorite ? "follow" : "unfollow"}/${username}/`, {
    method: "POST", headers: { ...headers, ...(csrf ? { "x-csrftoken": csrf } : {}) }, redirect: "manual", signal: requestSignal(context),
  });
  if (!response.ok) throw new Error(`Chaturbate could not ${favorite ? "follow" : "unfollow"} ${username} (HTTP ${response.status})`);
  const verification = await context.fetch(`https://chaturbate.com/api/chatvideocontext/${username}/`, {
    headers, redirect: "manual", signal: requestSignal(context),
  });
  let payload: unknown;
  try { payload = await verification.json(); } catch { payload = undefined; }
  const following = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).following : undefined;
  if (!verification.ok || following !== favorite) throw new Error(`Chaturbate did not confirm that ${username} was ${favorite ? "followed" : "unfollowed"}`);
  return { synchronized: true };
}

export function chaturbateLiveCam(room: unknown): LiveCam | undefined {
  if (!room || typeof room !== "object" || Array.isArray(room)) return undefined;
  const value = room as Record<string, unknown>;
  const username = text(value.username) ?? text(value.room) ?? text(value.slug);
  if (!username || !/^[a-z0-9_]+$/i.test(username)) return undefined;
  const status = (text(value.current_show) ?? text(value.room_status) ?? text(value.label) ?? "public").toLowerCase();
  if (status !== "public") return undefined;
  let thumbnailUrl = text(value.img) ?? text(value.thumbnail) ?? text(value.thumbnail_url);
  if (thumbnailUrl?.startsWith("//")) thumbnailUrl = `https:${thumbnailUrl}`;
  const age = whole(value.age ?? value.display_age);
  return {
    id: username.toLowerCase(), username,
    title: text(value.room_subject) ?? text(value.subject) ?? username,
    pageUrl: `https://chaturbate.com/${username}/`,
    thumbnailUrl: thumbnailUrl ?? `https://roomimg.stream.highwebmedia.com/ri/${encodeURIComponent(username)}.jpg`,
    viewers: whole(value.num_users ?? value.viewers ?? value.num_viewers) ?? 0,
    age: age !== undefined && age >= 18 && age <= 80 ? age : undefined, gender: text(value.gender), tags: tags(value.tags),
  };
}

export function chaturbateLiveCamPage(payload: unknown, page: number, pageSize: number): LiveCamPage {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Chaturbate returned an invalid live room list");
  const value = payload as Record<string, unknown>; let rooms: unknown = value.rooms;
  if (rooms && typeof rooms === "object" && !Array.isArray(rooms)) {
    const nested = rooms as Record<string, unknown>;
    rooms = nested.rooms ?? nested.results ?? nested.items ?? Object.values(nested);
  }
  if (!Array.isArray(rooms)) throw new Error("Chaturbate returned an invalid live room list");
  const cams = rooms.map(chaturbateLiveCam).filter((cam): cam is LiveCam => Boolean(cam));
  const total = whole(value.total_count ?? value.totalCount ?? value.num_total ?? value.numTotal ?? value.total) ?? cams.length;
  return { cams, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function chaturbateLiveCandidate(info: Record<string, unknown>, profileUrl: string): MediaCandidate | undefined {
  const liveStatus = text(info.live_status)?.toLowerCase();
  if (info.is_live !== true && liveStatus !== "is_live") return undefined;
  const id = text(info.id) ?? new URL(profileUrl).pathname.split("/").filter(Boolean)[0] ?? "live";
  const started = stamp(info.release_timestamp) ?? stamp(info.timestamp);
  const formats = Array.isArray(info.formats) ? info.formats as Array<Record<string, unknown>> : [];
  const streamKey = stableStreamKey(formats.map((format) => text(format.url)).find(Boolean) ?? `${id}:${started ?? "current"}`);
  const session = started ? String(started) : createHash("sha256").update(streamKey).digest("hex").slice(0, 16);
  return {
    externalId: `chaturbate:${id}:${session}`,
    title: text(info.title) ?? `${id} live`,
    pageUrl: profileUrl,
    mediaType: "video",
    publishedAt: started ? new Date(started * 1000).toISOString() : undefined,
    filename: `${id}-${session}.mp4`,
    metadata: { extractorUrl: profileUrl, live: true },
  };
}

export default definePlugin({
  manifest: {
    id: "org.easyx.chaturbate",
    name: "Chaturbate Live",
    version: "1.0.0",
    author: "Open EasyX",
    homepage: "https://github.com/yt-dlp/yt-dlp",
    description: "Check a public Chaturbate room and record a live session with yt-dlp and FFmpeg only when the room is broadcasting.",
    capabilities: ["media-listing", "download-resolver", "live-cam"],
    sourceUrlPatterns: ["http://chaturbate.com/*", "https://chaturbate.com/*", "http://www.chaturbate.com/*", "https://www.chaturbate.com/*"],
    polling: { mode: "live", defaultIntervalSeconds: 10, minimumIntervalSeconds: 5 },
    browserAuth: { loginUrl: "https://chaturbate.com/auth/login/", sessionSetting: "cookiesFile" },
    settings: [
      { key: "cookiesFile", label: "Account session", type: "session", cookieDomains: ["chaturbate.com"], help: "Optional. Public rooms normally do not require an account session." },
    ],
  },
  async testConnection(context) {
    const extractor = await testYtDlp(context, "Chaturbate");
    if (!extractor.ok || !text(context.config.cookiesFile)) return extractor;
    try {
      const cookies = accountCookies(context.config);
      if (!cookies) return { ok: false, message: "Connect a Chaturbate account in the integrated browser." };
      await validateAccountSession(context, cookies);
      return { ok: true, message: `${extractor.message} Chaturbate account session verified.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  async listMedia(context, source) {
    try {
      const profileUrl = normalizedChaturbateUrl(source.profileUrl);
      const info = await runYtDlpJson(context, ["--skip-download", "--dump-single-json", "--socket-timeout", "20", "--referer", "https://chaturbate.com/", ...configuredArgs(context.config), profileUrl], 90_000);
      const candidate = chaturbateLiveCandidate(info, profileUrl);
      return candidate ? [candidate] : [];
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (OFFLINE.some((marker) => message.includes(marker))) return [];
      throw error;
    }
  },
  async listLiveCams(context, query) {
    const load = async (offset: number, limit: number) => {
      const params = new URLSearchParams({ limit: String(Math.min(100, limit)), offset: String(offset) });
      if (query.gender) params.set("genders", { female: "f", male: "m", couple: "c", trans: "t" }[query.gender]);
      if (query.search) params.set("keywords", query.search);
      const response = await context.fetch(`https://chaturbate.com/api/ts/roomlist/room-list/?${params}`, {
        headers: {
          accept: "application/json", "x-requested-with": "XMLHttpRequest", referer: "https://chaturbate.com/",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36",
        }, signal: context.signal ?? AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Chaturbate live rooms returned HTTP ${response.status}`);
      const page = chaturbateLiveCamPage(await response.json(), 1, limit);
      return { ...page, cams: page.cams.slice(0, limit) };
    };

    if (query.search) {
      const cacheKey = `${query.gender ?? ""}:${query.search.toLowerCase()}`;
      let matching = liveSearchCache?.key === cacheKey && liveSearchCache.expiresAt > Date.now() ? liveSearchCache.cams : undefined;
      if (!matching) {
        const first = await load(0, 100);
        const offsets = Array.from({ length: Math.max(0, Math.ceil(first.total / 100) - 1) }, (_, index) => (index + 1) * 100);
        const rest = await Promise.all(offsets.map((offset) => load(offset, 100)));
        const unique = new Map<string, LiveCam>();
        for (const cam of [first, ...rest].flatMap((page) => page.cams)) unique.set(cam.id, cam);
        const needle = query.search.toLowerCase();
        matching = [...unique.values()].filter((cam) => `${cam.username} ${cam.title ?? ""} ${(cam.tags ?? []).join(" ")}`.toLowerCase().includes(needle));
        liveSearchCache = { key: cacheKey, expiresAt: Date.now() + 10_000, cams: matching };
      }
      const start = (query.page - 1) * query.pageSize;
      return { cams: matching.slice(start, start + query.pageSize), total: matching.length, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(matching.length / query.pageSize)) };
    }

    const start = (query.page - 1) * query.pageSize; const end = start + query.pageSize;
    const base = Math.floor(start / 100) * 100;
    const offsets = Array.from({ length: Math.ceil((end - base) / 100) }, (_, index) => base + index * 100);
    const pages = await Promise.all(offsets.map((offset) => load(offset, Math.min(100, end - offset))));
    const cams = pages.flatMap((page) => page.cams).slice(start - base, end - base);
    const total = pages[0]?.total ?? cams.length;
    return { cams, total, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)) };
  },
  async listFollowedLiveCams(context) { return followedSnapshot(context); },
  async setLiveCamFavorite(context, cam, favorite) { return setRemoteFavorite(context, cam, favorite); },
  async resolveLiveStream(context, cam) { return ytDlpLiveStream(context, cam, { referer: "https://chaturbate.com/" }); },
  async resolveDownload(context, item) { return ytDlpDownload(item, context.config, { referer: "https://chaturbate.com/", live: true }); },
});
