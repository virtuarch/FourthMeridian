# Wealth

## Purpose

The Wealth system answers the whole-portfolio, point-in-time and over-time question:
*what was my net worth (and its composition) as of a date, how did it change since an
earlier date, and can I trust that answer?* It is the historical net-worth lens over a
Space — assets, liabilities, liquid net worth, asset-class composition, drivers of
change, and a deterministic plain-English explanation.

Unlike Investments, Wealth introduces no new valuation, pricing, or reconstruction: it
is a pure read model over the already-earned `SpaceSnapshot` series.

## Authority

- **`computeWealthTimeMachine()`** in `lib/wealth/wealth-time-machine.ts:225` — the one
  canonical Wealth read model. Pure, deterministic, no I/O: it derives the entire
  historical Wealth answer from an already-fetched `SpaceSnapshot` series plus the
  shell-owned time context (`asOf`, optional `compareTo`, display currency). Every
  number it returns is a field already present on a snapshot row (or a difference of
  two); it never regenerates snapshots, values a position, or invents attribution.

There is deliberately **no `WealthSpaceData` wrapper contract**. `WealthResult` (the
read model's own output type) *is* the canonical, durable Wealth boundary — adding a
second envelope around it would be a wrapper with no slices to compose, since Wealth
has exactly one authority and its snapshots are a Space-level shared resource, not a
Wealth-owned fetch.

## Inputs

`WealthTimeMachineInput` (`wealth-time-machine.ts:147`):

- **`snapshots: Snapshot[]`** — the persisted per-date series, fetched once at the Space
  level and *shared* (Overview and Debt read the same series). Wealth does not fetch
  them.
- **`asOf`** (YYYY-MM-DD) — the point-in-time state date.
- **`compareTo`** (YYYY-MM-DD | null) — the comparison endpoint and the chart-range
  start.
- **`currency`** — the display currency for composed copy and the formatted explanation.

Point-in-time answers resolve at the nearest snapshot **≤ the as-of date**
(`getSnapshotAsOf` semantics, applied client-side over the same series the charts read).

## Outputs

`WealthResult` (`wealth-time-machine.ts:119`):

- `asOfState` / `compareState` (`WealthState`) — resolved net worth, total assets,
  total liabilities, liquid net worth, and `WealthComposition` (cash / investments /
  crypto / real / liabilities) at each endpoint, plus `found` + `isEstimated`.
- `deltas` + `drivers` — signed change per metric and per composition component,
  populated **only when both endpoints are real** (found).
- `chart.points` — the metric series over the `[compareTo → asOf]` window (falls back
  to full history up to `asOf` when there is no comparison).
- `chart.compareSeries` — the equal-length overlay window ending at `compareTo`; empty
  unless the full window is real and within coverage (never padded or truncated).
- `completeness` — canonical tier (`observed` / `derived` / `incomplete`) + shell-ready
  label + tone.
- `evidence` — real provenance only (snapshot count); null when none.
- `explanation` — a deterministic, template-driven sentence (no LLM), present only when
  both endpoints are real.

## Canonical contracts

- `WealthResult`, `WealthState`, `WealthDeltas`, `WealthDriver`, `WealthChartPoint`,
  `WealthComposition`, `WealthTier` — all in `lib/wealth/wealth-time-machine.ts`.
- `WEALTH_CATEGORY_LABELS` (`wealth-time-machine.ts:56`) — the single source of copy for
  composition slices, legend rows, driver rows, and story text ("Real World Assets",
  never "Real Estate"). Presentation only; the backend enums/columns are unchanged.
- `WEALTH_EPSILON` (`:49`) — the sub-dollar noise floor; a category at/below it renders
  as no slice, no legend row, no driver.
- `convertWealthSnapshots()` — `lib/wealth/display-conversion.ts:74`, the display-FX
  transform (see Invariants).

## Persistence

Wealth **persists nothing** and owns no table. It reads `SpaceSnapshot`
(`prisma/schema.prisma:2157`) — the repository's earned historical net-worth record,
written by the snapshot regeneration subsystem, not by Wealth. The composition
categories map onto snapshot columns in `toState` (`wealth-time-machine.ts:159`): cash =
`totalCash + totalSavings`, investments = `totalInvestments` (snapshot `stocks`), crypto
= `totalCrypto` (snapshot `crypto`), real = `totalAssets − cash − investments − crypto`,
liabilities = `totalDebt`.

## Consumers

- **Workspace** — `components/space/widgets/wealth/WealthWorkspace.tsx` owns the
  composition: it receives shared snapshots + shell time + a `ConversionContext`,
  applies `convertWealthSnapshots`, calls `computeWealthTimeMachine`, and renders the
  five surfaces (Hero, Trend chart, Change ledger, Composition card, Explanation) plus
  the shell trust envelope via `onEnvelopeChange`.
- `components/dashboard/SpaceDashboard.tsx` also references the read model.
- The read model is UI-agnostic — any surface that has the snapshot series + a date
  context can call it.

## Invariants

1. **`WealthResult` is the boundary — no second envelope.** The read model's output *is*
   the durable contract.
2. **Display-currency FX converts the INPUT snapshots, not the result.**
   `convertWealthSnapshots` (`display-conversion.ts:74`) converts each snapshot at *its
   own date* through the one `convertMoney` authority **before**
   `computeWealthTimeMachine` runs. This is the deliberate opposite of Investments'
   result-transform: the Time Machine bakes per-date deltas *and* a pre-formatted
   `explanation` sentence into its output, so converting the result would leave that
   sentence's numbers (and currency symbol) wrong. Converting the source makes every
   figure and every sentence emerge already in the display currency from one uniform
   path. Identity fast-path when `from === target` (byte-identical all-same-currency
   path); stored snapshots are never mutated.
3. **By-class composition is time-sliced; non-class modes are not.** The "By class" mode
   shows the *historical* composition of the selected as-of snapshot. "By institution",
   "By account", and "Concentration" read **live accounts**, so they carry a permanent
   "Current classification" label and are never presented as belonging to the as-of date
   (`WealthCompositionCard.tsx:77`). This is an **honesty constraint, not a feature**:
   snapshots persist class-level totals only, so there is no historical
   institution/account breakdown to show — the label prevents a live breakdown from
   masquerading as history.
4. **Honesty rules baked into the read model** (`wealth-time-machine.ts` header):
   a date before coverage returns a shaped incomplete state (never zeros dressed as an
   observation); `isEstimated` snapshots surface as "Reconstructed", never "Observed";
   `fxMiss` (mixed-unit) points are dropped from the series; deltas, drivers, and the
   explanation appear only when **both** endpoints are real; drivers are real snapshot
   component deltas, never invented attribution.
5. **A missing FX rate does not smuggle a native magnitude.** In
   `convertWealthSnapshots`, a rate miss on a date flags that row `fxMiss`, which
   `computeWealthTimeMachine` then drops — a shorter honest series over a silently mixed
   one.

## Known limitations

- Wealth resolution is only as granular as the snapshot history: point-in-time answers
  snap to the nearest snapshot ≤ the requested date, and a date before coverage is an
  honest "no history" state.
- Only class-level composition is historical. Institution/account/concentration
  breakdowns are necessarily "current classification" because that dimension is never
  persisted per date (see Invariant 3).
- `real` ("Real World Assets") is a residual (`totalAssets − cash − investments −
  crypto`, floored at 0), so it absorbs any asset not captured by the explicit columns
  — it is a remainder, not an independently measured figure.
- When the snapshot from-currency is unknown, figures are labeled without conversion
  (`snapshotCurrency ?? display target`) rather than relabeled — no masqueraded
  conversion, but also no FX applied.

## Extension points

- **New Wealth metric or driver** — add a field derived from existing snapshot columns
  in `toState` / `computeWealthTimeMachine`; do not introduce a new fetch or fact store.
- **New composition category** — extend `WealthComposition` + `WEALTH_CATEGORY_LABELS`;
  the epsilon filter and driver logic pick it up automatically.
- **New presentation surface** — consume `WealthResult`; it is pure and UI-agnostic.
- **A genuinely historical institution/account breakdown** would require persisting that
  dimension per date in the snapshot record first — it cannot be added at the read-model
  layer while snapshots hold class-level totals only.

## Why the architecture is this way

Wealth is a **read model, not an authority**, because the expensive, error-prone work —
valuing positions, reconstructing balances, resolving FX at capture time — is already
done and persisted in `SpaceSnapshot`. Re-deriving net worth here would create a second
net-worth authority that could silently disagree with the recorded history. Instead
Wealth restates the earned record through a date lens.

`WealthResult` is the contract (rather than a wrapping `WealthSpaceData`) because there
is exactly one authority and one shared input — there are no slices to compose, so a
wrapper would add a layer without adding structure.

FX converts the input rather than the output uniquely here because the read model emits
a *formatted* explanation sentence: only by converting upstream do the sentence, the
deltas, and the chart all come out consistently denominated. And the "Current
classification" label on non-class modes is the visible edge of a persistence honesty
rule — the system refuses to imply a historical breakdown it never recorded.
