/**
 * lib/rate-limit.test.ts  (OPS-1 S4)
 *
 * Standalone tsx script (house pattern — no jest/vitest):
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs lib/rate-limit.test.ts
 *
 * Exits 0 when all cases pass, 1 on failure. Runs credential-free and
 * DB-free: NODE_ENV is never "production" here, so the limiter uses its
 * in-memory backend and lib/db is imported but never queried.
 *
 * Covers:
 *   1. Flag polarity (isRateLimitingEnabled): prod default-ON with explicit
 *      "false" opt-out; dev/test opt-IN with "true".
 *   2. Pass-through when disabled — no blocking regardless of volume.
 *   3. Enforcement + key behavior: N allowed, N+1 → 429 with Retry-After;
 *      buckets are independent per route name, per IP, per user, per key.
 *   4. Shadow mode: over-limit returns null (logged, never blocked).
 *   5. getClientIp: x-forwarded-for first hop → x-real-ip → "unknown".
 *   7. checkStrict fail-closed verdicts (PS-4A, merged from
 *      lib/rate-limit-strict.test.ts) — runs AFTER the env-dependent sections
 *      above and restores the flag state it mutates.
 */

// Set BEFORE import: lib/rate-limit → lib/db instantiates a PrismaClient;
// give it a syntactically valid URL (never connected to — see header).
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.RATE_LIMIT_SHADOW;

import {
  isRateLimitingEnabled,
  limitByIp,
  limitByUser,
  limitByKey,
  peekKey,
  getClientIp,
  checkStrict,
  type LimitVerdict,
} from "@/lib/rate-limit";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const envw = process.env as Record<string, string | undefined>;

