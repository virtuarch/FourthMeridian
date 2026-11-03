/**
 * lib/platform/anomaly/plaid-calls.ts  (quota/cost anomaly — Plaid calls per day)
 *
 * Plaid provider calls per UTC day, from the ApiUsageCounter ledger the Plaid
 * client writes one row-increment per call into (lib/plaid/client.ts,
 * provider "PLAID", unit "calls") — the same ledger the Providers dashboard and
 * provider-health read. The ledger's grain is the UTC day, so the CURRENT
 * window is the last COMPLETE day (yesterday, UTC) and the baseline is the 7
 * days before it: a partial "today" would always read low.
 *
 * A day with no rows is IDLE (nothing recorded). Read-only.
 */

import "server-only";
import { db } from "@/lib/db";
import { ANOMALY_DEFINITION, type AnomalyWindow } from "@/lib/alerts/anomaly";
import type { PlaidCallAnomalyFacts } from "@/lib/alerts/authorities";

const DAY_MS = 24 * 60 * 60 * 1000;
export const PLAID_USAGE_PROVIDER = "PLAID";

export interface PlaidCallUsageClient {
  apiUsageCounter: {
    findMany(args: {
      where: { provider: string; unit: string; day: { gte: Date; lt: Date } };
      select: { day: true; count: true };
    }): Promise<Array<{ day: Date; count: bigint | number }>>;
  };
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Pure: per-day totals → the facts. `today` is the start of the current (incomplete) UTC day. */
export function buildPlaidCallAnomalyFacts(
  rows: ReadonlyArray<{ day: Date; count: bigint | number }>,
  today: Date,
  now: Date,
): PlaidCallAnomalyFacts {
  const byDay = new Map<number, number>();
  for (const r of rows) byDay.set(utcDay(r.day).getTime(), (byDay.get(utcDay(r.day).getTime()) ?? 0) + Number(r.count));
  const windowOf = (k: number): AnomalyWindow => {
    const n = byDay.get(today.getTime() - k * DAY_MS);
    return n !== undefined && n > 0 ? { kind: "VALUE", value: n } : { kind: "IDLE" };
  };
  const baseline: AnomalyWindow[] = [];
  for (let k = 2; k <= ANOMALY_DEFINITION.baselineWindows + 1; k++) baseline.push(windowOf(k));
  return {
    checkedAt: now.toISOString(),
    dayISO: new Date(today.getTime() - DAY_MS).toISOString().slice(0, 10),
    current: windowOf(1),
    baseline,
  };
}

export async function getPlaidCallAnomalyFacts(deps: { now?: Date; client?: PlaidCallUsageClient } = {}): Promise<PlaidCallAnomalyFacts> {
  const now = deps.now ?? new Date();
  const client = deps.client ?? (db as unknown as PlaidCallUsageClient);
  const today = utcDay(now);
  const since = new Date(today.getTime() - (ANOMALY_DEFINITION.baselineWindows + 1) * DAY_MS);
  const rows = await client.apiUsageCounter.findMany({
    where: { provider: PLAID_USAGE_PROVIDER, unit: "calls", day: { gte: since, lt: today } },
    select: { day: true, count: true },
  });
  return buildPlaidCallAnomalyFacts(rows, today, now);
}
