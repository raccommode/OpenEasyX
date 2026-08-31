import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";

const roots: string[] = [];
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-viewer-")); roots.push(root);
  const data = path.join(root, "data"); const media = path.join(root, "media");
  fs.mkdirSync(path.join(media, "Example Performer", "example.com"), { recursive: true });
  return { root, data, media, db: new LibraryDatabase(data) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("media catalog", () => {
  it("migrates playback state created by the initial release", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-viewer-migration-")); roots.push(root);
    const data = path.join(root, "data"); fs.mkdirSync(data);
    const legacy = new DatabaseSync(path.join(data, "easyx-viewer.sqlite"));
    legacy.exec(`CREATE TABLE playback (
      media_id TEXT PRIMARY KEY, progress_seconds REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT, updated_at TEXT NOT NULL
    ); INSERT INTO playback(media_id,progress_seconds,view_count,updated_at) VALUES('legacy-completed',0,1,'2026-01-01')`);
    legacy.close();

    const db = new LibraryDatabase(data);
    const columns = (db.sqlite.prepare("PRAGMA table_info(playback)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("completed");
    expect(columns).toContain("last_counted_at");
    expect(db.sqlite.prepare("SELECT completed FROM playback WHERE media_id='legacy-completed'").get()).toEqual({ completed: 1 });
    db.close();
  });

  it("indexes supported media and derives the Open EasyX folder metadata", async () => {
    const { data, media, db } = fixture();
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "first_video.mp4"), "video");
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "cover.jpg"), "image");
    fs.writeFileSync(path.join(media, "ignore.txt"), "not media");
    const catalog = new Catalog(db, media, data);

    const scan = await catalog.scan();
    const result = db.listMedia({ sort: "title" });

    expect(scan.indexed).toBe(2);
    expect(catalog.status).toMatchObject({ running: false, indexed: 2, processed: 2, total: 2, progress: 100 });
    expect(result.total).toBe(2);
    expect(result.items[0]).toMatchObject({ title: "cover", performer: "Example Performer", source: "example.com", kind: "image" });
    expect(result.items[1]).toMatchObject({ title: "first video", kind: "video" });
    expect(db.performers()).toEqual([{ name: "Example Performer", count: 2, videos: 1, images: 1, coverId: result.items[0].id }]);
    db.close();
  });

  it("uses a video as the performer cover when no photo is available", async () => {
    const { data, media, db } = fixture();
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "only-video.mp4"), "video");
    await new Catalog(db, media, data).scan();
    const video = db.listMedia().items[0];
    expect(db.performers()[0]).toMatchObject({ coverId: video.id, videos: 1, images: 0 });
    db.close();
  });

  it("queues thumbnails as soon as media is discovered", async () => {
    const { data, media, db } = fixture();
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "video.mp4"), "video");
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "photo.jpg"), "image");
    const catalog = new Catalog(db, media, data, true);
    const queued: string[] = [];
    catalog.thumbnail = async (item) => { queued.push(item.id); return path.join(data, `${item.id}.jpg`); };

    await catalog.scan();

    expect(queued).toHaveLength(2);
    expect(new Set(queued)).toEqual(new Set(db.listMedia().items.map((item) => item.id)));
    db.close();
  });

  it("hides unplayable media until the underlying file changes", async () => {
    const { data, media, db } = fixture();
    const file = path.join(media, "Example Performer", "example.com", "broken.mp4");
    fs.writeFileSync(file, "partial");
    const catalog = new Catalog(db, media, data, false);
    await catalog.scan();
    const item = db.listMedia().items[0];

    expect(db.markMediaUnplayable(item.id)).toBe(true);
    expect(db.getMedia(item.id)).toBeUndefined();
    expect(db.listMedia().total).toBe(0);
    expect(db.stats().total).toBe(0);
    expect(db.performers()).toEqual([]);

    await catalog.scan();
    expect(db.listMedia().total).toBe(0);
    fs.appendFileSync(file, "-complete");
    await catalog.scan();
    expect(db.listMedia().items[0]).toMatchObject({ id: item.id, size: 16 });
    db.close();
  });

  it.skipIf(!ffmpegAvailable)("lazily remuxes legacy MPEG-TS recordings mislabeled as MP4 for browser playback", async () => {
    const { data, media, db } = fixture();
    const file = path.join(media, "Example Performer", "example.com", "legacy-live.mp4");
    const generated = spawnSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", file,
    ], { encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    expect(fs.readFileSync(file).subarray(0, 1).toString("hex")).toBe("47");
    const catalog = new Catalog(db, media, data, false); await catalog.scan();
    const playback = await catalog.playbackFile(db.listMedia().items[0]);
    expect(playback).toMatchObject({ mimeType: "video/mp4", file: expect.stringContaining("playback-cache") });
    expect(fs.readFileSync(playback.file).subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(fs.readFileSync(file).subarray(0, 1).toString("hex")).toBe("47");
    db.close();
  });

  it("reads a sidecar title without exposing unsupported files", async () => {
    const { data, media, db } = fixture();
    const file = path.join(media, "Example Performer", "example.com", "opaque-id.mp4");
    fs.writeFileSync(file, "video");
    fs.writeFileSync(file.replace(".mp4", ".info.json"), JSON.stringify({ title: "A useful title" }));
    await new Catalog(db, media, data).scan();
    expect(db.listMedia().items[0].title).toBe("A useful title");
    db.close();
  });

  it("uses the source domain from sidecar metadata", async () => {
    const { data, media, db } = fixture();
    const file = path.join(media, "Example Performer", "example.com", "downloaded.mp4");
    fs.writeFileSync(file, "video");
    fs.writeFileSync(file.replace(".mp4", ".info.json"), JSON.stringify({ source_url: "https://www.youtube.com/watch?v=example" }));
    await new Catalog(db, media, data).scan();
    expect(db.listMedia().items[0].source).toBe("youtube.com");
    db.close();
  });

  it("aggregates storage, viewed content, and known watch durations", async () => {
    const { data, media, db } = fixture();
    const directory = path.join(media, "Example Performer", "example.com");
    fs.writeFileSync(path.join(directory, "episode.mp4"), "0123456789");
    fs.writeFileSync(path.join(directory, "photo.jpg"), "12345");
    await new Catalog(db, media, data).scan();
    const items = db.listMedia({ pageSize: 10 }).items;
    const video = items.find((item) => item.kind === "video")!;
    const image = items.find((item) => item.kind === "image")!;
    db.updateProbe(video.id, { duration: 120 });
    db.updateProgress(video.id, 30, 120);
    db.updateProgress(image.id, 0, 0, true);

    expect(db.stats()).toMatchObject({
      total: 2, videos: 1, images: 1, bytes: 15, videoBytes: 10, imageBytes: 5,
      viewed: 2, viewedVideos: 1, viewedImages: 1, libraryDurationSeconds: 120, watchedSeconds: 30,
    });
    db.close();
  });

  it("preserves playback state while missing files disappear from the library", async () => {
    const { data, media, db } = fixture();
    const file = path.join(media, "Example Performer", "example.com", "clip.mp4");
    fs.writeFileSync(file, "video"); const catalog = new Catalog(db, media, data); await catalog.scan();
    const item = db.listMedia().items[0];
    expect(db.setFavorite(item.id, true)?.favorite).toBe(true);
    expect(db.updateProgress(item.id, 42, 120)).toMatchObject({ progressSeconds: 42, completed: false, duration: 120 });
    expect(db.updateProgress(item.id, 120, 120, true)).toMatchObject({ viewCount: 1, completed: true });
    fs.unlinkSync(file); await catalog.scan();
    expect(db.listMedia().total).toBe(0);
    db.close();
  });

  it("permanently deletes a selected media file and its generated artifacts", async () => {
    const { data, media, db } = fixture();
    const file = path.join(media, "Example Performer", "example.com", "delete-me.jpg");
    fs.writeFileSync(file, "image");
    const catalog = new Catalog(db, media, data, false); await catalog.scan();
    const item = db.listMedia().items[0];
    const thumbnail = path.join(data, "thumbnails", `${item.id}-image-v1.jpg`);
    const subtitles = path.join(data, "subtitles", item.id, "manual-en.vtt");
    fs.mkdirSync(path.dirname(thumbnail), { recursive: true }); fs.writeFileSync(thumbnail, "thumb");
    fs.mkdirSync(path.dirname(subtitles), { recursive: true }); fs.writeFileSync(subtitles, "WEBVTT");

    expect(catalog.deleteMedia(item)).toEqual({ bytes: 5 });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(thumbnail)).toBe(false);
    expect(fs.existsSync(subtitles)).toBe(false);
    expect(db.getMedia(item.id)).toBeUndefined();
    expect(db.listMedia().total).toBe(0);
    db.close();
  });

  it("deletes a downloader media path and rejects paths outside the library root", async () => {
    const { root, data, media, db } = fixture();
    const relativePath = "Example Performer/example.com/recording.mp4";
    const file = path.join(media, ...relativePath.split("/"));
    const outside = path.join(root, "outside.mp4");
    fs.writeFileSync(file, "recording");
    fs.writeFileSync(outside, "keep me");
    const catalog = new Catalog(db, media, data, false); await catalog.scan();
    const item = db.listMedia().items[0];
    const playback = path.join(data, "playback-cache", `${item.id}.mp4`);
    fs.writeFileSync(playback, "cached");

    expect(catalog.deleteStoredMedia(relativePath)).toEqual({ bytes: 9, missing: false });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(playback)).toBe(false);
    expect(db.listMedia().total).toBe(0);
    expect(() => catalog.deleteStoredMedia("../outside.mp4")).toThrow("escapes the configured library root");
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
    db.close();
  });

  it("separates unseen, in-progress, unfinished, and completed videos", async () => {
    const { data, media, db } = fixture();
    const directory = path.join(media, "Example Performer", "example.com");
    for (const name of ["unseen.mp4", "started.mp4", "completed.mp4"]) fs.writeFileSync(path.join(directory, name), name);
    await new Catalog(db, media, data).scan();
    const byTitle = Object.fromEntries(db.listMedia({ pageSize: 10 }).items.map((item) => [item.title, item]));

    db.updateProgress(byTitle.started.id, 25, 100);
    db.updateProgress(byTitle.completed.id, 91, 100);

    expect(db.listMedia({ watched: "unseen" }).items.map((item) => item.title)).toEqual(["unseen"]);
    expect(db.listMedia({ watched: "progress" }).items.map((item) => item.title)).toEqual(["started"]);
    expect(new Set(db.listMedia({ watched: "unfinished" }).items.map((item) => item.title))).toEqual(new Set(["unseen", "started"]));
    expect(db.listMedia({ watched: "completed" }).items.map((item) => item.title)).toEqual(["completed"]);
    expect(db.getMedia(byTitle.started.id)).toMatchObject({ duration: 100, progressSeconds: 25, completed: false });
    expect(db.getMedia(byTitle.completed.id)).toMatchObject({ completed: true, viewCount: 1 });
    expect(db.facets().sources).toEqual([{ name: "example.com", count: 3 }]);
    expect(db.listMedia({ source: "example.com" }).total).toBe(3);
    db.close();
  });

  it("recalculates source counts for performer and watch-state filters", async () => {
    const { data, media, db } = fixture();
    const alpha = path.join(media, "Performer A", "alpha.example");
    const beta = path.join(media, "Performer A", "beta.example");
    const other = path.join(media, "Performer B", "alpha.example");
    fs.mkdirSync(alpha, { recursive: true }); fs.mkdirSync(beta, { recursive: true }); fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(alpha, "alpha-unseen.mp4"), "video");
    fs.writeFileSync(path.join(alpha, "alpha-completed.mp4"), "video");
    fs.writeFileSync(path.join(beta, "beta-progress.mp4"), "video");
    fs.writeFileSync(path.join(other, "other-unseen.mp4"), "video");
    await new Catalog(db, media, data).scan();
    const byTitle = Object.fromEntries(db.listMedia({ pageSize: 10 }).items.map((item) => [item.title, item]));
    db.updateProgress(byTitle["alpha completed"].id, 91, 100);
    db.updateProgress(byTitle["beta progress"].id, 25, 100);

    expect(db.facets({ performer: "Performer A" }).sources).toEqual([
      { name: "alpha.example", count: 2 }, { name: "beta.example", count: 1 },
    ]);
    expect(db.facets({ performer: "Performer A", watched: "unseen" }).sources).toEqual([{ name: "alpha.example", count: 1 }]);
    expect(db.facets({ performer: "Performer A", watched: "progress" }).sources).toEqual([{ name: "beta.example", count: 1 }]);
    expect(db.facets({ performer: "Performer A", watched: "completed" }).sources).toEqual([{ name: "alpha.example", count: 1 }]);
    expect(db.facets({ performer: "Performer B", watched: "unseen" }).sources).toEqual([{ name: "alpha.example", count: 1 }]);
    db.close();
  });

  it("stores subtitle preferences, tracks, and filter-consistent autoplay queues", async () => {
    const { data, media, db } = fixture();
    const directory = path.join(media, "Example Performer", "example.com");
    for (const name of ["first.mp4", "second.mp4"]) fs.writeFileSync(path.join(directory, name), name);
    fs.writeFileSync(path.join(directory, "between.jpg"), "image");
    await new Catalog(db, media, data).scan();
    const items = db.listMedia({ sort: "title" }).items;
    const video = items.find((item) => item.kind === "video")!;

    expect(db.subtitleSettings()).toEqual({ enabled: false, languages: [] });
    expect(db.setSubtitleSettings({ enabled: true, languages: ["fr", "en", "fr"] })).toEqual({ enabled: true, languages: ["en", "fr"] });
    expect(db.storedDownloaderSettings()).toBeUndefined();
    expect(db.downloaderSettings()).toEqual({ host: "localhost", port: 3210 });
    expect(db.setDownloaderSettings({ host: " downloader.local ", port: 4321 })).toEqual({ host: "downloader.local", port: 4321 });
    expect(db.storedDownloaderSettings()).toEqual({ host: "downloader.local", port: 4321 });
    db.upsertSubtitleTrack(video.id, "original", "en", "Original · English", "original", "en");
    db.upsertSubtitleTrack(video.id, "fr", "fr", "French", "generated", "en");
    expect(db.subtitleStatus(video.id)).toMatchObject({ status: "queued", tracks: [{ id: "original" }, { id: "fr" }] });
    expect(db.playlist({ source: "example.com", sort: "title" })).toEqual(items.map((item) => item.id));
    expect(db.playlist({ source: "example.com", kind: "video", sort: "title" })).toEqual(items.filter((item) => item.kind === "video").map((item) => item.id));
    expect(db.playlist({ source: "example.com", kind: "image", sort: "title" })).toEqual(items.filter((item) => item.kind === "image").map((item) => item.id));
    db.close();
  });
});
