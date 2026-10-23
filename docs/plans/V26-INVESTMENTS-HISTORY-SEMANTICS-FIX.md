# V26-INVESTMENTS-HISTORY-FIX — investigation and implementation record

Status: **period card and hero comparison FIXED. Chart segmentation NOT DONE.**

---

## 1 · Why $516.43 was selected

`InvestmentsHero`'s opening and the bridge's "Opening value" are the same number:
`reconciliation.openingValue = compareView.valuedSubtotal`, where `compareView`
is `getInvestmentValueAsOf({ asOf: "2026-01-01", holdConstantBeforeEarliest: true })`
(`investments-time-machine.ts:91`, `investments-time-machine-core.ts:317`).

Decomposed against the local corpus, that $516.43 is:

| | Amount |
|---|---|
| 12 long positions | **+$2,879.94** |
| 6 short positions | **−$2,363.51** |
| **net "opening value"** | **$516.43** |

It is not a portfolio value. Specifically:

- **The shorts are reconstruction artifacts.** TQQQ −20, NVDA −2.0057, JPM −1,
  NKE −4, INTC −5, TXN −1 — the QUANTITY-1B **B-4 dual-sign-convention** defect
  (`InvestmentEvent` stores BUY/SELL as magnitudes but TRANSFER_IN/OUT as
  negatives) surfacing as holdings. They offset real longs and shrink the
  denominator.
- **The two largest real positions are unvalued.** BTC (~$15.5k today) and the
  $471.15 cash account both return *"No RAW_CLOSE price within 7 days of
  2026-01-01"*. The opening is a partial subtotal over 18 of 20 holdings.
- **Not one quantity is observed.** Every tier is `estimated`, `derived` or
  `incomplete`; all quantities are projected backward from July observations by
  `holdConstantBeforeEarliest`. The earliest real `PositionObservation` is
  2026-07-19, first Plaid connect.
- **Every price is dated 2025-12-31**, the last close before the window opens.

## 2 · Why $18,918.98 was labelled portfolio change

`buildReconciliation` (`investments-time-machine-core.ts:309`):

```
totalChange      = closingValue − openingValue          = 19,918.98
residualChange   = totalChange − netExternalFlows       = 18,918.98
```

`investments-bridge.ts` then labels `residualChange` **"Portfolio change"**.

The residual is a balancing term. Here it is dominated by an
**estimated-to-observed basis transition**: the opening is 100% reconstructed and
partially unvalued, the closing is 10-of-11 observed and fully valued. The
difference between two different bases is not performance.

**The system already knew.** `buildReconciliation` computes
`endpointIncomplete: true`, `coverageConsistent: false` and
`changeInterpretation: "incomparable"` — all correct for this period. The hero
computed `totalChange / openingValue` (`InvestmentsHero.tsx:57`) without
consulting any of them; the bridge rendered the waterfall and demoted the guard
to a `caveat` string underneath. **The defect was not missing evidence. It was
discarded evidence.**

## 3 · Call graph (Phase 1)

```
InvestmentsWorkspace
└─ useInvestmentsSpaceData → GET /api/spaces/[id]/investments/space-data?asOf&compareTo
   ├─ loadInvestmentsSpaceData → getInvestmentsTimeMachine   (historical)
   │  ├─ getInvestmentValueAsOf(asOf)      ─┐ valuation = quantity × price × FX
   │  ├─ getInvestmentValueAsOf(compareTo) ─┘ both holdConstantBeforeEarliest: true
   │  │     └─ PositionObservation (incl. DERIVED) + PriceObservation RAW_CLOSE + FX
   │  ├─ getPeriodFlows → Transaction (external flows only)
   │  └─ assembleInvestmentsTimeMachine → buildReconciliation → **assessPeriodAttribution** (NEW)
   └─ getRecentSnapshots(1100) → buildPortfolioValueSeries    (chart — SpaceSnapshot)
        └─ value per point = snapshot.stocks + snapshot.crypto
```

Surfaces: **hero** (`portfolio.valuedSubtotal`, `totalChange`, `pct`) · **bridge
card** (`buildBridgeRows`) · **chart** (`buildPortfolioValueSeries`, a *separate*
source — `SpaceSnapshot`, not the valuation path).

## 4 · Reproduction (Phase 2), read-only

Every screenshot value reproduced exactly for Chris' Space:

| Field | Reproduced |
|---|---|
| headline | 20,435.42 |
| opening (2026-01-01) | 516.43 |
| totalChange / pct | 19,918.98 / **3857.0%** |
| netExternalFlows | 1,000.00 |
| money in / out | +1,050.00 / −50.00 |
| **residual "Portfolio change"** | **18,918.98** |
| endpointIncomplete | **true** |
| coverageConsistent | **false** |
| changeInterpretation | **"incomparable"** |

