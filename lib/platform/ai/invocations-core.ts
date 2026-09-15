/**
 * lib/platform/ai/invocations-core.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The PURE fold over AiInvocation GROUP rows into the AI operations read model.
 * No I/O, no clock, no rates of its own: every dollar comes from the one
 * code-owned rate card (lib/usage/pricing.ts `priceAiUsage`), priced at the
 * (provider, model, day) grain the day counter already uses — the cost formula
 * is linear in tokens, so a group priced once equals its rows priced one by one.
 *
 * WHAT THE AUTHORITY CAN AND CANNOT SAY — stated on the result, not implied:
 *   · surface / model / provider / environment / day / request+turn: recorded;
 *   · user / Space: NOT recorded, by explicit doctrine (lib/ai/invocation.ts) —
 *     an invocation is never resolvable to a person, so per-user cost is not a
 *     missing feature, it is a boundary. The result names it.
 *   · failures: NOT recorded — the ledger holds billed, returned calls only
 *     (a timeout writes no row). "Invocation count" is therefore a count of
 *     successful provider round-trips, and the result says so.
 */

import { priceAiUsage, type AiRate, AI_RATES, type UsageRowLike } from "@/lib/usage/pricing";

/** One (provider, model, surface, environment, day) group, as read from the ledger. */
export interface InvocationGroup {
  provider: string;
  model: string;
  surface: string | null;
  environment: string;
  /** YYYY-MM-DD (UTC) */
  day: string;
  invocations: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  latencyMsTotal: number;
  latencyMsMax: number;
}

export interface AiTotals {
  invocations: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  /** Mean provider round-trip; null when nothing was recorded. */
  meanLatencyMs: number | null;
  maxLatencyMs: number | null;
  /** Estimated USD from the rate card; null when NOTHING could be priced. */
  usd: number | null;
  /** Tokens (prompt + completion) whose model had no rate on their day. */
  unpricedTokens: number;
  /** cached ÷ prompt, or null when no prompt tokens. */
  cacheShare: number | null;
}

export interface AiBucket extends AiTotals {
  key: string;
}

export interface AiOperationsCore {
  totals: AiTotals;
  bySurface: readonly AiBucket[];
  byModel: readonly AiBucket[];
  byEnvironment: readonly AiBucket[];
  byDay: readonly AiBucket[];
  /** The surface value for rows recorded outside any context. */
  unattributedSurfaceKey: string;
}

export const UNATTRIBUTED_SURFACE = "(none)";

function usageRowsOf(g: InvocationGroup): UsageRowLike[] {
  const metric = `chat.completions:${g.model}`;
  return [
    { provider: g.provider, metric, unit: "prompt_tokens",        day: g.day, count: g.promptTokens },
    { provider: g.provider, metric, unit: "cached_prompt_tokens", day: g.day, count: g.cachedPromptTokens },
    { provider: g.provider, metric, unit: "completion_tokens",    day: g.day, count: g.completionTokens },
  ];
}

function totalsOf(groups: readonly InvocationGroup[], rates: readonly AiRate[]): AiTotals {
  const t = {
    invocations: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0,
    reasoningTokens: 0, toolCalls: 0, latencyTotal: 0, maxLatency: null as number | null,
  };
  for (const g of groups) {
    t.invocations += g.invocations;
    t.promptTokens += g.promptTokens;
    t.cachedPromptTokens += g.cachedPromptTokens;
    t.completionTokens += g.completionTokens;
    t.reasoningTokens += g.reasoningTokens;
    t.toolCalls += g.toolCalls;
    t.latencyTotal += g.latencyMsTotal;
    t.maxLatency = t.maxLatency === null ? g.latencyMsMax : Math.max(t.maxLatency, g.latencyMsMax);
  }
  const priced = priceAiUsage(groups.flatMap(usageRowsOf), rates);
  return {
    invocations: t.invocations,
    promptTokens: t.promptTokens,
    cachedPromptTokens: t.cachedPromptTokens,
    completionTokens: t.completionTokens,
    reasoningTokens: t.reasoningTokens,
    toolCalls: t.toolCalls,
    meanLatencyMs: t.invocations > 0 ? Math.round(t.latencyTotal / t.invocations) : null,
    maxLatencyMs: t.maxLatency,
    usd: priced.usd,
    unpricedTokens: priced.unpricedTokens,
    cacheShare: t.promptTokens > 0 ? t.cachedPromptTokens / t.promptTokens : null,
  };
}

function bucketsBy(
  groups: readonly InvocationGroup[],
  key: (g: InvocationGroup) => string,
  rates: readonly AiRate[],
  order: "usd" | "key",
): AiBucket[] {
  const map = new Map<string, InvocationGroup[]>();
  for (const g of groups) {
    const k = key(g);
    const list = map.get(k);
    if (list) list.push(g); else map.set(k, [g]);
  }
  const out = [...map.entries()].map(([k, rows]) => ({ key: k, ...totalsOf(rows, rates) }));
  if (order === "key") return out.sort((a, b) => a.key.localeCompare(b.key));
  return out.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.invocations - a.invocations || a.key.localeCompare(b.key));
}

/** The fold. Pure. */
export function buildAiOperations(groups: readonly InvocationGroup[], rates: readonly AiRate[] = AI_RATES): AiOperationsCore {
  return {
    totals: totalsOf(groups, rates),
    bySurface: bucketsBy(groups, (g) => g.surface ?? UNATTRIBUTED_SURFACE, rates, "usd"),
    byModel: bucketsBy(groups, (g) => `${g.provider}:${g.model}`, rates, "usd"),
    byEnvironment: bucketsBy(groups, (g) => g.environment, rates, "usd"),
    byDay: bucketsBy(groups, (g) => g.day, rates, "key"),
    unattributedSurfaceKey: UNATTRIBUTED_SURFACE,
  };
}

/** The windows an operator may ask for. Bounded by construction. */
export const AI_WINDOWS = ["24h", "7d", "30d"] as const;
export type AiWindow = (typeof AI_WINDOWS)[number];

export function parseAiWindow(raw: string | null | undefined): AiWindow {
  return (AI_WINDOWS as readonly string[]).includes(raw ?? "") ? (raw as AiWindow) : "7d";
}

export function windowStart(window: AiWindow, now: Date): Date {
  const hours = window === "24h" ? 24 : window === "7d" ? 24 * 7 : 24 * 30;
  return new Date(now.getTime() - hours * 3_600_000);
}
