import { describe, expect, it, vi } from "vitest";
import plugin, { myfreecamsRoom } from "./index.js";

describe("MyFreeCams capture", () => {
  it.each(["https://mfc.im/Alice/chat", "https://www.myfreecams.com/#Alice", "https://myfreecams.com/Alice"])("normalizes %s", (url) => {
    expect(myfreecamsRoom(url)).toMatchObject({ username: "Alice", pageUrl: "https://www.myfreecams.com/#Alice" });
  });
  it("records the browser's media URL instead of the unsupported room URL", async () => {
    const runCommand = vi.fn(async (_command: string) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ url: "https://cdn.test/live.m3u8", cookie: "sid=test" }) }));
    const context = { config: {}, fetch, runCommand, log: vi.fn() };
    const items = await plugin.listMedia!(context, { id: "source", externalId: "Alice", performerId: "person", profileUrl: "https://mfc.im/Alice/chat", domain: "mfc.im" });
    const request = await plugin.resolveDownload!(context, items[0]);
    expect(request).toMatchObject({ kind: "command", command: "ffmpeg", args: expect.arrayContaining(["-i", "https://cdn.test/live.m3u8", "-allowed_extensions", "m3u8,ts,mp4,m4s,pts,aac"]) });
    expect(runCommand.mock.calls.every((call) => call[0] === "easyx-browser-fetch" || call[0] === "ffmpeg")).toBe(true);
  });
});
