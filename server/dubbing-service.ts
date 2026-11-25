import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EasyXPlugin } from "../packages/plugin-sdk/index.js";
import type { Catalog } from "./catalog.js";
import type { LibraryDatabase, Media } from "./library-database.js";
import type { PluginManager } from "./plugin-manager.js";

type Identity = { media_id: string; language: string; fingerprint: string; provider: string };
type Job = Identity & { status: string; phase: string; progress: number; error: string; render_version: string };
type Output = Identity & { file_key: string; lip_sync_frames: number | null };
function fingerprint(media: Media) { return `${media.size}:${media.modifiedAt}`; }
function publicationKey(job: Identity, revision: string) {
  return createHash("sha256").update(JSON.stringify([job.provider, job.fingerprint, revision])).digest("hex").slice(0, 24);
}
const runtimeFailurePhase = "Waiting to retry runtime setup";

export class DubbingService {
  private active?: { plugin: EasyXPlugin; job: Job; controller: AbortController; done: Promise<void> };
  private timer?: NodeJS.Timeout;
  private runtimeFailure?: { provider: string; language: string; revision: string; delay: number; retryAt: number };
  private closed = false;

  constructor(private db: LibraryDatabase, private plugins: PluginManager, private catalog: Catalog, private dataDir: string) {
    // This service owns a single worker. After a process restart its old jobs
    // have no active worker, but their per-fingerprint work directories survive.
    this.db.sqlite.prepare("UPDATE video_dubs SET status='queued',phase='',progress=0,error='' WHERE status='running'").run();
    // Older workers persisted the end of the Python traceback, including the
    // failed subprocess command. Only recover installation in our managed env.
    const command = "subprocess.CalledProcessError: Command ";
    this.db.sqlite.prepare(`WITH failures AS (
        SELECT media_id,language,substr(error,instr(error,?)) AS command FROM video_dubs
        WHERE provider='org.easyx.dubbing' AND status='error' AND phase='' AND instr(error,?)>0
      ) UPDATE video_dubs SET status='queued',phase='',progress=0,error=''
      WHERE (media_id,language) IN (
        SELECT media_id,language FROM failures WHERE instr(replace(command,char(92),'/'),'/dubbing-runtime/')>0
        AND (instr(command,?)>0 OR instr(command,?)>0 OR instr(command,?)>0)
      )`).run(command, command, "'-m', 'pip', 'install'", "'-m', 'venv',", "'-m', 'ensurepip',");
    // These legacy tracebacks identify three fixed worker failures. Retry them once
    // using their existing checkpoints, without scheduling another render of published videos.
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const marker = this.db.sqlite.prepare("INSERT OR IGNORE INTO settings(key,value_json,updated_at) VALUES(?, 'true', ?)").run(
        "requeued_dubbing_packet_voice_translation_errors_v1", new Date().toISOString(),
      );
      if (marker.changes) this.db.sqlite.exec(`UPDATE video_dubs SET status='queued',phase='',progress=0,error=''
        WHERE provider='org.easyx.dubbing' AND status='error' AND (
          instr(error,'ValueError: The voice model did not generate audible speech')>0
          OR instr(error,'ValueError: Translation produced an empty phrase')>0
          OR (instr(error,'/lips.py')>0 AND instr(error,'av.error.InvalidDataError:')>0 AND instr(error,'avcodec_send_packet()')>0)
        )`);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  get installed() { return Boolean(this.plugins.dubbingProvider()); }

  private directory(job: Identity) {
    const version = createHash("sha256").update(job.provider + ":" + job.fingerprint).digest("hex").slice(0, 24);
    return path.join(this.dataDir, "dubbing", job.media_id, version);
  }

  private outputPath(output: Output) {
    const suffix = output.file_key ? "." + output.file_key : "";
    return path.join(this.directory(output), output.language + suffix + ".mp4");
  }

  private existingOutputPath(output: Output) {
    const file = this.outputPath(output);
    try {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.size > 0) return file;
    } catch { /* Let the render job handle an inaccessible mount. */ }
  }

