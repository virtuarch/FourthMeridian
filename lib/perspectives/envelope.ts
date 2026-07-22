/**
 * lib/perspectives/envelope.ts
 *
 * The per-perspective trust envelope contract + registry (amended plan S3). The
 * shell renders Completeness + Evidence from whatever the ACTIVE lens supplies;
 * this pure resolver shapes each lens's own data into one envelope shape. Fixed
 * vocabulary, no fabricated counts, no percentages (§4.6): an absent envelope
 * yields an inert "—" placeholder, never invented detail.
 *
 * Trust vocabulary (convergence slice): the envelope carries the ONE canonical
 * `CompletenessTier` (lib/perspective-engine/types.ts) — no parallel `EnvelopeTier`
 * / `WealthTier`. Every perspective resolves through the same five tiers
 * (observed / derived≙"Reconstructed" / estimated / incomplete / unknown≙"Unavailable").
 *
 * Trust has TWO orthogonal dimensions (mirroring the engine's tier-vs-conflict
 * split): `completeness` answers "how was this date's value obtained?" and
 * `warnings[]` carries orthogonal caveats — notably missing/walked-back FX — that
 * are NOT the same axis as reconstruction quality. A row can be observed + missing
 * FX, or reconstructed + no FX issue; the two never collapse into one tier.
 *
 * Today: Wealth ← the WealthResult; Cash Flow ← a host-computed stamp (static
 * fallback); Investments ← the A10 InvestmentsTimeMachineResult's own completeness
 * + portfolio counts; Liquidity/Debt ← their perspective-engine LensResult
 * provenance + completeness. Each lens swaps its source here without touching the
 * shell (P6).
 */

import type { LensResult, CompletenessTier } from "@/lib/perspective-engine/types";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { formatCurrency } from "@/lib/format";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import type { InvestmentsTimeMachineResult } from "@/lib/investments/investments-time-machine-core";
import { buildInvestmentsTrustSummary } from "@/lib/investments/investments-trust";

export type EnvelopeTone = "neutral" | "positive" | "warning";

export interface EnvelopeCompleteness {
  /** The one canonical platform trust tier (perspective-engine/types.ts). */
  tier:    CompletenessTier;
  /** Fixed user-facing label (Observed / Reconstructed / …). Never a percentage. */
  label:   string;
  tone:    EnvelopeTone;
  /** One-sentence reason for the popover. Absent ⇒ chip is not clickable. */
  detail?: string;
}

/**
 * An orthogonal trust caveat that is NOT a completeness tier — a value can be
 * fully observed yet still carry one (e.g. a currency converted at a walked-back
 * FX rate). Kept as a separate dimension so "observed + missing FX" and
 * "reconstructed + no FX issue" never collapse onto the same tier.
 */
export type EnvelopeWarningKind = "fx";

export interface EnvelopeWarning {
  kind:    EnvelopeWarningKind;
  /** Short chip/line text, e.g. "Some FX rates estimated". */
  label:   string;
  tone?:   EnvelopeTone;
  detail?: string;
}

/** A generic evidence record — designed so A7/A8/A10 sources drop in unchanged. */
export interface EvidenceRow {
  date:  string;
  label: string;
  tier:  "observed" | "reconstructed" | "imported";
}

export interface EnvelopeEvidence {
  /** Chip value, e.g. "37 snapshots". Only ever a real count. */
  label: string;
  /** Drawer detail; absent ⇒ chip is not clickable (no fake rows). */
  rows?: EvidenceRow[];
}

export interface PerspectiveEnvelope {
  completeness?: EnvelopeCompleteness;
  evidence?:     EnvelopeEvidence;
  /** Orthogonal caveats (FX today). Absent/empty ⇒ no warnings. */
  warnings?:     EnvelopeWarning[];
}

/**
 * The canonical, domain-neutral presentation for each `CompletenessTier`. Every
 * perspective resolves through THESE tiers; a lens may substitute a domain-flavored
 * label (Investments "Fully valued") but never a parallel tier or a new tone rule.
 * This is the single place tier → {label, tone, detail} is decided.
 */
export const COMPLETENESS_PRESENTATION: Record<CompletenessTier, { label: string; tone: EnvelopeTone; detail: string }> = {
  observed:   { label: "Observed",      tone: "positive", detail: "A provider or you stated this value for this date." },
  derived:    { label: "Reconstructed", tone: "neutral",  detail: "Reconstructed from your history — some values are held at recent prices." },
  estimated:  { label: "Estimated",     tone: "warning",  detail: "Estimated from partial data for this date." },
  incomplete: { label: "Incomplete",    tone: "warning",  detail: "The data cannot fully answer for this date." },
  unknown:    { label: "Unavailable",   tone: "warning",  detail: "Trust for this date could not be determined." },
};

