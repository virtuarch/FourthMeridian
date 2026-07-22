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

import { ShareStatus, FlowType, TransactionCategory } from "@prisma/client";
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
  resolveCursor,
  parseTransactionQuery,
  type TransactionQuery,
  type TransactionCursor,
  type TransactionQueryParseResult,
} from "@/lib/data/transaction-query-core";

export type {
  TransactionQuery,
  TransactionCursor,
  TransactionSort,
  TransactionSource,
} from "@/lib/data/transaction-query-core";
export { MAX_TRANSACTION_PAGE_SIZE, encodeCursor } from "@/lib/data/transaction-query-core";

/**
 * The live enum vocabularies the M3 parser validates against. The pure core stays
 * free of generated-client coupling, so the vocabulary is supplied HERE (the
 * server seam that already imports @prisma/client) and derived from the enums
 * themselves — a new FlowType or TransactionCategory is accepted automatically, and
 * the parser can never drift from the schema.
 */
export const TRANSACTION_QUERY_VOCABULARY = {
  flowTypes:  Object.values(FlowType)  as readonly string[],
  categories: Object.values(TransactionCategory) as readonly string[],
} as const;

/**
 * Parse untrusted request search params into a validated `TransactionQuery`.
 * The ONE entry point a route should use — it binds the live vocabulary so no
 * route hand-rolls enum validation (and so none can forget to).
 */
export function parseTransactionQueryParams(params: URLSearchParams): TransactionQueryParseResult {
  return parseTransactionQuery(params, TRANSACTION_QUERY_VOCABULARY);
}

export interface TransactionQueryResult {
  /** The bounded page of DTOs, in the requested sort order. */
  rows: Transaction[];
  /** Continuation token for the next page, or null when the page is the last. */
  nextCursor: TransactionCursor | null;
  /** Whether another page exists (a `limit + 1` sentinel was fetched). */
  hasMore: boolean;
  /**
   * M2 — true when the supplied cursor did not belong to the requested sort and was
   * DROPPED (this page is therefore the first page of the new sort). Surfaced rather
   * than hidden: a consumer appending pages must RESET its accumulated list when it
   * sees this, or it would concatenate two different orderings.
   */
  cursorReset: boolean;
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

  // M2 — a cursor is only valid under the sort it was minted from. A mismatch drops
  // the cursor and is REPORTED, never silently misapplied.
  const { cursor, reset: cursorReset } = resolveCursor(query.sort, query.cursor);

  // Account isolation: constrain an explicit accountIds filter to the visible set.
  // The population join already prevents leakage; this makes the intersection
  // explicit and lets an all-invisible request short-circuit to an empty page.
  let accountIds = query.accountIds;
  if (accountIds && accountIds.length > 0) {
    const visible = await resolveVisibleAccountIds(spaceId);
    accountIds = accountIds.filter((id) => visible.has(id));
    if (accountIds.length === 0) return { rows: [], nextCursor: null, hasMore: false, cursorReset };
  }

  const where: Prisma.TransactionWhereInput = {
    AND: [
      bankingTransactionWhere(spaceId),
      buildFilterWhere({ ...query, accountIds }),
      keysetWhere(query.sort, cursor ?? undefined),
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
  return { rows, nextCursor, hasMore, cursorReset };
}
