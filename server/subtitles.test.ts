import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeManualSubtitle } from "./subtitles";

describe("subtitle files", () => {
  it("stores a validated manual track in the persistent subtitle directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-subtitle-"));
    const result = writeManualSubtitle(root, "media123", "fr", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nBonjour");
    expect(result.trackId).toBe("manual-fr");
    expect(fs.readFileSync(result.destination, "utf8")).toContain("Bonjour");
  });
});
