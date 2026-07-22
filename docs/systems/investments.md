# Investments

## Purpose

The Investments system answers two structurally different questions about a Space's
brokerage and crypto holdings:

1. **What do I hold right now, and what is it worth?** — the current portfolio.
2. **What did I hold as of a past date, what changed since an earlier date, and can I
   trust those figures?** — the historical / time-machine view.

These two questions are served by two independent code paths that **never
cross-derive** one another. Everything a consumer needs — current holdings, as-of
holdings, allocation, period flows, completeness, concentration, and trust — is
composed into one serialisable envelope, `InvestmentsSpaceData`, read through a single
loader.

## Authority

There are exactly two valuation authorities, split by time, plus one trust authority:

- **Current portfolio** — `getCurrentPositions()` in
  `lib/investments/current-positions.ts:87`. This is the "A10-at-today" seam: it
  composes the *same* valuation path as the time machine (`valuePositionRows` →
  `valuation-core`) but sources its rows through a cheap
  latest-observation-per-(account, instrument) read instead of scanning the full
  history window. It is deliberately incapable of As-Of / compare / period flows — a
  caller needing any of those is a time-machine caller.
- **Historical portfolio ("A10")** — `getInvestmentsTimeMachine()` in
  `lib/investments/investments-time-machine.ts:55`. The single replay / price / FX /
  valuation / reconciliation engine for any past date. It calls the canonical
  `getInvestmentValueAsOf` (`lib/investments/valuation.ts`) once at `asOf` and once at
  `compareTo`, reads canonical `InvestmentEvent` rows for period flows, and assembles
  via the pure `assembleInvestmentsTimeMachine`.
- **Trust / completeness** — `buildInvestmentsTrustSummary()` in
  `lib/investments/investments-trust.ts:166`. The single authority that reduces the
  A10 result's four scattered trust sub-shapes (portfolio completeness, per-holding
  tiers, flow honesty counters, reconciliation residual) into one
  `InvestmentsTrustSummary` that every surface renders rather than re-derives.

Neither valuation path is a second fact store: both are derived arithmetic over
persisted facts (`PositionObservation`, `InvestmentEvent`, price archive, FX).

## Inputs

- **Scope** — `{ spaceId }` or `{ financialAccountId }` (`CurrentPositionsScope`,
  `GetInvestmentsTimeMachineArgs`). A single account's Space supplies its reporting
  currency + FX context.
- **Resolved dates** — `asOf` (and optional `compareTo`), always resolved upstream by
  the Perspective Shell; neither authority owns preset/date state.
- **Persisted facts** — `PositionObservation` rows (latest-per-pair for current,
  full-window for historical), `InvestmentEvent` rows (period flows, filtered
  `deletedAt: null, supersededById: null`), the price archive + FX rates via the money
  layer, and `Instrument` display identity (symbol/name/assetClass/sector/isCash).
- **Visibility** — enforced *inside* the seams (KD-21a): member-facing position DETAIL
  is always scoped to detail-eligible (FULL) links, so a BALANCE_ONLY / SUMMARY_ONLY /
  REVOKED account exposes no positions and fails closed to empty.
- **Display currency** — an optional `ConversionContext` applied read-time (see
  Outputs / Invariants).

## Outputs

The canonical envelope `InvestmentsSpaceData` (`lib/investments/space-data-core.ts:89`):

```
{
  current:     CurrentPortfolio,          // always present
  historical?: HistoricalPortfolio,       // = A10 result verbatim, opt-in
  activity?:   PeriodFlows,               // = historical.flows re-surfaced
  trust?:      InvestmentsTrustSummary,   // = buildInvestmentsTrustSummary(historical)
}
```

`historical`, `activity`, and `trust` travel together and are present only when the
caller requests the historical view; `activity` additionally requires a comparison
window (else `historical.flows` is null and the field is omitted). A current-only read
populates just `current`.

The `investments/space-data` route additionally serves a `series` field — the
"Portfolio Value Over Time" points, built from the persisted `SpaceSnapshot` window
(see `lib/investments/portfolio-series.ts`), *not* from an N×date valuation sampler.

