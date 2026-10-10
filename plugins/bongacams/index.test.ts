import { describe, expect, it, vi } from "vitest";
import { bongacamsRoom, bongacamsLiveVariant, listBongacamsMedia, resolveBongacamsDownload, variantUrls } from "./index.js";
const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x240\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000,RESOLUTION=1920x1080\nhigh.m3u8\n";
const live = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2\nsegment.ts\n";
const source = { id: "s", performerId: "p", externalId: "alice", domain: "bongacams.com", profileUrl: "https://bongacams.com/alice" };
function context(showType = "public", playlist = master) {
  return { config: {}, log: vi.fn(), runCommand: vi.fn(), fetch: vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("amf.php")) return Response.json({ performerData: { username: "Alice", showType }, localData: { videoServerUrl: "https://video.test" } });
    return new Response(url.endsWith("playlist.m3u8") ? playlist : live);
  }) };
}
describe("BongaCams room recording", () => {
  it.each(["private", "group", "ticket", "exclusive", "vip"])("skips %s shows", async (showType) => {
    expect(await listBongacamsMedia(context(showType), source)).toEqual([]);
  });
  it("treats the empty offline playlist as an empty scan", async () => {
    expect(await listBongacamsMedia(context("public", "#EXTM3U\n#EXT-X-ENDLIST\n"), source)).toEqual([]);
  });
  it("selects the highest bandwidth live variant and returns a recorder command", async () => {
    const ctx = context(); const [item] = await listBongacamsMedia(ctx, source);
    expect(item).toMatchObject({ externalId: "bongacams:alice:live", metadata: { live: true }, pageUrl: source.profileUrl });
    expect(await resolveBongacamsDownload(ctx, item)).toMatchObject({ command: process.execPath, args: expect.arrayContaining(["https://video.test/hls/stream_Alice/high.m3u8", "{output}"]) });
    expect(variantUrls(master, "https://video.test/master.m3u8")[0].bandwidth).toBe(9000);
  });
  it("records the performer's chosen maximum quality", async () => {
    const ctx = { ...context(), config: { recordingMaxHeight: 720 } }; const [item] = await listBongacamsMedia(ctx, source);
    expect(await resolveBongacamsDownload(ctx, item)).toMatchObject({ args: expect.arrayContaining(["https://video.test/hls/stream_Alice/low.m3u8"]) });
    expect(variantUrls(master, "https://video.test/master.m3u8", 720).map((variant) => variant.height)).toEqual([240, 1080]);
  });
  it("supports a media playlist but rejects a finished recording", async () => {
    expect(await bongacamsLiveVariant(context("public", live), "https://video.test/playlist.m3u8")).toBe("https://video.test/playlist.m3u8");
    expect(await bongacamsLiveVariant(context("public", live + "#EXT-X-ENDLIST\n"), "https://video.test/playlist.m3u8")).toBeUndefined();
    expect(await listBongacamsMedia(context("public", live + "#EXT-X-ENDLIST\n"), source)).toEqual([]);
  });
  it("falls back to the alternate API host on transport failure", async () => {
    const ctx = context(); ctx.fetch.mockRejectedValueOnce(new Error("Network"));
    expect(await bongacamsRoom(ctx, source.profileUrl)).toMatchObject({ state: "public" });
    expect(ctx.fetch.mock.calls[1][0]).toBe("https://de.bongacams.net/tools/amf.php");
  });
  it("does not turn authentication, network or malformed responses into offline scans", async () => {
    const ctx = context(); ctx.fetch.mockResolvedValueOnce(Response.json({}));
    await expect(bongacamsRoom(ctx, source.profileUrl)).rejects.toThrow("Invalid BongaCams");
    const failing = context(); failing.fetch.mockImplementation(async (url) => {
      if (String(url).includes("amf.php")) return Response.json({ performerData: { username: "alice" }, localData: { videoServerUrl: "https://video.test" } });
      return new Response("Unavailable", { status: 503 });
    });
    await expect(listBongacamsMedia(failing, source)).rejects.toThrow("HTTP 503");
  });
  it("reports an unknown performer and honors cancellation before resolution", async () => {
    const ctx = context(); ctx.fetch.mockResolvedValueOnce(Response.json({ status: "error" }));
    await expect(listBongacamsMedia(ctx, source)).rejects.toThrow("not found");
    const controller = new AbortController(); controller.abort(new Error("Cancelled"));
    await expect(resolveBongacamsDownload({ ...context(), signal: controller.signal }, { externalId: "x", mediaType: "video", pageUrl: source.profileUrl })).rejects.toThrow("Cancelled");
  });
});
