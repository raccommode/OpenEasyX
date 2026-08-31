import { describe, expect, it, vi } from "vitest";
import {
  bongacamsLiveCams, cam4LiveCams, camsLiveCams, camsodaLiveCams, listDiscoveredLiveCams,
  livejasminLiveCams, myfreecamsExplorerLiveCams, myfreecamsLiveCams, stripchatLiveCams, stripchatProfileLiveCams, stripchatStreamConfig, twitchLiveCams, xcamsLiveCams,
} from "./live-cam-discovery.js";

const bongaFixture = `<script id="listingConfiguration" type="application/json">${JSON.stringify({ stateData: { models: [
  { username: "Alice", display_name: "Alice A", room: "public", viewers: 42, gender: "female", thumb_image: "//img.example/alice.{ext}", thumbTags: ["chat"] },
  { username: "Private", room: "private", viewers: 99 }, { username: "Bob", room: "public", viewers: 7, gender: "male" },
] } })}</script>`;

describe("public live-cam discovery parsers", () => {
  it("reads only public BongaCams rooms", () => {
    expect(bongacamsLiveCams(bongaFixture)).toEqual([
      expect.objectContaining({ username: "Alice", viewers: 42, gender: "female", thumbnailUrl: "https://img.example/alice.webp" }),
      expect.objectContaining({ username: "Bob", gender: "male" }),
    ]);
  });

  it("reads public CAM4 broadcast records", () => {
    const html = `"BroadcastItem:1":${JSON.stringify({ username: "alice", viewers: 12, broadcastType: "female", showType: "PUBLIC_SHOW", preview: { poster: "https://img.example/a.jpg" } })},"BroadcastItem:2":${JSON.stringify({ username: "private", showType: "PRIVATE_SHOW" })}`;
    expect(cam4LiveCams(html)).toEqual([expect.objectContaining({ username: "alice", viewers: 12, gender: "female" })]);
  });

  it("decompresses the Cams.com model table", () => {
    const data = { props: { compressedWonResponse: { mapping: ["screen_name", "gender", "public_age", "hq_enabled"], models: [["Alice", "F", "25", "2"]] } } };
    expect(camsLiveCams(`<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`)).toEqual([expect.objectContaining({ username: "Alice", age: 25, gender: "female", tags: ["female", "hd"] })]);
  });

  it("reads CamSoda cards and LiveJasmin online performers", () => {
    const soda = `<a data-username="alice" data-thumb-image="https://img.example/a.jpg" href="/alice"><b>Alice</b><span>123 viewers</span></a>`;
    expect(camsodaLiveCams(soda)).toEqual([expect.objectContaining({ username: "alice", viewers: 123 })]);
    const performers = [{ display_name: "Jasmin", status: 1, main_category: "girls", viewers: 8 }, { display_name: "Offline", status: 0 }];
    expect(livejasminLiveCams(`<script>listPagePerformers = ${JSON.stringify(performers)};</script>`)).toEqual([expect.objectContaining({ username: "Jasmin", viewers: 8, gender: "female" })]);
  });

  it("reads rendered MyFreeCams, Twitch, and Xcams cards", () => {
    const mfc = `<div class="model_online modelbox_123456"><a title="Enter Chat Room of Alice"><img src="/alice.jpg"><span>9 viewers</span></a></div>`;
    expect(myfreecamsLiveCams(mfc)).toEqual([expect.objectContaining({ username: "Alice", viewers: 9 })]);
    const twitch = `<article><span>1.2K viewers</span><img src="https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-440x248.jpg"></article>`;
    expect(twitchLiveCams(twitch)).toEqual([expect.objectContaining({ username: "streamer", viewers: 1200 })]);
    const xcams = `<article><img src="/alice.jpg"><span>15 viewers</span><a href="/profile/Alice/">Alice</a></article>`;
    expect(xcamsLiveCams(xcams)).toEqual([expect.objectContaining({ username: "Alice", viewers: 15 })]);
  });

  it("reads the paginated MyFreeCams online Model Explorer", () => {
    const payload = `nRows = 537;\naListOrder = new Array(42, 0);\n aList['42'] = " <tr><i"+"mg src=https://img.mfcimg.com/photos2/420/42/avatar.100x100.jpg><a href='https://profiles.myfreecams.com/Alice'>View Full Profile</a><X>Hello &amp; welcome<X></tr> ";`;
    expect(myfreecamsExplorerLiveCams(payload)).toEqual({
      total: 537,
      cams: [expect.objectContaining({ username: "Alice", title: "Hello & welcome", gender: "female" })],
    });
  });

  it("normalizes Stripchat API models", () => {
    const payload = { blocks: [{ models: [{ username: "Alice", id: 42, snapshotTimestamp: 123, status: "public", viewersCount: 55, broadcastGender: "female" }] }] };
    expect(stripchatLiveCams(payload)).toEqual([expect.objectContaining({ username: "Alice", viewers: 55, gender: "female" })]);
  });

  it("reads an exact live Stripchat room from its browser-compatible profile state", () => {
    const state = {
      viewCam: { model: { username: "Alice", id: 42, status: "public", isLive: true, isOnline: true, viewersCount: 55 } },
      configV3: { initialCommon: { hlsStreamHost: "doppiocdn.net", hlsStreamHosts: { A: "doppiocdn.com" } }, static: { featureSettings: {
        hlsFallback: { fallbackDomains: ["doppiocdn.media"] },
        MMPExternalUnitedSourceOrigin: "https://mmp.doppiocdn.com/player/mmp/",
      } } },
      featuresConfig: { features: { playerModuleExternalLoading: { mmpVersion: "v2.12.0" } } },
    };
    const html = `<html><script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script></html>`;
    expect(stripchatProfileLiveCams(html, "alice")).toEqual([expect.objectContaining({ id: "alice", username: "Alice", pageUrl: "https://stripchat.com/Alice" })]);
    expect(stripchatStreamConfig(html)).toEqual({
      modelId: "42", domains: ["doppiocdn.media", "doppiocdn.net", "doppiocdn.com"],
      playerScriptUrl: "https://mmp.doppiocdn.com/player/mmp/v2.12.0/main.js",
    });
    expect(stripchatProfileLiveCams(html, "bob")).toEqual([]);
    expect(stripchatProfileLiveCams(`<script>window.__PRELOADED_STATE__ = ${JSON.stringify({ viewCam: { model: { username: "Alice", isLive: false, isOnline: false } } })}</script>`)).toEqual([]);
  });
});

