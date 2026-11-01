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
 * STORM LIMIT (Comms Center A-2b, owner decision O-10, lib/notifications/
 * delivery/storm.ts): right AFTER the recipient guard admits the address and
 * before the provider, a customer email of a limited class (SERVICE /
 * AWARENESS / MARKETING) is held when its recipient already has 5 ACCEPTED
 * such emails in the rolling hour (counted from the ledger) —
 * `{ status: "skipped", provider: "none", reason: "RATE_LIMITED" }` — or when
 * that count cannot be read (`RATE_LIMIT_UNVERIFIED`: fail closed). Security
 * (SECURITY_CRITICAL), ceremony (CEREMONY) and operator mail is exempt and
 * always sends. A held send is recorded SUPPRESSED with its reason and is
 * never retried ("skipped"). One redacted log line: template, key, reason.
 *
 * DELIVERY LEDGER (Comms Center A-2a, lib/notifications/delivery): every send
 * through here writes ONE CommsDelivery row with its outcome — ACCEPTED (the
 * provider accepted it; never "delivered"), CAPTURED (the guard), FAILED / DEAD
 * (error; DEAD on the caller-declared last attempt) — keyed by the catalog key
 * the caller names in the 4th argument. Metadata only: never the address,
 * subject, body or data. The write runs AFTER the transport answered — in a
 * request, after the RESPONSE (next/server after()); in a job or script,
 * inline and bounded by LEDGER_WRITE_TIMEOUT_MS — and can never throw into
 * the caller: a ledger failure is one redacted log line and the EmailResult
 * is returned unchanged.
 *
 * NON-THROWING: returns an EmailResult; callers branch on `status`.
 */

import "server-only";
import type { EmailMessage, EmailProvider, EmailResult, EmailSendContext, EmailTemplateName } from "@/lib/email/types";
import { getTemplate } from "@/lib/email/templates";
import { resolveSender } from "@/lib/email/senders";
import { resendAdapter } from "@/lib/email/providers/resend";
import { captureAdapter } from "@/lib/email/providers/capture";
import { decideRecipient, describeGuardedRecipient, type RecipientGuardEnv } from "@/lib/email/recipient-guard";
import { emailLedgerRow, recipientHash, recordDelivery, resolveEmailKey, type LedgerEnv } from "@/lib/notifications/delivery/record";
import { countRecentAcceptedEmails, writeDeliveryRow } from "@/lib/notifications/delivery/store";
import { decideStorm, PendingSends, pendingSends, type Reservation, type StormCounter } from "@/lib/notifications/delivery/storm";
import { runAfterResponse } from "@/lib/notifications/delivery/defer";
import type { LedgerWriter } from "@/lib/notifications/delivery/types";

/** The env keys the chokepoint reads (a structural subset of process.env). */
export interface EmailSendEnv extends RecipientGuardEnv, LedgerEnv {
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
  /** Sink for the redacted guard line ("warn" = unknown Vercel environment). */
  log?: (line: string, level: "info" | "warn") => void;
  /** The delivery-ledger writer (lib/notifications/delivery/store.ts in production). Absent ⇒ nothing recorded. */
  ledger?: LedgerWriter;
  /**
   * The storm-limit counter (A-2b; lib/notifications/delivery/store.ts
   * countRecentAcceptedEmails in production). Absent ⇒ no storm limit — only
   * a test seam that never models one leaves it out.
   */
  storm?: StormCounter;
  /**
   * In-process reservations of admitted-but-not-yet-recorded limited sends
   * (A-2b). Production: the module-level instance. Absent ⇒ a fresh instance
   * per sender (tests stay isolated).
   */
  pending?: PendingSends;
  /** Clock for the ledger row (tests). */
  now?: () => Date;
  /**
   * Where the ledger write runs. Production: after the response when a request
   * scope exists (next/server after()), inline otherwise — jobs and scripts.
   * Absent ⇒ inline, bounded by LEDGER_WRITE_TIMEOUT_MS.
   */
  defer?: (task: () => Promise<void>) => Promise<void>;
}

export type SendEmailFn = (
  name: EmailTemplateName,
  to: string,
  data?: Record<string, unknown>,
  ctx?: EmailSendContext,
) => Promise<EmailResult>;

