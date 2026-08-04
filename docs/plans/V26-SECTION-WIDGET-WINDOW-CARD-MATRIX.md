# V2.6 — Section-Widget Window Convergence · Card Matrix

Branch `v2.6`. Read-only against the database throughout.

The dashboard shell owns ONE selected financial window (`preset`, `asOf`, `compareTo`). Before
this slice, the **workspace** path consumed it and the **section/registry** path did not — the
section registry carried no as-of, so `filterByPeriod(rows, period)` fell through to its
`now = new Date()` default. A section card therefore showed **today's** period while the shell
displayed a historical date, and said nothing about the difference.

---

## 1. What changed

`SectionRenderProps.asOf` now carries the shell's selected date, threaded
**shell → `SectionCard` → registry entry → adapter → widget**. Every interval widget windows
against it. The ISO-date → anchor conversion lives in exactly one place, `asOfAnchor()` in
`lib/transactions/cash-flow.ts`, because `periodRange` does **local-time** arithmetic and
`new Date("2026-03-01")` parses as *UTC* midnight — a month boundary that moves by a day for
anyone west of Greenwich.

| file | before | after |
|---|---|---|
| `SectionRegistry.tsx` | no as-of in `SectionRenderProps` | `asOf?: string`, forwarded by all 6 interval entries |
| `SectionCard.tsx` | — | accepts + forwards `asOf` |
| `SpaceDashboard.tsx` | — | supplies `asOf` to `SectionCard` and to `SectionCardBundle` |
| `cash-flow-adapters.tsx` | `scoped(tx, period)` → wall clock | `scoped(tx, period, asOf)` |
| `CashFlowSummaryWidget` | `windowRows ?? filterByPeriod(tx, period)` | `… , asOfAnchor(asOf))` |
| `CashFlowHistoryWidget` | same, **and** the calendar grid anchored to today | rows + grid share one anchor |
| `DebtPaymentsWidget` | same fallback | `… , asOfAnchor(asOf))` |
| `liquidity-what-changed.ts` | `now?: () => Date`, production omitted it | `asOf: string` — **required**, so the omission cannot compile |
| `SpaceTrendHero.tsx` | 30-day baseline from `new Date()` | measured back from the **series end** |

`buildWhatChangedRows`' anchor was made **required** rather than defaulted. An optional clock that
production never passed is what produced the defect; making it required is what makes the defect
unrepresentable.

---

## 2. The card matrix — every registry section

`follows slicer` = the card's output changes when the shell's as-of changes.

### 2a. FLOW claims — events on the displayed calendar dates

All six now take `transactions, period, asOf`. Window = the canonical closed FLOW interval
`[from, to]` resolved against the selected as-of.

| section | authority | composition | follows slicer |
|---|---|---|---|
| `cash_flow_summary` | `aggregateDayFacts` → `groupLiquidityByReason` | Cash In / Cash Out / credit context | **yes** ✓ |
| `cash_flow_history` | same, per day | daily net + calendar grid | **yes** ✓ (grid too) |
| `income_vs_spending` | same | inflow vs outflow magnitude | **yes** ✓ |
| `cash_flow_by_category` | `outflowByCategory` | categories, ids recorded | **yes** ✓ |
| `income_by_source` | `incomeBySource` | sources, ids recorded | **yes** ✓ |
| `debt_payments` | `debt-payments.ts` groups | payees, ids recorded | **yes** ✓ |

### 2b. STOCK claims from a historical series — already correct

| section | authority | window | follows slicer |
|---|---|---|---|
| `net_worth`, `net_worth_section` | `computeWealthTimeMachine(snapshots)` | series ⊆ selected range | **yes** |
| `net_worth_chart` | `SpaceSnapshot` series | selected range | **yes** |
| `debt_history` | `SpaceSnapshot` series | selected range | **yes** |

### 2c. STOCK claims from CURRENT balances — a different question

These read `p.accounts`, which is always the present-day balance set. That is legitimate — Debt
and Liquidity *heroes* ask "what do you owe / what can you reach **now**" and say so. It is only
dishonest when unlabelled.

| section | labelled "current" on the section path? |
|---|---|
| `accessible_cash` | **yes** |
| `allocation`, `wealth_by_account`, `institution_allocation`, `asset_allocation`, `wealth_concentration` | **no** |
| `liquidity_ladder`, `emergency_fund_readiness`, `liquidity_concentration` | **no** |
| `debt_by_account`, `debt_cost`, `credit_utilization`, `debt_complete_info`, `debt_payoff_calculator`, `debt_breakdown_chart`, `debt_summary` family | **no** |
| `accounts_overview`, `business_accounts` | **no** |
| asset-value + progress widgets (`property_value`, `vehicle_value`, `equipment_value`, `trip_*`, `emergency_fund_progress`, `retirement_progress`) | **no** |

