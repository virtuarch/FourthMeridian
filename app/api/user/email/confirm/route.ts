/**
 * POST /api/user/email/confirm  (OPS-2 S3b — change-email confirm & swap)
 *
 * Consumes the email-change token issued by S3a and swaps the account email to
 * the pending address.
 *
 * TOKEN-AUTHENTICATED, NOT SESSION-AUTHENTICATED: the confirmation link is
 * usually clicked from the new inbox while logged out, so the hashed token is
 * the bearer authorization (bound to one specific pending change). POST-only,
 * so email prefetchers / link scanners hitting the /confirm-email-change PAGE
 * (a GET) never burn the token. Rate-limited.
 *
 * NON-IDEMPOTENT (unlike verify-email): a successful swap CLEARS the token, so
 * a second click resolves no user → { status: "invalid" }. Correct for a
 * one-time state transition.
 *
 * Body: { token: string }
 * Responses (always JSON with a `status`):
 *   200 { success: true,  status: "changed", newEmail }  — swapped
 *   400 { success: false, status: "expired" }            — link past its TTL
 *   400 { success: false, status: "email_taken" }        — address now in use
 *   400 { success: false, status: "invalid" }            — no/unknown token or no pending change
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";
import { revokeAllUserSessions } from "@/lib/sessions";
import { AuditAction } from "@/lib/audit-actions";
import { limitByIp } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "email-change-confirm", { limit: 10, windowSec: 900 });
    if (limited) return limited;

    const { token } = await req.json().catch(() => ({}));

    if (!token || typeof token !== "string") {
      return NextResponse.json({ success: false, status: "invalid" }, { status: 400 });
    }

    // Hashed-token lookup (no expiry filter yet, so we can distinguish expired).
    const user = await db.user.findFirst({
      where:  { emailChangeToken: hashResetToken(token) },
      select: { id: true, email: true, pendingEmail: true, emailChangeExpiry: true },
    });

    // Unknown token, or a token with no pending change (consumed/cancelled).
    if (!user || !user.pendingEmail) {
      return NextResponse.json({ success: false, status: "invalid" }, { status: 400 });
    }

    // Past its TTL → expired (user re-requests from Settings).
    if (!user.emailChangeExpiry || user.emailChangeExpiry <= new Date()) {
      return NextResponse.json({ success: false, status: "expired" }, { status: 400 });
    }

    const oldEmail = user.email;
    const newEmail = user.pendingEmail;

    // Re-check uniqueness immediately before swapping (someone else may have
    // claimed the address since the request). The unique index is the final
    // arbiter — this is the friendly early rejection.
    const taken = await db.user.findFirst({
      where:  { email: newEmail, NOT: { id: user.id } },
      select: { id: true },
    });
    if (taken) {
      return NextResponse.json({ success: false, status: "email_taken" }, { status: 400 });
    }

    // ── Swap (one transaction) ────────────────────────────────────────────────
    // email = pendingEmail; re-stamp emailVerifiedAt so S2e block-mode never
    // locks the user out; clear the pending-change columns (single-use).
    try {
      await db.user.update({
        where: { id: user.id },
        data:  {
          email:             newEmail,
          emailVerifiedAt:   new Date(),
          pendingEmail:      null,
          emailChangeToken:  null,
          emailChangeExpiry: null,
        },
      });
    } catch (e) {
      // Lost a race on the unique email index → address no longer available.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return NextResponse.json({ success: false, status: "email_taken" }, { status: 400 });
      }
      throw e;
    }

    // Identity change → revoke every session; the user re-authenticates with
    // the new email.
    const revokedSessions = await revokeAllUserSessions(user.id);

    await db.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.EMAIL_CHANGE_COMPLETED,
        metadata: { oldEmail, newEmail, revokedSessions },
      },
    });

    return NextResponse.json({ success: true, status: "changed", newEmail });
  } catch (err) {
    console.error("[email/confirm] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
