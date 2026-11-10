/**
 * lib/platform/security/operator-actions.ts  (P12a — operator action feed reader)
 *
 * The Security Ops "operator action feed" read, moved verbatim out of
 * GET /api/platform/security-ops/operator-actions (pure move; pinned
 * old-vs-new by ./p12a-readers.test.ts). The route keeps its gate —
 * requirePlatformAccess("SECURITY_OPS", "READ") — and calls this reader.
 *
 * Pure projection over AuditLog through ./operator-actions-core.ts — no write,
 * no customer financial data. PII-minimized: operator username, action, coarse
 * target, reason CODE (never the note), result, opaque execution references.
 * Never email/IP/user-agent, never AuditLog.metadata verbatim.
 *
 * AUTHORITY: the caller passes its client; there is no default.
 */

import type { PrismaClient } from "@prisma/client";
import { OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { projectOperatorActionEvent, type OperatorActionEvent } from "./operator-actions-core";

const RECENT_LIMIT = 20;

export type { OperatorActionEvent };

export interface OperatorActionsResponse {
  events: OperatorActionEvent[];
}

/** The only models this reader touches. */
export type OperatorActionFeedClient = Pick<PrismaClient, "auditLog" | "user">;

export async function readOperatorActionFeed(client: OperatorActionFeedClient): Promise<OperatorActionsResponse> {
  const rows = await client.auditLog.findMany({
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
    ? await client.user.findMany({ where: { id: { in: operatorIds } }, select: { id: true, username: true } })
    : [];
  const operatorName = new Map(operators.map((u) => [u.id, u.username] as const));

  const events = rows.map((r) => projectOperatorActionEvent(
    { id: r.id, action: r.action, createdAt: r.createdAt, performedByAdminId: r.performedByAdminId, metadata: r.metadata, subjectUsername: r.user?.username ?? null },
    (r.performedByAdminId && operatorName.get(r.performedByAdminId)) || null,
  ));

  return { events };
}
