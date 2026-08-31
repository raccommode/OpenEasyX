import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecentCarousel } from "./library-app";

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
});
