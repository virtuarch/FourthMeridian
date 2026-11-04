/**
 * lib/platform/ai/call-stats.ts  (AI & Costs — the call KPIs, one pure function each)
 *
 * The AI & Costs hero KPIs "Calls · 7 d", "Error rate · 7 d" and "Est. cost / call"
 * (components/platform/leads/ai-costs-model.ts aiKpis) and the Platform
 * Intelligence retrieval of the same figures (ai-call-outcomes@1,
 * ai-cost-per-call@1 in lib/platform/intelligence/metrics) both read these two
 * functions over the SAME reader payload (getAiOperations — the
 * /api/platform/platform-ops/ai-invocations route). There is no second
 * computation: the tile and the envelope agree by construction (pinned by
 * retrieve.test.ts).
 *
 * Aggregates only: fleet totals of the invocation ledger, never a per-user,
 * per-Space or per-customer dimension (the reader exposes none).
 *
 * Pure, import-free at runtime (type imports only).
 */

import type { AiOperations } from "@/lib/platform/ai/invocations";

export interface AiCallStats {
  /** Every provider call in the window: RETURNED + failed (MEASURED). */
  calls: number;
  /** RETURNED (billed) calls. */
  returned: number;
  /** Calls that did not return usage (FAILED, TIMEOUT, RATE_LIMITED, QUOTA). */
  failed: number;
  /** failed ÷ calls × 100; null when no call was recorded (undefined, never 0%). */
  errorRatePct: number | null;
}

/** The call KPIs over one ai-invocations payload. */
export function aiCallStats(i: Pick<AiOperations, "totals" | "failures">): AiCallStats {
  const returned = i.totals.invocations;
  const failed = i.failures.total;
  const calls = returned + failed;
  return { calls, returned, failed, errorRatePct: calls === 0 ? null : (failed / calls) * 100 };
}

export const COST_PER_CALL_NO_RATE_CARD = "no rate card";
export const COST_PER_CALL_NO_CALLS = "no calls recorded";
export const COST_PER_CALL_NOTHING_PRICED = "nothing priced";

export type AiCostPerCall =
  /** usd = Σ priced spend of RETURNED calls ÷ RETURNED calls; `partial` when some tokens had no rate (a lower bound). */
  | { kind: "ESTIMATED"; usd: number; partial: boolean; pricedUsd: number; returned: number }
  | { kind: "UNKNOWN"; reason: string };

/** Estimated USD per RETURNED invocation (an aggregate: never per user or per customer). */
export function aiCostPerCall(i: Pick<AiOperations, "totals" | "pricingConfigured">): AiCostPerCall {
  if (!i.pricingConfigured) return { kind: "UNKNOWN", reason: COST_PER_CALL_NO_RATE_CARD };
  if (i.totals.invocations === 0) return { kind: "UNKNOWN", reason: COST_PER_CALL_NO_CALLS };
  if (i.totals.usd === null) return { kind: "UNKNOWN", reason: COST_PER_CALL_NOTHING_PRICED };
  return { kind: "ESTIMATED", usd: i.totals.usd / i.totals.invocations, partial: i.totals.unpricedTokens > 0, pricedUsd: i.totals.usd, returned: i.totals.invocations };
}
