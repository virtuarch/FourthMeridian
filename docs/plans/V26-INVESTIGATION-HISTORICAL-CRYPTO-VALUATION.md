# V26 Investigation & Implementation Plan — Historical Crypto Valuation

**Status:** Investigation + implementation design. No code, schema, migration, or commit. Read-only against production and local.
**Repository:** `v2.6` @ `146a0dd`
**Continues from:** Financial Truth Data Model · Historical Valuation Integrity · Net Worth Attribution

**Marking:** **[EXISTS]** verified · **[ABSENT]** verified missing · **[PROPOSED]** · **[INFERRED]**

---

## 1 · Executive finding — do not build crypto valuation

**The unified historical valuation engine you hypothesised in Part 8 already exists, already works, and already handles crypto. Crypto is excluded from it by one boolean flag, and then never revalued by anything else.**

`lib/investments/valuation.ts` — `getInvestmentValueAsOf` / `getInvestmentValueForWindow` — reads `PositionObservation` and prices it against `PriceObservation`. **It does not filter on `assetClass`.** Given a BTC position and a BTC price row, it values Bitcoin exactly as it values AAPL. That is not a proposal; it is the current implementation.

The bifurcation happens in two places, neither of them valuation:

1. **`lib/snapshots/regenerate-history.ts:360`** passes `excludeDigitalAssetAccounts: true` — deliberately removing crypto accounts from the historical valuation it computes.
2. **Nothing computes a historical valuation for the crypto column at all.** `backfill-core.ts:316-317` splits `stocks = totalInvestments` / `crypto = totalDigitalAssets`, and A9 revalues only the first. The second keeps whatever backfill wrote — today's value, flat.

The exclusion was correct when added: crypto lives in its own snapshot column, so including it in `totalInvestments` would double-count it (the ~$14k net-worth cliff fixed by that flag). **The bug is not the exclusion. The bug is that nothing ever ran the complement.**

**So the work is not "add crypto support." It is: call the engine that already exists a second time, with the complementary filter, and write the result into the column that is currently frozen.** Everything else in this document is the supporting infrastructure to make that second call return real numbers instead of empty ones.

**Opinionated answer to your closing note: you are right, and it is closer than you think.** Crypto should not become "another supported asset class." It should stop being a class at all. The engine is already generic; what is class-specific is the *account-type split into two snapshot columns*, and that split is the thing worth attacking.

---

## 2 · Current crypto architecture — call graph

```
PROVIDER
  Blockchain (BTC) — lib/crypto/btc-explorer.ts, btc-address-derivation.ts
  CoinGecko (price) — lib/prices/providers/coingecko.ts

INGESTION
  lib/crypto/btc-sync.ts        → Transactions (externalTransactionId = txid)
                                → FinancialAccount.nativeBalance / balance  (MUTABLE, no history)
  jobs/sync-crypto.ts           → scheduled wallet sync
  app/api/accounts/wallet/route.ts, /[id]/sync/route.ts

IDENTITY                                                              [EXISTS — generic]
  lib/investments/crypto-instrument.ts
    CRYPTO_PROVIDER = "crypto"
    InstrumentAlias (provider="crypto", externalId=SYMBOL)  ← deterministic identity
    resolveCryptoInstrumentId() → adopts/creates Instrument(tickerSymbol, assetClass=CRYPTO)
    BTC_ASSET = { symbol:"BTC", name:"Bitcoin", currency:"USD" }   ← ONLY asset defined

QUANTITY                                                             [EXISTS — observed]
  lib/crypto/wallet-position-capture.ts
    captureWalletPosition() → PositionObservation
      origin = PositionOrigin.OBSERVED, source = "wallet"
      unique (financialAccountId, instrumentId, date, origin, source)

PRICE                                                                [EXISTS — BTC only]
  lib/prices/  { registry, service, fetch, capture, archive, backfill, config, types }
    registry.ts        → ordered failover: Tiingo (equities) + CoinGecko (crypto)
    providers/coingecko.ts → fetchBtcDailyClosesUsd()  ← HARDCODED to BTC_COIN_ID
                             endpoint: /coins/{id}/market_chart/range   ← correct, generic
    archive.ts:112     → priceObservation.createMany()   (the ONLY writer)
    backfill.ts:128    → backfillPricesForInstruments(), chunkDays default 365, missing-only, resumable

HISTORICAL VALUATION                                                 [EXISTS — asset-class agnostic]
  lib/investments/valuation.ts
    getInvestmentValueAsOf / getInvestmentValueForWindow
    → PositionObservation × PriceObservation × FX → { valuedSubtotal, unvalued remainder, tier }
    NO assetClass filter.  Optional excludeDigitalAssetAccounts (default false)

SNAPSHOTS
  lib/snapshots/backfill.ts        cash+cards walked back; investments/crypto/manual HELD FLAT (:222-223)
  lib/snapshots/regenerate-history.ts:360  ← calls valuation with excludeDigitalAssetAccounts: TRUE
  lib/snapshots/regenerate-history.core.ts:160  ← writes stocks; crypto untouched (:14-16)
  backfill-core.ts:316-317         stocks = totalInvestments ; crypto = totalDigitalAssets

CHARTS / NET WORTH / ATTRIBUTION
  lib/wealth/wealth-time-machine.ts toState() → composition.{cash,investments,crypto,real,liabilities}
  components/space/widgets/wealth/WealthChangeLedger.tsx  → drivers = component deltas
```