describe("public live-cam discovery paging", () => {
  it("pages the Stripchat catalogue locally because its endpoint ignores offsets", async () => {
    const models = Array.from({ length: 60 }, (_, index) => ({ username: `model-${index + 1}`, status: "public", viewersCount: 60 - index, broadcastGender: "female" }));
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ blocks: [{ models }], totalCount: 2_000 }), { status: 200 }));
    const context = { config: {}, fetch, log: vi.fn(), runCommand: vi.fn() };
    const first = await listDiscoveredLiveCams(context, "stripchat", { page: 1, pageSize: 24 });
    const second = await listDiscoveredLiveCams(context, "stripchat", { page: 2, pageSize: 24 });
    expect(first).toMatchObject({ total: 60, pages: 3 });
    expect(first.cams[0]).toMatchObject({ username: "model-1" });
    expect(second.cams[0]).toMatchObject({ username: "model-25" });
    expect(new Set(first.cams.map((cam) => cam.username))).not.toContain(second.cams[0].username);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).not.toMatch(/[?&](?:offset|page)=/);
  });

  it("applies search, gender, and pagination to a provider catalogue", async () => {
    const context = {
      config: {}, fetch: globalThis.fetch, log: () => undefined,
      runCommand: async () => ({ exitCode: 0, stdout: bongaFixture, stderr: "" }),
    };
    const female = await listDiscoveredLiveCams(context, "bongacams", { page: 1, pageSize: 1, gender: "female", search: "ali" });
    expect(female).toMatchObject({ total: 1, pages: 1, cams: [{ username: "Alice" }] });
    const second = await listDiscoveredLiveCams(context, "bongacams", { page: 2, pageSize: 1 });
    expect(second).toMatchObject({ total: 2, pages: 2, cams: [{ username: "Bob" }] });
  });

  it("keeps the last successful catalogue when a provider refresh is temporarily unavailable", async () => {
    vi.useFakeTimers();
    try {
      const html = `"BroadcastItem:1":${JSON.stringify({ username: "alice", viewers: 12, broadcastType: "female", showType: "PUBLIC_SHOW" })}`;
      let available = true;
      const context = {
        config: {}, fetch: globalThis.fetch, log: vi.fn(),
        runCommand: async () => available ? { exitCode: 0, stdout: html, stderr: "" } : { exitCode: 1, stdout: "", stderr: "temporary timeout" },
      };
      await expect(listDiscoveredLiveCams(context, "cam4", { page: 1, pageSize: 24 })).resolves.toMatchObject({ total: 1 });
      available = false; vi.advanceTimersByTime(91_000);
      await expect(listDiscoveredLiveCams(context, "cam4", { page: 1, pageSize: 24 })).resolves.toMatchObject({ total: 1, cams: [{ username: "alice" }] });
      expect(context.log).toHaveBeenCalledWith("warn", expect.stringContaining("last successful snapshot"), "temporary timeout");
    } finally { vi.useRealTimers(); }
  });
});
