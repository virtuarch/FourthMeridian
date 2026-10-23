/**
 * GET /api/platform/platform-ops/refresh/daily  (UX-P1 · D8)
 *
 * The read surface for the Refresh Daily Series projection — executions per
 * UTC day of `startedAt`, by status and source kind, over a window of at most
 * thirty days. Purely derived from the DF-2 refresh ledger via
 * lib/platform/refresh/projections; this route performs NO aggregation of its
 * own and reads no table directly (read-boundary.test.ts forbids it).
 *
 * Accepts `from` / `to` (YYYY-MM-DD) and repeatable `plaidItemId` scope through
 * the shared parameter contract. The result carries the projection's envelope
 * (window, determinism, reason, checkedAt) and its honesty notes — consumers
 * read `deterministic` and `floor` rather than assuming a past window is
 * settled, and read `notes` for what the ledger cannot show.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getRefreshDailySeries } from "@/lib/platform/refresh/projections";
import { parseProjectionParams } from "@/lib/platform/refresh/request-params";
import type { RefreshDailySeries } from "@/lib/platform/refresh/types";

export const runtime = "nodejs";

export type RefreshDailyResponse = RefreshDailySeries;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const args = parseProjectionParams(new URL(req.url).searchParams);
  const result = await getRefreshDailySeries(args);
  return NextResponse.json(result satisfies RefreshDailyResponse);
}
