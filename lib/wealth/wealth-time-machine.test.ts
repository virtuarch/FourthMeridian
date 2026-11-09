/**
 * lib/wealth/wealth-time-machine.test.ts
 *
 * A6 Wealth read-model tests. Pure, DB-free (house pattern):
 *
 *   npx tsx lib/wealth/wealth-time-machine.test.ts
 *
 * Proves the Time Machine behaviors the shared shell drives: as-of resolution,
 * compare-to deltas, range windowing (cards vs chart), gaps, before-coverage
 * incompleteness, isEstimated honesty, completeness, real-only evidence, and the
 * deterministic change story.
 */

import {
  computeWealthTimeMachine,
  wealthCompositionItems,
  WEALTH_EPSILON,
  WEALTH_CATEGORY_LABELS,
  LIQUID_DEBT_DRIVER_LABELS,
  type WealthTimeMachineInput,
  type WealthComposition,
} from "./wealth-time-machine";
import { METRIC_DRIVER_COMPONENTS } from "@/components/space/widgets/wealth/wealth-metric-facets";
import type { Snapshot } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number) => Math.abs(a - b) <= 1e-6;

// Snapshot fixture: net worth = assets − debt; assets = cash+savings+inv+crypto+real.
function snap(date: string, o: Partial<Snapshot> = {}): Snapshot {
  const totalCash = o.totalCash ?? 0, totalSavings = o.totalSavings ?? 0;
  const totalInvestments = o.totalInvestments ?? 0, totalCrypto = o.totalCrypto ?? 0;
  const real = o.totalAssets != null ? o.totalAssets - (totalCash + totalSavings + totalInvestments + totalCrypto) : 0;
  const totalAssets = o.totalAssets ?? totalCash + totalSavings + totalInvestments + totalCrypto + (real > 0 ? real : 0);
  const totalDebt = o.totalDebt ?? 0;
  return {
    date, totalCash, totalSavings, totalInvestments, totalCrypto, totalDebt, totalAssets,
    netWorth: o.netWorth ?? totalAssets - totalDebt,
    cashOnHand: Math.max(totalCash, 0),
    ...(o.isEstimated ? { isEstimated: true } : {}),
    ...(o.fxMiss ? { fxMiss: true as const } : {}),
  };
}

// A coherent history: Jan (small), Jun (mid), Jul-01, Jul-14 (latest).
const SERIES: Snapshot[] = [
  snap("2026-01-01", { totalCash: 5000, totalSavings: 10000, totalInvestments: 40000, totalDebt: 20000 }),   // NW 35000
  snap("2026-06-01", { totalCash: 6000, totalSavings: 12000, totalInvestments: 52000, totalDebt: 17000 }),   // NW 53000
  snap("2026-07-01", { totalCash: 7000, totalSavings: 12000, totalInvestments: 60000, totalDebt: 16000 }),   // NW 63000
  snap("2026-07-14", { totalCash: 8000, totalSavings: 13000, totalInvestments: 66000, totalDebt: 15000 }),   // NW 72000
];
const base = (o: Partial<WealthTimeMachineInput>): WealthTimeMachineInput => ({
  snapshots: SERIES, asOf: "2026-07-15", compareTo: null, currency: "USD", ...o,
});

console.log("As Of resolves to the nearest snapshot ≤ the date");
{
  const now = computeWealthTimeMachine(base({ asOf: "2026-07-15" }));
  check("today resolves the latest snapshot (NW 72000)", now.asOfState.found && approx(now.asOfState.netWorth, 72000));
  const mid = computeWealthTimeMachine(base({ asOf: "2026-06-10" }));
  check("a mid date resolves the Jun snapshot (NW 53000), not the latest", approx(mid.asOfState.netWorth, 53000) && mid.asOfState.date === "2026-06-01");
  check("changing As Of changes the historical state", now.asOfState.netWorth !== mid.asOfState.netWorth);
  check("liquid net worth = cash + savings − debt", approx(now.asOfState.liquidNetWorth, 8000 + 13000 - 15000));
  check("composition is the resolved snapshot's (historical, earned)", approx(mid.asOfState.composition.investments, 52000));
}

