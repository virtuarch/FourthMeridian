# A10 Historical Valuation Coverage — Audit & Repair Plan (Read-Only)

**Question under investigation:** the Investments hero shows an exaggerated percentage
(≈ +364% MTD) while the chart shows a small move. The [gain-disconnect audit]
(./INVESTMENTS_GAIN_DISCONNECT_AUDIT.md) proved the two surfaces read **two different
authorities**. This audit answers the deeper question: **why can A10 value *some* of the
portfolio at a past date but not the *whole* of it — and whose job is "what was my entire
portfolio worth on date X?"**

**Scope:** investigation only. No code, no UI, no suppression, no authority swap, no
second valuation engine. All findings are cited to `file:line`.

---

## 0. Verdict (read this first)

**Decision C — A10 and the snapshot series have *different purposes*, and the contract
must say so — carried out with a concrete, A-flavored repair of A10's coverage.**

Three facts force this:

1. **A10 is a bottom-up per-position valuation.** It values a holding at date X only when
   it has *both* a `PositionObservation ≤ X` **and** a `PriceObservation` (RAW_CLOSE
   within 7 days) `≤ X` for that instrument. Missing either → the position is dropped from
   `valuedSubtotal` (silently, or as an "unvalued" remainder). Its total is therefore a
   **coverage-gated subtotal, never a whole-portfolio total** — by construction, not by
   bug.

2. **The snapshot chart is *not* a fuller valuation authority.** With
   `WEALTH_REGENERATION_ENABLED` **off** (the default), historical snapshot `stocks` is
   **today's provider `FinancialAccount.balance` held flat backward** (`backfill.ts:284`)
   — full magnitude, but a *fabricated flat line*, not a real historical valuation. With
   the flag **on**, snapshots use the *same* price-gated core as A10 and inherit its gaps.
   Swapping the hero onto snapshots would trade an exploding % for a flat fake.

3. **There is no stored "true portfolio value on date X."** The schema holds **no
   per-account per-date balance history** — provider `balance` is a single mutable scalar
   overwritten each sync (`schema.prisma:846`), and the only historical record is the
   *aggregated* `SpaceSnapshot`, which holds investments flat on estimated rows. So the
   real answer must be *reconstructed* (A10, price-gated) or *estimated* (held-flat) — and
   both must disclose which.

The bug the user sees is a **consumer error** — the hero divides a coverage-gated opening
subtotal into the close-minus-open delta — layered on a **capability gap**: A10's
historical coverage is thinner than it should be because historical price backfill is
key-gated and asset-type-limited. The fix is to **name the two truths in the contract**
(as the doctrine already does for debt), **repair A10's coverage where it's cheaply
possible**, and **expose coverage metadata so no consumer can ever divide by a partial
opening again.**

---

## 1. Current authority map

```
PROVIDERS
  Plaid holdings/txns   Exchange/wallet (BTC)   CSV / manual import
        │                       │                       │
        ▼                       ▼                       ▼
CANONICAL IDENTITY / EVIDENCE
  Instrument  ◀─ InstrumentAlias(@@unique[provider,externalId])
  PositionObservation  (dated qty; append-only; sparse; per (acct,instr,date,origin,source))
  PriceObservation     (dated price; @@unique[instrument,date,basis]; RAW_CLOSE = valuation series)
  FxRate               (dated; @@unique[date,base,quote])
        │
        ▼
CANONICAL VALUATION CORE  (lib/investments/valuation-core.ts · ONE engine)
  valueInstrumentAsOf → valuePortfolioAsOf → InvestmentValuationView
    precedence: institutionValue → institutionPrice×qty → isCash(unit 1) → qty×RAW_CLOSE×FX
    a price/observation miss ⇒ position EXCLUDED from valuedSubtotal (retained as unvalued, or absent)
        │
        ├────────────── A10  (investments-time-machine.ts)  ── HISTORICAL positions authority
        │                 getInvestmentValueAsOf @asOf & @compareTo → reconciliation
        │                 (holdConstantBeforeEarliest=FALSE, visibilityScope="detailEligible",
        │                  excludeDigitalAssetAccounts=FALSE → crypto INCLUDED)
        │
        ├────────────── getCurrentPositions (current-positions.ts) ── "A10-at-today"
        │
        └────────────── A9  (regenerate-history.ts) writes SpaceSnapshot.stocks/crypto
                          (holdConstantBeforeEarliest=TRUE, scope="all",
                           excludeDigitalAssetAccounts=TRUE → crypto valued separately)

SPACESNAPSHOT (persisted daily aggregate; NO per-position, NO per-account)
  ├─ live "today" row       → regenerate.ts:125  = PROVIDER BALANCE (classifyAccounts sums FinancialAccount.balance)
  ├─ default historical rows → backfill.ts:284    = PROVIDER BALANCE HELD FLAT backward (isEstimated)
  └─ regenerated historical  → regenerate-history.ts:403 = A9 price-gated valuedSubtotal (flag-gated)
        │
        ▼
CONSUMERS
  Investments Workspace   hero ← A10 reconciliation ·  chart ← SpaceSnapshot series   ← THE DISCONNECT
  AI assemblers           holdings ← getCurrentPositions ; net worth ← SpaceSnapshot
  Export                  ← getCurrentPositions
  Wealth / Net Worth      ← SpaceSnapshot
```

