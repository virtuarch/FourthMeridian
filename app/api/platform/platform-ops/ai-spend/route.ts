/**
 * GET /api/platform/platform-ops/ai-spend  (BETA C6 + C7)
 *
 * Estimated AI spend over the last 30 UTC days ALLOCATED BY SURFACE from the
 * AiInvocation ledger — customer (Conversations + Daily Brief) told from
 * overhead (the evaluation harness and anything unattributed) and from what
 * could not be priced — plus the cost safeguards in force (the two spend-alert
 * thresholds with provenance, the daily-allowance dimension as the catalogue
 * defines it). The counter-based trend (ai-usage-trend) stays beside it as the
 * cross-check of two separately written ledgers.
 *
 * Read-only, fleet-level: no user, Space or conversation dimension is selected.
 * Every dollar is an estimate from the code-owned rate card, never a bill.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getAiSpendOverview, type AiSpendOverview } from "@/lib/platform/ai/spend-by-surface";
import { getCostSafeguards, type CostSafeguards } from "@/lib/platform/ai/cost-safeguards";

export const runtime = "nodejs";

export interface AiSpendResponse {
  spend: AiSpendOverview;
  safeguards: CostSafeguards;
}

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const [spend, safeguards] = await Promise.all([getAiSpendOverview(), getCostSafeguards()]);
  return NextResponse.json({ spend, safeguards } satisfies AiSpendResponse, { headers: { "Cache-Control": "no-store" } });
}
