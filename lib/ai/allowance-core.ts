/**
 * lib/ai/allowance-core.ts  (BETA C7 — the per-customer daily AI allowance, pure)
 *
 * WHAT A CUSTOMER MAY STILL SPEND TODAY, AND WHY NOT. The `aiDailyUsdAllowance`
 * entitlement (catalogue: BETA $5, FOUNDER overlay $20, ceiling $20, whole USD)
 * is an estimated-dollar bound on the model calls a customer may cause per UTC
 * day across Conversations and the Daily Brief. This module holds the two pure
 * halves: the fold of today's ledger rows into a spent figure, and the verdict.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * An invocation on a model with no rate in force CANNOT be priced, so the
 * customer's spend today is UNKNOWN — and an unknown spend is not "under the
 * allowance". The verdict refuses with `UNPRICED_MODEL` whenever any of today's
 * invocations is unpriced, whatever the priced part sums to (owner rule,
 * 2026-10-15: an unpriceable model never counts as zero and never bypasses a
 * safeguard). The provider chokepoint refuses such a model before the call,
 * so this branch is the belt to that brace: it covers rows written before a
 * rate was retired, or by a path that bypassed the chokepoint.
 *
 * ── The comparison ──────────────────────────────────────────────────────────
 * Refused when spent ≥ allowance. The NEXT turn is what is being decided and it
 * will cost something, so a customer who has reached the line is over it. An
 * allowance of 0 therefore refuses every turn (the ceiling's floor is a
 * boolean dimension's job, but 0 must still mean 0, never "unlimited").
 *
 * PURE — no I/O, no clock, no database. The loader is lib/ai/allowance.ts.
 */

import { AI_RATES, type AiRate } from "@/lib/usage/pricing";
import { fmtMoney } from "@/lib/ai/format";
import { priceSpendGroup, type ModelUsageGroup, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";

export const ALLOWANCE_CODE = "AI_ALLOWANCE" as const;

/** One (provider, model) group of the customer's RETURNED customer-surface rows TODAY. */
export type TodaySpendGroup = ModelUsageGroup;

export interface TodaySpend {
  /** Estimated USD over the priced invocations; 0 when nothing was spent. */
  spentUsd: number;
  invocations: number;
  unpricedInvocations: number;
  unpricedModels: string[];
}

/** Pure: today's groups, priced at today's rate. */
export function sumTodaySpend(groups: readonly TodaySpendGroup[], todayISO: string, rates: readonly AiRate[] = AI_RATES): TodaySpend {
  let spentUsd = 0, invocations = 0, unpricedInvocations = 0;
  const unpricedModels = new Set<string>();
  for (const g of groups) {
    invocations += g.invocations;
    const asGroup: SpendGroup = { ...g, surface: null, day: todayISO };
    const priced = priceSpendGroup(asGroup, rates);
    if (priced.unpriced) { unpricedInvocations += g.invocations; unpricedModels.add(`${g.provider}:${g.model}`); continue; }
    if (priced.usd !== null) spentUsd += priced.usd;
  }
  return { spentUsd, invocations, unpricedInvocations, unpricedModels: [...unpricedModels].sort() };
}

export type AllowanceReason = "ALLOWANCE_EXHAUSTED" | "UNPRICED_MODEL";

export type AllowanceVerdict =
  | { allowed: true; spentUsd: number; allowanceUsd: number; remainingUsd: number }
  | { allowed: false; reason: AllowanceReason; spentUsd: number; allowanceUsd: number; unpricedInvocations: number };

/** PURE — the decision. */
export function dailyAllowanceVerdict(input: { spentUsd: number; allowanceUsd: number; unpricedInvocations: number }): AllowanceVerdict {
  const spentUsd = Number.isFinite(input.spentUsd) && input.spentUsd > 0 ? input.spentUsd : 0;
  const allowanceUsd = Number.isFinite(input.allowanceUsd) && input.allowanceUsd > 0 ? input.allowanceUsd : 0;
  const unpricedInvocations = Number.isFinite(input.unpricedInvocations) && input.unpricedInvocations > 0 ? Math.floor(input.unpricedInvocations) : 0;
  // Fail closed FIRST: an unknown spend is never "under the allowance".
  if (unpricedInvocations > 0) return { allowed: false, reason: "UNPRICED_MODEL", spentUsd, allowanceUsd, unpricedInvocations };
  if (spentUsd >= allowanceUsd) return { allowed: false, reason: "ALLOWANCE_EXHAUSTED", spentUsd, allowanceUsd, unpricedInvocations: 0 };
  return { allowed: true, spentUsd, allowanceUsd, remainingUsd: allowanceUsd - spentUsd };
}

/** The customer-readable refusal body — one shape for Conversations and the Daily Brief. */
export interface AllowanceRefusalBody {
  error: string;
  code: typeof ALLOWANCE_CODE;
  reason: AllowanceReason;
  /** Estimated USD, rounded to the cent. */
  spentUsd: number;
  allowanceUsd: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function allowanceRefusalBody(v: Extract<AllowanceVerdict, { allowed: false }>, surfaceLabel: string): AllowanceRefusalBody {
  const error = v.reason === "UNPRICED_MODEL"
    ? `${surfaceLabel} is paused for today: some of today’s usage can’t be priced yet, so your daily AI allowance can’t be checked. Nothing was changed. It resets at midnight UTC.`
    // The allowance is denominated in USD by definition (the rate card is USD);
    // formatted through the currency-aware helper, never a literal symbol (REVIEW-3 C-6).
    : `You’ve used today’s AI allowance (about ${fmtMoney(v.allowanceUsd, "USD")} of estimated usage). ${surfaceLabel} resets at midnight UTC. Nothing was changed.`;
  return { error, code: ALLOWANCE_CODE, reason: v.reason, spentUsd: cents(v.spentUsd), allowanceUsd: v.allowanceUsd };
}

/**
 * The HTTP status for a refusal. 429 for an exhausted allowance — time cures it
 * (the UTC day rolls) — and 503 for an unpriced model: the service cannot price
 * what it would run, which only the operator (the rate card) can fix. 503 is
 * also what the Conversations route answers when the provider chokepoint
 * refuses the model itself, so a customer sees ONE status for the one gap.
 */
export function allowanceRefusalStatus(v: Extract<AllowanceVerdict, { allowed: false }>): 429 | 503 {
  return v.reason === "UNPRICED_MODEL" ? 503 : 429;
}
