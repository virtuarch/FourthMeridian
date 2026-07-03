# KD-7 — 5,000-Row Transaction Fetch Cap / Monthly Rollup Correctness

**Status:** Investigation only. No code changes. No files edited. STATUS.md untouched. KD-4 files untouched.
**Branch:** `feature/phase-2-architecture` (baseline `v2.4.0-8-g59c181b`)
**Date:** 2026-07-02

---

## 1. Executive Summary

`TRANSACTION_FETCH_LIMIT = 5000` in `lib/ai/assemblers/transactions.ts` is a hard `take:` cap
applied to **two** AI read paths (the transactions summary query and the drilldown query), both
ordered `date: 'desc'` (newest first). When a Space has more than 5,000 banking transactions in the
requested window, the query silently drops the **oldest** rows. Every downstream figure in the
`transactions_summary` domain is aggregated **in JavaScript over the returned rows**, so truncation
silently deflates them — and nothing in the code detects that truncation occurred.

The corruption is genuinely silent because the only "incompleteness" signal that exists today —
`MonthlyBreakdownEntry.partial` — reflects **calendar window clipping**, not fetch truncation. A month
whose rows were dropped by the 5,000 cap is emitted as a *complete, non-partial* month with an
artificially low total. Meanwhile the system prompt tells the model these are *"the ONLY valid
month-by-month figures"* summed *"directly from that month's transactions"* and that category totals
are the *"exact sum."* The model therefore reports truncated numbers with full confidence.

**Scope: AI context only.** The three UI/dashboard read paths (`lib/data/transactions.ts`,
`app/api/accounts/[id]/transactions/route.ts`) have **no `take:` cap** — they are unbounded and
unaffected. This is not a data-integrity bug in stored transactions; it is an aggregation-coverage
bug in the AI assembler.

**Reachability.** The default full window is 90 days (≈55 txns/day to hit the cap — plausible for a
multi-account or shared Space). The far more exposed case is the explicit D6 window, which the router
allows up to ~26 months (`MAX_EXPLICIT_WINDOW_DAYS = 800`): 5,000 rows over 800 days is only ≈6/day.
Long-window, month-by-month questions ("break down the last two years by month") are simultaneously
the **most likely to hit the cap** and the **most damaged by it** (oldest months silently hollowed
out). That is the worst-case intersection.

**Recommended smallest safe fix (detail in §7):** make truncation *detectable and honest* without
rewriting the aggregation engine — fetch `LIMIT + 1` as a deterministic sentinel, carry a `truncated`
+ `coverageStartDate` flag through `TransactionsSummaryData`, mark months at/older than the true
coverage floor as unreliable so trends exclude them, and make the prompt drop its "exact / only valid"
language when truncated. Full SQL-side aggregation is the correct long-term fix but is **not** the
smallest safe fix and is out of scope for this ticket.

---

## 2. Impact Map

| Consumer | File | Reads | Corrupted by truncation? |
|---|---|---|---|
| Summary aggregation (income/expense/net, byCategory) | `lib/ai/assemblers/transactions.ts` L254–331 | capped rows | **Yes** — undercounts; older-month-weighted categories worst |
| `monthlyBreakdown` | same, L333–339 + `buildMonthlyBreakdown` L624–721 | capped rows | **Yes** — oldest months hollowed; **not** flagged `partial` |
| Merchant rollup | same, L392–477 | capped rows | **Yes** — merchants active in dropped months undercounted/missing |
| Income-source rollup | same, L479–533 | capped rows | **Yes** — same as merchants for inflows |
| Recurring candidates | same, L349–390 | capped rows | **Yes** — occurrence counts undercount |
| `largestIncome` / `largestExpense` | same, L261–298 | capped rows | Partial — only if the extreme sits in a dropped month |
| `transactionCount` | same, L549 (`rows.length`) | capped rows | **Yes** — silently pins at exactly 5000 (this is the tell) |
| Drilldown `matchedTotal` / `totalCount` / `truncated` | same, L830–906 | capped rows | **Yes** — `truncated` flag only catches the 25-row *display* cap, **not** the 5000 *fetch* cap |
| Avg monthly spending (`cat.total / windowDays * 30`) | `app/api/ai/chat/route.ts` L474–479 | capped byCategory | **Yes** — numerator deflated, denominator (full windowDays) unchanged → understated |
| Spending trends (MoM, 3-mo rolling) | `lib/ai/intelligence/annotations.ts` `computeSpendingTrends` L928–955 | `monthlyBreakdown` | **Yes** — deltas/averages computed against corrupted old-month totals |
| Prompt "authoritative / exact / only valid" claims | `app/api/ai/chat/route.ts` L458–492 | above | **Amplifies** — asserts exactness over possibly-truncated data |
| Daily Brief savings-rate copy | `app/api/brief/route.ts` L393 | summary totals | **Yes** if brief window (30d) truncates (less likely, but possible) |
| **UI dashboard transaction lists** | `lib/data/transactions.ts`, `app/api/accounts/[id]/transactions/route.ts` | **uncapped** | **No** — no `take:`; unaffected |

