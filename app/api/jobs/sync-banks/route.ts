/**
 * GET /api/jobs/sync-banks
 *
 * Per-job entrypoint for jobs/sync-banks.ts's syncBanks() — D2 Step 7C.
 * Since OPS-4 S2 the production schedule runs through the single dispatcher
 * cron (app/api/jobs/dispatch — 06:00 UTC slot); this route stays deployed
 * as the manual/fallback entrypoint and the individual-revert target (point
 * a vercel.json cron back here to detach the job from the dispatcher
 * without a code change).
 *
 * Auth: Vercel automatically sends `Authorization: Bearer ${CRON_SECRET}`
 * on cron-triggered requests when CRON_SECRET is set on the project. Any
 * request missing that exact header (manual curl, no env var configured,
 * wrong value) gets a 401 — this route does not fall back to any other
 * auth.
 *
 * Runs independently of the manual-refresh cooldown
 * (lib/plaid/refreshCooldown.ts) — syncBanks() never reads or writes
 * PlaidItem.lastManualRefreshAt, so a scheduled run never blocks, and is
 * never blocked by, a user clicking "Refresh"/"Sync Now".
 *
 * No retry/backoff here — one run, one attempt per item, same as the
 * manual routes. See jobs/sync-banks.ts for per-item error handling.
 *
 * OPS-4 S1 — the body runs through runJob(), which records the execution in
 * the append-only JobRun ledger. Observational only: behavior is unchanged
 * (result returned verbatim; errors propagate as before). Auth stays HERE,
 * not in the wrapper (S0 ruling R3: existing cron routes unchanged).
 */

import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api";
import { runJob } from "@/lib/jobs/run";
import { syncBanks } from "@/jobs/sync-banks";

// Headroom for looping over every active PlaidItem in one invocation.
// 60s is the max available on the Hobby plan; cheap to set even though
// today's account volume finishes well under that.
export const maxDuration = 60;

export const GET = withApiHandler(async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runJob("sync-banks", syncBanks, { trigger: "cron" });
  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/sync-banks");
