import { describe, expect, it } from "vitest";
import { orderVariantsForRecording, parseHlsVariants, recordingMaxHeight, ytDlpHeightSort } from "./hls-quality";

const master = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,NAME="1080p"', "1080/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,NAME="720p"', "720/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,NAME="480p"', "480/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360', "360/index.m3u8",
].join("\n");
const heights = (list: Array<{ height: number }>) => list.map((variant) => variant.height);

describe("HLS recording quality", () => {
  it("reads height from RESOLUTION, NAME or the playlist name", () => {
    expect(heights(parseHlsVariants(master, "https://cdn.test/live/master.m3u8"))).toEqual([1080, 720, 480, 360]);
    expect(parseHlsVariants(master, "https://cdn.test/live/master.m3u8")[1].url).toBe("https://cdn.test/live/720/index.m3u8");
    expect(heights(parseHlsVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,NAME="540p"\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nroom_240p.m3u8', "https://cdn.test/m.m3u8"))).toEqual([540, 240]);
    expect(parseHlsVariants("not a playlist", "https://cdn.test/m.m3u8")).toEqual([]);
  });

  it("keeps the highest quality first when set to automatic", () => {
    expect(heights(orderVariantsForRecording(parseHlsVariants(master, "https://cdn.test/m.m3u8")))).toEqual([1080, 720, 480, 360]);
  });

  it("prefers the best variant at or below the maximum height", () => {
    const variants = parseHlsVariants(master, "https://cdn.test/m.m3u8");
    expect(heights(orderVariantsForRecording(variants, 720))).toEqual([720, 480, 360, 1080]);
    expect(heights(orderVariantsForRecording(variants, 600))).toEqual([480, 360, 720, 1080]);
  });

  it("falls back to the closest larger quality instead of failing", () => {
    const variants = parseHlsVariants(master, "https://cdn.test/m.m3u8");
    expect(heights(orderVariantsForRecording(variants, 240))).toEqual([360, 480, 720, 1080]);
  });

  it("uses bandwidth when the manifest has no quality information", () => {
    const variants = [{ url: "a", bandwidth: 1, height: 0 }, { url: "b", bandwidth: 9, height: 0 }];
    expect(orderVariantsForRecording(variants, 720).map((variant) => variant.url)).toEqual(["b", "a"]);
  });

  it("treats missing or invalid configuration as automatic", () => {
    expect(recordingMaxHeight(undefined)).toBe(0);
    expect(recordingMaxHeight({ recordingMaxHeight: "720" })).toBe(720);
    expect(recordingMaxHeight({ recordingMaxHeight: -1 })).toBe(0);
    expect(recordingMaxHeight({ recordingMaxHeight: 720.5 })).toBe(0);
    expect(ytDlpHeightSort(0)).toBeUndefined();
    expect(ytDlpHeightSort(480)).toBe("res:480");
  });
});