---

## 3. Current Read Paths (ground truth)

**Capped (AI, the subject of KD-7):**

1. **Summary query** — `lib/ai/assemblers/transactions.ts` L207–240
   - `where`: dual-path OR (legacy `account.spaceId` ∪ `financialAccount` via ACTIVE `SpaceAccountLink`
     with `visibilityLevel ∈ TRANSACTION_DETAIL_VISIBILITY`), `deletedAt: null`,
     `category ∈ BANKING_CATEGORIES`, `date` floor `gte win.start` (+ `lte win.end` for explicit windows).
   - `orderBy: { date: 'desc' }`, `take: TRANSACTION_FETCH_LIMIT` (5000).
   - All aggregation is JS over `rows`.

2. **Drilldown query** — `lib/ai/assemblers/transactions.ts` L830–865
   - Same visibility OR-scoping, `pending: false`, explicit `[start,lte end]`, category/sign/merchant filters.
   - `orderBy: { date: 'desc' }`, `take: TRANSACTION_FETCH_LIMIT` (5000).
   - `matchedTotal`/`totalCount` are computed from these (already-capped) rows; `truncated` (L905)
     compares `totalCount` vs the ≤25 display slice — it **cannot** see the 5000 cap.

**Window logic** — `resolveWindow` L748–769: default rolling floor 30d (brief) / 90d (full), floor only;
explicit D6 `[startDate,endDate]` inclusive, floor clamped to `MAX_EXPLICIT_WINDOW_DAYS = 800`.

**Callers:** `app/api/ai/chat/route.ts` (`scopeHint:'full'`, optional `transactionWindow` from the intent
classifier, up to ~26 months) and `app/api/brief/route.ts` (`scopeHint:'brief'`, 30d).

**Uncapped (UI, out of scope, confirms AI-only):**
`lib/data/transactions.ts` `getTransactions` / `getDebtTransactions` / `getInvestmentTransactions`
(L57, L93, L124) and `app/api/accounts/[id]/transactions/route.ts` L52 — none carry a `take:`.

---

## 4. Truncation Scenarios

- **Silent monthly corruption (primary).** Dense Space, `date desc` cap drops the oldest rows. The
  affected old months are emitted as complete (`partial` stays false because the calendar window still
  covers them) with deflated income/expense/category totals. `computeSpendingTrends` then treats them as
  valid history → wrong MoM deltas, wrong 3-month rolling averages, wrong trend direction.
- **Deflated averages.** `cat.total / windowDays * 30` (chat L477): the numerator is truncated but
  `windowDays` still reflects the full requested span → systematically understated "per month" figures.
- **Category/merchant/income skew.** A category or merchant concentrated in the dropped oldest months
  is undercounted or vanishes from the top-N rollups, changing "top spending categories/merchants."
- **Drilldown under-reports.** `matchedTotal`/`totalCount` cap at 5000; the `truncated` flag stays
  driven only by the 25-row display slice, so an under-count reads as an exact "total."
- **Long-window worst case.** Explicit 12–26 month "by month" requests are both the most cap-prone and
  the most damaged, and are exactly where the prompt most strongly asserts per-month authority.
- **`transactionCount` boundary tell.** On truncation `rows.length` is exactly 5000 — a deterministic
  signal that is currently computed and surfaced but never acted upon.

---

## 5. SQL Aggregation vs. Row-Fetch Aggregation

