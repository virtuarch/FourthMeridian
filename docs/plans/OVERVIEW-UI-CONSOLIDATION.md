# Overview UI Consolidation — implementation note

**Clip:** `redesign(overview): consolidate net worth assets and debt`
**Authority for the prior state:** `docs/plans/OVERVIEW-UI-INVENTORY.md`
**Scope:** information architecture only. No financial authority, contract, engine,
endpoint or trust vocabulary changed. No widget deleted.

## Final IA

```
Overview
├── Net Worth                     (default; the `wealth` workspace)
│   ├── Total                     ?metric absent
│   ├── Assets                    ?metric=assets   (+ ?slice=cash|investments)
│   │   ├── Cash section          (the former Liquidity workspace, embedded)
│   │   └── Investments section   (the former Investments workspace, embedded)
│   └── Debt                      ?metric=debt     (the complete Debt workspace)
└── Cash Flow                     ?perspective=cash-flow  (unchanged)
```

Lens rail: `Net Worth | Cash Flow` (`CORE_LENS_IDS = ["cashFlow"]`).
Page-level selector inside Net Worth: `Total | Assets | Debt` — the evolved
`?metric=` WealthMetric mechanism (`lib/wealth/wealth-mode.ts`), promoted out
of the chart header to directly under the shell. Not a new navigation system.
Assets balance history: `All | Cash | Investments` (switchable single series,
`?slice=`), rendered in the chart's existing `headerRight` slot.

## What moved

| From | To | How |
|---|---|---|
| Liquidity lens | Net Worth → Assets → **Cash** section | `LiquidityWorkspace embedded` — same hook, same authorities. Hero becomes a compact section header; its own balance-history chart is omitted (the Assets chart slices to the identical `totalCash + totalSavings` series). Sources (present + reconstructed tiers), Resilience trio, What changed + Cash Flow doorway, unused-credit line, tx coverage caveat: all kept. |
| Investments lens | Net Worth → Assets → **Investments** section | `InvestmentsWorkspace embedded` — same hook, same contract. Compact hero; own chart omitted (the Assets chart slices to `stocks + crypto` **with** this lens's per-point confidence + "N of M positions valued" via `wealth-trend-points.ts`). Excluded disclosure, scope note, bridge, holdings, allocation (4 dimensions), concentration, activity, connections, empty state: all kept. |
| Debt lens | Net Worth → **Debt** mode | `DebtWorkspace` mounted whole (hero, chart, structural Liabilities ledger, Cost & risk, Payoff planner + scenarios, Credit health incl. the APR / min-payment editor). |
| Net Worth / Liabilities metric | Debt mode | superseded by the fuller Debt workspace |
| Net Worth / Liquid NW metric | Total hero secondary stat | series + calculation retained (`liquidNetWorth` still on every `WealthChartPoint`); no longer a page |

## What stayed

Total = the prior Net Worth page (hero, chart, composition, what-moved-it,
explanation/evidence) plus a secondary stat line (Assets · Liabilities · Liquid NW).
Cash Flow is byte-for-byte the same workspace and renderer entry.
`TrendChart`, `BreakdownWidget`, `TrustIndicator`, `EvidenceDrawer`,
`HistoryExplorationSheet`, all data hooks and all `space-data` routes: untouched.

## Duplicate wrappers removed vs preserved

Removed from the Assets page (information preserved elsewhere on it):
`LiquidityBalanceHistory` and `InvestmentsBalanceHistory` mounts (the unified
chart plots the same series), the two full-size heroes (now compact section
headers with the same figures, stats, verdicts and trust).
Preserved: everything else, including the per-section `TrustIndicator`s.
The wrapper components themselves still exist and still render in non-embedded
mode (nothing deleted).

## Trust / envelope

One shell envelope per mode: `WealthWorkspace` emits in Total/Assets;
`DebtWorkspace` emits in Debt (Wealth stays silent). The embedded Cash and
Investments sections have no `onEnvelopeChange` wired and keep their own
`TrustIndicator`s — mixed evidence is disclosed per figure, never flattened.

## Data gating

`WorkspaceDefinition.modeDataNeeds` (registry) + `openPerspectiveDataNeeds(tab,
id, mode)`. Total: accounts + snapshots. Assets adds transactions + lens +
investmentsHistory. Debt adds lens + fico. The embedded historical fetches
(`useLiquiditySpaceData`, `useInvestmentsSpaceData`, `useDebtSpaceData`) gate on
their mode being open, exactly as they gated on their lens before.

## Legacy URL behaviour

| Old | Resolves to |
|---|---|
| `?metric=netWorth` | Total |
| `?metric=totalAssets` | Assets |
| `?metric=totalLiabilities` | Debt |
| `?metric=liquidNetWorth` | Total (Liquid NW shown as a stat) |
| `?perspective=liquidity` | Assets, slice=cash, Cash section focused |
| `?perspective=investments` | Assets, slice=investments, Investments section focused |
| `?perspective=debt`, `?tab=debt`, `?tab=credit` | Debt |
| `?tab=investments` | Assets / Investments |
| `?perspective=wealth`, unknown ids | Net Worth default |

The URL self-heals to the canonical `metric=` / `slice=` form on arrival.

## Sidebar

Total: Summary · Balance history · Composition · What moved it · Explanation.
Assets: Summary · Balance history · Composition · What moved it · Cash · Investments
(only Cash · Investments while snapshot history is absent).
Debt: Summary · Balance history · [Liabilities] · [Cost & risk · Payoff] · Credit health —
bracketed rows publish only when their section renders (the pre-existing
absent-anchor bug is fixed). Scroll-spy was NOT added.

## Intentional remaining duplication

- Five heroes still exist as five components (compact variants added to two).
- The Cash section's "Within days" figure and the Investments section's holdings
  describe the same brokerage/crypto money under two vocabularies (settlement
  speed vs holdings) — carried as-is.
- The Assets hero's "Investments & crypto" ($stocks+crypto, snapshot) and the
  Investments section's "Valued holdings" (present-day valued positions only)
  are different authorities and can differ; both are labelled.
- `DebtPaymentsWidget` stays in Cash Flow.

## Deferred design decisions

- Whether Composition's institution / account / concentration modes belong on
  Assets or on the Accounts tab.
- Whether the Assets chart should overlay Cash + Investments as two lines.
- Whether Explanation should follow the mode (it is net-worth scoped).
- Auto-scroll on legacy-link arrival is best-effort (smooth scroll can be cut by
  late-arriving content); the sidebar row is lit regardless.
- Scroll-spy for the sidebar.
