/**
 * GET /api/platform/platform-ops/rate-limits
 *
 * PO1.2 — current rate-limit pressure for the `ops_rate_limits` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * No existing admin route reads the RateLimit table (only the limiter and the
 * sweep job touch it), so this is written from scratch. RateLimit keys are
 * `{kind}:{name}:{subject}` where the subject is an IP / userId / login
 * identifier — PII. This route AGGREGATES by the `{kind}:{name}` bucket (the
 * endpoint), summing counts across subjects, and NEVER returns a subject. It
 * reads only recent windows so the card reflects current pressure, not history.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";

export const runtime = "nodejs";

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

/** Drop the trailing subject segment: `ip:pre-login:1.2.3.4` → `ip:pre-login`. */
function bucketOf(key: string): string {
  const parts = key.split(":");
  return parts.length <= 2 ? key : parts.slice(0, -1).join(":");
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const since = new Date(Date.now() - WINDOW_LOOKBACK_MS);
  const rows = await db.rateLimit.findMany({
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

  return NextResponse.json({
    windowSince: since.toISOString(),
    totalRows:   rows.length,
    totalHits,
    topBuckets,
  } satisfies PlatformRateLimitsResponse);
}
