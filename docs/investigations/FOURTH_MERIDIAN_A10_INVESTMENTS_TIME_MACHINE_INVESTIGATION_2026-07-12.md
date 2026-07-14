# Fourth Meridian — A10 Investments Time Machine: Investigation & Design

Date: 2026-07-12
Author: A10 session
Status: investigation complete; implementation in progress (slices 1–4)

Concurrent sessions active at authoring time: **A9 Wealth Regeneration** and the
**Perspective Shell / Wealth UI redesign** (P6). Their uncommitted surface is
fenced off (see §7).

---

## 1. The load-bearing discovery

A10-2's valuation engine already exists and has **no callers**.

`getInvestmentValueAsOf({ spaceId | financialAccountId, asOf })`
(`lib/investments/valuation.ts:74`) already composes, batched and N+1-free:

```
value(instrument, D) = quantityAsOf(D)  ×  priceAsOf(D)  ×  fxAsOf(D)
                       └ A4 resolvePositionAsOf   └ A8 PriceService   └ money ConversionContext
```

returning `InvestmentValuationView` (`valuation-core.ts:237`): a valued subtotal, an
explicit **unvalued remainder** (the "pixel rule" — a partial is never presented as
whole), per-instrument `InstrumentValuation` (quantityTier/priceTier/fxTier/overallTier,
`basisUsed`, `staleDays`, `reason`, `conflicted`), and a `completeness`
`{tier, conflict, reason, byInstrument}` over the canonical 5-tier
`CompletenessTier`.

**A10 consumes this. It does not rebuild replay, price lookup, FX, or valuation.**

## 2. Requirement classification

| A10 requirement | Classification | Canonical source |
| --- | --- | --- |
| Holdings/quantity as-of, tier, residual gaps | landed | `resolvePositionAsOf` / `getPositionQuantityAsOf` (`reconstruction-read.ts`) |
| Historical valuation, tiers, unvalued remainder, completeness | landed | `getInvestmentValueAsOf` → `InvestmentValuationView` |
| Portfolio total | landed | `valuePortfolioAsOf` |
| Composition shares | missing (trivial) | derived from valued subtotal |
| Security display identity (symbol/name) | extraction | `Instrument` join |
| Event → flow-category classification | missing | **new** `investment-flows-core.ts` |
| Period flows between two dates from canonical events | missing | **new** `investment-flows-core.ts` |
| Compare + reconciliation (opening + net external flows + residual = closing) | missing | **new** `investments-time-machine-core.ts` |
| Perspective-engine `LensId` lens | superseded/deferred | `LensResult` too narrow for holdings/flows; shell's `lib/perspectives/envelope.ts` reserves the `investments` slot for A10 to feed (P6 wires it) |
| Corporate-action *import* history | blocked on A7 | reconstruction inverts only stated-terms actions, else STOPS honestly; A10 inherits |

## 3. Canonical facts verified in code

- **Event enum** (`schema.prisma:1374`): BUY SELL CONTRIBUTION WITHDRAWAL TRANSFER_IN
  TRANSFER_OUT DIVIDEND INTEREST CAPITAL_GAIN REINVESTMENT FEE TAX SPLIT MERGER
  SPIN_OFF SYMBOL_CHANGE OPENING_BALANCE CANCEL ADJUSTMENT OTHER UNKNOWN.
- **Amount sign** (`plaid-investment-events.ts:171`, `schema.prisma:1410`): `amount` is
  FM-signed **+ cash in / − cash out**. Therefore
  `netExternalFlows = Σ amount` over `{CONTRIBUTION, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT}`.
- **Provenance-safe reads**: every canonical read filters `deletedAt: null,
  supersededById: null`. A10 replicates that filter for its event-window read
  (no shared "live events for account" helper exists yet).
- **Trust vocabulary**: `CompletenessTier` (`perspective-engine/types.ts:86`) +
  `worstTier`/`propagateCompleteness` (`completeness.ts`). A10 reuses these, never
  re-derives ordering.

## 4. Reconciliation — the honest, repository-backed identity

Buys, sells, income (dividends/interest/gains), fees, and corporate actions are all
**internal** to the portfolio boundary; their net effect on value already shows up in
`closing − opening`. Only money the user moves across the boundary is external.

```
Closing value
  = Opening value
  + net external flows        (Σ signed amount over CONTRIBUTION/WITHDRAWAL/TRANSFER_IN/TRANSFER_OUT, FX-converted at event date)
  + residual change           (market movement + FX + retained income + fees + reconstruction/valuation gaps)
```

