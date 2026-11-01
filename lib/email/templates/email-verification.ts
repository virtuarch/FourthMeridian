/**
 * lib/email/templates/email-verification.ts  (OPS-1 S2b → email design system)
 *
 * The email-verification email (registration + both resend paths). Sends as
 * the `email-verification` identity (support@fourthmeridian.com — see
 * lib/email/senders.ts), on the design system's SECURITY variant.
 *
 * TOKEN LIFECYCLE IS NOT HERE. The register route and lib/email/verification.ts
 * write the hashed token with EMAIL_VERIFICATION_TTL_MS; verify-email accepts it
 * idempotently (not cleared on use); a resend rotates it. This template states
 * the lifetime from the SAME constant and links the pre-built URL
 * (lib/email/verify-url.ts).
 *
 * PURE: no env, no DB, no token knowledge.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { durationPhrase } from "@/lib/email/design/datetime";
import { EMAIL_VERIFICATION_TTL_MS } from "@/lib/email/token-ttl";

/** Data the email-verification template renders from. */
export interface EmailVerificationData {
  /** Absolute, ready-to-click verification URL (built via buildVerifyUrl). */
  verifyUrl: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export const EMAIL_VERIFICATION_SUBJECT = "Verify your Fourth Meridian email";

export function renderEmailVerification(
  data: EmailVerificationData,
  opts: { brand?: EmailBrandConfig; ttlMs?: number } = {},
): RenderedEmail {
  const lifetime = durationPhrase(opts.ttlMs ?? EMAIL_VERIFICATION_TTL_MS);
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}${EMAIL_VERIFICATION_SUBJECT}`,
    preheader: `Confirm your email address within ${lifetime}.`,
    variant: "security",
    blocks: [
      { kind: "hero", heading: "Verify your email address" },
      { kind: "paragraph", text: "Welcome to Fourth Meridian. Please confirm that this is your email address." },
      { kind: "cta", label: "Verify email address", url: data.verifyUrl },
      { kind: "expiry", headline: `This link expires in ${lifetime}.` },
      { kind: "security", text: "If you didn't create a Fourth Meridian account, you can ignore this email." },
    ],
    footer: { reason: "You're receiving this email because a Fourth Meridian account was created with this address." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const emailVerificationTemplate: EmailTemplate<EmailVerificationData> = {
  name: "email-verification",
  sender: "email-verification",
  render(data: EmailVerificationData) {
    return renderEmailVerification(data);
  },
};
