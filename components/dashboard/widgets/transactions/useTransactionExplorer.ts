"use client";

/**
 * components/dashboard/widgets/transactions/useTransactionExplorer.ts  (TX-3.3)
 *
 * The Transaction Explorer's client query state — the thing that replaces
 * "load one array, then filter/sort/slice it in the browser".
 *
 * DOCTRINE:
 *   - The SERVER answers the question. This hook owns only the question (filters,
 *     search, sort) and the accumulated answer (pages). It performs no filtering,
 *     no sorting, and no slicing — if you find yourself adding a `.filter(` here,
 *     the browser has quietly become the browsing authority again.
 *   - Paging is KEYSET. The cursor is an opaque token from the server; this hook
 *     never constructs or inspects one.
 *   - `cursorReset` (M2) is honored: when the server reports that a supplied cursor
 *     did not belong to the requested sort, the accumulated list is REPLACED rather
 *     than appended to — otherwise two orderings would be concatenated.
 *   - Rows are deduped by id on append (M4). Sort keys are mutable in this system
 *     (a pending→posted sync updates `date` in place), so a row can in principle
 *     cross a page boundary mid-scroll. Dedupe makes that a no-op instead of a
 *     visible duplicate.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Transaction } from "@/types";
import {
  subscribeTransactionMutations,
  getTransactionMutationVersion,
  getServerTransactionMutationVersion,
} from "@/components/transactions/transaction-mutation-signal";

/** The question. Every field maps to a validated server query param. */
export interface ExplorerQuery {
  text: string;
  dateFrom: string | null;
  dateTo: string | null;
  /** Single-select in the UI today; the contract accepts a list, so this widens
   *  to one without any server change if multi-select ever ships. */
  accountId: string | null;
  category: string | null;
  flowType: string | null;
  source: string | null;
  /** true = pending only, false = cleared only, null = both. */
  pending: boolean | null;
  /** Merchant pivot — a resolved Merchant.id taken from a row. */
  merchantId: string | null;
  sort: "newest" | "oldest";
}

export const EMPTY_EXPLORER_QUERY: ExplorerQuery = {
  text: "", dateFrom: null, dateTo: null, accountId: null, category: null,
  flowType: null, source: null, pending: null, merchantId: null, sort: "newest",
};

/** Serialize the question into validated server params. Pure. */
export function toSearchParams(q: ExplorerQuery, cursor: string | null, limit: number): URLSearchParams {
  const p = new URLSearchParams();
  if (q.text.trim()) p.set("text", q.text.trim());
  if (q.dateFrom) p.set("dateFrom", q.dateFrom);
  if (q.dateTo) p.set("dateTo", q.dateTo);
  if (q.accountId) p.set("accountIds", q.accountId);
  if (q.category) p.set("categories", q.category);
  if (q.flowType) p.set("flowTypes", q.flowType);
  if (q.source) p.set("sources", q.source);
  if (q.pending !== null) p.set("pending", String(q.pending));
  if (q.merchantId) p.set("merchantId", q.merchantId);
  p.set("sort", q.sort);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  return p;
}

/**
 * A stable identity for the QUESTION (everything except the cursor). When this
 * changes the accumulated answer is discarded and paging restarts — the one place
 * that decides "new question" vs "more of the same answer".
 */
export function questionKey(q: ExplorerQuery): string {
  return JSON.stringify([
    q.text.trim(), q.dateFrom, q.dateTo, q.accountId, q.category,
    q.flowType, q.source, q.pending, q.merchantId, q.sort,
  ]);
}

/** Number of filter GROUPS active — drives the "Filters (N)" badge. */
export function activeFilterCount(q: ExplorerQuery): number {
  return (q.category ? 1 : 0)
    + (q.flowType ? 1 : 0)
    + (q.source ? 1 : 0)
    + (q.accountId ? 1 : 0)
    + (q.pending !== null ? 1 : 0)
    + (q.merchantId ? 1 : 0);
}

