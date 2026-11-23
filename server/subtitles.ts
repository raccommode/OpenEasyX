import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function isSubtitleLanguageCode(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value);
}

export function subtitleFilePath(dataDir: string, mediaId: string, trackId: string) {
  if (!/^[a-z0-9-]+$/i.test(mediaId) || !/^[a-z0-9-]+$/i.test(trackId)) throw new Error("Invalid subtitle path");
  return path.join(dataDir, "subtitles", mediaId, `${trackId}.vtt`);
}

export function writeManualSubtitle(dataDir: string, mediaId: string, language: string, webvtt: string) {
  if (!isSubtitleLanguageCode(language)) throw new Error("Invalid subtitle language code");
  const trackId = `manual-${language}`;
  const destination = subtitleFilePath(dataDir, mediaId, trackId);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, webvtt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { trackId, destination };
}
