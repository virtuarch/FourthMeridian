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

### Known limitations and residual migrations (from the v2.6 consumer audit)

Carried from the v2.6 semantic consumer audit (audit baseline 2026-08-01; the working
plan was deleted per ADR-008, recover it with
`git log -- docs/plans/V26-SEMANTICS-CONSUMER-CONVERGENCE.md`). The audit found the
authorities (A10 `getInvestmentsTimeMachine`, `getCurrentPositions`,
`computeWealthTimeMachine`, `buildInvestmentsTrustSummary`, the valuation core) sound;
its findings are about consumers that bypass them. Status labels follow ADR-008.
Line numbers were re-read on `develop` at `42f99ea` (2026-11-03).

**Verified open on `develop` (re-read 2026-11-03):**

- **M4 — `attribution` escapes display-FX conversion. OPEN.** `convHistorical`
  (`lib/investments/display-conversion.ts:148-156`) spreads `...h` and converts
  `holdings`, `portfolio`, `flows` and `reconciliation` only. The A10 result still
  carries `attribution?: PeriodAttribution | null`
  (`lib/investments/investments-time-machine-core.ts:185`), so on a display-currency
  switch the hero delta and the bridge's partial / not-attributable state can show
  source-currency amounts under a display-currency label.
  `lib/investments/display-conversion.test.ts` has no reference to `attribution`, so the
  exhaustiveness guard does not cover the field. Fix: convert `attribution`, and make the
  test walk every money field of the result type (guardrail R3).
- **M5 — ungated percentage fallback in the hero. OPEN.** When `attribution` is null,
  `components/space/widgets/investments/InvestmentsHero.tsx:68` still computes
  `(change / opening) * 100` from `reconciliation`, the expression the attribution gate
  (`heroComparison`) was built to replace. `attribution` is still optional on the A10
  result (`investments-time-machine-core.ts:185`). Fix: make `attribution` required and
  delete the fallback branch (`InvestmentsHero.tsx:64-68`).
- **M7 — allocation recomputed client-side. OPEN.** The envelope already carries the
  server-computed, display-converted `current.allocation`
  (`lib/investments/space-data-core.ts`), but
  `components/space/widgets/investments/HoldingsConcentration.tsx:55` and
  `components/space/widgets/investments/InvestmentAllocationPanel.tsx:90` each call
  `computeAllocation(holdings, accountNames)` again in the browser, with account names
  taken from the `accounts` prop rather than the server's resolver. (`AllocationSliceDetail`
  no longer calls it; it reduces through the same key functions.) Fix: consume
  `current.allocation` / `share` and delete the client recomputes.

**Partial or tracked elsewhere:**

- **M3 — one crypto engine. PARTIAL.** IMPLEMENTED: the legacy `Holding` dual-write in
  `btc-sync` is retired (`lib/crypto/btc-sync.ts:235-240`), the
  `lib/investments/legacy-crypto-holdings.ts` bridge is deleted
  (`lib/ai/assemblers/holdings.ts:20`), and the A9 history writer resolves each wallet's
  asset from its chain instead of assuming BTC
  (`lib/snapshots/regenerate-history.ts:318-328`). OPEN: A9 still values crypto as today's
  `nativeBalance` held constant × that day's close
  (`regenerate-history.ts:309-316`), not through valuation-core over spine positions.
- **M1 — converge the today-snapshot writer. OPEN, tracked as FM-AUDIT-021**
  (`docs/audits/PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md`): today's row is written from
  live account balances as "observed" and is then frozen against history regeneration.
- **M13 — amendment preview = apply. OPEN, gated off.** The amendment route refuses while
  `HISTORICAL_AMENDMENT_ENABLED = false` (`lib/snapshots/amendment-availability.ts:28`,
  checked at `app/api/spaces/[id]/wealth/amend/route.ts:51`); the regression test pins the
  flag false (`lib/snapshots/amendment-whole-day.regression.test.ts:87`).
- **M10 — AI / Brief convergence. OPEN; in part KD-14** (`AiAdvice` has no production
  writer; see STATUS.md). The rest of M10 is not re-verified (below).
