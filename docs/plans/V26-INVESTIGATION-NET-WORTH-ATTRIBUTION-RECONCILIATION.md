# V26 Investigation — Net Worth Attribution Reconciliation

**Status:** Investigation only. No code, no schema, no data modified, nothing committed. All database access read-only (`SELECT` only).
**Repository:** `v2.6` @ `146a0dd` · **Database:** local development copy, `localhost:5432/fintracker`
**Subject:** is "What moved your net worth? → Investments +$6,635" correct, mislabelled, or wrong?

**Marking:** **[EXISTS]** verified in repo/DB · **[ABSENT]** verified missing · **[INFERRED]** reasoned · **[PROPOSED]** recommendation

---

## 1 · Attribution architecture and call graph

```
SpaceSnapshot rows                         prisma/schema.prisma:2220
  (date, stocks, crypto, cash, savings, debt, netWorth, totalAssets, isEstimated)
        │
        ▼
toState(snapshot)                          lib/wealth/wealth-time-machine.ts:167-182
  cash        = totalCash + totalSavings
  investments = totalInvestments            ← maps to SpaceSnapshot.stocks
  crypto      = totalCrypto
  real        = max(0, totalAssets − cash − investments − crypto)   ← clamped residual
  liabilities = totalDebt
        │
        ▼
resolveState(series, asOf) / resolveState(series, compareTo)    :249-250
        │
        ▼
deltas.composition[id] = asOfState.composition[id] − compareState.composition[id]   :262-268
        │
        ▼
drivers = keys → {id, label, delta}, |Δ| > EPS, sorted by |Δ|     :270-274
        │
        ▼
WealthChangeLedger                         components/space/widgets/wealth/WealthChangeLedger.tsx
  rows filtered by METRIC_DRIVER_COMPONENTS[metric]              :71-72
  Net Change = deltas[metric].abs                                :76
  ATTRIBUTION_NOTE rendered beneath                              :117
```

**Presentation is inert.** `WealthChangeLedger.tsx:15` — *"Presentation only — every number comes from the WealthResult."* No arithmetic occurs in the component. **[EXISTS]**

**What is absent from the pipeline** — verified, not assumed:

| Concept | Status |
|---|---|
| Buys / sells / trades | **[ABSENT]** — no `InvestmentEvent` read anywhere in this path |
| Cost basis, realized gain | **[ABSENT]** |
| Contributions / withdrawals | **[ABSENT]** |
| Transfer handling | **[ABSENT]** — no transaction is read at all |
| Dividends, fees, interest | **[ABSENT]** |
| Market appreciation as a distinct quantity | **[ABSENT]** |

The attribution pipeline reads **only daily snapshot balances**. It never touches `Transaction`, `InvestmentEvent`, `PositionObservation`, or `PriceObservation`.

---

## 2 · Intended semantics — from implementation, not wording

`wealth-time-machine.ts:264`:

```ts
investments: asOfState.composition.investments − c.composition.investments
```

**`Investments +$X` is the change in the investments balance between two dates. Nothing more.**

It is **not** market appreciation, **not** realized gains, **not** net contributions, **not** asset-class contribution to return. The code says so twice, unprompted:

- `wealth-time-machine.ts:25` — *"drivers are real snapshot component deltas — never invented attribution."*
- `WealthChangeLedger.tsx:11-13` — *"we NEVER label a row Market Growth / Contributions / Income / Spending / Fees today."*
- `ATTRIBUTION_NOTE` (`:36-37`) — *"Attribution by market growth vs. contributions arrives with historical valuation."*

**The implementation is internally honest.** It knows it is not doing attribution and says so on screen.

---

## 3 · The governing invariant

For any composition component whose balance is non-negative:

```
delta = balance(asOf) − balance(compareTo),   balance(compareTo) ≥ 0
  ⟹   delta ≤ balance(asOf)
```

**A driver row can never exceed the current balance of its own component.** Your instinct — *"I do not understand how the investment contribution can exceed the current investment balance"* — is not merely a suspicion. It is a provable invariant of this implementation, and it currently has no test. **[ABSENT]**

