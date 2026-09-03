import path from "node:path";
import { z } from "zod";
import type { DownloadItem } from "./database.js";
import { outputSettings, renderOutputPath, validateOutputTemplate, type RecordingPreset } from "../packages/output-settings.js";

const template = (kind: "path" | "filename") => z.string().superRefine((value, context) => {
  const message = validateOutputTemplate(value, kind); if (message) context.addIssue({ code: "custom", message });
});
export const settingsSchema = z.object({
  retentionDays: z.number().int().min(0).max(36500).optional(), maxConcurrentDownloads: z.number().int().min(1).max(8).optional(),
  autoQueueDiscovered: z.boolean().optional(), legalAccepted: z.boolean().optional(),
  defaultScrapeIntervalMinutes: z.number().int().min(5).max(525600).optional(), defaultLiveIntervalSeconds: z.number().int().min(5).max(3600).optional(),
  outputPathTemplate: template("path").optional(), outputFilenameTemplate: template("filename").optional(),
  recordingPreset: z.enum(["source", "h264-high", "h264-small", "h265"]).optional(),
});

export function downloadOutputPath(settings: Record<string, unknown>, item: DownloadItem, performer: string, site: string, originalFilename: string): string {
  const options = outputSettings(settings); const original = path.parse(originalFilename);
  const date = new Date(item.publishedAt || item.createdAt);
  const stamp = Number.isNaN(date.valueOf()) ? "unknown" : date.toISOString();
  const extension = item.metadata.live === true && item.mediaType === "video" && options.recordingPreset !== "source" ? ".mp4" : original.ext;
  return renderOutputPath(options, {
    performer, site, filename: original.name, title: item.title || original.name, id: item.id,
    date: stamp.slice(0, 10), time: stamp.slice(11, 19).replaceAll(":", "-"), year: stamp.slice(0, 4), month: stamp.slice(5, 7), day: stamp.slice(8, 10),
  }, extension);
}

export function recordingEncodingArgs(preset: RecordingPreset, input: string, output: string): string[] {
  if (preset === "source") return [];
  return ["-y", "-nostdin", "-v", "error", "-i", input, "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", preset === "h265" ? "libx265" : "libx264", "-preset", preset === "h264-small" ? "fast" : "medium",
    "-crf", preset === "h264-high" ? "18" : "26", "-pix_fmt", "yuv420p",
    "-vf", preset === "h264-small" ? "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" : "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    ...(preset === "h265" ? ["-tag:v", "hvc1"] : []), "-c:a", "aac", "-b:a", preset === "h264-high" ? "192k" : "128k",
    "-movflags", "+faststart", output];
}