  private publication(media: Media, language: string) {
    return this.db.sqlite.prepare("SELECT * FROM dubbing_outputs WHERE media_id=? AND language=? AND fingerprint=?")
      .get(media.id, language, fingerprint(media)) as Output | undefined;
  }

  private previousOutput(media: Media, job: Job, revisions?: string[]) {
    if (!job.render_version || !Array.isArray(revisions) || !revisions.length) return;
    const published = this.publication(media, job.language);
    if (!published?.file_key || published.provider !== job.provider || published.fingerprint !== job.fingerprint) return;
    // A retry already carries the new job revision. The publication key still identifies the file on disk.
    const renderVersion = revisions.find((revision) => typeof revision === "string" && revision.length > 0
      && revision !== job.render_version && publicationKey(job, revision) === published.file_key);
    if (!renderVersion) return;
    const file = this.existingOutputPath(published);
    if (!file) return;
    return { path: file, renderVersion, lipSyncFrames: published.lip_sync_frames ?? undefined };
  }

  private reconcilePublishedRevision(media: Media, job: Job, interrupted = false) {
    const published = this.publication(media, job.language);
    if (published?.provider !== job.provider || published.file_key !== publicationKey(job, job.render_version)
      || !this.existingOutputPath(published)) return false;
    // A publication can be staged while its previous renderer is still serving. Recheck the row and key together.
    const restore = interrupted ? ",status='ready',phase='',progress=100,error=''" : "";
    const result = this.db.sqlite.prepare(`UPDATE video_dubs SET render_version=?${restore} WHERE media_id=? AND language=?
      AND fingerprint=? AND provider=? AND status=? AND render_version<>?
      AND EXISTS (SELECT 1 FROM dubbing_outputs o WHERE (o.media_id,o.language,o.fingerprint,o.provider)
        = (video_dubs.media_id,video_dubs.language,video_dubs.fingerprint,video_dubs.provider) AND o.file_key=?)`)
      .run(job.render_version, media.id, job.language, job.fingerprint, job.provider, interrupted ? "running" : "ready", job.render_version, published.file_key);
    return result.changes > 0;
  }

  private settings(plugin = this.plugins.dubbingProvider()) {
    const config = plugin ? this.plugins.context(plugin.manifest.id).config : {};
    const manifest = plugin?.manifest;
    const lipSync = manifest?.dubbingLipSyncRenderVersion ? config.lipSync === true : undefined;
    return {
      targets: (manifest?.dubbingLanguages ?? []).filter(({ code }) => config[code] === true),
      revision: (lipSync ? manifest?.dubbingLipSyncRenderVersion : manifest?.dubbingRenderVersion) ?? "",
      silentRevisions: manifest?.dubbingRecheckSilentVersions ?? [],
      oldestFirst: config.oldestFirst === true, lipSync,
    };
  }

  status(media: Media) {
    const plugin = this.plugins.dubbingProvider();
    const { targets, revision, silentRevisions } = this.settings(plugin);
    const jobs = this.db.sqlite.prepare("SELECT * FROM video_dubs WHERE media_id=? AND fingerprint=?").all(media.id, fingerprint(media)) as Job[];
    const outputs = this.db.sqlite.prepare("SELECT * FROM dubbing_outputs WHERE media_id=? AND fingerprint=?").all(media.id, fingerprint(media)) as Output[];
    const available = [...targets];
    for (const job of outputs) {
      if (!available.some(({ code }) => code === job.language)) {
        available.push({ code: job.language, label: new Intl.DisplayNames(["en"], { type: "language" }).of(job.language) ?? job.language });
      }
    }
    return { installed: Boolean(plugin), variants: available.map(({ code, label }) => {
      const job = jobs.find((row) => row.language === code && row.provider === plugin?.manifest.id);
      const output = outputs.find((row) => row.language === code);
      let updateStatus: string | undefined;
      const selected = targets.some((target) => target.code === code);
      const stale = selected && job && !!revision && job.render_version !== revision;
      let status = job?.status ?? "queued";
      if (stale && (status === "error" || (status === "silent" && silentRevisions.includes(job.render_version)))) status = "queued";
      if (output && selected) {
        if (!job || status !== "ready") updateStatus = status;
        else if (stale) updateStatus = "queued";
      }
      return { code, label, status: output ? "ready" : status, phase: job?.phase, progress: job?.progress ?? 0, error: job?.error,
        updateStatus, playbackVersion: output ? output.file_key || "legacy" : undefined, lipSyncFrames: output?.lip_sync_frames ?? undefined };
    }) };
  }