**The gap is a single missing edge:** nothing connects the valuation core to the `crypto` column.

---

## 3 · Instrument identity audit

| Facet | Status |
|---|---|
| Canonical identity | **[EXISTS]** — `InstrumentAlias(provider="crypto", externalId=symbol)`, `@@unique([provider, externalId])` refuses a second mapping |
| `Instrument` model | **[EXISTS]** — rich: `cusip`, `isin`, `sedol`, `tickerSymbol`, `assetClass`, `underlyingInstrumentId` |
| Symbol → instrument | **[EXISTS]** — `resolveCryptoInstrumentId()`, O(1) on repeat |
| Assets defined | **BTC only.** `crypto-instrument.ts:35` — *"ETH/SOL land by adding their descriptor — no BTC-specific branch"* |
| CoinGecko coin id | **[ABSENT]** — `BTC_COIN_ID` is a constant in the provider, not a property of the asset |
| Contract address / chain | **[ABSENT]** — no field anywhere |
| Wrapped/bridged asset relation | **[ABSENT]** — `underlyingInstrumentId` exists but is unused for crypto |

**Verdict:** identity architecture is sound and generic; the *descriptor table* is a one-row list. **The missing layer is a market-data identity on the asset descriptor** — symbol alone cannot disambiguate (multiple chains issue "USDC"; several tokens share tickers).

**[PROPOSED]** extend `CryptoAsset` to carry market-data identity, not a new model:

```ts
interface CryptoAsset {
  symbol: string;                  // canonical identity (unchanged)
  name: string; currency: string;
  marketData: { provider: 'coingecko'; coinId: string };   // BTC → 'bitcoin'
  chain?: { network: string; contractAddress?: string };   // ERC-20 / SPL disambiguation
}
```

This is a code-level descriptor, not schema. `InstrumentAlias` can additionally hold `(provider="coingecko", externalId=coinId)` using the **existing** table — no migration.

---

## 4 · Historical quantity audit

| Provider / class | Quantity as-of a date | Basis |
|---|---|---|
| **BTC wallet (xpub / address)** | **Observed** | `captureWalletPosition` → `PositionObservation(origin=OBSERVED, source="wallet")` |
| BTC quantity *before* first capture | **Unknown** | no observation exists; reconstruction from on-chain tx is possible in principle |
| Exchange-held crypto (Coinbase etc.) | **Unknown** | no adapter exists |
| Manual crypto | **Unknown** | no valuation record model (V26-F3 §2.3) |
| Equities (Plaid) | **Observed / Reconstructed** | `PositionObservation` + `PositionReconstruction` + `InvestmentEvent` |

**Crucially: BTC quantity is genuinely observed, per date, with provenance.** The quantity half of the problem is already solved for the wallet path — better than for equities, which lean on reconstruction.

**[INFERRED]** BTC is also uniquely favourable for pre-capture reconstruction: `btc-sync` already imports on-chain transactions with `externalTransactionId = txid`, so a wallet's *entire* quantity history is derivable from the chain — no provider dependency, no gaps. That is a stronger position than any equity account.

---

## 5 · CoinGecko capability audit

