/**
 * GET /api/platform/platform-ops/connection-health
 *
 * Wave 2 S7 / CH-1 — normalized provider-connection health for the
 * `ops_connection_health` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Thin over lib/connections/health.ts (getConnectionHealth), which normalizes
 * PlaidItem + non-Plaid Connection rows into one shape, dedupes the Plaid
 * dual-write, derives healthState server-side, and joins "broken since" from the
 * transition log. Aggregate + non-PII only (no userId, no email) — the PO1
 * platform-route posture. A CS-scoped variant, if ever built, is a second thin
 * route over this same module.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getConnectionHealth, type ConnectionHealthResult } from "@/lib/connections/health";

export const runtime = "nodejs";

export type ConnectionHealthResponse = ConnectionHealthResult;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const result = await getConnectionHealth();
  return NextResponse.json(result satisfies ConnectionHealthResponse);
}
