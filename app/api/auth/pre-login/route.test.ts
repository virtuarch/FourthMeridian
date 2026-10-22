/**
 * app/api/auth/pre-login/route.test.ts  (TEST-004)
 *
 * POST /api/auth/pre-login — the REAL handler against the in-memory Prisma fake.
 * The step before sign-in: it may only say anything specific once the PASSWORD
 * has been proved, and it fails CLOSED (503) when the limiter or the user store
 * cannot answer.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/auth/pre-login/route.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { limitByKey } from "@/lib/rate-limit";
import { LOGIN_CAPTCHA_THRESHOLD, LOGIN_ID_LIMIT, LOGIN_ID_WINDOW_SEC } from "@/lib/login-limits";

const t = makeChecker("POST /api/auth/pre-login (TEST-004)");
const fake = new FakePrisma();
let POST: typeof import("./route").POST;
let ip = 0;
const pre = (body: unknown, at = `198.51.100.${++ip % 250}`) => invoke(POST, request("/api/auth/pre-login", { body, ip: at }));
const PW = "the right password";
const env = process.env as Record<string, string | undefined>;

async function world() {
  fake.reset();
  const hash = await bcrypt.hash(PW, 4);
  const day = 86_400_000;
  fake.seed("User", { email: "ok@example.test", username: "ok", passwordHash: hash, emailVerifiedAt: new Date() });
  fake.seed("User", { email: "totp@example.test", username: "totp", passwordHash: hash, emailVerifiedAt: new Date(), totpEnabled: true, totpSecret: "x" });
  fake.seed("User", { email: "unverified@example.test", username: "unverified", passwordHash: hash });
  fake.seed("User", { email: "gone@example.test", username: "gone", passwordHash: hash, emailVerifiedAt: new Date(),
    deletionRequestedAt: new Date(), deletionScheduledAt: new Date(Date.now() + 30 * day), deactivatedAt: new Date() });
  fake.seed("User", { email: "off@example.test", username: "off", passwordHash: hash, emailVerifiedAt: new Date(), deactivatedAt: new Date(), totpEnabled: true, totpSecret: "x" });
}

async function main() {
  await installFakePrisma(fake);
  ({ POST } = await import("./route"));

  t.section("1. malformed input → 400 { ok: false }, before any lookup");
  {
    await world();
    t.check("missing password", (await pre({ identifier: "ok" })).status === 400);
    t.check("missing identifier", (await pre({ password: PW })).status === 400);
    t.check("unparseable JSON", (await invoke(POST, request("/api/auth/pre-login", { rawBody: "{", method: "POST" }))).status === 400);
    t.check("no user lookup happened", fake.callsTo("User").length === 0);
  }

  t.section("2. NON-ENUMERATION — wrong password and unknown account are indistinguishable");
  {
    await world();
    const unknown = await pre({ identifier: "nobody@example.test", password: PW });
    const wrong = await pre({ identifier: "ok@example.test", password: "nope" });
    const wrongUnverified = await pre({ identifier: "unverified", password: "nope" });
    const wrongGone = await pre({ identifier: "gone", password: "nope" });
    t.check("all 200 with the same body { ok: false, captchaRequired: false }",
      [unknown, wrong, wrongUnverified, wrongGone].every((r) => r.status === 200 && r.text === JSON.stringify({ ok: false, captchaRequired: false })),
      [unknown.text, wrong.text, wrongUnverified.text, wrongGone.text]);
  }

  t.section("3. only a PROVEN password unlocks specifics");
  {
    await world();
    const ok = await pre({ identifier: "  OK@Example.test ", password: PW });
    t.check("verified, no 2FA → { ok: true, totpRequired: false }", ok.body.ok === true && ok.body.totpRequired === false, ok.body);
    t.check("username works", (await pre({ identifier: "ok", password: PW })).body.ok === true);
    t.check("2FA account → totpRequired: true", (await pre({ identifier: "totp", password: PW })).body.totpRequired === true);
    t.check("unverified → reason 'unverified'", (await pre({ identifier: "unverified", password: PW })).body.reason === "unverified");
    const gone = await pre({ identifier: "gone", password: PW });
    t.check("pending deletion (wins over deactivated) → reason 'pending_deletion'", gone.body.ok === false && gone.body.reason === "pending_deletion", gone.body);
    const off = await pre({ identifier: "off", password: PW });
    t.check("deactivated → reason 'deactivated' + totpRequired (so the reactivation form asks for it)",
      off.body.reason === "deactivated" && off.body.totpRequired === true, off.body);
    t.check("pre-login never writes (no audit, no session)", fake.calls.every((c) => c.op.startsWith("find")));
  }

  t.section("4. CAPTCHA step-up after repeated sign-in attempts on one identifier");
  {
    await world();
    env.RATE_LIMIT_ENABLED = "true";
    try {
      for (let i = 0; i < LOGIN_CAPTCHA_THRESHOLD; i++) await limitByKey("ok@example.test", "login-id", { limit: LOGIN_ID_LIMIT, windowSec: LOGIN_ID_WINDOW_SEC });
      const r = await pre({ identifier: "OK@example.test", password: "nope" });
      t.check(`after ${LOGIN_CAPTCHA_THRESHOLD} attempts the failure says captchaRequired: true`, r.body.captchaRequired === true, r.body);
      t.check("another identifier is unaffected", (await pre({ identifier: "totp", password: "nope" })).body.captchaRequired === false);
    } finally {
      delete env.RATE_LIMIT_ENABLED;
    }
  }

  t.section("5. per-IP limit (10/min) — 429 with Retry-After");
  {
    await world();
    env.RATE_LIMIT_ENABLED = "true";
    // The limiter's windows are minute-ALIGNED (lib/rate-limit.ts check()), so
    // eleven requests that straddle a minute boundary land in two buckets and
    // all answer 200 — seen once under a loaded `npm run ci` (2026-10-22).
    // Hold the clock mid-window for the loop so the case tests the limit, not
    // the wall clock.
    const realNow = Date.now;
    const midWindow = Math.floor(realNow() / 60_000) * 60_000 + 30_000;
    Date.now = () => midWindow;
    try {
      const s: number[] = [];
      let last: Awaited<ReturnType<typeof pre>> | null = null;
      for (let i = 0; i < 11; i++) { last = await pre({ identifier: "nobody", password: "x" }, "192.0.2.11"); s.push(last.status); }
      t.check("10 answered, the 11th is 429", s.slice(0, 10).every((x) => x === 200) && s[10] === 429, s);
      t.check("Retry-After present", Number(last!.headers.get("retry-after")) > 0);
    } finally {
      Date.now = realNow;
      delete env.RATE_LIMIT_ENABLED;
    }
  }

  t.section("6. FAIL CLOSED — an unreachable authority is 503, never a credential verdict");
  {
    await world();
    fake.on("User", "findFirst", () => { throw new Error("P1001 can't reach database"); }, { once: true });
    const r = await pre({ identifier: "ok", password: PW });
    t.check("user store down → 503 { ok: false, reason: 'unavailable' }", r.status === 503 && r.body.reason === "unavailable" && r.body.ok === false, r);
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production"; // the DB-backed limiter
    try {
      fake.on("RateLimit", "upsert", () => { throw new Error("pool timeout"); }, { once: true });
      const l = await pre({ identifier: "ok", password: PW });
      t.check("limiter store down → 503 unavailable (strict limiter: no fail-open on auth)", l.status === 503 && l.body.reason === "unavailable", l);
      t.check("…and the password was never checked against the store", fake.callsTo("User", "findFirst").length === 1);
    } finally {
      env.NODE_ENV = prev;
    }
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
