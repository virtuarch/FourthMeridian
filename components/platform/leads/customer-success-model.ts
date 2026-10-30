/**
 * components/platform/leads/customer-success-model.ts  (Platform Spaces 2.0 — Customer Success, pure)
 *
 * Words and figures for the Customer Success dashboard from ONE read:
 * GET /api/platform/customer-success/overview?window=30|90. No React, no fetch,
 * no clock. Simple by design (owner directive): who needs help and why, where
 * customers are in onboarding, connection health, the sync-issue trend.
 */

import type { CsOverviewResponse } from "@/lib/platform/customer/overview-types";
import type { BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import type { DayBar, Fetched, Kpi } from "../ops-visual/ops-visual-model";
import type { HeroModel } from "../ops-visual/HealthHero";
import type { ShareBar } from "../charts/ShareBars";

export type CsWindow = "30" | "90";

/** The audited customer list — hosted in the page, unchanged (its actions, reasons and gating live there). */
export const CUSTOMER_LIST_KEY = "cs_customers";
export const INCIDENTS_WORKSPACE = "platform-incidents";

const n = (v: number) => v.toLocaleString("en-US");
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const reason = (f: Fetched<unknown>, what: string) => (f.loading ? `Reading ${what}…` : `${what} unavailable${f.error ? ` — ${f.error}` : ""}`);

/** Customers who got THROUGH first connection (the strict funnel's 4th stage or beyond). */
export function connectedCount(o: CsOverviewResponse): number {
  const i = o.stages.findIndex((s) => s.key === "firstConnection");
  return i < 0 ? 0 : o.stages.slice(i).reduce((a, s) => a + s.count, 0);
}

export function csKpis(f: Fetched<CsOverviewResponse>): Kpi[] {
  const o = f.data;
  if (!o) {
    const sub = reason(f, "customer figures");
    return [["customers", "Customers"], ["help", "Need help"], ["connected", "Connected"], ["issues", "Open sync issues"]].map(([key, label]) => ({ key, label, value: "—", sub }));
  }
  const connected = connectedCount(o);
  return [
    { key: "customers", label: "Customers", value: n(o.customers.active), sub: `${n(o.customers.deactivated)} deactivated` },
    { key: "help", label: "Need help", value: n(o.attention.customers), sub: o.customers.active ? `of ${n(o.customers.active)} customers` : "no customers",
      tone: o.attention.customers > 0 ? "warn" : undefined },
    { key: "connected", label: "Connected", value: o.customers.active ? `${Math.round((connected / o.customers.active) * 100)}%` : "—",
      sub: `${n(connected)} of ${n(o.customers.active)} reached a first connection` },
    { key: "issues", label: "Open sync issues", value: n(o.incidents.open), sub: "unresolved episodes now", tone: o.incidents.open > 0 ? "warn" : undefined },
  ];
}

export function csHero(f: Fetched<CsOverviewResponse>): HeroModel {
  const o = f.data;
  return {
    title: "Customer Success",
    dot: false,
    provenance: "MEASURED",
    verdict: { word: !o ? "—" : o.attention.customers === 0 ? "No one needs help" : `${n(o.attention.customers)} need${o.attention.customers === 1 ? "s" : ""} help`, tone: "muted" },
    checked: o ? hhmm(o.checkedAt) : null,
    caption: o ? `of ${n(o.customers.active)} active customers · reasons below, the list beneath` : reason(f, "customer figures"),
    kpis: csKpis(f),
    kpiLabels: { first: "Customers and help", second: "Connection and issues", all: "Customer Success figures" },
  };
}

/** Help reasons as shares of ACTIVE customers (a customer can have several). */
export function attentionBars(o: CsOverviewResponse): ShareBar[] {
  return o.attention.reasons.map((r) => ({ key: r.key, label: r.label, count: r.count, share: o.customers.active ? r.count / o.customers.active : null }));
}

/** Where active customers are now: the furthest stage reached through, as shares of active customers. */
export function stageBars(o: CsOverviewResponse): ShareBar[] {
  return o.stages.map((s) => ({ key: s.key, label: s.label, count: s.count, share: o.customers.active ? s.count / o.customers.active : null }));
}

const HEALTH: readonly { key: keyof CsOverviewResponse["connections"]["counts"]; label: string; color: string }[] = [
  { key: "HEALTHY", label: "Healthy", color: "var(--accent-positive)" },
  { key: "STALE", label: "Stale", color: "var(--accent-warning)" },
  { key: "DEGRADED", label: "Degraded", color: "var(--brass-300)" },
  { key: "NEEDS_REAUTH", label: "Needs reconnecting", color: "var(--coral-400)" },
  { key: "ERROR", label: "Error", color: "var(--accent-negative)" },
];

export function healthItems(o: CsOverviewResponse): BreakdownItem[] {
  return HEALTH.map((h) => ({ id: h.key, label: h.label, value: o.connections.counts[h.key] ?? 0, color: h.color })).filter((i) => i.value > 0);
}

/** Resolved (succeeded) and opened (failed) episodes per day — two event kinds, stacked as that day's lifecycle events. */
export function incidentBars(o: CsOverviewResponse): DayBar[] {
  return o.incidents.days.map((d) => ({ day: d.day, succeeded: d.resolved, other: 0, failed: d.opened, observed: true }));
}

export const INCIDENT_PALETTE = { succeeded: "var(--accent-positive)", other: "var(--accent-warning)", failed: "var(--coral-400)" } as const;
