# DEC-0 — Numeric Precision Audit & Decimal Migration Roadmap

**Track/ID:** `DEC-x` — a **new foundational-architecture track** (numeric precision / money representation). Folder allocated at `docs/initiatives/dec/` per the STATUS.md §4 namespace rule (track prefix + folder created at allocation so the ID cannot be squatted). Non-numbered track folders are precedented (`flowtype/`, `platops/`, `desync/`, `wealth-timeline/`).
**Status:** 🔵 **DEC-0 (Audit) COMPLETE — 2026-07-16.** Planning/investigation only. **No runtime code, schema, or migration was touched. Nothing committed.** DEC-1…DEC-12 are proposed, not approved; each requires its own approved implementation checklist before any code/schema/migration work (standing project rule).
**Author:** Architecture investigation (DEC-0), read-only.
**Supersedes / reconciles:** the placeholder **"DB2 / Decimal migration"** parked (unnamed → tentatively `DB2`) in `docs/architecture/PORTFOLIO_MASTER_PLAN_2026-07-06.md`. **This DEC track is the execution vehicle for that parked work.** See §Governance for the naming reconciliation (a STATUS.md §4 allocation act, deliberately left to the owner).
**Evidence base:** full read of `prisma/schema.prisma` (2772 lines) + five parallel domain investigations (schema census, investments/crypto, aggregation, serialization/ingestion, FX), each cited inline by `file:line`.

---

## 0. Executive summary

Fourth Meridian stores and computes **every monetary value as IEEE-754 `double` (`Float`)** — 59 `Float` fields in the schema, **zero `Decimal`** — and performs all aggregation as raw `+`/`reduce`/`+=` over `number` with **no rounding at any accumulation or persistence point**. This is a known, deliberately-parked latent liability: the Portfolio Master Plan already names it *"the headline latent bug"* and *"decade-critical,"* and states the governing principle plainly:

> **"Money must be exact before money is revenue. Float survives 20 beta users; it must not survive billing."** — `PORTFOLIO_MASTER_PLAN_2026-07-06.md:203`

The audit's findings sharpen that framing into an actionable doctrine:

1. **The migration surface is 50 of 59 Float fields** — 37 money + 4 price + 9 quantity — across Accounts, Debt, Goals, Holding, the investment spine (PositionObservation / InvestmentEvent / PositionReconstruction / PriceObservation), Transaction, and the two snapshot tables. The other 9 (`FxRate.rate`, 2 APR, 3 ratio/pct, 3 confidence) are **out of the core money surface**; all 20 `Int` + 1 `BigInt` are counts/versions and irrelevant.

2. **Representation should be Prisma `Decimal` (decimal.js), role-scoped by precision — NOT uniform integer-cents.** Integer-cents cannot express crypto quantity (ETH needs 18 dp), fractional-share counts (3–6 dp), or sub-penny prices; forcing it would just relocate the precision loss into scale-conversion bugs. `Prisma.Decimal` already ships inside `@prisma/client` (`decimal.js-light` present in `node_modules`), so **no new runtime dependency is required.**

3. **The single most time-sensitive finding is crypto quantity, not money.** BTC is *integer-exact today* (satoshis stay `Number.MAX_SAFE_INTEGER`-safe) but loses exactness at the `sats / 1e8` boundary; **ETH/wei (18 decimals ≈ 27 significant digits) cannot be represented by `double` at all.** The crypto instrument layer (`crypto-instrument.ts`) is already generic for ETH/SOL — the day any non-BTC 18-decimal asset is onboarded, **wei silently truncates.** Crypto-quantity precision is therefore a *provider blocker*, not merely a hygiene item.

4. **Fourth Meridian is unusually well-positioned to migrate**, because money math already funnels through **one universal seam**: `lib/money/convert.ts` `convertMoney` / `convertAndSum`, which carries an explicit *"NO ROUNDING (plan D-4): full f64 precision end to end"* contract. Every aggregation layer except one (the AI holdings assembler, a known gap) routes through it. Converting that seam to Decimal propagates the precision contract across the whole platform from a single point.

5. **The dangerous coupling is serialization, not arithmetic.** `Prisma.Decimal.toJSON()` returns a **string**, so `NextResponse.json(rawRow)` would silently emit `"amount":"12.34"` into ~40 routes whose client interfaces all declare `amount: number` — TS-clean at the cast, `NaN`/string-concat at first arithmetic. A canonical Decimal↔wire seam must be built **before** any column flips.

6. **`FxRate.rate` is not an independent decision — it is a dependent of the money decision.** The prior "Float confirmed — plan D3" ruling was correct *for a Float-amount world* and explicitly pre-authorized its own reversal ("Revisit only if the product ever becomes accounting-grade"). A Decimal money migration **is** that trigger: a `Decimal amount × Float rate` multiply at the conversion seam would defeat the migration. Rate must move **in lockstep** with money — never mixed.

**Bottom-line verdicts** (full reasoning in §15): Money → Decimal **YES**; crypto quantities → Decimal **YES** (highest urgency); investment quantities → Decimal **YES**; FX rate → Decimal **YES, coupled to money**; Number stays for ratios/statistics **YES** and for UI/layout **YES**; one-shot migration **NO**; staged migration **YES**; do it before AI/Daily-Brief maturity **YES (representation + seam first)**.

