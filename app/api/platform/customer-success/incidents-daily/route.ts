/**
 * GET /api/platform/customer-success/incidents-daily  (Platform visual pass V2)
 *
 * Sync incidents opened and resolved per UTC day (14 d) for the Platform
 * Overview trend. Counts only — see lib/platform/customer/incidents-daily.ts.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getIncidentsDailySeries, type IncidentsDailySeries } from "@/lib/platform/customer/incidents-daily";

export const runtime = "nodejs";

export type IncidentsDailyResponse = IncidentsDailySeries;

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  return NextResponse.json((await getIncidentsDailySeries()) satisfies IncidentsDailyResponse, { headers: { "Cache-Control": "no-store" } });
}
