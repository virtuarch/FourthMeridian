/**
 * POST /api/auth/verify-email  (OPS-1 S2c — verification consumer)
 *
 * Consumes an email-verification token (issued at registration, S2b) and marks
 * the account's email verified.
 *
 * IDEMPOTENT BY DESIGN: on first success we set emailVerifiedAt but do NOT
 * clear emailVerificationToken/emailVerificationExpiry. A second click on the
 * same still-unexpired link resolves the same user, sees emailVerifiedAt set,
 * and returns { status: "already_verified" } rather than an error. Re-applying
 * verification is a no-op, and — unlike a password-reset token — a reused
 * verification token grants nothing, so keeping it live until its natural 1h
 * expiry is safe. Expiry still bounds the token's lifetime.
 *
 * Token is hashed before lookup (stored hashed at rest, mirroring the
 * password-reset flow). Consumption is POST-only so email-client prefetchers
 * and link scanners hitting the /verify-email PAGE (a GET) never burn a token.
 *
 * Body: { token: string }
 * Responses (always JSON with a `status`):
 *   200 { success: true,  status: "verified" }          — just verified
 *   200 { success: true,  status: "already_verified" }  — was already verified
 *   400 { success: false, status: "expired" }           — link past its TTL
 *   400 { success: false, status: "invalid" }            — no/unknown token
 *
 * DELIBERATELY OUT OF SCOPE (S2c): no login enforcement, no session/JWT change,
 * no resend endpoint. Nothing yet gates access on emailVerifiedAt.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";
import { AuditAction } from "@/lib/audit-actions";
import { limitByIp } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "verify-email", { limit: 10, windowSec: 900 });
    if (limited) return limited;

    const { token } = await req.json().catch(() => ({}));

    if (!token || typeof token !== "string") {
      return NextResponse.json({ success: false, status: "invalid" }, { status: 400 });
    }

    // Look up by hashed token only (no expiry filter yet) so we can tell the
    // already-verified and expired cases apart.
    const user = await db.user.findFirst({
      where:  { emailVerificationToken: hashResetToken(token) },
      select: { id: true, email: true, emailVerifiedAt: true, emailVerificationExpiry: true },
    });

    // Unknown token → invalid (distinct from expired: different user action).
    if (!user) {
      return NextResponse.json({ success: false, status: "invalid" }, { status: 400 });
    }

    // Already verified → idempotent success (token intentionally not cleared).
    if (user.emailVerifiedAt) {
      return NextResponse.json({ success: true, status: "already_verified" });
    }

    // Token present but past its TTL → expired (user should request a new one).
    if (!user.emailVerificationExpiry || user.emailVerificationExpiry <= new Date()) {
      return NextResponse.json({ success: false, status: "expired" }, { status: 400 });
    }

    // First successful verification. Set the timestamp; leave the token/expiry
    // in place (idempotency, bounded by the existing expiry).
    await db.user.update({
      where: { id: user.id },
      data:  { emailVerifiedAt: new Date() },
    });

    await db.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.EMAIL_VERIFIED,
        metadata: { email: user.email },
      },
    });

    return NextResponse.json({ success: true, status: "verified" });
  } catch (err) {
    console.error("[verify-email] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
