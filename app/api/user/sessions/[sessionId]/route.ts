/**
 * DELETE /api/user/sessions/[sessionId]
 *
 * Revoke one of the current user's own sessions.
 * Revoking the current session requires an explicit confirmSelf=true flag.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { AuditAction } from "@/lib/audit-actions";
import { requireFreshUser } from "@/lib/session";
import { invalidateSession } from "@/lib/session-cache";
import { createNotification } from "@/lib/notifications/create";
import { parseUserAgent } from "@/lib/ua-parser";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  // Sensitive action — always a live revocation check, never the cache.
  const [user, err] = await requireFreshUser();
  if (err) return err;

  const { sessionId }  = await params;
  const userId         = user.id;
  const currentToken   = user.sessionToken ?? null;
  const confirmSelf    = req.nextUrl.searchParams.get("confirmSelf") === "true";

  // Load the target session — must belong to this user
  // RLS slice A — the guard read, as the user. Kept as its own short transaction so
  // the original two-step shape (check, then write) is preserved exactly.
  const target = await withTenantDb(userId, (tx) => tx.userSession.findFirst({
    where: { id: sessionId, userId },
  }));

  if (!target) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (target.revokedAt) return NextResponse.json({ error: "Session already revoked." }, { status: 400 });

  // Guard: revoking current session requires explicit confirmation
  const isCurrent = currentToken && target.sessionToken === currentToken;
  if (isCurrent && !confirmSelf) {
    return NextResponse.json(
      { error: "This is your current session. Pass confirmSelf=true to revoke it anyway.", isCurrent: true },
      { status: 400 },
    );
  }

  // ⚠️ THE BATCH ARRAY BECAME AN INTERACTIVE TRANSACTION, AND IT IS THE SAME ONE
  // THAT CARRIES THE IDENTITY. `withTenantDb` opens exactly one transaction and sets
  // `app.user_id` inside it, so the revocation and its audit row commit together, as
  // before — a `db.$transaction([...])` could not have carried the identity at all.
  const auditRow = await withTenantDb(userId, async (tx) => {
    await tx.userSession.update({
      where: { id: sessionId },
      data:  { revokedAt: new Date() },
    });
    return tx.auditLog.create({
      data: {
        userId,
        action:   AuditAction.SESSION_REVOKED,
        metadata: { sessionId, isCurrent: !!isCurrent },
      },
    });
  });

  // We have the exact token that was just revoked — targeted invalidation
  // instead of clearing the whole cache.
  invalidateSession(target.sessionToken);

  // OPS-3 S5 Wave 1 — bell mirror. `device` is the parsed display label the
  // Active Sessions surface already shows (never the raw UA). Skipped for a
  // self-revocation of the CURRENT session — the user is watching themselves
  // sign out; a ping would be noise.
  if (!isCurrent) {
    const parsed = parseUserAgent(target.userAgent ?? "");
    await createNotification({
      type: "SESSION_REVOKED",
      userId,
      auditLogId: auditRow.id,
      data: { device: [parsed.browser, parsed.os].filter(Boolean).join(" · ") || "A device" },
    });
  }

  return NextResponse.json({ success: true, isCurrent: !!isCurrent });
}