**Doctrine anchor.** `docs/doctrine/financial-semantics.md` already names #10
`getCurrentPositions` ("today's *valued* positions"), #11 A10 ("historical / As-Of /
compare … Historical truth belongs EXCLUSIVELY to A10"), and #13 the debt family, which
carries the load-bearing precedent (§8): **debt has two independent truths — "flow truth"
(bottom-up from transactions) and "balance truth" (what is owed at a point in time, from
`SpaceSnapshot.debt` / account balances) — and balance truth is *explicitly not
derivable* from the bottom-up flows.** Investments has the exact same shape and the
doctrine has not yet drawn the line: A10's `valuedSubtotal` is the investment "flow-truth"
analogue (bottom-up, coverage-gated); the whole-portfolio total is the "balance-truth"
analogue, and it is *not* derivable from summing individually-priced positions.

---

## 2. Why A10's opening value is partial — the exclusion map

A10 calls `getInvestmentValueAsOf` twice — at `asOf` and at `compareTo` — and sets
`openingValue = compareView.valuedSubtotal` (`investments-time-machine-core.ts:204`). At a
*past* `compareTo` the subtotal is partial for the reasons below. Two structurally
different drop kinds matter:

- **Category A — position entirely ABSENT** (not in `components`, not in `unvalued[]`, not
  counted). Invisible even to the `endpointIncomplete` guard.
- **Category B — position UNVALUED** (present with `reportingValue: null`, in `unvalued[]`,
  excluded from `valuedSubtotal`). This is what `endpointIncomplete` catches.

| # | Where | Condition | Kind | In `unvalued[]`? | reason string |
|---|-------|-----------|------|------------------|---------------|
| 1 | `account-scope.ts:35-91` | link not FULL-visibility (`detailEligible`) — A10 uses `visibilityScope:"detailEligible"` | A (whole account) | No | — (account never enters pipeline) |
| 2 | `valuation.ts:438` `if (quantity == null \|\| quantity === 0) continue;` | **no `PositionObservation ≤ date`** for the (acct,instr) — e.g. account/position first observed *after* `compareTo` | **A (absent)** | **No** | — (silent) |
| 3 | `valuation.ts:440-441`, `-core.ts:152` | Instrument/display row missing | none (grouping/currency only) | n/a | — (not a drop) |
| 4 | `valuation.ts:473` → `-core.ts:198-204` | **no RAW_CLOSE price within 7 days**, non-cash, no institution anchor | **B (unvalued)** | **Yes** | `"No RAW_CLOSE price within 7 days of {date}."` |
| 5 | `convert.ts:49/61` | missing FX rate | none (tier→estimated) | n/a | — (native pass-through, never drops) |
| 6 | shared spine + #4 | crypto with no RAW_CLOSE at that historical date | B (unvalued) | Yes | same as #4 |

**The two load-bearing drops:**

- **Drop 2 (silent absence).** `holdConstantBeforeEarliest` is **false** for A10
  (`investments-time-machine.ts:76-81`). So a position whose *first* observation postdates
  `compareTo` (account connected mid-period) resolves to `quantity: null` at the opening
  date and is `continue`-skipped *before* it can even become an unvalued remainder. It
  shrinks `openingValue` **and is invisible to `endpointIncomplete`** (which only sees
  Category B). A9 sets this flag true and rescues the case as an *estimated* held-back
  quantity — A10 does not.

