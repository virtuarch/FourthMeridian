/**
 * GET /api/user/security-history  (OPS-2 S1)
 *
 * Returns the authenticated user's OWN recent security events for the Security
 * Center. Read-only.
 *
 * SAFETY:
 *   - Scoped to `userId = <caller>` — never another user's rows.
 *   - Filtered to the SECURITY_HISTORY_ACTIONS allowlist — no Space/finance/AI
 *     activity leaks into the security log.
 *   - Returns SAFE FIELDS ONLY: action, label, createdAt, ipAddress, parsed
 *     user-agent, and a curated `reason` from metadata (for failed events).
 *     Raw metadata is never returned wholesale.
 *   - Fixed cap of 50 (S1) — no pagination yet.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { parseUserAgent } from "@/lib/ua-parser";
import { SECURITY_HISTORY_ACTIONS, securityHistoryLabel } from "@/lib/security-history";

const HISTORY_LIMIT = 50;

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const rows = await db.auditLog.findMany({
    where:   { userId: user.id, action: { in: SECURITY_HISTORY_ACTIONS } },
    orderBy: { createdAt: "desc" },
    take:    HISTORY_LIMIT,
    select:  { id: true, action: true, createdAt: true, ipAddress: true, userAgent: true, metadata: true },
  });

  const events = rows.map((r) => {
    // Surface only a curated `reason` string from metadata (present on failed
    // logins / password-change failures). Never echo raw metadata — it can
    // carry emails or other fields we don't want on this surface.
    const meta = (r.metadata ?? null) as { reason?: unknown } | null;
    const reason = meta && typeof meta.reason === "string" ? meta.reason : null;

    return {
      id:        r.id,
      action:    r.action,
      label:     securityHistoryLabel(r.action),
      createdAt: r.createdAt,
      ipAddress: r.ipAddress,
      parsed:    parseUserAgent(r.userAgent ?? ""),
      reason,
    };
  });

  return NextResponse.json({ events });
}
