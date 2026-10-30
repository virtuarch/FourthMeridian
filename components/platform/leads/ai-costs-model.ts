/**
 * components/platform/leads/ai-costs-model.ts  (Platform Ops visual spec §5 — AI & Costs)
 *
 * PURE view-model behind the AI & Costs dashboard. No React, no fetch, no clock
 * (callers inject `nowMs`). Every figure is read from an existing PLATFORM_OPS
 * READ route and carries its KIND — never a bill:
 *
 *   ai-usage-trend    ApiUsageCounter per UTC day: tokens (MEASURED) and the
 *                     spend estimate (tokens × code-owned rate card, ESTIMATED)
 *                     → hero, daily spend trend, tokens per day, OpenAI cycle spend
 *   ai-spend          AiInvocation ledger priced BY SURFACE (ESTIMATED) → donut
 *   ai-invocations    AiInvocation ledger, rolling 7 d / 30 d: invocations and
 *                     failures (MEASURED), priced totals (ESTIMATED) → KPIs, bars
 *   ai-budget         rolling-24 h fleet spend vs the alert threshold, top
 *                     customers vs THEIR allowance (ESTIMATED vs ASSUMED config)
 *   plaid-usage       Item-months × invoice-derived rate (ESTIMATED) → provider bars
 *
 * HONESTY RULES (pinned by platform-visual-providers-ai.test.ts):
 *   · billed cost is UNKNOWN — no invoice is read; a token count is never a bill;
 *   · an unpriced figure is UNKNOWN with its reason, never $0;
 *   · a day with no counter row is a GAP (the ai-usage-trend contract: "a day
 *     without a counter row is a gap, not zero"); an unpriced day is a gap in
 *     the spend line; windows are calendar-exact UTC days ending today.
 */

import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import type { AiBudgetUtilization, CustomerBudgetView } from "@/lib/platform/ai/cost-controls.types";
import type { AiSpendResponse } from "@/app/api/platform/platform-ops/ai-spend/route";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { TrendPoint } from "@/components/space/widgets/charts/TrendChart";
import type { StatusTone } from "../platform-surface";
import type { DayBar, Fetched, Kpi } from "../ops-visual/ops-visual-model";

const DAY_MS = 86_400_000;
const n = (v: number) => v.toLocaleString("en-US");

/** "$12.40" — cents, the Space money contract for a figure. Sub-cent amounts keep 4 places. */
export function usd(v: number): string {
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Billed cost is never known here: no provider invoice is read. */
export const BILLED_UNKNOWN = "Unknown — no invoice data";

/** A money figure and its kind. UNKNOWN always carries a reason; never a number. */
export type Money =
  | { kind: "ESTIMATED"; usd: number; partial: boolean; basis: string }
  | { kind: "UNKNOWN"; reason: string };

/** The ascending calendar-exact UTC day keys of the `days` days ending on `nowMs`'s day. */
export function calendarDays(nowMs: number, days: number): string[] {
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** The current billing cycle: the calendar month (Plaid's invoice shape, item-months.ts monthCycle). */
export function currentCycle(nowMs: number): { start: string; end: string } {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), end: new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10) };
}

const reasonOf = (f: Fetched<unknown>, what: string) => (f.loading ? `reading ${what}…` : `${what} unavailable${f.error ? ` — ${f.error}` : ""}`);

// ── Spend ─────────────────────────────────────────────────────────────────────

/** The hero: estimated AI spend over the trend's 30 UTC days. */
export function aiSpend30d(trend: Fetched<AiUsageTrend>): Money {
  const t = trend.data;
  if (!t) return { kind: "UNKNOWN", reason: reasonOf(trend, "AI usage") };
  if (!t.pricingConfigured) return { kind: "UNKNOWN", reason: "no AI rate card configured" };
  if (t.totals.estimatedSpendUsd === null) return { kind: "UNKNOWN", reason: "no priced usage in the window" };
  return { kind: "ESTIMATED", usd: t.totals.estimatedSpendUsd, partial: t.unpricedTokens > 0, basis: "tokens × rate card" };
}

