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
import type { ReadClient } from "@/lib/db/tenant-context";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { assertOneRowPerEvent } from "@/lib/transactions/event-projection";
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
  toDbDate,
  type TransactionCorpusBounds,
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
export { MAX_TRANSACTION_PAGE_SIZE, encodeCursor, transactionCoverage } from "@/lib/data/transaction-query-core";
export type { TransactionCorpusBounds, TransactionCoverage } from "@/lib/data/transaction-query-core";

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
 *
 * RLS-C-S3 — `client` is REQUIRED and leading. The guard answers "which accounts
 * may this Space see transaction detail for", and the answer depends entirely on
 * which role asks: on the migration principal it is the whole link table, on a
 * tenant client it is additionally filtered by `fm_account_visible`. Those are
 * two different questions and they used to be spelled the same way.
 */
export async function resolveVisibleAccountIds(
  client: ReadClient,
  spaceId: string,
): Promise<Set<string>> {
  const accounts = await client.financialAccount.findMany({
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
 *
 * ── RLS-C-S3 — THE AUTHORITY IS THE FIRST ARGUMENT ──────────────────────────
 * S1 made the SPACE explicit. The AUTHORITY was still ambient: this module
 * imported the migration principal — the one client exempt from every policy —
 * and every page, count and span ran through it, so a tenant-scoped read and a
 * platform-wide one were indistinguishable at the call site.
 *
 * `client` is typed `ReadClient` (= `Prisma.TransactionClient`), which has no
 * `$transaction` member: this leaf CANNOT open a transaction of its own, so the
 * phase boundary always belongs to the caller and `withTenantDb`'s
 * transaction-local identity can never be undercut from in here. `PrismaClient`
 * is structurally assignable, so a job holding `systemDb` — or a not-yet-converted
 * caller holding `db` — can still pass one, VISIBLY. What it cannot do is pass
 * nothing: an optional authority is an ambient one.
 */
export async function queryTransactions(
  client: ReadClient,
  args: {
    /** RLS-C-S1 — REQUIRED. The ambient space-context fallback is gone: a
     *  leaf read may not invent the tenant whose rows it is paging. */
    spaceId: string;
    query: TransactionQuery;
  },
): Promise<TransactionQueryResult> {
  const spaceId = args.spaceId;
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
    const visible = await resolveVisibleAccountIds(client, spaceId);
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

  const fetched = await client.transaction.findMany({
    where,
    orderBy: orderByForSort(query.sort),
    take: limit + 1, // +1 sentinel → hasMore, no second query
    include: transactionListInclude(spaceId),
  });

  const { pageRows, nextCursor, hasMore } = nextCursorFrom(fetched, query.sort, limit);
  // L8-B1 — the keyset explorer inherits the projection filter through
  // bankingTransactionWhere; this refuses the page if it ever stops doing so.
  assertOneRowPerEvent(pageRows, "queryTransactions");
  // RLS-C-S3 — the projection runs on the SAME client the page was read with, so
  // one authority answers the whole DTO rather than two halves of it.
  const rows = await projectTransactionListRows(client, pageRows, spaceId);
  return { rows, nextCursor, hasMore, cursorReset };
}

/**
 * How many rows a query MATCHES, as distinct from how many a page RETURNS.
 *
 * ⚠️ THE PAGE IS NOT THE POPULATION, AND A CONSUMER THAT CONFLATES THEM WILL
 * STATE AN ABSENCE IT NEVER ESTABLISHED. Measured (58b352f): a correct nine-month
 * window matched 80 transfers; the first page returned the newest 50, ending
 * three days short of the evidence; the assistant reported that none existed.
 * `hasMore` was true in the same payload and said only "another page exists" —
 * a transport fact, not an evidence one. This says how much was not looked at.
 *
 * ⚠️ A COUNT, NOT AN EXHAUSTION. One indexed aggregate over the same WHERE the
 * page uses — no rows materialized, no FX, no transfer assessment, and it stays
 * correct above the row ceiling where exhaustion cannot. `readWindowToExhaustion`
 * remains the right tool when the ROWS themselves are needed (597745a's ranking);
 * this is for when only the SIZE is.
 *
 * Population, visibility, soft-delete and the filters are the query's own —
 * `bankingTransactionWhere` + `buildFilterWhere`, exactly as `queryTransactions`
 * composes them. The keyset is deliberately absent: a cursor bounds a page, and
 * a page is the thing this is counting past.
 */
export async function countTransactions(
  /** RLS-C-S3 — REQUIRED and leading, for the same reason as the page: the count
   *  and the page must be the same population read by the same authority. */
  client: ReadClient,
  args: {
    /** RLS-C-S1 — REQUIRED, for the same reason as `queryTransactions` above: the
     *  count and the page must be the same population, named by the same caller. */
    spaceId: string;
    query: Omit<TransactionQuery, 'cursor' | 'limit'>;
  },
): Promise<number> {
  const spaceId = args.spaceId;
  let accountIds = args.query.accountIds;
  if (accountIds && accountIds.length > 0) {
    const visible = await resolveVisibleAccountIds(client, spaceId);
    accountIds = accountIds.filter((id) => visible.has(id));
    if (accountIds.length === 0) return 0;
  }
  return client.transaction.count({
    where: {
      AND: [
        bankingTransactionWhere(spaceId),
        buildFilterWhere({ ...args.query, accountIds } as TransactionQuery),
      ].filter((w): w is Prisma.TransactionWhereInput => w != null),
    },
  });
}

/**
 * The span of transaction history a query over this Space could reach — the
 * CORPUS, as distinct from the WINDOW any one query searched.
 *
 * ⚠️ THIS IS AN AUTHORITY BOUNDARY, NOT A CONVENIENCE. `queryTransactions`
 * answers "what is in this window"; a window with nothing in it and a Space with
 * nothing in it produce the same empty page. A consumer that cannot tell those
 * apart will state the second when it has only established the first. The 2×2
 * causal-evidence experiment (bb2f6ec) measured exactly that: 28 of 28 searches
 * were windowed, every window was genuinely empty, the unwindowed search returned
 * the evidence, and 11 of 18 negative answers escalated a windowed miss into an
 * absence claim.
 *
 * ⚠️ SAME POPULATION AS THE PAGE IT ACCOMPANIES. The bounds come from
 * `bankingTransactionWhere` — the one population/visibility/soft-delete authority
 * `queryTransactions` itself composes. They are NOT derived from the requested
 * window, from the rows returned, or from any filter (`text`, `flowTypes`,
 * `categories`): a search for "coinbase" that matches nothing must still report
 * the span it searched inside, or the metadata would shrink to the miss it is
 * meant to qualify.
 *
 * ⚠️ THE INFORMATION CEILING REACHES THIS TOO. `asOf` bounds the span, so a
 * retrospective read cannot learn from the corpus metadata that later
 * transactions exist. Without it this function would leak the future through the
 * back door the date filter closes at the front.
 *
 * `economicDate` is the L8-B chronology and the column `orderByForSort` orders
 * on. Rows with a null `economicDate` cannot be placed in time and are therefore
 * excluded from the bounds — the same rows the keyset already refuses to page.
 */
export async function transactionCorpusSpan(
  /**
   * RLS-C-S3 — REQUIRED and leading. ⚠️ THIS ONE CARRIES A CONTRACT, NOT JUST AN
   * AUTHORITY. The span is what tells a consumer apart "nothing in this window"
   * from "nothing in this Space", and under a tenant client an empty span can
   * ALSO mean "nothing this identity may see". The two are not the same claim,
   * and the `unavailableReason` below is worded for the first. That is why the AI
   * surface — the one consumer that turns this into English — keeps passing the
   * migration principal in this slice: see docs/plans/RLS-SILENT-REFUSAL-CAS.md.
   */
  client: ReadClient,
  args: {
    spaceId: string;
    /** Information ceiling: nothing dated after this contributes to the span. */
    asOf?: string;
  },
): Promise<TransactionCorpusBounds> {
  const ceiling = args.asOf ? toDbDate(args.asOf) : null;
  const agg = await client.transaction.aggregate({
    where: {
      AND: [
        bankingTransactionWhere(args.spaceId),
        { economicDate: { not: null, ...(ceiling ? { lte: ceiling } : {}) } },
      ],
    },
    _min: { economicDate: true },
    _max: { economicDate: true },
  });
  const from = agg._min.economicDate;
  const to = agg._max.economicDate;
  if (!from || !to) {
    return {
      from: null, to: null,
      unavailableReason: args.asOf
        ? `no dated transactions are available on or before ${args.asOf}`
        : 'no dated transactions are available for this Space',
    };
  }
  return { from: isoDay(from), to: isoDay(to), unavailableReason: null };
}

/** A `@db.Date` column back to the YYYY-MM-DD it encodes, in UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
