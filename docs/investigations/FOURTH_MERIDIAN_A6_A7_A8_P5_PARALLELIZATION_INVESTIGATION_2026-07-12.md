# Fourth Meridian — A6, A7, A8, and P5 Parallelization & Delivery Investigation

**Date:** 2026-07-12
**Branch:** `feature/v2.5-spaces-completion` (HEAD `922448e`)
**Type:** Architecture and implementation-sequencing investigation only. No code written, no files modified besides this report, no migrations, nothing committed.
**Governing inputs:** the A5/A4/P1–P4 parallelization investigation, the A5 Shared Perspective Engine investigation, and the Investment History Progressive Evidence plan (all 2026-07-11), superseded where noted by the direct repository audit in §2 below.
**Governing principle:** *"Did the data earn this?"*

---

## 1. Executive recommendation

**A6, A7, A8, and P5 cannot all start simultaneously as monoliths — but after one small spine commit (A6-1, the pricing contract + schema + read service) lands on the primary branch, four streams run genuinely concurrently with zero shared writable files.** The recommended topology is Option D (§8): a refined contract-first fan-out that also pulls P5's earliest capabilities *ahead* of A6/A7 instead of behind them.

The three findings that drive everything:

1. **The repository is ahead of the brief.** A5-S1/S2, P1, P2/P3, and A4-1/2/3 are all committed (`8cef352`, `002063f`, `d8271e6`, `8ed072f`, `fec9816`, `8597bdb`, `922448e`). The uncommitted working-tree change is A4-4 (`lib/investments/reconstruction-read.ts` + test) — the reconstruction read model, whose `getPositionQuantityAsOf` **is P5's quantity seam**. A5-S3/S4 (networth lens + shell as-of control) have not started and remain the current wave's primary-branch work. `PriceObservation` does not exist; `lib/prices/` does not exist.
2. **P5 is not one gate — it is four capabilities with four different prerequisites.** Flow history (contributions/withdrawals/dividends/fees) needs only landed A3 events. Holdings replay (quantities as-of) needs only A4-4. Valued portfolio history needs A6+A7. Regenerated long-horizon net-worth needs A8. Treating P5 as "gated on A4 + prices" (the A5 investigation's ruling) is now stale: two of its four capabilities are implementable the day A4-4 commits.
3. **A7 is less blocked than the plan assumed.** `PositionObservation` has carried `institutionPrice`/`institutionValue`/`institutionPriceAsOf` since A1 — on every observation date, valuation is answerable as **observed** with zero price infrastructure. A6 is needed for *between-observation* dates and pre-observation history. This means A7 hard-depends only on A6's *contract* (types + read interface), not on any vendor, and partial valuation is honest from day one.

**Topology in one line:** commit A4-4 → land A6-1 spine on primary → fan out `fm-a6` / `fm-a7` / `fm-a8` / `fm-p5` worktrees while primary finishes S3/S4/B4 → merge in the §6.3 order → one integration commit wires A8's triggers. The only external gate in the whole wave is price-vendor selection, and it blocks exactly one sub-slice (A6-3), nothing else.

---

## 2. Landed-state audit (brief §1)

### 2.1 Commits since the 2026-07-11 investigations

| Slice | Commit | Files |
|---|---|---|
| A5-S1 contract | `8cef352` | `lib/perspective-engine/types.ts` (+69: `asOf`, `CompletenessTier`, `Completeness`, `LensResult.completeness`), new `completeness.ts` (`COMPLETENESS_TIERS`, `isCompletenessTier`, `worstTier`, `propagateCompleteness`), `engine.test.ts` guards, `index.ts` threading |
| A5-S2 resolvers | `002063f` | new `lib/data/accounts-asof.{ts,core.ts,fixtures.ts,test.ts}` (per-row `{method, tier}`); `getSnapshotAsOf` in `lib/data/snapshots.ts:121` (stamp-aware, converts at the row's own date) |
| P1 lib | `d8271e6` | new `lib/transactions/cash-flow-compare.{ts,test.ts}` (`cashFlowStamp`, `compareCashFlow`) |
| P2/P3 | `8ed072f` | `lenses/{liquidity,debt}.ts` as-of bindings; new pure `lenses/asof-completeness.ts`; own test files `{liquidity,debt}.asof.test.ts` — cores untouched |
| A4-1 core | `fec9816` | new `lib/investments/reconstruction-core.{ts,test.ts}` (backward walk, stops, CANCEL matching, closed positions) |
| A4-2 persistence | `8597bdb` | `reconstruction-runner.{ts,test.ts}`, migration `20260712000000_add_position_reconstruction`, `PositionReconstruction` model (`schema.prisma:1456`) with the ratified job-outcome (`reconciliation`) vs trust-tier (`completeness`) split; write-time `assertCanonicalCompleteness` guard |
| A4-3 repair | `922448e` (HEAD) | bounded-repair hook in `investment-event-ingest.ts`, `scripts/run-reconstruction.ts` |

**Working tree (uncommitted): A4-4** — `lib/investments/reconstruction-read.ts` + test. Provides `describeReconstruction`/`toPositionHonesty` (honesty DTOs for B4) and `resolvePositionAsOf`/`getPositionQuantityAsOf` (latest non-superseded row ≤ date, origin precedence OBSERVED > IMPORTED > DERIVED > USER_ASSERTED, gap ⇒ `incomplete` never a fabricated 0). **This file is the P5 quantity seam and the A7 quantity input. Committing it is the first action of this wave.**

**Not started:** A5-S3 (`networth` lens — `LensId` is still `"liquidity" | "debt"`), A5-S4 (no `asOf` state in `SpaceDashboard.tsx`; the only time state is `cashFlowPeriod` at `:2595`), B4 badges, everything priced.

### 2.2 Contracts A6+ can now consume

| Contract | Where | What it gives the next wave |
|---|---|---|
| Canonical trust vocabulary + propagation | `lib/perspective-engine/completeness.ts` | `COMPLETENESS_TIERS`, `worstTier`, `propagateCompleteness`, `isCompletenessTier` — every A6/A7/A8/P5 tier is derived through these, never re-implemented |
| `Completeness` envelope + `asOf` on `ComputeOptions` | `lib/perspective-engine/types.ts` | The stamp every P5 answer carries; the kill-switch semantics (absent `asOf` ⇒ byte-identical) |
| Envelope builders | `lenses/asof-completeness.ts` | `buildAsOfCompleteness` pattern (per-bucket worst tier, deterministic reasons) — P5's envelope builder mirrors this, in its own file |
| Quantity-as-of | `lib/investments/reconstruction-read.ts` (A4-4, uncommitted) | `getPositionQuantityAsOf` — quantities with honest tiers; `PositionReconstruction` summaries with `earliestDefensibleDate`, residuals |
| Events | `InvestmentEvent` (`schema.prisma:1385`) + scheduled ingestion (`jobs/sync-banks.ts`, A3-4) | Dated, deduped, typed flows: CONTRIBUTION/WITHDRAWAL/DIVIDEND/FEE/BUY/SELL… — P5's flow history and A7/A8's external-flow decomposition input, accruing in production now |
| Observed same-day prices | `PositionObservation.institutionPrice/institutionValue/institutionPriceAsOf/costBasis` (`schema.prisma:1310`) | Observed valuation anchors at every observation date — A7 works before A6 has any data |
| Historical FX | `FxRate` (`schema.prisma:2268`), `lib/fx/{archive,service,config,fetch,registry,providers/}`, `jobs/fetch-fx-rates.ts`, `scripts/backfill-fx-rates.ts`, cron via `app/api/jobs/dispatch` | The **complete structural template for A6**: append-only archive, `@@unique([date,base,quote])`, walk-back `MAX_STALE_DAYS = 7` (`lib/fx/config.ts:17`), misses-as-values (`RateMiss`), request-scoped memo, provider failover registry, idempotent daily job, backfill script |
| Historical conversion | `lib/money/convert.ts` (`convertMoney(money, dateISO, ctx)` — walked-back ⇒ `estimated: true`), `getSnapshotAsOf`'s per-date stamp conversion | A7's FX leg exists; its estimation semantics are already ratified (walk-back ⇒ estimated) |
| Snapshot cache + walk-backs | `SpaceSnapshot` (`schema.prisma:2040`, `isEstimated`, `[spaceId,date]` unique), `lib/snapshots/regenerate.ts` (today-only upsert), `backfill.ts` (`BACKFILL_DAYS = 30`), `backfill-core.ts` | A8's substrate: rows are explicitly "cached projections"; `isEstimated=true` rows are regenerable, `false` rows frozen (plan §10, ratified) |
| P5 read path | `lib/data/investment-accounts.ts` → `lib/investments/current-holdings.ts` → `InvestmentAccountsWidget.tsx` | The current-state view P5 extends; documented "current-state only" — P5 adds a parallel as-of path, it does not rewrite this one |
| Timeline/simulation | `TimelineWidget.tsx` is the *activity* timeline; no `FinancialTimelineDiff`, no `Scenario`/`ForecastRun` | Unchanged: L4/L5 remain downstream consumers, out of this wave |
| Flags | `INVESTMENT_OBSERVATIONS_ENABLED`, `INVESTMENT_EVENTS_ENABLED`, `INVESTMENT_RECONSTRUCTION_ENABLED` (env-based, no framework) | The convention A6/A8 flags follow |

**Corrections to the governing docs:** (a) the A5 investigation's "P5 waits for A3 → A4 → prices" is now *partially* stale — quantities and flows are earned; only valuation still waits; (b) the parallelization investigation's §9 merge order steps 1–8 are complete or in flight except S3/S4/B4 — this report sequences the remainder; (c) the plan's Track D numbering (D1–D4) maps onto A6 (=D1+D2), A7 (=D3), A8 (=D4) with the amendments in §3–§5 below.

---

## 3. A6 Historical Prices (brief §3)

### 3.1 Ideal architecture: clone the FX stack, keyed by Instrument

The FX subsystem is a production-proven implementation of exactly the same problem (append-only daily value series, provider failover, walk-back reads, misses-as-values, idempotent cron + backfill). A6 should be a structural clone in `lib/prices/`, with these deliberate differences:

- **Identity is `instrumentId`, never a symbol.** Symbol changes, delistings, and reuse are already solved by `Instrument`/`InstrumentAlias` — the price series inherits that solution by construction. A price row never stores a ticker.
- **`basis` axis** (`PriceBasis`: `RAW_CLOSE | ADJUSTED_CLOSE | NAV | INTRADAY | CRYPTO_DAILY`) per plan §9: RAW_CLOSE is the canonical valuation series (a known historical quantity is valued at the price *as it was*); ADJUSTED_CLOSE never mixes into valuation; mutual funds NAV; crypto a stated UTC daily close. Unique on `[instrumentId, date, basis]`.
- **Provenance, not identity, per source** (`source` string — the `FxRate` doctrine): one canonical row per (instrument, date, basis); which provider supplied it is provenance.
- **Weekends/holidays are absent rows.** Reads walk back to latest ≤ asked within a staleness bound and stamp the result; never interpolate.

Rulings on the brief's specific concerns:

| Concern | Ruling | Grounds |
|---|---|---|
| Provider abstraction | `PriceProviderAdapter` interface + registry + failover chain, mirroring `lib/fx/registry.ts`/`fetch.ts`; a **fixture provider ships in A6-1** so every consumer is testable before a vendor exists | FX registry precedent; plan D1 "contract testable with fixture vendor" |
| Caching | The archive IS the cache (append-only, immutable for closed dates); request-scoped memo in the read service (the `createFxService` pattern). No second cache layer | `lib/fx/service.ts` memo design |
| Replay | Deterministic by construction: pure service over an immutable archive — "the same query returns the same answer in 2030" | FX service header, verbatim doctrine |
| Point-in-time lookup | `getPriceAsOf(instrumentId, dateISO, basis)` → exact row, else latest ≤ date within `PRICE_MAX_STALE_DAYS` (recommend 7, matching FX — covers weekends + long holidays), else a `PriceMiss` value | `MAX_STALE_DAYS = 7`; misses-are-values doctrine |
| Symbols vs identifiers | Resolution happens at *ingest* (vendor symbol → `InstrumentAlias` → `instrumentId`); reads are id-keyed. A vendor symbol that resolves to no Instrument is skipped and recorded, never auto-created (only *held* instruments earn price rows) | `MerchantAlias` refuse-on-ambiguity; "did the data earn this" |
| ETFs | RAW_CLOSE like equities; no special casing | plan §9 |
| Mutual funds | `NAV` basis; often no intraday; walk-back semantics identical | plan §9 |
| Crypto | `CRYPTO_DAILY` (UTC close). The BTC wallet path (`btc-sync.ts`) is *not* extended this wave — crypto valuation continues on its existing balance path | plan §4.2; scope discipline |
| Delisted securities | Rows retained forever; valuation after the delist date walks back only within the staleness bound, then `incomplete` — an honest "no price" | plan §9; §4.2 status DELISTED |
| Symbol changes | An Instrument concern (aliases), invisible to the price table | plan §9 |
| FX interaction | `PriceObservation.currency` is the quote currency; conversion happens downstream in A7 via the existing `ConversionContext`/`convertMoney` at the valuation date — A6 stores never-converted prices | `FxRate` separation; MC1 |
| Missing prices | Absent rows; tier degradation defined once in the read service: exact date ⇒ `observed`; walked-back ≤ bound ⇒ `estimated` (a flat-hold heuristic — matching `convertMoney`'s walked-back ⇒ estimated, and the S1 comment placing "FX walk-back miss" under estimated); beyond bound / never priced ⇒ `incomplete` | S1 vocabulary; `convertMoney` semantics |
| Confidence | The tier above + `basis` travel with every resolution; consumers propagate via `worstTier`, never re-derive | A5-S1 helpers |
| Provenance | `source` + `fetchedAt` on-row; same-day Plaid prices carry `source: "plaid"` | `FxRate` shape |

### 3.2 Does A6 split? Yes — three slices, and the split is what unblocks everything else

- **A6-1 — Contract + schema + read service (the spine commit, primary branch).** `PriceObservation` + `PriceBasis` migration (additive, the wave's only migration); `lib/prices/{types,config,archive,service}.ts` + fixture provider + fixture-tested walk-back/tier derivation. Zero vendor, zero network, zero UI. This is the fan-out gate: it freezes the pricing vocabulary exactly as A5-S1 froze the trust vocabulary.
- **A6-2 — Same-day observed price capture (worktree, no vendor).** Plaid already returns `Security.close_price`/`close_price_as_of` on every holdings fetch and on `investmentsTransactionsGet` securities payloads — both currently discarded (plan §2.2). A6-2 writes `PriceObservation(source: "plaid", basis: RAW_CLOSE)` rows from those payloads, behind `SECURITY_PRICES_ENABLED`, hooked where the securities payloads already flow (`position-capture.ts`, `investment-event-ingest.ts`). **Honesty rule:** a price is written only with a defensible date — `close_price_as_of` when present; absent ⇒ skip (never date a price "today" because it arrived today: MC1). This is A1's "stop the loss" doctrine applied to prices: coverage accrues from enable day forward, vendor or no vendor.
- **A6-3 — Vendor adapter + historical backfill + daily job (worktree, vendor-gated).** The one externally-blocked slice: adapter behind the A6-1 interface, `scripts/backfill-security-prices.ts` (per-instrument active windows: first observation/event date → today), `jobs/fetch-security-prices.ts` + dispatch route, mirroring the FX job's "fetch only what's missing, no-op re-runs". Vendor-selection gate: redistribution/derived-data licensing must permit persistent storage (plan §9, hard requirement).

---

## 4. A7 Historical Valuation (brief §4)

### 4.1 How positions and prices combine

`value(account, instrument, D) = quantityAsOf(D) × priceAsOf(D) × fxAsOf(D)`, each factor carrying its own tier, combined with `worstTier` — with **one precedence rule the plan didn't state but the data demands**: when a `PositionObservation` row exists at (or is the resolved row for) date D and carries `institutionValue`/`institutionPrice`, that observed valuation **is** the answer for that instrument at D (tier `observed`, FX still applied and still able to degrade it). The computed qty×price path covers all other dates. This makes A7 partially answerable the moment it lands, with A6 data only improving coverage between observations and before them.

### 4.2 Contracts

New pure module + thin binding (the repo's universal core/binding convention), owned by the A7 stream:

- `lib/investments/valuation-core.ts` — pure: `valueInstrumentAsOf(inputs) → { value: number | null, tier, basisUsed, staleDays, reason }` and `valuePortfolioAsOf(rows) → InvestmentValuationView`: per-instrument detail (`byComponent`), valued subtotal, **unvaluedCount + unvaluedQuantitySymbols**, overall tier = worst contributing tier, `conflict` OR'd from reconstruction summaries.
- `lib/investments/valuation.ts` — DB binding: `getInvestmentValueAsOf({ spaceId | financialAccountId, asOf })` reading `getPositionQuantityAsOf`/observation rows, the A6 price service, and `buildSpaceConversionContext` at the valuation date.

Rulings on the brief's specifics:

| Question | Ruling |
|---|---|
| Completeness | Per-instrument tier = `worstTier([qtyTier, priceTier, fxTier])`; portfolio tier = worst over instruments; `byComponent` keeps per-instrument detail, never collapsed (the `asof-completeness.ts` pattern) |
| Missing-price behavior | That instrument's `value: null`, tier `incomplete`, with a deterministic reason ("no price within N days of D") — the position still appears with its quantity; the number is never fabricated |
| Partial valuation | Always shaped: valued subtotal + explicit unvalued remainder; a partial total is **never** presented as the portfolio value styled observed (the pixel rule). Result tier `incomplete` whenever any held instrument is unvalued |
| Historical FX | Existing `convertMoney` at date D; walked-back FX ⇒ `estimated` (already implemented semantics) |
| Market holidays / weekends / gaps | Handled once, in A6's read service (walk-back + staleness tier) — A7 adds no calendar logic of its own |
| Pure or persisted? | **Pure — with persistence delegated to A8's existing cache.** Grounds: (a) the anti-`FinancialState` ruling — valuation is arithmetic over persisted facts (`PositionObservation`, `PriceObservation`, `FxRate`), not a new fact; (b) `SpaceSnapshot` is already the ratified space-day cached projection, and A8 exists precisely to fill it — a second valuation table would be a competing cache; (c) `RelationshipResolver` precedent: recomputed context, never rows. So: A7 pure/runtime; A8 persists space-level daily aggregates; no per-position valuation table this wave (revisit only if read volume proves the need — that evidence does not exist) |

A7's dependency surface is therefore: A4-4 (hard, committed first), A6-1 contract (hard), A6 *data* (runtime-only — fixture-tested green before any vendor), FX (landed), A5-S1 helpers (landed). It touches no engine files, no UI, no schema.

---

## 5. A8 Wealth Regeneration (brief §5)

### 5.1 Algorithm

For a space and date window: for each `SpaceSnapshot` row with `isEstimated = true` (and each *missing* day inside the window bounded by the space's earliest defensible data), recompute `stocks` (and the crypto component where instrument-backed) via `getInvestmentValueAsOf(spaceId, D)`; keep cash/savings/debt from the existing walk-back reconstruction (that is what wrote the estimated rows — `backfill.ts`); recompute the derived aggregates (`netWorth`, `totalAssets`, `netLiquid`, `cashOnHand`) with the same formulas as `regenerate.ts` (including its realAssets correction); upsert on `[spaceId, date]`.

Honesty rules (all ratified in plan §10, now made operational):

- **Frozen rows:** `isEstimated = false` rows are observations of what balances said that day — never touched. Enforced by a guard + a byte-identity test, not by convention.
- **Flag flip:** a regenerated row may flip `isEstimated` → `false` only when *every* component of that day reaches `observed`/`derived` — investment component tier from A7, cash/card from the walk-back tiers. Otherwise it stays `true` (the row improved; it did not become an observation).
- **Component-wise degradation:** worst-tier lives in the read path; the snapshot keeps its single flag (no new snapshot columns — zero-schema, per plan §10 "no schema growth until a consumer needs it").
- **Brokerage cash:** account value = Σ position values *including* the CASH-instrument position, never `balance + positions` (plan §10) — A8's investment component uses A7's portfolio view, which already includes cash positions.

### 5.2 The brief's questions

| Question | Answer |
|---|---|
| Incremental regeneration | Yes, and only incremental: regeneration always takes an explicit `{spaceId, fromDate, toDate}` window; no "regenerate everything" entry point exists |
| Bounded repair | Affected-window computation mirrors A4-3: a price backfill for instrument I, a reconstruction rerun, or an import rollback yields (instruments → accounts → `SpaceAccountLink` spaces) × [min affected date, next frozen row or today]; only estimated rows inside that window rerun |
| Replay strategy | Deterministic re-derivation, not versioned history: rows are cached projections; regeneration at any time recomputes from the same immutable facts. No `regenerationVersion` column — determinism is the version (and the bitemporal `KnowledgeVersion` trigger conditions remain unmet) |
| Persistence | Upserts into existing `SpaceSnapshot` only. Zero schema. |
| Trigger points | Three, all wired in a post-merge integration commit on primary, not from the A8 worktree: (1) after A6-3 backfill completes for instruments (script-level hook); (2) after A4 bounded repair rewrites a window (`reconstruction-runner` completion); (3) after investment-relevant daily sync (piggybacking the existing `regenerateSnapshotsForAccounts` call path). Plus the manual `scripts/regenerate-wealth-history.ts` |
| Validation | §10 below: frozen-row byte-identity; regenerated-row reconciliation against A7 at spot dates; monotone-improvement check (a regeneration never lowers a row's completeness) |
| Feature flags | `WEALTH_REGENERATION_ENABLED` (absent ⇒ zero writes), independent of the A4/A6 flags |
| Can regeneration operate independently of valuation? | The **framework** yes — the window/freeze/upsert core is pure and takes an injected per-day investment-value function (fixture-tested in parallel with A7). **Real regeneration no** — replacing flat-held investment components with valued ones is the entire point; without A7 there is nothing to regenerate *with*. This is why A8's worktree starts at fan-out (core) but merges after A7 (binding) |
| Can it regenerate only affected windows? | Yes — see bounded repair above; the frozen-row rule additionally caps every window |

Files: new `lib/snapshots/regenerate-history.core.ts` + `regenerate-history.ts` + `scripts/regenerate-wealth-history.ts`. **`regenerate.ts`, `backfill.ts`, `backfill-core.ts` are read-only imports** — the same sibling-file discipline S2 used for `accounts.ts`.

---

## 6. P5 Investments Time Machine (brief §6)

### 6.1 Capability decomposition and gates

P5 is four capabilities, not one feature:

| Capability | Needs A4 | Needs A6 | Needs A7 | Needs A8 | Needs S4/B4 (UI) | Earliest ship |
|---|---|---|---|---|---|---|
| **Flow history** — contributions, withdrawals, dividends, interest, fees per period (from `InvestmentEvent`, accruing since A3-4) | No | No | No | No | Yes (UI only) | **First** — right after S4/B4; lib is ready at fan-out |
| **Holdings replay** — quantities + composition (share-count weights) as-of; account drill-down; closed positions | **Yes (A4-4)** | No | No | No | Yes | Second |
| **Valued history** — portfolio value as-of, allocation by value, historical performance, contribution-vs-growth decomposition (`Δvalue = external flows + market-move residual`, plan §10) | Yes | **Yes** | **Yes** | No | Yes | Third |
| **Long-horizon charts** — regenerated net-worth/investment lines beyond observation coverage | Yes | Yes | Yes | **Yes** | Yes | Fourth |

Rulings on the brief's line items: **shared controls** — P5 consumes the single S4 `asOf` state via props, exactly as P1–P3; it introduces no date state (shell-seams guard applies). **Historical allocation** — by share count from holdings replay immediately; by value after A7. **Gains** — presented as the §10 decomposition (flows vs market move), the honest formulation. **Realized vs unrealized** — *refused this wave*: realized gains require lot-level cost basis, which no evidence source provides (plan: tax/cost-basis explicitly out of scope); unrealized may be shown against Plaid's aggregate `costBasis` where present, labeled provider-derived, never computed from invented lots (the Debt principal-vs-interest refusal precedent, applied verbatim). **Holdings replay** — `getPositionQuantityAsOf`. **Drill-down / account history / evidence** — event lists per (account, instrument, window) + `PositionReconstruction.evidenceRefs`, reusing the `TransactionSliceDrawer` drawer pattern. **Explanations** — `describeReconstruction` honesty lines (already written, A4-4). **Completeness presentation** — S1 envelope via a P5-owned builder mirroring `asof-completeness.ts`; user-facing copy only ("Reconstructed", "N shares unexplained before …", "No price within N days"), never tier names.

### 6.2 Not a lens (this wave)

The Investments perspective today is a widget read-model (`getInvestmentAccountsView`), not a registered lens; making it one would edit `types.ts`'s `LensId` union and `lib/perspectives.ts` — both primary-branch/A5-owned, merge-order-sensitive files. P5 therefore ships as **adapter + widgets over its own lib read model** (`lib/investments/investments-asof.*`), matching how Cash Flow participates without being a lens. Lensification is a separate later decision with its own justification burden.

---

## 7. Dependency graph (brief §2)

Key: **HARD** = hard prerequisite · **CONTRACT** = shared contract · **SCHEMA** = schema dependency · **RUNTIME** = runtime-data dependency · **FILE** = file overlap · **IND** = independent.

```
A4-4 commit (reconstruction-read — in the working tree today)
 └── HARD prerequisite of: A7 (quantity input), P5 holdings replay, B4

A6-1  Pricing contract + PriceObservation schema + read service   [SPINE, primary]
 ├── Instrument (landed) .............. HARD (satisfied)
 ├── prisma/schema.prisma ............. SCHEMA — the wave's ONLY migration
 ├── FX stack ......................... IND (template copied, never modified)
 └── HARD prerequisite of: A6-2, A6-3, A7 (price leg), A8 (via A7)

A6-2  Same-day Plaid price capture                                 [fm-a6]
 ├── A6-1 ............................. HARD
 ├── position-capture.ts, investment-event-ingest.ts  FILE (A6-owned
 │        this wave — free after A4-4 commits; hooks only)
 └── vendor ........................... IND (none needed)

A6-3  Vendor adapter + backfill + daily job                        [fm-a6]
 ├── A6-1 ............................. HARD
 ├── vendor selection ................. EXTERNAL GATE (licensing check)
 └── app/api/jobs/dispatch route ...... FILE (A6-owned, sole writer)

A7    Historical valuation (pure core + binding)                   [fm-a7]
 ├── A4-4 ............................. HARD (quantity-as-of)
 ├── A6-1 ............................. HARD (contract only)
 ├── A6-2/A6-3 data ................... RUNTIME (fixture-green before any data;
 │                                       observed-anchor valuation works day one)
 ├── FX / convertMoney ................ HARD (landed)
 ├── A5-S1 helpers .................... CONTRACT (import only)
 └── A8, P5-valued .................... is HARD prerequisite of both

A8    Wealth regeneration                                          [fm-a8]
 ├── A7 DTO ........................... HARD for the binding; the pure core
 │                                       takes an injected valuation fn (IND)
 ├── A6-3 backfill data ............... RUNTIME (real long-window runs)
 ├── SpaceSnapshot / backfill-core .... IND (read-only imports)
 ├── regenerate.ts .................... IND (formulas mirrored, file untouched)
 └── trigger wiring ................... FILE — deferred to ONE integration
                                         commit on primary (never from worktree)

P5-1  Flows + quantity adapter (lib)                               [fm-p5]
 ├── A3 events (landed), A4-4 ......... HARD
 ├── A6/A7/A8 ......................... IND — zero coupling
 └── S1 helpers ....................... CONTRACT (import only)

P5-2  Valued portfolio lib                                         [fm-p5, after A7 merges]
 ├── A7 ............................... HARD (rebase onto primary post-merge)

P5-UI (all widgets/adapters)                                       [primary only]
 ├── A5-S4 shared asOf control ........ HARD (current wave, in progress)
 ├── B4 badge conventions ............. HARD (consumes A4-4 DTOs)
 └── SpaceDashboard.tsx ............... FILE — single owner: primary, always
```

**What cannot be parallelized:** A6-1 with anything (it is the spine); A7's merge before A6-1; A8's *binding* before A7's DTO; every UI phase before S4; the A8 trigger wiring (one integration commit, after both A6 and A8 merge). **Everything else runs concurrently.**

---

## 8. Implementation topology (brief §§7–8)

### Option A — Fully sequential A6 → A7 → A8 → P5

Slowest (~4 serial streams); actively wrong twice: it puts P5's flow/quantity capabilities — which need *nothing* from A6/A7/A8 — at the back of the queue, and it lets the external vendor gate (A6-3) block the entire wave. Zero merge risk is not worth either.

### Option B — A6 foundation → parallel {A7, A8} → P5

Directionally right, two flaws: A8's real work depends on A7's DTO (so "parallel A7/A8" silently serializes unless A8's core/binding split is made explicit), and P5 is again last despite two of its capabilities being ready at fan-out.

### Option C — Contract-first, multiple worktrees, defined merge order

Correct mechanics (proven by the last wave). As stated it still treats P5 as one late stream.

### Option D — **Recommended:** contract-first fan-out with P5 pulled forward and A8 split core/binding

```
primary (feature/v2.5-spaces-completion):
  commit A4-4 → commit A6-1 (spine) → S3 → S4 → B4 + P5 flows/quantity UI
  → merges per §8.1 → integration commit (A8 triggers + P5 valued UI)

git worktree add ../fm-a6 -b feature/a6-historical-prices    <A6-1 commit>
git worktree add ../fm-a7 -b feature/a7-historical-valuation <A6-1 commit>
git worktree add ../fm-a8 -b feature/a8-wealth-regeneration  <A6-1 commit>
git worktree add ../fm-p5 -b feature/p5-investments-asof     <A6-1 commit>
```

All four worktrees branch from the A6-1 commit; all rebase only onto primary, never onto each other (last wave's rule, kept). A8 builds its pure core immediately and binds to A7's DTO after A7 merges to primary (rebase, one small commit). P5-1 needs only A4-4+events and is mergeable before any pricing exists.

Speed: the wave's wall-clock is max(primary S3/S4/B4, A6, A7) instead of their sum — ~2.5–3× Option A, and user-visible P5 value arrives *first* rather than last. Merge risk: low by construction (§9 — no two streams write one file). Drift risk: low — pricing vocabulary frozen in A6-1; trust vocabulary already frozen (S1); valuation DTO frozen at A7's first commit. Rollback: every stream additive + kill-switched (`SECURITY_PRICES_ENABLED`, `WEALTH_REGENERATION_ENABLED`, absent-`asOf`, absent price rows ⇒ shaped incomplete).

### 8.1 Exact chronological merge order

1. **Commit A4-4** on primary (the uncommitted read model — with its test).
2. **Commit A6-1** on primary → fan out all four worktrees.
3. **A5-S3** (networth lens), **A5-S4** (shell as-of control) on primary — current wave, unchanged plan.
4. **Merge `fm-p5` (P5-1 lib)** — flows + quantity adapter; no pricing coupling; rebases trivially.
5. **B4 + P5 flows/quantity UI** on primary (badges, "history since", event history, holdings replay behind the shared control).
6. **Merge `fm-a7`** — fixture-green; runtime-honest (returns shaped incomplete where no price/quantity data yet).
7. **Merge `fm-a6` stage 1 (A6-2 capture)** — same-day prices start accruing. *(Stage 2, A6-3 vendor, merges whenever the vendor clears licensing — it gates nothing else.)*
8. **Rebase `fm-p5` → P5-2 valued lib → merge**; valued UI on primary.
9. **Merge `fm-a8`** (core + binding, flag off) → **integration commit on primary** wiring the three A8 triggers + enabling dark runs.
10. **Real-data validation** (§10 order), then flags on.

Steps 4–7 are order-flexible among themselves except: P5 UI (5) after S4 (3); A8 (9) after A7 (6). If the vendor arrives early, 7-stage-2 can precede 8.

---

## 9. File ownership matrix (brief §9)

Legend: **P** = primary branch · **A6/A7/A8/P5** = worktree streams · R = read-only import · W = writes.

| File / surface | Owner | Who else touches | Risk |
|---|---|---|---|
| `prisma/schema.prisma` + migration `add_price_observation` | **P (A6-1 spine)** | nobody — sole migration of the wave | none (serialized on primary) |
| `lib/prices/**` (new: types, config, archive, service, providers, fixtures, tests) | **A6** (contract files born in A6-1 on P, then A6-owned) | A7/A8/P5: R | none |
| `lib/investments/position-capture.ts`, `investment-event-ingest.ts` (price-capture hooks only) | **A6** (A6-2) | A4 stream finished at A4-4 — free | low; hooks are additive, flag-gated |
| `jobs/fetch-security-prices.ts`, `app/api/jobs/fetch-security-prices/`, dispatch route edit, `scripts/backfill-security-prices.ts` | **A6** (A6-3) | nobody | none |
| `lib/investments/valuation-core.ts`, `valuation.ts` (+tests, new) | **A7** | A8/P5: R after merge | none |
| `lib/investments/reconstruction-read.ts` | **P** (A4-4 commit), then frozen | A7/P5/B4: R | **merge-sensitive until committed — commit first** |
| `lib/snapshots/regenerate-history.core.ts`, `regenerate-history.ts`, `scripts/regenerate-wealth-history.ts` (new) | **A8** | nobody | none |
| `lib/snapshots/{regenerate,backfill,backfill-core}.ts` | — | all: R only | **do not modify** (sibling-file rule) |
| `lib/investments/investments-asof.core.ts`, `investments-asof.ts`, own test files (new) | **P5** | nobody | none |
| `lib/investments/reconstruction-runner.ts` (A8 trigger hook) | **P (integration commit)** | never from a worktree | (M) — one commit, post-merges |
| `lib/perspective-engine/types.ts`, `completeness.ts`, `engine.test.ts` | **P (A5)** | all four streams: R only | HIGH if violated — forbidden-files lists enforce |
| `lib/perspectives.ts` | **P (A5-S3)** | nobody else | none |
| `components/dashboard/SpaceDashboard.tsx` | **P** (S4, then P5/B4 UI phases) | never a worktree | HIGH (M) — single owner at all times |
| `components/space/widgets/InvestmentAccountsWidget.tsx`, new investment TM widgets, `AsOfControl`/`CompletenessBadge` | **P** (post-S4) | worktrees: never | (M) serialized on primary |
| `lib/data/investment-accounts.ts`, `lib/investments/current-holdings.ts` | **P** (B4/P5-UI phase, additive) | worktrees: R | low |
| `lib/fx/**`, `lib/money/**`, `lib/data/accounts*.ts`, `lib/transactions/**`, `lib/plaid/**` | — | all: R only | untouched by every stream |

Ownership by concern (brief's list): **schema** = A6-1 on primary, exclusively. **Pricing** = A6. **Valuation** = A7. **Registry files** (`types.ts`, `perspectives.ts`, lens registry, dispatch route) = primary, except the dispatch route entry which is A6-3's one registry edit (sole writer). **UI** = primary, always. **Merge-sensitive** = `SpaceDashboard.tsx`, `reconstruction-read.ts` until committed, `reconstruction-runner.ts` (integration commit only). No file has two concurrent writers.

---

## 10. Validation strategy (brief §10)

- **Unit tests / fixtures:** A6 — fixture provider + golden walk-back tests (exact hit, weekend walk, holiday walk, beyond-bound miss, delisted tail, NAV vs RAW_CLOSE never mixing, per-basis uniqueness); fixtures live in `lib/prices/` and are **reused by A7/A8, never forked** (the S2 fixture doctrine). A7 — tier matrix (observed anchor / derived qty × estimated price / missing price ⇒ incomplete), partial-portfolio shapes, FX degradation, determinism (fixed clock + asOf ⇒ byte-identical JSON). A8 — frozen-row guard (a run over a window containing `isEstimated=false` rows writes zero bytes to them — asserted, not assumed), flag-flip rule, window bounding, injected-valuation core tests. P5 — envelope derivation, refusal shapes (realized gains), flow bucketing vs independent recomputation.
- **Cross-stream reconciliation invariants (the load-bearing checks):** (1) **valuation-vs-observation:** for any date with a `PositionObservation` carrying `institutionValue`, `getInvestmentValueAsOf` reconciles with Σ institutionValue within monetary epsilon — ties A7 to ground truth; (2) **regeneration-vs-live:** for today, A8's recomputation reconciles with `regenerate.ts`'s live row within epsilon — proves formula parity; (3) **snapshot-vs-resolver** (existing S2 invariant) re-run at every merge.
- **Kill-switch byte-identity, re-run at every merge:** flags off + no `asOf` ⇒ every existing lens, widget, snapshot row, and the full suite byte-identical. Enabling `SECURITY_PRICES_ENABLED`/`WEALTH_REGENERATION_ENABLED` changes zero bytes of Cash Flow / Liquidity / Debt results (the non-contamination test pattern from the last wave).
- **Price-gap validation:** a deliberate fixture instrument with a 3-week hole: valuation inside the hole must degrade estimated→incomplete exactly at the staleness bound; the P5 chart renders the gap (no interpolated line — browser check).
- **Historical/real-data validation order:** (1) A6-2 capture on the real brokerage (16 positions): one price row per priced security per refresh day, dated by `close_price_as_of`, idempotent re-runs; (2) A7 spot-checks on observation dates (invariant 1) and between-observation dates (tier `estimated`/`derived`, never observed); (3) A6-3 backfill for held instruments' active windows, then A7 across the reconstructed window; (4) A8 dark run on a bounded window: estimated rows improve, frozen rows byte-identical, re-run idempotent; (5) P5 browser pass — control, badges, gaps, drill-downs, "N shares unexplained" copy.
- **Performance validation:** valuation of one space (16 positions) at one date ≤ 1 query per table (batched reads — no per-instrument N+1: the walk-back read uses one windowed `findMany` per table, resolved in memory); A8 regeneration of a 30-day window bounded and measured; price backfill paginates per the FX backfill script's pattern.
- **Flags / rollback:** `SECURITY_PRICES_ENABLED`, `WEALTH_REGENERATION_ENABLED`, existing three investment flags unchanged. Rollback: flags off restore prior behavior instantly; dropping `PriceObservation` loses only price history; A8 touched only estimated rows, which are deterministically re-derivable by the same pipeline (and `backfill.ts` remains intact as the pre-A8 generator); P5 UI without `asOf` renders the unchanged current-state view.

---

## 11. Earliest user-visible milestones (brief §11.8)

1. **S4 ships (current wave):** shared As-of control with Wealth + Liquidity + Debt responding; Investments labeled "shows current values".
2. **B4 + P5 flow history (merge step 5):** honesty badges; contributions/withdrawals/dividends/fees history — the first investment Time Machine surface, earned by events alone.
3. **Holdings replay (same UI phase):** "what did I hold on D" with reconstruction provenance and unexplained-opening copy.
4. **Valued portfolio (after steps 6–8):** portfolio value as-of, allocation by value, contribution-vs-growth — first on recent dates (observed anchors + accruing same-day prices), deepening as the vendor backfill lands.
5. **Long-horizon charts (after step 9):** regenerated net-worth/investment history beyond the 30-day backfill, gaps visible, estimated rows visibly upgraded.

---

## 12. Claude Code implementation prompts (brief §11.9)

### 12.1 Spine — A6-1 (primary branch — run first, after committing A4-4)

```
Fourth Meridian — A6-1: Historical Prices contract + schema + read service (the fan-out spine).
Branch: feature/v2.5-spaces-completion, directly. ONE commit.
Prerequisite commits: 922448e (A4-3, current HEAD) AND the A4-4 commit (reconstruction-read.ts
+ test, currently uncommitted in the working tree — commit it first as its own commit).

Read first:
- FOURTH_MERIDIAN_A6_A7_A8_P5_PARALLELIZATION_INVESTIGATION_2026-07-12.md §3 (this design)
- FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN_2026-07-11.md §9
- lib/fx/{config,types,archive,service,fetch,registry}.ts — the structural template. COPY the
  patterns; NEVER modify lib/fx/**.
- prisma/schema.prisma: Instrument (:1252), FxRate (:2268).

Owned files (all new except schema): prisma/schema.prisma + ONE additive migration
(PriceObservation + PriceBasis enum: instrumentId FK, date @db.Date, price, currency, basis,
source, fetchedAt; @@unique([instrumentId, date, basis]); @@index([instrumentId, date]));
lib/prices/types.ts (PriceArchiveReader seam, Resolution/PriceMiss values, PriceProviderAdapter
interface); lib/prices/config.ts (PRICE_MAX_STALE_DAYS = 7, basis rules, assertISODate reuse);
lib/prices/archive.ts (insert-only writeBatch, skipDuplicates, closed-dates-only;
readLatestOnOrBefore); lib/prices/service.ts (getPriceAsOf: exact ⇒ tier "observed";
walked-back ≤ bound ⇒ "estimated" with staleDays; beyond/never ⇒ PriceMiss the caller maps to
"incomplete"; request-scoped memo; misses are VALUES, never throws); lib/prices/providers/
fixture.ts (deterministic fixture provider for tests); tests for all of it.

Forbidden files: lib/fx/**, lib/money/**, lib/perspective-engine/** (import types only),
lib/investments/** (A6-2 hooks are the WORKTREE's job, not the spine's), lib/data/**,
lib/snapshots/**, jobs/**, app/**, components/**, lib/transactions/**.

Rules: prices are keyed by instrumentId — no symbol column, ever. RAW_CLOSE is the canonical
valuation basis; ADJUSTED_CLOSE/NAV/CRYPTO_DAILY are distinct rows, never mixed in one read.
Weekend/holiday rows are absent by design; the service walks back and stamps; NO interpolation
anywhere. Currency is the quote currency; no conversion in this module. Tier values come from
lib/perspective-engine/completeness (import COMPLETENESS_TIERS / the CompletenessTier type);
never mint vocabulary.

Stop conditions: migration additive + reversible (drop-table rollback); fixture-provider tests
green incl. walk-back/staleness/miss/per-basis isolation; full suite green; NO vendor code, NO
network, NO capture wiring, NO valuation, NO UI. This commit is the fan-out gate for fm-a6,
fm-a7, fm-a8, fm-p5.
Merge order: §8.1 step 2 of the investigation.
```

### 12.2 Stream A6 (worktree `../fm-a6`)

```
Fourth Meridian — A6-2 + A6-3: same-day Plaid price capture, then vendor backfill + daily job.
Branch: feature/a6-historical-prices, worktree ../fm-a6.
Prerequisite commit: the A6-1 spine commit on feature/v2.5-spaces-completion (branch from it).
Merge order: A6-2 merges at §8.1 step 7 (stage 1); A6-3 merges whenever the vendor is selected
and licensed (stage 2 — it gates nothing else). Rebase onto primary before each merge.

Read first: lib/prices/** (the A6-1 contract — consume, extend providers only);
lib/investments/position-capture.ts and investment-event-ingest.ts (where securities payloads
flow); jobs/fetch-fx-rates.ts + scripts/backfill-fx-rates.ts + app/api/jobs/dispatch (the job
template); the plan §2.2 (close_price/close_price_as_of are currently discarded).

Owned files: lib/investments/position-capture.ts + investment-event-ingest.ts (ADDITIVE price-
capture hooks only — a small function call per file, flag-gated, non-fatal try/catch per the A1
contract); lib/prices/providers/<vendor>.ts + registry wiring; NEW jobs/fetch-security-prices.ts;
NEW app/api/jobs/fetch-security-prices/route.ts + the one dispatch-route registry entry;
NEW scripts/backfill-security-prices.ts; lib/prices/capture.ts (NEW — the shared
capture-from-securities-payload helper both hooks call); tests.

Forbidden files: prisma/** (A6-1 already shipped the schema), lib/prices/{types,config,archive,
service}.ts (frozen contract — if it is missing something, report, do not patch),
lib/perspective-engine/**, lib/data/**, lib/snapshots/**, lib/transactions/**, components/**,
lib/investments/* other than the two named hook files, lib/fx/**.

Tasks:
1. A6-2 capture: from every holdings/investmentsTransactions securities payload, write
   PriceObservation(source "plaid", basis RAW_CLOSE) via the archive. Date = close_price_as_of;
   when close_price_as_of is ABSENT, SKIP the row (never date a price by arrival time — MC1).
   Resolve security → instrumentId via the existing instrument resolver; unresolvable ⇒ skip.
   Behind env flag SECURITY_PRICES_ENABLED (absent ⇒ zero writes). Idempotent (unique key +
   skipDuplicates).
2. A6-3 vendor: adapter implementing PriceProviderAdapter; backfill script per instrument over
   [first observation/event date, today], missing-dates-only, resumable, paginated; daily job
   mirroring fetch-fx-rates (previous closed day, fetch-only-missing, no-op re-runs).
   STOP-AND-REPORT gate before writing the adapter: vendor licensing must permit persistent
   storage of historical prices — if unverified, deliver A6-2 + the fixture-tested job/backfill
   skeletons and stop.

Stop conditions: flag off ⇒ zero writes; re-runs add zero duplicates; capture is non-fatal to
refresh/ingest; full suite green; no valuation, no UI, no reads by any consumer added here.
Real-data validation (post-merge, primary): one refresh against the live brokerage writes dated
price rows for priced securities; second refresh adds none.
```

### 12.3 Stream A7 (worktree `../fm-a7`)

```
Fourth Meridian — A7 Historical Valuation: pure valuation core + as-of binding. Quantities ×
prices × FX, worst-tier stamped, partial-honest. NO persistence, NO UI, NO schema.
Branch: feature/a7-historical-valuation, worktree ../fm-a7.
Prerequisite commit: the A6-1 spine commit (branch from it; you need lib/prices/service + the
A4-4 reconstruction-read commit beneath it).
Merge order: §8.1 step 6 — after S4, before A8 and before P5's valued slice. Rebase onto
primary before merge.

Read first: the 2026-07-12 investigation §4 (this design, incl. the observed-anchor precedence
rule); lib/investments/reconstruction-read.ts (getPositionQuantityAsOf — your quantity input;
READ ONLY); lib/prices/service.ts (price input; READ ONLY); lib/money/convert.ts +
server-context.ts (FX at date; walked-back ⇒ estimated); lib/perspective-engine/completeness.ts
(worstTier/propagateCompleteness — the ONLY way you combine tiers);
lenses/asof-completeness.ts (the envelope-builder pattern to mirror, not import-and-edit).

Owned files (all new): lib/investments/valuation-core.ts (+ test), lib/investments/valuation.ts
(+ test), lib/investments/valuation.fixtures.ts.

Forbidden files: EVERYTHING else. Explicitly: lib/prices/** (consume only — a missing
capability is reported, not patched), lib/investments/* existing files, lib/perspective-engine/**,
lib/data/**, lib/snapshots/**, prisma/**, components/**, jobs/**, lib/fx/**, lib/money/**.

Tasks:
1. Pure core: valueInstrumentAsOf — PRECEDENCE: if the resolved position row for asOf carries
   institutionValue (or institutionPrice), that observed valuation wins (tier "observed", FX
   still applied and still able to degrade); else quantity × getPriceAsOf × FX with tier =
   worstTier([qtyTier, priceTier, fxTier]). Missing price beyond staleness ⇒ value null, tier
   "incomplete", deterministic reason. Cash-instrument positions value at 1 × FX.
2. valuePortfolioAsOf: per-instrument byComponent detail; valued subtotal + explicit unvalued
   remainder (count + quantities); overall tier = worst contributor; conflict OR'd from
   PositionReconstruction.conflicted. A partial total is NEVER shaped as the whole.
3. Binding getInvestmentValueAsOf({spaceId|financialAccountId, asOf, now?}): batched reads (one
   windowed findMany per table — no per-instrument N+1), visibility inherited via the account
   read path, injected clock.
4. Tests: full tier matrix, observed-anchor precedence, partial shapes, FX degradation, gap
   fixture (3-week price hole ⇒ estimated→incomplete exactly at the bound), determinism
   (byte-identical JSON), reconciliation fixture: at an observation date, portfolio value ==
   Σ institutionValue within epsilon.

Stop conditions: no persistence of any valuation result; no new completeness vocabulary; no
calendar logic (A6's walk-back owns weekends/holidays); fixtures green with ZERO real price
rows (fixture provider only); full suite green. Real-data validation happens post-merge on
primary (invariant 1 of the investigation §10).
```

### 12.4 Stream A8 (worktree `../fm-a8`)

```
Fourth Meridian — A8 Wealth Regeneration: bounded, honest regeneration of estimated
SpaceSnapshot rows using valued investment components. Zero schema.
Branch: feature/a8-wealth-regeneration, worktree ../fm-a8.
Prerequisite commit: the A6-1 spine commit (branch from it). Your BINDING additionally needs
A7's DTO: build the pure core first against an injected valuation function; after A7 merges to
primary (§8.1 step 6), rebase onto primary and add the binding commit.
Merge order: §8.1 step 9 — LAST worktree merge. The trigger wiring is NOT yours: it lands as
one integration commit on primary after your merge (reconstruction-runner hook, backfill-script
hook, sync-path hook).

Read first: the 2026-07-12 investigation §5; the plan §10 (frozen-vs-regenerable ruling);
lib/snapshots/regenerate.ts (formula parity INCLUDING the realAssets correction — mirror the
math, NEVER modify the file); lib/snapshots/backfill.ts + backfill-core.ts (READ ONLY — what
wrote the estimated rows); lib/data/snapshots.ts (READ ONLY); SpaceSnapshot (schema :2040).

Owned files (all new): lib/snapshots/regenerate-history.core.ts (+ test),
lib/snapshots/regenerate-history.ts (+ test), scripts/regenerate-wealth-history.ts.

Forbidden files: lib/snapshots/{regenerate,backfill,backfill-core}.ts, lib/data/**,
lib/investments/** (import valuation only, post-rebase), lib/prices/**,
lib/perspective-engine/** (import helpers only), prisma/**, components/**, jobs/**, app/**.

Tasks:
1. Pure core: given a window's snapshot rows + a per-day injected investment valuation
   ({value, tier} per day) + the cash/card walk-back tiers, produce the regenerated rows.
   HARD RULES: isEstimated=false rows are FROZEN (guard + test: zero writes, asserted
   byte-identical); a row flips isEstimated→false ONLY when every component that day is
   observed/derived; windows are always explicit {spaceId, fromDate, toDate}; missing days
   inside the window may be created only within the space's defensible coverage; NO
   interpolation.
2. Binding: getInvestmentValueAsOf per day (batched sensibly), existing formulas for the
   derived aggregates, upsert on [spaceId, date]. Behind env flag WEALTH_REGENERATION_ENABLED
   (absent ⇒ zero writes). Best-effort/non-fatal at call sites.
3. Affected-window computation: (instrumentIds → financialAccountIds → ACTIVE SpaceAccountLink
   spaceIds) × [min affected date, next frozen row or today] — exported for the integration
   commit's triggers to call.
4. Script: manual bounded run with a dry-run mode printing per-row diffs.
5. Tests: frozen-row byte-identity; flag-off zero-writes; flip rule; idempotent re-runs;
   monotone improvement (a run never lowers a row's completeness); formula parity with
   regenerate.ts for a same-day input (reconciliation invariant 2).

Stop conditions: zero schema; regenerate.ts/backfill*.ts untouched; no trigger wiring; no UI;
full suite green. Real long-window runs wait for A6-3 backfill data — dark-run validation on
primary per §10 order (4).
```

### 12.5 Stream P5 (worktree `../fm-p5`) + primary UI phase

```
Fourth Meridian — P5 Investments Time Machine, lib phase: flow history + holdings-replay
adapter (P5-1 now; P5-2 valued after A7 merges). UI is NOT in this stream — it lands on
primary after S4/B4.
Branch: feature/p5-investments-asof, worktree ../fm-p5.
Prerequisite commit: the A6-1 spine commit (branch from it — beneath it sit A4-4's
reconstruction-read and the landed A3 event ingestion you need). P5-1 has ZERO dependency on
prices or valuation.
Merge order: P5-1 merges at §8.1 step 4 (FIRST worktree merge, before B4/UI); after A7 merges,
rebase onto primary and deliver P5-2 as a second merge (step 8).

Read first: the 2026-07-12 investigation §6 (capability gates + refusals);
lib/investments/reconstruction-read.ts (quantity seam + honesty DTOs; READ ONLY);
InvestmentEvent schema (:1385) + lib/investments/investment-event-ingest.ts (what's in the
log); lenses/asof-completeness.ts (envelope-builder pattern — mirror in your own file);
lib/transactions/cash-flow-compare.ts (the stamp/period precedent);
lib/investments/current-holdings.ts (the current-state view you parallel, never rewrite).

Owned files (all new): lib/investments/investments-asof.core.ts (+ test),
lib/investments/investments-asof.ts (+ test), lib/investments/investments-asof.fixtures.ts.

Forbidden files: components/** (ALL UI — especially SpaceDashboard.tsx and
InvestmentAccountsWidget.tsx), lib/perspective-engine/** (import helpers/types only — P5 is
NOT a lens this wave: no LensId edit, no lib/perspectives.ts entry), lib/data/**,
lib/investments/* existing files (incl. valuation*.ts — import only after the P5-2 rebase),
lib/prices/**, lib/snapshots/**, prisma/**, jobs/**, lib/transactions/**.

Tasks (P5-1):
1. Flow history: per (account | space, window) buckets over InvestmentEvent — contributions,
   withdrawals, dividends, interest, fees, buys, sells; deterministic ordering; deleted/
   superseded rows excluded; completeness stamp: "observed" within event coverage,
   "incomplete" for windows predating the earliest defensible event date (derive from
   PositionReconstruction.earliestDefensibleDate / first event). Evidence refs = event ids
   (drawer consumption later, UI phase).
2. Holdings replay: as-of position list for an account/space via getPositionQuantityAsOf —
   quantities, share-count composition weights, closed positions (quantity 0 rows), per-row
   tier + reconstruction honesty label (describeReconstruction). NO values in P5-1.
3. Envelope builder (own file, mirroring asof-completeness.ts): per-bucket byComponent, worst
   tier via the S1 helpers, deterministic name-free reasons.
4. REFUSALS (test-asserted): realized-vs-unrealized decomposition refused (no lot data —
   shaped result with explicit reason); valuation fields absent/refused in P5-1.

Tasks (P5-2, after rebasing onto post-A7 primary):
5. Valued portfolio history: value-as-of + allocation-by-value + contribution-vs-growth
   (Δvalue = external flows + market-move residual, plan §10) via getInvestmentValueAsOf;
   unrealized-vs-aggregate-cost-basis shown ONLY where Plaid costBasis exists, labeled
   provider-derived; comparison completeness = worst of the two sides via the S1 propagation
   helper (the cash-flow-compare precedent).

Stop conditions: no UI; no date/period state anywhere; no LensId/registry edits; existing
investment read models byte-identical; fixtures green; full suite green.

UI phase (separate prompt, PRIMARY branch, after S4 + B4 + the P5-1 merge): wire flow history,
holdings replay, and (post-P5-2) valued history into the Investments widgets under the S4
shared asOf control; evidence drawers reuse the TransactionSliceDrawer pattern; completeness
badges reuse the S4 CompletenessBadge with user-facing copy only ("Reconstructed",
"N shares unexplained before …", "No price within N days of this date"); gaps render as gaps.
Owned there: InvestmentAccountsWidget.tsx, new investment TM widgets/adapters,
SpaceDashboard.tsx threading (single owner: primary). Forbidden there: everything under lib/
except additive exports in lib/data/investment-accounts.ts.
```

---

*End of investigation. No code written, no files modified besides this report, no migrations created, nothing committed.*