---

## Part 1 — Current numeric census

### 1.1 Totals

| Prisma type | count | money-relevant? |
|---|---:|---|
| `Float` | **59** | 50 in scope (money/price/qty); 9 excluded (rate/apr/ratio/confidence) |
| `Decimal` | **0** | — |
| `Int` | 20 | none (counts, versions, ordinals, day-of-month, ms, score) |
| `BigInt` | 1 | none (`ApiUsageCounter.count`) |

Confirmed against `docs/investigations/V2.5_ARCHITECTURE_STATUS_AUDIT_2026-07-REFRESH.md:4` — *"Every monetary field in the schema is `Float` (zero `Decimal`)."* Runtime mirrors storage: `grep '.toNumber()'` = 0 hits; no `Prisma.Decimal` / `decimal.js` import anywhere in `lib/app/components`. Money is `number` end to end: DB Float → server math → `NextResponse.json` → client `number`-typed props.

### 1.2 Census by domain (Float fields, classified)

Classification: **money** (currency amount) · **qty** (asset units) · **price** (per-unit) · **rate** (FX) · **apr** (interest %) · **ratio** (pct/split) · **conf** (confidence/statistic). Persistence: **source** (system-of-record) · **cache** (denormalized/derived).

**Accounts / Balances — `FinancialAccount`**
`balance`:844 money·source · `availableBalance`:845 money · `creditLimit`:846 money · `nativeBalance`:881 **qty** (crypto native units) · `interestRate`:889 apr · `minimumPayment`:890 money.

**Debt — `DebtProfile`**
`apr`:944 apr · `minimumPayment`:945 money. (`dueDay`:946 / `statementCloseDay`:947 are `Int` day-of-month.)

**Goals — `SpaceGoal`**
`targetAmount`:1130 money · `currentAmount`:1131 money·**cache** ("denormalized — updated by sync job") · `targetReductionAmount`:1145 money · `targetReductionPct`:1146 ratio · `snapshotBalance`:1147 money.

**Holding (current-state read model)**
`quantity`:1250 qty · `price`:1251 price · `value`:1252 money · `change24h`:1253 ratio.

**PositionObservation (append-only investment spine)**
`quantity`:1361 qty · `institutionPrice`:1366 price · `institutionValue`:1367 money · `costBasis`:1369 money ("Plaid holding-level aggregate") · `vestedQuantity`:1370 qty · `unexplainedQuantity`:1377 qty.

**InvestmentEvent (activity log)**
`quantity`:1450 qty (signed) · `price`:1451 price · `amount`:1452 money (cash leg, signed) · `fees`:1453 money · `ratio`:1467 ratio (corporate-action split).

**PositionReconstruction (reconciliation summary)**
`observedCurrentQuantity`:1524 qty · `openingQuantity`:1525 qty · `unexplainedOpeningQuantity`:1526 qty ("persisted, NEVER forced to 0").

**Price series — `PriceObservation`**
`price`:1574 price ("quote-currency close; positive-finite; never adjusted-mixed"). Structural twin of `FxRate`.

**Transactions / Merchant**
`Transaction.amount`:1765 money (signed) · `classificationConfidence`:1800 conf · `transferEvidenceConfidence`:1880 conf · `Merchant.enrichmentConfidence`:1943 conf.

**Snapshots — `SpaceSnapshot` (daily net-worth rollup — ALL derived cache)**
`stocks`:2164 · `crypto`:2165 · `total`:2166 · `cash`:2169 · `savings`:2170 · `debt`:2171 · `netWorth`:2174 · `totalAssets`:2175 · `cashOnHand`:2176 · `netLiquid`:2177 — all money·cache, stamped with `reportingCurrency`:2189.

**Snapshot audit — `SnapshotAmendmentDay` (~2757)**
12 `Float?` before/after fields (stocks/crypto/cash/savings/debt/netWorth × Before/After), all money·**stored delta** — explicitly *"NOT recompute-on-read … stays true forever even after the account is hard-deleted."*

**FX — `FxRate`**
`rate`:2467 rate ("1 base = rate quote (Float confirmed — plan D3)"). Deliberate; see Part 6.

### 1.3 Persisted vs computed vs presentation

- **Persisted source-of-truth money/qty/price:** account balances, transaction amounts, holding/position observations, investment events, price observations, goal targets. *(migrate columns)*
- **Persisted derived cache:** every `SpaceSnapshot.*`, `SnapshotAmendmentDay.*`, `Goal.currentAmount`, `FinancialAccount.balance` for crypto (Σ Holding.value). *(migrate columns AND regenerate)*
- **Computed (never persisted):** all `classifyAccounts` totals, cash-flow folds, investment valuation, debt interest, AI assembler aggregates. *(migrate the arithmetic)*
- **Presentation/temporary:** `change24h`, confidence fields, all `Intl.NumberFormat` output, chart pixels. *(stays Number)*

---

## Part 2 — Numeric taxonomy & recommended primitives

