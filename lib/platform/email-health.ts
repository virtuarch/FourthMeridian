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
 * NotificationDelivery, so they don't appear here. Their config-time health is
 * covered by the env-status widget (RESEND_API_KEY presence → "sent" vs
 * "captured"); per-message auth-email recording is deferred (would need a schema
 * change — NotificationDelivery requires a Notification FK).
 */

import { db } from "@/lib/db";

export interface EmailDeliveryHealth {
  windowDays: number;
  counts: {
    sent:     number; // really delivered via the provider
    captured: number; // fell back to capture (e.g. RESEND_API_KEY unset) — NOT actually sent
    error:    number; // provider/adapter error
    skipped:  number; // no recipient resolved (by design)
    total:    number;
  };
  recentErrors: Array<{ id: string; error: string; at: string }>;
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
  };
}
