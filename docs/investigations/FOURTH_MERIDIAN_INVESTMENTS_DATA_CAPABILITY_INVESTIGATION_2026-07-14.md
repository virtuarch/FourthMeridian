# FOURTH MERIDIAN — INVESTMENTS DATA & CAPABILITY INVESTIGATION
## Report to ChatGPT and Christian — 2026-07-14

Investigation-only. No source files modified, no migrations created, nothing committed. Every claim below was verified against the working tree at `/Users/chrstn/dev/FourthMeridian` (branch `feature/v2.5-spaces-completion`, including the uncommitted Allocation work) and the installed `plaid@42.2.0` SDK types, by five parallel code-audit passes. Labels used exactly as requested: **VERIFIED · PARTIALLY VERIFIED · IMPLEMENTED BUT NOT SURFACED · AVAILABLE BUT DISCARDED · SCHEMA EXISTS BUT DATA COVERAGE UNKNOWN · PROVIDER-SUPPORTED BUT NOT VERIFIED IN PAYLOAD · RECONSTRUCTED · DERIVED · NOT CURRENTLY SUPPORTABLE · PROPOSAL · NEEDS RUNTIME/DB VERIFICATION.**

The local Postgres (docker-compose `fintracker-db`) was not reachable from this environment, so every real-world coverage number is NEEDS RUNTIME/DB VERIFICATION; §12 contains a complete read-only query pack to close that gap.

---

## 1. Executive verdict

**The Allocation backend claim is accurate, the code is good, and it should be committed — after three small pre-commit fixes (§5.9).** The nine-file diff exists exactly as reported, `computeAllocation`'s test was executed here (all 17 checks pass), and the semantics match the report: valued rows only, shares over the valued total, deterministic ordering, cash retained in composition but excluded from concentration, unvalued rows disclosed as a count.

**The most important single discovery of this investigation is not about allocation at all: cost basis is already persisted and 100% unread.** Plaid's `holding.cost_basis` has been flowing into `PositionObservation.costBasis` on every capture (plus CSV imports and manual opening positions), and no UI, valuation path, AI assembler, or export reads it. Unrealized gain/loss — the single most-requested investment feature class — is blocked by a missing *reader*, not missing data. The same is true of `vested_quantity`, `securitySubtype`, `industry`, and the raw `option_contract`/`fixed_income` JSON blobs: all captured, none read. **VERIFIED.**

**The architecture is unusually honest and unusually ready.** The A8 (price archive) / A9 (wealth regen) / A10 (time machine) stack carries per-row completeness tiers, staleness metadata, FX taint flags, reconstruction conflict records, and an `unexplainedOpeningQuantity` that is never zeroed. Almost every capability in Part C of the brief is a pure helper over the existing `ValuedHoldingRow[]`, not a new engine. Nine of the ten requested cross-dimensional intersections need zero backend work.

**The one structural dishonesty to manage:** instrument classification (assetClass, sector, isCashEquivalent) is *current, first-seen, never-refreshed* metadata joined onto historical rows. Historical allocation "works" today for any asOf date, but the classification axes are current-metadata-applied-to-historical-positions, and the instrument metadata is also create-only (never refreshed on later syncs) — a quiet staleness bug in both directions of time. Fixable cheaply (§9, §17).

**What genuinely requires external data** is a short list: fund look-through, benchmarks/risk analytics, split-adjusted per-instrument returns (partially recoverable from the existing Tiingo vendor — its payload already includes adjClose/splitFactor/divCash and the adapter deliberately reads only `close`), corporate-action ratios, and tax-lot intelligence. None of it blocks the next several UI slices.

---

## 2. Current investment architecture map

**VERIFIED** throughout (file:line evidence in the sections that follow).

Two parallel read models exist by design:

1. **Legacy current-state model** — `Holding` table (symbol, name, quantity, price, value, change24h, isCash, currency). Written by `lib/investments/sync-current-holdings.ts` from Plaid holdings (skipping cash and no-ticker securities by design) and by `lib/crypto/btc-sync.ts`. Read by `GET /api/spaces/[id]/investments` → `InvestmentConnectionsCard`, and by the **AI holdings assembler** (`lib/ai/assemblers/holdings.ts`). No FK to `Instrument`; no assetClass/sector/costBasis columns.
2. **Evidence-grade A-track model** — `Instrument` + `InstrumentAlias` (canonical security identity; CUSIP/ISIN/SEDOL/ticker/MIC, assetClass/sector/industry/type/subtype/isCashEquivalent, raw optionMeta/fixedIncomeMeta JSON), `PositionObservation` (append-only position evidence: quantity, institutionPrice/Value/AsOf, **costBasis**, vestedQuantity, currency, isCash; origins OBSERVED/IMPORTED/DERIVED/USER_ASSERTED), `InvestmentEvent` (20-type canonical vocabulary with raw provider type/subtype preserved), `PositionReconstruction` (backward-walk summaries with failure/conflict/unexplained-residual fields), `PriceObservation` (per instrument×date×basis; sources plaid/tiingo/coingecko), `FxRate` (USD-base archive, 24 quotes). Read by the **A10 time machine** (`investments-time-machine.ts` → valuation → `ValuedHoldingRow[]`) which powers the redesigned `InvestmentsPerspective` (Portfolio header, Holdings grid with trust tiers, Period Activity, Change Bridge, and now the Allocation panel), and by **A9** wealth regeneration into `SpaceSnapshot.stocks/crypto`.

Ingestion paths: initial Plaid exchange, refresh (manual button, daily cron, Enable-Investments, webhook `HOLDINGS/DEFAULT_UPDATE` and `TRANSACTIONS/SYNC_UPDATES_AVAILABLE` → full deferred pipeline: sync → snapshots → reconstruction → price backfill → wealth regen), CSV import (`csv:schwab`, `csv:generic` profiles → same canonical event log, soft-delete rollback), manual opening positions (USER_ASSERTED observation + OPENING_BALANCE event, optional costBasis), and BTC self-custody sync (single global BTC Instrument, CoinGecko prices). **VERIFIED.**

Everything history-grade is env-flag-gated: `INVESTMENT_OBSERVATIONS_ENABLED`, `INVESTMENT_EVENTS_ENABLED`, `INVESTMENT_RECONSTRUCTION_ENABLED`, `SECURITY_PRICES_ENABLED`, `INVESTMENT_IMPORTS_ENABLED`, `TIINGO_API_KEY`, `COINGECKO_API_KEY`. Whether production tables actually contain data is therefore **NEEDS RUNTIME/DB VERIFICATION** in every case (§12).

Plaid surface actually used: `itemPublicTokenExchange`, `accountsGet`, `investmentsHoldingsGet`, `investmentsTransactionsGet` (24-month window, 500/page), `transactionsSync` (banking only). `/investments/refresh` is never called; link tokens are Transactions-only with Investments consent via `additional_consented_products`, gated per item by `PlaidItem.investmentsConsent`. **VERIFIED.**

---

## 3. Provider-to-UI data-flow diagram

```
                         PLAID                                   CSV / USER / WALLET
  ┌──────────────┬─────────────────────┬──────────────────┐   ┌──────────┬─────────────┐
  │ accountsGet  │ investmentsHoldings │ investmentsTxns  │   │ CSV file │ user assert │  BTC explorer
  │ (balances,   │ Get (holdings +     │ Get (24-mo,      │   │ (schwab/ │ (opening    │  + CoinGecko
  │  consent)    │  securities)        │  securities)     │   │ generic) │  position)  │
  └──────┬───────┴───────┬─────────────┴────────┬─────────┘   └────┬─────┴──────┬──────┘
         │               │                      │                  │            │
         v               v                      v                  v            v
  FinancialAccount   A1 position-capture   A3 event-ingest   A7 import-commit  btc-sync
  (balance, avail,   ├─ instrument-resolver ─────────────────────┤ (resolver-import)
   currency, asOf)   │        │                                  │
         │           │        v                                  │
         │           │   Instrument + InstrumentAlias  <─────────┤   (global BTC Instrument)
         │           v                                           v
         │   PositionObservation(OBSERVED:            PositionObservation(IMPORTED /
         │    qty, instPrice/Value/AsOf,               USER_ASSERTED: qty, costBasis)
         │    costBasis, vestedQty, isCash)           InvestmentEvent(csv:*/user,
         │           │                                 importedRaw JSON, ratio)
         │           │      InvestmentEvent("plaid": type/subtype raw+canonical,
         │           │      qty, price, amount(sign-normalized), fees, ccy, datetime)
         │           v
         │      A4 reconstruction-runner ──> PositionObservation(DERIVED)
         │                                   + PositionReconstruction(summary)
         ├──> A2 sync-current-holdings ──> Holding (symbol,…,change24h)
         │
         │   Security.close_price/as_of ──> A8-2 capture ─┐
         │   Tiingo backfill + daily cron ─────────────────┼──> PriceObservation
         │   CoinGecko BTC ────────────────────────────────┘    (date, basis, source)
         v
  ┌──────────────────────────── READERS ───────────────────────────────────────────┐
  │ Holding ──> /api/spaces/[id]/investments ──> ConnectionsCard; AI holdings asm   │
  │ PosObs+PriceObs+FxRate ──> valuation(A8-4) ──> time-machine(A10) ──> Perspective│
  │   (Portfolio header · Holdings grid w/ tiers · NEW Allocation panel)            │
  │ InvestmentEvent ──> period flows ──> Activity + Change Bridge cards             │
  │ valuation ──> A9 regenerate-history ──> SpaceSnapshot.stocks ──> Wealth charts  │
  └──────────────────────────────────────────────────────────────────────────────── ┘
```

Note the asymmetry that matters for product work: the AI assembler and Connections card read the **left-behind legacy `Holding` path**; the Investments Perspective reads the **A10 evidence path**. They can and will disagree (§5.7).

---

## 4. Field-level data inventory

Full field-by-field tables (with file:line evidence per cell) are in the companion inventory produced by this investigation; this section is the complete inventory in condensed form. Classification is exactly one of: fully-captured-and-used / captured-but-unused / available-but-discarded / single-ingestion-path-only / reconstructed-later / derived-by-FM / unavailable-from-provider / uncertain-needs-runtime-verification.

### 4.1 Security-level (Plaid `Security` object)

