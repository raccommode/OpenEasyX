import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EasyXPlugin } from "../packages/plugin-sdk/index.js";
import type { Catalog } from "./catalog.js";
import type { LibraryDatabase, Media } from "./library-database.js";
import type { PluginManager } from "./plugin-manager.js";

type Job = { media_id: string; language: string; fingerprint: string; provider: string; status: string; phase: string; progress: number; error: string };
function fingerprint(media: Media) { return `${media.size}:${media.modifiedAt}`; }
const runtimeFailurePhase = "Waiting to retry runtime setup";

export class DubbingService {
  private active?: { plugin: EasyXPlugin; job: Job; controller: AbortController; done: Promise<void> };
  private timer?: NodeJS.Timeout;
  private runtimeFailure?: { provider: string; language: string; delay: number; retryAt: number };
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
  }

  private directory(job: Job) {
    const version = createHash("sha256").update(job.provider + ":" + job.fingerprint).digest("hex").slice(0, 24);
    return path.join(this.dataDir, "dubbing", job.media_id, version);
  }

  private targets(plugin = this.plugins.dubbingProvider()) {
    if (!plugin) return [];
    const { config } = this.plugins.context(plugin.manifest.id);
    return (plugin.manifest.dubbingLanguages ?? []).filter(({ code }) => config[code] === true);
  }

  status(media: Media) {
    const plugin = this.plugins.dubbingProvider();
    const targets = this.targets(plugin);
    const jobs = this.db.sqlite.prepare("SELECT * FROM video_dubs WHERE media_id=? AND fingerprint=?").all(media.id, fingerprint(media)) as Job[];
    const available = [...targets];
    for (const job of jobs) {
      if (job.status === "ready" && !available.some(({ code }) => code === job.language)) {
        available.push({ code: job.language, label: new Intl.DisplayNames(["en"], { type: "language" }).of(job.language) ?? job.language });
      }
    }
    return { installed: Boolean(plugin), variants: available.map(({ code, label }) => {
      const job = jobs.find((row) => row.language === code && (row.status === "ready" || row.provider === plugin?.manifest.id));
      return { code, label, status: job?.status ?? "queued", phase: job?.phase, progress: job?.progress ?? 0, error: job?.error };
    }) };
  }

  overview() {
    const plugin = this.plugins.dubbingProvider();
    const job = this.active?.job;
    const current = job && this.db.sqlite.prepare(`SELECT m.title,d.language,d.progress,d.phase FROM video_dubs d JOIN media m ON m.id=d.media_id
      WHERE d.media_id=? AND d.language=? AND d.status='running'`).get(job.media_id, job.language);
    const errors = this.db.sqlite.prepare(`SELECT m.title,m.id,d.language,d.error,d.phase FROM video_dubs d JOIN media m ON m.id=d.media_id
      WHERE d.status='error' AND m.missing=0 AND d.provider=? AND d.fingerprint=(m.size||':'||m.modified_at)
      ORDER BY (d.phase=?) DESC,m.modified_at DESC LIMIT 20`).all(plugin?.manifest.id ?? "", runtimeFailurePhase)
      .map(({ phase, ...failure }) => phase === runtimeFailurePhase ? { ...failure, runtimeSetup: true } : failure);
    const wait = this.runtimeFailure;
    const runtimeRetryAt = wait && wait.provider === plugin?.manifest.id && wait.retryAt > Date.now()
      ? new Date(wait.retryAt).toISOString() : undefined;
    return { oldestFirst: !!plugin && this.plugins.context(plugin.manifest.id).config.oldestFirst === true, languages: plugin?.manifest.dubbingLanguages ?? [], selected: this.targets(plugin).map(({ code }) => code), current: current ?? null, errors, runtimeRetryAt };
  }

  file(media: Media, language: string) {
    const job = this.db.sqlite.prepare("SELECT * FROM video_dubs WHERE media_id=? AND language=? AND fingerprint=? AND status='ready'")
      .get(media.id, language, fingerprint(media)) as Job | undefined;
    if (!job) return;
    const file = path.join(this.directory(job), language + ".mp4");
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    this.db.sqlite.prepare("UPDATE video_dubs SET status='queued',progress=0 WHERE media_id=? AND language=?").run(media.id, language);
    this.sync();
  }

  retry(media: Media, language: string) {
    const plugin = this.plugins.dubbingProvider();
    if (!plugin || !this.targets(plugin).some(({ code }) => code === language)) throw Object.assign(new Error("Select this dubbing language first"), { statusCode: 409 });
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
    const targets = this.targets(plugin).map(({ code }) => code);
    if (this.runtimeFailure && (this.runtimeFailure.provider !== plugin?.manifest.id || !targets.includes(this.runtimeFailure.language))) {
      this.runtimeFailure = undefined;
    }
    if (this.active) {
      const { job, controller } = this.active;
      const media = this.db.getMedia(job.media_id);
      if (this.active.plugin !== plugin || !targets.includes(job.language) || !media || fingerprint(media) !== job.fingerprint) controller.abort();
      return;
    }
    // A scan may still be indexing other videos credited to this performer.
    if (!plugin?.renderDub || !targets.length || this.catalog.status.running) return;
    if (this.runtimeFailure && Date.now() < this.runtimeFailure.retryAt) return;
    const direction = this.plugins.context(plugin.manifest.id).config.oldestFirst === true ? "ASC" : "DESC";
    const values = targets.map(() => "(?)").join(",");
    const row = this.db.sqlite.prepare(`WITH targets(code) AS (VALUES ${values}) SELECT m.id,t.code FROM media m CROSS JOIN targets t
      LEFT JOIN video_dubs d ON d.media_id=m.id AND d.language=t.code AND d.fingerprint=(m.size||':'||m.modified_at) AND d.provider=?
      WHERE m.missing=0 AND m.playable=1 AND m.kind='video' AND (d.status IS NULL OR d.status='queued' OR (d.status='error' AND d.phase=?))
      ORDER BY CASE WHEN d.phase=? THEN 0 ELSE 1 END,m.added_at ${direction},m.id LIMIT 1`).get(...targets, plugin.manifest.id, runtimeFailurePhase, runtimeFailurePhase) as { id: string; code: string } | undefined;
    if (!row) return;
    const media = this.db.getMedia(row.id)!;
    const job: Job = { media_id: media.id, fingerprint: fingerprint(media), provider: plugin.manifest.id, language: row.code,
      status: "running", phase: "Preparing models", progress: 0, error: "" };
    this.db.sqlite.prepare(`INSERT INTO video_dubs(media_id,language,fingerprint,provider,status,phase,progress,error) VALUES(?,?,?,?,?,?,0,'')
      ON CONFLICT(media_id,language) DO UPDATE SET fingerprint=excluded.fingerprint,provider=excluded.provider,status='running',phase=excluded.phase,progress=0,error=''`)
      .run(media.id, row.code, job.fingerprint, job.provider, job.status, job.phase);
    const controller = new AbortController();
    const done = this.render(plugin, media, job, controller.signal).finally(() => {
      this.active = undefined;
      setImmediate(() => this.sync());
    });
    this.active = { plugin, job, controller, done };
  }

  private async render(plugin: EasyXPlugin, media: Media, job: Job, signal: AbortSignal) {
    const dir = this.directory(job);
    const output = path.join(dir, job.language + ".partial.mp4");
    const workDir = path.join(dir, "work");
    const update = this.db.sqlite.prepare("UPDATE video_dubs SET status=?,phase=?,progress=?,error=? WHERE media_id=? AND language=? AND fingerprint=?");
    try {
      fs.mkdirSync(workDir, { recursive: true });
      const referenceVideos = await this.catalog.dubbingReferenceVideos(media, signal);
      signal.throwIfAborted();
      const outcome = await plugin.renderDub!(this.plugins.context(job.provider, signal), {
        mediaId: media.id, fingerprint: job.fingerprint, language: job.language, source: this.catalog.absolutePath(media),
        dataDir: this.dataDir, workDir, output, referenceVideos,
      }, (phase, progress) => {
        if (!signal.aborted) update.run("running", phase, Math.max(0, Math.min(progress, 99)), "", media.id, job.language, job.fingerprint);
      });
      const current = this.db.getMedia(media.id);
      if (signal.aborted || !current || fingerprint(current) !== job.fingerprint) return;
      if (outcome === "rendered") {
        if (!fs.statSync(output).size) throw new Error("The rendered video is empty");
        fs.renameSync(output, path.join(dir, job.language + ".mp4"));
      }
      update.run(outcome === "rendered" ? "ready" : outcome, "", 100, "", media.id, job.language, job.fingerprint);
      this.runtimeFailure = undefined;
      if (this.status(current).variants.every((variant) => ["ready", "silent", "original"].includes(variant.status))) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (!signal.aborted) {
        const setup = typeof err === "object" && err !== null && "code" in err && err.code === "DUBBING_RUNTIME_SETUP";
        if (setup) {
          const delay = Math.min(15 * 60_000, (this.runtimeFailure?.delay ?? 30_000) * 2);
          this.runtimeFailure = { provider: job.provider, language: job.language, delay, retryAt: Date.now() + delay };
        } else this.runtimeFailure = undefined;
        update.run("error", setup ? runtimeFailurePhase : "", 0, err instanceof Error ? err.message : String(err), media.id, job.language, job.fingerprint);
      }
    } finally {
      if (signal.aborted) update.run("queued", "", 0, "", media.id, job.language, job.fingerprint);
      fs.rmSync(output, { force: true });
    }
  }

  async close() {
    this.closed = true; clearTimeout(this.timer);
    this.active?.controller.abort();
    await this.active?.done;
  }
}
