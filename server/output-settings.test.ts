import { describe, expect, it } from "vitest";
import { outputDefaults, renderOutputPath } from "../packages/output-settings.js";
import { downloadOutputPath, recordingEncodingArgs, settingsSchema } from "./output-settings.js";
import type { DownloadItem } from "./database.js";

const item = { id: "item_123", mediaType: "video", title: "A title", createdAt: "2026-09-03T20:30:15Z", metadata: {} } as DownloadItem;
describe("output settings", () => {
  it("keeps the existing performer/site/original-name default", () => {
    expect(downloadOutputPath({}, item, "Alice", "stripchat.com", "recording.mp4")).toBe("Alice/stripchat.com/recording.mp4");
  });
  it("supports model-only folders, site variables in filenames, dates and arbitrary subfolders", () => {
    expect(downloadOutputPath({ outputPathTemplate: "{performer}", outputFilenameTemplate: "{site}-{date}-{time}-{title}" }, item, "Alice", "stripchat.com", "recording.mp4")).toBe("Alice/stripchat.com-2026-09-03-20-30-15-A title.mp4");
    expect(downloadOutputPath({ outputPathTemplate: "{year}/{month}/{performer}" }, item, "Alice", "site", "photo.jpg")).toBe("2026/09/Alice/photo.jpg");
    expect(downloadOutputPath({ outputPathTemplate: "" }, item, "Alice", "site", "photo.jpg")).toBe("photo.jpg");
  });
  it.each(["../outside", "/absolute", "x/../../x", ".downloads", "{performer}/.downloads", "x\\y", "{unknown}", "{{site}", "x//y", "x/", "C:/data"])("rejects unsafe folder template %s", (outputPathTemplate) => {
    expect(settingsSchema.safeParse({ outputPathTemplate }).success).toBe(false);
  });
  it("sanitizes token values without letting external names create directories", () => {
    expect(downloadOutputPath({}, item, "../../Alice", "../source", "a.mp4")).toBe("Alice/source/a.mp4");
    expect(settingsSchema.safeParse({ outputFilenameTemplate: "folder/{filename}" }).success).toBe(false);
    expect(settingsSchema.safeParse({ outputFilenameTemplate: "" }).success).toBe(false);
    expect(settingsSchema.safeParse({ recordingPreset: "arbitrary-shell-command" }).success).toBe(false);
  });
  it("preserves media extensions and uses MP4 only for re-encoded live videos", () => {
    const settings = { recordingPreset: "h264-small" };
    expect(downloadOutputPath(settings, item, "Alice", "site", "video.webm")).toBe("Alice/site/video.webm");
    expect(downloadOutputPath(settings, { ...item, metadata: { live: true } }, "Alice", "site", "video.webm")).toBe("Alice/site/video.mp4");
    expect(downloadOutputPath(settings, { ...item, mediaType: "image", metadata: { live: true } }, "Alice", "site", "photo.webp")).toBe("Alice/site/photo.webp");
  });
  it("never runs encoding for the source preset", () => {
    expect(recordingEncodingArgs("source", "in", "out")).toEqual([]);
    expect(recordingEncodingArgs("h264-high", "in", "out")).toContain("libx264");
    expect(recordingEncodingArgs("h265", "in", "out")).toContain("libx265");
  });
});
