import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
import { cam4FollowedSnapshot, setCam4Favorite } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sessionFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-cam4-test-"));
  temporaryDirectories.push(directory);
  const destination = path.join(directory, "cookies.txt");
  fs.writeFileSync(destination, "# Netscape HTTP Cookie File\n.cam4.com\tTRUE\t/\tTRUE\t0\tJSESSIONID\ttest-session\n");
  return destination;
}

function context(fetch: PluginContext["fetch"]): PluginContext {
  return { config: { cookiesFile: sessionFile() }, fetch, log: vi.fn(), runCommand: vi.fn() };
}

describe("CAM4 account favorites", () => {
  it("imports live and offline follows from the authenticated favorites page", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { username: "viewer_one" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        totalUsersCount: 2,
        usersList: [
          { username: "Alice", profileThumbnailUrl: "https://img/alice.jpg" },
          { username: "Bob", profileThumbnailUrl: "https://img/bob.jpg" },
        ],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ isLive: true, viewerCount: 12, previewImageURL: "https://img/alice-live.jpg" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ isLive: false })));
    const mock = context(fetch as PluginContext["fetch"]);

    await expect(cam4FollowedSnapshot(mock)).resolves.toEqual({
      authoritative: true,
      cams: [
        expect.objectContaining({ username: "Alice", online: true, viewers: 12 }),
        expect.objectContaining({ username: "Bob", online: false, viewers: 0 }),
      ],
    });
    expect(fetch.mock.calls[1][0].toString()).toContain("/rest/v1.0/favorites/viewer_one?limit=100&offset=0");
  });

  it("mirrors a follow to CAM4 and verifies the remote state", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { username: "viewer_one" } }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("false"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("true"));
    const mock = context(fetch as PluginContext["fetch"]);

    await expect(setCam4Favorite(mock, {
      id: "alice", username: "Alice", pageUrl: "https://www.cam4.com/Alice",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(fetch.mock.calls[2][0].toString()).toContain("/rest/v1.0/favorites/viewer_one/Alice");
    expect(fetch.mock.calls[2][1]).toEqual(expect.objectContaining({ method: "POST", body: "" }));
  });

  it("does not repeat a CAM4 follow that is already active", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { username: "viewer_one" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "FAVORITE" })));
    const mock = context(fetch as PluginContext["fetch"]);

    await expect(setCam4Favorite(mock, {
      id: "alice", username: "Alice", pageUrl: "https://www.cam4.com/Alice",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
