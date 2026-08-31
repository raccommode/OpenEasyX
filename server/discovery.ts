import type { PersonCandidate } from "../packages/plugin-sdk/index.js";
import type { PluginManager } from "./plugin-manager.js";

export type DiscoveryMatch = { pluginId: string; pluginName: string; candidate: PersonCandidate };
export type DiscoveryProviderStatus = {
  pluginId: string;
  pluginName: string;
  ok: boolean;
  resultCount: number;
  durationMs: number;
  error?: string;
};
export type DiscoveryGroup = {
  key: string;
  name: string;
  aliases: string[];
  imageUrl?: string;
  profileUrls: string[];
  matches: DiscoveryMatch[];
};
export type DiscoveryProgress = { completed: number; total: number; progress: number };

export function normalizeIdentity(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function groupDiscoveryMatches(matches: DiscoveryMatch[], query: string): DiscoveryGroup[] {
  const groups = new Map<string, DiscoveryGroup>();
  for (const match of matches) {
    const key = normalizeIdentity(match.candidate.name);
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        name: match.candidate.name,
        aliases: [...new Set(match.candidate.aliases ?? [])],
        imageUrl: match.candidate.imageUrl,
        profileUrls: [...new Set(match.candidate.profileUrls ?? [])],
        matches: [match],
      });
      continue;
    }
    existing.aliases = [...new Set([...existing.aliases, ...(match.candidate.aliases ?? [])])].filter((alias) => normalizeIdentity(alias) !== key);
    existing.profileUrls = [...new Set([...existing.profileUrls, ...(match.candidate.profileUrls ?? [])])];
    existing.imageUrl ??= match.candidate.imageUrl;
    existing.matches.push(match);
  }
  const normalizedQuery = normalizeIdentity(query);
  return [...groups.values()].sort((a, b) => {
    const exact = Number(b.key === normalizedQuery) - Number(a.key === normalizedQuery);
    return exact || b.matches.length - a.matches.length || a.name.localeCompare(b.name);
  });
}

export async function discoverPeople(plugins: PluginManager, query: string, onProgress?: (progress: DiscoveryProgress) => void) {
  const entries = plugins.list().filter((entry) => entry.installed && entry.enabled && entry.manifest.capabilities.includes("identity-search"));
  let completed = 0;
  const reportProgress = () => onProgress?.({ completed, total: entries.length, progress: entries.length ? Math.round(completed / entries.length * 100) : 100 });
  reportProgress();
  const searches = await Promise.all(entries.map(async (entry): Promise<{ status: DiscoveryProviderStatus; matches: DiscoveryMatch[] }> => {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const plugin = plugins.get(entry.manifest.id);
      const candidates = plugin.searchPeople ? await plugin.searchPeople(plugins.context(entry.manifest.id, controller.signal), query) : [];
      return {
        status: { pluginId: entry.manifest.id, pluginName: entry.manifest.name, ok: true, resultCount: candidates.length, durationMs: Date.now() - started },
        matches: candidates.map((candidate) => ({ pluginId: entry.manifest.id, pluginName: entry.manifest.name, candidate })),
      };
    } catch (error) {
      return {
        status: { pluginId: entry.manifest.id, pluginName: entry.manifest.name, ok: false, resultCount: 0, durationMs: Date.now() - started, error: controller.signal.aborted ? "Search timed out after 20 seconds" : error instanceof Error ? error.message : String(error) },
        matches: [],
      };
    } finally {
      clearTimeout(timeout);
      completed++;
      reportProgress();
    }
  }));
  return {
    query,
    providers: searches.map((search) => search.status),
    results: groupDiscoveryMatches(searches.flatMap((search) => search.matches), query),
  };
}