**This is the remaining gap, and it is a labelling gap, not a window gap.** No wall clock is
involved: these cards never window. The *workspace* versions of the same claims already carry the
label (verified in-browser: *"reachable right now · current balances"*, *"Balances are current — the
trend and verdict below reflect Mar 20, 2026"*). The section versions do not. Recommended as its
own slice — adding an "as of today" qualifier to ~18 widgets is editorial work, not window work,
and was not in this slice's scope.

### 2d. Self-fetching — own their data, no shell window

`goal_progress`, `goal_on_track`, `goal_required_pace`, `goal_funding_gap`, `goals_progress`,
`recent_activity`, `credit_score`.

### 2e. Known coverage gap (pre-existing, unrelated to the window)

`SectionCardBundle` (used by `SpaceSectionStack` → Overview / Accounts workspaces) and
`RoutedWorkspaceModal` carry **no `transactions`**. An interval section configured onto those
surfaces renders its *loading* state indefinitely. Not a wall-clock defect — the widget returns
before it windows — but it means those hosts cannot currently show a Cash Flow card at all. `asOf`
was added to the bundle regardless, so wiring transactions in later cannot re-introduce a
wall-clock window.

### 2f. Not the shell's window, by design

`SpaceTransactionsPanel`'s 7d / 30d / 90d selector is an **in-card** filter the user sets on the
card itself. It is correctly relative to today and correctly labelled by its own toolbar.

---

## 3. Probes

`lib/transactions/cash-flow-window-identity.test.ts` — 12 checks. The former pinned **KNOWN GAP**
(which asserted *exactly two* wall-clock windows remained) is deleted and replaced by:

1. **STATIC** — 129 files across `components/space/widgets`, `components/space/sections` and
   `components/dashboard` scanned; **zero** `filterByPeriod`/`periodRange` calls without an
   explicit anchor. Repo-wide, not pinned to known files, so a *new* offender fails.
2. **STATIC** — `asOfAnchor` is exported from the authority, builds local midnight, and no
   component hand-rolls the same conversion.
3. **STATIC** — the as-of is threaded shell → `SectionCard` → registry → widget, and all six
   interval registry entries forward it.
4. **STATIC** — the trend-hero baseline is measured from the series end, not `new Date()`.
5. **BEHAVIOURAL** — at as-of `2026-03-20`, MTD selects the March row and not the August one;
   the canonical FLOW interval agrees with the widget's window on scope.
6. **BEHAVIOURAL** — `asOfAnchor` yields local midnight (March 1, not February 28) and returns
   `undefined` rather than fabricating a date.

Probe 1 earned its keep immediately: it caught `liquidity-what-changed.ts`, which was **not** one
of the two pinned files.

Comments are stripped before every static scan (repo precedent — assert intent, not a lexical
proxy).

---

## 4. Browser verification

Local dev, authenticated, Chris' Space.

| check | result |
|---|---|
| default (no params) | **1 month**, Jul 4 → Aug 4 2026 ✓ |
| historical as-of 2026-03-20, preset 1M | Feb 20 → Mar 20 ✓ |
| explicit **MTD** @ 2026-03-20 | **Mar 1 → Mar 20**; calendar renders **March 2026** ✓ |
| **YTD** @ 2026-03-20 | Jan 1 → Mar 20; calendar renders Jan/Feb/Mar only ✓ |
| card ↔ card identity, MTD @ Mar 20 | Cash In **$6,210** === Income by Source total **$6,210** ✓ |
| **cross-perspective identity** | Liquidity *"What changed · MTD"* → Earned income **+$6,210**, Debt payments **−$6,352** — byte-identical to Cash Flow's MTD at the same as-of. This card previously windowed against **August**. ✓ |
| back navigation | restores the same window and the same figures ✓ |
| Debt Payments | $6,352 (MTD) / $39,303 (YTD) — both follow the as-of ✓ |

---

## 5. Gate

- `tsc --noEmit` clean (excluding the gitignored `prototype/`, and `.next/dev/types` regenerated
  by the concurrently-running dev server).
- `npx tsx scripts/run-tests.ts` — **451/451 passed**.
- `npm run build` — exit 0, with `prototype/` and `app/prototype/` parked per the documented
  local-only workaround, then restored.

---

## 6. Database safety

No mutation, no regeneration, no schema change, no price acquisition, no event ingestion. Fixture
data only in the tests; every probe is a static scan or a pure in-memory computation.
