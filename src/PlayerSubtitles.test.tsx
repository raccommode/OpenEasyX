import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlayerSubtitles, selectedSubtitleTrack, type SubtitleState } from "./PlayerSubtitles";

const track = { id: "manual-fr", language: "fr", label: "French", origin: "manual" as const, url: "/captions.vtt", updatedAt: "2026-01-01" };
const state: SubtitleState = { pluginEnabled: false, status: "disabled", tracks: [], progress: 0, error: "", languages: [] };

function render(value: SubtitleState) {
  return renderToStaticMarkup(<PlayerSubtitles mediaId="video" state={value} selected="off" open toggle={vi.fn()} select={vi.fn()} update={vi.fn()} setNotice={vi.fn()}/>);
}

describe("optional player subtitles", () => {
  it("omits subtitle controls without the plugin or saved tracks", () => {
    expect(render(state)).toBe("");
  });

  it("keeps saved tracks selectable after uninstall and removes generation and import controls", () => {
    const html = render({ ...state, tracks: [track], status: "error" });
    expect(html).toContain("French");
    expect(html).toContain("Hide subtitles");
    expect(html).not.toContain("Retry generation");
    expect(html).not.toContain("Add VTT or SRT");
  });

  it("offers retry even when a failed translation already has an original track", () => {
    const html = render({ ...state, pluginEnabled: true, status: "error", tracks: [track], error: "Translation interrupted", languages: [{ code: "fr", label: "French" }] });
    expect(html).toContain("Translation interrupted");
    expect(html).toContain("Retry generation");
    expect(html).toContain("Add VTT or SRT");
    expect(html).toContain('<option value="fr" selected="">');
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
});
