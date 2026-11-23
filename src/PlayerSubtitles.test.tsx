import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlayerSubtitles, selectedSubtitleTrack, type SubtitleState } from "./PlayerSubtitles";

const track = { id: "manual-fr", language: "fr", label: "French", origin: "manual" as const, url: "/captions.vtt", updatedAt: "2026-01-01" };
const state: SubtitleState = { pluginEnabled: false, status: "disabled", tracks: [], progress: 0, error: "" };

function render(value: SubtitleState) {
  return renderToStaticMarkup(<PlayerSubtitles mediaId="video" state={value} selected="off" automatic={false} open toggle={vi.fn()} select={vi.fn()} update={vi.fn()} setNotice={vi.fn()}/>);
}

describe("optional player subtitles", () => {
  it("omits subtitle controls without the plugin or saved tracks", () => {
    expect(render(state)).toBe("");
  });

  it("keeps saved tracks selectable after uninstall", () => {
    const html = render({ ...state, tracks: [track], status: "error" });
    expect(html).toContain("French");
    expect(html).toContain("Hide subtitles");
    expect(html).not.toContain("Retry generation");
  });

  it("offers retry even when a failed translation already has an original track", () => {
    const original = { ...track, id: "original", origin: "original" as const };
    const html = render({ ...state, pluginEnabled: true, status: "error", tracks: [original], error: "Translation interrupted" });
    expect(html).toContain("Translation interrupted");
    expect(html).toContain("Retry generation");
  });

  it("shows automatic generation progress without a file picker", () => {
    const html = render({ ...state, pluginEnabled: true, status: "running", progress: 42 });
    expect(html).toContain("Generating subtitles · 42%");
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("Add VTT or SRT");
  });

  it("falls back for one video and honors the saved track again when it exists", () => {
    const original = { ...track, id: "original", language: "en", origin: "original" as const };
    const translated = { ...track, id: "fr", origin: "generated" as const };
    expect(selectedSubtitleTrack(track.id, [original])).toBe("original");
    expect(selectedSubtitleTrack(track.id, [original, translated])).toBe("fr");
    expect(selectedSubtitleTrack("fr", [original, track])).toBe(track.id);
    expect(selectedSubtitleTrack(track.id, [original, track])).toBe(track.id);
    expect(selectedSubtitleTrack("off", [original, track])).toBe("off");
  });

  it("automatically selects the first available target as translations arrive", () => {
    const original = { ...track, id: "original", language: "en", origin: "original" as const };
    const spanish = { ...track, id: "es", language: "es", origin: "generated" as const };
    const french = { ...track, id: "fr", origin: "generated" as const };
    const targets = ["fr", "es"];
    expect(selectedSubtitleTrack("auto", [], targets)).toBe("off");
    expect(selectedSubtitleTrack("auto", [original], targets)).toBe("original");
    expect(selectedSubtitleTrack("auto", [original, spanish], targets)).toBe("es");
    expect(selectedSubtitleTrack("auto", [original, spanish, track, french], targets)).toBe("fr");
    expect(selectedSubtitleTrack("auto", [original, french], ["en", "fr"])).toBe("original");
    expect(selectedSubtitleTrack("original", [original, french], targets)).toBe("original");
    expect(selectedSubtitleTrack("off", [original, french], targets)).toBe("off");
  });
});
