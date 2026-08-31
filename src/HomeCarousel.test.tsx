import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mediaDateLabel, mediaQualityLabel, RecentCarousel } from "./library-app";

describe("RecentCarousel", () => {
  it("puts the latest mixed media first with usable carousel controls", () => {
    const items = [
      { id: "photo", kind: "image", title: "Newest photo", performer: "Example", source: "local", thumbnailUrl: "/photo.jpg", favorite: false },
      { id: "video", kind: "video", title: "Newest video", performer: "Example", source: "local", thumbnailUrl: "/video.jpg", favorite: false },
    ] as never[];

    const html = renderToStaticMarkup(<RecentCarousel items={items} open={vi.fn()} favorite={vi.fn()}/>);

    expect(html).toContain("LATEST CONTENT");
    expect(html).toContain('class="home-carousel-image"');
    expect(html).toContain("Newest photo");
    expect(html).toContain("View photo");
    expect(html).toContain("Previous latest content");
    expect(html).toContain("Next latest content");
    expect(html).toContain("Show slide 2: Newest video");
  });

  it("formats media quality and dates for cards", () => {
    expect(mediaQualityLabel({ kind: "video", width: 1920, height: 1080, extension: ".mp4" })).toBe("1080p");
    expect(mediaQualityLabel({ kind: "image", width: 2400, height: 1600, extension: ".jpg" })).toBe("2400×1600");
    expect(mediaDateLabel("2026-08-31T12:00:00.000Z")).toBe("Aug 31, 2026");
  });
});