| Capability | Status |
|---|---|
| Provider adapter | **[EXISTS]** — `lib/prices/providers/coingecko.ts` |
| Historical endpoint | **[EXISTS]** — `/coins/{id}/market_chart/range`, the correct one: a window in one call |
| Daily bucketing | **[EXISTS]** — buckets sub-daily points to UTC calendar date |
| Auth | **[EXISTS]** — `x-cg-demo-api-key` (free/Demo tier) |
| Registry + failover | **[EXISTS]** — `registry.ts`, ordered adapters, DI seam |
| Backfill orchestration | **[EXISTS]** — `backfillPricesForInstruments`, 365-day chunks, missing-only, resumable |
| Archive writer | **[EXISTS]** — `archive.ts:112` |
| **Generalisation to any coin** | **[ABSENT]** — `fetchBtcDailyClosesUsd()` hardcodes `BTC_COIN_ID` |

**What can be priced today:** BTC only — and in production, only **39 days** (first 2026-06-21).

**What could be priced with a parameterised coin id:** BTC, ETH, SOL, XRP, and any CoinGecko-listed ERC-20/SPL/stablecoin/wrapped asset — the endpoint is identical; only the id changes.

**What remains genuinely hard:** delisted assets (CoinGecko may retain history but the id must be known), forks (two ids, one historical lineage), and pre-listing periods (no market existed). These are §7 unknowns, not engineering gaps.

**Free-tier reality check [INFERRED]:** the Demo tier historically limits `market_chart/range` to ~365 days of history and imposes low rate limits. A 2024-onward backfill likely needs either the paid tier or acceptance that history begins at the limit — **a product/cost decision, not a code decision** (§10, D2).

---

## 6 · PriceObservation audit

Current model **[EXISTS]**:

```
id · instrumentId · date (@db.Date) · price · currency · basis (PriceBasis) · source · fetchedAt · createdAt
```

| Required facet | Status |
|---|---|
| Instrument | ✅ `instrumentId` |
| ValuedAt | ✅ `date` — market close, daily |
| ObservedAt | ✅ `fetchedAt` |
| Provider / source | ✅ `source` |
| Currency | ✅ `currency` |
| Granularity | ✅ implicit daily; `basis` distinguishes adjusted/close |
| **ProviderInstrumentId** | ❌ **[ABSENT]** — cannot record *which* CoinGecko id produced the row |
| **Confidence** | ❌ **[ABSENT]** |
| **Corrections / versioning** | ❌ **[ABSENT]** — no supersession |

**[PROPOSED] minimal additive changes — and only two are needed for this initiative:**

1. `providerInstrumentId String?` — provenance for fork/rename disambiguation. **Recommended.**
2. Confidence and versioning — **defer.** `source` + `basis` already discriminate, and adding a confidence scale here without the unified vocabulary (V26-F3 §12) would create a fourth one.

**Do not add** a correction/supersession mechanism yet: `PriceObservation` is append-only with a natural key of `(instrument, date, basis)`; a re-fetch should upsert, and history-of-prices is a different problem from history-of-values.

---

## 7 · Historical valuation algorithm

```
Value(T) = Quantity(T) × Price(T) × FX(T→reporting)
```

| Input | Source | Class |
|---|---|---|
| **Quantity(T)** | `PositionObservation` (BTC: `origin=OBSERVED, source="wallet"`) | **Observed** where captured; **Unknown** before first capture |
| **Price(T)** | `PriceObservation` via CoinGecko `market_chart/range` | **Observed** where imported; **Unknown** before listing / outside tier limit |
| **FX(T)** | `FxRate(date, base, quote)` **[EXISTS]**, USD base | **Observed** where present; **Estimated** on nearest-prior; **Unknown** beyond window |
| **Value(T)** | the product | inherits the **worst** class of its inputs |

**Provenance rule [PROPOSED]:** the output carries the weakest input's tier, and the *reason*. `getInvestmentValueAsOf` already returns `{ valuedSubtotal, unvalued remainder, tier }` — *"never a partial total presented as the whole"* (`valuation.ts:142-143`). **That contract is exactly right and must be preserved when crypto flows through it.** The current crypto path violates it by presenting a flat projection as a historical value.

---

## 8 · Unknowns — and how Financial Truth must represent them

