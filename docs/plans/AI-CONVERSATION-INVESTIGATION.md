# AI conversation — investigation

**Date:** 2026-09-07 · **HEAD:** `95512bb` (the [AI conversation reset](AI-CONVERSATION-RESET.md))
**Status:** investigation. **No architecture is proposed here, and none should be chosen
from this document alone.** Its job is to say what we must *test* before choosing one.

Everything numeric below was **measured** against Chris' real Space
(`cmrrm846r000j7znwsl67gt1g`) on 2026-09-07 by running the surviving code, not read off
its comments. Where a claim is inferred rather than measured it says so.

Companion: [AI-CONVERSATION-GOLDENS.md](AI-CONVERSATION-GOLDENS.md) — 21 multi-turn
transcripts written *before* this analysis and deliberately not constrained by it.

---

## 1. Product north star

> **ChatGPT that already understands my financial world.**

Not a dashboard with a chatbot bolted on, not a database queried in English, not a
forecasting calculator with conversational syntax, and above all not an audit system that
emits prose. Chris should talk the way he talks to ChatGPT, and follow up in three words.

The previous architecture optimised one question — *how does code stop the model saying an
unsupported number?* — and produced a pipeline of eleven stages whose final safety net was
a deterministic figure dump. That dump was the worst artefact of the dogfood session it was
built to protect.

**The question this investigation asks instead:** what is the *smallest* trust boundary
that buys both financial correctness and conversational intelligence?

### The working hypothesis (to be tested, not assumed)

> **MODEL owns meaning and language. CODE owns financial truth and the calculations that
> must not vary.**

Treat it as a hypothesis. §10 lays out where the line plausibly falls and §12 designs the
experiment that would move it.

---

## 2. What survived the reset

The reset deleted the conversation layer and preserved the financial one. Concretely, what
is on disk today under the AI namespace:

| Module | LOC | What it is |
|---|---|---|
| `lib/ai/types.ts` | 1,356 | The domain payload contracts. **The most important artefact in the repo for this work.** |
| `lib/ai/assemblers/transactions.ts` | 2,021 | Windowed transaction aggregation — the richest surface. |
| `lib/ai/assemblers/accounts.ts` | 845 | Accounts, balances, freshness, liability semantics, debt metadata. |
| `lib/ai/assemblers/snapshot.ts` | 241 | Daily net-worth history (capped at 90 rows). |
| `lib/ai/assemblers/holdings*.ts` | 430 | Positions + concentration. **Materially broken on this Space — see §7.** |
| `lib/ai/context-builder.ts` | 319 | `buildContext` — membership guard, domain resolution, parallel assembly, signals, audit. |
| `lib/ai/intelligence/**` | 2,065 | `computeAssessment` — 11 graded sections, risks, opportunities, priorities. |
| `lib/ai/coverage-envelope.ts` | 348 | What evidence *exists*, as distinct from what was loaded. |
| `lib/ai/domain-relevance.ts` | 187 | Which domains a Space can supply and this question needs. |
| `lib/ai/economic-concepts.ts` | 352 | `composeInvestments` — the double-count rule. |
| `lib/ai/temporal-scope.ts` | 583 | Requested / selected / coverage / satisfied window authorities. |
| `lib/ai/bounded-selection.ts` | 103 | A ranked list carries its denominator. |
| `lib/ai/signals/**` | 349 | Deterministic signal detectors. |
| `lib/ai/forecast/{assemble,streams,pay-dates}.ts` | 834 | Deterministic forecast adapter, now taking **typed** inputs. |
| `lib/forecast/**` | 5,621 | The cash engine and its ten authorities. Pure, no DB, no clock, no model. |
| `lib/ai/provider.ts` | 174 | The only OpenAI import site. Currently **reader-less**. |

Plus, outside the AI namespace and **never wired to it**:

- **`lib/data/transaction-query.ts`** — `queryTransactions`, the canonical keyset read.
- **`lib/history/**`** — a 9-root × 5-level historical explanation tree.
- **`lib/investments/**`** — 40+ modules: current positions, historical holdings,
  corporate actions, concentration, event coverage.
- **`lib/snapshots/**`, `lib/wealth/**`, `lib/perspectives/**`, `lib/liquidity/**`,
  `lib/debt/**`.**

---

## 3. Financial capability map — measured

### 3.1 The Space

| | |
|---|---|
| Account links | 13 (4 cash · 2 debt · 3 investment · 4 crypto) |
| Transactions | **4,382**, 2023-03-18 → 2026-09-06 |
| Daily snapshots | **770**, 2024-07-21 → 2026-09-07 |
| Position observations | 6,499 · Price observations 9,739 |
| Chains with claimed history | BTC (2023-03-18→), ETH (2021-04-27→), SOL (2022-03-26→) |
| Net worth | $36,340.24 · cash $12,382.81 · BTC $18,977.04 · brokerage $5,005.85 |
| Liabilities | **$25.46** (one card at $25.46, one at **−$15.35** — issuer owes Chris) |
| Payroll | Vectrus, **biweekly**, $5,286.64/check |

### 3.2 What `buildContext` produces, measured

Broad question, `scopeHint: 'full'`:

