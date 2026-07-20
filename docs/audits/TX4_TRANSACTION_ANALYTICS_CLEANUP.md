# TX-4 — Transaction Analytics Cleanup

**Type:** Investigation + cleanup. No new authority, no replacement analytics, no schema change, no index migration.
**Date:** 2026-07-20. **Recovery point for every deletion below: `cd28478`.**

---

## 1. Classification

| Item | Class | Action | Reason |
|---|---|---|---|
| `TransactionSummaryCards` | **A — dead** | **Deleted** | Zero consumers after TX-3.3 (not even a test). Its per-flow-type money cards duplicate what `CashFlowSummaryWidget` already owns. Moving it (B) would have created a *second* transaction-analytics surface — the one thing the mission forbids. |
| `TransactionsCalendarHeatmap` (+ its test) | **B — belongs to Cash Flow** | **Deleted; home determined** | See §2. |
| `getInvestmentTransactions()` | **A — dead** | **Deleted** | Zero consumers since P2-2 and, uniquely in that file, **unbounded** (no `take`, no window). TX-1 flagged it as the last unbounded loader; TX-2 and CLEAN-0 both deferred removal. Leaving a dead unbounded read in a module the explorer now depends on is a loaded gun. |
| `serializeInvestmentTransactionRow` | **C — preserve** | **Kept** | Pure, side-effect-free, frozen golden coverage, and explicitly owned by the concurrent investment truth-spine track (P2-5/P2-6), whose migration "will retire or re-express it". Deleting it would reach into another track's domain. |
| `GroupBy` / `GROUP_BY_LABELS` | **A — dead** | **Deleted** | Only the removed client pivot used them. |
| `TRANSFER_DISPOSITION_LABEL`, `SourceFilter`, `PendingFilter`, `BANKING_CATEGORIES` | — | Kept | All still consumed (row chips, filters, correction UI). |
| Stale comments | — | **Corrected** | See §4. |
| Transaction indexes | **C — preserve, add none** | **No migration** | See §5. |

---

## 2. Where the Calendar belongs

**Determination: Cash Flow activity visualization.** Not DayFacts (that is a projection/fold layer, not a view), and not the explorer.

The heat-map answers *"what did activity look like across this period?"* — a temporal money shape over a whole filtered set. That is a Cash Flow question in both data and doctrine: it needs per-day converted magnitudes, which requires the conversion and classification authority Cash Flow owns and Transactions must not.

It was **deleted rather than moved**, because moving it means wiring it into Cash Flow, and the mission is explicit: *do not create replacement analytics unless there is a clear consumer.* There is none today. It was pure presentation (`amountOf` and `fmt` were injected, so it owned no money doctrine), which makes it cheap to restore verbatim from `cd28478` when a Cash Flow activity surface is actually built. Leaving it parked under `components/dashboard/widgets/transactions/` would have left a misplaced analytics component in the Transactions namespace — precisely the "duplicate authority" the mission warns against.

---

## 3. Duplicate-authority check

After cleanup there is exactly one of each:

| Concern | Authority |
|---|---|
| Transaction population + KD-15 visibility | `bankingTransactionWhere` |
| Transaction row DTO | `projectTransactionListRows` / `transactionListInclude` |
| Transaction browsing (rows) | `queryTransactions` |
| Transaction answer size | `countTransactions` (count only) |
| Money analytics over transactions | **Cash Flow projection layer** — not Transactions |
| Transaction detail + correction | `getTransactionDetail` / `POST …/correct` |

No transaction analytics authority remains inside the Transactions surface.

---

## 4. Stale comments corrected

- `app/api/spaces/[id]/transactions/route.ts` still said *"server-side pagination is the TX-3 follow-up"*. TX-3 has landed. The comment now states what is actually true: this route is **no longer the browsing authority** — it is the **analytical feed** (Cash Flow, Liquidity, Overview doorway, workspace renderers), which folds the whole array and therefore keeps the TX-2 cap + truncation sentinel until its own projection migration. It explicitly warns against adding browsing features there.
- `lib/data/transactions.ts` carries a tombstone explaining why `getInvestmentTransactions` is gone and why its serializer is not.
- The deleted heat-map's header claimed *"getTransactions() has no row cap"* — false since TX-2. Removed with the file.

---

## 5. Index measurement — the deferred question, now answered

