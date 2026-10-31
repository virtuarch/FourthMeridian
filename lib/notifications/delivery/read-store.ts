/**
 * lib/notifications/delivery/read-store.ts  (Comms Center Phase A-2a)
 *
 * The production DeliveryReadSource: aggregate counts from the ledger
 * (CommsDelivery, ≤ 90 days) UNION the rollup (CommsDeliveryDaily, older).
 * The retention rollup moves a row from the first table to the second in ONE
 * transaction (lib/notifications/delivery/rollup.ts), so summing both never
 * counts a send twice.
 *
 * AUTHORITY: systemDb (fm_system) — both tables are revoked from fm_app; the
 * route is gated to Customer Success READ before this runs.
 *
 * COST: two queries per request (ledgerSince + one DISTINCT ON / GROUP BY), bounded by the window (≤ 90 UTC days)
 * and served by the createdAt / (definitionKey, createdAt) indexes and the
 * rollup's (day, …) primary key. Never selects a recipient column.
 *
 * Comms Center B2 (contract v1.1 §6.9): operator TEST sends (mode "TEST") are
 * excluded — analytics count LIVE messages only.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { MEASURING_EVENT_WHERE } from "@/lib/notifications/delivery/provider-events";
import type { DeliveryCountQuery, DeliveryCountRow, DeliveryReadSource } from "@/lib/notifications/delivery/analytics";

function filters(q: DeliveryCountQuery, withStatus: boolean): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (q.channel) parts.push(Prisma.sql`AND "channel" = ${q.channel}`);
  if (withStatus && q.status) parts.push(Prisma.sql`AND "status" = ${q.status}`);
  if (q.key) parts.push(Prisma.sql`AND "definitionKey" = ${q.key}`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

export const deliveryReadSource: DeliveryReadSource = {
  async ledgerSince() {
    // "createdAt" is TIMESTAMP WITHOUT TIME ZONE holding UTC (Prisma); its ::date is
    // the UTC day whatever the session TimeZone. "day" is a DATE.
    const rows = await systemDb.$queryRaw<Array<{ since: string | null }>>`
      SELECT to_char(LEAST(
               (SELECT min("createdAt")::date FROM "CommsDelivery"),
               (SELECT min("day") FROM "CommsDeliveryDaily")
             ), 'YYYY-MM-DD') AS since`;
    return rows[0]?.since ?? null;
  },

  /**
   * MESSAGES, not attempts (contract v1.0.2): each (channel, messageKey) counts
   * ONCE, by its highest attempt (ties: latest createdAt, then id — the rollup's
   * order), on that attempt's UTC day. The status filter applies to that FINAL
   * status, so a retried-then-accepted email is never a FAILED.
   *
   * UTC, independent of the session TimeZone: the bounds are bound as ISO DATE
   * STRINGS (no JS Date parameter, so no timestamptz conversion), and days come
   * from date_trunc / ::date on the timezone-less UTC column.
   */
  async counts(q) {
    const ledgerFilters = filters(q, false);
    const dailyFilters = filters(q, true);
    const statusFilter = q.status ? Prisma.sql`WHERE "status" = ${q.status}` : Prisma.empty;
    const rows = await systemDb.$queryRaw<Array<{ day: string; definitionKey: string; channel: string; status: string; reason: string; count: number }>>`
      WITH finals AS (
        SELECT DISTINCT ON ("channel", "messageKey")
               to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "day",
               "definitionKey", "channel", "status", COALESCE("reason", '') AS "reason"
          FROM "CommsDelivery"
         WHERE "createdAt" >= (${q.from}::date)::timestamp
           AND "createdAt" <  (${q.to}::date + 1)::timestamp
           AND "mode" = 'LIVE' ${ledgerFilters}
         ORDER BY "channel", "messageKey", "attempt" DESC,
                  -- REVIEW F1: rank-aware within an attempt (provider-events.ts STATUS_RANK / currentRow)
                  CASE "status" WHEN 'COMPLAINED' THEN 3 WHEN 'BOUNCED' THEN 2 WHEN 'DELIVERED' THEN 1 ELSE 0 END DESC,
                  "createdAt" DESC, "id" DESC
      )
      SELECT u."day", u."definitionKey", u."channel", u."status", u."reason", SUM(u."n")::int AS "count"
        FROM (
          SELECT "day", "definitionKey", "channel", "status", "reason", COUNT(*) AS "n"
            FROM finals ${statusFilter}
           GROUP BY 1, 2, 3, 4, 5
          UNION ALL
          SELECT to_char("day", 'YYYY-MM-DD'), "definitionKey", "channel", "status", "reason", SUM("count") AS "n"
            FROM "CommsDeliveryDaily"
           WHERE "day" >= ${q.from}::date AND "day" <= ${q.to}::date ${dailyFilters}
           GROUP BY 1, 2, 3, 4, 5
        ) u
       GROUP BY 1, 2, 3, 4, 5`;
    return rows.map((r): DeliveryCountRow => ({ ...r, count: Number(r.count) }));
  },

  /**
   * Phase C — accepted-uncertain: final-ACCEPTED provider emails with no provider id (the R4
   * UNCERTAIN_ACCEPTANCE sends), LIVE only, by the same message order as `counts`. Ledger only:
   * a ≤ 90-day window is entirely inside the ledger (the rollup boundary is today − 90 days).
   */
  async acceptedUncertainCount(q) {
    const ledgerFilters = filters(q, false);
    const rows = await systemDb.$queryRaw<Array<{ n: number }>>`
      WITH finals AS (
        SELECT DISTINCT ON ("channel", "messageKey") "status", "provider", "providerMessageId"
          FROM "CommsDelivery"
         WHERE "createdAt" >= (${q.from}::date)::timestamp
           AND "createdAt" <  (${q.to}::date + 1)::timestamp
           AND "mode" = 'LIVE' AND "channel" IN ('EMAIL', 'OPERATOR_EMAIL') ${ledgerFilters}
         ORDER BY "channel", "messageKey", "attempt" DESC,
                  CASE "status" WHEN 'COMPLAINED' THEN 3 WHEN 'BOUNCED' THEN 2 WHEN 'DELIVERED' THEN 1 ELSE 0 END DESC,
                  "createdAt" DESC, "id" DESC
      )
      SELECT COUNT(*)::int AS n FROM finals
       WHERE "status" = 'ACCEPTED' AND "provider" = 'resend' AND "providerMessageId" IS NULL`;
    return Number(rows[0]?.n ?? 0);
  },

  /** Phase C — one indexed probe: does this environment hold a verified provider event? */
  async verifiedEventExists() {
    // REVIEW F3 — UNMATCHED events (e.g. another environment on a shared Resend account) do not count.
    return (await systemDb.commsProviderEvent.findFirst({ where: MEASURING_EVENT_WHERE, select: { id: true } })) !== null;
  },
};