| # | Category | Recommended primitive | Rationale |
|---|---|---|---|
| **A** | Exact monetary amount | **Decimal(23,4)** | Ledger exactness; 4 dp holds sub-cent fractional-crypto value and blocks sum-drift; 19 integer digits covers any net worth. |
| **B** | Exact asset quantity | **Decimal(28,8)** equities / **Decimal(38,18)** crypto | 8 dp = fractional shares + fund NAV counts; **18 dp is mandatory for wei** and non-negotiable for any ETH-class asset. |
| **C** | Exact price | **Decimal(20,6)** equities / **Decimal(28,10)** crypto | 6 dp for sub-penny/NAV/international; crypto needs wide integer part ($100k+ BTC) *and* deep fraction (sub-1e-8 tokens). |
| **D** | Exact exchange rate | **Decimal(24,12)** *(coupled to A)* | Cross-rate quotient is non-terminating; needs an explicit scale + rounding mode. Only migrate when A migrates (never mix Decimal amount × Float rate). |
| **E** | Exact cost basis | **Decimal(23,4)** | It *is* money (Plaid aggregate). Future `gain = value − costBasis` must be Decimal-subtracted. |
| **F** | Derived financial aggregate (net worth, totals) | **Decimal** (compute), **Number** at wire | Accumulate in Decimal to kill drift; coerce to Number once at the serialization seam. |
| **G** | Derived financial ratio (allocation %, blended APR, HHI) | **Number** | Ratios are analytical, display-grade; f64's 15–17 sig digits vastly exceed any meaningful ratio precision. Compute from Decimal inputs, emit Number. |
| **H** | Statistical metric (confidence, trend %, credit score) | **Number** / **Int** | Never ledger values; `FI0` doctrine forbids attaching arithmetic confidence to money anyway. |
| **I** | Presentation value (formatted currency, trend badge) | **Number → string** | Rounded at `Intl.NumberFormat`; the existing display boundary. |
| **J** | UI/layout number (pixels, opacity, scroll, scale) | **Number** | No exactness requirement whatsoever. |
| **K** | Count / integer (rows, versions, ordinals, days) | **Int / BigInt** | Already correct; untouched by DEC. |

**Doctrine in one line:** *Exactness where money is stored or accumulated (A–F in Decimal); Number everywhere it is ratioed, judged, formatted, or drawn (G–K).*

---

## Part 3 — Money doctrine

**Verdict: Money becomes universally `Decimal`.** Every field in category A/E/F above. Concretely, the 37 money Floats:

- `FinancialAccount.balance/availableBalance/creditLimit/minimumPayment`
- `DebtProfile.minimumPayment`
- `SpaceGoal.targetAmount/currentAmount/targetReductionAmount/snapshotBalance`
- `Holding.value`; `PositionObservation.institutionValue/costBasis`; `InvestmentEvent.amount/fees`
- `Transaction.amount`
- `SpaceSnapshot.*` (10) + `SnapshotAmendmentDay.*` (12)

**Representation choice — Decimal, not integer-cents.** Prior audits left this open (`V2.5_ARCHITECTURE_STATUS_AUDIT_*` name both candidates). The audit resolves it in favor of Decimal because the *same* migration must also handle quantity (18 dp) and price (sub-penny) — a single arithmetic model (decimal.js) across A–E is simpler and less bug-prone than money-in-int-cents beside quantity-in-Decimal. Integer-cents is rejected as the primary representation (it may still appear as an internal optimization inside a hot loop, never as the stored schema type).

**The already-correct parts** (do not disturb):
- Row-level currency is already stamped on every money/price row (MC1 Phase 0): `Transaction.currency`, `Holding.currency`, `PriceObservation.currency`, `SpaceSnapshot.reportingCurrency`. A Decimal migration **inherits** these stamps — it is orthogonal to, and composes cleanly with, MC1.
- Conversion is read-time, zero-mutation (`lib/money/convert.ts:6-9`). Stored facts are never rewritten; snapshots are the only write-time freeze. Decimal changes the *type* of those frozen values, not the freezing discipline.

---

## Part 4 — Investment precision doctrine

The valuation identity is `value = quantity × price × fx`, done entirely in `number` at `lib/investments/valuation-core.ts:165,207` (qty×price) and `:131` (×fx via `convertMoney`), then subtotaled at `:277` (`valuedSubtotal += reportingValue`). There is **no realized/unrealized-gain computation today** — `costBasis` is passed through, never subtracted (`current-positions-core.ts:103`) — so `gain = value − costBasis` is a *future* precision surface to design for, not an existing one.

**Recommended precision (do NOT assume 2 dp):**

| Role | Equity | Crypto |
|---|---|---|
| Money / market value / reporting value | Decimal(23,4) | Decimal(23,4) |
| **Quantity** | Decimal(28,8) | **Decimal(38,18)** |
| Price | Decimal(20,6) | Decimal(28,10) |
| Cost basis | Decimal(23,4) | Decimal(23,4) |

**Provider reality:** Plaid `/investments/holdings/get` delivers `quantity` (fractional — mutual-fund share counts to 3–4 dp), `institution_price` (2–4 dp, more for some funds/international), `cost_basis`, all as JSON numbers consumed verbatim (`position-capture.ts:64-76`, `sync-current-holdings.ts:58-70`) — already `double` before FM sees them, so FM storage can only *preserve or lose*, never recover, provider precision. Keeping `double` guarantees fractional-share and sub-penny NAV cases ride the ragged edge of representability. Fractional shares are currently governed by an existing `QUANTITY_EPSILON` tolerance (`A7_HISTORICAL…:278`) — i.e. the codebase *tolerates* float quantity imprecision rather than being exact; Decimal removes the need for that tolerance in the quantity domain.