`residual = closing − opening − netExternalFlows`. We do **not** compute a separate
"market gain" number: honestly separating market from FX from income-retained from
valuation gaps requires dollar-weighted, per-lot performance accounting the repository
does not support (A7 refuses tax lots; A6 price-vendor is the wave's one external
blocker). The residual is labeled with exactly what it bundles. Completeness of the
reconciliation is `worstTier(opening.tier, closing.tier)`; if either endpoint is
incomplete the residual is flagged untrustworthy.

Informational flow breakdown (contributions, withdrawals, transfers, income, fees,
buys, sells, unclassified) is surfaced separately but is never forced into the
market-vs-flow split beyond `netExternalFlows`.

**In-kind transfers** (a TRANSFER with a security quantity but null/zero cash amount)
move value without a cash leg; they are counted as explicit flow incompleteness so
their value effect is not silently misattributed to the residual as "market."

## 5. Architecture

Follows the codebase's dominant **pure-core + thin-binding** split (as in
`valuation-core.ts` / `valuation.ts`) and the Wealth read-model precedent
(`computeWealthTimeMachine`), but built entirely in Investments-owned files. It
receives resolved `{asOf, compareTo}` — it never owns preset/date state (the shell
owns those).

```
app/api/spaces/[id]/investments/time-machine/route.ts   (slice 4 — proving path)
        │  GET ?asOf&compareTo, membership-gated
        ▼
lib/investments/investments-time-machine.ts             (slice 3 — thin binding)
        │  getInvestmentValueAsOf(asOf) + getInvestmentValueAsOf(compareTo?)   ← A8/A4/FX (reused)
        │  read InvestmentEvent window (deletedAt/supersededById filter)       ← canonical events
        │  convert flow amounts via ConversionContext                          ← canonical FX (reused)
        │  join Instrument {symbol,name}
        ▼
lib/investments/investments-time-machine-core.ts         (slice 2 — pure)
        │  assembleInvestmentsTimeMachine(view, compareView?, flows?, displayMap)
        │  → ValuedHoldingRow[] + composition, InvestmentsReconciliation, completeness
        │
lib/investments/investment-flows-core.ts                 (slice 1 — pure)
           classifyEventFlow(type) + summarizePeriodFlows(events, from, to)
```

Each slice compiles and reverts independently; each has a fixture/guard test under the
repo's standalone-`tsx` convention (`scripts/run-tests.ts`).

## 6. Reused engines (no duplication)

- A4 replay — `resolvePositionAsOf` (via `getInvestmentValueAsOf`).
- A8 price — `PriceService` / `priceArchive` (via `getInvestmentValueAsOf`).
- FX — `convertMoney` / `ConversionContext` (via `getInvestmentValueAsOf` and the
  flow-amount conversion).
- Valuation — `getInvestmentValueAsOf` / `valuePortfolioAsOf`.
- Trust — `worstTier` / `propagateCompleteness` / `CompletenessTier`.

## 7. Concurrent-ownership fence (NOT edited by A10)

- `components/dashboard/SpaceDashboard.tsx` (uncommitted-modified)
- `components/space/shell/*` (PerspectiveShell, PerspectiveTabs, ShellContextRow,
  CompletenessPopover, EvidenceDrawer — new, uncommitted)
- `components/space/SharedHistoricalContext.tsx` (staged deletion)
- `lib/wealth/*` (A9)
- `lib/perspectives/*` incl. the just-created `envelope.ts`/`envelope.test.ts` (P6 —
  reserves the `investments` envelope slot for A10; P6 wires the swap)
- `lib/perspective-engine/types.ts` (`LensId` union)

## 8. Honest limitations & A7 prerequisites

- No market-vs-FX-vs-income split (needs performance accounting the repo lacks); folded
  into a labeled residual.
- In-kind transfer value not computed (surfaced as flow incompleteness).
- Imported statement values are not valuation anchors (A7-7 deferred); imported
  quantities flow through unchanged.
- Terms-unknown corporate actions truncate a position's history (A4 STOP); A10 inherits
  the truncation honestly.
- Reconstruction is gated behind `INVESTMENT_RECONSTRUCTION_ENABLED`; with it off,
  as-of reads fall back to OBSERVED/IMPORTED rows only (still honest).
