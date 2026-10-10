import { createHash } from "node:crypto";
import { recordingMaxHeight } from "./hls-quality.js";
import { definePlugin, type EasyXPlugin, type MediaCandidate, type PluginManifest } from "../packages/plugin-sdk/index.js";
import { browserCapturedLiveStream } from "./browser-html-utils.js";
import { listDiscoveredLiveCams, type LiveCamDiscoveryProvider } from "./live-cam-discovery.js";
import { configuredArgs, runYtDlpJson, testYtDlp, ytDlpDownload, ytDlpLiveStream } from "./yt-dlp-utils.js";

const OFFLINE_MARKERS = [
  "channel is not currently live", "model is offline", "model is in private show", "no active streams",
  "not currently broadcasting", "not currently live", "not live", "offline", "room is private", "user not live",
];

type LiveCamPluginOptions = {
  id: string;
  name: string;
  prefix: string;
  homepage: string;
  description: string;
  sourceUrlPatterns: string[];
  cookieDomains: string[];
  loginUrl?: string;
  referer?: string;
  defaultIntervalSeconds?: number;
  minimumIntervalSeconds?: number;
  discovery?: LiveCamDiscoveryProvider;
  sessionHelp?: string;
  sessionRequiredForPlaybackMessage?: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function streamIdentity(info: Record<string, unknown>, profileUrl: string): string {
  const formats = Array.isArray(info.formats) ? info.formats as Array<Record<string, unknown>> : [];
  const raw = text(info.url) ?? formats.map((format) => text(format.url)).find(Boolean) ?? profileUrl;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

function profileName(value: string): string {
  const url = new URL(value);
  const fragment = url.hash.replace(/^#/, "").split("/").filter(Boolean)[0];
  const parts = url.pathname.split("/").filter(Boolean);
  const markers = new Set(["chat", "girls", "model", "models", "profile"]);
  const markerIndex = parts.findIndex((part) => markers.has(part.toLowerCase()));
  return decodeURIComponent(fragment || (markerIndex >= 0 ? parts[markerIndex + 1] : parts.at(-1)) || "live");
}

export function genericLiveCandidate(info: Record<string, unknown>, profileUrl: string, prefix: string): MediaCandidate | undefined {
  const liveStatus = text(info.live_status)?.toLowerCase();
  if (info.is_live !== true && liveStatus !== "is_live") return undefined;
  const username = text(info.uploader_id) ?? text(info.channel_id) ?? text(info.id) ?? profileName(profileUrl);
  const started = timestamp(info.release_timestamp) ?? timestamp(info.timestamp);
  const session = started ? String(started) : createHash("sha256").update(streamIdentity(info, profileUrl)).digest("hex").slice(0, 16);
  const safeName = username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  return {
    externalId: `${prefix}:${username.toLowerCase()}:${session}`,
    title: text(info.title) ?? `${username} live`,
    pageUrl: profileUrl,
    mediaType: "video",
    publishedAt: started ? new Date(started * 1000).toISOString() : undefined,
    filename: `${safeName}-${session}.mp4`,
    metadata: { extractorUrl: profileUrl, live: true },
  };
}

export function createLiveCamPlugin(options: LiveCamPluginOptions): EasyXPlugin {
  const referer = options.referer ?? `${options.homepage.replace(/\/+$/, "")}/`;
  const settings: NonNullable<PluginManifest["settings"]> = [{
    key: "cookiesFile", label: "Account session", type: "session", cookieDomains: options.cookieDomains,
    help: options.sessionHelp ?? "Optional for public rooms. Import your own browser session only when the provider requires it.",
  }];
  return definePlugin({
    manifest: {
      id: options.id,
      name: options.name,
      version: "1.0.0",
      author: "Open EasyX",
      homepage: options.homepage,
      description: options.description,
      capabilities: ["media-listing", "download-resolver", "live-cam"],
      sourceUrlPatterns: options.sourceUrlPatterns,
      polling: {
        mode: "live",
        defaultIntervalSeconds: options.defaultIntervalSeconds ?? 15,
        minimumIntervalSeconds: options.minimumIntervalSeconds ?? 10,
      },
      settings,
      ...(options.loginUrl ? { browserAuth: { loginUrl: options.loginUrl, sessionSetting: "cookiesFile" } } : {}),
    },
    async testConnection(context) { return testYtDlp(context, options.name); },
    async listMedia(context, source) {
      try {
        const info = await runYtDlpJson(context, [
          "--skip-download", "--dump-single-json", "--socket-timeout", "20", "--referer", referer,
          ...configuredArgs(context.config), source.profileUrl,
        ], 90_000);
        const candidate = genericLiveCandidate(info, source.profileUrl, options.prefix);
        return candidate ? [candidate] : [];
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        if (OFFLINE_MARKERS.some((marker) => message.includes(marker))) return [];
        throw error;
      }
    },
    async resolveLiveStream(context, cam) {
      try { return await ytDlpLiveStream(context, cam, { referer, impersonate: "chrome" }); }
      catch (error) {
        context.log("debug", `${options.name} yt-dlp live resolution failed; trying browser capture`, error instanceof Error ? error.message : String(error));
        try { return await browserCapturedLiveStream(context, cam.pageUrl); }
        catch (captureError) {
          if (options.sessionRequiredForPlaybackMessage && !text(context.config.cookiesFile)) {
            throw new Error(options.sessionRequiredForPlaybackMessage, { cause: captureError });
          }
          throw captureError;
        }
      }
    },
    ...(options.discovery ? { async listLiveCams(context, query) { return listDiscoveredLiveCams(context, options.discovery!, query); } } : {}),
    async resolveDownload(context, item) { return ytDlpDownload(item, context.config, { referer, live: true, maxHeight: recordingMaxHeight(context.config) }); },
  });
}
