import { createHash } from "node:crypto";
import { recordingMaxHeight } from "../hls-quality.js";
import { definePlugin, type MediaCandidate } from "../../packages/plugin-sdk/index.js";
import { listDiscoveredLiveCams } from "../live-cam-discovery.js";
import { configuredArgs, runYtDlpJson, testYtDlp, ytDlpDownload, ytDlpLiveStream } from "../yt-dlp-utils.js";

const OFFLINE = ["offline", "not currently live", "channel is not live", "not live"];
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export function twitchLiveCandidate(info: Record<string, unknown>, profileUrl: string): MediaCandidate | undefined {
  const status = text(info.live_status)?.toLowerCase();
  if (info.is_live !== true && status !== "is_live") return undefined;
  const id = text(info.id) ?? new URL(profileUrl).pathname.split("/").filter(Boolean)[0] ?? "live";
  const started = Number(info.release_timestamp ?? info.timestamp);
  const session = Number.isFinite(started) && started > 0 ? String(started) : createHash("sha256").update(`${id}:${text(info.url) ?? text(info.webpage_url) ?? profileUrl}`).digest("hex").slice(0, 16);
  return { externalId: `twitch:${id}:${session}`, title: text(info.title) ?? `${id} live`, pageUrl: profileUrl, mediaType: "video", publishedAt: Number.isFinite(started) && started > 0 ? new Date(started * 1000).toISOString() : undefined, filename: `${id}-${session}.mp4`, metadata: { extractorUrl: profileUrl, live: true } };
}

export default definePlugin({
  manifest: {
    id: "org.easyx.twitch",
    name: "Twitch Live",
    version: "1.0.0",
    author: "Open EasyX",
    homepage: "https://github.com/yt-dlp/yt-dlp",
    description: "Check a public Twitch channel and record a user-selected live session with yt-dlp and FFmpeg.",
    capabilities: ["media-listing", "download-resolver", "live-cam"],
    sourceUrlPatterns: ["http://twitch.tv/*", "https://twitch.tv/*", "http://www.twitch.tv/*", "https://www.twitch.tv/*"],
    polling: { mode: "live", defaultIntervalSeconds: 30, minimumIntervalSeconds: 15 },
    browserAuth: { loginUrl: "https://www.twitch.tv/login", sessionSetting: "cookiesFile" },
    settings: [
      { key: "cookiesFile", label: "Account session", type: "session", cookieDomains: ["twitch.tv"], help: "Optional for public channels. Paste your own browser Cookie header or import a cookies.txt export." },
    ],
  },
  async testConnection(context) { return testYtDlp(context, "Twitch"); },
  async listMedia(context, source) {
    try {
      const info = await runYtDlpJson(context, ["--skip-download", "--dump-single-json", "--socket-timeout", "20", ...configuredArgs(context.config), source.profileUrl], 90_000);
      const candidate = twitchLiveCandidate(info, source.profileUrl);
      return candidate ? [candidate] : [];
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (OFFLINE.some((marker) => message.includes(marker))) return [];
      throw error;
    }
  },
  async resolveLiveStream(context, cam) { return ytDlpLiveStream(context, cam, { referer: "https://www.twitch.tv/" }); },
  async listLiveCams(context, query) { return listDiscoveredLiveCams(context, "twitch", query); },
  async resolveDownload(context, item) { return ytDlpDownload(item, context.config, { referer: "https://www.twitch.tv/", live: true, maxHeight: recordingMaxHeight(context.config) }); },
});
