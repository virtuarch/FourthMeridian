# TX-3.1 — Transaction Explorer Query Contract Review

**Type:** Investigation + review only. No code changed, no consumer added, no index, no schema.
**Date:** 2026-07-20.
**Reviews:** TX-3.0 (`537b817`) — `lib/data/transaction-query-core.ts`, `lib/data/transaction-query.ts`, the shared DTO extraction in `lib/data/transactions.ts`.
**Follows:** `TX3_TRANSACTION_EXPLORER_AUDIT.md` (investigation) → `TX3_QUERY_CONTRACT_IMPLEMENTATION.md` (TX-3.0).

---

## 0. Verdict

### **ITERATE BEFORE CONSUMERS**

The *foundation* is right and should not be rebuilt. Keyset-only (no offset), strict-total-order sorting, reuse of the one population/visibility authority (`bankingTransactionWhere`), reuse of the one DTO builder, page-bounded at 100, and no canonical Perspective time — all correct, all worth keeping. Confirmed: `grep queryTransactions` outside its own module returns **zero** hits, so the contract is genuinely unadopted and free to change.

But the contract is **not yet stable enough for TX-3.2 adoption**. Seven gaps would each surface as a silent regression or a 500 the moment a route or the panel consumes it. Three are semantic (the amount sorts are a *different sort* than the product's, the cursor is untagged, sort keys are mutable), three are completeness (no input parsing, no count concept, four of today's filters/sorts absent), one is a dead-end filter (`merchantId` has no source).

None require rebuilding TX-3.0. All are additive or subtractive edits to the contract surface. Estimated: one focused slice (call it **TX-3.1b**) before TX-3.2.

---

## 1. Contract completeness

The intended arc is `Question → Query → Bounded answer → Inspect → Act`. The contract covers **Query → Bounded answer** well and **Inspect → Act** well (§7). It is weakest at the two ends: turning a user's question into a valid query (no parsing), and telling them how big the answer is (no count).

### What the intended first consumer actually needs

`SpaceTransactionsPanel` is the real TX-3.2 target. Its current client-side query engine (`components/dashboard/widgets/SpaceTransactionsPanel.tsx:268` filter, `:295-315` sort, `:330-337` paginate) offers this surface. Mapped against the contract:

| Panel control | Contract | Status |
|---|---|---|
| `search` (merchant / merchantDisplayName / description) | `text` | ✅ **exact match** — see §2 |
| `dateRange` presets + custom | `dateFrom` / `dateTo` | ✅ |
| `accountFilter` (single) | `accountIds[]` | ✅ superset |
| `catFilter` (single) | `categories[]` | ✅ superset |
| `flowFilter` (single) | `flowTypes[]` | ✅ superset |
| `pendingFilter` | `pending` | ✅ |
| `sortBy: newest / oldest` | `sort` | ✅ |
| `sortBy: largest / smallest` | `sort` | ❌ **different semantics** (§4) |
| `sortBy: merchant` (A–Z) | — | ❌ **absent** |
| `sourceFilter` (import/plaid/manual) | — | ❌ **absent** (SQL-expressible) |
| `dispositionFilter` (`transferDisposition`) | — | ❌ **absent and NOT SQL-expressible** |
| `needsReviewOnly` (`needsClassification`) | — | ❌ **absent and NOT SQL-expressible** |
| `merchantFilter` (by display name) | `merchantId` | ❌ **no source** (§3.4) |
| KPI cards, Group By, Calendar heatmap | — | ❌ **no aggregate concept** (§1.2) |

### 1.1 The derived-field trap (structural)

`transferDisposition` and `needsClassification` are **not columns**. They are computed *after* the query, in `contextFields` (`lib/data/transactions.ts:258-284`) via `deriveTransactionContext`, from ~10 raw columns **plus** `isOwnedCounterparty`, which itself depends on a read-time transfer-match query run over the fetched page.

This is load-bearing. Under server-side paging you cannot filter on them:

