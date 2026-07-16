/**
 * lib/platform/cost/types.ts  (OPS-5 S10 — Cost & Latency Intelligence)
 *
 * THE canonical cost/latency model. Every metric is PURELY DERIVED from S7
 * Operational History and S9 Convergence — no direct execution reads, no bespoke
 * collectors, no background workers, no new schema. Each metric STATES its
 * provenance and carries the platform-wide trust tier (observed/derived/estimated/
 * unknown). Unknown stays Unknown; Estimated stays Estimated; no fake precision.
 */

import type { OperationalTier } from "@/lib/platform/history/types";

/** One derived cost/latency metric with honest provenance + trust. */
export interface CostMetric {
  id: string;
  label: string;
  /** The derived value, or null when it is honestly unknown. */
  value: number | null;
  unit: string; // "ms" | "count" | "usd" | "runs/day"
  tier: OperationalTier;
  /** Where this number came from (which upstream authority + reduction). */
  provenance: string;
  /** Optional system-generated context. */
  detail?: string;
}

export interface CostResult {
  asOf: string;
  window: { from: string; to: string };
  metrics: readonly CostMetric[];
  /** Worst tier across the metrics that carry a value. */
  trust: OperationalTier;
  checkedAt: string;
}
