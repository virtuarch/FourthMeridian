/**
 * lib/connections/balance-chart-start.test.ts   (B12 O-3 — new-user first-sync chart)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/balance-chart-start.test.ts
 *
 * On a brand-new connection most debts have no balance history before today,
 * so a 1-month Net Worth window drew a month of PARTIAL points far above today
 * and then a cliff — read as "my net worth crashed". The DEFAULT chart now
 * starts at the coverage floor (owner valuation-coverage ruling 2026-10-30:
 * charts start at the coverage floor; never $0, never silently omitted — the
 * partial days stay one opt-in away, marked partial, with the PB-8 note).
 *
 * Pins: floor selection (day-one, partially covered, fully covered, empty /
 * loading / unavailable / nothing to cover), values never changed, the opt-in
 * returns every point byte-identical to before, the note wording, and the
 * callers wired (Net Worth trend + Debt balance history). Synthetic fixtures only.
 *
 * B12 P3 — while the coverage read is LOADING the chart holds its placeholder
 * (no points, so no flash of the unclipped "crash"); FAILED / nothing to cover
 * render at once, unclipped, as before.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { projectWealthTrendPoints } from "@/components/space/widgets/wealth/wealth-trend-points";
import { debtTrendPoints } from "@/components/space/widgets/debt/debt-trend-points";
import { BalanceCoverageNote } from "@/components/space/widgets/shared/BalanceCoverageNote";
import { WealthTrendChart } from "@/components/space/widgets/wealth/WealthTrendChart";
import { DebtBalanceHistory } from "@/components/space/widgets/debt/DebtBalanceHistory";
import { SpaceIdProvider } from "@/components/space/space-id-context";
import {
  BALANCE_COVERAGE_LOADING, BALANCE_COVERAGE_UNAVAILABLE, HIDE_PARTIAL_HISTORY_LABEL, SHOW_PARTIAL_HISTORY_LABEL,
  balanceChartPending, balanceChartStartISO, balanceCoverageNote, balanceCoverageSidesFor, balanceHistoryStartNote, clipToBalanceCoverage,
  type BalanceCoverage,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const TODAY = "2026-11-09";
const NW = balanceCoverageSidesFor("netWorth");
const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const WINDOW = days("2026-10-09", TODAY); // a 1-month range

// Day one: 5 cash/savings walked back a month; 7 loans/cards connected today.
const DAY_ONE: BalanceCoverage = {
  assetFloors: Array(5).fill("2026-10-09"),
  liabilityFloors: Array(7).fill(TODAY),
  estimatedLiabilityFloors: Array(4).fill(TODAY),
};
// Partially covered: the last debt's history starts mid-window.
const PARTIAL: BalanceCoverage = { assetFloors: ["2026-10-01"], liabilityFloors: ["2026-10-01", "2026-10-20"], estimatedLiabilityFloors: [] };
// Fully covered: every floor precedes the window.
const COMPLETE: BalanceCoverage = { assetFloors: ["2026-01-01"], liabilityFloors: ["2026-02-01"], estimatedLiabilityFloors: [] };

const wealthResult = (dates: string[]): WealthResult => ({
  chart: {
    points: dates.map((date, i) => {
      const today = date === TODAY;
      const nw = today ? -40_000 : 25_000 + i; // the cliff: earlier days omit most debts
      return { date, netWorth: nw, totalAssets: 30_000, totalLiabilities: today ? 70_000 : 5_000, liquidNetWorth: nw, cash: 30_000, invested: 0, isEstimated: !today };
    }),
  },
} as unknown as WealthResult);

// ── 1. Floor selection ───────────────────────────────────────────────────────
{
  assert.equal(balanceChartStartISO(DAY_ONE, NW, WINDOW[0]), TODAY, "day one: starts today");
  assert.equal(balanceChartStartISO(PARTIAL, NW, WINDOW[0]), "2026-10-20", "partial: the latest floor");
  assert.equal(balanceChartStartISO(PARTIAL, ["asset"], WINDOW[0]), null, "an asset-only series is complete here");
  assert.equal(balanceChartStartISO(COMPLETE, NW, WINDOW[0]), null, "complete: no clip");
  assert.equal(balanceChartStartISO(PARTIAL, NW, "2026-10-20"), null, "window already starts on the floor");
  assert.equal(balanceChartStartISO(null, NW, WINDOW[0]), null, "nothing to cover");
  assert.equal(balanceChartStartISO(BALANCE_COVERAGE_LOADING, NW, WINDOW[0]), null, "loading: no floor known");
  assert.equal(balanceChartStartISO(BALANCE_COVERAGE_UNAVAILABLE, NW, WINDOW[0]), null, "unavailable: no floor known");
  assert.equal(balanceChartStartISO(DAY_ONE, NW, null), null, "empty window");
  assert.equal(balanceChartStartISO(DAY_ONE, [], WINDOW[0]), null, "ungoverned series (invested)");
  // The clip and the PB-8 note can never disagree.
  for (const [cov, from] of [[DAY_ONE, WINDOW[0]], [PARTIAL, WINDOW[0]], [COMPLETE, WINDOW[0]], [PARTIAL, "2026-10-20"]] as const) {
    assert.equal(balanceChartStartISO(cov, NW, from) !== null, balanceCoverageNote(cov, NW, from) !== null);
  }
  ok("floor selection: day-one → today, partial → latest floor, complete/empty/loading/unavailable/none → no clip; same condition as the PB-8 note");
}

// ── 2. The clip on the Net Worth trend ───────────────────────────────────────
{
  const result = wealthResult(WINDOW);
  const marked = projectWealthTrendPoints(result, "netWorth", null, DAY_ONE);
  const dayOne = clipToBalanceCoverage(marked, DAY_ONE, NW, false);
  assert.deepEqual(dayOne.map((p) => p.date), [TODAY], "day one: a today-only view");
  assert.equal(dayOne[0].value, -40_000, "today's value untouched");
  assert.notEqual(dayOne[0].basis, "unreliable", "the plotted point is not partial");

  const shown = clipToBalanceCoverage(marked, DAY_ONE, NW, true);
  assert.deepEqual(shown, marked, "opted in: every point, byte-identical to before (still marked partial)");
  assert.ok(shown.slice(0, -1).every((p) => p.basis === "unreliable" && /^Partial: 7 of 12 accounts/.test(p.coverageLabel ?? "")));

  const partial = clipToBalanceCoverage(projectWealthTrendPoints(result, "netWorth", null, PARTIAL), PARTIAL, NW, false);
  assert.equal(partial[0].date, "2026-10-20", "partial: starts at the floor");
  assert.equal(partial.length, days("2026-10-20", TODAY).length);
  assert.ok(partial.every((p) => p.basis !== "unreliable"), "no partial point in the default view");
  assert.deepEqual(partial, projectWealthTrendPoints(result, "netWorth", null, PARTIAL).slice(WINDOW.indexOf("2026-10-20")), "values unchanged");

  // No change for a user whose history is complete over the range.
  for (const metric of ["netWorth", "totalAssets", "totalLiabilities", "liquidNetWorth", "cash"] as const) {
    const before = projectWealthTrendPoints(result, metric, null, COMPLETE);
    assert.deepEqual(clipToBalanceCoverage(before, COMPLETE, balanceCoverageSidesFor(metric), false), before, `complete ${metric} unchanged`);
    const none = projectWealthTrendPoints(result, metric, null, null);
    assert.deepEqual(clipToBalanceCoverage(none, null, balanceCoverageSidesFor(metric), false), none, `no coverage ${metric} unchanged`);
  }
  assert.deepEqual(clipToBalanceCoverage([], DAY_ONE, NW, false), [], "empty stays empty");
  // A window wholly before the floor plots nothing by default (never a partial point as the default).
  const past = clipToBalanceCoverage(marked.slice(0, 10), DAY_ONE, NW, false);
  assert.deepEqual(past, [], "historical window before the floor: empty default");
  ok("clip: day-one → today only; partial → from the floor, values unchanged; opt-in byte-identical; complete/none unchanged for every series");
}

// ── 3. The Debt balance history ──────────────────────────────────────────────
{
  const slice = { points: WINDOW.map((date) => ({ date, totalDebt: date === TODAY ? 70_000 : 5_000, isEstimated: date !== TODAY })), currency: "USD", windowStart: WINDOW[0], windowAsOf: TODAY };
  const pts = debtTrendPoints(slice as never, DAY_ONE);
  assert.deepEqual(clipToBalanceCoverage(pts, DAY_ONE, ["liability"], false).map((p) => p.value), [70_000]);
  assert.deepEqual(clipToBalanceCoverage(pts, DAY_ONE, ["liability"], true), pts);
  const full = debtTrendPoints(slice as never, COMPLETE);
  assert.deepEqual(clipToBalanceCoverage(full, COMPLETE, ["liability"], false), full);
  ok("debt balance history: day-one today only, opt-in every point, complete unchanged");
}

// ── 4. The note under the chart ──────────────────────────────────────────────
{
  assert.equal(balanceHistoryStartNote(DAY_ONE, "netWorth", WINDOW[0], TODAY),
    "Your net worth history starts today. It builds as your accounts sync.");
  assert.equal(balanceHistoryStartNote(DAY_ONE, "totalLiabilities", WINDOW[0], TODAY),
    "Your debt history starts today. It builds as your accounts sync.");
  assert.equal(balanceHistoryStartNote(PARTIAL, "netWorth", WINDOW[0], TODAY),
    "Your net worth history starts Oct 20, 2026. Earlier days are partial: 1 of 3 accounts has no balance history that far back.");
  assert.equal(balanceHistoryStartNote(COMPLETE, "netWorth", WINDOW[0], TODAY), null);
  assert.equal(balanceHistoryStartNote(DAY_ONE, "invested", WINDOW[0], TODAY), null);

  const render = (shown: boolean, cov = DAY_ONE) => renderToStaticMarkup(createElement(BalanceCoverageNote, {
    from: WINDOW[0], metric: "netWorth", coverage: cov, partialHistory: { shown, onToggle: () => {}, todayISO: TODAY },
  }));
  const hidden = text(render(false));
  assert.equal(hidden, `Your net worth history starts today. It builds as your accounts sync. ${SHOW_PARTIAL_HISTORY_LABEL}`);
  const shown = text(render(true));
  assert.ok(shown.startsWith("History is partial before Nov 9, 2026: 7 of 12 accounts have no balance history that far back"), shown);
  assert.ok(shown.includes("a missing debt isn’t $0 owed") && shown.endsWith(HIDE_PARTIAL_HISTORY_LABEL));
  assert.ok(/aria-pressed="true"/.test(render(true)) && /aria-pressed="false"/.test(render(false)));
  assert.equal(render(false, COMPLETE), "", "complete: no note, no control");
  // Without the toggle (fixture renders), the PB-8 note exactly as before.
  const legacy = text(renderToStaticMarkup(createElement(BalanceCoverageNote, { from: WINDOW[0], metric: "netWorth", coverage: DAY_ONE })));
  assert.equal(legacy, balanceCoverageNote(DAY_ONE, NW, WINDOW[0]));
  ok("note: day-one wording, partial wording with the PB-8 count, opt-in shows the PB-8 note unchanged, complete renders nothing");
}

// ── 5. Callers wired ─────────────────────────────────────────────────────────
{
  const nwChart = src("../../components/space/widgets/wealth/WealthTrendChart.tsx");
  assert.ok(/clipToBalanceCoverage\(\s*projectWealthTrendPoints\(/.test(nwChart), "Net Worth trend clips");
  const debtChart = src("../../components/space/widgets/debt/DebtBalanceHistory.tsx");
  assert.ok(/clipToBalanceCoverage\(debtTrendPoints\(history, balanceCoverage\)/.test(debtChart), "Debt history clips");
  for (const ws of ["../../components/space/widgets/wealth/WealthWorkspace.tsx", "../../components/space/widgets/debt/DebtWorkspace.tsx"]) {
    const s = src(ws);
    assert.ok(/showPartialHistory=\{showPartialHistory\}/.test(s), `${ws}: chart receives the opt-in`);
    assert.ok(/<BalanceCoverageNote[^>]*partialHistory=\{\{ shown: showPartialHistory/.test(s), `${ws}: note carries the control`);
  }
  ok("callers: Net Worth (Total/Assets/Liquid/Cash/Debt-as-liabilities) trend + Debt balance history share one opt-in with their note");
}

// ── 6. B12 P3 — loading holds the chart; failed / none render as before ──────
{
  // The rule.
  assert.equal(balanceChartPending(BALANCE_COVERAGE_LOADING, NW, false), true, "loading + governed ⇒ held");
  assert.equal(balanceChartPending(BALANCE_COVERAGE_LOADING, ["liability"], false), true, "debt history held too");
  assert.equal(balanceChartPending(BALANCE_COVERAGE_LOADING, [], false), false, "ungoverned series (invested) never held");
  assert.equal(balanceChartPending(BALANCE_COVERAGE_LOADING, NW, true), false, "opted in: every point either way, never held");
  for (const cov of [BALANCE_COVERAGE_UNAVAILABLE, null, DAY_ONE, COMPLETE]) {
    assert.equal(balanceChartPending(cov, NW, false), false, "resolved (failed / none / known) ⇒ never held");
  }
  // FAILED / nothing to cover: the points are exactly the unclipped series, as before.
  const marked = projectWealthTrendPoints(wealthResult(WINDOW), "netWorth", null, BALANCE_COVERAGE_UNAVAILABLE);
  assert.deepEqual(clipToBalanceCoverage(marked, BALANCE_COVERAGE_UNAVAILABLE, NW, false), marked, "failed: unclipped");

  // Rendered: inside a Space the read has not landed during SSR ⇒ LOADING ⇒ held.
  const inSpace = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(SpaceIdProvider as never, { spaceId: "space-1" }, el));
  const nw = createElement(WealthTrendChart, { result: wealthResult(WINDOW), currency: "USD", metric: "netWorth" });
  const heldNw = inSpace(nw);
  assert.ok(heldNw.includes("data-trend-pending") && !/<svg/.test(heldNw) && !/<circle/.test(heldNw), "net worth: held, no points rendered");
  const invested = inSpace(createElement(WealthTrendChart, { result: wealthResult(WINDOW), currency: "USD", metric: "invested" }));
  assert.ok(!invested.includes("data-trend-pending") && /<svg/.test(invested), "invested (ungoverned): not held");
  const slice = { points: WINDOW.map((date) => ({ date, totalDebt: 5_000, isEstimated: false })), currency: "USD", windowStart: WINDOW[0], windowAsOf: TODAY };
  const debt = createElement(DebtBalanceHistory, { history: slice as never, currency: "USD", asOf: TODAY, compareTo: null });
  const heldDebt = inSpace(debt);
  assert.ok(heldDebt.includes("data-trend-pending") && !/<svg/.test(heldDebt), "debt history: held, no points rendered");
  // No Space ⇒ nothing to cover ⇒ the chart renders at once, every point (unchanged).
  const free = renderToStaticMarkup(nw);
  assert.ok(!free.includes("data-trend-pending") && /<svg/.test(free), "nothing to cover: rendered as before");
  assert.ok(!renderToStaticMarkup(debt).includes("data-trend-pending"), "debt, nothing to cover: rendered as before");
  ok("loading: Net Worth + Debt charts hold a placeholder (no points); invested / opt-in / failed / none / known never held");
}

for (const c of checks) console.log(`  ✓ ${c}`);
console.log(`\nAll ${checks.length} balance-chart-start checks passed`);
