/**
 * POST /api/user/email/request  (OPS-2 S3a — request-side change email)
 *
 * Starts an authenticated email-address change: re-authenticates with the
 * current password, stores the requested address as `pendingEmail` plus a
 * hashed single-use token (1h TTL), sends a confirmation link to the NEW
 * address, and warns the OLD address. The address is NOT swapped here — the
 * S3b confirm consumer performs the swap.
 *
 * Body: { newEmail: string, currentPassword: string }
 *
 * SCOPE (S3a): request only. No swap, no session revocation, no confirm route
 * or page yet — the emitted confirmation link 404s until S3b ships.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { isEmailAvailable } from "@/lib/users/availability";
import { withTenantDb } from "@/lib/db/tenant-context";
import { env } from "@/lib/env";
import { requireFreshUser } from "@/lib/session";
import { hashResetToken } from "@/lib/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { buildEmailChangeUrl } from "@/lib/email/email-change-url";
import { formatDateTime } from "@/lib/format";
import { createNotification } from "@/lib/notifications/create";
import { AuditAction } from "@/lib/audit-actions";
import { limitByIp, limitByUser } from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHANGE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "email-change-request", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    // Sensitive identity action — always a live revocation check, never cache.
    const [user, err] = await requireFreshUser();
    if (err) return err;

    // OPS-1 S4 — per-user limit alongside the per-IP one above: a hijacked
    // session rotating IPs must not get unlimited password-guess attempts here.
    const userLimited = await limitByUser(user.id, "email-change-request", { limit: 5, windowSec: 900 });
    if (userLimited) return userLimited;

    const { newEmail, currentPassword } = await req.json().catch(() => ({}));

    if (!newEmail || !currentPassword) {
      return NextResponse.json({ error: "New email and current password are required." }, { status: 400 });
    }
    if (typeof newEmail !== "string" || !EMAIL_RE.test(newEmail)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    const normalizedNew = newEmail.toLowerCase().trim();

    // RLS slice A — their own row, as them. Each DB step is its own short
    // transaction: bcrypt and two `sendEmail` calls sit between them.
    const dbUser = await withTenantDb(user.id, (tx) => tx.user.findUnique({
      where:  { id: user.id },
      select: { passwordHash: true, email: true },
    }));
    if (!dbUser?.passwordHash) {
      return NextResponse.json({ error: "Account has no password set." }, { status: 400 });
    }

    // ── Re-authenticate (current password only) ───────────────────────────────
    const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
    }

    if (normalizedNew === dbUser.email.toLowerCase()) {
      return NextResponse.json({ error: "That's already your email address." }, { status: 400 });
    }

    // ⚠️ THIS ONE PROBE CANNOT RUN AS THE TENANT, AND THAT IS THE POLICY WORKING.
    // fm_app's `User` SELECT policy is `id = current_fm_user_id()` — a user sees
    // themselves — so asking "does ANOTHER account own this address?" through the
    // tenant role returns nothing and this check would always pass. A cross-user
    // uniqueness question is not tenant-scoped data by definition; it is answered on
    // the deployment-wide client, which is why this file still imports one. It is a
    // SELECT of a single `id` and it is never returned to the caller — the response is
    // the same 409 either way, so it discloses nothing the unique index would not.
    const free = await isEmailAvailable(normalizedNew);
    if (!free) {
      return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
    }

    // ── Store the pending change (hashed token, 1h TTL) ────────────────────────
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiry   = new Date(Date.now() + CHANGE_TTL_MS);

    await withTenantDb(user.id, (tx) => tx.user.update({
      where: { id: user.id },
      data:  {
        pendingEmail:      normalizedNew,
        emailChangeToken:  hashResetToken(rawToken),
        emailChangeExpiry: expiry,
      },
    }));

    // ── Notify (both NON-THROWING) ────────────────────────────────────────────
    const confirmUrl = buildEmailChangeUrl(env.NEXT_PUBLIC_APP_URL, rawToken);
    const newResult = await sendEmail("email-change", normalizedNew, { confirmUrl });
    if (newResult.status === "error") {
      console.error("[email/request] confirmation email failed to send:", newResult.error);
    }

    // Warn the OLD address BEFORE any swap — the strongest takeover defense.
    const oldResult = await sendEmail("security-alert", dbUser.email, {
      title:   "Email change requested",
      message:
        `A change of your Fourth Meridian account email to ${normalizedNew} was ` +
        `requested on ${formatDateTime(new Date().toISOString())}. The change is ` +
        `not complete until confirmed from the new address.`,
    });
    if (oldResult.status === "error") {
      console.error("[email/request] old-address alert failed to send:", oldResult.error);
    }

    const auditRow = await withTenantDb(user.id, (tx) => tx.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.EMAIL_CHANGE_REQUESTED,
        metadata: { newEmail: normalizedNew, emailStatusNew: newResult.status, emailStatusOld: oldResult.status },
      },
    }));

    // OPS-3 S5 Wave 1 — bell mirror. pendingEmail is MASKED at the producer
    // (registry pointer contract): the bell never carries the full new address.
    await createNotification({
      type: "EMAIL_CHANGE_REQUESTED",
      userId: user.id,
      auditLogId: auditRow.id,
      data: { pendingEmail: normalizedNew.replace(/^(.).*(@.*)$/, "$1***$2") },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[email/request] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
