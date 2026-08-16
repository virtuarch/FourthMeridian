# V26 Investigation — Historical Price Coverage Infrastructure

**Status:** Investigation + implementation design. No code, schema, migration, or commit. Read-only against production and local.
**Repository:** `v2.6` @ `146a0dd`
**Continues from:** Historical Valuation Integrity · Historical Crypto Valuation · Net Worth Attribution · Financial Truth Data Model

**Marking:** **[EXISTS]** verified · **[ABSENT]** verified missing · **[INFERRED]** · **[PROPOSED]**

---

## 1 · Executive finding

**The central orchestration contract you hypothesised is missing — but the hypothesis needs one important correction: for Plaid equities, coverage orchestration *already exists and works well*. It is crypto that has no equivalent, and the asymmetry is the finding.**

Production evidence, 19 instruments:

| Class | Positions first seen | Price rows | Price coverage starts |
|---|---|---|---|
| Equities / ETF (QBTS, APLD, VST, VGT, OKLO, VRT…) | 2026-06-25 | **505 each** | **2024-07-24** — ~2 years, *predating* first position |
| **BTC** | 2026-07-22 | **39** | 2026-06-21 |
| CUR:USD (cash) | 2025-08-27 | 7 | 2026-07-22 |

`lib/plaid/backgroundHistorySync.ts:243` calls `backfillPricesForInstruments` on every connect, and it works: two years of daily closes for every held equity, fetched *before* A9 regeneration runs. **Architectural law 2 (check before fetching) and law 3 (fetch gaps not windows) are already honoured on that path** — the backfill is missing-only, chunked at 365 days, and resumable.

**Three defects sit around it:**

1. **Crypto has no coverage trigger.** `btc-sync` fetches a *spot* price for the current balance. `jobs/sync-crypto.ts` regenerates only `recentWealthWindow()` — **30 days** (`regenerate-history.ts:561-565`). No crypto path calls `backfillPricesForInstruments`. **[ABSENT]**
2. **Coverage is never a gate.** The Plaid backfill is budget-bounded (`PRICE_BACKFILL_BUDGET_MS`), can truncate ("deferred N to next connect"), and is wrapped in `try/catch` as **non-fatal**. A9 regeneration then runs regardless. Nothing asks "is coverage sufficient?" before producing a historical valuation. **[ABSENT]** — this is the missing contract.
3. **Coverage is scoped to `quantity > 0`** (`backgroundHistorySync.ts:236-241`) — *currently held* instruments only. A position sold last year is never priced, so its historical contribution is unrecoverable.

**And a quantity finding that reframes the crypto problem:** BTC has **9** `PositionObservation` rows (2026-07-22 → 07-30) while the wallet has held BTC since ~2023. Crypto's gap is **not primarily price history — it is quantity history.** Fixing prices alone would still yield an unvalued remainder for every date before 2026-07-22.

---

## 2 · Current price architecture — call graph

```
INSTRUMENT DISCOVERY (entry points that create/resolve an Instrument)
  lib/investments/crypto-instrument.ts  resolveCryptoInstrumentId()   ← crypto, symbol-keyed alias
  Plaid investments ingestion            → Instrument + InstrumentAlias (securities)
  lib/crypto/btc-price.ts                → legacy global Instrument(BTC, CRYPTO)
  imports (CSV/Excel)                    → instrument resolution

QUANTITY
  lib/crypto/wallet-position-capture.ts  captureWalletPosition() → PositionObservation(OBSERVED,"wallet")
  Plaid investments                      → PositionObservation + InvestmentEvent + PositionReconstruction

PRICE — request / plan / fetch / write
  lib/prices/backfill.ts:128   backfillPricesForInstruments(ids, {apply, registry, deadlineEpochMs})
        │  per-instrument window = [earliest defensible activity … today]
        │  chunkDays default 365 · MISSING-ONLY · resumable
        ▼
  lib/prices/registry.ts       defaultPriceRegistry() — ordered failover
        ├── providers/tiingo.ts      equities
        └── providers/coingecko.ts   fetchBtcDailyClosesUsd()  ← BTC hardcoded
        ▼
  lib/prices/archive.ts:112    priceObservation.createMany()      ← THE ONLY WRITER
        ▼
  PriceObservation  @@unique([instrumentId, date, basis])          ← no provider dimension

WHO TRIGGERS BACKFILL
  lib/plaid/backgroundHistorySync.ts:243   ← on connect / history sync   [EXISTS]
  lib/investments/holding-price-backfill.ts ← thin wrapper
  jobs/fetch-security-prices.ts             ← daily trailing-edge capture
  scripts/backfill-security-prices.ts       ← manual
  (nothing in jobs/sync-crypto.ts or lib/crypto/*)                       [ABSENT]

CONSUMPTION
  lib/investments/valuation.ts  getInvestmentValueAsOf / ForWindow  ← reads PriceObservation only
        ▼
  lib/snapshots/regenerate-history.ts:360  (excludeDigitalAssetAccounts: true)
        ▼
  SpaceSnapshot → wealth-time-machine → charts / drivers / attribution
```

