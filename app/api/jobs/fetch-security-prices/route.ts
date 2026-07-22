/**
 * GET /api/jobs/fetch-security-prices
 *
 * A8-3A — per-job entrypoint for jobs/fetch-security-prices.ts's
 * fetchSecurityPrices(). Since OPS-4 S2 the production schedule runs through the
 * single dispatcher cron (app/api/jobs/dispatch); this route stays deployed as
 * the manual/fallback entrypoint and the individual-revert target, mirroring
 * app/api/jobs/fetch-fx-rates/route.ts.
 *
 * Auth: identical to the other job routes — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when
 * CRON_SECRET is set. Any request missing that exact header gets a 401.
 *
 * Behavior: fetches the previous closed UTC day's RAW_CLOSE for held instruments
 * still missing it, through the provider failover chain, appending to the price
 * archive (insert-only, skip-duplicates — a re-invocation is a no-op). VENDOR-
 * GATED: with no licensed provider configured the job returns "no-provider" and
 * writes nothing (A8-3B deferred).
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { runJob } from "@/lib/jobs/run";
import { fetchSecurityPrices } from "@/jobs/fetch-security-prices";

// One provider call per missing instrument plus small DB writes — 60s headroom,
// matching the fetch-fx-rates precedent.
export const maxDuration = 60;

export const GET = withApiHandler(async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runJob("fetch-security-prices", () => fetchSecurityPrices(), { trigger: "cron" });
  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/fetch-security-prices");
