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
 *   - RESEND_API_KEY present   → the real Resend adapter, BEHIND THE
 *                                NON-PRODUCTION RECIPIENT GUARD (below).
 *   - otherwise (dev, no key)  → capture. Local dev needs no credentials.
 *
 * NON-PRODUCTION RECIPIENT GUARD (owner requirement 2026-10-31; Comms Center
 * contract §O-4, lib/email/recipient-guard.ts): before ANY message reaches the
 * real provider, the recipient is checked. Outside Production (VERCEL_ENV=
 * "production" on Vercel is the only Production), only an exact match in
 * EMAIL_NONPROD_ALLOWLIST is delivered; every other recipient is CAPTURED —
 * `{ status: "captured", provider: "none", reason: "ENVIRONMENT_GUARD" }` —
 * and never handed to the provider. Unset/empty allowlist or an unknown
 * environment ⇒ capture everything (fail closed). Production is unchanged.
 * A guarded send logs one redacted line (template, environment, recipient
 * domain + short hash) — never the address. "captured" is a non-failure:
 * callers that branch on "error" (and the retry job, which selects only
 * "error" rows) leave it alone.
 *
 * Every send path reaches the provider only through here: direct sendEmail
 * callers, lib/notifications/channels/email.ts (create-time AND the
 * jobs/retry-notifications.ts re-delivery), lib/alerts/run.ts, the purge's
 * injected seam, and scripts/email-preview.ts (whose own
 * EMAIL_PREVIEW_ALLOWED_TO gate runs first — both must admit the address).
 *
 * NON-THROWING: returns an EmailResult; callers branch on `status`.
 */

import "server-only";
import type { EmailMessage, EmailProvider, EmailResult, EmailTemplateName } from "@/lib/email/types";
import { getTemplate } from "@/lib/email/templates";
import { resolveSender } from "@/lib/email/senders";
import { resendAdapter } from "@/lib/email/providers/resend";
import { captureAdapter } from "@/lib/email/providers/capture";
import { decideRecipient, describeGuardedRecipient, type RecipientGuardEnv } from "@/lib/email/recipient-guard";

/** The env keys the chokepoint reads (a structural subset of process.env). */
export interface EmailSendEnv extends RecipientGuardEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM_DEFAULT?: string;
}

/** Injection seam: the real wiring below; fakes in tests (never a real provider). */
export interface EmailSenderDeps {
  /** Read on EVERY send (process.env by reference in production wiring). */
  env: EmailSendEnv;
  /** The real provider transport. */
  provider: EmailProvider;
  /** The in-memory transport (test mode / no key). */
  capture: EmailProvider;
  /** Sink for the redacted guard line. */
  log?: (line: string) => void;
}

export type SendEmailFn = (
  name: EmailTemplateName,
  to: string,
  data?: Record<string, unknown>,
) => Promise<EmailResult>;

/** Build a sendEmail over injected env + transports. */
export function createEmailSender(deps: EmailSenderDeps): SendEmailFn {
  const log = deps.log ?? ((line: string) => console.info(line));
  return (name, to, data = {}) => send(deps, log, name, to, data);
}

/**
 * Send a transactional email by template name.
 *
 * @param name  Registry key of the template to render.
 * @param to    Recipient address.
 * @param data  Template data (shape defined by the named template).
 * @returns     A non-throwing EmailResult.
 */
export const sendEmail: SendEmailFn = createEmailSender({
  env: process.env as EmailSendEnv,
  provider: resendAdapter,
  capture: captureAdapter,
});

async function send(
  deps: EmailSenderDeps,
  log: (line: string) => void,
  name: EmailTemplateName,
  to: string,
  data: Record<string, unknown>,
): Promise<EmailResult> {
  const env = deps.env;
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
    from: env.EMAIL_FROM_DEFAULT || sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    subject,
    text,
    // HTML is optional (design-system templates); text stays the alternative.
    ...(html ? { html } : {}),
  };

  // Test mode never sends for real, regardless of whether a key is present.
  if (env.NODE_ENV === "test") return deps.capture.send(message);
  // No key: capture (local dev needs no credentials). Nothing leaves the process.
  if (!env.RESEND_API_KEY) return deps.capture.send(message);

  // The real provider is next — the non-production recipient guard runs here,
  // and ONLY here, so no path can reach the provider around it.
  const decision = decideRecipient(to, env);
  if (!decision.deliver) {
    log(
      `[email] captured by the non-production recipient guard: template=${name} ` +
        `environment=${decision.environment} ${describeGuardedRecipient(to)}`,
    );
    return { status: "captured", provider: "none", reason: decision.reason };
  }
  return deps.provider.send(message);
}
