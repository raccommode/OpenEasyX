import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LibraryDatabase, type Media, type MediaKind } from "./library-database.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".ts", ".mts", ".m2ts"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);
const MIMES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".ts": "video/mp2t",
  ".mts": "video/mp2t", ".m2ts": "video/mp2t", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp",
};

function cleanTitle(filename: string) {
  return path.basename(filename, path.extname(filename)).replace(/\.info$/i, "").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

function metadataString(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sourceDomain(value: string) {
  const source = value.trim();
  if (!source || (!source.includes(".") && !source.includes("://") && !source.includes("/"))) return source;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(source) ? source : `https://${source}`);
    return parsed.hostname.replace(/^www\./i, "") || source;
  } catch {
    return source.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] || source;
  }
}

function readSidecar(file: string): Record<string, unknown> {
  const candidates = [file.replace(/\.[^.]+$/, ".info.json"), file.replace(/\.[^.]+$/, ".json")];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).size > 8 * 1024 * 1024) continue;
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* Sidecars are optional and never block a scan. */ }
  }
  return {};
}

function walk(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

function runFfmpeg(args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", ...args]);
    let error = ""; let settled = false;
    const finish = (failure?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (failure) reject(failure); else resolve();
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("FFmpeg preview generation timed out")); }, timeoutMs);
    child.stderr.on("data", (chunk) => { error = `${error}${String(chunk)}`.slice(-4000); });
    child.on("error", (failure) => finish(failure));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error(error || "FFmpeg could not generate this preview")));
  });
}

export class Catalog {
  private scanPromise: Promise<{ indexed: number; durationMs: number }> | null = null;
  private thumbnails = new Map<string, Promise<string>>();
  private previews = new Map<string, Promise<string>>();
  private playbackFiles = new Map<string, Promise<string>>();
  private ffmpegQueue: Promise<void> = Promise.resolve();
  readonly status = { running: false, indexed: 0, lastScanAt: "", error: "" };

