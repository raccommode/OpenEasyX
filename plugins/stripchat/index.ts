import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import { browserHtml } from "../browser-html-utils.js";
import { stripchatStreamConfig } from "../live-cam-discovery.js";
import type { CommandDownloadRequest, LiveStream, MediaCandidate, PluginContext } from "../../packages/plugin-sdk/index.js";

const plugin = createLiveCamPlugin({
  id: "org.easyx.stripchat", name: "Stripchat Live", prefix: "stripchat", homepage: "https://stripchat.com",
  discovery: "stripchat",
  description: "Check a public Stripchat room and play or record its active live stream with yt-dlp and FFmpeg.",
  sourceUrlPatterns: ["http://stripchat.com/*", "https://stripchat.com/*", "http://www.stripchat.com/*", "https://www.stripchat.com/*"],
  cookieDomains: ["stripchat.com"], loginUrl: "https://stripchat.com/login", minimumIntervalSeconds: 5, defaultIntervalSeconds: 10,
});

const genericResolveLiveStream = plugin.resolveLiveStream!;
const PLAYBACK_KEY_PATTERN = /\.set\(\s*["']pkey["']\s*,\s*["']([a-z0-9_-]{12,128})["']\s*\)/i;

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

plugin.resolveLiveStream = async (context, cam) => {
  try {
    return await resolveStripchatDirect(context, cam.pageUrl);
  } catch (error) {
    context.log("debug", "Stripchat direct HLS resolution failed; trying generic extraction", error instanceof Error ? error.message : String(error));
    return genericResolveLiveStream(context, cam);
  }
};
plugin.resolveDownload = resolveStripchatDownload;

export default plugin;
