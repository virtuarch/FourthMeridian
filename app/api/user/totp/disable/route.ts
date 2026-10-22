/**
 * POST /api/user/totp/disable
 *
 * Disables TOTP 2FA for the authenticated user.
 *
 * Requires one of (B4, 2026-10-23 — the password-only path is gone):
 *   - { totpCode: "123456" }                      — a FRESH code from the authenticator.
 *     Single-use for this action: the matched 30 s step is claimed in RateLimit
 *     (unique key + windowStart), so a captured code cannot disable twice.
 *   - { recoveryCode: "...", password: "..." }    — lost device: BOTH the account
 *     password and an unused recovery code, consumed atomically (verifyRecoveryCode).
 * A password alone is refused: it is the factor a session thief is most likely to
 * hold, and turning 2FA off must take the second factor. Operators keep the
 * separate audited reset (POST /api/admin/security/users/[userId]/2fa-reset).
 *
 * On success:
 *   - Clears totpSecret + sets totpEnabled = false
 *   - Deletes all recovery codes
 *   - Writes TWO_FACTOR_DISABLED audit log
 *
 * Security notes:
 *   - Both verification paths are required — cannot bypass by omitting both.
 *   - TOTP code verification uses ±1 window to handle clock drift.
 *   - Rate-limited per user (OPS-1 S4) — the password fallback is otherwise
 *     brute-forceable from a hijacked session.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import { matchTOTPStep } from "@/lib/totp";
import { verifyRecoveryCode } from "@/lib/recovery-codes";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { requireFreshUser } from "@/lib/session";
import { createNotification } from "@/lib/notifications/create";
import { limitByUser } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // Sensitive action (disables 2FA) — always a live revocation check.
  const [user, err] = await requireFreshUser();
  if (err) return err;

  const limited = await limitByUser(user.id, "totp-disable", { limit: 5, windowSec: 900 });
  if (limited) return limited;

  const body         = await req.json().catch(() => ({}));
  const totpCode     = typeof body.totpCode === "string" ? body.totpCode.replace(/\s/g, "") : "";
  const recoveryCode = typeof body.recoveryCode === "string" ? body.recoveryCode.trim() : "";
  const password     = typeof body.password === "string" ? body.password : "";

  if (!totpCode && !(recoveryCode && password)) {
    return NextResponse.json(
      { error: "Enter the current 6-digit code from your authenticator app. Lost your device? Use a recovery code together with your password." },
      { status: 400 },
    );
  }

  // RLS slice A — their own row, as them. Decryption, TOTP verification and bcrypt
  // all happen below, outside any transaction.
  const dbUser = await withTenantDb(user.id, (tx) => tx.user.findUnique({
    where:  { id: user.id },
    select: { totpEnabled: true, totpSecret: true, passwordHash: true },
  }));

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!dbUser.totpEnabled) {
    return NextResponse.json({ error: "2FA is not enabled." }, { status: 400 });
  }

  // ── Verify identity ──────────────────────────────────────────────────────────
  let verified = false;

  if (totpCode) {
    if (!dbUser.totpSecret) {
      return NextResponse.json({ error: "Verification failed. Check your code." }, { status: 400 });
    }
    let step: number | null;
    try {
      const secret = decryptWithPurpose(dbUser.totpSecret, EncryptionPurpose.TOTP_SECRET);
      step = matchTOTPStep(totpCode, secret, 1);
    } catch {
      return NextResponse.json({ error: "Failed to verify code." }, { status: 500 });
    }
    if (step === null) {
      return NextResponse.json({ error: "Verification failed. Check your code." }, { status: 400 });
    }
    // Replay guard: claim the step. A second request presenting a code from the
    // SAME step hits the (key, windowStart) unique index and is refused. Its own
    // tenant phase: a unique violation aborts the transaction it happens in.
    const claimed = await withTenantDb(user.id, (tx) => tx.rateLimit.create({
      data: { key: `user:totp-disable-step:${user.id}`, windowStart: new Date(step * 30_000), count: 1 },
      select: { id: true },
    })).then(() => true, (e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
      throw e;
    });
    if (!claimed) {
      return NextResponse.json({ error: "That code was already used. Wait for the next code and try again." }, { status: 400 });
    }
    verified = true;
  } else {
    // Lost device: password AND a single-use recovery code.
    const passwordOk = !!dbUser.passwordHash && await bcrypt.compare(password, dbUser.passwordHash);
    if (passwordOk) {
      verified = await withTenantDb(user.id, (tx) => verifyRecoveryCode(tx, user.id, recoveryCode));
    }
  }

  if (!verified) {
    return NextResponse.json(
      { error: "Verification failed. Check your code, or your recovery code and password." },
      { status: 400 },
    );
  }

  // ── Disable 2FA ──────────────────────────────────────────────────────────────
  // ⚠️ THE BATCH ARRAY BECAME THE TENANT TRANSACTION ITSELF — same three writes,
  // same single commit, now carrying `app.user_id`. Note the DELETE: fm_app holds
  // SELECT/INSERT/UPDATE/DELETE on RecoveryCode (policy `userId = me`), whereas
  // fm_auth holds only SELECT and UPDATE. Destroying a user's codes is POST-identity
  // tenant work and belongs here, which is exactly why this route does it itself.
  const auditRow = await withTenantDb(user.id, async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data:  { totpSecret: null, totpEnabled: false },
    });
    await tx.recoveryCode.deleteMany({
      where: { userId: user.id },
    });
    return tx.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.TWO_FACTOR_DISABLED,
      },
    });
  });

  // OPS-3 S5 Wave 1 — bell mirror, AFTER the transaction commits (fact first,
  // ping second). Non-throwing.
  await createNotification({
    type: "TWO_FACTOR_DISABLED",
    userId: user.id,
    auditLogId: auditRow.id,
  });

  return NextResponse.json({ ok: true });
}
