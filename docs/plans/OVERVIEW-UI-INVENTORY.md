# Overview UI Inventory — repository archaeology

**Status:** investigation only. No code changed, nothing deleted, no product decisions taken.
**Date:** 2026-09-07
**Purpose:** map the CURRENT Overview experience from the actual implementation so the
redesign is drawn from the product rather than from memory.

**Evidence base**
- Repository trace: route → host → shell → workspace → widget → data hook → API, read in
  rendered-composition order (not inferred from filenames).
- Live validation: the local dev server (`http://localhost:3000`) was walked in an
  authenticated browser session for Net Worth (all four internal metrics), Cash Flow,
  Liquidity, Investments and Debt. Sidebar contents, widget order, empty states and URL
  parameters below were confirmed on screen. The one surface NOT visually confirmed is the
  Net Worth *backfill* state (no backfill was running).

---

## 1. Current information architecture

### 1.1 Route and host

| Layer | File |
|---|---|
| Route | `app/(shell)/dashboard/page.tsx` (Personal) → `components/dashboard/PersonalDashboard.tsx` |
| Host | `components/dashboard/SpaceDashboard.tsx` (929 lines) — every Space, Personal included |
| Frame | `components/space/shell/SpaceShell.tsx` — content column + centred rail |
| App chrome (sidebar) | `components/ui/ContextualNavbar.tsx`, mounted by `components/ui/DashboardChrome.tsx` ABOVE the route child |

There is **no `/overview` route**. Overview is `?tab=overview` on `/dashboard`.

### 1.2 The two navigation levels

**Level 1 — the Space rail** (`lib/space-nav.ts`, `SPACE_TAB_ORDER`, fixed order, never reordered):

```
Overview | Activity | Accounts | Transactions | Members
```

Rendered by `SpaceShell` as an Atlas `SegmentedControl`, centred, text-only.

**Level 2 — the lens selector** (inside Overview only):

```
Net Worth | Cash Flow | Liquidity | Investments | Debt
```

Rendered by `components/space/shell/PerspectiveTabs.tsx` (loose bordered chips on a rule —
deliberately *not* a segmented control), mounted inside
`components/space/shell/PerspectiveShell.tsx`. Its items are built in `SpaceDashboard`
(`lensSelectorItems`): the literal `NET_WORTH_LENS_ID = "networth"` entry plus
`CORE_LENS_IDS = ["cashFlow","liquidity","investments","debt"]` filtered through the
category's `getPerspectivesForCategory()` list.

**Critical structural fact:** "Net Worth" is *not* a registry perspective. It is the
DEFAULT (null selection), and the null selection resolves to the `wealth` workspace.
`?perspective=wealth` is canonicalised back to null (`parsePerspectiveParam` in
`lib/space/use-space-navigation.ts`). So the lens rail is 1 default + 4 engageable lenses.

**Level 3 — inside Net Worth** (`components/space/widgets/wealth/WealthTrendChart.tsx`):

```
Net Worth | Assets | Liabilities | Liquid NW
```

This is a `Chips` control living in the **Balance-history chart header**, not a page-level
nav. See §5.

### 1.3 Registry model

`lib/perspectives.ts` is the one identity authority (`WORKSPACE_REGISTRY` = standard
workspaces + perspectives + platform + connections + settings). Per Overview lens it
declares: `dataNeeds`, `temporalCapability {asOf, compareTo, period}`, `envelope` source.

| id | label | dataNeeds | temporalCapability | envelope |
|---|---|---|---|---|
| `wealth` | Wealth (shown as "Net Worth") | accounts, snapshots | asOf full, compareTo full, period none | wealth |
| `cashFlow` | Cash Flow | accounts, transactions | asOf full, compareTo full, period **full** | cashFlow |
| `liquidity` | Liquidity | accounts, transactions, lens | asOf **partial**, compareTo partial, period none | lens |
| `investments` | Investments | accounts, investmentsHistory | asOf full, compareTo full, period none | investments |
| `debt` | Debt | accounts, snapshots, lens, fico | asOf **partial**, compareTo partial, period none | lens |

`components/space/workspaces/workspaceRenderers.tsx` (`WORKSPACE_RENDERERS`) is the
component-layer companion: `id → (ctx) => JSX`, bound to the registry by a parity test.
The host builds ONE `WorkspaceRenderCtx` and dispatches. Adding/removing a lens is a
registry + renderer pair, not a host branch.

---

## 2. Component tree (Overview, as rendered)

```
/dashboard  (app/(shell)/dashboard/page.tsx)
└── DashboardChrome                                  components/ui/DashboardChrome.tsx
    ├── SpaceChromeProvider                          lib/space/space-chrome-context.tsx
    ├── ContextualNavbar  (LEFT SIDEBAR)             components/ui/ContextualNavbar.tsx
    │   └── SpaceMode
    │       ├── identity (name, subtitle, freshness) ← publishSpace()   [SpaceDashboard]
    │       ├── SpaceControls (FX "view as" + Manage) ← publishCurrencyControl()
    │       └── SectionsNav  ("SECTIONS")            ← publishSections() [the WORKSPACE]
    └── PersonalDashboard → SpaceDashboard   (HOST)
        └── DisplayCurrencyProvider
            └── SpaceShell
                ├── overlays: ManageSpaceModal · ConfirmDialog(leave)
                ├── mobile-only identity row (<lg)
                ├── RAIL  SegmentedControl [Overview|Activity|Accounts|Transactions|Members]
                └── body  key={activeTab}:{activePerspectiveId}   (fm-view-enter animation)
                    └── activeTab === "OVERVIEW"
                        ├── CurrencyRevertedBanner            (conditional)
                        ├── PerspectiveShell
                        │   ├── PerspectiveTabs  [Net Worth|Cash Flow|Liquidity|Investments|Debt]
                        │   └── TimelineLens + ShellTrustRow
                        │        TimelineLens        components/atlas/TimelineLens/
                        │        ShellTrustRow       Completeness chip → CompletenessPopover
                        │                            Evidence chip     → EvidenceDrawer
                        │                            warning chips (FX)
                        └── WorkspaceExplorationHost            (ONE HistoryExplorationSheet mount)
                            └── WORKSPACE_RENDERERS[activePerspectiveId](ctx)
                                ├── WealthWorkspace
                                ├── CashFlowWorkspace
                                ├── LiquidityWorkspace
                                ├── InvestmentsWorkspace
                                └── DebtWorkspace
```

