/**
 * lib/platform/security/rate-limits.ts  (P12a — rate-limit pressure reader)
 *
 * The `ops_rate_limits` read, moved verbatim out of
 * GET /api/platform/platform-ops/rate-limits (pure move; pinned old-vs-new by
 * ./p12a-readers.test.ts). The route keeps its gate —
 * requirePlatformAccess("PLATFORM_OPS", "READ") — and calls this reader with
 * its clock.
 *
 * RateLimit keys are `{kind}:{name}:{subject}` where the subject is an IP /
 * userId / login identifier — PII. This reader AGGREGATES by the `{kind}:{name}`
 * bucket (the endpoint), summing counts across subjects, and NEVER returns a
 * subject. It reads only recent windows so the card reflects current pressure.
 *
 * AUTHORITY: the caller passes its client; there is no default.
 */

import type { PrismaClient } from "@prisma/client";

/** How far back a "current" window can have started. */
const WINDOW_LOOKBACK_MS = 60 * 60 * 1000; // 1 hour
const TOP_N = 8;

export interface RateLimitBucket {
  bucket: string; // `{kind}:{name}` — the endpoint, subject stripped
  hits:   number; // Σ RateLimit.count across subjects in this bucket
  keys:   number; // distinct subject rows in this bucket
}

export interface PlatformRateLimitsResponse {
  windowSince: string; // ISO — rows counted from here
  totalRows:   number; // distinct (key, window) rows in range
  totalHits:   number; // Σ count across all rows
  topBuckets:  RateLimitBucket[];
}

/** The only model this reader touches. */
export type RateLimitPressureClient = Pick<PrismaClient, "rateLimit">;

/** Drop the trailing subject segment: `ip:pre-login:1.2.3.4` → `ip:pre-login`. */
function bucketOf(key: string): string {
  const parts = key.split(":");
  return parts.length <= 2 ? key : parts.slice(0, -1).join(":");
}

/** `now` is the caller's epoch-ms clock (the route passes Date.now()). */
export async function readRateLimitPressure(client: RateLimitPressureClient, now: number): Promise<PlatformRateLimitsResponse> {
  const since = new Date(now - WINDOW_LOOKBACK_MS);
  const rows = await client.rateLimit.findMany({
    where:  { windowStart: { gte: since } },
    select: { key: true, count: true },
  });

  const agg = new Map<string, { hits: number; keys: number }>();
  let totalHits = 0;
  for (const r of rows) {
    totalHits += r.count;
    const b = bucketOf(r.key);
    const cur = agg.get(b) ?? { hits: 0, keys: 0 };
    cur.hits += r.count;
    cur.keys += 1;
    agg.set(b, cur);
  }

  const topBuckets: RateLimitBucket[] = [...agg.entries()]
    .map(([bucket, v]) => ({ bucket, hits: v.hits, keys: v.keys }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, TOP_N);

  return {
    windowSince: since.toISOString(),
    totalRows:   rows.length,
    totalHits,
    topBuckets,
  };
}
