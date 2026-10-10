import { concurrentDownloads } from "./download-limits.js";
import { validMediaDate } from "../packages/media-date.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { Database, DownloadItem } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import type { LogWriter } from "./log-store.js";
import { filenameFromUrl, safeSegment } from "./utils.js";
import { downloadOutputPath, recordingEncodingArgs } from "./output-settings.js";
import { outputSettings } from "../packages/output-settings.js";
import { canMatchVideoExcerpt, fingerprintVideo, verifyVideoContainment, videoFileStamp, type VideoFingerprint } from "./video-matching.js";
import type { Source } from "./database.js";

/**
 * Plugin config for one download, with the source's recording quality applied. A
 * source set to automatic (0) keeps the plugin's own setting (normally highest).
 */
export function recordingConfig(config: Record<string, unknown>, source: Pick<Source, "recordingMaxHeight">): Record<string, unknown> {
  return source.recordingMaxHeight > 0 ? { ...config, recordingMaxHeight: source.recordingMaxHeight } : config;
}

type ActiveDownload = {
  /** Live recording of a performer with this priority; preempted when a higher one has to wait for a slot. */
  live?: boolean; priority?: number; startedAt?: number; preempted?: boolean; child?: ChildProcess; abort?: AbortController; paused: boolean; encoding?: boolean; matching?: boolean; action?: "stop" | "cancel" | "delete" };

export class DownloadQueue {
  private active = new Map<string, ActiveDownload>();
  private finalizers = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  constructor(
    private db: Database,
    private plugins: PluginManager,
    private mediaRoot: string,
    private writeLog?: LogWriter,
    private onCompleted?: () => unknown | Promise<unknown>,
    private onDeleteCompleted?: (item: DownloadItem) => unknown,
  ) {}