The same defect affects **every** preset, not just YTD: MTD showed 58.8%, 1M
65.8%, ALL 796.5% — all with reconstructed, partially-unvalued openings.

## 5 · The eligibility rule (Phase 3)

`lib/investments/period-attribution.core.ts` — pure, no Prisma/clock/React.
A causal decomposition may be shown only when **all** hold. Any refusal denies
`ATTRIBUTABLE`; this is a conjunction, not a score, because a decomposition that
is 80% supported is not 80% true.

| Refusal | Condition |
|---|---|
| `OPENING_ENDPOINT_INCOMPLETE` | holdings unvalued at the start |
| `CLOSING_ENDPOINT_INCOMPLETE` | holdings unvalued at the end |
| `OPENING_NOT_OBSERVED` | opening tier is not `observed` |
| `BASIS_CHANGED_ACROSS_PERIOD` | opening tier ≠ closing tier |
| `OPENING_CONTAINS_RECONSTRUCTED_SHORTS` | negative reconstructed positions offset the opening |
| `HOLDING_UNIVERSE_CHANGED` | the instrument sets differ |
| `FLOW_COVERAGE_INCOMPLETE` | flow completeness is not `observed` |
| `RECONSTRUCTION_CONFLICT` | a position carries a conflict |

Result union: `ATTRIBUTABLE` · `PARTIALLY_ATTRIBUTABLE` (opening defensible,
something else is not) · `NOT_ATTRIBUTABLE`. `portfolioChange` is populated
**only** when `ATTRIBUTABLE`, so a partial period cannot render it as
performance under any label. `mayShowReturnPercentage` gates the hero.

## 6 · Before / after

| | YTD | MTD | 1M | ALL |
|---|---|---|---|---|
| **before** pct | 3857.0% | 58.8% | 65.8% | 796.5% |
| **before** "Portfolio change" | +18,918.98 | +7,566.38 | +8,113.32 | +17,156.06 |
| **after** kind | NOT_ATTRIBUTABLE | NOT_ATTRIBUTABLE | NOT_ATTRIBUTABLE | NOT_ATTRIBUTABLE |
| **after** pct | withheld | withheld | withheld | withheld |
| **after** change badge | withheld | withheld | withheld | withheld |
| **after** "Portfolio change" row | **not rendered** | not rendered | not rendered | not rendered |
| **after** current value | 20,435.42 | 20,435.42 | 20,435.42 | 20,435.42 |
| **after** money in/out | 0 / 0 | 0 / 0 | 0 / 0 | +1,050 / −50 |
| **after** reasons shown | 5 | 5 | 5 | 5 |

Facts survive; claims do not. The closing value and observed flows still render.

## 7 · Changed files

- `lib/investments/period-attribution.core.ts` (new)
- `lib/investments/period-attribution.core.test.ts` (new)
- `lib/investments/investments-time-machine-core.ts` — assess once, expose `attribution`
- `components/space/widgets/investments/investments-bridge.ts` — `partial` / `not-attributable` states
- `components/space/widgets/investments/InvestmentsBridgeCard.tsx` — refusal rendering
- `components/space/widgets/investments/InvestmentsHero.tsx` — gated change + percentage
- `components/space/widgets/investments/InvestmentsWorkspace.tsx` — pass the one verdict to both

## 8 · Snapshots

**Not changed by this slice.** No regeneration was required: the defect is in
interpretation, not in stored rows. `SpaceSnapshot` is untouched (1683 rows
before and after every run).

## 9 · What is NOT done

- **Phase 4A — chart segmentation.** `buildPortfolioValueSeries` still connects
  every `SpaceSnapshot` point regardless of evidence state, and reads a
  *different* source from the hero/card (`snapshot.stocks + snapshot.crypto`,
  not the valuation path). The false continuous line is still drawn.
- **Phase 5 — full `getPortfolioHistoryView`.** The hero and card now share one
  verdict, but the chart is not yet a consumer of it.
- **Other surfaces** — Overview net-worth history, Net Worth Lens, investment
  table, Daily Brief, AI context and exports are unmigrated and may still
  present residuals as performance.
- **Browser verification** — blocked by local session state (see §10).

## 10 · Verification method

Rendered-state evidence was produced by invoking the real composition and the
real presentation models (`getInvestmentsTimeMachine` → `buildBridgeRows` /
`heroComparison`) against the local database, read-only.

Browser screenshots could not be captured: `/dashboard` throws
`No SpaceMember found` (`lib/space.ts:239`) because the local session is
authenticated as a user with zero ACTIVE `SpaceMember` rows. The database is
healthy (16 active memberships). Signing in as another user would require
entering credentials.
