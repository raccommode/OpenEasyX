import fs from "node:fs";
import type { PluginContext } from "../packages/plugin-sdk/index.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readAccountCookies(context: PluginContext, domain: string, providerName: string): Map<string, string> | undefined {
  const cookiesFile = text(context.config.cookiesFile);
  if (!cookiesFile) return undefined;
  let contents: string;
  try { contents = fs.readFileSync(cookiesFile, "utf8"); }
  catch { throw new Error(`The stored ${providerName} session could not be read. Reconnect the account in the integrated browser.`); }

  const expectedDomain = domain.replace(/^\./, "").toLowerCase();
  const now = Date.now() / 1000;
  const cookies = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.startsWith("#HttpOnly_") ? rawLine.slice("#HttpOnly_".length) : rawLine;
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const cookieDomain = parts[0].replace(/^\./, "").toLowerCase();
    const expiry = Number(parts[4]);
    if (!(cookieDomain === expectedDomain || cookieDomain.endsWith(`.${expectedDomain}`))) continue;
    if (Number.isFinite(expiry) && expiry > 0 && expiry <= now) continue;
    cookies.set(parts[5], parts.slice(6).join("\t"));
  }
  if (!cookies.size) throw new Error(`The ${providerName} session is missing or expired. Reconnect the account in the integrated browser.`);
  return cookies;
}

export function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function accountSignal(context: PluginContext, timeoutMs = 20_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}