/** Append `incoming` to `existing`, dropping ids already present (M4). */
export function appendDeduped(existing: Transaction[], incoming: Transaction[]): Transaction[] {
  if (existing.length === 0) return incoming;
  const seen = new Set(existing.map((r) => r.id));
  const fresh = incoming.filter((r) => !seen.has(r.id));
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

/** The wire shape of one explorer page. */
interface ExplorerPage {
  transactions?: Transaction[];
  nextCursor?: string | null;
  hasMore?: boolean;
  count?: number;
  cursorReset?: boolean;
}

export interface ExplorerState {
  rows: Transaction[];
  /** Exact size of the answer (server count), or null until the first page lands. */
  count: number | null;
  hasMore: boolean;
  /** First page of a new question in flight (the list should show a skeleton). */
  loading: boolean;
  /** A continuation page in flight (the list stays, a spinner trails it). */
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
}

const PAGE_SIZE = 50; // mobile-friendly; server clamps to MAX_TRANSACTION_PAGE_SIZE

export function useTransactionExplorer(spaceId: string, query: ExplorerQuery): ExplorerState {
  const key = useMemo(() => questionKey(query), [query]);

  const [rows, setRows] = useState<Transaction[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // TX-3.4 — the invalidation seam. A correction made in the detail drawer (a SIBLING
  // tree, so there is no prop path) bumps this version; the question is then re-asked
  // through the same authority. That is what keeps a recategorized row from lingering
  // in a list it no longer belongs to. The signal carries no data — only a version.
  const mutationVersion = useSyncExternalStore(
    subscribeTransactionMutations,
    getTransactionMutationVersion,
    getServerTransactionMutationVersion,
  );

  // Guards against a stale in-flight response overwriting a newer question's
  // answer — the classic filter-race that makes a list show the wrong rows.
  const activeKey = useRef(key);
  const inFlight = useRef(false);

  // Question change resets the accumulated answer DURING RENDER, not in an effect —
  // this repo's eslint (react-hooks/set-state-in-effect) forbids synchronous
  // setState in an effect body as a cascading-render risk, and this is React's own
  // documented "storing information from previous renders" alternative (the same
  // pattern the panel already uses for its reset key).
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setRows([]);
    setCount(null);
    setCursor(null);
    setHasMore(false);
    setError(null);
    setLoading(true);
  }

  /**
   * Pure fetcher — performs I/O and returns the parsed page. It touches NO state, so
   * the effect below can call it and still write state only inside the promise
   * continuation (the shape use-space-data uses, and the shape this repo's
   * react-hooks/set-state-in-effect rule requires).
   */
  const fetchPageData = useCallback(
    (atCursor: string | null) => {
      const params = toSearchParams(query, atCursor, PAGE_SIZE);
      return fetch(`/api/spaces/${spaceId}/transactions/query?${params.toString()}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    },
    [spaceId, query],
  );

  /** Apply a landed page. `forKey` guards against a stale question's response. */
  const applyPage = useCallback(
    (forKey: string, isFirst: boolean, data: ExplorerPage) => {
      if (activeKey.current !== forKey) return; // a newer question won the race
      const incoming: Transaction[] = data?.transactions ?? [];
      // M2 — the server dropped an incompatible cursor, so this IS a first page.
      const replace = isFirst || data?.cursorReset === true;
      setRows((prev) => (replace ? incoming : appendDeduped(prev, incoming)));
      if (typeof data?.count === "number") setCount(data.count);
      setCursor(data?.nextCursor ?? null);
      setHasMore(!!data?.hasMore);
      setError(null);
    },
    [],
  );

  // Track the question a landed response must still belong to. Kept in an effect
  // (never written during render) and declared BEFORE the fetch effect so it is
  // already current by the time any promise continuation below runs.
  useEffect(() => { activeKey.current = key; }, [key]);

  // Fetch the FIRST page of whatever the current question is. The state reset already
  // happened during render; this effect performs I/O only, and every state write below
  // lives in a promise callback rather than the effect body.
  useEffect(() => {
    const forKey = key;
    let active = true;
    inFlight.current = true;
    fetchPageData(null)
      .then((data) => { if (active) applyPage(forKey, true, data); })
      .catch(() => { if (active && activeKey.current === forKey) setError("Could not load transactions."); })
      .finally(() => { inFlight.current = false; if (active) setLoading(false); });
    return () => { active = false; };
    // fetchPageData is recreated with `query`, which `key` already tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, spaceId, mutationVersion]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading || loadingMore || cursor === null || inFlight.current) return;
    const forKey = activeKey.current;
    inFlight.current = true;
    setLoadingMore(true); // an event handler, not an effect — safe and explicit
    fetchPageData(cursor)
      .then((data) => applyPage(forKey, false, data))
      .catch(() => { if (activeKey.current === forKey) setError("Could not load more."); })
      .finally(() => { inFlight.current = false; setLoadingMore(false); });
  }, [hasMore, loading, loadingMore, cursor, fetchPageData, applyPage]);

  return { rows, count, hasMore, loading, loadingMore, error, loadMore };
}
