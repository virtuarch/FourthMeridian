/**
 * GET /api/platform/platform-ops/economics/entitlements  (Platform Economics — Entitlements)
 *
 * Cost by policy group this cycle (lib/platform/economics/entitlements-core.ts):
 * Σ per-customer attributable cost grouped by CURRENT assignment, each group a
 * figure that drills to its customers (opaque refs), plus what could not be
 * attributed. Configuration stays in Policies; nothing here changes a policy.
 *
 * Read-only, identity-free. AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEconomicsEntitlements } from "@/lib/platform/economics/providers-entitlements";
import type { EconomicsEntitlementsView } from "@/lib/platform/economics/entitlements-core";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const body = await getEconomicsEntitlements(Date.now());
  return NextResponse.json(body satisfies EconomicsEntitlementsView, { headers: { "Cache-Control": "no-store" } });
}