  overview() {
    const plugin = this.plugins.dubbingProvider();
    const settings = this.settings(plugin);
    const job = this.active?.job;
    const current = job && this.db.sqlite.prepare(`SELECT m.title,d.language,d.progress,d.phase FROM video_dubs d JOIN media m ON m.id=d.media_id
      WHERE d.media_id=? AND d.language=? AND d.status='running'`).get(job.media_id, job.language);
    const errors = this.db.sqlite.prepare(`SELECT m.title,m.id,d.language,d.error,d.phase FROM video_dubs d JOIN media m ON m.id=d.media_id
      WHERE d.status='error' AND m.missing=0 AND d.provider=? AND d.fingerprint=(m.size||':'||m.modified_at)
      ORDER BY (d.phase=?) DESC,m.modified_at DESC LIMIT 20`).all(plugin?.manifest.id ?? "", runtimeFailurePhase)
      .map(({ phase, ...failure }) => phase === runtimeFailurePhase ? { ...failure, runtimeSetup: true } : failure);
    const wait = this.runtimeFailure;
    const runtimeRetryAt = wait && wait.provider === plugin?.manifest.id && wait.revision === settings.revision && wait.retryAt > Date.now()
      ? new Date(wait.retryAt).toISOString() : undefined;
    return { oldestFirst: settings.oldestFirst, lipSync: settings.lipSync ?? false, languages: plugin?.manifest.dubbingLanguages ?? [],
      selected: settings.targets.map(({ code }) => code), current: current ?? null, errors, runtimeRetryAt };
  }

  file(media: Media, language: string) {
    const output = this.publication(media, language);
    if (!output) return;
    const file = this.outputPath(output);
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    this.db.sqlite.prepare("DELETE FROM dubbing_outputs WHERE media_id=? AND language=?").run(media.id, language);
    this.db.sqlite.prepare("UPDATE video_dubs SET status='queued',progress=0 WHERE media_id=? AND language=? AND status='ready'").run(media.id, language);
    this.sync();
  }

  retry(media: Media, language: string) {
    const plugin = this.plugins.dubbingProvider();
    if (!plugin || !this.settings(plugin).targets.some(({ code }) => code === language)) throw Object.assign(new Error("Select this dubbing language first"), { statusCode: 409 });
    const job = this.db.sqlite.prepare(`UPDATE video_dubs SET status='queued',error='' WHERE media_id=? AND language=?
      AND fingerprint=? AND provider=? AND status='error' RETURNING phase`).get(media.id, language, fingerprint(media), plugin.manifest.id);
    if (job?.phase === runtimeFailurePhase) this.runtimeFailure = undefined;
    this.sync();
  }

