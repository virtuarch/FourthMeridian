/**
 * lib/investments/display-conversion.ts  (SD-4D)
 *
 * THE pure display-currency transform for the Investments workspace. It converts a
 * canonical `InvestmentsSpaceData` (denominated in its Space REPORTING currency) into
 * the member's selected DISPLAY currency for presentation ONLY:
 *
 *   persisted canonical facts      → never touched (this is a pure value transform)
 *   InvestmentsSpaceData (reporting) → convertInvestmentsSpaceData(data, ctx, date)
 *                                    → InvestmentsSpaceData (display)
 *
 * It reuses the ONE canonical money authority (`convertMoney` / `ConversionContext`,
 * lib/money) — no bespoke FX math, no second rate source. Every value is in the SAME
 * reporting currency, so one rate applies uniformly; shares/weights/percentages are
 * scale-invariant and pass through unchanged, and NATIVE instrument fields
 * (`nativePrice`, `nativeValue`, `currency`) and the native-denominated `costBasis`
 * stay native — they are intentionally instrument-level and are never relabeled.
 *
 * Honesty (PB-11b): a missing rate FAILS CLOSED — the conversion returns null and
 * the view says the portfolio is unavailable in the display currency; no source
 * figure is ever relabelled. We never fabricate a rate. When the
 * reporting currency already IS the target, the whole transform is identity (no
 * allocation, no relabel), so the all-USD path is byte-unchanged.
 *
 * EXHAUSTIVENESS is load-bearing: because we relabel `reportingCurrency` → target,
 * every reporting-currency money field MUST be converted, or a missed field would
 * masquerade (old magnitude under a new label). display-conversion.test.ts scales by
 * a known rate and asserts EVERY money field moved and every native/share field did not.
 */

import type { InvestmentAccountsSlice } from "./investment-accounts";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { InvestmentsSpaceData, CurrentPortfolio } from "./space-data-core";
import type {
  InvestmentsPortfolio,
  InvestmentsReconciliation,
  InvestmentsTimeMachineResult,
  PortfolioValuationCoverage,
  ValuedHoldingRow,
} from "./investments-time-machine-core";
import type { CurrentPositionRow } from "./current-positions-core";
import type { AllocationResult, AllocationSlice } from "./investments-allocation-core";
import type { PeriodFlows } from "./investment-flows-core";
import type { InvestmentsTrustSummary } from "./investments-trust";
import { REFUSAL_COPY, type PeriodAttribution } from "./period-attribution.core";

/** A converter bound to one (source reporting currency, rate date, context). */
type Conv = (amount: number) => number;

/** Thrown inside a conversion when a figure has no display-currency value. */
class DisplayRateMiss extends Error {}

/**
 * PB-11b — FAIL CLOSED. Returns null when there is no `from → target` rate at
 * `dateISO`: the contract cannot be shown in the display currency at all.
 *
 * It used to return `c.amount ?? amount` — on a miss, every total (current,
 * allocation, historical holdings / portfolio, reconciliation, flows, trust
 * residual, accounts) kept its SOURCE-currency magnitude under the display
 * label (the defensive edge V25-FINAL-1 described: £10,000 shown as €10,000).
 * A missing rate is now said, never relabelled. One rate applies to the whole
 * single-reporting-currency contract (one `from`, one `dateISO`), so the probe
 * decides; should any single figure still come back without a value, the
 * converter throws and the whole conversion is refused (never a partial mix).
 */
function makeConv(from: string, dateISO: string, ctx: ConversionContext): Conv | null {
  if (convertMoney({ amount: 1, currency: from }, dateISO, ctx).amount === null) return null;
  return (amount: number) => {
    const c = convertMoney({ amount, currency: from }, dateISO, ctx);
    if (c.amount === null) throw new DisplayRateMiss();
    return c.amount;
  };
}

/**
 * PB-11b — why a contract could not be converted, for the view's
 * "unavailable in <ccy>" state. Currency codes and the date only.
 */
export interface InvestmentsDisplayUnavailable {
  currency: string;
  from:     string;
  dateISO:  string;
  reason:   string;
}

export function investmentsDisplayUnavailable(from: string, target: string, dateISO: string): InvestmentsDisplayUnavailable {
  return {
    currency: target, from, dateISO,
    reason: `${REFUSAL_COPY.DISPLAY_RATE_UNAVAILABLE} (no ${from}→${target} rate for ${dateISO}).`,
  };
}

