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
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
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
           AND "createdAt" <  (${q.to}::date + 1)::timestamp ${ledgerFilters}
         ORDER BY "channel", "messageKey", "attempt" DESC, "createdAt" DESC, "id" DESC
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
};