**Invariants a migration must preserve:** `PriceObservation.price` "positive-finite; never adjusted-mixed" (:1574); `PositionReconstruction.unexplainedOpeningQuantity` "persisted, NEVER forced to 0" (:1526) — do not clamp during widening.

---

## Part 5 — Crypto precision doctrine (highest urgency)

| Asset | Smallest unit | Decimals | Full-precision sig-digits | `double` (~15.95 sig digits) verdict |
|---|---|---:|---:|---|
| BTC | satoshi = 1e-8 | 8 | up to ~16 (2.1e15 sats) | **Borderline** — safe for realistic single-wallet balances; last satoshi can flip at network scale; 0.1 BTC not exact in binary |
| ETH | wei = 1e-18 | 18 | up to ~27 | **Impossible** — `double` truncates ~11 digits; wei cannot be represented |
| ERC-20 / stablecoins | typ. 6–18 | 6–18 | up to ~27 | Same as ETH for 18-dp tokens |

**The precise loss points (BTC):**
1. On-chain balance is fetched as **integer satoshis** and summed exactly (`btc-sync.ts:534-539`, `reduce`, all < `MAX_SAFE_INTEGER`) — *exact today.*
2. **`btc-explorer.ts:104` `sats / 1e8`** is the conversion from exact integer to inexact binary BTC — **the primary loss point.**
3. Downstream, that float BTC quantity is written to `FinancialAccount.nativeBalance`, `Holding.quantity`, `PositionObservation.quantity` (`btc-sync.ts:560-572`, `wallet-position-capture.ts:65-76`) and to `Transaction.amount` (`btc-explorer.ts:359-385`), then valued via the same `qty×price×fx` chain as equities (`valuation-core.ts:207`).

**Verdict: crypto quantities become Decimal — and this is the most time-sensitive slice despite low data volume**, because `crypto-instrument.ts:47-57` (`resolveCryptoInstrumentId`) is already generic for ETH/SOL. **The first non-BTC 18-decimal asset onboarded onto the current Float `quantity` columns truncates wei on write — silently and unrecoverably.**

**Recommended structural model:** store crypto native quantity in the **smallest integer unit** (satoshis / wei as `Decimal(38,0)` or `BigInt`), deriving display BTC/ETH only at the presentation boundary. This makes on-chain sums exact and *eliminates the `/1e8` loss point entirely*. If a single decimal-units column is preferred, `Decimal(38,18)` per row still holds full satoshi + wei precision losslessly. `Holding.change24h` may remain a rounded display Float (it is a 2-dp percentage, `sync-current-holdings.ts:60`).

---

## Part 6 — FX precision doctrine

**Prior decision (verbatim):**
> **`Float`, not `Decimal`, for `rate`** — f64 carries ~15 significant digits; FX reference rates publish 5–6. Fourth Meridian is a reporting product, not a ledger of record; … introducing Prisma `Decimal` objects into one table creates mixed-arithmetic friction everywhere the rate touches a balance. **Revisit only if the product ever becomes accounting-grade.** — `MC1_MULTI_CURRENCY_ROADMAP.md:131` (§3.5), ratified as **D3** in `MC1_PHASE1_FX_PROVIDER_LAYER_PLAN.md:28`.

**The rate itself is genuinely not the risk.** Fiat rates carry 5–8 sig figs (USDJPY 149.382, EURUSD 1.08453, USDKRW ~1300); `double`'s 15–17 sig figs lose zero meaningful precision. D3's arithmetic is correct on that narrow point. `SUPPORTED_QUOTES` is fiat-only (`lib/fx/config.ts:23-27`) — crypto/hyperinflation range-stress is moot in the FX path.

**But the multiplication is the risk, and `FxRate.rate` is a *dependent* of the money decision — never an independent one:**
- `convertMoney` multiplies `money.amount * res.rate` (`convert.ts:70`) and cross-rates divide `legTo.rate / legFrom.rate` (`service.ts:89`, generally non-terminating).
- **Decimal amount × Float rate is incoherent** — D3's own "mixed-arithmetic friction" argument *inverts*: the Float rate becomes the friction/island at the exact multiply that matters, forcing a coercion back to f64 and nullifying the migration for every converted or aggregated value.
- Decimal rate × Float amount is pointless (bounded by the Float amounts).

**Verdict: reaffirm D3 while money stays Float; revise D3 → `FxRate.rate` becomes `Decimal(24,12)` in the same slice that the conversion seam goes Decimal.** A Decimal money migration *is* the "accounting-grade" trigger D3 named as its own revisit condition. The cross-rate division then needs an explicit scale + rounding mode (e.g. round-half-even at stored scale) — a *new* decision Decimal forces that Float silently hid. Rule for the plan: **`FxRate.rate`'s type mechanically follows the money columns — Float↔Float or Decimal↔Decimal, never mixed.**

