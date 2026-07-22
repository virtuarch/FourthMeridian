/**
 * lib/email/providers/resend.ts  (OPS-1 S1)
 *
 * THE ONLY FILE IN THIS CODEBASE THAT MAY IMPORT THE RESEND SDK.
 *
 * This is the ResendAdapter — the real transactional-email transport. It
 * implements the provider-agnostic EmailProvider contract so the rest of the
 * app (and lib/email/send.ts in particular) never references Resend directly.
 * Swapping Resend for Postmark/SES/SendGrid later means adding a sibling
 * adapter and changing the transport selection in send.ts — nothing else.
 *
 * Mirrors lib/ai/provider.ts:
 *   - Lazy singleton client, created on first send.
 *   - Reads process.env.RESEND_API_KEY directly (not via lib/env.ts) so the
 *     single-SDK-import boundary stays airtight and the key check lives with
 *     the client it guards.
 *
 * NON-THROWING: every path resolves to an EmailResult. A missing key or an SDK
 * failure returns { status: "error" } rather than throwing into a caller.
 */

import "server-only";
import { Resend } from "resend";
import type { EmailMessage, EmailProvider, EmailResult } from "@/lib/email/types";

const PROVIDER_NAME = "resend";

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _client: Resend | null = null;

/** Returns the client, or null if no API key is configured. */
function getClient(): Resend | null {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _client = new Resend(key);
  return _client;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const resendAdapter: EmailProvider = {
  name: PROVIDER_NAME,

  async send(message: EmailMessage): Promise<EmailResult> {
    const client = getClient();
    if (!client) {
      return {
        status: "error",
        provider: PROVIDER_NAME,
        error: "RESEND_API_KEY is not set — cannot send via Resend.",
      };
    }

    try {
      const { data, error } = await client.emails.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });

      if (error) {
        return { status: "error", provider: PROVIDER_NAME, error: error.message };
      }
      return { status: "sent", provider: PROVIDER_NAME, id: data?.id };
    } catch (err) {
      return {
        status: "error",
        provider: PROVIDER_NAME,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