| Field | Persisted at | Used today | Classification |
|---|---|---|---|
| security_id | InstrumentAlias.externalId; InvestmentEvent.providerSecurityId | identity resolution, provenance | fully-captured-and-used |
| cusip / isin / sedol | Instrument (unique) | identity precedence 2/3/4 | fully-captured-and-used (PROVIDER-SUPPORTED BUT NOT VERIFIED IN PAYLOAD — CUSIP licensing may null these) |
| ticker_symbol | Instrument.tickerSymbol; Holding.symbol | UI symbol; **Tiingo price-fetch key** | fully-captured-and-used |
| name | Instrument.name; Holding.name | display | fully-captured-and-used |
| type | Instrument.securityType + derived assetClass | Allocation byAssetClass | fully-captured-and-used |
| **subtype** (33-value SDK vocabulary) | Instrument.securitySubtype | **no reader** | captured-but-unused |
| sector | Instrument.sector | Allocation bySector (new) | fully-captured-and-used — but create-only, never refreshed |
| **industry** | Instrument.industry | **no reader** | captured-but-unused |
| cfi_code | Instrument.cfiCode | no reader | captured-but-unused |
| is_cash_equivalent | Instrument.isCashEquivalent | cash classification | fully-captured-and-used (with the §5.6 seam) |
| market_identifier_code | Instrument.marketIdentifierCode | weak-identity tiebreaker | fully-captured-and-used |
| close_price / close_price_as_of | PriceObservation(RAW_CLOSE, "plaid"); feeds Holding.change24h | valuation walk-back | fully-captured-and-used (flag-gated → NEEDS RUNTIME/DB VERIFICATION) |
| update_datetime | — | — | **available-but-discarded** (crypto freshness signal) |
| iso/unofficial_currency_code | Instrument/PriceObservation/Holding currency (coalesced) | currency routing | fully-captured-and-used (iso-vs-unofficial provenance folded/lost) |
| institution_security_id | InstrumentAlias.metadata JSON | no reader | captured-but-unused |
| institution_id (on Security) | — | — | available-but-discarded |
| proxy_security_id | InstrumentAlias.metadata JSON | no reader (no proxy-price fallback) | captured-but-unused |
| **option_contract** (type, expiry, strike, underlying ticker) | Instrument.optionMeta raw JSON | **no reader** | captured-but-unused |
| **fixed_income** (yield_rate, maturity_date, issue_date, face_value) | Instrument.fixedIncomeMeta raw JSON | **no reader** | captured-but-unused |
| FIGI | not exposed by plaid@42.2.0 | — | unavailable-from-provider (this SDK version) |

### 4.2 Holding-level (Plaid `Holding` object)

| Field | Persisted at | Used today | Classification |
|---|---|---|---|
| quantity | Holding.quantity; PositionObservation.quantity | UI, valuation, reconstruction anchor | fully-captured-and-used |
| institution_price / institution_value | Holding.price/value; PositionObservation | UI; valuation anchors #2/#1 | fully-captured-and-used |
| institution_price_as_of | PositionObservation.institutionPriceAsOf | staleness | fully-captured-and-used |
| institution_price_datetime | — | — | available-but-discarded |
| **cost_basis** | **PositionObservation.costBasis** | **no reader anywhere** | **captured-but-unused** — the headline finding |
| **vested_quantity** | PositionObservation.vestedQuantity | no reader | captured-but-unused |
| **vested_value** | — | — | **available-but-discarded** (the only Holding field never touched) |
| iso/unofficial currency | 4-level coalesce into row currency | FX | fully-captured-and-used |

### 4.3 Investment-transaction-level (Plaid `InvestmentTransaction`)

| Field | Persisted at | Used today | Classification |
|---|---|---|---|
| investment_transaction_id | InvestmentEvent.externalEventId | dedupe [source, externalEventId] | fully-captured-and-used |
| type (6) + subtype (48) | providerType/providerSubtype raw + canonical 20-value InvestmentEventType (total mapper over 6×48) | flows, reconstruction | fully-captured-and-used |
| date | InvestmentEvent.date | flows window; walk order | fully-captured-and-used (settlement date, 24-month ceiling) |
| transaction_datetime | InvestmentEvent.datetime | no reader | captured-but-unused |
| name | InvestmentEvent.description (verbatim) | no UI yet (Activity uses aggregates) | captured-but-unused |
| quantity / amount / price / fees | InvestmentEvent (amount sign-normalized +in/−out; fees abs) | flows + reconstruction (price only used in restatement diff) | fully-captured-and-used (price: captured-but-unused) |
| cancel_transaction_id | — (deliberate; deprecated) | CANCEL rows kept as events | available-but-discarded (deliberate) |
| is_investments_fallback_item | transient — gates stale-row removal & disappearance zeros | data-safety gate | fully-captured-and-used (transient) |

### 4.4 Account-level

| Field | Persisted | Used today | Classification |
|---|---|---|---|
| balances.current | FinancialAccount.balance | totals; brokerage-cash residual input | fully-captured-and-used |
| balances.available (= withdrawable cash on investment accounts) | FinancialAccount.availableBalance | **not used in any investments view** | captured-but-unused (for investments) |
| balances.last_updated_datetime | balanceLastUpdatedAt | freshness | fully-captured-and-used |
| type/subtype | mapped to coarse AccountType only; **raw subtype (ira/401k/roth/brokerage/hsa) dropped** | routing | **available-but-discarded** — blocks the entire taxable-vs-retirement feature family |
| margin balance | n/a | negative brokerage-cash residual detected but only console.warn'd | unavailable-from-provider (inferable signal only) |

### 4.5 FM-derived / reconstructed

Holding.change24h (derived; flows into the DTO but **no .tsx renders it** — IMPLEMENTED BUT NOT SURFACED); derived brokerage cash (balance − Σ positions, tier-labelled); assetClass (derived from type/subtype/is_cash_equivalent); DERIVED position history via A4 backward replay (RECONSTRUCTED); historical valuation qty×price×FX (DERIVED, never persisted per-instrument — only SpaceSnapshot totals); disappearance zeros (explicit quantity-0 observations); CSV lot data preserved **verbatim, uninterpreted** in `importedRaw` (single-ingestion-path-only); tax lots as structured data — unavailable-from-provider (Plaid) / raw-only (CSV); `InvestmentEvent.relatedInstrumentId` and `Instrument.supersededById` / `status: DELISTED` / ADJUSTED_CLOSE, NAV, INTRADAY, CRYPTO_DAILY price bases — **SCHEMA EXISTS BUT DATA COVERAGE UNKNOWN, no writer found**.

---

## 5. Allocation capability audit (the uncommitted work)

### 5.1 Diff accuracy — VERIFIED
The claimed nine files exist exactly as reported: modified `investments-time-machine.ts`, `investments-time-machine-core.ts` (+test), `lib/ai/assemblers/holdings.ts`, `InvestmentsPerspective.tsx`; new `concentration.ts`, `investments-allocation-core.ts` (+test), `InvestmentAllocationPanel.tsx`. The working tree also contains **eight unrelated modified files** — the KD-20 personal-Space defense-in-depth hardening (`STATUS.md`, `app/api/accounts/manual/route.ts`, `app/api/brief/route.ts`, `Sidebar.tsx`, `purge.ts`, `space-account-link.ts`, `space.ts`) plus a comment-only `OverlaySurface.tsx` edit — cleanly separable, zero overlap. Untracked session artifacts (`.claude/`, `_git_context.txt`, `_to_delete/`, gitmeta files) must never be committed.

### 5.2 computeAllocation semantics — VERIFIED by test execution
The pure test was run here (node type-stripping, repo untouched): **all 17 checks pass.** Confirmed semantics: valued rows only (`reportingValue != null`); `unvaluedCount` disclosed, never zero-valued; share denominator = valued total, shares sum to 1 per axis; four axes (assetClass with humanized labels + UNKNOWN fallthrough, sector with `__unknown__` sentinel, accountId, native currency); deterministic ordering (value desc, key asc — byte-identical JSON on repeat input); **cash stays in all composition axes and is excluded only from concentration**; concentration aggregates valued non-cash rows **per canonical `instrumentId`** (same security in two accounts merges — pinned by test) over the non-cash total.

### 5.3 Metadata population — PARTIALLY VERIFIED
`readDisplay` selects `assetClass`, `sector`, `isCashEquivalent` from the live `Instrument` table; absent instrument → UNKNOWN / null / false, pinned by the new core test. **But**: (a) Instrument provider metadata is **create-only** — the resolver's alias hit short-circuits and never refreshes sector/industry/subtype, so instruments created before those columns existed may be null forever, and GICS reclassifications never land (VERIFIED write-path fact; population percentages NEEDS RUNTIME/DB VERIFICATION, §12 Q3/Q9); (b) CSV-imported instruments get whatever the import supplies — typically UNKNOWN class and null sector (the import resolver does not set sector); (c) crypto/BTC gets assetClass CRYPTO, null sector; (d) historical rows receive **current** metadata (§9).

### 5.4 Currency — VERIFIED comparable, one honesty gap
All values are `reportingValue`: FX-converted into the Space reporting currency at the asOf date before any weighting (convert-then-sum). Mixed-currency portfolios are safely comparable. The byCurrency axis is keyed on the holding's **native/quote (denomination) currency** — not account currency, not economic/geographic exposure (a USD-quoted ADR counts as USD); the panel doesn't say so. **Gap:** on a full FX miss, `convertMoney` passes the native amount through flagged only `estimated`; the Holdings table surfaces tier dots, but **the Allocation panel ignores `fxTier`/`overallTier` entirely** — estimated figures enter shares with no taint disclosure.

### 5.5 Account dimension — VERIFIED
Grouped by stable `FinancialAccount.id`; label from the accounts prop with "Unknown account" fallback. Shared-Space sanitization means below-FULL accounts show as "Unknown account" rather than leaking names. **However (pre-existing, KD-19-class): the A10 read scopes SpaceAccountLinks on `status: ACTIVE` only, with no `visibilityLevel` filter** — per-position symbol/name/value of BALANCE_ONLY/SUMMARY_ONLY-shared accounts flows to every Space member through the Holdings table and now through new allocation axes. The route header's "visibility is inherited" claim is inaccurate. Not introduced by this change, but the Allocation panel widens the exposure surface. Deserves its own tracked finding. NEEDS RUNTIME/DB VERIFICATION whether any investment account is actually shared below FULL.

