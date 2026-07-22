/**
 * GET /api/platform/platform-ops/provider-health
 *
 * OPS-5 S3 — canonical provider health for the `ops_provider_health` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Thin over lib/platform/provider-health.ts (getProviderHealth), which treats
 * every EXTERNAL PROVIDER as a first-class operational resource and SYNTHESIZES
 * its health from the authorities that already own each truth — the JobRun
 * ledger (execution), ApiUsageCounter (usage), the OPS-5 S1 Resource Freshness
 * authority (content freshness, CONSUMED not recomputed), and lib/connections/
 * health.ts (connection recency). This is PROVIDER health, deliberately NOT job
 * health — job status is one input among several.
 *
 * Aggregate + non-monetary only: statuses, counts, dates, ratios, call volume —
 * no rates, no prices, no PII cross the boundary (the PO1 platform posture).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getProviderHealth, type ProviderHealth, type ProviderTrust } from "@/lib/platform/provider-health";

export const runtime = "nodejs";

export interface ProviderHealthResponse {
  checkedAt: string; // ISO
  counts: Record<ProviderTrust, number>;
  providers: ProviderHealth[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const result = await getProviderHealth();

  return NextResponse.json({
    checkedAt: result.checkedAt.toISOString(),
    counts: result.counts,
    providers: result.providers,
  } satisfies ProviderHealthResponse);
}
