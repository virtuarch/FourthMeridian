/**
 * lib/snapshots/regenerate-history.core.ts
 *
 * A9 — PURE wealth-regeneration decision core. No DB, no clock, no network: the
 * per-day rules that turn a flat-held historical snapshot into an A8-valued one,
 * so it fixture-tests without `prisma generate`. The binding
 * (regenerate-history.ts) gathers the inputs (walk-back balances + A8 valuation)
 * and applies these decisions.
 *
 * The gap this closes: lib/snapshots/backfill.ts walks cash and revolving cards
 * back from transactions but HOLDS INVESTMENTS AND DIGITAL ASSETS FLAT at
 * today's value on every historical row (backfill.ts §"everything else keeps
 * its current balance"). A9 replaces each of those flat components with its
 * canonical historical valuation when evidence reaches the day — investments
 * from A8 (getInvestmentValueAsOf → valuedSubtotal), digital assets from
 * A8-3B (constant quantity × that day's archived price) — keeps the cash/card
 * walk-backs and the real-asset component exactly as backfill computed them,
 * and recomputes the derived aggregates through the SAME computeSnapshotFields
 * the live "today" row uses (formula parity). Absent evidence, each component
 * keeps its flat estimate; INVALID evidence is rejected outright (see below).
 *
 * Honesty rules (all enforced here, none in the binding):
 *  - FROZEN rows: an isEstimated=false row is an observation of what balances
 *    said that day — NEVER touched (guard + byte-identity test). This is the
 *    load-bearing safety rule.
 *  - NO FABRICATION: when A8 has no position evidence reaching the day yet flat
 *    investments exist, the day is left as backfill wrote it (a labeled
 *    estimate) rather than zeroed — unknown is preferable to a fabricated value.
 *  - INVALID EVIDENCE (P0): a historical valuation that is negative or
 *    non-finite is not an estimate, it is an impossible value — a balance
 *    component cannot be below zero. Such a day is SKIPPED (skip-unsupported,
 *    reason INVALID_VALUATION_EVIDENCE), preserving whatever is already
 *    stored, rather than clamped to 0 or replaced with the flat value: both
 *    would substitute one wrong number for another and hide the upstream
 *    reconstruction defect that produced it. Checked INDEPENDENTLY per
 *    component, but an invalid component skips the WHOLE day — the derived
 *    aggregates (netWorth/totalAssets) are computed from all components at
 *    once, so a partial write would be internally inconsistent. This guard is
 *    the one rule an amendment may NOT bypass: a consented rebuild may revise
 *    a frozen or membership-changed day, never write an impossible one.
 *  - FLIP: a regenerated row flips isEstimated→false ONLY when every component
 *    is observed (cash + investment). Historical A8 valuation is derived/
 *    estimated, so historical rows stay isEstimated=true → a derived date is
 *    NEVER presented as observed.
 *  - MONOTONE: regeneration never turns an observed (frozen) row estimated and
 *    never removes coverage — completeness never decreases.
 *  - Deterministic: identical inputs ⇒ identical output (idempotent upserts).
 *  - No interpolation: this module decides values from evidence, never invents
 *    a date's data from its neighbours.
 */

