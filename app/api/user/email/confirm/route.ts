/**
 * POST /api/user/email/confirm  (OPS-2 S3b — change-email confirm & swap)
 *
 * Consumes the email-change token issued by S3a and swaps the account email to
 * the pending address.
 *
 * TOKEN-AUTHENTICATED, NOT SESSION-AUTHENTICATED: the confirmation link is
 * usually clicked from the new inbox while logged out, so the hashed token is
 * the bearer authorization (bound to one specific pending change). Rate-limited.
 *
 * IDEMPOTENT within the token TTL (OPS-2 UX fix). The confirm page auto-POSTs on
 * load, so any entity that loads the URL and runs its JS — an email-link
 * pre-scanner, a SafeLinks/redirect pre-check, or a browser refresh — can fire
 * the confirm before the human's own click renders. Previously the swap cleared
 * the token, so that second POST resolved no user and the human saw a false
 * "Invalid link" even though the email had already changed. Now the swap does
 * NOT clear pendingEmail / emailChangeToken / emailChangeExpiry; the 1h expiry
 * bounds the token instead. A repeated confirmation whose account email already
 * equals pendingEmail (isEmailChangeAlreadyApplied) returns "changed" without
 * re-swapping, re-revoking sessions, or duplicating the audit row. The lingering
 * columns are a no-op (email already equals pendingEmail); Settings/export treat
 * that state as "no pending change".
 *
 * Body: { token: string }
 * Responses (always JSON with a `status`):
 *   200 { success: true,  status: "changed", newEmail }  — swapped, or idempotent repeat
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
import { isEmailChangeAlreadyApplied } from "@/lib/email/email-change-confirm";
import { createNotification } from "@/lib/notifications/create";

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

    // Idempotent success (OPS-2 UX fix): the swap already happened for this
    // token's target (email already equals pendingEmail), so a repeated confirm
    // — from a scanner/redirect pre-check or a browser refresh — returns
    // "changed" without re-swapping, re-revoking sessions, or writing a second
    // EMAIL_CHANGE_COMPLETED audit row. This is what prevents the false
    // "Invalid link" the human used to see after the email had already changed.
    if (isEmailChangeAlreadyApplied(user)) {
      return NextResponse.json({ success: true, status: "changed", newEmail: user.pendingEmail });
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

    // ── Swap ───────────────────────────────────────────────────────────────────
    // email = pendingEmail; re-stamp emailVerifiedAt so S2e block-mode never
    // locks the user out. OPS-2 UX fix: do NOT clear pendingEmail /
    // emailChangeToken / emailChangeExpiry here — leaving them lets a repeated
    // confirmation of the same token hit the idempotent branch above ("changed")
    // instead of a false "invalid". The 1h expiry bounds the token; the lingering
    // columns are a harmless no-op (email now equals pendingEmail) and are
    // overwritten by the next email-change request. Settings/export treat
    // email === pendingEmail as "no pending change".
    try {
      await db.user.update({
        where: { id: user.id },
        data:  {
          email:           newEmail,
          emailVerifiedAt: new Date(),
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

    const auditRow = await db.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.EMAIL_CHANGE_COMPLETED,
        metadata: { oldEmail, newEmail, revokedSessions },
      },
    });

    // OPS-3 S5 Wave 1 — bell mirror, seen on next sign-in (all sessions were
    // just revoked). Non-throwing.
    await createNotification({
      type: "EMAIL_CHANGE_COMPLETED",
      userId: user.id,
      auditLogId: auditRow.id,
    });

    return NextResponse.json({ success: true, status: "changed", newEmail });
  } catch (err) {
    console.error("[email/confirm] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
