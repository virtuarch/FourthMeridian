/**
 * lib/connections/coverage-loading-pending.test.ts   (S2 ruling 2026-11-03)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/coverage-loading-pending.test.ts
 *
 * While the client's data-health balance-coverage read is still LOADING, every
 * coverage-governed change (debt, net worth, liabilities, liquid net worth,
 * assets, cash) renders PENDING ("—"). It used to read as `null` — the same
 * value as "nothing to cover" — so the change rendered, then was RETRACTED
 * when the floors arrived: a brief false claim. Invested is never governed and
 * renders immediately. A payload MISSING the `balanceCoverage` key (version
 * skew mid-deploy) is unavailable, never null. Synthetic fixtures only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "@/types";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { debtWindowChange } from "@/components/space/widgets/debt/debt-trend-points";
import { DebtHero } from "@/components/space/widgets/debt/DebtHero";
import { WealthHero } from "@/components/space/widgets/wealth/WealthHero";
import { wealthChangeGate } from "@/components/space/widgets/wealth/wealth-change-gate";
import { BalanceCoverageNote } from "@/components/space/widgets/shared/BalanceCoverageNote";
import { FAILED_DATA_HEALTH, balanceCoverageState, parseBalanceCoverage } from "@/components/space/PerspectiveEmptyState";
import {
  BALANCE_COVERAGE_LOADING, BALANCE_COVERAGE_PENDING_MESSAGE, BALANCE_COVERAGE_UNAVAILABLE,
  changeComparability, isBalanceCoverageLoading, type BalanceCoverage, type ClientBalanceCoverage,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TODAY = "2026-11-03";
const FROM  = "2026-06-17";
// A floor INSIDE the window: once resolved, the governed changes are withheld —
// exactly the case where an early render would have been retracted.
const COV: BalanceCoverage = { liabilityFloors: ["2026-09-01"], assetFloors: [], estimatedLiabilityFloors: [] };
const DEBT_POINTS = [
  { date: FROM, totalDebt: 1_000, isEstimated: true },
  { date: "2026-09-01", totalDebt: 1_500, isEstimated: true },
  { date: TODAY, totalDebt: 2_000, isEstimated: false },
];
const slice = { points: DEBT_POINTS, currency: "USD", windowStart: FROM, windowAsOf: TODAY };
const KPIS = { totalDebt: 2_000, estMonthlyInterest: 0, accountCount: 1, owingCount: 1, settledCount: 0, creditCount: 0,
  ratedCount: 0, unratedCount: 1, utilizationPct: null, utilizationLevel: null, estimated: false };
const ENVELOPE = { completeness: "complete", warnings: [] };
const debtHero = (w: ReturnType<typeof debtWindowChange>) => text(renderToStaticMarkup(createElement(DebtHero, {
  kpis: KPIS, currency: "USD", liabilityCount: 1, asOf: TODAY, today: TODAY, historical: false,
  change: w.change, changeWithheld: w.withheld, envelope: ENVELOPE, verdict: null, verdictAsOf: null, redactions: 0,
} as never)));
const snap = (date: string, debt: number, isEstimated: boolean, invested: number): Snapshot => ({
  date, isEstimated, totalCash: 3_000, totalSavings: 0, totalInvestments: invested, totalCrypto: 0, totalDebt: debt,
  totalAssets: 3_000 + invested, netWorth: 3_000 + invested - debt, netLiquid: 3_000 - debt, cashOnHand: 3_000,
} as Snapshot);
const wealth = computeWealthTimeMachine({
  snapshots: DEBT_POINTS.map((p, i) => snap(p.date, p.totalDebt, p.isEstimated, 10_000 + i * 1_000)),
  asOf: TODAY, compareTo: FROM, currency: "USD",
});
const nwHero = (changeGate: unknown, metric = "netWorth") =>
  text(renderToStaticMarkup(createElement(WealthHero, { result: wealth, currency: "USD", envelope: ENVELOPE, metric, changeGate } as never)));
const note = (cov: ClientBalanceCoverage, metric: string) =>
  renderToStaticMarkup(createElement(BalanceCoverageNote, { from: FROM, metric, coverage: cov } as never));

const GOVERNED = ["netWorth", "totalLiabilities", "liquidNetWorth", "totalAssets", "cash"] as const;

// ── §1 the client tri-state ──────────────────────────────────────────────────
{
  assert.equal(balanceCoverageState("space-a", null), BALANCE_COVERAGE_LOADING, "a Space whose read is in flight ⇒ LOADING, never null");
  assert.equal(balanceCoverageState(null, null), null, "no Space ⇒ no read will run ⇒ nothing to cover");
  assert.deepEqual(balanceCoverageState("space-a", { sources: null, valuationCoverage: null, balanceCoverage: COV }), COV, "read ⇒ the floors");
  assert.equal(balanceCoverageState("space-a", { sources: null, valuationCoverage: null, balanceCoverage: null }), null, "read, nothing to cover ⇒ null");
  assert.equal(balanceCoverageState("space-a", FAILED_DATA_HEALTH), BALANCE_COVERAGE_UNAVAILABLE, "failed read ⇒ unavailable");
  assert.ok(isBalanceCoverageLoading(BALANCE_COVERAGE_LOADING) && !isBalanceCoverageLoading(null) && !isBalanceCoverageLoading(BALANCE_COVERAGE_UNAVAILABLE));
  const pes = strip(src("../../components/space/PerspectiveEmptyState.tsx"));
  assert.ok(/return balanceCoverageState\(spaceId, useDataHealth\(spaceId\)\);/.test(pes), "the hook reads the tri-state");
  assert.ok(!/balanceCoverage \?\? null/.test(pes), "no `?? null` collapses loading into nothing-to-cover");
  ok("§1 tri-state: loading | read (value | null) | unavailable");
}

// ── §2 the missing key (version skew) ────────────────────────────────────────
{
  assert.equal(parseBalanceCoverage(undefined), BALANCE_COVERAGE_UNAVAILABLE, "missing key ⇒ unavailable, never null");
  assert.equal(parseBalanceCoverage(null), null, "an explicit null still means nothing to cover");
  const g = debtWindowChange(slice, parseBalanceCoverage(({} as { balanceCoverage?: unknown }).balanceCoverage));
  assert.equal(g.change, null, "a skewed payload never lets a debt change through");
  ok("§2 missing balanceCoverage key ⇒ unavailable (fails closed)");
}

// ── §3 no governed change renders before coverage resolves ───────────────────
{
  // Baseline: with nothing to cover the debt change IS stated — so its absence below is the gate, not the fixture.
  assert.ok(debtWindowChange(slice, null).change, "baseline: the debt change is measurable");
  assert.ok(/vs /.test(debtHero(debtWindowChange(slice, null))) || /%/.test(debtHero(debtWindowChange(slice, null))), "baseline: the hero states it");

  const loading = debtWindowChange(slice, BALANCE_COVERAGE_LOADING);
  assert.equal(loading.change, null, "Debt: no change figure while loading");
  assert.equal(loading.withheld, BALANCE_COVERAGE_PENDING_MESSAGE, "Debt: PENDING (—)");
  const dh = debtHero(loading);
  assert.ok(dh.includes("—") && !/%|vs Jun/.test(dh), `Debt hero: pending, no % / 'vs' (${dh})`);

  const gate = wealthChangeGate(wealth, BALANCE_COVERAGE_LOADING)!;
  assert.ok(gate, "a gate exists while loading (null would mean 'render as before')");
  for (const m of GOVERNED) {
    const g = gate[m];
    assert.ok(g.state === "withheld" && "pending" in g && g.message === BALANCE_COVERAGE_PENDING_MESSAGE, `Net Worth gate: ${m} pending`);
  }
  for (const m of GOVERNED) {
    const h = nwHero(gate, m);
    assert.ok(!/vs Jun 17, 2026/.test(h) && !/\d+(\.\d+)?%/.test(h), `${m} hero: no change stated while loading`);
  }

  // Resolving later can only REVEAL or WITHHOLD — never retract something already shown.
  const resolved = wealthChangeGate(wealth, COV)!;
  for (const m of GOVERNED) {
    if (resolved[m].state === "withheld") assert.equal(gate[m].state, "withheld", `${m}: withheld after resolve ⇒ was never shown before`);
  }
  assert.equal(debtWindowChange(slice, COV).change, null, "this fixture's resolved coverage withholds the debt change — which loading never showed");

  assert.equal(note(BALANCE_COVERAGE_LOADING, "totalLiabilities"), "", "the debt chart note is pending (renders nothing) while loading");
  assert.equal(note(BALANCE_COVERAGE_LOADING, "netWorth"), "", "the net-worth chart note is pending while loading");
  ok("§3 loading: every governed change pending (—) on the Debt and Net Worth heroes; chart notes render nothing");
}

// ── §4 invested renders while loading ────────────────────────────────────────
{
  const gate = wealthChangeGate(wealth, BALANCE_COVERAGE_LOADING)!;
  assert.equal(gate.invested.state, "comparable", "invested is never governed");
  assert.equal(changeComparability(BALANCE_COVERAGE_LOADING, [], { fromISO: FROM, toISO: TODAY }).state, "comparable");
  const h = nwHero(gate, "invested");
  assert.ok(/vs Jun 17, 2026/.test(h) || /%/.test(h), `invested hero states its change while loading (${h})`);
  assert.equal(h, nwHero(wealthChangeGate(wealth, null), "invested"), "invested is byte-identical to the nothing-to-cover render");
  assert.equal(note(BALANCE_COVERAGE_LOADING, "invested"), "", "no note under invested");
  ok("§4 invested: measured immediately while coverage loads");
}

for (const c of checks) console.log(`  ✓ ${c}`);
console.log(`coverage-loading-pending: ${checks.length} checks passed`);
