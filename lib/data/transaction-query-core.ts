/**
 * lib/data/transaction-query-core.ts  (TX-3.0, hardened in TX-3.1b)
 *
 * The PURE query contract + keyset-pagination logic for the Transaction Explorer —
 * deliberately free of any server-only dependency (no `db`, no `getSpaceContext`) so
 * every ordering/cursor/filter/parse rule is unit-testable in isolation. The server
 * authorities (transaction-query.ts / transaction-aggregate.ts) are thin shells that
 * compose THESE fragments with the existing population/visibility authority
 * (bankingTransactionWhere) and execute.
 *
 * DOCTRINE:
 *   - Transactions do NOT participate in canonical Perspective time. There is no
 *     preset / asOf / compareTo here — only an explicit { dateFrom, dateTo } range
 *     plus structured filters. (See TX3_TRANSACTION_EXPLORER_AUDIT.md §5.)
 *   - Keyset (cursor) pagination only. Ordering is a STRICT TOTAL ORDER — the sort
 *     key plus `id` as the tie-break — so a page boundary can never duplicate or
 *     skip a row, including many same-day transactions.
 *   - This module builds WHERE FRAGMENTS and ordering; it never decides the
 *     population (FlowType) or visibility (KD-15) — those stay in
 *     bankingTransactionWhere, ANDed in by the server authority.
 *
 * TX-3.1b HARDENING (see TX3_QUERY_CONTRACT_REVIEW.md):
 *   - M1 Amount sorting REMOVED. The product's "largest" is
 *     `Math.abs(FX-converted amount)`; the only thing SQL can order by is the signed
 *     NATIVE `amount`. Those differ by SIGN even in a single-currency Space, and
 *     Prisma cannot express `ORDER BY abs(amount)`. Shipping it would mean shipping a
 *     sort that is wrong for every user. The correct future primitive is amount
 *     RANGE FILTERING (`amountMin`/`amountMax` on magnitude), which is exact and
 *     needs no FX. A true converted-magnitude sort requires a persisted reporting
 *     amount — deliberately NOT built here (no reporting columns, no FX persistence).
 *   - M2 Cursors are SORT-TAGGED. A cursor minted under one sort can never silently
 *     apply to another; the mismatch is an explicit, reported reset.
 *   - M3 A pure PARSER boundary (`parseTransactionQuery`) validates every enum, date,
 *     and limit, so a route can never hand malformed input to Prisma.
 *   - Filter fragments compose into an `AND` array rather than assigning top-level
 *     keys, so two OR-shaped filters (text and source) can never overwrite each other.
 */

import type { Prisma, FlowType, TransactionCategory } from "@prisma/client";

// ── The query contract ──────────────────────────────────────────────────────

/**
 * M1: date sorts only. `largest`/`smallest` were removed — see the DOCTRINE note
 * above. Amount range filtering is the intended replacement primitive.
 */
export type TransactionSort = "newest" | "oldest";

export const TRANSACTION_SORTS: readonly TransactionSort[] = ["newest", "oldest"] as const;

/**
 * Provenance source — mirrors `deriveSource` in lib/data/transactions.ts EXACTLY
 * (importBatchId wins → plaidTransactionId → manual). The DTO field and this filter
 * must never disagree, so both are derived from the same two columns.
 */
export type TransactionSource = "import" | "plaid" | "manual";

export const TRANSACTION_SOURCES: readonly TransactionSource[] = ["import", "plaid", "manual"] as const;

/**
 * Keyset cursor — the sort-key value of the LAST row on the previous page plus its
 * id tie-break, TAGGED with the sort it was minted under (M2). Opaque to callers;
 * it is NOT an offset.
 */