Notes
- The **left sidebar is app-global chrome**, above the route child. The Space publishes UP
  into it through the `SpaceChrome` context (props only flow down).
- The Overview slot **always** renders a lens workspace. The former Overview "summary
  canvas" (`OverviewWorkspace`, trend hero, section stack, doorway cards) was deleted in
  REVIEW-3 because the Net Worth default always resolves to `wealth`. There is no
  dashboard-of-cards page under Overview any more.
- `SpaceDashboardSection` rows still exist as CONFIG (Manage → Overview toggles,
  `components/space/manage/OverviewSectionsPanel.tsx`) and still feed the initial-tab pick,
  but **nothing on Overview renders them**.

---

## 3. Exact sidebar map

### 3.1 Mechanism

| Concern | Owner |
|---|---|
| Section list per lens | the WORKSPACE itself, via `useSpaceSectionsPublisher()` in a `useEffect` (publish on mount / clear on unmount) |
| Transport | `lib/space/space-chrome-context.tsx` → `SpaceChromeSection { label, anchor }` |
| Render | `SectionsNav` in `components/ui/ContextualNavbar.tsx` |
| Scroll | `document.getElementById(anchor)?.scrollIntoView({behavior:"smooth", block:"start"})` |
| Scroll offset | each target div carries `className="scroll-mt-20"` |
| Active tracking | **click-only.** `activeSection` is set by the click handler and lives in `SpaceChromeProvider` state. There is NO IntersectionObserver / scroll spy — scrolling by hand does not move the highlight |
| Tab-specific change | automatic: unmounting one workspace clears the list, the next publishes its own |
| "· soon" rows | a section with `anchor: null` renders disabled + "· soon". No Overview lens currently emits one |
| Empty list | `SectionsNav` returns `null` — the whole SECTIONS block disappears |

### 3.2 The lists (verified on screen)

```
NET WORTH        components/space/widgets/wealth/WealthWorkspace.tsx  (WEALTH_SECTIONS)
- Summary          -> #wealth-summary
- Balance history  -> #wealth-trend
- Composition      -> #wealth-composition
- What moved it    -> #wealth-ledger
- Explanation      -> #wealth-explanation
CONDITIONAL: published only when `!backfillInProgress && result.hasHistory`.
             With no history the sidebar SECTIONS block is absent entirely (confirmed).

CASH FLOW        components/space/widgets/cashflow/CashFlowWorkspace.tsx (CASHFLOW_SECTIONS)
- Summary       -> #cashflow-summary
- Activity      -> #cashflow-activity
- Spending      -> #cashflow-spending
- Income        -> #cashflow-income
- What changed  -> #cashflow-insights
UNCONDITIONAL.

LIQUIDITY        components/space/widgets/liquidity/LiquidityWorkspace.tsx (inline array)
- Summary          -> #liquidity-summary
- Balance history  -> #liquidity-history
- Sources          -> #liquidity-sources
- Resilience       -> #liquidity-resilience
- Activity         -> #liquidity-activity      (ONLY when `period` is set)

INVESTMENTS      components/space/widgets/investments/InvestmentsWorkspace.tsx (INVESTMENTS_SECTIONS)
- Summary          -> #investments-summary
- Balance history  -> #investments-history
- This period      -> #investments-period
- Holdings         -> #investments-holdings
- Allocation       -> #investments-allocation
- Concentration    -> #investments-concentration
- Activity         -> #investments-activity
CONDITIONAL: published only when holdings exist OR unvaluedCount > 0.

DEBT             components/space/widgets/debt/DebtWorkspace.tsx (DEBT_SECTIONS)
- Summary          -> #debt-summary
- Balance history  -> #debt-history
- Liabilities      -> #debt-liabilities
- Cost & risk      -> #debt-costrisk
- Payoff           -> #debt-payoff
- Credit health    -> #debt-credit
UNCONDITIONAL — but three of its anchors are inside conditional blocks (see §4), so the
sidebar can point at a section that is not on the page (Cost & risk / Payoff when
`hasDebt === false`; Liabilities when `liabilityCount === 0`). This is a real,
pre-existing defect worth carrying into the redesign brief.
```

**Shape observation for the redesign:** four of the five lenses already open
`Summary → Balance history → …`. The vocabulary is nearly identical; the divergence starts
at the third row.

---

## 4. Complete widget inventory

One row per meaningful widget/section, in page order.
`Candidate destination` is a PRELIMINARY mapping only. Nothing is marked DELETE.

### 4.1 Net Worth (lens `wealth`, default)

| # | Sidebar section | Widget / component | Purpose | File | Data dependency | Shared with | Unique behaviour | Conditional? | Candidate destination | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Summary | `WealthHero` | The one place net worth is stated + delta + trust chip + 3 secondary rows (Assets · Liabilities · Liquid NW) | `wealth/WealthHero.tsx` | `WealthResult` | pattern shared w/ all heroes (`Figure`, `TrustIndicator`, `DeltaBadge`) | headline label/value follow the chart metric; Liquid NW row has a "→ Liquidity" lens-switch affordance | shows `WealthUnavailable` if as-of precedes coverage | TOTAL | the lens-switch affordance is the only cross-lens jump on Overview |
| 2 | Balance history | `WealthTrendChart` → `TrendChart` | 4-series balance history + metric chips | `wealth/WealthTrendChart.tsx` | `WealthResult.chart.points` (snapshots) | **`TrendChart` shared by all 4 stock lenses** | the ONLY chart with a series switcher | — | TOTAL / ASSETS / DEBT (see §5) | the natural home of an All\|Cash\|Investments slice |
| 3 | Composition | `WealthCompositionCard` | "Where it sits" — 4 modes × 3 regimes | `wealth/WealthCompositionCard.tsx` | `WealthResult` composition (historical) + live `accounts` | `BreakdownWidget`; **reuses `renderLiquidityLadder` and `renderDebtByAccount`** | mode switcher By class / By institution / By account / Concentration; per-class delta chips; RightPanel detail | class mode needs `asOfState.found`; liabilities row only in netWorth metric | ASSETS / SHARED | already imports Liquidity's and Debt's composition renderers — strong consolidation signal |
| 4 | What moved it | `WealthChangeLedger` | Driver rows + Net change, metric-filtered | `wealth/WealthChangeLedger.tsx` | `WealthResult.drivers/deltas` | — | carries the fixed `ATTRIBUTION_NOTE` (no market-growth-vs-contributions labels) | needs a comparison date | TOTAL | rows are generic `{id,label,delta}` by design |
| 5 | Explanation | `WealthExplanationCard` | Deterministic template sentence + dominant-driver clause + "View explanation and evidence" | `wealth/WealthExplanationCard.tsx` | `WealthResult.explanation` | opens the shared `EvidenceDrawer` | **no LLM** | needs a comparison date | TOTAL | always net-worth-scoped: does NOT follow the metric chips (observed on screen) |
| — | — | `EvidenceDrawer` | snapshot evidence rows | `shell/EvidenceDrawer.tsx` | envelope evidence | shell + every lens | — | needs evidence rows | SHARED | |
| — | — | backfill state | "Creating your 30-day snapshot history…" | `WealthWorkspace.tsx` | `snapshotsBackfilling` | — | suppresses the whole body | conditional | SHARED | |

