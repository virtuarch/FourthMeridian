/**
 * lib/perspectives/envelope.ts
 *
 * The per-perspective trust envelope contract + registry (amended plan S3). The
 * shell renders Completeness + Evidence from whatever the ACTIVE lens supplies;
 * this pure resolver shapes each lens's own data into one envelope shape. Fixed
 * vocabulary, no fabricated counts, no percentages (§4.6): an absent envelope
 * yields an inert "—" placeholder, never invented detail.
 *
 * Today: Wealth ← the WealthResult; Cash Flow ← a static honest boundary
 * statement; Investments ← "Current holdings only"; Liquidity/Debt ← their
 * perspective-engine LensResult provenance when available; Goals ← none. As A7/
 * A8/A10 land, each lens swaps its source here without touching the shell (P6).
 */

import type { LensResult } from "@/lib/perspective-engine/types";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { formatCurrency } from "@/lib/format";

export type EnvelopeTier = "observed" | "derived" | "estimated" | "incomplete";
export type EnvelopeTone = "neutral" | "positive" | "warning";

export interface EnvelopeCompleteness {
  tier:    EnvelopeTier;
  /** Fixed user-facing label (Observed / Reconstructed / …). Never a percentage. */
  label:   string;
  tone:    EnvelopeTone;
  /** One-sentence reason for the popover. Absent ⇒ chip is not clickable. */
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
}

const WEALTH_DETAIL: Record<EnvelopeTier, string> = {
  observed:   "A snapshot was recorded on or before this date.",
  derived:    "Reconstructed from your history — some values are held at recent prices.",
  estimated:  "Estimated from partial data for this date.",
  incomplete: "No snapshot exists on or before this date.",
};

function wealthEnvelope(r: WealthResult, currency: string): PerspectiveEnvelope {
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
  return { completeness, evidence };
}

/** Map a perspective-engine LensResult's provenance into an envelope (Liquidity/Debt). */
function lensEnvelope(lens: LensResult): PerspectiveEnvelope {
  const p = lens.provenance;
  const n = p.accountIds.length;
  const tier: EnvelopeTier = lens.estimated ? "estimated" : "observed";
  return {
    completeness: {
      tier,
      label: lens.estimated ? "Estimated" : "Observed",
      tone:  lens.estimated ? "warning" : "positive",
      detail: p.dataAsOf
        ? `Live account balances${lens.estimated ? " with some estimated values" : ""}, as of ${p.dataAsOf.slice(0, 10)}.`
        : undefined,
    },
    evidence: n > 0 ? { label: `${n} account${n === 1 ? "" : "s"}` } : undefined,
  };
}

/**
 * Shape the active perspective's envelope. Pure; absent inputs ⇒ empty envelope
 * (the shell shows inert "—" chips). This is the single sourcing point — no host
 * ternaries.
 */
export function resolvePerspectiveEnvelope(args: {
  perspectiveId: string;
  wealthResult?: WealthResult | null;
  lensResult?:   LensResult | null;
  currency?:     string;
}): PerspectiveEnvelope {
  switch (args.perspectiveId) {
    case "wealth":
      return args.wealthResult ? wealthEnvelope(args.wealthResult, args.currency ?? "USD") : {};
    case "cashFlow":
      return {
        completeness: {
          tier: "observed",
          label: "Complete within transaction depth",
          tone: "neutral",
          detail: "Cash Flow reflects every transaction on file; history is bounded by your accounts' transaction depth.",
        },
      };
    case "investments":
      return {
        completeness: {
          tier: "incomplete",
          label: "Current holdings only",
          tone: "warning",
          detail: "Investments shows current holdings; historical valuation arrives with the price foundation.",
        },
      };
    case "liquidity":
    case "debt":
      return args.lensResult ? lensEnvelope(args.lensResult) : {};
    default:
      return {}; // goals and any future lens: honest placeholder chips
  }
}
