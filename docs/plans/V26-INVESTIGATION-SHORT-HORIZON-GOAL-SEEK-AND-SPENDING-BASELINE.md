# Investigation — short-horizon goal-seek semantics, scenario integrity, and platform spending-baseline consistency

Status: INVESTIGATION ONLY. No code changed, no DB mutated, nothing committed.
Base: `v2.6` @ 16c638a. Date: 2026-10-04.

**Evidence limit.** The dogfood transcript text did not arrive with the brief, and no copy is stored anywhere:
`AiInvocation` holds token/cost metadata only, and the transcript cache is client-side. Everything below is
derived from the code paths plus the figures quoted in the brief (87,014 / 61,964 / 25,385 / 335 / 38,370 / ≈444% /
39,292 / 5,438 / 5,731 / 7,013 / 7,451). Where a conclusion depends on the exact tool arguments the model sent,
it is marked **[needs transcript]**. Those figures were enough to back out the solver's dates and conventions
exactly (§3).

Two defect families:
- **A. Short-horizon return semantics and scenario integrity** (§1–§12)
- **B. Platform spending-baseline consistency** (§13)

They meet at one point: the EOY scenario's spending rate was the structural Aug+Sep figure, not the canonical
3-month one (§2.2).

---

## 1. Executive verdict

1. **The arithmetic is correct.** 444.31%/yr and $39,293.27 are exact under the engine's convention: effective
   annual compounding, ACT/365, `asOf` 2026-10-03 → 2026-12-31, 89 days. Neither number is an arithmetic defect.
2. **The contract is the defect.** `scenario_goal_seek` can only solve in annualized-rate space and returns only
   `required` (a "percent per year"). It never returns the period growth (+51.16%) the question was about, nor the
   year fraction or compounding basis. The model had no deterministic period figure to lead with, so it led with
   the one number it had.
3. **The bracket is horizon-blind.** `MAX_SOLVED_RETURN_PCT = 500` is fixed in annualized space, so the period
   growth it can reach shrinks with the horizon:

   | Horizon | Largest period growth inside the bracket |
   |---|---|
   | 30 days | +15.9% |
   | 89 days | +54.8% |
   | 1 year | +500% |

   "No value between 0 and 500 reaches the target" on a short horizon is therefore a statement about the
   bracket, not about feasibility. The "$100k in investments" target needed +293.9% (≈27,563%/yr). That is
   absurd, but it is a solution.
4. **The scenario's spending was not the canonical baseline.** It was the **Aug+Sep net (≈$7,013/mo)**. The cause
   is structural, not the user's 2-month question. `WINDOW_MONTHS = 3` is only a cap over `reliableMonths` of a
   **90-day rolling** read, and on Oct 3 that read clips July. Every product surface shares the same root cause
   (§13). The narration "already bakes in roughly $5.7k to low-$7k" did not identify the executable value.
5. **The income change probably over-reached [needs transcript].** "Regular pay checks +20–25%" with no `source`
   runs as an aggregate SCALE over every projection-eligible INCOME stream. On this Space that includes
   bank-interest streams the classifier files as INCOME (`income-change.ts:150-163`). The contract allows an
   omitted source only when "the user meant income as a whole", so this is an **intent-resolution** defect if the
   model omitted `source`.
6. **Goal-seek has no state.** `captureActiveScenario` ignores `scenario_goal_seek`, so the target measure,
   target and date live only in prose. The correction from investments to net worth was a fresh call reassembled
   by the model, not a change to one dimension of held state.

**Implementation: GO WITH CONDITIONS.** See §9.

---

## 2. Scenario reconstruction

### 2.1 Lineage

Spine and ledger facts come from code. Argument shapes marked † are the ones the contract routes to; the actual
call arguments are **[needs transcript]**.

| # | State | Assumption added | Still active | Silently replaced? | Double count? | Explanation vs executable |
|---|---|---|---|---|---|---|
| S0 | Initial EOY projection (`project_cash` or `scenario_projection`, `asOf` 2026-10-03 → 2026-12-31) | none: observed income streams plus the observed spending rate | — | — | — | The spending rate is `observedDaily × 365/12` from `reliableMonths` of the **90-day** read = **Aug+Sep net** (§2.2). Any narration of it as "3-month" or "recent pattern" is wrong about the window. |
| S1 | Income baseline | — | S0 | — | — | Projection-eligible streams from `loadForecastIncomeStreams`. The pay cadence is observed, not stated. |
| S2 | Spending baseline / window | None *executable* from the 2-month question. `measure_flows` and `get_baselines` write no scenario state (verified: no code path into the plan, envelope or memory). | S0 | **No**, but the executable rate already *was* the 2-month figure | — | The narration "≈$5.7k–low-$7k baked in" names a range spanning the 3-month gross and the 2-month net. The executable value was one number, ≈$7,013. |
| S3 | + bonus | † `outflows:[{onDate, amount:-X}]` (a one-off inflow; `incomeChanges` refuses one-offs by design) | S0–S2 | — | Not scaled by S4: a one-off carries no `sourceKey` (`income-change.ts:43`) | ✓ if it was passed as an outflow |
| S4 | + 22.5% regular pay "starting now" | † `incomeChanges:[{op:'SCALE', multiplier:1.225, from:<today>}]` | S0–S3 | — | — | "Applied across all your current income streams" is an **accurate** description of an omitted-source SCALE, and an **inaccurate** reading of "regular pay checks" (§4). |
| S5 | + danger-pay backpay | † a second negative `outflow` | S0–S4 | — | **[needs transcript]**: if danger pay is also a recurring stream, S4 scaled it too | — |
| S6 | Investments | `composeInvestments(accounts).combined` = 25,385 (measured, held flat at 0%) | — | — | — | ✓ |
| S7 | Debt | 335 (`accounts.totalLiabilities`, plus lines if any APR) | — | — | — | ✓ |
| S8 | Goal: "$100k" → `measure:'investments'` | `scenario_goal_seek {target:100000, measure:'investments', solveFor:'annualReturnPct'}` | Only what the model **re-passed**: the envelope is not merged into goal-seek args | **Risk**: any S3–S5 clause the model failed to re-send would be dropped. `assumptionsInForce` echoes what ran, so this is checkable | — | Returned `feasible:false, bestReached≈39,293 @ 500`. Narrated without "annualized over 89 days" (§8). |
| S9 | Correction → net worth | A new call with `measure:'netWorth'` | Same risk as S8 | Target measure **replaced by reconstruction**, not by modifying state | — | `baseline.reached` 87,014 → `required` 444.31. Narrated as "444% annualized" first; +51% came later, from LLM arithmetic. |