console.log("Compare To updates every supported comparison value");
{
  const r = computeWealthTimeMachine(base({ asOf: "2026-07-15", compareTo: "2026-01-01" }));
  check("compareState resolves Jan (NW 35000)", r.compareState?.found === true && approx(r.compareState!.netWorth, 35000));
  check("net worth delta abs = 37000", r.deltas != null && approx(r.deltas.netWorth.abs, 37000));
  check("net worth delta pct ≈ 105.7%", r.deltas?.netWorth.pct != null && approx(r.deltas!.netWorth.pct!, (37000 / 35000) * 100));
  check("assets delta abs = 88000-55000 = 33000", approx(r.deltas!.totalAssets.abs, 87000 - 55000));
  check("liabilities delta abs = 15000-20000 = -5000 (decreased)", approx(r.deltas!.totalLiabilities.abs, -5000));
  check("liquid NW delta abs computed", approx(r.deltas!.liquidNetWorth.abs, (8000 + 13000 - 15000) - (5000 + 10000 - 20000)));
  check("drivers are real component deltas, ranked by |Δ|", r.drivers != null && r.drivers[0].id === "investments" && approx(r.drivers![0].delta, 26000));
}

console.log("Removing Compare To removes comparison copy but not the selected state");
{
  const withCmp = computeWealthTimeMachine(base({ asOf: "2026-07-15", compareTo: "2026-01-01" }));
  const noCmp   = computeWealthTimeMachine(base({ asOf: "2026-07-15", compareTo: null }));
  check("no compare ⇒ compareState/deltas/drivers/story all null", noCmp.compareState === null && noCmp.deltas === null && noCmp.drivers === null && noCmp.explanation === null);
  check("selected As Of state is identical with or without a comparison", JSON.stringify(noCmp.asOfState) === JSON.stringify(withCmp.asOfState));
}

console.log("Present-day / no-As-Of behavior preserves present results");
{
  const r = computeWealthTimeMachine(base({ asOf: "2026-07-15", compareTo: null }));
  check("as-of today = present-day latest snapshot", approx(r.asOfState.netWorth, 72000) && approx(r.asOfState.totalAssets, 87000));
}

console.log("Chart range = Compare To → As Of; the shell range never touches the cards");
{
  // No comparison ⇒ full history up to As Of.
  const all = computeWealthTimeMachine(base({ compareTo: null, asOf: "2026-07-15" }));
  check("no comparison ⇒ chart uses the full series", all.chart.points.length === 4);
  // A Compare To of Jul 1 windows the chart to [Jul 1, Jul 15] (Jan/Jun dropped).
  const windowed = computeWealthTimeMachine(base({ compareTo: "2026-07-01", asOf: "2026-07-15" }));
  check("Compare To windows the chart (Jan/Jun dropped, Jul kept)",
    windowed.chart.points.length < all.chart.points.length && windowed.chart.points.every((p) => p.date >= "2026-07-01"));
  check("the chart window does NOT change the As Of cards", JSON.stringify(windowed.asOfState) === JSON.stringify(all.asOfState));
}

console.log("Missing dates remain gaps — no interpolation/fabrication");
{
  const r = computeWealthTimeMachine(base({}));
  check("chart points exist only at real snapshot dates", JSON.stringify(r.chart.points.map((p) => p.date)) === JSON.stringify(SERIES.map((s) => s.date)));
}

console.log("Compare overlay series (S5) — equal-length window ending at Compare To");
{
  // A dense daily series so the equal-length window resolves to real points.
  const daily: Snapshot[] = [];
  for (let d = 1; d <= 20; d++) daily.push(snap(`2026-06-${String(d).padStart(2, "0")}`, { totalCash: 1000 * d }));
  // As Of Jun 20, Compare To Jun 15 ⇒ primary window 5 days; overlay = [Jun 10, Jun 15].
  const r = computeWealthTimeMachine({ snapshots: daily, asOf: "2026-06-20", compareTo: "2026-06-15", currency: "USD" });
  check("overlay is the equal-length window ending at Compare To",
    r.chart.compareSeries.length > 0 &&
    r.chart.compareSeries[0].date === "2026-06-10" &&
    r.chart.compareSeries[r.chart.compareSeries.length - 1].date === "2026-06-15");
  check("overlay carries only real snapshot dates (no padding/interpolation)",
    r.chart.compareSeries.every((p) => daily.some((s) => s.date === p.date)));
  check("no comparison ⇒ empty overlay", computeWealthTimeMachine({ snapshots: daily, asOf: "2026-06-20", compareTo: null, currency: "USD" }).chart.compareSeries.length === 0);
  check("overlay window preceding coverage ⇒ empty (never truncated)",
    computeWealthTimeMachine({ snapshots: daily, asOf: "2026-06-20", compareTo: "2026-06-05", currency: "USD" }).chart.compareSeries.length === 0);
  check("overlay carries isEstimated exactly like the primary series",
    computeWealthTimeMachine({ snapshots: [snap("2026-06-08", { totalCash: 1, isEstimated: true }), ...daily.slice(9)], asOf: "2026-06-20", compareTo: "2026-06-14", currency: "USD" }).chart.compareSeries.every((p) => typeof p.isEstimated === "boolean"));
}

