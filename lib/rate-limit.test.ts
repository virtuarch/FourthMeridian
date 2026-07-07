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
  getClientIp,
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

  console.log(failures === 0 ? "\nAll rate-limit tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