---

## Part 7 — Aggregation audit (drift analysis)

Every layer accumulates raw f64 with **no intermediate rounding**; rounding exists only at two *output* boundaries (AI-payload cent-snapping, percentage `Math.round`). The architecture's gift is a **single conversion chokepoint** (`convertMoney`) that nearly everything funnels through.

**Accumulation hotspots, ranked by drift risk:**

1. **`reconstructDailyCashBalances` / `reconstructDailyLiabilityBalances`** (`lib/snapshots/backfill-core.ts:59-124`) — **worst.** Up to ~30 chained f64 subtractions/additions per account, newest→oldest, seeded from a float balance, where each daily `sum` is itself a Postgres `_sum.amount` float aggregate (`backfill.ts:229-277`), and every reconstructed day is re-summed through `classifyAccounts` and persisted to Float columns. Sequential dependency = maximum compounding, and it writes *persisted history*.
2. **`foldDayFacts`** (`lib/transactions/cash-flow-projection.ts:140-167`) — highest row count (all transactions); 10 parallel `+=` accumulators; the classic 0.1+0.2 surface (sub-cent until totals are large).
3. **AI transactions fold** (`lib/ai/assemblers/transactions.ts:489-583`) — same volume; drift *masked* by `Math.round(x*100)/100` at the payload boundary but present in accumulation.
4. **`valueInstrumentAsOf` + `valuePortfolioAsOf`** (`valuation-core.ts`) — `qty×price×fx` products then subtotal fold; A9 replay re-runs per historical day.
5. **`computeDebt` full-rows loop** (`lib/perspective-engine/lenses/debt.core.ts:228-246`) — the only `rate×balance` products + a balance-weighted `blendedApr` ratio (division over two float sums); low count, most per-value sensitive.
6. **`sumBalances` / `classifyAccounts`** (`lib/account-classifier.ts:170-270`) — low count but the **fan-in** for every live total and both snapshot writers.

**The universal seam:** `lib/money/convert.ts` `convertMoney` (`:70`) / `convertAndSum` (`:88-97`) — explicitly *"NO ROUNDING (D-4), full f64."* Every layer **except** `lib/ai/assemblers/holdings-core.ts` routes through it (that assembler "still sums raw values, not yet threaded through the conversion seam" — `lib/ai/types.ts:843-845`, a pre-existing multi-currency correctness gap to fold into the cutover).

---

## Part 8 — Serialization audit

**The load-bearing hazard:** `Prisma.Decimal.toJSON()` returns a **string**. `NextResponse.json(rawPrismaRow)` therefore emits `"amount":"12.34"` where every client interface declares `amount: number` — passes `tsc` at the fetch cast, then `NaN` (`"12.34" * qty`) or string-concat (`+`) at first arithmetic. There is **no existing seam to absorb this** (0 `.toNumber()` calls in the repo).

| Area | Risk | Sites |
|---|---|---|
| **API route serialization** | **(b) breaking** | 127 `NextResponse.json` calls; ~40 return raw money rows. Confirmed breakers: `transactions/route.ts:58`, `snapshots/route.ts:62`, `accounts/route.ts:107`, `goals/*`, `investments/space-data/route.ts:75` (passthrough `costBasis`/`quantity`/`price` subset). |
| **Client hydration / props** | **(b) breaking** | Every money interface typed `number`: `SpaceDashboard.tsx:170,186`, `SpacesClient.tsx:96`, `lib/money/types.ts:19,35`, `lib/export/types.ts:43-55`. |
| **Coercion sites** | mixed | `sync-current-holdings.ts:61` (`toFixed→parseFloat` on prices — **throws on Decimal**), `transfer-resolution.ts:60` (`Math.round(amount*100)` match key — coerces, defeating exactness), `btc-explorer.ts:109`. The `Math.round(x*100)/100` cent-snapping cluster in `lib/ai/**` is safe *iff* Decimal→number happens upstream. |
| **Provider ingestion** | **(a) low** | Writes accept `number` into Decimal columns fine. `csv.ts:406 parseFloat` / `excel.ts:183` cap source at float — upgrade to `new Decimal(str)` only if source fidelity matters. Plaid already delivers `number`. |
| **Exports** | **(b) quiet break** | `lib/export/holdings.ts:36-67` passes `price/value/costBasis` verbatim into `csv.ts:77`; a Decimal object stringifies unpredictably in a CSV cell with **no rounding guard**. |

**Canonical seam (recommended):** a new `lib/money/wire.ts` (sibling to the existing `serializeContext`/`rehydrateContext` in `convert.ts:122,145`) exposing `toWireNumber(Decimal)` / `toWireMoney(row)`, run at **the route boundary and the composition loaders** (`lib/investments/space-data.ts`, `lib/connections/space-data.ts`, `lib/data/snapshots.ts` — already the canonical DB→contract mappers). **Never let Decimal reach:** client props, `Intl.NumberFormat` (`lib/format.ts`), CSV cells, or float-operator math. **Keep client types `number`** — do not ship decimal.js to the browser.

---

## Part 9 — Provider implications

