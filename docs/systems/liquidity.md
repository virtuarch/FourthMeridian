# Liquidity

## Purpose

The Liquidity system answers "how much spendable money do I have, how reachable is
it, and how did that change over a window?" It powers the Liquidity Workspace inside
a Space: a live current-state anchor (accessible cash, emergency-fund readiness,
reachability, concentration) plus a temporal layer that reconstructs the liquidity
picture at any historical `asOf` and compares it against a `compareTo` date.

## Authority

`lib/liquidity/space-data.ts` (`loadLiquiditySpaceData`) is THE single historical-
liquidity authority. It is a server COMPOSITION over existing canonical reads and
introduces NO valuation, NO account classifier, and NO liquidity math of its own:

- `current` → `computePerspective("liquidity")` — the live liquidity lens, verbatim.
- `atAsOf` / `atCompareTo` → the SPLICE ENGINE (`evaluateHistorical`): a live
  per-account past reconstructed from `getAccountsAsOf` (`lib/data/accounts-asof.ts`)
  + `getInvestmentValueAsOf` scope `'all'` (`lib/investments/valuation.ts`, the A8
  price×qty×FX authority) → `spliceLiquidityRows` → the UNCHANGED pure
  `computeLiquidity` (`lib/perspective-engine/lenses/liquidity.core.ts`) → the
  UNCHANGED `buildLiquidityCompleteness`.

The ladder math lives entirely in `computeLiquidity`; the tier partition (cash /
marketable / illiquid / credit) lives inside it and is never re-derived elsewhere.
The splice (`lib/liquidity/historical-splice.ts:118`) REPLACES each covered
investment/crypto account's held-flat estimate with that account's A8 reporting
value and never adds a parallel total.

## Inputs

- `PerspectiveScope` `{ spaceId, userId }` (visibility is always the requester's).
- `asOf` / `compareTo` ISO dates from the SD-0B shell (`compareTo` must be earlier
  than `asOf`); omit both for a pure current-state read.
- Persisted facts, read through the canonical loaders only: account rows +
  transaction history (`getAccountsAsOf`, which reuses `lib/snapshots/backfill-core.ts`
  walk-backs), `PositionObservation` / `PriceObservation` (A8 valuation), and the
  Space conversion context (`buildSpaceConversionContextById`).

## Outputs

`LiquiditySpaceData` (`lib/liquidity/space-data-core.ts:68`):

- `asOf`, `compareTo`, `reportingCurrency` (the currency every endpoint is valued in).
- `current` — the live lens `LensResult` (always present, the anchor).
- `atAsOf` / `atCompareTo` — reconstructed `LensResult`s (null when not requested).
- `delta` — per-tier `(atAsOf − atCompareTo)`, a PURE subtraction. `net` = Δcash +
  Δmarketable + Δilliquid; credit is EXCLUDED from `net` (borrowing capacity is never
  liquidity). null unless both endpoints are present and `ok`.
- `trust` — the `atAsOf` endpoint's `completeness` re-surfaced (a POINTER, not a
  recompute); null on a pure current read.

## Canonical contracts

- `LiquiditySpaceData` / `LiquidityDelta` — `lib/liquidity/space-data-core.ts`.
- `assembleLiquiditySpaceData` — the PURE composition (delta, worst-of trust, shape);
  no DB, clock, or network.
- `spliceLiquidityRows` — the pure marketable-value splice (`historical-splice.ts`).
- `convertLiquiditySpaceData` — the pure display-currency transform
  (`lib/liquidity/display-conversion.ts`).
- Route binding: `GET /api/spaces/[id]/liquidity/space-data` serves the whole composed
  contract via `loadLiquiditySpaceData`; it computes nothing itself.

## Persistence

Read-only over existing tables — the system introduces NO table and NO migration.
Balances resolve from account rows walked back over transactions; marketable value
resolves from the shared `PositionObservation` spine via A8. There is no liquidity
store; every number is recomputed from canonical facts on read.

