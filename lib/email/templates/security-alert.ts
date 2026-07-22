/**
 * lib/email/templates/security-alert.ts  (OPS-2 S2)
 *
 * Generic security-alert email. Text-first, sends as the `security-alert`
 * identity (support@fourthmeridian.com — see lib/email/senders.ts).
 *
 * Deliberately GENERIC ({ title, message }) so future account-security events
 * (new-device login, 2FA changes, etc.) reuse this one template instead of
 * adding a template per event. OPS-2 S2's first caller is the password-change
 * route.
 *
 * PURE: renders subject + text from pre-resolved strings. No env, no DB.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the security-alert template renders from. */
export interface SecurityAlertData {
  /** Short headline, also used as the subject (e.g. "Your password was changed"). */
  title: string;
  /** Body detail — what happened, when, and what to do if it wasn't them. */
  message: string;
}

export const securityAlertTemplate: EmailTemplate<SecurityAlertData> = {
  name: "security-alert",
  sender: "security-alert",
  render(data: SecurityAlertData) {
    return {
      subject: `Fourth Meridian security alert: ${data.title}`,
      text:
        `${data.message}\n\n` +
        `If this was you, no action is needed. If you don't recognize this ` +
        `activity, reset your password immediately and review your active ` +
        `sessions in Settings.\n`,
    };
  },
};
