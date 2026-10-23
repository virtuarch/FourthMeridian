/**
 * lib/platform/ai/spend-by-surface-core.ts  (BETA C6 — fleet AI spend by surface)
 *
 * THE PURE FOLD THAT TELLS CUSTOMER SPEND FROM OVERHEAD. Before this module every
 * fleet-grain dollar figure (Economics block, AI activity block, trend widget)
 * came from the ApiUsageCounter, which has no surface dimension — so the
 * evaluation harness's traffic (372 of 443 rows on the dev ledger) was reported
 * as if customers had caused it. The AiInvocation ledger records `surface`, so
 * spend CAN be allocated; this fold is where it is.
 *
 *   CUSTOMER   surface ∈ {chat, brief} — what customers caused. The headline.
 *   OVERHEAD   everything else: `harness` (evaluation runs), and any other or
 *              unattributed surface. Never customer spend, never hidden.
 *   UNPRICED   invocations whose model had no rate in force on their day.
 *              Reported as a COUNT with the model names — never folded in at $0.
 *
 * EVERY DOLLAR COMES FROM lib/usage/pricing.ts (`priceAiUsage`), priced at the
 * (provider, model, UTC day) grain the counter already uses. There is no second
 * cost engine here; this module only decides which bucket a priced group lands
 * in. PURE — no I/O, no clock.
 */

import { AI_RATES, priceAiUsage, type AiRate, type UsageRowLike } from "@/lib/usage/pricing";

/** The two surfaces whose invocations are customer spend. Everything else is overhead. */
export const CUSTOMER_SURFACES = ["chat", "brief"] as const;
export type CustomerSurface = (typeof CUSTOMER_SURFACES)[number];

export function isCustomerSurface(surface: string | null | undefined): surface is CustomerSurface {
  return (CUSTOMER_SURFACES as readonly string[]).includes(surface ?? "");
}

/** One (provider, model) group of RETURNED rows' token usage — the shape every spend fold prices. */
export interface ModelUsageGroup {
  provider: string;
  model: string;
  invocations: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

/** One (provider, model, surface, UTC day) group of RETURNED rows, as a reader selects it. */
export interface SpendGroup extends ModelUsageGroup {
  surface: string | null;
  /** YYYY-MM-DD (UTC) */
  day: string;
}

/** A priced bucket. `usd` is null when NOTHING in the bucket could be priced. */
export interface SpendFigure {
  /** Estimated USD over the priced invocations, or null when none were priced. */
  usd: number | null;
  invocations: number;
  pricedInvocations: number;
  /** Invocations whose model had no rate on their day — excluded from `usd`, never $0. */
  unpricedInvocations: number;
  /** Prompt + completion tokens, priced or not. */
  tokens: number;
}

export interface SpendDay {
  day: string;
  customerUsd: number | null;
  overheadUsd: number | null;
  unpricedInvocations: number;
}

export interface AiSpendBySurface {
  /** What customers caused: Conversations and the Daily Brief, and their sum. */
  customer: { chat: SpendFigure; brief: SpendFigure; total: SpendFigure };
  /** What the platform caused: evaluation runs and anything not attributed to a customer surface. */
  overhead: { harness: SpendFigure; other: SpendFigure; total: SpendFigure };
  /** The coverage statement: what could NOT be priced, across every surface. */
  unpriced: { tokens: number; invocations: number; models: string[] };
  byDay: SpendDay[];
}

const EMPTY = (): SpendFigure => ({ usd: null, invocations: 0, pricedInvocations: 0, unpricedInvocations: 0, tokens: 0 });

function usageRowsOf(g: SpendGroup): UsageRowLike[] {
  const metric = `chat.completions:${g.model}`;
  return [
    { provider: g.provider, metric, unit: "prompt_tokens",        day: g.day, count: g.promptTokens },
    { provider: g.provider, metric, unit: "cached_prompt_tokens", day: g.day, count: g.cachedPromptTokens },
    { provider: g.provider, metric, unit: "completion_tokens",    day: g.day, count: g.completionTokens },
  ];
}

/** Price ONE group. A group is wholly priced or wholly unpriced: one model, one day, one rate. */
export function priceSpendGroup(g: SpendGroup, rates: readonly AiRate[] = AI_RATES): { usd: number | null; unpriced: boolean } {
  const p = priceAiUsage(usageRowsOf(g), rates);
  // A group with zero tokens prices to null without being unpriced — nothing to price.
  const tokens = g.promptTokens + g.completionTokens;
  return { usd: p.usd, unpriced: tokens > 0 && p.usd === null };
}

function add(into: SpendFigure, g: SpendGroup, priced: { usd: number | null; unpriced: boolean }): void {
  into.invocations += g.invocations;
  into.tokens += g.promptTokens + g.completionTokens;
  if (priced.unpriced) { into.unpricedInvocations += g.invocations; return; }
  into.pricedInvocations += g.invocations;
  if (priced.usd !== null) into.usd = (into.usd ?? 0) + priced.usd;
}

function sum(...figs: SpendFigure[]): SpendFigure {
  const out = EMPTY();
  for (const f of figs) {
    out.invocations += f.invocations;
    out.pricedInvocations += f.pricedInvocations;
    out.unpricedInvocations += f.unpricedInvocations;
    out.tokens += f.tokens;
    if (f.usd !== null) out.usd = (out.usd ?? 0) + f.usd;
  }
  return out;
}

/** The fold. Pure. */
export function buildAiSpendBySurface(groups: readonly SpendGroup[], rates: readonly AiRate[] = AI_RATES): AiSpendBySurface {
  const chat = EMPTY(), brief = EMPTY(), harness = EMPTY(), other = EMPTY();
  const unpricedModels = new Set<string>();
  let unpricedTokens = 0, unpricedInvocations = 0;
  const days = new Map<string, SpendDay>();

  for (const g of groups) {
    const priced = priceSpendGroup(g, rates);
    const bucket = g.surface === "chat" ? chat : g.surface === "brief" ? brief : g.surface === "harness" ? harness : other;
    add(bucket, g, priced);

    const d = days.get(g.day) ?? { day: g.day, customerUsd: null, overheadUsd: null, unpricedInvocations: 0 };
    if (priced.unpriced) {
      unpricedModels.add(`${g.provider}:${g.model}`);
      unpricedTokens += g.promptTokens + g.completionTokens;
      unpricedInvocations += g.invocations;
      d.unpricedInvocations += g.invocations;
    } else if (priced.usd !== null) {
      if (isCustomerSurface(g.surface)) d.customerUsd = (d.customerUsd ?? 0) + priced.usd;
      else d.overheadUsd = (d.overheadUsd ?? 0) + priced.usd;
    }
    days.set(g.day, d);
  }

  return {
    customer: { chat, brief, total: sum(chat, brief) },
    overhead: { harness, other, total: sum(harness, other) },
    unpriced: { tokens: unpricedTokens, invocations: unpricedInvocations, models: [...unpricedModels].sort() },
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
