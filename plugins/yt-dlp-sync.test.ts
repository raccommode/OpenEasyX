import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ytDlpDownload } from "./yt-dlp-utils.js";

it("keeps the shared HLS clock when the audio playlist starts two segments later", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-split-hls-"));
  const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-nostdin", ...args], { cwd: root });
  const start = (file: string, stream: string) => {
    const data = execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", "stream=start_time", "-of", "json", file], { cwd: root, encoding: "utf8" });
    return Number(JSON.parse(data).streams[0].start_time);
  };
  try {
    const hls = ["-f", "hls", "-hls_time", "1", "-hls_list_size", "0"];
    ffmpeg("-f", "lavfi", "-i", "color=size=96x64:rate=10:duration=5", "-c:v", "libx264", "-g", "10", "-preset", "ultrafast", ...hls, "video.m3u8");
    ffmpeg("-f", "lavfi", "-i", "sine=duration=5", "-c:a", "aac", ...hls, "audio.m3u8");
    const audioPlaylist = path.join(root, "audio.m3u8");
    const manifest = fs.readFileSync(audioPlaylist, "utf8").replace("#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-MEDIA-SEQUENCE:2");
    fs.writeFileSync(audioPlaylist, manifest.replace(/(?:#EXTINF:[^\n]+\naudio\d+\.ts\n){2}/, ""));
    const expectedOffset = start("audio.m3u8", "a:0") - start("video.m3u8", "v:0");
    expect(expectedOffset).toBeGreaterThan(1.9);

    const { args } = ytDlpDownload({ externalId: "room", mediaType: "video", pageUrl: "https://live.test/room" }, {}, { live: true, hls: true });
    const inputArgs = (key: string) => args.find((arg) => arg.startsWith(key))?.slice(key.length).split(" ") ?? [];
    ffmpeg(...inputArgs("ffmpeg_i:"), "-i", "video.m3u8", ...inputArgs("ffmpeg_i2:"), "-i", "audio.m3u8",
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "recording.mp4");
    expect(start("recording.mp4", "a:0") - start("recording.mp4", "v:0")).toBeCloseTo(expectedOffset, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
