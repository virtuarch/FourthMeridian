/**
 * jobs/retry-notifications.ts  (OPS-4 S4)
 *
 * THE notification retry consumer — the reader OPS-3 built the
 * NotificationDelivery outbox for (frozen F16: "attempts is recorded, never
 * incremented here — retries are OPS-4"). Registered in lib/jobs/registry.ts
 * ("notification-retry", 07:30 UTC slot, sequenced AFTER notification-cleanup
 * so freshly aged-out notifications are never re-mailed) and executed through
 * the dispatcher + runJob(). The daily dispatcher run IS the retry cadence —
 * fixed, not exponential (backoff was never approved; S0 ruling R6).
 *
 * RETRY POLICY (the smallest safe reading of the ACTUAL state model —
 * statuses are the EmailResult vocabulary sent|captured|skipped|error;
 * no permanent-vs-transient signal exists, so every "error" is retryable
 * until the attempt cap):
 *   RETRY    status "error" AND attempts < MAX_DELIVERY_ATTEMPTS (3 total:
 *            the create-time attempt + up to 2 retries).
 *   NEVER    "sent" / "captured" (delivered) · "skipped" (deliberate) ·
 *            "error" at the cap — the terminal, queryable dead-letter state
 *            (no DLQ infrastructure, by the investigation's ruling).
 *   OBSOLETE a delivery whose notification is archived, expired, or already
 *            READ in-app, or whose recipient has no email — re-mailing has
 *            no value; the row is closed as "skipped" (existing vocabulary:
 *            a skip by design) WITHOUT an attempt increment, and exits the
 *            retry set. Deleted notifications need no handling — deliveries
 *            ride the FK cascade.
 *
 * DUPLICATE-SEND PREVENTION (the S4 design point, written down):
 *   CLAIM-FIRST — a conditional updateMany({ id, status: "error",
 *   attempts: <observed> }) increments attempts BEFORE the send; zero rows
 *   updated = another pass already claimed it (or state changed) → skip.
 *   This makes overlapping/re-run passes race-safe: a claimed row cannot be
 *   claimed again, so an idempotent re-run in the same instant sends
 *   nothing. Residual window, accepted and documented: if the process dies
 *   AFTER a successful provider send but BEFORE the outcome write, the row
 *   remains "error" with the attempt burned and the next daily run re-sends
 *   — a rare double email, bounded by the cap, preferred over the inverse
 *   failure (marking sent without sending). A crash after claim but before
 *   send burns one attempt without a send — bounded loss, no duplicate.
 *
 *   RLS-C-S6a: "zero rows updated = another pass already claimed it" is now
 *   checked rather than assumed. A zero that comes with an INVISIBLE row is not
 *   a race at all (removed row, or a refused write) and is counted as
 *   claimIndeterminate with an error log, never as claimLost.
 *
 * Row semantics preserved: attempts progress on the SAME row (the OPS-3
 * outbox model — one row per channel, not per attempt); status /
 * deliveredAt / provider / providerMessageId / error are updated from the
 * ChannelResult verbatim, deliveredAt only on "sent" (mirrors create.ts).
 * Notification rows are never touched. Bounded batch (oldest first), the
 * cleanup.ts best-effort idiom. Summary carries counts only (S1 doctrine).
 */

import { db } from "@/lib/db";
import { IndeterminateWriteError, resolveConditionalWrite } from "@/lib/db/conditional-write";
import { emailNotificationAdapter } from "@/lib/notifications/channels/email";
import type {
  ChannelAdapter,
  NotificationCategory,
  NotificationPriorityValue,
} from "@/lib/notifications/types";

/** Total attempts per delivery (1 create-time + up to 2 retries). */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Bounded batch per run — oldest first; the rest wait for tomorrow's run. */
const RETRY_BATCH_LIMIT = 100;

// ── Narrow client contract (injection seam for pure tests) ───────────────────

export interface RetryableDeliveryRow {
  id: string;
  attempts: number;
  notification: {
    userId: string;
    type: string;
    category: string;
    priority: string;
    title: string;
    body: string | null;
    href: string | null;
    readAt: Date | null;
    archivedAt: Date | null;
    expiresAt: Date | null;
    user: { email: string } | null;
  } | null;
}

export interface NotificationRetryClient {
  notificationDelivery: {
    findMany(args: {
      where: { channel: "EMAIL"; status: "error"; attempts: { lt: number } };
      select: {
        id: true;
        attempts: true;
        notification: {
          select: {
            userId: true;
            type: true;
            category: true;
            priority: true;
            title: true;
            body: true;
            href: true;
            readAt: true;
            archivedAt: true;
            expiresAt: true;
            user: { select: { email: true } };
          };
        };
      };
      orderBy: { createdAt: "asc" };
      take: number;
    }): Promise<RetryableDeliveryRow[]>;
    /** The conditional CLAIM — race-safe on (id, status, observed attempts). */
    updateMany(args: {
      where: { id: string; status: "error"; attempts: number };
      data: { attempts: { increment: 1 } };
    }): Promise<{ count: number }>;
    /**
     * RLS-C-S6a — the VISIBILITY PROBE for a lost claim. Asks the CAS's identity
     * question WITHOUT its condition, through the same client, so "another pass
     * claimed it" can be told apart from "this authority cannot see the row".
     */
    count(args: { where: { id: string } }): Promise<number>;
    /** Outcome / obsolete-closure write. */
    update(args: {
      where: { id: string };
      data: {
        status?: string;
        provider?: string | null;
        providerMessageId?: string | null;
        error?: string | null;
        deliveredAt?: Date | null;
      };
    }): Promise<unknown>;
  };
}

