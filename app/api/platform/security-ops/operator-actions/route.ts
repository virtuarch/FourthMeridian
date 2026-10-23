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
 * over AuditLog (lib/platform/security/operator-actions-core.ts) — no write, no
 * new permission, no customer financial data.
 *
 * PII-minimized: the acting operator's username, the action, a coarse target
 * label (subject username or `<kind> …<tail>`), the reason CODE (never the
 * note), the result and opaque execution references. Never email/IP/user-agent,
 * never AuditLog.metadata verbatim.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { projectOperatorActionEvent, type OperatorActionEvent } from "@/lib/platform/security/operator-actions-core";

export const runtime = "nodejs";

const RECENT_LIMIT = 20;

export type { OperatorActionEvent };

export interface OperatorActionsResponse {
  events: OperatorActionEvent[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  const rows = await db.auditLog.findMany({
    where:   { action: { in: OPERATOR_ACTION_FEED_ACTIONS }, performedByAdminId: { not: null } },
    orderBy: { createdAt: "desc" },
    take:    RECENT_LIMIT,
    select:  {
      id:                 true,
      action:             true,
      createdAt:          true,
      performedByAdminId: true,
      metadata:           true,
      user:               { select: { username: true } }, // the SUBJECT (userId), when present
    },
  });

  // performedByAdminId is a soft ref (no relation) — resolve operator usernames in
  // one batched follow-up query, like growth's redeemedActivated pattern.
  const operatorIds = [...new Set(rows.map((r) => r.performedByAdminId).filter((v): v is string => v != null))];
  const operators = operatorIds.length
    ? await db.user.findMany({ where: { id: { in: operatorIds } }, select: { id: true, username: true } })
    : [];
  const operatorName = new Map(operators.map((u) => [u.id, u.username] as const));

  const events = rows.map((r) => projectOperatorActionEvent(
    { id: r.id, action: r.action, createdAt: r.createdAt, performedByAdminId: r.performedByAdminId, metadata: r.metadata, subjectUsername: r.user?.username ?? null },
    (r.performedByAdminId && operatorName.get(r.performedByAdminId)) || null,
  ));

  return NextResponse.json({ events } satisfies OperatorActionsResponse);
}
