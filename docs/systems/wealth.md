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

## Manual real-world asset valuation history (RWA-2)

**IMPLEMENTED** — RWA-2A (`a5727b0`) and RWA-2B (`6d1a491`); migration
`20261015120000_rls_asset_valuations`. This is the one place Wealth's input series
carries a value that is not an observation, so the rules are recorded here. Status
markers as in the [documentation lifecycle](../README.md#documentation-lifecycle).

**What the user records** (a manual asset is a `FinancialAccount` with type `other` and
`syncStatus = "manual"`):

- On add: an optional acquisition date, an optional purchase price, an opt-in (default
  off) to use the purchase price as the asset's value on that date, a valuation date
  (default today) and a required current estimate.
- On update: a dated valuation is **appended** (`PATCH /api/accounts/manual/[id]`, body
  `{ balance, effectiveDate? }`); nothing is overwritten. The effective date may not be in
  the future or before acquisition.
- **Storage.** `AssetValuation` is an append-only ledger (effective date, value,
  currency, source `USER_ESTIMATE`, `recordedAt`, recorder) — append-only by grant:
  the tenant role may only `SELECT` and `INSERT`. `ManualAssetProfile` (1:1) holds the
  acquisition facts. Both use the account-subtree RLS predicate.

**One valuation policy for every reader** — the per-asset chart, the AI tools and the
history rebuild all call the pure resolver `valueOn` in
`lib/assets/valuation-series.core.ts`, so no two surfaces can describe an asset's past
differently. For day *d*:

| Day *d* | Result | Basis |
|---|---|---|
| before the acquisition date (else before the first anchor) | not held — `null` | — |
| after acquisition, before the first anchor | held but not valued — `null`, nothing invented | — |
| on an anchor date | that anchor's value | `recorded` |
| strictly between two anchors | linear interpolation in the asset's own currency, rounded to whole units | `modeled` |
| after the last anchor | the last anchor carried flat — **never extrapolated** (owner decision D-H4) | `carried` |

- **Anchors** are the user's valuations; the purchase price is an anchor **only** with the
  opt-in, and is otherwise shown as a fact, never as a market value.
- **Same-day corrections:** for one effective date the row with the latest `recordedAt`
  is the anchor; earlier rows stay stored as correction history and are never used.
- **Today's value:** `FinancialAccount.balance` equals the latest-effective-date anchor, so
  a backdated correction never changes today's balance.
- **Labels:** modeled values are labelled "modeled", never "valued", in the UI and to the
  AI. The AI receives recorded valuations plus a `modeledHistory` descriptor — never
  modeled points (`lib/ai/assemblers/accounts.ts`, `lib/ai/conversation/tools/snapshot.ts`).

**Privacy.** RLS lets any viewer of an ACTIVE link read these rows, including a
`BALANCE_ONLY` link, but valuation history discloses more than that tier allows. Every
application read is therefore additionally gated to the owner or a viewer holding an
ACTIVE **FULL** link; anyone else — and a missing asset — gets the same 404
(`GET /api/accounts/manual/[id]/valuations`, `lib/assets/valuations.ts`).

**Historical net worth (RWA-2B)** — the snapshot history engine values a manual asset
from the same resolver (`lib/snapshots/manual-asset-history.core.ts`):

- **Floor = the first anchor** (the acquisition date only when the purchase price was
  opted in). Held-but-unvalued days contribute nothing. In a shared Space the floor is
  also bounded by the date the asset was linked into it (`computeAccountFloors`).
- A modeled or carried day is an **estimate**: the stored row stays `isEstimated = true`.
  `SpaceSnapshot` has no "modeled" column, so the modeled distinction is re-derived at
  read time from the ledger (`lib/snapshots/real-asset-basis.core.ts`), and the Net Worth
  chart draws those days with the modeled basis.
- **Legacy assets** (created before RWA-2: no valuation rows, no profile) keep their
  pre-RWA-2B history byte-for-byte (floor = today), because applying the resolver would
  change existing estimated history without any user action — which the owner ruled out.
  The first recorded value turns the legacy balance into a ledger row and the resolver
  drives history from then on.
- **Frozen observed days are not rewritten automatically** (D-H1). A Personal-Space owner
  who adds history or backdates a valuation is offered "Update past net worth?": a dry-run
  preview of the affected range with before → after figures through the existing
  consent-based amendment route, applied only on explicit consent and never in a shared
  Space. Automatic range rebuilds stay behind `WEALTH_REGENERATION_ENABLED` (D-H2). The
  frozen-row and membership guards are unchanged.
- Today's snapshot is regenerated after an add, update, archive or restore
  (`regenerateSnapshotsForAccounts`), best-effort and non-fatal.

**Open items** (**PROPOSED**, not built): amendment day rows record per-component and
net-worth before/after but have no dedicated real-asset column; there is no asset↔loan
link, so equity display (a secured asset net of its loan) is a separate decision (RWA-3).

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
- The confidence chip maps the as-of row's resolved `completenessTier` only for the
  whole-row figures (Net worth, Total assets). Slices (Cash, Investments, Liquid NW,
  Liabilities) keep the legacy `isEstimated` rule, because the row tier is the worst
  across every component and per-component tiers are not stored — IMPLEMENTED
  (`components/space/trust/wealth-chip-tier.ts:28-37`).

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
