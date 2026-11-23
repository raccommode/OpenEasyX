import { describe, expect, it } from "vitest";
import { normalizeSubtitleContent } from "./import.js";

describe("subtitle plugin imports", () => {
  it("converts SRT cue times to WebVTT without changing punctuation in the subtitle text", () => {
    expect(normalizeSubtitleContent("\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nHello, world.\r\n")).toBe(
      "WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.500\nHello, world.\n",
    );
  });

  it("keeps WebVTT headers, cue identifiers, notes and positioning", () => {
    const content = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\nNOTE intro\n\none\n00:01.250 --> 00:03.500 align:start\nHello\nworld\n";
    expect(normalizeSubtitleContent(content)).toBe(content);
  });

  it.each(["WEBVTT", "WEBVTT\n\nNOTE no dialogue", "WEBVTT\n\nnot a cue", "1\n00:03.000 --> 00:01.000\nHello", "1\n00:01.000 --> 00:03.000"])(
    "rejects empty or malformed subtitle content", (content) => expect(() => normalizeSubtitleContent(content)).toThrow(),
  );
});