### 4.2 Cash Flow (lens `cashFlow`)

| # | Sidebar section | Widget | Purpose | File | Data dependency | Shared with | Unique behaviour | Conditional? | Candidate destination |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Summary | `CashFlowHero` | Net for the window + delta vs comparison + trust + perspective toggle | `cashflow/CashFlowHero.tsx` | `CashFlowSpaceData.summary` | hero pattern | hosts the Cash Flow / Spending **perspective toggle** + measure filter | — | CASH FLOW |
| 2 | Summary | `CashFlowSummaryWidget` (headless mode) | Cash In / Cash Out tiles, credit-card context, moved-not-spent, needs-classification | `widgets/CashFlowSummaryWidget.tsx` | windowed rows + facts | `TransactionSliceDrawer` | tiles drill to a transaction slice | — | CASH FLOW |
| 3 | Activity | `CashFlowHistoryWidget` | Calendar heatmap **or** Cards; Month/Quarter/Year selectors; All-Time year nav | `widgets/CashFlowHistoryWidget.tsx` | `daily` + `buckets` | `CashFlowCalendar`, `CalendarHeatmapGrid`, `TransactionSliceDrawer`, `CashFlowFilterControls` | the only calendar in the product; its own period drill writes the host's explicit period | modes gated by period scale | CASH FLOW |
| 4 | Activity | `TransactionCoverageNote` | honest "history incomplete" caveat | `trust/TransactionCoverageNote.tsx` | `transactionsMeta` | Liquidity too | — | only when the tx read was capped | SHARED |
| 5 | Spending | `CashFlowCategoryLedger` (spending) | Spending by category, weight bars → browser → detail ledger | `cashflow/CashFlowCategoryLedger.tsx` | `outflowByCategory` + rows-by-id | reused for Income | drill-down is BY ROW IDENTITY, never re-derived | empty state when no rows | CASH FLOW |
| 6 | Spending | `DebtPaymentsWidget` | debt payments in the window (the liquidity twin of spending) | `widgets/DebtPaymentsWidget.tsx` | windowed rows | `CashFlowCategoryBreakdown` | — | — | CASH FLOW / DEBT (overlaps Debt's story) |
| 7 | Income | `CashFlowCategoryLedger` (income) | Cash-in by reason (liquidity axis) **or** income by class (economic axis) | same file | `cashInByReason` / `income.lines` | same component as Spending | body changes with the perspective toggle | — | CASH FLOW |
| 8 | What changed | `CashFlowInsightsCard` | deterministic then-vs-now observations | `cashflow/CashFlowInsightsCard.tsx` | `compareCashFlow` + stamp | — | **no AI** | — | CASH FLOW |

### 4.3 Liquidity (lens `liquidity`)

| # | Sidebar section | Widget | Purpose | File | Data dependency | Shared with | Unique behaviour | Conditional? | Candidate destination |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Summary | `LiquidityHero` | Accessible cash + window delta + within-days + share-reachable + coverage + engine verdict | `liquidity/LiquidityHero.tsx` | `reachableNow(accounts)`, `classifyAccounts`, lens verdict, expense baseline | hero pattern, `TrustIndicator` | headline is PRESENT-DAY and says so under a past as-of | coverage row only with a resolved expense baseline | ASSETS / CASH |
| 2 | Balance history | `LiquidityBalanceHistory` → `TrendChart` | cashNow (checking+savings) over time | `liquidity/LiquidityBalanceHistory.tsx` | `clipCashHistory(snapshots)` | **same `TrendChart`** | single series, no switcher | null when <1 point | ASSETS / CASH |
| 3 | Sources | `SourcesLedger` (present) / historical tier list (past) | per-account reachable ledger → Left/Right panels; or reconstructed tier totals + delta chips | `liquidity/SourcesLedger.tsx` + inline `renderHistoricalTiers` | accounts + `LiquiditySpaceData.atAsOf` | `SourceAccountDetail`, `TierCompositionDetail`, Atlas panels | **two entirely different bodies for the same section** depending on as-of | historical branch only when `atAsOf.status === "ok"` | ASSETS / CASH |
| 4 | Resilience | Emergency coverage · Cash concentration · Reachability | 3 `Surface` stat panels + `ReachBar` | inline in `LiquidityWorkspace.tsx` | accounts + baseline | — | each degrades honestly (no fabricated runway) | each panel has its own empty state | ASSETS / CASH |
| 5 | Activity | `LiquidityWhatChangedCard` | top cash-in/out drivers + "View all activity in Cash Flow →" doorway | `liquidity/LiquidityWhatChangedCard.tsx` | transactions + period | — | the doorway calls `onOpenCashFlow` → switches lens | only when `period` is set | ASSETS / CASH → CASH FLOW doorway |
| — | — | unused-credit footnote | borrowing capacity, never counted as liquidity | inline | `availableCredit` metric | — | doctrine statement | historical branch, credit > 0 | ASSETS / CASH |

### 4.4 Investments (lens `investments`)

| # | Sidebar section | Widget | Purpose | File | Data dependency | Shared with | Unique behaviour | Conditional? | Candidate destination |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Summary | `InvestmentsHero` | Valued-holdings subtotal + period change + "4 of 13 positions valued" | `investments/InvestmentsHero.tsx` | `InvestmentsSpaceData` | hero pattern | states coverage of the headline up front | — | ASSETS / INVESTMENTS |
| 2 | (none) | `ExcludedDisclosure` | positions that couldn't be valued, named ABOVE the ledger | inline | `portfolio.unvalued` | — | "We'd rather be short than wrong" | `unvaluedCount > 0` | ASSETS / INVESTMENTS |
| 3 | (none) | scope-divergence note | shared-Space scope disclosure | inline | `raw.scopeDivergence` | — | — | conditional | ASSETS / INVESTMENTS |
| 4 | Balance history | `InvestmentsBalanceHistory` → `TrendChart` | invested value (stocks+crypto) over time | `investments/InvestmentsBalanceHistory.tsx` | `portfolio-series` over snapshots | **same `TrendChart`** | carries per-point `basis` + `coverageLabel` (3-state confidence: observed / reconstructed / unreliable) | — | ASSETS / INVESTMENTS |
| 5 | This period | `InvestmentsBridgeCard` | opening → in → out → change → closing waterfall + residual disclosure | `investments/InvestmentsBridgeCard.tsx` | `reconciliation`, `flows`, `attribution` | — | genuinely unique capability | — | ASSETS / INVESTMENTS |
| 6 | Holdings | `HoldingsLedger` | weight-bar ledger → `LeftPanel` browser → `HoldingDetail` | `investments/HoldingsLedger.tsx` | `primary.holdings` | Atlas panels (same idiom as Sources/Liabilities) | search inside the browser | — | ASSETS / INVESTMENTS |
| 7 | Allocation | `InvestmentAllocationPanel` | donut with dimension switcher: **By asset class / By sector / By account / By currency** | `investments/InvestmentAllocationPanel.tsx` | holdings | `BreakdownWidget` | 4-dimension allocation switcher | — | ASSETS / INVESTMENTS |
| 8 | Concentration | `HoldingsConcentration` | largest holding / top-5 / largest sector / effective-holdings | `investments/HoldingsConcentration.tsx` | holdings | conceptually twins Wealth's Concentration mode | HHI-style "effective holdings" | — | ASSETS / INVESTMENTS |
| 9 | Activity | `InvestmentsActivityCard` | money-in/out narrative + buys/sells/income/corporate actions | `investments/InvestmentsActivityCard.tsx` | `flows` | — | unique | — | ASSETS / INVESTMENTS |
| 10 | (none) | `InvestmentConnectionsCard` | reconnect prompts for broken brokerage links | `investments/InvestmentConnectionsCard.tsx` | self-fetched | — | renders itself only when an account needs attention | conditional | ASSETS / INVESTMENTS |
| 11 | (none) | empty state | "No holdings for this date" + connect CTA | inline | — | — | — | when no holdings and no unvalued | ASSETS / INVESTMENTS |

### 4.5 Debt (lens `debt`)

| # | Sidebar section | Widget | Purpose | File | Data dependency | Shared with | Unique behaviour | Conditional? | Candidate destination |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Summary | `DebtHero` | Total owed + window delta + utilization + engine verdict sentence | `debt/DebtHero.tsx` | `computeDebtKpis(accounts)` + lens | hero pattern | present-day headline under a past as-of, and says so | — | DEBT |
| 2 | Balance history | `DebtBalanceHistory` → `TrendChart` | total debt over time | `debt/DebtBalanceHistory.tsx` | `DebtSpaceData.history` (snapshots) | **same `TrendChart`** | — | null when <1 point | DEBT |
| 3 | Liabilities | `LiabilitiesLedger` | grouped weight-bar ledger → panels → `DebtAccountDetail` | `debt/LiabilitiesLedger.tsx` | accounts | Atlas panels | STRUCTURAL population — renders paid-off and in-credit accounts too | `liabilityCount > 0` | DEBT |
| 4 | Cost & risk | `CreditUtilizationWidget` + `renderDebtCost` | utilization per card, missing-limit prompts, estimated interest | `debt-perspective-adapters.tsx` | accounts | — | unique | inside `hasDebt` | DEBT |
| 5 | Payoff | `renderDebtPayoffCalculator` (`DebtPayoffSection`, 714 lines) + `PayoffScenarioStrip` | interactive amortisation planner (account picker, monthly payment slider, Mo/Wk/$, debt-free date, principal/interest totals) + preset scenarios | `sections/DebtPayoffSection.tsx`, `debt/PayoffScenarioStrip.tsx` | accounts aggregate | `simulatePayoff` also feeds `debt-signals` and `payoff-scenarios` | the single most interactive widget on Overview | inside `hasDebt` | DEBT |
| 6 | Credit health | `renderCreditScore` + `buildDebtSignals` + `renderDebtCompleteInfo` | manual FICO gauge, deterministic signals, inline APR/min-payment editor (writes data) | `debt-perspective-adapters.tsx` | `fico`, accounts | — | **the only data-WRITING form on Overview** | signals list only when non-empty | DEBT |

**Counts (meaningful sections/widgets per lens):** Net Worth 5 sections / ~7 widgets ·
Cash Flow 5 / 8 · Liquidity 5 / 7 · Investments 7 / 11 · Debt 6 / 8.
**Total ≈ 41 meaningful surfaces across the five lenses.**

---

## 5. Net Worth internal selector — deep investigation

### 5.1 What it actually is

`WealthMetricKey = "netWorth" | "totalAssets" | "totalLiabilities" | "liquidNetWorth"`
(`components/space/widgets/wealth/WealthTrendChart.tsx`).

It is **a display-metric selector, not navigation and not a filter**. Precisely:

- **State ownership:** `useSpaceNavigation` (`chartMetric` / `setChartMetric`), mirrored to
  the URL as `?metric=` (netWorth clears the param). Confirmed live:
  clicking "Assets" wrote `&metric=totalAssets`.
- **Threading:** host → `WorkspaceRenderCtx.chartMetric` → `WealthWorkspace` →
  `WealthHero`, `WealthTrendChart`, `WealthCompositionCard`, `WealthChangeLedger`.
- **Semantics:** one key selects (a) which field of `WealthChartPoint` is plotted,
  (b) the hero label + value + delta, (c) which composition REGIME renders, (d) which
  driver components make up the change ledger — via the pure facet table
  `wealth-metric-facets.ts`:

```
METRIC_COMPOSITION_REGIME   netWorth→assets  totalAssets→assets
                            totalLiabilities→liabilities  liquidNetWorth→liquid
METRIC_DRIVER_COMPONENTS    netWorth→[cash,investments,crypto,real,liabilities]
                            totalAssets→[cash,investments,crypto,real]
                            totalLiabilities→[liabilities]
                            liquidNetWorth→[cash,liabilities]
METRIC_POSSESSIVE           "your net worth" / "your assets" / …
```

### 5.2 What stays constant vs what changes (verified on screen)

| Surface | Net Worth | Assets | Liabilities | Liquid NW |
|---|---|---|---|---|
| Rail, lens chips, TimelineLens, trust chips | identical | identical | identical | identical |
| **Sidebar sections** | identical | identical | identical | identical |
| Hero eyebrow/value/delta | $36,340 NET WORTH | $36,366 TOTAL ASSETS | $25 TOTAL LIABILITIES | $12,357 LIQUID NET WORTH |
| Chart series | `netWorth` | `totalAssets` | `totalLiabilities` | `liquidNetWorth` |
| Composition body | assets donut **+ liabilities row** | assets donut, no liabilities row | **`renderDebtByAccount`** ("Current classification — your debts today, by creditor") | **`renderLiquidityLadder`** (Available now / Available in days) |
| Change ledger | 4 drivers, net +$8,309 | 3 drivers, net +$7,097 | 1 driver, net −$1,213 | cash + liabilities, net +$4,571 |
| Explanation card | net-worth sentence | **unchanged** (still the net-worth sentence) | unchanged | unchanged |
| Exploration root on chart click | `net-worth` | `assets` | `debt` | `liquid-net-worth` |

### 5.3 Findings that matter for the redesign

1. **Net Worth already contains Debt and Liquidity.** Selecting Liabilities renders Debt's
   own composition renderer; selecting Liquid NW renders Liquidity's own ladder renderer.
   The proposed Total | Assets | Debt model is partly implemented already.
2. **The selector is reusable as-is** for `Total | Assets | Debt`: it is a URL-synced string
   key + a pure facet table + one chart-series lookup. Renaming/re-scoping the key set is a
   table edit, not a new navigation system. The exploration root mapping
   (`metricRoot` in `WealthWorkspace`) is already `assets` / `debt`-aware.
3. **It lives in the wrong place visually** — inside the chart card header (`headerRight`),
   yet it drives four surfaces including the hero. If it becomes the Total|Assets|Debt
   selector, it needs to be promoted out of the chart header.
4. **Sidebar does not react to it.** Section labels stay "Composition / What moved it"
   regardless of metric.
5. **Two honesty asymmetries to carry forward:** the Liabilities and Liquid-NW composition
   bodies are PRESENT-DAY only (they say so), while the chart series for those same metrics
   is fully historical. And the Explanation card ignores the metric.

---

## 6. Chart inventory

| Chart | Component | Lens | Core | Series available | Selector today | Date range | Multiple series at once? | Historical authority |
|---|---|---|---|---|---|---|---|---|
| Balance history (Net Worth) | `WealthTrendChart` | Net Worth | **`TrendChart`** | netWorth · totalAssets · totalLiabilities · liquidNetWorth | **yes — `Chips`, 4 options** | shell `[compareTo … asOf]` | **no** — one at a time (`p[metric]`) | `SpaceSnapshot` via `computeWealthTimeMachine` |
| Balance history (Liquidity) | `LiquidityBalanceHistory` | Liquidity | `TrendChart` | cashNow (= `totalCash + totalSavings`) | none | same window | no | `SpaceSnapshot` via `clipCashHistory` |
| Balance history (Investments) | `InvestmentsBalanceHistory` | Investments | `TrendChart` | invested value (= `stocks + crypto`) | none | same window | no | `SpaceSnapshot` via `portfolio-series` |
| Balance history (Debt) | `DebtBalanceHistory` | Debt | `TrendChart` | totalDebt | none | same window | no | `SpaceSnapshot` via `DebtSpaceData.history` |
| Composition donut | `BreakdownWidget` | Net Worth, Investments, (via adapters) Debt, Liquidity | own SVG | by class / institution / account / sector / currency | mode switchers | point-in-time | n/a | snapshot (class) or live accounts |
| Activity heatmap | `CashFlowCalendar` / `CalendarHeatmapGrid` | Cash Flow | own | daily net, filtered by measure | Calendar/Cards + 9 measure filters | period-native | n/a | transactions |
| Payoff projection | `DebtPayoffSection` | Debt | own | amortisation schedule | payment amount + accounts | forward-looking | n/a | live accounts |
| Bridge waterfall | `InvestmentsBridgeCard` | Investments | CSS bars | opening/in/out/change/closing | none | period | n/a | investments contract |

### 6.1 `TrendChart` — the shared plotting core

`components/space/widgets/charts/TrendChart.tsx` (+ pure `trend-runs.core.ts`).
Domain-free: takes `TrendPoint {date, value, estimated, basis?, coverageLabel?}`, a currency
and presentation slots (`title`, `subtitle`, `headerRight`, `onSelectPoint`). It provides
measured-width layout, run splitting at real gaps AND at basis changes, dashed
reconstructed runs, hatched NO-DATA bands, seam rules, tooltip, legend, y-scale from real
points only, and click-to-explore.

**`headerRight` is the existing extension point** — Net Worth's metric chips are exactly
that. Any new slice control plugs into the same slot with no chart change.

### 6.2 Can Cash + Investments be rendered together today?

**Data: yes, trivially. Rendering: not without a small change.**

All four stock series come from the **same `SpaceSnapshot` row set** (`prisma/schema.prisma`
`model SpaceSnapshot`), read through the one canonical boundary (`lib/data/snapshots.ts` →
`types/index.ts` `Snapshot`):

```
netWorth · totalAssets · totalDebt · netLiquid            (derived columns)
totalCash (checking) · totalSavings · totalInvestments (stocks) · totalCrypto · total
isEstimated · fxMiss · reportingCurrency
+ crypto assertability + per-aggregate authorisation
```

So on one snapshot row:

```
Cash        = totalCash + totalSavings          (exactly Liquidity's cashNow)
Investments = totalInvestments + totalCrypto    (exactly the Investments series; disjoint buckets, no double count)
All assets  = totalAssets                       (persisted; ≈ cash + investments + real)
Debt        = totalDebt                         (exactly Debt's series)
```

An `All | Cash | Investments` slice therefore needs **no new data source, no new endpoint,
no new fetch** — the Wealth path already loads the whole snapshot series into
`WealthWorkspace`.

**What would be required (not implemented, listed for scoping only):**
1. `WealthChartPoint` (`lib/wealth/wealth-time-machine.ts` `WealthMetrics`) currently
   carries netWorth/totalAssets/totalLiabilities/liquidNetWorth. A cash and an
   investments field would have to be projected there (both are already on `Snapshot`).
2. Extend the `METRICS` table in `WealthTrendChart` (or a successor slice control).
3. Extend the three facet tables in `wealth-metric-facets.ts` for the new keys.
4. `TrendChart` plots ONE series (`points: TrendPoint[]`). "Cash + Investments together as
   two lines" needs a multi-series capability the core does not have; "All / Cash /
   Investments as switchable single series" needs nothing beyond 1–3.
5. FX: every series must pass through its existing per-date conversion helper
   (`convertWealthSnapshots` / `convertCashHistory` / `convertPortfolioValueSeries`) —
   they all drop `fxMiss` points identically, so the bases stay compatible.
6. Trust caveat: the Investments series carries a richer 3-state `basis` +
   `coverageLabel` (from persisted snapshot completeness) that the Wealth series does not.
   A merged control must not silently downgrade that disclosure.

---

## 7. Shared-vs-unique analysis (duplication map)

### Class 1 — SAME COMPONENT + DIFFERENT DATA (already consolidated)

| Concept | The one component | Consumers |
|---|---|---|
| Balance-history plotting | `charts/TrendChart.tsx` | Net Worth, Liquidity, Investments, Debt |
| Trust chip / caveat | `trust/TrustIndicator.tsx` + `shell/ShellTrustRow.tsx` | all five heroes + the shell |
| Completeness detail | `shell/CompletenessPopover.tsx` | all |
| Evidence detail | `shell/EvidenceDrawer.tsx` | all |
| Envelope resolution | `lib/perspectives/envelope.ts` `resolvePerspectiveEnvelope` | all five |
| Time selection | `atlas/TimelineLens` + `usePerspectiveShellState` + `perspective-time-adapter` | all five |
| Historical drill-down | `history/HistoryExplorationSheet` + `useHistoryExploration`, mounted ONCE in `WorkspaceExplorationHost` | Net Worth, Liquidity, Investments, Debt |
| Composition donut | `widgets/BreakdownWidget.tsx` | Net Worth, Investments, Debt adapters, Liquidity adapters |
| Ledger → browser → detail | `atlas/panels` (`LeftPanel`/`RightPanel`/`PanelHeader`/`PanelContent`) | Sources, Liabilities, Holdings, Accounts, category ledgers |
| Section shell | `atlas/Surface` (`Surface`, `Block`, `Figure`) | all |
| Delta badge | `wealth/wealth-ui.tsx` `DeltaBadge` | Wealth, Debt, Liquidity, Investments, Cash Flow |
| Transaction slice drill | `widgets/TransactionSliceDrawer.tsx` | Cash Flow (4 call sites) |
| Money display | `widgets/display-money.ts`, `lib/money/convert` | all |
| Tx coverage caveat | `trust/TransactionCoverageNote.tsx` | Cash Flow, Liquidity |

### Class 2 — DIFFERENT COMPONENT + SAME CONCEPT (the real duplication)

| Concept | Implementations | Note |
|---|---|---|
| **Hero / lede** | `WealthHero`, `CashFlowHero`, `LiquidityHero`, `InvestmentsHero`, `DebtHero` | 5 files, one idiom (eyebrow + trust chip + Figure + DeltaBadge + stat line). Differences are real (coverage line, verdict sentence, perspective toggle) but the skeleton is copied |
| **Balance-history wrapper** | `LiquidityBalanceHistory`, `InvestmentsBalanceHistory`, `DebtBalanceHistory` (+ `WealthTrendChart`) | 4 thin wrappers over one core, differing only in the point projection, title/aria copy and subtitle. `Liquidity`'s and `Debt`'s are byte-similar |
| **Window delta computation** | `change` memo in `LiquidityWorkspace`, `DebtWorkspace`; `WealthResult.deltas`; `CashFlowWorkspace.change` | Liquidity's and Debt's are the same 8-line first/last-point calculation |
| **Account ledger** | `SourcesLedger` (liquidity), `LiabilitiesLedger` (debt), `HoldingsLedger` (investments), `AccountsLedger` (Accounts tab) | same panel idiom, four implementations, four detail components |
| **Composition** | `WealthCompositionCard` (class/institution/account/concentration), `InvestmentAllocationPanel` (class/sector/account/currency), `renderLiquidityLadder`, `renderDebtByAccount` | Wealth already calls the last two — the pattern is proven |
| **Concentration** | `renderWealthConcentration` (Wealth mode 4) vs `HoldingsConcentration` (Investments) | same question, two answers |
| **"What changed"** | `WealthChangeLedger`, `LiquidityWhatChangedCard`, `CashFlowInsightsCard`, `InvestmentsActivityCard` + `InvestmentsBridgeCard` | genuinely different bases (composition drivers vs tx drivers vs then-vs-now vs flows) but one user question |
| **Present-day-headline-under-a-past-as-of disclosure** | `DebtHero` and `LiquidityHero` implement the same honesty rule separately | |
| **Loading indicator** | "Updating…" spinner rows in Liquidity, Debt, Investments, each hand-rolled | |

### Class 3 — GENUINELY UNIQUE CAPABILITY (nothing else does this)

- **Net Worth:** the 4-series metric switcher; the deterministic Explanation sentence;
  the historical by-class composition from the as-of snapshot (not today's classification);
  the metric-filtered driver ledger.
- **Cash Flow:** the calendar heatmap + Cards history with Month/Quarter/Year drill and
  All-Time year navigation; the liquidity-vs-economic perspective toggle; the 9 measure
  filters; category/income ledgers with identity-based drill; deterministic then-vs-now
  insights.
- **Liquidity:** the reachability tiering (now / days / illiquid); coverage months from a
  resolved expense baseline; cash concentration; the reconstructed as-of tier ladder with
  per-tier delta chips; the unused-credit-is-not-liquidity doctrine line.
- **Investments:** the period bridge/waterfall with residual disclosure; the excluded /
  unvalued disclosure and 3-state per-point confidence; 4-dimension allocation; effective
  holdings concentration; buys/sells/income/corporate-action activity; broken-connection
  reconnect card.
- **Debt:** the interactive payoff planner + preset scenarios; credit utilization with
  missing-limit prompts; interest-cost estimate; FICO + deterministic credit signals; the
  inline APR / minimum-payment **editor** (the only write surface on Overview).

---

## 8. Data dependency map

### 8.1 Space-level shared fetches — `lib/space/use-space-data.ts`

| Resource | Endpoint | Gate |
|---|---|---|
| sections (CONFIG only) | `GET /api/spaces/[id]/sections` | always |
| accounts | `GET /api/spaces/[id]/accounts` | always |
| space meta | `GET /api/spaces/[id]` | always |
| snapshots | `GET /api/spaces/[id]/snapshots` | `wantSnapshots` = trend-hero category ∨ PERSONAL ∨ open lens declares `snapshots` |
| transactions | `GET /api/spaces/[id]/transactions` | `wantTransactions` = flow category ∨ Transactions tab ∨ open lens declares `transactions` |
| FX context | `GET /api/money/view-context?target=` | always |
| lens verdicts | `GET /api/spaces/[id]/perspectives` (`use-space-lens-results.ts`) | always (present-day) |
| expense baseline | `GET /api/spaces/[id]/expense-baseline` | only while Liquidity is open |

Lazy activation is **declarative**: `openPerspectiveDataNeeds(activeTab, activePerspectiveId)`
in `lib/space/workspace-resources.ts` reads `WORKSPACE_REGISTRY[id].dataNeeds`.

### 8.2 Per-lens historical fetches (inside each workspace, gated on `active`)

| Lens | Hook | Endpoint |
|---|---|---|
| Liquidity | `useLiquiditySpaceData` | `GET /api/spaces/[id]/liquidity/space-data?asOf&compareTo` |
| Investments | `useInvestmentsSpaceData` | `GET /api/spaces/[id]/investments/space-data?asOf&compareTo` |
| Debt | `useDebtSpaceData` | `GET /api/spaces/[id]/debt/space-data?asOf&target` |
| Net Worth | none — pure over the shared snapshots (`computeWealthTimeMachine`) | — |
| Cash Flow | none — pure over the shared transactions (`buildCashFlowSpaceData`) | — |
| all | `GET /api/history/node` (exploration sheet) | on chart-point click |

`compareTo` is clamped to `shell.derived.historicalCompareTo` (strictly earlier) for
Debt/Investments/Liquidity — those routes 400 otherwise. Wealth uses the raw `compareTo`.

### 8.3 Snapshot column → lens mapping

```
SpaceSnapshot
├── netWorth ─────────────► Net Worth (metric netWorth)
├── totalAssets ──────────► Net Worth (metric totalAssets)
├── netLiquid ────────────► Net Worth (metric liquidNetWorth)
├── debt ─────────────────► Net Worth (metric totalLiabilities)  AND  Debt balance history
├── cash + savings ───────► Liquidity balance history (cashNow)
├── stocks + crypto ──────► Investments balance history
└── isEstimated / fxMiss / reportingCurrency / crypto assertability → trust on all of them
```

**One table already feeds every stock chart on Overview.**

---

## 9. Preliminary migration matrix

| CURRENT | POSSIBLE FUTURE HOME | Notes (factual) |
|---|---|---|
| Net Worth / Net Worth (metric `netWorth`) | **TOTAL** | hero + chart series + assets donut w/ liabilities row + 5-driver ledger + explanation |
| Net Worth / Assets (metric `totalAssets`) | **ASSETS** | already assets-only composition + 4-driver ledger; historical, from snapshots |
| Net Worth / Liabilities (metric `totalLiabilities`) | **DEBT** | already renders Debt's `renderDebtByAccount` composition |
| Net Worth / Liquid NW (metric `liquidNetWorth`) | **metric/widget, not navigation** | already renders Liquidity's ladder; is a derived figure (cash − debt) that spans Assets and Debt. Fits better as a hero stat row (it is already one in `WealthHero`) + a chart series than as a destination |
| Liquidity | **ASSETS / CASH** | hero, cashNow chart, sources ledger, resilience trio, what-changed doorway |
| Investments | **ASSETS / INVESTMENTS** | hero, invested-value chart, bridge, holdings, allocation, concentration, activity, connections |
| Debt | **DEBT** | whole workspace maps 1:1 |
| Cash Flow | **CASH FLOW** | whole workspace maps 1:1 |

---

## 10. Components / capabilities that do not fit this mapping cleanly

1. **Liquid Net Worth** — a cross-cutting figure (cash − debt). It is currently a chart
   series, a hero row and a composition regime. Under Total|Assets|Debt it belongs to no
   single lens.
2. **`DebtPaymentsWidget`** — lives in Cash Flow's Spending section but answers a Debt
   question from transaction data.
3. **Liquidity's "What changed"** — transaction-derived, inside an otherwise
   balance-sheet lens, and its only action is a doorway INTO Cash Flow.
4. **Liquidity's "Available in days" tier** — brokerage + crypto valued as *settlement
   speed*. That is the same money the Investments lens values as *holdings*. Under a
   unified Assets lens the same assets appear in two sub-stories with two vocabularies.
5. **`WealthCompositionCard`'s institution / account / concentration modes** — they read
   LIVE accounts, not the as-of snapshot, and overlap the Accounts rail tab
   (`AccountsLedger`) and Investments' concentration.
6. **Credit health (FICO + signals + the APR editor)** — a data-entry surface inside an
   analytical lens; also the only Overview surface that writes.
7. **`Explanation` (Net Worth)** — net-worth-scoped only; does not follow the metric.
8. **Cash Flow's perspective toggle (Cash Flow / Spending)** — a second semantic axis that
   exists only in that lens and changes the meaning of Net, Income and the calendar.
9. **The Investments "Excluded / unvalued" disclosure and 3-state confidence** — a trust
   vocabulary richer than the other three series carry.
10. **Debt's "Liabilities" section being structural** (renders paid-off / in-credit
    accounts) while everything below it is magnitude-gated on `hasDebt`.

---

## 11. Technical constraints to know before sketching

1. **The sidebar is published, not configured.** A workspace declares its own sections
   from inside its own render. Any new IA must keep "one mounted workspace owns the list",
   or the publish/clear lifecycle has to be redesigned.
2. **No scroll-spy.** Active section tracking is click-only. If the redesign implies longer
   pages, an IntersectionObserver is new work.
3. **Sidebar rows can point at absent anchors** (Debt today). Publishing must become
   conditional in the same way Liquidity's "Activity" row already is.
4. **Time is canonical and shared.** `{preset, asOf, compareTo}` is owned by
   `usePerspectiveShellState` and serialised through the one Space-URL authority
   (`useSpaceUrl` / `lib/space/space-url.ts`). Workspaces own NO time state. Cash Flow's
   explicit period drill is the single sanctioned local override.
5. **`temporalCapability` gates the explicit date inputs**, and Liquidity + Debt are
   `partial` — their headline figures are present-day by design and say so. Any
   consolidation that merges a `partial` surface with a `full` one must keep that
   disclosure per-figure, not per-page.
6. **Dual authority in Debt (deliberate):** every visible figure comes from the accounts
   array; the lens result supplies only the prose verdict. They can legitimately disagree.
7. **Envelope bridge:** each workspace emits ONE `PerspectiveEnvelope` up via
   `onEnvelopeChange` → `useActiveEnvelope` → the shell chips. Two workspaces rendered
   simultaneously would fight over that single slot. **This is the main technical
   constraint on "Assets shows Cash and Investments together."**
8. **`WORKSPACE_RENDERERS` ↔ registry parity is test-enforced.** A new lens id needs both.
9. **Fetch gating is declarative** (`dataNeeds`). A merged Assets lens must declare the
   union — `accounts + snapshots + transactions + lens + investmentsHistory` — which means
   opening Assets would trigger the Liquidity AND Investments historical fetches together.
10. **Money conversion is per-date and per-lens.** Four conversion helpers exist
    (`convertWealthSnapshots`, `convertLiquiditySpaceData` + `convertCashHistory`,
    `convertInvestmentsSpaceData` + `convertPortfolioValueSeries`, `convertDebtHistory`).
    All drop `fxMiss` points identically; a merged surface must pick one and not blend.
11. **`TrendChart` is single-series.** Multi-series overlay is new capability.
12. **The exploration sheet is mounted once** by `WorkspaceExplorationHost` and rooted by
    `LensRoot` (`net-worth` / `assets` / `debt` / `liquidity` / `investments` /
    `liquid-net-worth`). The root vocabulary already matches the proposed IA.
13. **Deep links in use:** `?tab=`, `?perspective=` (slugged: `cash-flow`), `?metric=`,
    `?asof=`, `?compareto=`, `?preset=`, `?account=`, plus exploration params
    `hroot/hnode/hfrom/hto`. Legacy aliases (`?tab=debt|credit|investments|banking|timeline|perspectives`)
    canonicalise. Any IA change must keep these resolving.
14. **Responsive today:** the sidebar (and therefore the whole SECTIONS list) is
    `hidden lg:*` — on a phone there is NO section navigation; identity + FX + Manage
    relocate above the rail inside `SpaceShell`. Workspace bodies are stacked
    `space-y-8 sm:space-y-10` with `lg:grid-cols-2 / lg:grid-cols-3 / lg:col-span-*`
    collapsing to one column. The lens chip row wraps (`flex-wrap`); the trust row uses a
    **container query** at `@min-[850px]`.
15. **Dead/orphaned code adjacent to Overview** (not rendered anywhere today):
    `widgets/AssetValueWidget.tsx`, `widgets/ProgressWidget.tsx`, `widgets/TimelineWidget.tsx`,
    and the unused adapters `renderAssetAllocation`, `renderAccessibleCash`,
    `renderEmergencyFundReadiness`, `renderLiquidityConcentration`, `renderDebtHistory`,
    `renderWealthAccountCards`, `renderWealthAllocationChart`. Also `/dashboard/credit`
    (`components/dashboard/DebtClient.tsx`) is a separate legacy Debt page outside Spaces.
16. **`DebtPayoffSection.simulatePayoff` is imported by three other modules**
    (`payoff-scenarios`, `debt-signals`, `debt-kpis` mirror its aggregate rules). The
    714-line component is also a shared calculation home.

---

## 12. Screens / components Chris should inspect manually

1. **Net Worth with all four metric chips** (`?metric=` netWorth / totalAssets /
   totalLiabilities / liquidNetWorth) — feel how much of the page already re-aims.
2. **Net Worth with no snapshot history** — the sidebar SECTIONS block disappears entirely.
   Decide whether that is the behaviour the new IA wants.
3. **Liquidity at a past As-of** — the Sources section swaps to reconstructed tier totals
   with delta chips while the hero stays present-day and says so.
4. **Investments over a 12-month window** — the excluded-positions disclosure, the
   "This period cannot be attributed" bridge state, and the 3-state chart legend
   ("Mostly unvalued" / "Evidence changes — not a market move" / "Never observed").
5. **Debt with everything paid off** (`hasDebt === false`) — Cost & risk and Payoff vanish
   but their sidebar rows remain.
6. **Cash Flow's Activity block** — calendar vs cards, the 9 measure filters, the
   Month/Quarter/Year drill, All-Time year nav. Densest interaction on Overview.
7. **Cash Flow / Spending perspective toggle** — it changes Net, Income and the calendar.
8. **Any chart point click** → the shared History Exploration sheet, then Back — the URL
   round-trip and the breadcrumb.
9. **A narrow window (<lg)** — no sidebar, therefore no section nav at all.
10. **"View as" currency override** — how each lens labels converted vs unconvertible
    figures, and the `CurrencyRevertedBanner`.
11. **Debt → Credit health inline editor** — the only place Overview writes data.
12. **Liquid NW row in `WealthHero`** → "→ Liquidity" — the only cross-lens jump.
