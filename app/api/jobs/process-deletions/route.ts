/**
 * GET /api/jobs/process-deletions  (OPS-2 S7c)
 *
 * Per-job entrypoint for the irreversible account-deletion purge. Since
 * OPS-4 S2 the production schedule runs through the single dispatcher cron
 * (app/api/jobs/dispatch — 07:00 UTC slot); this route stays deployed as the
 * manual/fallback entrypoint and the individual-revert target (point a
 * vercel.json cron back here to detach the job from the dispatcher without
 * a code change).
 *
 * Auth: identical to the other cron routes — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when
 * CRON_SECRET is set on the project. Any request missing that exact header
 * gets a 401; no fallback auth. Do NOT invent another scheduler.
 *
 * Behavior: purges every account past its grace window, one at a time,
 * best-effort per user (a single failure never blocks the rest and is retried
 * on the next daily run). See lib/account-deletion/purge.ts for the pipeline.
 *
 * SINGLE-PURPOSE since OPS-4 S3: the OPS-3 notification-retention tail that
 * rode this job (S0 ruling R4) relocated to its own dispatcher registration
 * ("notification-cleanup", 07:30 UTC slot) — exactly the move the OPS-3
 * headers promised. This route does deletions, nothing else.
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { runJob } from "@/lib/jobs/run";
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

  // OPS-4 S1 — ledgered via runJob(); same JobRun name as the dispatcher path.
  const result = await runJob("process-deletions", processDeletions, { trigger: "cron" });

  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/process-deletions");
