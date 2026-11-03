/**
 * components/platform/leads/merchant-model.ts  (Platform Spaces 2.0 — Merchant Operations, pure)
 *
 * Words and figures for the Merchant Operations dashboard from ONE read:
 * GET /api/platform/merchant-ops/overview?window=30|90. Merchant IDENTITY only —
 * no payment, settlement or processing vocabulary (Fourth Meridian processes no
 * payments). No React, no fetch, no clock.
 */

import type { MerchantOverviewResponse } from "@/lib/platform/merchant/overview-types";
import type { BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import type { DayBar, Fetched, Kpi } from "../ops-visual/ops-visual-model";
import type { HeroModel } from "../ops-visual/HealthHero";
import type { ShareBar } from "../charts/ShareBars";
import { formatCoveragePct } from "@/lib/platform/merchant/records-core";

export type MerchantWindow = "30" | "90";
export const REVIEW_HREF = "/merchant-ops";
export const MERGE_PALETTE = { succeeded: "color-mix(in srgb, var(--meridian-400) 75%, transparent)", other: "var(--text-faint)", failed: "var(--coral-400)" } as const;
export const GROWTH_PALETTE = { succeeded: "color-mix(in srgb, var(--meridian-400) 75%, transparent)", other: "var(--brass-300)", failed: "var(--coral-400)" } as const;

const n = (v: number) => v.toLocaleString("en-US");
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const reason = (f: Fetched<unknown>, what: string) => (f.loading ? `Reading ${what}…` : `${what} unavailable${f.error ? ` — ${f.error}` : ""}`);

export function coveragePct(m: MerchantOverviewResponse): number | null {
  return m.transactions.total > 0 ? (m.transactions.resolved / m.transactions.total) * 100 : null;
}

/**
 * PB-9 — the hero's linked share as text, FLOORED to two decimals (formatCoveragePct):
 * 7,986 of 8,014 reads "99.65%", never the "100%" Math.round printed.
 */
export function coverageLabel(m: MerchantOverviewResponse): string | null {
  return formatCoveragePct(m.transactions.resolved, m.transactions.total);
}

/** PB-9 — the "Without a merchant" split: identity expected (actionable) vs legitimate exclusions. */
export function unlinkedSplit(m: MerchantOverviewResponse): { actionable: number; excluded: number } {
  const c = m.transactions.coverage.unlinkedByClass;
  return { actionable: c.ELIGIBLE, excluded: c.TRANSFER + c.WALLET + c.NO_COUNTERPARTY };
}

export function merchantKpis(f: Fetched<MerchantOverviewResponse>): Kpi[] {
  const m = f.data;
  if (!m) {
    const sub = reason(f, "merchant figures");
    return [["merchants", "Merchants"], ["unresolved", "Without a merchant"], ["merged", "Merged"], ["dismissed", "Dismissed"]].map(([key, label]) => ({ key, label, value: "—", sub }));
  }
  return [
    { key: "merchants", label: "Merchants", value: n(m.merchants.total), sub: `${n(m.merchants.aliases.reduce((a, x) => a + x.count, 0))} aliases` },
    { key: "unresolved", label: "Without a merchant", value: n(m.transactions.coverage.unlinked), sub: `${n(unlinkedSplit(m).actionable)} identity expected · ${n(unlinkedSplit(m).excluded)} excluded` },
    { key: "merged", label: "Merged", value: n(m.decisions.merged), sub: `${m.windowDays} d · review decisions` },
    { key: "dismissed", label: "Dismissed", value: n(m.decisions.dismissed), sub: `${m.windowDays} d · kept apart` },
  ];
}

export function merchantHero(f: Fetched<MerchantOverviewResponse>): HeroModel {
  const m = f.data;
  const pct = m ? coverageLabel(m) : null;
  return {
    title: "Merchant identity",
    dot: false,
    provenance: "MEASURED",
    verdict: { word: !m ? "—" : pct === null ? "No transactions" : `${pct} linked`, tone: "muted" },
    checked: m ? hhmm(m.checkedAt) : null,
    caption: m
      ? `${n(m.transactions.resolved)} of ${n(m.transactions.total)} live transactions linked to a canonical merchant · all tenants · ${n(unlinkedSplit(m).actionable)} without one where identity is expected${m.transactions.coverage.eligible > 0 ? ` (${formatCoveragePct(m.transactions.coverage.eligibleLinked, m.transactions.coverage.eligible)} of eligible linked)` : ""}`
      : reason(f, "merchant figures"),
    kpis: merchantKpis(f),
    kpiLabels: { first: "Merchant identity figures", second: "Merge review figures", all: "Merchant figures" },
  };
}

/** Category provenance as shares of ALL transactions. */
export function sourceBars(m: MerchantOverviewResponse): ShareBar[] {
  return m.transactions.bySource.map((s) => ({ key: s.key, label: s.label, count: s.count, share: m.transactions.total ? s.count / m.transactions.total : null, muted: s.key === "none" }));
}

export function aliasItems(m: MerchantOverviewResponse): BreakdownItem[] {
  const colors: Record<string, string> = { PLAID: "color-mix(in srgb, var(--meridian-400) 75%, transparent)", IMPORT: "var(--brass-300)", USER: "var(--accent-positive)" };
  return m.merchants.aliases.map((a) => ({ id: a.source, label: a.label, value: a.count, color: colors[a.source] }));
}

export function decisionBars(m: MerchantOverviewResponse): DayBar[] {
  return m.decisions.days.map((d) => ({ day: d.day, succeeded: d.merged, other: d.dismissed, failed: 0, observed: true }));
}

export function growthBars(m: MerchantOverviewResponse): DayBar[] {
  return m.growth.days.map((d) => ({ day: d.day, succeeded: d.aliases, other: d.rules, failed: 0, observed: true }));
}
