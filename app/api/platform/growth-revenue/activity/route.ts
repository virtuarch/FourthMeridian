/**
 * GET /api/platform/growth-revenue/activity  (OPS-6C User Activity Intelligence)
 *
 * DAU/WAU/MAU, new users, activation, and most-active Spaces — a pure projection
 * over the existing AuditLog LOGIN/SPACE_SWITCH ledger + User + UserSession
 * (lib/platform/activity). Read-only, aggregate + non-financial.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getUserActivity, type UserActivityMetrics } from "@/lib/platform/activity/activity";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  const metrics = await getUserActivity();
  return NextResponse.json(metrics satisfies UserActivityMetrics);
}
