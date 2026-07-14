# Fourth Meridian — Transactions Tab Redesign: Phase 1 Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion`
**Scope:** Phase 1 only, per `FOURTH_MERIDIAN_TRANSACTIONS_TAB_REDESIGN_INVESTIGATION_2026-07-12.md` §8 — Flow Type filter, Group By, Perspective toggle, Merchant filter, Source filter, Needs-review filter, transfer-disposition filter/badge (list level), an expanded summary bar showing Transfer/Debt payment/Investment/Refund alongside today's Spend/In (added 2026-07-12 — see §2.3.1), a calendar heat-map Group By/Perspective mode (added 2026-07-12, post-initial-scope — see §2.4), and rendering the already-computed `transferCandidate` in the detail drawer. **No schema migration, no new batched-query design.** List-level duplicate flag (needs a new batched `RelationshipResolver.resolveDuplicate()` variant), Explain-extended, Coverage, and Compare are explicitly out of scope — each deferred to Phase 2/3 for a distinct, already-documented reason.

---

## 1. Repository findings (see the investigation doc for full citations — summarized here)

- **Current component:** `components/dashboard/widgets/SpaceTransactionsPanel.tsx` (449 lines) — real search/category/account/date-range/pending filters already; uses `isCostFlow`/`isRefund`/`isIncome` (`lib/transactions/flow-predicates.ts`) internally for summary totals only, never as a user-facing filter axis.
- **List source:** `getTransactions()` (`lib/data/transactions.ts:109–148`) — already computes `needsClassification` and `transferDisposition` for **every row in the list**, batched, via `contextFields()`/`deriveTransactionContext()` (CF-1) and a single `resolveOwnedTransferCounterparties(rows, {spaceId})` call — not per-row, not N+1. This data is already flowing into `SpaceTransactionsPanel.tsx`'s `transactions` prop today; the gap is UI-only for these two fields.
- **`FlowType`** already on every row (`Transaction.flowType`), membership predicates already centralized in `lib/transactions/flow-predicates.ts` — no new logic, only a new label map and a filter control.
- **`provenance.source`** is not yet on the list `Transaction` type — it's computed in `getTransactionDetail()` from flat columns (`importBatchId`/`plaidTransactionId`/`externalTransactionId`) already present on the base row. Needs the same pure derivation added to `getTransactions()`'s row mapping — no new query, no new column.
- **`transferCandidate`** (drawer-level transfer pairing) is real, resolved, KD-15-gated, computed in `getTransactionDetail()` (`lib/data/transactions.ts:430`+) — but `lib/transactions/detail-sections.ts`'s `relationshipIntelligence()` (`:115–136`) has a stale comment ("reserved-null and never rendered") and doesn't render it. Small, isolated fix.
- **Merchant filter:** `merchantId`/`merchantDisplayName` already on `Transaction` — a distinct-values reduce over the already-fetched list, no new query.

---

## 2. Exact implementation design

### 2.1 `lib/data/transactions.ts` — add `source` to the list row (the one real data change)

