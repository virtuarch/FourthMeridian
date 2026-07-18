/**
 * GET /api/platform/security-ops/operator-actions  (PO-3A)
 *
 * The Security Ops "operator action feed" — what platform operators (and
 * SYSTEM_ADMINs) DID to the platform: grant changes, manual operations, beta
 * decisions, operator-driven account state changes. These AuditLog rows already
 * exist (every operator write records one with `performedByAdminId`); this route
 * is the read surface that was missing — the standard security audit feed filters
 * on end-user auth events and never selected these.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ"). Pure projection
 * over AuditLog — no write, no new permission, no customer financial data.
 *
 * PII-minimized: the acting operator's username, the action, a coarse target
 * label (subject username or a non-PII metadata token), and the time. Never
 * email/IP/user-agent, never AuditLog.metadata verbatim.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";

export const runtime = "nodejs";

const RECENT_LIMIT = 20;

export interface OperatorActionEvent {
  id:       string;
  action:   string;
  at:       string;           // ISO timestamp
  operator: string;           // acting operator's username, or "operator" if unresolved
  target:   string | null;    // subject username or a non-PII metadata token
}

export interface OperatorActionsResponse {
  events: OperatorActionEvent[];
}

/** Pull a coarse, non-PII target label from an operator audit row's metadata. */
function targetLabel(metadata: unknown, subjectUsername: string | null): string | null {
  if (subjectUsername) return subjectUsername;
  if (metadata && typeof metadata === "object") {
    const m = metadata as Record<string, unknown>;
    // Non-PII tokens only: an operation's command/target, or a grant's area — never email.
    for (const key of ["commandId", "targetJob", "area", "level"]) {
      const v = m[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return null;
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

  const events: OperatorActionEvent[] = rows.map((r) => ({
    id:       r.id,
    action:   r.action,
    at:       r.createdAt.toISOString(),
    operator: (r.performedByAdminId && operatorName.get(r.performedByAdminId)) || "operator",
    target:   targetLabel(r.metadata, r.user?.username ?? null),
  }));

  return NextResponse.json({ events } satisfies OperatorActionsResponse);
}
