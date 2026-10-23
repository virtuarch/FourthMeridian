/**
 * lib/snapshots/amendment-availability.ts   (F1 — OWNER RULING 2026-10-15)
 *
 * ONE switch for the historical net-worth AMENDMENT action (the consent flow
 * that rewrites frozen SpaceSnapshot days through POST /api/spaces/[id]/wealth/amend
 * and the "Update past net worth?" offer on the Real assets section).
 *
 * WHY IT IS OFF. The Preview acceptance pass of 2026-10-15 showed that the
 * amendment engine rebuilds EVERY component of each past day from today's data
 * (investments, cash walk-back, FX — the proposal's "you cannot subtract one
 * account's slice"), so the consent preview for a $1 → $2 test asset reported a
 * ≈ $1,500 change in net worth on an unrelated day. The owner ruled that a
 * whole-day reconstruction from today's financial data is NOT a valid
 * historical asset amendment: an amendment may change only the affected
 * asset's contribution, and every unrelated balance and observation must stay
 * as recorded. Until the engine can amend one account's slice, the action is
 * disabled here — in the UI (no offer) and in the API (503, before any work).
 *
 * What stays available: manual asset creation, dated valuation updates, the
 * recorded valuation history, the per-asset modeled chart, the AI's valuation
 * facts and current net worth. No valuation record is deleted; no frozen
 * snapshot is touched.
 *
 * Pure constant (client-safe): read by the offer core, the route and the tests.
 * Flip to `true` only with the slice-amendment correction and its tests.
 */

export const HISTORICAL_AMENDMENT_ENABLED = false as boolean;

export const HISTORICAL_AMENDMENT_DISABLED_CODE = "AMENDMENT_DISABLED" as const;

export const HISTORICAL_AMENDMENT_DISABLED_MESSAGE =
  "Updating past net worth is temporarily unavailable: the historical rebuild would " +
  "recompute every past balance from today's data, not only this asset. Your recorded " +
  "valuations and today's net worth are unaffected.";
