/**
 * GET /api/platform/security-ops/daily  (Platform visual pass V2)
 *
 * The Security day series for the Platform Overview trend: failed sign-ins,
 * access-denial records and other anomaly trips per UTC day (14 d). Counts only
 * — see lib/platform/security/daily.ts.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getSecurityDailySeries, type SecurityDailySeries } from "@/lib/platform/security/daily";

export const runtime = "nodejs";

export type SecurityDailyResponse = SecurityDailySeries;

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;
  return NextResponse.json((await getSecurityDailySeries()) satisfies SecurityDailyResponse, { headers: { "Cache-Control": "no-store" } });
}
