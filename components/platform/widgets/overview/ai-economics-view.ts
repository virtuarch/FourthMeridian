/**
 * components/platform/widgets/overview/ai-economics-view.ts  (UX-P1 · Agent 5)
 *
 * THE PURE WORDING AND BUCKETING behind the AI activity block, the Economics
 * block and the AI usage trend widget. Three authorities feed them and each
 * keeps its own vocabulary here, never merged:
 *
 *   /platform-ops/ai-usage-trend   ApiUsageCounter per UTC day (calls, tokens,
 *                                  ESTIMATED spend when a rate was in force);
 *   /platform-ops/ai-invocations   the AiInvocation ledger (RETURNED count and
 *                                  the failure outcomes FAILED / TIMEOUT /
 *                                  RATE_LIMITED / QUOTA for the window);
 *   /platform-ops/plaid-usage      Item-months per billing cycle under both
 *                                  invoice readings, ESTIMATED USD.
 *
 * GAPS ARE GAPS. A UTC day with no counter row is `null` on the bars (no
 * observation), never 0 — the counter writes nothing on a day with no calls,
 * so absence and zero are indistinguishable and the honest rendering is a gap.
 * EVERY DOLLAR IS AN ESTIMATE and says so beside the figure; there is no
 * actual-charge ledger anywhere in the platform.
 *
 * No React, no clock (`nowMs` is a parameter): deterministic under test.
 */

import type { MiniBarPoint, DistributionSegment, StatusTone } from "../../platform-surface";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { AiFailureCounts } from "@/lib/platform/ai/invocations";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { AiSpendOverview } from "@/lib/platform/ai/spend-by-surface";
import type { SpendFigure } from "@/lib/platform/ai/spend-by-surface-core";

const DAY_MS = 86_400_000;

export const ESTIMATE_CAPTION = "estimate, not a bill";
export const AGGREGATE_NOTE = "Aggregate only — no per-user attribution on this surface.";
export const NO_LEDGER_NOTE = "No actual-charge ledger exists; all figures are estimates with provenance.";
export const AI_WINDOW_DAYS = 30;
/** AI COST CONTROLS — the Overview adds no fetch for the budget; this doorway sentence points at the reading. */
export const BUDGET_DOORWAY_NOTE = "Budget utilization — the rolling-24 h fleet estimate against its alert threshold, per-customer allowance use and the pause state — is read in AI and costs → AI Budget.";

