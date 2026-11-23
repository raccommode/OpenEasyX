import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import localDubbing from "../plugins/dubbing/index.js";
import type { EasyXPlugin } from "../packages/plugin-sdk/index.js";
import { Catalog } from "./catalog.js";
import { Database } from "./database.js";
import { DubbingService } from "./dubbing-service.js";
import { LibraryDatabase } from "./library-database.js";
import { PluginManager } from "./plugin-manager.js";

it("applies a change of date order when choosing the next unprocessed video", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dub-order-"));
  const dir = path.join(root, "media");
  const library = new LibraryDatabase(root);
  const database = new Database(root);
  const catalog = new Catalog(library, dir, root, false);
  const manager = new PluginManager(database, []);
  const config: Record<string, boolean> = { fr: true };
  const jobs: Array<{ file: string; finish: () => void; signal: AbortSignal }> = [];
  const plugin: EasyXPlugin = { ...localDubbing, async renderDub({ signal }, job) {
    await new Promise<void>((finish) => {
      jobs.push({ file: path.basename(job.source), finish, signal: signal! });
      signal!.addEventListener("abort", () => finish(), { once: true });
    });
    return "silent";
  } };
  vi.spyOn(manager, "dubbingProvider").mockReturnValue(plugin);
  const context = manager.context.bind(manager);
  vi.spyOn(manager, "context").mockImplementation((...args) => ({ ...context(...args), config }));
  const service = new DubbingService(library, manager, catalog, root);
  try {
    for (const name of ["old", "middle", "recent", "new"]) fs.writeFileSync(path.join(dir, name+".mp4"), name);
    await catalog.scan();
    const update = library.sqlite.prepare("UPDATE media SET added_at=? WHERE relative_path=?");
    for (const [i, name] of ["old", "middle", "recent", "new"].entries()) {
      update.run(`2025-01-0${i+1}T00:00:00.000Z`, name+".mp4");
    }
    service.sync();
    expect(service.overview().oldestFirst).toBe(false);
    await vi.waitFor(() => expect(jobs.map((job) => job.file)).toEqual(["new.mp4"]));
    config.oldestFirst = true;
    service.sync();
    expect(jobs[0].signal.aborted).toBe(false);
    jobs[0].finish();
    await vi.waitFor(() => expect(jobs[1]?.file).toBe("old.mp4"));
    config.oldestFirst = false;
    jobs[1].finish();
    await vi.waitFor(() => expect(jobs[2]?.file).toBe("recent.mp4"));
  } finally {
    await service.close();
    library.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
