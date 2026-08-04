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
import {
  CRYPTO_MATERIALITY_EPSILON, type CryptoValuationStatus,
} from "./crypto-valuation-status.core";
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
 * V26-INVESTMENTS-HISTORY — machine-searchable marker for the unsupported-zero
 * skip. Same shape as INVALID_VALUATION_REASON_CODE above: a stable prefix on
 * the existing `reason` string, not a new field. Grep this to find every day a
 * zero investment subtotal was refused.
 */
export const NO_VALUED_COMPONENTS_REASON_CODE = "NO_VALUED_COMPONENTS";

/**
 * V26-CRYPTO-QTY-1 — machine-searchable marker for the crypto no-fabrication
 * skip. Same shape as the two codes above. Grep this to find every day whose
 * crypto component could not be valued and was therefore not asserted.
 */
export const NO_CRYPTO_EVIDENCE_REASON_CODE = "NO_CRYPTO_EVIDENCE";

/**
 * V26-INVESTMENTS-HISTORY — A ZERO SUBTOTAL MAY ONLY BE ASSERTED WHEN EVIDENCE
 * SUPPORTS ZERO.
 *
 * ── The bug this exists to prevent ───────────────────────────────────────────
 * `applyOwnershipEligibility` reports `hasEligibleHoldings` as
 * `includedInstrumentIds.length > 0` — inclusion by OWNERSHIP, which says
 * nothing about whether any included holding could be VALUED. A day whose
 * holdings are all ownership-KNOWN but none of which resolves a price (or whose
 * quantity was refused as reconstruction residue) therefore reported
 * `hasEligibleHoldings: true` with `valuedSubtotal: 0`, sailed past the
 * OWNERSHIP PREHISTORY guard, passed `isUsableValuation(0)`, and was written as
 * `stocks = 0.00`.
 *
 * Measured after the 2026-08 regeneration: 27 days (2025-07-31 → 2025-08-26)
 * persisted stocks $0.00 at 0/14 and 0/15 coverage, producing a false ~$5,626
 * cliff on 2025-07-31 against the adjacent un-regenerated day. The system never
 * proved the user held nothing; it proved it could not value what they held.
 *
 * ── The distinction ──────────────────────────────────────────────────────────
 *   no components in scope            → zero may be valid (nothing to value)
 *   components explicitly closed      → zero may be valid (an OBSERVED zero;
 *                                       such positions never become components,
 *                                       so this reduces to the case above)
 *   components exist, none valued     → REFUSE. "We cannot say" is not "$0.00"
 *   some contribute, some unvalued    → partial subtotal, degraded tier (unchanged)
 *   all contribute                    → supported subtotal (unchanged)
 *
 * This is the OWNERSHIP PREHISTORY rule generalised: that guard catches the
 * subset where nothing was ownership-eligible, this catches every remaining way
 * a day can reach zero contributors. Ordering keeps the more specific reason.
 *
 * Counts absent (null) means no valuation was attempted at all — the
 * NO-FABRICATION guard owns that case, so this predicate stays silent.
 */
export function hasNoValuedComponents(input: {
  contributingComponentCount?: number | null;
  totalComponentCount?:        number | null;
}): boolean {
  const contributing = input.contributingComponentCount;
  const total = input.totalComponentCount;
  if (contributing == null || total == null) return false;
  return total > 0 && contributing === 0;
}

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
   * V26-PRICE-5A — true when the day HAD holdings but every one was excluded as
   * UNKNOWN ownership prehistory. Distinct from `!hasInvestmentEvidence`, which
   * also covers "A8 returned nothing at all": here we know holdings exist and
   * know we may not value them, so the day is skipped rather than zeroed.
   */
  ownershipIneligible?: boolean;
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
   * V26-INVESTMENTS-HISTORY — composition of the day's INVESTMENT valuation:
   * how many holdings contributed to `investmentValue`, and how many were
   * considered. Pass-through metadata: neither participates in any decision
   * below, so no guard, skip, tier or written value can change because of them.
   * Null when the day had no A8 valuation (investments held flat) — nothing was
   * composed, and null means NOT RECORDED, never zero.
   */
  contributingComponentCount?: number | null;
  totalComponentCount?:        number | null;
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
  /**
   * The stored row's financial fields, or null when no row exists yet.
   *
   * REQUIRED for a partial rewrite: a component this run cannot support is
   * PRESERVED from here rather than zeroed or fabricated. With no stored row
   * there is nothing to preserve, so an unsupported component forces the whole
   * day to skip — exactly the behaviour that predates per-component
   * authorisation, which is why every existing caller keeps working unchanged.
   */
  existing?: SnapshotFields | null;
}