/** Build a sendEmail over injected env + transports. */
export function createEmailSender(deps: EmailSenderDeps): SendEmailFn {
  const log = deps.log ?? ((line: string, level: "info" | "warn") => console[level](line));
  const pending = deps.pending ?? new PendingSends();
  return async (name, to, data = {}, ctx) => {
    const slot: { reservation: Reservation | null } = { reservation: null };
    const result = await send(deps, pending, log, name, to, data, ctx, slot);
    const reservation = slot.reservation;
    // A storm reservation (A-2b) is held only by an ACCEPTED send, and only until
    // its ledger row is written — from then on the DB count holds it. A send the
    // ledger never records keeps its reservation until it ages out of the window.
    if (reservation && result.status !== "sent") pending.release(reservation);
    const held = reservation && result.status === "sent" ? reservation : null;
    if (deps.ledger) {
      // Built inside the guard too: a row that cannot even be built must not reach the caller.
      let row: ReturnType<typeof emailLedgerRow>;
      try {
        row = emailLedgerRow({ template: name, to, result, ctx, env: deps.env, now: (deps.now ?? (() => new Date()))() });
      } catch {
        log(`[comms-ledger] delivery row could not be built (non-fatal; the send is unaffected): template=${name}`, "warn");
        return result;
      }
      const writer = deps.ledger;
      const write = async () => {
        const recorded = await recordDelivery(writer, row, { log: (line) => log(line, "warn") });
        if (recorded && held) pending.release(held);
      };
      if (deps.defer) {
        try { await deps.defer(write); } catch { /* recordDelivery never throws; a defer seam must not either */ }
      } else {
        await write();
      }
    }
    return result;
  };
}

/**
 * Send a transactional email by template name.
 *
 * @param name  Registry key of the template to render.
 * @param to    Recipient address.
 * @param data  Template data (shape defined by the named template).
 * @param ctx   Delivery-ledger context: the catalog key + the recipient userId (never the address).
 * @returns     A non-throwing EmailResult.
 */
export const sendEmail: SendEmailFn = createEmailSender({
  env: process.env as EmailSendEnv,
  provider: resendAdapter,
  capture: captureAdapter,
  ledger: writeDeliveryRow,
  defer: runAfterResponse,
  storm: countRecentAcceptedEmails,
  pending: pendingSends,
});

async function send(
  deps: EmailSenderDeps,
  pending: PendingSends,
  log: (line: string, level: "info" | "warn") => void,
  name: EmailTemplateName,
  to: string,
  data: Record<string, unknown>,
  ctx: EmailSendContext | undefined,
  /** Out-parameter: the storm reservation an admitted limited send took (A-2b). */
  slot: { reservation: Reservation | null },
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
  const { text, html } = rendered;
  // Comms Center B2 (contract v1.1 §6.9) — an operator TEST send is marked in its subject.
  const subject = ctx?.mode === "TEST" ? `[TEST] ${rendered.subject.replace(/^\[PREVIEW\] /, "")}` : rendered.subject;
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
    // B2 HARDENING A1 — the caller's provider idempotency key (an automation item id).
    ...(ctx?.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
  };

  // Test mode never sends for real, regardless of whether a key is present.
  if (env.NODE_ENV === "test") return deps.capture.send(message);
  // No key: capture (local dev needs no credentials). Nothing leaves the process.
  if (!env.RESEND_API_KEY) return deps.capture.send(message);

  // The real provider is next — the non-production recipient guard runs here,
  // and ONLY here, so no path can reach the provider around it.
  const decision = decideRecipient(to, env);
  if (!decision.deliver) {
    const detail = `template=${name} environment=${decision.environment} ${describeGuardedRecipient(to)}`;
    if (env.VERCEL === "1" && decision.environment === "unknown") {
      // A Vercel runtime whose VERCEL_ENV is not exactly production/preview/
      // development — most likely a misconfigured Production. Loud, fixed text.
      log(`[email] email guard: unknown Vercel environment, capturing — ${detail}`, "warn");
    } else {
      log(`[email] captured by the non-production recipient guard: ${detail}`, "info");
    }
    return { status: "captured", provider: "none", reason: decision.reason };
  }
  // The storm limit (A-2b, O-10) — after the guard, before the provider. Exempt
  // classes return at once (fail open); a limited send is held when over the
  // limit or when its count cannot be read (fail closed).
  // A TEST send is OPERATOR-class (v1.1 §6.9): never counted, never held — its own bucket bounds it.
  if (deps.storm && ctx?.mode !== "TEST") {
    const key = resolveEmailKey(name, ctx);
    const userId = ctx?.recipientUserId ?? null;
    const storm = await decideStorm({
      key,
      recipientUserId: userId,
      // The ledger's own recipient identity when there is no account (never the address).
      recipientHash: userId === null && ctx?.hashRecipient !== false ? recipientHash(to, env) : null,
      counter: deps.storm,
      now: (deps.now ?? (() => new Date()))(),
      pending,
    });
    if (!storm.send) {
      log(`[email] held by the storm limit: template=${name} key=${key} reason=${storm.reason}`, "warn");
      return { status: "skipped", provider: "none", reason: storm.reason };
    }
    if (!storm.exempt) slot.reservation = storm.reservation;
  }
  // Production: the caller's address. Elsewhere: the MATCHED allowlist entry,
  // never the raw string (no Unicode case-folding smuggling — recipient-guard.ts).
  return deps.provider.send({ ...message, to: decision.to });
}