- Push to SQL → requires reimplementing `deriveTransactionContext` as a Prisma predicate **and** the counterparty resolution as a join. That is a second derivation authority — exactly the fork TX-3.0 was careful to avoid.
- Filter client-side on the page → a 50-row page renders 4 rows and the user sees a broken list with a "load more" that yields 4 more.

**This must be decided before TX-3.2, not during it.** Three honest options:

- **(a) Descope** — the first migrated consumer does not offer these two filters. Cheapest; a visible feature regression on a surface that today filters over ≤5,000 rows anyway.
- **(b) Persist** — a CF-1 follow-up materializes `transferDisposition` / `needsClassification` as columns at write/classification time. Correct long-term, but it is a schema + backfill slice with its own ordering (it must land before TX-3.2, not inside it).
- **(c) Keep them client-side and accept partiality** — reject; this reintroduces the "silently partial answer" TX-1/TX-2/TX-3 exist to kill.

**Recommendation: (a) now, (b) as a separate tracked slice.** Do not let (b) get absorbed into the UI migration.

### 1.2 The missing aggregate concept

`queryTransactions` "performs NO aggregation" by design — correct for a row API. But the panel's KPI cards, "By Flow Type" chips, Group By buckets, and the Calendar heatmap (`TransactionsCalendarHeatmap.tsx`) all fold the **entire filtered set**. A 100-row page cannot produce any of them.

