/**
 * lib/snapshots/stamp-conversion.ts
 *
 * MC1 Phase 4 Slice 4 (plan D-6) — pure display-time conversion of a
 * snapshot row's stored totals from the currency they were STAMPED in
 * (SpaceSnapshot.reportingCurrency, frozen at write time) into the Space's
 * CURRENT reporting currency, at the snapshot's own date (historical FX).
 *
 * Read-path presentation only. Stored rows are never rewritten — this maps
 * values on their way to a chart. Doctrine carried through:
 *   - Homogeneous fast path lives in the CALLER (lib/data/snapshots.ts):
 *     when every stamp already matches the target, this module is never
 *     invoked and the DTOs are byte-identical to the pre-MC1 mapping.
 *   - One rate per row: every total on a snapshot shares the row's stamp and
 *     date, so a single resolution converts all fields and yields one
 *     per-point `estimated` flag.
 *   - D-3: a missing rate passes the stored values through unconverted with
 *     `estimated: true` — never excluded, never thrown. Converting a SUMMED
 *     total is inherently approximate when the original per-currency
 *     composition wasn't stored, which is why every off-stamp conversion is
 *     estimation-flagged even on exact rates (honesty over precision).
 *
 * Pure module: no DB, no fx-service imports beyond types — testable without
 * `prisma generate`.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";

export interface StampConversionResult<K extends string> {
  values:    Record<K, number>;
  /** True for every off-stamp point (display conversion is approximate by nature; misses stay native). */
  estimated: boolean;
}

/**
 * Convert a snapshot row's monetary fields from its stamp into the context
 * target at the row's own date. Caller guarantees `stamp !== ctx.target`
 * (the homogeneous fast path never reaches here).
 */
export function convertStampedValues<K extends string>(
  values: Record<K, number>,
  stamp: string,
  dateISO: string,
  ctx: ConversionContext,
): StampConversionResult<K> {
  const out = {} as Record<K, number>;
  for (const key of Object.keys(values) as K[]) {
    out[key] = convertMoney({ amount: values[key], currency: stamp }, dateISO, ctx).amount;
  }
  // Off-stamp display conversion is ALWAYS flagged estimated: even an
  // exact-rate conversion of a summed total is an approximation of what the
  // per-account originals would have produced (roadmap §6.4). A RateMiss
  // additionally leaves values native — still covered by the same flag.
  return { values: out, estimated: true };
}
