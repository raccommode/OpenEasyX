import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { PluginContext, SubtitleWorkerOptions } from "../../packages/plugin-sdk/index.js";
import localSubtitles from "./index.js";
import { Catalog } from "../../server/catalog.js";
import { Database } from "../../server/database.js";
import { LibraryDatabase } from "../../server/library-database.js";
import { registerLibraryRoutes } from "../../server/library-routes.js";
import { PluginManager } from "../../server/plugin-manager.js";
import { SubtitleService } from "../../server/subtitle-service.js";

it("controls worker lifetime, imports and retries through installation while retaining existing tracks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-subtitle-plugin-"));
  const mediaDir = path.join(root, "media");
  const library = new LibraryDatabase(root);
  const downloadDb = new Database(root);
  const manager = new PluginManager(downloadDb, []);
  let installed = false;
  const run = vi.fn((context: PluginContext, _options: SubtitleWorkerOptions) => new Promise<void>((resolve) => {
    context.signal!.addEventListener("abort", () => resolve(), { once: true });
  }));
  const subtitleLanguages = [{ code: "fr", label: "Français" }, { code: "sv-SE", label: "Svenska" }];
  const plugin = { ...localSubtitles, manifest: { ...localSubtitles.manifest, subtitleLanguages }, runSubtitleWorker: run };
  const service = new SubtitleService(library, {
    subtitleProvider: () => installed ? plugin : undefined,
    context: manager.context.bind(manager),
  }, root, mediaDir, vi.fn());
  const app = Fastify();
  const catalog = new Catalog(library, mediaDir, root, false);
  registerLibraryRoutes(app, library, catalog, downloadDb, root, service);
  try {
    fs.writeFileSync(path.join(mediaDir, "example.mp4"), "placeholder");
    await catalog.scan();
    const id = library.listMedia({}).items[0].id;
    const tracksUrl = `/api/media/${id}/subtitles`;
    const payload = { content: "1\n00:00:00,000 --> 00:00:03,000\nBonjour" };

    await service.sync();
    expect(run).not.toHaveBeenCalled();
    expect((await app.inject(tracksUrl)).json()).toMatchObject({ pluginEnabled: false, status: "disabled", languages: [] });
    expect((await app.inject({ url: `${tracksUrl}/fr`, method: "PUT", payload })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/settings/subtitles", method: "PUT", payload: { enabled: true, languages: [] } })).statusCode).toBe(409);

    installed = true;
    await service.sync();
    await service.sync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual({ databasePath: library.databasePath, dataDir: root, mediaDir, languages: [] });
    expect((await app.inject(tracksUrl)).json().languages).toEqual(subtitleLanguages);
    expect((await app.inject("/api/subtitles/status")).json().languages).toEqual(subtitleLanguages);
    expect((await app.inject({ url: "/api/settings/subtitles", method: "PUT", payload: { enabled: true, languages: ["en"] } })).statusCode).toBe(400);
    expect((await app.inject({ url: `${tracksUrl}/en`, method: "PUT", payload })).statusCode).toBe(400);
    const update = await app.inject({ url: "/api/settings/subtitles", method: "PUT", payload: { enabled: true, languages: ["sv-SE", "fr"] } });
    expect(update.statusCode).toBe(200);
    expect((await app.inject(tracksUrl)).json().targetLanguages).toEqual(["sv-SE", "fr"]);
    expect(run.mock.calls[0][0].signal!.aborted).toBe(true);
    expect(run.mock.calls[1][1].languages).toEqual(["sv-SE", "fr"]);
    expect((await app.inject({ url: `${tracksUrl}/fr`, method: "PUT", payload })).json()).toMatchObject({ tracks: [{ id: "manual-fr", label: "Français" }] });
    expect((await app.inject({ url: `${tracksUrl}/fr`, method: "PUT", payload: { content: "WEBVTT\n\nbroken" } })).statusCode).toBe(400);

    library.sqlite.prepare("INSERT INTO subtitle_jobs(media_id,status,attempts,last_error,updated_at) VALUES(?, 'error',3,'failed',?)").run(id, new Date().toISOString());
    expect((await app.inject({ url: `${tracksUrl}/retry`, method: "POST" })).json()).toMatchObject({ status: "queued", error: "" });
    expect((await app.inject({ url: `${tracksUrl}/retry`, method: "POST" })).statusCode).toBe(409);

    installed = false;
    await service.sync();
    expect(run.mock.calls[1][0].signal!.aborted).toBe(true);
    expect((await app.inject(tracksUrl)).json()).toMatchObject({ status: "disabled", tracks: [{ id: "manual-fr" }] });
    const track = await app.inject(`${tracksUrl}/manual-fr.vtt`);
    expect(track.statusCode).toBe(200);
    expect(track.body).toContain("00:00:00.000 --> 00:00:03.000\nBonjour");
    expect((await app.inject("/api/subtitles/status")).json()).toMatchObject({ pluginEnabled: false, settings: { enabled: false }, worker: { state: "disabled" } });
    expect(run).toHaveBeenCalledTimes(2);

    installed = true;
    await service.sync();
    expect(run.mock.calls[2][1].languages).toEqual(["sv-SE", "fr"]);
    await service.configure({ enabled: false, languages: ["fr"] });
    expect(run.mock.calls[2][0].signal!.aborted).toBe(true);
    expect((await app.inject(tracksUrl)).json()).toMatchObject({ pluginEnabled: true, status: "disabled" });
  } finally {
    await service.close();
    await app.close();
    library.close(); downloadDb.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