console.log("S5 regression lock — pre-existing fields byte-identical (only the field name changed)");
{
  const r = computeWealthTimeMachine(base({ asOf: "2026-07-15", compareTo: "2026-01-01" }));
  // explanation holds the exact former `story` content (rename only).
  // MONEY-PRECISION-2 — the STORY is prose: whole dollars. Structured wealth
  // figures (hero, composition, ledger) keep their cents. Arithmetic unchanged.
  check("explanation carries the deterministic sentence (former story content)",
    /^Your net worth increased by \$37,000 since Jan 1, 2026\. Assets increased by \$32,000 and liabilities decreased by \$5,000\.$/.test(r.explanation ?? ""));
  check("chart.points unchanged by the compareSeries addition",
    JSON.stringify(r.chart.points.map((p) => p.date)) === JSON.stringify(["2026-01-01", "2026-06-01", "2026-07-01", "2026-07-14"]));
}

console.log("Before-coverage As Of returns a shaped incomplete state");
{
  const r = computeWealthTimeMachine(base({ asOf: "2025-06-01" }));
  check("no snapshot ≤ date ⇒ not found", r.asOfState.found === false);
  check("completeness is incomplete with a coverage message", r.completeness.tier === "incomplete" && /No history before/i.test(r.completeness.label));
  check("does not fabricate a value", approx(r.asOfState.netWorth, 0) && r.asOfState.date === null);
}

console.log("isEstimated snapshots surface as Reconstructed, never Observed");
{
  const est = [snap("2026-05-01", { totalCash: 1000, totalDebt: 0, isEstimated: true })];
  const r = computeWealthTimeMachine(base({ snapshots: est, asOf: "2026-05-10" }));
  check("estimated as-of ⇒ tier derived, label Reconstructed", r.asOfState.isEstimated && r.completeness.tier === "derived" && r.completeness.label === "Reconstructed");
  check("never labeled Observed", r.completeness.label !== "Observed");
  const obs = computeWealthTimeMachine(base({ asOf: "2026-07-15" }));
  check("a non-estimated snapshot is Observed", obs.completeness.tier === "observed" && obs.completeness.label === "Observed");
}

console.log("fx-missed points are dropped (mixed-unit honesty)");
{
  const withMiss = [...SERIES, snap("2026-07-20", { totalCash: 999999, fxMiss: true })];
  const r = computeWealthTimeMachine(base({ snapshots: withMiss, asOf: "2026-07-25" }));
  check("fx-miss point excluded from the series and chart", r.chart.points.every((p) => p.date !== "2026-07-20") && approx(r.asOfState.netWorth, 72000));
}

console.log("Evidence uses real provenance only; omitted when empty");
{
  const r = computeWealthTimeMachine(base({}));
  check("evidence reports the real snapshot count", r.evidence?.label === "4 snapshots");
  const empty = computeWealthTimeMachine(base({ snapshots: [] }));
  check("no history ⇒ evidence omitted (null), not a placeholder number", empty.evidence === null && empty.hasHistory === false);
}

console.log("Percentage delta is null when the denominator is invalid");
{
  const s = [snap("2026-01-01", { totalCash: 0, totalDebt: 0 }), snap("2026-06-01", { totalCash: 100, totalDebt: 0 })];
  const r = computeWealthTimeMachine(base({ snapshots: s, asOf: "2026-06-02", compareTo: "2026-01-02" }));
  check("liabilities pct null when comparison liabilities = 0", r.deltas?.totalLiabilities.pct === null);
  check("net worth pct null when comparison net worth = 0", r.deltas?.netWorth.pct === null && approx(r.deltas!.netWorth.abs, 100));
}

console.log("Story is deterministic, template-driven, supported facts only");
{
  const r = computeWealthTimeMachine(base({ asOf: "2026-07-15", compareTo: "2026-01-01" }));
  check("story states the net-worth change since the comparison date",
    r.explanation != null && /net worth increased by \$37,000 since Jan 1, 2026/.test(r.explanation!));
  check("story states assets up and liabilities down", /Assets increased by \$32,000 and liabilities decreased by \$5,000/.test(r.explanation!));
  const noCmp = computeWealthTimeMachine(base({ compareTo: null }));
  check("no comparison ⇒ no story", noCmp.explanation === null);
}