- **Drop 4 (no historical price).** RAW_CLOSE resolution walks back ≤
  `PRICE_MAX_STALE_DAYS = 7` days (`config.ts:20`), else a miss → unvalued. At an early
  `compareTo`, any instrument whose price series doesn't reach that far back drops here.
  Whether the series reaches back is a **backfill-coverage** question (§3).

**FX never drops a position** (`convert.ts` degrades to native + `estimated`). The opening
partiality is entirely observation coverage (Drop 2) + price coverage (Drop 4).

---

## 3. Historical valuation capability by asset type

**Price authorities** (each independently env-gated; registry is empty with no key —
`registry.ts:44`):

| Source | Writer | Gate | Coverage | Backfill? |
|--------|--------|------|----------|-----------|
| `plaid` | `prices/capture.ts:53,89` | `SECURITY_PRICES_ENABLED` | equities/ETF/MF close at fetch time | **Forward-only** (no history) |
| `tiingo` | `prices/backfill.ts` + `providers/tiingo.ts` | `TIINGO_API_KEY` | US equities + ETFs, RAW_CLOSE EOD | **Real historical** `[earliest activity, yesterday]` |
| `coingecko` | `crypto/btc-price.ts:52` | `COINGECKO_API_KEY` | **BTC only** (`coingecko.ts:18` hardcodes `"bitcoin"`) | Real historical BTC/USD |

| Asset type | Path | Historical? | Failure mode |
|---|---|---|---|
| **Equities** | Instrument → RAW_CLOSE × FX | **Yes IF `TIINGO_API_KEY`**; else only forward Plaid captures | No key / date before capture → price miss → **unvalued** (Drop 4) |
| **ETFs** | same (Tiingo serves ETFs) | same as equities | same |
| **Mutual funds** | needs NAV basis — **no NAV adapter**; only Plaid `institutionPrice/Value` anchors at observation dates | **Partial** — valued only at anchored dates, no market backfill between/before | no anchor + no NAV provider → **unvalued** |
| **Cash / MMF** | `isCash` → unit price 1 × FX (`valuation-core.ts:181`) | **Yes** at any date with a qty observation ≤ asOf (no price series needed) | only fails if no observation ≤ asOf |
| **Crypto — BTC** | spine → CoinGecko RAW_CLOSE × FX | **Yes IF `COINGECKO_API_KEY`** | no key → no series → **unvalued** |
| **Crypto — non-BTC** | no coin id, only `BTC_ASSET` defined (`crypto-instrument.ts:57`) | **No** — no series; and A9 mis-values every `type==="crypto"` at the **BTC price** (`regenerate-history.ts:422`) | unvalued (A10) / mis-valued (A9) |
| **Options / fixed income** | only Plaid anchors | **Partial** (anchored dates only) | no anchor → **unvalued** |
| **Unknown / OTHER** | instrument still created; needs ticker + vendor | only if ticker + vendor coverage | retained as **unvalued** (never silently dropped) |

**The crucial capability fact:** *historical price backfill exists but is key-gated and
asset-limited.* Plaid alone is forward-only, so before an account's connect date there is
no price. There was a real regression where the A9 `forceWindow` reused "resume after
latest covered date," so once the daily cron accrued ~30 days the historical window
resolved empty — *"the root cause of historical investment valuation silently falling off
after ~30 days back"* (`prices/backfill.ts:22-31`, since fixed by
`resolveForceBackfillWindows`). This is exactly the shape of a July-1 opening that can only
price a fraction of the book.

---

## 4. A10 vs snapshots — same date, same accounts, different numbers

There are **three** snapshot writers; which one produced a row decides whether it agrees
with A10:

| Snapshot row | Writer | Investment value = | Agrees with A10? |
|---|---|---|---|
| Today's live dot | `regenerate.ts:125` | **provider `FinancialAccount.balance`** (`classifyAccounts` sum) | No — top-down provider total |
| Default historical | `backfill.ts:284` | **today's provider balance held FLAT backward** (`isEstimated`) | No — fabricated flat magnitude |
| Regenerated historical (`WEALTH_REGENERATION_ENABLED`) | `regenerate-history.ts:403` | **A9 `valuedSubtotal`** = same price-gated core as A10 (+ `holdConstantBeforeEarliest`, scope `all`) | Nearly — inherits A10's gaps, marginally fuller |

