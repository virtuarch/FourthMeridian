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
 *   2. Render subject + text (+ html, for design-system templates) from the
 *      caller's data (pure). A render failure is an error RESULT, not a throw.
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
  // NON-THROWING contract: a template that refuses its data (e.g. a non-http(s)
  // URL, an invalid date) becomes an error result, never an exception into the
  // caller. The message is fixed — it never echoes the data (links, tokens).
  let rendered: { subject: string; text: string; html?: string };
  try {
    rendered = template.render(data as never);
  } catch {
    return { status: "error", provider: "none", error: `template "${name}" failed to render` };
  }
  const { subject, text, html } = rendered;
  const sender = resolveSender(template.sender);

  const message: EmailMessage = {
    to,
    // Optional global From override; otherwise the per-purpose identity.
    from: process.env.EMAIL_FROM_DEFAULT || sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    subject,
    text,
    // HTML is optional (design-system templates); text stays the alternative.
    ...(html ? { html } : {}),
  };

  return selectTransport().send(message);
}