Verified: `stocks ≥ 0` for all 737 snapshots in the real Space; `real` is additionally clamped at `max(0, …)` (`:170`).

---

## 4 · Reconstructed period — real data only

The database mixes real Plaid data with seeded demo data. Partitioning on `plaidAccountId IS NOT NULL`, the real Space is **"Chris' Space"** (737 snapshots, 2024-07-21 → 2026-07-27) — the only Space whose window matches the real Plaid history. All seeded Spaces ("John's", "Jane's", "Smith-Doe Household", "Debt Payoff Tracker") were excluded from every conclusion.

**Endpoints:**

| | Date | Investments | Crypto | Cash | Debt | Net worth |
|---|---|---|---|---|---|---|
| First | 2024-07-21 | **12** | 15,517 | 0 | 29,359 | −13,831 |
| Last | 2026-07-27 | **4,966** | 15,517 | 5,726 | 234 | 25,974 |

Your recollection of ≈$4,968 current investments matches the last snapshot (**4,966**) to rounding. ✔

**Every standard comparison window, as-of 2026-07-27:**

| Window | Investments Δ | Crypto Δ | Cash Δ | Liabilities Δ | Net Change |
|---|---|---|---|---|---|
| 1M | **+3,305** | +1,046 | +754 | −7,192 | +12,297 |
| 3M | +391 | 0 | +687 | −5,112 | +6,189 |
| 6M | −517 | 0 | −1,357 | −37,028 | +35,155 |
| YTD | −276 | 0 | −3,792 | −36,976 | +32,908 |
| 1Y | −604 | 0 | −2,919 | −41,129 | +37,606 |
| **ALL** | **+4,955** | 0 | +5,726 | −29,125 | +39,805 |

**No window produces +6,635.** The maximum possible today is ALL = +4,954, exactly as the §3 invariant requires (4,966 − 12).

---

## 5 · Where +6,635 can and cannot come from

Exhaustive pair search over all 737×736 ordered endpoint pairs in the real Space:

| Query | Result |
|---|---|
| Pairs with Investments Δ ∈ [6,627, 6,643] | **0** |
| Maximum achievable Investments Δ, any pair | **7,018** (peak 7,030 on 2025-10 − floor 12) |
| Pairs with Δ ∈ [6,500, 6,800] | 21 — **all** with `compareTo = 2024-07-21` and as-of in **Oct–Nov 2025** |
| Nearest values | 6,720 · 6,665 · 6,655 · 6,624 |
| Pairs with Δ ∈ [6,630, 6,640] in **other** Spaces | **Smith-Doe Household: 5 · John's Space: 4** — both seeded |

So:

- **+6,635 is not producible from your real data with as-of = today.** Provably: it would require `stocks(compareTo) = 4,966 − 6,635 = −1,669`.
- The value is *near-producible* only with an as-of in **October–November 2025** against the **ALL** window — a period when investments peaked around 6,600–7,030.
- The exact figure **does** occur in two seeded demo Spaces.

**[INFERRED]** — one of: the screenshot was taken with an as-of in Oct/Nov 2025 (where the composition card would read ≈6,6xx, not 4,968); or it was a seeded Space; or the figure was transcribed approximately. **I cannot determine which without the screenshot's Space and dates**, and I will not guess.

**What I can state without qualification:** a render showing *Current Investments ≈ 4,968* and *Investments +6,635* **simultaneously, from one `WealthResult`, is impossible** — both derive from the same `asOfState.composition.investments`, so the row is arithmetically pinned to `4,966 − compare`.

---

## 6 · Investment sale analysis

**No sale is visible in the attribution pipeline, by construction.** The pipeline reads snapshot balances only (§1); it has no access to trades. `InvestmentEvent` **[EXISTS]** as a model but is read by no part of this path.

**On your recollection** — sold appreciated positions, proceeds stayed in the brokerage, nothing contributed or withdrawn:

`SpaceSnapshot.stocks` is documented as *"sum of investment account balances"*. Brokerage cash sits **inside** the investment account balance. Therefore:

