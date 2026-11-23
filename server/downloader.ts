import { concurrentDownloads } from "./download-limits.js";
import { validMediaDate } from "../packages/media-date.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AudioGapCounter, liveAudioSyncEnabled } from "./live-audio-sync.js";
import type { Database, DownloadItem } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import type { LogWriter } from "./log-store.js";
import { filenameFromUrl, safeSegment } from "./utils.js";
import { downloadOutputPath, recordingEncodingArgs, recordingSyncArgs } from "./output-settings.js";
import { outputSettings } from "../packages/output-settings.js";
import { canMatchVideoExcerpt, fingerprintVideo, verifyVideoContainment, videoFileStamp, type VideoFingerprint } from "./video-matching.js";
import type { Source } from "./database.js";

/**
 * A requested height applies only to this job, including 0 for the highest quality.
 * Without an override, sources set to automatic keep the plugin default.
 */
export function recordingConfig(config: Record<string, unknown>, source: Pick<Source, "recordingMaxHeight">, requestedHeight?: unknown): Record<string, unknown> {
  if (typeof requestedHeight === "number" && Number.isInteger(requestedHeight) && requestedHeight >= 0 && requestedHeight <= 4320) {
    return { ...config, recordingMaxHeight: requestedHeight };
  }
  return source.recordingMaxHeight > 0 ? { ...config, recordingMaxHeight: source.recordingMaxHeight } : config;
}

type ActiveDownload = {
  /** Live recording of a performer with this priority; preempted when a higher one has to wait for a slot. */
  live?: boolean; priority?: number; startedAt?: number; preempted?: boolean; child?: ChildProcess; abort?: AbortController; paused: boolean; encoding?: boolean; matching?: boolean; action?: "stop" | "cancel" | "delete";
  /** Set while the application shuts down: the item is finished or recovered on the next start. */
  shuttingDown?: boolean; escalation?: NodeJS.Timeout; recoverableCapture?: boolean };

/** How long a shutdown waits for live recordings to be saved. Docker's stop_grace_period should be longer. */
export const SHUTDOWN_GRACE_MS = Math.max(5, Number(process.env.EASYX_SHUTDOWN_GRACE_SECONDS ?? 60) || 60) * 1000;

