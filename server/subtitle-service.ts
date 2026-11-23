import type { EasyXPlugin } from "../packages/plugin-sdk/index.js";
import type { LibraryDatabase, SubtitleSettings } from "./library-database.js";
import type { LogWriter } from "./log-store.js";
import type { PluginManager } from "./plugin-manager.js";

export class SubtitleService {
  private active?: { plugin: EasyXPlugin; settingsKey: string; controller: AbortController; done: Promise<void> };
  private restart?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private db: LibraryDatabase,
    private plugins: Pick<PluginManager, "subtitleProvider" | "context">,
    private dataDir: string,
    private mediaDir: string,
    private log: LogWriter,
  ) {}

  requirePlugin() {
    const plugin = this.plugins.subtitleProvider();
    if (!plugin) throw Object.assign(new Error("Install a subtitle plugin first"), { statusCode: 409 });
    return plugin;
  }

  importTrack(code: string, content: string) {
    const plugin = this.requirePlugin();
    const language = plugin.manifest.subtitleLanguages?.find((item) => item.code === code);
    if (!language) throw Object.assign(new Error("Unsupported subtitle language"), { statusCode: 400 });
    if (!plugin.importSubtitle) throw Object.assign(new Error("Subtitle imports are unavailable"), { statusCode: 409 });
    try { return { webvtt: plugin.importSubtitle(content), language }; }
    catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 400 }); }
  }

  private settingsFor(plugin: EasyXPlugin | undefined) {
    const saved = this.db.subtitleSettings(Boolean(plugin));
    const supported = plugin?.manifest.subtitleLanguages;
    return { enabled: Boolean(plugin) && saved.enabled, languages: supported ? saved.languages.filter((code) => supported.some((item) => item.code === code)) : saved.languages };
  }

  librarySettings() {
    const plugin = this.plugins.subtitleProvider();
    return { subtitles: this.settingsFor(plugin), subtitleLanguages: plugin?.manifest.subtitleLanguages ?? [] };
  }

  mediaStatus(mediaId: string) {
    const plugin = this.plugins.subtitleProvider();
    const settings = this.settingsFor(plugin);
    const status = this.db.subtitleStatus(mediaId, settings.enabled);
    return status && { ...status, pluginEnabled: Boolean(plugin), targetLanguages: settings.languages, languages: plugin?.manifest.subtitleLanguages ?? [] };
  }

  overview() {
    const plugin = this.plugins.subtitleProvider();
    return { ...this.db.subtitleOverview(this.settingsFor(plugin)), pluginEnabled: Boolean(plugin), languages: plugin?.manifest.subtitleLanguages ?? [] };
  }

  async configure(settings: SubtitleSettings) {
    const plugin = this.requirePlugin();
    if (settings.languages.some((code) => !plugin.manifest.subtitleLanguages?.some((item) => item.code === code))) throw Object.assign(new Error("One or more subtitle languages are not supported"), { statusCode: 400 });
    const result = this.db.setSubtitleSettings(settings);
    await this.sync();
    return result;
  }

  retry(mediaId: string) {
    if (!this.settingsFor(this.plugins.subtitleProvider()).enabled) throw Object.assign(new Error("Enable automatic generation in the subtitle plugin first"), { statusCode: 409 });
    if (!this.db.retrySubtitleJob(mediaId)) throw Object.assign(new Error("Only failed subtitle jobs can be retried"), { statusCode: 409 });
    return this.mediaStatus(mediaId);
  }

  async sync(): Promise<void> {
    const plugin = this.closed ? undefined : this.plugins.subtitleProvider();
    const settings = this.settingsFor(plugin);
    const controller = new AbortController();
    const context = plugin && this.plugins.context(plugin.manifest.id, controller.signal);
    const settingsKey = JSON.stringify([settings.languages, context?.config]);
    if (this.active) {
      const current = this.active;
      if (!current.controller.signal.aborted && settings.enabled && current.plugin === plugin && current.settingsKey === settingsKey) return;
      current.controller.abort();
      // Wait for the old process to exit before another worker can claim a job.
      await current.done;
      return this.sync();
    }
    clearTimeout(this.restart);
    if (!settings.enabled || !plugin?.runSubtitleWorker || !context) return;

    this.db.setSubtitleWorkerState("starting");
    const paths = { dataDir: this.dataDir, mediaDir: this.mediaDir, databasePath: this.db.databasePath, languages: settings.languages };
    const run = plugin.runSubtitleWorker.bind(plugin);
    const done = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      await run(context, paths);
      throw new Error("Subtitle worker stopped unexpectedly");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.db.setSubtitleWorkerState("error", message);
      this.log("error", "subtitles", "Subtitle worker stopped", { pluginId: plugin.manifest.id, error: message });
      this.restart = setTimeout(() => { void this.sync(); }, 60_000).unref();
    }).finally(() => { this.active = undefined; });
    this.active = { plugin, settingsKey, controller, done };
  }

  async close() {
    this.closed = true;
    await this.sync();
  }
}