| Domain | Latency | Bytes | ~tokens | Share |
|---|---|---|---|---|
| `accounts` | 93 ms | 14,073 | 3,519 | 26% |
| `transactions_summary` | 137 ms | 14,801 | 3,701 | 28% |
| `snapshot_history` | 30 ms | 22,580 | 5,645 | **42%** |
| `holdings_summary` | 119 ms | 1,343 | 336 | *(excluded — see §5)* |
| **Full context** | **~260 ms** | **53,781** | **13,446** | |
| `computeAssessment` on top | <5 ms | 5,936 | 1,484 | |

**~15,000 tokens** of structured JSON for one broad question, assembled in about a quarter
of a second. That is *cheap* on a modern model and *not* the constraint people assume.

### 3.3 Windowed retrieval, measured

The transactions assembler already takes an arbitrary window (clamped at 800 days) and is
fast:

| Window | Latency | ~tokens | Rows | Truncated |
|---|---|---|---|---|
| Aug 2026 only | 58 ms | 2,601 | 173 | no |
| 2025 full year | 105 ms | 9,047 | 2,251 | no |
| Trailing 24 months | 173 ms | 14,332 | 4,014 | no |
| Transaction drilldown (ranked rows) | 27 ms | — | 10 | no |

`largestExpense` resolves correctly per window: Aug → Shein $680.24; 2025 → AMEXTRAVEL
$2,611.49; 24 mo → Hair Of Stanbul Tour $6,050. **"What was my biggest purchase last
month?" is a solved problem today** — it needs a window, not an abstraction.

### 3.4 The deterministic forecast, measured

`loadForecastIncomeStreams` (47 ms) resolves **5 streams** with cadence and activity:

| Stream | Cadence | Activity | Eligible | Amount |
|---|---|---|---|---|
| Vectrus Systems Payroll | **BIWEEKLY** | CURRENT | ✅ | $5,286.64 |
| Abacus Technolog Payroll | SEMIMONTHLY | **SILENT** | ❌ | $5,015.68 |
| Interest Deposit | MONTHLY | CURRENT | ✅ | $0.21 |
| Interest Payment ×2 | MONTHLY | CURRENT | ✅ | null |

**This is the only place payroll cadence exists, and `buildContext` does not include it.**

Running `assembleForecast` for "by end of November" three ways:

| Statements supplied | Licensed ending cash | Evidence projection |
|---|---|---|
| none | **REFUSED** | $32,099.85 |
| + spending fact $4,500/mo | **REFUSED** | $31,684.13 |
| + spending fact + NET basis on one stream | **REFUSED** | $31,684.13 |

The licensed path refuses because it requires a NET/GROSS basis on **every** income event
plus a spending baseline. On this Space that is six separate user assertions. Its refusal
prose is **681 tokens** and contains the line:

> *"NOT counted as cash: … These total USD 31720.47 STATED, which is NOT spendable cash and
> may NOT be added to the balance or described as money arriving."*

That paragraph is the dogfood figure dump in its natural habitat.

**Only `PROJECTION-1` — the evidence-based path — actually answers.** It produced
$32,099.85 from a measured spending rate of $142.90/day over two complete months. That is
the family of answer the goldens want, and it is already computed and already correct.

---

## 4. Conversation-family capability matrix

Legend — **Model**: is a capable model sufficient after retrieval? **New calc**: is new
deterministic computation genuinely required?

| Family | Required evidence | Surviving source | Deterministic calc? | Historical depth | Current authority | Known limitations | Missing capability | Model sufficient? | New calc needed? |
|---|---|---|---|---|---|---|---|---|---|
| **Broad assessment** | balances, spend, income, net worth, trend | `buildContext` (3 domains) + `computeAssessment` | ✅ full | 90 d default | accounts domain | investments **excluded** by `resolveDomains`; assessment is materiality-blind | materiality; investments in scope | ✅ **from facts**, ❌ from the assessment | ❌ — remove opinion, don't add |
| **Projection** | opening cash, income cadence, spending rate | `assembleForecast` + `PROJECTION-1` | ✅ correct | needs 2+ complete months | forecast engine | licensed path **refuses** on real data; only projection answers | a projection reachable without 6 assertions | ⚠️ arithmetic must stay in code | ❌ — it exists; it needs a caller |
| **Projection follow-up** | the previous answer + its inputs | *(none)* | n/a | n/a | n/a | nothing carries the last answer | **answer memory** | ✅ if the prior turn's structured result is in history | ❌ |
| **Spending / cash flow** | categories, merchants, monthly rollups, drilldown | transactions assembler | ✅ full | any window ≤800 d | assembler | "Other" = 27% of spend; card payments framed as debt | category quality | ✅ | ❌ |
| **Income** | per-month paycheck **count and dates** | `loadForecastIncomeStreams` **only** | ✅ cadence | 730 d | streams | **cadence is not in `buildContext`**; `monthlyBreakdown.byCategory` omits Income entirely | cadence in evidence | ⚠️ inferable, not stated | ❌ — wire, don't build |
| **Investments** | positions, values, crypto, concentration | `holdings_summary` (scope now stated) + accounts totals + `lib/investments` | ⚠️ partial | `lib/investments` has full history | accounts domain | on this Space only 4 of 13 positions can be priced, so the position view is a tiny subset — now declared as one | one composed investment view | ⚠️ needs the composition beside it | ⚠️ compose, don't compute |
| **Debt** | balances, APR, minimums, interest | accounts domain + `computeAssessment` | ✅ | 90 d | accounts | **$25.46 hijacks 6 assessment outputs** | **materiality** | ✅ from facts | ❌ |
| **Affordability** | cash, income, spending, obligations, goals | all of the above | ⚠️ arithmetic only | — | accounts | no single judgment surface | judgment (correctly a model job) | ✅ | ❌ |
| **Change explanation** | net-worth deltas by component | `lib/history/**` — **zero AI consumers** | ✅ **excellent** | 1,100 snapshot rows | exploration tree | never wired to AI; context has 90 d | wiring | ✅ over the tree | ❌ |
| **Comparison** | arbitrary historical windows | assembler (txns) + `getRecentSnapshots` | ✅ | txns 800 d; snapshots 90 in context / **1,100 available** | both | snapshot depth in context is 90 rows of 770 | deeper NW history | ✅ | ❌ |
| **Strategy** | everything, prioritised | context + assessment | ⚠️ | — | — | assessment's priorities are threshold-driven, not material | judgment | ✅ | ❌ |
| **Transaction drilldown** | ranked rows with merchant + account | assembler `drilldown` + `queryTransactions` | ✅ | any window | read authority | 25-row cap per drilldown | — | ✅ | ❌ |
| **Follow-up explanation** | the prior answer's derivation | *(none)* | n/a | n/a | n/a | — | **answer memory** | ✅ if carried | ❌ |
| **User scenario** | assumption stack, ±% on holdings | `ForecastPolicy` (typed) | ✅ cash; ❌ market | — | forecast engine | no `UserStatement` producer; no investment scenario arithmetic | assumption capture; market scenario | ⚠️ arithmetic in code | ⚠️ **one small piece** |
| **Correction** | typed statement + durability | `UserStatement` type exists, unproduced | ✅ routing | — | `routeStatement` | nothing produces a `UserStatement` | statement capture | ✅ model can emit the typed struct | ❌ |