| Scenario | Representation |
|---|---|
| Quantity before first wallet capture | **Unknown** → excluded from `valuedSubtotal`, reported in the unvalued remainder |
| Price before listing / outside API limit | **Unknown** → same |
| Wallet disconnected mid-history | **Unknown** for the gap — never carried forward |
| Unsupported asset (no CoinGecko id) | **Unknown**, named: "this asset is not priced" |
| Contract migration / fork | **Unknown** until an explicit lineage is recorded; never silently merged |
| Symbol ambiguity (multi-chain USDC) | **Unresolved identity** → refuse to value, do not guess a coin id |
| Exchange-held crypto | **Unknown** — no adapter |
| Manual custody | **Unknown** until a `Valuation` record exists (V26-F3) |
| FX missing | **Unknown** — per V25-FINAL-1, `amount: null`, never a fake zero |

**The binding rule, and the whole point of this initiative:**

> **Never substitute today's value for an unknown historical value.** Today's price applied to a past date is not an estimate — it is a fabrication with a plausible shape, and it is precisely what produced the flat crypto line and the sync-time restatements.

---

## 9 · Stocks vs crypto — challenging your hypothesis

Your proposed shape:

```
Quantity Resolver → Historical Price Resolver → Historical Valuation Core
```

**Endorsed — with the correction that it already exists.** `getInvestmentValueForWindow` *is* the historical valuation core; `PositionObservation` *is* the quantity resolver; `lib/prices/` *is* the price resolver with a provider registry and failover. Tiingo serves equities, CoinGecko serves crypto, behind one interface.

**So the real question is not "should they unify" but "why are they still split at the snapshot layer."** The answer is `SpaceSnapshot`'s two columns — `stocks` and `crypto` — which are an **account-type** partition (`AccountType.investment` vs `AccountType.crypto`), not an instrument-class one. That partition:

- forces `excludeDigitalAssetAccounts` to exist at all (to prevent double counting between columns);
- means a crypto position held *inside a brokerage* would land in `stocks` while the same asset in a wallet lands in `crypto` — the same instrument, two columns, by custody rather than by nature;
- guarantees that any future asset class needs a third column and a third exclusion flag.

**Opinionated recommendation:** treat the two columns as a **presentation rollup of one valued portfolio**, not as two independent totals. Value everything once through the core; classify the result for display. Then `excludeDigitalAssetAccounts` can be deleted rather than complemented, and "crypto support" ceases to be a category of work.

That is the larger prize you identified, and I agree it is where this leads. **But it is not the first ticket** — it changes how every historical row is composed, and it should follow the narrow fix that makes crypto values real in the first place.

---

## 10 · Where historical valuation belongs

**`regenerate-history.core.ts` should stop performing valuation.**

Today it is the only thing that knows how to turn evidence into a historical value, and it does so while also deciding freeze rules, flip rules and write actions. That is why the §1 defect exists at all: valuation policy and write policy live in one function, so excluding an account class from valuation silently excluded it from *revaluation forever*.

**[PROPOSED]**

```
Evidence (PositionObservation · PriceObservation · FxRate · BalanceObservation)
        ↓
Historical Valuation Core            ← valuation ONLY; returns valued + unvalued + tier
        ↓
Financial Truth Resolver             ← seals: composition, provenance, unknowns
        ↓
Snapshots (materialised view)  →  Charts  →  Attribution  →  Assessment
```

**What becomes simpler when valuation moves out:**

- `regenerate-history.core.ts` shrinks to freeze/flip/write policy — the part it does well.
- The §1 defect becomes structurally impossible: there is one valuation entry point, so a class cannot be excluded from it and forgotten.
- The missing non-negativity guard (prior investigation) has **one** place to live.
- Snapshots become a rebuildable projection — rebuilding cannot change history, because history is the evidence.
- Attribution (two-endpoint compiler) reads sealed truth instead of re-deriving from snapshot columns.

---

## 11 · Performance and cost

**Volume estimate for the current production Space** (1 crypto instrument, ~735 days of history):

| Metric | Estimate |
|---|---|
| CoinGecko calls for full BTC history | **~2–3** (365-day chunks, `chunkDays` default 365) |
| New `PriceObservation` rows | ~735 per instrument |
| Row size | tiny (~100 B) → **<100 KB per instrument-year** |
| Daily incremental | 1 call, 1 row per instrument |
| Backfill duration | seconds, dominated by rate-limit sleeps |
| Snapshot regeneration | already runs; no new cost — the same A9 pass gains a second valuation call |