The reconciliation 61,964 + 25,385 − 335 = 87,014 implies `otherAssets` = 0 and shows the ledger composed the
figures consistently.

### 2.2 Spending semantics (Part 2, with the owner's decision applied)

| Question | Answer |
|---|---|
| Executable authority | `prepareScenario` (`tools.ts:2761-2766`): `assumedMonthlySpending`, else `endpoint.observedSpending.dailyRate × 365/12`. The rate comes from `assembleForecast` (`assemble.ts:538-549`) → `deriveObservedSpendingRate(reliableMonths(txn))`, where `txn` = `assemble(TRANSACTIONS_SUMMARY)` with **no window**. Production never sets `ctx.cashSpineReads`, so the read is `resolveWindow`'s default `startOfDay(-90)` (`transactions.ts:1912-1918`). |
| Window on 2026-10-03 | Read 07-05..10-03. July is clipped by the start (`startClipped`), October by the end. `reliableMonths` = Aug, Sep. **2 complete months.** `WINDOW_MONTHS = 3` is a cap that cannot bind. |
| Gross or net | **Net** (`clampEconomicSpend(gross, refunds)`, floored at 0), less the interest on modelled liabilities (S1-N1). |
| Primitive or fixed rate | A baseline primitive: an observed daily rate accrued over the horizon. Not a fixed user-stated figure **[needs transcript: confirm no `assumedMonthlySpending` was sent]**. |
| Described accurately? | **No.** "≈$5.7k to low-$7k" names no executable value. The value was ≈$7,013 net (Aug+Sep). |
| Measurement detached from execution? | Yes, in the other direction from the one feared. The **measurements** (`get_baselines.byWindow[3]` = Jul–Sep ≈$5,438) used the true calendar window. The **execution** used the clipped 2-month figure. The same `get_baselines` result even carries both: `expense.amount` (Aug–Sep) beside `byWindow[0]` (Jul–Sep). |
| Owner's A/B/C/D | **B, by structure, not by contamination.** The 2-month figure was in force before the user asked. The user's 2-month query changed nothing (no code path), and its result *coincided* with the rate already running. |
| Would "$5,700/month" have changed EOY? | **Yes, upward**, by ≈ (7,013 − 5,700) / (365/12) × 89 ≈ **+$3,842**. |
| Under the canonical baseline (≈$5,438) | EOY cash ≈ 61,964 + 4,608 ≈ **66,572**. Investments needed for $100k NW ≈ 33,763: **+33.0% period** (≈222%/yr), not +51%. This is an estimate: it assumes the transcript's 7,013 equals the spine's rate, and modelled interest on a $335 debt is negligible. |

---

## 3. Independent arithmetic verification

The engine's growth (`scenario-ledger.ts:538-551`) is `factor = Π (1 + annualPct/100)^(days/365)`. The span is
half-open, `days` is UTC whole days, and the solved return period is `{fromISO: asOf, toISO: by}`, so the span is
`days(asOf, by)`.

Back-solving the horizon from the transcript's 500% figure: T = ln(39,292/25,385) / ln 6 = 0.24382 yr =
**88.99 days**, so `asOf` = **2026-10-03** (UTC `todayUTCISO()` at the time of the turn) and the horizon is 89 days.

| Quantity | Formula | Value |
|---|---|---|
| Required investments for NW $100k | 100,000 − 61,964 + 335 | 38,371 |
| Period growth factor | 38,371 / 25,385 | 1.51156 |
| **Period return** | factor − 1 | **+51.16%** |
| Annualized, effective, ACT/365 | 1.51156^(365/89) − 1 | **444.31%** ✓ |
| Annualized, simple | 0.5116 × 365/89 | 209.8% |
| Annualized, continuous | ln 1.51156 × 365/89 | 169.4% |
| FV at 500%/yr | 25,385 × 6^(89/365) | **39,293.27** ✓ |
| Period growth at 500%/yr | 6^(89/365) − 1 | +54.79% |
| Investments target $100k | 100,000 / 25,385 − 1 | +293.9% period ≈ **27,563%/yr** (outside the bracket) |

The solver precision is 0.01pp, then a ceil-and-verify step, so `required` = 444.31 or 444.32 depending on the
exact cent values. Both numbers are correct. Only the choice of representation was wrong.

**Convention inconsistency found.** `timeToTarget.years` comes from `elapsedBetween` and uses **365.25**
(`scenario-crossing.ts:173`). The ledger compounds on **365**. Any LLM-side annualization from
`timeToTarget.years` would disagree with the engine in the second significant figure.

---

## 4. Income-change semantics (Part 3)

The primitive is `lib/forecast/income-change.ts:466-491`. A rule with `sourceKey: null` targets every stream
with `projectionEligible && role === INCOME`. On this Space the role filter separates nothing: three bank-interest
streams carry `flowType: INCOME` (the module says so at `:150-163`). One-off assertions (bonus, backpay as
`outflows`) are never reached.

