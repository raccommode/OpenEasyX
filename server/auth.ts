import { randomBytes, scrypt as scryptCallback, createHmac, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Database } from "./database.js";

// Tuned for a 1GB single-core host: ~16MB peak, tens of milliseconds per hash.
// Argon2id would allocate ~64MB per hash here and is deliberately avoided.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(password: string | Buffer, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEYLEN, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

// Session lifetime: 30 days. A single admin user does not need rolling sessions.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Login brute-force protection. Small, bounded in-memory map.
const MAX_FAILS = 5;
const RATE_LIMIT_CAP = 512;

type FailEntry = { fails: number; until: number };

export class AuthService {
  private readonly secret: string;
  private readonly fails = new Map<string, FailEntry>();
  private readonly log: (line: string) => void;

  constructor(private readonly db: Database, secret?: string, log: (line: string) => void = () => {}) {
    this.log = log;
    if (!secret) {
      // No secret configured: sessions are ephemeral and lost on restart. This
      // is safe but forces re-login; operators should set EASYX_SESSION_SECRET.
      this.secret = randomBytes(32).toString("hex");
      this.log("EASYX_SESSION_SECRET not set; generated an ephemeral session secret (lost on restart, forcing re-login). Set EASYX_SESSION_SECRET to persist sessions.");
    } else if (secret.length < 16) {
      this.secret = secret;
      this.log("WARNING: EASYX_SESSION_SECRET is shorter than 16 characters; using it, but a longer random value is recommended.");
    } else {
      this.secret = secret;
    }
  }

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await deriveKey(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
    return `scrypt$${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
  }

  async verifyPassword(password: string, stored?: string): Promise<boolean> {
    if (!stored || !stored.startsWith("scrypt$")) return false;
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const [params, saltHex, hashHex] = parts.slice(1) as [string, string, string];
    const [N, r, p] = params.split(":").map(Number);
    if (!N || !r || !p) return false;
    const expected = Buffer.from(hashHex, "hex");
    let derived: Buffer;
    try {
      derived = await deriveKey(password, Buffer.from(saltHex, "hex"), { N, r, p, maxmem: SCRYPT_MAXMEM });
    } catch {
      return false;
    }
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  createSession(): string {
    const payload = Buffer.from(JSON.stringify({ uid: "admin", iat: Date.now(), exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  verifySession(value?: string): boolean {
    if (!value) return false;
    const dot = value.lastIndexOf(".");
    if (dot < 0) return false;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"))) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
      return typeof data.exp === "number" && data.exp > Date.now();
    } catch {
      return false;
    }
  }

  checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const entry = this.fails.get(ip);
    if (!entry) return { allowed: true, retryAfter: 0 };
    if (entry.until > Date.now()) return { allowed: false, retryAfter: Math.ceil((entry.until - Date.now()) / 1000) };
    return { allowed: true, retryAfter: 0 };
  }

  recordFailure(ip: string): void {
    const entry = this.fails.get(ip) ?? { fails: 0, until: 0 };
    entry.fails += 1;
    if (entry.fails >= MAX_FAILS) {
      const backoff = Math.min(60, 2 ** (entry.fails - MAX_FAILS + 1));
      entry.until = Date.now() + backoff * 1000;
    }
    this.fails.set(ip, entry);
    if (this.fails.size > RATE_LIMIT_CAP) {
      const oldest = this.fails.keys().next().value;
      if (oldest !== undefined) this.fails.delete(oldest);
    }
  }

  resetFailures(ip: string): void {
    this.fails.delete(ip);
  }

  private getPasswordHash(): string {
    return String((this.db.getSettings() as Record<string, unknown>)["admin_password_hash"] ?? "");
  }

  async verifyLogin(password: string): Promise<boolean> {
    return this.verifyPassword(password, this.getPasswordHash());
  }

  private async setPassword(password: string): Promise<void> {
    await this.db.updateSettings({ admin_password_hash: await this.hashPassword(password) });
  }

  /** Ensure a password exists; bootstrap from env or a generated one-time password. */
  async bootstrap(): Promise<void> {
    if (this.getPasswordHash()) return;
    const envPassword = process.env.EASYX_ADMIN_PASSWORD;
    if (envPassword && envPassword.length >= 8) {
      await this.setPassword(envPassword);
      this.log("Admin password initialized from EASYX_ADMIN_PASSWORD.");
      return;
    }
    if (envPassword) this.log("EASYX_ADMIN_PASSWORD was shorter than 8 characters; ignoring it and generating a random password instead.");
    const generated = randomBytes(9).toString("base64url").replace(/[-_]/g, "0");
    await this.setPassword(generated);
    this.log(`No admin password configured. Generated initial password: ${generated}  (change it immediately in Settings).`);
  }

  async changePassword(current: string, next: string): Promise<void> {
    if (!(await this.verifyPassword(current, this.getPasswordHash()))) {
      throw Object.assign(new Error("Current password is incorrect"), { statusCode: 401 });
    }
    if (next.length < 8) throw Object.assign(new Error("New password must be at least 8 characters"), { statusCode: 400 });
    await this.setPassword(next);
  }
}
