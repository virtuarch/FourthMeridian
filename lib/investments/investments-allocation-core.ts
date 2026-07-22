/**
 * lib/investments/investments-allocation-core.ts
 *
 * PURE assembly of the Investments Allocation view — the "how am I diversified?"
 * question the shipped Investments Perspective doesn't yet answer. No DB, clock,
 * or network: a deterministic reduce over the ALREADY-VALUED `ValuedHoldingRow[]`
 * the A10 read model already produces (fixture-tested, no `prisma generate`).
 *
 * It creates NO valuation, price, or FX arithmetic — every figure is a sum of
 * the canonical per-holding `reportingValue` the valuation service already
 * computed. Four composition breakdowns (asset class · sector · account ·
 * currency) plus a concentration read reusing the shared formula in
 * ./concentration (the same math the AI holdings assembler uses).
 *
 * Honesty: only VALUED rows (reportingValue != null) contribute — an unvalued
 * holding is disclosed as a count, never folded in at zero. Concentration is a
 * RISK read, so it excludes cash (isCash) exactly as the assembler does; the
 * asset-class breakdown still shows Cash as its own slice.
 */

import { computeConcentration, type ConcentrationMetrics } from "./concentration";
import type { ValuedHoldingRow } from "./investments-time-machine-core";

/** Humanized AssetClass labels (raw enum VALUE → display). */
const ASSET_CLASS_LABEL: Record<string, string> = {
  EQUITY:       "Equity",
  ETF:          "ETF",
  MUTUAL_FUND:  "Mutual fund",
  FIXED_INCOME: "Fixed income",
  OPTION:       "Option",
  CRYPTO:       "Crypto",
  CASH:         "Cash",
  OTHER:        "Other",
  UNKNOWN:      "Unknown",
};

/** One slice of a composition breakdown, in the reporting currency. */
export interface AllocationSlice {
  /** Stable grouping key (enum value / accountId / currency / sentinel). */
  key:   string;
  /** Display label. */
  label: string;
  /** Summed reporting-currency value of the slice. */
  value: number;
  /** value / valuedTotal, 0..1. */
  share: number;
}

/** The four composition axes + concentration + honesty counts. */
export interface AllocationResult {
  /** Σ reportingValue over valued rows — the denominator for every share. */
  valuedTotal:   number;
  valuedCount:   number;
  /** Rows the valuation service could not value (disclosed, never folded in). */
  unvaluedCount: number;
  byAssetClass:  AllocationSlice[];
  bySector:      AllocationSlice[];
  byAccount:     AllocationSlice[];
  byCurrency:    AllocationSlice[];
  /** Concentration over valued, NON-CASH, per-instrument weights. */
  concentration: ConcentrationMetrics;
}

const UNKNOWN_KEY = "__unknown__";

/** The four composition axes, as a value the UI can pass around. */
export type AllocationDimension = "assetClass" | "sector" | "account" | "currency";

/**
 * How each axis buckets a row — the SINGLE definition of slice membership.
 *
 * `computeAllocation` reduces through these, and `holdingsInSlice` selects
 * through these, so a slice's total and the rows a drill-down shows are the same
 * set by construction. Re-deriving "the same" key in the UI is exactly how a
 * segment and its detail panel drift apart.
 *
 * Aggregation is UNCHANGED by their extraction: these are the identical
 * expressions the breakdowns already used, now named once.
 */
export const ALLOCATION_KEY_OF: Record<AllocationDimension, (r: ValuedHoldingRow) => string> = {
  assetClass: (r) => r.assetClass || "UNKNOWN",
  sector:     (r) => r.sector ?? UNKNOWN_KEY,
  account:    (r) => r.accountId,
  currency:   (r) => r.currency ?? UNKNOWN_KEY,
};

/**
 * The valued holdings behind one slice, largest first.
 *
 * Applies the SAME valued-only filter the breakdowns apply, so the returned rows
 * sum to that slice's `value`. Pure selection — no valuation, FX, or historical
 * arithmetic is introduced here.
 */