- **Plaid** (transactions + holdings): delivers `number` (already f64). Storage choice preserves-or-loses only; Decimal write from `number` is lossless-of-what-arrived. No parseFloat in the Plaid path.
- **BTC explorer** (mempool/blockstream): integer sats + integer fee — **exact until `/1e8`**; the integer-unit storage model (Part 5) keeps it exact end-to-end.
- **CoinGecko / Tiingo** (prices): `number`, full float, no normalization (`coingecko.ts:86`, `tiingo.ts:41,135`).
- **CSV / Excel import**: `parseFloat`/`cellRawNumber` (`csv.ts:406`, `excel.ts:183`) — the *first* capture of external money strings; upgrade to Decimal construction to preserve arbitrary source precision (else capped at float).
- **Normalization precision:** incoming precision should be captured at *provider fidelity* (Decimal at the parse boundary), stored at *role precision* (Part 2 table), and normalized (FX-converted) only at read time — never re-quantized on write.

---

## Part 10 — UI implications (where Number is correct)

Number is **perfectly acceptable and should stay** for:
- **Layout / rendering:** chart coordinates, pixel values, SVG paths, `width`/`height`, scroll offsets, animation/tween scale (`useScrollShrink` `computeShrink`), opacity, responsive breakpoints.
- **Derived presentation values that are not ledger:** trend percentages (`netWorthTrendPct`), `change24h`, allocation share % for a pie slice, HHI/concentration, blended APR display, day counts.
- **Formatted output:** everything through `lib/format.ts` (`Intl.NumberFormat` does not accept Decimal — coerce Decimal→number immediately before formatting).

Rule: **compute from Decimal, ratio/format/draw in Number.** A ratio of two Decimals is emitted as Number at the boundary; there is no accuracy loss because ratios are display-grade.

---

## Part 11 — Migration roadmap