- **M14 — quantity authority `compare` → `adopt`. DECIDED BUT NOT IMPLEMENTED.**
  `QUANTITY_AUTHORITY_MODE` defaults to off; unset or unrecognised values mean off
  (`lib/env.ts:223-235`), and "adopt" must not be set in Production before the compare
  ledger is reviewed.

**NOT RE-VERIFIED (open until measured).** One line each so nothing is lost; each is the
audit's 2026-08-01 finding and may since have changed.

- M2 — wire `mayClaimObserved` (3-axis) + `assessRepresentativeness` into A9's write decision (were diagnostic-only).
- M6 — serve the portfolio series inside the `InvestmentsSpaceData` contract with a declared basis; render the today/history basis seam; guarantee endpoint points at `asOf` / `compareTo` or label the plotted range.
- M8 — move the per-holding return math out of `HoldingDetail` into a lib authority with tier / basis gates.
- M9 — move SpaceTrendHero, NetWorthChart (+ modal), `debt_history`, launcher cards and the `net_worth` / `investment_summary` sections onto `computeWealthTimeMachine` / `classifyAccounts` / `getCurrentPositions`; end the "view as" currency masquerade.
- M10 (remainder) — holdings assembler to consume `portfolio` + trust summary + scope divergence; snapshot reductions from `computeWealthTimeMachine`; count-as-days (3 sites) and hardcoded `$`; serialize snapshot / holdings windows and coverage; Brief "since" window honesty.
- M11 — one FX-miss policy for series across the display-conversion modules; missing `fxMiss` filters; replace fabricated `?? 0` zeros with honest absence.
- M12 — unify nearest-≤ resolution on `nearestOnOrBefore`; decide the staleness ceiling deliberately.
- M15 — Liquidity option profile: reconcile `holdConstantBeforeEarliest` with A9 / A10 or record the divergence as a tested decision.
- M16 — the snapshots route's local mid-sync check → `spaceHasSyncIncompleteProviderData`.
- M17 — fire snapshot regeneration from `opening-position` writes; run event ingest before A9 in `sync-banks` (or document the one-day lag at both sites).
- R1 — import bans: `components/**` may not import valuation, quantity, reconstruction, `classifyAccounts`, `computeAllocation`, `computeConcentration` or Prisma.
- R2 — expression tripwires under `components/**` (`/ opening) * 100`, `.slice(-`, `points[0]`, `new Date()` window math, `Intl.NumberFormat(`) with a shrink-only baseline.
- R3 — structural display-FX exhaustiveness walker over every money field (would have caught M4).
- R4 — single-writer snapshot guard: `spaceSnapshot.upsert|createMany` only in the A9 family.
- R5 — one-series guard: the series arrives inside the contract; the route adds no fields beyond it.
- R6 — nearest-≤ singleton: the resolution idiom allowed only in the primitive and the two archives.
- R7 — reason-vocabulary registry test mapping every refusal code into one vocabulary.
- R8 — AI parity tests: AI caveat strings `===` the trust-summary authors; scope-divergence disclosed beside `accounts.totalInvestments`.
- R9 — unit honesty: brand `SnapshotCount` vs `DayCount`.
- R10 — bucket-flag ratchet: register every `getInvestmentValueAsOf|ForWindow` call site's option triple.
- R11 — dead-honesty tripwire: every exported field of `WealthResult` / trust summary / view has a non-test consumer.
- R12 — enforce `implemented: false` in `SectionCard.renderBody()` with a test.

**PROPOSED — canonical ownership (one owner per financial fact; everyone else consumes
the object).** ⊕ = no owner exists yet.

