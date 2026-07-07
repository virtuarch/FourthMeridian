/**
 * GET /api/jobs/fetch-fx-rates
 *
 * Vercel Cron entrypoint for jobs/fetch-fx-rates.ts's fetchFxRates() —
 * MC1 Phase 1 Slice 4. Schedule lives in vercel.json (daily 06:30 UTC,
 * after the 06:00 sync-banks run; Vercel Hobby-plan cron jobs cannot run
 * more often than once per day — this uses the plan's second and last
 * Hobby cron slot).
 *
 * Auth: identical to app/api/jobs/sync-banks/route.ts — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when
 * CRON_SECRET is set on the project. Any request missing that exact header
 * gets a 401; no fallback auth.
 *
 * Behavior: fetches the previous closed UTC banking day through the
 * provider failover chain and appends it to the FxRate archive
 * (insert-only, skip-duplicates — a re-invocation is a network-free
 * no-op). No retries beyond provider failover: a fully-failed day is
 * self-healed by tomorrow's run or scripts/backfill-fx-rates.ts. No
 * conversion logic, no consumers — the archive only grows (MC1 Phase 1
 * contract; conversion is Phase 2).
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { runJob } from "@/lib/jobs/run";
import { fetchFxRates } from "@/jobs/fetch-fx-rates";

// One provider HTTP call plus a small DB write — 60s is generous headroom,
// matching the sync-banks precedent.
export const maxDuration = 60;

export const GET = withApiHandler(async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // OPS-4 S1 — ledgered via runJob(); behavior unchanged (result verbatim,
  // errors propagate). Auth stays in the route (S0 ruling R3).
  const result = await runJob("fetch-fx-rates", fetchFxRates, { trigger: "cron" });
  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/fetch-fx-rates");