The contract (`scenario-inputs.ts:146-151`) says: "Omit it only when the user meant income as a whole … an
omitted source scales EVERY stream." "My regular pay checks" names a stream. The `sourceKey` is discoverable via
`get_pay_dates` / `get_income`.

**Classification:**
- If the call omitted `source` **[needs transcript]**, the outcome is **B**, and plausibly **E** (interest
  streams were scaled too). The layer is **reasoning/intent selection**. The execution was correct for the
  arguments sent, and the narration "applied across all your current income streams" was *truthful about the
  execution*. The execution result lists `matched` streams, so the evidence existed to notice it.
- **C did not happen**: irregular deposits are not streams.
- Contract weakness (secondary): nothing forces disambiguation when a phrase names a subset ("regular",
  "paycheck", "salary"), and the aggregate SCALE silently includes interest-like streams the classifier
  mislabels.

---

## 5. Goal-target semantics (Part 4)

- **Dimensions exist** (`tools.ts:3776`): `measure ∈ {netWorth, liquid, investments, debt}`, default `netWorth`,
  with debt solved downward. There is no category or asset-specific measure. None was needed here.
- The **default was right** (netWorth). The model chose `investments` from the user's ambiguous wording. That is
  intent resolution, and defensible given that wording.
- The **correction was a new call**, not a state mutation. `captureActiveScenario` IGNOREs `scenario_goal_seek`
  (`active-scenario.ts:168`), and the pending plan stages only scenario *inputs*, never a goal. A goal is
  `{measure, target, by, solveFor}` and has no carrier. "No, I meant net worth" therefore depends on the model
  re-sending every scenario clause plus the new measure. In this transcript the 87,014 baseline suggests it did
  (S3–S5 held), but nothing structural guaranteed it.
- Contrast: the crossing tool's target **is** captured ("what about $2M?" is a one-field change,
  `active-scenario.ts:52-60`). Goal-seek lacks the parity.

---

## 6. General temporal return semantics (Part 6)

### Rule

A return is a property of **a horizon**. The deterministic result exposes both the period and the annualized
representation, plus the basis. The model chooses which to lead with by intent and never converts between them.

| User intent / horizon | Primary | Secondary |
|---|---|---|
| "how much would my investments need to grow", "what could get me to X by <date>" (any horizon) | **periodReturn** ("+51% between now and Dec 31") | annualized, with its basis, only if useful |
| "what return would I need" — horizon < 1 yr | **periodReturn** | annualized, labelled "≈444%/yr if sustained for a full year (effective, ACT/365)" |
| "what return would I need" — horizon ≈ 1 yr (within ±2 weeks) | Either; they differ by < 1pp, so state one and name the horizon | — |
| "what return would I need" — horizon > 1 yr | **annualizedReturn** ("7.2%/yr for 5 years") | cumulative periodReturn ("+42% in total") |
| "what *annual* / *annualized* return would I need" (any horizon) | **annualizedReturn** | periodReturn when the horizon < 1 yr (an annualized short-horizon figure is otherwise unintelligible) |

**Rationale.** Below one year, annualizing *extrapolates* growth across time the question does not cover, which
amplifies it non-linearly. That is a different claim from the one asked. Above one year, a period total hides the
rate the user can compare against market history. The engine already compounds over actual days, so both
numbers are a function of one factor and must come from it.

### Contract fields

On every `annualReturnPct` solve, and usable elsewhere:

```
horizon:   { startDate, endDate, dayCount, yearFraction, dayCountConvention: 'ACT/365' }
returnAtSolution: {
  annualizedPct,                 // the solved rate (what `required` is today)
  periodPct,                     // (growthFactor(returns, start, end) − 1) × 100 — FROM THE LEDGER'S OWN growthFactor
  compounding: 'EFFECTIVE_ANNUAL',
  meaning: 'periodPct is what one dollar held the whole horizon grows by; annualizedPct is that rate expressed per 365 days',
}
```

`periodPct` must be **`growthFactor` − 1**, not `requiredValue / startingValue − 1`. With contributions present,
or dated returns that start later, the value ratio mixes principal and growth. The factor is the rate's own
period equivalent and stays correct in every case. When there are no contributions, the two coincide, and both
can be shown as "show me the math" (§9).

---

## 7. Feasibility semantics (Part 7)

| Concept | Today |
|---|---|
| Mathematically infeasible (flat function: target does not respond to the lever) | ✓ Distinguished (`solveForTarget` flat-function reason) |
| Outside search bounds | ⚠️ Reported as `feasible:false` with reason "no value of X between lo and hi reaches the target", and `bestReached`. The **field name** `feasible:false` conflates "outside bracket" with "infeasible". For returns, the bracket is horizon-blind (§1.3). |
| Impossible under constraints (cut > spending, payment > debt) | ✓ The bracket upper bound is the fact (`hi = base`, `hi = debt`) |
| Financially plausible / historically unusual | Owned by the model by design ("Nothing here decides that 142%/yr is unrealistic"). There is no deterministic reference. |
| Target already met | ✓ `alreadyMet`, `required = lo = 0` |
| Negative required return (target met even with losses) | ✗ `lo = 0`: reports `alreadyMet` with no headroom figure ("investments could fall 12% and you'd still make it") |

**Reusable defect:** `feasible:false` should split into `INFEASIBLE` (the function cannot reach the target) and
`OUT_OF_RANGE` (it can, beyond the searched bound). For returns, the bound should be stated in period terms too
("the search went up to +54.8% over these 89 days"). "Crypto-moonshot / lottery territory" for +51%/3 mo is a
model **judgement**, which the design allocates to the model. That is not a defect. It is defensible, and should be
anchored on the period figure, not the annualized one.