console.log("Composition — crypto included, zero categories filtered, Real World Assets label");
{
  const comp = (o: Partial<WealthComposition>): WealthComposition =>
    ({ cash: 0, investments: 0, crypto: 0, real: 0, liabilities: 0, liquidDebt: 0, liquidDefinitionChange: 0, ...o });

  const withCrypto = wealthCompositionItems(comp({ cash: 1000, investments: 500, crypto: 250 }));
  check("crypto is included as its own category (not Investments)",
    withCrypto.some((i) => i.id === "crypto" && i.label === "Crypto" && approx(i.value, 250)));
  check("investments stays separate from crypto",
    withCrypto.some((i) => i.id === "investments") && withCrypto.find((i) => i.id === "investments")!.value !== 250);

  const zeroReal = wealthCompositionItems(comp({ cash: 1000, investments: 500, real: 0 }));
  check("Real assets at $0 does not render as a slice", !zeroReal.some((i) => i.id === "real"));
  check("no zero legend rows (only non-empty categories)", zeroReal.every((i) => i.value > WEALTH_EPSILON) && zeroReal.length === 2);

  const tinyResidual = wealthCompositionItems(comp({ cash: 1000, real: 0.3 }));
  check("sub-epsilon residual is filtered (no $0 slice)", !tinyResidual.some((i) => i.id === "real"));

  const realNamed = wealthCompositionItems(comp({ cash: 1000, real: 4200 }));
  check("real assets render as 'Real World Assets'", realNamed.find((i) => i.id === "real")?.label === "Real World Assets");

  // The story/driver copy also uses the renamed label.
  const s = [
    snap("2026-01-01", { totalCash: 1000, totalAssets: 3000 }), // real residual = 2000
    snap("2026-06-01", { totalCash: 1000, totalAssets: 6000 }), // real residual = 5000
  ];
  const r = computeWealthTimeMachine(base({ snapshots: s, asOf: "2026-06-02", compareTo: "2026-01-02" }));
  check("driver rows use 'Real World Assets'", r.drivers?.some((d) => d.id === "real" && d.label === "Real World Assets") === true);
}

