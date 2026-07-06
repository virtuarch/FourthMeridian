/**
 * lib/email/templates/email-verification.ts  (OPS-1 S2b)
 *
 * The email-verification email. Text-first, sends as the `email-verification`
 * identity (support@fourthmeridian.com — see lib/email/senders.ts).
 *
 * PURE: renders subject + text from a pre-built absolute verify URL. It does
 * not build the URL, read env, or know about tokens — the register route
 * assembles the URL via lib/email/verify-url.ts and passes it in.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the email-verification template renders from. */
export interface EmailVerificationData {
  /** Absolute, ready-to-click verification URL (built via buildVerifyUrl). */
  verifyUrl: string;
}

/** How long the verification link is valid — mirrors the register TTL (1 hour). */
const EXPIRY_LABEL = "1 hour";

export const emailVerificationTemplate: EmailTemplate<EmailVerificationData> = {
  name: "email-verification",
  sender: "email-verification",
  render(data: EmailVerificationData) {
    return {
      subject: "Verify your Fourth Meridian email",
      text:
        `Welcome to Fourth Meridian!\n\n` +
        `Please confirm this is your email address by visiting the link below:\n` +
        `${data.verifyUrl}\n\n` +
        `This link expires in ${EXPIRY_LABEL}.\n\n` +
        `If you didn't create a Fourth Meridian account, you can safely ignore ` +
        `this email.\n`,
    };
  },
};
