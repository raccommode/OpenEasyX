import { expect, it, vi } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import localDubbing from "../plugins/dubbing/index.js";
import { Catalog } from "./catalog.js";
import { Database } from "./database.js";
import { LibraryDatabase } from "./library-database.js";
import { PluginManager } from "./plugin-manager.js";
import { SubtitleService } from "./subtitle-service.js";
import { DubbingService } from "./dubbing-service.js";
import { registerLibraryRoutes } from "./library-routes.js";
import type { DubbingJob, EasyXPlugin } from "../packages/plugin-sdk/index.js";

it("keeps a migrated dub playable during a revision, interruption and failure, then publishes and revalidates the replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-revision-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  let library = new LibraryDatabase(root);
  let catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(db, []);
  let installed = true;
  let release: () => void = () => {};
  let attempts = 0;
  let fail = true;
  const plugin: EasyXPlugin = { ...localDubbing, manifest: { ...localDubbing.manifest, dubbingRenderVersion: "new" }, async renderDub({ signal }, job) {
    attempts++;
    fs.writeFileSync(job.output, "incomplete");
    await new Promise<void>((resolve) => { release = resolve; signal!.addEventListener("abort", () => resolve(), { once: true }); });
    if (fail) throw new Error("Model unavailable");
    fs.writeFileSync(job.output, "new rendition");
    return { outcome: "rendered", lipSyncFrames: 0 };
  } };
  vi.spyOn(manager, "dubbingProvider").mockImplementation(() => installed ? plugin : undefined);
  const context = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...context(...args), config: { fr: true } }));
  let service: DubbingService | undefined;
  let subtitles: SubtitleService | undefined;
  const app = Fastify();
  try {
    fs.writeFileSync(path.join(mediaDir, "video.mp4"), "source");
    await catalog.scan();
    const media = library.listMedia({}).items[0];
    const fingerprint = media.size + ":" + media.modifiedAt;
    const directory = createHash("sha256").update(plugin.manifest.id + ":" + fingerprint).digest("hex").slice(0, 24);
    const dir = path.join(root, "dubbing", media.id, directory);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "fr.mp4"), "existing");
    library.sqlite.exec("DROP TABLE dubbing_outputs; ALTER TABLE video_dubs DROP COLUMN render_version");
    library.sqlite.prepare("INSERT INTO video_dubs(media_id,language,fingerprint,provider,status) VALUES(?,'fr',?,?,'ready')").run(media.id, fingerprint, plugin.manifest.id);
    library.close();
    library = new LibraryDatabase(root);
    catalog = new Catalog(library, mediaDir, root, false);
    service = new DubbingService(library, manager, catalog, root);
    const variant = () => service!.status(media).variants[0];
    expect(variant()).toMatchObject({ status: "ready", updateStatus: "queued", playbackVersion: "legacy" });
    service.sync();
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(variant().updateStatus).toBe("running");
    expect(fs.readFileSync(service.file(media, "fr")!, "utf8")).toBe("existing");
    await service.close();
    service = new DubbingService(library, manager, catalog, root);
    service.sync();
    await vi.waitFor(() => expect(attempts).toBe(2));
    release();
    await vi.waitFor(() => expect(service!.overview().errors).toMatchObject([{ error: "Model unavailable" }]));
    expect(variant()).toMatchObject({ status: "ready", updateStatus: "error" });
    service.sync();
    expect(attempts).toBe(2);
    installed = false;
    expect(variant().status).toBe("ready");
    installed = true;
    subtitles = new SubtitleService(library, manager, root, mediaDir, vi.fn());
    registerLibraryRoutes(app, library, catalog, db, root, subtitles, service);
    const url = `/api/media/${media.id}/stream?dub=fr`;
    const old = await app.inject(url + "&v=legacy");
    expect(old.body).toBe("existing");
    expect(old.headers["cache-control"]).toContain("no-cache");
    expect((await app.inject({ url, headers: { "if-none-match": old.headers.etag! } })).statusCode).toBe(304);
    fail = false;
    service.retry(media, "fr");
    await vi.waitFor(() => expect(attempts).toBe(3));
    expect((await app.inject(url)).body).toBe("existing");
    release();
    await vi.waitFor(() => expect(variant().lipSyncFrames).toBe(0));
    expect(variant().updateStatus).toBeUndefined();
    expect(variant().playbackVersion).not.toBe("legacy");
    const next = await app.inject({ url: url + "&v=" + variant().playbackVersion, headers: { "if-range": old.headers.etag!, range: "bytes=0-2" } });
    expect([next.statusCode, next.body]).toEqual([200, "new rendition"]);
    expect(next.headers.etag).not.toBe(old.headers.etag);
    const partial = await app.inject({ url, headers: { "if-range": next.headers.etag!, range: "bytes=0-2" } });
    expect([partial.statusCode, partial.body]).toEqual([206, "new"]);
    expect(service.overview().errors).toEqual([]);
    await service.close();
    service = new DubbingService(library, manager, catalog, root);
    service.sync();
    expect(service.overview().current).toBeNull();
    expect(variant().lipSyncFrames).toBe(0);
  } finally {
    await service?.close(); await subtitles?.close(); await app.close(); library.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("offers only verified publications from supported revisions and reuses the same publication on retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-upgrade-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  const library = new LibraryDatabase(root);
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(db, []);
  const jobs: DubbingJob[] = [];
  let finish = false;
  const plugin: EasyXPlugin = { ...localDubbing, manifest: {
    ...localDubbing.manifest, dubbingRenderVersion: "v3", dubbingPreviousRenderVersions: ["v1", "v2"],
  }, async renderDub(_ctx, job) {
    jobs.push(job);
    fs.writeFileSync(job.output, finish ? "updated" : "incomplete");
    if (!finish) throw new Error("Interrupted upgrade");
    return { outcome: "rendered", lipSyncFrames: job.previousOutput?.lipSyncFrames };
  } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const ctx = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...ctx(...args), config: { fr: true } }));
  const service = new DubbingService(library, manager, catalog, root);
  try {
    const kinds = ["eligible", "foreign", "stale", "unsupported", "legacy", "missing", "empty"];
    for (const kind of kinds) fs.writeFileSync(path.join(mediaDir, kind + ".mp4"), "source");
    await catalog.scan();
    const media = library.listMedia({}).items;
    const expected = new Map<string, DubbingJob["previousOutput"]>();
    const publish = library.sqlite.prepare("INSERT INTO dubbing_outputs(media_id,language,fingerprint,provider,file_key,lip_sync_frames) VALUES(?,'fr',?,?,?,0)");
    for (const item of media) {
      const kind = path.parse(item.relativePath).name;
      const fingerprint = item.size + ":" + item.modifiedAt;
      const provider = kind === "foreign" ? "another.dubbing" : plugin.manifest.id;
      const source = kind === "stale" ? "previous-source" : fingerprint;
      const revision = kind === "unsupported" ? "v0" : "v2";
      // Even an otherwise matching key cannot authorize a foreign provider or a stale source.
      const key = kind === "legacy" ? "" : createHash("sha256").update(JSON.stringify([plugin.manifest.id, fingerprint, revision])).digest("hex").slice(0, 24);
      const directory = createHash("sha256").update(provider + ":" + source).digest("hex").slice(0, 24);
      const dir = path.join(root, "dubbing", item.id, directory);
      const file = path.join(dir, key ? "fr." + key + ".mp4" : "fr.mp4");
      fs.mkdirSync(dir, { recursive: true });
      if (kind !== "missing") fs.writeFileSync(file, kind === "empty" ? "" : "published");
      publish.run(item.id, source, provider, key);
      expected.set(item.id, kind === "eligible" ? { path: file, renderVersion: revision, lipSyncFrames: 0 } : undefined);
    }
    service.sync();
    await vi.waitFor(() => expect(service.overview().errors).toHaveLength(kinds.length));
    expect(jobs).toHaveLength(kinds.length);
    for (const job of jobs) expect(job.previousOutput).toEqual(expected.get(job.mediaId));
    const item = media.find((item) => expected.get(item.id))!;
    const previous = expected.get(item.id)!;
    expect(service.file(item, "fr")).toBe(previous.path);
    expect(fs.readFileSync(previous.path, "utf8")).toBe("published");
    finish = true;
    service.retry(item, "fr");
    await vi.waitFor(() => expect(service.status(item).variants[0].updateStatus).toBeUndefined());
    expect(jobs.at(-1)?.previousOutput).toEqual(previous);
    expect(service.file(item, "fr")).not.toBe(previous.path);
    expect(fs.readFileSync(service.file(item, "fr")!, "utf8")).toBe("updated");
    expect(service.status(item).variants[0].lipSyncFrames).toBe(0);
  } finally {
    await service.close(); library.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reconciles a staged ready revision without rendering and still renders incomplete jobs or files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-staged-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  const library = new LibraryDatabase(root);
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(db, []);
  let renders = 0;
  const plugin: EasyXPlugin = { ...localDubbing, manifest: { ...localDubbing.manifest, dubbingRenderVersion: "4" },
    async renderDub(_ctx, job) {
      fs.writeFileSync(job.output, "render " + ++renders);
      return { outcome: "rendered", lipSyncFrames: 1040 };
    } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const ctx = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...ctx(...args), config: { fr: true } }));
  const service = new DubbingService(library, manager, catalog, root);
  try {
    fs.writeFileSync(path.join(mediaDir, "video.mp4"), "source");
    await catalog.scan();
    const media = library.listMedia({}).items[0];
    const stage = library.sqlite.prepare("UPDATE video_dubs SET status=?,render_version='3' WHERE media_id=? AND language='fr'");
    const job = () => library.sqlite.prepare("SELECT * FROM video_dubs WHERE media_id=? AND language='fr'").get(media.id);
    service.sync();
    await vi.waitFor(() => expect(job()?.status).toBe("ready"));
    const ready = job();
    const published = service.status(media).variants[0];
    const file = service.file(media, "fr")!;
    stage.run("ready", media.id);
    service.sync();
    service.sync();
    expect(job()).toEqual(ready);
    expect(service.status(media).variants[0]).toEqual(published);
    expect(renders).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("render 1");

    for (const scenario of ["queued", "error", "missing", "empty", "symlink"]) {
      stage.run(scenario === "queued" || scenario === "error" ? scenario : "ready", media.id);
      if (scenario === "missing") fs.unlinkSync(file);
      if (scenario === "empty") fs.truncateSync(file, 0);
      if (scenario === "symlink") {
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(mediaDir, "video.mp4"), file);
      }
      const before = renders;
      service.sync();
      await vi.waitFor(() => expect(job()).toMatchObject({ status: "ready", render_version: "4" }));
      expect(renders).toBe(before + 1);
      expect(fs.readFileSync(file, "utf8")).toBe("render " + renders);
    }
  } finally {
    await service.close(); library.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("publishes only finished versions, supports resuming a failed language and serves seekable video", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-lifecycle-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  const library = new LibraryDatabase(root);
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(db, []);
  let installed = false;
  const gates = new Map<string, () => void>();
  let fail = true;
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub({ signal }, job, report) {
    report("Synthesizing", 55);
    await new Promise<void>((resolve) => { gates.set(job.language, resolve); signal!.addEventListener("abort", () => resolve(), { once: true }); });
    if (job.language === "es" && fail) throw new Error("Temporary model failure");
    fs.writeFileSync(job.output, job.language + "-render");
    return "rendered";
  } };
  vi.spyOn(manager, "dubbingProvider").mockImplementation(() => installed ? plugin : undefined);
  const ctx = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...ctx(...args), config: { fr: true, es: true } }));
  const dub = new DubbingService(library, manager, catalog, root);
  const subtitles = new SubtitleService(library, manager, root, mediaDir, vi.fn());
  const app = Fastify();
  registerLibraryRoutes(app, library, catalog, db, root, subtitles, dub);
  try {
    fs.writeFileSync(path.join(mediaDir, "dialogue.mp4"), "original");
    await catalog.scan();
    const media = library.listMedia({}).items[0];
    const url = `/api/media/${media.id}`;
    dub.sync();
    expect(dub.status(media)).toEqual({ installed: false, variants: [] });
    installed = true;
    const scan = catalog.scan();
    dub.sync();
    expect(dub.overview().current).toBeNull();
    await scan;
    dub.sync();
    await vi.waitFor(() => expect(dub.overview().current).toMatchObject({ progress: 55, language: "fr" }));
    expect((await app.inject(url+"/stream?dub=fr")).statusCode).toBe(404);
    gates.get("fr")!();
    await vi.waitFor(() => expect(dub.overview().current).toMatchObject({ language: "es" }));
    const stream = await app.inject({ url: url+"/stream?dub=fr", headers: { range: "bytes=0-1" } });
    expect([stream.statusCode, stream.body]).toEqual([206, "fr"]);
    gates.get("es")!();
    await vi.waitFor(() => expect(dub.overview().errors).toMatchObject([{ language: "es", error: "Temporary model failure" }]));
    fail = false;
    await app.inject({ method: "POST", url: url+"/dubbing/es/retry" });
    gates.get("es")!();
    await vi.waitFor(() => expect(dub.status(media).variants.every((v) => v.status === "ready")).toBe(true));
    expect((await app.inject(url+"/stream?dub=es")).body).toBe("es-render");
    library.sqlite.prepare("UPDATE media SET size=size+1 WHERE id=?").run(media.id);
    expect((await app.inject(url+"/stream?dub=fr")).statusCode).toBe(404);
  } finally {
    await dub.close(); await subtitles.close(); await app.close(); library.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("publishes distinct audio and lip-sync revisions and keeps serving the last completed mode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-modes-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  const library = new LibraryDatabase(root);
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(db, []);
  const config = { fr: true, lipSync: false };
  const runs: { job: DubbingJob; signal: AbortSignal; finish: () => void }[] = [];
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub({ signal }, job) {
    await new Promise<void>((finish) => {
      runs.push({ job, signal: signal!, finish });
      signal!.addEventListener("abort", () => finish(), { once: true });
    });
    fs.writeFileSync(job.output, job.lipSync ? "animated" : "original picture");
    return { outcome: "rendered", lipSyncFrames: job.lipSync ? 17 : 0 };
  } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const ctx = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...ctx(...args), config }));
  const service = new DubbingService(library, manager, catalog, root);
  try {
    fs.writeFileSync(path.join(mediaDir, "video.mp4"), "source");
    await catalog.scan();
    const media = library.listMedia({}).items[0];
    const variant = () => service.status(media).variants[0];
    service.sync();
    expect(service.overview().lipSync).toBe(false);
    await vi.waitFor(() => expect(runs[0]?.job.lipSync).toBe(false));
    runs[0].finish();
    await vi.waitFor(() => expect(variant().lipSyncFrames).toBe(0));
    const audio = service.file(media, "fr")!;
    config.lipSync = true;
    service.sync();
    await vi.waitFor(() => expect(runs[1]?.job).toMatchObject({ lipSync: true, previousOutput: { path: audio, renderVersion: "5-audio" } }));
    expect(service.file(media, "fr")).toBe(audio);
    config.lipSync = false;
    service.sync();
    expect(runs[1].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(variant().updateStatus).toBeUndefined());
    expect(runs).toHaveLength(2);
    expect(fs.readFileSync(audio, "utf8")).toBe("original picture");
    config.lipSync = true;
    service.sync();
    await vi.waitFor(() => expect(runs[2]?.job.lipSync).toBe(true));
    config.fr = false;
    service.sync();
    expect(runs[2].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(service.overview().current).toBeNull());
    expect(service.file(media, "fr")).toBe(audio);
    config.fr = true;
    service.sync();
    await vi.waitFor(() => expect(runs[3]?.job.lipSync).toBe(true));
    runs[3].finish();
    await vi.waitFor(() => expect(variant().lipSyncFrames).toBe(17));
    const visual = service.file(media, "fr")!;
    expect(visual).not.toBe(audio);
    config.lipSync = false;
    service.sync();
    await vi.waitFor(() => expect(runs[4]?.job).toMatchObject({ lipSync: false, previousOutput: { path: visual, renderVersion: "5-lips" } }));
    expect(fs.readFileSync(service.file(media, "fr")!, "utf8")).toBe("animated");
    runs[4].finish();
    await vi.waitFor(() => expect(service.file(media, "fr")).toBe(audio));
  } finally {
    await service.close(); library.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it("rechecks legacy silent detections once and preserves confirmed silence and original-language outcomes across mode changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-silent-revision-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  const library = new LibraryDatabase(root);
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(db, []);
  const config = { fr: true, es: true, lipSync: false };
  const calls: string[] = [];
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub(_ctx, job) { calls.push(job.language); return "silent"; } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const ctx = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...ctx(...args), config }));
  const service = new DubbingService(library, manager, catalog, root);
  try {
    fs.writeFileSync(path.join(mediaDir, "video.mp4"), "source");
    await catalog.scan();
    const media = library.listMedia({}).items[0];
    const seed = library.sqlite.prepare("INSERT INTO video_dubs(media_id,language,fingerprint,provider,status,render_version) VALUES(?,?,?,?,?,'3')");
    for (const [language, status] of [["fr", "silent"], ["es", "original"]]) {
      seed.run(media.id, language, media.size + ":" + media.modifiedAt, plugin.manifest.id, status);
    }
    const states = () => Object.fromEntries(service.status(media).variants.map((variant) => [variant.code, variant.status]));
    expect(states()).toEqual({ fr: "queued", es: "original" });
    service.sync();
    await vi.waitFor(() => expect(states()).toEqual({ fr: "silent", es: "original" }));
    config.lipSync = true;
    service.sync();
    expect(service.overview().current).toBeNull();
    expect(states()).toEqual({ fr: "silent", es: "original" });
    expect(calls).toEqual(["fr"]);
  } finally {
    await service.close(); library.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it("requeues known legacy dubbing failures without resetting finished or unrelated jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-recovery-"));
  const database = new Database(root);
  const library = new LibraryDatabase(root);
  const mediaDir = path.join(root, "media");
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(database, []);
  try {
    fs.writeFileSync(path.join(mediaDir, "dialogue.mp4"), "source");
    await catalog.scan();
    const media = library.listMedia({}).items[0];
    const insert = library.sqlite.prepare(`INSERT INTO video_dubs(media_id,language,fingerprint,provider,status,phase,progress,error)
      VALUES(?,?,?,?,?,'',?,?)`);
    const id = localDubbing.manifest.id;
    const pip = "subprocess.CalledProcessError: Command '['/data/dubbing-runtime/linux-x86_64-3.11-cpu/bin/python', '-m', 'pip', 'install', '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.9.1', 'torchaudio==2.9.1']' returned non-zero exit status 1.";
    const venv = "subprocess.CalledProcessError: Command '['/usr/bin/python3', '-m', 'venv', '/data/dubbing-runtime/linux-x86_64-3.11-cpu']' returned non-zero exit status 1.";
    const renderFailed = "subprocess.CalledProcessError: Command '['ffmpeg', '-i', '/data/dubbing-runtime/demo.mp4']' returned non-zero exit status 1.";
    const packets = 'File "/app/plugins/dubbing/lips.py", line 954, in render\nav.error.InvalidDataError: Invalid data: avcodec_send_packet()';
    const silentVoice = "ValueError: The voice model did not generate audible speech";
    const cases = [
      ["ko", id, "error", packets, "queued"], ["fa", id, "error", silentVoice, "queued"],
      ["sv", id, "error", "ValueError: Translation produced an empty phrase", "queued"],
      ["nn", id, "error", packets.replace("/lips.py", "/dialogue.py"), "error"],
      ["pl", "other.provider", "error", silentVoice, "error"],
      ["fr", id, "error", pip, "queued"], ["en", id, "error", venv, "queued"],
      ["es", id, "error", renderFailed, "error"],
      ["zh", id, "error", pip.replace("/data/dubbing-runtime/", "/other/"), "error"],
      ["de", "another.provider", "error", pip, "error"],
      ["pt", id, "ready", "", "ready"], ["ru", id, "original", "", "original"], ["ja", id, "silent", "", "silent"],
    ];
    for (const [language, provider, status, error] of cases) {
      insert.run(media.id, language, media.size+":"+media.modifiedAt, provider, status, status === "error" ? 0 : 100, error);
    }
    const service = new DubbingService(library, manager, catalog, root);
    const select = library.sqlite.prepare("SELECT status,progress,error FROM video_dubs WHERE media_id=? AND language=?");
    for (const [language, , status, error, expectedStatus] of cases) {
      expect(select.get(media.id, language)).toEqual({
        status: expectedStatus, progress: status === "error" ? 0 : 100, error: expectedStatus === "queued" ? "" : error,
      });
    }
    await service.close();
    library.sqlite.prepare("UPDATE video_dubs SET status='error',error=? WHERE language='fa'").run(silentVoice);
    const restarted = new DubbingService(library, manager, catalog, root);
    expect(select.get(media.id, "fa")).toMatchObject({ status: "error", error: silentVoice });
    await restarted.close();
  } finally {
    library.close(); database.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it("waits on a common setup outage, retries the same job automatically, on request and after a restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-setup-"));
  const database = new Database(root);
  const library = new LibraryDatabase(root);
  const mediaDir = path.join(root, "media");
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(database, []);
  const attempts: string[] = [];
  let failing = true;
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub(_ctx, job) {
    attempts.push(job.mediaId);
    if (failing) throw Object.assign(new Error("Wheel install failed"), { code: "DUBBING_RUNTIME_SETUP" });
    fs.writeFileSync(job.output, "rendered");
    return "rendered";
  } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const context = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...context(...args), config: { fr: true } }));
  let service = new DubbingService(library, manager, catalog, root);
  const realTime = Date.now.bind(Date);
  let elapsed = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realTime() + elapsed);
  try {
    for (const name of ["one", "two", "three"]) fs.writeFileSync(path.join(mediaDir, name+".mp4"), "source");
    await catalog.scan();
    service.sync();
    await vi.waitFor(() => expect(service.overview().runtimeRetryAt).toBeDefined());
    const first = library.getMedia(attempts[0])!;
    const firstRetry = Date.parse(service.overview().runtimeRetryAt!);
    expect(service.overview().errors).toMatchObject([{ id: first.id, runtimeSetup: true, error: "Wheel install failed" }]);
    for (let i=0; i<4; i++) service.sync();
    expect(attempts).toEqual([first.id]);
    expect(library.sqlite.prepare("SELECT COUNT(*) AS n FROM video_dubs").get()?.n).toBe(1);
    elapsed = firstRetry - realTime() + 1;
    service.sync();
    await vi.waitFor(() => expect(attempts).toEqual([first.id, first.id]));
    expect(Date.parse(service.overview().runtimeRetryAt!) - Date.now()).toBeGreaterThan(110_000);
    service.retry(first, "fr");
    await vi.waitFor(() => expect(attempts).toEqual([first.id, first.id, first.id]));
    expect(service.overview().errors).toHaveLength(1);
    await service.close();
    failing = false;
    service = new DubbingService(library, manager, catalog, root);
    service.sync();
    await vi.waitFor(() => expect(library.sqlite.prepare("SELECT COUNT(*) AS n FROM video_dubs WHERE status='ready'").get()?.n).toBe(3));
    expect(attempts[3]).toBe(first.id);
    expect(attempts).toHaveLength(6);
    expect(service.overview().runtimeRetryAt).toBeUndefined();
    expect(service.overview().errors).toEqual([]);
  } finally {
    clock.mockRestore(); await service.close();
    library.close(); database.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it("requeues every interrupted worker on startup and resumes one job with its saved work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-interrupted-"));
  const database = new Database(root);
  const library = new LibraryDatabase(root);
  const mediaDir = path.join(root, "media");
  const catalog = new Catalog(library, mediaDir, root, false);
  const manager = new PluginManager(database, []);
  const resumed: string[] = [];
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub({ signal }, job) {
    resumed.push(fs.readFileSync(path.join(job.workDir, "speakers.json"), "utf8"));
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    return "silent";
  } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const context = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...context(...args), config: { fr: true } }));
  let service: DubbingService | undefined;
  try {
    for (const name of ["one", "two"]) fs.writeFileSync(path.join(mediaDir, name+".mp4"), name);
    await catalog.scan();
    const items = library.listMedia({}).items;
    const states = () => library.sqlite.prepare("SELECT status,phase,progress FROM video_dubs ORDER BY status").all();
    const snapshots: string[] = [];
    for (const media of items) {
      const fingerprint = media.size+":"+media.modifiedAt;
      const provider = plugin.manifest.id;
      library.sqlite.prepare(`INSERT INTO video_dubs(media_id,language,fingerprint,provider,status,phase,progress)
        VALUES(?,'fr',?,?,'running','Synthesizing',65)`).run(media.id, fingerprint, provider);
      const version = createHash("sha256").update(provider+":"+fingerprint).digest("hex").slice(0, 24);
      const workDir = path.join(root, "dubbing", media.id, version, "work");
      fs.mkdirSync(workDir, { recursive: true });
      const snapshot = path.join(workDir, "speakers.json");
      fs.writeFileSync(snapshot, media.id);
      snapshots.push(snapshot);
    }
    service = new DubbingService(library, manager, catalog, root);
    const queued = { status: "queued", phase: "", progress: 0 };
    expect(states()).toEqual([queued, queued]);
    expect(service.overview().current).toBeNull();
    service.sync();
    await vi.waitFor(() => expect(resumed).toHaveLength(1));
    expect(items.map((item) => item.id)).toContain(resumed[0]);
    expect(states().map((row) => row.status)).toEqual(["queued", "running"]);
    expect(snapshots.map((file) => fs.readFileSync(file, "utf8"))).toEqual(items.map((item) => item.id));
  } finally {
    await service?.close(); library.close(); database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
