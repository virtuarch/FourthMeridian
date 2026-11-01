/**
 * lib/platform/email-health.ts  (PO-5A)
 *
 * The smallest useful email-delivery visibility for beta operators — a read
 * model over the EXISTING NotificationDelivery ledger (its
 * `@@index([channel, status, createdAt])` was built for exactly this). Answers
 * "are emails failing?" for the emails that flow through the notification
 * pipeline. Metadata only — recipient addresses and message bodies are never read.
 *
 * SCOPE NOTE (documented gap): transactional AUTH emails (verification, invite,
 * password reset) go through lib/email/send.ts directly and are NOT recorded in
 * NotificationDelivery, so they don't appear in `counts`. Their config-time
 * health is covered by the env-status widget (RESEND_API_KEY presence → "sent"
 * vs "captured"); per-message auth-email recording is deferred (would need a
 * schema change — NotificationDelivery requires a Notification FK).
 *
 * OBS-008 — the DIRECT sendEmail legs are now at least REPRESENTED here, as a
 * declared coverage list (`directSend`): which template families bypass the
 * ledger, and the transport the chokepoint would select for them right now.
 * That is a configuration fact, not a per-message count, and it is labelled so.
 */

import { db } from "@/lib/db";
import { emailEnvironment, parseNonprodAllowlist, type EmailEnvironment } from "@/lib/email/recipient-guard";

/**
 * THE DELIVERY VOCABULARY (OBS-003 / UI-011). A notification email moves through
 *
 *   queued → attempted → accepted → (delivered) | failed
 *
 * and this product can observe only up to ACCEPTED: `NotificationDelivery.status
 * = "sent"` means the provider's API accepted the message (Resend returned an
 * id). No webhook or delivery event is ingested, so DELIVERED is never known and
 * no surface may claim it — the honest word is "accepted by the provider".
 * `captured` is NOT attempted against any provider: either the in-memory
 * transport (no key / test) or the non-production recipient guard
 * (lib/email/recipient-guard.ts — provider "none") holding back a recipient
 * that is not on EMAIL_NONPROD_ALLOWLIST. It is its own category, never a failure.
 */
export type EmailDeliveryStage = "accepted" | "captured" | "failed" | "skipped";
export const EMAIL_STAGE_WORD: Record<EmailDeliveryStage, string> = {
  accepted: "accepted by the provider",
  captured: "captured — not sent to any provider (no key, or non-production recipient guard)",
  failed:   "failed at the provider",
  skipped:  "skipped (no recipient)",
};

export interface EmailDeliveryHealth {
  windowDays: number;
  counts: {
    sent:     number; // ACCEPTED by the provider (handed off; delivery itself is never observed)
    captured: number; // NOT attempted against any provider: capture transport (RESEND_API_KEY unset) or the non-production recipient guard
    error:    number; // FAILED at the provider/adapter
    skipped:  number; // no recipient resolved (by design)
    total:    number;
  };
  recentErrors: Array<{ id: string; error: string; at: string }>;
  /** OBS-008 — the direct-send legs the ledger does not see, as declared coverage. Optional so older fixtures/readers still type. */
  directSend?: DirectSendCoverage;
}

export async function getEmailDeliveryHealth(windowDays = 7): Promise<EmailDeliveryHealth> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [grouped, errorRows] = await Promise.all([
    db.notificationDelivery.groupBy({
      by:     ["status"],
      where:  { channel: "EMAIL", createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.notificationDelivery.findMany({
      where:   { channel: "EMAIL", status: "error", createdAt: { gte: since } },
      select:  { id: true, error: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take:    10,
    }),
  ]);

  const byStatus = new Map<string, number>();
  for (const g of grouped) byStatus.set(g.status, g._count._all);
  const sent     = byStatus.get("sent")     ?? 0;
  const captured = byStatus.get("captured") ?? 0;
  const error    = byStatus.get("error")    ?? 0;
  const skipped  = byStatus.get("skipped")  ?? 0;

  return {
    windowDays,
    counts: { sent, captured, error, skipped, total: sent + captured + error + skipped },
    recentErrors: errorRows.map((r) => ({ id: r.id, error: r.error ?? "(no detail)", at: r.createdAt.toISOString() })),
    directSend: describeDirectSendCoverage(),
  };
}

// ── OBS-008 — direct sendEmail coverage (declared, not counted) ───────────────

/** Template families that call lib/email/send.ts directly and leave NO NotificationDelivery row. */
export const DIRECT_SEND_TEMPLATES: readonly string[] = [
  "password-reset", "email-verification", "email-change", "space-invite", "beta-invite", "beta-request",
  "security-alert", "platform-alert",
];

export interface DirectSendCoverage {
  /** The template families that bypass the ledger (static declaration). */
  templates: readonly string[];
  /**
   * The transport lib/email/send.ts selects RIGHT NOW for those sends, from
   * configuration alone (mirrors its transport selection): "resend" when a key is
   * present, "capture" otherwise. "capture" outside development means every one
   * of those emails reaches nobody.
   */
  transport: "resend" | "capture";
  /** Whether that transport is a real provider in this NODE_ENV. */
  real: boolean;
  /**
   * The non-production recipient guard (lib/email/send.ts → recipient-guard.ts).
   * `active` = this environment is not Production, so a real transport delivers
   * ONLY to the `allowlistCount` EMAIL_NONPROD_ALLOWLIST addresses and captures
   * every other recipient. Count only — the addresses are never surfaced.
   */
  recipientGuard: { environment: EmailEnvironment; active: boolean; allowlistCount: number };
  note: string;
}

export function describeDirectSendCoverage(
  env: {
    NODE_ENV?: string; RESEND_API_KEY?: string;
    VERCEL?: string; VERCEL_ENV?: string; EMAIL_NONPROD_ALLOWLIST?: string;
  } = process.env,
): DirectSendCoverage {
  const transport: DirectSendCoverage["transport"] =
    env.NODE_ENV !== "test" && env.RESEND_API_KEY ? "resend" : "capture";
  const real = transport === "resend";
  const environment = emailEnvironment(env);
  const recipientGuard = {
    environment,
    active: environment !== "production",
    allowlistCount: parseNonprodAllowlist(env.EMAIL_NONPROD_ALLOWLIST).size,
  };
  const guardNote = !real || !recipientGuard.active
    ? ""
    : recipientGuard.allowlistCount === 0
      ? ` Outside Production with an empty EMAIL_NONPROD_ALLOWLIST, every recipient is captured (provider "none") and reaches nobody.`
      : ` Outside Production only the ${recipientGuard.allowlistCount} EMAIL_NONPROD_ALLOWLIST address(es) are sent; every other recipient is captured (provider "none").`;
  return {
    templates: DIRECT_SEND_TEMPLATES,
    transport,
    real,
    recipientGuard,
    note: (real
      ? "These emails are sent directly through the chokepoint and are not counted above; the provider would accept them, but no per-message row exists."
      : "These emails are sent directly through the chokepoint and are not counted above; with no RESEND_API_KEY they are captured in memory and reach nobody.") + guardNote,
  };
}
