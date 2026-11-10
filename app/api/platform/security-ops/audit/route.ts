/**
 * GET /api/platform/security-ops/audit
 *
 * PO1.1 — Security Ops audit feed. A dashboard-scaled read of recent
 * security-relevant audit activity for the `sec_audit_feed` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") — the granted,
 * non-SYSTEM_ADMIN platform staff this feature exists for. It deliberately does
 * NOT reuse /api/admin/audit's requireSystemAdmin gate (which would 403 those
 * users). It reuses that route's QUERY SHAPE only: auditLog filtered by the
 * canonical ADMIN_SECURITY_FILTER_ACTIONS set (lib/audit-actions.ts).
 *
 * P12a: the read lives in lib/platform/security/audit-feed.ts (pure move);
 * this route is gate → reader → JSON.
 *
 * Scaled down to a card: the most recent security events, no
 * filter/pagination UI. PII-minimized — action + time + a coarse actor
 * (username or "system"); never email/IP/user-agent.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readSecurityAuditFeed, type PlatformAuditResponse } from "@/lib/platform/security/audit-feed";

export const runtime = "nodejs";

export type { PlatformAuditEvent, PlatformAuditResponse } from "@/lib/platform/security/audit-feed";

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  return NextResponse.json((await readSecurityAuditFeed(db)) satisfies PlatformAuditResponse);
}