**No snapshot path falls back to provider balance to fill an unpriced position** —
`valuePortfolioAsOf` sums only non-null `reportingValue`s (`valuation-core.ts:273-284`);
the `skip-unsupported` guard (`regenerate-history.core.ts:150-155`) refuses to fabricate a
value. So the *regenerated* snapshot does not paper over A10; it reproduces it. The
*default* snapshot (`backfill.ts`) does mask the gap — but with a flat held-backward
estimate, not a real valuation.

**This is the mechanism behind ≈ +364%:**

```
                          2026-07-01 (compareTo)      2026-07-18 (asOf)
A10 valuedSubtotal        ≈ $4,400   ← partial:       ≈ $20,450
  (bottom-up, price-gated)   Drop 2 (obs) + Drop 4 (price)
Chart snapshot value      ≈ $18,500  ← full magnitude ≈ $20,450
  (provider balance,          held flat backward
   flag-OFF default)          (backfill.ts:284)

Hero:  totalChange = 20,450 − 4,400 = $16,050 ;  pct = 16,050 / 4,400 = +364.8%
Chart: 20,450 − 18,500 = +$1,950
```

The hero's opening is A10's coverage-gated subtotal; the chart's opening is the provider
balance held flat. Neither is the *true* July-1 value (which is unknown — no per-account
history exists). The hero then divides the delta by the partial opening → the exploded
percentage. Both surfaces are internally faithful; **the juxtaposition is dishonest, and
underneath it A10's historical coverage is genuinely thin.**

---

## 5. Root cause

**Why can A10 value some holdings but not the entire portfolio?**

Because A10 answers a **fundamentally bottom-up** question — "value each position I have
*evidence and a price* for" — and at a historical date that evidence is incomplete along
two independent axes, neither of which A10 can conjure:

1. **Observation coverage (Drop 2).** `PositionObservation` is a *sparse, append-only,
   forward-accruing* series. Before a position's first observation the quantity is
   genuinely unknown; A10 (with `holdConstantBeforeEarliest=false`) drops it *silently*.
   No stored data can fill this — the account simply wasn't connected yet.

2. **Price coverage (Drop 4).** RAW_CLOSE prices come from key-gated, asset-limited
   vendors (Tiingo equities/ETF, CoinGecko BTC) plus forward-only Plaid captures. Any
   instrument without a backfilled series reaching the date is unvalued. Mutual funds
   (no NAV adapter), non-BTC crypto, options, and anything under a missing vendor key are
   structurally unpriceable historically. This axis **is** repairable (backfill).

`valuedSubtotal` is the sum over the intersection of "observed" ∩ "priced" ∩ "visible" —
a coverage-gated subtotal. **It was never designed to equal the whole-portfolio value, and
the doctrine's own debt precedent says a bottom-up sum is not a balance truth.** The defect
is that a consumer (the hero) treats it as one — and, secondarily, that the coverage is
thinner than it needs to be because the repairable price axis is under-provisioned.

There is no reliable *balance-truth* fallback either: the schema has **no per-account
per-date balance history** (`FinancialAccount.balance` is a single overwritten scalar,
`schema.prisma:846`), so the only "full" historical number available today is a *held-flat
estimate* (`backfill.ts`) — honest only as an estimate, never as a real valuation.

---

## 6. Decision

**Chosen: Option C (contract clarification) executed via a targeted Option-A repair of
A10's coverage.** Not pure A, not B.

- **Not pure A ("A10 is just broken, make it value everything").** A10 *cannot* be made to
  value the whole portfolio at every past date, because Drop 2 (pre-first-observation) and
  the irreducible price gaps (mutual-fund NAV, non-BTC crypto, missing vendor coverage) are
  genuine data absences, not code defects. Forcing a number there would fabricate
  valuations — explicitly forbidden and against the honesty valve the engine already
  implements (`valuation-core.ts:198-204`).

- **Not B ("hand total portfolio value to snapshots, retire A10's total").** Snapshots are
  *not* a trustworthy total authority: flag-off they're a fabricated flat line, flag-on
  they inherit A10's gaps, and either way they hold **no per-position decomposition** the
  workspace needs for holdings/allocation/concentration. And there is no per-account
  balance history to promote into a real balance-truth series. Swapping the hero onto
  snapshots (explicitly out of scope) would replace a visible lie with a quiet one.

