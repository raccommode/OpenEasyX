import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveCamCard, LiveCamFavoriteButton, LiveCamRecordButton, LiveCamUnavailable, LivePlayer, liveCamListUrl, liveCamPresetFromSearch, liveCamUrl, shouldRecoverNativeLiveMediaError } from "./LiveCamPage";

describe("Live Cam availability", () => {
  it("explains that a live source plugin is needed instead of presenting a broken empty grid", () => {
    const html = renderToStaticMarkup(<LiveCamUnavailable reason="Live Cam works only with Open EasyX."/>);
    expect(html).toContain("No live-cam plugin is ready");
    expect(html).toContain("Plugins → Sources &amp; live");
  });

  it("uses the custom video controls for live streams", () => {
    const html = renderToStaticMarkup(<LivePlayer cam={{ id: "alice", username: "alice", pageUrl: "https://example.test/alice", providerId: "test", providerName: "Test Live" }} close={() => {}}/>);
    expect(html).toContain("custom-player live-custom-player");
    expect(html).toContain("ON AIR");
    expect(html).not.toContain("controls=\"\"");
    expect(html).not.toContain("Autoplay");
    expect(html).not.toContain("Subtitles");
  });

  it("creates shareable URLs for filters and individual live cams", () => {
    expect(liveCamListUrl({ query: "alice", providerId: "test.live", gender: "female", favoritesOnly: true, page: 3 }))
      .toBe("/live-cam?q=alice&source=test.live&gender=female&favorites=1&page=3");
    expect(liveCamPresetFromSearch("?q=alice&source=test.live&gender=female&favorites=1&page=3"))
      .toEqual({ query: "alice", providerId: "test.live", gender: "female", favoritesOnly: true, page: 3 });
    expect(liveCamUrl({ providerId: "test.live", id: "alice/bob" })).toBe("/live-cam/test.live/alice%2Fbob");
  });

  it("offers direct recording from a live room", () => {
    const html = renderToStaticMarkup(<LiveCamRecordButton cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live" }}/>);
    expect(html).toContain("Record live");
  });

  it("offers a persistent creator favorite action", () => {
    const html = renderToStaticMarkup(<LiveCamFavoriteButton cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live", favorite: true }}/>);
    expect(html).toContain("Favorited"); expect(html).toContain('aria-pressed="true"');
  });

  it("renders offline favorite cams separately without opening the player", () => {
    const html = renderToStaticMarkup(<LiveCamCard cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live", favorite: true, online: false }} open={() => {}}/>);
    expect(html).toContain("OFFLINE"); expect(html).toContain('aria-disabled="true"'); expect(html).toContain("Not broadcasting right now");
    expect(html).not.toContain('href="/live-cam/');
  });

  it("recovers Safari media error 4 after a tab suspension without hiding real playback errors", () => {
    expect(shouldRecoverNativeLiveMediaError(4, true, 0, 10_000)).toBe(true);
    expect(shouldRecoverNativeLiveMediaError(4, false, 9_000, 10_000)).toBe(true);
    expect(shouldRecoverNativeLiveMediaError(4, false, 1_000, 10_000)).toBe(false);
    expect(shouldRecoverNativeLiveMediaError(3, true, 0, 10_000)).toBe(false);
  });
});
