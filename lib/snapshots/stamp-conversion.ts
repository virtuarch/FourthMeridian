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
  /**
   * MC1 QA Q4b — true when the row's stamp could NOT be resolved (RateMiss):
   * `values` passed through NATIVE (unconverted), so they sit at a different
   * magnitude than the resolving points in the same series. `estimated` cannot
   * discriminate this (it also covers exact-but-approximate summed conversions
   * and reconstructed history), so a presentation guard that must drop only the
   * genuinely mixed-unit points reads THIS flag. False on any successful
   * resolution, exact or walked-back.
   */
  missed:    boolean;
}

/**
 * Convert a snapshot row's monetary fields from its stamp into the context
 * target at the row's own date. Caller guarantees `stamp !== ctx.target`
 * (the homogeneous fast path never reaches here).
 *
 * One rate per row (module header): every total shares the row's stamp and
 * date, so a single resolution decides both the conversion and the `missed`
 * flag for the whole row.
 */
export function convertStampedValues<K extends string>(
  values: Record<K, number>,
  stamp: string,
  dateISO: string,
  ctx: ConversionContext,
): StampConversionResult<K> {
  // Resolve the row's stamp once — a miss here means every field below took the
  // D-3 native pass-through, leaving the row at its stamped magnitude.
  const missed = ctx.resolve(stamp, dateISO).kind === "miss";

  const out = {} as Record<K, number>;
  for (const key of Object.keys(values) as K[]) {
    // V25-FINAL-1 — when the stamp can't be converted (missed), convertMoney returns
    // null; this row is `missed` and DROPPED by the caller (fxMiss), so keep the
    // native magnitude in the dropped row rather than emit a fake 0.
    const c = convertMoney({ amount: values[key], currency: stamp }, dateISO, ctx);
    out[key] = c.amount ?? values[key];
  }
  // Off-stamp display conversion is ALWAYS flagged estimated: even an
  // exact-rate conversion of a summed total is an approximation of what the
  // per-account originals would have produced (roadmap §6.4). A RateMiss
  // additionally leaves values native — surfaced separately via `missed`.
  return { values: out, estimated: true, missed };
}
