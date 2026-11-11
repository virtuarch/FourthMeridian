/**
 * GET /api/platform/security-ops/operator-actions  (PO-3A; P1 envelope)
 *
 * The Security Ops "operator action feed" — what platform operators (and
 * SYSTEM_ADMINs) DID to the platform: grant changes, manual operations, beta
 * decisions, operator-driven account state changes, and the P1 consequential
 * actions (customer policy / cohort assignment, cadence changes, operator
 * refresh-all). Every operator write records an AuditLog row with
 * `performedByAdminId`; this route is the read surface.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ"). Pure projection
 * over AuditLog — no write, no new permission, no customer financial data.
 *
 * P12a: the read lives in lib/platform/security/operator-actions.ts (pure move),
 * which projects every row through the pure core
 * (lib/platform/security/operator-actions-core.ts); this route is
 * gate → reader → JSON.
 *
 * PII-minimized: the acting operator's username, the action, a coarse target
 * label (subject username or `<kind> …<tail>`), the reason CODE (never the
 * note), the result and opaque execution references. Never email/IP/user-agent,
 * never AuditLog.metadata verbatim.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readOperatorActionFeed, type OperatorActionsResponse } from "@/lib/platform/security/operator-actions";

export const runtime = "nodejs";

export type { OperatorActionEvent, OperatorActionsResponse } from "@/lib/platform/security/operator-actions";

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  return NextResponse.json((await readOperatorActionFeed(db)) satisfies OperatorActionsResponse);
}