export type RegenAction =
  | "write"
  | "write-partial"
  | "skip-frozen"
  | "skip-unsupported"
  | "skip-membership-changed";

/** The five stored PRIMITIVES. Aggregates are derived from these, never stored independently. */
export type ComponentName = "stocks" | "crypto" | "cash" | "savings" | "debt";
export const COMPONENT_NAMES: readonly ComponentName[] =
  ["stocks", "crypto", "cash", "savings", "debt"] as const;

/**
 * What happened to ONE component on ONE day.
 *
 * `authorized` is NOT "did we write it". A PRESERVED value is still carried into
 * the row's arithmetic — the row must stay internally consistent — but it never
 * gains the right to authorise an aggregate merely by being present. That
 * distinction is the whole point of this type.
 */
export interface ComponentDecision {
  component: ComponentName;
  action:    "recomputed" | "preserved";
  /** The value the row will carry: freshly computed, or the stored one kept. */
  value:     number;
  /** May this value support an aggregate that depends on it? */
  authorized: boolean;
  /** Coded refusal, present only when the component was preserved. */
  reason:    string | null;
}

/** Only the fields authorised to change. Never a full replacement row. */
export type SnapshotFieldPatch = Partial<SnapshotFields>;

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
  /**
   * V26-INVESTMENTS-HISTORY — the input's composition counts, echoed so the
   * writer persists them from the SAME object it takes `tier` and `fields`
   * from. Non-null only on `action === "write"`: a skipped day writes nothing,
   * and carrying counts on a skip would invite persisting composition for a row
   * whose values came from a different run.
   */
  contributingComponentCount: number | null;
  totalComponentCount:        number | null;
  /**
   * V26-CRYPTO-STATUS-1 — whether this day's crypto component may be asserted.
   *
   * Meaningful on BOTH a write and a skip. `supported` accompanies a written
   * row; `unavailable` is produced by the crypto no-fabrication skip, whose row
   * is NOT rewritten — the binding stamps that one status alone, touching no
   * financial scalar (see the metadata-only update there). Null everywhere the
   * writer has no authority to classify: no material holding, or a disposition
   * that never examined crypto.
   */
  cryptoValuationStatus: CryptoValuationStatus | null;
  /**
   * Per-component verdicts. Non-null on `write` and `write-partial`; null on
   * every skip, where no component was decided.
   */
  components: ComponentDecision[] | null;
  /**
   * The fields this day is authorised to CHANGE, and only those. Empty object
   * means "authorised, but nothing moved" — which is what makes a second run
   * write nothing. Null on a skip.
   */
  fieldPatch: SnapshotFieldPatch | null;
  reason: string;
}

