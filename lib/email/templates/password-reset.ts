/**
 * lib/email/templates/password-reset.ts  (OPS-1 S2a)
 *
 * The password-reset email. First real transactional template on the seam.
 * Text-first (no HTML framework), sends as the `password-reset` identity
 * (support@fourthmeridian.com — see lib/email/senders.ts).
 *
 * The template is PURE: it renders subject + text from a pre-built absolute
 * reset URL. It does not build the URL, read env, or know about tokens — the
 * route assembles the URL via lib/email/reset-url.ts and passes it in.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the password-reset template renders from. */
export interface PasswordResetData {
  /** Absolute, ready-to-click reset URL (built via buildResetUrl). */
  resetUrl: string;
}

/** How long the reset link is valid — mirrors the route's TOKEN_TTL (1 hour). */
const EXPIRY_LABEL = "1 hour";

export const passwordResetTemplate: EmailTemplate<PasswordResetData> = {
  name: "password-reset",
  sender: "password-reset",
  render(data: PasswordResetData) {
    return {
      subject: "Reset your Fourth Meridian password",
      text:
        `We received a request to reset the password for your Fourth Meridian account.\n\n` +
        `Reset your password using the link below:\n` +
        `${data.resetUrl}\n\n` +
        `This link expires in ${EXPIRY_LABEL} and can be used once.\n\n` +
        `If you didn't request this, you can safely ignore this email — your ` +
        `password won't change until you use the link above.\n`,
    };
  },
};