## Canonical contracts

- `InvestmentsSpaceData`, `CurrentPortfolio`, `HistoricalPortfolio` —
  `lib/investments/space-data-core.ts`.
  - `HistoricalPortfolio` is a **type alias for `InvestmentsTimeMachineResult`**
    (`space-data-core.ts:64`): the A10 result verbatim, deliberately reusing none of
    the current-position DTOs. The current↔historical boundary is *time, not data*.
  - `CurrentPortfolio` fields are `getCurrentPositions()` output verbatim (`asOf`,
    `reportingCurrency`, `holdings`, `portfolio`) plus one pure `computeAllocation`
    reduce; no valuation/FX/price math is created in the contract layer.
- **The one composition loader** — `loadInvestmentsSpaceData()` in
  `lib/investments/space-data.ts:136`. Orchestration only: it calls the current loader,
  optionally the A10 loader, and hands both to the pure `assembleInvestmentsSpaceData`.
  It computes nothing itself.
- `loadInvestmentsHistory` (`space-data.ts:74`) is a **named re-export of
  `getInvestmentsTimeMachine`** under its contract name, kept so the
  `/investments/time-machine` route stays JSON byte-identical. The composition loader
  reuses this *same* binding for the historical slice.
- `InvestmentsTrustSummary` + `buildInvestmentsTrustSummary` —
  `lib/investments/investments-trust.ts`.

**Why the composed envelope exists:** before it, every panel re-assembled the graph
itself and independently re-reduced the same raw trust fields into its own prose — the
Portfolio Header, the shell envelope, the Activity card, and the AI holdings assembler
each re-authored "N of M positions valued" / the caveat sentence. The envelope makes
one loader the single boundary: consumers read fields off it instead of rebuilding it,
so the four surfaces can never disagree.

## Persistence

The Investments system **owns no derived fact store** — it is pure computation over
facts other systems persist:

- `PositionObservation` (`prisma/schema.prisma:1353`) — one row per (account,
  instrument) observation; the position spine both valuation paths read.
- `InvestmentEvent` (`schema.prisma:1440`) — buys/sells/transfers/income/fees, the
  period-flow source.
- `PositionReconstruction` (`schema.prisma:1516`) — conflict flags consumed by
  valuation.
- `Instrument` (`schema.prisma:1294`) — display identity + allocation grouping fields.
- `SpaceSnapshot` (`schema.prisma:2157`) — the persisted per-date net-worth record.
  Its `stocks` and `crypto` columns feed the Portfolio Value Over Time series
  (`lib/data/snapshots.ts:78` maps `stocks → totalInvestments`, `crypto →
  totalCrypto`).

No route or loader here writes to any of these; ingestion/reconstruction is a separate
subsystem (`investment-event-ingest.ts`, `reconstruction-*.ts`).

## Consumers

- **Route** — `app/api/spaces/[id]/investments/space-data/route.ts` serves the composed
  envelope + the value series; `.../investments/time-machine/route.ts` serves the raw
  A10 result.
- **Workspace** — `components/space/widgets/investments/InvestmentsWorkspace.tsx` reads
  the envelope via `useInvestmentsSpaceData`, applies display-currency conversion, and
  emits its trust envelope up to the shell chip from the *unconverted* historical
  (trust is currency-agnostic).
- **Shared seams** — the AI holdings assembler, data export, and Connections health all
  read `getCurrentPositions()` directly (parity by shared source, not convention).
  `countCurrentPositionsByAccount` wraps it for a position-presence signal.

## Invariants

1. **Current and historical never cross-derive.** `current` comes only from
   `getCurrentPositions`; the as-of/compare view comes only from A10. Pinned in
   `space-data-historical.test.ts`.
2. **A10 is the only replay/valuation/FX/reconciliation engine** for past dates; the
   current seam physically cannot do As-Of.
