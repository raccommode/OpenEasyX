import { describe, expect, it } from "vitest";
import { ffmpegHlsRetryArgs, liveStreamFromInfo, ytDlpDownload } from "./yt-dlp-utils.js";

describe("live stream selection", () => {
  it("keeps separate live video and audio tracks when yt-dlp selected both formats", () => {
    const master = "https://cdn.test/master.m3u8?token=fresh";
    expect(liveStreamFromInfo({
      requested_formats: [
        { url: "https://cdn.test/video.m3u8", manifest_url: master, vcodec: "avc1", acodec: "none", height: 1080 },
        { url: "https://cdn.test/audio.m3u8", manifest_url: master, vcodec: "none", acodec: "aac" },
      ],
      formats: [{ url: "https://cdn.test/audio-low.m3u8", vcodec: "none", acodec: "aac" }],
      http_headers: { Referer: "https://live.test/" },
    }, "alice")).toEqual({
      url: "https://cdn.test/video.m3u8", audioUrl: "https://cdn.test/audio.m3u8",
      headers: { Referer: "https://live.test/" }, contentType: "application/vnd.apple.mpegurl",
    });
  });

  it("keeps the best muxed stream when no master manifest exists", () => {
    expect(liveStreamFromInfo({ formats: [
      { url: "https://cdn.test/360.mp4", vcodec: "h264", acodec: "aac", height: 360 },
      { url: "https://cdn.test/720.mp4", vcodec: "h264", acodec: "aac", height: 720 },
    ] }, "alice")).toEqual({ url: "https://cdn.test/720.mp4", headers: undefined, contentType: undefined });
  });
});

describe("live recording output", () => {
  it("asks FFmpeg to retry failed live segments when it supports that", () => {
    const request = ytDlpDownload({ externalId: "live:alice", mediaType: "video", pageUrl: "https://live.test/alice" }, {}, { live: true, hls: true });
    const retry = ffmpegHlsRetryArgs();
    expect(request.args).toContain(["ffmpeg_i:-rw_timeout 15000000", ...retry].join(" "));
  });

  it("does not pass HLS-specific options to live extractors with an unknown protocol", () => {
    expect(ytDlpDownload({ externalId: "live", mediaType: "video", pageUrl: "https://live.test/alice" }, {}, { live: true }).args.join(" ")).not.toContain("ffmpeg_i");
  });

  it("records the highest quality without a format sort when set to automatic", () => {
    const request = ytDlpDownload({ externalId: "live:alice", mediaType: "video", pageUrl: "https://live.test/alice" }, {}, { live: true, maxHeight: 0 });
    expect(request.args[request.args.indexOf("--format") + 1]).toBe("bestvideo+bestaudio/best");
    expect(request.args).not.toContain("--format-sort");
  });

  it("caps the native video resolution while retaining separate audio and captures both together", () => {
    const request = ytDlpDownload({ externalId: "live:alice", mediaType: "video", pageUrl: "https://live.test/alice" }, {}, { live: true, maxHeight: 720 });
    expect(request.args[request.args.indexOf("--format") + 1]).toBe("bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best");
    expect(request.args[request.args.indexOf("--format-sort") + 1]).toBe("res:720");
    expect(request.args).toEqual(expect.arrayContaining(["--downloader", "ffmpeg"]));
    expect(request.args).not.toContain("--recode-video");
  });

  it("leaves ordinary downloads unchanged when given live recording options", () => {
    const request = ytDlpDownload({ externalId: "video", mediaType: "video", pageUrl: "https://video.test/watch" }, {}, { maxHeight: 720 });
    expect(request.args.join(" ")).not.toContain("height<=");
    expect(request.args).not.toContain("--format-sort");
    expect(request.args).not.toContain("--downloader");
    expect(request.args).not.toContain("--force-ipv4");
  });

  it("stages live media in recoverable clusters for the final MP4", () => {
    const request = ytDlpDownload({ externalId: "live:alice", mediaType: "video", pageUrl: "https://live.test/alice", filename: "alice.mp4" }, {}, { live: true });
    expect(request.liveCaptureContainer).toBe("matroska");
    expect(request.filename).toBe("alice.mp4");
    expect(request.args).toContain("ffmpeg_o:-f matroska -cluster_time_limit 2000 -flush_packets 1");
  });
});
