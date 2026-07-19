/**
 * lib/data/transaction-query-core.ts  (TX-3.0)
 *
 * The PURE query contract + keyset-pagination logic for the future Transaction
 * Explorer — deliberately free of any server-only dependency (no `db`, no
 * `getSpaceContext`) so every ordering/cursor/filter rule is unit-testable in
 * isolation. The server authority (lib/data/transaction-query.ts) is a thin shell
 * that composes THESE fragments with the existing population/visibility authority
 * (bankingTransactionWhere) and executes the query.
 *
 * DOCTRINE:
 *   - Transactions do NOT participate in canonical Perspective time. There is no
 *     preset / asOf / compareTo here — only an explicit { dateFrom, dateTo } range
 *     plus structured filters. (See docs/audits/TX3_TRANSACTION_EXPLORER_AUDIT.md §5.)
 *   - Keyset (cursor) pagination only. Ordering is a STRICT TOTAL ORDER — the sort
 *     key plus `id` as the tie-break — so a page boundary can never duplicate or
 *     skip a row, including many same-day transactions.
 *   - This module builds WHERE FRAGMENTS and ordering; it never decides the
 *     population (FlowType) or visibility (KD-15) — those stay in
 *     bankingTransactionWhere, ANDed in by the server authority.
 */

import type { Prisma, FlowType, TransactionCategory } from "@prisma/client";

// ── The query contract ──────────────────────────────────────────────────────

export type TransactionSort = "newest" | "oldest" | "largest" | "smallest";

/**
 * Keyset cursor — the sort-key value of the LAST row on the previous page plus its
 * id tie-break. `lastAmount` is present only for the amount sorts (largest /
 * smallest); date sorts use `lastDate` + `lastId`. This is an opaque continuation
 * token from the caller's perspective; it is NOT an offset.
 */
export interface TransactionCursor {
  /** YYYY-MM-DD of the last row on the previous page. */
  lastDate: string;
  /** id of the last row on the previous page (the strict tie-break). */
  lastId: string;
  /** Native (signed) amount of the last row — only for largest / smallest sorts. */
  lastAmount?: number;
}

export interface TransactionQuery {
  /** Inclusive lower date bound (YYYY-MM-DD). */
  dateFrom?: string;
  /** Inclusive upper date bound (YYYY-MM-DD). */
  dateTo?: string;
  /** Restrict to these account ids (the server intersects with the visible set). */
  accountIds?: string[];
  /** Restrict to these canonical flow types (ANDed with the banking population). */
  flowTypes?: FlowType[];
  /** Restrict to these presentation categories. */
  categories?: string[];
  /** true → only pending, false → only cleared, undefined → both. */
  pending?: boolean;
  /** Restrict to one resolved merchant. */
  merchantId?: string;
  /** Case-insensitive substring over merchant / description / resolved name. */
  text?: string;
  /** Ordering (default "newest"). */
  sort: TransactionSort;
  /** Continuation token from the previous page's `nextCursor`. */
  cursor?: TransactionCursor;
  /** Page size (clamped to [1, MAX_TRANSACTION_PAGE_SIZE]). */
  limit?: number;
}

export interface TransactionQueryPage<T> {
  pageRows: T[];
  nextCursor: TransactionCursor | null;
  hasMore: boolean;
}

// ── Scale guards ────────────────────────────────────────────────────────────

/** Hard ceiling on a single page — a caller can never request unbounded rows. */
export const MAX_TRANSACTION_PAGE_SIZE = 100;
/** Default page size when the caller omits `limit`. */
export const DEFAULT_TRANSACTION_PAGE_SIZE = 50;

/** Clamp any requested page size into [1, MAX_TRANSACTION_PAGE_SIZE]. */
export function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_TRANSACTION_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_TRANSACTION_PAGE_SIZE);
}

// ── Ordering ────────────────────────────────────────────────────────────────

/** true for the amount-keyed sorts (keyset uses amount + id, not date + id). */
export function isAmountSort(sort: TransactionSort): boolean {
  return sort === "largest" || sort === "smallest";
}

/**
 * The Prisma ordering for a sort — always a STRICT TOTAL ORDER (sort key then id),
 * so keyset pagination is exact. Amount sorts order by NATIVE (signed) `amount`
 * (see the parity note in the TX-3 doc: this is not the client's converted-absolute
 * magnitude).
 */
export function orderByForSort(sort: TransactionSort): Prisma.TransactionOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":   return [{ date: "asc" },  { id: "asc" }];
    case "largest":  return [{ amount: "desc" }, { id: "desc" }];
    case "smallest": return [{ amount: "asc" },  { id: "asc" }];
    case "newest":
    default:         return [{ date: "desc" }, { id: "desc" }];
  }
}

// ── Date helpers (the `date` column is @db.Date — compare at UTC midnight) ────

/** YYYY-MM-DD → a UTC-midnight Date matching the @db.Date column encoding. */
export function toDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** A Date → YYYY-MM-DD (the DTO / cursor date encoding). */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Keyset WHERE ────────────────────────────────────────────────────────────

/**
 * The keyset predicate: "strictly after the cursor in this sort's order". For
 * `(key desc, id desc)` that is `key < lastKey OR (key = lastKey AND id < lastId)`;
 * for ascending sorts the comparators flip. Returns null for the FIRST page (no
 * cursor) or when an amount sort lacks `lastAmount`.
 */
