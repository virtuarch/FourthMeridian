/**
 * DELETE /api/user/sessions/[sessionId]
 *
 * Revoke one of the current user's own sessions.
 * Revoking the current session requires an explicit confirmSelf=true flag.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { requireUser } from "@/lib/session";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { sessionId }  = await params;
  const userId         = user.id;
  const currentToken   = user.sessionToken ?? null;
  const confirmSelf    = req.nextUrl.searchParams.get("confirmSelf") === "true";

  // Load the target session — must belong to this user
  const target = await db.userSession.findFirst({
    where: { id: sessionId, userId },
  });

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

  await db.$transaction([
    db.userSession.update({
      where: { id: sessionId },
      data:  { revokedAt: new Date() },
    }),
    db.auditLog.create({
      data: {
        userId,
        action:   AuditAction.SESSION_REVOKED,
        metadata: { sessionId, isCurrent: !!isCurrent },
      },
    }),
  ]);

  return NextResponse.json({ success: true, isCurrent: !!isCurrent });
}
