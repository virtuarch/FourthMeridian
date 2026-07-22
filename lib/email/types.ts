/**
 * lib/email/types.ts  (OPS-1 S0)
 *
 * Pure types + the provider contract for the email seam. Zero runtime beyond
 * type declarations; this module imports nothing and instantiates no client.
 *
 * SEAM PHILOSOPHY (mirrors lib/ai/provider.ts and lib/rate-limit.ts):
 *   - One chokepoint (lib/email/send.ts) is the only entry point callers use.
 *   - The provider SDK (Resend) is imported in exactly ONE file
 *     (lib/email/providers/resend.ts) so the provider stays swappable
 *     (Resend -> Postmark -> SES) without touching any caller.
 *   - sendEmail() is best-effort and NON-THROWING: it returns an EmailResult
 *     the caller inspects, rather than throwing into domain logic. This mirrors
 *     the best-effort idiom of the event-handler dispatch in lib/events/emit.ts.
 *
 * See docs/initiatives/ops1/OPS1_S0_S1_IMPLEMENTATION_PROPOSAL.md.
 */

/**
 * A rendered, ready-to-send message. Producers never build this by hand — it
 * is assembled inside lib/email/send.ts from a template + a resolved sender.
 * Text-first by design: no HTML framework in the OPS-1 floor.
 */
export interface EmailMessage {
  /** Recipient address. */
  to: string;
  /** Fully-formed From identity, e.g. `Fourth Meridian <support@fourthmeridian.com>`. */
  from: string;
  /** Optional Reply-To identity. */
  replyTo?: string;
  /** Subject line (rendered by the template). */
  subject: string;
  /** Plain-text body (rendered by the template). */
  text: string;
}

/**
 * The outcome of a send attempt. NON-THROWING contract: every path resolves to
 * one of these statuses; callers branch on `status` instead of catching.
 *
 *   sent      — handed to the real provider, which accepted it (id present).
 *   captured  — recorded by the dev/test capture transport (not really sent).
 *   skipped   — no send performed by design (e.g. email disabled / no creds in
 *               a context that must not fall back to capture).
 *   error     — the transport attempted a send and failed (error present).
 */
export interface EmailResult {
  status: "sent" | "captured" | "skipped" | "error";
  /** Provider message id when status === "sent". */
  id?: string;
  /** Which transport produced this result: "resend" | "capture". */
  provider: string;
  /** Human-readable failure reason when status === "error". */
  error?: string;
}

/**
 * The provider contract. Both the real Resend adapter and the dev/test capture
 * transport implement this. The single chokepoint selects an implementation at
 * call time; nothing else in the codebase references implementations directly.
 */
export interface EmailProvider {
  /** Stable transport name, surfaced in EmailResult.provider. */
  readonly name: string;
  /** Deliver (or capture) a fully-rendered message. Must never throw. */
  send(message: EmailMessage): Promise<EmailResult>;
}

/**
 * The typed template registry key space. Grows one entry per real template as
 * later slices land. S1: smoke. S2a: password-reset. S2b: email-verification.
 * S3: space-invite. OPS-2 S2: security-alert. OPS-3 S4: notification (the one
 * generic awareness email — see lib/email/templates/notification.ts). OPS-5 S5:
 * platform-alert (the operator-facing Platform Operations alert).
 */
export type EmailTemplateName =
  | "smoke"
  | "password-reset"
  | "email-verification"
  | "space-invite"
  | "security-alert"
  | "email-change"
  | "notification"
  | "beta-invite"
  | "beta-request"
  | "platform-alert";

/**
 * A template turns typed `data` into the subject + text of a message. The
 * sender identity is resolved separately (lib/email/senders.ts), not here.
 */
export interface EmailTemplate<Data = unknown> {
  /** Registry key. */
  name: EmailTemplateName;
  /** Which sender identity this template sends as (see lib/email/senders.ts). */
  sender: SenderPurpose;
  /** Pure render: data -> { subject, text }. No I/O. */
  render(data: Data): { subject: string; text: string };
}

/**
 * Purposes that map to a sender identity. Declared in full now so the identity
 * map is complete and review-stable; only `smoke` is exercised in OPS-1 S1.
 */
export type SenderPurpose =
  | "smoke"
  | "password-reset"
  | "email-verification"
  | "space-invite"
  | "security-alert"
  | "product-notification"
  | "beta-invite"
  | "platform-ops";
