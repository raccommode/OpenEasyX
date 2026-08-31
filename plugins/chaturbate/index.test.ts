import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
import chaturbate, { chaturbateLiveCam, chaturbateLiveCamPage, chaturbateLiveCandidate, normalizedChaturbateUrl } from "./index.js";
import { ytDlpDownload } from "../yt-dlp-utils.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function accountContext(fetchImpl: typeof fetch, cookieLines = ".chaturbate.com\tTRUE\t/\tTRUE\t0\tsessionid\taccount-session\n.chaturbate.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tcsrf-token"): PluginContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-chaturbate-")); temporaryDirectories.push(directory);
  const cookiesFile = path.join(directory, "cookies.txt");
  fs.writeFileSync(cookiesFile, `# Netscape HTTP Cookie File\n${cookieLines}\n`);
  return { config: { cookiesFile }, fetch: fetchImpl, runCommand: vi.fn(), log: vi.fn() };
}

describe("Chaturbate plugin", () => {
  it("creates one stable candidate for an active live session", () => {
    expect(chaturbateLiveCandidate({ id: "model", title: "Model live", is_live: true, timestamp: 1_700_000_000, formats: [{ url: "https://cdn.example/live.m3u8" }] }, "https://chaturbate.com/model/"))
      .toMatchObject({ externalId: "chaturbate:model:1700000000", mediaType: "video", filename: "model-1700000000.mp4" });
  });

  it("returns no candidate while the room is offline", () => {
    expect(chaturbateLiveCandidate({ id: "model", live_status: "not_live" }, "https://chaturbate.com/model/")).toBeUndefined();
  });

  it("keeps a session stable when only signed stream parameters rotate", () => {
    const first = chaturbateLiveCandidate({ id: "model", is_live: true, formats: [{ url: "https://cdn.example/v1/edge/streams/origin.model.SESSION/chunklist.m3u8?token=one" }] }, "https://chaturbate.com/model/");
    const refreshed = chaturbateLiveCandidate({ id: "model", is_live: true, formats: [{ url: "https://cdn.example/v1/edge/streams/origin.model.SESSION/chunklist.m3u8?token=two" }] }, "https://chaturbate.com/model/");
    const nextLive = chaturbateLiveCandidate({ id: "model", is_live: true, formats: [{ url: "https://cdn.example/v1/edge/streams/origin.model.NEXT/chunklist.m3u8?token=three" }] }, "https://chaturbate.com/model/");
    expect(refreshed?.externalId).toBe(first?.externalId);
    expect(nextLive?.externalId).not.toBe(first?.externalId);
  });

  it("normalizes room casing and selects the live-compatible format", () => {
    expect(normalizedChaturbateUrl("https://chaturbate.com/CherryCrush/")).toBe("https://chaturbate.com/cherrycrush/");
    const request = ytDlpDownload({ externalId: "live", pageUrl: "https://chaturbate.com/cherrycrush/", mediaType: "video" }, {}, { live: true });
    expect(request.args[request.args.indexOf("--format") + 1]).toBe("bestvideo+bestaudio/best");
    expect(request.args).toContain("--no-hls-use-mpegts");
  });

  it("normalizes public room-list entries for the Viewer live aggregation", () => {
    expect(chaturbateLiveCam({ username: "alice", current_show: "public", num_users: 42, tags: ["french", "chat"], img: "//images.example/alice.jpg", age: 24 }))
      .toMatchObject({ id: "alice", username: "alice", viewers: 42, age: 24, thumbnailUrl: "https://images.example/alice.jpg" });
    expect(chaturbateLiveCam({ username: "private_room", current_show: "private" })).toBeUndefined();
    expect(chaturbateLiveCamPage({ rooms: [{ username: "alice" }, { username: "bob" }], total_count: 51 }, 2, 24))
      .toMatchObject({ total: 51, page: 2, pageSize: 24, pages: 3, cams: [{ username: "alice" }, { username: "bob" }] });
  });

  it("applies text search to the provider result and reports the filtered count", async () => {
    const fetch = async () => new Response(JSON.stringify({
      rooms: [{ username: "alice", room_subject: "French chat", tags: ["friendly"] }, { username: "bob", room_subject: "Music" }], total_count: 2,
    }), { status: 200 });
    const page = await chaturbate.listLiveCams!({ fetch } as never, { page: 1, pageSize: 24, search: "alice" });
    expect(page).toMatchObject({ total: 1, cams: [{ username: "alice" }] });
  });

  it("loads both online and offline followed creators from a connected account", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      const offline = url.includes("offline=true");
      return new Response(JSON.stringify({
        rooms: [{ username: offline ? "offline_model" : "online_model", current_show: offline ? "offline" : "public", is_following: true }],
        total_count: 1,
      }), { status: 200 });
    });
    const result = await chaturbate.listFollowedLiveCams!(accountContext(fetchMock as typeof fetch));
    expect(result).toMatchObject({ authoritative: true, cams: [{ username: "online_model" }, { username: "offline_model", viewers: 0 }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ cookie: expect.stringContaining("sessionid=account-session") });
  });

  it("rejects a captured browser session that is not actually signed in", async () => {
    const context = accountContext(fetch, ".chaturbate.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tcsrf-token");
    context.runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "2026.08.19\n", stderr: "" }));
    await expect(chaturbate.testConnection!(context)).resolves.toEqual({
      ok: false, message: "The Chaturbate session is missing or expired. Reconnect the account in the integrated browser.",
    });
  });

  it("verifies the authenticated Chaturbate API before accepting a captured session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
    const context = accountContext(fetchMock as typeof fetch, ".chaturbate.com\tTRUE\t/\tTRUE\t0\tsessionid\tverified-session");
    context.runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "2026.08.19\n", stderr: "" }));
    await expect(chaturbate.testConnection!(context)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("account session verified") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to replace favorites when Chaturbate ignores the followed-only filter", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rooms: [{ username: "public_model", is_following: false }], total_count: 1 }), { status: 200 }));
    await expect(chaturbate.listFollowedLiveCams!(accountContext(fetchMock as typeof fetch))).resolves.toMatchObject({
      authoritative: false, cams: [], skippedReason: "Chaturbate ignored the followed-only filter",
    });
  });

  it("advances followed pagination by the raw Chaturbate result window", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("pm_users")) return new Response(JSON.stringify({ users: [] }), { status: 200 });
      if (!url.searchParams.has("offline")) return new Response(JSON.stringify({ rooms: [], total_count: 0 }), { status: 200 });
      const offset = Number(url.searchParams.get("offset"));
      return new Response(JSON.stringify({
        rooms: [{ username: offset === 0 ? "first_offline" : "last_offline", is_following: true }], total_count: 122,
      }), { status: 200 });
    });
    const result = await chaturbate.listFollowedLiveCams!(accountContext(fetchMock as typeof fetch));
    expect(result).toMatchObject({ authoritative: true, cams: [{ username: "first_offline" }, { username: "last_offline" }] });
    const requestedOffsets = fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes("offline=true")).map((url) => new URL(url).searchParams.get("offset"));
    expect(requestedOffsets).toEqual(["0", "90"]);
  });

  it("mirrors favorite changes to Chaturbate and verifies the remote result", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("chatvideocontext")) return new Response(JSON.stringify({ following: true }), { status: 200 });
      return new Response("", { status: 200 });
    });
    const result = await chaturbate.setLiveCamFavorite!(accountContext(fetchMock as typeof fetch), {
      id: "alice", username: "alice", pageUrl: "https://chaturbate.com/alice/",
    }, true);
    expect(result).toEqual({ synchronized: true });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://chaturbate.com/alice/",
      "https://chaturbate.com/follow/follow/alice/",
      "https://chaturbate.com/api/chatvideocontext/alice/",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", headers: expect.objectContaining({ "x-csrftoken": "csrf-token" }) });
  });
});
