import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dubbingStreamUrl, PlayerDubbing } from "./PlayerDubbing";

const controls = { selected: "", busy: false, open: true, select: vi.fn(), toggle: vi.fn() };

describe("library audio versions", () => {
  it("uses the compatible original when switching back and retains stream parameters", () => {
    expect(dubbingStreamUrl("/stream?token=abc", "fr", true)).toBe("/stream?token=abc&dub=fr");
    expect(dubbingStreamUrl("/stream?token=abc", "", true)).toBe("/stream?token=abc&compatible=1");
    expect(dubbingStreamUrl("https://nas.test/stream", "de", false)).toBe("https://nas.test/stream?dub=de");
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
