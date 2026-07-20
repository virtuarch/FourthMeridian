/**
 * lib/data/transaction-aggregate.ts  (TX-3.1b)
 *
 * The server-only AGGREGATE authority — the sibling of `queryTransactions`.
 *
 * WHY A SIBLING AND NOT A FIELD ON THE PAGE (review finding M7):
 *   Totals must never be computed from paginated rows. A page holds ≤100 rows of a
 *   set that may hold thousands, so any figure derived from it is a lie shaped like
 *   a number. This authority answers "how many / how much" over the WHOLE filtered
 *   set, independently of paging.
 *
 * THE PARITY GUARANTEE:
 *   It shares `buildFilterWhere` and `bankingTransactionWhere` VERBATIM with
 *   `queryTransactions`. The count and the list are therefore the same population by
 *   construction, not by convention — the one thing that keeps "1,284 results" honest
 *   as the list scrolls. The ONLY intentional difference is the keyset: an aggregate
 *   spans the whole set, so it never applies the cursor.
 *
 * It performs no UI formatting and returns no rows.
 */

import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { bankingTransactionWhere } from "@/lib/data/transactions";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { buildFilterWhere, toISODate, type TransactionQuery } from "@/lib/data/transaction-query-core";
import {
  foldAggregateGroups,
  conversionKeysFor,
  type AggregateGroup,
  type TransactionAggregate,
} from "@/lib/data/transaction-aggregate-core";
import { resolveVisibleAccountIds } from "@/lib/data/transaction-query";

export type { TransactionAggregate } from "@/lib/data/transaction-aggregate-core";

/**
 * Count + converted per-flow-type magnitudes for a `TransactionQuery`.
 *
 * `cursor`, `sort` and `limit` are IGNORED by design — an aggregate is a property of
 * the filtered SET, not of any page through it.
 */
export async function aggregateTransactions(args: {
  spaceId?: string;
  query: TransactionQuery;
}): Promise<TransactionAggregate> {
  const spaceId = args.spaceId ?? (await getSpaceContext()).spaceId;
  const query = args.query;

  // Same visibility intersection as the row query — an aggregate must never count a
  // row the page would not show.
  let accountIds = query.accountIds;
  if (accountIds && accountIds.length > 0) {
    const visible = await resolveVisibleAccountIds(spaceId);
    accountIds = accountIds.filter((id) => visible.has(id));
    if (accountIds.length === 0) {
      const ctx = await buildSpaceConversionContextById(spaceId, { currencies: [], dates: [] });
      return { count: 0, totalsByFlowType: {}, currency: ctx.target, estimated: false };
    }
  }

  // The SHARED where — population/visibility + the identical filter fragments the
  // row query uses. No keyset term (see the header note).
  const where: Prisma.TransactionWhereInput = {
    AND: [
      bankingTransactionWhere(spaceId),
      buildFilterWhere({ ...query, accountIds }),
    ],
  };

  // The sign split is what makes the magnitude exact: a single signed sum per group
  // would net inflows against outflows, and |net| ≠ Σ|row|. See the core module's
  // exactness argument.
  const by = ["flowType", "currency", "date"] as const;
  const [count, positives, negatives] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.groupBy({
      by: [...by],
      where: { AND: [where, { amount: { gt: 0 } }] },
      _sum: { amount: true },
    }),
    db.transaction.groupBy({
      by: [...by],
      where: { AND: [where, { amount: { lt: 0 } }] },
      _sum: { amount: true },
    }),
  ]);

  const groups: AggregateGroup[] = [...positives, ...negatives].map((g) => ({
    flowType: g.flowType ?? null,
    currency: g.currency ?? null,
    date: toISODate(g.date),
    sum: g._sum.amount ?? null,
  }));

  // Prefetch exactly the (currency × date) pairs the fold will convert — nothing
  // more. A Space whose rows are all already in its reporting currency resolves
  // through the identity fast path and performs ZERO archive lookups.
  const ctx = await buildSpaceConversionContextById(spaceId, conversionKeysFor(groups));
  return foldAggregateGroups(groups, count, ctx);
}
