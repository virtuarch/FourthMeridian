# TX-3 — Transaction Explorer Investigation

**Type:** Product-architecture investigation. **No code, no migrations, no UI changes.**
**Date:** 2026-07-20.
**Predecessors:** TX-1 (scale audit) → TX-2 (bounded loaders `b241cc2`) → TX-2A (completeness honesty `be836db`). Reads are now bounded, truncation is honest, calculations unchanged. TX-3 is **not** a pagination task — it is a decision about *what Transactions should become*.

---

## Core answer up front

**Transactions should become a financial investigation surface, not a ledger.** The organizing loop is:

> **ask** (a query intent — date/account/flow/merchant/text) → **answer** (a bounded, honest, server-computed result window) → **inspect** (open any row's detail) → **act** (correct it, or ask AI about it).

It is *not* "scroll every row you've ever had." A spreadsheet answers "show me everything"; an investigation surface answers "show me the thing I'm looking for, tell me the truth about the set, and let me go deep on any of it." The current surface already has the right *visual* DNA (an editorial day-grouped ledger row that reflows and never becomes a table — `SpaceTransactionsPanel.tsx:829-915`) and the right *detail* DNA (a URL-driven, fetch-by-id drawer). What it lacks is a **server query model**: today every filter, search, sort, group, and page runs in the browser over one preloaded ≤5,000-row array.

---

## 1. Current state — responsibilities inventory

The Space Transactions tab renders `TransactionsWorkspace` → `SpaceTransactionsPanel`, a client component that receives the **entire transaction array as a prop** and does nearly everything in-memory. The only server round-trips are the initial bulk fetch (`GET /api/spaces/[id]/transactions`, bounded to 5,000) and a lazy per-row detail fetch.

| Capability | Where it runs today | Classification | Rationale |
|---|---|---|---|
| **Row browsing / day-grouped ledger** | client, over loaded array (`SpaceTransactionsPanel.tsx:397-406,713-740`) | **Belongs — re-architect to server-paged** | Core of the surface; the editorial row DNA stays, the data source changes. |
| **Filters** (category, flow, disposition, source, merchant, needs-review, account, date-range, pending) | client `Array.filter` (`:268-289`) | **Belongs — move server-side** | These are *query intent*. They must compile to a WHERE clause, not a browser predicate. |
| **Search** (merchant/displayName/description substring) | client substring (`:284-286`) | **Belongs — move server-side** | Today search only finds within the most-recent 5,000; silently misses older matches. |
| **Sort** (newest/oldest/largest/smallest/merchant) | client reorder (`:295-315`) | **Belongs — move to server `orderBy` (fixed key set)** | Sorting a page-window requires a server order; client sort of one page is meaningless. |
| **Client pagination** (25/50/100 page slice) | client `slice` (`:332-335`) | **Remove — replace with real server pagination** | It paginates the loaded array, not the DB. Numbered pages over a truncated set are dishonest at scale. |
| **Group By pivots** (flow/merchant/account/category) | client pivot over full array (`:351-389`) | **Remove from explorer / relocate to analysis** | A pivot needs the *whole population*; it cannot run over a server page. Aggregate pivots are a Cash Flow / analysis job, not a find-a-transaction job. |
| **Summary KPI cards** (spend/income/transfers/debt/investments/refunds) | client sum over filtered array (`:408-418,648-658`) | **Belongs elsewhere (Cash Flow) OR a dedicated server aggregate** | Cannot survive server-paging honestly (a page ≠ the set). Either a cheap server `groupBy` for the *current query*, or defer aggregate storytelling to the Cash Flow workspace. See §3. |
| **Calendar heatmap** (day-net) | client, over filtered array (`TransactionsCalendarHeatmap.tsx`; fed `filtered` at `:679`) | **Belongs elsewhere / thin server view** | Overlaps the Cash Flow Calendar; a day-net heatmap is aggregate reporting. Either drop from the explorer or back it with server day-aggregates. |
| **Merchant resolution** (displayName) | write-time (`lib/transactions/merchant-resolver.ts`) | **Elsewhere — already correct** | Read surface just consumes `merchantDisplayName ?? merchant`. |
| **Merchant merge review** | separate admin Space (`app/merchant-ops/*`) | **Elsewhere — already correct** | Operator surface, not customer Transactions. |
| **Per-transaction correction** (`POST /api/transactions/[id]/correct`) | endpoint exists, **no UI** (`correct/route.ts:18`) | **Belongs — wire into the detail drawer** | This is the "act" verb of an investigation surface. Built server-side, unsurfaced. |
| **Categories** (display chip + filter vocab) | client display (`transactions-filter-constants.ts`) | **Belongs (presentation)** | Population authority is FlowType, not category — already enforced; keep as display filter. |
| **Export** | separate server pipeline (`lib/export/assemble.ts`, 5,000 cap) | **Elsewhere — already correct** | Independent of the browse array; honest truncation in the manifest. A future "export this query" hook is optional, not core. |
| **AI transaction feed** | separate assembler (`lib/ai/assemblers/transactions.ts`, own windowed query) | **Elsewhere — already correct** | Summary-only, never raw rows; shares only the visibility predicate. |
| **Per-account history** (`GET /api/accounts/[id]/transactions`) | separate 5,000-capped list (`accounts/[id]/transactions/route.ts`) | **Elsewhere (Accounts) — should reuse the same server-paged read** | Same scale problem; converge onto the TX-3 read model. |
| **Detail (row → drawer)** | URL-driven drawer, fetch-by-id (`useTransactionDrawer.ts`, `GET /api/transactions/[id]`) | **Belongs — already TX-3-ready** | Independent of the list array; see §5. |

**Answer to "belongs / elsewhere / remove":** the explorer keeps *find + inspect + act* (browse, filter, search, sort, detail, correct). It sheds *aggregate reporting* (Group By, KPI cards, calendar heatmap) to Cash Flow or to explicit server-aggregate calls, and it stops doing *fake* pagination.

---

## 2. Problems (why the current model breaks)

1. **Everything is client-side over a capped array.** Filter/search/sort/group/paginate all run in the browser over ≤5,000 preloaded rows (`SpaceTransactionsPanel.tsx:266-406`). For a Space over the cap:
   - **Search is silently partial** — it can only match within the most-recent 5,000 (TX-2A surfaces the cap, but a user searching for a 2-year-old merchant still gets "no results", indistinguishable from "doesn't exist").
   - **Custom date ranges lie** — selecting Jan 2024 returns nothing if those rows fell outside the recent 5,000.
   - **Merchant/account filter option lists are partial** — built only from the loaded set (`:259-263,244-254`).
2. **The payload is the ceiling.** Even bounded at 5,000, the initial fetch ships thousands of fully-serialized rows to the browser on every tab open. That is wasteful (a user usually wants the last few weeks) and it is the wrong shape for a query surface.
3. **Aggregates can't be honest under paging.** The KPI cards and Group By fundamentally require the whole set. They work *only because* the whole set is loaded — which is exactly the thing that doesn't scale.
4. **No server query model exists.** There is **no cursor pagination anywhere** in a user-facing transaction read (the only precedents: the admin AuditLog offset/limit endpoint `app/api/admin/audit/route.ts:106-112`, and a keyset backfill *script* `scripts/backfill-transfer-evidence.ts:77`). The read model is "bounded slice + truncation sentinel" everywhere.
5. **Two parallel list reads** (Space tab + Account modal) each re-implement a 5,000-cap fetch; they should converge.

---

## 3. Target architecture

### 3.1 Read model: query intent → server filter → bounded window

Move decisively from:

```
load ≤5,000 rows  →  browser filter/search/sort/paginate
```

to:

```
query intent (filters + cursor)  →  server WHERE + orderBy + keyset  →  bounded page (25–50 rows) + nextCursor
```

**A `TransactionQuery` contract** (the request shape) carries: `dateFrom?/dateTo?`, `accountIds?`, `flowType?`, `category?`, `pending?`, `merchantId?`, `text?`, `sort` (fixed enum), `cursor?`, `limit` (page size, default 25–50, hard-capped ~100). It compiles to a Prisma `where` built on the existing `bankingTransactionWhere` + additional indexed predicates.

**Pagination: keyset (cursor), not offset.** Order by `(date desc, id desc)` — `date` is `@db.Date` (no time component) so `id` is the required tie-break. Keyset reads O(page_size) rows via an index range scan and is stable under inserts; offset degrades linearly with depth and double-counts on concurrent sync. The only offset precedent (admin audit) is fine for small admin lists but wrong here.

**Efficient Space scoping.** Space visibility is a *relation join* (`financialAccount.spaceAccountLinks`), not a column on Transaction. Per-page joins are avoidable: **resolve the visible account-id set once** (small query, already done for the Account modal gate), then query `financialAccountId: { in: [...] }` directly against the transaction indexes. This turns every page into a pure indexed range scan on `[financialAccountId, date, id]`.

**Filters → indexes** (current index set is *mostly* sufficient):
- date range → `[financialAccountId, date]` (exists) ✅
- account subset → narrows the `in` list ✅
- flowType + date → `[financialAccountId, flowType, date]` / `[flowType, date]` (exist) ✅
- merchantId → `[merchantId]` (exists) ✅
- category / pending / source → no dedicated index; these are **low-selectivity refinements** applied on top of the date/account range scan — acceptable (Postgres filters the already-narrow range), no new index needed for beta scale.
- **text search** (`merchant`/`description` ILIKE) → the one genuinely new cost. For true full-history free-text search, a `pg_trgm` GIN index on `merchant` (and optionally `description`) is the right tool. **Defer** it (§6): ship structured filters first; add trigram search only if free-text-across-all-history proves necessary. Interim: text search can stay client-side *within the loaded page window* with an honest "searching recent results" scope note, or trigger a server ILIKE without the index at small scale.

**Aggregate honesty.** The current KPI cards and Group By cannot ride a page. Two acceptable directions (recommend a hybrid):
- **Lightweight query header** — one cheap server `groupBy(flowType)` + `count` for the *active query* returns "N results · net Y" so the investigator keeps context without loading rows. This is bounded and indexed.
- **Rich aggregate storytelling stays in Cash Flow** — the multi-perspective breakdown, the day-net calendar, and the flow/merchant/account pivots are the Cash Flow workspace's job (it already folds DayFacts). The explorer links *into* Cash Flow rather than re-deriving it. This is the "not a spreadsheet" line.

### 3.2 What stays unchanged
- `bankingTransactionWhere` + KD-15 visibility predicate (the population/visibility authority is reused verbatim).
- The AI assembler and export pipelines (their own bounded windowed queries — already correct).
- The detail read (`GET /api/transactions/[id]`) — already fetch-by-id, independent of the list (§5).

---

## 4. UX recommendation

### Option evaluation (mobile-first)

- **Option A — traditional paginated table.** ❌ Reject. Desktop-centric, dense columns, "spreadsheet" — the exact thing the product thesis rejects (`SpaceTransactionsPanel.tsx:829-833`: "no table, at any width"). Numbered pages fight touch.
- **Option B — infinite-scroll feed.** ◐ Partial. The *loading mechanic* is right (append pages via cursor, no numbered pager, natural on mobile), but a bare feed with no query framing is just a longer ledger — it doesn't make Transactions an *investigation* surface.
- **Option C — investigation explorer.** ✅ **Recommend.** A query-led surface: a prominent search/filter bar that compiles to server query intent; a bounded, honest result set presented as the existing **editorial day-grouped feed**; a lightweight "N results · net Y for this query" header; and the detail drawer as the inspect verb. It *uses B's cursor/infinite-scroll mechanic* for loading, but frames it as "answer to a question," not "everything."

**Recommendation: Option C, built on an infinite-scroll (cursor) loading mechanic, mobile-first.** Concretely:
- The day-grouped editorial rows and the URL-driven detail drawer stay (proven DNA).
- The filter/search bar becomes the primary affordance and drives *server* query state (debounced), replacing the client predicate.
- "Load more" / infinite scroll appends cursor pages; no numbered pager.
- A compact query-result header replaces the six KPI cards (which relocate to / defer to Cash Flow).
- Group By and the calendar heatmap leave the explorer (Cash Flow owns aggregate views).

### Time model for the explorer (mobile-first, arbitrary range)
The explorer's time control is **its own local model**: rolling presets (7/30/90d) + an arbitrary `{from,to}` custom window — *not* asOf-anchored. This is what the surface already has (`SpaceTransactionsPanel.tsx:62,513-549`); TX-3 makes it a *server* parameter rather than a client cutoff. See §4-below for why this is deliberately separate from canonical Perspective time.

---

## 5. Relationship to TimelineLens

**Do not put the explorer on canonical Perspective time, and do not adopt TimelineLens as its time control.** This is documented doctrine, not inference:

- **TimelineLens is a prototype + planned migration, not shipped.** It exists only under `app/prototype/**` and in `docs/audits/TIMELINELENS_V4_MIGRATION_MATRIX.md` ("investigation complete, no code changed"). There is no `components/atlas/TimelineLens` and no production import.
- **Canonical Perspective time is the wrong model for an explorer.** The canonical state is a triple `{ preset, asOf, compareTo }` (`lib/perspectives/time-range.ts:128`) — a *point-in-time snapshot with one comparison baseline*, asOf-anchored, calendar-aligned. The migration matrix explicitly marks Transactions **"Defer — separate local adapter … Must NOT touch Perspective time"** and states plainly that **"`compareTo` has no meaning here"** (`TIMELINELENS_V4_MIGRATION_MATRIX.md:41,132-135`). An explorer needs an arbitrary `{start,end}` range + account + merchant axis, which is orthogonal to a single asOf.
- **TimelineWidget (activity) is not a paginator precedent.** `components/space/widgets/TimelineWidget.tsx` self-fetches the latest 60 activity events (`app/api/spaces/[id]/activity/route.ts:505`) and paginates them *client-side*; the matrix calls that recency cap a blocker for any time-range control. Its pagination model does not transfer.

**Recommendation: a separate `TransactionQuery` adapter, sharing only presentation.** If/when TimelineLens is promoted to an Atlas primitive, it is described by its own authors as *"a reusable presentation boundary over canonical Perspective time"* with a `state + resolver → Lens → onApply(next)` contract. The explorer can reuse that **visual shell** with a **different adapter** whose state is `TransactionQuery` (arbitrary range + filters), **not** `PerspectiveTimeState`. So: *shared component, different adapter, explicitly not canonical Perspective time.* Concretely — answer the sub-question directly:
- Use TimelineLens *presentation*? Optional and only later — as a skin over a transaction-query adapter.
- A separate `TransactionLens`/adapter? **Yes** — the explorer's time+filter state is its own model.
- Canonical Perspective time applies? **No** — deliberately not.

---

## 6. Transaction detail — drawer / page / modal

**Already answered by the shipped architecture: it is a URL-driven drawer, and that is the right choice — keep it.**

- Clicking a row calls `openTransaction(id)` → pushes `?transaction=<id>` → the single shell-mounted `TransactionDetailDrawer` (in `DashboardChrome`) fetches `GET /api/transactions/[id]` and renders `buildTransactionDetailSections` (Summary, Account, Transaction Intelligence, Relationships, Provenance, Reporting). It is **shareable, refresh-survivable, Back-closable, and independent of the list array** (`useTransactionDrawer.ts`, `TransactionDetailDrawer.tsx:93-109`).
- **This is why TX-3 does not touch detail:** the drawer fetches by id, so moving the *list* to server-paging leaves detail untouched. The detail layer is already TX-3-ready.

### TI roadmap reconciliation
"TI" = Transaction Intelligence (TI0–TI5). Relevant slices:
- **TI-1** — the canonical single-transaction read `GET /api/transactions/[id]` + `TransactionDetail` DTO (shipped, stable seam).
- **TI5-1 / TI5-2** — DTO field groups: TI2 durable facts exposed detail-only, and read-time relationship facts (pending↔posted, duplicate, transfer candidate).
- **TI5-3 (A/B/C)** — the **shipped** drawer: URL plumbing (3A), pure section projection (3B), single shell-level instance (3C).
- The convergence roadmap (`TRANSACTIONS_WORKSPACE_CONVERGENCE_ROADMAP.md`) describes a **modal→RightPanel re-shell** as "presentation-only, not a data change." **Reconciliation:** the Atlas `RightPanel` *is* the edge-anchored drawer primitive — "drawer" and "RightPanel" are the same target; the doc thread predates the shipped shell drawer. Recommendation: **keep the URL-driven `?transaction=` opener and the shell-mounted drawer**; do not switch to a full page or a centered modal (both lose deep-linkability + the inspect-without-leaving-context property).

### How detail affects the explorer (the "act" verbs)
The detail drawer is where the investigation surface earns its name. Two already-scoped-but-unsurfaced capabilities turn it from *inspect* into *investigate + act*:
- **Wire `POST /api/transactions/[id]/correct`** (exists, no UI) into the drawer — correct merchant/category → a USER MerchantRule/override. This is the missing "act" verb.
- **Per-transaction AI explanation** — the drawer already reserves an inert "Ask AI" slot (v2.6); it becomes the "explain this" verb when the per-transaction assembler lands. **Out of TX-3 scope** — noted as the natural successor.

---

## 7. Scale assumptions

Rough model (per TX-1: a moderately active user generates a few thousand transactions/year across accounts; a real power user is ~28–35k lifetime). Assume ~5k rows/user/year, heavy tail ~15–30k lifetime.

| Cohort | Total transaction rows (order of magnitude) | Query volume | Verdict |
|---|---|---|---|
| **100 users** | ~0.3–3M | a handful of concurrent explorer sessions | Trivial. Current client model even limps along (until an individual heavy user). |
| **1,000 users** | ~5–30M | tens of concurrent sessions, bursty on sync | Comfortable for Postgres **with keyset pagination + the existing indexes**. The client model is already failing for heavy individuals. |
| **10,000 users** | ~50–300M | low-hundreds concurrent at peak | Still Postgres-only. The risk is **never total rows** — it is *per-request unbounded scans*. A keyset page reads O(page_size) via index regardless of table size. No sharding, no search cluster, no read replica needed for this range. |

**Indexes:** the current set already covers the hot paths (`[financialAccountId, date]`, `[financialAccountId, flowType, date]`, `[flowType, date]`, `[merchantId]`). The one addition worth making when TX-3 lands is **`[financialAccountId, date, id]`** so the `(date desc, id desc)` keyset is a pure index scan with no sort. A `pg_trgm` GIN index on `merchant` is needed **only if** full-history free-text search ships — defer until that decision.

**Caching:** none required initially. Transactions mutate on every sync, so a cache would need aggressive invalidation for little gain; keyset first-page reads are already cheap. The query-header aggregate (`groupBy` + `count`) is the only repeatable computation and is itself index-bounded. **Do not add a cache layer, a search service, materialized views, or read replicas for the modeled range** — they are premature.

**Query volume reality check:** the *current* model reads up to 5,000 rows **per tab open**. The TX-3 model reads ~25–50 rows per page. TX-3 is a net *reduction* in DB and network load even before considering scale — the scale argument and the efficiency argument point the same way.

---

## 8. Migration plan (phased — no implementation in TX-3)

1. **TX-3.0 — Contract.** Define `TransactionQuery` (filters + cursor + sort enum + page size) and a server-paged endpoint (evolve `GET /api/spaces/[id]/transactions` with query params, or a sibling route) returning `{ rows, nextCursor, queryTotals? }`. Reuse `bankingTransactionWhere`; resolve visible account-ids once, then keyset over `financialAccountId IN (...)`.
2. **TX-3.1 — Server filters + keyset.** Map every filter to an indexed WHERE; server `orderBy` for the fixed sort set; `(date desc, id desc)` cursor. Add the `[financialAccountId, date, id]` index (additive migration).
3. **TX-3.2 — Client cutover.** Rebuild `SpaceTransactionsPanel` from "one array + client predicate" to "query state → fetch page → append (infinite scroll)". Filters/search become debounced server params. Remove client pagination and world-scoped Group By.
4. **TX-3.3 — Aggregate honesty.** Replace the six KPI cards with a lightweight server query-total header (`groupBy(flowType)` + count for the active query), and relocate rich aggregate views (calendar, pivots) to / link them into Cash Flow.
5. **TX-3.4 — Converge the Account modal** onto the same server-paged read (retire the parallel 5,000-cap list).
6. **Defer:** `pg_trgm` full-history text search (only if needed); per-transaction AI explanation (v2.6); the `/correct` UI wiring (a small, independent TI slice worth pulling forward). TX-4 remains separate (dead `getInvestmentTransactions`, drop unused `[counterpartyAccountId]` index, doc-comment cleanup).

**Detail layer:** untouched by the migration (already fetch-by-id). The only detail-adjacent recommendation is surfacing the existing `/correct` endpoint.

---

## 9. Summary

- **What Transactions should become:** a **query → answer → inspect → act** investigation surface, keeping its editorial-row and URL-drawer DNA, shedding aggregate reporting to Cash Flow, and replacing client-side everything with a server keyset query model.
- **UX:** Option **C (investigation explorer)** on an infinite-scroll cursor mechanic, mobile-first.
- **Query:** keyset pagination over `(date desc, id desc)`, visible-account-id resolution + `financialAccountId IN (...)`, filters mapped to existing indexes (+ one composite for the keyset), text search deferred behind a trigram index.
- **TimelineLens:** **separate adapter, not canonical Perspective time** — optionally share only the future presentation shell.
- **Detail:** already the right thing (URL-driven drawer, fetch-by-id) — keep it; wire the built-but-unsurfaced `/correct`, and the AI slot later.
- **Scale:** Postgres + keyset + existing indexes carries 10k users; the danger is unbounded per-request scans, not table size. Don't over-engineer (no cache/search cluster/replicas/MVs yet).

**No implementation. Investigation complete.**