Row-fetch aggregation is only correct while the row set is complete; the 5000 cap breaks that
precondition. **SQL-side aggregation (`GROUP BY … SUM/COUNT`) is structurally safer** because it sums
over *all* matching rows in the database regardless of cardinality — there is no row cap to hit for the
aggregate figures (monthly totals, category totals, cash-flow totals).

Caveats that make full SQL migration a larger effort (not the smallest safe fix):
- **Monthly grouping** needs `date_trunc('month', date)`, which Prisma `groupBy` cannot express — it
  requires `$queryRaw`, giving up some type-safety and the shared dual-path `where` builder.
- **Merchant/income rollups** group by `normalizeMerchant()` (JS canonicalization in
  `lib/transactions/merchant.ts`); that logic is not reproducible in SQL without porting it, so those
  rollups can't be fully pushed down without duplicating the normalizer.
- **`largestIncome`/`largestExpense`, recurring candidates, drilldown line items** legitimately need
  rows, not just aggregates.

**Conclusion:** SQL aggregation is the right *eventual* architecture for the pure-aggregate figures
(monthly, category, cash-flow) and should be filed as a follow-up. For KD-7 the smallest safe fix is
**detect + flag + be honest**, not a rewrite.

---

## 6. Deterministic Truncation Detection & Payload Flags

**Detection (cheapest deterministic option):** query `take: TRANSACTION_FETCH_LIMIT + 1`. If
`rows.length > TRANSACTION_FETCH_LIMIT`, truncation occurred; slice back to `LIMIT` before aggregating.
This is exact (no false positives at exactly-5000, unlike an `=== 5000` heuristic) and costs one extra
row. Alternative: a parallel `db.transaction.count(where)` — exact but a second round-trip; the
`LIMIT + 1` sentinel is preferred.

**True coverage floor:** after truncation the oldest *returned* row (`rows[rows.length-1].date`) is the
real coverage floor. Everything at/older than that boundary month is unreliable.

**New payload fields on `TransactionsSummaryData` (additive):**
- `truncated: boolean` — cap was hit.
- `coverageStartDate: string` — oldest date actually aggregated (== requested `startDate` when not truncated).
- `fetchLimit: number` — the cap in force (for provenance).

**Monthly breakdown:** flag the boundary/older month(s) — reuse `partial: true` **or** add a distinct
`truncated?: true` on `MonthlyBreakdownEntry` so `computeSpendingTrends` excludes them (it already drops
`partial`). A distinct flag is cleaner than overloading `partial` (which means "calendar-clipped").

**Prompt caveats (`app/api/ai/chat/route.ts`):** when `truncated`, replace the "exact sum / ONLY valid
month-by-month / this is the ONLY period" language with an explicit coverage caveat — e.g. "Older
transactions beyond {coverageStartDate} were not included (fetch cap {fetchLimit}); figures before that
date are incomplete — do not present them as exact or compare them month-over-month."

**Drilldown:** apply the same `LIMIT + 1` sentinel so `matchedTotal`/`totalCount` are marked
approximate when the fetch cap (not just the 25-row display cap) is hit.

---

## 7. Recommended Smallest Safe Fix