**This is a cheap problem.** Even ten instruments across three years is ~11k rows and ~30 calls.

**Recommended architecture: hybrid.**
- **On connect** — enqueue a historical backfill for the new instrument (not inline; wallet connect must stay fast).
- **Background job** — `backfillPricesForInstruments`, missing-only and resumable, already built for exactly this.
- **Daily cron** — incremental capture (already exists).
- **Never lazy/on-demand at read time** — a chart request must not trigger a vendor call; that reintroduces read-time nondeterminism, which is the disease being cured.

---

## 12 · Repairing existing data

Ordered, and the ordering is the important part:

1. **Fix the writer first.** Repairing rows before the writer is guarded means the next regeneration re-corrupts them. (This is the standing recommendation from the prior investigation, still unshipped.)
2. **Import historical prices** — `backfillPricesForInstruments` for each crypto instrument, missing-only. Read-only against user data; additive to `PriceObservation`.
3. **Dry-run the valuation** — compute historical crypto values for the full window and produce a comparison report (old flat value vs new valued vs unvalued remainder) **without writing**.
4. **Review the report** — specifically the size of the unvalued remainder per period. If it is large, the fix would replace a wrong number with an incomplete one; that must be a conscious choice.
5. **Regenerate snapshots** — A9 pass, `isEstimated` semantics unchanged. Observed rows stay frozen (`skip-frozen` already enforces this).
6. **Verify integrity** — the probe from the prior ticket: no negative components, composition sums to totals, no value sourced from today's price.
7. **Charts and attribution need no regeneration** — both derive from snapshots at read time.

**Rollback:** every step is additive or idempotent. `PriceObservation` rows can be deleted by `(instrument, source, date-range)`; snapshots can be regenerated from the prior algorithm behind a flag. **Observed rows are never touched at any step** — that is the safety property that makes this repairable at all.

---

## 13 · Implementation phases and dependencies

| Phase | Objective | Depends on | Changes user-visible numbers? |
|---|---|---|---|
| **P1** | Guard the writer (non-negativity + coverage) — *prior investigation's ticket* | — | No (prevents future corruption) |
| **P2** | Parameterise the CoinGecko adapter by coin id; add `marketData.coinId` to `CryptoAsset` | — | No |
| **P3** | Historical price backfill for crypto instruments (job + script, dry-run default) | P2 | No (writes `PriceObservation` only) |
| **P4** | Second valuation call: value crypto accounts via the existing core; write the `crypto` column | P3 | **Yes — the intended correction** |
| **P5** | Dry-run comparison + integrity probe over the full window | P4 | No |
| **P6** | Regenerate historical snapshots behind a flag | P5 green | **Yes** |
| **P7** | Chart/attribution validation; estimation disclosure surfaced | P6 | Presentation only |
| **P8** | *(Larger prize)* collapse `stocks`/`crypto` into one valued portfolio with display-time classification; delete `excludeDigitalAssetAccounts` | P4–P7 | Structural |

P1 is independent and should ship first regardless of this initiative.

---

## 14 · Validation strategy

| Invariant | Test |
|---|---|
| Historical valuation never changes after sync | Seal a window, sync, recompute — byte-identical for dates with complete evidence |
| No historical crypto uses today's price | Assert every valued day resolves to a `PriceObservation` whose `date` ≤ that day; **fail if a value is produced with no in-window price row** |
| BTC chart matches CoinGecko | Fixture: known dates, published closes, ±0.5% tolerance for bucketing |
| Portfolio reconstructs exactly | `Σ(quantity × price × fx)` equals the stored component for fully-observed days |
| No negative components | Property test over generated inputs + the integrity probe (P1) |
| Unknowns propagate | A day with a missing price yields an unvalued remainder, **not** a smaller total silently presented as complete |
| Confidence preserved | Output tier equals the worst input tier |
| Attribution reproducible | Same two endpoints ⇒ same driver deltas across runs |

The second row is the one that would have caught this class of defect years earlier, and it is cheap.

---

## 15 · Exact first implementation ticket

