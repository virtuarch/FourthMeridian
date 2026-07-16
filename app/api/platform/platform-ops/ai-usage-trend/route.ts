/**
 * GET /api/platform/platform-ops/ai-usage-trend  (OPS-6D AI Operations)
 *
 * AI usage over time — a per-day trend projected from the ApiUsageCounter ledger
 * (lib/platform/ai). Read-only, aggregate-only (provider/model/day). Estimated
 * spend is honest: null unless unit pricing is configured. Per-user/per-workspace
 * is structurally impossible until ApiUsageCounter gains that dimension (OPS-6H).
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getAiUsageTrend, type AiUsageTrend } from "@/lib/platform/ai/ai-usage";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const trend = await getAiUsageTrend();
  return NextResponse.json(trend satisfies AiUsageTrend);
}