**Who waits for coverage: nobody.** Who ignores it: A9 regeneration, snapshot backfill, charts, attribution.

---

## 3 · Initial-synchronisation lifecycle audit

### 3.1 Plaid investment account — order verified in `backgroundHistorySync.ts`

| # | Step | Line |
|---|---|---|
| 1 | Snapshot backfill — **investments held FLAT** | `:177` `backfillSpaceSnapshots` |
| 2 | Position reconstruction | `:213` `reconstructAccount` |
| 3 | **Historical price backfill** — held instruments, `quantity > 0` | `:243` |
| 4 | **A9 wealth regeneration** | `:277` `regenerateWealthHistoryForItem` |

| Question | Answer |
|---|---|
| Does historical price backfill run during initial sync? | **Yes** |
| Synchronous / awaited? | **Yes, awaited** |
| Fire-and-forget? | No — but **non-fatal**: `catch` logs and continues (`:255`) |
| Does snapshot generation run before it? | **Yes — step 1 precedes it**, writing flat-held rows first |
| Can valuation run against partial coverage? | **Yes.** Budget truncation ("deferred N to next connect") and provider failure both leave regen to proceed |
| Durable "prices still loading" state? | **[ABSENT]** |
| Does a later sync retry gaps? | **Yes** — missing-only backfill is idempotent and resumes |
| Provider fails halfway? | Successful sub-ranges persist (chunked writes); the rest retries next connect. **Good behaviour** |

### 3.2 BTC wallet

| Step | Reality |
|---|---|
| Account creation | wallet route / `btc-sync` |
| Instrument resolution | `resolveCryptoInstrumentId` — symbol-keyed **[EXISTS]** |
| Balance | `btc-sync` computes `balance = quantity × **spot** price` |
| `PositionObservation` | `captureWalletPosition` **[EXISTS]** — but only from the day capture shipped |
| **Historical price backfill** | **[ABSENT]** — no call site |
| Snapshot regeneration | `jobs/sync-crypto.ts:56` → `regenerateWealthHistoryForAccounts(..., recentWealthWindow())` = **30 days** |
| Result | flat crypto before 30 days; no price history; no quantity history |

### 3.3 Reconstructed production sequence — instrument introduced without coverage

**BTC.** Wallet held since ~2023 (local shows crypto transactions from 2023-03-24). In production:

- `PositionObservation`: **9 rows**, first **2026-07-22** — capture began then.
- `PriceObservation`: **39 rows**, first **2026-06-21** — daily capture accruing since the CoinGecko adapter shipped.
- Snapshots before 2026-07-22: crypto **flat at today's value**, `isEstimated = true`.

**Nothing in the connect path ever requested BTC price history for the ownership window, because no crypto path calls the backfill.** This is the missing trigger, proven.

**Counter-example that proves the mechanism works when wired:** every equity has 505 price rows from 2024-07-24 — earlier than its first position — because the Plaid path *does* call it.

---

## 4 · Required historical window

**Your hypothesis:**
```
requiredPriceWindow = earliest date quantity may be non-zero … latest required valuation date
```

**Endorsed, with one correction and one addition.**

**Correction — "may be non-zero" is not knowable from positions alone.** `backfill.ts:11` already computes *"earliest defensible activity (first observation / …)"*, which is the right instinct, but a first **observation** is not first **ownership**. BTC proves it: first observation 2026-07-22, actual ownership ~2023. Deriving the floor from observations alone silently truncates history.

**[PROPOSED] three-tier window:**

```
KNOWN      max(earliest PositionObservation, earliest InvestmentEvent, earliest acquiring Transaction)
POSSIBLE   back to account connection date / first account transaction — quantity may have been non-zero
UNKNOWN    before that — no evidence either way
```

