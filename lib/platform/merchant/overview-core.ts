/**
 * lib/platform/merchant/overview-core.ts  (Platform Spaces 2.0 — Merchant Operations, pure)
 */

import type { MerchantOverviewResponse } from "./overview-types";

const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function windowDayKeys(now: Date, n: number): string[] {
  const today = Date.parse(`${dayKey(now)}T00:00:00.000Z`);
  return Array.from({ length: n }, (_, i) => dayKey(new Date(today - (n - 1 - i) * DAY_MS)));
}

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  PLAID_PFC: "Provider category",
  PFC_SPEND_BUCKET: "Provider category → spend bucket",
  GLOBAL_CATALOG: "Fourth Meridian merchant catalogue",
  USER_RULE: "Customer's merchant rule",
  USER_OVERRIDE: "Customer's own correction",
  LEGACY: "Legacy derivation (backfilled)",
  none: "Not recorded (pre-provenance)",
};
export const ALIAS_LABELS: Readonly<Record<string, string>> = { PLAID: "Provider", IMPORT: "Import", USER: "Customer" };

export interface MerchantOverviewFacts {
  totalTransactions: number;
  resolvedTransactions: number;
  bySource: readonly { key: string | null; count: number }[];
  merchants: number;
  aliasesBySource: readonly { source: string; count: number }[];
  userRules: number;
  decisions: readonly { day: string; verdict: string; count: number }[];
  byTier: readonly { tier: string; verdict: string; count: number }[];
  aliasDays: readonly { day: string; count: number }[];
  ruleDays: readonly { day: string; count: number }[];
}

export function buildMerchantOverview(f: MerchantOverviewFacts, now: Date, windowDays: 30 | 90): MerchantOverviewResponse {
  const keys = windowDayKeys(now, windowDays);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const days = keys.map((day) => ({ day, merged: 0, dismissed: 0 }));
  for (const d of f.decisions) {
    const i = idx.get(d.day);
    if (i === undefined) continue;
    if (d.verdict === "MERGED") days[i].merged += d.count; else if (d.verdict === "DISMISSED") days[i].dismissed += d.count;
  }
  const growth = keys.map((day) => ({ day, aliases: 0, rules: 0 }));
  for (const a of f.aliasDays) { const i = idx.get(a.day); if (i !== undefined) growth[i].aliases += a.count; }
  for (const r of f.ruleDays) { const i = idx.get(r.day); if (i !== undefined) growth[i].rules += r.count; }

  const tiers = new Map<string, { merged: number; dismissed: number }>();
  for (const t of f.byTier) {
    const e = tiers.get(t.tier) ?? { merged: 0, dismissed: 0 };
    if (t.verdict === "MERGED") e.merged += t.count; else if (t.verdict === "DISMISSED") e.dismissed += t.count;
    tiers.set(t.tier, e);
  }
  return {
    checkedAt: now.toISOString(),
    windowDays,
    transactions: {
      total: f.totalTransactions,
      resolved: f.resolvedTransactions,
      bySource: [...f.bySource]
        .map((s) => ({ key: s.key ?? "none", label: SOURCE_LABELS[s.key ?? "none"] ?? s.key ?? "Not recorded", count: s.count }))
        .sort((a, b) => b.count - a.count),
    },
    merchants: {
      total: f.merchants,
      aliases: [...f.aliasesBySource].map((a) => ({ source: a.source, label: ALIAS_LABELS[a.source] ?? a.source, count: a.count })).sort((a, b) => b.count - a.count),
      userRules: f.userRules,
    },
    decisions: {
      days,
      merged: days.reduce((a, d) => a + d.merged, 0),
      dismissed: days.reduce((a, d) => a + d.dismissed, 0),
      byTier: [...tiers.entries()].map(([tier, v]) => ({ tier, ...v })).sort((a, b) => a.tier.localeCompare(b.tier)),
    },
    growth: { days: growth },
    notes: [
      "Merchant Operations is merchant IDENTITY for customers' transactions. Fourth Meridian does not process payments or settle funds — there is no payment, settlement or processing data to chart.",
      "Counts are deployment-wide (every tenant), with no merchant names or tenant detail on this surface.",
      "Category provenance is recorded from the Merchant Intelligence release; older transactions read \"not recorded\".",
      "The global merchant catalogue lives in code, so its change history is not charted here.",
      "Pending merge candidates are computed on the review page (a fleet-wide read), not on this dashboard.",
    ],
  };
}
