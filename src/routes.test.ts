import { describe, expect, it } from "vitest";
import { canonicalEntryPath, pageFromPath, pagePath } from "./routes.js";

describe("application routes", () => {
  it.each([
    ["dashboard", "/overview"], ["library", "/performers"],
    ["activity", "/activity"], ["logs", "/logs"], ["plugins", "/plugins"], ["settings", "/settings"],
  ] as const)("maps %s to %s", (page, path) => {
    expect(pagePath(page)).toBe(path);
    expect(pageFromPath(path)).toBe(page);
  });

  it("accepts a trailing slash and sends unknown paths to overview", () => {
    expect(pageFromPath("/plugins/")).toBe("plugins");
    expect(pageFromPath("/not-a-page")).toBe("dashboard");
    expect(pageFromPath("/")).toBe("dashboard");
  });

  it("sends the legacy overview entry to Home", () => {
    expect(canonicalEntryPath("/")).toBe("/media");
    expect(canonicalEntryPath("/overview")).toBe("/media");
    expect(canonicalEntryPath("/overview/")).toBe("/media");
    expect(canonicalEntryPath("/discover")).toBe("/performers");
    expect(canonicalEntryPath("/plugins")).toBe("/plugins");
  });
});