### 5.6 The isCash seam — VERIFIED divergence
Valuation classifies cash via the per-observation row flag (`is_cash_equivalent === true || type === "cash"`); allocation's display join uses `Instrument.isCashEquivalent === true` only. A `type: "cash"` security with `is_cash_equivalent` unset is valued via the cash branch yet enters **concentration weights** while also appearing in the Cash asset-class slice. The docstring claiming "same source valuation.ts uses" is wrong. Cheap fix (§5.9).

### 5.7 Shared concentration doctrine — PARTIALLY VERIFIED
`concentration.ts` is byte-identical to the code removed from the AI assembler (formula, bands, guard — compared against the diff), and the assembler delegates to it. **But the two consumers still weigh different worlds:** AI = current `Holding` snapshot, keyed by *symbol*, **native unconverted values**, FULL-visibility filtered; Panel = as-of A10 valuation, keyed by *instrumentId*, reporting currency, no visibility filter. Same math, different inputs → the AI and the UI can state different concentration classifications for the same portfolio. Also `holdings.ts:231` still emits the now-false dataLimit "Asset-class and sector breakdown unavailable until security type is persisted." Duplicate-instrument risk: the resolver refuses merges on strong-id conflicts and can mint distinct Instruments for one real security → concentration **understated** (split weights); the AI's symbol-keying has the inverse failure. NEEDS RUNTIME/DB VERIFICATION (§12 Q10).

### 5.8 Component review — presentation-ready with nits
Placed first in the side column as claimed; honest empty state (includes unvalued count), unvalued footnote, concentration insight hidden on INSUFFICIENT_DATA. SegmentedControl has tablist roles and focus rings but no arrow-key roving tabindex (pre-existing primitive deviation from the APG tabs pattern — keyboard-operable but verbose). Bars are decorative divs alongside full text — screen-reader legible. Mobile: grid stacks in source order so Allocation lands after Holdings — acceptable. Copy nits: "top NVDA 73%" is 73% **of non-cash value**, unlabeled; Currency axis shows denomination without saying so. No slice selection exists; `dimension` state is panel-local; `InvestmentsHoldings` has no filter prop — cross-filtering is unwired but the seams are clean (§8). Tests: allocation core is well-fixture-tested; **no `concentration.test.ts` and no AI-assembler test at all** — the behavior-neutrality claim is inspection-verified, not regression-tested. `tsc`/eslint claims could not be re-run here (no node_modules); PARTIALLY VERIFIED.