---

## 8. The 500% exchange (Part 8)

- **Convention verified:** FV = PV × (1 + r)^(days/365), effective annual, half-open span.
  25,385 × 6^(89/365) = **$39,293.27**. ✓
- The tool result carried `unit: 'percent per year'`, `bestAt: 500`, and `timeToTarget` (months/days). It did
  **not** carry the year fraction, the compounding basis, or the period growth (+54.8%).
- "Even at an extreme +500% annual return, you'd only get to about $39,292" omitted "applied for 89 days, i.e.
  +54.8% growth". **Classification: narration defect, enabled by a contract gap.** The basis was not given as
  data. The model had a unit string and a separate elapsed-time object, and no field joining them.

---

## 9. Provenance / "show me the math" (Part 9)

| Line | Exists deterministically today? |
|---|---|
| Projected cash at target date | ✓ `scenario.checkpoints[-1].liquid` (ledger at the solution) |
| Projected liabilities | ✓ `…debt` |
| Other assets | ✓ `…otherAssets` |
| Target net worth | ✓ `target` |
| Required investment value | ✓ *implicitly*, as `…investments` at the solution. It is not named as "required". |
| Baseline (at 0%) | ✓ `baseline.reached` and `baseline.gap` |
| Starting investment value | ✓ `scenario.opening.investments` |
| Period growth factor / period return | ✗ **LLM-reconstructed** (the +51% in the transcript was model arithmetic) |
| Annualization formula, day count, year fraction | ✗ (`timeToTarget` carries days, but in 365.25-years) |
| Spending rate and its months | ⚠️ `assumptionsInForce.spending.{source, monthly}`, **no months**. `project_cash` exposes `monthsAveraged`, the scenario tools do not. |
| Income streams the raise reached | ✓ `incomeChanges.executions[].matched` |

Smallest addition: a `derivation` block on the goal-seek success, built from values already in the ledger:

```
derivation: {
  measure: 'netWorth',
  identity: 'liquid + investments + otherAssets − debt = target',
  terms: { liquid, investmentsRequired, otherAssets, debt, target },
  investments: { opening, contributedPrincipal, growthFactor, periodPct, annualizedPct },
  horizon: { startDate, endDate, dayCount, yearFraction, convention: 'ACT/365, effective annual' },
}
```

---

## 10. Defect table — family A

| # | Issue | Layer | Severity | Current behavior | Correct invariant | Reusable fix direction | Regression-test concept |
|---|---|---|---|---|---|---|---|
| A1 | Goal-seek returns only an annualized rate | Temporal-semantics (contract) | **High** | `required` in "percent per year", nothing else | A return over a horizon is exposed as period AND annualized, with basis | `returnAtSolution{annualizedPct, periodPct, compounding}` + `horizon{…yearFraction}` from `growthFactor` | 89-day solve: periodPct ≈ 51.16, annualizedPct ≈ 444.31, and growthFactor round-trips |
| A2 | Return bracket fixed in annualized space | Temporal-semantics (solver) | **Medium** | 0–500%/yr; at 30 days that is ≤ +15.9% | The searched bound is stated in the horizon's terms, and a bound-exhausted result is not called infeasible | State `searchRange.periodTo`. Optionally bracket in period space (`hi` such that the period factor ≥ N×) | 30-day target needing +20%: not reported as "no solution exists" |
| A3 | `feasible:false` conflates out-of-range with infeasible | Contract | Medium | One boolean, two meanings | `outcome: SOLVED / ALREADY_MET / OUT_OF_RANGE / INFEASIBLE` | Split the result kind in `solveForTarget` (the flat-function branch already exists) | Flat function ⇒ INFEASIBLE; bound exhausted ⇒ OUT_OF_RANGE with bestReached and bestAt in period terms |
| A4 | "444% annualized" led the answer to a by-date question | Narration (enabled by A1) | Medium | Model leads with the only number given | Lead representation follows intent (§6 table) | Description and `meaning` text on the new fields. No arithmetic in prose | Generic "grow by Dec 31" ⇒ the answer leads with periodPct; "annual return" ⇒ annualizedPct |
| A5 | "+500% … only $39,292" without basis | Narration (contract gap) | Low–Med | The unit string only | Any annualized figure over < 1 yr carries horizon and period equivalent | `bestAt` is accompanied by `bestAtPeriodPct` | An out-of-range short-horizon result includes the period equivalent |
| A6 | `timeToTarget.years` uses 365.25, the ledger uses 365 | Temporal-semantics (consistency) | Low | Two year conventions in one result | One convention per result | `horizon.yearFraction` from the ledger's `days/365`; label elapsed `years` as display | yearFraction × 365 === dayCount |
| A7 | Goal has no state; a measure correction means a full reassembly | Scenario-state | Medium | Goal-seek IGNOREd by the envelope | A correction to one goal dimension modifies that dimension only | Capture goal-seek like the crossing: `{assumptions, goal{measure,target,by,solveFor}, result}` | Goal-seek(investments) → "I meant net worth" ⇒ same clauses, measure changed, nothing dropped |
| A8 | Aggregate SCALE for "regular pay checks" | Intent-resolution | Medium **[needs transcript]** | No `source` ⇒ every INCOME stream, incl. mislabeled interest | Subset wording names a stream or asks | Description: subset words ("paycheck", "salary", "regular") require `source`. Surface `matched` labels in the narration | "Regular paychecks +20%" with salary + interest streams ⇒ only the salary scaled |
| A9 | Spending narrated as a range, not the executed value | Narration | Medium | "≈$5.7k–low-$7k baked in" | Narrate the executed rate and its months | Echo `months` and `monthCount` in `assumptionsInForce.spending` (B5) | Scenario answer cites the months the rate averaged |
| A10 | No negative-return headroom | Contract (minor gap) | Low | `lo=0`, `alreadyMet` | Target already met ⇒ say how much loss is tolerable | Allow `lo < 0` for returns when already met (bisect downward) | Already-met case reports a tolerable drawdown |
| A11 | 444% numerically | — | **No defect** | — | — | — | Pin the 89-day vector |