> A sale whose proceeds remain in the brokerage should produce **no change** in `stocks`, **no** Investments driver row, and **no** net-worth change.

That is the financially correct behaviour, and this implementation would produce it. **Your recollection and a correct system are consistent with each other** — an internal sale is invisible here, and should be.

Which makes the observed recent series the thing that needs explaining.

---

## 7 · The finding that is independent of the $6,635 question

Daily investments series, 2026-06-20 → 2026-07-27:

```
06-25   5,048   est=true
06-26   1,661   est=true     ← −3,387 in one day
  …     ~1,6xx  est=true     ← 23 days at the depressed level
07-18   1,566   est=true
07-19   5,069   est=FALSE    ← +3,503 in one day
07-22   5,265   est=FALSE
07-27   4,966   est=FALSE
```

**The ~3,400 disappearance and its recovery lie entirely within `isEstimated = true` snapshots, and the recovery lands exactly on the first `isEstimated = false` snapshot.**

This is the signature of a **valuation gap**, not a sale: an estimated reconstruction that could not value part of the portfolio, persisting until real observations returned. **[INFERRED]** — strongly, from the exact coincidence of the recovery with the estimation flag flipping.

**Direct consequence, and this one is concrete:**

> The **1-month window shows "Investments +$3,305"**. Its compare endpoint is 2026-06-27, whose value is **1,661 — inside the dropout**. That figure is `4,966 − 1,661`. It is **almost entirely an artifact of the estimation gap**, not investment performance.

And the ledger says nothing about it. `WealthState.isEstimated` **[EXISTS]** (`wealth-time-machine.ts:171`) and is carried on every state and chart point — but `WealthChangeLedger` never reads it. A driver row computed from a known-estimated endpoint is rendered with the same authority as one computed from two real observations. **[ABSENT]** — no endpoint-estimation disclosure in the ledger.

---

## 8 · Double-counting audit — each hypothesis tested and falsified

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Realized gains double-counted with market gain | **Falsified** | The pipeline reads no trades and no gains. There is only one quantity: a balance delta |
| Sale proceeds counted alongside appreciation | **Falsified** | Same — proceeds are not an input |
| Stock/flow confusion (current balance vs historical contribution) | **Confirmed as a labelling risk, not a computation error** | The computation is a pure stock difference; the *heading* ("What moved…") invites a flow reading. See §10 |
| Internal transfer inflation (brokerage → checking counted as gain) | **Falsified for net worth; real for component rows** | A brokerage→checking move reduces `stocks` and raises `cash` by the same amount. Net worth is unchanged (verified: ALL-window components +4,955 +0 +5,726 −(−29,125) = +39,806 ≈ net change +39,805, rounding). But the two *rows* would read "Investments −X / Cash +X", which is a transfer, not a move in wealth |
| Asset reclassification (security → brokerage cash treated as new value) | **Falsified** | Both live inside `stocks`; reclassification within the account is invisible |
| Category leakage (brokerage cash classified as cash) | **Falsified** | `cash = totalCash + totalSavings` (checking + savings only); brokerage cash stays in `stocks` |
| Beginning-balance error | **Not falsified — material** | The ALL window's compare endpoint is 2024-07-21 with `stocks = 12`, i.e. essentially the day tracking began. Every ALL-window Investments row is therefore "everything since we started watching", not "what your investments did" |
| Missing liabilities | **Falsified** | `liabilities = totalDebt`, present at both endpoints |
| Price timing / historical valuation | **CONFIRMED — see §7** | The 23-day estimated dropout distorts any window whose endpoint lands inside it |

**Two real defects survive falsification:** the estimation-gap distortion (§7) and the absent invariant test (§3). Neither is double counting.

---

## 9 · Explaining the numbers

For the current render (as-of 2026-07-27, ALL window):

