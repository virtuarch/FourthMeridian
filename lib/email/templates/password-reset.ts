/**
 * lib/email/templates/password-reset.ts  (OPS-1 S2a → email design system)
 *
 * The password-reset email. Sends as the `password-reset` identity
 * (support@fourthmeridian.com — see lib/email/senders.ts), built on the shared
 * design system's SECURITY variant (no promotional blocks), so the HTML and
 * plain-text parts come from one block list.
 *
 * TOKEN LIFECYCLE IS NOT HERE. app/api/auth/forgot-password writes the hashed
 * token with PASSWORD_RESET_TTL_MS; app/api/auth/reset-password consumes it once
 * (conditional consume). This template only states the lifetime — read from
 * the SAME constant — and links the pre-built URL (lib/email/reset-url.ts).
 *
 * PURE: no env, no DB, no token knowledge.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { durationPhrase } from "@/lib/email/design/datetime";
import { PASSWORD_RESET_TTL_MS } from "@/lib/email/token-ttl";

/** Data the password-reset template renders from. */
export interface PasswordResetData {
  /** Absolute, ready-to-click reset URL (built via buildResetUrl). */
  resetUrl: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export const PASSWORD_RESET_SUBJECT = "Reset your Fourth Meridian password";

export function renderPasswordReset(
  data: PasswordResetData,
  opts: { brand?: EmailBrandConfig; ttlMs?: number } = {},
): RenderedEmail {
  const lifetime = durationPhrase(opts.ttlMs ?? PASSWORD_RESET_TTL_MS);
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}${PASSWORD_RESET_SUBJECT}`,
    preheader: `Use this link within ${lifetime} to choose a new password.`,
    variant: "security",
    blocks: [
      { kind: "hero", heading: "Reset your password" },
      { kind: "paragraph", text: "We received a request to reset the password for your Fourth Meridian account." },
      { kind: "cta", label: "Reset password", url: data.resetUrl },
      { kind: "expiry", headline: `This link expires in ${lifetime} and can be used once.` },
      {
        kind: "security",
        text: "If you didn't request this, you can ignore this email. Your password won't change unless you use the link above.",
      },
    ],
    footer: { reason: "You're receiving this email because a password reset was requested for your Fourth Meridian account." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const passwordResetTemplate: EmailTemplate<PasswordResetData> = {
  name: "password-reset",
  sender: "password-reset",
  render(data: PasswordResetData) {
    return renderPasswordReset(data);
  },
};
