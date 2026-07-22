# Cash Flow

## Purpose

The Cash Flow system answers two honest questions about one window of transactions:
"did spendable cash move?" (LIQUIDITY axis) and "what did I actually spend?" (ECONOMIC
axis). It powers the Cash Flow Workspace — Summary, History (calendar + cards), Spending
by Category, Income by Source, Debt Payments, context, and a completeness stamp — all
fed from a single projection so no panel re-classifies raw transactions.

## Authority

`lib/transactions/cash-flow-projection.ts` is THE canonical windowed projection. It adds
NO classifier: every fact is read from the two existing canonical authorities exactly
ONCE per row —

- LIQUIDITY axis → `classifyLiquidity` (`lib/transactions/liquidity.ts`)
- ECONOMIC axis → flow-predicates (`lib/transactions/flow-predicates.ts`) via the single
  economic-fold authority `foldEconomicRow` (`lib/transactions/cash-flow.ts:282`)

`foldDayFacts` folds one row into a `DayFacts` reading BOTH axes once. The three
granularity projections all derive from that same fold:

- `aggregateDayFacts` → the Summary (one aggregate `DayFacts`).
- `bucketDayFacts` → History cards (per-time-bucket, period granularity).
- `projectDailyFacts` → the Calendar (per-ISO-day).

Behavioural parity across these entry points is test-enforced
(`cash-flow-fold-authority.test.ts`, `cash-flow-projection.test.ts`): the three never
disagree because they share one fold, not three formulas.

## Inputs

- `transactions` — the FULL visible history (host-fetched via the generic transactions
  read; the window is derived internally).
- `accounts` `{ id, type }[]` — builds the liquidity tier context (`tierResolver`).
- `period` — a `CashFlowPeriod` (the SD-0B preset dimension; Cash Flow never reads the
  canonical `asOf` / `compareTo`).
- Optional `now` (injected clock) and `moneyCtx` (`ConversionContext` for per-row,
  per-date conversion; absent ⇒ raw amounts).

## Outputs

`CashFlowSpaceData` (`lib/transactions/cash-flow-space-data.ts:73`) — perspective-AGNOSTIC
data for one resolved window; both axes pre-folded once:

- `period`, `range` (inclusive ISO bounds), `rows` (windowed drill-down source).
- `summary` (`DayFacts`), `daily` (`Map<iso, DayFacts>`), `buckets` (`FactsBucket[]`).
- `outflowByCategory`, `incomeBySource`, `cashInByReason`, `debtPayments`, `context`.
- `stamp` (completeness, computed over FULL history), `available` / `dataYears`
  (selector option lists, also over full history).

Widgets select measures out of `DayFacts` (`perspectiveTotals`, `netOfMeasures`,
`rowsForMeasures`); they never re-fold. `DayFacts` carries the two axes plus documented
subsets: `cashIn`/`cashOut` (liquidity), `income`/`spendGross`/`refunds` (economic),
`creditCardSpending`/`directSpending` (tier split of gross spend), `cashWithdrawals`
(physical-cash form change), `unresolved`, and `byReason`.

## Canonical contracts

- `DayFacts`, `FactsBucket`, `CalendarMeasure`, `CALENDAR_MEASURES`,
  `perspectiveTotals`, `economicSpend`, `netOfMeasures`, `rowsForMeasures` —
  `cash-flow-projection.ts`.
- `foldEconomicRow` + `clampEconomicSpend` — the SOLE economic income / gross-spend /
  refund / spend-clamp definition (`cash-flow.ts`); the 3-way branch and the clamp must
  never be re-inlined elsewhere.
- `CashFlowSpaceData` + `buildCashFlowSpaceData` — the workspace contract
  (`cash-flow-space-data.ts`), a PURE PROJECTION (no DB — inputs are host-fetched).

## Persistence

Read-only over transactions and accounts already loaded by the host. The system defines
NO table and NO migration; every fact is recomputed from the transaction window on read.
The completeness `stamp` is a property of the DATA, so it is computed over full history,
not the window.

## Consumers

