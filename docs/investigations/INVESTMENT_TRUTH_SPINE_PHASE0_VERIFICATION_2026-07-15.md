# Investment Truth-Spine — Phase 0 Verification (LOCAL DB)

| | |
|---|---|
| Date | **2026-07-15** |
| Branch / HEAD | `feature/v2.5-spaces-completion` / `4074c75` (working tree dirty — pre-existing WIP preserved) |
| Database | **LOCAL DEV DB ONLY** — `postgresql://fintracker@localhost:5432/fintracker`. Not Preview/Production. |
| Nature | READ-ONLY. No writes, no migrations, no `--apply`, no Plaid/price-vendor API calls. |

Scope: verify whether the evidence-grade investment spine is being populated correctly locally, and what the intended deployment configuration should be. Covers P0-2A flag contract, P0-2B observation freshness, P0-2C BTC identity, P0-2D `investment_accounts`, P0-2E MI1 category divergence.

---

## P0-2A — Investment flag / config contract

All readers verified against source. **None** of these variables are declared in `lib/env.ts`'s snapshot — every one is read directly via `process.env.X` at its call site (this Phase 0 adds documentation-mirror declarations for the price/investment/AI vars — see P0-3A). All boolean flags use strict `=== "true"` (absent/anything-else = OFF).

| Variable | Source reader(s) | Default if absent | Gates | Local? | Preview rec | Prod rec | Secret |
|---|---|---|---|---|---|---|---|
| `INVESTMENT_OBSERVATIONS_ENABLED` | `lib/investments/position-capture.ts` (callers: `plaid/refresh.ts`, `plaid/exchangeToken.ts`) | `false` | dark-write `PositionObservation` capture from Plaid | ✅ set | `true` | `true` | no |
| `INVESTMENT_EVENTS_ENABLED` | `lib/investments/investment-event-ingest.ts` (same callers) | `false` | canonical `InvestmentEvent` ingest | ✅ set | `true` | `true` | no |
| `INVESTMENT_RECONSTRUCTION_ENABLED` | `lib/investments/reconstruction-runner.ts` | `false` | backward-walk DERIVED quantity history | ✅ set | `true` | `true` | no |
| `WEALTH_REGENERATION_ENABLED` | `lib/snapshots/regenerate-history.ts` | `false` | rewrite historical SpaceSnapshot investment component | ✅ set | `true` | `true` | no |
| `SECURITY_PRICES_ENABLED` | `lib/prices/capture.ts` (callers: `position-capture.ts`, `investment-event-ingest.ts`) | `false` | write `PriceObservation` from Plaid `close_price` | ❌ absent | **add `true`** | **add `true`** | no |
| `INVESTMENT_IMPORTS_ENABLED` | `lib/investments/opening-position.ts` + 5 route guards | `false` | manual investment/statement import surface (routes 404 when off) | ❌ absent | optional (`true` to test) | leave off until validated | no |
| `TIINGO_API_KEY` | `lib/prices/registry.ts` | registry has no vendor | registers Tiingo price adapter (historical/current) | ✅ set | present | present | **yes** |
| `COINGECKO_API_KEY` | `lib/crypto/btc-price.ts`, `lib/prices/providers/coingecko.ts` | crypto history flat | BTC/USD daily-close backfill | ✅ set | present | present | **yes** |
| `OXR_APP_ID` | `lib/fx/registry.ts` | Frankfurter/ECB fallback | primary FX provider | ✅ set | present | present | **yes** |
| `AI_OUTPUT_VALIDATION_MODE` | `app/api/ai/chat/route.ts` | `annotate` | AI numeric-claim enforcement (shadow/annotate/block) | ❌ absent (⇒ annotate) | leave unset or `annotate` | leave unset or `annotate` | no |
| `FLOWTYPE_SHADOW` | `lib/plaid/syncTransactions.ts` | `off` | optional non-PII flow-distribution log line ONLY | ❌ absent | leave unset | leave unset | no |

### Explicit answers

