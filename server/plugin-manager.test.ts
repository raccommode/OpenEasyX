import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { PluginManager, pluginMatchesSource } from "./plugin-manager.js";
import type { PluginManifest } from "../packages/plugin-sdk/index.js";

const manifest = (patterns?: string[]): PluginManifest => ({
  id: "example.scraper", name: "Example", version: "1.0.0", description: "Test", author: "Test",
  capabilities: ["media-listing"], sourceUrlPatterns: patterns,
});

describe("plugin source matching", () => {
  it("matches declared URL globs without matching unrelated hosts", () => {
    const reddit = manifest(["https://www.reddit.com/r/*", "https://reddit.com/user/*"]);
    expect(pluginMatchesSource(reddit, "https://www.reddit.com/r/example/")).toBe(true);
    expect(pluginMatchesSource(reddit, "https://www.reddit.com/user/example")).toBe(false);
    expect(pluginMatchesSource(reddit, "https://example.test/r/example")).toBe(false);
  });

  it("keeps older media-listing plugins compatible with any URL", () => {
    expect(pluginMatchesSource(manifest(), "https://example.test/profile")).toBe(true);
    expect(pluginMatchesSource({ ...manifest(), capabilities: ["identity-search"] }, "https://example.test/profile")).toBe(false);
  });
});

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("plugin lifecycle", () => {
  it("includes the message and code when a plugin fails to load", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-error-")); temporaryDirectories.push(root);
    const plugins = path.join(root, "plugins"); fs.mkdirSync(path.join(plugins, "broken"), { recursive: true });
    fs.writeFileSync(path.join(plugins, "broken", "index.mjs"), 'throw Object.assign(new Error("Missing runtime dependency"), { code: "MODULE_NOT_FOUND" });');
    const db = new Database(path.join(root, "data")); const logs: unknown[] = [];
    try {
      await new PluginManager(db, [plugins], undefined, (_level, _scope, message, details) => logs.push({ message, details })).load();
      expect(logs).toContainEqual({ message: "Failed to load plugin", details: { file: path.join(plugins, "broken", "index.mjs"), error: "Missing runtime dependency", code: "MODULE_NOT_FOUND" } });
    } finally { db.close(); }
  });

  it("accepts only HTTPS browser login manifests tied to a session setting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-browser-auth-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins"); fs.mkdirSync(path.join(pluginRoot, "valid"), { recursive: true }); fs.mkdirSync(path.join(pluginRoot, "valid-manyvids"), { recursive: true }); fs.mkdirSync(path.join(pluginRoot, "invalid"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "valid", "index.mjs"), `export default { manifest: { id: "test.browser-valid", name: "Valid", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "auth", label: "Auth", type: "session", sessionFormat: "raw-json" }], browserAuth: { loginUrl: "https://onlyfans.com/", sessionSetting: "auth", capture: "onlyfans" } } };`);
    fs.writeFileSync(path.join(pluginRoot, "valid-manyvids", "index.mjs"), `export default { manifest: { id: "test.browser-manyvids", name: "ManyVids", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "cookies", label: "Cookies", type: "session", cookieDomains: ["manyvids.com"] }], browserAuth: { loginUrl: "https://www.manyvids.com/Login", sessionSetting: "cookies", capture: "manyvids" } } };`);
    fs.writeFileSync(path.join(pluginRoot, "invalid", "index.mjs"), `export default { manifest: { id: "test.browser-invalid", name: "Invalid", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "token", label: "Token", type: "password" }], browserAuth: { loginUrl: "http://onlyfans.com/", sessionSetting: "token", capture: "authorization-header", requestDomains: ["onlyfans.com"] } } };`);
    const database = new Database(path.join(root, "data"));
    const originalError = console.error; console.error = () => undefined;
    try {
      const manager = new PluginManager(database, [pluginRoot]); await manager.load();
      expect(manager.list().map((entry) => entry.manifest.id).sort()).toEqual(["test.browser-manyvids", "test.browser-valid"]);
    } finally { console.error = originalError; }
  });

  it("installs and activates atomically, then uninstalls both states", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-lifecycle-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins"); fs.mkdirSync(path.join(pluginRoot, "sample"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "sample", "index.mjs"), `export default { manifest: { id: "test.lifecycle", name: "Lifecycle", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "token", label: "Token", type: "password", required: true }] } };`);
    const database = new Database(path.join(root, "data"));
    const manager = new PluginManager(database, [pluginRoot]); await manager.load();
    expect(() => manager.install("test.lifecycle")).toThrow("Configure Token");
    expect(manager.install("test.lifecycle", { token: "secret" })).toMatchObject({ installed: true, enabled: true });
    expect(manager.uninstall("test.lifecycle")).toMatchObject({ installed: false, enabled: false });
  });

  it("requires subtitle hooks and permits only one installed subtitle provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-subtitle-providers-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins");
    for (const name of ["First", "Second", "MissingHooks", "InvalidLanguages", "DuplicateLanguages"]) {
      const base = path.join(pluginRoot, name);
      fs.mkdirSync(base, { recursive: true });
      const languages = [{ code: "fr-CA", label: "Canadian French" }];
      if (name === "InvalidLanguages") languages.push({ code: "../file", label: "Invalid" });
      if (name === "DuplicateLanguages") languages.push({ code: "fr-ca", label: "Repeated" });
      const manifest = { id: "test." + name.toLowerCase(), name, version: "1", author: "Test", description: "Test", capabilities: ["subtitle-generation"], subtitleLanguages: languages };
      const hooks = name === "MissingHooks" ? "" : ", async runSubtitleWorker() {}, importSubtitle(content) { return content }";
      fs.writeFileSync(path.join(base, "index.mjs"), `export default { manifest: ${JSON.stringify(manifest)}${hooks} };`);
    }
    const database = new Database(path.join(root, "data"));
    try {
      const manager = new PluginManager(database, [pluginRoot], undefined, () => {});
      await manager.load();
      expect(manager.list().map(entry => entry.manifest.name).sort()).toEqual(["First", "Second"]);
      manager.install("test.first");
      expect(() => manager.install("test.second")).toThrow("Uninstall First");
      expect(database.getPluginState("test.second").installed).toBe(false);
      manager.uninstall("test.first");
      manager.install("test.second");
      expect(manager.subtitleProvider()?.manifest.id).toBe("test.second");
    } finally { database.close(); }
  });

  it("turns legacy installed-but-disabled plugins into uninstalled plugins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-legacy-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins"); fs.mkdirSync(path.join(pluginRoot, "sample"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "sample", "index.mjs"), `export default { manifest: { id: "test.legacy", name: "Legacy", version: "1", description: "Test", author: "Test", capabilities: [] } };`);
    const database = new Database(path.join(root, "data")); database.setPluginState("test.legacy", { installed: true, enabled: false });
    const manager = new PluginManager(database, [pluginRoot]); await manager.load();
    expect(database.getPluginState("test.legacy")).toMatchObject({ installed: false, enabled: false });
  });

  it("removes obsolete technical options that are no longer declared", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-prune-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins"); fs.mkdirSync(path.join(pluginRoot, "sample"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "sample", "index.mjs"), `export default { manifest: { id: "test.simple", name: "Simple", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "maxItems", label: "Maximum items", type: "number", default: 50 }] } };`);
    const database = new Database(path.join(root, "data")); database.setPluginState("test.simple", { config: { maxItems: 25, impersonate: "chrome", format: "custom" } });
    const manager = new PluginManager(database, [pluginRoot]); await manager.load();
    expect(database.getPluginState("test.simple").config).toEqual({ maxItems: 25 });
  });

  it("stores imported account sessions privately and removes them on uninstall", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-session-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins"); const sessionsRoot = path.join(root, "sessions");
    fs.mkdirSync(path.join(pluginRoot, "sample"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "sample", "index.mjs"), `export default { manifest: { id: "test.session", name: "Session", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "cookiesFile", label: "Account session", type: "session", required: true, cookieDomains: ["example.com"] }] } };`);
    const database = new Database(path.join(root, "data"));
    const manager = new PluginManager(database, [pluginRoot], sessionsRoot); await manager.load();
    expect(manager.list()[0].manifest.browserAuth).toEqual({ loginUrl: "https://example.com/", sessionSetting: "cookiesFile" });
    const installed = manager.install("test.session", { cookiesFile: "sessionid=abc; csrf=def" });
    const sessionPath = installed.config.cookiesFile as string;
    expect(sessionPath).toBe(path.join(sessionsRoot, "test.session.txt"));
    expect(fs.statSync(sessionPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(sessionPath, "utf8")).toContain(".example.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc");
    expect(manager.list()[0].config.cookiesFile).toBe("••••••••");
    manager.configure("test.session", { cookiesFile: "# Netscape HTTP Cookie File\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsessionid\treplaced" });
    expect(fs.readFileSync(sessionPath, "utf8")).toContain("#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsessionid\treplaced");
    expect(manager.uninstall("test.session").config.cookiesFile).toBeUndefined();
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it("preserves imported raw JSON sessions for plugins that need structured authentication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-plugin-json-session-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins"); const sessionsRoot = path.join(root, "sessions");
    fs.mkdirSync(path.join(pluginRoot, "sample"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "sample", "index.mjs"), `export default { manifest: { id: "test.raw-session", name: "Raw session", version: "1", description: "Test", author: "Test", capabilities: [], settings: [{ key: "auth", label: "Authentication", type: "session", sessionFormat: "raw-json", required: true }] } };`);
    const database = new Database(path.join(root, "data"));
    const manager = new PluginManager(database, [pluginRoot], sessionsRoot); await manager.load();
    const installed = manager.install("test.raw-session", { auth: '{"sess":"secret","nested":{"value":1}}' });
    const sessionPath = installed.config.auth as string;
    expect(sessionPath).toBe(path.join(sessionsRoot, "test.raw-session.json"));
    expect(fs.statSync(sessionPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).toEqual({ sess: "secret", nested: { value: 1 } });
    expect(manager.list()[0].config.auth).toBe("••••••••");
    expect(() => manager.configure("test.raw-session", { auth: "not JSON" })).toThrow("valid JSON session file");
    manager.uninstall("test.raw-session");
    expect(fs.existsSync(sessionPath)).toBe(false);
  });
});