Assuming P1 (writer guard) is already scheduled, the first ticket for *this* initiative:

> **V26-CRYPTO-1 · Parameterise crypto price history by coin id (no valuation change)**
>
> Make the existing CoinGecko adapter capable of fetching any coin's history, and give crypto assets a market-data identity. **No valuation change, no snapshot change, no user-visible number moves.**
>
> **1. `lib/investments/crypto-instrument.ts`**
> - Extend `CryptoAsset` with `marketData: { provider: 'coingecko'; coinId: string }`. `BTC_ASSET` gains `coinId: 'bitcoin'`.
> - Optionally register a second alias `(provider="coingecko", externalId=coinId)` using the **existing** `InstrumentAlias` table — no schema change.
> - Add no new assets in this ticket. One asset, correctly described, proves the shape.
>
> **2. `lib/prices/providers/coingecko.ts`**
> - Generalise `fetchBtcDailyClosesUsd(...)` → `fetchDailyClosesUsd(coinId, window, ...)`. Keep the BTC-named export as a thin wrapper so existing callers are untouched.
> - **Do not change** the endpoint, bucketing, auth, or retry behaviour — they are correct.
> - Surface the tier's history limit explicitly: if the requested window predates what the API returns, return the covered sub-window **and report the shortfall**. Silently returning less is how a gap becomes invisible.
>
> **3. Tests**
> - Fixture adapter (`providers/fixture.ts` already exists as the DI seam): a non-BTC coin id round-trips.
> - Window truncation is reported, not swallowed.
> - Existing BTC tests pass **unchanged** — the wrapper preserves behaviour.
>
> **4. Explicitly out of scope**
> - Valuing crypto historically (P4 — this ticket only makes prices *available*).
> - Adding ETH/SOL descriptors.
> - Any change to `regenerate-history.*`, snapshots, charts, or `excludeDigitalAssetAccounts`.
>
> **Done when:** suite green, `tsc` clean, lint clean, and a dry-run can fetch a full BTC history window while reporting any tier-imposed truncation. **No stored value changes.**

---

## 16 · Final answer

> **Yes — Fourth Meridian can eliminate estimated historical crypto valuation for supported assets, and it is a smaller job than it appears, because the unified valuation engine already exists and already handles crypto.**

**What is already in place:** `getInvestmentValueForWindow` prices `PositionObservation` against `PriceObservation` with **no `assetClass` filter**; BTC quantity is genuinely **observed** per date via `captureWalletPosition` (`origin=OBSERVED`); crypto identity is generic and deterministic via `InstrumentAlias`; the CoinGecko adapter already calls the correct historical endpoint; and `backfillPricesForInstruments` already does resumable, chunked, missing-only historical import.

**What is required, precisely:**

1. **A market-data identity on the asset descriptor** — a CoinGecko `coinId` per asset. Symbol alone cannot disambiguate multi-chain tokens. *(Code, not schema.)*
2. **Parameterise the CoinGecko adapter** — one hardcoded `BTC_COIN_ID` is the only thing preventing any other coin.
3. **Run the price backfill** for each crypto instrument over its ownership window.
4. **Make the second valuation call** — the complement of `excludeDigitalAssetAccounts` — and write its result into the `crypto` column instead of leaving backfill's flat projection.
5. **`providerInstrumentId` on `PriceObservation`** — the one additive field worth having, for fork/rename provenance.

**The irreducible unknowns that will remain, and must be represented as unknown rather than filled:**

- **Quantity before the first wallet capture.** Reconstructible from on-chain history for BTC (`btc-sync` already imports txids) — but until that reconstruction is built, it is unknown.
- **Price before an asset was listed**, and any period outside the API tier's historical limit.
- **Exchange-held and manually-custodied crypto** — no adapter, no valuation record.
- **Forks, contract migrations, and ticker collisions** — resolvable only with an explicit recorded lineage; never by inference.

**And the strategic conclusion, stated plainly:** the highest-value outcome here is not working crypto history. It is that after P4–P8, `stocks` and `crypto` stop being separate totals computed by separate paths. One quantity resolver, one price resolver, one valuation core, one sealed truth — with asset class as a *display* concern. At that point "crypto support" is not a feature that was added; it is a special case that was deleted, and the next asset class costs a descriptor rather than a pipeline.
