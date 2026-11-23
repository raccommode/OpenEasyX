import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerViewer } from "./Player";

const photo = {
  id: "photo-1", relativePath: "Performer/local/photo.jpg", kind: "image" as const, title: "Photo one", performer: "Performer", source: "local",
  extension: ".jpg", mimeType: "image/jpeg", size: 1024, modifiedAt: "2026-01-01", duration: 0, width: 1200, height: 800,
  favorite: false, progressSeconds: 0, completed: false, viewCount: 0, thumbnailUrl: "/thumbnail", previewUrl: "", streamUrl: "/stream",
};
const video = {
  ...photo,
  id: "video-1", relativePath: "Performer/local/video.mp4", kind: "video" as const, title: "Video one",
  extension: ".mp4", mimeType: "video/mp4", duration: 30, width: 1920, height: 1080, streamUrl: "/video-stream",
};

function renderPhoto(autoStart: boolean, stored = "true") {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => key === "open-easyx.autoplay" ? stored : null,
    setItem: vi.fn(),
  });
  return renderToStaticMarkup(<PlayerViewer media={photo} context={{ ids: ["photo-1", "video-1"] }} autoStart={autoStart} close={vi.fn()} favorite={vi.fn()} advance={vi.fn()} setNotice={vi.fn()}/>);
}

afterEach(() => vi.unstubAllGlobals());

describe("photo player", () => {
  it("shows autoplay off when a photo was opened manually", () => {
    const html = renderPhoto(false);
    expect(html).toContain("Autoplay is off");
    expect(html).toContain('aria-pressed="false"');
  });

  it("keeps autoplay enabled while a photo reached from the previous item loads", () => {
    const html = renderPhoto(true);
    expect(html).toContain("Loading photo…");
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("video player", () => {
  it("asks the browser to autoplay a video reached from the previous item", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    const html = renderToStaticMarkup(<PlayerViewer media={video} context={{ ids: ["photo-1", "video-1"] }} autoStart close={vi.fn()} favorite={vi.fn()} advance={vi.fn()} setNotice={vi.fn()}/>);
    expect(html).toContain('autoPlay=""');
  });

  it("does not autoplay when the caller explicitly disables autostart", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    const html = renderToStaticMarkup(<PlayerViewer media={video} context={{ ids: ["video-1"] }} close={vi.fn()} favorite={vi.fn()} advance={vi.fn()} setNotice={vi.fn()}/>);
    expect(html).not.toContain('autoPlay=""');
  });
});

describe("delete from the player", () => {
  it("offers a delete action when the library allows it", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    const html = renderToStaticMarkup(<PlayerViewer media={video} context={{ ids: ["video-1"] }} close={vi.fn()} favorite={vi.fn()} advance={vi.fn()} setNotice={vi.fn()} remove={vi.fn()}/>);
    expect(html).toContain("watch-delete");
    expect(html).toContain(">Delete</button>");
  });

  it("hides the delete action when no delete handler is given", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    const html = renderToStaticMarkup(<PlayerViewer media={video} context={{ ids: ["video-1"] }} close={vi.fn()} favorite={vi.fn()} advance={vi.fn()} setNotice={vi.fn()}/>);
    expect(html).not.toContain("watch-delete");
  });
});

describe("video player gestures and casting", () => {
  it("renders the gesture surface and a cast button", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    const html = renderToStaticMarkup(<PlayerViewer media={video} context={{ ids: ["video-1"] }} close={vi.fn()} favorite={vi.fn()} advance={vi.fn()} setNotice={vi.fn()}/>);
    expect(html).toContain('class="player-surface"');
    expect(html).toContain('aria-label="Cast to a TV"');
    expect(html).toContain('aria-label="Mute"');
    expect(html).toContain('aria-label="Volume"');
    expect(html).not.toContain("player-zoom-reset");
  });
});