3. **Crypto taxonomy split.** Crypto/digital-asset accounts are **excluded** from the
   `SpaceSnapshot.totalInvestments` (`stocks`) net-worth bucket but **included** in
   A10's investments holdings view. `getInvestmentValueAsOf`'s
   `excludeDigitalAssetAccounts` option (`valuation.ts:137`) is **opt-in and defaults
   OFF** using the canonical `DIGITAL_ASSET_ACCOUNT_TYPES`; only the A9 snapshot
   regeneration passes `true`, so a crypto position on the shared spine is valued once
   as a digital asset, never double-counted into net worth. A10, the AI holdings
   assembler, and `getCurrentPositions` all keep the default, so they surface crypto
   positions. Guarded by `valuation.investment-bucket.test.ts`. The Portfolio Value
   series therefore sums two disjoint buckets (`totalInvestments + totalCrypto`) so
   each asset is counted exactly once.
4. **Display-currency FX is a read-time transform, never a relabel.**
   `convertInvestmentsSpaceData` (`lib/investments/display-conversion.ts:152`) converts
   every reporting-currency money field through the one `convertMoney` authority;
   native instrument fields (`nativePrice`, `nativeValue`, `currency`, `costBasis`) and
   shares/weights/percentages stay untouched. A missing rate passes the native amount
   through flagged `estimated` — never a fabricated rate. When reporting === target the
   whole transform is identity (byte-unchanged all-USD path).
5. **One trust authority.** No surface re-derives "valued holdings" / "N of M positions
   valued" / the activity caveat; they read `InvestmentsTrustSummary`.
6. **The trust envelope is emitted from the *unconverted* result** (trust tiers are
   currency-agnostic).

## Known limitations

- The current seam accepts an injected `asOf` clock for determinism/parity, but it is
  *not* a historical portal — over the latest observation ≤ that date it yields
  "A10-at-`asOf`" with no compare/flows. Any genuine historical read must go through
  A10. `space-data-historical.test.ts` pins "asOf is only ever today here".
- `costBasis` is a native-denominated Plaid aggregate and is intentionally *never*
  FX-converted; consumers must not treat it as reporting-currency.
- The Portfolio Value Over Time series reuses persisted `SpaceSnapshot` rows rather than
  re-valuing per date, so its granularity and coverage are exactly whatever the
  snapshot history holds; `fxMiss` points are honestly dropped rather than interpolated.

## Extension points

- **New workspace slice** — add a field to `InvestmentsSpaceData`, populate it in the
  pure `assembleInvestmentsSpaceData`, and convert it in `convertInvestmentsSpaceData`.
  The exhaustiveness test forces every reporting-currency money field to be converted.
- **New consumer of current holdings** — call `getCurrentPositions()`; do not add a
  second position read (see `countCurrentPositionsByAccount` for the pattern of
  deriving from the one authority).
- **New trust indicator** — extend `InvestmentsTrustIndicator['key']` and emit it in
  `buildInvestmentsTrustSummary`; surfaces render the structured `indicators[]` list
  without authoring prose.
- **New account-type boundary** — extend `DIGITAL_ASSET_ACCOUNT_TYPES` in the canonical
  classifier; never hard-code a crypto list in valuation.

## Why the architecture is this way

The two-path split exists because "what I hold now" and "what I held then" have
genuinely different cost and correctness profiles: the current view must be cheap
(latest-observation read) and the historical view must be exhaustive (full-window
replay with reconciliation). Letting either derive from the other would either make the
current path pay for a history scan or make the historical path inherit the current
view's blind spots. Keeping them separate but valuing through the *same* core
guarantees they agree at today's date without coupling.

The composed envelope and single trust authority exist to end the duplication that
preceded them: multiple panels re-fetching and re-reducing the same facts drifted into
subtly different numbers and prose. One loader + one trust reduction makes disagreement
structurally impossible. The crypto taxonomy split is the resolution of a real
net-worth double-count bug — a crypto asset sits on the shared position spine, so it is
valued as a digital asset for net worth and as an investment holding for the
Investments view, but never summed into both.
