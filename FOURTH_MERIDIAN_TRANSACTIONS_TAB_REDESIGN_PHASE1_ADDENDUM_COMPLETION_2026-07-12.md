# Fourth Meridian — Transactions Tab Redesign Phase 1 (Addendum): Completion Summary

**Date:** 2026-07-12
**Branch:** `feature/v2.5-spaces-completion`
**Plan of record:** `FOURTH_MERIDIAN_TRANSACTIONS_TAB_REDESIGN_IMPLEMENTATION_PLAN_2026-07-12.md`
**Predecessor:** `FOURTH_MERIDIAN_TRANSACTIONS_TAB_REDESIGN_PHASE1_COMPLETION_2026-07-12.md` (original S1–S6, commits `b27c418..b6a61c4`).

This addendum covers the two scopes added to the plan on 2026-07-12 *after* the
original Phase 1 shipped — **§2.3.1 (summary bar expansion)** and **§2.4
(calendar heat-map + Table/Calendar switcher)** — implemented as three small,
independently revertible commits on top of `b6a61c4`. The already-shipped Phase 1
work (Flow Type / Needs-review / transfer-disposition / Source / Merchant
filters, Group By, transferCandidate drawer note) was **not** touched.

---

## What shipped, per slice

- **N1 — Summary bar expansion (§2.3.1)** (`52c9d1d`)
  - `lib/transactions/flow-predicates.ts`: new pure `sumByFlowType(rows, amount)`
    + `UNCLASSIFIED_FLOW_KEY` sentinel — the SINGLE per-FlowType aggregation both
    the summary bar and the "By Flow Type" Group By bucket totals consume, so a
    per-kind total can never be computed two ways (§9.8).
  - `SpaceTransactionsPanel.tsx`: the summary strip gains **Transfers / Debt
    payments / Investments / Refunds** chips beside the existing Spend / In. Each
    renders only when that kind occurs in the filtered list (zero-count
    discipline, §9.7 — never a fabricated "$0.00"). Spend stays **net of
    refunds** and Refunds is disclosed as its own figure, so no dollar is
    double-counted. Group headers now show each bucket's total; the "By Flow
    Type" bucket total is read from the shared `sumByFlowType` map (not a second
    reduce). Existing Spend/In figures are byte-identical (recomposed from the
    same map).
  - `flow-predicates.test.ts`: `sumByFlowType` buckets correctly, sentinels null,
    and reproduces the pre-existing `isCostFlow`/`isRefund` Spend math.

- **N2a — Extract `CalendarHeatmapGrid` (§2.4 steps 1–2)** (`refactor` commit)
  - New `components/space/widgets/shared/CalendarHeatmapGrid.tsx` — the
    metric-agnostic month-grid heat map (DayCell, MonthGrid, `cellBg`/`cellText`
    tint, `tooltipPlacement`, full/mini sizing, legend) extracted from
    `CashFlowCalendar`. Contract: a caller-built `Map<iso, net>`, a formatter, an
    `onSelectDay` callback, and a per-day `tooltipRowsFor` builder — **no**
    liquidity / measures / FlowType concepts inside it.
  - `CashFlowCalendar.tsx` refactored to consume it, supplying its exact
    per-measure tooltip breakdown + Net row via `tooltipRowsFor`. **DOM-identical**
    to the prior inline grid (a mechanical move; the only new seam is the tooltip
    body arriving as a reproduced data array).
  - `CalendarHeatmapGrid.test.ts`: fixture tests for the pure tint / placement /
    sizing helpers.

- **N2b — Transactions calendar + Table/Calendar switcher (§2.4 steps 3–4)** (`feat` commit)
  - New `components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.tsx`
    — a second, independent consumer of the shared grid. Buckets the
    already-filtered list by day (net = money in − money out, the confirmed
    metric) with a per-day in/out tooltip. Carries none of Cash Flow's liquidity
    axis (§9.9). Zero new query.
  - `SpaceTransactionsPanel.tsx`: a top-level **Table / Calendar** switcher (one
    control; Group By is a table-only sub-mode, Calendar a peer view — §2.4
    resolved, no two redundant controls).
  - `TransactionsCalendarHeatmap.test.ts`: day-bucketing sums, in/out split,
    loaded-range derivation, and the zero-vs-unavailable contract (§9.6).

---

## Design decisions resolved (the plan's deliberate-choice points)

- **Calendar metric — Net (in − out)**, confirmed with the user (§2.4 asked to
  confirm). Consistent with `CashFlowCalendar`'s net semantics.
