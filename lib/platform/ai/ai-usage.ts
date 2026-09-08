/**
 * lib/platform/ai/ai-usage.ts  (OPS-6D AI Operations)
 *
 * A PURE PROJECTION of AI usage OVER TIME from the ApiUsageCounter ledger — the
 * per-day trend the existing windowed api-usage route does not provide. Reuses the
 * ApiUsageCounter dimensions (provider/metric[model]/unit/day) and the S10-adjacent
 * pricing helper (lib/usage/pricing) for an ESTIMATED daily spend — never a second
 * cost engine, never a fabricated dollar figure. Per-user / per-workspace AI cost
 * is structurally impossible until ApiUsageCounter gains a user/space dimension
 * (OPS-6H); this projection is honestly aggregate-only.
 *
 * PURE CORE + INJECTED I/O: rows are read through an injected reader; the trend
 * build + pricing are pure.
 */

import "server-only";
import { db } from "@/lib/db";
import { priceAiUsage, isPricingConfigured } from "@/lib/usage/pricing";
import type { OperationalTier } from "@/lib/platform/history/types";

const DAY_MS = 86_400_000;

export interface AiUsageRow {
  provider: string;
  metric: string;
  unit: string;
  day: Date;
  count: number;
}
export interface AiUsageDay {
  day: string; // YYYY-MM-DD
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Estimated USD for the day, or null when no rate was in force that day. */
  estimatedSpendUsd: number | null;
}
export interface AiUsageTrend {
  since: string;
  days: AiUsageDay[];
  totals: { calls: number; promptTokens: number; completionTokens: number; estimatedSpendUsd: number | null };
  /** Distinct models seen (from the metric dimension). */
  models: string[];
  pricingConfigured: boolean;
  /** observed for counts; the spend is estimated (or unknown when unpriced). */
  tier: OperationalTier;
  /**
   * Token usage in the window that no rate covered, and the days it fell on.
   *
   * ⚠️ COVERAGE, NOT A CAVEAT. A spend figure over a window where half the days
   * predate the earliest configured rate is not wrong — it is PARTIAL, and
   * saying which part is the difference between an estimate and a claim.
   */
  unpricedTokens: number;
  unpricedDays: string[];
  checkedAt: string;
}

/** Pure: fold ApiUsageCounter rows into a per-day trend + honest estimated spend. */
export function buildAiUsageTrend(rows: readonly AiUsageRow[], now: Date, days: number): AiUsageTrend {
  const priced = isPricingConfigured();
  const byDay = new Map<string, AiUsageDay>();
  const models = new Set<string>();
  let anySpend = false;

  // ⚠️ PRICED PER DAY, AS A SET — never row by row. The input rate depends on a
  // second row (cached tokens are a SUBSET of prompt tokens), so a per-row
  // accumulation can only ignore caching or double count it. Rows are bucketed
  // first, then each day's whole set is handed to the one reducer.
  const rowsByDay = new Map<string, AiUsageRow[]>();

  for (const r of rows) {
    const key = r.day.toISOString().slice(0, 10);
    const d = byDay.get(key) ?? { day: key, calls: 0, promptTokens: 0, completionTokens: 0, estimatedSpendUsd: null };
    if (r.unit === "calls") d.calls += r.count;
    else if (r.unit === "prompt_tokens") d.promptTokens += r.count;
    else if (r.unit === "completion_tokens") d.completionTokens += r.count;
    if (r.provider === "OPENAI" && r.metric.startsWith("chat.completions:")) models.add(r.metric.slice("chat.completions:".length));
    byDay.set(key, d);
    rowsByDay.set(key, [...(rowsByDay.get(key) ?? []), r]);
  }

  let unpricedTokens = 0;
  const unpricedDays = new Set<string>();
  for (const [key, d] of byDay) {
    const p = priceAiUsage(rowsByDay.get(key) ?? []);
    d.estimatedSpendUsd = p.usd;
    if (p.usd != null) anySpend = true;
    unpricedTokens += p.unpricedTokens;
    for (const day of p.unpricedDays) unpricedDays.add(day);
  }

  const daysArr = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totals = daysArr.reduce(
    (t, d) => ({
      calls: t.calls + d.calls,
      promptTokens: t.promptTokens + d.promptTokens,
      completionTokens: t.completionTokens + d.completionTokens,
      estimatedSpendUsd: anySpend ? (t.estimatedSpendUsd ?? 0) + (d.estimatedSpendUsd ?? 0) : null,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, estimatedSpendUsd: anySpend ? 0 : null } as AiUsageTrend["totals"],
  );

  return {
    since: new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10),
    days: daysArr,
    totals,
    models: [...models].sort(),
    pricingConfigured: priced,
    tier: anySpend ? "estimated" : "observed",
    unpricedTokens,
    unpricedDays: [...unpricedDays].sort(),
    checkedAt: now.toISOString(),
  };
}

export interface AiUsageDeps {
  now?: Date;
  aiUsageRows?: (since: Date) => Promise<AiUsageRow[]>;
  days?: number;
}

export async function getAiUsageTrend(deps: AiUsageDeps = {}): Promise<AiUsageTrend> {
  const now = deps.now ?? new Date();
  const days = deps.days ?? 30;
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY_MS);
  const read = deps.aiUsageRows ?? ((s: Date) => db.apiUsageCounter.findMany({ where: { day: { gte: s } }, select: { provider: true, metric: true, unit: true, day: true, count: true } }).then((rows) => rows.map((r) => ({ ...r, count: Number(r.count) }))));
  const rows = await read(since);
  return buildAiUsageTrend(rows, now, days);
}