| Financial fact | Owner (target) | Must never recompute it |
|---|---|---|
| Current holdings + valuation | `getCurrentPositions` | Investments page, AI holdings, Export, Connections counts, Dashboard / section / launcher "current" numbers |
| Historical quantity as-of | quantity authority (`decideQuantity`, mode adopt) | everything except valuation-core |
| Historical instrument value | `valueInstrumentAsOf` / `valuePositionRowsOverDates` | A10, A9, Liquidity splice (via their bindings only) |
| Historical portfolio (as-of, compare, flows, reconciliation, attribution) | A10 `getInvestmentsTimeMachine` | Investments page, AI, Brief, Reports (via `HistoricalPortfolioView`) |
| Portfolio value series | ⊕ one series builder with declared basis | Investments chart and hero |
| Opening / closing period values | `assessPeriodAttribution` + `buildReconciliation` | hero, bridge, chart endpoints, AI period claims; no `points[0]` rules |
| Portfolio gain / gain % | `heroComparison` gated by `mayShowReturnPercentage` | every surface; no local `(b − a) / a` |
| Per-holding return | ⊕ lib authority, tier- and basis-gated | `HoldingDetail` |
| Net worth (current) | `classifyAccounts`, with spine investments once converged | sections, AI accounts, snapshot writer |
| Net worth (historical, deltas, drivers, chart) | `computeWealthTimeMachine` | Wealth surfaces, SpaceTrendHero, NetWorthChart, launcher, Brief, AI snapshot reductions |
| Snapshot as-of resolution | `nearestOnOrBefore` | every hand-rolled nearest-≤ copy |
| Snapshot series read + FX stamping | `getRecentSnapshots`, with one shared fxMiss / estimated policy | all readers |
| Snapshot writing (all rows incl. today) | A9 `regenerateWealthHistory` + a converged today-writer | — |
| Snapshot write admission | `mayClaimObserved` + `assessRepresentativeness` | A9 writer |
| Price as-of | `priceArchive.readRange` semantics | valuation only |
| Price coverage / priceability | `coverage-binding.core` | jobs, acquisition planning |
| Event-stream coverage | `event-coverage.core` | quantity authority |
| Crypto valuation | valuation-core over spine positions | A9, A10, AI |
| Trust / completeness prose | `buildInvestmentsTrustSummary` (+ Wealth `completeness`) | UI chips, AI, Brief, Export |
| Scope divergence disclosure | `investmentsScopeDivergence` | Investments UI, AI, Brief |
| Concentration | `lib/investments/concentration.ts` | Investments, wealth adapters (no local HHI) |
| Allocation | server `computeAllocation` in the envelope | panels / widgets consume `share` |
| Money-in / money-out grouping | ⊕ one helper in `investment-flows-core` | bridge and activity cards |
| Display FX | `convertMoney` + per-domain display conversion, one miss policy | all |
| Liability sign | `amountOwed` (`balance-semantics.ts`) | AllocationChart |
| Period window (preset → asOf / compareTo) | `shellTimeReducer` / `compareToForPreset` | NetWorthChart intervals, SpaceTrendHero, launcher, AI windows |

**PROPOSED — `HistoricalPortfolioView` contract.** One immutable object per
(scope, period), assembled by one authority and read verbatim by every surface, AI
assembler, Brief section and export row that states a historical portfolio fact:

```
HistoricalPortfolioView {
  period             // ONE interval {fromISO, toISO, preset?} (today split across five shapes)
  opening            // {value, date, coverage, defensible}; null only with a reason
  closing            // {value, date, coverage}
  historicalSeries   // [{date, value, basis, estimated}]: one series, per-point basis, so the
                     //   today/history basis seam is a point attribute, not a silent step
  coverage           // valuation + price + event coverage mapped into one consumer vocabulary
  attribution        // PeriodAttribution: REQUIRED, display-FX-converted like every money field
  gaps               // [{fromISO, toISO, reason}] from quantity, price and snapshot holes
  unsupportedReasons // ONE reason vocabulary unifying the existing refusal / fallback enums
  gain               // from attribution; null carries a reason code
  gainPercent        // present ONLY when mayShowReturnPercentage; computed once, here
  valuationBasis     // portfolio rollup of per-row basisUsed
  quantityBasis      // OBSERVED_ANCHOR / REPLAYED / BACK_PROJECTED / HELD_FLAT rollup
  priceBasis         // RAW_CLOSE etc. + staleness envelope
}
```

A10 already produces most of this. The audit's deltas: make `attribution` required and
converted; serve the series behind the contract rather than beside it on the route;
surface `gaps`; unify the reason vocabularies; add the three basis rollups. `WealthResult`
is the same pattern for net worth and would need a real `coverage` object, an attribution
verdict gating `WealthDelta.pct`, and a consumer for its own `basis` field.

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
