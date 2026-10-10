import { z } from "zod";
import type { Database } from "./database.js";
import { pluginMatchesSource, type PluginManager } from "./plugin-manager.js";
import { PerformerConflictError } from "./performer-conflict.js";
import { settingsSchema } from "./output-settings.js";
import { profileIdentity } from "../packages/profile-identity.js";

/*
 * Export and import of the library setup: performers (with aliases, links and
 * priority), their sources, the application settings and which plugins are
 * installed. Downloads, files and plugin configuration (passwords, cookies,
 * sessions) are never part of a backup.
 *
 * Importing merges into the current library and never deletes anything:
 * performers are matched by name or linked identity, sources by account, so importing
 * the same file twice changes nothing.
 */
export const BACKUP_FORMAT = "open-easyx-backup";
export const BACKUP_VERSION = 1;

const sourceSchema = z.object({
  pluginId: z.string().min(1), externalId: z.string().min(1), label: z.string().default(""),
  profileUrl: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Use an HTTP or HTTPS profile URL"), domain: z.string().default(""),
  enabled: z.boolean().optional(), autoDownload: z.boolean().optional(),
  scraperPluginId: z.string().nullable().optional(), scrapeEnabled: z.boolean().optional(),
  syncIntervalSeconds: z.number().int().min(5).max(31_536_000).optional(),
  recordingMaxHeight: z.number().int().min(0).max(4320).optional(),
});

const performerSchema = z.object({
  name: z.string().trim().min(1), aliases: z.array(z.string()).default([]), imageUrl: z.string().nullable().optional(),
  externalRefs: z.record(z.string(), z.string()).default({}), priority: z.number().int().min(-1).max(1).optional(),
  identities: z.array(z.object({ pluginId: z.string().min(1), externalId: z.string().min(1) })).default([]),
  sources: z.array(sourceSchema).default([]),
});

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT), version: z.number().int().min(1),
  exportedAt: z.string().optional(), appVersion: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  plugins: z.array(z.object({ id: z.string().min(1), enabled: z.boolean().optional() })).optional(),
  performers: z.array(performerSchema),
});

export type Backup = z.infer<typeof backupSchema>;
export type ImportOptions = { settings?: boolean; plugins?: boolean };
export type ImportResult = {
  performers: { created: number; updated: number; skipped: Array<{ name: string; reason: string }> };
  sources: { added: number; updated: number; warnings: Array<{ performer: string; profileUrl: string; reason: string }>; skipped: Array<{ performer: string; profileUrl: string; reason: string }> };
  settings: { applied: string[]; skipped: string[] };
  plugins: { installed: string[]; skipped: Array<{ id: string; reason: string }> };
};

export function exportBackup(db: Database, plugins: PluginManager, appVersion?: string): Backup {
  const sources = db.listSources();
  const settings = db.getSettings();
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), ...(appVersion ? { appVersion } : {}),
    settings: Object.fromEntries(Object.entries(settings).filter(([key]) => Object.hasOwn(settingsSchema.shape, key))),
    plugins: plugins.list().filter((plugin) => plugin.installed).map((plugin) => ({ id: plugin.manifest.id, enabled: plugin.enabled })),
    performers: db.listPerformers().map((performer) => ({
      name: performer.name, aliases: performer.aliases, ...(performer.imageUrl ? { imageUrl: performer.imageUrl } : {}),
      externalRefs: performer.externalRefs, identities: db.performerIdentities(performer.id), priority: performer.priority ?? 0,
      sources: sources.filter((source) => source.performerId === performer.id).map((source) => ({
        pluginId: source.pluginId, externalId: source.externalId, label: source.label, profileUrl: source.profileUrl, domain: source.domain,
        enabled: source.enabled, autoDownload: source.autoDownload, scraperPluginId: source.scraperPluginId ?? null,
        scrapeEnabled: source.scrapeEnabled, syncIntervalSeconds: source.syncIntervalSeconds, recordingMaxHeight: source.recordingMaxHeight,
      })),
    })),
  };
}

export function parseBackup(input: unknown): Backup {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) {
    const format = input && typeof input === "object" ? (input as Record<string, unknown>).format : undefined;
    const reason = format !== BACKUP_FORMAT ? "This file is not an Open EasyX backup" : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 3).join("; ");
    throw Object.assign(new Error(reason), { statusCode: 400 });
  }
  if (parsed.data.version > BACKUP_VERSION) throw Object.assign(new Error(`This backup was made by a newer Open EasyX (format ${parsed.data.version}); update first`), { statusCode: 400 });
  return parsed.data;
}

