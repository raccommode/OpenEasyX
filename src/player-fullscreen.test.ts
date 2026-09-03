import { describe, expect, it, vi } from "vitest";
import { enterPlayerFullscreen } from "./player-fullscreen";

describe("cross-browser player fullscreen", () => {
  it("requests native element fullscreen directly from the user gesture", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const result = enterPlayerFullscreen({ requestFullscreen } as unknown as HTMLElement);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe("native");
  });
  it("uses Safari element fullscreen when available", async () => {
    const webkitRequestFullscreen = vi.fn();
    await expect(enterPlayerFullscreen({ webkitRequestFullscreen } as unknown as HTMLElement)).resolves.toBe("native");
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
  });
  it("uses iPhone native video fullscreen when element fullscreen is unavailable", async () => {
    const webkitEnterFullscreen = vi.fn();
    await expect(enterPlayerFullscreen({} as HTMLElement, { webkitEnterFullscreen } as unknown as HTMLVideoElement)).resolves.toBe("native");
    expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
  });
  it("falls back to full-window playback after a rejected browser request", async () => {
    await expect(enterPlayerFullscreen({ requestFullscreen: () => Promise.reject(new Error("Not allowed")) } as unknown as HTMLElement)).resolves.toBe("page");
    await expect(enterPlayerFullscreen({} as HTMLElement)).resolves.toBe("page");
  });
  it("handles an unready iPhone video without an unhandled rejection", async () => {
    await expect(enterPlayerFullscreen({} as HTMLElement, { webkitEnterFullscreen() { throw new Error("Video not ready"); } } as unknown as HTMLVideoElement)).resolves.toBe("page");
  });
});
