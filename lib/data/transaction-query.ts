/**
 * lib/data/transaction-query.ts  (TX-3.0)
 *
 * The server-only KEYSET query authority the future Transaction Explorer will
 * consume. It replaces the "load ≤5,000 rows → filter/sort/paginate in the browser"
 * model with "TransactionQuery → server WHERE + orderBy + keyset → bounded page".
 *
 * It composes — it does not re-derive:
 *   - POPULATION + VISIBILITY: bankingTransactionWhere (FlowType banking population +
 *     KD-15 transaction-detail visibility + soft-delete). The ONE authority; not
 *     duplicated here.
 *   - FILTERS + ORDERING + KEYSET: the pure lib/data/transaction-query-core module.
 *   - DTO: projectTransactionListRows / transactionListInclude — the SAME row shape
 *     and serialization getTransactions produces.
 *
 * It performs NO aggregation, NO calculation, NO UI formatting — it returns a
 * bounded window of DTOs plus a continuation cursor. Transactions do NOT use
 * canonical Perspective time (no preset / asOf / compareTo).
 */

import "server-only";

import { ShareStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { Transaction } from "@/types";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import {
  bankingTransactionWhere,
  transactionListInclude,
  projectTransactionListRows,
} from "@/lib/data/transactions";
import {
  clampLimit,
  orderByForSort,
  keysetWhere,
  buildFilterWhere,
  nextCursorFrom,
  type TransactionQuery,
  type TransactionCursor,
} from "@/lib/data/transaction-query-core";

export type {
  TransactionQuery,
  TransactionCursor,
  TransactionSort,
} from "@/lib/data/transaction-query-core";
export { MAX_TRANSACTION_PAGE_SIZE } from "@/lib/data/transaction-query-core";

export interface TransactionQueryResult {
  /** The bounded page of DTOs, in the requested sort order. */
  rows: Transaction[];
  /** Continuation token for the next page, or null when the page is the last. */
  nextCursor: TransactionCursor | null;
  /** Whether another page exists (a `limit + 1` sentinel was fetched). */
  hasMore: boolean;
}

/**
 * Resolve the FinancialAccount ids VISIBLE to this Space at transaction-detail
 * grant (the SAME KD-15 rule bankingTransactionWhere applies through its relation
 * join). Used only to constrain an explicit `accountIds` filter — a caller can
 * never widen a query to an account the Space cannot see. This is a visibility
 * guard, NOT a second population authority (population = FlowType, unchanged).
 */
export async function resolveVisibleAccountIds(spaceId: string): Promise<Set<string>> {
  const accounts = await db.financialAccount.findMany({
    where: {
      deletedAt: null,
      spaceAccountLinks: {
        some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
      },
    },
    select: { id: true },
  });
  return new Set(accounts.map((a) => a.id));
}

/**
 * Execute a bounded keyset page. Ordering is a strict total order (sort key + id),
 * so paging never duplicates or skips a row. The population/visibility/soft-delete
 * WHERE, the filters, and the keyset are ANDed as SEPARATE terms so no `flowType`/
 * `date` fragment ever overwrites another.
 */
export async function queryTransactions(args: {
  spaceId?: string;
  query: TransactionQuery;
}): Promise<TransactionQueryResult> {
  const spaceId = args.spaceId ?? (await getSpaceContext()).spaceId;
  const query = args.query;
  const limit = clampLimit(query.limit);

  // Account isolation: constrain an explicit accountIds filter to the visible set.
  // The population join already prevents leakage; this makes the intersection
  // explicit and lets an all-invisible request short-circuit to an empty page.
  let accountIds = query.accountIds;
  if (accountIds && accountIds.length > 0) {
    const visible = await resolveVisibleAccountIds(spaceId);
    accountIds = accountIds.filter((id) => visible.has(id));
    if (accountIds.length === 0) return { rows: [], nextCursor: null, hasMore: false };
  }

  const where: Prisma.TransactionWhereInput = {
    AND: [
      bankingTransactionWhere(spaceId),
      buildFilterWhere({ ...query, accountIds }),
      keysetWhere(query.sort, query.cursor),
    ].filter((w): w is Prisma.TransactionWhereInput => w != null),
  };

  const fetched = await db.transaction.findMany({
    where,
    orderBy: orderByForSort(query.sort),
    take: limit + 1, // +1 sentinel → hasMore, no second query
    include: transactionListInclude(spaceId),
  });

  const { pageRows, nextCursor, hasMore } = nextCursorFrom(fetched, query.sort, limit);
  const rows = await projectTransactionListRows(pageRows, spaceId);
  return { rows, nextCursor, hasMore };
}