Fetch prices for **KNOWN ∪ POSSIBLE**. Never fetch for UNKNOWN — but represent it, so a chart range extending into prehistory returns *unknown*, not zero.

**Addition — the ceiling is not "today".** It is `max(today, latest required valuation date)`, which for a sold position is its disposal date. **Coverage must not be scoped to currently-held instruments** — the `quantity > 0` filter at `backgroundHistorySync.ts:236` is a real defect: a position sold in 2025 needs 2024–2025 prices to value 2024–2025 history correctly, forever.

**Edge cases:** acquisitions predating connection → POSSIBLE; unknown acquisition date → POSSIBLE floored at connection; transfers between accounts → window is per **instrument**, not per account, so custody changes are irrelevant; crypto received before wallet connection → POSSIBLE, reconstructible from chain (`btc-sync` already imports txids); corporate actions → out of scope until `InvestmentEvent` lineage is modelled.

---

## 5 · Coverage semantics

`MIN`/`MAX` is insufficient — it cannot see internal gaps, and production has a live example (CUR:USD: 7 price rows spanning 2026-07-22→07-29).

**[PROPOSED] minimal contract.** Deliberately reuses the existing `CompletenessTier` vocabulary (`lib/perspective-engine/completeness.ts` **[EXISTS]**, already used by A8/A9 via `worstTier`) rather than minting a fourth status vocabulary:

```ts
type MissingReason =
  | 'NOT_FETCHED' | 'PROVIDER_LIMIT' | 'PRE_LISTING' | 'PROVIDER_FAILURE'
  | 'UNRESOLVED_IDENTITY' | 'UNSUPPORTED_INSTRUMENT' | 'INVALID_OBSERVATION';

interface MissingRange { from: string; to: string; reason: MissingReason }

interface HistoricalPriceCoverage {
  instrumentId: string;
  requested:    { from: string; to: string };
  expectedDays: number;          // per the instrument calendar — NOT calendar days
  coveredDays:  number;
  missing:      MissingRange[];  // compressed ranges, not a date array
  invalidDates: string[];        // price <= 0, wrong currency, wrong basis
  tier:         CompletenessTier;   // reuse — do not invent
}
```

**Deliberate omissions from your draft:** `expectedDates: Date[]` and `coveredRanges` — a two-year equity window is ~500 dates; materialising arrays per instrument per request is wasteful when compressed ranges plus counts answer every question. `CoverageStatus` is dropped in favour of `CompletenessTier`, which the valuation core already propagates.

**Non-trading days are a calendar concern, not a gap.** Crypto = 7-day; equities = exchange calendar. A missing Saturday for AAPL is `NON_TRADING_DAY` (not missing at all); a missing Saturday for BTC is `NOT_FETCHED`. **The planner must take the calendar as an input, never infer it from the data** — inferring "no price ⇒ not a trading day" makes gaps invisible by construction.

---

## 6 · Central service seam

**The best existing seam is `lib/prices/backfill.ts`.** It already owns per-instrument window resolution, missing-only planning, chunking, resumability and a budget. It is ~80% of the orchestrator; what it lacks is (a) a *reportable* coverage result and (b) callers who treat that result as a gate.

**[PROPOSED] two layers, both in `lib/prices/`:**

```
lib/prices/coverage.core.ts     planHistoricalPriceCoverage(input): CoveragePlan
                                pure — no DB, no network. Follows the 23-module *-core.ts convention.

lib/prices/coverage.ts          ensureHistoricalPriceCoverage(input): Promise<CoverageResult>
                                reads PriceObservation → plans → fetches missing → archives → re-evaluates
```

**Why `lib/prices/` and not the alternatives:** `lib/investments/` would re-bind crypto to an investments namespace (the special case we are trying to delete); synchronisation would couple coverage to Plaid; the Financial Truth Resolver **must not** call providers (law 7); `jobs/` is a caller, not a home. Prices are a global evidence domain — they belong with the archive that stores them.

**Naming:** `ensureHistoricalPriceCoverage` is good and matches repo idiom (`ensure*`, `resolve*`, `capture*`). `planHistoricalPriceCoverage` in a `.core.ts` matches the pure-core convention exactly.

---

## 7 · Provider capability audit

Can an adapter express what generic orchestration needs?