console.log("Mortgage F1 — the liquidDebt driver label follows BOTH end rows' liquid-NW bases");
{
  // A stored row: legacy (installmentDebt NULL ⇒ netLiquid subtracted ALL debt)
  // or new basis (installmentDebt recorded ⇒ netLiquid excludes it).
  const row = (date: string, cash: number, card: number, inst: number, legacy: boolean, extra: Partial<Snapshot> = {}): Snapshot => ({
    ...snap(date, { totalCash: cash, totalDebt: card + inst }),
    netLiquid: legacy ? cash - card - inst : cash - card,
    ...(legacy ? {} : { installmentDebt: inst }),
    ...extra,
  } as Snapshot);
  const liquidIds = new Set<string>(METRIC_DRIVER_COMPONENTS.liquidNetWorth);
  const cents = (n: number) => Math.round(n * 100);
  // Σ Liquid-NW drivers (liquidDebt subtracts) — what the Liquid NW ledger shows.
  const driverSum = (r: ReturnType<typeof computeWealthTimeMachine>) => (r.drivers ?? [])
    .filter((d) => liquidIds.has(d.id))
    .reduce((s, d) => s + (d.id === "liquidDebt" ? -d.delta : d.delta), 0);
  const run = (a: Snapshot, b: Snapshot) => computeWealthTimeMachine({ snapshots: [a, b], asOf: b.date, compareTo: a.date, currency: "USD" });
  const debtLabel = (r: ReturnType<typeof computeWealthTimeMachine>) => r.drivers?.find((d) => d.id === "liquidDebt")?.label;

  // Synthetic-fixture shape: card 5,000 → 3,000, mortgage 300,000 → 299,000, cash 10,000 → 11,000.
  const cases: { name: string; legacyA: boolean; legacyB: boolean; label: string; debtDelta: number }[] = [
    { name: "legacy → legacy", legacyA: true,  legacyB: true,  label: LIQUID_DEBT_DRIVER_LABELS.previous, debtDelta: -3_000 },
    { name: "new → new",       legacyA: false, legacyB: false, label: LIQUID_DEBT_DRIVER_LABELS.current,  debtDelta: -2_000 },
    { name: "legacy → new",    legacyA: true,  legacyB: false, label: LIQUID_DEBT_DRIVER_LABELS.previous, debtDelta: -3_000 },
    { name: "new → legacy (rollback-era row)", legacyA: false, legacyB: true, label: LIQUID_DEBT_DRIVER_LABELS.previous, debtDelta: -3_000 },
  ];
  for (const c of cases) {
    const a = row("2026-10-01", 10_000, 5_000, 300_000, c.legacyA);
    const b = row("2026-11-20", 11_000, 3_000, 299_000, c.legacyB);
    const r = run(a, b);
    check(`${c.name}: liquidDebt label = "${c.label}"`, debtLabel(r) === c.label, String(debtLabel(r)));
    check(`${c.name}: liquidDebt amount unchanged (${c.debtDelta}: ${c.label === LIQUID_DEBT_DRIVER_LABELS.current ? "excl. long-term loans" : "all debts"})`,
      approx(r.deltas!.composition.liquidDebt, c.debtDelta), String(r.deltas!.composition.liquidDebt));
    check(`${c.name}: Σ Liquid NW drivers = Δ Liquid NW to the cent`, cents(driverSum(r)) === cents(r.deltas!.liquidNetWorth.abs),
      `${driverSum(r)} vs ${r.deltas!.liquidNetWorth.abs}`);
  }
  check("WEALTH_CATEGORY_LABELS.liquidDebt is the current-definition label (one source)",
    WEALTH_CATEGORY_LABELS.liquidDebt === LIQUID_DEBT_DRIVER_LABELS.current);
  check("label copy stays coarse (P1-R1: no loan type)",
    Object.values(LIQUID_DEBT_DRIVER_LABELS).every((l) => !/mortgage|auto|student|installment/i.test(l)));

  // D2 — a legacy row of a Space that never held an installment liability is
  // numerically the current definition (same rule as the chart segment flag).
  const d2a = row("2026-10-01", 10_000, 5_000, 0, true, { liquidLegacyRowsCurrent: true });
  const d2b = row("2026-11-20", 11_000, 3_000, 0, true, { liquidLegacyRowsCurrent: true });
  const d2 = run(d2a, d2b);
  check("D2: never-held-installments legacy rows keep the current label (matches the chart)",
    debtLabel(d2) === LIQUID_DEBT_DRIVER_LABELS.current && d2.chart.points.every((p) => !p.liquidBasisPrevious));

  // Property: randomized rows on random bases. The identity holds to the cent,
  // the amount is Δ all debts unless both ends are new-basis, and no driver is
  // labelled "excl. long-term loans" when either end row is legacy.
  let seed = 0x5eed_f1;
  const rnd = (max: number) => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed % (max + 1); };
  let identityFails = 0, labelFails = 0, amountFails = 0, labelled = 0;
  for (let i = 0; i < 2_000; i++) {
    const legacyA = rnd(1) === 1, legacyB = rnd(1) === 1;
    const instA = rnd(3) === 0 ? 0 : rnd(500_000), instB = rnd(3) === 0 ? 0 : rnd(500_000);
    const a = row("2026-09-01", rnd(80_000), rnd(30_000), instA, legacyA);
    const b = row("2026-12-01", rnd(80_000), rnd(30_000), instB, legacyB);
    const r = run(a, b);
    if (cents(driverSum(r)) !== cents(r.deltas!.liquidNetWorth.abs)) identityFails++;
    const expectedDebt = legacyA || legacyB
      ? b.totalDebt - a.totalDebt
      : (b.totalDebt - instB) - (a.totalDebt - instA);
    if (cents(r.deltas!.composition.liquidDebt) !== cents(expectedDebt)) amountFails++;
    const l = debtLabel(r);
    if (l !== undefined) labelled++;
    if ((legacyA || legacyB) && l !== undefined && /excl\. long-term loans/.test(l)) labelFails++;
    if (!legacyA && !legacyB && l !== undefined && l !== LIQUID_DEBT_DRIVER_LABELS.current) labelFails++;
  }
  check("property: Σ Liquid NW drivers = Δ Liquid NW to the cent (2,000 random windows)", identityFails === 0, `${identityFails} failures`);
  check("property: liquidDebt Δ = Δ all debts unless both ends are new-basis (amounts unchanged)", amountFails === 0, `${amountFails} failures`);
  check("REGRESSION: no driver labelled 'excl. long-term loans' when either end row is legacy", labelFails === 0 && labelled > 1_000, `${labelFails} failures, ${labelled} labelled`);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll wealth-time-machine checks passed");
