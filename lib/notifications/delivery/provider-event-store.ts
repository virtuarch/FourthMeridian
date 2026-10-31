/**
 * lib/notifications/delivery/provider-event-store.ts  (Comms Center Phase C)
 *
 * The production I/O behind the Resend webhook (provider-events.ts) and its
 * read-only health. AUTHORITY: systemDb (fm_system) — CommsDelivery and
 * CommsProviderEvent are revoked from fm_app / fm_auth; the webhook is a
 * machine route with no session. Imported lazily, as lib/notifications/
 * delivery/store.ts is, so the receiver stays free of the database at import.
 *
 * COST: the match is two indexed reads (@@index([providerMessageId]), then
 * @@index([messageKey]), ≤ 50 rows); the commit is one transaction of one or
 * two INSERTs. Never selects a payload: none is stored.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import type { CommsDeliveryRow } from "@/lib/notifications/delivery/types";
import {
  WEBHOOK_REJECTION_UNIT,
  WEBHOOK_USAGE_PROVIDER,
  type LedgerRowRead,
  type ProviderEventInsert,
  type ProviderEventStore,
  type WebhookHealthRows,
} from "@/lib/notifications/delivery/provider-events";
import type { SvixRejection } from "@/lib/notifications/delivery/svix";

const MESSAGE_ROWS_MAX = 50;

const LEDGER_SELECT = {
  id: true, createdAt: true, messageKey: true, definitionKey: true, definitionVersion: true, templateVersion: true,
  channel: true, status: true, reason: true, provider: true, providerMessageId: true, attempt: true, errorCode: true,
  recipientUserId: true, recipientHash: true, notificationId: true, environment: true, acceptedAt: true,
  contentVersionId: true, mode: true, automationRunItemId: true, deliveredAt: true,
} as const;

async function sys() {
  return (await import("@/lib/db")).systemDb;
}

export const providerEventStore: ProviderEventStore = {
  async findMessageRows(providerMessageId) {
    const db = await sys();
    const hit = await db.commsDelivery.findFirst({
      where: { providerMessageId },
      orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
      select: { channel: true, messageKey: true },
    });
    if (!hit) return [];
    const rows = await db.commsDelivery.findMany({
      where: { channel: hit.channel, messageKey: hit.messageKey },
      orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
      take: MESSAGE_ROWS_MAX,
      select: LEDGER_SELECT,
    });
    return rows as unknown as LedgerRowRead[];
  },

  async commit(event: ProviderEventInsert, append: CommsDeliveryRow | null) {
    const db = await sys();
    try {
      await db.$transaction(async (tx) => {
        await tx.commsProviderEvent.createMany({ data: [event] });
        if (append) await tx.commsDelivery.createMany({ data: [append] });
      });
      return "stored";
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "duplicate";
      throw err;
    }
  },
};

/** Count one signature rejection, by reason (a daily counter; never the body, headers or IP). Non-throwing. */
export async function recordWebhookRejection(reason: SvixRejection): Promise<void> {
  const { recordApiUsage } = await import("@/lib/usage/record");
  await recordApiUsage(WEBHOOK_USAGE_PROVIDER, `signature:${reason}`, WEBHOOK_REJECTION_UNIT);
}

// ── Health readers (Platform Ops → email health) ────────────────────────────

/** "createdAt" is TIMESTAMP WITHOUT TIME ZONE holding UTC: bind the UTC wall clock as a string (no timestamptz conversion). */
const utcWall = (d: Date) => d.toISOString().slice(0, 23);

export async function readWebhookHealthRows(since: Date, staleBefore: Date | null): Promise<WebhookHealthRows> {
  const db = await sys();
  const [last, grouped, usage, stale] = await Promise.all([
    db.commsProviderEvent.findFirst({ orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    db.commsProviderEvent.groupBy({ by: ["type", "outcome"], where: { receivedAt: { gte: since } }, _count: { _all: true } }),
    db.apiUsageCounter.findMany({
      where: { provider: WEBHOOK_USAGE_PROVIDER, unit: WEBHOOK_REJECTION_UNIT, day: { gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())) } },
      select: { metric: true, count: true },
    }),
    staleBefore && staleBefore > since
      ? db.$queryRaw<Array<{ n: number; u: number }>>`
          WITH finals AS (
            SELECT DISTINCT ON ("channel", "messageKey") "status", "providerMessageId"
              FROM "CommsDelivery"
             WHERE "provider" = 'resend' AND "mode" = 'LIVE'
               AND "channel" IN ('EMAIL', 'OPERATOR_EMAIL')
               AND "createdAt" >= (${utcWall(since)})::timestamp AND "createdAt" < (${utcWall(staleBefore)})::timestamp
             ORDER BY "channel", "messageKey", "attempt" DESC, "createdAt" DESC, "id" DESC
          )
          -- N-b: an ACCEPTED row with NO provider id (an UNCERTAIN_ACCEPTANCE idempotency conflict) can
          -- never match an event — counted apart, never as "awaiting confirmation" (isExpectedUnmatchable).
          SELECT (COUNT(*) FILTER (WHERE "status" = 'ACCEPTED' AND "providerMessageId" IS NOT NULL))::int AS n,
                 (COUNT(*) FILTER (WHERE "status" = 'ACCEPTED' AND "providerMessageId" IS NULL))::int AS u
            FROM finals`
      : Promise.resolve(null),
  ]);
  return {
    lastReceivedAt: last?.receivedAt ?? null,
    byTypeOutcome: grouped.map((g) => ({ type: g.type, outcome: g.outcome, count: g._count._all })),
    rejections: usage.map((u) => ({ metric: u.metric, count: Number(u.count) })),
    acceptedWithoutEvent: stale ? Number(stale[0]?.n ?? 0) : null,
    acceptedUncertain: stale ? Number(stale[0]?.u ?? 0) : null,
  };
}
