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
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const user = await db.user.findUnique({
    where:  { id: session.user.id },
    select: { passwordHash: true },
  });

  if (!user?.passwordHash) {
    return NextResponse.json({ error: "Account has no password set." }, { status: 400 });
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "PASSWORD_CHANGE_FAILED",
        metadata: { reason: "wrong_current_password" },
      },
    });
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  await db.user.update({
    where: { id: session.user.id },
    data:  { passwordHash: newHash },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "PASSWORD_CHANGED",
    },
  });

  return NextResponse.json({ success: true });
}
