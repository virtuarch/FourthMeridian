/**
 * GET /api/jobs/resume-stale-imports
 *
 * Server-side backstop that finishes first-run Plaid imports nothing else will.
 * See jobs/resume-stale-imports.ts for the gap this closes — in short, the
 * client-driven resume only runs while the Connections page is open, which on
 * mobile is usually not long enough.
 *
 * Runs on its own frequent cron (vercel.json) rather than through the daily
 * dispatcher: a backstop measured in hours is not a backstop for something a
 * user is watching. It is bounded per run and safe to fire often — the per-item
 * sync lock means overlapping invocations skip rather than race.
 *
 * Auth: identical to the other job routes — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests. Anything
 * without that exact header gets a 401; there is no other auth path.
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { runJob } from "@/lib/jobs/run";
import { resumeStaleImports } from "@/jobs/resume-stale-imports";

// Matches the sync budget: one invocation may drive several items, each of
// which runs the full deferred pipeline.
export const maxDuration = 300;

export const GET = withApiHandler(async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runJob("resume-stale-imports", resumeStaleImports, { trigger: "cron" });
  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/resume-stale-imports");