1. **`SECURITY_PRICES_ENABLED=true` in Preview?** **Yes.** Without it, the Plaid `close_price` capture path writes **zero** `PriceObservation` rows. To exercise the full evidence spine in a Plaid-connected Preview, enable it.
2. **In Production?** **Yes, for parity** once beta data flows. It is a pure additive capture switch — enabling it only adds observed price provenance; low risk. (Currently no users, so not urgent, but recommended when the other investment flags are on.)
3. **What breaks/stops if absent?** Only the Plaid-payload price capture (`captureSecurityPrices`) is skipped — no `PriceObservation` writes from that path. Nothing errors; the spine simply lacks Plaid-close price provenance.
4. **Does Tiingo behavior depend on it?** **No.** Tiingo historical/current fetch is gated **solely by `TIINGO_API_KEY` presence** (`lib/prices/registry.ts`) and does not consult `SECURITY_PRICES_ENABLED`. They are two independent price sources with two independent switches.
5. **Should `INVESTMENT_IMPORTS_ENABLED` be enabled now?** It gates the manual investment/statement import surface (routes 404 when off; writers return `status:"disabled"`). Off is the safe default. **Recommend: enable in Preview to exercise/validate the import flow; leave off in Production** until the import UI is validated and beta actually needs it.
6. **Where?** Preview yes (testing); Production not yet.
7. **Is `WEALTH_REGENERATION_ENABLED=true` correctly paired?** **Yes.** It is an independent kill switch that *consumes* the outputs of the observation/reconstruction/price pipeline (`regenerate-history.ts` reads `PositionObservation` + Tiingo/CoinGecko backfills). With observations enabled it has data to value; with them off it degrades gracefully (fewer rows) rather than erroring. The four investment flags being on together is consistent.

---

## P0-2B — Observation freshness / coverage (LOCAL)

Expected cadence: day-one `PositionObservation` capture on Plaid connect + resync (daily-ish), with reconstruction backfilling DERIVED history. Freshness bucketed by per-account latest observation age.

- investment/crypto `FinancialAccount`s (live): **14** (8 `investment`, 6 `crypto`)
- `PositionObservation`: total **54**, live 54
- latest observation date: **2026-07-14** (age **1 day**)
- accounts with ≥1 live observation: **3** → **coverage 21%**; never observed: **11**
- freshness buckets (per-account latest): `≤1d` 3, `2–3d` 0, `4–7d` 0, `>7d` 0
- by origin: `OBSERVED` 19 (source plaid), `DERIVED` 35 (source reconstruction)
- supporting: `Instrument` 23 · `InstrumentAlias` 21 · `InvestmentEvent` 41 (live)

**Verdict: LIVE but PARTIALLY POPULATED.** The observed accounts are fresh (≤1 day) and the spine is actively writing (OBSERVED + DERIVED both present), but only **3 of 14** investment/crypto accounts carry observations. The 11 unobserved are consistent with the crypto accounts (which write legacy `Holding`, not `PositionObservation` — see P0-2C) plus investment accounts that predate the observation writers or have no Plaid investment payload. This is a **coverage** gap, not a staleness or emptiness gap.

---

## P0-2C — BTC / crypto Instrument identity

**Source trace — three uncoordinated BTC `Instrument` minters, keyed disjointly (real duplication hazard):**

1. `lib/crypto/btc-price.ts` `resolveBtcInstrumentId()` — key `findFirst({ tickerSymbol:"BTC", assetClass:CRYPTO })`; creates the canonical `CRYPTO` row; **no `InstrumentAlias`**.
2. `scripts/backfill-position-observations.ts` — bootstraps an Instrument from every legacy `Holding`; key `InstrumentAlias{ provider:"bootstrap", externalId:"bootstrap:BTC" }`; creates `assetClass=UNKNOWN` for the BTC holding. Does **not** consult path 1 ⇒ would mint a **second** BTC row (`UNKNOWN`).
3. `lib/investments/instrument-resolver.ts` (Plaid) — weak fallback `findFirst({ tickerSymbol, marketIdentifierCode })`, ignores `assetClass`/`currency` ⇒ non-deterministic match or a third row.

Also: the wallet sync itself (`lib/crypto/btc-sync.ts` `writeBtcHolding`) writes **only** a legacy `Holding` (`symbol="BTC"`), never an `Instrument` or `PositionObservation`. The import resolver (`instrument-resolver-import.ts`) *refuses* (`conflict`) when a CRYPTO **and** UNKNOWN BTC row coexist — pre-existing duplicates would break BTC imports.

**LOCAL DB result:**

