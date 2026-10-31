/**
 * lib/email/token-ttl.ts
 *
 * THE lifetimes of the single-purpose links Fourth Meridian emails. Each value
 * is read by BOTH the route that writes the token's expiry column AND the
 * template that tells the recipient how long the link works, so the two can
 * never disagree (the templates once hard-coded "1 hour" next to a separate
 * route constant).
 *
 *   PASSWORD_RESET_TTL_MS      app/api/auth/forgot-password → passwordResetExpiry
 *   EMAIL_VERIFICATION_TTL_MS  app/api/auth/register + lib/email/verification.ts
 *                              (resend) → emailVerificationExpiry
 *   EMAIL_CHANGE_TTL_MS        app/api/user/email/request → emailChangeExpiry
 *
 * Pure constants: no imports, no I/O.
 */

/** Password-reset link lifetime: 1 hour. Single use (conditional consume). */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Email-verification link lifetime: 1 hour. Idempotent (not cleared on use); rotated on resend. */
export const EMAIL_VERIFICATION_TTL_MS = 60 * 60 * 1000;

/** Email-change confirmation link lifetime: 1 hour. */
export const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;
