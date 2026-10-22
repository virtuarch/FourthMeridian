/**
 * GET /api/jobs/fetch-fx-rates
 *
 * Per-job entrypoint for jobs/fetch-fx-rates.ts's fetchFxRates() —
 * MC1 Phase 1 Slice 4. Since OPS-4 S2 the production schedule runs through
 * the single dispatcher cron (app/api/jobs/dispatch — 06:30 UTC slot, after
 * the 06:00 sync-banks slot); this route stays deployed as the
 * manual/fallback entrypoint and the individual-revert target.
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
import { isAuthorizedCronRequest } from "@/lib/jobs/cron-auth";
import { runJob } from "@/lib/jobs/run";
import { fetchFxRates } from "@/jobs/fetch-fx-rates";

// One provider HTTP call plus a small DB write — 60s is generous headroom,
// matching the sync-banks precedent.
export const maxDuration = 300; // IDEMP-003 — aligned with the dispatcher (a 60 s fallback killed the same body the 300 s wake runs)

export const GET = withApiHandler(async (req: NextRequest) => {
  // SEC-009 — timing-safe CRON_SECRET comparison (lib/jobs/cron-auth.ts).
  if (!isAuthorizedCronRequest(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // OPS-4 S1 — ledgered via runJob(); behavior unchanged (result verbatim,
  // errors propagate). Auth stays in the route (S0 ruling R3).
  const result = await runJob("fetch-fx-rates", fetchFxRates, { trigger: "cron" });
  return NextResponse.json({ ok: true, ...result });
}, "GET /api/jobs/fetch-fx-rates");
