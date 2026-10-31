/**
 * GET /api/platform/merchant-ops/overview?window=30|90  (Platform Spaces 2.0 — Merchant Operations)
 *
 * Merchant-identity counts for the Merchant Operations dashboard: transaction
 * resolution coverage, category provenance mix, merchants / aliases / customer
 * rules, and merge-review decisions over time and by evidence tier — as the
 * MerchantOverviewResponse (lib/platform/merchant/overview-types.ts). Counts only.
 * Fourth Meridian processes no payments; nothing here implies it does.
 *
 * AUTHORIZATION: requirePlatformAccess("MERCHANT_OPS", "READ") first. Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getMerchantOverview } from "@/lib/platform/merchant/overview";
import type { MerchantOverviewResponse } from "@/lib/platform/merchant/overview-types";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("MERCHANT_OPS", "READ");
  if (err) return err;
  const raw = new URL(req.url).searchParams.get("window");
  if (raw !== null && raw !== "30" && raw !== "90") {
    return NextResponse.json({ error: "window must be 30 or 90" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const body = await getMerchantOverview(raw === "90" ? 90 : 30);
  return NextResponse.json(body satisfies MerchantOverviewResponse, { headers: { "Cache-Control": "no-store" } });
}
