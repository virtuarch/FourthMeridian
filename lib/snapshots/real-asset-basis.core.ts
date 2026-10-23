/**
 * lib/snapshots/real-asset-basis.core.ts   (RWA-2B — READ BOUNDARY)
 *
 * Does a stored historical row's REAL-ASSET component rest on a MODELED value?
 * Pure: no DB, no clock.
 *
 * ── Why this is re-derived at read time ──────────────────────────────────────
 * The history engine (RWA-2B-ENGINE) values a manual asset from its valuation
 * ledger and persists a modeled day as an ESTIMATED row — SpaceSnapshot has no
 * column for "modeled", the tier vocabulary has no word for it, and this slice
 * makes no schema change. So the distinction the chart and the AI need ("this
 * is a straight line between two of the user's estimates, not an observed or
 * reconstructed value") is answered HERE, from the same ledger through the SAME
 * resolver the engine used (manual-asset-history.core.ts → valueOn), so the
 * answer cannot disagree with what was written.
 *
 * ── The rule, per row ────────────────────────────────────────────────────────
 * A row is `realAssetsModeled` when ALL of:
 *   1. it is a reconstruction (`isEstimated === true`) — a frozen observed row
 *      holds whatever balance the live writer saw that day and is never a
 *      modeled value, whatever the ledger says about the date now;
 *   2. the ledger says at least one manual asset is MODELED on that date
 *      (strictly between two anchors); a carried or recorded value is not
 *      modeled, and a day the engine wrote from carried values is an ordinary
 *      reconstruction;
 *   3. the row actually CARRIES a real-asset component: the unstored residual
 *      `totalAssets − (stocks + crypto + cash + savings)` is above the noise
 *      floor. A pre-RWA-2B estimated row (manual assets floored to today ⇒
 *      absent) therefore never reads as modeled merely because the ledger has
 *      since gained anchors around its date.
 *
 * This is a flag on the Space's own stored aggregate — the same kind of
 * statement as `isEstimated` or the crypto valuation state — and it discloses
 * no value and no entry: the series itself already shows the slope change at
 * every anchor.
 */

import { derivedRealAssets } from "@/lib/snapshots/aggregate-authorisation.core";
import { WEALTH_REGEN_EPSILON } from "@/lib/snapshots/regenerate-history.core";
import { manualAssetValueOn, type ManualAssetHistoryInput } from "@/lib/snapshots/manual-asset-history.core";
import type { ValuationBasis } from "@/lib/assets/valuation-series.core";

/** Per date, the least-trusted basis among the manual assets valued that day (null = none). */
export function realAssetBasisByDate(
  assets: readonly ManualAssetHistoryInput[],
  dates: readonly string[],
): Map<string, ValuationBasis | null> {
  const rank: Record<ValuationBasis, number> = { recorded: 0, carried: 1, modeled: 2 };
  const out = new Map<string, ValuationBasis | null>();
  for (const d of dates) {
    let worst: ValuationBasis | null = null;
    for (const a of assets) {
      const v = manualAssetValueOn(a, d);
      if (v && (worst === null || rank[v.basis] > rank[worst])) worst = v.basis;
    }
    out.set(d, worst);
  }
  return out;
}

/** The stored fields the rule reads (structural — no Prisma import). */
export interface RealAssetBasisRow {
  isEstimated?: boolean | null;
  stocks: number; crypto: number; cash: number; savings: number; totalAssets: number;
}

/** Rule 1–3 above. */
export function isRealAssetsModeled(row: RealAssetBasisRow, basisForDate: ValuationBasis | null | undefined): boolean {
  if (row.isEstimated !== true) return false;
  if (basisForDate !== "modeled") return false;
  const real = derivedRealAssets({
    stocks: row.stocks, crypto: row.crypto, cash: row.cash, savings: row.savings,
    total: row.stocks + row.crypto, totalAssets: row.totalAssets,
    // Not read by derivedRealAssets; present only to satisfy the shared input shape.
    debt: 0, netWorth: 0, netLiquid: 0, cashOnHand: 0,
  });
  return real > WEALTH_REGEN_EPSILON;
}