So TX-3.2 has only three moves: keep the unbounded fetch alongside the paged one (defeats the purpose), ship KPIs computed over one page (dishonest — the exact failure TX-2A's coverage note was built to prevent), or **add a sibling aggregate authority**.

The pattern already exists in the codebase and should be copied rather than invented: `app/api/money/view-context/route.ts:46-47` composes `bankingTransactionWhere` into a `groupBy` directly. The contract needs a `countTransactions(...)` / `aggregateTransactions(...)` sibling that consumes the **same** `TransactionQuery` filters (sharing `buildFilterWhere`) but returns totals, not rows.

Minimum for TX-3.2: a **total count** for the active query. "Bounded answer" without "how many" is not an answer — it is a scroll.

### 1.3 Smaller contract nits

- `sort: TransactionSort` is **required**, but its doc comment says `Ordering (default "newest")`. One of the two is wrong. Make it optional with a documented default (kinder to a route parser).
- `TransactionQueryPage<T>` (core) uses `pageRows`; `TransactionQueryResult` (server) uses `rows`. Harmless, mildly confusing.

---

## 2. Search semantics

Current implementation (`transaction-query-core.ts:180-187`) is a case-insensitive `contains` OR across three fields:

```
merchant  |  description  |  resolvedMerchant.displayName
```

**This already matches the client's search exactly** (`SpaceTransactionsPanel.tsx:268` searches `merchant`, `merchantDisplayName`, `description`). That is a real and underrated win — `text` is the one part of the contract with zero adoption risk.

### Recommended initial meaning — keep it exactly as is

> `text` matches the **name-ish fields already on the row**: raw merchant, resolved merchant display name, and description. Nothing else.

Explicitly **do not** extend it now:

- **category** — an enum with 23 members (`schema.prisma:28-56`). Use the `categories` filter; free-text matching against enum names is a worse UX and a worse query.
- **institution** — a property of `FinancialAccount`, not the transaction. Use `accountIds`. Adding it makes every text search join accounts.
- **counterparty** — KD-15-gated; text-searching it risks leaking a counterparty name the Space cannot see. **Not appropriate**, now or later, without a dedicated visibility review.
- **amount as text** ("42.50") — a filter, not a search (§3).

### Expansion path (in order, each gated on evidence)

1. **Now:** trim + case-insensitive `contains` over the three fields. Already done.
2. **When measured slow:** a `pg_trgm` GIN index on `merchant` / `description`. Additive migration, no contract change. This is the correct first infrastructure step, and only after `EXPLAIN ANALYZE` on a real large Space.
3. **Only if 2 is insufficient:** a `tsvector` search column with ranking. This is where "search engine" begins — and where the contract would need a `relevance` sort mode.

Do not skip to 3. Do not consider Elasticsearch (§8).

---

## 3. Filter semantics

### 3.1 Existing filters — verdict

| Filter | Verdict | Note |
|---|---|---|
| `dateFrom` / `dateTo` | ✅ **Required now, correct** | Inclusive, `@db.Date`-aligned via `toDbDate`. Right call to use an explicit range rather than Perspective time. |
| `accountIds` | ✅ **Required now, correct** | Intersected with the visible set (`transaction-query.ts:97-102`) — good; an all-invisible request short-circuits to an empty page rather than silently widening. |
| `flowTypes` | ✅ **Required now, correct** | ANDed as a separate term so it can never overwrite the population's `flowType: { not: INVESTMENT }`. Deliberate and right. |
| `categories` | ⚠️ **Required now, unsafe typing** | Typed `string[]`, cast `as TransactionCategory[]` (`core:172`). Unvalidated — see §3.5. |
| `pending` | ✅ **Required now, correct** | Tri-state via `undefined` is the right encoding. |
| `text` | ✅ **Required now, correct** | §2. |
| `merchantId` | ❌ **Dead filter** | §3.4. |

### 3.2 Missing — required now (for first-consumer parity)

- **`source`** (`import` / `plaid` / `manual`) — today's `sourceFilter`. Unlike the derived-context fields, this **is** SQL-expressible: `deriveSource` (`transactions.ts:252-256`) is pure precedence over `importBatchId` and `plaidTransactionId`, both real columns. Cheap to add, and it must reuse that same precedence so list and filter cannot disagree.
- **A merchant sort** (`merchant` A–Z) — present in the UI today, absent from `TransactionSort`. Note it needs a keyset on `(merchant, id)` and there is **no index on `merchant`**; if it is kept, it needs the same measurement treatment as the amount sorts.

### 3.3 Missing — future (classify, do not build)

- **Amount range** (`amountMin` / `amountMax`, on magnitude) — **the most conspicuous asymmetry in the contract**: you can *sort* by amount but not *filter* by it, and range-filtering is by far the more common explorer question ("everything over $500"). It is also more tractable than amount sorting. Recommend it **replaces** amount sorting as the near-term amount concept (§4).
- **`currency`** — the column exists (`currency String?`). Trivial to add. Genuinely useful only for multi-currency Spaces; defer until one exists.
- **`institution`** — derive to `accountIds` in the consumer. Do not put it in the contract.
- **`excludeTransfers`** — sugar over `flowTypes`. Nice-to-have; the primitive already covers it.
- **Settlement/transaction status beyond `pending`** — `settlementState` is a TI2 column and exists. Future, low demand.
- **`debtOnly` / account-type** — needed only if `getDebtTransactions` converges (§6).

### 3.4 `merchantId` — a filter with no source

`merchantId` is filterable, but the list DTO **does not expose it**. `projectTransactionListRows` emits `merchantDisplayName` and `merchantLogoUrl` only; `merchantId` is read and discarded (`transactions.ts:156-169`). Today's panel filters by display *name*, and builds its dropdown from the distinct merchants **in the fetched array** (`:259`) — impossible under paging, where one page holds ~50 of thousands of merchants.

So no consumer can obtain a `merchantId` to pass, and no consumer can enumerate the options. Either:

- **(a)** add `merchantId` to the DTO (one field, additive, unblocks "more from this merchant" from a row — the natural inspect→query loop), **and** accept that the *dropdown* needs a separate distinct-merchants facet query; or
- **(b)** drop `merchantId` from the contract until (a)'s facet exists.

**Recommendation: (a).** It is one field, and merchant is the single most valuable pivot in a transaction explorer.

### 3.5 Not appropriate

- **Recurring detection** — a derived intelligence concept, not a query predicate. It belongs to an MI/intelligence layer that could later *produce* a column the query filters on. Keep it out of `TransactionQuery`.
- **"Investment exclusion" as a caller-facing flag** — investments are excluded by `BANKING_POPULATION` inside `bankingTransactionWhere`. Exposing a caller toggle would fork the one population authority. **Reject.** If an investment explorer is ever wanted, it is a different authority with a different population.

---

## 4. Sorting contract — the amount sorts are the sharpest finding

TX-3.0's implementation doc flags this as an FX parity risk. **The divergence is larger than FX**, and the doc's framing understates it.

```
Client today (SpaceTransactionsPanel.tsx:302-306):
    arr.sort((a, b) => Math.abs(rowAmount(b)) - Math.abs(rowAmount(a)))
                       ^^^^^^^^^           ^^^^^^^^^
                       ABSOLUTE            FX-CONVERTED at the row's own date

Server (transaction-query-core.ts:104):
    orderBy: [{ amount: "desc" }, { id: "desc" }]
                        ^^^^^^^^
                        SIGNED, NATIVE
```

Two independent differences:

1. **Sign.** `Math.abs` vs signed. Server "largest" returns the biggest **income**; the product's "largest" returns the biggest **magnitude** (a −$5,000 mortgage payment). These disagree **in a single-currency USD Space**, where FX is the identity. Documenting "native currency behavior" (Option B) does not fix this — it is not an FX problem.
2. **FX.** `amount` is stored native (`Float`, `schema.prisma:1778`) with a nullable `currency`; there is **no persisted reporting/converted amount column anywhere**. Conversion is strictly read-time and **client-side**, via a `SerializedConversionContext` the route builds from the fetched rows (`app/api/spaces/[id]/transactions/route.ts:55-60`). A client holding one page cannot order across pages it hasn't seen.

And a hard constraint that decides it: **Prisma cannot express `ORDER BY abs(amount)`.** There is no expression ordering in `orderBy`. So the server cannot reproduce the product's sort today without raw SQL plus a functional index, or a persisted magnitude column. There is also **no index on `amount` at all**.

### Recommendation: **Option A — remove amount sorting from the contract now.**

Narrow `TransactionSort` to `"newest" | "oldest"` and delete `lastAmount` from `TransactionCursor` and the amount branches of `keysetWhere` / `orderByForSort` / `compareForSort`. Rationale:

- Option B (document native) ships a sort that is **wrong for every user**, single- and multi-currency alike, and calls it documented. Reject.
- Option C (reporting-amount authority) is the correct long-term answer but is a schema + backfill + FX-at-write-time slice with real doctrinal weight (which date's rate? what happens when rates are revised?). It must not be smuggled into a UI migration.
- Removing it costs little: **amount *range filtering* (§3.3) answers most of what amount sorting is used for** ("show me the big ones") and is cheap and exact.
- Everything removed here is additive to restore. The keyset machinery for amount sorts is already written and tested; if C lands, it is re-enabled against the reporting column with the same shape.

**Sequenced:** A now → amount-range filter in TX-3.3 → C only if evidence shows range filtering is insufficient.

If Option A is rejected and amount sorts must ship in TX-3.2, then the *minimum* honest bar is: switch the client to signed ordering too so the two agree, gate the sort to Spaces with an identity conversion context (i.e. all rows already in the reporting currency — a signal `serializeSpaceConversionContext` already produces as an empty entry table), and hide the control otherwise. That is strictly more work than Option A.

---

## 5. Pagination contract

### Correct

Keyset on `(sortKey, id)` with a strict total order, `take: limit + 1` sentinel, no `skip`/offset anywhere, `nextCursor` derived from the last kept row and `null` on the last page, hard cap of 100 with a default of 50. The pure test walks a synthetic dataset with same-day and same-amount ties through all four sorts and proves no duplicates and no missing rows. Mechanically, this is right, and it is materially better than offset.

### Problem 5.1 — the cursor is not tagged with its sort (must fix)

`TransactionCursor` carries `{ lastDate, lastId, lastAmount? }` but not the sort it was derived under. A consumer that changes sort while holding a cursor gets **silent wrong behavior**, not an error, in both directions:

- Date cursor → amount sort: `keysetWhere` returns `null` (`core:135`, no `lastAmount`) and the query **silently restarts at page 1**. An infinite scroll appends page 1 to itself, forever.
- Amount cursor → date sort: `lastDate` is present, so a date keyset is applied from a position that is meaningless in date order — a **wrong window, no error**.

**Fix:** put `sort` in the cursor and have `queryTransactions` treat a mismatch explicitly (reset to first page, or reject). Cheap, and it turns two silent failures into one defined behavior.

### Problem 5.2 — the sort keys are mutable (must document; affects the guarantee)

The "no duplicate / no skip" proof holds for an **immutable** sort key. In this system the sort keys change in place:

```
lib/plaid/syncTransactions.ts:383   baseFields = { ..., date, amount, pending, ... }
lib/plaid/syncTransactions.ts:445   db.transaction.update({ where: { id: existingByPlaidId.id }, data: { ...baseFields, ... } })
lib/plaid/syncTransactions.ts:463   db.transaction.update({ ... })   // fingerprint fallback
```

A pending→posted transition **updates `date` and `amount` on the same row id**. If a sync lands mid-scroll, a row can move across the cursor boundary and be **duplicated** (moved backward) or **skipped** (moved forward). The pure test cannot catch this — it uses a static dataset.

This is not fatal and does not argue against keyset (offset is strictly worse here). It argues for three things:

- **Date sorts are low-risk**, because posted dates move by days at most and the common `newest` scroll moves away from the volatile recent edge.
- **Amount sorts are high-risk** — pending amounts change routinely (holds, tips, FX settlement). Another independent reason for Option A (§4).
- **The consumer must dedupe appended pages by `id`.** State this in the contract rather than leaving it for TX-3.2 to discover. Rows also legitimately *disappear* mid-scroll via soft-delete (`syncTransactions.ts:505` `updateMany` sets `deletedAt`); that only shrinks the result and is acceptable.

There is no snapshot/as-of pin, and I do **not** recommend adding one — it would reintroduce exactly the Perspective-time coupling TX-3.0 correctly rejected.

### Limits — appropriate

100 max / 50 default is right. For **mobile infinite scroll**, 50 is a good page. For **desktop**, the panel currently offers 25/50/100 page sizes — all within the cap, so it maps cleanly. On **refresh**, the consumer should discard accumulated pages and restart from a null cursor rather than attempt to reconcile; combined with id-dedupe on append, that covers the realistic cases.

One efficiency note: `resolveVisibleAccountIds` runs an extra query on **every page** whenever `accountIds` is set. Fine at current scale; a candidate to hoist into the consumer's session once measured (§8 argues it should become unconditional anyway).

---

## 6. Relationship to existing transaction authorities

I inventoried every `db.transaction` read in the repo. **There is no competing explorer authority.** `queryTransactions` is a superset of `getTransactions`, not a fork — it already reuses `bankingTransactionWhere`, `transactionListInclude`, and `projectTransactionListRows`.

The real duplication predates TX-3.0 and lives elsewhere:

| Reader | Relationship | Action |
|---|---|---|
| `getTransactions` (`transactions.ts:228`) | Same population, **same DTO** (already shared). | **Migrate — but consumer-gated.** Row shape is identical; all risk is on the consumer side (`use-space-data.ts:200` loads the whole payload into React state, and every Cash Flow / heatmap widget assumes it). Needs §1.2 aggregates first. `moneyCtx` also becomes per-page. |
| `app/api/accounts/[id]/transactions/route.ts:53` | **Divergent predicate** — hand-rolled `{financialAccountId, deletedAt:null}` with a separate visibility pre-check and **no FlowType population gate**. Also appears **orphaned** (no `fetch()` in `components/`/`app/` targets it). | **Migrate first — lowest risk, highest correctness win.** Preserve its deliberate non-FULL "empty 200" contract; note investment-category rows it returns today would correctly disappear. |
| `lib/export/assemble.ts:134` | Consumes `getTransactions`. | **Migrate — mechanical.** A loop until `hasMore` removes the in-memory `EXPORT_TRANSACTION_CAP` materialization. Watch total latency. |
| `getDebtTransactions` (`transactions.ts:301`) | Same population (`debtOnly`), **different include**, omits `source`. | **Defer.** Needs an account-type filter the contract lacks, and both consumers fold rows into totals — paging is a semantic change, not plumbing. |
| AI assemblers (`lib/ai/assemblers/transactions.ts:352, 1322`) | **Re-derive the KD-15 + population predicate inline, twice.** | **Do NOT migrate to `queryTransactions`** — they fold thousands of rows into rollups; a paged row API structurally cannot serve them. **Do converge them onto `bankingTransactionWhere`** — that is the actual duplication, and it is independent of TX-3. |
| Cash Flow / Calendar / heatmap widgets | Client-side folds over the one fetched array. | **Aggregate endpoints**, not the row API. Follow the `view-context` pattern. |
| `getTransactionDetail` (`transactions.ts:396`) | By-id, different visibility predicate, richer DTO. | **Do not migrate.** Correct as a separate authority (§7). |
| `getInvestmentTransactions` (`transactions.ts:335`) | Dead, unbounded, no consumer. | **Delete** (this is the TX-4 cleanup already noted in TX-1/TX-2). |
| ~20 aggregate readers (`_sum`/`_min`/`count`/`groupBy`) and import/sync matchers | Deliberately read outside the banking population. | **Never migrate.** |

---

## 7. Detail + action boundary — **no blocker, this end is sound**

The inspect→act path does **not** depend on the list DTO carrying provenance, because the drawer re-fetches by id:

```
list row (id only)
  → useOpenTransaction() → ?transaction=<id>
  → TransactionDetailDrawer.tsx:89-104  fetch(`/api/transactions/${id}`)
  → getTransactionDetail()  →  TransactionDetail (pfc*, TI2 facts, provenance,
                                counterparty, reporting, relationships)
  → buildTransactionDetailSections(d)
```

`TransactionDetail extends Transaction` and adds everything TI5 detail, the relationship resolver (±7-day candidate window, `take: 300`), and the reporting/FX block need. The correction route (`app/api/transactions/[id]/correct/route.ts`) requires only **transaction id + Space context + FULL visibility** plus `requireUser()`.

**Conclusion: the query contract exposes enough identity — `id` is sufficient, and it is present.** This boundary is correctly drawn and needs no change for TX-3.2.

Two follow-ons, neither a blocker:

- **`merchantId` on the list DTO** (§3.4) — needed for the inspect→query loop ("more from this merchant"), not for the drawer.
- **List invalidation after correction.** The correct route re-reads and returns a fresh `TransactionDetail`, but nothing invalidates the list. Under accumulated keyset pages this matters more than it does today: recategorizing a row while a `categories` filter is active should remove it from the list. A TX-3.4 concern — flag it now so the page-accumulation state model is designed with it in mind.

---

## 8. Scale review — assumptions hold, no infrastructure needed

Rough shape: an active user with 3–5 connected accounts generates ~3–5k transactions/year.

| Users | Rows/year | Cumulative @ 3yr | Verdict |
|---|---|---|---|
| 100 | ~400k | ~1.2M | Trivial for Postgres. |
| 1,000 | ~4M | ~12M | Comfortable with correct indexes. |
| 10,000 | ~40M | ~120M | Fine for **keyset + indexed range**; would be painful for offset paging (which TX-3.0 correctly avoided). |

Query frequency is low and human-paced: an infinite scroll is one indexed query per ~50 rows viewed, and the `limit + 1` sentinel avoids a second count query per page. Nothing here justifies **Elasticsearch, read replicas, or a caching layer**, and none should be added.

### The one real query-plan concern (for TX-3.2 measurement)

TX-3.0 deferred `[financialAccountId, date, id]` to measurement — right call. But note *why* it may not help as written: `bankingTransactionWhere` expresses visibility as a **relation filter**, not an id list:

```ts
financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status, visibilityLevel } } }
```

Prisma compiles that to a join/subquery. A global page ordered by `(date desc, id desc)` across that join is unlikely to use a `[financialAccountId, date, id]` index for ordering — Postgres would sort.

**Recommendation for TX-3.2 (measure, then act):** always resolve to an explicit account-id list first — `resolveVisibleAccountIds` already exists and already runs when `accountIds` is set — and query `financialAccountId IN (...)` unconditionally. Account counts are small (single/double digits), the extra query is one indexed lookup, and it gives Postgres a shape it can serve from `[financialAccountId, date, id]` via per-account index scans merged in date order. Then `EXPLAIN ANALYZE` on a >5,000-row Space and add the index **only if** the plan shows the sort it removes.

Also missing and worth knowing before measuring: **no index on `merchant`, `category`, `amount`, or `deletedAt`.** That bears on the merchant sort (§3.2), amount sorting (§4), and text search (§2 step 2) — three more reasons to keep the TX-3.2 surface narrow and measure before indexing.

---

## 9. Findings

### Must fix before TX-3.2

| # | Finding | Where |
|---|---|---|
| **M1** | **Amount sorts are semantically a different sort**, not just an FX divergence — client uses `Math.abs(converted)`, server uses signed native; they disagree even in a single-currency Space. Prisma cannot express `ORDER BY abs(amount)`. **Recommend Option A: remove amount sorting from the contract.** | `core:101-109`, `SpaceTransactionsPanel.tsx:302-306` |
| **M2** | **Cursor is not tagged with its sort.** A sort change with a live cursor silently restarts at page 1 (infinite-scroll loop) or applies a meaningless window — no error either way. | `core:35-42, 131-146` |
| **M3** | **No input-parsing / validation boundary.** `categories: string[]` is cast to the enum unvalidated; `dateFrom`/`dateTo` are unvalidated (`toDbDate("junk")` → Invalid Date → Prisma throws → 500). There is **no zod in this repo**, so a route will hand-roll it — that parser belongs in the pure core as `parseTransactionQuery`, tested. **Biggest blocker to a route.** | `core:114-116, 156-189` |
| **M4** | **Sort keys are mutable.** `syncTransactions.ts:383/445/463` updates `date`, `amount`, `pending` in place; a pending→posted row can cross the cursor mid-scroll and be duplicated or skipped. Contract must state it; consumers must dedupe by `id`. | `lib/plaid/syncTransactions.ts:383-463` |
| **M5** | **First-consumer filter regression.** `transferDisposition` and `needsClassification` are post-projection derived (not SQL-expressible without a second derivation authority); `source` is absent though expressible; merchant A–Z sort is absent. Decide descope-vs-persist **before** the UI slice. | `transactions.ts:258-284`, `SpaceTransactionsPanel.tsx:268` |
| **M6** | **`merchantId` is a dead filter** — the DTO doesn't expose it and a single page can't enumerate merchant options. Add `merchantId` to the DTO, or drop the filter. | `transactions.ts:156-169`, `core:58` |
| **M7** | **No count/aggregate concept.** The panel's KPIs, Group By, and Calendar heatmap fold the full set; a 100-row page cannot serve them. Needs a sibling aggregate authority sharing `buildFilterWhere` (follow the `view-context` `groupBy` pattern). | `transaction-query.ts` (absent) |

### Should fix later

- **S1** `sort` is required but documented as defaulting to `"newest"`. Make it optional with a real default.
- **S2** `resolveVisibleAccountIds` re-queries per page; hoist once measured (and see §8 — it likely becomes unconditional).
- **S3** Intra-day ordering falls to `id` (cuid), so same-day order is stable but **arbitrary, not chronological**. Fine for the day-grouped UI; document it.
- **S4** `TransactionQueryPage.pageRows` vs `TransactionQueryResult.rows` naming drift.
- **S5** Converge `app/api/accounts/[id]/transactions` — the one row reader bypassing `bankingTransactionWhere` (and apparently orphaned).
- **S6** Converge the two AI assemblers onto `bankingTransactionWhere` (not onto `queryTransactions`) — the real predicate duplication, independent of TX-3.
- **S7** `getDebtTransactions` needs an account-type filter and emits no `source` — DTO asymmetry to resolve if it ever converges.
- **S8** Delete the dead, unbounded `getInvestmentTransactions`.
- **S9** List invalidation after a correction (§7).

### Future enhancements

- **F1** Amount **range** filter (`amountMin`/`amountMax` on magnitude) — recommended as the near-term replacement for amount sorting.
- **F2** `currency` filter (column exists; defer until a multi-currency Space exists).
- **F3** Reporting-amount authority (persisted converted/magnitude column) — the only real path to correct amount sorting; a schema + FX-doctrine slice, deliberately out of scope.
- **F4** `pg_trgm` GIN for text search, **after** measurement.
- **F5** Query serialization to URL / saved queries — the natural "Question" surface once the contract is stable.
- **F6** `excludeTransfers` sugar over `flowTypes`.

### Explicitly rejected

- Caller-facing "investment exclusion" flag (forks the one population authority).
- Recurring detection as a query predicate (intelligence layer, not a filter).
- Counterparty text search (KD-15 leak risk).
- Elasticsearch / read replicas / caching layer (no evidence).
- An as-of snapshot pin for pagination (reintroduces Perspective-time coupling TX-3.0 correctly rejected).

---

## 10. Recommended TX-3 roadmap

```
TX-3.0  Query Authority                                    ✅ landed (537b817)
TX-3.1  Contract Review                                    ✅ this document
TX-3.1b Contract Hardening  ← DO THIS NEXT
          M1 remove amount sorts · M2 sort-tag the cursor
          M3 pure parseTransactionQuery · M4 document key mutability
          M6 merchantId on the DTO · M7 count/aggregate sibling
          M5 decide: descope vs persist derived context fields
          (pure + contract only — still no consumer)
TX-3.2  First Consumer Migration
          per-account route (orphaned, divergent predicate) → queryTransactions
          then the paged route + EXPLAIN ANALYZE + index decision (§8)
TX-3.3  Transaction Explorer UI
          SpaceTransactionsPanel cutover, infinite scroll, server filters,
          amount-range filter (F1), honest aggregates via the M7 sibling
TX-3.4  Detail + Actions Integration
          wire the existing /correct route to UI, list invalidation,
          merchant pivot, AI slot
TX-4    Cleanup
          delete getInvestmentTransactions, converge AI assemblers (S6)
```

**Note on numbering:** `TX3_QUERY_CONTRACT_IMPLEMENTATION.md` §4 uses a different scheme (TX-3.1 = route, TX-3.2 = panel cutover, TX-3.3 = aggregates, TX-3.4 = per-account modal). This review adopts the mission's numbering. That doc's §4 should be renumbered to match so the two don't drift.

**One structural change from that plan:** it migrates the *space route* first. This review recommends the **per-account route first** — it is orphaned, it is the only row reader with a divergent predicate, and it carries none of the aggregate-honesty coupling that makes the space route expensive.

---

## 11. Summary

TX-3.0 built the right thing. Keyset over offset, one population authority, one DTO, page-bounded, no Perspective time — every foundational decision holds up, and none of the findings below argue for rebuilding it.

But "the query runs correctly" and "the contract is ready for consumers" are different bars. The gaps are concentrated at the contract's edges: it cannot yet safely *receive* a query (no parsing, M3), it cannot *describe* the answer's size (no count, M7), one of its sorts means something different from what the product calls that sort (M1), its cursor can silently lie under a sort change (M2), and four of the first consumer's controls have nowhere to land (M5, M6).

All are additive or subtractive edits to a sound core. One hardening slice (TX-3.1b) closes them, and the first consumer should be the orphaned per-account route rather than the space route — the cheapest possible proof that the authority works, before the expensive one that drags aggregate honesty with it.

**Verdict: ITERATE BEFORE CONSUMERS.** Stop after TX-3.1.
