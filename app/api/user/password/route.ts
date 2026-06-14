/**
 * PATCH /api/user/password
 *
 * Changes the authenticated user's password.
 * Requires the current password to prevent unauthorized changes
 * from hijacked sessions.
 *
 * Body: { currentPassword: string, newPassword: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { requireUser } from "@/lib/session";
import { withApiHandler } from "@/lib/api";

export const PATCH = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const { currentPassword, newPassword } = await req.json();

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Both current and new password are required." }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 });
  }
  if (currentPassword === newPassword) {
    return NextResponse.json({ error: "New password must be different from current password." }, { status: 400 });
  }

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { passwordHash: true },
  });

  if (!dbUser?.passwordHash) {
    return NextResponse.json({ error: "Account has no password set." }, { status: 400 });
  }

  const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
  if (!valid) {
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: "PASSWORD_CHANGE_FAILED",
        metadata: { reason: "wrong_current_password" },
      },
    });
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  await db.user.update({
    where: { id: user.id },
    data:  { passwordHash: newHash },
  });

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "PASSWORD_CHANGED",
    },
  });

  return NextResponse.json({ success: true });
}, "PATCH /api/user/password");
