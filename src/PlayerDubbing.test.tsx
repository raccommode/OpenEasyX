import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dubbingStreamUrl, readyDub, PlayerDubbing } from "./PlayerDubbing";

const controls = { selected: "", busy: false, open: true, select: vi.fn(), toggle: vi.fn() };

describe("library audio versions", () => {
  it("uses the compatible original when switching back and retains stream parameters", () => {
    expect(dubbingStreamUrl("/stream?token=abc", "fr", true)).toBe("/stream?token=abc&dub=fr");
    expect(dubbingStreamUrl("/stream?token=abc", "", true)).toBe("/stream?token=abc&compatible=1");
    expect(dubbingStreamUrl("https://nas.test/stream", "de", false)).toBe("https://nas.test/stream?dub=de");
    expect(dubbingStreamUrl("/stream", "fr", false, "rev2")).toBe("/stream?dub=fr&v=rev2");
  });

  it("restores only a ready version of the chosen language, including one being updated", () => {
    const ready = { code: "fr", label: "French", status: "ready" as const, playbackVersion: "revision", updateStatus: "running" as const, progress: 40 };
    const pending = { ...ready, code: "es", status: "running" as const };
    const state = { installed: true, variants: [pending, ready] };
    expect(readyDub(undefined, "fr")).toBeUndefined();
    expect(readyDub(state, "es")).toBeUndefined();
    expect(readyDub(state, "")).toBeUndefined();
    expect(readyDub(state, "FR")).toEqual(ready);
  });

  it("keeps a published update playable and distinguishes detected lip movement from audio-only output", () => {
    const html = renderToStaticMarkup(<PlayerDubbing {...controls} state={{ installed: true, variants: [
      { code: "fr", label: "French", status: "ready", updateStatus: "running", progress: 34, lipSyncFrames: 0 },
      { code: "es", label: "Spanish", status: "ready", progress: 100, lipSyncFrames: 124 },
    ] }}/>);
    expect(html).toContain("Dubbed audio only · Updating 34%");
    expect(html).toContain("Dubbed audio with lip sync");
    expect(html).not.toContain("disabled");
  });

  it("shows original audio and only permits completed versions", () => {
    const html = renderToStaticMarkup(<PlayerDubbing {...controls} state={{ installed: true, variants: [
      { code: "en", label: "English", status: "original", progress: 100 },
      { code: "fr", label: "French", status: "ready", progress: 100 },
      { code: "de", label: "German", status: "running", phase: "Rendering", progress: 34 },
    ] }}/>);
    expect(html).toContain("Original audio<small>English");
    expect(html).toContain("French<small>Dubbed audio");
    expect(html).toMatch(/disabled=""[^>]*><span>German<small>Rendering · 34%/);
    expect(renderToStaticMarkup(<PlayerDubbing {...controls} state={{ installed: false, variants: [] }}/>)).toBe("");
    const saved = renderToStaticMarkup(<PlayerDubbing {...controls} state={{ installed: false, variants: [{ code: "fr", label: "French", status: "ready", progress: 100 }] }}/>);
    expect(saved).toContain("French<small>Dubbed audio");
  });
});
