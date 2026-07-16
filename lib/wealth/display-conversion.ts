/**
 * lib/wealth/display-conversion.ts  (SD-5)
 *
 * Per-date display-currency conversion of the SpaceSnapshot series that feeds the
 * Wealth Time Machine. It mirrors the NetWorthChart model exactly: EACH snapshot is
 * converted at ITS OWN date, through the ONE canonical money authority
 * (`convertMoney` / `ConversionContext`, lib/money), from the Space's snapshot
 * (reporting) currency into the member's selected DISPLAY currency — BEFORE
 * `computeWealthTimeMachine` derives net worth, deltas, drivers, the chart series,
 * and the deterministic explanation.
 *
 * Why convert the INPUT series, not the WealthResult (unlike Investments' SD-4D
 * result transform): the Time Machine bakes per-date deltas AND a pre-FORMATTED
 * `explanation` sentence into its output. Converting the result would leave that
 * sentence's numbers (and currency) wrong. Converting the source snapshots makes
 * every figure and every sentence come out already denominated in the display
 * currency, from one uniform code path.
 *
 * Honesty (the money contract):
 *  - Identity fast-path when `from === ctx.target` — the whole transform returns the
 *    input array unchanged, so the all-same-currency path is byte-identical (the
 *    Time Machine sees exactly what it saw before FX activation).
 *  - Stored snapshots are NEVER mutated — this is a pure value transform producing
 *    new rows.
 *  - A missing rate for a date makes that point native/unconverted, i.e. mixed-unit
 *    relative to the converted series. Rather than smuggle a native magnitude in
 *    beside converted ones, that point is flagged `fxMiss` — the exact mixed-unit
 *    guard `computeWealthTimeMachine` already drops. `convertMoney` owns the rate
 *    lookup; we never fabricate a rate.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

/** Convert one snapshot's absolute money fields at its own date. A rate miss on the
 *  date makes the whole row native/mixed-unit, so it is flagged `fxMiss` (dropped by
 *  the Time Machine) instead of blended into the converted series. */
function convertSnapshot(s: Snapshot, from: string, ctx: ConversionContext): Snapshot {
  // Already mixed-unit at rest ⇒ leave untouched; the Time Machine drops it regardless.
  if (s.fxMiss) return s;
  let missed = false;
  const conv = (amount: number): number => {
    const m = convertMoney({ amount, currency: from }, s.date, ctx);
    if (m.estimated) missed = true;
    return m.amount;
  };
  // Every absolute figure on the row (netWorth is stored, not re-derived here, so it
  // is converted directly — the same single rate at s.date applies to all of them).
  const next: Snapshot = {
    ...s,
    netWorth:         conv(s.netWorth),
    totalAssets:      conv(s.totalAssets),
    totalDebt:        conv(s.totalDebt),
    totalCash:        conv(s.totalCash),
    totalSavings:     conv(s.totalSavings),
    totalInvestments: conv(s.totalInvestments),
    totalCrypto:      conv(s.totalCrypto),
    cashOnHand:       conv(s.cashOnHand),
  };
  return missed ? { ...next, fxMiss: true } : next;
}

/**
 * Convert an entire SpaceSnapshot series from `from` into `ctx.target`, per-date.
 * Identity (returns the input array unchanged) when the reporting currency already
 * IS the target display currency — the common all-same-currency path stays
 * byte-identical and allocation-free.
 *
 * @param snapshots the stored series (never mutated)
 * @param from      the snapshot/reporting currency the totals are stamped in
 * @param ctx       the display ConversionContext (`ctx.target` is the display currency)
 */
export function convertWealthSnapshots(
  snapshots: Snapshot[],
  from:      string,
  ctx:       ConversionContext,
): Snapshot[] {
  if (from === ctx.target) return snapshots; // identity — no conversion, no relabel, no new objects
  return snapshots.map((s) => convertSnapshot(s, from, ctx));
}
