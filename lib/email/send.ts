/**
 * lib/email/send.ts  (OPS-1 S1)
 *
 * THE single transactional-email chokepoint. Every future email flow calls
 * sendEmail() — nothing else. This file is PROVIDER-AGNOSTIC: it imports the
 * two transports through the EmailProvider contract and never touches an email
 * SDK (the Resend SDK is imported only in lib/email/providers/resend.ts).
 *
 * PIPELINE
 *   1. Look up the template by name (typed registry).
 *   2. Render subject + text from the caller's data (pure).
 *   3. Resolve the sender identity for the template's purpose.
 *   4. Select a transport and send.
 *
 * TRANSPORT SELECTION (mirrors lib/rate-limit.ts backend selection):
 *   - NODE_ENV === "test"      → capture ALWAYS. The chokepoint refuses a real
 *                                send in test mode, so unit tests never hit the
 *                                network or need credentials.
 *   - RESEND_API_KEY present   → the real Resend adapter.
 *   - otherwise (dev, no key)  → capture. Local dev needs no credentials.
 *
 * NON-THROWING: returns an EmailResult; callers branch on `status`.
 */

import "server-only";
import type { EmailMessage, EmailResult, EmailTemplateName } from "@/lib/email/types";
import { getTemplate } from "@/lib/email/templates";
import { resolveSender } from "@/lib/email/senders";
import { resendAdapter } from "@/lib/email/providers/resend";
import { captureAdapter } from "@/lib/email/providers/capture";

/** Pick the transport for the current environment. */
function selectTransport() {
  // Test mode never sends for real, regardless of whether a key is present.
  if (process.env.NODE_ENV === "test") return captureAdapter;
  // Real delivery only when a key is configured; otherwise capture in dev.
  if (process.env.RESEND_API_KEY) return resendAdapter;
  return captureAdapter;
}

/**
 * Send a transactional email by template name.
 *
 * @param name  Registry key of the template to render.
 * @param to    Recipient address.
 * @param data  Template data (shape defined by the named template).
 * @returns     A non-throwing EmailResult.
 */
export async function sendEmail(
  name: EmailTemplateName,
  to: string,
  data: Record<string, unknown> = {},
): Promise<EmailResult> {
  const template = getTemplate(name);
  const { subject, text } = template.render(data as never);
  const sender = resolveSender(template.sender);

  const message: EmailMessage = {
    to,
    // Optional global From override; otherwise the per-purpose identity.
    from: process.env.EMAIL_FROM_DEFAULT || sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    subject,
    text,
  };

  return selectTransport().send(message);
}
