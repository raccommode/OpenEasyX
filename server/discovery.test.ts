import { describe, expect, it } from "vitest";
import { discoverPeople, groupDiscoveryMatches } from "./discovery.js";

describe("multi-provider discovery", () => {
  it("groups the same performer and ranks exact multi-source matches first", () => {
    const results = groupDiscoveryMatches([
      { pluginId: "one", pluginName: "One", candidate: { externalId: "1", name: "Example Star", aliases: ["Example"] } },
      { pluginId: "two", pluginName: "Two", candidate: { externalId: "2", name: "example star", aliases: ["Star"] } },
      { pluginId: "three", pluginName: "Three", candidate: { externalId: "3", name: "Example Movie" } },
    ], "Example Star");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: "Example Star", aliases: ["Example", "Star"] });
    expect(results[0].matches.map((match) => match.pluginId)).toEqual(["one", "two"]);
  });

  it("keeps healthy results when another provider fails", async () => {
    const available = [
      { manifest: { id: "good", name: "Good", capabilities: ["identity-search"] }, installed: true, enabled: true },
      { manifest: { id: "bad", name: "Bad", capabilities: ["identity-search"] }, installed: true, enabled: true },
    ];
    const manager = {
      list: () => available,
      get: (id: string) => ({ searchPeople: id === "bad" ? async () => { throw new Error("provider down"); } : async () => [{ externalId: "1", name: "Example Star" }] }),
      context: (_id: string, signal?: AbortSignal) => ({ config: {}, signal, fetch: globalThis.fetch, log: () => undefined }),
    };
    const progress: number[] = [];
    const response = await discoverPeople(manager as never, "Example Star", (status) => progress.push(status.progress));
    expect(response.results).toHaveLength(1);
    expect(response.providers).toEqual([
      expect.objectContaining({ pluginId: "good", ok: true, resultCount: 1 }),
      expect.objectContaining({ pluginId: "bad", ok: false, error: "provider down" }),
    ]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
  });
});
