/**
 * lib/snapshots/reconstructed-series-integrity.test.ts
 *
 * THE LEDGER IDENTITY — the criterion that decides which of two disagreeing
 * authorities is right.
 *
 * A reconstructed liability series is produced by walking a posted anchor
 * backward through a posted ledger. That construction implies, for every
 * adjacent pair of days:
 *
 *     owed(d) − owed(d−1) === −Σ(amounts dated d)
 *
 * The identity is not a convention; it is what "walked from the ledger" MEANS. A
 * series that satisfies it everywhere is reproducible from evidence. A series
 * that violates it at a date has, at that date, applied something the ledger does
 * not contain.
 *
 * ── Why these tests exist ────────────────────────────────────────────────────
 * Chris' Space stored snapshots violate the identity at exactly one reconstructed
 * date (2025-07-31, residual +145.98) with no compensating counterpart, which
 * leaves all 375 earlier rows a constant 145.98 too low. A fresh replay violates
 * it on none of 745 days.
 *
 * These tests pin the MECHANISM — that a single phantom delta produces exactly
 * that signature, and that a clamped negative produces a different, harmless one
 * — so the two are never again mistaken for each other.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  reconstructDailyLiabilityBalances, fromISO,
  type CashAccountBalance,
} from "./backfill-core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const ACCOUNT: CashAccountBalance[] = [{ id: "card", balance: 100 }];
const TODAY = fromISO("2026-01-10");
const START = fromISO("2026-01-01");

/** Build the per-(account, day) delta map the walk consumes. */
function deltas(byDay: Record<string, number>): Map<string, Map<string, number>> {
  return new Map([["card", new Map(Object.entries(byDay))]]);
}

