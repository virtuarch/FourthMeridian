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
 *   NEVER    "sent" / "captured" (accepted, or held back by capture / the
 *            non-production recipient guard — never a failure) · "skipped" (deliberate) ·
 *            "error" at the cap — the terminal, queryable dead-letter state
 *            (no DLQ infrastructure, by the investigation's ruling).
 *   OBSOLETE a delivery whose notification is archived, expired, or already
 *            READ in-app, or whose recipient has no email, or whose type now
 *            excludes EMAIL (registry `excludedChannels`) — re-mailing has
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
import { recomputeActionLabel } from "@/lib/notifications/action-label";
import { getNotificationDefinition } from "@/lib/notifications/registry";
import { isEmailAnchorMetadata } from "@/lib/notifications/email-anchor";
import { notificationLedgerRow, recordDelivery } from "@/lib/notifications/delivery/record";
import { writeDeliveryRow } from "@/lib/notifications/delivery/store";
import type { LedgerWriter } from "@/lib/notifications/delivery/types";
import { retryEmailParts, type LiveContentResolver } from "@/lib/notifications/content/send";
import { defaultLiveContentResolver } from "@/lib/notifications/content/store";
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
  /** A-2a: the delivery ledger's messageKey — every retry of this email is the same message. */
  notificationId?: string;
  notification: {
    userId: string;
    type: string;
    category: string;
    priority: string;
    title: string;
    body: string | null;
    href: string | null;
    /** The createNotification input data — read (never written) to recompute the email CTA label. */
    metadata?: unknown;
    readAt: Date | null;
    archivedAt: Date | null;
    expiresAt: Date | null;
    /** A-2b: an email anchor still holding its key is an OPEN condition (see the obsolete rule). */
    dedupeKey?: string | null;
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
        notificationId: true;
        notification: {
          select: {
            userId: true;
            type: true;
            category: true;
            priority: true;
            title: true;
            body: true;
            href: true;
            metadata: true;
            readAt: true;
            archivedAt: true;
            expiresAt: true;
            dedupeKey: true;
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
  /**
   * A-2a delivery ledger. Default: the production writer when this runs on the
   * real client, and NOTHING for an injected test client (never a real DB).
   */
  ledger?: LedgerWriter | null,
  /**
   * Comms Center B1 — the live-content resolver for the EMAIL leg (the retried
   * email re-renders the EMAIL stream's published version, never the stored
   * in-app copy). Default: production on the real client, none for a test client.
   */
  content?: LiveContentResolver | null,
): Promise<RetryNotificationsResult> {
  const writer: LedgerWriter | null =
    ledger !== undefined ? ledger : (client === (db as unknown as NotificationRetryClient) ? writeDeliveryRow : null);
  const resolver: LiveContentResolver | null =
    content !== undefined ? content : (client === (db as unknown as NotificationRetryClient) ? defaultLiveContentResolver : null);
  const rows = await client.notificationDelivery.findMany({
    where: { channel: "EMAIL", status: "error", attempts: { lt: MAX_DELIVERY_ATTEMPTS } },
    select: {
      id: true,
      attempts: true,
      notificationId: true,
      notification: {
        select: {
          userId: true,
          type: true,
          category: true,
          priority: true,
          title: true,
          body: true,
          href: true,
          metadata: true,
          readAt: true,
          archivedAt: true,
          expiresAt: true,
          dedupeKey: true,
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
    // Also obsolete: a type whose registry entry now EXCLUDES the EMAIL channel
    // (SPACE_INVITE_RECEIVED since 2026-10-31 — its email is the dedicated
    // space-invite email). A legacy failed row must not resurrect the duplicate.
    // Comms Center A-2b: an EMAIL ANCHOR (written archived because the user's
    // in-app channel was off; lib/notifications/create.ts) is archived by
    // design, not resolved — while it still holds its dedupe key the condition
    // is open and its email is retried under the normal policy (attempt cap,
    // DEAD). Retirement releases the key, after which it is obsolete as before.
    const openAnchor =
      n !== null && n.archivedAt !== null && typeof n.dedupeKey === "string" &&
      isEmailAnchorMetadata(n.metadata) && getNotificationDefinition(n.type)?.emailIndependentOfInApp === true;
    const obsolete =
      n === null ||
      (n.archivedAt !== null && !openAnchor) ||
      n.readAt !== null ||
      (n.expiresAt !== null && n.expiresAt <= now) ||
      !n.user?.email ||
      getNotificationDefinition(n.type)?.excludedChannels?.includes("EMAIL") === true;
    if (obsolete) {
      await client.notificationDelivery.update({
        where: { id: row.id },
        data: { status: "skipped" },
      });
      result.skippedObsolete++;
      // A-2a (contract v1.0.2): the message's FINAL attempt on the ledger, so final-status
      // counting closes it as SUPPRESSED instead of leaving its last FAILED standing.
      // Same messageKey (the Notification id), the next attempt number; no send happened.
      if (writer && n !== null && row.notificationId) {
        await recordDelivery(writer, notificationLedgerRow({
          key: n.type, channel: "EMAIL", status: "SUPPRESSED",
          reason: !n.user?.email ? "NO_RECIPIENT" : "OBSOLETE",
          recipientUserId: n.userId, notificationId: row.notificationId,
          attempt: row.attempts + 1, env: process.env, now,
        }));
      }
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
    const actionLabel = recomputeActionLabel(n.type, n.metadata);
    // Comms Center B1 (review P2): the stored row is the IN-APP render. For a
    // content-editable type the email re-renders its OWN leg — the registry
    // render plus the EMAIL stream's published version (contentVersionId on the
    // ledger) — never the operator's in-app wording. Other types: unchanged.
    const parts = await retryEmailParts({
      type: n.type, metadata: n.metadata, stored: { title: n.title, body: n.body, href: n.href },
      resolver, appBaseUrl: process.env.NEXT_PUBLIC_APP_URL,
    });
    const outcome = await adapter.deliver({
      userId: n.userId,
      email: n.user!.email,
      type: n.type,
      category: n.category as NotificationCategory,
      priority: n.priority as NotificationPriorityValue,
      title: parts.title,
      ...(parts.body ? { body: parts.body } : {}),
      ...(parts.href ? { href: parts.href } : {}),
      ...(parts.emailContent ? { emailContent: parts.emailContent } : {}),
      // The CTA label is email-only and never persisted: recompute it from the
      // persisted type + metadata through the same registry render (SYNC_FAILED
      // without a derivable state → the conservative "Review connection").
      ...(n.href && actionLabel ? { actionLabel } : {}),
      // Delivery ledger (A-2a): this is attempt attempts+1; at the cap an error is DEAD.
      attempt: row.attempts + 1,
      ...(row.notificationId ? { notificationId: row.notificationId } : {}),
      finalAttempt: row.attempts + 1 >= MAX_DELIVERY_ATTEMPTS,
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