**Core principle — the two-phase-per-domain ratchet** (matches this repo's proven "additive-before-subtractive / exact-equivalence" style, e.g. SD-3, MC1 Phase 0):

- **Widen (behavior-preserving):** flip a domain's columns to `Decimal`, and **coerce Decimal→number at the read boundary immediately** (`.toNumber()` in the composition loader). Arithmetic stays f64 → **golden baselines byte-identical**, migration reversible. This de-risks the schema change in isolation.
- **Deepen (numbers change):** replace f64 math in that domain's cutover functions with Decimal ops, then **regenerate golden baselines** (now exact). This is the only step where stored/emitted numbers move.

Never widen a money column without the read-boundary coercion already in place — that is what prevents a repo-wide `tsc`/runtime break.

### Recommended slice order

| Slice | Scope | Type | Notes |
|---|---|---|---|
| **DEC-0** | **Audit** (this document) | ✅ done | — |
| **DEC-1** | **Numeric Doctrine ratification** — approve Part 2 taxonomy, precision table, Decimal-not-cents, and the wire-contract policy. | planning | No code. Ratifies §Verdicts; supersedes/renames DB2 (§Governance). |
| **DEC-2** | **Serialization seam (scaffold)** — build `lib/money/wire.ts`; route ALL money serialization through composition loaders + a `toWire` mapper **while still `number`**. Add a guard test/lint banning raw `NextResponse.json` of money models. | additive, behavior-neutral | *Must precede any column flip.* Establishes the seam that later absorbs the Decimal type change. |
| **DEC-3** | **Conversion core → Decimal** — `convertMoney`/`convertAndSum` Decimal-capable; **`FxRate.rate` → Decimal(24,12) in lockstep** (revise D3); cross-rate division scale + rounding-mode decision; fold in the `holdings-core.ts` seam gap. | widen + deepen | The universal chokepoint — highest leverage. |
| **DEC-4** | **Money core columns (accounts, goals, debt money)** — widen `FinancialAccount.*`, `SpaceGoal.*`, `DebtProfile.minimumPayment`; coerce at boundary. | widen | Live-total surface; small blast radius after DEC-2/3. |
| **DEC-5** | **Transactions** — `Transaction.amount` widen+deepen; cash-flow fold (`foldDayFacts`). | widen + deepen | Highest row volume; transfer-match key (`transfer-resolution.ts:60`) must move to Decimal. |
| **DEC-6** | **Snapshots** — `SpaceSnapshot.*` + `SnapshotAmendmentDay.*` widen; `computeSnapshotFields` + the two reverse-walk reconstructors deepen; **regenerate snapshot history + golden baselines**. | widen + deepen + regen | Worst sequential drift; the persisted-history slice. |
| **DEC-7** | **Wealth / classifier** — `sumBalances`/`classifyAccounts` deepen (fan-in for all live totals + snapshot writers). | deepen | Reads DEC-4/6 columns; low own-drift. |
| **DEC-8** | **Cash Flow** — deepen `foldDayFacts`/`rowMagnitude` + `foldEconomicRow`/`clampEconomicSpend`. | deepen | Perf-sensitive (see §12). |
| **DEC-9** | **Investments valuation** — `Holding.*`, `PositionObservation.*`, `InvestmentEvent.*`, `PriceObservation.price` widen; `valueInstrumentAsOf`/`valuePortfolioAsOf` deepen (qty×price×fx); A10/allocation/flows inherit. | widen + deepen | A9 replay regen. |
| **DEC-10** | **Crypto quantities** — integer-unit (sat/wei) storage model; `btc-explorer.ts`/`btc-sync.ts`/`wallet-position-capture.ts`. **Pull forward ahead of DEC-9 if any non-BTC crypto provider is on the near-term roadmap** (wei-truncation blocker). | widen + deepen | Provider blocker; low volume, high urgency. |
| **DEC-11** | **FX conversion hardening** — cross-rate rounding-mode, walked-back-leg precision, `stamp-conversion.ts` display re-conversion. | deepen | Rate type already flipped in DEC-3. |
| **DEC-12** | **Float retirement** — assert zero money/qty/price `Float` remain; permanent guard (lint rule: no `Float` on money models, no raw money-row `NextResponse.json`); re-ratify all golden baselines; delete now-redundant `QUANTITY_EPSILON`/cent-snapping where accumulation is exact. | subtractive | Closeout + regression fence. |

**Divergence from the user's straw-man ordering:** serialization is pulled to the *front* (DEC-2, before any flip) rather than DEC-11 — the wire seam must exist before columns change or ~40 routes break simultaneously. FX rate is handled inside DEC-3 (coupled to the conversion seam) rather than as a late standalone. Crypto (DEC-10) carries a conditional pull-forward.

---

## Part 12 — Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| **Wire-contract break** (Decimal→string in JSON) | **High** | DEC-2 seam *before* any flip; guard test banning raw money-row `NextResponse.json`; client stays `number`. |
| **Golden-baseline churn — "compounds daily"** | **High** | Every existing golden (`debt.golden`, `account-classifier.golden`, `transactions/serialize.golden`, `ai/assemblers/transactions.golden`) pins f64 sums. Two-phase ratchet keeps *widen* byte-identical; *deepen* regenerates baselines deliberately, one domain at a time. Cost rises with every new snapshot/transaction — **schedule sooner rather than later.** |
| **Decimal arithmetic cost** (decimal.js ~10–100× native f64) | **Medium** | Hot loops: `foldDayFacts` (thousands of rows), A9 replay (per-day re-valuation), reverse walks. Mitigate by keeping *inner* hot loops in Number where the value is not ledger-persisted, converting at domain boundaries; benchmark DEC-8/DEC-6 before/after. |
| **Client bundle bloat** | **Low** | Do not ship decimal.js to the browser; seam converts server-side; `Prisma.Decimal` stays server-only. |
| **Prisma implications** | **Medium** | Reads return `Prisma.Decimal`; `_sum`/`_avg` return Decimal; ordering/filtering unaffected. `Prisma.Decimal` already bundled (`decimal.js-light` in `node_modules`) — **no new dependency.** |
| **Breaking API changes** | **Medium** | Contained by the DEC-2 seam; contracts stay `number`-typed on the wire. |
| **Schema migration mechanics** | **Medium** | `Float→Decimal` is an in-place `ALTER COLUMN TYPE` (Postgres casts double→numeric); per project rule use `migrate diff` + `migrate deploy`, scope each migration to the slice, never use a real DB as shadow. |
| **Historical replay** (A9) | **Medium** | Re-derives from persisted facts → must regenerate after DEC-6/DEC-9; `WEALTH_REGEN_EPSILON=0.5` noise floor can tighten once exact. |
| **Test impact** (256 tests) | **Medium** | Many assert exact f64 numbers; money equality assertions must become Decimal-aware. Widen phase preserves values; deepen phase updates expected values per slice. |
| **Concurrent-seam collision** | **High** (governance) | Portfolio doctrine: *"DB2/Decimal with any open seam whatsoever … the portfolio's one full-stop initiative"* (`PORTFOLIO_MASTER_PLAN:220`). DEC must be an **exclusive-lock initiative** — no other schema-touching work in flight. |

---

## Part 13 — Intersection with existing doctrine

- **MC1 (multi-currency):** *complementary, not conflicting.* Row-level currency stamps and read-time zero-mutation conversion are inherited unchanged; DEC changes the numeric *type*, MC1 owns the *denomination*. The one action item MC1 leaves for DEC: thread `holdings-core.ts` through the conversion seam (`types.ts:843-845`).
- **FX D3 decision:** explicitly revisited here (Part 6) — its own "accounting-grade" revisit trigger is met; rate flips with money in DEC-3.
- **PCS / investment spine (PositionObservation, A8/A10):** the `qty×price×fx` chain and reconciliation residuals (`unexplainedOpeningQuantity`, "never forced to 0") are precision-sensitive and must preserve their first-class-residual invariants through widening.
- **Snapshot reconstruction / D2.x backfill:** the reverse cash/liability walks are the worst drift source; `isEstimated` provenance and `SnapshotAmendmentDay` stored-delta ("NOT recompute-on-read") invariants must survive.
- **FI0 Financial Intelligence Doctrine:** the `*Confidence` Floats are classification confidences, explicitly *not* arithmetic — they stay Number and are out of DEC scope (attaching precision to them would be the "false precision" the doctrine forbids).
- **Portfolio Master Plan:** already parks this as **DB2**, *"decade-critical,"* exclusive-lock, golden-regenerating, **at the v3.0 quiet start before billing.** DEC is DB2's execution track.

---

## Part 14 — Estimated effort by slice

T-shirt sizing (relative; assumes exclusive lock, one engineer + review):

| Slice | Effort | Driver |
|---|---|---|
| DEC-1 Doctrine | **S** | Decision ratification, no code. |
| DEC-2 Wire seam | **M** | New module + rewiring ~40 routes/loaders through it; guard test. |
| DEC-3 Conversion core + FX rate | **M** | Small surface, high care (cross-rate rounding mode, seam-gap fold-in). |
| DEC-4 Money columns | **S–M** | Mechanical widen after seam exists. |
| DEC-5 Transactions | **M** | Volume + transfer-key + cash-flow entry. |
| DEC-6 Snapshots | **L** | Reverse walks + history regeneration + baseline churn. |
| DEC-7 Wealth/classifier | **S** | Deepen the fan-in functions. |
| DEC-8 Cash flow | **M** | Deepen + perf benchmark. |
| DEC-9 Investments | **L** | Widest column set + A9/A10/allocation inheritance + replay regen. |
| DEC-10 Crypto qty | **M** | Integer-unit remodel; low volume, precise care. |
| DEC-11 FX hardening | **S** | Rounding-mode + display re-conversion. |
| DEC-12 Retirement | **S–M** | Guards, baseline re-ratification, cleanup. |

**Aggregate:** a multi-week exclusive-lock initiative (roughly **2 L + 4 M + rest S**). The dominant cost is not code but **golden-baseline regeneration and test re-ratification**, which grows with every day of accrued data — the central argument for scheduling it early in the next quiet window.

---

## Part 15 — Final architectural recommendation & verdicts

**Recommendation:** Adopt the DEC numeric doctrine (Part 2), migrate the **50-field money/price/quantity surface to role-scoped `Prisma.Decimal`** via the **two-phase-per-domain ratchet**, build the **serialization seam first (DEC-2)**, convert the **universal `convertMoney` chokepoint (DEC-3)** with `FxRate.rate` coupled in lockstep, and run the whole track as a **single exclusive-lock initiative** in the next quiet window **before billing and before AI/Daily-Brief matures its numeric contracts.** Pull **crypto quantity (DEC-10) forward** if any non-BTC crypto provider is near-term. Keep **Number for ratios, statistics, formatting, and all UI/layout.**

**Critical blockers discovered:**
1. **Wei-truncation provider blocker** — the generic crypto-instrument layer will silently truncate any 18-decimal asset on the current Float `quantity` columns. Highest-urgency correctness risk.
2. **Wire-contract break** — `Decimal.toJSON()→string` across ~40 raw-row routes; the seam must exist before any flip.
3. **Golden-baseline compounding** — every new snapshot/transaction raises migration cost; the delay itself is the risk.
4. **Exclusive-lock requirement** — DEC cannot run alongside any other schema-touching seam (portfolio doctrine).

### Explicit verdicts

| Question | Verdict |
|---|---|
| Money should become Decimal? | **YES** — role-scoped `Decimal(23,4)`; not integer-cents. |
| Crypto quantities should become Decimal? | **YES** — `Decimal(38,18)` (or integer sat/wei); highest urgency (provider blocker). |
| Investment quantities should become Decimal? | **YES** — `Decimal(28,8)` equities; preserves fractional shares exactly. |
| FX rates should become Decimal? | **YES — but coupled to money**, in the same slice (DEC-3); never Decimal-amount × Float-rate. Reaffirm D3 only if money stays Float. |
| Number should remain for analytical ratios? | **YES** — allocation %, blended APR, HHI, trend %. |
| Number should remain for UI/layout? | **YES** — pixels, opacity, scroll, animation, chart coordinates. |
| One-shot migration recommended? | **NO** — a single big-bang breaks ~40 routes and every golden baseline at once. |
| Staged migration recommended? | **YES** — DEC-1…DEC-12, two-phase-per-domain ratchet. |
| Should this occur before AI/Daily-Brief maturity? | **YES** — representation + seam (DEC-1→DEC-3) before AI numeric contracts harden; the full deepen can trail, but the type/seam foundation should land first. |

---

## Governance — DEC vs DB2 naming reconciliation (owner decision)

The Portfolio Master Plan parked this work as **"DB2"** in the DB-x hygiene track (`PORTFOLIO_MASTER_PLAN_2026-07-06.md:166,203`). This audit was commissioned as **"DEC-0"** with a DEC-x phase structure. These are the same initiative. Because track allocation is a STATUS.md §4 governance act, the audit does **not** unilaterally rename it — it flags the choice:

- **(a)** Promote **DEC-x** as the real track name (numeric-precision is a distinct concern from physical-schema hygiene, which is what DB-x otherwise holds) and retire "DB2" as a superseded placeholder; **or**
- **(b)** Keep the DB2 label inside DB-x and treat this folder as DB2's investigation home.

**Recommendation:** option (a) — DEC-x reads truer to the concern and the phase count (0–12) already exceeds a single DB-x slot. Whichever is chosen, record it in STATUS.md §4/§5 at DEC-1 entry.

---

*DEC-0 audit complete. Read-only. No runtime code, schema, migration, commit, or push was performed. DEC-1…DEC-12 are proposals pending per-slice approval.*