/**
 * The FX warning — a single orthogonal caveat, NEVER folded into the completeness
 * tier. Two severities (V25-FINAL-1):
 *   - `unconverted` (STRONGER): at least one balance had NO acceptable exchange
 *     rate, so it was EXCLUDED from the totals — the displayed total is a partial.
 *     This is the honest disclosure the FX-honesty contract requires.
 *   - `estimated` (softer): a real rate was applied but walked back from a nearby
 *     date. The amount WAS converted, just not at an exact same-day rate.
 * `unconverted` wins when both are set (it is the more serious statement).
 */
function fxWarnings(estimated?: boolean, unconverted?: boolean): EnvelopeWarning[] | undefined {
  if (unconverted) {
    return [
      {
        kind:  "fx",
        label: "Some balances excluded — no exchange rate",
        tone:  "warning",
        detail:
          "One or more balances could not be converted to the reporting currency because no exchange rate was available, so they are excluded from this total. The figure shown is a partial total of the balances that could be converted.",
      },
    ];
  }
  if (estimated) {
    return [
      {
        kind:  "fx",
        label: "Some FX rates estimated",
        tone:  "warning",
        detail:
          "Some amounts were converted using an exchange rate walked back from a nearby date rather than an exact same-day rate.",
      },
    ];
  }
  return undefined;
}

const WEALTH_DETAIL: Record<CompletenessTier, string> = {
  observed:   "A snapshot was recorded on or before this date.",
  derived:    "Reconstructed from your history — some values are held at recent prices.",
  estimated:  "Estimated from partial data for this date.",
  incomplete: "No snapshot exists on or before this date.",
  unknown:    "Trust for this date could not be determined.",
};

function wealthEnvelope(r: WealthResult, currency: string, fxUnconverted?: boolean): PerspectiveEnvelope {
  const c = r.completeness;
  const completeness: EnvelopeCompleteness = {
    tier:   c.tier,
    label:  c.label,
    tone:   c.tone,
    // "No history before …" is self-explanatory; other tiers get a reason line.
    detail: c.tier === "incomplete" ? c.label : WEALTH_DETAIL[c.tier],
  };
  const evidence: EnvelopeEvidence | undefined = r.evidence
    ? {
        label: r.evidence.label,
        rows: r.chart.points.map((p) => ({
          date:  formatWealthDate(p.date),
          label: formatCurrency(p.netWorth, currency),
          tier:  p.isEstimated ? "reconstructed" : "observed",
        })),
      }
    : undefined;
  // V25-FINAL-1 — when the current composition excludes an account that could not
  // be converted to the display currency, the net-worth total is a partial: surface
  // it as an orthogonal FX warning (never folded into the completeness tier).
  return { completeness, evidence, warnings: fxWarnings(false, fxUnconverted) };
}

/** The static honest boundary the Cash Flow chip shows when no stamp is supplied
 *  (backward-compatible fallback — unchanged wording). */
const CASH_FLOW_STATIC: EnvelopeCompleteness = {
  tier: "observed",
  label: "Complete within transaction depth",
  tone: "neutral",
  detail: "Cash Flow reflects every transaction on file; history is bounded by your accounts' transaction depth.",
};

/**
 * Map a host-computed CashFlowStamp (cash-flow-compare.ts) into the shell
 * envelope, so the Completeness chip is dynamic for Cash Flow — the calendar and
 * every Cash Flow panel now sit under the SAME shell trust envelope the other
 * perspectives use. `observed` keeps the honest static wording; `incomplete`
 * (the period reaches before coverage) surfaces the stamp's own reason as a
 * warning. The stamp's tier IS a canonical `CompletenessTier`, carried through
 * unchanged (no parallel-vocabulary collapse). No fabricated counts — evidence
 * stays with the shell.
 */
function cashFlowEnvelope(stamp: CashFlowStamp, fxUnconverted?: boolean): PerspectiveEnvelope {
  // V25-FINAL-1 — a Cash Flow window that excluded one or more foreign rows for
  // lack of an exchange rate is a partial total; surface it as an FX warning
  // orthogonal to the transaction-depth completeness tier.
  const warnings = fxWarnings(false, fxUnconverted);
  const t = stamp.completeness.tier;
  if (t === "observed") {
    return {
      completeness: {
        ...CASH_FLOW_STATIC,
        detail: stamp.dataAsOf
          ? `${CASH_FLOW_STATIC.detail} Latest transaction on file: ${stamp.dataAsOf}.`
          : CASH_FLOW_STATIC.detail,
      },
      warnings,
    };
  }
  return {
    completeness: {
      tier: t,
      label: "History-limited",
      tone: "warning",
      detail: stamp.completeness.reason,
    },
    warnings,
  };
}

/** Fixed user-facing label per tier for the Investments Time Machine (A10). */
const INVESTMENTS_LABEL: Record<CompletenessTier, string> = {
  observed:   "Fully valued",
  derived:    "Reconstructed",
  estimated:  "Estimated",
  incomplete: "Partially valued",
  unknown:    "Valuation unavailable",
};

