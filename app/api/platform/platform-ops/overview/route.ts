/**
 * GET /api/platform/platform-ops/overview  (PLATFORM OPS OBSERVABILITY)
 *
 * The operations overview: one verdict per operational domain, each derived
 * from its own authority (lib/platform/ops/overview.ts). Read-only; no
 * provider call; gated PLATFORM_OPS READ.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getOperationsOverview } from "@/lib/platform/ops/overview";

export const runtime = "nodejs";

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json(await getOperationsOverview());
}
