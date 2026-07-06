/**
 * lib/email/verification.ts  (OPS-1 S2d)
 *
 * Shared core for RESENDING an email-verification link. Both resend entry
 * points (token-based from the expired page, identifier-based from login) call
 * this one function so the rotate/send/audit behavior can never drift between
 * them.
 *
 * ROTATE-ALWAYS: every resend mints a fresh token with a fresh 1h expiry and
 * stores only the hash (mirroring registration / password-reset). This
 * invalidates any prior outstanding link and keeps the semantics trivial to
 * reason about.
 *
 * NON-THROWING send: a provider failure is logged and reflected in the return
 * value; it never throws into the caller (the route decides how much to
 * reveal — the identifier path reveals nothing).
 *
 * NOTE: registration (app/api/auth/register/route.ts) has its own inline
 * first-send and is intentionally NOT refactored to use this — S2d does not
 * modify registration.
 */

import "server-only";
import crypto from "crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { hashResetToken } from "@/lib/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { buildVerifyUrl } from "@/lib/email/verify-url";
import { AuditAction } from "@/lib/audit-actions";

/** Token TTL for a resent verification link — mirrors registration (1 hour). */
const VERIFICATION_TTL_MS = 60 * 60 * 1000;

/** Minimal user shape the core needs. */
export interface ResendTargetUser {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
}

/** Outcome of a resend attempt for a resolved user. */
export type ResendOutcome =
  | "already_verified" // user is already verified — nothing sent
  | "sent"             // token rotated and a fresh link dispatched
  | "error";           // send failed (token was still rotated; caller logs)

/**
 * Rotate this user's verification token and send a fresh link — unless they are
 * already verified, in which case this is a no-op.
 *
 * Returns an outcome the caller maps onto its own response contract. The
 * identifier-based route deliberately discards the distinction (always generic
 * success); the token-based route may surface it.
 */
export async function rotateAndSendVerification(
  user: ResendTargetUser,
): Promise<ResendOutcome> {
  if (user.emailVerifiedAt) return "already_verified";

  // Rotate: fresh token + fresh expiry, hash at rest. Invalidates prior links.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiry   = new Date(Date.now() + VERIFICATION_TTL_MS);

  await db.user.update({
    where: { id: user.id },
    data:  {
      emailVerificationToken:  hashResetToken(rawToken),
      emailVerificationExpiry: expiry,
    },
  });

  const verifyUrl = buildVerifyUrl(env.NEXT_PUBLIC_APP_URL, rawToken);
  const result = await sendEmail("email-verification", user.email, { verifyUrl });

  if (result.status === "error") {
    console.error("[verify-email/resend] verification email failed to send:", result.error);
    return "error";
  }

  await db.auditLog.create({
    data: {
      userId:   user.id,
      action:   AuditAction.EMAIL_VERIFICATION_RESENT,
      metadata: { email: user.email },
    },
  });

  return "sent";
}
