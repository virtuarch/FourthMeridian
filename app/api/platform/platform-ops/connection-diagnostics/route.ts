/**
 * GET /api/platform/platform-ops/connection-diagnostics  (CONN-2F)
 *
 * Operator per-connection diagnostics for the `ops_connection_diagnostics` widget
 * — enough visibility to support beta users ("their financial picture is wrong →
 * which layer failed: acquisition, intelligence build, or freshness?").
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Thin over lib/platform/connection-diagnostics.ts, which reuses the same pure
 * derivations as the customer surface (state / intelligence / health) — no new
 * financial authority. Operational METADATA only: status, health, counts,
 * timestamps, institution label. NO balances, NO transaction amounts, NO snapshot
 * value columns (only SpaceSnapshot.date, as a freshness signal).
 *
 * OWNER EMAIL — a deliberate deviation from the aggregate/no-PII posture of
 * connection-health: a support operator must identify WHOSE connection a ticket
 * refers to, so the owner's email is exposed HERE (grant-gated, PLATFORM_OPS
 * READ). It remains metadata — no financial data is exposed alongside it.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getConnectionDiagnostics, type ConnectionDiagnostic } from "@/lib/platform/connection-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ConnectionDiagnosticsResponse {
  connections: ConnectionDiagnostic[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const connections = await getConnectionDiagnostics();
  return NextResponse.json({ connections } satisfies ConnectionDiagnosticsResponse);
}