### Rough share supportable today

Counting a family as *supportable* when the evidence exists and reaching it is wiring
rather than construction:

- **Fully supportable now (7/14, 50%):** spending, transaction drilldown, comparison,
  affordability, strategy, debt *(facts only)*, broad assessment *(facts only)*.
- **Supportable after wiring existing code (4/14, 29%):** income cadence, change
  explanation, projection, correction.
- **Genuinely missing (3/14, 21%):** investments-as-one-concept, answer memory, market
  scenario arithmetic.

**≈ 79% of the desired conversation families are reachable from evidence that already
exists.** The gap is overwhelmingly *composition and wiring*, not *computation*.

---

## 5. Existing context quality

### What is good — and it is better than expected

- **Provenance is everywhere and it is honest.** Every account carries
  `balanceFreshness{basis,band,ageDays,providerClockUnknown}`, `availableQuantity` (which
  *names* whether a number is available cash, settled cash or an unused credit line —
  worth $32,460 of misreading on one card), and `currentState` reconciling observed vs
  pending vs reachable with a plain-English `explanation`.
- **Liability sign convention is pre-resolved** into `amountOwed` / `creditBalance` /
  `liabilityState`, so a model can never narrate "you have −$124 in debt".
- **Bounded lists carry denominators** (`BoundedSelection<T>` — 102 merchants, 25
  returned), so superlatives can be qualified honestly.
- **Currency is resolved per figure**, with `reportingBalance: null` where conversion is
  unavailable rather than a fake zero.
- **Refusals are structural**: `ungraded[]`, `dataLimits[]`, `unavailableReason`.
- **Transfers are separated from spending** — `transferTotal`, `debtPaymentTotal`,
  `refundTotal`, `netCashFlow`, all distinct.

### What is wrong — measured, not suspected

**(a) `resolveDomains` excludes investments from broad questions.** Measured on both
*"how am I looking financially?"* and *"what was my biggest purchase last month?"*:

```
holdings_summary : false : NOT_RELEVANT
```

On a Space that is **66% crypto by net worth**. The category manifest for `PERSONAL` is
`[accounts, transactions_summary, snapshot_history]`, and the question-relevance expansion
did not fire for a plainly broad question. Family F is unreachable and family A is
answering with a third of the picture missing.

**(b) The holdings assembler exposes a narrow statistic with no statement of its
scope.**

> **⚠️ CORRECTED 2026-09-07 (post-fix).** The first version of this section said the
> assembler was "materially wrong" and "would tell Chris his portfolio is concentrated in
> Take-Two Interactive". **The arithmetic was never wrong.** Every figure below is correct
> *about its own population*; what was missing was any statement of what that population
> was. The precise finding is recorded after the payload. The defect was **semantic
> scope**, and it is fixed — see "the correction", below.

```
totalPortfolioValue   $4,040.60      (accounts domain says $5,005.85 + $18,977.04)
positionCount          2
analyzedInvestedValue  $11.62
concentration          HIGHLY_CONCENTRATED, topSymbol TTWO, topWeight 75%
dataLimits             "9 position(s) could not be valued and are excluded"
```

**The precise finding.** `analyzedInvestedValue` is the concentration denominator, and it
was **$11.62** — the only two positions the canonical valuation seam could price. The
canonical account composition (`composeInvestments`) reads **$23,982.89**, of which
$18,977.04 is Bitcoin. So the statistic described **0.05% of the money** and said so
nowhere.

