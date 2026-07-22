/**
 * lib/platform/convergence/correlation.test.ts
 *
 * PRE-V26-PLAID-CLOSE Phase 4 — semantic episode correlation
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/platform/convergence/correlation.test.ts
 *
 * The rule under test: an episode is a real operation, not a time bucket.
 * Events carrying a `correlationKey` cluster with that key and NOTHING else;
 * keyless ledgers keep the original 6-hour proximity behaviour.
 *
 * The bug this closes, from the Platform Ops investigation: a Chase sync run at
 * 11:03 and an unrelated American Express run at 12:08 were folded into ONE
 * episode purely because they fell inside six hours of each other — while a
 * single incident spanning a longer retry gap split into several.
 */

import { correlateEpisodes } from "./convergence";
import type { ConvergenceEvent } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ev = (at: string, over: Partial<ConvergenceEvent> = {}): ConvergenceEvent => ({
  at, ledger: "syncIssue", kind: "sync-issue", subject: "Chase",
  outcome: "degraded", detail: "critical · transactions · upsert error", tier: "observed",
  ...over,
});
const KEY_CHASE_R1 = "plaidItem:item_chase|run:r1";
const KEY_AMEX_R2  = "plaidItem:item_amex|run:r2";

// ── 1. The exact real-world false merge ─────────────────────────────────────
console.log("1. Chase 11:03 and Amex 12:08 must NOT be one episode");
{
  const eps = correlateEpisodes([
    ev("2026-07-22T11:03:58.241Z", { correlationKey: KEY_CHASE_R1, subject: "Chase" }),
    ev("2026-07-22T11:03:58.272Z", { correlationKey: KEY_CHASE_R1, subject: "Chase" }),
    ev("2026-07-22T11:03:58.275Z", { correlationKey: KEY_CHASE_R1, subject: "Chase" }),
    ev("2026-07-22T12:08:32.260Z", { correlationKey: KEY_AMEX_R2,  subject: "American Express" }),
  ]);
  check("two episodes, not one", eps.length === 2, `${eps.length}`);
  const chase = eps.find((e) => e.subjects.includes("Chase"));
  const amex  = eps.find((e) => e.subjects.includes("American Express"));
  check("the Chase run keeps its 3 events together", chase?.events.length === 3, `${chase?.events.length}`);
  check("the Amex run stands alone", amex?.events.length === 1);
  check("no episode spans both institutions",
    eps.every((e) => e.subjects.length === 1), JSON.stringify(eps.map((e) => e.subjects)));
}

// ── 2. Same item, DIFFERENT runs stay separate ──────────────────────────────
console.log("2. Same PlaidItem, different sync runs — separate incidents");
{
  const eps = correlateEpisodes([
    ev("2026-07-22T11:00:00.000Z", { correlationKey: "plaidItem:item_chase|run:r1" }),
    ev("2026-07-22T11:00:05.000Z", { correlationKey: "plaidItem:item_chase|run:r2" }),
  ]);
  check("five seconds apart but different runs ⇒ 2 episodes", eps.length === 2, `${eps.length}`);
}

// ── 3. One long incident is NOT split by a retry gap ────────────────────────
console.log("3. A retry 9 hours later still belongs to its own run's episode");
{
  // Same run id, far apart in time — proximity clustering would have split this.
  const eps = correlateEpisodes([
    ev("2026-07-22T01:00:00.000Z", { correlationKey: KEY_CHASE_R1 }),
    ev("2026-07-22T10:00:00.000Z", { correlationKey: KEY_CHASE_R1 }),
  ]);
  check("9-hour gap does NOT split a keyed episode", eps.length === 1, `${eps.length}`);
  check("both events are in it", eps[0].events.length === 2);
}

// ── 4. Legacy rows still never cross item boundaries ────────────────────────
console.log("4. Pre-Phase-4 rows (run:legacy) remain item-scoped");
{
  const eps = correlateEpisodes([
    ev("2026-07-20T22:08:11.000Z", { correlationKey: "plaidItem:item_amex|run:legacy",  subject: "American Express" }),
    ev("2026-07-20T22:08:12.000Z", { correlationKey: "plaidItem:item_chase|run:legacy", subject: "Chase" }),
  ]);
  check("the legacy fallback does NOT merge two items", eps.length === 2, `${eps.length}`);
  check("each keeps its own institution",
    eps.every((e) => e.subjects.length === 1));
}

// ── 5. Keyless ledgers keep proximity clustering ────────────────────────────
console.log("5. Jobs / alerts / status changes are unchanged");
{
  const jobs = [
    ev("2026-07-22T01:00:00.000Z", { ledger: "jobRun", kind: "job-failed", subject: "sync-banks", correlationKey: undefined }),
    ev("2026-07-22T01:05:00.000Z", { ledger: "alerts", kind: "alert-fired", subject: "alerts",     correlationKey: undefined }),
  ];
  check("nearby keyless events still cluster", correlateEpisodes(jobs).length === 1);

  const farApart = [
    ev("2026-07-22T01:00:00.000Z", { ledger: "jobRun", correlationKey: undefined }),
    ev("2026-07-22T20:00:00.000Z", { ledger: "jobRun", correlationKey: undefined }),
  ];
  check("keyless events beyond 6h still split", correlateEpisodes(farApart).length === 2);
}

// ── 6. Mixed keyed + keyless, and ordering ──────────────────────────────────
console.log("6. Mixed feed — keyed and keyless coexist, episodes stay chronological");
{
  const eps = correlateEpisodes([
    ev("2026-07-22T09:00:00.000Z", { ledger: "jobRun", subject: "sync-banks", correlationKey: undefined }),
    ev("2026-07-22T11:03:58.241Z", { correlationKey: KEY_CHASE_R1, subject: "Chase" }),
    ev("2026-07-22T12:08:32.260Z", { correlationKey: KEY_AMEX_R2,  subject: "American Express" }),
  ]);
  check("three distinct episodes", eps.length === 3, `${eps.length}`);
  check("a keyed sync issue never absorbs a keyless job event",
    eps.every((e) => e.events.length === 1));
  const times = eps.map((e) => e.from);
  check("episodes are ordered chronologically",
    times.join("|") === [...times].sort().join("|"), times.join(" , "));
  check("episode ids are unique", new Set(eps.map((e) => e.id)).size === eps.length);
}

// ── 7. Degenerate inputs ────────────────────────────────────────────────────
console.log("7. Degenerate inputs");
{
  check("empty feed ⇒ no episodes", correlateEpisodes([]).length === 0);
  check("a single keyed event ⇒ one episode",
    correlateEpisodes([ev("2026-07-22T11:00:00.000Z", { correlationKey: KEY_CHASE_R1 })]).length === 1);
}

console.log(failures === 0
  ? "\n✅ correlation: all checks passed"
  : `\n❌ correlation: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
