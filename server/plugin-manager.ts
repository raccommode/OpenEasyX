import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import type { EasyXPlugin, PluginContext, PluginManifest } from "../packages/plugin-sdk/index.js";
import type { Database } from "./database.js";
import type { LogWriter } from "./log-store.js";

export class PluginManager {
  private plugins = new Map<string, EasyXPlugin>();
  private pluginRoots = new Map<string, string>();
  constructor(private db: Database, private roots: string[], private sessionsDir = path.resolve("data", "sessions"), private writeLog?: LogWriter) {}

  setRoots(roots: string[]) { this.roots = [...new Set(roots.map((root) => path.resolve(root)))]; }

  async load() {
    this.plugins.clear();
    this.pluginRoots.clear();
    for (const root of this.roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const base = path.join(root, entry.name);
        const file = ["index.ts", "index.mjs", "index.js"].map((name) => path.join(base, name)).find(fs.existsSync);
        if (!file) continue;
        try {
          const module = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
          const plugin = (module.default ?? module.plugin) as EasyXPlugin;
          this.addDefaultBrowserAuth(plugin);
          this.validate(plugin);
          if (this.plugins.has(plugin.manifest.id)) throw new Error(`Duplicate plugin id: ${plugin.manifest.id}`);
          this.plugins.set(plugin.manifest.id, plugin);
          this.pluginRoots.set(plugin.manifest.id, path.resolve(root));
          const state = this.db.getPluginState(plugin.manifest.id);
          const allowedSettings = new Set((plugin.manifest.settings ?? []).map((field) => field.key));
          const prunedConfig = Object.fromEntries(Object.entries(state.config).filter(([key]) => allowedSettings.has(key)));
          if (Object.keys(prunedConfig).length !== Object.keys(state.config).length) this.db.setPluginState(plugin.manifest.id, { config: prunedConfig });
          // Since 0.6 an installed plugin is always active. Collapse legacy
          // "installed but disabled" rows back to the uninstalled state.
          if (state.installed && !state.enabled) this.db.setPluginState(plugin.manifest.id, { installed: false, enabled: false });
          this.writeLog?.("debug", "plugins", "Plugin loaded", { pluginId: plugin.manifest.id, version: plugin.manifest.version });
        } catch (error) {
          if (this.writeLog) this.writeLog("error", "plugins", "Failed to load plugin", { file, error });
          else console.error(`[plugins] Failed to load ${file}`, error);
        }
      }
    }
  }

  private addDefaultBrowserAuth(plugin: EasyXPlugin) {
    if (plugin?.manifest?.browserAuth) return;
    const sessionField = plugin?.manifest?.settings?.find((field) => field.type === "session" && field.sessionFormat !== "raw-json" && field.cookieDomains?.length);
    const domain = sessionField?.cookieDomains?.[0]?.replace(/^\./, "");
    if (sessionField && domain) plugin.manifest.browserAuth = { loginUrl: `https://${domain}/`, sessionSetting: sessionField.key };
  }

  private validate(plugin: EasyXPlugin) {
    if (!plugin?.manifest?.id || !/^[a-z0-9][a-z0-9.-]+$/.test(plugin.manifest.id)) throw new Error("Invalid plugin manifest id");
    if (!plugin.manifest.name || !plugin.manifest.version || !Array.isArray(plugin.manifest.capabilities)) throw new Error("Incomplete plugin manifest");
    if (plugin.manifest.capabilities.includes("live-cam") && !plugin.resolveLiveStream) throw new Error("Live-cam plugins must implement resolveLiveStream");
    if (plugin.manifest.fallback !== undefined && typeof plugin.manifest.fallback !== "boolean") throw new Error("Invalid plugin fallback flag");
    if (plugin.manifest.sourceUrlPatterns && (!plugin.manifest.sourceUrlPatterns.length || plugin.manifest.sourceUrlPatterns.some((pattern) => typeof pattern !== "string" || !pattern.trim()))) throw new Error("Invalid source URL patterns");
    if (plugin.manifest.polling && (!Number.isInteger(plugin.manifest.polling.defaultIntervalSeconds) || !Number.isInteger(plugin.manifest.polling.minimumIntervalSeconds) || plugin.manifest.polling.minimumIntervalSeconds < 5 || plugin.manifest.polling.defaultIntervalSeconds < plugin.manifest.polling.minimumIntervalSeconds)) throw new Error("Invalid plugin polling policy");
    if (plugin.manifest.browserAuth) {
      let loginUrl: URL;
      try { loginUrl = new URL(plugin.manifest.browserAuth.loginUrl); }
      catch { throw new Error("Invalid browser login URL"); }
      if (loginUrl.protocol !== "https:" || loginUrl.username || loginUrl.password) throw new Error("Browser login URLs must use HTTPS without embedded credentials");
      const sessionField = plugin.manifest.settings?.find((field) => field.key === plugin.manifest.browserAuth?.sessionSetting);
      const capture = plugin.manifest.browserAuth.capture ?? "cookies";
      const supportedField = capture === "authorization-header" ? sessionField?.type === "password" : sessionField?.type === "session";
      if (!supportedField) throw new Error("Browser authentication must reference a compatible session setting");
      if (capture === "onlyfans" && sessionField?.sessionFormat !== "raw-json") throw new Error("OnlyFans browser authentication requires a raw JSON session setting");
      if (capture === "authorization-header" && !plugin.manifest.browserAuth.requestDomains?.length) throw new Error("Authorization-header capture requires an official request domain");
      for (const domain of plugin.manifest.browserAuth.requestDomains ?? []) {
        if (typeof domain !== "string" || !/^[a-z0-9.-]+$/i.test(domain)) throw new Error("Invalid browser authentication request domain");
      }
    }
    for (const field of plugin.manifest.settings ?? []) {
      if (field.type === "session" && field.sessionFormat !== "raw-json" && (!field.cookieDomains?.length || field.cookieDomains.some((domain) => typeof domain !== "string" || !/^\.?[a-z0-9.-]+$/i.test(domain)))) throw new Error(`Invalid cookie domains for '${field.label}'`);
    }
  }

  list() {
    return [...this.plugins.values()].map(({ manifest }) => {
      const state = this.db.getPluginState(manifest.id);
      const safeConfig = Object.fromEntries(Object.entries(state.config).map(([key, value]) => {
        const field = manifest.settings?.find((item) => item.key === key);
        return [key, (field?.type === "password" || field?.type === "session") && value ? "••••••••" : value];
      }));
      const root = this.pluginRoots.get(manifest.id) ?? "";
      return { manifest, ...state, config: safeConfig, origin: this.roots.indexOf(root) <= 0 ? "official" : root };
    });
  }

  get(pluginId: string, requireEnabled = true): EasyXPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' is not available`);
    const state = this.db.getPluginState(pluginId);
    if (requireEnabled && (!state.installed || !state.enabled)) throw new Error(`Plugin '${pluginId}' is not enabled`);
    return plugin;
  }

  context(pluginId: string, signal?: AbortSignal, configOverride?: Record<string, unknown>): PluginContext {
    const state = this.db.getPluginState(pluginId);
    return {
      config: configOverride ?? state.config,
      signal,
      fetch: globalThis.fetch,
      runCommand: (command, args, options = {}) => new Promise((resolve, reject) => {
        execFile(command, args, {
          timeout: Math.max(1_000, Math.min(30 * 60_000, options.timeoutMs ?? 120_000)),
          maxBuffer: Math.max(64 * 1024, Math.min(50 * 1024 * 1024, options.maxOutputBytes ?? 10 * 1024 * 1024)),
          encoding: "utf8",
          signal,
        }, (error, stdout, stderr) => {
          if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "string") return reject(error);
          resolve({ exitCode: typeof (error as { code?: unknown } | null)?.code === "number" ? Number((error as { code: number }).code) : error ? 1 : 0, stdout, stderr });
        });
      }),
      log: (level, message, details) => this.writeLog
        ? this.writeLog(level, `plugin:${pluginId}`, message, details)
        : console[level === "debug" ? "log" : level](`[plugin:${pluginId}] ${message}`, details ?? ""),
    };
  }

  private mergedConfig(pluginId: string, incoming: Record<string, unknown>, includeDefaults = false) {
    const plugin = this.get(pluginId, false); const old = this.db.getPluginState(pluginId).config;
    const defaults = includeDefaults
      ? Object.fromEntries((plugin.manifest.settings ?? []).filter((field) => field.default !== undefined).map((field) => [field.key, field.default]))
      : {};
    const config = { ...defaults, ...old };
    for (const field of plugin.manifest.settings ?? []) {
      const value = incoming[field.key];
      if (value === "••••••••") continue;
      if (value !== undefined) {
        const valid = field.type === "boolean" ? typeof value === "boolean"
          : field.type === "number" ? typeof value === "number" && Number.isFinite(value)
          : typeof value === "string";
        if (!valid) throw new Error(`Invalid value for '${field.label}'`);
        config[field.key] = value;
      }
    }
    return config;
  }

  private missingSettings(pluginId: string, config: Record<string, unknown>) {
    const plugin = this.get(pluginId, false);
    return (plugin.manifest.settings ?? []).filter((field) => field.required && (config[field.key] === undefined || config[field.key] === ""));
  }

  private managedSessionPath(pluginId: string, format: "cookies" | "raw-json" = "cookies") {
    return path.join(this.sessionsDir, `${pluginId.replace(/[^a-z0-9.-]/gi, "_")}.${format === "raw-json" ? "json" : "txt"}`);
  }

  private sessionDocument(value: string, domains: string[], format: "cookies" | "raw-json" = "cookies") {
    const normalized = value.trim().replace(/^Cookie:\s*/i, "");
    if (!normalized) return "";
    if (format === "raw-json") {
      let parsed: unknown;
      try { parsed = JSON.parse(normalized); }
      catch { throw new Error("Import a valid JSON session file"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The session JSON must contain an object");
      return `${JSON.stringify(parsed, null, 2)}\n`;
    }
    if (normalized.includes("\t")) {
      const lines = normalized.split(/\r?\n/).filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")));
      if (!lines.length || lines.some((line) => line.split("\t").length < 7)) throw new Error("The account session file is not in Netscape cookie format");
      return `${normalized}\n`;
    }
    const cookies = normalized.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) throw new Error("Paste a browser Cookie header or import a cookies.txt file");
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const;
    });
    if (!cookies.length) throw new Error("The account session is empty");
    const domain = domains[0].startsWith(".") ? domains[0] : `.${domains[0]}`;
    return `# Netscape HTTP Cookie File\n${cookies.map(([name, cookieValue]) => `${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${cookieValue}`).join("\n")}\n`;
  }

  private materializeSessions(pluginId: string, config: Record<string, unknown>, previous: Record<string, unknown>) {
    const plugin = this.get(pluginId, false);
    for (const field of plugin.manifest.settings ?? []) {
      if (field.type !== "session") continue;
      const value = config[field.key];
      if (value === previous[field.key]) continue;
      if (typeof value !== "string" || !value.trim()) { delete config[field.key]; continue; }
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.sessionsDir, 0o700);
      const format = field.sessionFormat ?? "cookies";
      const destination = this.managedSessionPath(pluginId, format);
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, this.sessionDocument(value, field.cookieDomains ?? [], format), { mode: 0o600 });
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
      config[field.key] = destination;
    }
    return config;
  }

  configure(pluginId: string, incoming: Record<string, unknown>) {
    const previous = this.db.getPluginState(pluginId).config;
    const config = this.mergedConfig(pluginId, incoming);
    const missing = this.missingSettings(pluginId, config);
    if (missing.length) throw Object.assign(new Error(`Configure ${missing.map((field) => field.label).join(", ")} before saving this plugin`), { statusCode: 409 });
    return this.db.setPluginState(pluginId, { config: this.materializeSessions(pluginId, config, previous) });
  }

  install(pluginId: string, incoming: Record<string, unknown> = {}) {
    const previous = this.db.getPluginState(pluginId).config;
    const config = this.mergedConfig(pluginId, incoming, true);
    const missing = this.missingSettings(pluginId, config);
    if (missing.length) throw Object.assign(new Error(`Configure ${missing.map((field) => field.label).join(", ")} before installing this plugin`), { statusCode: 409 });
    return this.db.setPluginState(pluginId, { installed: true, enabled: true, config: this.materializeSessions(pluginId, config, previous) });
  }

  uninstall(pluginId: string) {
    const plugin = this.get(pluginId, false);
    const config = { ...this.db.getPluginState(pluginId).config };
    for (const field of plugin.manifest.settings ?? []) {
      if (field.type !== "session") continue;
      const storedPath = config[field.key];
      if (typeof storedPath === "string" && [this.managedSessionPath(pluginId), this.managedSessionPath(pluginId, "raw-json")].some((managedPath) => path.resolve(storedPath) === path.resolve(managedPath))) fs.rmSync(storedPath, { force: true });
      delete config[field.key];
    }
    return this.db.setPluginState(pluginId, { installed: false, enabled: false, config });
  }

  ensureConfigured(pluginId: string) {
    const config = this.db.getPluginState(pluginId).config;
    const missing = this.missingSettings(pluginId, config);
    if (missing.length) throw Object.assign(new Error(`Configure ${missing.map((field) => field.label).join(", ")} before enabling this plugin`), { statusCode: 409 });
  }
}

export function pluginMatchesSource(manifest: PluginManifest, profileUrl: string): boolean {
  if (!manifest.capabilities.includes("media-listing") && !manifest.capabilities.includes("live-cam")) return false;
  const patterns = manifest.sourceUrlPatterns;
  if (!patterns?.length) return true;
  return patterns.some((pattern) => {
    const expression = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`, "i").test(profileUrl);
  });
}
