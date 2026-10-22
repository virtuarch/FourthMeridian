/**
 * app/api/auth/verify-email/route.test.ts  (TEST-004)
 *
 * POST /api/auth/verify-email and POST /api/auth/verify-email/resend — the REAL
 * exported handlers against the in-memory Prisma fake. Token hashing, the
 * shared rotate-and-send core (lib/email/verification.ts), the capture e-mail
 * transport and the limiter are production code.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/auth/verify-email/route.test.ts
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { hashResetToken } from "@/lib/password-reset-token";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";

const t = makeChecker("POST /api/auth/verify-email + /resend (TEST-004)");
const fake = new FakePrisma();
let VERIFY: typeof import("./route").POST;
let RESEND: typeof import("./resend/route").POST;
let ip = 0;
const verify = (body: unknown, at = `198.51.100.${++ip % 250}`) => invoke(VERIFY, request("/api/auth/verify-email", { body, ip: at }));
const resend = (body: unknown, at = `198.51.100.${++ip % 250}`) => invoke(RESEND, request("/api/auth/verify-email/resend", { body, ip: at }));
const HOUR = 3_600_000;

function world() {
  fake.reset();
  clearCapturedEmails();
  const raw = "a".repeat(64);
  const pending = fake.seed("User", { email: "pending@example.test", username: "pending", passwordHash: "x",
    emailVerificationToken: hashResetToken(raw), emailVerificationExpiry: new Date(Date.now() + HOUR) });
  const expiredRaw = "b".repeat(64);
  const expired = fake.seed("User", { email: "expired@example.test", username: "expired", passwordHash: "x",
    emailVerificationToken: hashResetToken(expiredRaw), emailVerificationExpiry: new Date(Date.now() - 1) });
  const done = fake.seed("User", { email: "done@example.test", username: "done", passwordHash: "x", emailVerifiedAt: new Date(Date.now() - HOUR) });
  return { raw, pending, expiredRaw, expired, done };
}
const tokenIn = (text: string | undefined) => /token=([0-9a-f]{64})/.exec(text ?? "")?.[1];

async function main() {
  await installFakePrisma(fake);
  ({ POST: VERIFY } = await import("./route"));
  ({ POST: RESEND } = await import("./resend/route"));

  t.section("1. verify — a valid token verifies once, then is idempotent");
  {
    const w = world();
    const r = await verify({ token: w.raw });
    t.check("200 { success: true, status: 'verified' }", r.status === 200 && r.body.status === "verified" && r.body.success === true, r.body);
    const u = fake.one("User", { id: w.pending.id })!;
    t.check("emailVerifiedAt is set", u.emailVerifiedAt instanceof Date);
    t.check("lookup was by the token's HASH, never the raw token",
      JSON.stringify(fake.callsTo("User", "findFirst")[0].args).includes(hashResetToken(w.raw))
      && !JSON.stringify(fake.callsTo("User", "findFirst")[0].args).includes(w.raw));
    const audit = fake.one("AuditLog", { action: "EMAIL_VERIFIED" });
    t.check("EMAIL_VERIFIED audit, keyed by the e-mail DIGEST only", !!audit && !JSON.stringify(audit).includes("example.test"));
    const again = await verify({ token: w.raw });
    t.check("a second click → 200 already_verified (grants nothing, no second audit)",
      again.status === 200 && again.body.status === "already_verified" && fake.rows("AuditLog", { action: "EMAIL_VERIFIED" }).length === 1);
  }

  t.section("2. verify — refusals");
  {
    const w = world();
    const ex = await verify({ token: w.expiredRaw });
    t.check("expired token → 400 { status: 'expired' }", ex.status === 400 && ex.body.status === "expired" && ex.body.success === false);
    t.check("…and the account stays unverified", fake.one("User", { id: w.expired.id })!.emailVerifiedAt === null);
    t.check("unknown token → 400 invalid", (await verify({ token: "c".repeat(64) })).body.status === "invalid");
    t.check("missing token → 400 invalid", (await verify({})).status === 400);
    t.check("non-string token → 400 invalid", (await verify({ token: 42 })).status === 400);
    t.check("malformed JSON → 400 invalid (not a 500)", (await invoke(VERIFY, request("/api/auth/verify-email", { rawBody: "{nope", method: "POST" }))).status === 400);
    t.check("no refusal wrote anything", fake.calls.every((c) => c.op !== "update" && c.op !== "create"));
  }

  t.section("3. resend by token — precise answers (the token is a bearer credential)");
  {
    const w = world();
    const r = await resend({ token: w.expiredRaw });
    t.check("an expired-but-known token → 200 { success, status: 'sent' }", r.status === 200 && r.body.status === "sent" && r.body.success === true, r.body);
    const u = fake.one("User", { id: w.expired.id })!;
    const mail = capturedEmails();
    const fresh = tokenIn(mail[0]?.text);
    t.check("one e-mail to the account address", mail.length === 1 && mail[0].to === "expired@example.test");
    t.check("the token was ROTATED: stored hash = hash(new raw), new expiry ~1h",
      !!fresh && u.emailVerificationToken === hashResetToken(fresh) && fresh !== w.expiredRaw
      && Math.abs((u.emailVerificationExpiry as Date).getTime() - Date.now() - HOUR) < 60_000);
    t.check("the OLD token no longer verifies", (await verify({ token: w.expiredRaw })).body.status === "invalid");
    t.check("the NEW token does", (await verify({ token: fresh! })).body.status === "verified");
    t.check("unknown token → 400 invalid", (await resend({ token: "d".repeat(64) })).body.status === "invalid");
    const verifiedRaw = "e".repeat(64);
    fake.seed("User", { email: "v2@example.test", username: "v2", passwordHash: "x", emailVerifiedAt: new Date(), emailVerificationToken: hashResetToken(verifiedRaw) });
    clearCapturedEmails();
    const av = await resend({ token: verifiedRaw });
    t.check("already-verified token → 200 already_verified, nothing sent", av.body.status === "already_verified" && capturedEmails().length === 0);
    const audit = fake.one("AuditLog", { action: "EMAIL_VERIFICATION_RESENT" });
    t.check("a resend writes EMAIL_VERIFICATION_RESENT", !!audit);
    // J-D1 FIXED: the resend audit stores emailHash.
    t.check("…keyed by the e-mail DIGEST, not the address (PRIV-002)",
      !!audit && !JSON.stringify(audit.metadata).includes("example.test") && typeof (audit.metadata as { emailHash?: unknown }).emailHash === "string");
  }

  t.section("4. resend by identifier — NON-ENUMERATING");
  {
    const w = world();
    const responses = await Promise.all([
      resend({ identifier: "Pending@Example.test" }),  // exists, unverified
      resend({ identifier: "done" }),                  // exists, verified (by username)
      resend({ identifier: "nobody@example.test" }),   // does not exist
    ]);
    const bodies = responses.map((r) => r.text);
    t.check("all three answer 200 with a byte-identical body", responses.every((r) => r.status === 200) && new Set(bodies).size === 1, bodies);
    t.check("the body is just { success: true }", bodies[0] === JSON.stringify({ success: true }));
    t.check("only the unverified account was mailed", capturedEmails().length === 1 && capturedEmails()[0].to === "pending@example.test");
    t.check("only the unverified account's token rotated", fake.one("User", { id: w.pending.id })!.emailVerificationToken !== hashResetToken(w.raw)
      && fake.one("User", { id: w.done.id })!.emailVerificationToken === null);
    t.check("neither token nor identifier → 400 invalid", (await resend({})).status === 400);
  }

  t.section("5. rate limits (per IP): verify 10 / resend 5 per 15 min");
  {
    world();
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const at = "192.0.2.50";
      const v: number[] = [];
      for (let i = 0; i < 11; i++) v.push((await verify({ token: "f".repeat(64) }, at)).status);
      t.check("verify: 10 answered, the 11th is 429", v.slice(0, 10).every((s) => s === 400) && v[10] === 429, v);
      const r: number[] = [];
      for (let i = 0; i < 6; i++) r.push((await resend({ identifier: "nobody" }, at)).status);
      t.check("resend: 5 answered, the 6th is 429 (separate bucket from verify)", r.slice(0, 5).every((s) => s === 200) && r[5] === 429, r);
    } finally {
      delete process.env.RATE_LIMIT_ENABLED;
    }
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
