/**
 * lib/platform/ai/invocation-economics.ts  (Platform Ops cost accounting — Slice 3)
 *
 * INVOCATION → TURN → SESSION economics, as a PURE reduction over AiInvocation
 * facts. No I/O, no database, no second pricing engine.
 *
 * ⚠️ EVERY DOLLAR COMES FROM SLICE 2. `priceAiUsage` is the one pricing
 * authority; this module adapts an invocation into the counter-row shape that
 * reducer already takes, so the subset-aware input formula
 * `(prompt − cached) × input + cached × cachedInput` and the effective-dated rate
 * lookup are inherited rather than reimplemented. There is no arithmetic here
 * that pricing does not own.
 *
 * ⚠️ EACH INVOCATION IS PRICED INDIVIDUALLY AND THEN SUMMED, which is what makes
 * "turn cost = Σ its invocation costs" and "session cost = Σ its turn costs" true
 * BY CONSTRUCTION rather than by a matching test. Pooling first would give the
 * same number today — the subset arithmetic is linear while cached ⊆ prompt holds
 * per invocation — but it would make the identity an arithmetic coincidence
 * instead of a structural guarantee, and it would lose the per-invocation figure
 * this slice exists to provide.
 *
 * ⚠️ UNPRICED IS NOT ZERO. An invocation whose day precedes every configured rate
 * contributes to `unpricedInvocations`, never to `usd`. A rollup where nothing
 * could be priced reports `usd: null`.
 */

import type { AiRate, UsageRowLike, PricedAiUsage } from "@/lib/usage/pricing";
import { priceAiUsage, AI_RATES } from "@/lib/usage/pricing";

/** One AiInvocation row, in the shape a reader selects it. */
export interface InvocationFact {
  provider: string;
  model: string;
  occurredAt: Date | string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  toolCallCount: number;
  environment: string;
  correlationId: string | null;
  turnIndex: number | null;
  surface: string | null;
}

/**
 * One invocation, expressed as the counter rows Slice 2's reducer consumes.
 *
 * The metric is rebuilt in the counter's own vocabulary so `modelFromMetric`
 * resolves it — the same parse, the same rate lookup, the same exclusions. Note
 * `reasoning_tokens` is NOT emitted: it is already inside `completion_tokens` and
 * would double count.
 */
export function invocationUsageRows(inv: InvocationFact): UsageRowLike[] {
  const day = typeof inv.occurredAt === "string" ? inv.occurredAt.slice(0, 10)
    : inv.occurredAt.toISOString().slice(0, 10);
  const metric = `chat.completions:${inv.model}`;
  return [
    { provider: inv.provider, metric, unit: "prompt_tokens",        day, count: inv.promptTokens },
    { provider: inv.provider, metric, unit: "cached_prompt_tokens", day, count: inv.cachedPromptTokens },
    { provider: inv.provider, metric, unit: "completion_tokens",    day, count: inv.completionTokens },
  ];
}

/** What one invocation cost, at the rate effective on the day it occurred. */
export function priceInvocation(inv: InvocationFact, rates: readonly AiRate[] = AI_RATES): PricedAiUsage {
  return priceAiUsage(invocationUsageRows(inv), rates);
}

export interface Rollup {
  /** Estimated USD, or null when nothing in the group could be priced. */
  usd: number | null;
  invocations: number;
  /** Invocations no rate covered — reported, never folded in at zero. */
  unpricedInvocations: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  latencyMs: number;
}

const EMPTY = (): Rollup => ({
  usd: null, invocations: 0, unpricedInvocations: 0, promptTokens: 0,
  cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: 0, latencyMs: 0,
});

/** Sum a set of invocations, pricing each one on its own day's rate. */
export function rollUp(invocations: readonly InvocationFact[], rates: readonly AiRate[] = AI_RATES): Rollup {
  const out = EMPTY();
  let anyPriced = false;
  for (const inv of invocations) {
    const priced = priceInvocation(inv, rates);
    if (priced.usd === null) out.unpricedInvocations += 1;
    else { out.usd = (out.usd ?? 0) + priced.usd; anyPriced = true; }
    out.invocations += 1;
    out.promptTokens += inv.promptTokens;
    out.cachedPromptTokens += inv.cachedPromptTokens;
    out.completionTokens += inv.completionTokens;
    out.reasoningTokens += inv.reasoningTokens;
    out.toolCalls += inv.toolCallCount;
    out.latencyMs += inv.latencyMs;
  }
  if (!anyPriced) out.usd = null;
  return out;
}

/** Group, then roll up. The key function decides the grain. */
function group<K extends string>(
  invocations: readonly InvocationFact[],
  key: (inv: InvocationFact) => K | null,
  rates: readonly AiRate[],
): { key: K; rollup: Rollup }[] {
  const buckets = new Map<K, InvocationFact[]>();
  for (const inv of invocations) {
    const k = key(inv);
    if (k === null) continue;   // ungroupable at this grain — still billable, counted elsewhere
    buckets.set(k, [...(buckets.get(k) ?? []), inv]);
  }
  return [...buckets.entries()]
    .map(([k, invs]) => ({ key: k, rollup: rollUp(invs, rates) }))
    .sort((a, b) => (b.rollup.usd ?? 0) - (a.rollup.usd ?? 0));
}

/**
 * Per user turn. The key is (correlationId, turnIndex) — an invocation missing
 * either is not part of any turn and is skipped HERE, not dropped: it still
 * appears in `rollUp` over the whole set, because it was still billed.
 */
export function byTurn(invocations: readonly InvocationFact[], rates: readonly AiRate[] = AI_RATES) {
  return group(invocations,
    (i) => (i.correlationId && i.turnIndex !== null ? `${i.correlationId}#${i.turnIndex}` : null), rates)
    .map(({ key, rollup }) => {
      const at = key.lastIndexOf("#");
      return { correlationId: key.slice(0, at), turnIndex: Number(key.slice(at + 1)), ...rollup };
    });
}

/** Per conversation/session. */
export function bySession(invocations: readonly InvocationFact[], rates: readonly AiRate[] = AI_RATES) {
  return group(invocations, (i) => i.correlationId, rates)
    .map(({ key, rollup }) => ({ correlationId: key, ...rollup }));
}

/** Per model, over whatever window the caller selected. */
export function byModel(invocations: readonly InvocationFact[], rates: readonly AiRate[] = AI_RATES) {
  return group(invocations, (i) => i.model, rates).map(({ key, rollup }) => ({ model: key, ...rollup }));
}

/** Per UTC day — the series a trend needs. */
export function byDay(invocations: readonly InvocationFact[], rates: readonly AiRate[] = AI_RATES) {
  return group(invocations,
    (i) => (typeof i.occurredAt === "string" ? i.occurredAt.slice(0, 10) : i.occurredAt.toISOString().slice(0, 10)),
    rates)
    .map(({ key, rollup }) => ({ day: key, ...rollup }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Per deployment environment.
 *
 * ⚠️ THE REASON environment IS ON THE FACT AT ALL. One provider account serves
 * local development, preview and production, so without this dimension "platform
 * AI spend" and "production cost-to-serve" are the same number — and the recorded
 * Plaid precedent is that development churn can be the large majority of a bill.
 */
export function byEnvironment(invocations: readonly InvocationFact[], rates: readonly AiRate[] = AI_RATES) {
  return group(invocations, (i) => i.environment, rates)
    .map(({ key, rollup }) => ({ environment: key, ...rollup }));
}
