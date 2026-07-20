/**
 * lib/data/transaction-count.ts  (TX-3.3)
 *
 * The COUNT authority for the Transaction Explorer — the sibling of
 * `queryTransactions`, and deliberately nothing more.
 *
 * SCOPE (why this is a count and not an "aggregate"):
 *   The explorer is an INVESTIGATION surface: question → answer → inspect → act. The
 *   only set-level fact it owns is "how many rows answer this question" — which is
 *   exact, currency-free, and needs no doctrine. Money ANALYTICS (per-flow-type
 *   totals, category rollups, temporal shape) are NOT the explorer's semantic
 *   authority; they belong to the Cash Flow projection layer, which owns the
 *   conversion and classification doctrine those figures depend on. This module
 *   deliberately does not compute them.
 *
 *   An earlier TX-3.1b draft shipped a converted per-flow-type aggregate here. It had
 *   no consumer and it claimed semantic authority over money figures that Cash Flow
 *   owns — so it was removed rather than left to rot. Only add to this module when a
 *   real consumer AND a clear owner exist.
 *
 * THE PARITY GUARANTEE:
 *   It shares `bankingTransactionWhere` and `buildFilterWhere` VERBATIM with
 *   `queryTransactions`, so the count and the list are the same population by
 *   construction rather than by convention — the one thing that keeps "1,284 results"
 *   honest while the list scrolls. The ONLY intentional difference is the keyset: a
 *   count spans the whole set, so it never applies the cursor.
 */

import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { bankingTransactionWhere } from "@/lib/data/transactions";
import { buildFilterWhere, type TransactionQuery } from "@/lib/data/transaction-query-core";
import { resolveVisibleAccountIds } from "@/lib/data/transaction-query";

/**
 * Exact number of rows matching a `TransactionQuery`.
 *
 * `cursor`, `sort` and `limit` are IGNORED by design — a count is a property of the
 * filtered SET, not of any page through it.
 */
export async function countTransactions(args: {
  spaceId?: string;
  query: TransactionQuery;
}): Promise<number> {
  const spaceId = args.spaceId ?? (await getSpaceContext()).spaceId;
  const query = args.query;

  // The same visibility intersection the row query applies — a count must never
  // include a row the page would not show.
  let accountIds = query.accountIds;
  if (accountIds && accountIds.length > 0) {
    const visible = await resolveVisibleAccountIds(spaceId);
    accountIds = accountIds.filter((id) => visible.has(id));
    if (accountIds.length === 0) return 0;
  }

  const where: Prisma.TransactionWhereInput = {
    AND: [
      bankingTransactionWhere(spaceId),
      buildFilterWhere({ ...query, accountIds }),
    ],
  };

  return db.transaction.count({ where });
}
