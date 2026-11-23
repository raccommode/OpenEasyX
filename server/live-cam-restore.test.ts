import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.js";
import { LiveCamService } from "./live-cams.js";
import { PluginManager } from "./plugin-manager.js";
import { restoreLiveCamPerformers } from "./live-cam-restore.js";
import { profileIdentity } from "../packages/profile-identity.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-live-restore-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), pluginRoot = path.join(root, "plugins");
  const pluginDir = path.join(pluginRoot, "live"); fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.mjs"), `export default { manifest: { id: "test.restore", name: "Restore", version: "1", description: "Test", author: "Test", capabilities: ["live-cam"], sourceUrlPatterns: ["https://chaturbate.com/*"] }, listLiveCams: async () => ({ cams: [], total: 0, page: 1, pageSize: 24, pages: 1 }), resolveLiveStream: async () => ({ url: "https://cdn.test/live.m3u8" }) };`);
  const db = new Database(data); cleanups.push(() => db.close());
  const plugins = new PluginManager(db, [pluginRoot]); await plugins.load(); plugins.install("test.restore");
  const service = new LiveCamService(db, plugins);
  const cam = (username: string) => ({ id: username, username, pageUrl: `https://chaturbate.com/${username}/`, online: false });
  const source = (id: string, externalId: string, url: string) => db.addSource(id, "test.restore", { externalId, label: externalId, profileUrl: url, domain: "chaturbate.com" });
  const owner = db.createPerformer({ name: "Cherry Crush" });
  const original = source(owner.id, "reference", cam("cherrycrush").pageUrl);
  const legacy = db.upsertPerformer({ externalId: "cherrycrush", name: "cherrycrush" }, "test.restore");
  const duplicate = source(legacy.id, "cherrycrush", "https://chaturbate.com/old-cherry/");
  // Old databases can already contain the same account under two different names.
  db.sqlite.prepare("UPDATE sources SET profile_url=?,profile_key=? WHERE id=?").run(original.profileUrl, profileIdentity(original.profileUrl)!, duplicate.id);
  db.setLiveCamFavorite("test.restore", { ...cam("cherrycrush"), camId: "cherrycrush" }, true);
  return { root, data, pluginRoot, db, plugins, service, cam, source, owner, legacy, duplicate };
}

describe("saved live performer restoration", () => {
  it("refreshes a legacy shared account without merging it or losing its conflict notice", async () => {
    const { db, plugins, service, legacy, owner, duplicate, cam } = await fixture();
    const report = vi.fn();
    expect(() => restoreLiveCamPerformers(db, plugins, service, report)).not.toThrow();
    expect(report).not.toHaveBeenCalled();
    expect(db.listPerformers()).toHaveLength(2);
    expect(db.listSources()).toHaveLength(2);
    expect(db.getSource(duplicate.id)?.performerId).toBe(legacy.id);
    expect(db.sourceConflicts(legacy.id)).toEqual([expect.objectContaining({ existingPerformer: { id: owner.id, name: "Cherry Crush" } })]);
    // URL formatting changes do not create a new account association either.
    expect(() => service.createPerformer("test.restore", { ...cam("cherrycrush"), pageUrl: "https://chaturbate.com/CHERRYCRUSH?utm_source=test" })).not.toThrow();
    plugins.get("test.restore").listFollowedLiveCams = async () => ({ authoritative: true, cams: [cam("cherrycrush"), cam("healthy")] });
    await expect(service.syncFavorites("test.restore")).resolves.toMatchObject({ authoritative: true, synced: 2 });
    expect(db.getPerformerByName("healthy")).toBeDefined();
  });

  it("logs a genuinely new conflict, continues restoring other favorites, and still rejects manual reassignment", async () => {
    const { db, plugins, service, cam, source, legacy } = await fixture();
    source(legacy.id, "other-owned", cam("blocked").pageUrl);
    const blocked = db.upsertPerformer({ externalId: "blocked", name: "blocked" }, "test.restore");
    const previous = source(blocked.id, "blocked", "https://chaturbate.com/previous/");
    for (const username of ["blocked", "healthy"]) db.setLiveCamFavorite("test.restore", { ...cam(username), camId: username }, true);
    const report = vi.fn();
    expect(() => restoreLiveCamPerformers(db, plugins, service, report)).not.toThrow();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: "PERFORMER_IDENTITY_CONFLICT" }), "test.restore", "blocked");
    expect(db.getPerformerByName("healthy")).toBeDefined();
    expect(db.listLiveCamFavorites()).toHaveLength(3);
    expect(db.getSource(previous.id)?.profileUrl).toBe("https://chaturbate.com/previous/");
    expect(() => db.updateSource(previous.id, { profileUrl: cam("blocked").pageUrl })).toThrow("already linked");
    expect(() => db.addSource(blocked.id, "another", { externalId: "duplicate", label: "Duplicate", domain: "chaturbate.com", profileUrl: cam("cherrycrush").pageUrl })).toThrow("already linked");
  });

  it("starts the real HTTP server with both legacy duplicates and an invalid saved favorite", async () => {
    const { root, data, pluginRoot, db, legacy, cam } = await fixture();
    db.setLiveCamFavorite("test.restore", { camId: "broken", username: "broken", pageUrl: "https://unsupported.test/broken" }, true);
    db.setLiveCamFavorite("test.restore", { ...cam("healthy"), camId: "healthy" }, true);
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(), env: { ...process.env,
      PORT: "0", EASYX_DATA_DIR: data, EASYX_MEDIA_DIR: path.join(root, "media"), EASYX_EXTERNAL_PLUGINS_DIR: pluginRoot }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; } });
    let logs = "";
    const address = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${logs}`)), 15_000);
      const output = (chunk: Buffer) => {
        logs += chunk.toString(); const match = logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      };
      child.stdout.on("data", output); child.stderr.on("data", output);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Startup exited ${code}: ${logs}`)); });
    });
    expect(await (await fetch(`${address}/api/health`)).json()).toMatchObject({ ok: true });
    const conflicts = await (await fetch(`${address}/api/performers/${legacy.id}/conflicts`)).json() as { conflicts: unknown[] };
    expect(conflicts.conflicts).toHaveLength(1);
    expect(db.getPerformerByName("healthy")).toBeDefined();
    expect(logs).toContain("Saved favorite performer could not be restored");
  }, 20_000);
});
