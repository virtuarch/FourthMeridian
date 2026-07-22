/**
 * GET /api/platform/platform-ops/resource-freshness
 *
 * OPS-5 S1 — canonical resource freshness for the `ops_resource_freshness`
 * widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Thin over lib/platform/resource-freshness.ts (checkResourceFreshness), the
 * ONE freshness authority. That module derives freshness from the underlying
 * data (MAX(FxRate.date), the newest PriceObservation, …) — NEVER from
 * JobRun.status — and surfaces the ledger's last-attempted / last-successful
 * beside the content truth so the false-green (a green job over a stale/empty
 * archive) is visible. Aggregate + non-monetary only: dates, counts, states,
 * cadence — no rates, no prices, no PII cross the boundary.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { checkResourceFreshness, type ResourceFreshnessReport } from "@/lib/platform/resource-freshness";

export const runtime = "nodejs";

export interface ResourceFreshnessResponse {
  checkedAt: string; // ISO
  allFresh: boolean;
  counts: { fresh: number; stale: number; empty: number; idle: number };
  resources: ResourceFreshnessReport[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const result = await checkResourceFreshness();

  const counts = { fresh: 0, stale: 0, empty: 0, idle: 0 };
  for (const r of result.resources) counts[r.healthState]++;

  return NextResponse.json({
    checkedAt: result.checkedAt.toISOString(),
    allFresh: result.allFresh,
    counts,
    resources: result.resources,
  } satisfies ResourceFreshnessResponse);
}