export function holdingsInSlice(
  holdings:  readonly ValuedHoldingRow[],
  dimension: AllocationDimension,
  key:       string,
): ValuedHoldingRow[] {
  const keyOf = ALLOCATION_KEY_OF[dimension];
  return holdings
    .filter((h) => h.reportingValue != null && keyOf(h) === key)
    .sort((a, b) => (b.reportingValue as number) - (a.reportingValue as number));
}

/** Deterministic slice order: value desc, then key asc. */
function sliceSort(a: AllocationSlice, b: AllocationSlice): number {
  if (a.value !== b.value) return b.value - a.value;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Reduce valued rows into a breakdown by a caller-chosen key+label. */
function breakdown(
  rows:        readonly ValuedHoldingRow[],
  valuedTotal: number,
  keyOf:       (r: ValuedHoldingRow) => string,
  labelOf:     (key: string, r: ValuedHoldingRow) => string,
): AllocationSlice[] {
  const acc = new Map<string, { label: string; value: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    const bucket = acc.get(key) ?? { label: labelOf(key, r), value: 0 };
    bucket.value += r.reportingValue as number; // rows pre-filtered to valued
    acc.set(key, bucket);
  }
  return [...acc.entries()]
    .map(([key, b]) => ({ key, label: b.label, value: b.value, share: valuedTotal > 0 ? b.value / valuedTotal : 0 }))
    .sort(sliceSort);
}

/**
 * Compose the allocation view. Pure and deterministic.
 * @param holdings     the A10 `ValuedHoldingRow[]` (per account×instrument).
 * @param accountNames accountId → display name (for the by-account axis).
 */
export function computeAllocation(
  holdings:     readonly ValuedHoldingRow[],
  accountNames: Record<string, string> = {},
): AllocationResult {
  const valued = holdings.filter((h) => h.reportingValue != null);
  const unvaluedCount = holdings.length - valued.length;
  const valuedTotal = valued.reduce((s, h) => s + (h.reportingValue as number), 0);

  // Every axis reduces through ALLOCATION_KEY_OF — the same functions
  // holdingsInSlice selects through, so totals and drill-downs cannot disagree.
  const byAssetClass = breakdown(
    valued, valuedTotal,
    ALLOCATION_KEY_OF.assetClass,
    (key) => ASSET_CLASS_LABEL[key] ?? key,
  );
  const bySector = breakdown(
    valued, valuedTotal,
    ALLOCATION_KEY_OF.sector,
    (key) => (key === UNKNOWN_KEY ? "Unknown" : key),
  );
  const byAccount = breakdown(
    valued, valuedTotal,
    ALLOCATION_KEY_OF.account,
    (key) => accountNames[key] ?? "Unknown account",
  );
  const byCurrency = breakdown(
    valued, valuedTotal,
    ALLOCATION_KEY_OF.currency,
    (key) => (key === UNKNOWN_KEY ? "Unknown" : key),
  );

  // ── Concentration: valued, NON-CASH, aggregated per instrument ──────────────
  const nonCash = valued.filter((h) => !h.isCash);
  const nonCashTotal = nonCash.reduce((s, h) => s + (h.reportingValue as number), 0);
  const byInstrument = new Map<string, { symbol: string | null; value: number }>();
  for (const h of nonCash) {
    const b = byInstrument.get(h.instrumentId) ?? { symbol: h.symbol ?? h.name ?? null, value: 0 };
    b.value += h.reportingValue as number;
    byInstrument.set(h.instrumentId, b);
  }
  const positions = [...byInstrument.values()]
    .map((p) => ({ symbol: p.symbol, weight: nonCashTotal > 0 ? p.value / nonCashTotal : 0, value: p.value }))
    .sort((a, b) => b.value - a.value);
  const concentration = computeConcentration(positions, nonCashTotal);

  return {
    valuedTotal,
    valuedCount: valued.length,
    unvaluedCount,
    byAssetClass,
    bySector,
    byAccount,
    byCurrency,
    concentration,
  };
}