export interface TransactionCursor {
  /** The sort this cursor was derived under. A mismatch is an explicit reset. */
  sort: TransactionSort;
  /** YYYY-MM-DD of the last row on the previous page. */
  lastDate: string;
  /** id of the last row on the previous page (the strict tie-break). */
  lastId: string;
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
  categories?: TransactionCategory[];
  /** true → only pending, false → only cleared, undefined → both. */
  pending?: boolean;
  /** Restrict to one resolved merchant (Merchant.id — a real persisted authority). */
  merchantId?: string;
  /** Restrict to these provenance sources (derived from the same columns as the DTO). */
  sources?: TransactionSource[];
  /** Case-insensitive substring over merchant / description / resolved name. */
  text?: string;
  /** Ordering. */
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

/** The default sort when a caller omits it. */
export const DEFAULT_TRANSACTION_SORT: TransactionSort = "newest";

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

/**
 * The Prisma ordering for a sort — always a STRICT TOTAL ORDER (date then id), so
 * keyset pagination is exact. Note `date` is `@db.Date`, so same-day rows all tie on
 * the primary key and fall to the `id` tie-break: same-day order is STABLE but
 * arbitrary (cuid), not chronological. Consumers group by day, so this is invisible.
 */
export function orderByForSort(sort: TransactionSort): Prisma.TransactionOrderByWithRelationInput[] {
  return sort === "oldest"
    ? [{ date: "asc" }, { id: "asc" }]
    : [{ date: "desc" }, { id: "desc" }];
}

// ── Date helpers (the `date` column is @db.Date — compare at UTC midnight) ────

/** Strict YYYY-MM-DD shape. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD → a UTC-midnight Date matching the @db.Date column encoding. */
export function toDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** A Date → YYYY-MM-DD (the DTO / cursor date encoding). */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * True only for a well-formed AND real calendar date (rejects `2026-02-31`,
 * `2026-13-01`, and anything Prisma would choke on as an Invalid Date). M3.
 */
export function isValidISODate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && toISODate(d) === value;
}

// ── Keyset WHERE (M2 — sort-tagged) ─────────────────────────────────────────

/** Does this cursor belong to this sort? A cursor is only valid under its own sort. */
export function isCursorCompatible(sort: TransactionSort, cursor?: TransactionCursor): boolean {
  return cursor == null || cursor.sort === sort;
}

/**
 * M2 — resolve a caller-supplied cursor against the requested sort. An incompatible
 * cursor is DROPPED and reported (`reset: true`) rather than silently misapplied:
 * before this, a date cursor under an amount sort restarted at page 1 forever
 * (infinite-scroll duplication) and an amount cursor under a date sort produced a
 * meaningless window with no error.
 */
export function resolveCursor(
  sort: TransactionSort,
  cursor?: TransactionCursor,
): { cursor: TransactionCursor | null; reset: boolean } {
  if (cursor == null) return { cursor: null, reset: false };
  if (cursor.sort !== sort) return { cursor: null, reset: true };
  return { cursor, reset: false };
}

/**
 * The keyset predicate: "strictly after the cursor in this sort's order". For
 * `(date desc, id desc)` that is `date < lastDate OR (date = lastDate AND id < lastId)`;
 * for ascending the comparators flip. Returns null for the FIRST page (no cursor) or
 * for a cursor that does not belong to this sort (M2 — the caller should surface the
 * reset via `resolveCursor`).
 */
export function keysetWhere(sort: TransactionSort, cursor?: TransactionCursor): Prisma.TransactionWhereInput | null {
  if (!cursor || !isCursorCompatible(sort, cursor)) return null;
  const d = toDbDate(cursor.lastDate);
  return sort === "oldest"
    ? { OR: [{ date: { gt: d } }, { date: d, id: { gt: cursor.lastId } }] }
    : { OR: [{ date: { lt: d } }, { date: d, id: { lt: cursor.lastId } }] };
}

// ── Filter WHERE ────────────────────────────────────────────────────────────

/**
 * The provenance-source predicate, mirroring `deriveSource`'s precedence exactly:
 *   import → importBatchId != null
 *   plaid  → importBatchId == null AND plaidTransactionId != null
 *   manual → importBatchId == null AND plaidTransactionId == null
 * The three are mutually exclusive and exhaustive, so a full selection is a no-op.
 */
export function sourceWhere(sources: readonly TransactionSource[]): Prisma.TransactionWhereInput | null {
  const wanted = [...new Set(sources)];
  if (wanted.length === 0 || wanted.length === TRANSACTION_SOURCES.length) return null;
  const fragment = (s: TransactionSource): Prisma.TransactionWhereInput => {
    switch (s) {
      case "import": return { importBatchId: { not: null } };
      case "plaid":  return { importBatchId: null, plaidTransactionId: { not: null } };
      case "manual": return { importBatchId: null, plaidTransactionId: null };
    }
  };
  const fragments = wanted.map(fragment);
  return fragments.length === 1 ? fragments[0] : { OR: fragments };
}