- BTC-like `Instrument` rows by assetClass: **`CRYPTO` = 1** (currency USD); no `UNKNOWN`/other BTC row.
- alias provenance: the single row has **no alias** (the price-cache path #1).
- legacy `Holding` rows `symbol='BTC'`: **5** (un-linked wallet positions, no `instrumentId`).

**Classification: SINGLE CANONICAL BTC locally — but code-level DUPLICATE RISK (NEEDS CONVERGENCE).** Today there is exactly one canonical `CRYPTO` BTC instrument, so no duplicate exists. However the bootstrap path has not run locally; if it (or a Plaid crypto payload) runs against these 5 un-linked BTC Holdings, it would mint an `UNKNOWN` duplicate because the minters share no canonical key. Convergence (single BTC resolution keyed on a normalized crypto identity, with an alias) is required **before** the bootstrap/backfill path is run in any environment, and crypto must eventually write `PositionObservation` rather than only legacy `Holding`.

---

## P0-2D — `investment_accounts` widget

- Registry: `lib/widget-registry.ts` (`key:"investment_accounts"`, `implemented:true`, OVERVIEW). Renderer: `SpaceDashboard.tsx` `WIDGET_RENDERERS["investment_accounts"] → InvestmentAccountsWidget`. Perspective: `lib/perspectives.ts` lists it under the `investments` perspective.
- **Reachability:** the `investments` perspective body is intercepted by a hard `activePerspectiveId === "investments" ? <InvestmentsPerspective/>` branch in `SpaceDashboard.tsx` **before** the generic virtual-section fallback, so `widgets:["investment_accounts"]` never reaches the renderer. No Space preset seeds a `SpaceDashboardSection` with this key (absent from `space-presets.ts` / templates). The header of `InvestmentAccountsWidget.tsx` labels itself "Slice B … no history" — superseded by the A10 `InvestmentsPerspective`.
- **LOCAL DB:** `SpaceDashboardSection` rows with `key='investment_accounts'`: **total 0, enabled 0**.

**Classification: DEAD CANDIDATE (dormant + unmaterialized).** Superseded by `InvestmentsPerspective`, unreachable via the perspective path, and never materialized. Safe to retire the registry entry + renderer + component later — **not in Phase 0** (no deletion performed here).

---

## P0-2E — MI1 / category latent divergence

- `TransactionCategory` enum has 22 values; the **six MI1 M1 additions** are `Medical, Entertainment, Transport, PersonalCare, Services, Education` (schema comment: "nothing writes them until M2").
- `BANKING_CATEGORIES` is defined identically in **four** places (`lib/ai/assemblers/transactions.ts`, `lib/data/transactions.ts`, `components/dashboard/widgets/transactions/transactions-filter-constants.ts`, `scripts/kd17-audit-jan-other.ts`) and **omits** all six.
- **No automated producer emits the six:** the Plaid mapper (`lib/transactions/plaid-category.ts`) and merchant rules (`lib/transactions/merchant-rules.ts`) can only yield the legacy set. Only `POST /api/transactions/[id]/correct` *accepts* the full enum (no UI picker surfaces the six).
- **LOCAL DB:** rows using `{Medical,Entertainment,Transport,PersonalCare,Services,Education}` = **0**. Categories actually present: Buy 31, Dining 1044, Dividend 9, Fee 121, Groceries 29, Income 126, Interest 98, Other 574, Payment 242, Sell 5, Shopping 668, Subscriptions 201, Transfer 483, Travel 627, Utilities 64 (all within/expected relative to BANKING_CATEGORIES + investment set).

**Classification: LATENT DIVERGENCE.** The vocabulary exists and `/correct` accepts it, but no writer/UI produces the six, so 0 rows carry them today — `BANKING_CATEGORIES` omitting them is currently harmless. It becomes an **ACTIVE** divergence the instant an M2 producer (or a UI) starts assigning them: such rows would silently vanish from the banking list, AI assembler row set, and filter overlay (4 constants to update in lockstep). Do not fix the population logic in Phase 0.

---

## Implications for Phase 1 / 2

- **Investment truth-spine convergence is a consumer-cutover problem, not a construction problem.** A1–A10 build is done and powers A10; the open work is migrating AI holdings assembler, export, Connections, and **crypto/BTC** off legacy `Holding` and onto the `PositionObservation`/`Instrument` spine, and enforcing SAL visibility in the A10 time machine (KD-21a).
- **BTC identity must converge before any bootstrap/backfill run** to avoid minting `UNKNOWN` duplicates against the 5 un-linked BTC Holdings.
- **Coverage (21%)** is expected to rise as crypto moves onto the spine and more Plaid investment payloads capture; it is not a defect by itself.
- `investment_accounts` and the MI1 `BANKING_CATEGORIES` omission are **tracked, not urgent** — retire/expand at their proper milestones.

## Requires later deployed-environment verification

- `SECURITY_PRICES_ENABLED` / `INVESTMENT_IMPORTS_ENABLED` presence in Preview/Production (Vercel) — recommended values above; not changed here.
- Observation coverage + BTC identity **in the deployed DBs** (only LOCAL was measured). Given the disposable-reset posture, these are best re-measured post-reset/migrate.

## Confirmation

Read-only throughout. No writes, no migrations, no `--apply`, no Plaid or price-vendor API calls. Temporary aggregate probes were deleted; no residue committed.