In `getTransactions()`'s row mapping (`:141–147`), add a pure `deriveSource()` call reusing the exact same logic `getTransactionDetail()`'s `provenance` building already uses (do not reimplement — extract the existing derivation into a shared pure function if it's currently inlined, and call it from both places). Output: `source: "plaid" | "import" | "manual"` per row. No new query — `importBatchId`/`plaidTransactionId`/`externalTransactionId` are already selected as part of the base row.

### 2.2 `lib/transactions/flow-predicates.ts` — add a label map only

New export: `FLOW_TYPE_LABEL: Record<string, string>` (e.g. `SPENDING: "Spending"`, `DEBT_PAYMENT: "Debt payment"`) — humanized labels for the filter UI. Pure, additive, does not touch any existing predicate or set.

### 2.3 `components/dashboard/widgets/SpaceTransactionsPanel.tsx` — filters, Group By, Perspective toggle

- **Flow Type filter:** new `SegmentedControl`/dropdown alongside the existing category filter, backed by `FLOW_TYPE_LABEL` + the row's `flowType`. No new predicate logic — direct equality filter, same shape as the existing category filter.
- **Source filter:** `All / Plaid / Import / Manual`, backed by the new `source` field from §2.1.
- **Needs-review filter:** a boolean toggle ("Show only transactions needing review"), backed by the already-present `needsClassification` field — reuse the exact TE-2B boolean, do not invent new copy or a new tier system (per the investigation's explicit finding that a raw confidence badge would regress this app's honesty doctrine).
- **Transfer disposition filter/badge:** surface `transferDisposition` (already present per row) as a filter option and/or a small row badge — exact copy should reuse whatever human-readable labels `deriveTransferDisposition`'s output already implies; do not invent new terminology for an existing canonical concept.
- **Merchant filter:** typeahead/dropdown over distinct `merchantDisplayName` values present in the currently-fetched list (client-side; no new query).
- **Group By:** new view-mode control — `List / By Flow Type / By Merchant / By Account / By Category` — a pure client-side `reduce` over the already-fetched, already-filtered list. No new fetch per mode switch.
- **Perspective toggle:** if Group By subsumes this (grouped view IS the "perspective"), do not build a second, redundant control — confirm during implementation whether "Perspective toggle" and "Group By" collapse into one control (recommended) or are genuinely distinct in the final UI; do not ship two controls that do the same thing.

### 2.3.1 Summary bar — expand beyond Spend/In (added 2026-07-12)

Today's summary row (`SpaceTransactionsPanel.tsx`) shows exactly two figures — "Spend" (the `isCostFlow` sum) and "In" (the `isIncome` sum) — collapsing the ledger's full `FlowType` ontology into two buckets. Since `flow-predicates.ts` already exposes a predicate per flow kind (`isTransfer`, `isDebtPayment`, `isInvestmentFlow`, `isRefund`, plus `isCostFlow`/`isIncome`), this is a pure extension of the exact aggregation already running — no new data, no new predicate logic.

- Add summary chips for the remaining flow kinds present in the currently-filtered list: **Transfer**, **Debt payment**, **Investment**, **Refund** (already netted into Spend today per `isSpendLedgerFlow` — decide during S1 whether Refund gets its own chip in addition to, or instead of, netting into Spend; do not silently double-count it in both places). **Fee**/**Interest** are members of `COST_FLOWS` (already inside "Spend") — leave them folded in unless a chip is specifically requested; do not fragment "Spend" without a reason.
- **Zero-count discipline applies here too:** only render a chip for a flow kind actually present in the current filtered list (a Space with no transfers this period shows no Transfer chip) — never a chip reading "$0.00" for a kind that doesn't occur, matching the same zero-count-clause doctrine used everywhere else in this codebase.
- **Share one aggregation, don't duplicate it.** The summary bar's per-flow-kind sums and the Group By "By Flow Type" bucket sums (§2.3) are the same computation at different granularities (totals vs. per-bucket lists) — implement one pure `sumByFlowType()`-style function and have both the summary bar and Group By consume it, rather than writing the reduce twice.
- Filtering by Flow Type (§2.3's Flow Type filter) should update the summary bar's figures to match the filtered set, same as Spend/In already do today — not a separate, unfiltered "grand total" row.

### 2.4 Calendar heat-map — a new Group By/Perspective mode (added 2026-07-12; corrected 2026-07-12 after reviewing the actual reference component)

**Correction to this section's original scoping:** the user's actual reference is `components/space/widgets/CashFlowCalendar.tsx` — the Cash Flow Perspective's real, shipped month-grid heat map (day cells tinted by magnitude, hover/focus tooltip with a per-measure breakdown + net, "full" size for one month / "mini" grid for a quarter or year, click-a-day → open that day's transactions). The Transactions calendar should look and behave like that component, not like a generic from-scratch grid.

**Do not import `CashFlowCalendar` directly into Transactions.** Verified: it is wired specifically to the liquidity/economic axis — `CALENDAR_MEASURES` (`lib/transactions/cash-flow-projection.ts`) is keyed to liquidity concepts (`cashIn`/`cashOut`/`fromInvestments`/`debtPayments`/etc.), and its daily projection runs through `tierResolver`'s liquid/illiquid account classification (`lib/transactions/liquidity.ts`). Importing it as-is would silently filter/reclassify Transactions rows by Cash Flow's liquidity semantics — wrong for a tab whose entire premise is showing every transaction regardless of account tier.

**Correct reuse shape — extract the presentation, not the domain logic:**
1. Extract the metric-agnostic pieces of `CashFlowCalendar.tsx` — `DayCell`, `MonthGrid`, `tooltipPlacement`, the `cellBg`/`cellText` tint helpers, the `size: "full" | "mini"` responsive layout — into a shared, presentation-only component, e.g. `components/space/widgets/shared/CalendarHeatmapGrid.tsx`. It should take a caller-supplied `Map<string, number>` (iso date → magnitude), a value formatter, and an `onSelectDay` callback — no liquidity/measures concepts inside it at all.
2. Refactor `CashFlowCalendar.tsx` to consume the extracted primitive, passing its existing `CALENDAR_MEASURES`-derived net as the value map. This step touches a shipped, tested, real feature — treat it with real care: it must be **behavior-neutral** (identical visual output, Cash Flow's existing tests still passing unchanged). If a clean, behavior-neutral extraction isn't straightforward, stop and duplicate the presentational logic into the new component instead of forcing a risky shared refactor of a feature outside this slice's nominal scope.
3. Build the Transactions calendar (`TransactionsCalendarHeatmap.tsx`, per §3's file list) as a second, independent consumer of the same shared primitive, bucketing by day over the already-fetched, already-filtered transaction list (reuse `isCostFlow` from `flow-predicates.ts` for a spend-per-day metric — the same authority the panel's summary chips already use, not a new spend definition; confirm with the user whether spend-only or net-including-income is the right metric before building both, since "cash flow calendar" nets both directions and "transactions calendar" plausibly should too).
4. **Verified before scoping this in:** `getTransactions()` has no server-side row cap or date restriction — the full Space transaction history is already fetched into `SpaceTransactionsPanel.tsx`'s `transactions` prop today, and the existing 7d/30d/90d/all date-range filter (`cutoffForRange()`, `:60–65`) is applied client-side. So the calendar view itself is zero new fetch, zero new backend — same complexity class as Group By, just a grid renderer instead of a bucket-list renderer.
- **Honesty requirement (matches this app's zero-count-clause doctrine elsewhere, and matches `CashFlowCalendar`'s own no-activity treatment):** a day with zero transactions must render as a visually neutral/empty cell — never a colored "zero" that could be misread as a data point. A day outside the currently-loaded history's range (e.g. before the account's earliest transaction) must render as *unavailable*, not as zero — these are different facts and must look different.
- **Month navigation** operates entirely over the already-fetched list (prev/next just moves the bucketing window) — it must NOT trigger a new fetch; if a user navigates to a month outside the currently-loaded range under the active date-range filter (e.g. they have "30 Days" selected and click back), either widen the fetch scope for calendar mode specifically or disable navigation past the loaded range — pick one deliberately during implementation rather than silently rendering an empty grid that looks like "no spending" when it's actually "no data loaded."
- **View switcher:** ship this as `Table / Calendar`, a small control alongside (or subsuming) the Group By control from §2.3 — resolve during implementation whether Calendar is itself a Group By option (`List / By Flow Type / By Merchant / By Account / By Category / Calendar`) or a separate top-level switcher; do not ship two controls that both toggle between "list-like" and "calendar-like" views.

### 2.5 `lib/transactions/detail-sections.ts` — render `transferCandidate`

Add a `transferCandidate` branch inside `relationshipIntelligence()` (`:115–136`), following the exact hedge-language discipline already used for `duplicate` ("appears to match," never an unqualified claim). Update the stale header comment (`:13`) — it currently claims both `refundCandidate` and `transferCandidate` are reserved-null; only `refundCandidate` still is. Do not touch `refundCandidate` — it remains correctly reserved-null.

---

## 3. Files

**Modify:**
- `lib/data/transactions.ts` — add `source` derivation to `getTransactions()`'s row mapping (§2.1).
- `lib/transactions/flow-predicates.ts` — add `FLOW_TYPE_LABEL` export (§2.2).
- `components/dashboard/widgets/SpaceTransactionsPanel.tsx` — new filters, Group By, Perspective toggle (§2.3).
- `lib/transactions/detail-sections.ts` — render `transferCandidate`, fix stale comment (§2.4).
- `types/index.ts` — add `source` to the base `Transaction` type if not already present on it (verify before assuming; it may already be typed loosely enough).

**Add:**
- `lib/transactions/flow-predicates.test.ts` extension, or a new colocated test file, covering `FLOW_TYPE_LABEL` completeness (every `FlowType` enum value has a label — a source-scan test, same house convention used throughout).
- Extend `lib/transactions/detail-sections.test.ts` with a `transferCandidate`-rendering case.
- `components/space/widgets/shared/CalendarHeatmapGrid.tsx` (new — §2.4, extracted presentational primitive from `CashFlowCalendar.tsx`).
- `components/space/widgets/shared/CalendarHeatmapGrid.test.ts` (new — colocated fixture test; day-cell tinting, tooltip placement, full/mini sizing, all metric-agnostic).
- `components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.tsx` (new — §2.4, consumes the shared primitive with a Transactions-specific day-bucketing).
- `components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.test.ts` (new — colocated fixture test per house convention).

**Modify (added by §2.4's extraction step):**
- `components/space/widgets/CashFlowCalendar.tsx` — refactored to consume the new shared `CalendarHeatmapGrid` primitive instead of its inline `DayCell`/`MonthGrid`. Must remain behavior-neutral — Cash Flow's existing tests pass unchanged, no visual or functional difference for that feature.

**Explicitly untouched:** `RelationshipResolver.ts` (consumed, not modified — no batching work in this slice), `lib/transactions/transaction-context.ts` (consumed, not modified — `transferDisposition`/`needsClassification` derivation is correct as-is), `refundCandidate` handling (stays reserved-null), `prisma/schema.prisma` (no migration), `TransactionDetailContent.tsx` (renders whatever `detail-sections.ts` returns — no changes needed there), `lib/transactions/cash-flow-projection.ts` and `lib/transactions/liquidity.ts` (Cash Flow's domain logic — consumed only by `CashFlowCalendar.tsx` itself, never by the new Transactions component).

---

## 4. Slice plan

- **S1 — Flow Type filter + label map + summary bar expansion.** `FLOW_TYPE_LABEL`, the filter control, wired to the existing `flowType` field, plus the shared `sumByFlowType()`-style aggregation (§2.3.1) powering new summary chips (Transfer/Debt payment/Investment/Refund — zero-count-clause discipline applies) alongside the existing Spend/In. Zero new data.
- **S2 — Needs-review filter + transfer-disposition filter/badge.** Both already-computed fields, UI-only.
- **S3 — Source: derive + filter.** The one real data-layer change (§2.1) — add `source` to `getTransactions()`, then the filter control.
- **S4 — Merchant filter + Group By + Perspective-toggle resolution.** Confirm Group By vs. Perspective toggle collapse into one control before building both.
- **S5 — Calendar heat-map.** (a) Extract `CalendarHeatmapGrid.tsx` from `CashFlowCalendar.tsx`, refactor Cash Flow to consume it, confirm behavior-neutral (Cash Flow's tests pass unchanged, manual visual check). (b) Build `TransactionsCalendarHeatmap.tsx` as a second consumer. (c) Wire the Table/Calendar switcher per §2.4. Zero-count-vs-unavailable cell distinction, month-navigation-vs-loaded-range decision made deliberately (not defaulted). If (a) can't be done cleanly, stop and duplicate the presentational logic instead — do not force a risky shared refactor under Phase 1 time pressure.
- **S6 — `transferCandidate` in the drawer + stale-comment fix.** Isolated, single-file, `detail-sections.ts` only.
- **S7 — Tests + polish + STATUS.md.**

Each independently shippable; S1 alone is already a real, visible improvement.

---

## 5. Risks

- **Reinventing Confidence as a raw tier badge.** The investigation is explicit: this app's doctrine is a single honest boolean with plain-English disclosure, not a four-tier badge. If implementation drifts toward exposing `classificationConfidence` numbers or `classificationReason` codes directly, stop — that's the exact thing TE-2B was written to prevent.
- **Building a second batched-duplicate-query mechanism under Phase 1 time pressure.** Duplicate detection is deliberately deferred to Phase 2 (needs its own batched-resolver design, see investigation §4) — do not rush a naive per-row loop into the list view to "complete" this filter set; that reintroduces the N+1 problem the investigation flagged.
- **Group By and Perspective toggle shipping as two redundant controls.** Confirm during S4 whether they're actually the same concept before building both.
- **`source` derivation drifting from the drawer's existing logic.** Must reuse (or extract into a shared pure function) the exact same precedence `getTransactionDetail()`'s provenance section already uses — a second, slightly different definition of "source" between list and drawer would be a real, confusing inconsistency.
- **Calendar heat-map rendering a colored "zero" for empty days, or an empty grid for unloaded-range days.** These are two different facts (nothing spent vs. no data here) and must look visually distinct — conflating them is the same honesty failure this app's zero-count-clause and `estimated`/`unknown` tiering discipline exists to prevent elsewhere. Do not default this without a deliberate design pass.
- **Calendar month navigation silently triggering a fetch, or silently doing nothing, past the active date-range filter's loaded window.** Pick one behavior deliberately (widen the fetch, or disable navigation past the loaded range) rather than letting it fall out of whatever's easiest to implement.

## 6. Overengineering check

Confirmed feasible as: one new pure derivation (`source`) + one new label map + UI wiring over fields that are, for `needsClassification`/`transferDisposition`, already computed and already flowing through the component today. Rejected: a new confidence-tier system, a batched duplicate resolver (Phase 2), Explain-extended (Phase 2), Coverage (Phase 2), Compare (Phase 3), Natural Language Search / Saved Views (not scoped, per investigation §6).

## 7. Testing expectations

`flow-predicates.test.ts`: `FLOW_TYPE_LABEL` has an entry for every `FlowType` enum value (source-scan/fixture test, house convention). `detail-sections.test.ts`: `transferCandidate` renders with correctly hedged language when present, `refundCandidate` still never renders. `SpaceTransactionsPanel` (colocated fixture test per house convention): each new filter narrows the list correctly against fixture rows; Group By produces correct bucket counts; Needs-review filter matches the existing `needsClassification` field exactly (no drift from the drawer's TE-2B logic). `TransactionsCalendarHeatmap.test.ts`: day-bucketing sums match `isCostFlow` totals against fixture rows; a day with zero transactions renders the empty state, never a colored zero; a day outside the loaded range renders the unavailable state, distinct from empty; month navigation produces the correct bucket set for fixture data spanning multiple months. Summary bar (§2.3.1): each flow-kind chip's total matches the corresponding `flow-predicates.ts` predicate's sum against fixture rows; a flow kind absent from the filtered set renders no chip (never a $0.00 chip); chip totals update when the Flow Type filter narrows the list; the summary bar and "By Flow Type" Group By mode produce identical per-kind totals from the same shared aggregation function (a fixture test asserting they never drift apart).

## 8. Validation gate

```bash
npx tsc --noEmit
npx eslint
npm test
git diff --name-only   # must match §3 exactly
npm run dev             # manual pass: Flow Type/Source/Needs-review/transfer-disposition
                         # filters each narrow the list correctly; Group By renders correct
                         # buckets; Merchant filter matches distinct merchants in view;
                         # detail drawer now shows transfer-pair notes when a transferCandidate
                         # resolves; duplicate notes still render exactly as before (untouched);
                         # refundCandidate still never renders anywhere
```

## 9. Stop conditions

1. Any UI surfaces raw `classificationConfidence` numbers, `classificationReason` codes, or provider strings — that's the exact TE-2B violation this plan must not reintroduce.
2. Implementation drifts toward a batched duplicate-detection query — that's Phase 2, scoped separately once designed properly.
3. `source` derivation is reimplemented differently from the drawer's existing provenance logic instead of reused/shared.
4. Group By and Perspective toggle end up as two separate controls doing the same thing — resolve which one ships before building both.
5. Any work drifts toward Explain-extended, Coverage, Compare, Natural Language Search, Saved Views, refundCandidate resolution, or recurring/subscription detection — all explicitly out of scope for Phase 1 (investigation §5–7).
6. The calendar heat-map renders a day with zero transactions and a day outside the loaded range identically — resolve the visual distinction before shipping S5.
7. A summary chip renders for a flow kind that doesn't occur in the current filtered list (a fabricated "$0.00" chip) — never render an absent kind, per zero-count-clause discipline.
8. The summary bar's per-flow-kind sums and the "By Flow Type" Group By bucket sums are implemented as two separate reduces instead of one shared aggregation function — they must not be able to drift apart.
9. `CashFlowCalendar.tsx` is imported directly into Transactions (inheriting liquidity-axis filtering it shouldn't have), or its extraction into `CalendarHeatmapGrid.tsx` changes Cash Flow's existing visual behavior even slightly — either one means stop and reassess before continuing S5.
