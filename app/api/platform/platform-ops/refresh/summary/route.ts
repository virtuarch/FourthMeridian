/**
 * GET /api/platform/platform-ops/refresh/summary  (OPS-2C-1)
 *
 * The read surface for the Refresh Summary projection — execution outcomes,
 * durations, trigger/profile mix, and the per-endpoint stage roll-up over a
 * window. Purely derived from the DF-2 refresh ledger via
 * lib/platform/refresh/projections; this route performs NO aggregation of its
 * own and reads no table directly (read-boundary.test.ts forbids it).
 *
 * Accepts `from` / `to` (YYYY-MM-DD) and repeatable `plaidItemId` scope. The
 * result carries its own determinism envelope — a window is reproducible only
 * when it is closed AND holds no RUNNING execution — so consumers must read
 * `deterministic` rather than assuming a past window is stable.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getRefreshSummary } from "@/lib/platform/refresh/projections";
import { parseProjectionParams } from "@/lib/platform/refresh/request-params";
import type { RefreshSummary } from "@/lib/platform/refresh/types";

export const runtime = "nodejs";

export type RefreshSummaryResponse = RefreshSummary;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const args = parseProjectionParams(new URL(req.url).searchParams);
  const result = await getRefreshSummary(args);
  return NextResponse.json(result satisfies RefreshSummaryResponse);
}