/**
 * The daily spend line over the last `days` calendar UTC days: one point per
 * PRICED day only. A day without a counter row, or with tokens no rate covered,
 * is left out — TrendChart draws the hole as a hatched "no data" band and never
 * interpolates across it. A day whose rows carry no AI tokens is a real $0.
 */
export function spendSeries(trend: AiUsageTrend | null, nowMs: number, days: number): { points: TrendPoint[]; gaps: number; usd: number | null } {
  if (!trend || !trend.pricingConfigured) return { points: [], gaps: days, usd: null };
  const by = new Map(trend.days.map((d) => [d.day, d] as const));
  const points: TrendPoint[] = [];
  let gaps = 0;
  for (const day of calendarDays(nowMs, days)) {
    const d = by.get(day);
    if (!d || day < trend.since) { gaps++; continue; }
    if (d.estimatedSpendUsd !== null) points.push({ date: day, value: d.estimatedSpendUsd, estimated: false });
    else if (d.promptTokens + d.completionTokens === 0) points.push({ date: day, value: 0, estimated: false });
    else gaps++;
  }
  return { points, gaps, usd: points.length > 0 ? points.reduce((a, p) => a + p.value, 0) : null };
}

/** Prompt (bottom) and completion (top) tokens per calendar UTC day; a missing counter day is a gap. */
export function tokenDays(trend: AiUsageTrend | null, nowMs: number, days: number): DayBar[] {
  const by = new Map((trend?.days ?? []).map((d) => [d.day, d] as const));
  return calendarDays(nowMs, days).map((day) => {
    const d = trend ? by.get(day) : undefined;
    if (!d || !trend || day < trend.since) return { day, succeeded: 0, failed: 0, other: 0, observed: false };
    return { day, succeeded: d.promptTokens, other: d.completionTokens, failed: 0, observed: true };
  });
}

/**
 * Returned invocations per calendar UTC day from the invocation ledger's day
 * buckets. A day with no bucket is a gap (no ledger row ⇒ nothing to vouch for).
 * The rolling 30 d read starts mid-day 30 days back, so its first partial day
 * falls outside the 30 calendar days drawn here.
 */
export function invocationDays(inv: AiOperations | null, nowMs: number, days: number): DayBar[] {
  const by = new Map((inv?.byDay ?? []).map((b) => [b.key, b] as const));
  return calendarDays(nowMs, days).map((day) => {
    const b = by.get(day);
    if (!b) return { day, succeeded: 0, failed: 0, other: 0, observed: false };
    return { day, succeeded: b.invocations, failed: 0, other: 0, observed: true };
  });
}

// ── Composition ───────────────────────────────────────────────────────────────

export interface SliceItem { id: string; label: string; value: number; color: string }

export const SURFACE_COLORS = {
  chat: "var(--meridian-400)",
  brief: "var(--emerald-400)",
  harness: "var(--brass-300)",
  other: "var(--text-faint)",
} as const;

/** Estimated spend by surface (30 d, invocation ledger). Σ items = the priced total; unpriced counted aside. */
export function spendBySurface(s: AiSpendResponse | null): { items: SliceItem[]; total: number; unpricedInvocations: number; windowDays: number | null } {
  if (!s) return { items: [], total: 0, unpricedInvocations: 0, windowDays: null };
  const sp = s.spend;
  const all: SliceItem[] = [
    { id: "chat", label: "Conversations", value: sp.customer.chat.usd ?? 0, color: SURFACE_COLORS.chat },
    { id: "brief", label: "Daily Brief", value: sp.customer.brief.usd ?? 0, color: SURFACE_COLORS.brief },
    { id: "harness", label: "Evaluation harness", value: sp.overhead.harness.usd ?? 0, color: SURFACE_COLORS.harness },
    { id: "other", label: "Unattributed", value: sp.overhead.other.usd ?? 0, color: SURFACE_COLORS.other },
  ];
  const items = all.filter((i) => i.value > 0);
  return { items, total: items.reduce((a, i) => a + i.value, 0), unpricedInvocations: sp.unpriced.invocations, windowDays: sp.window.days };
}

// ── Cycle spend by provider ───────────────────────────────────────────────────

