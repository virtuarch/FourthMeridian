/**
 * components/platform/leads/growth-model.ts  (Platform Spaces 2.0 — Growth, pure)
 *
 * Every word and figure the Growth dashboard (GrowthLead.tsx) draws, derived
 * from two READ payloads and nothing else:
 *   acquisition        GET /api/platform/growth-revenue/acquisition?window=30|90
 *   product analytics  GET /api/platform/growth-revenue/product-analytics
 * No React, no fetch, no clock. This module AUTHORS NO RATE: conversions and
 * adoption shares are read from the payloads; cohort shares travel as num/den.
 */

import type { AcquisitionDay, AcquisitionResponse, CohortRow } from "@/lib/platform/growth/acquisition-types";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";
import type { BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import type { DayBar, Fetched, Kpi } from "../ops-visual/ops-visual-model";
import type { HeroModel } from "../ops-visual/HealthHero";
import type { FunnelBarStage } from "../charts/FunnelBars";
import { WEEKDAYS, pct, type HeatAxis, type HeatCell } from "../charts/heatmap-model";

export type GrowthWindow = "30" | "90";
export type GrowthDrawer = "signups" | "analytics" | "funnel" | "users" | "activity" | "policy";

/** The drawers, in nav order, each with the hosted (former) widgets it renders unchanged. */
export const GROWTH_DRAWERS: readonly { key: GrowthDrawer; label: string; keys: readonly string[] }[] = [
  { key: "funnel", label: "Funnel stages", keys: ["growth_funnel"] },
  { key: "analytics", label: "Product analytics", keys: ["growth_product_analytics"] },
  { key: "signups", label: "Signups & activation", keys: ["growth_signups"] },
  { key: "users", label: "Accounts", keys: ["growth_users"] },
  { key: "activity", label: "Activity", keys: ["growth_activity"] },
  { key: "policy", label: "Policy groups", keys: ["growth_policy_groups"] },
];

/** The beta signup list — hosted unchanged (its actions, gating and audit live there). */
export const BETA_LIST_KEY = "growth_beta_requests";

export const GROWTH_COLORS = {
  primary: "color-mix(in srgb, var(--meridian-400) 75%, transparent)",
  secondary: "var(--brass-300)",
  muted: "var(--text-faint)",
} as const;

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const shortDay = (day: string) =>
  new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const reason = (f: Fetched<unknown>, what: string) => (f.loading ? `Reading ${what}…` : `${what} unavailable${f.error ? ` — ${f.error}` : ""}`);

// ── Hero ─────────────────────────────────────────────────────────────────────

export function growthKpis(acq: Fetched<AcquisitionResponse>, pa: Fetched<ProductAnalyticsResponse>): Kpi[] {
  const a = acq.data, p = pa.data;
  const win = a ? `${a.windowDays} d` : "";
  return [
    { key: "requests", label: "Beta requests", value: a ? n(a.requests.total) : "—",
      sub: a ? `${win} · distinct requesters` : reason(acq, "requests") },
    { key: "registrations", label: "Registrations", value: a ? n(a.registrations.total) : "—",
      sub: a ? `${win} · new accounts` : reason(acq, "registrations") },
    { key: "waitlist", label: "Waiting", value: a ? n(a.waitlist.pending) : "—",
      sub: a ? `${n(a.waitlist.invited)} invited · ${n(a.waitlist.invitedExpired)} expired` : reason(acq, "waitlist"),
      tone: a && a.waitlist.pending > 0 ? "warn" : undefined },
    { key: "engaged", label: "Engaged · 30 d", value: p ? n(p.active.monthly.engaged) : "—",
      sub: p ? `of ${n(p.registrations.total - p.registrations.deactivated)} active accounts` : reason(pa, "activity") },
  ];
}

export function growthHero(acq: Fetched<AcquisitionResponse>, pa: Fetched<ProductAnalyticsResponse>): HeroModel {
  const p = pa.data, a = acq.data;
  const accounts = p ? p.registrations.total - p.registrations.deactivated : null;
  return {
    title: "Growth",
    dot: false,
    provenance: "MEASURED",
    verdict: { word: accounts === null ? "—" : plural(accounts, "account"), tone: "muted" },
    checked: a ? hhmm(a.checkedAt) : p ? hhmm(p.checkedAt) : null,
    caption: a && p
      ? `+${n(a.registrations.total)} registered · ${n(a.requests.total)} beta requests · last ${a.windowDays} UTC days`
      : reason(a ? pa : acq, "growth figures"),
    kpis: growthKpis(acq, pa),
    kpiLabels: { first: "Acquisition figures", second: "Waitlist and engagement figures", all: "Growth figures" },
  };
}

// ── Day series ───────────────────────────────────────────────────────────────

/** A per-day count series as DayBars (one stack; a null day is an unobserved gap). */
export function countBars(days: readonly AcquisitionDay[]): DayBar[] {
  return days.map((d) => ({ day: d.day, succeeded: d.count ?? 0, failed: 0, other: 0, observed: d.count !== null }));
}

export function activeBars(p: ProductAnalyticsResponse, series: "present" | "engaged"): DayBar[] {
  return p.active.perDay.map((d) => ({ day: d.day, succeeded: series === "engaged" ? d.engaged : d.present, failed: 0, other: 0, observed: true }));
}

export function seriesCaption(days: readonly AcquisitionDay[], noun: string): string {
  const observed = days.filter((d) => d.count !== null);
  const total = observed.reduce((a, d) => a + (d.count ?? 0), 0);
  const gaps = days.length - observed.length;
  return `${plural(total, noun)} · ${days.length} UTC days${gaps ? ` · ${gaps} without data` : ""}`;
}

// ── Proportions ──────────────────────────────────────────────────────────────

export function waitlistItems(a: AcquisitionResponse): BreakdownItem[] {
  const w = a.waitlist;
  return [
    { id: "pending", label: "Waiting", value: w.pending, color: "var(--accent-warning)" },
    { id: "invited", label: "Invited", value: w.invited, color: GROWTH_COLORS.primary },
    { id: "expired", label: "Invite expired", value: w.invitedExpired, color: "var(--coral-400)" },
    { id: "redeemed", label: "Joined", value: w.redeemed, color: "var(--accent-positive)" },
    { id: "declined", label: "Declined", value: w.declined, color: GROWTH_COLORS.muted },
  ].filter((i) => i.value > 0);
}

export function sourceItems(a: AcquisitionResponse): BreakdownItem[] {
  return a.sources.map((s, i) => ({ id: `src-${i}`, label: s.label, value: s.count }));
}

export function adoptionItems(p: ProductAnalyticsResponse): BreakdownItem[] {
  return [...p.features]
    .sort((x, y) => y.adopters - x.adopters)
    .map((f) => ({
      id: f.key, label: f.label, value: f.adopters,
      meta: f.adoption === undefined ? undefined : f.adoption === null ? "—" : `${Math.round(f.adoption * 100)}% of accounts`,
    }));
}

export function funnelStages(p: ProductAnalyticsResponse): FunnelBarStage[] {
  return p.funnel.map((s) => ({ key: s.key, label: s.label, count: s.count, rate: s.rate, dropped: s.abandoned }));
}

// ── Heatmap readouts ─────────────────────────────────────────────────────────

const valueOf = (c: HeatCell): number => (c.kind === "value" ? c.v : 0);

export function describeCalendarCell(day: string | null, cell: HeatCell, noun: string): string {
  const when = day ? new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  if (cell.kind === "noData") return `${when} · no data (before recording began)`;
  return `${when} · ${plural(valueOf(cell), noun)}`;
}

export function describeWeekHourCell(r: number, c: number, cell: HeatCell, noun: string, total: number): string {
  const h = String(c).padStart(2, "0");
  const v = valueOf(cell);
  return `${WEEKDAYS[r]} ${h}:00–${h}:59 UTC · ${plural(v, noun)}${total > 0 ? ` · ${pct(v, total)} of ${n(total)}` : ""}`;
}

export function describeCohortCell(row: CohortRow, colLabel: string, cell: HeatCell, what: string): string {
  const head = `Week of ${shortDay(row.weekStart)} · ${colLabel}`;
  switch (cell.kind) {
    case "noData": return `${head} · no data (engagement not yet recorded then)`;
    case "immature": return `${head} · in progress`;
    case "blank": return `${head} · no accounts`;
    case "zero": return `${head} · 0 of ${n(cell.den ?? row.size)} ${what} (0%)`;
    case "value": return `${head} · ${n(cell.num ?? 0)} of ${n(cell.den ?? row.size)} ${what} (${pct(cell.num ?? 0, cell.den ?? 0)})`;
  }
}

export const cohortCellText = (cell: HeatCell): string | null =>
  cell.kind === "value" && cell.num !== undefined && cell.den ? pct(cell.num, cell.den) : cell.kind === "zero" ? "0%" : null;

export const RETENTION_COLS: HeatAxis[] = Array.from({ length: 8 }, (_, k) => ({ key: `w${k}`, label: `W${k}`, shown: true }));

/** Enough cohort history to be worth a heatmap: ≥ 2 measured cells in cohorts that have members. */
export function cohortHasHistory(rows: readonly CohortRow[]): boolean {
  let measured = 0;
  for (const r of rows) if (r.size > 0) for (const c of r.cells) if (c.state === "value") measured++;
  return measured >= 2;
}

/** Few events make a time-of-week pattern meaningless; below this the card says so. */
export const TIME_OF_WEEK_MIN_EVENTS = 10;