export interface RetryNotificationsResult {
  /** Eligible error rows examined this run. */
  examined: number;
  /** Sends actually attempted (claimed + delivered to the adapter). */
  retried: number;
  /** Retries that delivered ("sent" or dev-transport "captured"). */
  delivered: number;
  /** Retries that failed again (remain "error"; retried until the cap). */
  stillFailing: number;
  /** Rows closed as obsolete (archived/expired/read/no-recipient). */
  skippedObsolete: number;
  /** Rows lost to the claim race (already claimed by a concurrent pass). */
  claimLost: number;
  /**
   * RLS-C-S6a — rows whose claim matched nothing AND whose row this authority
   * cannot see. NOT a claim race: either the delivery was removed or the write
   * was refused by a policy, and neither is a concurrent pass. Counted
   * separately and logged at error level precisely so it can never be read as
   * `claimLost` again.
   */
  claimIndeterminate: number;
}

export async function retryNotifications(
  client: NotificationRetryClient = db as unknown as NotificationRetryClient,
  adapter: ChannelAdapter = emailNotificationAdapter,
  now: Date = new Date(),
): Promise<RetryNotificationsResult> {
  const rows = await client.notificationDelivery.findMany({
    where: { channel: "EMAIL", status: "error", attempts: { lt: MAX_DELIVERY_ATTEMPTS } },
    select: {
      id: true,
      attempts: true,
      notification: {
        select: {
          userId: true,
          type: true,
          category: true,
          priority: true,
          title: true,
          body: true,
          href: true,
          readAt: true,
          archivedAt: true,
          expiresAt: true,
          user: { select: { email: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: RETRY_BATCH_LIMIT,
  });

  const result: RetryNotificationsResult = {
    examined: rows.length,
    retried: 0,
    delivered: 0,
    stillFailing: 0,
    skippedObsolete: 0,
    claimLost: 0,
    claimIndeterminate: 0,
  };

  for (const row of rows) {
    const n = row.notification;

    // Obsolete: close as "skipped" (no attempt increment — nothing was
    // attempted); the row exits the retry set by status. Original error
    // text is left in place for forensics.
    const obsolete =
      n === null ||
      n.archivedAt !== null ||
      n.readAt !== null ||
      (n.expiresAt !== null && n.expiresAt <= now) ||
      !n.user?.email;
    if (obsolete) {
      await client.notificationDelivery.update({
        where: { id: row.id },
        data: { status: "skipped" },
      });
      result.skippedObsolete++;
      continue;
    }

    // CLAIM before send (duplicate-send prevention — header doctrine).
    const claim = await client.notificationDelivery.updateMany({
      where: { id: row.id, status: "error", attempts: row.attempts },
      data: { attempts: { increment: 1 } },
    });

    // RLS-C-S6a — a lost claim must be a lost RACE, not an invisible row.
    // CAUGHT rather than propagated, and this is the one site of the four where
    // that is the right call: the batch is a hundred INDEPENDENT rows, and one
    // row that cannot be seen is no reason to abandon the ninety-nine that can.
    // What must not survive is the silence, so it gets its own counter and an
    // error log instead of being folded into claimLost's calm verdict.
    let claimed: boolean;
    try {
      claimed = await resolveConditionalWrite(
        claim.count,
        { table: "NotificationDelivery", rowId: row.id, operation: "update" },
        () => client.notificationDelivery.count({ where: { id: row.id } }),
      );
    } catch (err) {
      if (!(err instanceof IndeterminateWriteError)) throw err;
      console.error(`[notification-retry] INDETERMINATE claim on delivery ${row.id} — not a race: ${err.message}`);
      result.claimIndeterminate++;
      continue;
    }
    if (!claimed) {
      result.claimLost++;
      continue;
    }

    // Re-deliver through the SAME adapter create.ts uses — no second email
    // path. The adapter never throws by contract.
    result.retried++;
    const outcome = await adapter.deliver({
      userId: n.userId,
      email: n.user!.email,
      type: n.type,
      category: n.category as NotificationCategory,
      priority: n.priority as NotificationPriorityValue,
      title: n.title,
      ...(n.body ? { body: n.body } : {}),
      ...(n.href ? { href: n.href } : {}),
    });

    // Outcome write — ChannelResult verbatim, deliveredAt only on "sent"
    // (field-for-field the create.ts bookkeeping).
    await client.notificationDelivery.update({
      where: { id: row.id },
      data: {
        status: outcome.status,
        provider: outcome.provider ?? null,
        providerMessageId: outcome.id ?? null,
        error: outcome.error ?? null,
        deliveredAt: outcome.status === "sent" ? new Date() : null,
      },
    });

    if (outcome.status === "sent" || outcome.status === "captured") result.delivered++;
    else result.stillFailing++;
  }

  if (result.examined > 0) {
    console.log(
      `[notification-retry] examined ${result.examined} — ${result.delivered} delivered, ` +
        `${result.stillFailing} still failing, ${result.skippedObsolete} obsolete, ${result.claimLost} claim-lost, ` +
        `${result.claimIndeterminate} claim-indeterminate`,
    );
  }

  return result;
}