---

## 11. Recommended architecture — family A (smallest reusable correction)

Do not add a new tool, a special case, or an intent taxonomy. Extend three existing seams:

1. **`scenario-ledger.ts`.** Export a pure `returnRepresentation(periods, fromISO, toISO)`:
   `{ dayCount, yearFraction, growthFactor, periodPct, annualizedPct, convention }`, built on `growthFactor`
   itself so it cannot disagree with the ledger. In `solveForTarget`, split the result kind
   (`SOLVED | ALREADY_MET | OUT_OF_RANGE | INFEASIBLE`) and keep `feasible` as a derived alias for compatibility.
2. **`tools.ts` `scenario_goal_seek`.** On the annualReturnPct path, attach `returnAtSolution`, `horizon`, and for
   OUT_OF_RANGE `bestAtPeriodPct` plus `searchRange.periodTo`. Add the `derivation` block (§9). In the
   description, add one sentence saying which representation answers which question (§6), and a forbiddance on
   converting between them in prose.
3. **`active-scenario.ts`.** Capture goal-seek as a scenario-with-goal (parity with the crossing), so a
   correction is a field change.

Shape check against the brief's proposal: `targetMeasure / targetValue / targetDate / startingValue /
requiredValueAtTarget` already exist (as `measure / target / by / scenario.opening.investments /
scenario.checkpoints[-1].investments`). Only the *return representation*, the *horizon basis*, and the *outcome
kind* are missing. Do not duplicate the existing fields under new names.

---

## 12. Regression matrix — family A

| Case | Input | Expect |
|---|---|---|
| 3-month horizon | asOf 10-03, by 12-31, need ×1.5116 | periodPct 51.16, annualizedPct 444.3, dayCount 89, yearFraction 0.24384 |
| 6-month horizon | 182 days, need ×1.20 | periodPct 20.0, annualizedPct ≈ 44.1 |
| Exactly 1 year | 365 days (non-leap) | periodPct === annualizedPct (± precision) |
| Leap boundary | 2027-10-03 → 2028-10-03 = 366 days at 8% | periodPct 8.0228, yearFraction 366/365 |
| Multi-year | 5 years, need ×1.42 | annualized ≈ 7.27, period 42.0 |
| Explicit "annual return" wording | 89-day case | Answer leads with the annualized figure AND gives the period one (model eval) |
| Generic "grow by Dec 31" | 89-day case | Answer leads with +51% (model eval) |
| NET_WORTH vs INVESTMENTS $100k | Same scenario | netWorth: SOLVED 444%. investments: OUT_OF_RANGE, bestAtPeriodPct 54.8, never "impossible" |
| Clarification changes measure | Goal-seek(investments) → "net worth" | Same clauses ran (`assumptionsInForce` identical), measure changed |
| Bonus + raise + spending change | All three stated, then goal-seek | `assumptionsInForce` lists all three. Baseline equals the projection's EOY |
| Gross vs net baseline | Refund-heavy month | Spine rate uses net (B-family tests) |
| Bound exhaustion | 30-day, need +20% | OUT_OF_RANGE, periodTo 15.9 |
| Negative required return | Target below 0%-path value | ALREADY_MET, plus tolerable drawdown if A10 is done |
| Target already satisfied | baseline ≥ target | ALREADY_MET, required 0, period 0 |
| Zero investment balance | opening 0, no contributions | INFEASIBLE (flat), not OUT_OF_RANGE |
| Contributions + return | Monthly 500 plus solve rate | periodPct = growthFactor − 1 ≠ requiredValue/opening − 1, and both are shown in the derivation |

---

## 13. Family B — PLATFORM SPENDING-BASELINE CONSISTENCY

### 13.1 Headline

There is **one** spending-average authority and one predicate (`reliableMonths`), so the platform does **not**
compute independent averages. But it feeds that authority a **90-day rolling read**, and the read almost never
contains 3 complete months. Simulated over every day of 2026: **356 of 365 days yield 2 complete months, 9 yield
3.** Most of those 9 are month-end days, where an in-progress month is wrongly counted complete because
`endClipped = !isLastDayOfMonth(today)` (`transactions.ts:1545`).

So the "2-month average" the owner sees on Net Worth/Assets and the Daily Brief is **not a second
implementation**. It is the canonical authority running on a window that cannot reach 3 months. The scenario
engine's `WINDOW_MONTHS = 3` is defeated the same way. The only true calendar-3-month figures on the platform are
measurements: `get_baselines.byWindow[3]`, `measure_flows`, and `rolling3moAvg`. The last of these is null on the
same 356 days, for the same reason.

The owner's diagram is **almost** the current shape: economics (`clampEconomicSpend`), then one predicate
(`reliableMonths`), then consumers. The missing box is "**3 complete calendar months**". The window is decided
upstream by the assembler's read length, not by the baseline authority.

### 13.2 Producer / consumer map

Shared pipeline: `ASSESSMENT_WINDOW_DAYS = 90` (`transactions.ts:265`), `startOfDay(-90)` on the UTC **wall
clock** (not `ctx.asOfISO`), `economicDate ?? date` bucketed by UTC month, then `reliableMonths` (non-partial,
non-truncated; `metrics.ts:295-299`), then net via `clampEconomicSpend` (`cash-flow.ts:379-386`).
- Scope: SPENDING + FEE + INTEREST, with REFUND as the credit side.
- Excluded: transfers, debt payments, investment flows, pending rows, UNKNOWN/ADJUSTMENT rows, rows that failed
  currency conversion.
- Months with no rows are absent rather than counted as $0.

| Surface | Producer | Window (actual) | Complete / rolling | Gross / net | Consumers | Money or display | Classification |
|---|---|---|---|---|---|---|---|
| **Net Worth → Assets → Cash** "covers N months · at $X/mo" | `app/api/spaces/[id]/expense-baseline/route.ts:138-157` → `computeAverageMonthlySpending` → `resolveExpenseBaseline` (`lib/liquidity/expense-baseline.ts:96-112`); `SpaceDashboard.tsx:645-655` → `LiquidityWorkspace.tsx:254-261,384-398` → `LiquidityHero.tsx:188-205` | reliable months of 90d ⇒ **2** | Complete months inside a rolling read | Net | Hero coverage, emergency-coverage bands (3/6 mo) | Display, but drives coverage bands | **Inconsistent baseline** (window). The label omits the count and the months (`expense-baseline.ts:129`) |
| Assessment liquidity / runway grade (`estimatedMonthlyExpense`, `coverageMonths`) | `lib/ai/intelligence/annotations/engine.ts:150,436,481-484` | **2** | same | Net | Brief, AI context, AiAdvice, READY_TO_INVEST | **Money** (verdicts) | **Inconsistent baseline** |
| **Daily Brief** `behavior.monthlyExpenses` | `lib/ai/brief/package.ts:269-281` (reads the assessment); loader `brief/load.ts:223-227` (retrospective `[asOf-90, asOf]`) | **2** | same | Net | Prompt; `isMaterialActivity` gate (`digest.ts:52-57`) | Narration + materiality gate | **Inconsistent baseline**, plus a disclosure defect: `prompt.ts:49` says "monthly averages over behavior.window" while the window is `{days:90}` and the mean is over 2 months |
| Scenario / project_cash / crossing / goal-seek / months-of-expenses floor / category rates | `observed-spending.ts:113-140` via `assemble.ts:538-549`; `tools.ts:1828,2761-2766` | **2** (cap 3) | same | Net, less modelled interest (S1-N1) | Ledger, floor, crossing, solver bracket (`hi = base`) | **Money** | **Inconsistent baseline**: the cap cannot bind |
| `get_baselines.expense` (default) | `tools.ts:1116-1160` | **2** | same | Net | Model: surplus, savings rate, runway | Money (advice) | **Inconsistent baseline**. Contradicts `byWindow[3]` in the same result |
| `get_baselines.measuredSpending.byWindow` | `tools.ts:1190-1200` | **3/6/12 calendar months** via `resolvePeriod` | True complete months | Net (gross if material) | Model | Measurement | **No defect** (measurement). Note: `byWindow[3]` *is* the owner's canonical figure |
| `measure_flows` | `tools.ts:1006-1075`, `measure.ts` | any | as asked | Headline gross, `netOfRefunds` beside it | Model | Measurement | **Intentionally different measure** (headline-gross convention worth reviewing separately) |
| `get_spending` | `tools.ts:512-585` | 90d, needs ≥2 whole months | rolling → whole | Net | Model | Display | Measurement. Same window caveat |
| Orientation `recent` / `activity` frames | `evidence.ts:267-271`, `activity-frame.ts:113-125` | 90d / trailing 6 mo, partial included | Rolling | **Gross** | Prompt | Display (division forbidden, `evidence.ts:307-310`) | **Intentionally different** (period totals, not a baseline). Gross vs net-everywhere-else is worth a note |
| Spending trends `rolling3moAvg` | `metrics.ts:270-276` | Last 3 complete months | Complete | Net | Assessment trends | Descriptor | Intentionally different, but **unreachable** on ~356 days/yr (null) |
| Category `monthlyEquivalent` | `metrics.ts:137-160` | **2** | Complete | Net | Assessment opportunities | Advisory | Inherits the window. No separate defect |
| Cash Flow workspace (Hero, Summary, Insights, Calendar) | `components/space/widgets/cashflow/*` | Selected period | Period totals | Net + liquidity tiers | Display | Display | **Intentionally different measure** |
| Licensed engine / FORECAST-6 `deriveSpendingBaseline` | `lib/forecast/engine.ts:298-331`, `spending-baseline.ts:218` | 28-day, gross | — | — | **No production caller** | — | **Stale implementation** (unused). The engine answers only from stated spending. `MEAN_MONTH_DAYS` 365.2425/12 vs 365/12: tiny drift |
| `renderEmergencyFundReadiness` / `renderAccessibleCash` | `components/space/widgets/liquidity-adapters.tsx:189-254` | — | — | — | No consumer | — | **Stale implementation** (dead code) |
| Memory V2 `BASELINE.monthlySpending` | `memory-model.ts:172,479` | — | — | — | Orientation memory line; never merged into scenarios | — | No defect (user-stated only, gated) |
| Tests | `transactions.parity.test.ts:184-205` (90d), `net-expense-baseline.test.ts:81-115` (Aug/Sep 2-month means pinned), `brief/package.test.ts`, `brief/fixtures.ts` (`{days:90}`), `projection.test.ts:63`, `measures.test.ts:490` (`=== 3`) | — | — | — | — | — | **Test-only artifacts** pinning the 2-month result. No test asserts that the read *yields* 3 months, which is why this went unnoticed |

### 13.3 Daily Brief specifics

- **Calculated independently?** No. It consumes the assessment's resolved baseline.
- **Persisted?** Not as a field. `DailyBrief.content` freezes the model's prose, including any figure it quoted.
  `materialDigest` stores **bucketed** expenses (`digest.ts:36-45,103-104`).
- **Cache key:** `sourceWatermark`, `materialDigest` (`brief-material-v3`), and
  `promptVersion = BRIEF_GENERATION_VERSION('brief-generation-4') + prompt hash`. **None includes the window
  definition.** A policy change re-briefs only when the new value crosses a bucket boundary.
- **History:** the lifecycle writes only today's `(space, owner, briefDay)` row. Historical briefs are never
  rewritten, which is ✓ correct. Changing the policy should bump `BRIEF_GENERATION_VERSION` so *today's* brief
  regenerates once. Past rows keep their basis.
- **Gap:** past briefs do not record *which months* they averaged, so "preserve original basis" holds only as
  frozen prose. A `basis.spendingMonths` in the package (persisted with `content`) would make it auditable.

### 13.4 Contamination: can "what was my 2-month average?" leak into a scenario?

| Path | Status |
|---|---|
| `measure_flows` / `get_baselines` result auto-written to plan, envelope or memory | **Impossible**: no code path |
| `get_baselines.spendingWindow` | Affects that tool's own output for that turn only |
| Pending plan (`stage_assumptions`) | Gated by `userStatedFigure`: the figure must appear in the user's own text |
| Memory V2 | Gated and never merged into scenarios (`tools.ts:2632-2633`) |
| **Model copies a measured figure into `assumedMonthlySpending`** | **Possible, only via model choice, and unverifiable afterwards.** It is labelled `USER_STATED` (`tools.ts:2762`), recorded as a SPENDING_LEVEL fact, captured verbatim in the envelope, and replayed. The direct-call path does not apply the `userStatedFigure` gate the plan and memory use. The STATED-basis note (`baseline.ts:155-158`) and "pass `spendingWindow` to make the baseline use it" (`tools.ts:1233`) both nudge the model toward treating a measured window as *the* baseline. |
| **Structural: the 90d read makes the 2-month figure the baseline** | **Exists, with no model involvement.** This is what happened in the transcript. |

`MEASURE(window=2) ≠ SET_SCENARIO_SPENDING` holds at the code level except for the unguarded
`assumedMonthlySpending` provenance. The owner's invariant fails today because `CANONICAL_BASELINE` itself
equals `MEASURE(window=2)` on 356 days a year.

### 13.5 Smallest consolidation

1. **One month selector.** Add `canonicalSpendingMonths(asOfISO)`, which returns the three complete calendar
   months strictly before `asOf`'s month (Oct 4 → Jul, Aug, Sep), on the `asOf` date authority, never the wall
   clock. Make it the single home of `WINDOW_MONTHS`. `computeMonthlySpendingBasis` (`metrics.ts:352-356`) and
   `deriveObservedSpendingRate` both select through it. A future policy change touches one function.
2. **Make the read cover those months.** Give the baseline consumers an **explicit calendar window** (1st of
   `asOf`−3 months … last day of `asOf`−1 month) rather than widening `ASSESSMENT_WINDOW_DAYS`. Widening it
   would move every assessment total, the activity-frame threshold (> ~92 days deletes it) and the W4 pin.
   The consumers are:
   - the expense-baseline route
   - the assessment's expense figure
   - the Brief loader
   - the cash spine (`tools.ts:1828`)
   - `get_baselines.expense`
   
   `resolvePeriod({completeMonths:3}, ceiling)` already computes exactly this window. Reuse it; do not write a
   second period parser.
3. **Fix the month-end bug.** "Complete" means the month has *ended*: `endISO > lastDay(month)`, not
   `endISO === lastDay`.
4. **Disclose.** Echo `{months, monthCount, basis:'NET'}` in `assumptionsInForce.spending`, in the expense-baseline
   label, and in the Brief's `behavior` (replacing `window:{days:90}`).
5. **Provenance.** `assumedMonthlySpending` passed directly is accepted, but its provenance is decided by the
   same `userStatedFigure` gate the plan uses: user-stated vs `MODEL_SUPPLIED`, echoed as such. Reword the
   STATED note and the `spendingWindow` note so a measurement is never described as becoming "the baseline".
6. **Brief:** bump `BRIEF_GENERATION_VERSION`. Do not touch historical rows.
7. **Fewer than 3 complete months (existing behavior, keep):** average what exists (1–2), disclose the count, and
   refuse at 0 (`observed-spending.ts:116-125`, `cash-flow.ts:430`). `rolling3moAvg` stays null below 3. The
   only change is that the count becomes visible on every surface.

### 13.6 Defect table — family B

| # | Issue | Classification | Severity | Fix direction |
|---|---|---|---|---|
| B1 | Canonical baseline = 2 months on ~356 days/yr (90d read clips the oldest month) | Inconsistent baseline (structural) | **High** (money: scenarios, runway grades, Brief gate) | §13.5 steps 1–2 |
| B2 | Month-end day counts the current month as complete | Temporal-semantics | Medium | §13.5 step 3 |
| B3 | Baseline window from the UTC wall clock, measurements from `ctx.asOfISO` | Temporal-semantics | Low | Selector on `asOf` |
| B4 | `get_baselines.expense` (Aug–Sep) contradicts `byWindow[3]` (Jul–Sep) in one result | Inconsistent duplicate presentation | Medium | Resolved by B1 |
| B5 | Scenario echo lacks the months; the Brief claims a `{days:90}` window | Narration / disclosure | Medium | §13.5 step 4 |
| B6 | `assumedMonthlySpending` direct-call provenance unguarded (`USER_STATED` for anything) | Scenario-state | Medium | §13.5 step 5 |
| B7 | Tool notes describe a measurement as able to become "the baseline" | Contract wording | Low | §13.5 step 5 |
| B8 | Brief cache keys omit the window; a policy change does not re-brief | Freshness | Low | Bump the version |
| B9 | `deriveSpendingBaseline` (F6) and liquidity adapters unused | Stale implementation | Low | Delete later, separately |
| B10 | Orientation frames gross, tools net | Intentionally different (display) | Info | Leave; optionally label |
| B11 | No test asserts the read yields 3 months | Test gap | Medium | Tests 1–2, 11 below |

### 13.7 Regression tests — family B

| # | Test |
|---|---|
| 1 | asOf 2026-10-04 ⇒ canonical months `[2026-07, 2026-08, 2026-09]` across the route, assessment, Brief package, spine and `get_baselines.expense`, all equal to `byWindow[3]` |
| 2 | October rows (partial) contribute nothing to the canonical figure |
| 3 | A refund in August reduces August by the refund, floored at 0 |
| 4 | `measure_flows({completeMonths:2})` returns Aug/Sep; the next scenario's `assumptionsInForce.spending` is still Jul–Sep and `OBSERVED` |
| 5 | Same for 6 months |
| 6 | `assumedMonthlySpending: 5700` stated by the user ⇒ `USER_STATED` in that scenario only. The next `get_baselines.expense` is still the measured Jul–Sep figure. A value not in the user's text ⇒ `MODEL_SUPPLIED` |
| 7 | New Brief package `behavior.monthlyExpenses` = canonical, `behavior.months` = Jul–Sep |
| 8 | A stored DailyBrief row from before the change is byte-identical after the change. Only today regenerates (version bump) |
| 9 | The Net Worth/Assets expense-baseline route equals the AI orientation and `get_baselines.expense` for one fixture |
| 10 | `project_cash` and `scenario_goal_seek` baseline spending are equal to canonical unless `assumedMonthlySpending` is given |
| 11 | Month boundary: asOf 09-30 ⇒ Jun/Jul/Aug (September is NOT complete on its last day); asOf 10-01 ⇒ Jul/Aug/Sep |
| 12 | Only 2 complete months of history ⇒ averages 2, discloses `monthCount: 2`. 0 months ⇒ refusal (existing) |
| 13 | Refund-heavy month (refunds > charges) ⇒ that month is 0, not negative |
| 14 | A month with zero spending: **decide**. Today an empty month has no bucket and silently drops out of the mean, which inflates the average. Recommend counting it as $0 when it lies inside the covered window |
| 15 | Timezone: a transaction at 2026-09-30T23:30 in a UTC−5 Space buckets by `economicDate`/UTC as today, and is pinned so a later TZ decision is deliberate |

---

## 14. Files and surfaces likely involved

Family A:
- `lib/ai/conversation/scenario-ledger.ts`: `growthFactor`, `solveForTarget`
- `lib/ai/conversation/tools.ts`: `scenario_goal_seek` (3717-3995), `scenarioAssumptions` (3278-3347)
- `lib/ai/conversation/active-scenario.ts`: `captureActiveScenario`
- `lib/ai/conversation/scenario-crossing.ts`: `elapsedBetween`, the 365.25 convention
- `lib/ai/conversation/scenario-inputs.ts`: the `incomeChanges.source` wording
- `lib/forecast/income-change.ts`: read-only reference
- Tests: `spending-goal-seek.test.ts`, `scenario-composition.test.ts`, `scripts/ai-baseline/*` for the model evals

Family B:
- `lib/ai/assemblers/transactions.ts`: `resolveWindow`, partial-month predicate
- `lib/ai/intelligence/annotations/metrics.ts`: `reliableMonths`, `computeMonthlySpendingBasis`
- `lib/forecast/observed-spending.ts`
- `lib/ai/forecast/assemble.ts`
- `lib/ai/measures/{period,baseline}.ts`
- `app/api/spaces/[id]/expense-baseline/route.ts`
- `lib/liquidity/expense-baseline.ts`
- `lib/ai/intelligence/annotations/engine.ts`
- `lib/ai/brief/{load,package,prompt,policy}.ts`
- The test pins listed in §13.2

---

## 15. GO / GO WITH CONDITIONS / STOP

**GO WITH CONDITIONS.**
1. Family B ships **before** any family-A narration eval is trusted. Every scenario figure in an eval otherwise
   sits on the 2-month rate.
2. Family B lands behind its own tests 1–2 and 11 *first*. Today nothing asserts that the read yields 3 months.
3. Do not widen `ASSESSMENT_WINDOW_DAYS` (the W4 pin, activity-frame deletion). Use an explicit calendar window
   for baseline reads.
4. Retrieve the real transcript (or re-run it on a seeded dogfood) to settle the **[needs transcript]** items
   (A8, whether `assumedMonthlySpending` was sent) before claiming them as defects.
5. Bump `BRIEF_GENERATION_VERSION` with B1. Historical Daily Briefs are not touched.

## 16. Recommended first slice

**B1 + B2 + B5 (spending baseline window), as one slice:**
- `canonicalSpendingMonths(asOf)` + explicit calendar read
- month-end fix
- `months` echoed in `assumptionsInForce.spending`, the expense-baseline label, and the Brief `behavior`

It is the only defect here that changes **money** on every surface, and it is a precondition for measuring
anything in family A.

**Second slice: A1 + A3 + A6 (return representation).** Add `returnRepresentation` from `growthFactor`,
`returnAtSolution` / `horizon`, the outcome kind, and period-terms bracket disclosure. All deterministic and
pinned by the §12 vectors. Then A4/A5 description changes with a paired model eval. A7 (goal capture) comes third.
