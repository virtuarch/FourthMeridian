/**
 * lib/platform/security/audit-feed.ts  (P12a — Security Ops audit feed reader)
 *
 * The `sec_audit_feed` read, moved verbatim out of
 * GET /api/platform/security-ops/audit (pure move; pinned old-vs-new by
 * ./p12a-readers.test.ts). The route keeps its gate —
 * requirePlatformAccess("SECURITY_OPS", "READ") — and calls this reader.
 *
 * QUERY SHAPE: auditLog filtered by the canonical ADMIN_SECURITY_FILTER_ACTIONS
 * set (lib/audit-actions.ts), most recent RECENT_LIMIT first. PII-minimized —
 * action + time + a coarse actor (username or "system"); never email/IP/user-agent.
 *
 * AUTHORITY: the caller passes its client; there is no default (a `?? db`
 * default would be an implicit migration-principal read — scripts/audit-db-authority.ts).
 */

import type { PrismaClient } from "@prisma/client";
import { ADMIN_SECURITY_FILTER_ACTIONS } from "@/lib/audit-actions";

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

/** The only model this reader touches. */
export type SecurityAuditFeedClient = Pick<PrismaClient, "auditLog">;

export async function readSecurityAuditFeed(client: SecurityAuditFeedClient): Promise<PlatformAuditResponse> {
  const rows = await client.auditLog.findMany({
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

  return { events };
}