  start() {
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    fs.mkdirSync(this.downloadsRoot, { recursive: true, mode: 0o700 });
    this.db.requeueInterruptedDownloads();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const control of this.active.values()) { this.signal(control, "SIGTERM"); control.abort?.abort(); }
  }

  pause(itemId: string) {
    const item = this.requiredItem(itemId);
    if (item.status === "queued") return this.db.setItemStatus(itemId, "paused");
    const control = this.active.get(itemId);
    if (control?.matching) throw Object.assign(new Error("Video comparison is finishing; the download can still be cancelled"), { statusCode: 409 });
    if (item.status !== "downloading" || !control) throw Object.assign(new Error(`Cannot pause an item with status '${item.status}'`), { statusCode: 409 });
    control.paused = true; this.signal(control, "SIGSTOP");
    return this.db.setItemStatus(itemId, "paused");
  }

  resume(itemId: string) {
    const item = this.requiredItem(itemId);
    if (item.status !== "paused") throw Object.assign(new Error(`Cannot resume an item with status '${item.status}'`), { statusCode: 409 });
    const control = this.active.get(itemId);
    if (!control) return this.db.setItemStatus(itemId, "queued");
    control.paused = false; this.signal(control, "SIGCONT");
    return this.db.setItemStatus(itemId, "downloading");
  }

  stopRecording(itemId: string) { return this.interrupt(itemId, "stop"); }
  cancel(itemId: string) { return this.interrupt(itemId, "cancel"); }
  delete(itemId: string) {
    const item = this.requiredItem(itemId);
    if (["downloading", "paused"].includes(item.status) && this.active.has(itemId)) return this.interrupt(itemId, "delete");
    let mediaDeletion: unknown;
    if (item.status === "completed") {
      if (!item.storagePath) throw Object.assign(new Error("Completed item has no stored media path"), { statusCode: 409 });
      if (!this.onDeleteCompleted) throw Object.assign(new Error("Completed media deletion is not configured"), { statusCode: 409 });
      mediaDeletion = this.onDeleteCompleted(item);
    }
    this.db.deleteItem(itemId);
    return { deleted: true, id: itemId, ...(mediaDeletion && typeof mediaDeletion === "object" ? mediaDeletion : {}) };
  }

  outputPath(itemId: string) {
    const item = this.requiredItem(itemId); if (item.storagePath) return item.storagePath;
    const performer = this.db.getPerformer(item.performerId); const source = this.db.getSource(item.sourceId);
    const fallback = `${item.externalId}.${item.mediaType === "image" ? "jpg" : item.mediaType === "video" ? "mp4" : "bin"}`;
    return downloadOutputPath(this.db.getSettings(), item, performer?.name ?? "Unknown", source?.domain ?? "unknown", item.filename ?? fallback);
  }

  private requiredItem(itemId: string) {
    const item = this.db.getItem(itemId);
    if (!item) throw Object.assign(new Error("Item not found"), { statusCode: 404 });
    return item;
  }

  private interrupt(itemId: string, action: ActiveDownload["action"]) {
    const item = this.requiredItem(itemId); const control = this.active.get(itemId);
    if (action === "stop" && (control?.encoding || control?.matching)) return item;
    if (!control) {
      if (!["queued", "paused"].includes(item.status)) throw Object.assign(new Error(`Cannot ${action} an item with status '${item.status}'`), { statusCode: 409 });
      this.db.suppressLiveRecording(itemId);
      return this.db.setItemStatus(itemId, action === "delete" ? "deleted" : "cancelled");
    }
    this.db.suppressLiveRecording(itemId);
    control.action = action; control.paused = false;
    this.signal(control, "SIGCONT"); this.signal(control, action === "stop" ? "SIGINT" : "SIGTERM"); control.abort?.abort();
    return this.db.setItemStatus(itemId, action === "stop" ? "stopping" : "cancelling");
  }

  private async tick() {
    const max = concurrentDownloads(this.db.getSettings().maxConcurrentDownloads);
    while (this.active.size < max) {
      const item = this.db.nextQueued();
      if (!item || this.active.has(item.id)) break;
      const control: ActiveDownload = { paused: false, live: item.metadata.live === true, priority: this.db.itemPriority(item.id), startedAt: Date.now() };
      this.active.set(item.id, control);
      const startedItem = this.db.setItemStatus(item.id, "downloading", { progress: 0 })!;
      this.writeLog?.("info", "download", "Download started", { itemId: item.id, pluginId: item.pluginId, title: item.title, mediaType: item.mediaType });
      void this.download(startedItem, control).finally(() => this.active.delete(item.id));
    }
    if (this.active.size >= max) this.preemptForPriority();
  }

  /**
   * All slots are busy and a live recording of a higher-priority performer is waiting:
   * stop the lowest-priority live recording (latest started first) so the waiting one
   * gets its slot. The stopped recording is kept, and the room is not suppressed, so
   * it is recorded again once a slot is free. Recordings already being stopped for a
   * waiting item are counted, so one waiting item never stops two recordings.
   */
  private preemptForPriority() {
    const waiting = this.db.queuedLivePriorities();
    if (!waiting.length) return;
    for (const [itemId, control] of this.active) control.priority = this.db.itemPriority(itemId);
    let freeing = [...this.active.values()].filter((control) => control.preempted || control.action).length;
    for (const priority of waiting) {
      if (freeing > 0) { freeing -= 1; continue; }
      const victim = [...this.active.entries()]
        .filter(([, control]) => control.live && !control.preempted && !control.action && !control.paused && !control.encoding && !control.matching && (control.priority ?? 0) < priority)
        .sort(([, left], [, right]) => (left.priority ?? 0) - (right.priority ?? 0) || (right.startedAt ?? 0) - (left.startedAt ?? 0))[0];
      if (!victim) return;
      const [itemId, control] = victim;
      control.preempted = true; control.action = "stop";
      this.signal(control, "SIGCONT"); this.signal(control, "SIGINT"); control.abort?.abort();
      const item = this.db.setItemStatus(itemId, "stopping");
      this.writeLog?.("info", "download", "Recording stopped for a higher-priority performer", { itemId, title: item?.title, priority: control.priority ?? 0, waitingPriority: priority });
    }
  }

  private async download(item: DownloadItem, control: ActiveDownload) {
    let temporary = "";
    let temporaryDirectory = "";
    let preserveTemporary = false;
    let lastProgress = 0; let lastBytes = 0; let lastProgressUpdate = 0;
    const reportProgress = (progress?: number, downloadedBytes?: number, force = false) => {
      const nextProgress = progress === undefined ? lastProgress : Math.max(lastProgress, Math.min(0.99, Math.max(0, progress)));
      const nextBytes = downloadedBytes === undefined ? lastBytes : Math.max(lastBytes, downloadedBytes);
      const stamp = Date.now();
      if (!force && stamp - lastProgressUpdate < 250 && nextProgress - lastProgress < 0.005 && nextBytes - lastBytes < 256 * 1024) return;
      lastProgress = nextProgress; lastBytes = nextBytes; lastProgressUpdate = stamp;
      if (!control.action) this.db.setItemStatus(item.id, control.paused ? "paused" : "downloading", { progress: nextProgress, downloadedBytes: nextBytes });
    };
    try {
      const plugin = this.plugins.get(item.pluginId);
      if (!plugin.resolveDownload) throw new Error("This plugin cannot resolve downloads");
      const performer = this.db.getPerformer(item.performerId); const source = this.db.getSource(item.sourceId);
      if (!performer || !source) throw new Error("The performer or source no longer exists");
      const settings = outputSettings(this.db.getSettings());
      const resolutionController = new AbortController(); control.abort = resolutionController;
      const request = await plugin.resolveDownload(this.plugins.context(item.pluginId, resolutionController.signal, recordingConfig(this.db.getPluginState(item.pluginId).config, source)), {
        externalId: item.externalId, identityKey: item.identityKey, title: item.title, pageUrl: item.pageUrl,
        mediaType: item.mediaType as any, filename: item.filename, qualityScore: item.qualityScore,
        expectedBytes: item.expectedBytes, publishedAt: item.publishedAt, metadata: item.metadata,
      });
      resolutionController.signal.throwIfAborted();
      const fallback = `${item.externalId}.${item.mediaType === "image" ? "jpg" : item.mediaType === "video" ? "mp4" : "bin"}`;
      const requestUrl = request.kind === "command" ? item.pageUrl ?? item.externalId : request.url;
      const filename = safeSegment(request.filename ?? item.filename ?? filenameFromUrl(requestUrl, fallback), fallback);
      const destination = path.join(this.mediaRoot, downloadOutputPath(settings, item, performer.name, source.domain, filename));
      this.prepareOutputDirectory(path.dirname(destination));
      temporaryDirectory = path.join(this.downloadsRoot, safeSegment(item.id, "download"));
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      temporary = path.join(temporaryDirectory, filename);
      let checksum: string;
      if (request.kind === "command") {
        const placeholders: Record<string, string> = {
          "{output}": temporary,
          "{outputDir}": path.dirname(temporary),
          "{outputName}": path.basename(temporary),
        };
        await this.runCommandDownload(request.command, request.args.map((argument) => {
          for (const [placeholder, value] of Object.entries(placeholders)) argument = argument.replaceAll(placeholder, value);
          return argument;
        }), temporaryDirectory, item.expectedBytes, reportProgress, control, request.requireSuccessfulExit);
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) throw new Error("Extractor completed without producing a media file");
        reportProgress(0.99, fs.statSync(temporary).size, true);
        checksum = await this.hashFile(temporary);
      } else {
        const controller = new AbortController(); control.abort = controller;
        const response = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, body: request.body, redirect: "follow", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
        const contentLength = Number(response.headers.get("content-length") ?? item.expectedBytes ?? 0);
        const hash = createHash("sha256"); let received = 0;
        const readable = Readable.fromWeb(response.body as any);
        readable.on("data", (chunk: Buffer) => {
          hash.update(chunk); received += chunk.length;
          reportProgress(contentLength ? received / contentLength : undefined, received);
        });
        await pipeline(readable, fs.createWriteStream(temporary, { mode: 0o600 }));
        reportProgress(contentLength ? received / contentLength : undefined, received, true);
        checksum = hash.digest("hex");
      }
      if (["cancel", "delete"].includes(control.action ?? "")) throw new Error("Download cancelled");
      if (item.mediaType === "video" && item.metadata.live === true && settings.recordingPreset !== "source") {
        const encoded = path.join(temporaryDirectory, "encoded.mp4");
        control.action = undefined; control.encoding = true;
        this.db.setItemStatus(item.id, "downloading", { progress: 0.99 });
        this.writeLog?.("info", "download", "Encoding live recording", { itemId: item.id, preset: settings.recordingPreset });
        await this.runCommandDownload("ffmpeg", recordingEncodingArgs(settings.recordingPreset, temporary, encoded), temporaryDirectory, undefined, () => {}, control);
        if (control.action === "cancel" || control.action === "delete") throw new Error("Encoding cancelled");
        if (!fs.existsSync(encoded) || !fs.statSync(encoded).size) throw new Error("Encoder completed without producing a media file");
        fs.unlinkSync(temporary); temporary = encoded;
        checksum = await this.hashFile(temporary);
      }
      await this.withFinalizeLock("output", async () => {
        if (["cancel", "delete"].includes(control.action ?? "")) throw new Error("Download cancelled");
        const comparison = item.mediaType === "video" ? await this.checkVideoExcerpt(item, temporary, control) : undefined;
        if (["cancel", "delete"].includes(control.action ?? "")) throw new Error("Download cancelled");
        if (comparison?.original) {
          // An excerpt must never replace the full video, even at higher resolution,
          // and its publication date must not alter the original's date.
          fs.unlinkSync(temporary); temporary = "";
          this.db.markVideoExcerpt(item.id, comparison.original.id, checksum);
          this.writeLog?.("info", "download", "Excerpt already contained in a full video", {
            itemId: item.id, duplicateOf: comparison.original.id, ...comparison.match,
          });
          return;
        }
        const visual = await this.visualFingerprint(temporary, item.mediaType);
        const qualityScore = Math.max(item.qualityScore, visual?.qualityScore ?? 0);
        this.db.setDownloadFingerprint(item.id, visual?.hash, qualityScore);
        const duplicate = (item.identityKey ? this.db.findByIdentity(item.identityKey, item.id, item.performerId) : undefined)
          ?? this.db.findByChecksum(checksum, item.id, item.performerId)
          ?? (visual ? this.db.findVisualDuplicate(visual.hash, item.id, item.performerId, item.mediaType) : undefined);
        if (duplicate?.storagePath && fs.existsSync(path.join(this.mediaRoot, duplicate.storagePath))) {
          const canonicalDate = this.db.setCanonicalMediaDate(duplicate.id, item.publishedAt);
          if (qualityScore <= duplicate.qualityScore) {
            fs.unlinkSync(temporary); temporary = "";
            this.db.setCanonicalMediaDate(item.id, canonicalDate);
            if (duplicate.storagePath) await this.applyMediaDate(path.join(this.mediaRoot, duplicate.storagePath), duplicate.mediaType, canonicalDate);
            this.db.setItemStatus(item.id, "duplicate", { progress: 1, checksum, duplicateOf: duplicate.id });
            this.writeLog?.("info", "download", "Duplicate download discarded", { itemId: item.id, duplicateOf: duplicate.id, title: item.title });
            return;
          }
          this.db.setCanonicalMediaDate(item.id, canonicalDate);
          await this.applyMediaDate(temporary, item.mediaType, canonicalDate);
          const oldPath = duplicate.storagePath ? path.join(this.mediaRoot, duplicate.storagePath) : undefined;
          const finalPath = this.availableDestination(destination, item.id, oldPath);
          fs.renameSync(temporary, finalPath); temporary = "";
          if (oldPath && path.resolve(oldPath) !== path.resolve(finalPath) && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          const relativePath = path.relative(this.mediaRoot, finalPath);
          this.db.setItemStatus(item.id, "completed", { progress: 1, checksum, storagePath: relativePath });
          if (comparison) this.db.setVideoFingerprint(item.id, videoFileStamp(finalPath), comparison.fingerprint);
          this.writeLog?.("info", "download", "Higher-quality download stored", { itemId: item.id, replacedItemId: duplicate.id, storagePath: relativePath });
          this.db.supersedeDownload(duplicate.id, item.id);
          if (plugin.afterDownload) await plugin.afterDownload(this.plugins.context(item.pluginId), { absolutePath: finalPath, relativePath, mediaType: item.mediaType, checksumSha256: checksum });
          void Promise.resolve(this.onCompleted?.()).catch((error) => this.writeLog?.("warn", "library", "Library refresh after download failed", { error }));
          return;
        }
        const canonicalDate = this.db.setCanonicalMediaDate(item.id, item.publishedAt);
        await this.applyMediaDate(temporary, item.mediaType, canonicalDate);
        const finalPath = this.availableDestination(destination, item.id);
        fs.renameSync(temporary, finalPath); temporary = "";
        const relativePath = path.relative(this.mediaRoot, finalPath);
        this.db.setItemStatus(item.id, "completed", { progress: 1, checksum, storagePath: relativePath });
        if (comparison) this.db.setVideoFingerprint(item.id, videoFileStamp(finalPath), comparison.fingerprint);
        this.writeLog?.("info", "download", "Download completed", { itemId: item.id, storagePath: relativePath, mediaType: item.mediaType });
        if (plugin.afterDownload) await plugin.afterDownload(this.plugins.context(item.pluginId), { absolutePath: finalPath, relativePath, mediaType: item.mediaType, checksumSha256: checksum });
        void Promise.resolve(this.onCompleted?.()).catch((error) => this.writeLog?.("warn", "library", "Library refresh after download failed", { error }));
      });
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      const parts = temporaryDirectory && path.join(temporaryDirectory, "live-parts");
      if (!["cancel", "delete"].includes(control.action ?? "") && parts && fs.existsSync(parts) && fs.readdirSync(parts).some((file) => file.endsWith(".ts") && fs.statSync(path.join(parts, file)).size > 0)) {
        preserveTemporary = true;
        if (control.action === "stop") control.action = undefined;
        message += ` Recording parts preserved at ${temporaryDirectory}; recover them before retrying.`;
      }
      if (control.encoding && !control.action && temporary && fs.existsSync(temporary)) {
        try {
          const recoveryDirectory = path.join(this.mediaRoot, ".recording-recovery", safeSegment(item.id));
          this.prepareOutputDirectory(recoveryDirectory);
          const recovery = this.availableDestination(path.join(recoveryDirectory, path.basename(temporary)), item.id);
          fs.renameSync(temporary, recovery); temporary = "";
          message += ` Recording preserved for recovery at ${path.relative(this.mediaRoot, recovery)}.`;
        } catch {
          preserveTemporary = true;
          message += ` Recording preserved in staging at ${path.relative(this.mediaRoot, temporary)}; recover it before retrying.`;
        }
      }
      if (control.preempted && control.action === "stop") {
        // Not a user action: keep the room eligible for a new session once a slot is free.
        this.db.setItemStatus(item.id, "failed", { error: "Stopped for a higher-priority performer" });
        this.writeLog?.("info", "download", "Recording stopped for a higher-priority performer", { itemId: item.id, title: item.title });
      } else if (control.action) {
        if (control.action !== "delete") this.db.setItemStatus(item.id, "cancelled", { error: null });
        this.writeLog?.("info", "download", control.action === "stop" ? "Recording stopped" : "Download cancelled", { itemId: item.id, title: item.title });
      } else {
        this.db.setItemStatus(item.id, "failed", { error: message });
        this.writeLog?.("error", "download", "Download failed", { itemId: item.id, pluginId: item.pluginId, title: item.title, error: message });
      }
    } finally {
      if (temporaryDirectory && !preserveTemporary) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      if (control.action === "delete") this.db.deleteItem(item.id);
    }
  }

  private get downloadsRoot() { return path.join(this.mediaRoot, ".downloads"); }

  private async checkVideoExcerpt(item: DownloadItem, file: string, control: ActiveDownload) {
    const controller = new AbortController(); control.abort = controller; control.matching = true;
    const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
    let fingerprint: VideoFingerprint | undefined;
    try {
      this.writeLog?.("info", "download", "Checking video for an already stored full version", { itemId: item.id });
      fingerprint = await fingerprintVideo(file, controller.signal);
      if (!fingerprint || !canMatchVideoExcerpt(fingerprint)) return { fingerprint };
      for (const original of this.db.completedVideos(item.performerId, item.id)) {
        controller.signal.throwIfAborted();
        const root = path.resolve(this.mediaRoot);
        const originalFile = path.resolve(root, original.storagePath!);
        if (!originalFile.startsWith(`${root}${path.sep}`)) continue;
        try {
          const stamp = videoFileStamp(originalFile);
          let full = this.db.getVideoFingerprint(original.id, stamp);
          if (full === undefined) {
            full = await fingerprintVideo(originalFile, controller.signal) ?? null;
            if (videoFileStamp(originalFile) !== stamp) continue;
            this.db.setVideoFingerprint(original.id, stamp, full ?? undefined);
          }
          if (!full) continue;
          const match = await verifyVideoContainment(file, fingerprint, originalFile, full, controller.signal);
          if (match && videoFileStamp(originalFile) === stamp && this.db.getItem(original.id)?.status === "completed") {
            return { fingerprint, original, match };
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // Missing files, unsupported codecs or stale cache entries cannot
          // justify discarding the new video.
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return { fingerprint };
    } catch (error) {
      this.writeLog?.("warn", "download", "Video comparison unavailable; keeping the downloaded video", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      return fingerprint ? { fingerprint } : undefined;
    } finally {
      clearTimeout(timer); control.matching = false;
      if (control.abort === controller) control.abort = undefined;
    }
  }

  private prepareOutputDirectory(directory: string) {
    const root = path.resolve(this.mediaRoot); const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Output path must stay inside the media volume");
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { fs.mkdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Output folders must be real directories, not symbolic links");
    }
  }

  private availableDestination(destination: string, itemId: string, replacedPath?: string) {
    this.prepareOutputDirectory(path.dirname(destination));
    let candidate = destination; let suffix = 0;
    while (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(replacedPath ?? "")) {
      suffix++;
      candidate = path.join(path.dirname(destination), `${path.parse(destination).name}-${itemId.slice(-6)}${suffix > 1 ? `-${suffix}` : ""}${path.extname(destination)}`);
    }
    return candidate;
  }

  private signal(control: ActiveDownload, signal: NodeJS.Signals) {
    const child = control.child; if (!child?.pid) return;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, signal); return; } catch { /* Fall back to the direct child. */ }
    }
    child.kill(signal);
  }

  private runCommandDownload(command: string, args: string[], outputDirectory: string, expectedBytes: number | undefined, reportProgress: (progress?: number, downloadedBytes?: number, force?: boolean) => void, control: ActiveDownload, requireSuccessfulExit = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      control.child = child;
      if (control.paused) this.signal(control, "SIGSTOP");
      if (control.action) this.signal(control, control.action === "stop" ? "SIGINT" : "SIGTERM");
      let output = ""; let progressOutput = ""; let settled = false;
      const remember = (chunk: Buffer) => {
        const text = chunk.toString("utf8"); output = `${output}${text}`.slice(-8_000); progressOutput = `${progressOutput}${text}`.replaceAll("\r", "\n").slice(-2_000);
        const matches = [...progressOutput.matchAll(/(?:easyx-progress:\s*)?(\d{1,3}(?:\.\d+)?)%/gi)];
        const percentage = Number(matches.at(-1)?.[1]);
        if (Number.isFinite(percentage)) reportProgress(percentage / 100);
        const byteMatches = [...progressOutput.matchAll(/easyx-bytes:(\d+):(\d+)/gi)];
        const downloadedBytes = Number(byteMatches.at(-1)?.[1]); const expectedBytes = Number(byteMatches.at(-1)?.[2]);
        if (Number.isFinite(downloadedBytes) && downloadedBytes > 0) reportProgress(expectedBytes > 0 ? downloadedBytes / expectedBytes : undefined, downloadedBytes);
      };
      child.stdout.on("data", remember); child.stderr.on("data", remember);
      const poll = setInterval(() => {
        const downloadedBytes = this.directoryBytes(outputDirectory);
        if (downloadedBytes > 0) reportProgress(expectedBytes ? downloadedBytes / expectedBytes : undefined, downloadedBytes);
      }, 250); poll.unref();
      const finish = (error?: Error) => { if (settled) return; settled = true; clearInterval(poll); error ? reject(error) : resolve(); };
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        control.child = undefined;
        if (code === 0 || (!requireSuccessfulExit && control.action === "stop" && this.directoryBytes(outputDirectory) > 0)) finish();
        else finish(new Error(`${command} exited with code ${code}: ${output.trim() || "no error output"}`));
      });
    });
  }

  private directoryBytes(directory: string): number {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return total + this.directoryBytes(target);
        if (!entry.isFile()) return total;
        try { return total + fs.statSync(target).size; } catch { return total; }
      }, 0);
    } catch { return 0; }
  }

  private hashFile(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256"); const stream = fs.createReadStream(file);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", reject); stream.once("end", () => resolve(hash.digest("hex")));
    });
  }

  private async visualFingerprint(file: string, mediaType: string): Promise<{ hash: string; qualityScore: number } | undefined> {
    if (mediaType !== "image") return undefined;
    try {
      const probe = await this.capture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file]);
      const stream = (JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
      const width = Number(stream?.width ?? 0); const height = Number(stream?.height ?? 0);
      const pixels = await this.capture("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=8:8:force_original_aspect_ratio=decrease,pad=8:8:(ow-iw)/2:(oh-ih)/2:black,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
      if (pixels.stdout.length < 64) return undefined;
      const values = [...pixels.stdout.subarray(0, 64)];
      if (Math.max(...values) - Math.min(...values) < 10) return undefined;
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      let hash = "";
      for (let index = 0; index < 64; index += 4) {
        let nibble = 0;
        for (let bit = 0; bit < 4; bit += 1) if (values[index + bit] >= average) nibble |= 1 << (3 - bit);
        hash += nibble.toString(16);
      }
      return { hash, qualityScore: width > 0 && height > 0 ? width * height : 0 };
    } catch { return undefined; }
  }

  private async applyMediaDate(file: string, mediaType: string, publishedAt?: string) {
    const normalized = validMediaDate(publishedAt);
    if (!normalized || !fs.existsSync(file)) return;
    const date = new Date(normalized);
    if (mediaType === "image") {
      const exifDate = date.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
      try { await this.capture("exiftool", ["-overwrite_original", `-DateTimeOriginal=${exifDate}`, `-CreateDate=${exifDate}`, `-ModifyDate=${exifDate}`, `-XMP:DateCreated=${date.toISOString()}`, file]); } catch { /* Filesystem date still preserves the canonical date. */ }
    } else if (mediaType === "video" && [".mp4", ".m4v", ".mov", ".mkv", ".webm"].includes(path.extname(file).toLowerCase())) {
      const extension = path.extname(file); const dated = `${file}.dated${extension}`;
      try {
        await this.capture("ffmpeg", ["-y", "-v", "error", "-i", file, "-map", "0", "-map_metadata", "0", "-c", "copy", "-metadata", `creation_time=${date.toISOString()}`, "-metadata", `date=${date.toISOString()}`, dated]);
        if (fs.existsSync(dated) && fs.statSync(dated).size > 0) fs.renameSync(dated, file);
      } catch { if (fs.existsSync(dated)) fs.unlinkSync(dated); }
    }
    fs.utimesSync(file, date, date);
  }

  async applyStoredMediaDates(itemIds: string[]) {
    for (const itemId of [...new Set(itemIds)]) {
      const item = this.db.getItem(itemId);
      if (!item?.storagePath || item.status !== "completed") continue;
      await this.withFinalizeLock("output", () => this.applyMediaDate(path.join(this.mediaRoot, item.storagePath!), item.mediaType, item.publishedAt));
    }
  }

  private capture(command: string, args: string[]): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out`)); }, 120_000); timer.unref();
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }) : reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`)); });
    });
  }

  private async withFinalizeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.finalizers.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.finalizers.set(key, settled);
    try { return await result; }
    finally { if (this.finalizers.get(key) === settled) this.finalizers.delete(key); }
  }
}
