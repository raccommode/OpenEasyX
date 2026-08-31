import { describe, expect, it, vi } from "vitest";
import { loadPlayerAudio, savePlayerAudio } from "./player-audio";

describe("player audio preferences", () => {
  it("restores a saved volume and mute state", () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ volume: 0.35, muted: true })) };
    expect(loadPlayerAudio(storage)).toEqual({ volume: 0.35, muted: true });
  });

  it("uses safe defaults and clamps invalid stored volume values", () => {
    expect(loadPlayerAudio({ getItem: () => "not-json" })).toEqual({ volume: 1, muted: false });
    expect(loadPlayerAudio({ getItem: () => JSON.stringify({ volume: 4, muted: false }) })).toEqual({ volume: 1, muted: false });
    expect(loadPlayerAudio({ getItem: () => null }, { volume: 1, muted: true })).toEqual({ volume: 1, muted: true });
  });

  it("persists audio preferences under the shared player key", () => {
    const storage = { setItem: vi.fn() };
    savePlayerAudio({ volume: 0.6, muted: false }, storage);
    expect(storage.setItem).toHaveBeenCalledWith("open-easyx.player-audio", JSON.stringify({ volume: 0.6, muted: false }));
  });
});