  constructor(
    readonly db: LibraryDatabase,
    readonly mediaRoot: string,
    readonly dataDir: string,
    readonly eagerThumbnails = process.env.NODE_ENV !== "test" && process.env.EASYX_EAGER_THUMBNAILS !== "false",
  ) {
    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "thumbnails"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dataDir, "video-previews"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dataDir, "playback-cache"), { recursive: true, mode: 0o700 });
  }

  scan() {
    if (this.scanPromise) return this.scanPromise;
    this.status.running = true;
    this.status.error = "";
    this.scanPromise = Promise.resolve().then(() => {
      const started = Date.now();
      const scanId = new Date().toISOString();
      let indexed = 0;
      for (const absolute of walk(this.mediaRoot)) {
        const extension = path.extname(absolute).toLowerCase();
        const kind: MediaKind | undefined = VIDEO_EXTENSIONS.has(extension) ? "video" : IMAGE_EXTENSIONS.has(extension) ? "image" : undefined;
        if (!kind) continue;
        try {
          const stat = fs.statSync(absolute);
          const relativePath = path.relative(this.mediaRoot, absolute).split(path.sep).join("/");
          const parts = relativePath.split("/");
          const metadata = readSidecar(absolute);
          const titleValue = metadataString(metadata, ["title"]);
          const performerValue = metadataString(metadata, ["performer"]);
          const sourceValue = metadataString(metadata, ["source", "sourceUrl", "source_url", "webpage_url", "url"]);
          const id = crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 24);
          this.db.upsertMedia({
            id,
            relativePath, kind, title: titleValue || cleanTitle(relativePath), performer: performerValue || (parts.length > 1 ? parts[0] : "Unsorted"),
            source: sourceDomain(sourceValue || (parts.length > 2 ? parts[1] : "")), extension, mimeType: MIMES[extension] ?? "application/octet-stream",
            size: stat.size, modifiedAt: stat.mtime.toISOString(), addedAt: stat.birthtime.toISOString(),
            duration: 0, width: 0, height: 0, metadata, scanId,
          });
          if (this.eagerThumbnails) {
            const media = this.db.getMedia(id);
            if (media) void this.thumbnail(media).catch(() => { this.db.markMediaUnplayable(media.id); });
          }
          indexed++;
        } catch { /* A file may disappear while the scan is in progress. */ }
      }
      this.db.finishScan(scanId);
      this.status.indexed = indexed;
      this.status.lastScanAt = new Date().toISOString();
      return { indexed, durationMs: Date.now() - started };
    }).catch((error) => {
      this.status.error = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => {
      this.status.running = false;
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  absolutePath(media: Media) {
    const root = path.resolve(this.mediaRoot);
    const candidate = path.resolve(root, media.relativePath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("Media path escapes the configured library root");
    return candidate;
  }

  private removeGeneratedArtifacts(mediaId: string, kind: MediaKind) {
    const cached = [
      path.join(this.dataDir, "thumbnails", kind === "video" ? `${mediaId}-middle-v1.jpg` : `${mediaId}-image-v1.jpg`),
      path.join(this.dataDir, "video-previews", `${mediaId}.gif`),
      path.join(this.dataDir, "playback-cache", `${mediaId}.mp4`),
    ];
    for (const file of cached) fs.rmSync(file, { force: true });
    fs.rmSync(path.join(this.dataDir, "subtitles", mediaId), { recursive: true, force: true });
  }

  deleteStoredMedia(relativePath: string) {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const root = path.resolve(this.mediaRoot);
    const source = path.resolve(root, ...normalized.split("/"));
    if (!normalized || source === root || !source.startsWith(`${root}${path.sep}`)) {
      throw Object.assign(new Error("Media path escapes the configured library root"), { statusCode: 409 });
    }
    const extension = path.extname(normalized).toLowerCase();
    const kind: MediaKind | undefined = VIDEO_EXTENSIONS.has(extension) ? "video" : IMAGE_EXTENSIONS.has(extension) ? "image" : undefined;
    if (!kind) throw Object.assign(new Error("Stored item is not a supported media file"), { statusCode: 409 });
    const mediaId = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.db.markMediaMissing(mediaId);
      this.removeGeneratedArtifacts(mediaId, kind);
      return { bytes: 0, missing: true };
    }
    if (!stat.isFile()) throw Object.assign(new Error("Media path is not a regular file"), { statusCode: 409 });
    try { fs.unlinkSync(source); }
    catch { throw Object.assign(new Error("Media file could not be deleted. Check that the media mount is writable"), { statusCode: 409 }); }
    this.db.markMediaMissing(mediaId);
    this.removeGeneratedArtifacts(mediaId, kind);
    return { bytes: stat.size, missing: false };
  }

  deleteMedia(media: Media) {
    const source = this.absolutePath(media);
    let stat: fs.Stats;
    try { stat = fs.statSync(source); }
    catch { throw Object.assign(new Error("Media file is not available"), { statusCode: 404 }); }
    if (!stat.isFile()) throw Object.assign(new Error("Media path is not a regular file"), { statusCode: 409 });
    try { fs.unlinkSync(source); }
    catch { throw Object.assign(new Error("Media file could not be deleted. Check that the media mount is writable"), { statusCode: 409 }); }
    this.db.markMediaMissing(media.id);
    this.removeGeneratedArtifacts(media.id, media.kind);
    return { bytes: stat.size };
  }

  private enqueueFfmpeg<T>(task: () => Promise<T>) {
    const operation = this.ffmpegQueue.then(task, task);
    this.ffmpegQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  playbackFile(media: Media): Promise<{ file: string; mimeType: string }> {
    const source = this.absolutePath(media);
    if (media.kind !== "video" || media.extension !== ".mp4") return Promise.resolve({ file: source, mimeType: media.mimeType });
    let header: Buffer;
    try { const descriptor = fs.openSync(source, "r"); try { header = Buffer.alloc(12); fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); } }
    catch { return Promise.reject(new Error("Media file is not available")); }
    if (header.subarray(4, 8).toString("ascii") === "ftyp") return Promise.resolve({ file: source, mimeType: media.mimeType });
    const destination = path.join(this.dataDir, "playback-cache", `${media.id}.mp4`);
    try {
      if (fs.statSync(destination).mtimeMs >= fs.statSync(source).mtimeMs) return Promise.resolve({ file: destination, mimeType: "video/mp4" });
    } catch { /* A missing or stale compatibility remux is regenerated below. */ }
    const active = this.playbackFiles.get(media.id);
    const operation = active ?? this.enqueueFfmpeg(async () => {
      const temporary = `${destination}.tmp.mp4`;
      try {
        await runFfmpeg(["-i", source, "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", temporary], 120_000);
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size <= 0) throw new Error("FFmpeg produced an empty playback file");
        fs.renameSync(temporary, destination); return destination;
      } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {} }
    }).finally(() => this.playbackFiles.delete(media.id));
    if (!active) this.playbackFiles.set(media.id, operation);
    return operation.then((file) => ({ file, mimeType: "video/mp4" }));
  }

  thumbnail(media: Media) {
    const destination = path.join(this.dataDir, "thumbnails", media.kind === "video" ? `${media.id}-middle-v1.jpg` : `${media.id}-image-v1.jpg`);
    const source = this.absolutePath(media);
    try {
      if (fs.statSync(destination).mtimeMs >= fs.statSync(source).mtimeMs) return Promise.resolve(destination);
    } catch { /* A missing or stale thumbnail is regenerated below. */ }
    const active = this.thumbnails.get(media.id);
    if (active) return active;
    const operation = this.enqueueFfmpeg(async () => {
      const temporary = `${destination}.tmp.jpg`;
      try {
        const seek = media.kind === "video" ? ["-ss", (Math.max(0, await this.probe(media)) * 0.5).toFixed(3)] : [];
        await runFfmpeg([...seek, "-i", source, "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease", "-q:v", "4", "-y", temporary], 30_000);
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size <= 0) throw new Error("FFmpeg produced an empty thumbnail");
        fs.renameSync(temporary, destination); return destination;
      } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {} }
    }).finally(() => this.thumbnails.delete(media.id));
    this.thumbnails.set(media.id, operation);
    return operation;
  }

  private probe(media: Media) {
    if (media.duration > 0) return Promise.resolve(media.duration);
    return new Promise<number>((resolve, reject) => {
      const child = spawn("ffprobe", [
        "-v", "error", "-show_entries", "format=duration:stream=width,height", "-select_streams", "v:0", "-of", "json", this.absolutePath(media),
      ]);
      let output = ""; let error = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdout.on("data", (chunk) => { output += String(chunk).slice(0, 64 * 1024); });
      child.stderr.on("data", (chunk) => { error += String(chunk).slice(0, 2000); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(error || "FFprobe could not inspect this video"));
        try {
          const result = JSON.parse(output) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number }> };
          const duration = Number(result.format?.duration ?? 0); const stream = result.streams?.[0];
          if (!Number.isFinite(duration) || duration <= 0) return reject(new Error("Video duration is unavailable"));
          this.db.updateProbe(media.id, { duration, width: Number(stream?.width ?? 0), height: Number(stream?.height ?? 0) });
          resolve(duration);
        } catch { reject(new Error("FFprobe returned invalid video information")); }
      });
    });
  }

  preview(media: Media) {
    if (media.kind !== "video") return Promise.reject(new Error("Animated previews are only available for videos"));
    const destination = path.join(this.dataDir, "video-previews", `${media.id}.gif`);
    const source = this.absolutePath(media);
    try {
      if (fs.statSync(destination).mtimeMs >= fs.statSync(source).mtimeMs) return Promise.resolve(destination);
    } catch { /* A missing or stale preview is regenerated below. */ }
    const active = this.previews.get(media.id);
    if (active) return active;
    const operation = this.enqueueFfmpeg(async () => {
      const duration = await this.probe(media);
      const temporary = `${destination}.tmp.gif`;
      const work = fs.mkdtempSync(path.join(this.dataDir, "video-previews", `.${media.id}-`));
      const frameCount = Math.min(10, Math.max(6, Math.ceil(duration / 3)));
      const timestamps = Array.from({ length: frameCount }, (_, index) => duration * (index + 0.5) / frameCount);
      const deadline = Date.now() + 100_000; let saved = 0;
      try {
        for (const timestamp of timestamps) {
          const remaining = deadline - Date.now(); if (remaining < 2_000) break;
          const frame = path.join(work, `frame-${String(saved).padStart(2, "0")}.jpg`);
          try {
            await runFfmpeg([
              "-ss", timestamp.toFixed(3), "-i", source, "-frames:v", "1", "-an", "-sn", "-vf",
              "scale=360:203:force_original_aspect_ratio=increase,crop=360:203,setsar=1", "-q:v", "5", "-y", frame,
            ], Math.min(15_000, remaining));
            if (fs.existsSync(frame) && fs.statSync(frame).size > 0) saved++;
          } catch { try { fs.unlinkSync(frame); } catch {} }
        }
        if (saved < Math.min(6, frameCount)) throw new Error("FFmpeg could not extract enough frames for this preview");
        const remaining = deadline - Date.now();
        if (remaining < 2_000) throw new Error("FFmpeg preview generation timed out");
        await runFfmpeg([
          "-framerate", "2.5", "-start_number", "0", "-i", path.join(work, "frame-%02d.jpg"), "-filter_complex",
          "[0:v]split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
          "-loop", "0", "-y", temporary,
        ], Math.min(30_000, remaining));
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size <= 0) throw new Error("FFmpeg produced an empty animated preview");
        fs.renameSync(temporary, destination); return destination;
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
      }
    }).finally(() => this.previews.delete(media.id));
    this.previews.set(media.id, operation);
    return operation;
  }
}