/**
 * The FILTER fragments (date range + account / flow / category / pending / merchant /
 * source / text). NOT the population or visibility — those come from
 * bankingTransactionWhere and are ANDed in by the server authority, so a `flowTypes`
 * filter never collides with the population's `flowType: { not: INVESTMENT }`.
 *
 * Composed as an `AND` ARRAY of independent fragments (TX-3.1b): two OR-shaped
 * filters (text and source) assigned to a top-level `OR` key would silently
 * overwrite each other. An AND array makes key collision structurally impossible.
 *
 * Shared verbatim by BOTH the row query (transaction-query.ts) and the aggregate
 * authority (transaction-aggregate.ts) — that shared construction is what makes
 * "the count matches the list" a structural guarantee rather than a convention.
 */
export function buildFilterWhere(query: TransactionQuery): Prisma.TransactionWhereInput {
  const and: Prisma.TransactionWhereInput[] = [];

  if (query.dateFrom || query.dateTo) {
    and.push({
      date: {
        ...(query.dateFrom ? { gte: toDbDate(query.dateFrom) } : {}),
        ...(query.dateTo   ? { lte: toDbDate(query.dateTo) }   : {}),
      },
    });
  }
  if (query.accountIds && query.accountIds.length > 0) {
    and.push({ financialAccountId: { in: query.accountIds } });
  }
  if (query.flowTypes && query.flowTypes.length > 0) {
    and.push({ flowType: { in: query.flowTypes } });
  }
  if (query.categories && query.categories.length > 0) {
    and.push({ category: { in: query.categories } });
  }
  if (typeof query.pending === "boolean") {
    and.push({ pending: query.pending });
  }
  if (query.merchantId) {
    and.push({ merchantId: query.merchantId });
  }
  if (query.sources && query.sources.length > 0) {
    const s = sourceWhere(query.sources);
    if (s) and.push(s);
  }
  if (query.text && query.text.trim() !== "") {
    const t = query.text.trim();
    and.push({
      OR: [
        { merchant:    { contains: t, mode: "insensitive" } },
        { description: { contains: t, mode: "insensitive" } },
        { resolvedMerchant: { displayName: { contains: t, mode: "insensitive" } } },
      ],
    });
  }

  return and.length === 0 ? {} : { AND: and };
}

// ── Cursor derivation + reference ordering (also used by the tests) ──────────

/** The minimal row shape the keyset needs: the sort key + the id tie-break. */
export interface KeyedRow {
  id: string;
  date: Date;
}

/** The cursor that continues AFTER this row under the given sort (sort-tagged, M2). */
export function cursorFromRow(row: KeyedRow, sort: TransactionSort): TransactionCursor {
  return { sort, lastDate: toISODate(row.date), lastId: row.id };
}

/**
 * The strict-total-order comparator this sort implies (date, then id). The single
 * source of truth for BOTH the Prisma orderBy above and the reference matcher below
 * — so a test can prove the keyset never duplicates or skips a row.
 */
export function compareForSort(a: KeyedRow, b: KeyedRow, sort: TransactionSort): number {
  const cmpId = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  const cursorRow: KeyedRow = { id: cursor.lastId, date: toDbDate(cursor.lastDate) };
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

// ── Cursor transport (opaque token) ─────────────────────────────────────────

/**
 * Cursors ride the wire as one opaque base64url token so no consumer is tempted to
 * hand-craft or mutate one. Encoding is pure and reversible; decoding VALIDATES the
 * decoded shape (M3) so a tampered or truncated token degrades to "first page"
 * rather than reaching Prisma.
 */
export function encodeCursor(cursor: TransactionCursor): string {
  const json = JSON.stringify([cursor.sort, cursor.lastDate, cursor.lastId]);
  return Buffer.from(json, "utf8").toString("base64url");
}

/** Decode an opaque cursor token. Returns null for anything malformed. */
export function decodeCursor(token: string): TransactionCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [sort, lastDate, lastId] = parsed;
    if (typeof sort !== "string" || typeof lastDate !== "string" || typeof lastId !== "string") return null;
    if (!TRANSACTION_SORTS.includes(sort as TransactionSort)) return null;
    if (!isValidISODate(lastDate) || lastId === "") return null;
    return { sort: sort as TransactionSort, lastDate, lastId };
  } catch {
    return null;
  }
}

// ── M3 — the pure parser boundary ───────────────────────────────────────────

export interface TransactionQueryParseError {
  field: string;
  message: string;
}

export type TransactionQueryParseResult =
  | { ok: true;  query: TransactionQuery; cursorReset: boolean }
  | { ok: false; errors: TransactionQueryParseError[] };

/** The enum vocabularies the parser validates against, injected so this stays pure. */
export interface TransactionQueryVocabulary {
  flowTypes:  readonly string[];
  categories: readonly string[];
}

