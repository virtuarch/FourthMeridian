/**
 * lib/email/send-security-alert.ts
 *
 * sendEmail("security-alert", …) with the alert's DATA built INSIDE the
 * non-throwing contract. A builder in lib/email/security-alerts.ts can throw
 * (e.g. buildAppLink on a malformed NEXT_PUBLIC_APP_URL); built at the call
 * site, that throw escapes sendEmail's render guard and fails the caller's
 * request — for the data export, a 500 with no audit row. Here it becomes an
 * error EmailResult with a FIXED message (never the URL, never the data), so
 * the caller's own flow and audit still complete and no email is sent.
 */

import "server-only";
import type { EmailResult, EmailSendContext } from "@/lib/email/types";
import type { SecurityAlertData } from "@/lib/email/templates/security-alert";
import { sendEmail } from "@/lib/email/send";

export const SECURITY_ALERT_BUILD_ERROR = "security-alert data failed to build";

export async function sendSecurityAlert(
  to: string,
  build: () => SecurityAlertData,
  ctx?: EmailSendContext,
  send: typeof sendEmail = sendEmail,
): Promise<EmailResult> {
  let data: SecurityAlertData;
  try {
    data = build();
  } catch {
    return { status: "error", provider: "none", error: SECURITY_ALERT_BUILD_ERROR };
  }
  return send("security-alert", to, { ...data }, ctx);
}
