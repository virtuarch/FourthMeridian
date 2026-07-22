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
import { estimateUnitSpendUsd, isPricingConfigured } from "@/lib/usage/pricing";
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
  /** Estimated USD for the day, or null when no pricing is configured. */
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
  checkedAt: string;
}

/** Pure: fold ApiUsageCounter rows into a per-day trend + honest estimated spend. */
export function buildAiUsageTrend(rows: readonly AiUsageRow[], now: Date, days: number): AiUsageTrend {
  const priced = isPricingConfigured();
  const byDay = new Map<string, AiUsageDay>();
  const models = new Set<string>();
  let anySpend = false;

  for (const r of rows) {
    const key = r.day.toISOString().slice(0, 10);
    const d = byDay.get(key) ?? { day: key, calls: 0, promptTokens: 0, completionTokens: 0, estimatedSpendUsd: priced ? 0 : null };
    if (r.unit === "calls") d.calls += r.count;
    else if (r.unit === "prompt_tokens") d.promptTokens += r.count;
    else if (r.unit === "completion_tokens") d.completionTokens += r.count;
    if (r.provider === "OPENAI" && r.metric.startsWith("chat.completions:")) models.add(r.metric.slice("chat.completions:".length));
    const spend = estimateUnitSpendUsd(r.provider, r.metric, r.unit, r.count);
    if (spend != null) { d.estimatedSpendUsd = (d.estimatedSpendUsd ?? 0) + spend; anySpend = true; }
    byDay.set(key, d);
  }

  const daysArr = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totals = daysArr.reduce(
    (t, d) => ({
      calls: t.calls + d.calls,
      promptTokens: t.promptTokens + d.promptTokens,
      completionTokens: t.completionTokens + d.completionTokens,
      estimatedSpendUsd: priced ? (t.estimatedSpendUsd ?? 0) + (d.estimatedSpendUsd ?? 0) : null,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, estimatedSpendUsd: priced ? 0 : null } as AiUsageTrend["totals"],
  );

  return {
    since: new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10),
    days: daysArr,
    totals,
    models: [...models].sort(),
    pricingConfigured: priced,
    tier: anySpend ? "estimated" : "observed",
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
