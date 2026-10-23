/**
 * lib/plaid/refreshCooldown.test.ts — the cooldown check is parameterised by the
 * customer's entitlement and backward compatible. Run: npx tsx lib/plaid/refreshCooldown.test.ts
 */
import { MANUAL_REFRESH_COOLDOWN_MS, checkManualRefreshCooldown, cooldownMsFromMinutes } from "./refreshCooldown";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const now = Date.parse("2026-10-08T10:00:00Z");
const minsAgo = (m: number) => new Date(now - m * 60_000);

check("default window is the catalogue's 60 minutes", MANUAL_REFRESH_COOLDOWN_MS === 60 * 60 * 1000);
check("never refreshed ⇒ off cooldown", !checkManualRefreshCooldown(null).onCooldown);
check("one-arg call keeps the 60-minute default (30 min ago ⇒ on cooldown)", checkManualRefreshCooldown(minsAgo(30), undefined, now).onCooldown);
check("a 15-minute entitlement lets a 30-minute-old attempt through", !checkManualRefreshCooldown(minsAgo(30), cooldownMsFromMinutes(15), now).onCooldown);
const c = checkManualRefreshCooldown(minsAgo(10), cooldownMsFromMinutes(15), now);
check("retryAfterSeconds is the remaining window", c.onCooldown && c.retryAfterSeconds === 5 * 60, String(c.retryAfterSeconds));
check("minutes → ms floors and clamps at zero", cooldownMsFromMinutes(15.9) === 15 * 60_000 && cooldownMsFromMinutes(-5) === 0);
check("a zero window never cools down", !checkManualRefreshCooldown(minsAgo(0), 0, now).onCooldown);

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