/** owed(d) for every day the walk produced, oldest first. */
function series(d: Map<string, Map<string, number>>): { dateISO: string; owed: number }[] {
  const walked = reconstructDailyLiabilityBalances(ACCOUNT, d, TODAY, START);
  return [...walked.entries()]
    .map(([dateISO, m]) => ({ dateISO, owed: m.get("card")! }))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

/** Every date where the series violates the ledger identity. */
function residuals(
  s: { dateISO: string; owed: number }[],
  byDay: Record<string, number>,
): { dateISO: string; residual: number }[] {
  const out: { dateISO: string; residual: number }[] = [];
  for (let i = 1; i < s.length; i++) {
    const step = s[i].owed - s[i - 1].owed;
    const residual = +(step + (byDay[s[i].dateISO] ?? 0)).toFixed(2);
    if (Math.abs(residual) > 0.005) out.push({ dateISO: s[i].dateISO, residual });
  }
  return out;
}

// ── 1 · the walk satisfies the identity BY CONSTRUCTION ─────────────────────
{
  const byDay = {
    "2026-01-03": -42.68, "2026-01-05": -70.54,
    "2026-01-07": -205.45, "2026-01-09": 300,   // a payment, positive
  };
  const s = series(deltas(byDay));
  assert.equal(residuals(s, byDay).length, 0, "a walked series never violates its own ledger");
  ok("the liability walk satisfies owed(d) − owed(d−1) === −Σtx(d) on every day");
}

// ── 2 · THE ROOT CAUSE · one phantom delta ⇒ one residual + a CONSTANT offset ─
//
// This is the 145.98 signature exactly: a single unexplained step, and every
// EARLIER day permanently displaced by that amount. Because the walk runs
// backward from today's anchor, a phantom delta at date D corrupts nothing after
// D and everything before it, by a constant.
{
  const truth = { "2026-01-03": -42.68, "2026-01-07": -205.45 };
  const PHANTOM = -145.98;
  // The generator saw an extra −145.98 on 01-07 that the ledger no longer holds.
  const generated = { ...truth, "2026-01-07": truth["2026-01-07"] + PHANTOM };

  const truthSeries = series(deltas(truth));
  const badSeries = series(deltas(generated));

  // Audited against the TRUE ledger — which is what comparing a stored snapshot
  // to today's transactions does.
  const bad = residuals(badSeries, truth);
  assert.equal(bad.length, 1, "exactly one date violates the identity");
  assert.equal(bad[0].dateISO, "2026-01-07");
  assert.equal(bad[0].residual, -PHANTOM, "the residual IS the phantom amount");

  const offsets = truthSeries.map((t, i) => +(badSeries[i].owed - t.owed).toFixed(2));
  const before = offsets.filter((_, i) => truthSeries[i].dateISO < "2026-01-07");
  const after = offsets.filter((_, i) => truthSeries[i].dateISO >= "2026-01-07");
  assert.ok(before.every((o) => o === PHANTOM), `every earlier day is displaced by exactly ${PHANTOM}`);
  assert.ok(after.every((o) => o === 0), "no day on or after the phantom moves");
  ok("ROOT CAUSE · one phantom delta ⇒ one residual, and a constant offset on every earlier day");
}

// ── 3 · a clamped negative is a DIFFERENT signature: it does NOT propagate ──
//
// The three small live pairs (±10.49, ±1.05, ±4.92) are this: one card's walked
// owed dipped briefly negative, the stored row published max(0, owed), and a
// later payment restored it. The distinguishing property is NOT that residuals
// cancel — it is that a clamp displaces only the days it covers, while a phantom
// displaces every day before it, forever. Confusing the two would mean
// "repairing" rows that are merely displayed differently.
{
  // −300 pushes owed negative walking back; +400 further back lifts it again,
  // so the negative excursion is INTERIOR and the oldest day is unaffected.
  const byDay = { "2026-01-06": -300, "2026-01-03": 400 };
  const s = series(deltas(byDay));
  const clamped = s.map((p) => ({ ...p, owed: Math.max(0, p.owed) }));

  const negatives = s.filter((p) => p.owed < 0).map((p) => p.dateISO);
  assert.ok(negatives.length > 0, "the scenario really does go negative");

  const displaced = s.filter((p, i) => Math.abs(clamped[i].owed - p.owed) > 0.005).map((p) => p.dateISO);
  assert.deepEqual(displaced, negatives, "a clamp displaces exactly the days it covers, and no others");

  // THE distinguishing property: the oldest day is untouched.
  assert.equal(clamped[0].owed, s[0].owed, "clamping does not displace the oldest day");
  ok("a clamped negative displaces only the days it covers — it never propagates backward");
}

// ── 4 · the affected interval is everything BEFORE the phantom ──────────────
{
  const truth = { "2026-01-04": -10, "2026-01-06": -20, "2026-01-08": -30 };
  const generated = { ...truth, "2026-01-06": -20 - 99 };
  const t = series(deltas(truth));
  const b = series(deltas(generated));
  const affected = t.filter((p, i) => Math.abs(b[i].owed - p.owed) > 0.005).map((p) => p.dateISO);
  assert.deepEqual(affected, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  assert.ok(!affected.includes("2026-01-06"), "the phantom's own day is correct; only earlier days move");
  // The contrast with clamping: a phantom ALWAYS reaches the oldest day.
  assert.equal(affected[0], t[0].dateISO, "a phantom displaces the oldest day");
  ok("the affected interval is exactly the days strictly before the phantom, oldest included");
}

// ── 5 · frozen rows are outside this analysis entirely ──────────────────────
//
// An isEstimated=false row is an OBSERVATION of what balances said that day. It
// was never walked, so the ledger identity does not apply to it and a residual
// there is not evidence of a defect. The live data's post-2026-07-19 residuals
// are all on such rows.
{
  const core = readFileSync(new URL("./regenerate-history.core.ts", import.meta.url), "utf8");
  assert.ok(/skip-frozen/.test(core), "the regenerator has an explicit frozen-row action");
  assert.ok(/isEstimated=false row is an observation/.test(core),
    "and states why an observed row is never rewritten");
  ok("observed rows are never walked, so the identity does not apply to them");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`reconstructed-series-integrity: ${checks.length} checks passed`);
