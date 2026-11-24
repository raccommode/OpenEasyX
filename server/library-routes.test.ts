import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import subtitlePlugin from "../plugins/subtitles";
import dubbingPlugin from "../plugins/dubbing";
import { Catalog } from "./catalog";
import { Database } from "./database";
import { DubbingService } from "./dubbing-service";
import { LibraryDatabase } from "./library-database";
import { parseMediaRange, registerLibraryRoutes } from "./library-routes";
import { PluginManager } from "./plugin-manager";
import { SubtitleService } from "./subtitle-service";

describe("media byte ranges", () => {
  it("serves ordinary and open-ended browser ranges", () => {
    expect(parseMediaRange("bytes=100-199", 1_000)).toEqual({ start: 100, end: 199 });
    expect(parseMediaRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseMediaRange("bytes=900-1200", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("serves suffix ranges from the end of the media file", () => {
    expect(parseMediaRange("bytes=-200", 1_000)).toEqual({ start: 800, end: 999 });
    expect(parseMediaRange("bytes=-1200", 1_000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects malformed, empty, multiple, and unsatisfiable ranges", () => {
    expect(parseMediaRange("bytes=-0", 1_000)).toBeUndefined();
    expect(parseMediaRange("bytes=1000-", 1_000)).toBeUndefined();
    expect(parseMediaRange("bytes=200-100", 1_000)).toBeUndefined();
    expect(parseMediaRange("bytes=0-10,20-30", 1_000)).toBeUndefined();
  });
});

it("filters the library, source counts and playlist by tracks from each installed plugin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-track-search-"));
  const mediaDir = path.join(root, "media");
  const db = new Database(root);
  const library = new LibraryDatabase(root);
  const catalog = new Catalog(library, mediaDir, root, false);
  const plugins = new PluginManager(db, []);
  const subtitles = new SubtitleService(library, plugins, root, mediaDir, () => {});
  const dubbing = new DubbingService(library, plugins, catalog, root);
  const app = Fastify();
  registerLibraryRoutes(app, library, catalog, db, root, subtitles, dubbing);
  const get = async (url: string) => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const list = (query: string) => get(`/api/library?sort=title&${query}`);
  const subtitleProvider = vi.spyOn(plugins, "subtitleProvider");
  const dubbingProvider = vi.spyOn(plugins, "dubbingProvider");
  const dubbingId = dubbingPlugin.manifest.id;
  try {
    const folder = path.join(mediaDir, "Performer", "example.com");
    fs.mkdirSync(folder, { recursive: true });
    for (const filename of ["a.mp4", "b.mp4", "c.mp4", "photo.jpg"]) fs.writeFileSync(path.join(folder, filename), "fixture");
    await catalog.scan();
    const [a, b, c] = library.listMedia({ kind: "video", sort: "title" }).items;
    library.upsertSubtitleTrack(a.id, "original", "en", "English", "original");
    library.upsertSubtitleTrack(a.id, "fr", "FR", "French", "generated");
    library.upsertSubtitleTrack(b.id, "manual-fr", "fr", "French", "manual");
    const publish = library.sqlite.prepare("INSERT INTO dubbing_outputs(media_id,language,fingerprint,provider,file_key) VALUES(?,?,?,?,?)");
    publish.run(a.id, "es", a.size + ":" + a.modifiedAt, dubbingId, "published");
    publish.run(c.id, "de", "outdated", dubbingId, "old");
    library.sqlite.prepare("INSERT INTO video_dubs(media_id,language,fingerprint,provider,status) VALUES(?,?,?,?,?)")
      .run(b.id, "es", b.size + ":" + b.modifiedAt, dubbingId, "running");

    const both = "subtitles=fr&dubbing=es";
    const baseFacets = await get("/api/facets");
    expect(baseFacets).not.toHaveProperty("subtitleLanguages");
    expect(baseFacets).not.toHaveProperty("dubbingLanguages");
    expect((await list(both)).total).toBe(4);

    subtitleProvider.mockReturnValue(subtitlePlugin);
    library.setSubtitleSettings({ enabled: false, languages: [] });
    const subtitleFacets = await get("/api/facets");
    expect(subtitleFacets.subtitleLanguages).toEqual(["en", "fr"]);
    expect(subtitleFacets).not.toHaveProperty("dubbingLanguages");
    expect((await list(both + "&pageSize=1&page=2"))).toMatchObject({ total: 2, pages: 2, items: [{ id: b.id }] });
    expect((await list("subtitles=with")).total).toBe(2);
    expect((await list("subtitles=without")).items).toMatchObject([{ id: c.id }]);

    dubbingProvider.mockReturnValue(dubbingPlugin);
    expect((await get("/api/facets?" + both))).toMatchObject({ subtitleLanguages: ["en", "fr"], dubbingLanguages: ["es"], sources: [{ name: "example.com", count: 1 }] });
    expect((await list(both)).items).toMatchObject([{ id: a.id }]);
    expect((await list("subtitles=fr&dubbing=without")).items).toMatchObject([{ id: b.id }]);
    expect((await list("dubbing=de")).total).toBe(0);
    expect((await list("kind=image&" + both)).items).toMatchObject([{ kind: "image" }]);
    expect((await get("/api/library/playlist?" + both)).ids).toEqual([a.id]);
    library.setFavorite(b.id, true);
    expect((await list("favorite=true&subtitles=fr&dubbing=without")).items).toMatchObject([{ id: b.id }]);

    subtitleProvider.mockReturnValue(undefined);
    const dubFacets = await get("/api/facets");
    expect(dubFacets).not.toHaveProperty("subtitleLanguages");
    expect(dubFacets.dubbingLanguages).toEqual(["es"]);
    expect((await list("subtitles=without&dubbing=with")).items).toMatchObject([{ id: a.id }]);
    expect((await list("dubbing=without")).total).toBe(2);
  } finally {
    await app.close();
    await dubbing.close();
    await subtitles.close();
    library.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
