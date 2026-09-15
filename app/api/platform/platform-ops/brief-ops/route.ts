/**
 * GET /api/platform/platform-ops/brief-ops  (PLATFORM OPS OBSERVABILITY)
 *
 * Daily Brief operations: generated / failed / in-progress / version-stale
 * from the DailyBrief rows, economics joined to AiInvocation by correlationId.
 * Query: window=24h|7d|30d. Gated PLATFORM_OPS READ.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getBriefOps, parseBriefOpsWindow } from "@/lib/platform/ai/brief-ops";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json(await getBriefOps(parseBriefOpsWindow(req.nextUrl.searchParams)));
}
