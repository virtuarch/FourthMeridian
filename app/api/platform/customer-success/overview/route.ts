/**
 * GET /api/platform/customer-success/overview?window=30|90  (Platform Spaces 2.0 — Customer Success)
 *
 * The Customer Success dashboard's counts: onboarding stage distribution,
 * customers needing assistance by reason, connection health, the sync-incident
 * trend and registration-week onboarding cohorts — as the CsOverviewResponse
 * (lib/platform/customer/overview-types.ts). Counts only; the per-customer list
 * stays the audited Customers route.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ") first. Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getCsOverview } from "@/lib/platform/customer/overview";
import type { CsOverviewResponse } from "@/lib/platform/customer/overview-types";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const raw = new URL(req.url).searchParams.get("window");
  if (raw !== null && raw !== "30" && raw !== "90") {
    return NextResponse.json({ error: "window must be 30 or 90" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const body = await getCsOverview(raw === "90" ? 90 : 30);
  return NextResponse.json(body satisfies CsOverviewResponse, { headers: { "Cache-Control": "no-store" } });
}
