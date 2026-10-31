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
 *
 * BOUNDED: a send that has not answered within RESEND_SEND_TIMEOUT_MS (10 s)
 * resolves as { status: "error" } ("timed out — delivery unknown"), so one hung
 * provider call cannot consume a caller's whole budget (e.g. a bulk approval).
 * The underlying request is not cancelled (the SDK takes no signal); its late
 * answer is ignored. A timed-out invite stands and can be resent.
 *
 * LOGGING HYGIENE: this adapter logs nothing itself, and the error string it
 * returns (which callers log) is passed through redactProviderError(), so no
 * recipient address, link or token can ride a provider error into the logs.
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

// ── Payload + error hygiene ───────────────────────────────────────────────────

/** The subset of the Resend client this adapter calls (a seam for tests). */
export interface ResendLikeClient {
  emails: { send: (payload: ResendPayload, options?: ResendRequestOptions) => Promise<{ data: { id: string } | null; error: { message: string } | null }> };
}

/** The SDK's per-request options this adapter sets (resend@6 CreateEmailRequestOptions: `idempotencyKey` → the `Idempotency-Key` header). */
export interface ResendRequestOptions {
  idempotencyKey?: string;
}

/** B2 HARDENING A1 — the request options for a message: its idempotency key when the caller gave one, else none. */
export function buildResendOptions(message: EmailMessage): ResendRequestOptions | undefined {
  return message.idempotencyKey ? { idempotencyKey: message.idempotencyKey.slice(0, 256) } : undefined;
}

export interface ResendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

/**
 * The provider payload for a message. Text is always sent; `html` only when
 * the template rendered one, so the message goes out as multipart/alternative
 * with the text part as the plain alternative.
 */
export function buildResendPayload(message: EmailMessage): ResendPayload {
  return {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
}

/**
 * Provider error strings reach the callers' console.error lines verbatim. A
 * validation error can echo the recipient address or a URL from the body, so
 * addresses, URLs and long hex runs (raw tokens) are masked and the length
 * capped before the string leaves this adapter.
 */
export function redactProviderError(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+/g, "[email]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[token]")
    .slice(0, 300);
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/** The longest one provider hand-off may take before it is reported as an error. */
export const RESEND_SEND_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol("timed-out");

/** Resolve `p`, or TIMED_OUT after `ms` — the timer is always cleared. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Build an adapter over a client getter (the real one below; a fake in tests). */
export function createResendAdapter(
  clientFor: () => ResendLikeClient | null,
  opts: { timeoutMs?: number } = {},
): EmailProvider {
  const timeoutMs = opts.timeoutMs ?? RESEND_SEND_TIMEOUT_MS;
  return {
    name: PROVIDER_NAME,

    async send(message: EmailMessage): Promise<EmailResult> {
      const client = clientFor();
      if (!client) {
        return {
          status: "error",
          provider: PROVIDER_NAME,
          error: "RESEND_API_KEY is not set — cannot send via Resend.",
        };
      }

      try {
        const options = buildResendOptions(message);
        const answer = await within(options ? client.emails.send(buildResendPayload(message), options) : client.emails.send(buildResendPayload(message)), timeoutMs);
        if (answer === TIMED_OUT) {
          return { status: "error", provider: PROVIDER_NAME, error: `Resend send timed out after ${timeoutMs} ms — delivery unknown.` };
        }
        const { data, error } = answer;

        if (error) {
          return { status: "error", provider: PROVIDER_NAME, error: redactProviderError(error.message) };
        }
        return { status: "sent", provider: PROVIDER_NAME, id: data?.id };
      } catch (err) {
        return {
          status: "error",
          provider: PROVIDER_NAME,
          error: redactProviderError(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };
}

export const resendAdapter: EmailProvider = createResendAdapter(
  () => getClient() as unknown as ResendLikeClient | null,
);
