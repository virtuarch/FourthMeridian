/**
 * app/api/user/password/route.test.ts  (TEST-004)
 *
 * PATCH /api/user/password — REAL exported handler (wrapped in withApiHandler),
 * real session cookies, in-memory Prisma fake. Changing the password requires
 * the current one, demands a fresh session, and signs out every OTHER device.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/user/password/route.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";

const t = makeChecker("PATCH /api/user/password (TEST-004)");
const fake = new FakePrisma();
let PATCH: typeof import("./route").PATCH;
let STATUS: typeof import("@/app/api/user/totp/status/route").GET;
const OLD = "the old password";
const NEW = "a brand new password";
const change = (cookie: string | null, body: unknown) => invoke(PATCH, request("/api/user/password", { method: "PATCH", cookie, body }));
const alive = async (cookie: string) => { freshCache(); return (await invoke(STATUS, request("/api/user/totp/status", { cookie }))).status === 200; };

async function world() {
  fake.reset();
  freshCache();
  clearCapturedEmails();
  const alice = fake.seed("User", { email: "alice@example.test", username: "alice", passwordHash: await bcrypt.hash(OLD, 4), emailVerifiedAt: new Date() });
  const bob = fake.seed("User", { email: "bob@example.test", username: "bob", passwordHash: await bcrypt.hash(OLD, 4), emailVerifiedAt: new Date() });
  const here = await signIn(fake, alice.id as string);
  const phone = await signIn(fake, alice.id as string);
  const bobs = await signIn(fake, bob.id as string);
  return { alice, bob, here, phone, bobs };
}
const hashOf = (id: unknown) => fake.one("User", { id })!.passwordHash as string;

async function main() {
  await installFakePrisma(fake);
  ({ PATCH } = await import("./route"));
  ({ GET: STATUS } = await import("@/app/api/user/totp/status/route"));

  t.section("1. the right current password changes it and revokes every OTHER session");
  {
    const w = await world();
    const r = await change(w.here.cookie, { currentPassword: OLD, newPassword: NEW });
    t.check("200 { success: true }", r.status === 200 && r.body.success === true, r.body);
    t.check("the new password verifies, the old one does not", await bcrypt.compare(NEW, hashOf(w.alice.id)) && !(await bcrypt.compare(OLD, hashOf(w.alice.id))));
    t.check("the phone session is revoked and refused", fake.one("UserSession", { id: w.phone.sessionId })!.revokedAt instanceof Date && !(await alive(w.phone.cookie)));
    t.check("the session that made the change stays signed in", await alive(w.here.cookie));
    t.check("bob is untouched", await alive(w.bobs.cookie) && await bcrypt.compare(OLD, hashOf(w.bob.id)));
    const audit = fake.one("AuditLog", { action: "PASSWORD_CHANGED" })!;
    t.check("PASSWORD_CHANGED audit with revokedOtherSessions: 1", (audit.metadata as Record<string, unknown>).revokedOtherSessions === 1, audit.metadata);
    t.check("a security-alert e-mail + a PASSWORD_CHANGED notification",
      capturedEmails().some((m) => m.to === "alice@example.test") && fake.rows("Notification", { userId: w.alice.id, auditLogId: audit.id }).length === 1);
  }

  t.section("2. the wrong current password → 401, audited, nothing changes");
  {
    const w = await world();
    const r = await change(w.here.cookie, { currentPassword: "guess", newPassword: NEW });
    t.check("401 'Current password is incorrect.'", r.status === 401 && r.body.error === "Current password is incorrect.", r.body);
    t.check("password unchanged, no session revoked", await bcrypt.compare(OLD, hashOf(w.alice.id)) && fake.rows("UserSession", { revokedAt: { not: null } }).length === 0);
    t.check("PASSWORD_CHANGE_FAILED audited (reason wrong_current_password)",
      (fake.one("AuditLog", { action: "PASSWORD_CHANGE_FAILED" })?.metadata as Record<string, unknown>)?.reason === "wrong_current_password");
  }

  t.section("3. validation");
  {
    const w = await world();
    t.check("missing currentPassword → 400", (await change(w.here.cookie, { newPassword: NEW })).status === 400);
    t.check("missing newPassword → 400", (await change(w.here.cookie, { currentPassword: OLD })).status === 400);
    t.check("new == current → 400", (await change(w.here.cookie, { currentPassword: OLD, newPassword: OLD })).status === 400);
    fake.seed("PlatformSetting", { key: "min_password_length", value: "24" });
    const short = await change(w.here.cookie, { currentPassword: OLD, newPassword: NEW });
    t.check("below the admin-configured minimum (24) → 400 naming it", short.status === 400 && String(short.body.error).includes("24"));
    t.check("no refusal touched the password", await bcrypt.compare(OLD, hashOf(w.alice.id)));
  }

  t.section("4. session guards");
  {
    const w = await world();
    t.check("anonymous → 401", (await change(null, { currentPassword: OLD, newPassword: NEW })).status === 401);
    await alive(w.here.cookie); // warm the cache
    fake.one("UserSession", { id: w.here.sessionId })!.revokedAt = new Date();
    const r = await invoke(PATCH, request("/api/user/password", { method: "PATCH", cookie: w.here.cookie, body: { currentPassword: OLD, newPassword: NEW } }));
    t.check("a revoked session the cache still trusts → 401 (requireFreshUser)", r.status === 401, r.status);
    t.check("…password unchanged", await bcrypt.compare(OLD, hashOf(w.alice.id)));
    fake.seed("PlatformSetting", { key: "require_totp_all_users", value: "true" });
    t.check("a TOTP-pending session → 403", (await change(w.phone.cookie, { currentPassword: OLD, newPassword: NEW })).status === 403);
  }

  t.section("5. per-user limit (5 / 15 min) and the 500 envelope");
  {
    const w = await world();
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const s: number[] = [];
      for (let i = 0; i < 6; i++) s.push((await change(w.here.cookie, { currentPassword: "guess", newPassword: NEW })).status);
      t.check("5 answered (401), the 6th is 429", s.slice(0, 5).every((x) => x === 401) && s[5] === 429, s);
    } finally { delete process.env.RATE_LIMIT_ENABLED; }
    fake.on("User", "update", () => { throw new Error("db down"); }, { once: true });
    const crash = await change(w.here.cookie, { currentPassword: OLD, newPassword: NEW });
    t.check("an unexpected failure → withApiHandler's generic 500, other sessions NOT revoked",
      crash.status === 500 && crash.body.error === "Internal server error" && fake.rows("UserSession", { revokedAt: { not: null } }).length === 0, crash);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