function fakeReq(ip: string): Request {
  return new Request("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

async function main(): Promise<void> {
  // ── 1. Polarity ─────────────────────────────────────────────────────────────
  console.log("1. isRateLimitingEnabled polarity (OPS-1 S4)");

  envw.NODE_ENV = "production";
  delete envw.RATE_LIMIT_ENABLED;
  check("production + unset → ENABLED (default-on)", isRateLimitingEnabled());
  envw.RATE_LIMIT_ENABLED = "false";
  check('production + "false" → disabled (explicit opt-out)', !isRateLimitingEnabled());
  envw.RATE_LIMIT_ENABLED = "true";
  check('production + "true" → enabled', isRateLimitingEnabled());

  envw.NODE_ENV = "test";
  delete envw.RATE_LIMIT_ENABLED;
  check("dev/test + unset → disabled (opt-in)", !isRateLimitingEnabled());
  envw.RATE_LIMIT_ENABLED = "true";
  check('dev/test + "true" → enabled', isRateLimitingEnabled());

  // ── 2. Disabled → pure pass-through ─────────────────────────────────────────
  console.log("2. Disabled flag is a pass-through");
  delete envw.RATE_LIMIT_ENABLED;
  let blocked = false;
  for (let i = 0; i < 25; i++) {
    if (await limitByIp(fakeReq("9.9.9.9"), "off-test", { limit: 3, windowSec: 60 })) blocked = true;
  }
  check("25 calls at limit=3 never block when disabled", !blocked);

  // ── 3. Enforcement + key behavior ───────────────────────────────────────────
  console.log("3. Enforcement and key independence");
  envw.RATE_LIMIT_ENABLED = "true";

  const cfg = { limit: 3, windowSec: 3600 }; // long window: no reset mid-test
  let res: Response | null = null;
  for (let i = 0; i < 3; i++) {
    res = await limitByIp(fakeReq("1.1.1.1"), "enforce-test", cfg);
  }
  check("first N (limit) calls pass", res === null);

  const fourth = await limitByIp(fakeReq("1.1.1.1"), "enforce-test", cfg);
  check("call N+1 is blocked", fourth !== null);
  check("blocked response is a 429", fourth?.status === 429);
  check(
    "429 carries Retry-After",
    !!fourth && Number(fourth.headers.get("Retry-After")) >= 1,
    `Retry-After=${fourth?.headers.get("Retry-After")}`,
  );

  const otherIp = await limitByIp(fakeReq("2.2.2.2"), "enforce-test", cfg);
  check("different IP has an independent bucket", otherIp === null);

  const otherRoute = await limitByIp(fakeReq("1.1.1.1"), "other-route", cfg);
  check("different route name has an independent bucket", otherRoute === null);

  let userRes: Response | null = null;
  for (let i = 0; i < 4; i++) {
    userRes = await limitByUser("user-a", "user-test", cfg);
  }
  check("limitByUser blocks after limit", userRes?.status === 429);
  check("other user unaffected", (await limitByUser("user-b", "user-test", cfg)) === null);

  let keyRes: Response | null = null;
  for (let i = 0; i < 4; i++) {
    keyRes = await limitByKey("alice@example.com", "login-id", cfg);
  }
  check("limitByKey (login identifier) blocks after limit", keyRes?.status === 429);
  check(
    "other identifier unaffected",
    (await limitByKey("bob@example.com", "login-id", cfg)) === null,
  );

  // ── 4. Shadow mode ──────────────────────────────────────────────────────────
  console.log("4. Shadow mode logs but never blocks");
  envw.RATE_LIMIT_SHADOW = "true";
  let shadowBlocked = false;
  for (let i = 0; i < 10; i++) {
    if (await limitByIp(fakeReq("3.3.3.3"), "shadow-test", cfg)) shadowBlocked = true;
  }
  check("10 calls at limit=3 never block in shadow mode", !shadowBlocked);
  delete envw.RATE_LIMIT_SHADOW;

  // ── 5. getClientIp ──────────────────────────────────────────────────────────
  console.log("5. getClientIp extraction");
  check(
    "x-forwarded-for first hop wins",
    getClientIp(new Request("http://x/", { headers: { "x-forwarded-for": "5.5.5.5, 6.6.6.6" } })) === "5.5.5.5",
  );
  check(
    "x-real-ip fallback",
    getClientIp(new Request("http://x/", { headers: { "x-real-ip": "7.7.7.7" } })) === "7.7.7.7",
  );
  check("no headers → 'unknown'", getClientIp(new Request("http://x/")) === "unknown");

  // ── 6. peekKey (Wave 2 ⑥ — CAPTCHA step-up read) ────────────────────────────
  console.log("6. peekKey reads the bucket without incrementing");
  const WIN = 3600;

  // Untouched identifier → 0.
  check("peek of an untouched key → 0", (await peekKey("nobody@example.com", "login-id", WIN)) === 0);

  // Drive the SAME (key, name, window) bucket up with limitByKey, then peek.
  const peekCfg = { limit: 100, windowSec: WIN }; // high limit: never blocks here
  for (let i = 0; i < 4; i++) {
    await limitByKey("peek@example.com", "login-id", peekCfg);
  }
  check("peek reflects 4 prior increments", (await peekKey("peek@example.com", "login-id", WIN)) === 4);

  // Peeking must NOT increment — repeated peeks return the same value.
  const p1 = await peekKey("peek@example.com", "login-id", WIN);
  const p2 = await peekKey("peek@example.com", "login-id", WIN);
  check("peek does not increment (stable across reads)", p1 === 4 && p2 === 4);

  // A subsequent real increment moves it, proving peek never touched the count.
  await limitByKey("peek@example.com", "login-id", peekCfg);
  check("count advances only on limitByKey, not peek", (await peekKey("peek@example.com", "login-id", WIN)) === 5);

  // Independent per (name) and per (key).
  check("peek is bucket-scoped by name", (await peekKey("peek@example.com", "other-name", WIN)) === 0);
  check("peek is bucket-scoped by key", (await peekKey("someone-else@example.com", "login-id", WIN)) === 0);

  // ── 7. checkStrict fail-closed verdicts (PS-4A) ─────────────────────────────
  // merged from lib/rate-limit-strict.test.ts. The authentication paths need the
  // limiter to FAIL CLOSED: a store outage must stop the attempt (→ temporary
  // unavailability) rather than silently disable brute-force protection. These
  // execute checkStrict's three verdicts, including the error path (via the
  // injection seam, since the DB backend is production-gated and never throws in
  // test). Both suites mutate process.env in one process, so this block runs
  // AFTER every env-dependent section above and restores the flags it touches.
  console.log("7. checkStrict fail-closed policy (PS-4A)");

  // Enable limiting for this block (and restore afterwards).
  const prevEnabled = envw.RATE_LIMIT_ENABLED;
  const prevShadow = envw.RATE_LIMIT_SHADOW;
  envw.RATE_LIMIT_ENABLED = "true";
  delete envw.RATE_LIMIT_SHADOW;

  // FAIL CLOSED: store throws (simulated P2024 / ECHECKOUTTIMEOUT).
  const throwP2024 = async (): Promise<never> => {
    const e = new Error("Timed out fetching a new connection from the connection pool. (connection_limit: 1)");
    (e as unknown as { code: string }).code = "P2024";
    throw e;
  };
  const throwCheckout = async (): Promise<never> => {
    throw new Error("FATAL: (ECHECKOUTTIMEOUT) unable to check out connection from the pool after 60000ms in Transaction mode");
  };

  const v1: LimitVerdict = await checkStrict("k", { limit: 5, windowSec: 60 }, throwP2024);
  check("simulated P2024 ⇒ status 'unavailable' (fail CLOSED, not open)", v1.status === "unavailable");

  const v2: LimitVerdict = await checkStrict("k", { limit: 5, windowSec: 60 }, throwCheckout);
  check("simulated ECHECKOUTTIMEOUT ⇒ status 'unavailable'", v2.status === "unavailable");

  // Normal outcomes still work.
  const underLimit = async () => ({ limited: false, retryAfterSec: 42 });
  const v3 = await checkStrict("k", { limit: 5, windowSec: 60 }, underLimit);
  check("under limit ⇒ status 'ok'", v3.status === "ok");

  const overLimit = async () => ({ limited: true, retryAfterSec: 42 });
  const v4 = await checkStrict("k", { limit: 5, windowSec: 60 }, overLimit);
  check("over limit ⇒ status 'limited' with retryAfterSec", v4.status === "limited" && (v4 as { retryAfterSec: number }).retryAfterSec === 42);

  // Disabled ⇒ ok without touching the store (no accidental fail-closed).
  envw.RATE_LIMIT_ENABLED = "false";
  let touched = false;
  const spy = async () => { touched = true; return { limited: true, retryAfterSec: 1 }; };
  const v5 = await checkStrict("k", { limit: 5, windowSec: 60 }, spy);
  check("disabled ⇒ ok and store NOT consulted", v5.status === "ok" && touched === false);
  envw.RATE_LIMIT_ENABLED = "true";

  // Store error is NOT reported as 'ok' (the fail-open bug it replaces).
  check("fail-closed never returns 'ok' on a store throw", v1.status !== "ok" && v2.status !== "ok");

  // Restore the env exactly as the earlier sections left it.
  if (prevEnabled === undefined) delete envw.RATE_LIMIT_ENABLED;
  else envw.RATE_LIMIT_ENABLED = prevEnabled;
  if (prevShadow === undefined) delete envw.RATE_LIMIT_SHADOW;
  else envw.RATE_LIMIT_SHADOW = prevShadow;

  console.log(failures === 0 ? "\nAll rate-limit tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
