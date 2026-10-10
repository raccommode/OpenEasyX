import { oldestMediaDate as mediaDate } from "../packages/media-date.js";
import { ytDlpHeightSort } from "./hls-quality.js";
import type { CommandDownloadRequest, LiveCam, LiveStream, MediaCandidate, PluginContext } from "../packages/plugin-sdk/index.js";

type YtDlpEntry = Record<string, unknown> & { entries?: YtDlpEntry[] };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function configuredArgs(config: Record<string, unknown>): string[] {
  const args: string[] = [];
  const cookiesFile = text(config.cookiesFile);
  if (cookiesFile) args.push("--cookies", cookiesFile);
  return args;
}

export async function testYtDlp(context: PluginContext, label: string): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await context.runCommand("yt-dlp", ["--version"], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
    const version = result.stdout.trim();
    return result.exitCode === 0
      ? { ok: true, message: `${label} extractor is ready (yt-dlp ${version || "installed"}).` }
      : { ok: false, message: `yt-dlp exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runYtDlpJson(context: PluginContext, args: string[], timeoutMs = 120_000): Promise<YtDlpEntry> {
  const result = await context.runCommand("yt-dlp", ["--no-warnings", ...args], { timeoutMs, maxOutputBytes: 25 * 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim() || `yt-dlp exited with code ${result.exitCode}`);
  const output = result.stdout.trim();
  if (!output) throw new Error("yt-dlp returned no metadata");
  try { return JSON.parse(output) as YtDlpEntry; }
  catch { throw new Error("yt-dlp returned invalid JSON metadata"); }
}

export function liveStreamFromInfo(info: YtDlpEntry, username: string): LiveStream {
  const formats = Array.isArray(info.formats) ? info.formats as Array<Record<string, unknown>> : [];
  const requested = Array.isArray(info.requested_formats) ? info.requested_formats as Array<Record<string, unknown>> : [];
  const entries = [info, ...requested, ...formats];
  const requestedVideo = requested.find((entry) => /^https?:\/\//i.test(text(entry.url) ?? "") && text(entry.vcodec) !== "none");
  const requestedAudio = requested.find((entry) => /^https?:\/\//i.test(text(entry.url) ?? "") && text(entry.vcodec) === "none");
  if (requestedVideo && requestedAudio) {
    const rawHeaders = requestedVideo.http_headers ?? requestedAudio.http_headers ?? info.http_headers;
    const headers = rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)
      ? Object.fromEntries(Object.entries(rawHeaders as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>
      : undefined;
    return {
      url: text(requestedVideo.url)!, audioUrl: text(requestedAudio.url)!, headers,
      contentType: "application/vnd.apple.mpegurl",
    };
  }
  const manifest = entries.find((entry) => {
    const url = text(entry.manifest_url);
    return Boolean(url && /^https?:\/\//i.test(url) && /\.m3u8(?:$|\?)/i.test(url));
  });
  const playable = entries.filter((entry) => {
    const url = text(entry.url);
    const video = text(entry.vcodec); const audio = text(entry.acodec);
    return Boolean(url && /^https?:\/\//i.test(url) && video !== "none" && audio !== "none");
  }).sort((left, right) => (number(right.height) ?? 0) - (number(left.height) ?? 0) || (number(right.tbr) ?? 0) - (number(left.tbr) ?? 0));
  const selected = manifest ?? playable[0] ?? entries.find((entry) => {
    const url = text(entry.url); return Boolean(url && /^https?:\/\//i.test(url) && text(entry.vcodec) !== "none");
  }) ?? entries.find((entry) => /^https?:\/\//i.test(text(entry.url) ?? ""));
  const url = manifest ? text(selected?.manifest_url) : text(selected?.url);
  if (!url) throw new Error(`${username} did not expose a playable live stream`);
  const rawHeaders = selected?.http_headers ?? info.http_headers;
  const headers = rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)
    ? Object.fromEntries(Object.entries(rawHeaders as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>
    : undefined;
  return { url, headers, contentType: /\.m3u8(?:$|\?)/i.test(url) ? "application/vnd.apple.mpegurl" : undefined };
}

export async function ytDlpLiveStream(context: PluginContext, cam: LiveCam, options: { referer?: string; impersonate?: string; forceIpv4?: boolean } = {}): Promise<LiveStream> {
  const args = ["--skip-download", "--dump-single-json", "--socket-timeout", "20", ...configuredArgs(context.config)];
  if (options.forceIpv4) args.push("--force-ipv4");
  if (options.impersonate) args.push("--impersonate", options.impersonate);
  if (options.referer) args.push("--referer", options.referer);
  const info = await runYtDlpJson(context, [...args, cam.pageUrl], 90_000);
  return liveStreamFromInfo(info, cam.username);
}

export function playlistCandidates(info: YtDlpEntry, sourceUrl: string, prefix: string, limit: number): MediaCandidate[] {
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  const found = new Map<string, MediaCandidate>();
  for (const entry of entries) {
    const pageUrl = text(entry.webpage_url) ?? text(entry.original_url) ?? text(entry.url);
    let id = text(entry.id) ?? text(entry.display_id);
    if (!id && pageUrl) {
      try {
        const url = new URL(pageUrl);
        id = url.searchParams.get("viewkey") ?? url.searchParams.get("v") ?? url.pathname.split("/").filter(Boolean).at(-1);
      } catch { /* The URL is validated below. */ }
    }
    if (!id || !pageUrl || !/^https?:\/\//i.test(pageUrl)) continue;
    const width = number(entry.width); const height = number(entry.height); const bitrate = number(entry.tbr) ?? 0;
    const publishedAt = mediaDate(entry.timestamp, entry.release_timestamp, entry.upload_timestamp, entry.release_date, entry.upload_date);
    found.set(id, {
      externalId: `${prefix}:${id}`,
      identityKey: `${prefix}:${id}`,
      title: text(entry.title) ?? id,
      pageUrl,
      mediaType: "video",
      publishedAt,
      filename: `${id}.mp4`,
      qualityScore: (width ?? 0) * (height ?? 0) + bitrate,
      metadata: { extractorUrl: pageUrl, sourceUrl },
    });
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

export function ytDlpDownload(item: MediaCandidate, config: Record<string, unknown>, options: { referer?: string; live?: boolean; impersonate?: string; forceIpv4?: boolean; maxHeight?: number } = {}): CommandDownloadRequest {
  const extractorUrl = text(item.metadata?.extractorUrl) ?? item.pageUrl;
  if (!extractorUrl) throw new Error("The extractor did not provide a downloadable page URL");
  const height = options.live && options.maxHeight && Number.isInteger(options.maxHeight) && options.maxHeight > 0 ? `[height<=${options.maxHeight}]` : "";
  // With a maximum height, the best format at or below it wins; when the room offers
  // nothing that small, the fallback (sorted by --format-sort res:N) takes the closest
  // larger quality, so a missing quality never fails the recording.
  const heightSort = height ? ytDlpHeightSort(options.maxHeight!) : undefined;
  const format = options.live
    ? `bestvideo${height}+bestaudio/best${height}${height ? "/bestvideo+bestaudio/best" : ""}`
    : "bestvideo*[vcodec!=none]+bestaudio[acodec!=none]/best[acodec!=none]/best";
  const args = [
    "--progress", "--newline", "--progress-delta", "0.5", "--progress-template", "download:easyx-progress:%(progress._percent_str)s", "--no-playlist", "--retries", "5", "--fragment-retries", "5",
    "--concurrent-fragments", "1", ...configuredArgs(config),
  ];
  if (options.forceIpv4) args.push("--force-ipv4");
  if (options.impersonate) args.push("--impersonate", options.impersonate);
  if (options.referer) args.push("--referer", options.referer);
  if (heightSort) args.push("--format-sort", heightSort);
  args.push("--format", format, "--merge-output-format", "mp4", "--remux-video", "mp4", "--output", "{output}");
  // Capture separate live video/audio together, preserving their shared timeline.
  if (options.live) args.push("--downloader", "ffmpeg", "--no-hls-use-mpegts");
  args.push(extractorUrl);
  return { kind: "command", command: "yt-dlp", args, filename: item.filename ?? `${item.externalId}.mp4` };
}

export function positiveInteger(value: unknown, fallback: number, maximum = 500): number {
  return Math.max(1, Math.min(maximum, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback));
}