/** Convert one valued holding row: only `reportingValue` is reporting-currency.
 *  `nativePrice`/`nativeValue`/`currency` stay native; `costBasis` (native, Plaid
 *  aggregate) stays native; `share`/`quantity`/tiers are unaffected. */
function convRow<T extends ValuedHoldingRow>(row: T, c: Conv, target: string): T {
  return {
    ...row,
    reportingValue:    row.reportingValue == null ? row.reportingValue : c(row.reportingValue),
    reportingCurrency: target,
  };
}

/** Convert the reporting-currency money in a coverage block; ratios/counts/flags
 *  are scale-invariant and pass through. `unavailableValue` may be null. */
function convCoverage(cov: PortfolioValuationCoverage, c: Conv): PortfolioValuationCoverage {
  return {
    ...cov,
    valuedValue:      c(cov.valuedValue),
    observedValue:    c(cov.observedValue),
    estimatedValue:   c(cov.estimatedValue),
    unavailableValue: cov.unavailableValue == null ? cov.unavailableValue : c(cov.unavailableValue),
  };
}

function convPortfolio(p: InvestmentsPortfolio, c: Conv, target: string): InvestmentsPortfolio {
  // `unvalued[]` positions carry no reporting value (that is why they are unvalued),
  // so there is nothing to convert there.
  return { ...p, valuedSubtotal: c(p.valuedSubtotal), coverage: convCoverage(p.coverage, c), reportingCurrency: target };
}

function convSlices(slices: AllocationSlice[], c: Conv): AllocationSlice[] {
  // `share` is a ratio (scale-invariant) — only the absolute `value` converts.
  return slices.map((s) => ({ ...s, value: c(s.value) }));
}

function convAllocation(a: AllocationResult, c: Conv): AllocationResult {
  // `concentration` is weight/Herfindahl only (no money). `valuedTotal` is the shared
  // denominator; converting it and every slice value keeps shares identical.
  return {
    ...a,
    valuedTotal:  c(a.valuedTotal),
    byAssetClass: convSlices(a.byAssetClass, c),
    bySector:     convSlices(a.bySector, c),
    byAccount:    convSlices(a.byAccount, c),
    byCurrency:   convSlices(a.byCurrency, c),
  };
}

function convFlows(f: PeriodFlows, c: Conv, target: string): PeriodFlows {
  return {
    ...f,
    contributions:    c(f.contributions),
    withdrawals:      c(f.withdrawals),
    transfersIn:      c(f.transfersIn),
    transfersOut:     c(f.transfersOut),
    buys:             c(f.buys),
    sells:            c(f.sells),
    income:           c(f.income),
    fees:             c(f.fees),
    netExternalFlows: c(f.netExternalFlows),
    byCategory:       f.byCategory.map((b) => ({ ...b, amount: c(b.amount) })),
    reportingCurrency: target,
  };
}

function convReconciliation(r: InvestmentsReconciliation, c: Conv, target: string): InvestmentsReconciliation {
  return {
    ...r,
    openingValue:     c(r.openingValue),
    closingValue:     c(r.closingValue),
    totalChange:      c(r.totalChange),
    netExternalFlows: c(r.netExternalFlows),
    residualChange:   c(r.residualChange),
    openingCoverage:  convCoverage(r.openingCoverage, c),
    closingCoverage:  convCoverage(r.closingCoverage, c),
    reportingCurrency: target,
  };
}

function convTrust(t: InvestmentsTrustSummary, c: Conv): InvestmentsTrustSummary {
  // Only `residual` (change-completeness money) is a reporting-currency figure; every
  // other field is a count, tier, label, or structured indicator.
  return { ...t, residual: t.residual == null ? t.residual : c(t.residual) };
}

/**
 * PB-11 M4 — the period verdict's money, through the SAME converter (same rate,
 * same `dateISO`) as the reconciliation and portfolio totals it sits beside.
 * It used to ride through `...h` untouched, so a converted Space showed its
 * opening / money in / money out / change in the reporting currency next to
 * display-currency totals. PB-11b — a rate miss never reaches here: the whole
 * contract is refused (makeConv), so no period figure — closing value included
 * — is ever shown in a currency it was not converted to.
 */
