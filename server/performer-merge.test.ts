import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { LibraryDatabase } from "./library-database.js";
import { Catalog } from "./catalog.js";
import { registerPerformerMergeRoutes } from "./performer-merge-routes.js";
import { profileIdentity } from "../packages/profile-identity.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-merge-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new Database(root); cleanup.push(() => db.close());
  const library = new LibraryDatabase(root); cleanup.push(() => library.close());
  const a = db.upsertPerformer({ externalId: "one", name: "First" }, "test");
  const b = db.upsertPerformer({ externalId: "two", name: "Second" }, "test");
  const source = (id: string, url: string) => db.addSource(id, "test", { externalId: "account", label: "Account", profileUrl: url, domain: "instagram.com" });
  const sa = source(a.id, "https://www.instagram.com/Example/");
  const sb = source(b.id, "https://instagram.com/other");
  const app = Fastify(); cleanup.push(() => app.close());
  return { root, db, library, a, b, sa, sb, app, source };
}

describe("performer account conflicts and explicit merge", () => {
  it("normalizes account links while preserving different post IDs and query identities", () => {
    expect(profileIdentity("http://www.instagram.com/EXAMPLE/?igsh=123#bio")).toBe(profileIdentity("https://instagram.com/example"));
    expect(profileIdentity("https://mfc.im/Alice/chat")).toBe(profileIdentity("https://www.myfreecams.com/#Alice"));
    expect(profileIdentity("https://www.myfreecams.com/#Alice")).not.toBe(profileIdentity("https://www.myfreecams.com/#Bob"));
    expect(profileIdentity("https://twitter.com/Example")).toBe(profileIdentity("https://x.com/example"));
    expect(profileIdentity("https://site.test/profile.php?id=1")).not.toBe(profileIdentity("https://site.test/profile.php?id=2"));
    expect(profileIdentity("https://instagram.com/p/AbC")).not.toBe(profileIdentity("https://instagram.com/p/abc"));
  });

  it("blocks both add and edit across plugins with a structured conflict; never merges implicitly", () => {
    const { db, a, b, sb } = fixture();
    expect(() => db.addSource(b.id, "another", { externalId: "x", label: "Same account", domain: "instagram.com", profileUrl: "https://instagram.com/EXAMPLE?igsh=abc" }))
      .toThrow(expect.objectContaining({ statusCode: 409, code: "PERFORMER_IDENTITY_CONFLICT", conflict: expect.objectContaining({ performerId: b.id, existingPerformer: { id: a.id, name: a.name } }) }));
    expect(() => db.updateSource(sb.id, { profileUrl: "https://instagram.com/example" })).toThrow("already linked");
    expect(db.getSource(sb.id)?.profileUrl).toContain("other");
    expect(db.listPerformers()).toHaveLength(2);
  });

  it("merges legacy duplicate sources, retains colliding item IDs, and remembers every provider identity", () => {
    const { db, a, b, sa, sb } = fixture();
    // Simulate duplicates saved before account ownership checks existed.
    db.sqlite.prepare("UPDATE sources SET profile_url=?,profile_key=? WHERE id=?").run(sa.profileUrl, profileIdentity(sa.profileUrl)!, sb.id);
    expect(db.sourceConflicts(b.id)[0].existingPerformer.id).toBe(a.id);
    for (const s of [sa, sb]) {
      db.ingestItems(s, [{ externalId: "same-video", mediaType: "video" }]);
      db.setItemStatus(db.getItemBySourceExternalId(s.id, "same-video")!.id, "completed", { storagePath: `${s.id}.mp4` });
    }
    const before = db.listItems().map((item) => ({ id: item.id, storagePath: item.storagePath }));
    db.mergePerformers(b.id, a.id);
    expect(db.listPerformers()).toHaveLength(1);
    expect(db.listSources()).toHaveLength(1);
    for (const item of before) expect(db.getItem(item.id)).toMatchObject({ ...item, performerId: a.id, sourceId: sa.id, externalId: "same-video" });
    expect(db.getPerformer(a.id)?.aliases).toContain("Second");
    expect(db.upsertPerformer({ externalId: "two", name: "Second" }, "test").id).toBe(a.id);
    expect(db.findPerformerByIdentity("test", "one")?.id).toBe(a.id);
    expect(db.resolvePerformerName("Second")).toBe("First");
    expect(() => db.createPerformer({ name: "Second" })).toThrow("merged profile First");
    expect(db.upsertPerformer({ externalId: "new-provider-id", name: "Second" }, "other").id).toBe(a.id);
    expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("requires confirmation, blocks active work, and preserves library favorites/history through rescans", async () => {
    const { root, db, library, a, b, app } = fixture();
    let busy = false;
    registerPerformerMergeRoutes(app, db, library, root, () => busy);
    const media = path.join(root, "media"); fs.mkdirSync(path.join(media, b.name), { recursive: true });
    const file = path.join(media, b.name, "photo.jpg"); fs.writeFileSync(file, "photo");
    const catalog = new Catalog(library, media, root, false, undefined, (name) => db.resolvePerformerName(name));
    await catalog.scan();
    const item = library.listMedia().items[0];
    library.setFavorite(item.id, true); library.updateProgress(item.id, 12, 100);
    const before = library.getMedia(item.id)!;
    const url = `/api/performers/${b.id}/merge`;
    expect((await app.inject({ method: "POST", url, payload: { targetId: a.id } })).statusCode).toBe(400);
    busy = true;
    expect((await app.inject({ method: "POST", url, payload: { targetId: a.id, confirmed: true } })).statusCode).toBe(409);
    busy = false;
    expect((await app.inject({ method: "POST", url, payload: { targetId: a.id, confirmed: true } })).statusCode).toBe(200);
    await catalog.scan();
    expect(library.getMedia(item.id)).toMatchObject({ ...before, performer: a.name });
    expect(fs.readFileSync(file, "utf8")).toBe("photo");
    expect((await app.inject({ method: "POST", url, payload: { targetId: a.id, confirmed: true } })).statusCode).toBe(404);
  });

  it("refuses merging while a download is active and makes no changes", () => {
    const { db, a, b, sb } = fixture();
    db.ingestItems(sb, [{ externalId: "active", mediaType: "video" }]);
    const item = db.getItemBySourceExternalId(sb.id, "active")!;
    db.setItemStatus(item.id, "downloading");
    expect(() => db.mergePerformers(b.id, a.id)).toThrow("active downloads");
    expect(db.listPerformers()).toHaveLength(2);
    expect(db.getItem(item.id)?.performerId).toBe(b.id);
  });
});
