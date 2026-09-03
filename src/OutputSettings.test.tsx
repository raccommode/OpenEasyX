import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutputSettings } from "./OutputSettings";

describe("output settings form", () => {
  it("shows editable templates, a matching preview and all recording presets", () => {
    const html = renderToStaticMarkup(<OutputSettings settings={{ mediaRoot: "/media", outputPathTemplate: "{performer}", outputFilenameTemplate: "{site}-{filename}" }} setNotice={() => {}} onSaved={() => {}}/>);
    expect(html).toContain('aria-label="Folder template"');
    expect(html).toContain('aria-label="Filename template"');
    expect(html).toContain("Alice/stripchat.com-live-session.mp4");
    for (const value of ["source", "h264-high", "h264-small", "h265"]) expect(html).toContain(`value="${value}"`);
    expect(html).toContain("Existing files are not moved or renamed");
  });
});
