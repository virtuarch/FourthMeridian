/**
 * jobs/sweep-rate-limits.ts  (OPS-4 S3)
 *
 * Deletes expired RateLimit fixed-window rows. Without this sweep the table
 * grows unboundedly by construction — one row per (key, windowStart) bucket,
 * never deleted anywhere (the gap named in the OPS-4 investigation §4.6).
 *
 * CUTOFF: 24 hours. The largest window any call site uses is 900s (KD-3
 * inventory), so every row older than 24h is long expired for every
 * endpoint — the sweep can never delete a bucket that could still be
 * consulted. Registered in lib/jobs/registry.ts (07:30 UTC slot), executed
 * through the dispatcher + runJob().
 *
 * IDEMPOTENT by construction: a WHERE-guarded deleteMany against an absolute
 * cutoff (the lib/notifications/cleanup.ts idiom); a second run in the same
 * instant matches zero rows. Uses the @@index([windowStart]) index.
 */

import { db } from "@/lib/db";

const RATE_LIMIT_ROW_RETENTION_HOURS = 24;

/** Exactly the one operation the sweep performs (injection seam for tests). */
export interface RateLimitSweepClient {
  rateLimit: {
    deleteMany(args: { where: { windowStart: { lt: Date } } }): Promise<{ count: number }>;
  };
}

export interface SweepRateLimitsResult {
  /** Expired window rows deleted this run. */
  deleted: number;
  /** The absolute cutoff applied (ISO) — audit convenience, no user content. */
  cutoff: string;
}

export async function sweepRateLimits(
  client: RateLimitSweepClient = db as unknown as RateLimitSweepClient,
  now: Date = new Date(),
): Promise<SweepRateLimitsResult> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_ROW_RETENTION_HOURS * 60 * 60 * 1000);

  const result = await client.rateLimit.deleteMany({
    where: { windowStart: { lt: cutoff } },
  });

  if (result.count > 0) {
    console.log(`[sweep-rate-limits] deleted ${result.count} expired window row(s) older than ${RATE_LIMIT_ROW_RETENTION_HOURS}h`);
  }

  return { deleted: result.count, cutoff: cutoff.toISOString() };
}