export function keysetWhere(sort: TransactionSort, cursor?: TransactionCursor): Prisma.TransactionWhereInput | null {
  if (!cursor) return null;

  if (isAmountSort(sort)) {
    if (cursor.lastAmount == null) return null; // amount sort needs the amount key
    const a = cursor.lastAmount;
    return sort === "largest"
      ? { OR: [{ amount: { lt: a } }, { amount: a, id: { lt: cursor.lastId } }] }
      : { OR: [{ amount: { gt: a } }, { amount: a, id: { gt: cursor.lastId } }] };
  }

  const d = toDbDate(cursor.lastDate);
  return sort === "oldest"
    ? { OR: [{ date: { gt: d } }, { date: d, id: { gt: cursor.lastId } }] }
    : { OR: [{ date: { lt: d } }, { date: d, id: { lt: cursor.lastId } }] };
}

// ── Filter WHERE ────────────────────────────────────────────────────────────

/**
 * The filter fragments (date range + account / flow / category / pending / merchant
 * / text). NOT the population or visibility — those come from bankingTransactionWhere
 * and are ANDed in by the server authority, so a `flowTypes` filter never collides
 * with the population's `flowType: { not: INVESTMENT }` (they are separate AND terms).
 */
export function buildFilterWhere(query: TransactionQuery): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = {};

  if (query.dateFrom || query.dateTo) {
    where.date = {
      ...(query.dateFrom ? { gte: toDbDate(query.dateFrom) } : {}),
      ...(query.dateTo   ? { lte: toDbDate(query.dateTo) }   : {}),
    };
  }
  if (query.accountIds && query.accountIds.length > 0) {
    where.financialAccountId = { in: query.accountIds };
  }
  if (query.flowTypes && query.flowTypes.length > 0) {
    where.flowType = { in: query.flowTypes };
  }
  if (query.categories && query.categories.length > 0) {
    where.category = { in: query.categories as TransactionCategory[] };
  }
  if (typeof query.pending === "boolean") {
    where.pending = query.pending;
  }
  if (query.merchantId) {
    where.merchantId = query.merchantId;
  }
  if (query.text && query.text.trim() !== "") {
    const t = query.text.trim();
    where.OR = [
      { merchant:    { contains: t, mode: "insensitive" } },
      { description: { contains: t, mode: "insensitive" } },
      { resolvedMerchant: { displayName: { contains: t, mode: "insensitive" } } },
    ];
  }
  return where;
}

// ── Cursor derivation + reference ordering (also used by the tests) ──────────

/** The minimal row shape the keyset needs: the sort key(s) + the id tie-break. */
export interface KeyedRow {
  id: string;
  date: Date;
  amount: number;
}

/** The cursor that continues AFTER this row under the given sort. */
export function cursorFromRow(row: KeyedRow, sort: TransactionSort): TransactionCursor {
  return {
    lastDate: toISODate(row.date),
    lastId: row.id,
    ...(isAmountSort(sort) ? { lastAmount: row.amount } : {}),
  };
}

/**
 * The strict-total-order comparator this sort implies (sort key, then id). The
 * single source of truth for BOTH the Prisma orderBy above and the reference
 * matcher below — so a test can prove the keyset never duplicates or skips a row.
 */
export function compareForSort(a: KeyedRow, b: KeyedRow, sort: TransactionSort): number {
  const cmpId = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (isAmountSort(sort)) {
    const d = a.amount - b.amount;
    const primary = d !== 0 ? (d < 0 ? -1 : 1) : cmpId;
    return sort === "largest" ? -primary : primary; // largest ⇒ descending
  }
  const da = a.date.getTime(), db = b.date.getTime();
  const primary = da !== db ? (da < db ? -1 : 1) : cmpId;
  return sort === "oldest" ? primary : -primary; // newest ⇒ descending
}

/**
 * Pure reference for the keyset predicate: does this row fall strictly AFTER the
 * cursor row in the sort order? Mirrors keysetWhere exactly; the tests use it to
 * prove no-duplicate / no-missing / same-day ordering across simulated pages.
 */
export function afterCursorMatches(row: KeyedRow, sort: TransactionSort, cursor: TransactionCursor): boolean {
  const cursorRow: KeyedRow = {
    id: cursor.lastId,
    date: toDbDate(cursor.lastDate),
    amount: cursor.lastAmount ?? 0,
  };
  return compareForSort(cursorRow, row, sort) < 0; // row sorts strictly after the cursor
}

/**
 * Given a `limit + 1` fetch (in sort order), split into the page + the continuation.
 * `hasMore` is the sentinel row's presence; `nextCursor` is derived from the LAST
 * kept row (null when there is no next page).
 */
export function nextCursorFrom<T extends KeyedRow>(
  fetched: T[],
  sort: TransactionSort,
  limit: number,
): TransactionQueryPage<T> {
  const hasMore = fetched.length > limit;
  const pageRows = hasMore ? fetched.slice(0, limit) : fetched;
  const last = pageRows[pageRows.length - 1];
  return {
    pageRows,
    hasMore,
    nextCursor: hasMore && last ? cursorFromRow(last, sort) : null,
  };
}
