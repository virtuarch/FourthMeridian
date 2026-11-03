/**
 * lib/connections/data-health-coverage-fail-closed.test.ts  (S2 sweep — client twin of #293)
 *
 * The Space heroes read balance coverage from GET /api/spaces/[id]/data-health.
 * A failed coverage read used to 500 the whole route; the client then mapped
 * the error to `null` ("nothing to cover"), and the Debt and Net Worth heroes
 * printed changes measured across an unknown balance-history floor. Now:
 *
 *   route    coverage in a phase of its OWN via loadBalanceCoverageFailClosed;
 *            a failure answers `balanceCoverage: { unavailable: true }`, and the
 *            sources still arrive (no 500)
 *   client   a non-OK / thrown / malformed read ⇒ BALANCE_COVERAGE_UNAVAILABLE;
 *            the heroes WITHHOLD every change coverage governs (debt, net worth,
 *            liabilities, cash…), invested stays measured, and the chart note
 *            says completeness could not be read
 *   normal   a read coverage, or nothing to cover, renders byte-identically
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/data-health-coverage-fail-closed.test.ts
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
import { FAILED_DATA_HEALTH, parseBalanceCoverage } from "@/components/space/PerspectiveEmptyState";
import {
  BALANCE_COVERAGE_UNAVAILABLE, BALANCE_COVERAGE_UNREADABLE_CHART_NOTE, BALANCE_COVERAGE_UNREADABLE_MESSAGE, type BalanceCoverage,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FLOOR = "2026-11-02";
const TODAY = "2026-11-03";
const COV: BalanceCoverage = { liabilityFloors: ["2026-01-05", FLOOR], assetFloors: ["2026-01-05"], estimatedLiabilityFloors: [] };
const DEBT_POINTS = [
  { date: "2026-06-17", totalDebt: 1_234.5, isEstimated: true },
  { date: "2026-09-01", totalDebt: 1_100, isEstimated: true },
  { date: FLOOR, totalDebt: 99_999.75, isEstimated: true },
  { date: TODAY, totalDebt: 100_000, isEstimated: false },
];
const slice = { points: DEBT_POINTS, currency: "USD", windowStart: "2026-06-17", windowAsOf: TODAY };

const KPIS = { totalDebt: 100_000, estMonthlyInterest: 0, accountCount: 2, owingCount: 2, settledCount: 0, creditCount: 0,
  ratedCount: 0, unratedCount: 2, utilizationPct: null, utilizationLevel: null, estimated: false };
const ENVELOPE = { completeness: "complete", warnings: [] };
const debtHero = (w: ReturnType<typeof debtWindowChange>) => text(renderToStaticMarkup(createElement(DebtHero, {
  kpis: KPIS, currency: "USD", liabilityCount: 2, asOf: TODAY, today: TODAY, historical: false,
  change: w.change, changeWithheld: w.withheld, envelope: ENVELOPE, verdict: null, verdictAsOf: null, redactions: 0,
} as never)));
const snap = (date: string, debt: number, isEstimated: boolean): Snapshot => ({
  date, isEstimated, totalCash: 20_000, totalSavings: 0, totalInvestments: 50_000, totalCrypto: 0, totalDebt: debt,
  totalAssets: 70_000, netWorth: 70_000 - debt, netLiquid: 20_000 - debt, cashOnHand: 20_000,
} as Snapshot);
const wealth = computeWealthTimeMachine({ snapshots: DEBT_POINTS.map((p) => snap(p.date, p.totalDebt, p.isEstimated)), asOf: TODAY, compareTo: "2026-06-17", currency: "USD" });
const nwHero = (changeGate: unknown, metric = "netWorth") =>
  text(renderToStaticMarkup(createElement(WealthHero, { result: wealth, currency: "USD", envelope: ENVELOPE, metric, changeGate } as never)));

// ── §1 the route ─────────────────────────────────────────────────────────────
{
  const route = strip(src("../../app/api/spaces/[id]/data-health/route.ts"));
  assert.ok(/loadBalanceCoverageFailClosed\(tx, spaceId, "data-health-route"\)/.test(route), "coverage read fails CLOSED");
  assert.ok(!/loadBalanceCoverage\(tx, spaceId\)/.test(route), "the throwing read is gone from the route");
  const shared = route.slice(route.indexOf("Promise.all(["), route.indexOf("]));"));
  assert.ok(!/BalanceCoverage/.test(shared), "coverage is NOT in the sources' transaction (a failed statement would abort it)");
  assert.ok(/\.catch\(\(\) => BALANCE_COVERAGE_UNAVAILABLE\)/.test(route), "even a failed phase answers unavailable, never a 500");
  assert.ok(/sources: health\.sources, balanceCoverage, valuationCoverage/.test(route), "the payload shape is unchanged");
  assert.deepEqual(JSON.parse(JSON.stringify({ balanceCoverage: BALANCE_COVERAGE_UNAVAILABLE })), { balanceCoverage: { unavailable: true } }, "the wire value");
  ok("§1 route: coverage in its own phase, fail-closed to { unavailable: true }; sources still served");
}

// ── §2 the client read ───────────────────────────────────────────────────────
{
  assert.equal(parseBalanceCoverage(null), null, "nothing to cover stays null");
  assert.equal(parseBalanceCoverage(undefined), null, "an older payload without the key stays null");
  assert.deepEqual(parseBalanceCoverage(COV), COV, "a read coverage passes through untouched");
  assert.equal(parseBalanceCoverage({ unavailable: true }), BALANCE_COVERAGE_UNAVAILABLE, "the route's failed read");
  assert.equal(parseBalanceCoverage({ liabilityFloors: "x" }), BALANCE_COVERAGE_UNAVAILABLE, "malformed ⇒ unavailable, never trusted");
  assert.equal(FAILED_DATA_HEALTH.balanceCoverage, BALANCE_COVERAGE_UNAVAILABLE, "a failed fetch ⇒ unavailable coverage");
  assert.equal(FAILED_DATA_HEALTH.sources, null, "…while the sources are simply unknown (the page keeps its own behaviour)");
  const pes = strip(src("../../components/space/PerspectiveEmptyState.tsx"));
  assert.ok(/if \(!r\.ok\) \{ coverageReadFailed\(\); return FAILED_DATA_HEALTH; \}/.test(pes), "non-OK ⇒ FAILED_DATA_HEALTH");
  assert.ok(/\.catch\(\(\) => \{ coverageReadFailed\(\); return FAILED_DATA_HEALTH; \}\)/.test(pes), "thrown / bad JSON ⇒ FAILED_DATA_HEALTH");
  assert.ok(/parseBalanceCoverage\(j\.balanceCoverage\)/.test(pes), "the wire value is parsed, never cast");
  assert.ok(!/return null;/.test(pes.slice(pes.indexOf("function loadPayload"), pes.indexOf("function useDataHealth"))), "no failure path returns null any more");
  ok("§2 client: non-OK, thrown or malformed reads ⇒ BALANCE_COVERAGE_UNAVAILABLE; null / absent / read coverage unchanged");
}

// ── §3 the heroes withhold ───────────────────────────────────────────────────
{
  const failed = debtWindowChange(slice, BALANCE_COVERAGE_UNAVAILABLE);
  assert.equal(failed.change, null, "Debt: no change figure");
  assert.equal(failed.withheld, BALANCE_COVERAGE_UNREADABLE_MESSAGE);
  const dh = debtHero(failed);
  assert.ok(dh.includes(BALANCE_COVERAGE_UNREADABLE_MESSAGE) && !/98,765|8,000|vs Jun 17|%/.test(dh), "Debt hero says why; no $ / % / 'vs'");

  const gate = wealthChangeGate(wealth, BALANCE_COVERAGE_UNAVAILABLE)!;
  for (const m of ["netWorth", "totalLiabilities", "liquidNetWorth", "totalAssets", "cash"] as const) {
    assert.equal(gate[m].state, "withheld", `Net Worth gate: ${m} withheld`);
  }
  assert.equal(gate.invested.state, "comparable", "invested has no balance sides ⇒ stays measured");
  const nh = nwHero(gate);
  assert.ok(nh.includes(BALANCE_COVERAGE_UNREADABLE_MESSAGE) && !/vs Jun 17, 2026/.test(nh), "Net Worth hero withholds and says why");

  const note = (cov: unknown, metric: string) => text(renderToStaticMarkup(createElement(BalanceCoverageNote, { from: "2026-06-17", metric, coverage: cov } as never)));
  assert.equal(note(BALANCE_COVERAGE_UNAVAILABLE, "totalLiabilities"), BALANCE_COVERAGE_UNREADABLE_CHART_NOTE, "the debt chart says completeness could not be read");
  assert.equal(note(BALANCE_COVERAGE_UNAVAILABLE, "invested"), "", "…not under a series coverage never governs");
  ok("§3 heroes: every governed change withheld with the unreadable reason; invested measured; the chart note says why");
}

// ── §4 the normal paths are byte-identical ───────────────────────────────────
{
  const none = debtWindowChange(slice, null);
  assert.ok(none.change && none.withheld === null, "nothing to cover ⇒ measured, as before");
  assert.equal(wealthChangeGate(wealth, null), null, "nothing to cover / loading ⇒ no gate, as before");
  const read = debtWindowChange(slice, COV);
  assert.ok(read.change === null && /history is partial before Nov 2, 2026/.test(read.withheld ?? ""), "a read coverage ⇒ the PB-8b wording, unchanged");
  const note = (cov: unknown) => renderToStaticMarkup(createElement(BalanceCoverageNote, { from: "2026-06-17", metric: "totalLiabilities", coverage: cov } as never));
  assert.equal(note(null), "", "no note without coverage");
  assert.ok(/History is partial before/.test(note(COV)), "the PB-8 note, unchanged");
  ok("§4 normal paths: null and a read coverage render exactly as before");
}

for (const c of checks) console.log(`  ✓ ${c}`);
console.log(`data-health-coverage-fail-closed: ${checks.length} checks passed`);
