/**
 * lib/snapshots/manual-asset-history.core.ts   (RWA-2B — HISTORICAL NET WORTH)
 *
 * How a MANUAL real-world asset (FinancialAccount type "other", syncStatus
 * "manual") enters a RECONSTRUCTED historical day. Pure: no DB, no clock —
 * `today` is an argument — so it fixture-tests without `prisma generate`.
 *
 * ── The one policy, reused — never a second rule ─────────────────────────────
 * The per-day VALUE is `valueOn` from lib/assets/valuation-series.core.ts: the
 * same resolver the per-asset chart and the AI read, so the Net Worth history
 * cannot describe an asset's past differently from its own chart. This module
 * adds only what the history engine needs around that answer:
 *
 *   FLOOR   the first day the asset may appear on a reconstructed day
 *           (the engine's "earliest transaction" equivalent for an account that
 *           has no transactions — see lib/snapshots/backfill-core.ts
 *           computeAccountFloors, which still owns the SHARED-Space link-date
 *           bound and the max() of the two);
 *   TIER    what a day valued from the resolver does to the row's trust;
 *   VALUE   the resolver's answer for the day, or "contribute nothing".
 *
 * ── Owner decisions this encodes (docs/plans/RWA-2-ASSET-VALUATION-HISTORY.md §5)
 *   · Nothing before ownership. The floor is the FIRST ANCHOR — the acquisition
 *     date when the purchase price was opted in as a starting value, else the
 *     first recorded valuation. A day after acquisition but before the first
 *     anchor is held-but-unvalued (`NOT_VALUED`) and contributes NOTHING; no
 *     value is invented for it.
 *   · Carried forward, never extrapolated: after the last anchor the resolver
 *     carries the latest estimate flat (`carried`), and this module labels it.
 *   · A modeled or carried day is an ESTIMATE: its tier is "estimated", so the
 *     row stays `isEstimated = true` and is never presented as observed. A day
 *     ON an anchor is the user's own dated statement — the same thing the live
 *     writer stores for today — and constrains the row no further ("observed"
 *     under worstTier lifts nothing).
 *   · A LEGACY asset (created before RWA-2: no valuation rows, no profile) keeps
 *     the pre-RWA-2B engine behaviour BYTE-FOR-BYTE: floor = today, so it is
 *     absent from every reconstructed day exactly as before. The resolver would
 *     carry its balance forward from `lastUpdated`, but applying that would
 *     change existing Spaces' estimated history without any user action — the
 *     one thing the owner ruled out. The first time the user records a value
 *     (PATCH), the legacy balance becomes a dated ledger row and the asset's
 *     history is driven by the resolver from then on.
 *
 * ── What the stored row can and cannot say ───────────────────────────────────
 * SpaceSnapshot has no column for "modeled". The tier vocabulary (observed /
 * derived / estimated / incomplete / unknown) cannot express it either, and this
 * slice makes no schema change. So a modeled day is persisted as an ESTIMATED
 * row, and the modeled distinction is re-derived at the READ boundary from the
 * ledger (lib/snapshots/real-asset-basis.core.ts) — the same resolver, the same
 * answer.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import {
  valueOn,
  type ResolvedAnchors,
  type ValuationBasis,
} from "@/lib/assets/valuation-series.core";

/** The resolver's inputs the engine has for one manual asset. */
export interface ManualAssetHistoryInput {
  resolved: ResolvedAnchors;
  /** True when the asset has NO valuation rows and NO profile (pre-RWA-2). */
  isLegacy: boolean;
}

/** True for a pre-RWA-2 asset: its only anchor is the legacy balance and it has no profile. */
export function isLegacyManualAsset(args: { resolved: ResolvedAnchors; hasProfile: boolean }): boolean {
  const { resolved, hasProfile } = args;
  return !hasProfile && resolved.anchors.length > 0 && resolved.anchors.every((a) => a.kind === "LEGACY_BALANCE");
}

/**
 * The first day the asset may appear on a reconstructed day (YYYY-MM-DD).
 *
 *   legacy asset        → `today`   (zero reconstructable days — unchanged)
 *   no anchors at all   → `today`   (nothing to value)
 *   otherwise           → the FIRST ANCHOR's date (never the acquisition date
 *                         alone: held-but-unvalued days contribute nothing)
 *
 * The engine feeds this to computeAccountFloors as the account's "earliest
 * transaction", so the SHARED-Space link-date bound still applies on top.
 */
export function manualAssetHistoryFloor(input: ManualAssetHistoryInput, today: string): string {
  if (input.isLegacy) return today;
  const first = input.resolved.anchors[0]?.date ?? null;
  if (first === null) return today;
  return first < today ? first : today;
}

export interface ManualAssetDayValue {
  value: number;
  basis: ValuationBasis;
}

/**
 * The asset's value on `day`, or null when it contributes nothing (not held,
 * or held but not yet valued). Null means EXCLUDE the account from the day —
 * never a zero, which would be a claim.
 */
export function manualAssetValueOn(input: ManualAssetHistoryInput, day: string): ManualAssetDayValue | null {
  if (input.isLegacy) return null;
  const v = valueOn(input.resolved, day);
  if (!v.held || !v.valued) return null;
  return { value: v.value, basis: v.basis };
}

/**
 * The trust a day's real-asset component adds to the row.
 *
 *   no manual asset valued that day  → null (adds no constraint)
 *   any modeled or carried value     → "estimated"
 *   every value recorded             → "observed" (the user's dated statement;
 *                                       lifts nothing under worstTier)
 */
export function realAssetTierFor(bases: readonly ValuationBasis[]): CompletenessTier | null {
  if (bases.length === 0) return null;
  return bases.some((b) => b === "modeled" || b === "carried") ? "estimated" : "observed";
}