/** Fields whose recomputed value differs from the stored one by more than a cent. */
function diffFields(next: SnapshotFields, prev: SnapshotFields | null): SnapshotFieldPatch {
  if (!prev) return { ...next };
  const patch: SnapshotFieldPatch = {};
  for (const k of Object.keys(next) as (keyof SnapshotFields)[]) {
    if (Math.abs(next[k] - prev[k]) > 0.005) patch[k] = next[k];
  }
  return patch;
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
    return {
      date, action: "skip-frozen", fields: null, isEstimated: false, tier: "observed",
      contributingComponentCount: null, totalComponentCount: null,
      components: null, fieldPatch: null,
      cryptoValuationStatus: null,
      reason: "Observed row is frozen.",
    };
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
      contributingComponentCount: null, totalComponentCount: null,
      components: null, fieldPatch: null,
      cryptoValuationStatus: null,
      reason: "An account was removed from this Space after this date; automatic regen leaves the existing value untouched (requires an explicit amendment).",
    };
  }

  // V26-CRYPTO-STATUS-1 — THE CRYPTO VERDICT IS INDEPENDENT OF THE DISPOSITION.
  //
  // Decided here, once, BEFORE the guard chain, because it must survive whichever
  // guard happens to fire first. It was originally computed at the crypto
  // no-fabrication rule, and that hid it: on 375 legacy days the INVESTMENTS
  // no-fabrication rule short-circuits earlier, so the day never reached the
  // crypto rule and its verdict went unrecorded — even though "material crypto,
  // no price reached this day" was just as true there.
  //
  // Nothing about this verdict depends on investments, ownership, or validity,
  // so nothing about those may suppress it.
  //
  // Frozen and membership-changed days are the exception and keep null: the
  // former is an immutable observation this function must never classify, and
  // the latter was computed against a different account set, so this run has no
  // authority over it. Both return before this line.
  const cryptoMaterial = Math.abs(base.totalDigitalAssets) > CRYPTO_MATERIALITY_EPSILON;
  const cryptoVerdict: CryptoValuationStatus | null =
    input.hasDigitalAssetEvidence && Math.abs(input.digitalAssetValue) > CRYPTO_MATERIALITY_EPSILON ? "supported"
    : cryptoMaterial ? "unavailable"
    : null;

  const flatInvestments = base.totalInvestments;
  const existing = input.existing ?? null;

  // ── PER-COMPONENT AUTHORISATION ───────────────────────────────────────────
  //
  // Each component answers for ITSELF. A component this run cannot support does
  // not authorise its own rewrite — but it no longer silences the others.
  //
  // The rule that keeps this safe: an unsupported component is PRESERVED from
  // the stored row. It is never zeroed, never replaced by a carried current
  // balance, and never by another component's fallback. Where there is no stored
  // row there is nothing to preserve, so the day still skips whole — which is
  // exactly the pre-existing behaviour.
  const refusals: { component: ComponentName; reason: string }[] = [];

  // INVESTMENTS — four independent ways to be unsupported, each keeping its own
  // reason so a component-specific refusal stays visible in diagnostics.
  let stocksRefusal: string | null = null;
  if (input.ownershipIneligible === true) {
    // OWNERSHIP PREHISTORY (V26-PRICE-5A): holdings exist but NONE has KNOWN or
    // POSSIBLE ownership on this date. Writing would claim a portfolio worth
    // (near) zero, and zero is a claim. The truth is "we cannot say".
    stocksRefusal =
      "OWNERSHIP_PREHISTORY: no holding has KNOWN or POSSIBLE ownership on this date; " +
      "the stored value is preserved rather than replaced with a zero-valued portfolio.";
  } else if (hasNoValuedComponents(input)) {
    // UNSUPPORTED ZERO (V26-INVESTMENTS-HISTORY): holdings were in scope and not
    // one resolved a defensible value, so a zero subtotal would assert an
    // absence the evidence never established.
    stocksRefusal =
      `${NO_VALUED_COMPONENTS_REASON_CODE}: ${input.totalComponentCount} holding(s) were in scope for ` +
      `this date and none could be valued, so a zero investment subtotal would assert an absence the ` +
      `evidence does not support.`;
  } else if (!input.hasInvestmentEvidence && flatInvestments > WEALTH_REGEN_EPSILON) {
    // NO FABRICATION: a flat estimate we cannot A8-value is kept as-is.
    stocksRefusal = "No historical position evidence for this date; flat estimate preserved (not fabricated).";
  } else if (input.hasInvestmentEvidence && !isUsableValuation(input.investmentValue)) {
    // INVALID EVIDENCE (P0): negative or non-finite is not a weak estimate, it is
    // an impossible balance component. Never clamped to 0, never replaced by the
    // flat value — both substitute one wrong number for another and hide the
    // upstream reconstruction defect.
    stocksRefusal =
      `${INVALID_VALUATION_REASON_CODE} (investments): historical valuation was negative or non-finite; ` +
      `the stored value is preserved, not overwritten. Upstream position reconstruction requires investigation.`;
  }
  if (stocksRefusal) refusals.push({ component: "stocks", reason: stocksRefusal });

  // CRYPTO — the exact analogue, decided independently of investments.
  let cryptoRefusal: string | null = null;
  if (input.hasDigitalAssetEvidence && !isUsableValuation(input.digitalAssetValue)) {
    cryptoRefusal =
      `${INVALID_VALUATION_REASON_CODE} (digitalAssets): historical valuation was negative or non-finite; ` +
      `the stored value is preserved, not overwritten.`;
  } else if (!input.hasDigitalAssetEvidence && base.totalDigitalAssets > WEALTH_REGEN_EPSILON) {
    cryptoRefusal =
      `${NO_CRYPTO_EVIDENCE_REASON_CODE}: no historical crypto evidence for this date (no price reached it, ` +
      `or the constant-quantity carry was refused by wallet activity); the carried balance is preserved, ` +
      `NOT asserted as that day's value.`;
  }
  if (cryptoRefusal) refusals.push({ component: "crypto", reason: cryptoRefusal });

  // CASH / SAVINGS / DEBT come from the posted-ledger walk. They are magnitudes:
  // an impossible one is refused on the same terms as a valuation.
  const walked: Record<"cash" | "savings" | "debt", number> = {
    cash:    base.totalChecking,
    savings: base.totalSavings,
    debt:    base.totalLiabilities,
  };
  for (const c of ["cash", "savings", "debt"] as const) {
    if (!isUsableValuation(walked[c])) {
      refusals.push({
        component: c,
        reason: `${INVALID_VALUATION_REASON_CODE} (${c}): the walked balance was negative or non-finite; ` +
                `the stored value is preserved, not overwritten.`,
      });
    }
  }

  // NOTHING TO PRESERVE ⇒ the whole day still skips. Preservation is the only
  // thing that makes a partial rewrite safe; without a stored row a partial
  // write would have to invent the missing component.
  if (refusals.length > 0 && existing === null) {
    return {
      date, action: "skip-unsupported", fields: null, isEstimated: true, tier: "incomplete",
      contributingComponentCount: null, totalComponentCount: null,
      components: null, fieldPatch: null,
      cryptoValuationStatus: cryptoVerdict,
      reason: refusals.map((r) => r.reason).join(" | "),
    };
  }

  const refusedBy = new Map(refusals.map((r) => [r.component, r.reason]));

  // Each component's VALUE: freshly computed when supported, otherwise the
  // stored one, preserved verbatim.
  const freshStocks = input.hasInvestmentEvidence ? input.investmentValue : flatInvestments;
  const freshCrypto = input.hasDigitalAssetEvidence ? input.digitalAssetValue : base.totalDigitalAssets;
  const fresh: Record<ComponentName, number> = {
    stocks: freshStocks, crypto: freshCrypto,
    cash: walked.cash, savings: walked.savings, debt: walked.debt,
  };

  const components: ComponentDecision[] = COMPONENT_NAMES.map((component) => {
    const reason = refusedBy.get(component) ?? null;
    if (reason === null) {
      return { component, action: "recomputed" as const, value: fresh[component], authorized: true, reason: null };
    }
    // PRESERVED — carried into the row's arithmetic so the row stays internally
    // consistent, but NEVER authorised by the mere fact that it is present.
    return {
      component, action: "preserved" as const,
      value: existing ? existing[component] : fresh[component],
      authorized: false, reason,
    };
  });
  const valueOf = (c: ComponentName) => components.find((d) => d.component === c)!.value;

  const totals: ClassifyTotals = {
    ...base,
    totalInvestments:   valueOf("stocks"),
    totalDigitalAssets: valueOf("crypto"),
    totalChecking:      valueOf("cash"),
    totalSavings:       valueOf("savings"),
    totalLiabilities:   valueOf("debt"),
  };
  // AGGREGATES ARE ALWAYS RECOMPUTED FROM THE COMPONENTS THE ROW WILL CARRY.
  //
  // Not because a mixed-basis aggregate is authoritative — it is not — but
  // because `netWorth === totalAssets − debt` and `total === stocks + crypto`
  // are identities between STORED COLUMNS, checked by aggregate authorisation
  // (`identityViolations`). Repairing one component and leaving the aggregates
  // stale would break those identities and turn every repaired row
  // CONTRADICTORY: strictly worse than the defect being fixed.
  //
  // Assertability is unaffected. It is derived at the read boundary from the
  // component verdicts (`cryptoValuationStatus` and friends), which this run
  // does not relax — so an aggregate resting on a preserved component stays
  // refused exactly as it was.
  const fields = computeSnapshotFields(totals);
  const fieldPatch = diffFields(fields, existing);

  const investmentTier: CompletenessTier = input.hasInvestmentEvidence ? input.investmentTier : "derived";
  // Crypto tier only constrains the day when crypto was actually valued; with no
  // BTC evidence it must not drag an otherwise-observed day down.
  const tiers: CompletenessTier[] = [input.cashCardTier, investmentTier];
  if (input.hasDigitalAssetEvidence) tiers.push(input.digitalAssetTier);
  const tier = worstTier(tiers);
  // FLIP: observed only when every component is observed; otherwise the row is a
  // reconstruction and stays estimated (a derived date is never "observed"). An
  // amendment always lands estimated. A PARTIAL rewrite can never be observed —
  // some component is only preserved.
  const isEstimated = isAmendment || refusals.length > 0 ? true : tier !== "observed";

  const partial = refusals.length > 0;
  const parts: string[] = [];
  if (!refusedBy.has("stocks") && input.hasInvestmentEvidence) parts.push("investments at A8 historical value");
  if (!refusedBy.has("crypto") && input.hasDigitalAssetEvidence) parts.push("crypto at historical price × today's quantity");

  return {
    date,
    action: partial ? "write-partial" : "write",
    fields,
    fieldPatch,
    components,
    isEstimated,
    tier: partial ? worstTier([tier, "incomplete"]) : tier,
    // Composition counts describe the INVESTMENT valuation. A preserved stocks
    // component was not composed by this run, so recording counts for it would
    // attribute one run's composition to another run's value.
    contributingComponentCount: refusedBy.has("stocks") ? null : (input.contributingComponentCount ?? null),
    totalComponentCount:        refusedBy.has("stocks") ? null : (input.totalComponentCount ?? null),
    cryptoValuationStatus: cryptoVerdict,
    reason: partial
      ? `PARTIAL: ${refusals.map((r) => `${r.component} preserved — ${r.reason}`).join(" | ")}` +
        (parts.length ? ` || rewritten: ${parts.join(" + ")}` : " || rewritten: cash/savings/debt from the posted ledger")
      : parts.length ? `${parts.join(" + ")} (${tier}).` : `Cash-only reconstruction for this date (${tier}).`,
  };
}

/**
 * Apply the rules across a window. Deterministic: identical inputs ⇒ identical
 * results, so repeated regeneration upserts identical rows (idempotent).
 */
export function regenerateWindow(inputs: readonly DayRegenInput[]): DayRegenResult[] {
  return inputs.map(regenerateDay);
}

/** The rows a run would write in FULL (every component recomputed), in input order. */
export function writableRows(results: readonly DayRegenResult[]): DayRegenResult[] {
  return results.filter((r) => r.action === "write");
}

/**
 * Rows a run would PATCH — some component preserved — and that actually move.
 *
 * An empty patch is filtered out here rather than at the writer, so "authorised
 * but nothing changed" costs zero writes. That is what makes a second run
 * idempotent by construction instead of by luck.
 */
export function patchableRows(results: readonly DayRegenResult[]): DayRegenResult[] {
  return results.filter((r) =>
    r.action === "write-partial" && r.fieldPatch !== null && Object.keys(r.fieldPatch).length > 0);
}
