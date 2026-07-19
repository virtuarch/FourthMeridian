# TX-3.0 — Transaction Explorer Query Contract

**Type:** Backend authority slice. New server query contract only — **no UI, no workspace migration, no behavior removed, no schema migration.**
**Date:** 2026-07-20.
**Follows:** `TX3_TRANSACTION_EXPLORER_AUDIT.md` (the investigation). This slice builds the *authority* the future explorer will consume; it has **no consumers yet** by design.

---

## 1. What shipped

- **Pure contract + keyset logic** — `lib/data/transaction-query-core.ts` (server-only-free): the `TransactionQuery` / `TransactionCursor` / `TransactionSort` types, `MAX_TRANSACTION_PAGE_SIZE = 100`, `clampLimit`, `orderByForSort`, `keysetWhere`, `buildFilterWhere`, cursor derivation, and a reference comparator/matcher. All unit-tested.
- **Server authority** — `lib/data/transaction-query.ts` (`import "server-only"`): `queryTransactions({ spaceId, query }) → { rows, nextCursor, hasMore }`. Composes the pure fragments with the existing population authority; executes one keyset `findMany`; projects via the shared DTO builder.
- **Shared DTO extraction** — `lib/data/transactions.ts` now exports `transactionListInclude(spaceId)` + `projectTransactionListRows(rows, spaceId)` (the exact serialize + read-time transfer-match + CF-1 context + provenance-source projection). `getTransactions` was refactored to call them, so the explorer and the existing loader **cannot diverge on the DTO**.
- **Tests** — `transaction-query-core.test.ts` (pure) + `transaction-query.test.ts` (source-scan tripwires).

### The contract (as delivered)

```ts
TransactionQuery {
  dateFrom?, dateTo?     // YYYY-MM-DD, inclusive
  accountIds?            // intersected with the Space's VISIBLE accounts
  flowTypes?             // FlowType[]  (ANDed with the banking population)
  categories?            // string[]
  pending?               // true=pending only, false=cleared only, undefined=both
  merchantId?
  text?                  // ILIKE over merchant / description / resolved name
  sort                   // "newest" | "oldest" | "largest" | "smallest"
  cursor?                // { lastDate, lastId, lastAmount? }
  limit?                 // clamped to [1, 100]
}
→ { rows: Transaction[]; nextCursor: TransactionCursor | null; hasMore: boolean }
```

**No `preset` / `asOf` / `compareTo` / `PerspectiveTimeState`.** Transactions explicitly do not participate in canonical Perspective time (per the audit): the explorer's time axis is an arbitrary `{dateFrom,dateTo}` range, not an asOf-anchored snapshot.

---

## 2. Old authority → new authority

| | Old (`getTransactions`) | New (`queryTransactions`) |
|---|---|---|
| Shape | `{ rows, truncated, limit, windowDays }` — a bounded **list** | `{ rows, nextCursor, hasMore }` — a keyset **page** |
| Bounding | most-recent 5,000 (`take: limit+1`) | one page (`take: clampLimit+1`, max 100+1) |
| Filtering | none server-side (client did it) | date / account / flow / category / pending / merchant / text, all server-side |
| Sort | fixed `date desc` | 4 sorts, each a strict total order (sort key + id) |
| Paging | none (client sliced the array) | **keyset** on `(date desc, id desc)` etc — no offset |
| Population/visibility | `bankingTransactionWhere` | **same** `bankingTransactionWhere` (reused verbatim) |
| DTO | inline projection | **same** projection, now extracted + shared |

**Both authorities coexist.** `getTransactions` is unchanged in contract and still feeds the current Transactions tab, Cash Flow, Liquidity, export, and the AI/debt paths. `queryTransactions` is additive and unconsumed.

### Keyset mechanics
Ordering is always the sort key **plus `id`** as a strict tie-break, so a page boundary can never duplicate or skip a row — including the common case of many transactions on the same `@db.Date` day. The cursor carries `{ lastDate, lastId }` (and `lastAmount` for the amount sorts); the "next page" predicate is "strictly after the cursor in this order" (`keysetWhere`). No `skip`/offset anywhere (offset degrades with depth and double-counts under concurrent sync). Every page is bounded by `MAX_TRANSACTION_PAGE_SIZE`.

### Reuse — no second authority
- **Population + visibility + soft-delete**: `bankingTransactionWhere` (FlowType banking population + KD-15 `TRANSACTION_DETAIL_VISIBILITY` + `deletedAt`), ANDed in as a separate term (so a `flowTypes` filter never overwrites the population's `flowType: { not: INVESTMENT }`).
- **Account isolation**: `resolveVisibleAccountIds` intersects an explicit `accountIds` filter with the Space's visible set using the **same KD-15 constant** — a caller can never widen a query to an account the Space cannot see. It is a visibility guard, not a new population rule.
- **DTO**: the shared `projectTransactionListRows` / `transactionListInclude` — the identical `Transaction` shape `getTransactions` produces.

---

## 3. Index investigation (measure first — no migration in this slice)

Current `Transaction` indexes (verbatim, `prisma/schema.prisma`):

```
@@index([financialAccountId])          @@index([financialAccountId, flowType, date])
@@index([financialAccountId, date])    @@index([flowType, date])
@@index([date])                        @@index([counterpartyAccountId])
@@index([importBatchId])               @@index([merchantId])
                                       @@index([categoryRuleId])
```

**Analysis.** The keyset orders by `(date, id)` (date sorts) or `(amount, id)` (amount sorts) over the Space's visible-account set. `[financialAccountId, date]` serves date-ordered ranges *per account*; a global multi-account page ordered by `(date, id)` is not perfectly served by any current index (the `id` tie-break and the cross-account merge aren't covered), and there is **no `amount` index at all** for the largest/smallest sorts. The audit's candidate is a composite **`[financialAccountId, date, id]`**.