function convAttribution(a: PeriodAttribution, c: Conv, target: string): PeriodAttribution {
  const n = (v: number | null) => (v == null ? v : c(v));
  return {
    ...a,
    reportingCurrency:  target,
    closingValue:       c(a.closingValue),
    openingValue:       n(a.openingValue),
    moneyIn:            n(a.moneyIn),
    moneyOut:           n(a.moneyOut),
    portfolioChange:    n(a.portfolioChange),
    unattributedChange: n(a.unattributedChange),
  };
}

function convHistorical(h: InvestmentsTimeMachineResult, c: Conv, target: string): InvestmentsTimeMachineResult {
  return {
    ...h,
    ...(h.attribution ? { attribution: convAttribution(h.attribution, c, target) } : {}),
    holdings:       h.holdings.map((r) => convRow(r, c, target)),
    portfolio:      convPortfolio(h.portfolio, c, target),
    flows:          h.flows ? convFlows(h.flows, c, target) : h.flows,
    reconciliation: h.reconciliation ? convReconciliation(h.reconciliation, c, target) : h.reconciliation,
    reportingCurrency: target,
  };
}

function convCurrent(cur: CurrentPortfolio, c: Conv, target: string): CurrentPortfolio {
  return {
    ...cur,
    holdings:   cur.holdings.map((r) => convRow<CurrentPositionRow>(r, c, target)),
    portfolio:  convPortfolio(cur.portfolio, c, target),
    allocation: convAllocation(cur.allocation, c),
    reportingCurrency: target,
  };
}

/**
 * Convert an entire `InvestmentsSpaceData` into the context's target display currency.
 * Identity (returns the input unchanged) when the reporting currency already IS the
 * target — the common all-same-currency path stays byte-identical.
 *
 * @param data   the canonical reporting-currency contract (unchanged)
 * @param ctx    the display ConversionContext (its `target` is the display currency)
 * @param dateISO the rate date to resolve at (typically the current asOf); one rate
 *               applies to the whole single-reporting-currency contract
 */
export function convertInvestmentsSpaceData(
  data:    InvestmentsSpaceData,
  ctx:     ConversionContext,
  dateISO: string,
): InvestmentsSpaceData | null {
  const from = data.current.reportingCurrency;
  if (from === ctx.target) return data; // identity fast-path — no conversion, no relabel
  // PB-11b — no rate ⇒ null: the caller renders "unavailable in <ccy>"
  // (investmentsDisplayUnavailable), never a source-currency figure.
  const c = makeConv(from, dateISO, ctx);
  if (!c) return null;
  try {
    return convertWith(data, c, ctx.target);
  } catch (e) {
    if (e instanceof DisplayRateMiss) return null;
    throw e;
  }
}

function convertWith(data: InvestmentsSpaceData, c: Conv, target: string): InvestmentsSpaceData {
  const ctx = { target };
  return {
    current:    convCurrent(data.current, c, ctx.target),
    ...(data.historical ? { historical: convHistorical(data.historical, c, ctx.target) } : {}),
    // `activity` IS `historical.flows` re-surfaced — convert it identically so the two
    // can never disagree.
    ...(data.activity ? { activity: convFlows(data.activity, c, ctx.target) } : {}),
    ...(data.trust ? { trust: convTrust(data.trust, c) } : {}),
    ...(data.scopeDivergence ? { scopeDivergence: data.scopeDivergence } : {}),
    ...(data.accounts ? { accounts: convAccounts(data.accounts, c, ctx.target) } : {}),
    // PB-11 M7 — the historical allocation (server-computed) converts like current's.
    ...(data.historicalAllocation ? { historicalAllocation: convAllocation(data.historicalAllocation, c) } : {}),
  };
}

/** The investment-account ledger — every money field, through the SAME display conversion. */
function convAccounts(a: InvestmentAccountsSlice, c: Conv, target: string): InvestmentAccountsSlice {
  return {
    reportingCurrency: target,
    rows:              a.rows.map((r) => ({ ...r, value: r.value == null ? null : c(r.value) })),
    investmentsTotal:  c(a.investmentsTotal),
    cryptoTotal:       c(a.cryptoTotal),
  };
}
