/**
 * lib/liquidity/space-data-core.ts  (LIQ-H1 — Liquidity composition contract, pure core)
 *
 * THE canonical composition contract for the Liquidity workspace. Liquidity is a
 * TEMPORAL Perspective (consumesShellTime) that must answer, over the shell's
 * asOf / compareTo window: current state, past state, and their comparison. This
 * module owns the DURABLE composition of those endpoints; it computes NO liquidity
 * figure of its own — the ladder math lives ENTIRELY in computeLiquidity, and each
 * endpoint here is a whole `LensResult` carried verbatim (the contract composes
 * canonical outputs rather than flattening them into a bespoke ladder DTO).
 *
 * Shape (each field an existing authority, never cross-derived):
 *   • current     — the LIVE liquidity lens @ today (production current-state
 *                   truth via computePerspective). ALWAYS present — the anchor.
 *   • atAsOf      — computeLiquidity @ asOf over the SPLICED rows (the historical
 *                   engine: getAccountsAsOf + getInvestmentValueAsOf splice).
 *                   null on a pure current-state read (no asOf requested).
 *   • atCompareTo — computeLiquidity @ compareTo over spliced rows. null unless a
 *                   comparison date was requested.
 *   • delta       — per-tier (atAsOf − atCompareTo), a PURE subtraction; net
 *                   excludes credit (borrowing capacity is never liquidity). null
 *                   unless BOTH endpoints are present and ok.
 *   • trust       — the atAsOf endpoint's `completeness` re-surfaced (a POINTER,
 *                   not a recompute); the delta carries its own worst-of-endpoints
 *                   trust. null on a pure current-state read.
 *
 * PURE: no DB, no clock, no network. Composes already-computed `LensResult`s into
 * one serialisable shape. The runtime BINDING — the splice engine that produces
 * the historical endpoints against DB reads — is `./space-data.ts`
 * (loadLiquiditySpaceData). Unit-testable under tsx.
 */

import { worstTier } from "@/lib/perspective-engine/completeness";
import { liquidityReason } from "@/lib/perspective-engine/lenses/asof-completeness";
import type { Completeness, CompletenessTier, LensResult } from "@/lib/perspective-engine/types";

/** Fail-closed envelope for the degenerate case where an ok endpoint carries no
 *  completeness (should not occur — an ok as-of endpoint always has ≥1 contributing
 *  account and so an attached envelope — but the delta math must never throw). */
const UNKNOWN_COMPLETENESS: Completeness = {
  tier: "unknown",
  conflict: false,
  reason: "Trust for this endpoint could not be determined.",
};

/** Per-tier change between two liquidity endpoints. */
export interface LiquidityDelta {
  /** The earlier endpoint (compareTo date). */
  from: string;
  /** The later endpoint (asOf date). */
  to: string;
  cashNow: number;
  marketable: number;
  illiquid: number;
  credit: number;
  /**
   * Accessible-asset net change: Δcash + Δmarketable + Δilliquid. Credit is
   * borrowing capacity, NEVER liquidity (liquidity.core doctrine) — it is
   * reported per-tier for context but EXCLUDED from `net`.
   */
  net: number;
  /** Worst-of the two endpoints' trust — a delta is only as trustworthy as its weaker end. */
  trust: Completeness;
}

/** THE canonical Liquidity workspace composition contract. */
export interface LiquiditySpaceData {
  asOf: string;
  compareTo: string | null;
  /** Live liquidity @ today — the production current-state truth. Always present. */
  current: LensResult;
  /** Historical reconstruction @ asOf over spliced rows. null on a pure current read. */
  atAsOf: LensResult | null;
  /** Historical reconstruction @ compareTo over spliced rows. null unless requested. */
  atCompareTo: LensResult | null;
  /** Per-tier change (atAsOf − atCompareTo). null unless both endpoints are present and ok. */
  delta: LiquidityDelta | null;
  /** The atAsOf endpoint's completeness re-surfaced (pointer). null on a pure current read. */
  trust: Completeness | null;
}

/**
 * Read one liquidity tier value out of a LensResult by metric id. computeLiquidity
 * always emits `cashNow` (also the headline), `marketable`, and `illiquid`, and
 * `availableCredit` only when a known credit limit exists — a missing metric is a
 * true zero for that tier. A non-ok endpoint contributes nothing.
 */
function metricValue(lens: LensResult | null, id: string): number {
  if (!lens || lens.status !== "ok") return 0;
  const m = lens.metrics.find((x) => x.id === id);
  return m && typeof m.value === "number" ? m.value : 0;
}

/** Merge two per-component tier maps, keeping the WORST tier per bucket. */
function mergeByComponent(
  a?: Record<string, CompletenessTier>,
  b?: Record<string, CompletenessTier>,
): Record<string, CompletenessTier> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, CompletenessTier> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      out[k] = k in out ? worstTier([out[k], v]) : v;
    }
  }
  return out;
}

/**
 * Worst-of two endpoint envelopes — the honest trust of a comparison (worst tier,
 * conflict OR'd, byComponent worst-merged, reason from the liquidity vocabulary).
 * Exported for the loader/tests; uses the SAME propagation helpers the lens uses,
 * never a hand-rolled ordering.
 */
export function worstOfCompleteness(a: Completeness, b: Completeness, asOf: string): Completeness {
  const tier = worstTier([a.tier, b.tier]);
  const byComponent = mergeByComponent(a.byComponent, b.byComponent);
  return {
    tier,
    conflict: a.conflict || b.conflict,
    reason: liquidityReason(tier, asOf),
    ...(byComponent ? { byComponent } : {}),
  };
}

/**
 * Compose the canonical Liquidity workspace contract from already-computed lens
 * endpoints. PURE ORCHESTRATION — it computes NO liquidity sum: it carries each
 * endpoint verbatim, subtracts per-tier for the delta (credit excluded from net),
 * re-surfaces the atAsOf trust, and derives the delta's worst-of-endpoints trust.
 */
export function assembleLiquiditySpaceData(args: {
  asOf: string;
  compareTo?: string | null;
  current: LensResult;
  atAsOf?: LensResult | null;
  atCompareTo?: LensResult | null;
}): LiquiditySpaceData {
  const compareTo = args.compareTo ?? null;
  const atAsOf = args.atAsOf ?? null;
  const atCompareTo = args.atCompareTo ?? null;

  let delta: LiquidityDelta | null = null;
  if (atAsOf && atCompareTo && atAsOf.status === "ok" && atCompareTo.status === "ok") {
    const dCash = metricValue(atAsOf, "cashNow") - metricValue(atCompareTo, "cashNow");
    const dMkt = metricValue(atAsOf, "marketable") - metricValue(atCompareTo, "marketable");
    const dIll = metricValue(atAsOf, "illiquid") - metricValue(atCompareTo, "illiquid");
    const dCred = metricValue(atAsOf, "availableCredit") - metricValue(atCompareTo, "availableCredit");
    delta = {
      from: compareTo ?? args.asOf,
      to: args.asOf,
      cashNow: dCash,
      marketable: dMkt,
      illiquid: dIll,
      credit: dCred,
      net: dCash + dMkt + dIll,
      trust: worstOfCompleteness(
        atAsOf.completeness ?? UNKNOWN_COMPLETENESS,
        atCompareTo.completeness ?? UNKNOWN_COMPLETENESS,
        args.asOf,
      ),
    };
  }

  return {
    asOf: args.asOf,
    compareTo,
    current: args.current,
    atAsOf,
    atCompareTo,
    delta,
    trust: atAsOf?.completeness ?? null,
  };
}