- **Chosen C, with repair.** A10 and the snapshot series have **different, both-legitimate
  purposes** and the contract must name the boundary — exactly as the debt family already
  separates flow-truth from balance-truth (§8 doctrine). Alongside that clarification, A10's
  *repairable* coverage gap (the price axis) should be closed so its reconstruction is as
  complete as the data honestly allows, and the partial-ness must be made
  machine-readable so no consumer divides by it blindly.

**Answer to the core architectural question** — *"should A10 be able to produce 'what was
my entire portfolio worth on date X?'"*: **A10 should produce the best bottom-up
*reconstruction* the evidence supports, always paired with an explicit coverage figure —
but the authoritative *total* is a balance-truth question that A10 shares with a
balance-truth series, and where neither has real data the honest output is a disclosed
estimate, not an asserted number.**

---

## 7. Recommended architecture — one portfolio-value funnel (do not implement)

The end state the product wants — one number feeding hero, chart, AI, export — is
reachable *only* by making the total a **balance-truth-anchored, A10-reconciled** figure
with explicit coverage, mirroring the debt reconciliation the doctrine already blesses
(`debtReconciliationResidual`, §8-I).

```
                     ┌────────────────────────────────────────────┐
                     │  PORTFOLIO VALUE @date  (ONE funnel)        │
                     │                                            │
   A10 bottom-up ───▶│  valuedValue      (priced positions)       │
   (decomposition)   │  + unavailableValue (observed, unpriced)   │──▶ Hero (total + change)
                     │  + coverage%       (valued / observed)      │──▶ Chart (series)
   Balance truth ───▶│  reconciled to → provider balance where a  │──▶ AI
   (provider/snap)   │     real capture exists; else held-flat     │──▶ Export
                     │     ESTIMATE, disclosed                     │
                     │  residual = balanceTruth − valuedValue      │  (all read the SAME contract)
                     └────────────────────────────────────────────┘
```

**Path to get there (all owner-correct, no new engine):**

1. **Name the two truths in the doctrine** (`financial-semantics.md` §6): A10 =
   *position-valuation truth* (bottom-up, coverage-gated, owns holdings/allocation/
   concentration/decomposition); *portfolio-total* = *balance truth* (provider balance
   where captured; held-flat estimate otherwise). State — as debt already does — that the
   total is **not derivable by summing individually-priced positions**. This is the C core.

2. **Repair A10's price axis (the A-flavored capability build), in `lib/prices` / A9 —
   never in the component:**
   - Ensure `TIINGO_API_KEY` + `COINGECKO_API_KEY` are provisioned so equity/ETF/BTC
     backfill actually runs (registry is a no-op without them, `registry.ts:44`).
   - Guarantee backfill windows reach `[earliest activity, yesterday]` and stay gap-filled
     (the `resolveForceBackfillWindows` fix, `backfill.ts:163-177`) so coverage never
     "falls off after ~30 days."
   - Broaden adapters for the structural gaps: a NAV source for mutual funds; a
     generic crypto price adapter (retire the BTC-price-for-all-crypto assumption at
     `regenerate-history.ts:422`).

3. **Close Drop 2 honestly in the A10 reconciliation path** — enable
   `holdConstantBeforeEarliest` (as A9 already does) so pre-first-observation quantities
   are held back as *estimated* rather than silently absent, converting invisible Category-A
   drops into disclosed Category-B coverage. This makes `endpointIncomplete` actually see
   the whole gap.

4. **Enrich the A10/`HistoricalPortfolio` contract with coverage metadata** (§8 below) so
   the hero computes change against a **coverage-consistent basis** (same instruments
   valued at both endpoints) or suppresses the % when coverage diverges — *driven by the
   contract, not guessed in the component*. This is the surgical fix for the +364% symptom
   and it belongs in `space-data` / `investments-time-machine-core`, not the widget.

5. **Reconcile total to balance truth with an explicit residual** — where a real provider
   balance exists for a date, expose `residual = balanceTruth − valuedValue` (exactly the
   debt `reconciliationResidual` pattern); where only a held-flat estimate exists, mark the
   total `estimated`. The single reconciled figure is what hero, chart, AI, and export all
   read.

---

## 8. Trust interaction — enrich the contract, reuse the envelope

The system already carries `PerspectiveEnvelope` → `CompletenessTier`
(`resolvePerspectiveEnvelope`, consumed at `InvestmentsWorkspace.tsx:77`). The gap is that
A10's *numbers* don't expose their own coverage, so a consumer can divide by a partial
opening with no signal. **A10 should expose coverage metadata on the historical contract**
— this belongs in the contract, riding the existing envelope, not a new trust system:

