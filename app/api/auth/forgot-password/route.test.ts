/**
 * app/api/auth/forgot-password/route.test.ts  (TEST-004)
 *
 * POST /api/auth/forgot-password — the REAL handler against the in-memory Prisma
 * fake. Proves the production response is NON-ENUMERATING (byte-identical for an
 * existing and an absent account), that the stored token is a hash of the one
 * mailed, and that the audit row carries the e-mail DIGEST (PRIV-002).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/auth/forgot-password/route.test.ts
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { hashResetToken } from "@/lib/password-reset-token";
import { auditEmailHash } from "@/lib/audit";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";

const t = makeChecker("POST /api/auth/forgot-password (TEST-004)");
const fake = new FakePrisma();
let POST: typeof import("./route").POST;
let ip = 0;
const forgot = (body: unknown, at = `198.51.100.${++ip % 250}`) => invoke(POST, request("/api/auth/forgot-password", { body, ip: at }));
const env = process.env as Record<string, string | undefined>;

function world() {
  fake.reset();
  clearCapturedEmails();
  return fake.seed("User", { email: "alice@example.test", username: "alice", passwordHash: "x", emailVerifiedAt: new Date() });
}

async function main() {
  await installFakePrisma(fake);
  ({ POST } = await import("./route"));

  t.section("1. an existing account (by e-mail, any case) gets a hashed, expiring token and a mailed link");
  {
    const u = world();
    const r = await forgot({ identifier: "  ALICE@example.test " });
    t.check("200 success", r.status === 200 && r.body.success === true, r.body);
    const row = fake.one("User", { id: u.id })!;
    const mail = capturedEmails();
    const raw = /token=([0-9a-f]{64})/.exec(mail[0]?.text ?? "")?.[1];
    t.check("one password-reset e-mail to the account address", mail.length === 1 && mail[0].to === "alice@example.test");
    t.check("the stored token is the HASH of the mailed one", !!raw && row.passwordResetToken === hashResetToken(raw) && row.passwordResetToken !== raw);
    t.check("expiry ~1h out", Math.abs((row.passwordResetExpiry as Date).getTime() - Date.now() - 3_600_000) < 60_000);
    const audit = fake.one("AuditLog", { action: "PASSWORD_RESET_REQUESTED" })!;
    t.check("PASSWORD_RESET_REQUESTED audit carries emailHash = auditEmailHash(address) (PRIV-002)",
      (audit.metadata as Record<string, unknown>).emailHash === auditEmailHash("alice@example.test"));
    t.check("…and no raw address anywhere in the row", !JSON.stringify(audit).includes("example.test"));
    t.check("by username works too", (await forgot({ identifier: "alice" })).status === 200 && capturedEmails().length === 2);
    t.check("a second request ROTATES the token (the first link dies)", fake.one("User", { id: u.id })!.passwordResetToken !== hashResetToken(raw!));
  }

  t.section("2. non-enumeration — PRODUCTION response is byte-identical for present and absent accounts");
  {
    world();
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const present = await forgot({ identifier: "alice@example.test" });
      const absent = await forgot({ identifier: "nobody@example.test" });
      t.check("both 200", present.status === 200 && absent.status === 200);
      t.check("identical bodies", present.text === absent.text, [present.text, absent.text]);
      t.check("no resetUrl / token in the production body", !present.text.includes("resetUrl") && !/[0-9a-f]{64}/.test(present.text));
      t.check("the present account was still mailed", capturedEmails().length === 1);
      t.check("production limiter used the DB backend (RateLimit upserts)", fake.callsTo("RateLimit", "upsert").length === 2);
    } finally {
      env.NODE_ENV = prev;
    }
  }

  t.section("3. DEV MODE (non-production, capture transport) exposes the link — by design, and only there");
  {
    world();
    const present = await forgot({ identifier: "alice@example.test" });
    const absent = await forgot({ identifier: "nobody@example.test" });
    t.check("present account: DEV MODE body with resetUrl", typeof present.body.resetUrl === "string" && String(present.body.message).startsWith("DEV MODE"));
    t.check("absent account: generic body, no resetUrl", !("resetUrl" in absent.body));
    t.check("the dev resetUrl is built from NEXT_PUBLIC_APP_URL, not the Host header",
      String(present.body.resetUrl).startsWith("https://app.test.invalid/"));
  }

  t.section("4. refusals and failure handling");
  {
    world();
    t.check("blank identifier → 400", (await forgot({ identifier: "   " })).status === 400);
    t.check("missing identifier → 400", (await forgot({})).status === 400);
    t.check("no lookup or write for a refusal", fake.calls.length === 0);
    fake.on("User", "findFirst", () => { throw new Error("db down"); }, { once: true });
    const crash = await forgot({ identifier: "alice" });
    t.check("a store failure is a generic 500 that says nothing about the account", crash.status === 500 && !crash.text.includes("alice"));
  }

  t.section("5. per-IP rate limit — 5 per 15 min");
  {
    world();
    env.RATE_LIMIT_ENABLED = "true";
    try {
      const s: number[] = [];
      for (let i = 0; i < 6; i++) s.push((await forgot({ identifier: "nobody" }, "192.0.2.9")).status);
      t.check("5 answered, the 6th is 429", s.slice(0, 5).every((x) => x === 200) && s[5] === 429, s);
      t.check("the limited request did no lookup", fake.callsTo("User", "findFirst").length === 5);
    } finally {
      delete env.RATE_LIMIT_ENABLED;
    }
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
