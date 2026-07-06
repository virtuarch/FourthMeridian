/**
 * GET /api/jobs/process-deletions  (OPS-2 S7c)
 *
 * Vercel Cron entrypoint for jobs/process-deletions.ts's processDeletions() —
 * the irreversible account-deletion purge. Schedule lives in vercel.json
 * (daily 07:00 UTC, after the 06:00 sync-banks and 06:30 fetch-fx-rates runs).
 *
 * Auth: identical to the other cron routes — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when
 * CRON_SECRET is set on the project. Any request missing that exact header
 * gets a 401; no fallback auth. Do NOT invent another scheduler.
 *
 * Behavior: purges every account past its grace window, one at a time,
 * best-effort per user (a single failure never blocks the rest and is retried
 * on the next daily run). See lib/account-deletion/purge.ts for the pipeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { processDeletions } from "@/jobs/process-deletions";

// Headroom for looping over the (small) set of due accounts in one invocation —
// matches the sync-banks / fetch-fx-rates precedent (Hobby-plan max).
export const maxDuration = 60;

export const GET = withApiHandler(async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processDeletions();
  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/process-deletions");