const INVESTMENTS_TONE: Record<CompletenessTier, EnvelopeTone> = {
  observed:   "positive",
  derived:    "neutral",
  estimated:  "warning",
  incomplete: "warning",
  unknown:    "warning",
};

/**
 * Map the A10 InvestmentsTimeMachineResult's own completeness envelope + portfolio
 * counts into the shell envelope, so the Completeness chip is dynamic for
 * Investments (A8/A10 landed — no more static "current holdings only" text). Tier
 * comes from the DTO's overall envelope (a canonical `CompletenessTier`, carried
 * through unchanged); a conflict forces a warning tone and is never averaged away.
 * Evidence is the real valued/total position count — never a fabricated row list.
 */
function investmentsEnvelope(r: InvestmentsTimeMachineResult): PerspectiveEnvelope {
  const tier = r.completeness.tier;
  // The valued/total evidence string is authored once, in the canonical Trust
  // summary (PCS-1C) — the Investments Portfolio Header reads the SAME builder,
  // so the chip and the header can never disagree on the count.
  const trust = buildInvestmentsTrustSummary(r);
  return {
    completeness: {
      tier,
      label: INVESTMENTS_LABEL[tier],
      // A same-tier conflict must surface as a warning even when the tier is good.
      tone:  r.completeness.conflict ? "warning" : INVESTMENTS_TONE[tier],
      detail: r.completeness.reason,
    },
    evidence: trust.valuedOfTotalLabel ? { label: trust.valuedOfTotalLabel } : undefined,
  };
}

/**
 * Map a perspective-engine LensResult's provenance into an envelope (Liquidity/Debt).
 *
 * Trust correctness (convergence slice): the completeness tier is the lens's OWN
 * `completeness.tier` (its reconstruction/observation quality) — NOT `lens.estimated`,
 * which is the orthogonal FX-conversion taint. Pre-convergence this read
 * `lens.estimated`, so a single walked-back FX rate wrongly flipped the whole chip
 * to "Estimated". FX now surfaces as a `warnings[]` entry instead, and the shell
 * chip agrees with the workspace's own notes. A lens that answered "now" carries no
 * completeness envelope ⇒ a live observed read.
 */
function lensEnvelope(lens: LensResult): PerspectiveEnvelope {
  const p = lens.provenance;
  const n = p.accountIds.length;
  const tier: CompletenessTier = lens.completeness?.tier ?? "observed";
  const preset = COMPLETENESS_PRESENTATION[tier];
  return {
    completeness: {
      tier,
      label: preset.label,
      tone:  lens.completeness?.conflict ? "warning" : preset.tone,
      detail:
        lens.completeness?.reason ??
        (p.dataAsOf ? `Live account balances, as of ${p.dataAsOf.slice(0, 10)}.` : preset.detail),
    },
    evidence: n > 0 ? { label: `${n} account${n === 1 ? "" : "s"}` } : undefined,
    // V25-FINAL-1 — `unconverted` (a balance excluded for lack of a rate) is the
    // stronger caveat and wins over the softer walked-back "estimated".
    warnings: fxWarnings(lens.estimated, lens.unconverted),
  };
}

/**
 * Shape the active perspective's envelope. Pure; absent inputs ⇒ empty envelope
 * (the shell shows inert "—" chips). This is the single sourcing point — no host
 * ternaries.
 */
export function resolvePerspectiveEnvelope(args: {
  perspectiveId:  string;
  wealthResult?:  WealthResult | null;
  lensResult?:    LensResult | null;
  currency?:      string;
  /** S4 — the host-computed Cash Flow completeness stamp. Absent ⇒ static text. */
  cashFlowStamp?: CashFlowStamp | null;
  /** A10 — the host-fetched Investments Time Machine result. Absent ⇒ empty envelope. */
  investmentsResult?: InvestmentsTimeMachineResult | null;
  /**
   * V25-FINAL-1 — true when the perspective's displayed total EXCLUDES one or more
   * balances that had no acceptable exchange rate (a partial reporting-currency
   * total). Consumed by wealth/cashFlow to raise the stronger FX warning. Orthogonal
   * to completeness; ignored by perspectives that carry FX taint on their own result
   * (liquidity/debt read it from the LensResult).
   */
  fxUnconverted?: boolean;
}): PerspectiveEnvelope {
  switch (args.perspectiveId) {
    case "wealth":
      return args.wealthResult ? wealthEnvelope(args.wealthResult, args.currency ?? "USD", args.fxUnconverted) : {};
    case "cashFlow":
      return args.cashFlowStamp
        ? cashFlowEnvelope(args.cashFlowStamp, args.fxUnconverted)
        : { completeness: CASH_FLOW_STATIC, warnings: fxWarnings(false, args.fxUnconverted) };
    case "investments":
      return args.investmentsResult ? investmentsEnvelope(args.investmentsResult) : {};
    case "liquidity":
    case "debt":
      return args.lensResult ? lensEnvelope(args.lensResult) : {};
    default:
      return {}; // goals and any future lens: honest placeholder chips
  }
}