| Capability | Status |
|---|---|
| Supported instrument classes | **[ABSENT]** — registry order is the only routing |
| Canonical provider instrument id | **[ABSENT]** — `BTC_COIN_ID` is a module constant |
| Supported currencies | **[ABSENT]** — USD assumed |
| Max historical window / earliest history | **[ABSENT]** |
| Chunk-size limit | partial — `chunkDays` is a *caller* option, not a provider property |
| Market calendar | **[ABSENT]** |
| Rate limit | **[INFERRED]** in adapter internals, not declared |
| Adjusted vs unadjusted | **[EXISTS]** — `PriceBasis` on the observation |
| Partial response / explicit truncation | **[ABSENT]** — the crypto investigation flagged this |
| Unsupported instrument / delisting | **[ABSENT]** |

**[PROPOSED] minimal additions — a capability descriptor, not a redesign:**

```ts
interface PriceProviderCapability {
  id: string;                                  // 'tiingo' | 'coingecko'
  supports(instrument): boolean;               // by assetClass + identity presence
  resolveProviderId(instrument): string | null;// ticker | coinId — null ⇒ unsupported
  calendar: 'EXCHANGE_US' | 'CRYPTO_DAILY';
  maxWindowDays: number | null;                // tier limit
  earliestAvailable: string | null;
  maxChunkDays: number;
}
```

Plus one change to the fetch return shape: report the **actually covered** sub-window alongside rows, so truncation is explicit rather than inferred from row counts. That single addition satisfies law 6 for both providers and removes the last reason for provider-specific logic in the planner.

---

## 8 · PriceObservation as central evidence

| Facet | Status |
|---|---|
| `instrumentId`, `date`, `price`, `currency`, `basis`, `source`, `fetchedAt` | **[EXISTS]** |
| Uniqueness | **[EXISTS]** `@@unique([instrumentId, date, basis])` |
| `providerInstrumentId` | **[ABSENT]** |
| Confidence / corrections / versioning | **[ABSENT]** |

### The key question: one canonical price, or many provider observations?

**The current key already answers it: one price per `(instrument, date, basis)` — no provider dimension.** Two providers cannot both store a close for the same date; the second collides.

**Recommendation: keep it that way.** Adding `source` to the key would let Tiingo and CoinGecko both persist AAPL for 2025-03-04, and every downstream read would then need a precedence resolver — turning a settled question into a per-query decision, and making historical values depend on *which* rows happened to exist. That is precisely the read-time nondeterminism this programme is eliminating.

**Consequences, stated honestly:**
- **Reproducibility: improved.** One instrument-date-basis has exactly one value; a sealed valuation cannot silently change because a second provider arrived.
- **Corrections: constrained.** A revised close must *upsert* the existing row, losing the prior value. Acceptable today (`fetchedAt` records recency); when `Truth` seals valuations (V26-F3), the *value used* is captured in the sealed artifact, so the price row may be corrected without rewriting history.
- **Precedence moves to write time** — the registry's failover order decides who wins, which is where the decision belongs.

**`providerInstrumentId` is sufficient for this initiative** and is the one field worth adding: it records *which* CoinGecko id or ticker produced a row, which is what makes fork/rename/delisting auditable. Defer confidence and versioning — the confidence vocabulary should be unified once (V26-F3 §12), not extended piecemeal.

---

## 9 · Sync orchestration design

| Trigger | Coverage checked | Execution | Valuation waits? | Charts wait? |
|---|---|---|---|---|
| New account connected | Yes | queued job, per instrument | **Evaluation yes, completion no** | No |
| New wallet connected | **Yes — currently missing** | queued | same | No |
| New instrument in existing account | Yes | queued | same | No |
| **Earlier ownership date discovered** | Yes | queued, **leading range only** | same | No |
| User requests longer chart range | Yes | queued; render unknown meanwhile | No | No |
| Prior partial history | Yes — resumes | queued | same | No |
| Daily trailing edge | Yes | existing cron | No | No |
| Identity corrected | Yes — re-plan under new identity | queued | same | No |

**The distinction that matters, and it resolves your Part 14 question:** valuation waits for coverage to be **evaluated**, never for it to be **complete**. Requiring completeness would block Truth on an external vendor — violating law 10, since a provider outage would become a missing net worth. Requiring evaluation costs one indexed query and yields an honest `tier` plus an unvalued remainder.

