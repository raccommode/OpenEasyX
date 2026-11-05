import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegHlsRetryArgs } from "./yt-dlp-utils.js";
import { LIVE_RECORDER_SCRIPT } from "./live-recorder.js";

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

async function recording(mode: "stall" | "timestamps" | "yt-stall") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-real-hls-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=4:size=96x64:rate=10", "-f", "lavfi", "-i", "sine=duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-sc_threshold", "0", "-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", path.join(root, "sample.m3u8")]);
  const output = path.join(root, "result.mp4");
  const part = (number: number) => fs.existsSync(path.join(root, "live-parts", `part-00${number}.ts`));
  const playlist = (segments: number[], ended: boolean, discontinuity = false) => "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n" +
    segments.map((segment, index) => `${discontinuity && index === 2 ? "#EXT-X-DISCONTINUITY\n" : ""}#EXTINF:1,\n/sample${segment}.ts\n`).join("") + (ended ? "#EXT-X-ENDLIST\n" : "");
  const server = http.createServer((request, response) => {
    const url = request.url!;
    if (url === "/master.m3u8") response.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=96x64\n/${part(1) ? "second" : "first"}.m3u8\n`);
    else if (url === "/first.m3u8") response.end(mode === "timestamps" ? playlist([0, 1, 0, 1], true, true) : playlist([0, 1], false));
    else if (url === "/second.m3u8") response.end(mode === "timestamps" ? playlist([0, 1], true) : playlist([2, 3], part(2)));
    else if (/^\/sample[0-3]\.ts$/.test(url)) response.end(fs.readFileSync(path.join(root, path.basename(url))));
    else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const command = mode === "yt-stall" ? "ffmpeg" : process.execPath;
  const args = mode === "yt-stall" ? ["-v", "error", "-rw_timeout", "15000000", ...ffmpegHlsRetryArgs(), "-i", `${base}/first.m3u8`, "-c", "copy", "-y", output]
    : ["-e", LIVE_RECORDER_SCRIPT, `${base}/first.m3u8`, `${base}/master.m3u8`, "{}", output, "500", "20", "Test"];
  const child = spawn(command, args, {
    // FFmpeg 5 can probe the stream for five seconds before creating output.
    env: { ...process.env, EASYX_LIVE_STALL_SECONDS: "10" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
  let logs = ""; child.stderr.on("data", (chunk) => { logs += chunk; });
  expect((await once(child, "close"))[0], logs).toBe(0);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,duration", "-of", "json", output], { encoding: "utf8" }));
  // Decode the complete output, not just its container header.
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"], { stdio: "pipe" });
  return { logs, frames: Number(probe.streams[0].nb_read_frames), duration: Number(probe.streams[0].duration) };
}

describe("recording real HLS over HTTP", () => {
  it("bounds Chaturbate's FFmpeg wait when an HTTP 200 playlist stops advancing", async () => {
    const result = await recording("yt-stall");
    expect(result.frames).toBe(20);
    expect(result.duration).toBeGreaterThanOrEqual(1.9);
    expect(result.duration).toBeLessThan(3);
  }, 25_000);

  it("captures both sides of a stalled playlist instead of leaving the recorder idle", async () => {
    const result = await recording("stall");
    expect(result.logs).toContain("continuing the recording");
    expect(result.frames).toBe(40);
    expect(result.duration).toBeGreaterThanOrEqual(3.9);
  }, 30_000);
  it("retains all frames and duration when the provider resets timestamps mid-stream", async () => {
    const result = await recording("timestamps");
    expect(result.frames).toBe(40);
    expect(result.duration).toBeGreaterThanOrEqual(3.9);
  }, 20_000);
});
