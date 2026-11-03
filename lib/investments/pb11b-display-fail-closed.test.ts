/**
 * lib/investments/pb11b-display-fail-closed.test.ts  (PB-11b — follow-up to PB-11)
 *
 * (1) `makeConv` returned `c.amount ?? amount`: on a rate miss EVERY total —
 *     current totals, allocation, historical holdings / portfolio, reconciliation,
 *     flows / activity, trust residual, accounts — kept its SOURCE-currency
 *     magnitude under the display-currency label. It now fails CLOSED: the
 *     conversion returns null and the workspace renders "unavailable in <ccy>"
 *     with the reason; no figure in any currency is shown.
 * (2) `reconciliationComparison` never reads an absent / non-finite total: it
 *     withholds (PERIOD_TOTALS_UNAVAILABLE).
 * (3) A coverage mismatch with no unvalued holding at either endpoint gets its
 *     own honest reason (ENDPOINT_COVERAGE_MISMATCH), not CLOSING_ENDPOINT_INCOMPLETE.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/investments/pb11b-display-fail-closed.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversionContext } from "@/lib/money/types";
import { convertInvestmentsSpaceData, investmentsDisplayUnavailable } from "./display-conversion";
import { assessPeriodAttribution, reconciliationComparison, REFUSAL_COPY } from "./period-attribution.core";
import { assembleInvestmentsSpaceData, type InvestmentsSpaceData } from "./space-data-core";
import { computeAllocation } from "./investments-allocation-core";
import { InvestmentsDisplayUnavailable } from "@/components/space/widgets/investments/InvestmentsDisplayUnavailable";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ── Fixture: a GBP Space with EVERY converted surface populated ──────────────
const DAY = "2026-11-03";
const rate = (rate: number | null): ConversionContext => ({
  target: "EUR",
  resolve: (from, d) => rate !== null && from === "GBP"
    ? { kind: "rate", rate, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }
    : { kind: "miss", quote: from, requestedDateISO: d },
});
const row = (id: string, acct: string, v: number, cls: string) => ({
  instrumentId: id, accountId: acct, quantity: 1, nativePrice: v, nativeValue: v, reportingValue: v,
  currency: "GBP", reportingCurrency: "GBP", quantityTier: "observed", priceTier: "observed", fxTier: "observed",
  overallTier: "observed", basisUsed: "raw-close", priceDate: DAY, staleDays: 0, reason: "ok",
  conflicted: false, symbol: id.toUpperCase(), name: id, share: null, assetClass: cls, sector: null, isCash: false,
});
const HOLDINGS = [row("vti", "a1", 61_234.57, "US_STOCK"), row("bnd", "a2", 13_579.24, "BOND")];
const TOTAL = 74_813.81;
const cov = (v: number) => ({ valuedValue: v, observedValue: v, estimatedValue: 0, valuedCount: 2, unavailableCount: 0, unavailableValue: null, coverageByCount: 1, fullyObserved: true });
const portfolio = { reportingCurrency: "GBP", valuedSubtotal: TOTAL, valuedCount: 2, unvaluedCount: 0, unvalued: [], coverage: cov(TOTAL), completeness: { tier: "observed", conflict: false, reason: "", byInstrument: {} } };
const flows = {
  from: "2026-10-03", to: DAY, reportingCurrency: "GBP", eventCount: 2,
  contributions: 4_321.09, withdrawals: -987.65, transfersIn: 0, transfersOut: 0, buys: 0, sells: 0, income: 55.44, fees: -6.66,
  netExternalFlows: 3_333.44, byCategory: [{ category: "contribution", count: 1, amount: 4_321.09 }],
  inKindTransferCount: 0, unclassifiedCount: 0, externalAmountMissingCount: 0, fxEstimated: false, completeness: "observed", reason: "",
};
const reconciliation = {
  from: "2026-10-03", to: DAY, reportingCurrency: "GBP",
  openingValue: 66_666.67, closingValue: TOTAL, totalChange: 8_147.14, netExternalFlows: 3_333.44, residualChange: 4_813.70,
  residualReason: "", completeness: "observed", conflict: false, endpointIncomplete: false,
  openingCoverage: cov(66_666.67), closingCoverage: cov(TOTAL), coverageConsistent: true,
  hasExternalFlows: true, changeInterpretation: "value-change", reason: "",
};
const attribution = assessPeriodAttribution({
  fromISO: "2026-10-03", toISO: DAY, reportingCurrency: "GBP",
  openingValue: 66_666.67, closingValue: TOTAL, moneyIn: 4_321.09, moneyOut: -987.65, netExternalFlows: 3_333.44, residualChange: 4_813.70,
  openingUnvaluedCount: 0, closingUnvaluedCount: 0, openingTier: "observed", closingTier: "observed",
  openingComponentValues: [55_000, 11_666.67], openingInstrumentIds: ["vti", "bnd"], closingInstrumentIds: ["vti", "bnd"],
  flowCompleteness: "observed", conflict: false,
});
const NAMES = { a1: "Brokerage", a2: "IRA" };
const base = assembleInvestmentsSpaceData({
  current: { asOf: DAY, reportingCurrency: "GBP", holdings: HOLDINGS, portfolio, allocation: computeAllocation(HOLDINGS as never, NAMES) } as never,
  historical: { asOf: DAY, compareTo: "2026-10-03", reportingCurrency: "GBP", holdings: HOLDINGS, portfolio, flows, reconciliation,
    completeness: { tier: "observed", conflict: false, reason: "", byInstrument: {} }, attribution } as never,
  accountNames: NAMES,
});
const DATA: InvestmentsSpaceData = {
  ...base,
  trust: { ...base.trust!, residual: 4_813.70 },
  accounts: { reportingCurrency: "GBP", rows: [{ accountId: "a1", name: "Brokerage", value: 61_234.57 } as never], investmentsTotal: TOTAL, cryptoTotal: 1_212.12 },
};
// Every source-currency figure a fail-open conversion would have relabelled.
const SOURCE_FIGURES = [TOTAL, 61_234.57, 13_579.24, 66_666.67, 8_147.14, 3_333.44, 4_813.70, 4_321.09, 987.65, 55.44, 1_212.12];
const shows = (html: string, n: number) => [n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2 }), Math.round(n).toLocaleString("en-US")]
  .some((f) => html.includes(f));

async function main() {
  // ── (1) a rate miss fails closed across every surface ──────────────────────
  assert.ok(DATA.current && DATA.historical && DATA.activity && DATA.trust && DATA.accounts && DATA.historicalAllocation, "every surface is populated");
  assert.equal(convertInvestmentsSpaceData(DATA, rate(null), DAY), null, "no rate ⇒ null, never a relabelled contract");

  // A resolver that answers the probe and then misses: the conversion is refused
  // whole, never a partial mix of converted and source figures.
  let calls = 0;
  const flaky: ConversionContext = { target: "EUR", resolve: (from, d) => (calls++ === 0
    ? { kind: "rate", rate: 2, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }
    : { kind: "miss", quote: from, requestedDateISO: d }) };
  assert.equal(convertInvestmentsSpaceData(DATA, flaky, DAY), null, "a later miss refuses the whole conversion");

  const u = investmentsDisplayUnavailable("GBP", "EUR", DAY);
  assert.deepEqual(u, { currency: "EUR", from: "GBP", dateISO: DAY,
    reason: `${REFUSAL_COPY.DISPLAY_RATE_UNAVAILABLE} (no GBP→EUR rate for ${DAY}).` });
  const html = text(renderToStaticMarkup(createElement(InvestmentsDisplayUnavailable, { unavailable: u })));
  assert.ok(html.includes("Unavailable in EUR") && html.includes("Investments are unavailable in EUR") && html.includes(u.reason), html);
  assert.ok(!/£|€\s*\d/.test(html), "no money symbol with a figure");
  for (const n of SOURCE_FIGURES) assert.ok(!shows(html, n), `source figure ${n} is not rendered`);

  // The workspace short-circuits BEFORE any figure-bearing surface.
  const ws = readFileSync(new URL("../../components/space/widgets/investments/InvestmentsWorkspace.tsx", import.meta.url), "utf8");
  const stop = ws.indexOf("if (displayUnavailable) {\n    return <InvestmentsDisplayUnavailable");
  assert.ok(stop > 0, "the workspace renders the unavailable state");
  for (const surface of ["<InvestmentsHero", "<InvestmentAllocationPanel", "<HoldingsLedger", "<HoldingsConcentration", "<InvestmentAccountsLedger", "<InvestmentsBridgeCard"]) {
    assert.ok(ws.indexOf(surface) > stop, `${surface} is only reachable after the unavailable short-circuit`);
  }
  assert.ok(/const displayUnavailable = raw && ctx && data === null/.test(ws));
  // The fail-open fallback is gone.
  const dc = readFileSync(new URL("./display-conversion.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\?\?\s*amount/.test(dc), "makeConv no longer keeps the source amount");
  ok("(1) rate miss: null contract, 'unavailable in EUR' with the reason, no source figure rendered anywhere");

  // Hit and identity are unchanged.
  const hit = convertInvestmentsSpaceData(DATA, rate(2), DAY)!;
  assert.equal(hit.current.portfolio.valuedSubtotal, TOTAL * 2);
  assert.equal(hit.historical!.attribution!.closingValue, TOTAL * 2);
  assert.equal(hit.accounts!.cryptoTotal, 1_212.12 * 2);
  assert.equal(hit.historicalAllocation!.valuedTotal, TOTAL * 2);
  const gbp: ConversionContext = { target: "GBP", resolve: (f, d) => ({ kind: "miss", quote: f, requestedDateISO: d }) };
  const same = convertInvestmentsSpaceData(DATA, gbp, DAY);
  assert.equal(same, DATA, "identity: the same reference");
  assert.equal(JSON.stringify(same), JSON.stringify(DATA), "identity: byte-identical");
  ok("hit converts every surface; identity is byte-identical");

  // ── (2) the fallback never reads an absent total ───────────────────────────
  const rc = (over: Record<string, unknown>) => reconciliationComparison({ ...reconciliation, ...over } as never);
  for (const k of ["openingValue", "closingValue", "totalChange"]) {
    for (const v of [null, Number.NaN]) {
      const g = rc({ [k]: v });
      assert.ok(!g.showChange && g.changeAmount === null && g.percentage === null, `${k}=${v}`);
      assert.equal(g.suppressedReason, REFUSAL_COPY.PERIOD_TOTALS_UNAVAILABLE);
    }
  }
  assert.equal(rc({}).showChange, true, "a complete reconciliation still compares");
  ok("(2) reconciliationComparison withholds on an absent / non-finite total");

  // ── (3) the coverage-mismatch reason ───────────────────────────────────────
  const zero = { ...cov(1), unavailableCount: 0 }, two = { ...cov(1), unavailableCount: 2 };
  assert.equal(rc({ coverageConsistent: false, changeInterpretation: "incomparable", openingCoverage: zero, closingCoverage: zero }).suppressedReason,
    REFUSAL_COPY.ENDPOINT_COVERAGE_MISMATCH, "neither endpoint short ⇒ coverage mismatch, not 'closing incomplete'");
  assert.equal(rc({ endpointIncomplete: true, openingCoverage: zero, closingCoverage: zero }).suppressedReason, REFUSAL_COPY.ENDPOINT_COVERAGE_MISMATCH);
  assert.equal(rc({ endpointIncomplete: true, openingCoverage: zero, closingCoverage: two }).suppressedReason, REFUSAL_COPY.CLOSING_ENDPOINT_INCOMPLETE);
  assert.equal(rc({ endpointIncomplete: true, openingCoverage: two, closingCoverage: zero }).suppressedReason, REFUSAL_COPY.OPENING_ENDPOINT_INCOMPLETE);
  ok("(3) coverage mismatch has its own reason; opening / closing reasons only when that endpoint is short");
}

main().then(() => {
  for (const c of checks) console.log("  ✓ " + c);
  console.log(`pb11b-display-fail-closed: ${checks.length} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
