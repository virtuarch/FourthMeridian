/**
 * GET /api/platform/platform-ops/refresh/executions/[id]/timeline  (OPS-2C-3)
 *
 * ONE execution's ordered story — the Execution Timeline projection. It merges
 * that execution's stage results, provider-call attempts and per-account
 * coverage into chronological timeline entries with a deterministic tiebreak, so
 * an equal-timestamp cluster never reshuffles between reads.
 *
 * ── WHY THE PANEL FETCHES A PROJECTION, NOT THE SEAM'S DETAIL ─────────────────
 * `getRefreshExecutionDetail` (the row seam) would return the same underlying
 * facts in a second shape — endpoint rows, call rows, coverage rows — and the
 * panel would then have to interleave them by time. That interleaving IS the
 * timeline projection, which already exists and is already order-stable. Having
 * the panel do it would be new aggregation inside an inspection surface, so this
 * route serves the projection and the panel renders it verbatim.
 *
 * 404 when the execution does not exist — never a fabricated empty timeline,
 * which would read as "this execution did nothing".
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getExecutionTimeline } from "@/lib/platform/refresh/projections";
import type { ExecutionTimeline } from "@/lib/platform/refresh/types";

export const runtime = "nodejs";

export type ExecutionTimelineResponse = ExecutionTimeline;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const { id } = await ctx.params;
  const timeline = await getExecutionTimeline(id);
  if (!timeline) {
    return NextResponse.json({ error: "Execution not found" }, { status: 404 });
  }

  return NextResponse.json(timeline satisfies ExecutionTimelineResponse);
}