**Job granularity: per canonical instrument + window, deduplicated globally.** Not per account (an instrument in two accounts fetches twice), not per Space (law 4 — AAPL's close is not user-specific), not per provider batch (one failing instrument would poison the batch). Per-instrument is the natural unit of the unique key and of the dedupe.

---

## 10 · Idempotency and concurrency

| Hazard | Current protection |
|---|---|
| Two Spaces own the same instrument | **[EXISTS]** — `PriceObservation` is global; second write is a no-op |
| Duplicate rows on overlapping fetch | **[EXISTS]** — `@@unique([instrumentId, date, basis])` + `createMany` |
| Daily capture racing historical backfill | **[EXISTS]** — same constraint |
| Two providers, same date | **[EXISTS]** — constraint forbids it |
| Retry after timeout | **[EXISTS]** — missing-only planning resumes |
| Partial DB failure | **[EXISTS]** — chunked writes; completed chunks persist |
| **Duplicate concurrent jobs for the same instrument** | **[ABSENT]** — no dedupe key |
| **Snapshot regen starting before archive completes** | **[ABSENT]** — no gate |

**Two invariants to add [PROPOSED]:**
1. **Global dedupe by `(instrumentId, from, to)`** — the claim-lock pattern at `lib/plaid/sync-lock.ts:74` (conditional `updateMany`) is the proven primitive and needs no new mechanism.
2. **Valuation consumes a committed set** — coverage is evaluated *after* archive commit, never against in-flight writes.

The existing constraint already makes duplicate work *safe*; it does not make it *avoided*. That is an efficiency gap, not a correctness one.

---

## 11 · Partial coverage and unknown propagation

`getInvestmentValueAsOf` already returns *"a valued subtotal plus an explicit unvalued remainder; never a partial total presented as the whole"* (`valuation.ts:142-143`) with a `tier`. **The contract is already correct at the valuation layer.** The information is destroyed downstream:

| Layer | Fate of the unvalued remainder |
|---|---|
| `getInvestmentValueForWindow` | **preserved** — valued + unvalued + tier |
| `regenerate-history.core.ts:160` | **collapsed** — only `investmentValue` is used; the remainder is dropped |
| `SpaceSnapshot` | **collapsed further** — one `isEstimated` boolean for the whole day |
| `wealth-time-machine` | carries `isEstimated` per point **[EXISTS]** |
| `WealthChangeLedger` | **discarded** — never reads it (prior investigation) |

**Three lossy hops.** The fix is not new plumbing at the top; it is stopping the collapse at hop one and surfacing at hop four.

---

## 12 · Durable coverage state

**Recommendation: B — persist job state only; derive coverage.**

Your stated principle is right and the repo agrees: prices are truth, job progress is operational metadata. Coverage over `@@index([instrumentId, basis, date])` is a cheap indexed scan for a few hundred rows.

**Option C (a coverage record) is rejected** — it is a cache of a derivable fact, and every such cache eventually disagrees with its source. That is exactly the `SpaceSnapshot` failure mode this programme is unwinding; repeating it one layer down would be self-defeating.

**Option A (derived only) is insufficient** for one reason: *why* a range is missing is **not** derivable from absence. `PRE_LISTING`, `PROVIDER_LIMIT` and `PROVIDER_FAILURE` are indistinguishable from `NOT_FETCHED` by looking at `PriceObservation`. That reason must be recorded — as **attempt metadata**, not as coverage.

`JobRun` **[EXISTS]** with deployment stamping and is the natural host; it does not currently carry a per-instrument cursor. That is the minimal addition.

---

## 13 · Production and local coverage audit

**Production — 19 instruments with positions:**

| Instrument | Class | Positions | Price rows | Price window | Assessment |
|---|---|---|---|---|---|
| QBTS, APLD, VST, VGT, OKLO, VRT, … | EQUITY/ETF | 9 each, from 2026-06-25 | **505 each** | 2024-07-24 → 2026-07-29 | **Coverage leads ownership.** Plaid path working |
| **BTC** | CRYPTO | **9**, from 2026-07-22 | **39** | 2026-06-21 → 2026-07-29 | **Both quantity and price history absent** |
| CUR:USD | CASH | 19, from 2025-08-27 | 7 | 2026-07-22 → 07-29 | cash needs no market price |
| Invalid prices (`price <= 0`) | — | — | **0** | — | clean |

**Interpretation.** Equities disprove the general form of the hypothesis: initial sync *does* ensure coverage where it is wired. BTC proves the specific form: no crypto trigger exists, and BTC's position history is 9 days against ~3 years of ownership.

**Local** shows the same shape with different severity (prior investigation: 23-day valuation dropout vs production's 92 negative days) — same code, different completeness.

**Conclusion: initial sync is the missing trigger for crypto only.** For equities the missing piece is not the trigger but the *gate* and the `quantity > 0` scoping.

---

## 14 · Performance and cost

| Metric | Estimate |
|---|---|
| Rows per instrument-year | ~252 (equities) · 365 (crypto) |
| Row size | ~100 B → **<40 KB per instrument-year** |
| Production today | 19 instruments × ~505 rows ≈ **9.6k rows** — trivial |
| Initial sync calls | 1–3 per instrument (365-day chunks) |
| Daily incremental | 1 batched call per provider |
| Coverage computation | one indexed range scan per instrument |
| Repair of BTC history | ~3 calls, ~1,100 rows |

**Global de-duplication is already achieved** and is the architecture's best existing property: `PriceObservation` is keyed by instrument, **not** by Space or user. Ten users holding AAPL share one price history. Law 4 is satisfied by the schema as it stands.

**Recommended fetch granularity: per canonical instrument, batched by provider where the API supports it, deduplicated globally by `(instrumentId, range)`.** Never per Space or per account.

---

## 15 · Financial Truth integration

```
External market data
      ↓  (jobs / sync triggers — the ONLY place providers are called)
Historical Price Coverage Service
      ↓
PriceObservation   ← stored evidence
      ↓
Financial Truth Resolver          ← reads evidence ONLY; never calls a provider
      ↓
Historical valuation → Snapshots → Charts → Attribution → Assessment
```

**Answering your challenge: coverage completion is *both*, and the split is by request type.**

- **Enrichment (asynchronous)** for compilation triggered by sync, schedule, or discovery. Truth seals with whatever evidence exists and records the unvalued remainder.
- **Prerequisite (blocking)** only for an explicit user act that *demands* completeness — "rebuild my history", an export, a tax report. Those may legitimately wait, and must say so.

**What can be sealed with incomplete price history:** everything — provided the seal carries the unvalued remainder and its reason. A Truth object that says *"$4,966 valued, one instrument unpriced 2024-01→2026-06 (PROVIDER_LIMIT)"* is honest and useful. One that says *"$4,966"* is neither.

**This is the load-bearing rule:** incompleteness is a property of the sealed artifact, not a reason to refuse to seal.

---

## 16 · Repair strategy

Ordering is the substance:

1. **Ship the non-negativity + coverage guard** (prior investigation, still unshipped). Without it, every later step can be re-corrupted.
2. **Ship provider capability + generic CoinGecko adapter** (crypto investigation, V26-CRYPTO-1).
3. **Audit required windows** — read-only report per instrument: KNOWN/POSSIBLE/UNKNOWN.
4. **Fetch missing prices** — missing-only, resumable, additive to `PriceObservation`. Safe: no user-facing value changes.
5. **Read-only coverage report** — post-fetch tiers per instrument.
6. **Dry-run valuations** — old flat vs new valued vs unvalued remainder, **no writes**.
7. **Review remainders** — if large, the change substitutes an incomplete number for a wrong one. A conscious decision, not an automatic one.
8. **Enable crypto historical valuation** (the complementary call).
9. **Regenerate estimated snapshots only** — `skip-frozen` already guarantees observed rows are untouched.
10. **Validate** charts, attribution, integrity probe.
11. **Confirm a later sync does not rewrite sealed periods** — law 8.

**Rollback:** steps 3–7 are read-only or additive. Price rows are deletable by `(instrument, source, range)`. Snapshot regeneration is flag-gated and reversible. **Observed rows are never touched at any step** — the property that makes this repairable.

**Rerun:** every step is idempotent by construction (unique constraint + missing-only planning).

---

## 17 · Validation strategy

**Coverage (pure, no I/O):** complete coverage ⇒ **zero** provider calls · only missing ranges fetched · internal gaps detected · crypto expects 7-day calendar · equities respect exchange calendar · truncation reported not inferred · partial response never labelled complete · re-run idempotent.

**Valuation:** no value produced from a price row dated after the valuation date *(the single highest-value test — it is what would have caught the flat-crypto class years ago)* · missing price ⇒ unvalued remainder, never a smaller "complete" total · deterministic value for fully-covered windows · **historical values unchanged after an unrelated account sync** (law 8) · two users holding one instrument share one price history · BTC and AAPL traverse the identical interface.

**Orchestration:** initial sync enqueues coverage · snapshot regen cannot outrun archive commit · duplicate jobs produce no duplicate rows · failure retries without losing successful sub-ranges · discovering an earlier ownership date extends **only the leading** range.

**Integrity probe [PROPOSED]** — read-only, non-zero exit on findings, modelled on `scripts/check-external-id-duplicates.ts`: instruments with positions but insufficient prices · internal gaps · invalid prices (`<= 0`, currency/basis mismatch) · snapshots whose investment component was flat-held while prices existed · provider truncation · stale trailing edge.

---

## 18 · Implementation phases

| Phase | Objective | Files | Schema | Numbers change? | Rollback |
|---|---|---|---|---|---|
| **P0** | Non-negativity + coverage guard *(prior investigation)* | `regenerate-history.core.ts` | none | No | revert |
| **P1** | **Pure coverage planner** | `lib/prices/coverage.core.ts` (new) | none | **No** | delete |
| **P2** | Provider capability descriptor + explicit truncation | `registry.ts`, `providers/*` | none | No | revert |
| **P3** | Coverage orchestrator | `lib/prices/coverage.ts` (new) | none | No (writes prices only) | disable |
| **P4** | Crypto sync triggers coverage | `jobs/sync-crypto.ts`, wallet routes | none | No | flag |
| **P5** | Drop `quantity > 0`; window = KNOWN ∪ POSSIBLE | `backgroundHistorySync.ts`, `backfill.ts` | none | No | revert |
| **P6** | Valuation gate — evaluate coverage, propagate remainder | `regenerate-history.*` | none | **Yes** | flag |
| **P7** | `providerInstrumentId`; job cursor state | schema (additive) | **additive** | No | drop column |
| **P8** | Production audit + repair | scripts | none | **Yes** | regenerate |
| **P9** | Unified portfolio rollup; delete `excludeDigitalAssetAccounts` | valuation + snapshots | none | **Yes** | flag |

**Ordering change from your draft:** provider capability (P2) moves *before* the orchestrator (P3) — the orchestrator cannot be provider-agnostic until adapters can declare a calendar and a limit; building it first would bake in the special-casing this initiative exists to remove.

---

## 19 · Exact first implementation ticket

> **V26-PRICE-1 · Pure historical price coverage planner**
>
> **Problem.** Nothing in the repository can answer "is this instrument's price history sufficient for this window?" `backfillPricesForInstruments` computes a window and fetches missing ranges, but returns counts — not a coverage verdict. Consequently no caller can gate on coverage, and A9 regeneration values history against whatever happens to exist.
>
> **Files**
> - `lib/prices/coverage.core.ts` (new) — pure, matching the 23-module `*-core.ts` convention.
> - `lib/prices/coverage.core.test.ts` (new).
>
> **Types** (smallest coherent contract — reuses `CompletenessTier`, mints no new status vocabulary)
> ```ts
> type PriceCalendar = 'CRYPTO_DAILY' | 'EXCHANGE_US';
> type MissingReason = 'NOT_FETCHED' | 'PROVIDER_LIMIT' | 'PRE_LISTING'
>                    | 'PROVIDER_FAILURE' | 'UNRESOLVED_IDENTITY'
>                    | 'UNSUPPORTED_INSTRUMENT' | 'INVALID_OBSERVATION';
> interface MissingRange { from: string; to: string; reason: MissingReason }
> interface CoverageInput {
>   requested: { from: string; to: string };
>   observed:  Array<{ date: string; price: number; currency: string; basis: string }>;
>   calendar:  PriceCalendar;
>   expectedCurrency: string;
>   expectedBasis: string;
>   providerEarliest?: string | null;   // ⇒ PROVIDER_LIMIT / PRE_LISTING
> }
> interface CoverageResult {
>   expectedDays: number; coveredDays: number;
>   missing: MissingRange[]; invalidDates: string[];
>   tier: CompletenessTier;
> }
> export function planHistoricalPriceCoverage(i: CoverageInput): CoverageResult;
> ```
>
> **Algorithm**
> 1. Expand `requested` into expected dates **using the calendar** — crypto every day; equities excluding weekends and a supplied holiday set. The calendar is an **input**; never infer non-trading days from missing data.
> 2. Reject invalid observations (`price <= 0`, non-finite, currency or basis mismatch) into `invalidDates` — they do **not** count as coverage.
> 3. Diff expected vs valid observed; compress consecutive missing dates into ranges.
> 4. Attribute a reason: before `providerEarliest` ⇒ `PRE_LISTING`/`PROVIDER_LIMIT`; otherwise `NOT_FETCHED`.
> 5. Map to `CompletenessTier` via the existing `worstTier` helper.
>
> **Tests**
> - Full coverage ⇒ zero missing, best tier.
> - Leading, trailing and **internal** gaps each detected and compressed.
> - Crypto expects weekends; equities do not (a missing Saturday for AAPL is not a gap).
> - `price <= 0` ⇒ `invalidDates`, and the date is **not** counted as covered.
> - Currency/basis mismatch ⇒ invalid, not covered.
> - Dates before `providerEarliest` ⇒ `PRE_LISTING`, not `NOT_FETCHED`.
> - Determinism: same input ⇒ identical output.
> - **Purity guard:** the module imports nothing from `@prisma/client`, `lib/db`, or any provider — source-scanned, so the boundary cannot erode.
>
> **Explicit exclusions.** No DB access. No provider calls. No changes to `backfill.ts`, `archive.ts`, `registry.ts`, `regenerate-history.*`, snapshots, charts, or valuation. **No stored value changes.** No schema. No new status vocabulary.
>
> **Completion.** Suite green with the new tests, `tsc` clean, lint clean, and `planHistoricalPriceCoverage` correctly classifies the production shapes: BTC (39 rows over a ~3-year ownership window ⇒ large `NOT_FETCHED` leading range) and an equity (505 rows ⇒ complete over its window).

---

## 20 · Final answers

**Is initial synchronisation responsible for ensuring historical price coverage?**
**Partially — and asymmetrically.** For Plaid investments, yes: `backgroundHistorySync.ts:243` awaits `backfillPricesForInstruments` on every connect, and production shows it working (505 rows per equity, back to 2024-07-24, predating first position). For crypto, **no** — no crypto path calls it.

**If not, what currently triggers price backfill?**
Three things, none of them crypto: the Plaid connect/history path; the daily `fetch-security-prices` cron (trailing edge only); and a manual script. BTC's 39 price rows are daily-capture accrual, not backfill.

**Can historical valuation and snapshot generation run before coverage is complete?**
**Yes, and they routinely do.** Snapshot backfill runs *first* with investments held flat; the price backfill is budget-bounded, truncatable and non-fatal; A9 regeneration then runs regardless. No gate exists anywhere.

**Single central entry point?**
`ensureHistoricalPriceCoverage()` in `lib/prices/coverage.ts`, over a pure `planHistoricalPriceCoverage()` in `lib/prices/coverage.core.ts`.

**Global per instrument, or per Space?**
**Global per canonical instrument** — and this is already true: `PriceObservation` is keyed by instrument with no Space or user dimension. Law 4 is satisfied by the existing schema; only the *job* needs global dedupe.

**What prevents two concurrent syncs writing the same range?**
`@@unique([instrumentId, date, basis])` makes duplicate writes **safe** but not **avoided**. A claim-lock keyed on `(instrumentId, from, to)` — reusing `sync-lock.ts:74`'s conditional-`updateMany` pattern — is the missing piece.

**What evidence is required before a valuation may be labelled complete?**
For every held instrument, over the KNOWN ∪ POSSIBLE ownership window: a `PositionObservation`-derived quantity, a valid `PriceObservation` for every expected date on that instrument's calendar, and an `FxRate` where the currency differs — with zero `NOT_FETCHED` or `PROVIDER_FAILURE` ranges. Anything less is valued-with-remainder, never complete.

**First ticket?** **V26-PRICE-1 — pure historical price coverage planner** (§19).

---

> **Fourth Meridian treats `PriceObservation` as central financial evidence for equities — where the connect path fetches two years of history before valuation runs — but as optional input for crypto, where no path ever requests it and historical outputs are produced from a flat projection instead; the missing piece is not the store, which is well-designed and globally shared, but a coverage contract that every consumer of historical value is obliged to consult.**