export class DownloadQueue {
  /** A cancelled download whose process ignores SIGTERM is killed after this delay. */
  static cancelKillAfterMs = 10_000;
  /** A stopped recording that is still finishing gets a second SIGINT (ffmpeg then exits at once). */
  static stopRepeatAfterMs = 45_000;
  private active = new Map<string, ActiveDownload>();
  private finalizers = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private db: Database,
    private plugins: PluginManager,
    private mediaRoot: string,
    private writeLog?: LogWriter,
    private onCompleted?: (relativePath: string, replacedPath?: string) => unknown | Promise<unknown>,
    private onDeleteCompleted?: (item: DownloadItem) => unknown,
  ) {}

  private notifyCatalog(relativePath: string, replacedPath?: string) {
    // Catalog failures must not turn a successfully stored download into a failure.
    void Promise.resolve().then(() => this.onCompleted?.(relativePath, replacedPath))
      .catch((error) => this.writeLog?.("warn", "library", "Library indexing failed", { relativePath, error }));
  }

  /** Resolves once interrupted recordings are recovered and the queue runs. */
  start(): Promise<void> {
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    fs.mkdirSync(this.downloadsRoot, { recursive: true, mode: 0o700 });
    this.stopped = false;
    const interrupted = this.db.interruptedLiveItems().filter((item) => recordedInput(this.stagingDirectory(item.id)));
    if (!interrupted.length) { this.run(); return Promise.resolve(); }
    return this.boot(interrupted);
  }

  private async boot(interrupted: DownloadItem[]) {
    try { await this.recoverInterruptedRecordings(interrupted); }
    catch (error) { this.writeLog?.("error", "download", "Interrupted recordings could not be recovered", { error: error instanceof Error ? error.message : String(error) }); }
    if (!this.stopped) this.run();
  }

  private run() {
    this.db.requeueInterruptedDownloads();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const control of this.active.values()) { this.signal(control, "SIGTERM"); control.abort?.abort(); }
  }

  /**
   * Application shutdown. Live recordings are stopped like "Stop and save" and get up
   * to graceMs to be stored in the library; other downloads are interrupted and start
   * again on the next run. Whatever is still unfinished when the grace period ends is
   * recovered from its recorded parts on the next start.
   */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS) {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const live: Array<Promise<void>> = [];
    for (const [itemId, control] of this.active) {
      control.shuttingDown = true;
      if (control.live && (control.encoding || control.matching)) live.push(this.settled(itemId));
      else if (control.live && !control.action) {
        control.action = "stop"; control.paused = false;
        this.signal(control, "SIGCONT"); this.signal(control, "SIGINT");
        live.push(this.settled(itemId));
      } else if (!control.live) {
        this.signal(control, "SIGTERM"); control.abort?.abort();
      } else live.push(this.settled(itemId));
    }
    if (!live.length) return;
    this.writeLog?.("info", "download", "Saving live recordings before shutdown", { recordings: live.length, graceSeconds: Math.round(graceMs / 1000) });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(live), new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
    if (timer) clearTimeout(timer);
  }

  private settled(itemId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => this.active.has(itemId) ? setTimeout(check, 100).unref() : resolve();
      check();
    });
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
    // "Stop and save" keeps the room eligible: a performer who is still online is
    // recorded again (as a new video) on the next check. Cancel and delete suppress
    // the room until it is seen offline or the source is hard-refreshed.
    if (action !== "stop") this.db.suppressLiveRecording(itemId);
    control.action = action; control.paused = false;
    this.signal(control, "SIGCONT"); this.signal(control, action === "stop" ? "SIGINT" : "SIGTERM"); control.abort?.abort();
    this.escalate(itemId, control);
    return this.db.setItemStatus(itemId, action === "stop" ? "stopping" : "cancelling");
  }

  /** Make sure a stop or cancel always ends, even when a process ignores the first signal. */
  private escalate(itemId: string, control: ActiveDownload) {
    if (control.escalation) clearTimeout(control.escalation);
    const cancelling = control.action === "cancel" || control.action === "delete";
    control.escalation = setTimeout(() => {
      control.escalation = undefined;
      if (this.active.get(itemId) !== control || !control.child) return;
      if (!cancelling && (control.encoding || control.matching)) return;
      if (control.recoverableCapture && !cancelling) {
        this.writeLog?.("warn", "download", "Live capture did not stop; saving its recorded clusters", { itemId });
        this.signal(control, "SIGKILL");
      } else if (cancelling) {
        this.writeLog?.("warn", "download", "Download did not stop after cancel; killing it", { itemId });
        this.signal(control, "SIGKILL");
      } else {
        this.writeLog?.("warn", "download", "Recording is still finishing after stop; asking it again", { itemId });
        this.signal(control, "SIGINT");
      }
    }, cancelling ? DownloadQueue.cancelKillAfterMs : DownloadQueue.stopRepeatAfterMs);
    control.escalation.unref();
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
      void this.download(startedItem, control).finally(() => { if (control.escalation) clearTimeout(control.escalation); this.active.delete(item.id); });
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
      this.escalate(itemId, control);
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
      const config = recordingConfig(this.db.getPluginState(item.pluginId).config, source, item.metadata.live === true ? item.metadata.recordingMaxHeight : undefined);
      const request = await plugin.resolveDownload(this.plugins.context(item.pluginId, resolutionController.signal, config), {
        externalId: item.externalId, identityKey: item.identityKey, title: item.title, pageUrl: item.pageUrl,
        mediaType: item.mediaType as any, filename: item.filename, qualityScore: item.qualityScore,
        expectedBytes: item.expectedBytes, publishedAt: item.publishedAt, metadata: item.metadata,
      });
      resolutionController.signal.throwIfAborted();
      const fallback = `${item.externalId}.${item.mediaType === "image" ? "jpg" : item.mediaType === "video" ? "mp4" : "bin"}`;
      const requestUrl = request.kind === "command" ? item.pageUrl ?? item.externalId : request.url;
      const requestedFilename = safeSegment(request.filename ?? item.filename ?? filenameFromUrl(requestUrl, fallback), fallback);
      const captureInMatroska = request.kind === "command" && request.liveCaptureContainer === "matroska";
      const filename = captureInMatroska ? path.parse(requestedFilename).name + ".mp4" : requestedFilename;
      const destination = path.join(this.mediaRoot, downloadOutputPath(settings, item, performer.name, source.domain, filename));
      this.prepareOutputDirectory(path.dirname(destination));
      temporaryDirectory = path.join(this.downloadsRoot, safeSegment(item.id, "download"));
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      temporary = path.join(temporaryDirectory, filename);
      let checksum: string;
      if (request.kind === "command") {
        const capturePath = captureInMatroska ? path.join(temporaryDirectory, LIVE_CAPTURE_NAME) : undefined;
        const commandPath = capturePath ?? temporary;
        const placeholders: Record<string, string> = {
          "{output}": commandPath,
          "{outputDir}": temporaryDirectory,
          "{outputName}": path.basename(commandPath),
        };
        const args = request.args.map((argument) => {
          for (const [placeholder, value] of Object.entries(placeholders)) argument = argument.replaceAll(placeholder, value);
          return argument;
        });
        let commandOutput = "", stalledBeforeMedia = false;
        control.recoverableCapture = Boolean(capturePath);
        try {
          commandOutput = await this.runCommandDownload(request.command, args, temporaryDirectory, item.expectedBytes, reportProgress, control, request.requireSuccessfulExit, capturePath ? (bytes) => {
            if (!bytes) {
              stalledBeforeMedia = true;
              this.signal(control, "SIGKILL");
              return;
            }
            this.writeLog?.("warn", "download", "Live capture stopped writing media; saving the recording", { itemId: item.id });
            this.stopRecording(item.id);
          } : undefined);
        } catch (error) {
          if (stalledBeforeMedia && !capturedFile(temporaryDirectory)) throw new Error("Live capture timed out before any media was recorded");
          if (!capturePath || request.requireSuccessfulExit || control.action === "cancel" || control.action === "delete" || !capturedFile(temporaryDirectory)) throw error;
          this.writeLog?.("warn", "download", "Live extractor exited early; saving the recorded media", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
        } finally { control.recoverableCapture = false; }
        if (control.action === "cancel" || control.action === "delete") throw new Error("Download cancelled");
        if (capturePath) {
          const captured = capturedFile(temporaryDirectory);
          if (!captured) throw new Error("Live extractor exited without recording media");
          const output = temporary;
          temporary = captured;
          control.action = undefined; control.encoding = true;
          if (control.escalation) clearTimeout(control.escalation);
          if (settings.recordingPreset === "source") {
            await this.runCommandDownload("ffmpeg", remuxRecordingArgs(["-i", captured], output), temporaryDirectory, undefined, () => {}, control, true);
            temporary = output;
          }
        }
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) throw new Error("Extractor completed without producing a media file");
        const problems = /\[live-recorder\] stream problems: (\d+) segment\(s\) skipped, (\d+) failed request\(s\)(?:, (\d+) stalled capture\(s\))?/.exec(commandOutput);
        if (problems) this.writeLog?.("warn", "download", "Live stream encountered capture interruptions", { itemId: item.id, title: item.title, skippedSegments: Number(problems[1]), failedRequests: Number(problems[2]), stalledCaptures: Number(problems[3] ?? 0) });
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
      } else if (item.mediaType === "video" && item.metadata.live === true && liveAudioSyncEnabled()) {
        // A healthy recording stays exactly as captured. Only when its audio has gaps (which
        // make players drift out of sync) is the audio rebuilt in sync; the video is copied.
        const synced = path.join(temporaryDirectory, `synced${path.extname(temporary) || ".mp4"}`);
        control.action = undefined; control.encoding = true;
        this.db.setItemStatus(item.id, "downloading", { progress: 0.99 });
        try {
          const gaps = await this.audioGaps(temporary, control);
          if (control.action === "cancel" || control.action === "delete") throw new Error("Recording cancelled");
          if (gaps.count) {
            this.writeLog?.("info", "download", "Repairing audio/video sync of the live recording", { itemId: item.id, audioGaps: gaps.count, missingSeconds: Math.round(gaps.seconds * 10) / 10 });
            await this.runCommandDownload("ffmpeg", recordingSyncArgs(temporary, synced), temporaryDirectory, undefined, () => {}, control, true);
            if (control.action === "cancel" || control.action === "delete") throw new Error("Recording cancelled");
            if (!fs.existsSync(synced) || !fs.statSync(synced).size) throw new Error("FFmpeg produced no file");
            const syncedChecksum = await this.hashFile(synced);
            fs.unlinkSync(temporary); temporary = synced; checksum = syncedChecksum;
          }
        } catch (error) {
          if (control.action === "cancel" || control.action === "delete") throw error;
          fs.rmSync(synced, { force: true });
          this.writeLog?.("warn", "download", "Audio/video sync repair skipped; the recording is kept as captured", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
        }
        control.encoding = false;
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
            this.notifyCatalog(duplicate.storagePath);
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
          this.notifyCatalog(relativePath, duplicate.storagePath);
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
        this.notifyCatalog(relativePath);
      });
    } catch (error) {
      // Interrupted by the shutdown: a live recording keeps its parts for recovery on the
      // next start; any other download stays "downloading" and is queued again.
      if (control.shuttingDown) { if (control.live) preserveTemporary = true; return; }
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

  /** Use decoded sample counts: MP4 stretches packet durations over missing audio,
   * so packet timestamps and durations alone hide the very gaps we need to repair. */
  private async audioGaps(file: string, control?: ActiveDownload): Promise<{ count: number; seconds: number }> {
    const metadata = await this.capture("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "json", file]);
    const stream = (JSON.parse(metadata.stdout.toString("utf8")) as { streams?: Array<{ sample_rate?: string }> }).streams?.[0];
    if (!stream) return { count: 0, seconds: 0 };
    const rate = Number(stream.sample_rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("The audio sample rate could not be determined");
    if (control?.action === "cancel" || control?.action === "delete") throw new Error("Recording cancelled");
    return new Promise((resolve, reject) => {
      const child = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "frame=best_effort_timestamp_time,nb_samples", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      if (control) {
        control.child = child;
        if (control.action) this.signal(control, "SIGTERM");
      }
      const counter = new AudioGapCounter();
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const [pts, rawSamples] = line.split(",");
        const samples = Number(rawSamples);
        if (Number.isFinite(samples) && samples > 0) counter.add(`${pts},${samples / rate}`);
      });
      let error = "", settled = false, timedOut = false;
      child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-4000); });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10 * 60_000);
      timer.unref();
      const finish = (failure?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); lines.close();
        if (control?.child === child) control.child = undefined;
        failure ? reject(failure) : resolve(counter.result());
      };
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(code === 0 && !timedOut ? undefined : new Error(timedOut ? "Audio analysis timed out" : `Audio analysis failed: ${error.trim() || code}`)));
    });
  }

  private get downloadsRoot() { return path.join(this.mediaRoot, ".downloads"); }

  /**
   * A restart (or a container that was killed) used to throw away a running live
   * recording: the item was queued again and its staging folder wiped. Whatever was
   * recorded is now turned into a video in the library first; the performer is then
   * recorded again as a new video if the room is still live.
   */
  private stagingDirectory(itemId: string) { return path.join(this.downloadsRoot, safeSegment(itemId, "download")); }

  private async recoverInterruptedRecordings(items: DownloadItem[]) {
    for (const item of items) {
      if (this.stopped) return;
      const directory = this.stagingDirectory(item.id);
      const input = recordedInput(directory);
      if (!input) continue;
      const output = path.join(directory, `recovered-${Date.now()}.mp4`);
      try {
        if (input.parts) {
          const list = path.join(directory, "recovered-parts.txt");
          fs.writeFileSync(list, input.parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
          await this.capture("ffmpeg", remuxRecordingArgs(["-f", "concat", "-safe", "0", "-i", list], output), 30 * 60_000);
        } else {
          await this.capture("ffmpeg", remuxRecordingArgs(["-i", input.file!], output), 30 * 60_000);
        }
        if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error("FFmpeg produced no video");
        if (liveAudioSyncEnabled() && (await this.audioGaps(output).catch(() => ({ count: 0 }))).count) {
          const synced = path.join(directory, `recovered-synced-${Date.now()}.mp4`);
          try {
            await this.capture("ffmpeg", recordingSyncArgs(output, synced), 30 * 60_000);
            if (fs.existsSync(synced) && fs.statSync(synced).size > 0) fs.renameSync(synced, output);
          } catch { fs.rmSync(synced, { force: true }); }
        }
        const performer = this.db.getPerformer(item.performerId); const source = this.db.getSource(item.sourceId);
        if (!performer || !source) throw new Error("The performer or source no longer exists");
        const fallback = `${item.externalId}.mp4`;
        const sourceFilename = safeSegment(item.filename ?? fallback, fallback);
        const filename = input.file && capturedFile(directory) === input.file ? path.parse(sourceFilename).name + ".mp4" : sourceFilename;
        const destination = path.join(this.mediaRoot, downloadOutputPath(outputSettings(this.db.getSettings()), item, performer.name, source.domain, filename));
        this.prepareOutputDirectory(path.dirname(destination));
        const canonicalDate = this.db.setCanonicalMediaDate(item.id, item.publishedAt);
        await this.applyMediaDate(output, item.mediaType, canonicalDate);
        const checksum = await this.hashFile(output);
        const finalPath = this.availableDestination(destination, item.id);
        fs.renameSync(output, finalPath);
        const storagePath = path.relative(this.mediaRoot, finalPath);
        this.db.setItemStatus(item.id, "completed", { progress: 1, checksum, storagePath, error: null });
        fs.rmSync(directory, { recursive: true, force: true });
        this.writeLog?.("info", "download", "Live recording interrupted by a restart was saved", { itemId: item.id, title: item.title, storagePath, parts: input.parts?.length ?? 1 });
        this.notifyCatalog(storagePath);
      } catch (error) {
        fs.rmSync(output, { force: true });
        let kept = path.relative(this.mediaRoot, directory);
        try {
          const recovery = path.join(this.mediaRoot, ".recording-recovery", safeSegment(item.id, "recording"));
          fs.mkdirSync(path.dirname(recovery), { recursive: true });
          fs.rmSync(recovery, { recursive: true, force: true });
          fs.renameSync(directory, recovery); kept = path.relative(this.mediaRoot, recovery);
        } catch { /* Leave it in staging. */ }
        const reason = error instanceof Error ? error.message : String(error);
        this.db.setItemStatus(item.id, "failed", { error: `Recording interrupted by a restart could not be joined (${reason}). The recorded data is kept at ${kept}.` });
        this.writeLog?.("error", "download", "Interrupted live recording could not be recovered", { itemId: item.id, kept, error: reason });
      }
    }
  }

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

  private runCommandDownload(command: string, args: string[], outputDirectory: string, expectedBytes: number | undefined, reportProgress: (progress?: number, downloadedBytes?: number, force?: boolean) => void, control: ActiveDownload, requireSuccessfulExit = false, onCaptureStalled?: (bytes: number) => void): Promise<string> {
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
      const stallSeconds = Number(process.env.EASYX_LIVE_STALL_SECONDS);
      const stallMs = (Number.isFinite(stallSeconds) && stallSeconds > 0 ? stallSeconds : 60) * 1000;
      let lastBytes = 0, lastGrowth = Date.now(), stallSignalled = false, captureOpened = false;
      const poll = setInterval(() => {
        const downloadedBytes = this.directoryBytes(outputDirectory);
        if (onCaptureStalled && !stallSignalled) {
          const capture = path.join(outputDirectory, LIVE_CAPTURE_NAME);
          const opened = captureOpened || downloadedBytes > 0 || fs.existsSync(capture) || fs.existsSync(capture + ".part");
          // Allow slower page extraction to finish before FFmpeg opens its first file.
          const deadline = opened ? stallMs : Math.max(stallMs, 120_000);
          if (control.paused || downloadedBytes !== lastBytes || opened !== captureOpened) lastGrowth = Date.now();
          else if (!control.action && Date.now() - lastGrowth >= deadline) {
            stallSignalled = true;
            onCaptureStalled(downloadedBytes);
          }
          lastBytes = downloadedBytes;
          captureOpened = opened;
        }
        if (downloadedBytes > 0) reportProgress(expectedBytes ? downloadedBytes / expectedBytes : undefined, downloadedBytes);
      }, 250); poll.unref();
      const finish = (error?: Error) => { if (settled) return; settled = true; clearInterval(poll); error ? reject(error) : resolve(output); };
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

  private capture(command: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out`)); }, timeoutMs); timer.unref();
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

const LIVE_CAPTURE_NAME = "live-capture.mkv";

function capturedFile(directory: string) {
  for (const name of [LIVE_CAPTURE_NAME, LIVE_CAPTURE_NAME + ".part"]) {
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 0) return file;
    } catch { /* Look for the remaining staging file. */ }
  }
}

function remuxRecordingArgs(inputArgs: string[], output: string) {
  return ["-nostdin", "-hide_banner", "-loglevel", "error", ...inputArgs, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", output];
}

const RECORDING_EXTENSIONS = new Set([".ts", ".mp4", ".mkv", ".flv", ".m4v", ".webm", ".part"]);

/** What an interrupted recording left in its staging folder: recorder parts, or the largest partial file. */
export function recordedInput(directory: string): { parts?: string[]; file?: string } | undefined {
  const nonEmpty = (file: string) => { try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0; } catch { return false; } };
  const partsDirectory = path.join(directory, "live-parts");
  let parts: string[] = [];
  try { parts = fs.readdirSync(partsDirectory).filter((name) => name.endsWith(".ts")).sort().map((name) => path.join(partsDirectory, name)).filter(nonEmpty); } catch { /* No recorder parts. */ }
  if (parts.length) return { parts };
  // A restart during MP4 finalization can leave a larger, unindexed output beside the capture.
  const captured = capturedFile(directory);
  if (captured) return { file: captured };
  let files: string[] = [];
  try {
    files = fs.readdirSync(directory).map((name) => path.join(directory, name))
      .filter((file) => nonEmpty(file) && (RECORDING_EXTENSIONS.has(path.extname(file).toLowerCase()) || /\.(?:mp4|mkv|ts|webm)\.part$/i.test(file)) && !path.basename(file).startsWith("recovered-"));
  } catch { return undefined; }
  if (!files.length) return undefined;
  return { file: files.sort((left, right) => fs.statSync(right).size - fs.statSync(left).size)[0] };
}
