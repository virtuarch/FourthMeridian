/**
 * lib/usage/ai-tokens.ts  (Platform Ops cost accounting — Slice 1)
 *
 * THE ONE PLACE THAT KNOWS WHAT AN OPENAI USAGE OBJECT MEANS.
 *
 * Slice 1 captures the two facts `ApiUsageCounter` was missing. It stores no
 * dollars and derives no cost — pricing is Slice 2. What it does own is the
 * arithmetic that every future price must be built on.
 *
 * ── The subset invariant, and why it has a module ───────────────────────────
 *
 *     cached_tokens    ⊆ prompt_tokens
 *     reasoning_tokens ⊆ completion_tokens
 *
 * Neither is a sibling of its parent. They are PARTS OF IT, reported separately
 * because they are priced or explained differently:
 *
 *   • CACHED PROMPT TOKENS change the RATE. Uncached input is billed at the
 *     input rate and cached input at roughly a tenth of it, so the correct
 *     reduction is
 *         (prompt − cached) × inputRate  +  cached × cachedRate
 *     and NEVER
 *         prompt × inputRate  +  cached × cachedRate
 *     The wrong form does not merely mis-state the bill, it makes it LARGER
 *     than pricing the raw prompt alone — a "cost fix" that increases the
 *     reported cost. That is the defect this module exists to make impossible,
 *     and `uncachedPromptTokens` is the only sanctioned way to get the number.
 *
 *   • REASONING TOKENS change nothing about the rate. They are already inside
 *     `completion_tokens` and are billed at the output rate like any other
 *     output token. They are captured to EXPLAIN a bill, never to add to one.
 *     Pricing them separately would double count. `nonReasoningCompletionTokens`
 *     exists for the same reason `uncachedPromptTokens` does: so the split is
 *     computed once, correctly, rather than by whoever needs it next.
 *
 * ── What is deliberately NOT stored ─────────────────────────────────────────
 * No `uncached_prompt_tokens` unit and no `total_tokens` unit. Both are
 * derivations, and a stored derivation can drift from the parts it was derived
 * from — the "two competing figures" defect the platform layer already forbids.
 * Derive at read time, from the facts below.
 *
 * PURE — no imports, no I/O, no database. That is what lets the invariant be
 * tested in the DB-free suite rather than only against a live provider.
 */

/** The OpenAI usage object, in the shape this codebase reads it. */
export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Present on models/endpoints that report prompt caching. */
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** Present on reasoning models. */
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

/**
 * The `ApiUsageCounter.unit` vocabulary for one OpenAI call.
 *
 * ⚠️ ADDITIVE ONLY. `unit` is a free string on the counter, so adding a member
 * needs no migration — but an existing member may never change meaning, because
 * rows already written under it cannot be reinterpreted.
 */
export const AI_USAGE_UNITS = {
  CALLS:                'calls',
  PROMPT_TOKENS:        'prompt_tokens',
  /** ⊆ PROMPT_TOKENS. Billed at the cached rate, not the input rate. */
  CACHED_PROMPT_TOKENS: 'cached_prompt_tokens',
  COMPLETION_TOKENS:    'completion_tokens',
  /** ⊆ COMPLETION_TOKENS. Billed at the output rate — explanatory, not additive. */
  REASONING_TOKENS:     'reasoning_tokens',
} as const;

export type AiUsageUnit = typeof AI_USAGE_UNITS[keyof typeof AI_USAGE_UNITS];

const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/**
 * Everything one OpenAI call contributes to the counter, as (unit, count) pairs.
 *
 * ⚠️ ONE CALL SITE PER UNIT, ACROSS EVERY PATH. Before this existed, the three
 * capture blocks in `lib/ai/provider.ts` each wrote their own three lines, and
 * they had already drifted: `reasoning_tokens` was read in one of the three and
 * discarded, and `cached_tokens` was read in none. A list built in one place is
 * what stops a fourth path from capturing a fourth subset.
 *
 * Counts are reported EXACTLY as the provider gave them — a zero or absent field
 * yields 0, and `recordApiUsage` treats 0 as a no-op, so an absent detail block
 * writes no row rather than a false zero. Nothing is clamped here: if a provider
 * ever reported `cached > prompt`, that anomaly belongs in the facts, and the
 * clamp lives in the derivation below where it can be seen.
 */
export function aiUsageUnits(usage: OpenAiUsage | null | undefined): { unit: AiUsageUnit; count: number }[] {
  if (!usage) return [];
  return [
    { unit: AI_USAGE_UNITS.CALLS,                count: 1 },
    { unit: AI_USAGE_UNITS.PROMPT_TOKENS,        count: whole(usage.prompt_tokens) },
    { unit: AI_USAGE_UNITS.CACHED_PROMPT_TOKENS, count: whole(usage.prompt_tokens_details?.cached_tokens) },
    { unit: AI_USAGE_UNITS.COMPLETION_TOKENS,    count: whole(usage.completion_tokens) },
    { unit: AI_USAGE_UNITS.REASONING_TOKENS,     count: whole(usage.completion_tokens_details?.reasoning_tokens) },
  ];
}

/**
 * Input tokens billed at the FULL input rate: `prompt − cached`.
 *
 * ⚠️ SUBTRACTION, NEVER ADDITION. Clamped at zero so a contradictory pair can
 * never produce a negative quantity that a later multiplication would turn into
 * a negative cost.
 */
export function uncachedPromptTokens(promptTokens: number, cachedPromptTokens: number): number {
  return Math.max(0, whole(promptTokens) - whole(cachedPromptTokens));
}

/**
 * Output tokens that were not reasoning: `completion − reasoning`.
 *
 * Both halves bill at the same output rate, so this is for EXPLAINING a bill
 * ("74% of output was reasoning"), never for pricing one.
 */
export function nonReasoningCompletionTokens(completionTokens: number, reasoningTokens: number): number {
  return Math.max(0, whole(completionTokens) - whole(reasoningTokens));
}