- `components/space/widgets/cashflow/CashFlowWorkspace.tsx` builds
  `CashFlowSpaceData` once and fans the same projection into: `CashFlowSummaryWidget`,
  `CashFlowHistoryWidget` (calendar + cards), `CashFlowCategoryBreakdown`,
  `DebtPaymentsWidget`, Income by Source, and `CashFlowInsightsCard`.
- The workspace owns only the semantic-slice state (the perspective toggle
  Cash Flow ⇄ Spending, and the measure filter); canonical TIME (`period`) stays
  host-owned. It emits its trust envelope to the shell chip.
- `CalendarHeatmapGrid` (`components/space/widgets/shared/CalendarHeatmapGrid.tsx`) is a
  metric-agnostic presentation-only primitive: it takes a caller-built
  `Map<iso, number>` of signed day magnitudes, a formatter, a tooltip-row builder, and
  an `onSelectDay` callback. It knows nothing about liquidity measures, FlowType, or any
  axis — there is NO separate fold inside it. It is shared with the Transactions
  calendar.

## Invariants

- One fold, both axes, once per row — the two canonical classifiers are read exactly
  once inside the projection; nothing downstream re-classifies (the
  cash-flow-fold-authority invariant).
- The three granularities reconcile (test-enforced parity), as does the drill-down: a
  measure's `rowMatches` reads the SAME canonical facts as its `value`, so the drawer
  shows exactly the rows a heat-map cell counted.
- Economic spend is clamped at ONE site: `clampEconomicSpend(spendGross, refunds)`,
  floored at 0, shared by `economicSpend`, `economicTotals`, and the projection.
- A credit-card purchase and its later debt payment are never counted as spending twice:
  the purchase is ECONOMIC spend (rises `spendGross`, not `cashOut`); the payment is a
  LIQUIDITY `DEBT_PAYMENT` cash-out — different axes, no overlap.
- `byReason` is effect-partitioned: a straddle reason's NEUTRAL leg is deliberately not
  recorded, so the Cash In / Cash Out reason partition is never corrupted. Every reason
  maps to a single side.
- Measures carry `subsetOf`; the UI must never sum a measure with its parent (the only
  way to double-count). Within a perspective's non-subset measures there is no overlap.

## Known limitations

- The named net figures are per-perspective, not standalone fields: `perspectiveTotals`
  yields `{ in, out, net }` (liquidity Net Cash or economic net = income − clamped
  spend), and `netOfMeasures` sums a selected measure set. There is no
  `netAfterDebtService` / `netEconomic` / `netLiquidity` measure — debt-service cash-out
  is surfaced through the `DEBT_PAYMENT` liquidity reason, not a dedicated net.
- `byReason.DEBT_PAYMENT` counts cash leaving a liquid account toward a liability; it may
  undercount payments from accounts not connected to Fourth Meridian (no liquid leg), and
  does not necessarily correspond to purchases in the same window.
- `creditCardSpending` is a period FLOW fact, never a balance — it does not mean an unpaid
  card balance (that is a Debt-domain STOCK fact).
- Currency conversion is per-row at the row's own date; absent a `ConversionContext`,
  raw amounts are used (the same rule as every other Cash Flow helper).

## Extension points

- New calendar measures register in `CALENDAR_MEASURES` with a `value` (over `DayFacts`)
  and a `rowMatches` (over a row + liquidity context) that read the same facts; set
  `subsetOf` for any measure that is a strict subset of another.
- New economic buckets extend `foldEconomicRow` (the single 3-way branch); never add a
  parallel branch.
- New workspace panels take a slice off `CashFlowSpaceData` and a pure drill filter over
  `rows` — never a second window or fold.

## Why the architecture is this way

A credit-card-heavy user must see both their spendable-cash reality and their true daily
spending, so the domain is inherently two-axis. Computing those axes independently per
widget is how Summary, History, and Calendar drift apart, so the design collapses the
decision to ONE fold producing a perspective-agnostic `DayFacts`; widgets SELECT out of
it and never re-fold, which is what lets the three granularities and the drill-down
reconcile by construction. `CalendarHeatmapGrid` is deliberately metric-agnostic so the
calendar is a presentation adapter over the projection, not a fourth fold. The contract
carries only DATA for one window; all control state (perspective, measure filter, view
mode) lives outside it, so a slice change never triggers a re-projection.
