import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppChrome } from "./AppChrome";

describe("AppChrome", () => {
  it("renders the shared header and sidebar around page content", () => {
    const html = renderToStaticMarkup(<AppChrome title="Plugins" onScanLibrary={() => undefined}><div>Page content</div></AppChrome>);

    expect(html).toContain("Open EasyX");
    expect(html).toContain("ONE PRIVATE SUITE");
    expect(html).toContain("Private by design");
    expect(html).toContain("Plugins");
    expect(html).toContain("Scan library");
    expect(html).toContain("Scan discover");
    expect(html).not.toContain("Browse media");
    expect(html).not.toContain("Find a performer");
    expect(html).toContain("Page content");
  });
});
