import { describe, expect, it, vi } from "vitest";
import { listStripchatMedia, resolveStripchatDirect, resolveStripchatDownload, stripchatPublicPlaybackKey } from "./index.js";

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