import { computeSnapshotFields, type ClassifyTotals, type SnapshotFields } from "./backfill-core";
import { worstTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/** Sub-dollar noise floor — a flat investment at/below this is "nothing to reconstruct". */
export const WEALTH_REGEN_EPSILON = 0.5;

/**
 * P0 — machine-searchable marker for the invalid-evidence skip. Deliberately a
 * stable prefix on the existing `reason` string rather than a new field on
 * DayRegenResult: the typed-reason model belongs with the coverage/completeness
 * work, and P0 must not widen the interface. Grep this to find every day a
 * historical valuation was rejected.
 */
export const INVALID_VALUATION_REASON_CODE = "INVALID_VALUATION_EVIDENCE";

/**
 * Is a provider-derived historical valuation usable as a balance component?
 *
 * A balance component is a magnitude: it may be zero, never negative, and never
 * non-finite. `Number.isFinite` rejects NaN and ±Infinity; `>= 0` rejects
 * negatives (and, redundantly but explicitly, -Infinity).
 *
 * Exported because the same predicate must hold wherever historical valuations
 * are accepted — the integrity probe (scripts/check-snapshot-integrity.ts)
 * mirrors it in SQL as `v >= 0 AND v < 'Infinity'::float8`, which is the exact
 * PostgreSQL equivalent (note: `v <> v` does NOT detect NaN in PostgreSQL,
 * which treats NaN as equal to itself so it can be sorted and indexed).
 */
export function isUsableValuation(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** What the binding resolves for one day before applying the regeneration rules. */
export interface DayRegenInput {
  date: string; // YYYY-MM-DD
  /** Existing SpaceSnapshot state for the day: its isEstimated flag, or null if no row. */
  existingIsEstimated: boolean | null;
  /**
   * Base classified totals with cash/card WALKED BACK and everything else
   * (investments, crypto, real, loans) flat-held — i.e. exactly what backfill
   * produces for the day. `totalInvestments` is the flat value A9 replaces.
   */
  base: ClassifyTotals;
  /** A8 historical investment valuation (valuedSubtotal), reporting currency. */
  investmentValue: number;
  /** A8 completeness tier for the day's investment valuation. */
  investmentTier: CompletenessTier;
  /** True when A8 had at least one position with evidence reaching the day. */
  hasInvestmentEvidence: boolean;
  /**
   * Part-A — historical DIGITAL-ASSET (crypto) valuation for the day, reporting
   * currency: Σ (crypto account native quantity, held constant) × that day's
   * CoinGecko price. Overrides the flat totalDigitalAssets exactly like
   * investmentValue overrides totalInvestments. Absent evidence ⇒ flat is kept.
   */
  digitalAssetValue: number;
  /** Completeness tier of the day's crypto valuation ("estimated" — constant quantity). */
  digitalAssetTier: CompletenessTier;
  /** True when a historical BTC price reached the day (else keep flat, never fabricate). */
  hasDigitalAssetEvidence: boolean;
  /** Trust tier of the walked-back cash/card component (typically "derived"). */
  cashCardTier: CompletenessTier;
  /**
   * 2026-07-15 — true when some account in this Space was revoked from the
   * Space (SpaceAccountLink.revokedAt) strictly AFTER this day's date — i.e.
   * that account was plausibly part of the Space as of this day and has
   * since left. Automatic (non-amendment) regen must never silently drop a
   * since-revoked account's contribution from a day it was genuinely part
   * of — that's a real account-membership change, not new evidence, and
   * violates "historical snapshots may remain historical"
   * (docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md's
   * principle, which A9 broke without anyone deciding to). See
   * docs/initiatives/wealth-timeline/WEALTH_TIMELINE_AMENDMENT_SYSTEM_PROPOSAL.md §9.
   */
  membershipChangedSince: boolean;
  /**
   * 2026-07-14 (Phase 2 — amendment system) — true when this day is being
   * regenerated by an EXPLICIT, consent-gated SnapshotAmendment rather than the
   * automatic pipeline. Exempts the day from BOTH the frozen-row guard and the
   * membership-changed guard "by construction" — a deliberately-consented
   * rebuild is the only sanctioned way to revise an observed or
   * membership-changed day. The automatic path never sets this (defaults
   * false), so every existing decision is unchanged. See proposal §9 and §4.
   */
  isAmendment?: boolean;
}

export type RegenAction = "write" | "skip-frozen" | "skip-unsupported" | "skip-membership-changed";

/** The per-day decision + the row to upsert when action === "write". */
export interface DayRegenResult {
  date: string;
  action: RegenAction;
  /** The regenerated snapshot fields, or null when skipped. */
  fields: SnapshotFields | null;
  /** The isEstimated flag to persist (meaningful only when action === "write"). */
  isEstimated: boolean;
  /** Overall completeness tier of the regenerated row (worst of cash/card + investment). */
  tier: CompletenessTier;
  reason: string;
}

/**
 * Apply the A9 regeneration rules to one day. Pure and total — never throws.
 */
export function regenerateDay(input: DayRegenInput): DayRegenResult {
  const { date, existingIsEstimated, base } = input;

  // AMENDMENT: an explicit, consent-gated rebuild is exempt from BOTH guards
  // below by construction — it is the ONLY sanctioned path allowed to revise a
  // frozen (observed) row or a membership-changed day on purpose. The automatic
  // pipeline never sets isAmendment, so its behaviour is unchanged.
  const isAmendment = input.isAmendment === true;

  // FROZEN: an observed row is never touched by the automatic path (the safety
  // invariant). An amendment may deliberately revise it (proposal §4).
  if (!isAmendment && existingIsEstimated === false) {
    return { date, action: "skip-frozen", fields: null, isEstimated: false, tier: "observed", reason: "Observed row is frozen." };
  }

  // MEMBERSHIP CHANGED: an account that was plausibly part of this Space as of
  // this day has since been revoked. The account set this function was called
  // with reflects only CURRENTLY active accounts, so writing now would
  // silently drop that account's contribution from a day it genuinely
  // belonged to — a real account-membership change, not new evidence. The
  // automatic path skips and leaves whatever is already stored; only an
  // explicit, consent-gated amendment may deliberately revise a day like this.
  if (!isAmendment && input.membershipChangedSince) {
    return {
      date, action: "skip-membership-changed", fields: null, isEstimated: existingIsEstimated ?? true, tier: "incomplete",
      reason: "An account was removed from this Space after this date; automatic regen leaves the existing value untouched (requires an explicit amendment).",
    };
  }

  const flatInvestments = base.totalInvestments;

  // NO FABRICATION: flat investments we cannot A8-value are left as-is, never
  // zeroed or fabricated — the day keeps backfill's labeled estimate.
  if (!input.hasInvestmentEvidence && flatInvestments > WEALTH_REGEN_EPSILON) {
    return {
      date, action: "skip-unsupported", fields: null, isEstimated: true, tier: "incomplete",
      reason: "No historical position evidence for this date; flat estimate preserved (not fabricated).",
    };
  }

  // INVALID EVIDENCE (P0): a historical valuation that is negative or non-finite
  // is not a weak estimate — it is an impossible balance component, and writing
  // it corrupts every aggregate derived from it (production carried 92 days of
  // negative `stocks`, minimum -1,810). Checked INDEPENDENTLY per component,
  // because the NO-FABRICATION rule above covers only investments and a
  // crypto-only invalid value must still be caught.
  //
  // An invalid component skips the WHOLE day rather than falling back to that
  // component's flat value: computeSnapshotFields derives netWorth/totalAssets
  // from all components together, so a partial write would mix fresh evidence
  // with a stale component and produce internally inconsistent aggregates.
  // Skipping preserves whatever is already stored (writableRows keeps only
  // action === "write"), which on a re-run is the better of the two values.
  //
  // Deliberately NOT clamped to 0 and NOT replaced with the flat value: both
  // substitute one wrong number for another and hide the upstream position-
  // reconstruction defect that produced the impossible value. See the
  // INVALID EVIDENCE honesty rule in the module header.
  //
  // Reached by amendments too — the guards above may be bypassed by an explicit,
  // consented rebuild; this one may not.
  const invalidComponents: string[] = [];
  if (input.hasInvestmentEvidence && !isUsableValuation(input.investmentValue)) {
    invalidComponents.push("investments");
  }
  if (input.hasDigitalAssetEvidence && !isUsableValuation(input.digitalAssetValue)) {
    invalidComponents.push("digitalAssets");
  }
  if (invalidComponents.length > 0) {
    return {
      date, action: "skip-unsupported", fields: null,
      isEstimated: true, tier: "incomplete",
      reason:
        `${INVALID_VALUATION_REASON_CODE} (${invalidComponents.join(",")}): historical valuation was ` +
        `negative or non-finite; the stored value is preserved, not overwritten. ` +
        `Upstream position reconstruction requires investigation.`,
    };
  }

  // Override the flat investment component with the A8 valuation (when evidence
  // exists); otherwise there is nothing to value (flat ≈ 0) and the day is a
  // cash-only reconstruction.
  const investments = input.hasInvestmentEvidence ? input.investmentValue : flatInvestments;
  // Part-A — override the flat crypto component with the historical
  // (constant-quantity × CoinGecko price) valuation when a BTC price reached the
  // day; otherwise keep the flat estimate (never fabricated).
  const digitalAssets = input.hasDigitalAssetEvidence ? input.digitalAssetValue : base.totalDigitalAssets;
  const totals: ClassifyTotals = { ...base, totalInvestments: investments, totalDigitalAssets: digitalAssets };
  const fields = computeSnapshotFields(totals);

  const investmentTier: CompletenessTier = input.hasInvestmentEvidence ? input.investmentTier : "derived";
  // Crypto tier only constrains the day when crypto was actually valued; with no
  // BTC evidence it must not drag an otherwise-observed day down.
  const tiers: CompletenessTier[] = [input.cashCardTier, investmentTier];
  if (input.hasDigitalAssetEvidence) tiers.push(input.digitalAssetTier);
  const tier = worstTier(tiers);
  // FLIP: observed only when every component is observed; otherwise the row is a
  // reconstruction and stays estimated (a derived date is never "observed"). An
  // amendment always lands estimated — a row deliberately revised because the
  // account set changed is honestly a reconstruction again, even if every
  // current component reads observed (proposal §4).
  const isEstimated = isAmendment ? true : tier !== "observed";

  const parts: string[] = [];
  if (input.hasInvestmentEvidence) parts.push("investments at A8 historical value");
  if (input.hasDigitalAssetEvidence) parts.push("crypto at historical price × today's quantity");
  return {
    date, action: "write", fields, isEstimated, tier,
    reason: parts.length ? `${parts.join(" + ")} (${tier}).` : `Cash-only reconstruction for this date (${tier}).`,
  };
}

/**
 * Apply the rules across a window. Deterministic: identical inputs ⇒ identical
 * results, so repeated regeneration upserts identical rows (idempotent).
 */
export function regenerateWindow(inputs: readonly DayRegenInput[]): DayRegenResult[] {
  return inputs.map(regenerateDay);
}

/** The rows a run would write (action === "write"), in input order. */
export function writableRows(results: readonly DayRegenResult[]): DayRegenResult[] {
  return results.filter((r) => r.action === "write");
}
