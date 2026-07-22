/**
 * GET /api/platform/security-ops/audit
 *
 * PO1.1 — Security Ops audit feed. A dashboard-scaled read of recent
 * security-relevant audit activity for the `sec_audit_feed` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") — the granted,
 * non-SYSTEM_ADMIN platform staff this feature exists for. It deliberately does
 * NOT reuse /api/admin/audit's requireSystemAdmin gate (which would 403 those
 * users). It reuses that route's QUERY SHAPE only: db.auditLog filtered by the
 * canonical ADMIN_SECURITY_FILTER_ACTIONS set (lib/audit-actions.ts).
 *
 * Scaled down to a card: the most recent RECENT_LIMIT security events, no
 * filter/pagination UI. PII-minimized — action + time + a coarse actor
 * (username or "system"); never email/IP/user-agent.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { ADMIN_SECURITY_FILTER_ACTIONS } from "@/lib/audit-actions";

export const runtime = "nodejs";

const RECENT_LIMIT = 15;

export interface PlatformAuditEvent {
  id:     string;
  action: string;
  at:     string;       // ISO timestamp
  actor:  string;       // username, or "system" when no user is attached
}

export interface PlatformAuditResponse {
  events: PlatformAuditEvent[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  const rows = await db.auditLog.findMany({
    where:   { action: { in: ADMIN_SECURITY_FILTER_ACTIONS } },
    orderBy: { createdAt: "desc" },
    take:    RECENT_LIMIT,
    select:  {
      id:        true,
      action:    true,
      createdAt: true,
      user:      { select: { username: true } },
    },
  });

  const events: PlatformAuditEvent[] = rows.map((r) => ({
    id:     r.id,
    action: r.action,
    at:     r.createdAt.toISOString(),
    actor:  r.user?.username ?? "system",
  }));

  return NextResponse.json({ events } satisfies PlatformAuditResponse);
}
