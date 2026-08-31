import type { LiveCam, LiveCamPage, LiveCamQuery, PluginContext } from "../packages/plugin-sdk/index.js";
import { absoluteUrl, browserHtml, decodeHtml, plainHtml, renderedBrowserHtml } from "./browser-html-utils.js";

export type LiveCamDiscoveryProvider = "bongacams" | "cam4" | "cams" | "camsoda" | "livejasmin" | "myfreecams" | "stripchat" | "twitch" | "xcams";

const cache = new Map<string, { expiresAt: number; cams: LiveCam[] }>();
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function whole(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined; }
function tagList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[#,]+/) : [];
  return [...new Set(values.map((item) => item === null || item === undefined || item === "" ? undefined : typeof item === "object" ? text(record(item)?.name ?? record(item)?.label ?? record(item)?.slug) : text(String(item))).filter((item): item is string => Boolean(item)).map((item) => item.toLowerCase()))].slice(0, 20);
}
function normalizedGender(value: unknown): LiveCamQuery["gender"] | undefined {
  const key = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (["f", "female", "females", "woman", "women", "girl", "girls"].includes(key)) return "female";
  if (["m", "male", "males", "man", "men", "boy", "boys"].includes(key)) return "male";
  if (["t", "ts", "trans", "transgender", "femaletranny", "tranny"].includes(key)) return "trans";
  if (["c", "couple", "couples", "group", "malefemale"].includes(key)) return "couple";
  return undefined;
}
function attrs(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}
function imageFrom(value: string, base: string): string | undefined {
  const match = value.match(/<img\b([^>]*)>/i); if (!match) return undefined;
  const values = attrs(match[1]); const source = values["data-src"] || values["data-original"] || values["data-thumb"] || values.src;
  if (!source || source.startsWith("data:")) return undefined;
  try { return absoluteUrl(source, base); } catch { return undefined; }
}
function viewerCount(value: string): number {
  const match = plainHtml(value).match(/(\d+(?:[.,]\d+)?)\s*([km])?\s*(?:viewers?|watching|users?|connections?)/i);
  if (!match) return 0; const number = Number(match[1].replace(",", "."));
  return Math.round(number * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1));
}
function dedupe(cams: LiveCam[]): LiveCam[] {
  const result = new Map<string, LiveCam>();
  for (const cam of cams) {
    if (!cam.username.trim()) continue; const key = cam.username.toLowerCase(); const old = result.get(key);
    if (!old) result.set(key, cam);
    else result.set(key, { ...old, ...cam, thumbnailUrl: old.thumbnailUrl || cam.thumbnailUrl, viewers: Math.max(old.viewers ?? 0, cam.viewers ?? 0), tags: [...new Set([...(old.tags ?? []), ...(cam.tags ?? [])])] });
  }
  return [...result.values()];
}
function filteredPage(cams: LiveCam[], query: LiveCamQuery): LiveCamPage {
  const needle = query.search?.trim().toLowerCase();
  const matching = dedupe(cams).filter((cam) => {
    if (query.gender && normalizedGender(cam.gender) !== query.gender) return false;
    return !needle || `${cam.username} ${cam.title ?? ""} ${(cam.tags ?? []).join(" ")}`.toLowerCase().includes(needle);
  }).sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0));
  const start = (query.page - 1) * query.pageSize; const total = matching.length;
  return { cams: matching.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)) };
}
function scriptJson(html: string, id: string): unknown {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<script\\b[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i"));
  if (!match) return undefined; try { return JSON.parse(decodeHtml(match[1])); } catch { return undefined; }
}
function findRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const item = record(value); if (item) {
    const direct = record(item[key]); if (direct) return direct;
    for (const child of Object.values(item)) { const found = findRecord(child, key); if (found) return found; }
  } else if (Array.isArray(value)) for (const child of value) { const found = findRecord(child, key); if (found) return found; }
  return undefined;
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

export function bongacamsLiveCams(html: string): LiveCam[] {
  const config = record(scriptJson(html, "listingConfiguration")); const state = record(config?.stateData); const models = Array.isArray(state?.models) ? state.models : [];
  return models.map((entry): LiveCam | undefined => {
    const item = record(entry); const username = text(item?.username); if (!item || !username || String(item.room ?? "public").toLowerCase() !== "public") return undefined;
    let thumbnailUrl = text(item.thumb_image); if (thumbnailUrl) thumbnailUrl = `${thumbnailUrl.startsWith("//") ? "https:" : ""}${thumbnailUrl}`.replace("{ext}", "webp");
    return { id: username.toLowerCase(), username, title: text(item.thumbChatTopic) ?? text(item.display_name) ?? username, pageUrl: `https://bongacams.com/${encodeURIComponent(username)}`, thumbnailUrl, viewers: whole(item.viewers) ?? 0, gender: normalizedGender(item.gender), tags: tagList(item.thumbTags) } satisfies LiveCam;
  }).filter((cam): cam is LiveCam => Boolean(cam));
}

export function cam4LiveCams(html: string): LiveCam[] {
  const cams: LiveCam[] = [];
  for (const match of html.matchAll(/"BroadcastItem:\d+":/g)) {
    const raw = balancedObject(html, (match.index ?? 0) + match[0].length); if (!raw) continue;
    let item: Record<string, unknown> | undefined; try { item = record(JSON.parse(raw)); } catch { continue; }
    const username = text(item?.username); const show = String(item?.showType ?? "PUBLIC_SHOW").toUpperCase(); if (!item || !username || show !== "PUBLIC_SHOW") continue;
    const preview = record(item.preview); let thumbnailUrl = text(preview?.poster) ?? text(item.profileImageURL); if (thumbnailUrl) thumbnailUrl = thumbnailUrl.replaceAll("\\u002F", "/");
    const gender = normalizedGender(item.broadcastType); const tags = tagList([gender, ...[...raw.matchAll(/"__ref":"BroadcastTag:([^"]+)"/g)].map((tag) => tag[1])]);
    cams.push({ id: username.toLowerCase(), username, title: username, pageUrl: `https://www.cam4.com/${encodeURIComponent(username)}`, thumbnailUrl, viewers: whole(item.viewers) ?? 0, gender, tags });
  }
  return dedupe(cams);
}

export function camsLiveCams(html: string): LiveCam[] {
  const compressed = findRecord(scriptJson(html, "__NEXT_DATA__"), "compressedWonResponse");
  const mapping = Array.isArray(compressed?.mapping) ? compressed.mapping.map(String) : []; const rows = Array.isArray(compressed?.models) ? compressed.models : [];
  return rows.map((row): LiveCam | undefined => {
    if (!Array.isArray(row)) return undefined; const item = Object.fromEntries(mapping.map((key, index) => [key, row[index]])); const username = text(item.screen_name) ?? text(item.stream_name); if (!username) return undefined;
    const gender = normalizedGender(item.gender); const age = whole(item.public_age); const tags = tagList([gender, String(item.hq_enabled) === "2" ? "hd" : "", String(item.vr) === "1" ? "vr" : ""]);
    return { id: username.toLowerCase(), username, title: username, pageUrl: `https://cams.com/${encodeURIComponent(username)}`, thumbnailUrl: `https://images4.streamray.com/images/streamray/streams/${username.toLowerCase()}_640.gif`, viewers: whole(item.viewer_count ?? item.viewers) ?? 0, age: age && age >= 18 ? age : undefined, gender, tags } satisfies LiveCam;
  }).filter((cam): cam is LiveCam => Boolean(cam));
}

export function camsodaLiveCams(html: string): LiveCam[] {
  const cams: LiveCam[] = [];
  for (const match of html.matchAll(/<a\b([^>]*data-username\s*=\s*["'][^"']+["'][^>]*)>([\s\S]*?)(?=<a\b[^>]*data-username\s*=|<\/main>|<footer|$)/gi)) {
    const values = attrs(match[1]); const username = text(values["data-username"]); if (!username) continue; const body = match[2];
    let thumbnailUrl = text(values["data-thumb-image"]) ?? imageFrom(body, "https://www.camsoda.com/"); if (thumbnailUrl?.startsWith("//")) thumbnailUrl = `https:${thumbnailUrl}`;
    cams.push({ id: username.toLowerCase(), username, title: plainHtml(body).slice(0, 140) || username, pageUrl: absoluteUrl(values.href || `/${username}`, "https://www.camsoda.com/"), thumbnailUrl, viewers: viewerCount(body), gender: "female", tags: ["female"] });
  }
  return dedupe(cams);
}

export function livejasminLiveCams(html: string): LiveCam[] {
  const match = html.match(/listPagePerformers\s*=\s*(\[[\s\S]*?\]);/i); if (!match) return [];
  let values: unknown; try { values = JSON.parse(match[1]); } catch { return []; } if (!Array.isArray(values)) return [];
  return values.map((entry): LiveCam | undefined => {
    const item = record(entry); const username = text(item?.display_name); if (!item || !username || whole(item.status) !== 1) return undefined;
    const willingnesses = record(item.willingnesses); const gender = normalizedGender(item.main_category);
    return { id: username.toLowerCase(), username, title: username, pageUrl: `https://www.livejasmin.com/en/chat/${encodeURIComponent(username)}`, thumbnailUrl: text(item.profilePictureUrl), viewers: whole(item.viewers ?? item.num_users) ?? 0, gender, tags: tagList([...(willingnesses ? Object.values(willingnesses) : []), text(item.language)?.replace("lng_", ""), item.region]) } satisfies LiveCam;
  }).filter((cam): cam is LiveCam => Boolean(cam));
}

export function myfreecamsLiveCams(html: string): LiveCam[] {
  const cams: LiveCam[] = [];
  for (const match of html.matchAll(/<div\b([^>]*(?:model_online|modelbox_)[^>]*)>([\s\S]*?)(?=<div\b[^>]*(?:model_online|modelbox_)|<\/body>|$)/gi)) {
    const body = match[2]; const title = body.match(/title\s*=\s*["']Enter Chat Room of ([^"']+)["']/i); const username = text(title?.[1]); if (!username || username.includes("%")) continue;
    const uid = match[0].match(/modelbox_(\d+)|data-uid\s*=\s*["']?(\d+)/i); const id = uid?.[1] ?? uid?.[2];
    const thumbnailUrl = imageFrom(body, "https://www.myfreecams.com/") ?? (id ? `https://img.mfcimg.com/photos2/${id.slice(0, 3)}/${id}/avatar.300x300.jpg` : undefined);
    cams.push({ id: username.toLowerCase(), username, title: username, pageUrl: `https://mfc.im/${encodeURIComponent(username)}/chat`, thumbnailUrl, viewers: viewerCount(body) });
  }
  return dedupe(cams);
}

export function myfreecamsExplorerLiveCams(payload: string): { cams: LiveCam[]; total: number } {
  const total = whole(payload.match(/\bnRows\s*=\s*(\d+)/)?.[1]) ?? 0;
  const cams: LiveCam[] = [];
  for (const line of payload.split(/\r?\n/)) {
    const id = line.match(/aList\['(\d+)'\]/)?.[1];
    const username = text(line.match(/profiles\.myfreecams\.com\/([A-Za-z0-9_.-]+)/)?.[1]);
    if (!id || !username) continue;
    const thumbnailUrl = text(line.match(/\bsrc=(https:\/\/img\.mfcimg\.com\/[^\s'"<>]+)/i)?.[1]);
    const topic = text(line.match(/<X>(.*?)<X>/)?.[1]);
    cams.push({
      id: username.toLowerCase(), username, title: topic ? decodeHtml(topic) : username,
      pageUrl: `https://mfc.im/${encodeURIComponent(username)}/chat`,
      thumbnailUrl, viewers: 0, gender: "female", tags: ["female"],
    });
  }
  return { cams: dedupe(cams), total };
}

export function twitchLiveCams(html: string): LiveCam[] {
  const cams: LiveCam[] = [];
  for (const match of html.matchAll(/https:\/\/static-cdn\.jtvnw\.net\/previews-ttv\/live_user_([a-z0-9_]+)-[^"'&<\s]+/gi)) {
    const username = match[1]; const start = Math.max(0, (match.index ?? 0) - 1_500); const context = html.slice(start, (match.index ?? 0) + 1_500);
    cams.push({ id: username.toLowerCase(), username, title: plainHtml(context).slice(0, 140) || username, pageUrl: `https://www.twitch.tv/${username}`, thumbnailUrl: decodeHtml(match[0]), viewers: viewerCount(context) });
  }
  return dedupe(cams);
}

export function xcamsLiveCams(html: string): LiveCam[] {
  const cams: LiveCam[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']\/profile\/([^/"'?#]+)\/["']/gi)) {
    const username = decodeURIComponent(match[1]); const start = Math.max(0, (match.index ?? 0) - 700); const context = html.slice(start, (match.index ?? 0) + 1_400);
    cams.push({ id: username.toLowerCase(), username, title: username, pageUrl: `https://www.xcams.com/chat/${encodeURIComponent(username)}/`, thumbnailUrl: imageFrom(context, "https://www.xcams.com/"), viewers: viewerCount(context), gender: "female", tags: ["female"] });
  }
  return dedupe(cams);
}

function stripchatModels(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []; const item = record(value);
  if (item) {
    if (Array.isArray(item.models)) result.push(...item.models.map(record).filter((entry): entry is Record<string, unknown> => Boolean(entry)));
    for (const child of Object.values(item)) result.push(...stripchatModels(child));
  } else if (Array.isArray(value)) for (const child of value) result.push(...stripchatModels(child));
  return result;
}
export function stripchatLiveCams(payload: unknown): LiveCam[] {
  return dedupe(stripchatModels(payload).map((item): LiveCam | undefined => {
    const username = text(item.username ?? item.login); if (!username) return undefined; const status = String(item.status ?? "public").toLowerCase(); if (status !== "public" && item.isOnline !== true && item.isLive !== true) return undefined;
    const id = text(item.streamName) ?? (whole(item.id) !== undefined ? String(whole(item.id)) : undefined); const stamp = item.snapshotTimestamp !== undefined ? String(item.snapshotTimestamp) : item.verifiedSnapshotTimestamp !== undefined ? String(item.verifiedSnapshotTimestamp) : undefined; const gender = normalizedGender(item.broadcastGender ?? item.gender ?? item.genderGroup);
    let thumbnailUrl = id && stamp ? `https://img.doppiocdn.net/snapshot/${id}/${stamp}` : text(item.previewUrlThumbBig ?? item.previewUrl ?? item.avatarUrl);
    if (thumbnailUrl?.startsWith("/")) thumbnailUrl = `https://img.doppiocdn.net${thumbnailUrl}`;
    return { id: username.toLowerCase(), username, title: text(item.groupShowTopic ?? item.name) ?? username, pageUrl: `https://stripchat.com/${encodeURIComponent(username)}`, thumbnailUrl, viewers: whole(item.viewersCount ?? item.viewers ?? item.usersCount) ?? 0, age: whole(item.age), gender, tags: tagList([gender, item.country, item.isHd ? "hd" : "", item.isVr ? "vr" : "", ...(Array.isArray(item.tags) ? item.tags : [])]) } satisfies LiveCam;
  }).filter((cam): cam is LiveCam => Boolean(cam)));
}

export type StripchatStreamConfig = { modelId: string; domains: string[]; playerScriptUrl?: string };

function stripchatPreloadedState(html: string): Record<string, unknown> | undefined {
  const marker = html.indexOf("window.__PRELOADED_STATE__");
  const raw = marker >= 0 ? balancedObject(html, marker) : undefined;
  if (!raw) return undefined;
  try { return record(JSON.parse(raw)); } catch { return undefined; }
}

export function stripchatStreamConfig(html: string): StripchatStreamConfig | undefined {
  const state = stripchatPreloadedState(html);
  const model = record(record(state?.viewCam)?.model);
  const modelId = text(model?.id) ?? (whole(model?.id) !== undefined ? String(whole(model?.id)) : undefined);
  if (!modelId || (model?.isLive !== true && model?.isOnline !== true)) return undefined;
  const configV3 = record(state?.configV3);
  const common = record(configV3?.initialCommon);
  const featureSettings = record(record(configV3?.static)?.featureSettings);
  const features = record(record(state?.featuresConfig)?.features);
  const playerModule = record(features?.playerModuleExternalLoading) ?? record(featureSettings?.playerModuleExternalLoading);
  const fallbackDomains = record(featureSettings?.hlsFallback)?.fallbackDomains;
  const streamHosts = record(common?.hlsStreamHosts);
  const domains = [
    ...(Array.isArray(fallbackDomains) ? fallbackDomains : []),
    model?.hlsStreamHost, common?.hlsStreamHost, common?.defaultHlsStreamHost,
    ...(streamHosts ? Object.values(streamHosts) : []),
  ].map(text).filter((value): value is string => Boolean(value));
  const playerOrigin = text(featureSettings?.MMPExternalUnitedSourceOrigin) ?? text(featureSettings?.MMPExternalSourceOrigin);
  const playerVersion = text(playerModule?.mmpVersion);
  const playerScriptUrl = playerOrigin && playerVersion
    ? `${playerOrigin.replace(/\/+$/, "")}/${encodeURIComponent(playerVersion)}/main.js`
    : undefined;
  return { modelId, domains: [...new Set(domains)], ...(playerScriptUrl ? { playerScriptUrl } : {}) };
}

export function stripchatProfileLiveCams(html: string, requestedUsername?: string): LiveCam[] {
  const state = stripchatPreloadedState(html);
  const model = record(record(state?.viewCam)?.model);
  if (!model || (model.isLive !== true && model.isOnline !== true)) return [];
  const cams = stripchatLiveCams({ models: [model] });
  const needle = requestedUsername?.trim().toLowerCase();
  return needle ? cams.filter((cam) => cam.username.toLowerCase() === needle) : cams;
}

async function stripchatPage(context: PluginContext, query: LiveCamQuery): Promise<LiveCamPage> {
  const primaryTag = { female: "girls", male: "men", couple: "couples", trans: "trans" }[query.gender ?? "female"];
  const load = async () => {
    const url = new URL("https://stripchat.com/api/front/v2/models"); url.searchParams.set("primaryTag", primaryTag);
    const response = await context.fetch(url, { headers: { accept: "application/json", origin: "https://stripchat.com", referer: `https://stripchat.com/${primaryTag}`, "user-agent": USER_AGENT }, signal: context.signal ?? AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Stripchat live rooms returned HTTP ${response.status}`);
    return stripchatLiveCams(await response.json());
  };
  if (query.search) {
    const username = query.search.trim();
    const html = await browserHtml(context, `https://stripchat.com/${encodeURIComponent(username)}`);
    return filteredPage(stripchatProfileLiveCams(html, username), { ...query, page: 1 });
  }
  // Stripchat currently ignores offset/page parameters and returns the same
  // multi-block catalogue for every request. Page that catalogue locally so a
  // provider-filtered page never repeats page one. Keep one short-lived
  // snapshot so viewer-count reordering cannot move a room across page
  // boundaries while somebody navigates through the catalogue.
  const cacheKey = `stripchat:${primaryTag}`; const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return filteredPage(cached.cams, query);
  try {
    const cams = await load(); cache.set(cacheKey, { cams, expiresAt: Date.now() + 90_000 });
    return filteredPage(cams, query);
  } catch (error) {
    if (cached?.cams.length) {
      context.log("warn", "Stripchat live catalogue refresh failed; serving the last successful snapshot", error instanceof Error ? error.message : String(error));
      return filteredPage(cached.cams, query);
    }
    throw error;
  }
}

async function myfreecamsPage(context: PluginContext, query: LiveCamQuery): Promise<LiveCamPage> {
  if (query.gender && query.gender !== "female") return { cams: [], total: 0, page: query.page, pageSize: query.pageSize, pages: 1 };
  const explorerPageSize = 50;
  const firstExplorerPage = Math.floor(((query.page - 1) * query.pageSize) / explorerPageSize) + 1;
  const lastExplorerPage = Math.floor((((query.page - 1) * query.pageSize) + query.pageSize - 1) / explorerPageSize) + 1;
  const payloads = await Promise.all(Array.from({ length: lastExplorerPage - firstExplorerPage + 1 }, async (_, index) => {
    const result = await context.runCommand("easyx-browser-fetch", ["--mfc-models", String(firstExplorerPage + index), query.search?.trim() ?? ""], { timeoutMs: 75_000, maxOutputBytes: 16 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `MyFreeCams live models failed with exit code ${result.exitCode}`);
    return myfreecamsExplorerLiveCams(result.stdout);
  }));
  const total = payloads[0]?.total ?? 0;
  const offset = ((query.page - 1) * query.pageSize) - ((firstExplorerPage - 1) * explorerPageSize);
  const cams = dedupe(payloads.flatMap((part) => part.cams)).slice(offset, offset + query.pageSize);
  return { cams, total, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

async function loadProvider(context: PluginContext, provider: Exclude<LiveCamDiscoveryProvider, "stripchat" | "myfreecams">): Promise<LiveCam[]> {
  const cached = cache.get(provider); if (cached && cached.expiresAt > Date.now()) return cached.cams;
  try {
    let cams: LiveCam[];
    if (provider === "bongacams") cams = bongacamsLiveCams(await browserHtml(context, "https://bongacams.com/"));
    else if (provider === "cam4") cams = cam4LiveCams(await browserHtml(context, "https://www.cam4.com/"));
    else if (provider === "cams") cams = camsLiveCams(await browserHtml(context, "https://www.cams.com/"));
    else if (provider === "camsoda") cams = camsodaLiveCams(await browserHtml(context, "https://www.camsoda.com/"));
    else if (provider === "livejasmin") cams = livejasminLiveCams(await browserHtml(context, "https://www.livejasmin.com/en/girls"));
    else if (provider === "twitch") cams = twitchLiveCams(await renderedBrowserHtml(context, "https://www.twitch.tv/directory/all"));
    else cams = xcamsLiveCams(await browserHtml(context, "https://www.xcams.com/"));
    cache.set(provider, { cams, expiresAt: Date.now() + 90_000 }); return cams;
  } catch (error) {
    if (cached?.cams.length) {
      context.log("warn", `${provider} live catalogue refresh failed; serving the last successful snapshot`, error instanceof Error ? error.message : String(error));
      return cached.cams;
    }
    throw error;
  }
}

export async function listDiscoveredLiveCams(context: PluginContext, provider: LiveCamDiscoveryProvider, query: LiveCamQuery): Promise<LiveCamPage> {
  if (provider === "stripchat") return stripchatPage(context, query);
  if (provider === "myfreecams") return myfreecamsPage(context, query);
  return filteredPage(await loadProvider(context, provider), query);
}
