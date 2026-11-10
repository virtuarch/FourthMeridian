/**
 * GET /api/platform/platform-ops/rate-limits
 *
 * PO1.2 — current rate-limit pressure for the `ops_rate_limits` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * No existing admin route reads the RateLimit table (only the limiter and the
 * sweep job touch it), so this was written from scratch. RateLimit keys are
 * `{kind}:{name}:{subject}` where the subject is an IP / userId / login
 * identifier — PII. The reader AGGREGATES by the `{kind}:{name}` bucket (the
 * endpoint), summing counts across subjects, and NEVER returns a subject. It
 * reads only recent windows so the card reflects current pressure, not history.
 *
 * P12a: the read lives in lib/platform/security/rate-limits.ts (pure move);
 * this route is gate → reader → JSON.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readRateLimitPressure, type PlatformRateLimitsResponse } from "@/lib/platform/security/rate-limits";

export const runtime = "nodejs";

export type { RateLimitBucket, PlatformRateLimitsResponse } from "@/lib/platform/security/rate-limits";

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  return NextResponse.json((await readRateLimitPressure(db, Date.now())) satisfies PlatformRateLimitsResponse);
}
