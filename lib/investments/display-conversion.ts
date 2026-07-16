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
 * Honesty (the money contract, D-3): a missing rate passes the native amount through
 * flagged `estimated` — `convertMoney` owns that; we never fabricate a rate. When the
 * reporting currency already IS the target, the whole transform is identity (no
 * allocation, no relabel), so the all-USD path is byte-unchanged.
 *
 * EXHAUSTIVENESS is load-bearing: because we relabel `reportingCurrency` → target,
 * every reporting-currency money field MUST be converted, or a missed field would
 * masquerade (old magnitude under a new label). display-conversion.test.ts scales by
 * a known rate and asserts EVERY money field moved and every native/share field did not.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { InvestmentsSpaceData, CurrentPortfolio } from "./space-data-core";
import type {
  InvestmentsPortfolio,
  InvestmentsReconciliation,
  InvestmentsTimeMachineResult,
  ValuedHoldingRow,
} from "./investments-time-machine-core";
import type { CurrentPositionRow } from "./current-positions-core";
import type { AllocationResult, AllocationSlice } from "./investments-allocation-core";
import type { PeriodFlows } from "./investment-flows-core";
import type { InvestmentsTrustSummary } from "./investments-trust";

/** A converter bound to one (source reporting currency, rate date, context). */
type Conv = (amount: number) => number;

function makeConv(from: string, dateISO: string, ctx: ConversionContext): Conv {
  return (amount: number) => convertMoney({ amount, currency: from }, dateISO, ctx).amount;
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

function convPortfolio(p: InvestmentsPortfolio, c: Conv, target: string): InvestmentsPortfolio {
  // `unvalued[]` positions carry no reporting value (that is why they are unvalued),
  // so there is nothing to convert there.
  return { ...p, valuedSubtotal: c(p.valuedSubtotal), reportingCurrency: target };
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
    reportingCurrency: target,
  };
}

function convTrust(t: InvestmentsTrustSummary, c: Conv): InvestmentsTrustSummary {
  // Only `residual` (change-completeness money) is a reporting-currency figure; every
  // other field is a count, tier, label, or structured indicator.
  return { ...t, residual: t.residual == null ? t.residual : c(t.residual) };
}

function convHistorical(h: InvestmentsTimeMachineResult, c: Conv, target: string): InvestmentsTimeMachineResult {
  return {
    ...h,
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
): InvestmentsSpaceData {
  const from = data.current.reportingCurrency;
  if (from === ctx.target) return data; // identity fast-path — no conversion, no relabel
  const c = makeConv(from, dateISO, ctx);

  return {
    current:    convCurrent(data.current, c, ctx.target),
    ...(data.historical ? { historical: convHistorical(data.historical, c, ctx.target) } : {}),
    // `activity` IS `historical.flows` re-surfaced — convert it identically so the two
    // can never disagree.
    ...(data.activity ? { activity: convFlows(data.activity, c, ctx.target) } : {}),
    ...(data.trust ? { trust: convTrust(data.trust, c) } : {}),
  };
}