**Decision: no migration in TX-3.0.** Per the mission's "measure first / no query-optimization guesses / additive only if required": there is no consumer and no production query plan to measure yet. Adding an index speculatively would be exactly the guess the mission forbids. When a consumer lands (TX-3.2), run `EXPLAIN ANALYZE` on representative data (a >5,000-row Space) for each sort; if the keyset shows a sort or heap cost that an index removes, add `[financialAccountId, date, id]` (and, only if amount sorts prove hot, an `amount` composite) as an **additive** migration then. Documented, not done.

---

## 4. Callers waiting for adoption (future slices — NOT this one)

`queryTransactions` is intentionally unconsumed. Adoption is later TX-3 slices:

- **TX-3.1** — a server-paged route (evolve `GET /api/spaces/[id]/transactions` with query params, or a sibling) that calls `queryTransactions` and returns `{ rows, nextCursor, hasMore }`.
- **TX-3.2** — `SpaceTransactionsPanel` cutover from "one array + client predicate" to "query state → fetch page → append", filters/search as debounced server params, infinite-scroll (cursor) loading. This is where the index measurement happens.
- **TX-3.3** — aggregate honesty (replace the client KPI cards / Group By with a server query-total or relocate to Cash Flow).
- **TX-3.4** — converge the per-account modal (`GET /api/accounts/[id]/transactions`) onto the same authority.

Explicitly **not** touched here: infinite scroll, filter redesign, TimelineLens integration, KPI replacement, Cash Flow, the detail drawer.

---

## 5. Parity risks

1. **`getTransactions` refactor.** Its inline projection was extracted into `projectTransactionListRows` and it now calls that + `transactionListInclude`. Behavior is byte-identical (same serialize + transfer-match + context + source), verified: `transactions.population`, `transactions.privacy` (KD-15 SAL predicate lockstep), `serialize.golden`, `financial-doctrine-oracle`, and `transactions-bounding` all green. **Risk: low.** The one wrinkle handled: the derived `TransactionListRow` type is built from `ReturnType<typeof transactionListInclude>` (not a hand-written literal) so the privacy source-scan sees no unguarded `spaceAccountLinks` literal — the KD-15 predicate stays in exactly one place.
2. **"Largest / smallest" is NATIVE amount, not converted magnitude.** The current client sort orders by *converted absolute* magnitude (FX per row date). The server can't reproduce that without per-row FX in SQL, so `queryTransactions` orders by native signed `amount`. When TX-3.2 adopts amount sorts it must either accept native ordering or apply display conversion after the page loads (the honest, documented divergence). **This is a semantics decision for the consumer slice, flagged here.**
3. **Text search selectivity.** `text` compiles to a case-insensitive `contains` over `merchant`/`description`/resolved name. At scale this wants a `pg_trgm` GIN index; deferred (§3, and the audit). Until then, text queries on a very large Space scan the date/account-narrowed range — acceptable for beta, measured at TX-3.2.
4. **No consumer = no integration coverage yet.** DB-behavioral correctness (isolation/visibility/soft-delete) is currently guaranteed by *reuse* of the already-tested `bankingTransactionWhere` (asserted by source-scan) rather than a live query test; a full integration test arrives with the TX-3.1 route.

---

## 6. Tests

- **`transaction-query-core.test.ts`** (pure): scale-guard clamp (≤100), ordering (strict total order per sort), keyset comparators (first-page null; correct lt/gt per sort/direction; amount sort needs `lastAmount`), filter mapping (date/account/flow/category/pending/merchant/text), and the **pagination invariants** — a synthetic dataset with same-day + same-amount ties is walked page-by-page through the keyset and reassembled: **no duplicates, no missing rows, same-day rows ordered by id** for all four sorts. Cursor derivation (last-row key; null on final page).
- **`transaction-query.test.ts`** (source-scan): reuses `bankingTransactionWhere` (no second population authority), no `skip:` (keyset not offset), `take = clampLimit + 1`, AND-composition (no key overwrite), shared DTO builder, account-id intersection, `server-only` guard, and no `preset/asOf/compareTo` in the contract.
- **Existing guards green** (parity): population, privacy (KD-15), serialize.golden, doctrine-oracle, bounding. tsc + eslint clean. Clean-env unit baseline unchanged (only the pre-existing marketing-boundary fail).

---

## 7. Summary

TX-3.0 establishes the keyset query authority (`queryTransactions`) and the pure contract (`transaction-query-core`) the future explorer will consume — reusing the one population/visibility authority and the one DTO builder, keyset-only (no offset), page-bounded (≤100), and free of canonical Perspective time. No consumer, no UI, no migration. The `[financialAccountId, date, id]` index is analyzed and **deferred to measurement** at adoption. **Stop after TX-3.0.**
