/**
 * lib/usage/provider-budget.ts
 *
 * The I/O half of the shared daily provider budget (decisions and the reasons
 * for reusing ApiUsageCounter: ./provider-budget.core.ts).
 *
 *   recordProviderMeter   flush a transport meter into the durable counter
 *                         (through lib/usage/record.ts — the one writer)
 *   providerCallsOn       today's calls for a provider, for a cap to read
 *
 * Both NEVER throw: metering must not fail a sync, and an unreadable ledger
 * reads as null (the caller then falls back to the checkpoints it holds).
 */

import { recordApiUsage } from "./record";
import {
  USAGE_UNIT_CALLS, meterDelta, meterTotal, usageDayBucket, usageMetric, type RequestMeter,
} from "./provider-budget.core";

export * from "./provider-budget.core";

/** The recorder seam — lib/usage/record.ts in production, a fake in tests. */
export type UsageRecorder = (provider: string, metric: string, unit: string, n: number) => Promise<void>;

/**
 * Record every method in `meter` beyond `flushed` (default: nothing flushed)
 * and return the number of calls recorded. `flushed` is advanced in place, so
 * one meter can be flushed repeatedly without double counting.
 */
export async function recordProviderMeter(
  provider: string,
  network: string,
  meter: Readonly<RequestMeter>,
  opts: { flushed?: RequestMeter; record?: UsageRecorder } = {},
): Promise<number> {
  const flushed = opts.flushed ?? {};
  const record = opts.record ?? recordApiUsage;
  const delta = meterDelta(meter, flushed);
  for (const [method, n] of Object.entries(delta)) {
    try { await record(provider, usageMetric(network, method), USAGE_UNIT_CALLS, n); }
    catch { /* recordApiUsage never throws; a fake might */ }
    flushed[method] = (flushed[method] ?? 0) + n;
  }
  return meterTotal(delta);
}

/** The minimal client surface read here (systemDb in production). */
export interface ProviderUsageClient {
  apiUsageCounter: {
    aggregate(args: {
      where: { provider: string; unit: string; day: Date };
      _sum: { count: true };
    }): Promise<{ _sum: { count: bigint | number | null } }>;
  };
}

/** Calls recorded for `provider` on the UTC day `dayISO`, across every network and method. Null when unreadable. */
export async function providerCallsOn(client: ProviderUsageClient, provider: string, dayISO: string): Promise<number | null> {
  try {
    const r = await client.apiUsageCounter.aggregate({
      where: { provider, unit: USAGE_UNIT_CALLS, day: usageDayBucket(dayISO) },
      _sum:  { count: true },
    });
    const n = Number(r._sum.count ?? 0);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    console.warn(`[usage] providerCallsOn(${provider}) failed (non-fatal):`, e instanceof Error ? e.message : String(e));
    return null;
  }
}