| Row | Value | Derivation |
|---|---|---|
| Cash | +5,726 | (cash+savings) 5,726 − 0 |
| Investments | +4,955 | stocks 4,966 − 12 |
| Crypto | 0 | 15,517 − 15,517 — filtered out by the `|Δ| > EPS` rule (`:273`) |
| Liabilities | −29,125 | debt 234 − 29,359 |
| **Net Change** | **+39,805** | `deltas.netWorth.abs` = 25,974 − (−13,831) |

Components sum to +39,806 vs Net Change +39,805 — a 1-unit rounding difference. **The ledger reconciles.**

**Mathematically, +6,635 cannot be explained for this render.** It exceeds the component's current balance (4,966), violating the §3 invariant, and requires a negative historical balance.

---

## 10 · Truthfulness audit

Can the UI honestly support *"Investments increased your net worth by $6,635"*?

**No — and it does not claim to.** The heading is "What moved your net worth?", the rows are bare `{label, delta}` pairs, and the card closes with an explicit disclaimer that attribution by market growth vs contributions has not arrived. The implementation is more honest than the question assumes.

But the wording still under-specifies what it *is*:

| Current | Problem |
|---|---|
| "What moved your net worth?" + "Investments +X" | "Moved" reads as a flow/cause. The number is a stock difference |

Most truthful phrasings, in order of preference:

1. **"Investment balance change: +$X"** — exactly what is computed, no causal claim
2. **"Your investment holdings are worth $X more than on <date>"** — states the comparison explicitly
3. *"Net investment activity contributed…"* — **rejected**: implies contributions, which are not computed
4. *"Market appreciation contributed…"* — **rejected**: not computed

**Recommended heading change:** "What changed since <date>?" rather than "What moved…?" — a difference, not a cause.

**Required disclosure that is missing:** when either endpoint has `isEstimated = true`, the row must say so. Today §7's +3,305 renders indistinguishably from a real gain.

---

## 11 · Comparison with proper portfolio attribution

Proper attribution decomposes a balance change into external contributions, withdrawals, market appreciation, realized gains, income (dividends/interest), and fees. It requires trades, cost basis, and dated prices.

**All three exist in the schema and none is used here:** `InvestmentEvent`, `PositionObservation` (with `costBasis`), `PriceObservation`. **[EXISTS]**

So the correct statement of the gap is not *"the calculation is wrong"* but: **a balance-delta ledger is being presented under a heading that promises attribution, while the inputs required for attribution sit unused one layer away.** Building real attribution is feasible without new ingestion — it needs a compiler, not new data.

---

## 12 · Architecture

Your intuition:

```
Financial Truth → Attribution Compiler → Net Worth Attribution → Assessment
```

**Endorsed, with one correction and one addition.**

**Correction — attribution is not derivable from Financial Truth alone as currently scoped.** A balance delta needs two sealed truth objects; a *decomposition* needs the flows between them. So the compiler's input is `(Truth_t0, Truth_t1, flows over (t0, t1])` — it is a **two-endpoint compiler**, unlike the Resolver (one instant) or the Evaluator (one truth). That difference is worth naming, because it determines the artifact's identity: an attribution is identified by a *pair*, not a point.

**Addition — attribution is not Assessment.** "Investments rose $4,955, of which $3,300 was market appreciation" is *observed decomposition*, deterministic and falsifiable. "Your portfolio is over-concentrated" is judgment. Attribution belongs on the Truth side of the Evaluator boundary.

```
Truth(t0), Truth(t1), flows(t0,t1]  →  Attribution Compiler  →  NetWorthAttribution(t0,t1)  →  Evaluator
```

**And this investigation supplies the argument for `BalanceObservation` (V26-F3) that the F-3 document could only assert abstractly.** Today attribution rests on `SpaceSnapshot` — a *derived daily aggregate* that is regenerated, carries a single `isEstimated` bit, and has no per-account detail. §7 is what that costs: a 23-day valuation gap silently became a +$3,305 "investment gain" with no disclosure available, because the snapshot cannot say *which* account was unpriced or *why*.

---

## 13 · Exact first implementation ticket

