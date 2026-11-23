import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DubbingJob, EasyXPlugin } from "../packages/plugin-sdk/index.js";
import localDubbing from "../plugins/dubbing/index.js";
import { Catalog } from "./catalog.js";
import { Database } from "./database.js";
import { DubbingService } from "./dubbing-service.js";
import { LibraryDatabase } from "./library-database.js";
import { PluginManager } from "./plugin-manager.js";

let root: string, mediaRoot: string, db: LibraryDatabase, catalog: Catalog;
const signal = new AbortController().signal;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-reference-videos-"));
  mediaRoot = fs.realpathSync(root) + path.sep + "library";
  db = new LibraryDatabase(root);
  catalog = new Catalog(db, mediaRoot, root, false, undefined, (name) => name === "Former Name" ? "Casey" : name);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function add(file: string, info?: object) {
  const target = path.join(mediaRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file);
  if (info) fs.writeFileSync(target.replace(/\.[^.]+$/, ".info.json"), JSON.stringify(info));
  return target;
}

it("gives the first render distinct local videos with a shared performer credit", async () => {
  add("Various/current.mp4", { cast: ["CASEY", { name: "Robin" }] });
  const solo = add("Former Name/first.mp4");
  const other = add("Robin/second.mp4");
  const joint = add("Other/joint.mp4", { performers: ["Robin", "Casey"] });
  add("Various/unrelated.mp4");
  add("Casey Lee/unrelated.mp4");
  add("Casey/photo.jpg");
  const gone = add("Casey/removed.mp4");
  const changed = add("Casey/changed.mp4");
  const blocked = add("Casey/blocked.mp4");
  const escaped = add("Casey/escaped.mp4");
  const hardlink = path.join(mediaRoot, "Casey", "same-file.mp4");
  fs.linkSync(solo, hardlink);
  fs.linkSync(path.join(mediaRoot, "Various/current.mp4"), path.join(mediaRoot, "Casey/current-copy.mp4"));
  await catalog.scan();
  fs.unlinkSync(gone);
  fs.appendFileSync(changed, "different fingerprint");
  db.sqlite.prepare("UPDATE media SET playable=0 WHERE relative_path=?").run(path.relative(mediaRoot, blocked));
  fs.renameSync(escaped, path.join(root, "external.mp4"));
  fs.symlinkSync(path.join(root, "external.mp4"), escaped);
  const current = db.listMedia({ q: "current", sort: "recent" }).items.find((item) => item.relativePath === "Various/current.mp4")!;
  db.sqlite.prepare("UPDATE media SET added_at='2035-01-01' WHERE id=?").run(current.id);
  const managerDb = new Database(root);
  const plugins = new PluginManager(managerDb, []);
  let first: DubbingJob | undefined;
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub({ signal: abort }, job) {
    first = job;
    await new Promise<void>((resolve) => abort!.addEventListener("abort", () => resolve(), { once: true }));
    return "silent";
  } };
  vi.spyOn(plugins, "dubbingProvider").mockReturnValue(plugin);
  const context = plugins.context.bind(plugins);
  vi.spyOn(plugins, "context").mockImplementation((...args) => ({ ...context(...args), config: { fr: true } }));
  const service = new DubbingService(db, plugins, catalog, root);
  try {
    service.sync();
    await vi.waitFor(() => expect(first?.mediaId).toBe(current.id));
    const references = first!.referenceVideos!;
    expect(references).toHaveLength(3);
    expect(references.map((r) => r.source)).toEqual(expect.arrayContaining([other, joint]));
    expect(references.some((r) => r.source === solo || r.source === hardlink)).toBe(true);
    for (const r of references) {
      const item = db.getMedia(r.mediaId)!;
      expect(r.fingerprint).toBe(`${item.size}:${item.modifiedAt}`);
      expect(fs.realpathSync(r.source)).toBe(r.source);
    }
    expect(await catalog.dubbingReferenceVideos(current, signal)).toEqual(references);
  } finally {
    await service.close();
    managerDb.close();
  }
});

it("backfills existing libraries, follows changed credits and excludes unassigned videos", async () => {
  add("first.mp4");
  add("second.mp4");
  const named = add("before.mp4", { cast: ["Alex"] });
  add("other.mp4", { cast: [{ name: "Alex" }] });
  await catalog.scan();
  db.sqlite.exec("DROP TABLE video_cast");
  db.close();
  db = new LibraryDatabase(root);
  catalog = new Catalog(db, mediaRoot, root, false);
  const media = db.listMedia({}).items;
  const target = media.find(({ relativePath }) => relativePath === "before.mp4")!;
  expect((await catalog.dubbingReferenceVideos(target, signal)).map((item) => path.basename(item.source))).toEqual(["other.mp4"]);
  expect(await catalog.dubbingReferenceVideos(media.find(({ relativePath }) => relativePath === "first.mp4")!, signal)).toEqual([]);
  fs.writeFileSync(named.replace(".mp4", ".info.json"), JSON.stringify({ cast: ["New Credit"] }));
  await catalog.indexStoredMedia("before.mp4");
  expect(await catalog.dubbingReferenceVideos(target, signal)).toEqual([]);
  db.mergePerformerNames("New Credit", "Alex");
  expect(await catalog.dubbingReferenceVideos(target, signal)).toHaveLength(1);
});

it("caps references deterministically while including a less prolific co-star", async () => {
  for (let i = 0; i < 44; i++) add(`Prolific/work-${i}.mp4`);
  const rare = add("Other/only.mp4");
  add("target.mp4", { cast: ["Prolific", "Other"] });
  await catalog.scan();
  const target = db.listMedia({ q: "target" }).items[0];
  const refs = await catalog.dubbingReferenceVideos(target, signal);
  expect(refs).toHaveLength(32);
  expect(refs.slice(0, 2).map((r) => r.source)).toContain(rare);
  expect(await catalog.dubbingReferenceVideos(target, signal)).toEqual(refs);
});

it("uses the managed download's performer and cast when it has no sidecar", async () => {
  const downloads = new Database(root);
  try {
    const performer = downloads.createPerformer({ name: "Lead" });
    const source = downloads.addSource(performer.id, "source.test", {
      externalId: "lead", label: "Lead", domain: "example.test", profileUrl: "https://example.test/lead",
    });
    downloads.ingestItems(source, [{ externalId: "scene", mediaType: "video", metadata: { cast: [{ name: "Guest" }] } }]);
    const item = downloads.getItemBySourceExternalId(source.id, "scene")!;
    downloads.setItemStatus(item.id, "completed", { storagePath: "managed.mp4" });
    add("managed.mp4");
    add("Lead/solo.mp4");
    add("Guest/other.mp4");
    catalog = new Catalog(db, mediaRoot, root, false, (file) => downloads.storedMediaMetadata(file));
    await catalog.scan();
    const current = db.listMedia({ q: "managed" }).items[0];
    const refs = await catalog.dubbingReferenceVideos(current, signal);
    expect(refs.map((r) => path.basename(r.source)).sort()).toEqual(["other.mp4", "solo.mp4"]);
  } finally {
    downloads.close();
  }
});
