/**
 * lib/investments/pb11-investments-correctness.test.ts  (PB-11 — three live defects)
 *
 *   M4  the period verdict (`attribution`) rode through the display conversion
 *       untouched, so a converted Space showed opening / money in / money out /
 *       change in the reporting currency next to converted totals. Now it goes
 *       through the SAME converter (same rate, same date); a rate MISS withholds
 *       every period figure (honest-unavailable), never shows one unconverted.
 *   M5  the hero divided change by opening whenever both existed when there was
 *       no verdict. Now the percentage is the verdict's alone; without one, the
 *       reconciliation's own evidence decides (withheld / estimated / comparable).
 *   M7  the Allocation panel and the Concentration card each re-reduced holdings
 *       client-side. Both now read ONE server-computed allocation
 *       (lib/investments/space-data-core), current AND historical.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/investments/pb11-investments-correctness.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversionContext } from "@/lib/money/types";
import { convertInvestmentsSpaceData } from "./display-conversion";
import { assessPeriodAttribution, heroComparison, reconciliationComparison, REFUSAL_COPY } from "./period-attribution.core";
import { assembleInvestmentsSpaceData, type InvestmentsSpaceData } from "./space-data-core";
import { computeAllocation } from "./investments-allocation-core";
import { InvestmentsHero } from "@/components/space/widgets/investments/InvestmentsHero";
import { HoldingsConcentration } from "@/components/space/widgets/investments/HoldingsConcentration";
import { InvestmentAllocationPanel } from "@/components/space/widgets/investments/InvestmentAllocationPanel";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const near = (a: number | null | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const ENVELOPE = { completeness: "complete", warnings: [] } as never;

// ── Fixture: a GBP-reporting Space viewed in EUR (non-USD both sides) ─────────
const RATE = 1.2; // GBP → EUR
const ctx = (hit: boolean): ConversionContext => ({
  target: "EUR",
  resolve: (from, d) => hit && from === "GBP"
    ? { kind: "rate", rate: RATE, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }
    : { kind: "miss", quote: from, requestedDateISO: d },
});
const row = (id: string, acct: string, v: number, cls: string, sector: string | null) => ({
  instrumentId: id, accountId: acct, quantity: 1, nativePrice: v, nativeValue: v, reportingValue: v,
  currency: "GBP", reportingCurrency: "GBP", quantityTier: "observed", priceTier: "observed", fxTier: "observed",
  overallTier: "observed", basisUsed: "raw-close", priceDate: "2026-11-03", staleDays: 0, reason: "ok",
  conflicted: false, symbol: id.toUpperCase(), name: id, share: null, assetClass: cls, sector, isCash: false,
});
const HOLDINGS = [row("vti", "a1", 6000, "US_STOCK", "Broad"), row("aapl", "a1", 3000, "US_STOCK", "Tech"), row("bnd", "a2", 1000, "BOND", null)];
const cov = (v: number) => ({ valuedValue: v, observedValue: v, estimatedValue: 0, valuedCount: 3, unavailableCount: 0, unavailableValue: null, coverageByCount: 1, fullyObserved: true });
const portfolio = { reportingCurrency: "GBP", valuedSubtotal: 10_000, valuedCount: 3, unvaluedCount: 0, unvalued: [], coverage: cov(10_000), completeness: { tier: "observed", conflict: false, reason: "", byInstrument: {} } };
const reconciliation = {
  from: "2026-10-03", to: "2026-11-03", reportingCurrency: "GBP",
  openingValue: 8_000, closingValue: 10_000, totalChange: 2_000, netExternalFlows: 500, residualChange: 1_500,
  residualReason: "", completeness: "observed", conflict: false, endpointIncomplete: false,
  openingCoverage: cov(8_000), closingCoverage: cov(10_000), coverageConsistent: true,
  hasExternalFlows: true, changeInterpretation: "value-change", reason: "",
} as const;
const attribution = assessPeriodAttribution({
  fromISO: "2026-10-03", toISO: "2026-11-03", reportingCurrency: "GBP",
  openingValue: 8_000, closingValue: 10_000, moneyIn: 600, moneyOut: -100, netExternalFlows: 500, residualChange: 1_500,
  openingUnvaluedCount: 0, closingUnvaluedCount: 0, openingTier: "observed", closingTier: "observed",
  openingComponentValues: [5000, 2400, 600], openingInstrumentIds: ["vti", "aapl", "bnd"], closingInstrumentIds: ["vti", "aapl", "bnd"],
  flowCompleteness: "observed", conflict: false,
});
assert.equal(attribution.kind, "ATTRIBUTABLE");
const NAMES = { a1: "Brokerage", a2: "IRA" };
const current = { asOf: "2026-11-03", reportingCurrency: "GBP", holdings: HOLDINGS, portfolio, allocation: computeAllocation(HOLDINGS as never, NAMES) };
const historical = { asOf: "2026-11-03", compareTo: "2026-10-03", reportingCurrency: "GBP", holdings: HOLDINGS, portfolio, flows: null, reconciliation, completeness: { tier: "observed", conflict: false, reason: "", byInstrument: {} }, attribution };
const DATA = assembleInvestmentsSpaceData({ current: current as never, historical: historical as never, accountNames: NAMES }) as InvestmentsSpaceData;

// ── M4 — attribution converts with the totals ────────────────────────────────
{
  const out = convertInvestmentsSpaceData(DATA, ctx(true), "2026-11-03");
  const a = out.historical!.attribution!;
  assert.equal(a.reportingCurrency, "EUR");
  assert.ok(near(a.closingValue, 12_000) && near(a.openingValue, 9_600) && near(a.moneyIn, 720) && near(a.moneyOut, -120)
    && near(a.portfolioChange, 1_800), JSON.stringify(a));
  assert.equal(a.unattributedChange, null, "a null stays null");
  assert.ok(near(a.closingValue, out.historical!.portfolio.valuedSubtotal), "the verdict's closing = the converted total beside it");
  assert.ok(near(a.openingValue, out.historical!.reconciliation!.openingValue), "…and its opening = the converted reconciliation's");
  assert.equal(a.kind, attribution.kind);
  assert.deepEqual(a.refusals, attribution.refusals);
  // Rendered: the hero's change is in EUR at the converted magnitude, never £2,000.
  const html = text(renderToStaticMarkup(createElement(InvestmentsHero, {
    portfolio: out.historical!.portfolio, reconciliation: out.historical!.reconciliation, reportingCurrency: "EUR",
    figureLabel: "Portfolio value", asOf: "2026-11-03", envelope: ENVELOPE, attribution: a,
  })));
  assert.ok(/€12,000\.00/.test(html) && /€2,400/.test(html), html);
  assert.ok(!/£/.test(html) && !/[↑↓]\s*.?2,000\.00/.test(html), "no reporting-currency figure beside the converted total");

  // A rate miss: honest-unavailable, never an unconverted figure.
  const miss = convertInvestmentsSpaceData(DATA, ctx(false), "2026-11-03").historical!.attribution!;
  assert.equal(miss.kind, "NOT_ATTRIBUTABLE");
  assert.ok(miss.openingValue === null && miss.moneyIn === null && miss.moneyOut === null && miss.portfolioChange === null && miss.unattributedChange === null);
  assert.equal(miss.mayShowReturnPercentage, false);
  assert.equal(miss.refusals[0].code, "DISPLAY_RATE_UNAVAILABLE");
  assert.equal(heroComparison(miss).showChange, false);
  assert.equal(heroComparison(miss).suppressedReason, REFUSAL_COPY.DISPLAY_RATE_UNAVAILABLE);
  // Identity (reporting === display) stays byte-identical.
  const gbp: ConversionContext = { target: "GBP", resolve: (f, d) => ({ kind: "miss", quote: f, requestedDateISO: d }) };
  assert.equal(convertInvestmentsSpaceData(DATA, gbp, "2026-11-03"), DATA);
  ok("M4 attribution converts with the same rate/date as its totals (GBP Space → EUR); a miss withholds, never unconverted");
}

// ── M5 — the hero % is gated ─────────────────────────────────────────────────
{
  const hero = (rec: unknown, attr: unknown = null) => text(renderToStaticMarkup(createElement(InvestmentsHero, {
    portfolio: portfolio as never, reconciliation: rec as never, reportingCurrency: "GBP",
    figureLabel: "Portfolio value", asOf: "2026-11-03", envelope: ENVELOPE, attribution: attr as never,
  })));
  // Partial / unpriced opening, no verdict: withheld with the reason (was 25.0%).
  const partial = { ...reconciliation, endpointIncomplete: true, coverageConsistent: false, changeInterpretation: "incomparable",
    openingCoverage: { ...cov(8_000), unavailableCount: 2 } };
  const hp = hero(partial);
  assert.ok(hp.includes(`Period change unavailable — ${REFUSAL_COPY.OPENING_ENDPOINT_INCOMPLETE}`), hp);
  assert.ok(!/%/.test(hp), "no percentage over a partial opening");
  // Estimated basis: the value change, labelled estimated, no %.
  const est = { ...reconciliation, completeness: "estimated", changeInterpretation: "return", hasExternalFlows: false };
  const he = hero(est);
  assert.ok(/£2,000/.test(he) && /2026-10-03 · estimated/.test(he) && !/%/.test(he), he);
  // A like-for-like, flow-free, observed period: the return %.
  const ret = { ...reconciliation, changeInterpretation: "return", hasExternalFlows: false };
  assert.ok(/25\.0%/.test(hero(ret)), hero(ret));
  // A value change with external flows: the amount, never a %.
  assert.ok(/£2,000/.test(hero(reconciliation)) && !/%/.test(hero(reconciliation)));
  // With a verdict, the verdict alone decides (unchanged).
  assert.ok(/25\.0%/.test(hero(reconciliation, attribution)));
  assert.equal(reconciliationComparison(partial as never).showPercentage, false);
  // The fallback division is gone from the hero.
  const src = readFileSync(new URL("../../components/space/widgets/investments/InvestmentsHero.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\/\s*opening\)/.test(src) && !/\* 100/.test(src), "the hero computes no percentage of its own");
  ok("M5 hero %: partial/unpriced opening withheld with reason, estimated labelled, return % only when comparable");
}

// ── M7 — one allocation authority ────────────────────────────────────────────
{
  assert.deepEqual(DATA.historicalAllocation, computeAllocation(HOLDINGS as never, NAMES), "historical allocation computed at assembly");
  assert.equal(assembleInvestmentsSpaceData({ current: current as never }).historicalAllocation, undefined, "absent without historical");
  const conv = convertInvestmentsSpaceData(DATA, ctx(true), "2026-11-03");
  assert.ok(near(conv.historicalAllocation!.valuedTotal, 12_000) && near(conv.historicalAllocation!.byAssetClass[0].value, 10_800), "converted like current's");
  assert.deepEqual(conv.historicalAllocation!.concentration, DATA.historicalAllocation!.concentration, "weights scale-invariant");

  // Both views read the SAME object and so cannot diverge.
  const alloc = DATA.current.allocation;
  const conc = text(renderToStaticMarkup(createElement(HoldingsConcentration, { allocation: alloc })));
  const panel = text(renderToStaticMarkup(createElement(InvestmentAllocationPanel, {
    allocation: alloc, holdings: HOLDINGS as never, accounts: [{ id: "a1", name: "Brokerage" }, { id: "a2", name: "IRA" }], reportingCurrency: "GBP",
  })));
  assert.ok(conc.includes("VTI 60.0%"), conc);
  assert.ok(/US_STOCK £9,000\.00 90\.0%/.test(panel) && /BOND £1,000\.00 10\.0%/.test(panel), panel);
  assert.ok(conc.includes("VTI 60.0%") && panel.includes("top VTI 60%"), "the card and the panel state the same concentration");
  assert.equal(renderToStaticMarkup(createElement(HoldingsConcentration, { allocation: null })), "", "no allocation ⇒ nothing, never a client recompute");

  // Pin: computeAllocation has ONE call site outside tests — space-data-core.
  const ROOT = process.cwd();
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (f === "node_modules" || f.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
  const sites = ["lib", "components", "app"].flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => /\bcomputeAllocation\s*\(/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")))
    .map((f) => relative(ROOT, f)).sort();
  assert.deepEqual(sites, ["lib/investments/investments-allocation-core.ts", "lib/investments/space-data-core.ts"],
    `computeAllocation call sites: ${sites.join(", ")}`);
  const ws = readFileSync(new URL("../../components/space/widgets/investments/InvestmentsWorkspace.tsx", import.meta.url), "utf8");
  assert.ok(/data\.historicalAllocation \?\? null : data\.current\.allocation/.test(ws) && /<HoldingsConcentration allocation=\{allocation\} \/>/.test(ws)
    && /allocation=\{allocation\}\n\s*holdings=\{primary\.holdings\}/.test(ws), "the workspace hands both views the one allocation");
  ok("M7 Allocation + Concentration read ONE server allocation (current and historical); single computation site pinned");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`pb11-investments-correctness: ${checks.length} checks passed`);
