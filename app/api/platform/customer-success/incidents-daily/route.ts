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
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { getIncidentsDailySeries, type IncidentsDailySeries } from "@/lib/platform/customer/incidents-daily";

export const runtime = "nodejs";

export type IncidentsDailyResponse = IncidentsDailySeries;

export async function GET(): Promise<Response> {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  // PB-1 Phase 3 — the incident token from THIS guard result (the series downgrades it to the identity-free tier).
  const incidentToken = incidentAudienceFor(auth);
  if (!incidentToken || incidentToken.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json((await getIncidentsDailySeries(incidentToken)) satisfies IncidentsDailyResponse, { headers: { "Cache-Control": "no-store" } });
}