export function importBackup(db: Database, plugins: PluginManager, backup: Backup, options: ImportOptions = {}): ImportResult {
  const result: ImportResult = { performers: { created: 0, updated: 0, skipped: [] }, sources: { added: 0, updated: 0, warnings: [], skipped: [] }, settings: { applied: [], skipped: [] }, plugins: { installed: [], skipped: [] } };

  db.sqlite.exec("SAVEPOINT backup_import");
  try {
    if (options.plugins !== false) {
      const known = new Map(plugins.list().map((plugin) => [plugin.manifest.id, plugin]));
      for (const entry of backup.plugins ?? []) {
        const plugin = known.get(entry.id);
        if (!plugin) { result.plugins.skipped.push({ id: entry.id, reason: "Plugin not available in this installation" }); continue; }
        if (plugin.installed) continue;
        if (entry.enabled === false) { result.plugins.skipped.push({ id: entry.id, reason: "Disabled plugin left inactive" }); continue; }
        try { plugins.install(entry.id); result.plugins.installed.push(entry.id); }
        catch (error) { result.plugins.skipped.push({ id: entry.id, reason: error instanceof Error ? error.message : String(error) }); }
      }
    }

    if (options.settings !== false && backup.settings) {
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(backup.settings)) {
        const check = settingsSchema.safeParse({ [key]: value });
        if (check.success && key in check.data) values[key] = (check.data as Record<string, unknown>)[key];
        else result.settings.skipped.push(key);
      }
      if (Object.keys(values).length) { db.updateSettings(values); result.settings.applied.push(...Object.keys(values)); }
    }

    for (const entry of backup.performers) {
      const name = db.resolvePerformerName(entry.name);
      let performer = db.getPerformerByName(name);
      const identities = [...Object.entries(entry.externalRefs).map(([pluginId, externalId]) => ({ pluginId, externalId })), ...entry.identities];
      const owners = new Map(identities.flatMap(({ pluginId, externalId }) => {
        const owner = db.findPerformerByIdentity(pluginId, externalId); return owner ? [[owner.id, owner] as const] : [];
      }));
      if (owners.size > 1 || (performer && [...owners.keys()].some((owner) => owner !== performer?.id))) {
        result.performers.skipped.push({ name: entry.name, reason: "Linked accounts belong to another performer; resolve the conflict before importing" });
        continue;
      }
      performer ??= owners.values().next().value;
      if (performer) result.performers.updated += 1;
      else { performer = db.createPerformer({ name, aliases: [], imageUrl: entry.imageUrl ?? null }); result.performers.created += 1; }
      db.mergePerformerDetails(performer.id, { aliases: entry.name.toLowerCase() === performer.name.toLowerCase() ? entry.aliases : [...entry.aliases, entry.name], imageUrl: entry.imageUrl ?? undefined, externalRefs: entry.externalRefs, identities: entry.identities });
      if (entry.priority !== undefined) db.setPerformerPriority(performer.id, entry.priority);

      const existing = db.listSources(performer.id);
      for (const source of entry.sources) {
        try {
          const same = existing.find((stored) => (stored.pluginId === source.pluginId && stored.externalId === source.externalId)
            || profileIdentity(stored.profileUrl) === profileIdentity(source.profileUrl));
          const saved = same ?? db.addSource(performer.id, source.pluginId, { externalId: source.externalId, label: source.label || source.domain, profileUrl: source.profileUrl, domain: source.domain || new URL(source.profileUrl).hostname });
          let scrapeEnabled = source.scrapeEnabled;
          let interval = source.syncIntervalSeconds;
          const scraperId = source.scraperPluginId === undefined ? saved.scraperPluginId : source.scraperPluginId;
          if (scraperId) {
            const scraper = plugins.list().find((plugin) => plugin.manifest.id === scraperId);
            if (!scraper?.installed || !scraper.enabled || !scraper.manifest.capabilities.includes("media-listing") || !pluginMatchesSource(scraper.manifest, saved.profileUrl)) {
              scrapeEnabled = false;
              result.sources.warnings.push({ performer: name, profileUrl: source.profileUrl, reason: "Source restored with scraping disabled: configure a compatible scraper first" });
            }
            const minimum = scraper?.manifest.polling?.minimumIntervalSeconds ?? 300;
            if (interval !== undefined && interval < minimum) {
              interval = minimum;
              result.sources.warnings.push({ performer: name, profileUrl: source.profileUrl, reason: `Scrape interval raised to the plugin minimum of ${minimum} seconds` });
            }
          } else if (scrapeEnabled) scrapeEnabled = false;
          db.updateSource(saved.id, {
            ...(source.enabled !== undefined ? { enabled: source.enabled } : {}), ...(source.autoDownload !== undefined ? { autoDownload: source.autoDownload } : {}),
            ...(source.scraperPluginId !== undefined ? { scraperPluginId: source.scraperPluginId } : {}), ...(scrapeEnabled !== undefined ? { scrapeEnabled } : {}),
            ...(interval !== undefined ? { syncIntervalSeconds: interval } : {}),
            ...(source.recordingMaxHeight !== undefined ? { recordingMaxHeight: source.recordingMaxHeight } : {}),
          });
          if (same) result.sources.updated += 1; else { result.sources.added += 1; existing.push(saved); }
        } catch (error) {
          const reason = error instanceof PerformerConflictError
            ? `Already belongs to ${error.conflict.existingPerformer.name}`
            : error instanceof Error ? error.message : String(error);
          result.sources.skipped.push({ performer: name, profileUrl: source.profileUrl, reason });
        }
      }
    }
    db.sqlite.exec("RELEASE backup_import");
    return result;
  } catch (error) { db.sqlite.exec("ROLLBACK TO backup_import; RELEASE backup_import"); throw error; }
}
