/**
 * lib/email/templates/email-change.ts  (OPS-2 S3a)
 *
 * Verification email sent to the NEW address when a user requests an email
 * change. Text-first. Reuses the `email-verification` sender identity
 * (support@fourthmeridian.com — see lib/email/senders.ts) rather than
 * introducing a new sender purpose.
 *
 * Distinct from the registration `email-verification` template: the copy is
 * change-specific ("confirm your new email"), and the link targets the S3b
 * confirm consumer, not the initial-verification consumer.
 *
 * PURE: renders subject + text from a pre-built confirm URL. No env, no DB.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the email-change template renders from. */
export interface EmailChangeData {
  /** Absolute, ready-to-click confirmation URL (built via buildEmailChangeUrl). */
  confirmUrl: string;
}

/** How long the confirmation link is valid — mirrors the request TTL (1 hour). */
const EXPIRY_LABEL = "1 hour";

export const emailChangeTemplate: EmailTemplate<EmailChangeData> = {
  name: "email-change",
  sender: "email-verification",
  render(data: EmailChangeData) {
    return {
      subject: "Confirm your new Fourth Meridian email",
      text:
        `You requested to change the email address on your Fourth Meridian ` +
        `account to this one.\n\n` +
        `Confirm this new address using the link below:\n` +
        `${data.confirmUrl}\n\n` +
        `This link expires in ${EXPIRY_LABEL}. Your account email will not ` +
        `change until you confirm.\n\n` +
        `If you didn't request this, you can safely ignore this email.\n`,
    };
  },
};