- **View switcher — a separate Table/Calendar control**, not a Group By option
  (Calendar isn't a grouping). Group By is hidden in Calendar mode. No two
  controls toggle the same list-vs-calendar axis (§2.4 / stop condition #4 spirit).
- **Month navigation — none.** The calendar renders the full filtered span
  exactly as the reference `CashFlowCalendar` does; the existing 7d/30d/90d/all
  date-range filter is the zoom. This deliberately sidesteps the empty-grid
  navigation hazard (§9 risk / §2.4) — there is no navigation that could render
  an unloaded month as "no spending."
- **Zero vs. unavailable (§9.6).** The `range` fed to the grid is the filtered
  list's own `[min, max]` span, so an in-range day with no transactions renders a
  neutral empty cell while a day outside the loaded span renders faint
  (unavailable) — two distinct looks, enforced by the grid and asserted in tests.
- **Day-click open — deferred.** The Phase 1 calendar is a read-only heat-map;
  wiring a click to open a single day's transactions needs a new single-day
  filter mechanism (genuinely additional scope), so `onSelectDay` is omitted here.

---

## Validation gate (plan §8) + Cash Flow behavior-neutrality

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **Clean** (0 errors). |
| `npx eslint` (`npm run lint`) | **0 errors.** 7 pre-existing warnings, none in touched files. |
| `npm test` | **194/194 passed** (+2 new test files: `CalendarHeatmapGrid.test.ts`, `TransactionsCalendarHeatmap.test.ts`; `flow-predicates.test.ts` extended). |
| **Cash Flow suite — behavior-neutral proof** | `cash-flow*.test.ts` + `liquidity*.test.ts` + `cash-movement.test.ts` = **61/61 passed, identical before and after** the `CalendarHeatmapGrid` extraction. |
| `git diff --name-only` (`b6a61c4..HEAD`) | **Matches plan §3 exactly** — see below. |
| `npm run dev` manual pass | **Partial — see note.** |

**`git diff --name-only b6a61c4..HEAD`** (all 8 in §3):

```
components/dashboard/widgets/SpaceTransactionsPanel.tsx
components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.test.ts
components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.tsx
components/space/widgets/CashFlowCalendar.tsx
components/space/widgets/shared/CalendarHeatmapGrid.test.ts
components/space/widgets/shared/CalendarHeatmapGrid.tsx
lib/transactions/flow-predicates.test.ts
lib/transactions/flow-predicates.ts
```

`lib/transactions/cash-flow-projection.ts` and `lib/transactions/liquidity.ts`
(Cash Flow's domain logic) were **not** touched, as §3 requires.

**Manual dev-pass note (honest scope).** The running dev server (`:3000`)
compiles and serves the changed module graph without error (transactions route
returns `307 → /login`, auth-gated, not a 500). The full interactive
click-through — visually confirming the new summary chips, the Table/Calendar
switch, and the heat-map's zero-vs-unavailable cells against a logged-in Space —
was **not** completed here: the Chrome automation extension cannot load
`localhost:3000`, and the check needs an authenticated session with
representative multi-month data. The underlying logic for every item is covered
by the passing unit tests (summary/Group-By shared-aggregation, day-bucketing,
zero-vs-unavailable, tint/placement/sizing) and by the behavior-neutral Cash
Flow suite; the remaining item is a visual spot-check for the user.

---

## Stop conditions §9.6–9.9 — none triggered

6. **Zero-transaction day vs. out-of-loaded-range day rendered identically.** Not
   triggered. The grid renders in-range no-activity days as neutral inset cells
   and out-of-range days as faint "unavailable" cells; the Transactions calendar
   feeds it the filtered list's own `[min, max]` range so the two facts are
   always visually distinct (asserted in `TransactionsCalendarHeatmap.test.ts`).
7. **A fabricated "$0.00" chip for an absent flow kind.** Not triggered. Every
   new summary chip is gated on `total > 0`; a kind absent from the filtered list
   renders no chip.
8. **Two separate reduces for summary vs. Group-By flow-type sums.** Not
   triggered. Both read one shared `sumByFlowType` map; the "By Flow Type" bucket
   total is `flowSums.get(key)`, never a second reduce.
9. **`CashFlowCalendar` imported into Transactions, or its extraction changing
   Cash Flow's behavior.** Not triggered. Transactions consumes only the shared
   metric-agnostic `CalendarHeatmapGrid` (no `CALENDAR_MEASURES` / `tierResolver`
   / liquidity import); the extraction is a mechanical, DOM-identical move and
   Cash Flow's domain suite passes 61/61 unchanged.

The original Phase 1 stop conditions §9.1–§9.5 remain honored: no raw confidence
numbers / reason codes / provider strings surfaced, no batched duplicate query,
`source` still single-sourced, one Group By control, and no drift into
Explain-extended / Coverage / Compare / NLU / Saved Views / refundCandidate /
recurring detection.