Additive, no schema change, no removals (consistent with "additive before subtractive" and "do not
implement multiple decisions in one branch"):

1. **Detect** — summary query: `take: LIMIT + 1`; set `truncated = rows.length > LIMIT`; slice to `LIMIT`.
2. **Compute coverage** — `coverageStartDate = truncated ? oldestReturnedRow.date : win.startIso`.
3. **Propagate** — add `truncated`, `coverageStartDate`, `fetchLimit` to `TransactionsSummaryData`
   (and types.ts contract docs).
4. **Protect trends** — mark boundary/older months in `monthlyBreakdown` (new `truncated?` flag);
   ensure `computeSpendingTrends` excludes them alongside `partial`.
5. **Honest prompt** — gate the "exact / only valid / only period" assertions on `!truncated`; emit a
   coverage caveat when truncated.
6. **Drilldown parity** — `LIMIT + 1` sentinel; reflect fetch-cap truncation in `matchedTotal`/`totalCount`/`truncated`.

Explicitly **not** in the smallest safe fix: raising the cap (masks, doesn't fix), removing the cap
(reintroduces the unbounded-query risk the cap exists to prevent), or the full SQL-aggregation rewrite
(separate follow-up).

---

## 8. Exact Implementation Checklist (for approval — do NOT implement yet)

**A. Contract / types** — `lib/ai/types.ts`
- [ ] Add `truncated: boolean`, `coverageStartDate: string`, `fetchLimit: number` to `TransactionsSummaryData` with doc comments.
- [ ] Add optional `truncated?: boolean` to `MonthlyBreakdownEntry`; document it as fetch-cap coverage (distinct from calendar `partial`).

**B. Summary assembler** — `lib/ai/assemblers/transactions.ts`
- [ ] Change main query `take:` to `TRANSACTION_FETCH_LIMIT + 1`.
- [ ] Compute `truncated`; slice rows back to `TRANSACTION_FETCH_LIMIT` before any aggregation.
- [ ] Derive `coverageStartDate` from the oldest retained row when truncated, else `win.startIso`.
- [ ] Pass `truncated` + `coverageStartDate` into `buildMonthlyBreakdown`; flag the coverage-boundary month(s) `truncated: true`.
- [ ] Populate the three new fields in the returned `data`.

**C. Drilldown** — `lib/ai/assemblers/transactions.ts`
- [ ] `take: TRANSACTION_FETCH_LIMIT + 1`; detect fetch-cap truncation separately from the display-limit truncation and reflect it in `truncated` / `matchedTotal` / `totalCount` semantics.

**D. Trends** — `lib/ai/intelligence/annotations.ts`
- [ ] In `computeSpendingTrends`, exclude `truncated` months from complete-month analysis (mirror the `partial` handling); surface excluded months for reporting.

**E. Prompt** — `app/api/ai/chat/route.ts`
- [ ] Gate the "exact sum" / "ONLY valid month-by-month" / "ONLY period" lines on `!txn.truncated`.
- [ ] When truncated, emit a coverage caveat citing `coverageStartDate` and `fetchLimit`.
- [ ] Re-check the `cat.total / windowDays * 30` average copy so it isn't presented as exact under truncation.

**F. Brief (if in scope)** — `app/api/brief/route.ts`
- [ ] Confirm the savings-rate line degrades gracefully (or is suppressed) when the brief window is truncated.

**G. Tests**
- [ ] Unit: seed > 5000 in-window rows → assert `truncated === true`, `coverageStartDate` == oldest retained date, boundary month flagged.
- [ ] Unit: ≤ 5000 rows → `truncated === false`, `coverageStartDate === startDate`, no month flagged.
- [ ] `computeSpendingTrends` excludes truncated months.
- [ ] Prompt snapshot: caveat present iff truncated.

---

## 9. Validation Plan

- [ ] `npx prisma generate` (no schema change expected — confirm).
- [ ] `npx tsc --noEmit` — new fields typecheck across producers/consumers.
- [ ] `npm run lint`.
- [ ] Targeted unit tests in §8-G.
- [ ] Manual/route check: a >5000-row Space through `/api/ai/chat` shows the coverage caveat and no
      "exact/only valid" claims; a small Space is unchanged (`truncated:false`, identical output).
- [ ] Regression: confirm UI transaction lists (`lib/data/transactions.ts`, accounts route) are untouched.

---

## 10. Risks & Rollback

- **Risk — false "truncated" from an off-by-one.** Mitigation: `LIMIT + 1` sentinel is exact; unit-test the boundary at 4999/5000/5001.
- **Risk — trend regression.** Excluding truncated months could drop a trend from HIGH→MEDIUM/LOW confidence. This is *correct* (honest confidence), but flag in review.
- **Risk — prompt-token growth** from the caveat. Negligible; only emitted when truncated.
- **Risk — scope creep into SQL rewrite.** Explicitly deferred (§5).
- **Rollback:** the change is additive and flag-gated. Reverting the assembler + prompt commit restores
  prior behavior; the new optional fields are ignorable by consumers. No migration, so no data rollback needed.

---

## 11. Out of Scope

- Any KD-4 files / Phase 0/1 work (owned by Thread 1).
- `STATUS.md` edits.
- Raising or removing `TRANSACTION_FETCH_LIMIT`.
- Full SQL/`$queryRaw` aggregation rewrite (file as follow-up).
- UI/dashboard transaction pages (uncapped; unaffected).
- Any change to visibility/scoping (KD-1 / KD-15), category sets, or the merchant normalizer.
- Investment-transaction domain.
