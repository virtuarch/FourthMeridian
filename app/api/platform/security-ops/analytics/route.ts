/**
 * GET /api/platform/security-ops/analytics?window=30|90  (Platform Spaces 2.0 — Security)
 *
 * The Security dashboard's analytics — sign-ins vs failed sign-ins (credential
 * vs blocked) per UTC day, access denials, detector windows and refused CONTROL
 * changes, failed sign-ins by weekday × hour, operator activity by result, 2FA
 * coverage and enforcement — as the SecurityAnalyticsResponse
 * (lib/platform/security/analytics-types.ts). Counts only, aggregated in SQL.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") first, like
 * every Security read. Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getSecurityAnalytics } from "@/lib/platform/security/analytics";
import type { SecurityAnalyticsResponse } from "@/lib/platform/security/analytics-types";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;
  const raw = new URL(req.url).searchParams.get("window");
  if (raw !== null && raw !== "30" && raw !== "90") {
    return NextResponse.json({ error: "window must be 30 or 90" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const body = await getSecurityAnalytics(raw === "90" ? 90 : 30);
  return NextResponse.json(body satisfies SecurityAnalyticsResponse, { headers: { "Cache-Control": "no-store" } });
}
