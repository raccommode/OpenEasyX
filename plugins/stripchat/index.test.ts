import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
import { listStripchatMedia, resolveStripchatDirect, resolveStripchatDownload, setStripchatFavorite, stripchatFollowedSnapshot, stripchatPublicPlaybackKey } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function stripchatSession(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-stripchat-test-"));
  temporaryDirectories.push(directory);
  const destination = path.join(directory, "cookies.txt");
  fs.writeFileSync(destination, "# Netscape HTTP Cookie File\n.stripchat.com\tTRUE\t/\tTRUE\t0\tsessionId\ttest-session\n");
  return destination;
}

function accountPage(): string {
  return `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({ userSession: { currentUser: { id: 77, username: "viewer" } }, config: { releaseVersion: "12.3.4" } })};</script>`;
}

function modernAccountPage(): string {
  return `<script>window.PAGE_CONFIG = ${JSON.stringify({ releaseVersion: "12.3.4" })};</script>`;
}

function pageState() {
  return `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({
    viewCam: { model: { id: 42, username: "Alice", isLive: true, isOnline: true } },
    configV3: {
      initialCommon: { hlsStreamHost: "doppiocdn.media" },
      static: { featureSettings: {
        hlsFallback: { fallbackDomains: ["doppiocdn.media"] },
        MMPExternalUnitedSourceOrigin: "https://mmp.doppiocdn.com/player/mmp",
      } },
    },
    featuresConfig: { features: { playerModuleExternalLoading: { mmpVersion: "v2.12.0" } } },
  })};</script>`;
}

function context(variant: string) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v2.12.0/main.js")) return new Response('function airplay(url){url.searchParams.set("pkey","PublicKey123456")}');
    if (url.includes("/master/")) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://media-hls.doppiocdn.media/live/42.m3u8?pkey=PublicKey123456\n`, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    return new Response(variant, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  });
  return {
    config: {}, fetch, log: vi.fn(),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: pageState(), stderr: "" })),
  };
}

describe("Stripchat direct live playback", () => {
  it("detects a live configured source from browser state without invoking yt-dlp", async () => {
    const mock = context("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n");
    await expect(listStripchatMedia(mock, {
      id: "source-1", externalId: "Alice", performerId: "person-1", profileUrl: "https://stripchat.com/Alice", domain: "stripchat.com",
    })).resolves.toEqual([expect.objectContaining({
      externalId: "stripchat:alice:live", pageUrl: "https://stripchat.com/Alice", filename: "Alice-live.mp4", metadata: expect.objectContaining({ live: true }),
    })]);
    expect(mock.runCommand).toHaveBeenCalledTimes(1);
    expect(mock.runCommand).toHaveBeenCalledWith("easyx-browser-fetch", ["https://stripchat.com/Alice"], expect.any(Object));
  });

  it("extracts the public playback key from the current player module", () => {
    expect(stripchatPublicPlaybackKey('url.searchParams.set("pkey","B0p93vi8Uj6AYyZb")')).toBe("B0p93vi8Uj6AYyZb");
    expect(stripchatPublicPlaybackKey("no playback key here")).toBeUndefined();
  });

  it("adds the player key and accepts only a real live media playlist", async () => {
    const mock = context("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:123\n#EXTINF:2\nsegment.mp4\n");
    await expect(resolveStripchatDirect(mock, "https://stripchat.com/Alice")).resolves.toEqual({
      url: "https://edge-hls.doppiocdn.media/hls/42/master/42_auto.m3u8?pkey=PublicKey123456",
      headers: { referer: "https://stripchat.com/", origin: "https://stripchat.com" },
      contentType: "application/vnd.apple.mpegurl",
    });
    expect(mock.fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects Stripchat's finite intro advertisement playlist", async () => {
    const mock = context("#EXTM3U\n#EXT-X-MOUFLON-ADVERT\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n");
    await expect(resolveStripchatDirect(mock, "https://stripchat.com/Alice")).rejects.toThrow("No public Stripchat HLS host returned a live manifest");
  });

  it("records the validated live media playlist directly instead of invoking yt-dlp", async () => {
    const mock = context("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:123\n#EXTINF:2\nsegment.mp4\n");
    await expect(resolveStripchatDownload(mock, {
      externalId: "stripchat:alice:session", pageUrl: "https://stripchat.com/Alice", mediaType: "video", filename: "alice.mp4",
    })).resolves.toEqual({
      kind: "command", command: "ffmpeg", filename: "alice.mp4",
      args: expect.arrayContaining([
        "-i", "https://media-hls.doppiocdn.media/live/42.m3u8?pkey=PublicKey123456",
        "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "{output}",
      ]),
    });
    expect(mock.runCommand).toHaveBeenCalledWith("easyx-browser-fetch", ["https://stripchat.com/Alice"], expect.any(Object));
  });
});

describe("Stripchat account favorites", () => {
  it("imports the authenticated online and offline favorite lists", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(modernAccountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ initialDynamic: { user: { id: 77, username: "viewer" } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [11, 12] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [
        { id: 11, username: "Alice", status: "public", viewersCount: 42 },
        { id: 12, username: "Bob", status: "offline", previewUrl: "/bob.jpg" },
      ] })));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand: vi.fn() } as unknown as PluginContext;

    await expect(stripchatFollowedSnapshot(mock)).resolves.toEqual({
      authoritative: true,
      cams: [
        expect.objectContaining({ username: "Alice", online: true, viewers: 42 }),
        expect.objectContaining({ username: "Bob", online: false, viewers: 0 }),
      ],
    });
    expect(fetch.mock.calls[1][0].toString()).toContain("/api/front/v3/config/initial-dynamic");
    expect(fetch.mock.calls[2][0].toString()).toContain("/api/front/users/77/favorites");
    expect(fetch.mock.calls[3][0].toString()).toContain("/api/front/models/list?modelIds=11%2C12");
  });

  it("mirrors a follow to Stripchat and verifies it in the remote favorite lists", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { user: { id: 22, username: "Bob" } } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [22] })));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand: vi.fn() } as unknown as PluginContext;

    await expect(setStripchatFavorite(mock, {
      id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(fetch.mock.calls[3][0].toString()).toContain("/api/front/users/77/favorites/22");
    expect(fetch.mock.calls[3][1]).toEqual(expect.objectContaining({ method: "PUT" }));
  });

  it("uses Stripchat's signed browser action when the HTTP endpoint requires its anti-noise payload", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [] })))
      .mockResolvedValueOnce(new Response("contract required", { status: 418 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [22] })));
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ success: true, favorite: true, modelId: 22 }), stderr: "" }));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand } as unknown as PluginContext;

    await expect(setStripchatFavorite(mock, {
      id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(runCommand).toHaveBeenCalledWith("easyx-browser-fetch", [
      "--stripchat-favorite", "https://stripchat.com/Bob", expect.stringContaining("cookies.txt"), "0", "follow",
    ], expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("does not repeat a Stripchat follow that is already active", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [22] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ id: 22, username: "Bob", status: "offline" }] })));
    const runCommand = vi.fn();
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand } as unknown as PluginContext;

    await expect(setStripchatFavorite(mock, {
      id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