### 5.9 Commit verdict
**Commit the nine Allocation files as one atomic feature commit** after three small fixes: (1) correct/remove the stale AI dataLimit line; (2) fix the isCash comment and align the flags (`isCash: r.isCashEquivalent === true || assetClass === "CASH"` or thread valuation's row flag); (3) label the concentration line "of non-cash holdings". File as follow-ups, not blockers: FX-taint disclosure in the panel, a direct `concentration.test.ts` + any AI-assembler test, the A10 visibility seam (own STATUS row), and the missing STATUS.md ledger entry for the feature itself. KD-20 files = separate commit; OverlaySurface comment = with KD-20 or docs; investigation doc = docs commit.

### 5.10 Per-dimension answers (the questionnaire)

**Asset class** — source `Instrument.assetClass` (EQUITY/ETF/MUTUAL_FUND/FIXED_INCOME/OPTION/CRYPTO/CASH/OTHER/UNKNOWN), derived at instrument creation from Plaid type/subtype/is_cash_equivalent. Unknown → UNKNOWN slice, labeled "Unknown". Cash is its own class; ETF is its own class (no look-through); crypto → CRYPTO; derivatives → OPTION; fixed income → FIXED_INCOME; unrecognized → OTHER. Imports: usually UNKNOWN. **Sector** — raw Plaid string, preserved not interpreted; security-level only, **no look-through** (ETF/fund-heavy portfolios show a large "Unknown"/fund-vocabulary sector picture); provider vocabulary leaks verbatim as labels; frequently null; never refreshed. Coverage % NEEDS RUNTIME/DB VERIFICATION. **Account** — stable id key, sanitized label, no institution axis yet, retirement-vs-taxable NOT CURRENTLY SUPPORTABLE (no subtype persisted anywhere). **Currency** — keyed on native denomination, values in reporting currency, FX at asOf with ≤7-day walk-back flagged estimated, miss = flagged native pass-through, unofficial crypto codes can appear as keys; denomination ≠ economic exposure and the panel doesn't distinguish.

---

## 6. Current UI capability inventory

**VERIFIED.** The Investments Perspective redesign shipped before this work (commit `188a69d`); the current surface renders, over the A10 DTO: Portfolio header (valued subtotal with explicit "Valued holdings" partial label), valued/unvalued chips, Holdings grid (rank, share bars, trust-tier dots, basis, price date, staleness; sorted by value), Period Activity card (3 intent groups from `PeriodFlows`), Change Bridge card (opening + flows + residual = closing, identity asserted in code; residual honestly labeled "market movement + FX + reinvested income + fees + incomplete history"), Connections card (legacy path, connection-health states), and now the Allocation panel (4 axes + concentration insight). Shell exposes As Of / Compare To and a Completeness chip via `investmentsEnvelope`. Wealth perspective charts `SpaceSnapshot.stocks` history (A9-regenerated, isEstimated-flagged).

**What the UI fails to expose despite data existing** (all IMPLEMENTED BUT NOT SURFACED or captured-but-unused): cost basis / unrealized G/L; `change24h` (computed, in DTO, unrendered); a raw `InvestmentEvent` list (dated buys/sells/dividends with descriptions — no endpoint or component lists events); dividend-vs-interest split (merged into one `income` figure); by-account/by-security activity; allocation/concentration change between dates (compare-date components computed then dropped in assembly); institution and account-type allocation axes (data already on the client); withdrawable cash (`availableBalance`); vested quantities; option/fixed-income detail; securitySubtype/industry axes; compareTo holdings anywhere.

---

## 7. Capabilities possible immediately (no new schema, no new provider)

Status legend: ✅ shipped · Ⓐ pure helper/UI only · Ⓑ small additive query/DTO/core change · ✖ blocked.

**Portfolio summary:** total valued subtotal ✅; valued/unvalued counts ✅; holdings count ✅; accounts count Ⓐ; cash-equivalent total Ⓐ (Cash slice already computed; derived-cash tier disclosed); largest position/top-five/effective holdings/classification ✅; valuation completeness ✅; metadata completeness (N holdings without sector/class) Ⓐ. All work for any asOf date.

**Allocation:** asset class ✅, sector ✅, account ✅, currency ✅; **institution Ⓐ and account-type Ⓐ — zero query change** (the `accounts` prop the dashboard already passes carries `institution` and `type`; the perspective's prop type just declares `{id,name}` — widen it); investment-vs-cash Ⓐ; direct-vs-fund Ⓐ (derived from assetClass); known-vs-unknown ✅ (as slices); security type: coarse = assetClass ✅, fine (subtype) Ⓑ (add 2 fields to readDisplay select); **taxable-vs-retirement ✖ NOT CURRENTLY SUPPORTABLE** — Plaid account subtype is persisted nowhere.

**Diversification/concentration:** per-instrument ✅; per-dimension (account/sector/class/currency) Ⓐ — `computeConcentration` is generic over `{weight,symbol}[]`; caveat: the bands were calibrated for single-name risk and will over-flag 4-slice axes — report HHI/effective-N without a band word, or define new bands (PROPOSAL). Concentration over time Ⓑ — no series exists; loop `getInvestmentValueAsOf` × `computeAllocation` over N dates (new small endpoint; SpaceSnapshot stores only totals, not composition).

**Activity:** buys/sells/contributions/withdrawals/transfers/fees/net flow ✅; income ✅ (cash income only — REINVESTMENT is deliberately a separate category; disclose); dividend/interest/capital-gain split Ⓑ (trivial core change — types are distinct in DB, merged in the pure core); recent-events list Ⓑ (rows exist with date/type/amount/description; **no endpoint or UI reads raw events today**); by-account and by-security Ⓑ (indexes exist; `readPeriodFlows` just doesn't select the two ids — 2-field select + core groupBy). Caveats: 24-month Plaid ceiling; coverage starts at ingestion-enable; flag-gated.

**Risk/structure:** cash reserve Ⓐ; single-position risk ✅; per-dimension concentration Ⓐ; option/fixed-income/crypto exposure as slices Ⓐ (contract-level detail requires reading the captured optionMeta/fixedIncomeMeta JSON — Ⓑ); unclassified exposure ✅; FX denomination ✅; margin ✖ as a number (negative brokerage-cash residual is detected but only console.warn'd — PROPOSAL: persist/surface as labeled "possible margin/debit"); maturity concentration ✖ until fixedIncomeMeta is parsed (Ⓑ); liquidity tiers — coarse deterministic map from assetClass is buildable (PROPOSAL); tax-location mix ✖ (same subtype blocker).

**Intelligence:** deterministic template insight lines are the established house doctrine (perspective-engine bans LLM in lens numbers) — concentration warnings, cash-drag observations, allocation shifts, completeness/staleness caveats should all be pure-model → template. LLM's role is narrative synthesis over assembler payloads only. The caveat infrastructure (CompletenessTier, staleDays, conflicted, reasons, envelope chip) is complete — nothing new needed. Highest-leverage AI move: **re-point the holdings assembler at the A10 spine** (allocation, flows, staleness, completeness reach the AI with zero new engines; retires stale dataLimits). All labeled DERIVED/PROPOSAL as noted.

---

## 8. Capabilities possible with existing backend work (small, additive)

The Ⓑ set, plus cross-dimensional wiring — all verified feasible:

**Cross-dimensional intersections (Part D):** `ValuedHoldingRow` is per (account × instrument) and carries accountId, instrumentId, assetClass, sector, currency, isCash, reportingValue, tiers. **Nine of ten requested intersections are pure client-side group-bys — no query change**: asset class × account (drilldown/accordion inside a bar, not a matrix), sector × account (drawer), currency × account, asset class × currency, cash × account (high value — "which broker is sitting on cash"), largest positions within an account (Holdings filter), direct-vs-fund by account, concentration incl-vs-ex-cash (second computeConcentration call), unknown-metadata by account (actionable connection-quality disclosure). Only retirement-vs-taxable is blocked (schema/ingest). Recommended presentation: drilldowns and drawers, never a matrix — visual-overload risk is real for sector × account.

**Cross-filtering Allocation → Holdings: feasible now, recommend as an immediate UI slice.** Shared stable identifiers verified on both sides (slice keys are documented stable keys — enum/accountId/currency/sentinel — derivable from row fields byte-stably). Selection state belongs in `InvestmentsPerspective` (it already owns layout and passes `result.holdings` to both panels); the Allocation panel needs `onSliceSelect` and its dimension state lifted; `InvestmentsHoldings` needs one additive `selection`/highlight prop. **Highlight-and-dim rather than remove** (removal silently re-ranks and hides unvalued disclosure rows). No URL state needed for v1; clear selection on dimension change; mobile works via a dismissible filter chip at the top of Holdings (source order puts Holdings above Allocation on mobile). ~3 files, zero backend, fixture-testable predicate.

**Other Ⓑ slices:** compareTo holdings in the DTO (the compare-date valuation components are computed then dropped — additive `compareHoldings` field unlocks allocation change, concentration change, cash change, largest-position change); costBasis surfacing (add to the valuation select, thread through to `ValuedHoldingRow` — the as-of observation walk already works for basis rows); activity by-account/by-security + income split; instrument-metadata refresh-on-sync (fixes create-only staleness); event-list endpoint; MWR/TWR pure-math modules gated on flows completeness (§10).

---

## 9. Historical allocation feasibility

**Mechanism (VERIFIED):** backward event replay anchored at the latest OBSERVED observation per (account, instrument); gaps return null, never fabricated zeros; splits without ratios (i.e., **every Plaid-sourced split** — Plaid never supplies ratios) honestly STOP the walk with `earliestDefensibleDate`; unexplained opening residuals persist un-zeroed; imported checkpoints that disagree flag `conflicted`, never averaged. Historical prices: append-only archive (Plaid same-day close from enable-day forward + Tiingo backfill), ≤7-day walk-back = "estimated" with staleDays, beyond = disclosed unvalued. Historical FX: FxRate archive with per-date conversion; caveat — a full FX miss passes the **native amount through** flagged only "estimated". Account identity stable (cuid + plaidAccountId); but scope = **current** ACTIVE Space links, so accounts removed from a Space vanish from all history. `Instrument.status: DELISTED` exists with no reader/writer; SYMBOL_CHANGE has no walk handling and no `supersededById` writer — a renamed ticker becomes two unlinked instruments unless strong IDs match.

**The core defect: classification is current metadata applied to historical rows.** `readDisplay` reads the live Instrument table for every asOf date. A current (first-seen, never-refreshed) sector IS applied to old dates; `isCashEquivalent` projects backward into the Cash slice and the concentration exclusion. Partial mitigation exists: valuation's per-row `isCash` is point-in-time on OBSERVED dates — but allocation's display join ignores it. No classification-history table exists.

**Per-dimension verdicts** (PIT = point-in-time correct; RBH = reconstructed-but-honest; CMH = current-metadata-applied-to-historical-position; NS = not supportable):

| Dimension | Verdict | Minimum upgrade |
|---|---|---|
| Instrument weights | RBH | none for correctness; surface `earliestDefensibleDate`; deepen price/event coverage |
| Asset class | CMH (low drift) | snapshot class on PositionObservation at capture, or dated `InstrumentClassification` table |
| Sector | CMH (worst case — GICS moves silently restate; often null) | classification history; until then label "current classification" |
| Account | RBH/near-PIT | point-in-time link scoping only if removed accounts must appear |
| Institution / account type | CMH (mild; not an axis yet) | acceptable with label |
| Currency | RBH | persist currency on DERIVED rows; exclude-and-disclose FX misses |
| Cash-equivalent | CMH in allocation / RBH in valuation | **one-line-class fix: thread valuation's per-date isCash into ValuedHoldingRow** |
| Security type / direct-vs-fund | CMH (minimal drift) | piggybacks on class fix; ship with caveat |
| Taxable-vs-retirement | **NS** | persist Plaid account subtype first |

**Specific claims:** allocation as of a date — RECONSTRUCTED, supportable **today** (the panel already reduces holdings for any asOf the shell resolves), with CMH caveats on class/sector/cash axes. Allocation change between two dates — DERIVED, engine-ready, **not exposed** (DTO carries asOf holdings only; `compareHoldings` is an assembly change, not a new engine); note that classification drift affects both endpoints identically, so *change* on classification axes is less wrong than levels, though a reclassification also masks as zero change. Concentration change — DERIVED; approximate when either endpoint is partially valued (unvalued rows shrink the denominator — carry endpointIncomplete). Cash-allocation change — CMH until the isCash threading fix, then RBH. Largest-position change — RECONSTRUCTED (a missing price can fake a change; disclose unvalued). Account-allocation change — RECONSTRUCTED. Sector-allocation change — **not honestly supportable as a point-in-time fact**; ship only labeled "current sector classification applied to historical holdings" or wait for classification history. Whether reconstruction/prices have actually run in production: NEEDS RUNTIME/DB VERIFICATION.

---

## 10. Performance-math feasibility

The exact distinctions, each classified (VERIFIED against the engines):

| Measure | Definition | Verdict |
|---|---|---|
| Value change | closing − opening valued subtotal | **Currently possible — shipped** (reconciliation.totalChange) |
| Net contributions | Σ signed CONTRIBUTION/WITHDRAWAL/TRANSFER± | **Currently possible — shipped**; in-kind transfers counted + tier degraded, never zero-valued |
| Flow-vs-market attribution | closing = opening + flows + residual | **Currently possible — shipped** (Change Bridge; identity asserted in code; residual honestly labeled, never called "market gain") |
| Investment income | flows.income (cash income) | **Currently possible — shipped**; excludes reinvested dividends (separate category — disclose) |
| Income return | income ÷ opening/average value | Approximately possible (one division; accrual timing ignored; partial-subtotal denominator) |
| Unrealized gain/loss | value − cost basis | **Approximately possible after a reader is built** — basis is persisted but not selected by valuation; per-(account,instrument) aggregate only, nullable per institution (coverage NEEDS RUNTIME/DB VERIFICATION, §12 Q2); no lots; historical basis-as-of works via the same observation walk |
| Realized gain | proceeds − basis of sold lots | **Not defensible** — no lot attribution; 24-month event ceiling; `unexplainedOpeningQuantity` is a first-class unknown; CSV lot data deliberately uninterpreted |
| Total return % | flow-adjusted growth | Naive (close−open)/open is **not defensible when external flows ≠ 0**; defensible only in zero-flow windows (checkable from shipped PeriodFlows) and still bundles FX+fees+income |
| Money-weighted (IRR) | solve NPV=0 over dated flows + endpoints | Approximately possible — all ingredients exist except an IRR solver (small pure module); **gate on flows.completeness and endpoint completeness**; only defensible inside event coverage |
| Time-weighted | valuation at every flow date, geometric linking | Approximately possible — `getInvestmentValueAsOf` can value any date; degraded by ≤7-day price walk-back and archive depth; tier = worst boundary |
| Contribution-adjusted (modified Dietz) | residual ÷ (opening + time-weighted flows) | Approximately possible — pure helper over data already in memory; label as estimate |
| Per-instrument price return | close-to-close ratio | **Not defensible** — only RAW_CLOSE captured; raw closes break across splits/dividends; ADJUSTED_CLOSE enum has no writer (Tiingo's payload includes adjClose — recoverable without a new vendor, §13) |
| Historical value | point or series | **Currently possible** — point: any asOf; series: SpaceSnapshot.stocks (Wealth, space-total only) or an N-date valuation loop |
| Allocation/concentration change | per-slice deltas between dates | DERIVED — blocked only by the missing `compareHoldings` DTO field |

House doctrine observed everywhere and worth preserving: the residual is never asserted as market gain; partial subtotals are never presented as the whole; do not ship any "return" number without its completeness gate.

---

## 11. Plaid-supported but discarded (or under-used) data — prioritization

| Field/family | Endpoint | Selected? | Persisted? | Product value | Coverage | Historical recoverability | Schema cost | Provider neutrality | Recommended timing |
|---|---|---|---|---|---|---|---|---|---|
| cost_basis **reader** | holdings/get | ✔ | ✔ (unread) | ★★★ unrealized G/L, tax awareness | per-institution nulls — verify | already accruing; as-of walk works | none (optional Holding mirror) | neutral (canonical column) | **Now** |
| Account subtype (ira/401k/roth/brokerage/hsa) | accountsGet | read, then dropped | ✘ | ★★★ retirement/taxable axis, AI tax context | high | full on next accountsGet | 1 nullable column | store raw + canonical mapping | **Now** — trivial, unblocks a whole family |
| Instrument metadata refresh-on-sync | both | create-only | create-only | ★★★ fixes stale/null sector & class | n/a | full — next sync repairs | none (write-path change) | neutral | **Now** — quiet correctness bug |
| vested_value | holdings/get | ✘ | ✘ | ★★ equity-comp views (vestedQuantity already stored) | equities only | forward only | 1 nullable column | neutral | next schema window |
| securitySubtype + industry **readers** | both | ✔ | ✔ (unread) | ★★ finer taxonomy, industry drilldown | unknown — verify | full | none | Plaid vocab — map to canonical | with Allocation v2 |
| option_contract / fixed_income **readers** | both | ✔ | ✔ raw JSON | ★★ options expiry/strike, bond maturity/yield ladders | segment-dependent | full | optional typed columns | keep raw + typed view | when those users appear |
| balances.available in Investments views | accountsGet | ✔ | ✔ (unused there) | ★★ withdrawable-cash vs derived residual | Plaid-dependent | full | none | neutral | with Investments UI v2 |
| institution_price_datetime; Security.update_datetime | holdings/get | ✘ | ✘ | ★ intraday staleness precision (crypto) | select institutions | forward only | 1 column / transient | neutral | low priority |
| transaction_datetime + event `name` surfacing | txns/get | ✔ | ✔ (unread) | ★★ recognizable activity feed | select institutions for datetime | 24-mo | none | neutral | with activity detail slice |
| currency provenance (iso vs unofficial flag) | all | folded | folded | ★ honest crypto display | n/a | forward | 1 bool | neutral | low |
| /investments/refresh endpoint | — | not called | — | ★ user-triggered freshness | paid add-on | n/a | none | Plaid-specific | evaluate cost later |
| institution_id (Security); account unofficial ccy | various | ✘ | ✘ | ★ | — | forward | metadata | neutral | opportunistic |
| cancel_transaction_id | txns/get | deliberately ignored (deprecated) | — | — | — | — | — | — | never |
| FIGI | — | not in plaid@42.2.0 | — | identity hardening | — | — | SDK upgrade first | improves neutrality | later |

Premature-bloat guardrail: do **not** promote optionMeta/fixedIncomeMeta to typed columns, add classification-history tables, or add per-lot schema until a concrete consumer slice exists — raw capture already prevents data loss.

---

## 12. Real-world data coverage findings

**All coverage conclusions are NEEDS RUNTIME/DB VERIFICATION — the DB was unreachable from this environment.** What is verified is the schema/writer layer; what the dataset contains is unknown until the query pack (Appendix A) is run against the docker-compose Postgres. Critical framing for whoever runs it:

- Zero live `@map`/`@@map` directives remain (post-DB1): table = PascalCase model name, column = camelCase field name, both double-quoted; enums are native Postgres types.
- **The naive table is the wrong table**: legacy `Holding` has no assetClass/sector/costBasis and no FK to Instrument. Canonical current position = latest live `PositionObservation` per (account, instrument) joined to `Instrument` — the pack builds a `latest_pos` temp view for this.
- Metrics with **no column anywhere** (do not query, do not fabricate): margin/buying-power, cost basis on `Holding`, country/geography on `Instrument`.
- Provenance ladder to keep distinct per metric: SDK-supports ✔ → writer-captures ✔ → schema-stores ✔ → **dataset-contains UNKNOWN** (all A-track writers env-flag-gated — a flag that was off leaves tables sparse regardless of writer support).

The pack (Q0–Q15, read-only transaction) measures: table row counts; legacy Holding coverage; canonical-position coverage incl. **pct_with_cost_basis** and vestedQuantity; Instrument classification/identity coverage (assetClass distribution, ticker/cusip/isin/subtype/sector/industry, cash-equivalent tri-state); price coverage per held instrument + basis/source/date ranges; reconstruction outcomes (COMPLETE/PARTIAL/FAILED, unexplained openings); anchor inventory by origin/source; investment/crypto account coverage; event type/subtype distributions incl. raw→canonical mapping audit; definitely-unvalued floor; UNKNOWN-class/null-sector among held instruments; duplicate tickers + alias-constraint verification; multi-account instruments; staleness buckets; unpriced instruments by class; imported-vs-plaid provenance; crypto-vs-brokerage split. The decision-relevant outputs: **Q2 pct_with_cost_basis** (gates the unrealized G/L slice), **Q3/Q9 sector/class coverage** (gates how loudly sector allocation can speak), **Q4/Q12 price depth** (gates TWR and historical charts), **Q5 reconstruction outcomes** (gates historical-allocation confidence), **Q10 duplicate instruments** (gates concentration trustworthiness).

---

## 13. External data requirements (Part H)

What cannot be delivered honestly from Plaid + current data, and what each needs. The existing provider-adapter seams (price providers registry, FX providers, import profiles) generalize well — most of these fit as new adapters without architectural change. Nothing here blocks the next several UI slices; none of it should land before beta except where marked.

**Market & reference data.** Reliable historical prices: largely SOLVED in-repo (Tiingo EOD + archive); gaps are delisted tickers and non-US/OTC coverage — deepen vendor or accept disclosed unvalued rows. Intraday prices: new licensed feed; decorative for this product — defer indefinitely. **Corporate actions/splits/dividends: the sleeper.** Plaid never supplies split ratios, so every Plaid split stops reconstruction; **Tiingo's daily payload already contains adjClose, splitFactor, divCash and the adapter deliberately reads only `close`** (VERIFIED) — extending the adapter + an ADJUSTED_CLOSE/corp-action writer recovers split-adjusted series and ratio-known splits **without a new vendor**. This is the cheapest path to per-instrument price returns and to un-sticking FAILED reconstructions. Delistings: same vendor family or accept honest unvalued. Security master / identifier mapping: needed only when multi-provider dedupe pain appears (OpenFIGI is a candidate; SDK upgrade may expose FIGI). Fundamentals/market cap/ratios/earnings/estimates: separate licensed provider; **strategic only if FM wants research-grade features — otherwise decorative**; defer well past beta.

**Fund look-through** (ETF/fund composition, true sector/geography, factor exposure, bond duration/credit quality, fund overlap): NOT CURRENTLY SUPPORTABLE from any existing source; requires a fund-data provider with meaningful licensing cost. This is the single biggest honest-analysis upgrade for ETF-heavy users (today their sector view is mostly "Unknown"). Architecture fit: a look-through table keyed by Instrument, fed by an adapter — clean. Timing: after beta; before it, label sector as security-level explicitly.

**Benchmarks** (index comparison, blended benchmarks, alpha/beta/tracking error/Sharpe/drawdown-vs-index): needs licensed index series (or proxy-ETF price series as a pragmatic stand-in — an ETF's Tiingo prices can proxy its index at near-zero cost, with an honesty label). Requires TWR first (§10) — sequencing: TWR → proxy benchmark → real index licensing much later. Defer past beta.

**Tax intelligence** (complete lots, wash sales, realized L/S gains, harvesting, jurisdiction logic): Plaid cannot supply lots; sources are broker CSV lot imports (raw data already preserved in `importedRaw` — an interpreter is the missing piece), user entry, or aggregator upgrades. Jurisdiction logic (Christian is in Kuwait; multi-jurisdiction users likely) is a product-scope decision before it is a data decision. Defer; do not fake with average-cost guesses.

**Risk analytics** (volatility, correlation, VaR, stress tests, factor risk, concentration-vs-benchmark, rate sensitivity): computable from deep daily price history for held instruments — the PriceObservation archive is the substrate and Tiingo can backfill depth; correlation/vol are honest once coverage is verified; VaR/stress/factor models are strategic-question territory (is FM a risk platform?). Liquidity risk: no data source; coarse assetClass tiers only. Defer past beta except perhaps simple realized-volatility once TWR lands.

Licensing/cost concerns: fund look-through and real index data are the two families with material licensing cost; everything else is cheap or already contracted (Tiingo).

---

## 14. Proposed Investments workspace (Part I — PROPOSAL)

The ten user questions map onto the existing single-page composition (keep it — no tabs), rebalanced so Allocation is promoted:

**Row 1 — Portfolio summary strip** (full width): valued subtotal + completeness chip (shipped), plus new deterministic stat line: accounts · holdings · cash % · largest position · unvalued count. Answers Q1/Q6/Q9. Backend: none. Priority: first slice, trivial.

**Row 2 — main column: Holdings** (shipped) with cross-filter highlighting and, later, a per-row drawer (activity by security, basis/gain when the reader lands, price provenance). Answers Q2/Q3. **Side column, top: Allocation — promoted to co-primary.** The panel has outgrown "small side panel": with 4→6 axes, concentration insight, cross-filtering, and As-Of reactivity it is the analytical heart of the page. Recommendation: keep it side-column on desktop v1 (it is information-dense, not wide), but (a) move it above the fold on mobile (source-order change), (b) give it the cross-filter role, (c) revisit full-width placement only when the sector look-through story improves — a mostly-"Unknown" full-width sector chart would over-promise. Answers Q4/Q5.

**Row 3 — Activity & Change**: Period Activity + Change Bridge (shipped), extended with income split and a recent-events feed (new small read); later by-account/by-security drilldowns. Answers Q7/Q8.

**Row 4 — Historical**: value-over-time chart (SpaceSnapshot series for space totals now, honesty-labeled; per-portfolio series endpoint later), and after `compareHoldings` lands: "allocation then vs now" delta view gated per-axis by the §9 verdicts (account/instrument deltas freely; sector deltas labeled). Answers Q7 across time.

**Persistent honesty rail** (not a panel — a doctrine): completeness chip, unvalued disclosures, estimated-FX taint, `earliestDefensibleDate` when a historical date precedes defensible history, "N holdings lack classification" line, and Q10's "what we don't know" — data-quality is a property of every panel, not a separate card users must find. Account breakdown stays inside Allocation's account axis + Connections card (no separate panel). Security detail = Holdings drawer, deferred. Investment insights = deterministic template lines placed inside the relevant panels; AI narrative stays in Brief/Analyst surfaces reading the re-pointed assembler.

As Of / Compare To interaction: every panel already recomputes for asOf (verified for allocation); Compare To today affects only the bridge/reconciliation — after `compareHoldings`, it should also drive the allocation-delta and concentration-change lines. Mobile: single column ordered summary → allocation → holdings → activity → bridge → historical; the current source order (holdings before allocation) should flip on mobile in the same slice as cross-filter chips.

---

## 15. Mobile and responsive implications

VERIFIED current behavior: the perspective grid stacks in source order on mobile — Holdings (long) lands above Allocation, so the new panel is buried below a long table; recommend flipping order at the mobile breakpoint. Cross-filtering on mobile must not rely on hover; tap-to-toggle + a dismissible filter chip pinned at the top of Holdings is the pattern (the seams exist). SegmentedControl is tab-reachable but lacks arrow-key roving tabindex — fix once in the shared primitive, benefits every perspective. Bars must keep their text pairing (label + value + %) — they are already screen-reader-legible; keep charts decorative, numbers primary. Density: 6+ allocation axes on a phone argues for the SegmentedControl collapsing to a select at narrow widths (PROPOSAL). The honesty chips (completeness, unvalued, FX-estimated) must survive mobile truncation — they are the product's differentiator, not chrome.

---

## 16. Data-quality and honesty rules (codify these)

1. Never present a partial subtotal as the whole (already enforced — keep the "Valued holdings" label rule).
2. Unvalued rows are disclosed counts, never zero-valued positions (enforced in allocation core — keep everywhere).
3. The bridge residual is never called "market gain" (enforced — extend to any future return language).
4. No return number ships without its completeness gate: MWR/TWR only when flows.completeness ∈ {observed, estimated} and endpoints complete.
5. Classification axes on historical dates carry a "current classification" label until classification history exists (§9).
6. Estimated-FX taint must be visible wherever converted numbers are aggregated — the Allocation panel currently violates this (fix in follow-up).
7. Concentration statements name their base ("of non-cash holdings").
8. Sector allocation names its level ("security-level; funds not looked through").
9. UNKNOWN is a first-class rendered slice, never silently dropped — and doubles as a data-quality signal (per-connection unknown counts).
10. AI dataLimits must track shipped reality (the stale "no asset-class breakdown" line is the cautionary example).
11. Currency axis is denomination, not exposure — say so.
12. Anything env-flag-gated reports absence honestly ("history not enabled") rather than empty-state ambiguity.

---

## 17. Recommended implementation slices (Part J)

| # | Slice | Objective | Exists already | Missing | Files/domains | Schema | Migration | Tests | Risk | Parallel-safe | Exit condition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | **Commit Allocation** (with §5.9 fixes) | land the feature atomically | 9 files done, tests pass | 3 small fixes; STATUS row | the 9 files + STATUS.md | none | none | existing + fix assertions | low | n/a | committed; STATUS updated |
| 1 | Cross-filter Allocation↔Holdings | slice-tap filters/highlights holdings | stable keys both sides | lifted state, onSliceSelect, highlight prop, mobile chip | InvestmentsPerspective, AllocationPanel, InvestmentsHoldings | none | none | predicate fixtures | low | yes (UI-only) | tap → dim/highlight + clear chip, mobile OK |
| 2 | Allocation axes v2 + summary strip | institution, account-type, invest-vs-cash, direct-vs-fund axes; portfolio stat line; FX-taint + "of non-cash" + denomination labels | data on client already | pure helpers, prop-type widening, copy | allocation-core, panel, perspective | none | none | fixture per axis | low | yes | 6+ axes, honest labels |
| 3 | Runtime coverage pass | run Appendix A; record results | query pack ready | execution + STATUS annotations | dev DB | none | none | n/a | none | yes | coverage numbers recorded; slices 5/7 gated on them |
| 4 | Activity depth | dividend/interest/cap-gain split; by-account/by-security; recent-events read | events + indexes | 2-field select, core groupBy, small endpoint, list UI | flows-core, time-machine, activity card | none | none | core fixtures | low | yes | income split + event feed shipped |
| 5 | costBasis reader → unrealized G/L | surface persisted basis with disclosures | data persisted | select + thread to ValuedHoldingRow, Holdings column, null-coverage gating | valuation, time-machine-core, holdings UI | none | none | valuation fixtures | med (institution nulls) | yes | per-holding G/L where basis exists, disclosed where not |
| 6 | compareHoldings DTO → allocation/concentration change | expose the dropped compare-date components | engine computes it | additive DTO field + delta UI, per-axis honesty labels | time-machine-core/binding, panel | none | none | assembly fixtures | low | yes | "then vs now" deltas with §9 labels |
| 7 | Metadata capture trio | account subtype column; instrument refresh-on-sync; vestedValue | writers exist to extend | 2 nullable columns + write-path change | exchangeToken/refresh, resolver, position-capture | **2 additive columns** | additive only | writer tests | low | yes | subtype persisted; sector staleness repaired on sync |
| 8 | isCash threading + A10 visibility seam | point-in-time cash flag; SAL visibilityLevel filter | valuation has per-date flag | thread into rows; add filter + tests | valuation, time-machine, space-account queries | none | none | seam tests | med (privacy) | yes | allocation cash = per-date; below-FULL positions redacted |
| 9 | AI re-point | holdings assembler reads A10 spine | assembler + spine | new assembly path, dataLimits rewrite, tests | lib/ai/assemblers | none | none | **first assembler test** | med | yes | AI states allocation/flows/completeness consistent with UI |
| 10 | MWR/TWR gated | defensible returns | flows, valuations, gates | IRR solver + linking cores + return UI | new pure modules, perspective | none | none | golden math fixtures | med-high | yes | returns render only when gates pass |

**Later (existing-data backend):** historical allocation series endpoint; concentration-over-time; margin-signal persistence; optionMeta/fixedIncomeMeta typed readers; event-detail drawer. **Additive metadata-capture, later:** industry/subtype axes; price datetimes; currency provenance flag. **External-data initiatives (all post-beta):** Tiingo adapter extension (adjClose/splitFactor/divCash → ADJUSTED_CLOSE + corp-action ratios — the cheapest, do first), fund look-through, proxy-ETF benchmarks then licensed indices, security master/FIGI, fundamentals, tax lots.

---

## 18. Schema and migration impact matrix

| Initiative | Schema change | Migration | Backfill |
|---|---|---|---|
| Slices 0–6, 8–10 | **none** | none | none |
| Slice 7 | `FinancialAccount.providerSubtype` (nullable string); `PositionObservation.vestedValue` (nullable decimal) | additive, trivial | next accountsGet/holdings refresh self-backfills |
| Instrument refresh-on-sync | none (write-path) | none | next sync repairs stale metadata |
| Classification history (deferred) | new dated table or snapshot columns | additive | forward-only; history stays CMH-labeled |
| Corp-actions via Tiingo (deferred) | none (PriceObservation ADJUSTED_CLOSE exists; event ratios fit InvestmentEvent.ratio) | none | vendor backfill |
| Fund look-through (deferred) | new look-through table | additive | vendor |
| Tax lots (deferred) | new lot tables | substantial | CSV interpreter over preserved importedRaw |

---

## 19. Risks and likely false claims to avoid

1. **"Portfolio return" from value change** — the most dangerous number in this domain; ship only the bridge decomposition until MWR/TWR gates exist.
2. **Sector allocation as truth** — security-level, fund-blind, current-metadata, often null. Label or under-promise.
3. **Historical sector/class allocation as point-in-time fact** — CMH; label or gate.
4. **Concentration precision** — duplicate-instrument splits understate it; AI vs UI currently disagree by construction; the isCash seam can leak a cash row into weights.
5. **Realized gains / tax numbers** — no lots; refuse rather than approximate.
6. **Treating "schema stores it" as "users have it"** — every A-track table is flag-gated; run Appendix A before promising coverage-dependent features.
7. **The A10 visibility seam** — shipping more surfaces over an unfiltered read compounds a privacy defect; fix in slice 8, and check whether below-FULL investment shares exist at all.
8. **FX-miss pass-through** — a wrong number flagged only "estimated"; exclude-and-disclose is the honest posture for allocation.
9. **change24h** — derived from close-vs-institution price with mixed staleness; if surfaced, label the basis.

---

## 20. Explicit deferrals

Fund look-through; benchmarks and all benchmark-relative stats; fundamentals/earnings; VaR/stress/factor risk; intraday prices; tax lots/wash sales/harvesting; realized-gain reporting; classification-history table (until historical-allocation labeling proves insufficient); matrix-style cross-dimension views; URL-persisted selection state; reverse cross-filter (Holdings→Allocation); options/fixed-income typed features (until user demand); multi-coin wallet expansion; /investments/refresh paid add-on; FIGI/SDK upgrade; margin as a number.

---

## 21. STATUS.md and roadmap corrections required

1. §2 Active-branch row: "untracked residue is docs…, **not code**" is now false — uncommitted source exists; restamp at commit time.
2. §3 A-x table: "A6 | Historical price infrastructure" + footnote "A8 is unallocated" is **contradicted by ~46 A8-x references in code** (schema comments label PriceObservation "Slice A8-1"). Relabel the row A8 or record the dual numbering (planning docs used A6/A7/A8; shipped code uses A8/A9/A10).
3. Add a ledger row for the Allocation feature at commit (suggest **A11 — Investments Allocation & Concentration**) per the Maintenance rule; none exists in the staged STATUS.md.
4. Annotate the MC1 "mixed-currency allocation precision (donut/concentration)" residual against the new by-currency axis (narrows it; conversion caveat still stands upstream).
5. Extend the "Next workstream" activity list past 07-13 with the 07-14 investigation + allocation work.
6. Roadmap doc (07-09) is largely overtaken: of its five headline parallel picks, Positions/Holdings, Merchant Intelligence, and Historical Import are shipped; Provider Adapters partial; **AI Facts remains the unbuilt highest-leverage item**. Its "Wallets after adapters" sequencing was bypassed (xpub shipped 07-09) without observed harm.
7. New tracked findings to file: A10 SAL visibility seam (KD-19-class); instrument metadata create-only staleness; isCash dual-source seam; FX-miss pass-through posture in allocation.

---

## 22. Founder decisions required

1. **Commit hygiene**: approve the 9-file atomic Allocation commit with the three §5.9 fixes, KD-20 separated.
2. **Allocation prominence**: accept the "co-primary in the side column, promoted on mobile" recommendation, or push it to a full-width main panel now.
3. **Retirement/taxable**: approve the `providerSubtype` column (slice 7) — a one-column decision unblocking a feature family.
4. **Return math posture**: approve gated MWR/TWR as the only return numbers FM will ever show, and the refusal to show realized gains without lots.
5. **Sector honesty**: accept explicit "security-level, funds not looked through" labeling now vs. buying fund look-through data later.
6. **Privacy seam priority**: whether slice 8's SAL filter jumps the queue (depends on whether shared below-FULL investment accounts exist — check with Appendix A / Q6 plus a SAL query).
7. **Env flags**: confirm which A-track flags are on in production — every history feature's real coverage hangs on this.
8. **AI consistency**: approve re-pointing the AI assembler at A10 (slice 9) — after which AI and UI must never disagree on concentration again.

---

## 23. Final recommended order of work

**0.** Commit Allocation (with fixes) + KD-20 as separate commits; update STATUS.md (ledger row, branch-state row, A8 footnote).
**1.** Run the Appendix A coverage pack; record results in STATUS.md.
**2.** Cross-filter slice (Allocation↔Holdings) — the interactivity payoff for the panel just built.
**3.** Allocation axes v2 + portfolio summary strip + honesty labels (FX taint, "of non-cash", denomination note).
**4.** Activity depth (income split, event feed, by-account/by-security).
**5.** compareHoldings DTO → allocation/concentration change views.
**6.** Metadata capture trio (account subtype, instrument refresh-on-sync, vestedValue) — the only schema-touching slice in the horizon.
**7.** costBasis reader → unrealized G/L (sequenced after the coverage pass proves basis density).
**8.** isCash threading + A10 visibility fix (earlier if founder decision #6 says shared sub-FULL accounts exist).
**9.** AI re-point.
**10.** MWR/TWR gated returns; then the external-data track opens with the Tiingo adapter extension.

---

## Report back to ChatGPT

**Five most important verified findings.** (1) The reported Allocation work is real, accurate, and test-passing — nine files, semantics as claimed, `computeAllocation`'s 17 fixture checks executed and green; the working tree also contains an unrelated 8-file KD-20 hardening set that must be committed separately. (2) **Cost basis is persisted and completely unread** — `PositionObservation.costBasis` has been accruing from Plaid, CSV, and manual paths; unrealized G/L is a reader away, not a provider away. Same pattern: vestedQuantity, securitySubtype, industry, optionMeta, fixedIncomeMeta all captured-but-unused. (3) Instrument classification is **current, create-only, never-refreshed metadata stamped onto all dates** — the central caveat for both current-sector accuracy and historical allocation; plus the isCash dual-source seam and the AI-vs-UI concentration divergence (same formula, different inputs: symbol/native/Holding vs instrumentId/reporting/A10). (4) The honesty infrastructure (tiers, staleness, conflicts, unexplained residuals, disclosed unvalued) is complete and genuinely good — nearly every Part-C capability is a pure helper over `ValuedHoldingRow[]`, and 9 of 10 cross-dimensional intersections need zero backend. (5) Everything history-grade is env-flag-gated and the DB was unreachable — **all real-world coverage is unverified** until the read-only query pack (Appendix A) runs; also the A10 read path lacks a SpaceAccountLink visibility filter (pre-existing KD-19-class privacy seam the new panel widens).

**What the Allocation panel genuinely unlocks:** an as-of-correct, FX-coherent, honestly-disclosed 4-axis allocation + per-instrument concentration over the A10 spine — and, because it threads assetClass/sector/isCash onto every valued row, it unlocks the entire next tier for free: cross-filtering, 6+ axes, cash/summary stats, allocation-change views (one DTO field away), and a single shared concentration doctrine the AI can be re-pointed to.

**Biggest current data limitation:** no fund look-through (sector is security-level and fund-blind), no lot-level basis (realized gains and tax features undeliverable), no account subtype (retirement/taxable blocked — one trivial column), 24-month Plaid event ceiling, and Plaid's ratio-less splits stopping reconstruction — partially recoverable from the already-integrated Tiingo vendor whose splitFactor/divCash/adjClose fields the adapter deliberately ignores.

**Biggest UI opportunity:** cross-filtering Allocation↔Holdings plus the axes-v2/summary-strip slice — zero backend, both sides already share stable keys, and it converts the new panel from a chart into the page's navigation instrument. Close behind: surfacing the already-persisted costBasis.

**Most dangerous misleading capability to avoid:** any naive "portfolio return" from value change (and its cousins: realized gains without lots, sector allocation presented as truth, historical sector charts presented as point-in-time facts). The codebase's own bridge-residual doctrine is correct — extend it, never bypass it.

**Next five implementation slices:** (1) commit Allocation with the three small fixes; (2) cross-filter; (3) allocation axes v2 + portfolio summary strip + honesty labels; (4) run the DB coverage pack and record results; (5) activity depth (income split + event feed + by-account/by-security). Then compareHoldings, the metadata-capture trio, and the costBasis reader.

**Should the current Allocation work be committed as-is?** Yes — as one atomic 9-file commit, **after** three pre-commit fixes: remove the stale AI dataLimit ("asset-class and sector breakdown unavailable…" is now false), fix/align the isCash source (comment claims parity with valuation that doesn't exist; a `type=cash` security can leak into concentration weights), and label the concentration line "of non-cash". KD-20's 8 files are a separate commit; never commit the session artifacts (`.claude/`, `_git_context.txt`, `_to_delete/`, gitmeta files).

**Concerns to resolve before the Investments redesign begins:** run the coverage pack (env flags + costBasis/sector/price density decide which slices are honest to ship); decide the A10 visibility-seam priority; fix instrument metadata refresh-on-sync (quiet correctness bug corrupting allocation slowly); decide the account-subtype column; align the AI assembler with A10 before shipping more AI investment commentary; and correct STATUS.md's A6/A8 numbering conflict so the ledger matches the code.

---

*Appendix A (read-only runtime coverage query pack) follows.*

---

# Appendix A — Read-only runtime coverage query pack

### The query pack (read-only; counts/percentages only; no sensitive values)

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Fourth Meridian — investment runtime-coverage pack (2026-07-14)
-- READ-ONLY. Aggregates only. All table/column names are Prisma model/field
-- names verbatim (no @map/@@map exist after DB1) — quoting is REQUIRED.
-- Run inside a read-only transaction for belt-and-braces safety:
BEGIN TRANSACTION READ ONLY;

-- ─── Q0. Table row counts (orientation) ─────────────────────────────────────
SELECT 'Holding' t, count(*) n FROM "Holding"
UNION ALL SELECT 'Instrument', count(*) FROM "Instrument"
UNION ALL SELECT 'InstrumentAlias', count(*) FROM "InstrumentAlias"
UNION ALL SELECT 'PositionObservation', count(*) FROM "PositionObservation"
UNION ALL SELECT 'InvestmentEvent', count(*) FROM "InvestmentEvent"
UNION ALL SELECT 'PositionReconstruction', count(*) FROM "PositionReconstruction"
UNION ALL SELECT 'PriceObservation', count(*) FROM "PriceObservation"
UNION ALL SELECT 'ImportBatch', count(*) FROM "ImportBatch"
ORDER BY 1;

-- ─── Q1. Legacy Holding table coverage (current-state read model) ───────────
-- NOTE: quantity/price/value are NOT NULL here by schema; the honest coverage
-- questions are currency-known, cash rows, and zero/nonzero values.
SELECT
  count(*)                                              AS holdings,
  count(*) FILTER (WHERE "isCash")                      AS cash_rows,
  count(*) FILTER (WHERE currency IS NOT NULL)          AS with_currency,
  round(100.0*count(*) FILTER (WHERE currency IS NOT NULL)/nullif(count(*),0),1) AS pct_with_currency,
  count(*) FILTER (WHERE value  = 0)                    AS zero_value_rows,
  count(*) FILTER (WHERE price  = 0)                    AS zero_price_rows,
  count(*) FILTER (WHERE "financialAccountId" IS NOT NULL) AS on_financial_account,
  count(*) FILTER (WHERE "accountId" IS NOT NULL)       AS on_legacy_account
FROM "Holding";

-- Heuristic Holding↔Instrument linkage (symbol↔tickerSymbol — NO FK exists):
SELECT
  count(*) AS holdings_noncash,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM "Instrument" i WHERE i."tickerSymbol" = h.symbol
  )) AS symbol_matches_an_instrument
FROM "Holding" h WHERE NOT h."isCash";

-- ─── Canonical current positions: latest LIVE observation per (acct,instr) ──
-- Approximation of the read path (resolvePositionAsOf has richer precedence);
-- date DESC, then OBSERVED > USER_ASSERTED > IMPORTED > DERIVED on ties.
CREATE TEMP VIEW latest_pos AS
SELECT DISTINCT ON ("financialAccountId","instrumentId") *
FROM "PositionObservation"
WHERE "deletedAt" IS NULL AND "supersededById" IS NULL
ORDER BY "financialAccountId","instrumentId", "date" DESC,
  CASE origin::text WHEN 'OBSERVED' THEN 0 WHEN 'USER_ASSERTED' THEN 1
                    WHEN 'IMPORTED' THEN 2 ELSE 3 END;

-- ─── Q2. Canonical holdings coverage (valuation facts, cost basis, currency) ─
SELECT
  count(*)                                                   AS open_positions,
  count(*) FILTER (WHERE "isCash")                           AS cash_positions,
  count(*) FILTER (WHERE "institutionValue" IS NOT NULL)     AS with_institution_value,
  count(*) FILTER (WHERE "institutionPrice" IS NOT NULL)     AS with_institution_price,
  count(*) FILTER (WHERE "institutionPriceAsOf" IS NOT NULL) AS with_price_asof_date,
  count(*) FILTER (WHERE "costBasis" IS NOT NULL)            AS with_cost_basis,
  round(100.0*count(*) FILTER (WHERE "costBasis" IS NOT NULL)/nullif(count(*),0),1) AS pct_with_cost_basis,
  count(*) FILTER (WHERE "vestedQuantity" IS NOT NULL)       AS with_vested_qty,
  count(*) FILTER (WHERE currency IS NOT NULL)               AS with_currency
FROM latest_pos WHERE quantity <> 0;

-- ─── Q3. Instrument identity & classification coverage ──────────────────────
SELECT "assetClass"::text, count(*) AS instruments,
       round(100.0*count(*)/sum(count(*)) OVER (),1) AS pct
FROM "Instrument" GROUP BY 1 ORDER BY 2 DESC;

SELECT
  count(*)                                            AS instruments,
  count(*) FILTER (WHERE "tickerSymbol" IS NOT NULL)  AS with_ticker,
  count(*) FILTER (WHERE cusip IS NOT NULL)           AS with_cusip,
  count(*) FILTER (WHERE isin  IS NOT NULL)           AS with_isin,
  count(*) FILTER (WHERE sedol IS NOT NULL)           AS with_sedol,
  count(*) FILTER (WHERE "securityType" IS NOT NULL)  AS with_security_type,
  count(*) FILTER (WHERE "securitySubtype" IS NOT NULL) AS with_security_subtype,
  count(*) FILTER (WHERE sector IS NOT NULL)          AS with_sector,
  count(*) FILTER (WHERE industry IS NOT NULL)        AS with_industry,
  count(*) FILTER (WHERE "isCashEquivalent" IS TRUE)  AS cash_equivalent_true,
  count(*) FILTER (WHERE "isCashEquivalent" IS NULL)  AS cash_equivalent_null,
  count(*) FILTER (WHERE currency IS NOT NULL)        AS with_currency
FROM "Instrument";

-- Provider-reported type/subtype breakdown (raw, preserved-not-interpreted):
SELECT coalesce("securityType",'∅') stype, coalesce("securitySubtype",'∅') ssub,
       count(*) FROM "Instrument" GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40;

-- Provider-id coverage (InstrumentAlias — plaid security_id, csv keys, etc.):
SELECT a.provider, count(DISTINCT a."instrumentId") AS instruments,
       count(*) AS aliases
FROM "InstrumentAlias" a GROUP BY 1 ORDER BY 3 DESC;

SELECT count(*) AS instruments_with_no_alias
FROM "Instrument" i
WHERE NOT EXISTS (SELECT 1 FROM "InstrumentAlias" a WHERE a."instrumentId" = i.id);

-- ─── Q4. Held instruments with/without historical prices ────────────────────
WITH held AS (SELECT DISTINCT "instrumentId" FROM latest_pos WHERE quantity <> 0)
SELECT
  (SELECT count(*) FROM held)                                        AS held_instruments,
  count(DISTINCT p."instrumentId")                                   AS held_with_any_price,
  round(100.0*count(DISTINCT p."instrumentId")/nullif((SELECT count(*) FROM held),0),1) AS pct_priced
FROM "PriceObservation" p JOIN held h ON h."instrumentId" = p."instrumentId";

SELECT basis::text, source, count(*) AS price_rows,
       count(DISTINCT "instrumentId") AS instruments,
       min(date) AS earliest, max(date) AS latest
FROM "PriceObservation" GROUP BY 1,2 ORDER BY 3 DESC;

-- ─── Q5. Historically reconstructable holdings (A4 summaries) ───────────────
SELECT reconciliation::text, completeness, conflicted, count(*),
       count(*) FILTER (WHERE "unexplainedOpeningQuantity" <> 0) AS with_unexplained_opening
FROM "PositionReconstruction" GROUP BY 1,2,3 ORDER BY 4 DESC;

WITH held AS (SELECT "financialAccountId","instrumentId" FROM latest_pos WHERE quantity <> 0)
SELECT (SELECT count(*) FROM held) AS held_positions,
       count(*)                    AS with_reconstruction_row,
       count(*) FILTER (WHERE r.reconciliation = 'COMPLETE') AS reconstruction_complete
FROM "PositionReconstruction" r
JOIN held h ON h."financialAccountId" = r."financialAccountId"
           AND h."instrumentId"       = r."instrumentId";

-- Anchor inventory the reconstruction depends on:
SELECT origin::text, source, count(*) AS observations,
       count(DISTINCT ("financialAccountId","instrumentId")) AS positions,
       min(date) AS earliest, max(date) AS latest
FROM "PositionObservation"
WHERE "deletedAt" IS NULL AND "supersededById" IS NULL
GROUP BY 1,2 ORDER BY 3 DESC;

-- ─── Q6. Accounts: investment/crypto, available balance (NO margin column) ──
SELECT type::text, count(*) AS accounts,
       count(*) FILTER (WHERE "availableBalance" IS NOT NULL) AS with_available_balance,
       count(*) FILTER (WHERE "plaidAccountId" IS NOT NULL)   AS plaid_linked,
       count(*) FILTER (WHERE "walletAddress" IS NOT NULL)    AS wallet_linked
FROM "FinancialAccount"
WHERE "deletedAt" IS NULL AND type IN ('investment','crypto')
GROUP BY 1;
-- Margin / buying power: NO COLUMN EXISTS — nothing to query (see prose above).

-- ─── Q7. Investment transactions by type/subtype ────────────────────────────
SELECT type::text, count(*) AS events,
       count(*) FILTER (WHERE amount   IS NOT NULL) AS with_amount,
       count(*) FILTER (WHERE quantity IS NOT NULL) AS with_quantity,
       count(*) FILTER (WHERE fees     IS NOT NULL) AS with_fees,
       min(date) AS earliest, max(date) AS latest
FROM "InvestmentEvent"
WHERE "deletedAt" IS NULL AND "supersededById" IS NULL
GROUP BY 1 ORDER BY 2 DESC;

-- Raw provider vocabulary → canonical mapping audit:
SELECT coalesce("providerType",'∅') ptype, coalesce("providerSubtype",'∅') psub,
       type::text AS canonical, count(*)
FROM "InvestmentEvent" WHERE "deletedAt" IS NULL
GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 50;

-- ─── Q8. Unvalued holdings (approximation of the valuation read path) ───────
-- A position is "definitely unvalued" if its latest live row has no
-- institutionValue AND its instrument has zero PriceObservation rows at all.
-- (The real service also walks back ≤ max-stale days and applies FX — this
-- query intentionally under-approximates; treat as a floor, not the truth.)
SELECT count(*) AS open_positions,
  count(*) FILTER (WHERE lp."institutionValue" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "PriceObservation" p
                    WHERE p."instrumentId" = lp."instrumentId")) AS definitely_unvalued
FROM latest_pos lp WHERE lp.quantity <> 0;

-- ─── Q9. UNKNOWN asset class / missing sector among HELD instruments ────────
SELECT
  count(*) AS held_instruments,
  count(*) FILTER (WHERE i."assetClass" = 'UNKNOWN')             AS unknown_asset_class,
  round(100.0*count(*) FILTER (WHERE i."assetClass" = 'UNKNOWN')/nullif(count(*),0),1) AS pct_unknown_class,
  count(*) FILTER (WHERE i.sector IS NULL)                       AS null_sector,
  count(*) FILTER (WHERE i.sector IS NULL AND i."assetClass" NOT IN ('CRYPTO','CASH')) AS null_sector_excl_crypto_cash
FROM (SELECT DISTINCT "instrumentId" FROM latest_pos WHERE quantity <> 0) h
JOIN "Instrument" i ON i.id = h."instrumentId";

-- ─── Q10. Duplicate securities ───────────────────────────────────────────────
-- (a) Same ticker on >1 Instrument (POSSIBLE — ticker is a weak identifier):
SELECT "tickerSymbol", count(*) AS instruments
FROM "Instrument" WHERE "tickerSymbol" IS NOT NULL
GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC;
-- (b) Same provider externalId twice: IMPOSSIBLE by constraint —
--     @@unique(provider, externalId) on InstrumentAlias; cusip/isin are also
--     @unique on Instrument. Verify the constraint holds rather than hunt dupes:
SELECT provider, "externalId", count(*) FROM "InstrumentAlias"
GROUP BY 1,2 HAVING count(*) > 1;              -- expect ZERO rows
-- (c) One instrument with >1 alias from the SAME provider (a soft smell):
SELECT "instrumentId", provider, count(*) FROM "InstrumentAlias"
GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC LIMIT 20;

-- ─── Q11. Same instrument held across multiple accounts ─────────────────────
SELECT count(*) AS instruments_in_multiple_accounts FROM (
  SELECT "instrumentId" FROM latest_pos WHERE quantity <> 0
  GROUP BY 1 HAVING count(DISTINCT "financialAccountId") > 1
) x;

-- ─── Q12. Price staleness per HELD instrument (RAW_CLOSE + CRYPTO_DAILY) ────
WITH held AS (SELECT DISTINCT "instrumentId" FROM latest_pos WHERE quantity <> 0),
mx AS (
  SELECT h."instrumentId", max(p.date) AS latest_price
  FROM held h LEFT JOIN "PriceObservation" p
    ON p."instrumentId" = h."instrumentId"
   AND p.basis IN ('RAW_CLOSE','CRYPTO_DAILY','NAV')
  GROUP BY 1)
SELECT CASE
    WHEN latest_price IS NULL                       THEN '1: no price ever'
    WHEN CURRENT_DATE - latest_price <= 3           THEN '2: fresh (≤3d)'
    WHEN CURRENT_DATE - latest_price <= 14          THEN '3: 4–14d'
    WHEN CURRENT_DATE - latest_price <= 60          THEN '4: 15–60d'
    ELSE                                                 '5: >60d stale'
  END AS staleness, count(*) AS held_instruments
FROM mx GROUP BY 1 ORDER BY 1;

-- ─── Q13. Missing prices (held instruments, zero PriceObservation rows) ─────
SELECT i."assetClass"::text, count(*) AS held_unpriced_instruments
FROM (SELECT DISTINCT "instrumentId" FROM latest_pos WHERE quantity <> 0) h
JOIN "Instrument" i ON i.id = h."instrumentId"
WHERE NOT EXISTS (SELECT 1 FROM "PriceObservation" p WHERE p."instrumentId" = h."instrumentId")
GROUP BY 1 ORDER BY 2 DESC;

-- ─── Q14. Provenance: imported vs Plaid vs user vs reconstruction ───────────
SELECT origin::text, source,
       count(*) FILTER (WHERE "importBatchId" IS NOT NULL) AS batch_linked,
       count(*) AS rows
FROM "PositionObservation" WHERE "deletedAt" IS NULL
GROUP BY 1,2 ORDER BY 4 DESC;

SELECT source, count(*) AS events,
       count(*) FILTER (WHERE "importBatchId" IS NOT NULL) AS batch_linked,
       count(*) FILTER (WHERE "importedRaw" IS NOT NULL)   AS with_imported_raw
FROM "InvestmentEvent" WHERE "deletedAt" IS NULL
GROUP BY 1 ORDER BY 2 DESC;

SELECT kind::text, status::text, count(*), sum("importedCount") AS imported_rows
FROM "ImportBatch" GROUP BY 1,2 ORDER BY 1,2;

-- ─── Q15. Crypto vs brokerage split ─────────────────────────────────────────
SELECT fa.type::text AS account_type,
       count(DISTINCT lp."financialAccountId") AS accounts,
       count(*)                                AS open_positions,
       count(DISTINCT lp."instrumentId")       AS distinct_instruments
FROM latest_pos lp
JOIN "FinancialAccount" fa ON fa.id = lp."financialAccountId"
WHERE lp.quantity <> 0 AND fa."deletedAt" IS NULL
GROUP BY 1;

SELECT i."assetClass"::text, fa.type::text AS account_type, count(*)
FROM latest_pos lp
JOIN "Instrument" i        ON i.id  = lp."instrumentId"
JOIN "FinancialAccount" fa ON fa.id = lp."financialAccountId"
WHERE lp.quantity <> 0
GROUP BY 1,2 ORDER BY 3 DESC;

COMMIT;  -- (read-only txn; nothing was written)
```

### How to run

The DB is the docker-compose Postgres on the dev machine (service `postgres`, container `fintracker-db`, bound to `127.0.0.1:5432`, credentials from `.env` `POSTGRES_USER/PASSWORD/DB`). Either:

```bash
# from the repo root, paste the block or save it as coverage.sql:
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < coverage.sql
# or interactively:
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# or from the host:
psql "postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:5432/$POSTGRES_DB" -f coverage.sql
```

The temp view `latest_pos` is session-local; run the whole block in one session. Everything is SELECT-only inside a `READ ONLY` transaction.