/** Split a repeatable/comma-separated param into trimmed, non-empty values. */
function splitList(raw: string | null): string[] {
  if (raw == null) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * M3 — parse an untrusted URL query string into a validated `TransactionQuery`.
 *
 * This is the ONE boundary between the wire and Prisma. Before it existed, a route
 * would hand `categories` straight through an unchecked `as TransactionCategory[]`
 * cast and a malformed `dateFrom` through `new Date("junk")` → Invalid Date → a
 * Prisma crash (a 500 on user input). Everything here fails CLOSED with a field-level
 * error; nothing is silently coerced except the documented clamps and defaults.
 *
 * The enum vocabularies are injected (not imported from @prisma/client) so this
 * module stays free of generated-client coupling and fully unit-testable.
 */
export function parseTransactionQuery(
  params: URLSearchParams,
  vocab: TransactionQueryVocabulary,
): TransactionQueryParseResult {
  const errors: TransactionQueryParseError[] = [];
  const query: TransactionQuery = { sort: DEFAULT_TRANSACTION_SORT };

  // ── sort (defaulted, validated) ──
  const rawSort = params.get("sort");
  if (rawSort != null && rawSort !== "") {
    if (!TRANSACTION_SORTS.includes(rawSort as TransactionSort)) {
      errors.push({
        field: "sort",
        message: `must be one of: ${TRANSACTION_SORTS.join(", ")}`,
      });
    } else {
      query.sort = rawSort as TransactionSort;
    }
  }

  // ── dates ──
  for (const field of ["dateFrom", "dateTo"] as const) {
    const raw = params.get(field);
    if (raw == null || raw === "") continue;
    if (!isValidISODate(raw)) {
      errors.push({ field, message: "must be a real calendar date in YYYY-MM-DD form" });
      continue;
    }
    query[field] = raw;
  }
  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
    errors.push({ field: "dateFrom", message: "must not be after dateTo" });
  }

  // ── accountIds (opaque ids — shape only; the server intersects with the
  //    Space's VISIBLE set, which is the actual authorization check) ──
  const accountIds = splitList(params.get("accountIds"));
  if (accountIds.length > 0) query.accountIds = accountIds;

  // ── enums ──
  const flowTypes = splitList(params.get("flowTypes"));
  const badFlow = flowTypes.filter((f) => !vocab.flowTypes.includes(f));
  if (badFlow.length > 0) errors.push({ field: "flowTypes", message: `unknown value(s): ${badFlow.join(", ")}` });
  else if (flowTypes.length > 0) query.flowTypes = flowTypes as FlowType[];

  const categories = splitList(params.get("categories"));
  const badCat = categories.filter((c) => !vocab.categories.includes(c));
  if (badCat.length > 0) errors.push({ field: "categories", message: `unknown value(s): ${badCat.join(", ")}` });
  else if (categories.length > 0) query.categories = categories as TransactionCategory[];

  const sources = splitList(params.get("sources"));
  const badSrc = sources.filter((s) => !TRANSACTION_SOURCES.includes(s as TransactionSource));
  if (badSrc.length > 0) errors.push({ field: "sources", message: `unknown value(s): ${badSrc.join(", ")}` });
  else if (sources.length > 0) query.sources = sources as TransactionSource[];

  // ── pending (tri-state) ──
  const rawPending = params.get("pending");
  if (rawPending != null && rawPending !== "") {
    if (rawPending === "true") query.pending = true;
    else if (rawPending === "false") query.pending = false;
    else errors.push({ field: "pending", message: 'must be "true" or "false"' });
  }

  // ── merchantId / text ──
  const merchantId = params.get("merchantId")?.trim();
  if (merchantId) query.merchantId = merchantId;

  const text = params.get("text")?.trim();
  if (text) query.text = text;

  // ── limit (clamped, not rejected — a page size is a preference, not an assertion) ──
  const rawLimit = params.get("limit");
  if (rawLimit != null && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isFinite(n)) errors.push({ field: "limit", message: "must be a number" });
    else query.limit = clampLimit(n);
  }

  // ── cursor (opaque; malformed → first page, mismatched sort → explicit reset) ──
  let cursorReset = false;
  const rawCursor = params.get("cursor");
  if (rawCursor != null && rawCursor !== "") {
    const decoded = decodeCursor(rawCursor);
    if (decoded == null) {
      cursorReset = true; // tampered/truncated → restart, never a 500
    } else {
      const resolved = resolveCursor(query.sort, decoded);
      cursorReset = resolved.reset;
      if (resolved.cursor) query.cursor = resolved.cursor;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, query, cursorReset };
}
