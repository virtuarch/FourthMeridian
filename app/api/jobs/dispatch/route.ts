/**
 * GET /api/jobs/dispatch  (OPS-4 S2)
 *
 * THE single Vercel Cron entrypoint. vercel.json carries exactly one cron —
 * this path — now multi-slot: "0,30 0,6,7,12,18 * * *" (CH-3, 2026-07-13,
 * confirmed off the Hobby tier's sub-daily-cron-rejected-at-deploy constraint
 * — the note that used to live here about being pinned to a single daily
 * 06:00 tick is stale; see the connections-weirdness investigation §5.2).
 * This covers every registered slot — sync-crypto 00:00/06:00/12:00/18:00,
 * sync-banks + fx/security-prices 06:00/06:30, deletions 07:00, maintenance
 * 07:30 — plus two slots (00:30, 12:30) with no registered job, where the
 * dispatcher harmlessly no-ops. The dispatcher (lib/jobs/dispatch.ts) selects
 * the jobs due at the invocation's slot from the registry
 * (lib/jobs/registry.ts) and runs each through runJob() — individually
 * ledgered, individually isolated. Any slot a future registry change doesn't
 * reach stays reachable via the per-job fallback routes (CRON_SECRET-guarded);
 * FX freshness is additionally kept current by the opportunistic
 * stale-while-revalidate refresh (lib/money/fx-freshness.ts).
 *
 * Auth: identical to the pre-S2 cron routes — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when
 * CRON_SECRET is set on the project. Any request missing that exact header
 * gets a 401; no fallback auth.
 *
 * REVERTIBILITY: the three per-job routes (sync-banks, fetch-fx-rates,
 * process-deletions) remain deployed and CRON_SECRET-guarded — any job is
 * individually revertible to its own vercel.json cron entry without a code
 * change.
 *
 * FAILURE SIGNAL: any failed job → 500, so a bad slot is visible in Vercel's
 * cron dashboard exactly as the per-job crons were. Details live in the
 * JobRun ledger (status "failed" + errorSummary).
 *
 * NOT HERE (S0 rulings): retries · dead-job detection · digests ·
 * notification retry · metrics. Dispatch, sequencing, isolation, logging —
 * nothing else.
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { dispatchDueJobs } from "@/lib/jobs/dispatch";

// One slot's job(s) per invocation — the same 60s Hobby-max headroom the
// per-job routes used; per-slot fan-out means runtimes do not sum across
// slots (S2 risk note: re-verify if a slot ever hosts multiple jobs).
export const maxDuration = 60;

export const GET = withApiHandler(async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await dispatchDueJobs(new Date());

  return NextResponse.json(
    { ok: result.failures === 0, ...result },
    { status: result.failures === 0 ? 200 : 500 },
  );
}, "GET /api/jobs/dispatch");
