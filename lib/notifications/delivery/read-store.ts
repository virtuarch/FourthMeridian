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
 * COST: two GROUP BY queries per request, bounded by the window (≤ 90 UTC days)
 * and served by the createdAt / (definitionKey, createdAt) indexes and the
 * rollup's (day, …) primary key. Never selects a recipient column.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import type { DeliveryCountQuery, DeliveryCountRow, DeliveryReadSource } from "@/lib/notifications/delivery/analytics";

const DAY_MS = 86_400_000;
/** YYYY-MM-DD → that UTC midnight. */
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);

function filters(q: DeliveryCountQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (q.channel) parts.push(Prisma.sql`AND "channel" = ${q.channel}`);
  if (q.status) parts.push(Prisma.sql`AND "status" = ${q.status}`);
  if (q.key) parts.push(Prisma.sql`AND "definitionKey" = ${q.key}`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

export const deliveryReadSource: DeliveryReadSource = {
  async ledgerSince() {
    const rows = await systemDb.$queryRaw<Array<{ since: string | null }>>`
      SELECT to_char(LEAST(
               (SELECT min("createdAt")::date FROM "CommsDelivery"),
               (SELECT min("day") FROM "CommsDeliveryDaily")
             ), 'YYYY-MM-DD') AS since`;
    return rows[0]?.since ?? null;
  },

  async counts(q) {
    const fromTs = dayStart(q.from);
    const toExclusive = new Date(dayStart(q.to).getTime() + DAY_MS);
    const f = filters(q);
    const rows = await systemDb.$queryRaw<Array<{ day: string; definitionKey: string; channel: string; status: string; reason: string; count: number }>>`
      SELECT to_char(u."day", 'YYYY-MM-DD') AS "day", u."definitionKey", u."channel", u."status", u."reason",
             SUM(u."n")::int AS "count"
        FROM (
          SELECT ("createdAt")::date AS "day", "definitionKey", "channel", "status",
                 COALESCE("reason", '') AS "reason", COUNT(*) AS "n"
            FROM "CommsDelivery"
           WHERE "createdAt" >= ${fromTs} AND "createdAt" < ${toExclusive} ${f}
           GROUP BY 1, 2, 3, 4, 5
          UNION ALL
          SELECT "day", "definitionKey", "channel", "status", "reason", SUM("count") AS "n"
            FROM "CommsDeliveryDaily"
           WHERE "day" >= ${fromTs}::date AND "day" < ${toExclusive}::date ${f}
           GROUP BY 1, 2, 3, 4, 5
        ) u
       GROUP BY 1, 2, 3, 4, 5`;
    return rows.map((r): DeliveryCountRow => ({ ...r, count: Number(r.count) }));
  },
};