TX-3.0 deferred `[financialAccountId, date, id]` to "measure when a consumer lands". A consumer has landed, so it was measured. `EXPLAIN (ANALYZE, BUFFERS)` on the real dev DB (3,983 visible rows across 11 accounts, read-only):

| Query | Plan | Time |
|---|---|---|
| **A. Page 1 — relation-join visibility (what ships today)** | Nested Loop **materializes all 3,983 rows**, then top-N heapsort for 51 | **20.0 ms** (285 buffers) |
| **B. Page 1 — `financialAccountId IN (resolved visible)`** | `Index Scan Backward using Transaction_date_idx` + Incremental Sort, stops at 52 rows | **0.40 ms** (71 buffers) |
| C. Deep page (cursor ~3 yr back), IN-list form | Bitmap index scan | 0.14 ms |
| D. `count(*)` for the same question | Seq Scan | 1.2 ms |
| E. ILIKE text search | Seq Scan | 4.5 ms |

**Verdict on the index: add none.** No plan was index-starved; `Transaction_date_idx` already serves the ordered path. A composite would only remove the ~50 % row discard in plan B, which is already 0.4 ms. Adding it now would be the speculative guess TX-3.0 correctly refused. D and E confirm the `pg_trgm` deferral is still right at this scale.

**But the measurement surfaced something else, and it is the important finding.**

### 5.1 Finding — the shipped query is O(total rows) per page, not O(page)

Plan A materializes **every** matching row (3,983) on **every** page fetch, then discards all but 51. Keyset paging's central benefit — cost proportional to the page, not the corpus — is therefore **not currently being realized**. The `EXISTS`/join form of the KD-15 visibility predicate defeats index-ordered access.

**Magnitude, honestly stated:** at today's 3,983 rows this is 7–20 ms — completely fine. It is a *scaling characteristic*, not a present defect. But it grows linearly with the Space's transaction count and repeats on every "load more", so a 40 k-row Space would pay ~10× per page, on every scroll step.

### 5.2 Why it was NOT fixed in this slice

Adding the IN list *alongside* the existing relation predicate does **not** help — measured: **11.6 ms, still materializing all 3,983 rows** (worse than the 7.0 ms baseline, from evaluating both predicates). The join itself forces materialization.

Getting plan B therefore requires **replacing** the relation-join visibility with an application-resolved account-id list. That moves the KD-15 boundary out of SQL and into resolved application state — a **security-boundary relocation**, not an optimization. It would also break the population/privacy tripwires that deliberately assert `bankingTransactionWhere` is composed by every read.

The mission's rule is explicit: *stop and reassess if any step requires a new authority.* Re-siting the visibility authority qualifies. **Reported, not done.**

### 5.3 Recommended next slice (TX-5, if pursued)

Design question to settle first: *may KD-15 visibility be enforced by a resolved id-list instead of a SQL relation predicate?* If yes, the shape is already half-built — `resolveVisibleAccountIds` exists and is already used for the `accountIds` intersection. The work would be: resolve unconditionally, pass the id list as the sole account predicate, keep `bankingTransactionWhere`'s **non-visibility** parts (population, soft-delete), and re-point the privacy tripwires at the new enforcement site with equal or stronger assertions. Do not start it without that doctrinal answer.

---

## 6. Verification

- **tsc clean, eslint clean, 309/309 unit** (309 files after the two deletions removed one test file).
- Doctrine oracle, transaction population, privacy/KD-15, bounding, serialize.golden, coverage-note: all green.
- Cash Flow, Liquidity, Calendar consumers and TimelineLens: **untouched** — no file in this slice references them.

---

## 7. Remaining future slices

| Slice | Scope |
|---|---|
| **TX-5** (gated on doctrine) | The §5.3 visibility-shape question and, if approved, the O(page) query fix. |
| Cash Flow activity surface | Restore the heat-map from `cd28478` under Cash Flow ownership. |
| Intelligence projection | Persist `transferDisposition` + `needsClassification` at classification time; they then become ordinary indexed explorer filters ("Needs review" returns). |
| Merchant facet | A distinct-merchant endpoint to restore full merchant-filter parity (today: pivot-from-row only). |
| Amount range filter | The replacement for the removed amount sort. |
| Merchant identity correction UI | The endpoint's third path (candidate search + 409 confirm). |
| Analytics migration | Move Cash Flow / Liquidity / Overview off the shared bounded array onto their own aggregate authorities — the last consumer of the capped `/transactions` route. |
