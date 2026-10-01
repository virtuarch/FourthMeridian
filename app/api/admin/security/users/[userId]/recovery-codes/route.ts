/**
 * POST /api/admin/security/users/[userId]/recovery-codes
 *
 * Regenerates recovery codes for a user.
 * - Invalidates all existing unused codes
 * - Generates 10 new codes
 * - Returns plaintext codes (shown ONCE — never stored in plaintext)
 * - Writes RECOVERY_CODES_REGENERATED to AuditLog
 *
 * Body: { confirmToken: "REGENERATE" }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { systemDb } from "@/lib/db";
import { db } from "@/lib/db";
import { requireFreshSystemAdmin } from "@/lib/session";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  // SEC-2 — destructive (invalidates + regenerates another user's recovery
  // codes). Always a live revocation check, never the cache.
  const [user, err] = await requireFreshSystemAdmin();
  if (err) return err;

  const { userId } = await params;
  const adminId    = user.id;

  const body = await req.json() as { confirmToken?: string };
  if (body.confirmToken !== "REGENERATE") {
    return NextResponse.json({ error: "Confirmation token missing or incorrect." }, { status: 400 });
  }

  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  // OPERATOR authority: these are ANOTHER user's codes. fm_app's RecoveryCode
  // policy is `userId = current_fm_user_id()`, so the tenant role structurally
  // cannot reach them — which is the correct refusal, not an obstacle.
  const codes = await generateRecoveryCodes(systemDb, userId, true /* isRegen */, adminId);

  return NextResponse.json({
    success: true,
    codes,
    warning: "These codes are shown ONCE. Store them securely — they cannot be retrieved again.",
  });
}
