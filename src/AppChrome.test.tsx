import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppChrome, operationLabel } from "./AppChrome";

describe("AppChrome", () => {
  it("renders the shared header and sidebar around page content", () => {
    const html = renderToStaticMarkup(<AppChrome title="Plugins" onScanLibrary={() => undefined} onRefreshPerformers={() => undefined}><div>Page content</div></AppChrome>);

    expect(html).toContain("Open EasyX");
    expect(html).toContain("ONE PRIVATE SUITE");
    expect(html).toContain("Private by design");
    expect(html).toContain("v...");
    expect(html).toContain("Plugins");
    expect(html).toContain("Scan library");
    expect(html).toContain("Refresh performers");
    expect(html).not.toContain("Browse media");
    expect(html).not.toContain("Find a performer");
    expect(html).toContain("Page content");
  });

  it("formats live operation percentages for the header", () => {
    expect(operationLabel("Scan library", { running: true, percent: 41.6 })).toBe("Scan library · 42%");
    expect(operationLabel("Refresh performers", { running: false, percent: 80 })).toBe("Refresh performers");
  });
});
