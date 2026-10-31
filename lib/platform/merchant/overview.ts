/**
 * lib/platform/merchant/overview.ts  (Platform Spaces 2.0 — Merchant Operations: THE READER)
 *
 * Deployment-wide counts on fm_system (`systemDb`) — the same reach the merge
 * review page uses (app/merchant-ops/page.tsx), for the same reason: per-tenant
 * narrowing would be a wrong answer. Counts and GROUP BYs only; no merchant
 * name, canonical key, alias text or transaction detail is selected. Read-only.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { buildMerchantOverview, windowDayKeys } from "./overview-core";
import type { MerchantOverviewResponse } from "./overview-types";

type DayRow = { day: string; count: bigint | number };
type SourceRow = { key: string | null; total: bigint | number; linked: bigint | number };
type DayVerdictRow = { day: string; verdict: string; count: bigint | number };

export async function getMerchantOverview(windowDays: 30 | 90, now: Date = new Date()): Promise<MerchantOverviewResponse> {
  const client = systemDb;
  const since = new Date(`${windowDayKeys(now, windowDays)[0]}T00:00:00.000Z`);
  const [bySource, merchants, aliases, userRules, decisions, byTier, aliasDays, ruleDays] = await Promise.all([
    // ONE pass over live transactions (soft-deleted rows — rolled-back imports,
    // superseded pendings — are excluded, like every product reader): count and
    // merchant-linked count per category provenance.
    client.$queryRaw<SourceRow[]>`
      SELECT "categorySource"::text AS key, count(*) AS total, count("merchantId") AS linked
        FROM "Transaction" WHERE "deletedAt" IS NULL GROUP BY 1`,
    client.merchant.count(),
    client.merchantAlias.groupBy({ by: ["source"], _count: { _all: true } }),
    client.merchantRule.count({ where: { scope: "USER" } }),
    client.$queryRaw<DayVerdictRow[]>`
      SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, "verdict"::text AS verdict, count(*) AS count
        FROM "MerchantMergeDecision" WHERE "createdAt" >= ${since} GROUP BY 1, 2`,
    client.merchantMergeDecision.groupBy({ by: ["evidenceTier", "verdict"], _count: { _all: true } }),
    client.$queryRaw<DayRow[]>`
      SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS count FROM "MerchantAlias" WHERE "createdAt" >= ${since} GROUP BY 1`,
    client.$queryRaw<DayRow[]>`
      SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS count FROM "MerchantRule" WHERE "createdAt" >= ${since} AND "scope"::text = 'USER' GROUP BY 1`,
  ]);
  const num = (v: bigint | number) => Number(v);
  return buildMerchantOverview({
    totalTransactions: bySource.reduce((a, s) => a + num(s.total), 0),
    resolvedTransactions: bySource.reduce((a, s) => a + num(s.linked), 0),
    bySource: bySource.map((s) => ({ key: s.key, count: num(s.total) })),
    merchants,
    aliasesBySource: aliases.map((a) => ({ source: String(a.source), count: a._count._all })),
    userRules,
    decisions: decisions.map((d) => ({ day: d.day, verdict: d.verdict, count: num(d.count) })),
    byTier: byTier.map((t) => ({ tier: t.evidenceTier, verdict: String(t.verdict), count: t._count._all })),
    aliasDays: aliasDays.map((d) => ({ day: d.day, count: num(d.count) })),
    ruleDays: ruleDays.map((d) => ({ day: d.day, count: num(d.count) })),
  }, now, windowDays);
}