The root cause is upstream of the assembler and is not an assembler bug: on this Space
`getInvestmentValueAsOf` reports `completeness: incomplete` with *"9 of 13 holdings could
not be valued for 2026-09-07"* — every crypto position and six equities returned **"No
RAW_CLOSE price within 7 days"**. The assembler then **discarded that completeness verdict**
and re-derived a weaker prose note from the FULL-visibility rows alone.

`totalPortfolioValue` compounded it: the name asserts portfolio scope for a number that is
the *priced subtotal*.

So the honest statement of the defect is:

> the holdings assembler exposed a ~75% concentration over a narrow valued-stock population
> without sufficient scope for a downstream consumer to distinguish it from portfolio-level
> concentration.

**The correction** (commit `fix(ai-data): preserve investment concentration scope`) is
semantic, not arithmetic:

- `concentration.population` — the denominator, the counts, the exclusions and
  `shareOfValuedTotal`, **inside** the concentration object so a serializer cannot emit the
  classification without it;
- `unvaluedPositions[]` — the excluded positions as data (symbol, asset class, quantity and
  the seam's own reason), so "every crypto holding is missing here" is visible rather than a
  count in a sentence;
- `valuationCompleteness` — the canonical seam's tier, sentence and counts, carried verbatim
  instead of re-derived;
- `totalPortfolioValue` → **`valuedPositionsTotal`**, `investedValue` →
  **`valuedNonCashTotal`**, `cashValue` → **`valuedCashTotal`** — three names that asserted
  a scope they did not have.

`computeConcentration` itself is untouched: it is the shared authority the Investments
Allocation panel runs, and it answers exactly the question it is asked.

**(c) Payroll cadence is absent from the context, and so is any per-month income count.**
Measured: `monthlyBreakdown[].byCategory` contains **no Income entry at all** for any of the
four months. The window-level `byCategory` has `Income: count 7`. So the context states
*income fell 33%* and contains nothing from which "July had three paychecks" can be read
directly.

The ground truth, from the ledger:

| 2026 | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug |
|---|---|---|---|---|---|---|---|---|
| Vectrus checks | **3** | 2 | **3** | 2 | 2 | 2 | **3** | 2 |
| Total | $17,903 | $11,399 | $11,555 | $10,632 | $10,534 | $11,562 | **$15,860** | $10,554 |

*Partially inferable:* `recurringCandidates` shows `vectrus…, occurrences: 6,
typicalAmount: 5448.08` over a 90-day window, and $15,860 ÷ $5,448 ≈ 2.9. A capable model
could get there. **Whether it does is the single best test of the model-first hypothesis**
(§12, probe C).

**(d) Card payments are framed as debt burden.** Measured over the same 90 days:

```
debtPaymentTotal              $23,953.92
totalLiabilities                  $25.46
estimatedMonthlyDebtPayments   $7,984.64
deficitCause                  DEBT_DRIVEN
```

Chris pays his cards in full; the card purchases are already in `expenseTotal`. The
arithmetic is right (`netCashFlow` does not double-count) and the *framing* is what
produced "estimated monthly debt payments $8,451.69" in the dogfood dump. The exact fold
deserves its own look before anyone claims a defect.

**(e) Net-worth history is capped at 90 rows.** `SNAPSHOT_HISTORY_LIMIT = 90`, so the
context shows `spanDays: 98` while **770** daily snapshots exist. `lib/history/exploration`
reads `WINDOW_ROWS = 1100` from the same authority. "What was my net worth last year" is
unanswerable from context and trivially answerable from the store.

**(f) Snapshot history is 42% of the context** — 23,433 bytes for 90 points × 8 numbers.
The most compressible thing in the payload by a wide margin.

### Answering the specific questions asked

| Question | Answer |
|---|---|
| Is it structured? | Yes — typed JSON, no prose. |
| Is it redundant? | Mildly. Net worth appears in `accounts` and in every snapshot point. |
| Enough temporal evidence? | Transactions yes (any window ≤800 d). Net worth **no** (90 d). |
| Enough transaction detail? | Yes on demand (drilldown, 25 rows) — not by default, correctly. |
| Investment holdings? | **Present but wrong**, and excluded from broad questions anyway. |
| Current vs historical clear? | Yes — `latest` vs `history`, `requestedAt`, freshness bands. |
| Transfers vs spending? | Yes structurally; **framed misleadingly** for card payoffs. |
| Payroll cadence? | **No.** |
| Account type? | Yes, plus subtype, institution, mask, visibility. |
| Liabilities correct? | Yes — sign, credit balances and semantics all pre-resolved. |
| **"$11 debt is immaterial" without special rules?** | **Yes, from the facts** — `totalLiabilities: 25.46` sits beside the gaps. **No, from the assessment**, which pre-judges it as three warnings. |
| **Three-paycheck month?** | Not from stated evidence. Inferable from `recurringCandidates`. **Test it.** |
| **"Biggest purchase?"** | **Yes, today**, with a window. |
| **Explain a net-worth movement?** | Coarsely from context; **excellently** from `lib/history`, which the AI has never touched. |
| **Affordability?** | Yes — every input is present. |

---

## 6. Existing deterministic calculation capabilities

| Capability | Where | Quality |
|---|---|---|
| Net worth, assets, liabilities, liquid, investments, digital | accounts assembler + snapshots | ✅ canonical, currency-resolved |
| Spending/income/refund/transfer/debt-payment folds | transactions assembler | ✅ single fold authority |
| Category, merchant, income-source rollups | transactions assembler | ✅ bounded with denominators |
| Monthly breakdown, partial/estimated flags | transactions assembler | ✅ |
| `largestExpense` / `largestIncome` | transactions assembler | ✅ per window |
| Transaction drilldown | assembler + `queryTransactions` | ✅ 12 filter dimensions, keyset |
| Cash projection | `lib/forecast/engine` + `PROJECTION-1` | ✅ correct; ⚠️ licensed path unreachable |
| Pay-date generation | `expectedOccurrencesBetween` | ✅ licence-gated |
| Cadence / activity derivation | `lib/forecast/{cadence,stream-activity}` | ✅ **the cadence answer** |
| Spending baseline, observed rate | `lib/forecast/{spending-baseline,observed-spending}` | ✅ |
| Assumption routing (fact vs supposition) | `routeStatement` | ✅ typed, no producer |
| Net-worth attribution by component | `lib/history/**` | ✅ 9 roots × 5 levels, `explainedAssets/Liabilities` |
| Historical positions, corporate actions | `lib/investments/**` | ✅ deep, unused by AI |
| Debt strategy (avalanche/snowball, weighted APR) | `computeAssessment` | ⚠️ blocked by null APR |
| Liquidity coverage months | `computeAssessment` | ✅ |
| **Investment scenario arithmetic (±% → net worth)** | **nowhere** | ❌ |

---

## 7. Missing financial capabilities

Ranked by how much conversation they block.

1. **Investments as one concept.** `composeInvestments` exists and is the *right* authority
   (it prevents a 79% double-count), but nothing composes crypto + brokerage + positions
   into an answerable view, and `holdings_summary` actively misleads. Blocks family F and
   degrades A, B, L.
2. **Materiality.** Not a missing calculation — a missing *absence*. `computeAssessment`
   fires on `totalLiabilities > 0` with no floor.
3. **Payroll cadence in evidence.** Exists in `loadForecastIncomeStreams`; not in context.
4. **Answer memory.** Nothing carries the previous answer or its inputs. Blocks family C
   entirely — and family C is where the dogfood session died.
5. **A projection that answers.** The engine computes it. Nothing calls it and the licensed
   path refuses.
6. **Net-worth history beyond 90 days.** A constant, not a capability.
7. **Investment scenario arithmetic.** "What if Bitcoin does 10%" — genuinely absent.
   The smallest real *new* calculation on this list.
8. **Assumption capture.** `UserStatement` is typed and routed; nothing produces one.
9. **Category correction write-back.** Golden 21. A data-layer action, out of scope now.

---

## 8. Retrieval options and tradeoffs

| | Approach | Cost per turn | Broad Qs | Narrow Qs | Follow-ups | Brittleness | Verdict |
|---|---|---|---|---|---|---|---|
| **A** | Broad context always | ~13.4k tok, ~260 ms | ✅ | ✅ wasteful | ✅ trivially | **none** | **Strong baseline.** Cheaper than assumed. |
| **B** | Model selects evidence (2-pass) | 2 model calls | ✅ | ✅ | ⚠️ | low | Latency cost for little gain over A. |
| **C** | Deterministic domain retrieval | ~260 ms | ❌ measured broken | ⚠️ | ❌ | **high — this is the classifier** | **Reject.** It is `resolveDomains`, which already fails. |
| **D** | Tool-calling model | 1–4 calls, 30–200 ms each | ✅ | ✅ minimal | ✅ **natively** | low | **Most promising.** |
| **E** | Hybrid: small always-on core + tools | ~3–4k tok + tools | ✅ | ✅ | ✅ | low | **Best candidate.** |

### Why D/E look right, and it is a repository fact rather than a preference

The surviving code is *already shaped like tools*: every retrieval surface takes explicit
parameters, is fast, is bounded, and enforces visibility internally.

| Tool | Backed by | Latency | Bounded by |
|---|---|---|---|
| `financial_snapshot()` | accounts assembler | 93 ms | 13 accounts |
| `spending(from, to)` | transactions assembler | 58–173 ms | 800 d, 5,000 rows |
| `transactions(filters…)` | `queryTransactions` | fast | 100/page, keyset |
| `net_worth_history(from, to)` | `getRecentSnapshots` | 30 ms | 1,100 rows |
| `explain_change(lens, date)` | `resolveExplorationNode` | — | 9 roots × 5 levels |
| `income_streams()` | `loadForecastIncomeStreams` | 47 ms | 100-row page |
| `project_cash(to, assumptions)` | `assembleForecast` | <10 ms | horizon |
| `pay_dates(ask, window)` | `resolvePayDates` | <10 ms | occurrence cap |

**Eight tools, all existing, none new.** The only genuinely new one is
`investment_scenario(deltas)`.

**Blocker:** `lib/ai/provider.ts` exposes `generateChatReply` and `generateStructured` and
**no tool/function-calling path**. `openai@6.45.0` supports it. Adding `tools` to the
provider seam is additive plumbing at the sanctioned boundary — but it is a real
prerequisite, and it is the *only* code change the experiment needs.

### On the retrieval fear

*"Do not put the entire financial world into every prompt"* is right in principle and, at
this scale, currently costs 13.4k tokens for a full picture — under 10% of a 200k window
and about 3¢ on a frontier model. **The argument for E is conversation quality (a narrow
question should not drag investment history along), not token budget.** Do not let a cost
model we have not measured drive the architecture.

---

## 9. Conversation-state options and tradeoffs

The sequence to support:

```
"what will I have by November"  →  "assume I spend 6k"  →  "February?"
  →  "what if bitcoin does 10%"  →  "forget the bitcoin"  →  "what's realistic"
```

| | Option | What it stores | Risk |
|---|---|---|---|
| **1** | **Nothing.** Raw history only. | — | Model must re-derive assumptions from prose each turn. Cheap to test. |
| **2** | **History + prior tool results.** Each turn's structured tool output stays in the transcript. | Nothing new | **Answer memory falls out for free.** "Break it down" sees the object that produced the number. |
| **3** | Option 2 + an explicit assumption list the model reads and rewrites. | `UserStatement[]` | Small. Uses the *existing* typed vocabulary. |
| **4** | A scenario/turn lifecycle with enums. | A state machine | **This is what was deleted.** Do not. |

**Test 2 first.** It is the null hypothesis and it costs nothing to try: keep the tool call
*and its JSON result* in the message list, and see whether a strong model handles the
six-turn assumption sequence without help. If it drifts, escalate to 3 — and 3 is not new
architecture, it is `UserStatement[]` from `lib/forecast/policy.ts`, which
`assembleForecast` already consumes.

**"What's realistic"** is the discriminating turn: it requires distinguishing *the user's
suppositions* from *the evidence*. Under option 2 that distinction lives only in prose;
under option 3 it is `mode: ASSERTS_FACT` vs `REQUESTS_ASSUMPTION`. **This one turn should
decide 2-vs-3, empirically.**

---

## 10. Model/tool boundary options

### Certainly code

Money arithmetic that must not vary between two identical questions:

net worth · balance sums · currency conversion · category and merchant totals · monthly
rollups · cash projection · pay-date generation · cadence derivation · spending baselines ·
interest · net-worth attribution · **visibility** (a security boundary, never a model's
judgment).

### Certainly model

Judgments over deterministic evidence, none of which has a defensible threshold:

- "Is $25 of debt important?" — *the assessment's answer today is three warnings.*
- "July looks higher because there were three paychecks."
- "Most of your portfolio is Bitcoin."
- "That vacation is affordable but slows your savings target."
- "This month looks unusual."
- What to lead with. What to leave out. How long the answer should be.

### The contested middle — and the finding that matters most

**`computeAssessment` is the contested layer, and the evidence says it is a liability in a
conversational product.** Measured on this Space, from **$25.46**:

| Output | Value |
|---|---|
| `debt.classification` | `INSUFFICIENT_DATA` |
| risk | `APR_MISSING_FOR_DEBT` (warning) |
| risk | `DEBT_PAYOFF_BLOCKED_BY_DATA` (warning) |
| opportunity | `IMPROVE_DATA_QUALITY` — "enter missing debt APRs" |
| `capitalAllocation.blockers` | "APR missing … comparison blocked" |
| `investmentReadiness.blockers` | "APR missing … full carry cost unknown" |
| `advisorHeuristics` | `APR_REQUIRED_FOR_PRECISE_PAYOFF` |
| `ungraded` | `debt / APR_MISSING` |

**Seven outputs from twenty-five dollars.** And separately, `trajectory: WORSENING` and
`income FALLING −33.42%` from **two complete months**, one of which had three paychecks.

The assessment is not wrong — every rule is defensible. It is **materiality-blind and
sample-size-blind**, and it is *pre-committed opinion*. Handed to a model it does not
inform the judgment, it **argues with it**: the model reads "APR_MISSING_FOR_DEBT: warning"
and reasonably surfaces it.

> **The sharpest hypothesis this investigation produces:**
> the conversational product may be **better** if the model is given the deterministic
> **facts** (`totalLiabilities: 25.46`, `apr: null`, `liquidCashTotal: 12382.81`) and
> **not** the deterministic **verdicts** — and `computeAssessment` stays where it belongs,
> serving the Daily Brief.

That is testable in one A/B (§12, probe A). It is the highest-value comparison available.

**Note it is not a proposal to delete anything.** `computeAssessment` has non-chat
consumers and its sections are useful *inputs*. The question is whether its *grades* should
reach a conversation.

---

## 11. Memory extension considerations

Do not build. Do keep the seams open.

**The invariant:** *financial data is authority for what happened; memory is authority for
what Chris said and intends.* Memory must never become a balance. A remembered "I have
about $15K" must lose to the ledger's $12,382.81, always.

Worth remembering eventually: goals and targets ("25k by November" — live across turns in
golden 6), spending intentions, planned purchases, standing corrections ("Lulu is
groceries", "Microsoft is reimbursed"), stated payroll facts, prior forecast checkpoints
(so "you said $36K last month" is checkable).

**Extension requirements that today's design must not block:**

1. **Corrections must be captured as typed statements, not absorbed into prose.**
   `UserStatement{mode, subject, statedAs, asOfISO}` already exists and is exactly the
   right shape — durable or not is then one field, not a redesign.
2. **Every remembered item must carry provenance and a timestamp**, so a stale intention
   can be aged out or re-confirmed.
3. **Durability must be an explicit product moment**, not an inference. Goldens 10 and 21
   both have 4M *ask* — "keep excluding those, or just this conversation?".
4. **Retrieval must be able to accept a memory block as a separate, clearly-labelled
   evidence source**, so a model can never confuse testimony with measurement.
5. **No schema decisions now.** `AiAgent` exists per Space; there is no
   `Conversation`/`ChatMessage` model and none is needed to test any of this.

---

## 12. Model-first baseline experiment design

**Goal:** find how much architecture is actually necessary, by starting with none.

**Not production. Not in `app/`. A script under `scripts/`, model calls behind the existing
provider seam, no route changes, no schema.**

### The harness

```
for each golden conversation × each arm × each model tier:
    replay turns; capture reply, tool calls, latency, tokens, cost
```

Inputs per turn: **(1)** conversation history, **(2)** evidence, **(3)** tools where the arm
allows, **(4)** a **short** behavioural instruction — a few hundred tokens: *be concise, you
are talking to the person whose money this is, never state a figure you were not given,
say when you do not know, match the depth of the question.*

Explicitly **not present in any arm**: intent classifier, MeasureId, LicensedFigure, prose
scanner, claim schema, verifier, repair loop, deterministic fallback, doctrine.

### The arms

| Arm | Evidence | Tools | Tests |
|---|---|---|---|
| **A0** | full `buildContext` **+ `computeAssessment`** | none | the closest thing to "what we had, minus the machinery" |
| **A1** | full `buildContext`, **assessment withheld** | none | **§10's central hypothesis** |
| **A2** | thin core (~3–4k tok: totals, latest snapshot, 90-day rollup, streams) | 8 tools | the hybrid |
| **A3** | nothing pre-loaded | 8 tools | pure tool-calling |

A0-vs-A1 answers *does the assessment help or hurt?* A1-vs-A2/A3 answers *is retrieval
worth building?*

### Probes — the ones that discriminate

| # | Probe | Passes when |
|---|---|---|
| **A** | *"how's my debt"* / *"anything I should worry about"* | $25.46 is mentioned and dismissed, or omitted. **Fails** if APR-missing is surfaced as a concern. |
| **B** | *"how am I looking"* | Bitcoin is in the answer. Currently `resolveDomains` excludes it. |
| **C** | *"did my income go down?"* | Three-vs-two paychecks identified **unprompted**. The single best test of model-over-rules. |
| **D** | *"$36K by November" → "break it down"* | Explains **that** figure. **Fails** on a figure dump. This is the reset's founding failure. |
| **E** | 6-turn assumption sequence (golden 2) | Assumptions carry, retract individually, and "realistic" drops the user's. |
| **F** | *"what am I invested in"* | Bitcoin dominates the composition; any narrow position statistic is qualified by its population. **Fails** if a within-subset concentration is restated as portfolio concentration. |
| **G** | *"lose the bullet points, just talk to me regular"* | Prose. It returned a 502 in the dogfood. |
| **H** | *"am I spending more?"* | Sample size stated before the verdict. |
| **I** | *"what's bitcoin going to do"* | Declines once, briefly, offers scenarios. |
| **J** | *"what was my biggest purchase last month"* | Shein $680.24, Aug 26. Exactness check. |

### Scoring — deliberately human first

**Chris reads them.** Per turn: *would I have sent this?* Automate only two things, because
both are objective: **(i)** every figure traces to supplied evidence; **(ii)** answer length.
**Do not build a scorer before we have transcripts** — the last architecture's scorers were
wrong before the model twice as often, and later ten times.

### Model tiers

`AI_CHAT_MODEL` already parameterises the model, and `generateStructured` takes a `model`
override — so tiers cost no new plumbing. Both prior tier decisions
(FORECAST-11: *no*; V26-REASONING: *yes*) were conditional on architectures that no longer
exist and **neither transfers**.

Compare, same conversations, same evidence, cost and p50 latency recorded:

1. **`gpt-4o-mini`** — the surviving default. The floor, and the control.
2. **`gpt-4.1`** — measured better under structure; the mid tier.
3. **A frontier tier** (`gpt-5`-class or `claude-opus`-class) — the ceiling. **The most
   important arm:** if the frontier tier with no architecture beats mini with a lot of it,
   that settles the programme's direction.
4. **A non-OpenAI frontier model**, if adding one to the provider seam is cheap — the seam
   was built for exactly this and has never been exercised.

Treat quality/latency/cost as an **empirical product decision**. Do not change production.

### The smallest prototype

1. Add `tools` support to `lib/ai/provider.ts` *(the only code change; additive)*.
2. `scripts/ai-baseline.ts` — replay goldens × arms × tiers, dump transcripts to disk.
3. Thin tool adapters over the eight existing surfaces, in the script, not in `lib/`.
4. Fix nothing else first. Let the probes tell us which gaps actually bite.

**~1–2 days.** Everything it needs already exists.

---

## 13. Risks

| # | Risk | Why it is real here | Mitigation |
|---|---|---|---|
| 1 | **Rebuilding the last architecture by accident.** | Every stage was added for a good reason. So will the next eleven be. | No new abstraction without a transcript showing the failure it fixes. |
| 2 | **The assessment quietly becomes the doctrine.** | It is deterministic, it survived, and it already emits verdicts. | A1 arm. Measure it as a *hypothesis*, not a foundation. |
| 3 | **A correctly-computed number is read at the wrong scope.** | A ~75% concentration over $11.62 of priced positions could be restated as portfolio concentration. **Fixed** by attaching the population to the statistic. | Scope the evidence; never add a guard that scans prose for it. |
| 4 | **Over-fitting to one Space.** | Every measurement here is Chris' Space. Jane's has 151 transactions; the seeded Spaces have zero snapshots. | Run at least one probe against a thin Space. |
| 5 | **The model invents a figure.** | The failure the last architecture existed for. | Test whether it *actually happens* with good evidence and a strong model **before** building anything to prevent it. Probe (i) measures it. |
| 6 | **Latency.** | Tool-calling multiplies round trips; 4 calls × 2 s ≈ 8 s. | Measure it in the experiment. Streaming is not built. |
| 7 | **Cost, unmeasurable per turn.** | `ApiUsageCounter` has no `userId`/`spaceId`. | Measure in the harness, where the numbers are attributable. |
| 8 | **Truncation invisibility.** | All 5 forecast streams return `truncated: true` (100-row page cap). | Surface it in evidence; do not silence it. |
| 9 | **Chris's judgment is the scorer, and it does not scale.** | Deliberate, for now. | Keep transcripts; derive automated checks *from* them later. |
| 10 | **The privacy predicate must not become a model decision.** | `TRANSACTION_DETAIL_VISIBILITY` has 12 non-AI consumers. | Tools enforce visibility internally. A tool may not take a "show hidden" flag. |

---

## 14. Questions only a prototype can answer

Architecture debate cannot settle any of these. Each maps to a probe.

1. **Does a strong model, given facts and no verdicts, judge materiality correctly?** (A)
   *If yes, most of the "advisor rules" layer is unnecessary — that is the largest possible
   simplification available to this product.*
2. **Does it infer payroll cadence from `occurrences: 6` + `typicalAmount` + monthly
   totals — unprompted?** (C) *If yes, an entire class of "reason before concluding" rules
   collapses into good evidence.*
3. **Does `computeAssessment` help or hurt a conversation?** (A0 vs A1)
4. **Is ordinary history + prior tool results enough for a 6-turn assumption sequence?** (E)
   *If yes, conversation state is not a thing we build.*
5. **Does the model invent numbers when the evidence is good?** How often, and how badly?
6. **Does "break it down" work without an explicit answer-memory mechanism?** (D)
7. **Does tool-calling feel better than broad context, or just cost more latency?** (A1 vs A3)
8. **How much does model tier actually buy?** Is mini disqualifying, or merely worse?
9. **Can the model write a conversational answer at all, or does structured evidence pull
   it toward bullets?** (G) *The dogfood's terminal failure was a formatting request.*
10. **What breaks on a thin Space?** (Jane's: 151 transactions.)
11. **What does Chris actually want when he asks "what would you do?"** Nobody knows.
12. **How long should answers be?** Measure what he keeps reading.

---

## 15. Recommended next experiment

> **Build the model-first baseline harness and run the ten probes across four arms and
> three model tiers. Change no production code except adding tool support to the provider
> seam. Have Chris read the transcripts.**

**Why this and nothing else first.** Every alternative starting point — fix holdings, add
materiality thresholds, wire cadence into context, design retrieval — presumes an answer to
a question we can cheaply measure instead. If the frontier tier with a good evidence pack
already dismisses $25 of debt, infers the three-paycheck month and explains its own $36K
answer, then most of the "missing capability" list in §7 is **composition work**, and the
architecture is: *tools + a short instruction*. If it does not, we will know precisely which
of the ten probes failed and can design against a transcript instead of a fear.

**Deliverable:** a directory of transcripts, one per (conversation × arm × tier), with
per-turn latency, tokens and cost — and Chris's read.

**Explicitly out of scope until those transcripts exist:** any route change, any prompt
committed to `lib/`, any planner, any schema, any new abstraction, and any fix to the
defects catalogued above. **Except one, which was fixed before the experiment because it
could let a correct number be read at the wrong scope:** the holdings concentration
statistic now carries its population (§5b).

---

## Appendix — what was inspected

**Run against the live local database** (read-only; no writes, no `buildContext` audit
rows): `buildContext`'s three assemblers, `holdings_summary`, `computeAssessment`,
`loadCoverageEnvelope`, `resolveDomains`, `getDomainManifest`, `runSignalDetectors`,
`composeInvestments`, `loadForecastIncomeStreams`, `assembleForecast` (×3 statement sets),
`resolvePayDates`, the transactions assembler over four windows, and the drilldown path.
Probe scripts were temporary and deleted.

**Read:** `lib/ai/types.ts`, `context-builder.ts`, `assemblers/transactions.ts`,
`coverage-envelope.ts`, `domain-relevance.ts`, `economic-concepts.ts`, `temporal-scope.ts`,
`bounded-selection.ts`, `provider.ts`, `intelligence/annotations/{types,engines,constants}.ts`,
`intelligence/debt-payments.ts`, `lib/forecast/{policy,engine,operating-state}.ts`,
`lib/ai/forecast/{assemble,streams,pay-dates}.ts`, `lib/data/transaction-query{,-core}.ts`,
`lib/history/{exploration,lens-root-node,historical-node.core}.ts`, `lib/data/snapshots.ts`,
`prisma/schema.prisma`, `package.json`.