/** Plaid's estimated cost this cycle (Item-months × invoice-derived rate). */
export function plaidCycleSpend(plaid: Fetched<PlaidUsage>): Money {
  const p = plaid.data;
  if (!p) return { kind: "UNKNOWN", reason: reasonOf(plaid, "Plaid usage") };
  if (!p.priceAuthority.configured) return { kind: "UNKNOWN", reason: "no rate card configured" };
  const current = p.cycles.find((c) => c.label === "current");
  if (!current) return { kind: "UNKNOWN", reason: "no current billing cycle reported" };
  if (current.during.usd === null) return { kind: "UNKNOWN", reason: current.during.unpricedItemMonths ? "before the rate's evidence" : "nothing billable this cycle" };
  return { kind: "ESTIMATED", usd: current.during.usd, partial: current.during.unpricedItemMonths > 0, basis: "Item-months × invoice-derived rate" };
}

/**
 * OpenAI's estimated cost this cycle: the trend's priced days from the first of
 * the month. UNKNOWN when the 30-day trend does not reach back to the cycle
 * start (it would silently drop the month's first day) or nothing was priced.
 */
export function openAiCycleSpend(trend: Fetched<AiUsageTrend>, nowMs: number): Money {
  const t = trend.data;
  if (!t) return { kind: "UNKNOWN", reason: reasonOf(trend, "AI usage") };
  if (!t.pricingConfigured) return { kind: "UNKNOWN", reason: "no AI rate card configured" };
  const { start } = currentCycle(nowMs);
  if (t.since > start) return { kind: "UNKNOWN", reason: "usage window starts after the cycle" };
  const inCycle = t.days.filter((d) => d.day >= start);
  const priced = inCycle.filter((d) => d.estimatedSpendUsd !== null);
  if (priced.length === 0) return { kind: "UNKNOWN", reason: "no priced AI usage this cycle" };
  const unpriced = inCycle.some((d) => d.estimatedSpendUsd === null && d.promptTokens + d.completionTokens > 0);
  return { kind: "ESTIMATED", usd: priced.reduce((a, d) => a + (d.estimatedSpendUsd ?? 0), 0), partial: unpriced, basis: "tokens × rate card" };
}

/** Σ of the ESTIMATED parts; partial when any part is unknown or partial; UNKNOWN when none is estimated. */
export function sumMoney(parts: readonly Money[]): Money {
  const est = parts.filter((p): p is Extract<Money, { kind: "ESTIMATED" }> => p.kind === "ESTIMATED");
  if (est.length === 0) return { kind: "UNKNOWN", reason: "no provider has a priced estimate" };
  return {
    kind: "ESTIMATED",
    usd: est.reduce((a, p) => a + p.usd, 0),
    partial: est.length < parts.length || est.some((p) => p.partial),
    basis: est.map((p) => p.basis).join(" + "),
  };
}

export interface ProviderCost { id: string; label: string; money: Money }

/** Cost by provider this cycle: OpenAI and Plaid are estimated where a rate card answered; every other metered provider is UNKNOWN. */
export function costByProvider(args: { trend: Fetched<AiUsageTrend>; plaid: Fetched<PlaidUsage>; apiUsage: ApiUsageResponse | null; nowMs: number }): ProviderCost[] {
  const out: ProviderCost[] = [
    { id: "OPENAI", label: "OpenAI · tokens", money: openAiCycleSpend(args.trend, args.nowMs) },
    { id: "PLAID", label: "Plaid · Item-months", money: plaidCycleSpend(args.plaid) },
  ];
  for (const p of args.apiUsage?.providers ?? []) {
    if (p.provider === "OPENAI" || p.provider === "PLAID") continue;
    out.push({ id: p.provider, label: p.provider.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), money: { kind: "UNKNOWN", reason: "no rate card for this provider" } });
  }
  return out;
}

// ── Budget ────────────────────────────────────────────────────────────────────

export interface BudgetMeter {
  /** Rolling-window spend vs the fleet alert threshold; null pct = unpriced. */
  pct: number | null;
  spend: Money;
  thresholdUsd: number;
  windowHours: number;
  alertEnabled: boolean;
  tone: StatusTone;
}

