/**
 * lib/platform/history/types.ts  (OPS-5 S7 — Operational History)
 *
 * THE canonical model of Platform Operations HISTORY. One model — every
 * operational subsystem contributes into it; no subsystem invents its own
 * historical representation. It is a READ MODEL: operational history is NOT a new
 * stored fact stream — it is reconstructed at read-time from the append-only
 * ledgers that ALREADY exist (JobRun, ApiUsageCounter, FxRate/PriceObservation,
 * the evaluate-alerts JobRun summaries), reusing each subsystem's OWN live engine
 * at the as-of point. This is what the mission's absolute prohibitions require:
 * no second JobRun interpretation, no second freshness/provider model, and
 * historical values computed the SAME way as live values (the live classifier,
 * fed as-of inputs).
 *
 * TRUST uses the platform-wide doctrine vocabulary (lib/perspective-engine/types
 * `CompletenessTier` / `Completeness`) — observed · derived · estimated ·
 * incomplete · unknown. A point is `observed` when a ledger row exists at that
 * time; `derived` when a live engine reconstructs a verdict from observed rows;
 * `unknown` when the ledgers do not cover the period. Unknown stays Unknown.
 */

import type { Completeness, CompletenessTier } from "@/lib/perspective-engine/types";

/** The operational trust tier — the platform-wide doctrine vocabulary, verbatim. */
export type OperationalTier = CompletenessTier;

/** A single dated observation in one subsystem's history. Carries only
 *  system-generated identifiers/counts/states — never user content. */
export interface OperationalHistoryPoint {
  /** ISO datetime of the observation. */
  at: string;
  /** Trust of THIS point (observed row vs derived verdict). */
  tier: OperationalTier;
  /** System label — a status/kind/id ("succeeded" / "stale" / "OPERATIONAL"). */
  label: string;
  /** Numeric metric at this point (durationMs, ageDays, count …) or null. */
  value: number | null;
  /** Optional system-generated context (no PII). */
  detail?: string;
}

/** One history stream from ONE source (ONE ledger + its own engine). */
export interface OperationalHistorySeries {
  /** Registry id of the producing source. */
  sourceId: string;
  label: string;
  /** What this series measures — "execution" | "latency" | "freshness" | "trust" | "alerts" | "operations". */
  metric: string;
  /** Unit of `point.value` — "ms" | "days" | "count" | null. */
  unit: string | null;
  /** Chronological (ascending) points. */
  points: readonly OperationalHistoryPoint[];
  /** Worst tier across the points — the series' honest trust. */
  trust: OperationalTier;
  /** Earliest date this source can answer for (an honest lower bound), or null. */
  coverageFrom: string | null;
}

/** The as-of state of one source — reused from the LIVE engine at the as-of date. */
export interface OperationalAsOfState {
  sourceId: string;
  label: string;
  /** The as-of date this state answers for. */
  at: string;
  tier: OperationalTier;
  /** The engine's verdict at as-of ("healthy" / "stale" / "OPERATIONAL" / …). */
  status: string;
  /** System-generated one-liner (counts/states only). */
  summary: string;
  /** Headline numeric at as-of, or null. */
  value: number | null;
}

/** THE canonical operational-history answer for a time selection. */
export interface OperationalHistoryResult {
  /** As-of endpoint (YYYY-MM-DD). */
  asOf: string;
  /** Compare-to date (YYYY-MM-DD) or null. */
  compareTo: string | null;
  /** The trend window [from, to] (YYYY-MM-DD). */
  window: { from: string; to: string };
  /** Per-source state as-of `asOf`. */
  states: readonly OperationalAsOfState[];
  /** Per-source state as-of `compareTo` (for deltas), or null. */
  compareStates: readonly OperationalAsOfState[] | null;
  /** Trend series over the window. */
  series: readonly OperationalHistorySeries[];
  /** Overall completeness — worst tier across sources, with a reason. */
  completeness: Completeness;
  checkedAt: string;
}
