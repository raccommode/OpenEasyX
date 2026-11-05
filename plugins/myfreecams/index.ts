import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";
import { browserCapturedLiveStream } from "../browser-html-utils.js";
import type { LiveCam } from "../../packages/plugin-sdk/index.js";

export function myfreecamsRoom(value: string): LiveCam {
  const url = new URL(value);
  if (!["mfc.im", "myfreecams.com", "www.myfreecams.com"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid MyFreeCams room URL");
  const username = decodeURIComponent(url.hash.slice(1) || url.pathname.split("/").filter(Boolean)[0] || "");
  if (!/^[a-z0-9_]+$/i.test(username)) throw new Error("A MyFreeCams room name is required");
  return { id: username.toLowerCase(), username, pageUrl: `https://www.myfreecams.com/#${username}` };
}

const plugin = createLiveCamPlugin({
  id: "org.easyx.myfreecams", name: "MyFreeCams Live", prefix: "myfreecams", homepage: "https://www.myfreecams.com",
  discovery: "myfreecams",
  description: "Check a public MyFreeCams room and use any HTTP live stream exposed to the configured browser session.",
  sourceUrlPatterns: ["http://myfreecams.com/*", "https://myfreecams.com/*", "http://www.myfreecams.com/*", "https://www.myfreecams.com/*", "http://mfc.im/*", "https://mfc.im/*"],
  cookieDomains: ["myfreecams.com", "mfc.im"], loginUrl: "https://www.myfreecams.com/", defaultIntervalSeconds: 15,
});

// yt-dlp has no extractor for MFC room pages. Use the same browser capture for
// discovery, playback and recording; never send the room redirect back to yt-dlp.
export default {
  ...plugin,
  async listMedia(context, source) {
    const cam = myfreecamsRoom(source.profileUrl);
    await browserCapturedLiveStream(context, cam.pageUrl);
    return [{ externalId: `myfreecams:${cam.id}:live`, title: `${cam.username} live`, pageUrl: cam.pageUrl,
      mediaType: "video", filename: `${cam.username}-live.mp4`, metadata: { live: true } }];
  },
  async resolveLiveStream(context, cam) { return browserCapturedLiveStream(context, myfreecamsRoom(cam.pageUrl).pageUrl); },
  async resolveDownload(context, item) {
    const cam = myfreecamsRoom(item.pageUrl ?? "");
    // Resolve immediately before recording: signed media URLs must not be saved in the queue.
    const stream = await browserCapturedLiveStream(context, cam.pageUrl);
    const hls = stream.contentType === "application/vnd.apple.mpegurl";
    const help = hls ? await context.runCommand("ffmpeg", ["-hide_banner", "-h", "demuxer=hls"], { timeoutMs: 10_000 }) : undefined;
    // MFC serves fragmented MP4 under .pts URLs. Recent FFmpeg rejects that
    // extension unless it is explicitly allowed for this provider.
    const extensions = "m3u8,ts,mp4,m4s,pts,aac";
    const hlsArgs = hls ? ["-allowed_extensions", extensions,
      ...(help?.stdout.includes("allowed_segment_extensions") ? ["-allowed_segment_extensions", extensions] : []),
      ...(help?.stdout.includes("extension_picky") ? ["-extension_picky", "0"] : [])] : [];
    const headers = Object.entries(stream.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\r\n") + "\r\n";
    return { kind: "command", command: "ffmpeg", filename: item.filename ?? `${cam.username}-live.mp4`,
      args: ["-nostdin", "-hide_banner", "-loglevel", "warning", "-rw_timeout", "15000000", ...hlsArgs, "-headers", headers,
        "-i", stream.url, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", "{output}"] };
  },
} satisfies typeof plugin;