```ts
InvestmentHistoricalValue {          // per endpoint (opening AND closing)
  totalValue          // valuedValue + unavailableValue (best estimate of the whole)
  valuedValue         // Σ priced positions  == today's `valuedSubtotal`
  unavailableValue    // observed-but-unpriced (Category B) — a magnitude, not just a count
  coveragePercent     // valuedValue / totalValue (or valued/observed count)
  missingPositions[]  // the unvalued[] remainder, already computed
}
```

`endpointIncomplete` (`investments-time-machine-core.ts:209`) is the boolean seed of this;
it currently under-reports because it misses Category-A silent drops (Drop 2) and carries
no *magnitude*. Promoting it to a coverage figure lets the reconciliation (and the hero)
refuse to publish a percentage whose denominator is a partial opening — the honest
behavior the [gain-disconnect audit](./INVESTMENTS_GAIN_DISCONNECT_AUDIT.md) called for,
now grounded in a contract field instead of a component heuristic.

---

## 9. Constraints honoured / non-goals

- **No UI change, no percentage suppression in the widget** — the % decision moves *into
  the contract* (coverage-consistent basis or contract-driven null), not a component hack.
- **No hero→snapshot swap** — §4/§6 show snapshots are not a trustworthy total; the
  recommendation reconciles them, it does not substitute one for the other.
- **No second valuation engine** — every repair lives in the *existing* core
  (`valuation-core.ts`), the *existing* price layer (`lib/prices`), and the A9 writer;
  A10 stays the sole historical position authority (doctrine #11).
- **Trust envelope preserved** — coverage metadata rides the existing
  `PerspectiveEnvelope`/`CompletenessTier`, not a parallel trust path.
- **Honesty valve preserved** — unpriced positions remain disclosed remainders
  (`valuation-core.ts:198-204`); nothing is fabricated to force a total.

---

## Appendix — evidence index

- **A10 pipeline & exclusions:** `lib/investments/investments-time-machine.ts:55,76-81`;
  `investments-time-machine-core.ts:204-209`; `valuation.ts:145,170-182,343,398,426-435,438,470-475,511`;
  `valuation-core.ts:144-204,263-303`; `reconstruction-read.ts:148-152`;
  `nearest-on-or-before.ts:55`; `account-scope.ts:35-91`; `prices/service.ts:42-65`;
  `prices/config.ts:20`; `money/convert.ts:45-61`.
- **Snapshot writers:** `lib/snapshots/regenerate.ts:53-163` (live/provider-balance);
  `lib/snapshots/backfill.ts:284-295` (held-flat default);
  `lib/snapshots/regenerate-history.ts:61-63,340-346,403,406-423` (A9 price-gated, flag);
  `regenerate-history.core.ts:150-155`; `lib/data/snapshots.ts:57-105`;
  `lib/investments/portfolio-series.ts:59-69`.
- **Asset-type / price capability:** `prices/capture.ts:8-10,53,89`;
  `prices/backfill.ts:22-31,163-177`; `prices/registry.ts:44`;
  `prices/providers/tiingo.ts:11-12`; `prices/providers/coingecko.ts:18`;
  `crypto/btc-price.ts:13-15,52,88`; `investments/instrument-resolver.ts:37-48,99-121`;
  `investments/crypto-instrument.ts:22-31,57,138`; `plaid/backgroundHistorySync.ts:152-175`;
  `jobs/fetch-security-prices.ts`.
- **Schema:** `prisma/schema.prisma` — `PositionObservation:1353-1398`
  (`@@unique[financialAccountId,instrumentId,date,origin,source]`); `Instrument:1294-1330`;
  `InstrumentAlias:1333-1344` (`@@unique[provider,externalId]`);
  `PriceObservation:1568-1586` (`@@unique[instrumentId,date,basis]`);
  `SpaceSnapshot:2164-2211` (`stocks`/`crypto`/`isEstimated`; **no `fxMiss` field**);
  `FinancialAccount:819-928` (`balance` single scalar; **no per-date balance history**);
  `FxRate:2469-2483`.
- **Doctrine:** `docs/doctrine/financial-semantics.md` §6 (#10/#11 investments), §8 (debt
  flow-truth vs balance-truth precedent, `debtReconciliationResidual`).

*Read-only audit. Nothing was modified.*