export function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** The last `days` UTC day keys ending on the UTC day of `nowMs`, oldest first. */
export function utcDayKeys(nowMs: number, days: number = AI_WINDOW_DAYS): string[] {
  const d = new Date(nowMs);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

/** Calls per UTC day; a day without a counter row is a GAP (null), never 0. */
export function callsPerDay(trend: Pick<AiUsageTrend, "days">, nowMs: number, days: number = AI_WINDOW_DAYS): MiniBarPoint[] {
  const byDay = new Map(trend.days.map((d) => [d.day, d] as const));
  return utcDayKeys(nowMs, days).map((key) => {
    const d = byDay.get(key);
    return d ? { key, value: d.calls, title: `${key}: ${fmtCount(d.calls)} calls · ${fmtTokens(d.promptTokens + d.completionTokens)} tokens` } : { key, value: null };
  });
}

/**
 * Estimated spend per UTC day. Null (a gap) when the day has no counter row OR
 * no rate was in force that day — an unpriced day is unknown, not free.
 */
export function spendPerDay(trend: Pick<AiUsageTrend, "days" | "pricingConfigured">, nowMs: number, days: number = AI_WINDOW_DAYS): MiniBarPoint[] {
  const byDay = new Map(trend.days.map((d) => [d.day, d] as const));
  return utcDayKeys(nowMs, days).map((key) => {
    const d = byDay.get(key);
    if (!d || !trend.pricingConfigured || d.estimatedSpendUsd == null) {
      return { key, value: null, title: d ? `${key}: unpriced (no rate in force)` : `${key}: no observation` };
    }
    return { key, value: d.estimatedSpendUsd, title: `${key}: ${fmtUsd(d.estimatedSpendUsd)} estimated` };
  });
}

/** "1,234 calls · 2.3M tokens · 12 of 30 UTC days observed · since 2026-09-15". */
export function aiTotalsText(trend: Pick<AiUsageTrend, "totals" | "days" | "since" | "models">, days: number = AI_WINDOW_DAYS): string {
  const t = trend.totals;
  return `${fmtCount(t.calls)} calls · ${fmtTokens(t.promptTokens + t.completionTokens)} tokens · ${trend.days.length} of ${days} UTC days observed · since ${trend.since} · ${trend.models.length} model${trend.models.length === 1 ? "" : "s"}`;
}

/** The 30-day spend reading: a figure with its coverage, or the reason there is none. */
export function aiSpendReading(trend: Pick<AiUsageTrend, "totals" | "pricingConfigured" | "unpricedTokens" | "unpricedDays">):
  | { kind: "figure"; value: string; qualifier: string }
  | { kind: "unavailable"; reason: string } {
  if (!trend.pricingConfigured) return { kind: "unavailable", reason: "no AI pricing configured — usage is shown, spend is not" };
  if (trend.totals.estimatedSpendUsd == null) return { kind: "unavailable", reason: "nothing in the window could be priced" };
  const coverage = trend.unpricedTokens > 0
    ? `${trend.unpricedDays.length} day${trend.unpricedDays.length === 1 ? "" : "s"} unpriced (no rate in force) — covers the rest`
    : "every observed day priced";
  return { kind: "figure", value: fmtUsd(trend.totals.estimatedSpendUsd), qualifier: `${ESTIMATE_CAPTION} · rate card · ${coverage}` };
}

/** The invocation ledger's outcome vocabulary, as DistributionBar segments. RETURNED is the billed count. */
export function aiOutcomeSegments(returned: number, failures: AiFailureCounts): DistributionSegment[] {
  const tone = (t: StatusTone) => t;
  return [
    { word: "returned", count: returned, tone: tone("ok") },
    { word: "failed", count: failures.failed, tone: tone("bad") },
    { word: "timeout", count: failures.timeouts, tone: tone("bad") },
    { word: "rate limited", count: failures.rateLimited, tone: tone("warn") },
    { word: "quota", count: failures.quota, tone: tone("bad") },
  ];
}

// ── Spend by surface (BETA C6) ───────────────────────────────────────────────

export const CUSTOMER_SPEND_NOTE = "Customer spend = Conversations + Daily Brief from the invocation ledger; the evaluation harness and any other or unattributed surface are overhead, shown beside it, never inside it.";

type SpendShape = Pick<AiSpendOverview, "customer" | "overhead" | "unpriced" | "pricingConfigured">;

const figureUsd = (f: SpendFigure): string => (f.usd === null ? "—" : fmtUsd(f.usd));

/** "3 unpriced invocations not counted (OPENAI:gpt-7)" or "every invocation priced". Never folds unpriced at $0. */
export function unpricedText(spend: Pick<AiSpendOverview, "unpriced">): string {
  const u = spend.unpriced;
  if (u.invocations === 0) return "every invocation priced";
  return `${fmtCount(u.invocations)} unpriced invocation${u.invocations === 1 ? "" : "s"} not counted (${u.models.join(", ") || "no model named"}) — see rate card`;
}

/** The overhead line: what the platform, not a customer, caused. */
export function overheadText(spend: Pick<AiSpendOverview, "overhead">): string {
  const o = spend.overhead;
  const parts = [`harness ${figureUsd(o.harness)}`];
  if (o.other.invocations > 0) parts.push(`other/unattributed ${figureUsd(o.other)}`);
  return `overhead ${figureUsd(o.total)} (${parts.join(" · ")}; ${fmtCount(o.total.invocations)} invocation${o.total.invocations === 1 ? "" : "s"}) — not customer spend`;
}

/** The counter-based figure, named as the cross-check it is. */
export function counterCrossCheckText(trend: Pick<AiUsageTrend, "totals" | "pricingConfigured">): string {
  if (!trend.pricingConfigured || trend.totals.estimatedSpendUsd == null) return "counter cross-check (all surfaces): unavailable";
  return `counter cross-check (all surfaces): ${fmtUsd(trend.totals.estimatedSpendUsd)}`;
}

/** The headline: estimated CUSTOMER spend with chat/brief split, coverage and the estimate caption. */
export function customerSpendReading(spend: SpendShape):
  | { kind: "figure"; value: string; qualifier: string }
  | { kind: "unavailable"; reason: string; qualifier: string } {
  const coverage = unpricedText(spend);
  if (!spend.pricingConfigured) return { kind: "unavailable", reason: "no AI pricing configured — usage is shown, spend is not", qualifier: coverage };
  const c = spend.customer;
  if (c.total.usd === null) {
    const reason = c.total.invocations === 0 ? "no customer invocations in the window" : "no customer invocation in the window could be priced";
    return { kind: "unavailable", reason, qualifier: `${ESTIMATE_CAPTION} · ${coverage}` };
  }
  return {
    kind: "figure",
    value: fmtUsd(c.total.usd),
    qualifier: `chat ${figureUsd(c.chat)} · brief ${figureUsd(c.brief)} · ${fmtCount(c.total.invocations)} invocation${c.total.invocations === 1 ? "" : "s"} · ${ESTIMATE_CAPTION} · ${coverage}`,
  };
}

/** Estimated CUSTOMER spend per UTC day; a day with no priced customer invocation is a gap, never $0. */
export function customerSpendPerDay(spend: Pick<AiSpendOverview, "byDay" | "pricingConfigured">, nowMs: number, days: number = AI_WINDOW_DAYS): MiniBarPoint[] {
  const byDay = new Map(spend.byDay.map((d) => [d.day, d] as const));
  return utcDayKeys(nowMs, days).map((key) => {
    const d = byDay.get(key);
    if (!d || !spend.pricingConfigured || d.customerUsd == null) {
      return { key, value: null, title: d ? `${key}: no priced customer invocation${d.unpricedInvocations ? ` (${d.unpricedInvocations} unpriced)` : ""}` : `${key}: no observation` };
    }
    return { key, value: d.customerUsd, title: `${key}: ${fmtUsd(d.customerUsd)} customer estimate${d.unpricedInvocations ? ` · ${d.unpricedInvocations} unpriced not counted` : ""}` };
  });
}

// ── Economics ────────────────────────────────────────────────────────────────

/** The Plaid current-cycle reading: Item-months, the two invoice readings, and an ESTIMATED dollar — or the reason there is none. */
export function plaidCycleReading(usage: Pick<PlaidUsage, "cycles" | "priceAuthority">):
  | { kind: "figure"; value: string; qualifier: string }
  | { kind: "unavailable"; reason: string; qualifier: string } {
  const current = usage.cycles.find((c) => c.label === "current") ?? usage.cycles[0];
  if (!current) return { kind: "unavailable", reason: "no billing cycle in the census", qualifier: "" };
  const d = current.during;
  const a = current.atEnd;
  const itemMonths = d.itemMonths.transactions + d.itemMonths.investments;
  const readings = current.agree
    ? "invoice readings agree"
    : `invoice readings disagree (${a.itemMonths.transactions + a.itemMonths.investments} Item-months at cycle end)`;
  const qualifier = `${itemMonths} Item-month${itemMonths === 1 ? "" : "s"} this cycle (${current.cycle.start.slice(0, 7)}) · ${readings} · ${ESTIMATE_CAPTION}`;
  if (!usage.priceAuthority.configured) return { kind: "unavailable", reason: "no Plaid price authority configured — usage is shown, cost is not", qualifier };
  if (d.usd == null) return { kind: "unavailable", reason: d.unpricedItemMonths > 0 ? "cycle predates the rate's evidence" : "nothing billable this cycle", qualifier };
  return { kind: "figure", value: current.agree ? fmtUsd(d.usd) : `${fmtUsd(d.usd)} – ${fmtUsd(a.usd ?? d.usd)}`, qualifier };
}
