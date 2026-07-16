/**
 * GET /api/platform/growth-revenue/growth  (OPS-6F Growth)
 *
 * The growth funnel — beta conversion (requested → approved → redeemed →
 * activated) + signup activation (users → verified → activated → returning) — a
 * pure projection over BetaAccessRequest + User + UserSession (lib/platform/growth).
 * Read-only, aggregate + non-financial.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getGrowthFunnel, type GrowthFunnel } from "@/lib/platform/growth/growth";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  const funnel = await getGrowthFunnel();
  return NextResponse.json(funnel satisfies GrowthFunnel);
}
