/**
 * lib/usage/provider-budget.core.ts
 *
 * PURE. The SHARED DAILY PROVIDER BUDGET (2026-10-28) — one durable request
 * counter per provider, which every history path that spends that provider's
 * key increments, and which the background worker's daily cap reads.
 *
 * ── Why the existing counter, not a new table ───────────────────────────────
 * ApiUsageCounter (provider, metric, unit, day) already IS a durable, race-safe
 * daily counter: lib/usage/record.ts upsert-increments it on its unique key,
 * the Platform Ops API-usage view already lists every provider in it, the
 * retention job already bounds it (90 days), and its RLS posture (fm_system
 * only, revoked from fm_app) is already in force. A new table would be a second
 * counter with a second RLS surface. So: provider "ALCHEMY", unit "calls",
 * metric "<network>:<method>" — one row per (network, method, UTC day).
 *
 * ── How the SOL checkpoint usage relates ────────────────────────────────────
 * Each Solana wallet's checkpoint still records the requests ITS backfill sent
 * today, at every commit (durable even for a run killed mid-flight). Those
 * requests are ALSO recorded here — so the checkpoint sum is a SUBSET of the
 * ledger, never an addition to it. The budget in force is therefore the MAX of
 * the two: the ledger when it has been flushed, the checkpoints when a run died
 * between its commit and its flush.
 *
 * Counted unit: one JSON-RPC CALL (a batch of 50 is 50) — what the provider
 * meters and rate-limits, and the unit the Solana cap has always counted.
 */

/** ApiUsageCounter.provider for every Alchemy-keyed request. */
export const ALCHEMY_USAGE_PROVIDER = "ALCHEMY";
/** ApiUsageCounter.unit for request counts (the vocabulary lib/usage/record.ts documents). */
export const USAGE_UNIT_CALLS = "calls";

/** The networks whose history paths meter into the shared budget. */
export const ALCHEMY_USAGE_NETWORK = { SOLANA: "solana", ETHEREUM: "ethereum" } as const;

/** Requests by method. The shape every transport meter already uses. */
export type RequestMeter = Record<string, number>;

/** Total requests in a meter (non-finite / negative entries ignored). */
export function meterTotal(meter: Readonly<RequestMeter>): number {
  let n = 0;
  for (const v of Object.values(meter)) if (Number.isFinite(v) && v > 0) n += v;
  return n;
}

/**
 * What `meter` holds beyond `flushed` — the part not yet recorded. Pure; the
 * caller advances `flushed` to `meter` after a successful record.
 */
export function meterDelta(meter: Readonly<RequestMeter>, flushed: Readonly<RequestMeter>): RequestMeter {
  const out: RequestMeter = {};
  for (const [k, v] of Object.entries(meter)) {
    const d = (Number.isFinite(v) ? v : 0) - (flushed[k] ?? 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

/** `ApiUsageCounter.metric` for one request kind. */
export function usageMetric(network: string, method: string): string {
  return `${network}:${method}`;
}

/**
 * The budget already spent today: the larger of the shared ledger and the sum
 * of the Solana checkpoints (a subset of the ledger whenever it was flushed).
 */
export function effectiveDailyUsage(args: { ledgerCalls: number | null; checkpointCalls: number }): number {
  const ledger = args.ledgerCalls !== null && Number.isFinite(args.ledgerCalls) && args.ledgerCalls > 0 ? args.ledgerCalls : 0;
  const cps = Number.isFinite(args.checkpointCalls) && args.checkpointCalls > 0 ? args.checkpointCalls : 0;
  return Math.max(ledger, cps);
}

/** "YYYY-MM-DD" → the counter's day bucket (UTC midnight). */
export function usageDayBucket(dayISO: string): Date {
  return new Date(`${dayISO}T00:00:00.000Z`);
}