## Consumers

- `components/space/widgets/liquidity/LiquidityWorkspace.tsx` via the
  `useLiquiditySpaceData` hook. The workspace synthesizes the present-day contract
  from the host's already-fetched lens (no round-trip) and fetches the historical
  contract only when a past date / comparison is active.
- The four current-anchor widgets (Accessible Cash, Emergency Fund Readiness,
  Reachability, Concentration) read the visibility-filtered `accounts` array live;
  the temporal layer rides one panel (the Liquidity Ladder) plus the lede.
- The workspace emits its trust envelope up to the shell Completeness chip
  (`onEnvelopeChange` → `resolvePerspectiveEnvelope`).

## Invariants

- Crypto is counted exactly ONCE (structural): each account appears once in the
  `getAccountsAsOf` universe and once in the splice; an A8 value only ever REPLACES
  that one row's balance — there is no parallel digital-asset total to add. This is
  the guard against the historical net-worth double-count bug.
- Held-flat is preserved: an account with no A8 coverage at a date PASSES THROUGH with
  its `getAccountsAsOf` balance and tier; a balance-bearing account is never zeroed for
  lack of position evidence.
- Spliced investment rows are stamped in the reporting currency so they IDENTITY-
  convert downstream — never double-FX'd.
- Display FX is per-date and honest: each endpoint converts at its OWN date through the
  one canonical money authority (`convertMoney`); the delta is RECOMPUTED from the
  converted endpoints, never converted at a single rate. Identity when
  `display == reporting` (byte-identical). A missing rate degrades to an `estimated`
  (≈) flag — a silent symbol-only relabel is impossible.
- A delta's trust is the worst-of its two endpoints' envelopes; a comparison is only
  as trustworthy as its weaker end.

## Known limitations

- Trust/completeness is content-derived from the CONTRIBUTING accounts only: a withheld
  account's tier never leaks into the envelope. Tiers come from `getAccountsAsOf`
  (`observed` / `derived` / `estimated` / `incomplete`) propagated worst-wins by
  `buildLiquidityCompleteness`; an account with any unvalued instrument restamps to
  `incomplete`.
- Foreign-currency CASH at a historical date is FX'd at today's rate, not the as-of
  date's rate (a documented deferral in the server engine); marketable endpoints are
  per-date correct. Single-currency Spaces are exact.
- The lede `verdict` prose is left as the engine built it (a self-consistent reporting-
  currency sentence); the display-conversion pass converts numbers, not prose.
- `current` is intentionally NOT run through `convertLiquiditySpaceData` — its
  provenance is dual (already display-currency on the client path; not surfaced on the
  server historical path), so converting it would double-convert.

## Extension points

- To make foreign-cash FX per-date correct, thread the as-of date into the
  `buildSpaceConversionContextById` call inside `evaluateHistorical` instead of
  `now − 1`; the seam already targets the reporting currency.
- New account types flow through `liquidityComponent` (`asof-completeness.ts`) and the
  `computeLiquidity` tier partition — extend those, never the splice, which is driven
  purely by which accounts A8 produced components for.
- `LiquidityEngineDeps` is an injectable seam (`getAccountsAsOf`, `getInvestmentValueAsOf`,
  `buildCtx`, `computeCurrent`) so the engine is unit-testable DB-free.

## Why the architecture is this way

Liquidity is a temporal Perspective that must answer current, past, and comparison over
one window, but the lens lives under `lib/perspective-engine/` whose import-graph guard
forbids Prisma / valuation reads. The lens's as-of branch is therefore only the
cash/card reconstruction primitive; the honest marketable splice must live one level up,
as a server composition. The splice is a REPLACE (never an ADD) precisely because the
prior net-worth cliff was caused by valuing crypto as both an investment and a digital
asset — counting once is enforced structurally, not by convention. Keeping every number
sourced from A8 or the lens core (no second valuation authority, no second classifier)
is what lets the historical engine be trusted as a composition rather than audited as a
new calculation.
