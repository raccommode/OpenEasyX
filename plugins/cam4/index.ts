import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import { accountSignal, cookieHeader, readAccountCookies } from "../account-cookies.js";
import type { LiveCam, LiveCamFavoriteSnapshot, PluginContext } from "../../packages/plugin-sdk/index.js";

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

export default plugin;
