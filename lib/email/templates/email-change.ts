/**
 * lib/email/templates/email-change.ts  (OPS-2 S3a → email design system)
 *
 * Verification email sent to the NEW address when a user requests an email
 * change. Reuses the `email-verification` sender identity
 * (support@fourthmeridian.com — see lib/email/senders.ts), on the design
 * system's SECURITY variant. The OLD address gets a separate security-alert
 * (lib/email/security-alerts.ts emailChangeRequestedAlert).
 *
 * TOKEN LIFECYCLE IS NOT HERE: app/api/user/email/request writes the hashed
 * token with EMAIL_CHANGE_TTL_MS; this template states the lifetime from the
 * SAME constant and links the pre-built URL (lib/email/email-change-url.ts).
 *
 * PURE: no env, no DB, no token knowledge.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { durationPhrase } from "@/lib/email/design/datetime";
import { EMAIL_CHANGE_TTL_MS } from "@/lib/email/token-ttl";

/** Data the email-change template renders from. */
export interface EmailChangeData {
  /** Absolute, ready-to-click confirmation URL (built via buildEmailChangeUrl). */
  confirmUrl: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export const EMAIL_CHANGE_SUBJECT = "Confirm your new Fourth Meridian email";

export function renderEmailChange(
  data: EmailChangeData,
  opts: { brand?: EmailBrandConfig; ttlMs?: number } = {},
): RenderedEmail {
  const lifetime = durationPhrase(opts.ttlMs ?? EMAIL_CHANGE_TTL_MS);
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}${EMAIL_CHANGE_SUBJECT}`,
    preheader: `Confirm this address within ${lifetime} to finish changing your account email.`,
    variant: "security",
    blocks: [
      { kind: "hero", heading: "Confirm your new email address" },
      { kind: "paragraph", text: "You requested to change the email address on your Fourth Meridian account to this one." },
      { kind: "cta", label: "Confirm new email", url: data.confirmUrl },
      {
        kind: "expiry",
        headline: `This link expires in ${lifetime}.`,
        detail: "Your account email will not change until you confirm.",
      },
      { kind: "security", text: "If you didn't request this, you can ignore this email." },
    ],
    footer: { reason: "You're receiving this email because this address was entered as the new email for a Fourth Meridian account." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const emailChangeTemplate: EmailTemplate<EmailChangeData> = {
  name: "email-change",
  sender: "email-verification",
  render(data: EmailChangeData) {
    return renderEmailChange(data);
  },
};