  sync() {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => this.sync(), 5000).unref();
    const plugin = this.plugins.dubbingProvider();
    const { targets: selected, revision, silentRevisions, oldestFirst, lipSync } = this.settings(plugin);
    const targets = selected.map(({ code }) => code);
    if (this.runtimeFailure && (this.runtimeFailure.provider !== plugin?.manifest.id || !targets.includes(this.runtimeFailure.language) || this.runtimeFailure.revision !== revision)) {
      this.runtimeFailure = undefined;
    }
    if (this.active) {
      const { job, controller } = this.active;
      const media = this.db.getMedia(job.media_id);
      if (this.active.plugin !== plugin || !targets.includes(job.language) || job.render_version !== revision || !media || fingerprint(media) !== job.fingerprint) controller.abort();
      return;
    }
    // A scan may still be indexing other videos credited to this performer.
    if (!plugin?.renderDub || !targets.length || this.catalog.status.running) return;
    if (this.runtimeFailure && Date.now() < this.runtimeFailure.retryAt) return;
    const direction = oldestFirst ? "ASC" : "DESC";
    const values = targets.map(() => "(?)").join(",");
    const row = this.db.sqlite.prepare(`WITH targets(code) AS (VALUES ${values}) SELECT m.id,t.code,d.status FROM media m CROSS JOIN targets t
      LEFT JOIN video_dubs d ON d.media_id=m.id AND d.language=t.code AND d.fingerprint=(m.size||':'||m.modified_at) AND d.provider=?
      LEFT JOIN dubbing_outputs o ON o.media_id=m.id AND o.language=t.code AND o.fingerprint=(m.size||':'||m.modified_at)
      WHERE m.missing=0 AND m.playable=1 AND m.kind='video' AND (d.status IS NULL OR d.status='queued' OR (d.status='error' AND d.phase=?)
        OR (?<>'' AND d.render_version<>? AND (o.media_id IS NOT NULL OR d.status='error'
          OR (d.status='silent' AND d.render_version IN (SELECT value FROM json_each(?))))))
      ORDER BY CASE WHEN d.phase=? THEN 0 WHEN o.media_id IS NOT NULL THEN 1 ELSE 2 END,m.added_at ${direction},m.id LIMIT 1`)
      .get(...targets, plugin.manifest.id, runtimeFailurePhase, revision, revision, JSON.stringify(silentRevisions), runtimeFailurePhase) as { id: string; code: string; status: string | null } | undefined;
    if (!row) return;
    const media = this.db.getMedia(row.id)!;
    const job: Job = { media_id: media.id, fingerprint: fingerprint(media), provider: plugin.manifest.id, language: row.code,
      status: "running", phase: "Preparing models", progress: 0, error: "", render_version: revision };
    if (row.status === "ready" && this.reconcilePublishedRevision(media, job)) {
      setImmediate(() => this.sync());
      return;
    }
    this.db.sqlite.prepare(`INSERT INTO video_dubs(media_id,language,fingerprint,provider,status,phase,render_version,progress,error) VALUES(?,?,?,?,?,?,?,0,'')
      ON CONFLICT(media_id,language) DO UPDATE SET fingerprint=excluded.fingerprint,provider=excluded.provider,status='running',phase=excluded.phase,render_version=excluded.render_version,progress=0,error=''`)
      .run(media.id, row.code, job.fingerprint, job.provider, job.status, job.phase, revision);
    const controller = new AbortController();
    const done = this.render(plugin, media, job, controller, lipSync).finally(() => {
      this.active = undefined;
      setImmediate(() => this.sync());
    });
    this.active = { plugin, job, controller, done };
  }

  private async render(plugin: EasyXPlugin, media: Media, job: Job, controller: AbortController, lipSync?: boolean) {
    const { signal } = controller;
    const dir = this.directory(job);
    const output = path.join(dir, job.language + ".partial.mp4");
    const workDir = path.join(dir, "work");
    const update = this.db.sqlite.prepare("UPDATE video_dubs SET status=?,phase=?,progress=?,error=? WHERE media_id=? AND language=? AND fingerprint=?");
    try {
      fs.mkdirSync(workDir, { recursive: true });
      const referenceVideos = await this.catalog.dubbingReferenceVideos(media, signal);
      signal.throwIfAborted();
      const result = await plugin.renderDub!(this.plugins.context(job.provider, signal), {
        mediaId: media.id, fingerprint: job.fingerprint, language: job.language, source: this.catalog.absolutePath(media),
        dataDir: this.dataDir, workDir, output, referenceVideos, lipSync,
        previousOutput: this.previousOutput(media, job, plugin.manifest.dubbingPreviousRenderVersions),
      }, (phase, progress) => {
        if (!signal.aborted) update.run("running", phase, Math.max(0, Math.min(progress, 99)), "", media.id, job.language, job.fingerprint);
      });
      const current = this.db.getMedia(media.id);
      if (signal.aborted || !current || fingerprint(current) !== job.fingerprint) return;
      const provider = this.plugins.dubbingProvider();
      const desired = this.settings(provider);
      if (provider !== plugin || desired.revision !== job.render_version || !desired.targets.some(({ code }) => code === job.language)) {
        controller.abort();
        return;
      }
      const outcome = typeof result === "string" ? result : result.outcome;
      const previous = this.publication(current, job.language);
      let published: Output | undefined;
      if (previous && outcome !== "rendered") throw new Error(outcome === "silent"
        ? "The updated renderer found no translatable speech. The previous version is still available."
        : "The updated renderer identified the source as already in this language. The previous version is still available.");
      if (outcome === "rendered") {
        if (!fs.statSync(output).size) throw new Error("The rendered video is empty");
        const frames = typeof result === "object" ? result.lipSyncFrames : undefined;
        published = { ...job, file_key: publicationKey(job, job.render_version),
          lip_sync_frames: frames !== undefined && Number.isSafeInteger(frames) && frames >= 0 ? frames : null };
        fs.renameSync(output, this.outputPath(published));
      }
      // Keep serving the old publication until the complete file and its metadata are available together.
      this.db.sqlite.exec("BEGIN IMMEDIATE");
      try {
        if (published) this.db.sqlite.prepare(`INSERT OR REPLACE INTO dubbing_outputs(media_id,language,fingerprint,provider,file_key,lip_sync_frames)
          VALUES(?,?,?,?,?,?)`).run(media.id, job.language, job.fingerprint, job.provider, published.file_key, published.lip_sync_frames);
        update.run(published ? "ready" : outcome, "", 100, "", media.id, job.language, job.fingerprint);
        this.db.sqlite.exec("COMMIT");
      } catch (error) { this.db.sqlite.exec("ROLLBACK"); throw error; }
      this.runtimeFailure = undefined;
      if (previous && published && this.outputPath(previous) !== this.outputPath(published)) {
        // Finish retiring this file before a later mode switch can publish to the same revision name.
        try { fs.rmSync(this.outputPath(previous), { force: true }); } catch { /* The old file may still be open for playback. */ }
      }
      if (this.status(current).variants.every((variant) => !variant.updateStatus && ["ready", "silent", "original"].includes(variant.status))) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (!signal.aborted) {
        const setup = typeof err === "object" && err !== null && "code" in err && err.code === "DUBBING_RUNTIME_SETUP";
        if (setup) {
          const delay = Math.min(15 * 60_000, (this.runtimeFailure?.delay ?? 30_000) * 2);
          this.runtimeFailure = { provider: job.provider, language: job.language, revision: job.render_version, delay, retryAt: Date.now() + delay };
        } else this.runtimeFailure = undefined;
        update.run("error", setup ? runtimeFailurePhase : "", 0, err instanceof Error ? err.message : String(err), media.id, job.language, job.fingerprint);
      }
    } finally {
      if (signal.aborted) {
        // Switching back while an upgrade is still running can leave the desired version already published.
        const provider = this.plugins.dubbingProvider();
        const revision = this.settings(provider).revision;
        if (provider?.manifest.id !== job.provider || !revision || revision === job.render_version
          || !this.reconcilePublishedRevision(media, { ...job, render_version: revision }, true)) {
          update.run("queued", "", 0, "", media.id, job.language, job.fingerprint);
        }
      }
      fs.rmSync(output, { force: true });
    }
  }

  async close() {
    this.closed = true; clearTimeout(this.timer);
    this.active?.controller.abort();
    await this.active?.done;
  }
}
