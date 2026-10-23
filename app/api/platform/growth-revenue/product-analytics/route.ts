/**
 * GET /api/platform/growth-revenue/product-analytics  (BETA A1–A8)
 *
 * First-party product analytics at fleet grain — registrations, present vs
 * engaged DAU/WAU/MAU with sign-ins beside them, weekly D1/D7 retention, the
 * onboarding funnel, feature adoption and cost per engaged user — as the frozen
 * ProductAnalyticsResponse (lib/platform/growth/product-analytics-types.ts).
 * A pure projection over AuditLog product events, UserSession, User,
 * AiInvocation, PlaidItem, Connection and FinancialAccount
 * (lib/platform/growth/product-analytics). Read-only, identity-minimised: no
 * user id, name, email or Space name is in the body.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ") first, like
 * every Growth & Revenue read. Never cached: the figures move with the ledgers.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getProductAnalytics } from "@/lib/platform/growth/product-analytics";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  const body = await getProductAnalytics();
  return NextResponse.json(body satisfies ProductAnalyticsResponse, { headers: { "Cache-Control": "no-store" } });
}