export function budgetMeter(b: AiBudgetUtilization | null): BudgetMeter | null {
  if (!b) return null;
  const f = b.fleet;
  const pct = f.utilizationPct;
  return {
    pct,
    spend: f.estimatedUsd === null ? { kind: "UNKNOWN", reason: "no priced customer spend in the window" } : { kind: "ESTIMATED", usd: f.estimatedUsd, partial: b.unpriced.invocations > 0, basis: "tokens × rate card" },
    thresholdUsd: f.thresholdUsd,
    windowHours: b.windowHours,
    alertEnabled: f.alertEnabled,
    tone: pct === null ? "muted" : pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok",
  };
}

/** The top customers by today's spend against their own allowance (opaque refs only). */
export function topCustomers(b: AiBudgetUtilization | null, rows = 3): CustomerBudgetView[] {
  return (b?.customers ?? []).slice().sort((a, c) => c.todayUsd - a.todayUsd).slice(0, rows);
}

// ── Hero KPIs ─────────────────────────────────────────────────────────────────

const pct1 = (v: number) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;

export function aiKpis(args: { budget: Fetched<AiBudgetUtilization>; inv7: Fetched<AiOperations> }): Kpi[] {
  const out: Kpi[] = [];
  const m = budgetMeter(args.budget.data);
  out.push(m
    ? m.pct === null
      ? { key: "budget", label: "Budget used", value: "—", sub: "spend unpriced", tone: "muted" }
      : { key: "budget", label: "Budget used", value: `${Math.round(m.pct)}%`, sub: `of ${usd(m.thresholdUsd)} · ${m.windowHours} h · est.`, tone: m.tone === "ok" ? undefined : m.tone }
    : { key: "budget", label: "Budget used", value: "—", sub: args.budget.loading ? "reading…" : "unavailable", tone: "muted" });

  const i = args.inv7.data;
  if (!i) {
    const sub = args.inv7.loading ? "reading…" : "unavailable";
    out.push({ key: "calls", label: "Calls · 7 d", value: "—", sub, tone: "muted" });
    out.push({ key: "errors", label: "Error rate · 7 d", value: "—", sub, tone: "muted" });
    out.push({ key: "per-call", label: "Est. cost / call", value: "—", sub, tone: "muted" });
    return out;
  }
  const calls = i.totals.invocations + i.failures.total;
  out.push({ key: "calls", label: "Calls · 7 d", value: n(calls), sub: `${n(i.totals.invocations)} returned · measured` });
  out.push(calls === 0
    ? { key: "errors", label: "Error rate · 7 d", value: "—", sub: "no calls recorded", tone: "muted" }
    : { key: "errors", label: "Error rate · 7 d", value: pct1((i.failures.total / calls) * 100), sub: `${n(i.failures.total)} failed · measured`, tone: i.failures.total > 0 ? "warn" : undefined });
  const per = costPerCall(i);
  out.push(per.kind === "ESTIMATED"
    ? { key: "per-call", label: "Est. cost / call", value: usd(per.usd), sub: per.partial ? "estimated · partial" : "estimated · 7 d" }
    : { key: "per-call", label: "Est. cost / call", value: "Unknown", sub: per.reason, tone: "muted" });
  return out;
}

/** Estimated USD per RETURNED invocation (7 d). Partial when some tokens had no rate. */
export function costPerCall(i: AiOperations): Money {
  if (!i.pricingConfigured) return { kind: "UNKNOWN", reason: "no rate card" };
  if (i.totals.invocations === 0) return { kind: "UNKNOWN", reason: "no calls recorded" };
  if (i.totals.usd === null) return { kind: "UNKNOWN", reason: "nothing priced" };
  return { kind: "ESTIMATED", usd: i.totals.usd / i.totals.invocations, partial: i.totals.unpricedTokens > 0, basis: "tokens × rate card ÷ returned calls" };
}

/** "Unknown" or "$12.40" — the words for a Money cell. Never "$0" for unknown. */
export function moneyText(m: Money): string {
  return m.kind === "ESTIMATED" ? usd(m.usd) : "Unknown";
}
