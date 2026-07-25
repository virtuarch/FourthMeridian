/**
 * GET /api/platform/platform-ops/refresh/coverage  (OPS-2C-1)
 *
 * The read surface for the Coverage Summary projection — per-endpoint and per
 * (account, endpoint) coverage evidence from RefreshEndpointAccountCoverage:
 * which accounts an execution evaluated, which were intentionally skipped and
 * why, and when each last had its freshness advanced.
 *
 * ── FACTS, NOT A STALENESS VERDICT ────────────────────────────────────────────
 * DF-2E ships the coverage facts and the reason vocabulary; it does NOT decide
 * whether an account is stale *now*, because that needs a per-endpoint cadence
 * authority which does not exist (the only staleness threshold in the repo,
 * PLAID_STALE_MS, is owned by lib/connections/health.ts). This route therefore
 * returns `lastCoveredAt` / `lastFreshnessAdvancedAt` and stops. A consumer must
 * not invent a stale/fresh verdict from them.
 *
 * ABSENCE IS NOT UNCOVERED, AND ABSENCE IS NOT FRESH: an account with no row was
 * simply not evaluated per-account by these executions.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getCoverageSummary } from "@/lib/platform/refresh/projections";
import { parseProjectionParams } from "@/lib/platform/refresh/request-params";
import type { CoverageSummary } from "@/lib/platform/refresh/types";

export const runtime = "nodejs";

export type RefreshCoverageResponse = CoverageSummary;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const args = parseProjectionParams(new URL(req.url).searchParams);
  const result = await getCoverageSummary(args);
  return NextResponse.json(result satisfies RefreshCoverageResponse);
}
