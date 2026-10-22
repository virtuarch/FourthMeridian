/**
 * app/api/auth/reset-password/route.test.ts  (TEST-004)
 *
 * POST /api/auth/reset-password — the REAL handler against the in-memory Prisma
 * fake. A valid token resets the password, is consumed (single use) and revokes
 * EVERY session — proved end to end: a session cookie that authenticated a real
 * route before the reset is refused after it. Expired and reused tokens are
 * refused, and two concurrent redemptions of one token (IDEMP-011, the
 * conditional `updateMany`) yield exactly one success.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/auth/reset-password/route.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn } from "@/lib/test-support/route-harness";
import { hashResetToken } from "@/lib/password-reset-token";
import { auditEmailHash } from "@/lib/audit";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";

const t = makeChecker("POST /api/auth/reset-password (TEST-004)");
const fake = new FakePrisma();
let POST: typeof import("./route").POST;
let STATUS: typeof import("@/app/api/user/totp/status/route").GET;
let ip = 0;
const reset = (body: unknown, at = `198.51.100.${++ip % 250}`) => invoke(POST, request("/api/auth/reset-password", { body, ip: at }));
const RAW = "1".repeat(64);
const OLD = "old password 123";

async function world(expiresInMs = 3_600_000) {
  fake.reset();
  clearCapturedEmails();
  const u = fake.seed("User", { email: "alice@example.test", username: "alice", passwordHash: await bcrypt.hash(OLD, 4),
    emailVerifiedAt: new Date(), passwordResetToken: hashResetToken(RAW), passwordResetExpiry: new Date(Date.now() + expiresInMs) });
  return u;
}

async function main() {
  await installFakePrisma(fake);
  ({ POST } = await import("./route"));
  ({ GET: STATUS } = await import("@/app/api/user/totp/status/route"));

  t.section("1. a valid token resets the password, is consumed, and revokes every session");
  {
    const u = await world();
    const phone = await signIn(fake, u.id as string);
    const laptop = await signIn(fake, u.id as string);
    const before = await invoke(STATUS, request("/api/user/totp/status", { cookie: phone.cookie }));
    t.check("control: the phone session authenticates a real route before the reset", before.status === 200, before.status);
    const r = await reset({ token: RAW, password: "brand new password" });
    t.check("200 { success: true }", r.status === 200 && r.body.success === true, r.body);
    const row = fake.one("User", { id: u.id })!;
    t.check("the new password verifies; the old one does not",
      await bcrypt.compare("brand new password", row.passwordHash as string) && !(await bcrypt.compare(OLD, row.passwordHash as string)));
    t.check("the token and its expiry are nulled (single use)", row.passwordResetToken === null && row.passwordResetExpiry === null);
    t.check("both sessions are revoked in the store", fake.rows("UserSession", { userId: u.id, revokedAt: null }).length === 0
      && fake.rows("UserSession", { userId: u.id }).length === 2);
    const after = await invoke(STATUS, request("/api/user/totp/status", { cookie: phone.cookie }));
    const after2 = await invoke(STATUS, request("/api/user/totp/status", { cookie: laptop.cookie }));
    t.check("…and the SAME cookies are now refused by a real route (401)", after.status === 401 && after2.status === 401, [after.status, after2.status]);
    const audit = fake.one("AuditLog", { action: "PASSWORD_RESET_COMPLETE" })!;
    const meta = audit.metadata as Record<string, unknown>;
    t.check("PASSWORD_RESET_COMPLETE audit: emailHash digest + revokedSessions = 2",
      meta.emailHash === auditEmailHash("alice@example.test") && meta.revokedSessions === 2 && !JSON.stringify(audit).includes("example.test"), meta);
    t.check("a security-alert e-mail goes to the account", capturedEmails().some((m) => m.to === "alice@example.test" && /password was reset/i.test(m.subject + m.text)));
    t.check("a PASSWORD_RESET notification is linked to the audit row", fake.rows("Notification", { userId: u.id, auditLogId: audit.id }).length === 1);
    const reused = await reset({ token: RAW, password: "another new password" });
    t.check("REUSING the token → 400 invalid-or-expired", reused.status === 400 && String(reused.body.error).includes("invalid or has expired"));
    t.check("…and the password did not change again", await bcrypt.compare("brand new password", fake.one("User", { id: u.id })!.passwordHash as string));
  }

  t.section("2. refusals");
  {
    const u = await world(-1);
    const ex = await reset({ token: RAW, password: "brand new password" });
    t.check("an EXPIRED token → 400, password unchanged", ex.status === 400 && await bcrypt.compare(OLD, fake.one("User", { id: u.id })!.passwordHash as string));
    await world();
    t.check("an unknown token → 400", (await reset({ token: "2".repeat(64), password: "brand new password" })).status === 400);
    t.check("missing token → 400", (await reset({ password: "brand new password" })).status === 400);
    t.check("missing password → 400", (await reset({ token: RAW })).status === 400);
    const short = await reset({ token: RAW, password: "short" });
    t.check("a password below the policy minimum → 400 naming it", short.status === 400 && String(short.body.error).includes("8"));
    t.check("no refusal touched the password or a session", fake.callsTo("User", "updateMany").length === 0 && fake.callsTo("UserSession").length === 0);
  }

  t.section("3. IDEMP-011 — two concurrent redemptions of ONE token: exactly one wins");
  {
    const u = await world();
    await signIn(fake, u.id as string);
    const [a, b] = await Promise.all([
      reset({ token: RAW, password: "winner password A" }),
      reset({ token: RAW, password: "winner password B" }),
    ]);
    t.check("control: both requests passed the token lookup (the race was real)",
      fake.callsTo("User", "findFirst").length === 2, fake.callsTo("User", "findFirst").length);
    const statuses = [a.status, b.status].sort();
    t.check("one 200, one 400", statuses[0] === 200 && statuses[1] === 400, statuses);
    const winner = a.status === 200 ? "winner password A" : "winner password B";
    const loser = a.status === 200 ? "winner password B" : "winner password A";
    const hash = fake.one("User", { id: u.id })!.passwordHash as string;
    t.check("the stored password is the WINNER's, never the loser's", await bcrypt.compare(winner, hash) && !(await bcrypt.compare(loser, hash)));
    t.check("exactly one completion audit and one session revocation pass",
      fake.rows("AuditLog", { action: "PASSWORD_RESET_COMPLETE" }).length === 1 && fake.callsTo("UserSession", "updateMany").length === 1);
  }

  t.section("4. per-IP rate limit — 10 per 15 min");
  {
    await world();
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const s: number[] = [];
      for (let i = 0; i < 11; i++) s.push((await reset({ token: "3".repeat(64), password: "brand new password" }, "192.0.2.10")).status);
      t.check("10 answered, the 11th is 429", s.slice(0, 10).every((x) => x === 400) && s[10] === 429, s);
    } finally {
      delete process.env.RATE_LIMIT_ENABLED;
    }
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
