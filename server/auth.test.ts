import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { AuthService } from "./auth.js";
import type { Database } from "./database.js";

function stubDb(initialHash = ""): Database {
  const store: Record<string, unknown> = { admin_password_hash: initialHash };
  return {
    getSettings: () => store,
    updateSettings: (values: Record<string, unknown>) => { Object.assign(store, values); return store; },
  } as unknown as Database;
}

const SECRET = "test-secret-1234567890";

describe("AuthService", () => {
  it("hashes and verifies a correct password", async () => {
    const auth = new AuthService(stubDb(), SECRET);
    const hash = await auth.hashPassword("hunter2!");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await auth.verifyPassword("hunter2!", hash)).toBe(true);
    expect(await auth.verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects malformed or missing stored hashes", async () => {
    const auth = new AuthService(stubDb(), SECRET);
    expect(await auth.verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await auth.verifyPassword("anything")).toBe(false);
  });

  it("signs and verifies a session, rejects tampering", () => {
    const auth = new AuthService(stubDb(), SECRET);
    const token = auth.createSession();
    expect(auth.verifySession(token)).toBe(true);
    const tampered = `${token.slice(0, -2)}${token.endsWith("A") ? "B" : "A"}`;
    expect(auth.verifySession(tampered)).toBe(false);
    expect(auth.verifySession("garbage")).toBe(false);
    expect(auth.verifySession(undefined)).toBe(false);
  });

  it("invalidates sessions when the secret changes", () => {
    const a = new AuthService(stubDb(), "secret-one-1234567890");
    const b = new AuthService(stubDb(), "secret-two-1234567890");
    expect(b.verifySession(a.createSession())).toBe(false);
  });

  it("rejects expired sessions", () => {
    const auth = new AuthService(stubDb(), SECRET);
    const payload = Buffer.from(JSON.stringify({ uid: "admin", iat: 1, exp: Date.now() - 1000 })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(auth.verifySession(`${payload}.${sig}`)).toBe(false);
    // a freshly minted token is still valid
    expect(auth.verifySession(auth.createSession())).toBe(true);
  });

  it("rate limits after the failure threshold", () => {
    const auth = new AuthService(stubDb(), SECRET);
    const ip = "1.2.3.4";
    expect(auth.checkRateLimit(ip).allowed).toBe(true);
    for (let i = 0; i < 5; i++) auth.recordFailure(ip);
    const blocked = auth.checkRateLimit(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    auth.resetFailures(ip);
    expect(auth.checkRateLimit(ip).allowed).toBe(true);
  });

  it("bootstraps a password when none is configured", async () => {
    const db = stubDb();
    const auth = new AuthService(db, SECRET);
    await auth.bootstrap();
    const stored = String((db.getSettings() as Record<string, unknown>)["admin_password_hash"] ?? "");
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("changes password only after verifying the current one", async () => {
    const db = stubDb();
    const auth = new AuthService(db, SECRET);
    db.updateSettings({ admin_password_hash: await auth.hashPassword("current-pass") });
    await auth.changePassword("current-pass", "new-pass-1234");
    expect(await auth.verifyLogin("new-pass-1234")).toBe(true);
    expect(await auth.verifyLogin("current-pass")).toBe(false);
    await expect(auth.changePassword("wrong", "other-1234")).rejects.toMatchObject({ statusCode: 401 });
    await expect(auth.changePassword("new-pass-1234", "short")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("verifyLogin reflects the stored hash", async () => {
    const db = stubDb();
    const auth = new AuthService(db, SECRET);
    db.updateSettings({ admin_password_hash: await auth.hashPassword("topsecret-1") });
    expect(await auth.verifyLogin("topsecret-1")).toBe(true);
    expect(await auth.verifyLogin("nope")).toBe(false);
  });
});