> **V26-ATTR-1 · Pin the driver invariant and disclose estimated endpoints**
>
> Two defects, both small, both provable. **No schema, no migration, no new aggregation.**
>
> **1. Invariant guard — `lib/wealth/wealth-driver-invariants.test.ts` (new)**
> - For every non-negative composition component (`cash`, `investments`, `crypto`, `real`), assert `driver.delta ≤ asOfState.composition[id]` for any endpoint pair.
> - Assert `drivers` sum to `deltas.netWorth` within rounding, with liabilities signed correctly.
> - Property-style over generated snapshot pairs, plus a fixture pinning the real ALL-window figures (+4,955 / +5,726 / −29,125 / net +39,805).
> - **This test fails on any future change that lets a row exceed its own component balance** — the class of error this investigation was opened to check.
>
> **2. Estimated-endpoint disclosure — `WealthChangeLedger.tsx`**
> - `WealthState.isEstimated` already exists on both endpoints and is already carried in `WealthResult`. Surface it: when either endpoint is estimated, render a disclosure line beside the existing `ATTRIBUTION_NOTE`.
> - Copy must name the mechanism, not hedge generically — e.g. *"Part of this period is estimated; investment values on <date> were reconstructed, not observed."*
> - No new data, no new query — a field already in the result object.
>
> **3. Heading correction (optional, one string)**
> - `"What moved ${METRIC_POSSESSIVE[metric]}?"` → `"What changed since <compare date>?"`. The colocated `wealth-metric-surfaces.test.ts:74-77` pins the current strings and must be updated with it.
>
> **Out of scope:** real attribution (contributions vs appreciation), `InvestmentEvent` integration, `BalanceObservation`, any change to snapshot generation.
>
> **Done when:** suite green with the new guard, `tsc` clean, lint clean, and the 1-month window renders its estimation disclosure.

---

## 14 · Final answer

> **The number is not mathematically wrong — the *calculation* is sound. But "+$6,635" cannot be reproduced from your real data as an Investments row rendered today, and the label it appears under is misleading.**

Three separable conclusions:

**On the calculation — correct.** The driver is `stocks(asOf) − stocks(compareTo)`, a pure balance difference (`wealth-time-machine.ts:264`). It reconciles: components sum to the Net Change total within one unit of rounding. No double counting exists, because there is only ever one quantity — no gain, proceed, or contribution is an input.

**On the specific figure — not reproducible.** Current investments are **4,966**. Because a balance component is non-negative, an Investments row is bounded above by the current balance, so today's maximum is **+4,954** (the ALL window, +4,955 by rounding). Producing +6,635 requires a compare-date balance of **−1,669**. An exhaustive search of all 737 endpoint pairs found **zero** matches within ±8; the nearest values (6,624–6,720) require an as-of in **October–November 2025**, when investments peaked near 7,030 — and at those as-of dates the composition card would have read ≈6,6xx, not 4,968. The exact figure does occur in two **seeded demo Spaces**. I cannot determine from here which Space and dates the screenshot came from, and I have not assumed.

**On the label — misleading, and the code agrees.** "What moved your net worth?" invites a causal, flow reading of a number that is a stock difference. The implementation knows this: it refuses to label rows Market Growth or Contributions, and prints *"Attribution by market growth vs. contributions arrives with historical valuation."* Your question — how can a contribution exceed the balance? — is the right question, and the answer is that it is not a contribution.

**And the investigation surfaced a defect you did not ask about, which is more consequential than the labelling.** Between 2026-06-26 and 2026-07-18 the investments series drops ~3,400 and recovers exactly when the first non-estimated snapshot arrives — a valuation gap, not a sale. The **1-month window therefore reports "Investments +$3,305"**, which is almost entirely that artifact. `isEstimated` is already computed and carried on both endpoints; the ledger simply never reads it. That is the one thing here I would fix first.

**On your recollection:** selling appreciated positions and leaving the proceeds in the brokerage should produce *no* Investments row and *no* net-worth change, because brokerage cash lives inside the investment account balance. Your recollection and a correct system agree. What the data shows in that period is not the signature of a sale.
