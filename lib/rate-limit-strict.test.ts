/**
 * lib/rate-limit-strict.test.ts  (PS-4A)
 *
 * The authentication paths need the limiter to FAIL CLOSED: a store outage must
 * stop the attempt (→ temporary unavailability) rather than silently disable
 * brute-force protection. These tests execute checkStrict's three verdicts,
 * including the error path (via the injection seam, since the DB backend is
 * production-gated and never throws in test).
 */

import { checkStrict, type LimitVerdict } from "@/lib/rate-limit";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("PS-4A — rate limiter fail-closed policy");

// Enable limiting for this test process (dev/test default is off).
const prev = process.env.RATE_LIMIT_ENABLED;
const prevShadow = process.env.RATE_LIMIT_SHADOW;
process.env.RATE_LIMIT_ENABLED = "true";
delete process.env.RATE_LIMIT_SHADOW;

async function main() {
  // ── FAIL CLOSED: store throws (simulated P2024 / ECHECKOUTTIMEOUT) ──────────
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

  // ── Normal outcomes still work ──────────────────────────────────────────────
  const underLimit = async () => ({ limited: false, retryAfterSec: 42 });
  const v3 = await checkStrict("k", { limit: 5, windowSec: 60 }, underLimit);
  check("under limit ⇒ status 'ok'", v3.status === "ok");

  const overLimit = async () => ({ limited: true, retryAfterSec: 42 });
  const v4 = await checkStrict("k", { limit: 5, windowSec: 60 }, overLimit);
  check("over limit ⇒ status 'limited' with retryAfterSec", v4.status === "limited" && (v4 as { retryAfterSec: number }).retryAfterSec === 42);

  // ── Disabled ⇒ ok without touching the store (no accidental fail-closed) ─────
  process.env.RATE_LIMIT_ENABLED = "false";
  let touched = false;
  const spy = async () => { touched = true; return { limited: true, retryAfterSec: 1 }; };
  const v5 = await checkStrict("k", { limit: 5, windowSec: 60 }, spy);
  check("disabled ⇒ ok and store NOT consulted", v5.status === "ok" && touched === false);
  process.env.RATE_LIMIT_ENABLED = "true";

  // ── Store error is NOT reported as 'ok' (the fail-open bug it replaces) ──────
  check("fail-closed never returns 'ok' on a store throw", v1.status !== "ok" && v2.status !== "ok");
}

main()
  .then(() => {
    process.env.RATE_LIMIT_ENABLED = prev;
    if (prevShadow !== undefined) process.env.RATE_LIMIT_SHADOW = prevShadow;
    if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
    console.log("\nAll rate-limit fail-closed checks passed.");
  })
  .catch((e) => { console.error(e); process.exit(1); });
