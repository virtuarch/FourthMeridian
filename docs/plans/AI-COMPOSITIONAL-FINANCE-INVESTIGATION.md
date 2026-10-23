# General compositional financial reasoning — investigation

**Date:** 2026-09-14 · **Investigation only. No production code, prompt, tool or schema changed.**
Authority: 0d80404 (liquidFloor), 201be37 (checkpoint contract), f070f6d (elapsed + evidence rule),
4c6d6ab (bounded project_cash). Harness and probe outputs under `tmp/floor/` (uncommitted).

> ## Verdict: PARTIALLY COMPOSABLE
>
> Fourth Meridian already has a real algebra, not a list of handlers. Seventeen tools expose
> **six primitive classes** — state, flow/behaviour, history, transformation, allocation, and
> temporal predicate/solve — over **one cash spine and one ledger**, with one assumption language
> shared by three scenario tools and carried verbatim in conversation state. Measured live:
> three unrelated phrasings of "keep $50k and invest the rest" compiled to byte-identical
> arguments; a car purchase, a market shock, a goal seek, a debt-free date and a net-worth change
> each resolved to one deterministic call; a raise the engine cannot take was refused and
> labelled rather than faked.
>
> What is missing is not tools. It is **three transformation classes the ledger cannot express**
> — a liability that changes (payments, interest, payoff), an income stream that changes (raise,
> new job, loss), and a spending line that changes by category — plus **one measure class**
> (period-over-period comparison and a named "monthly surplus"), without which the model does its
> own arithmetic in prose. Every one of those showed up in the probe as either a refusal, a
> model-side multiplication, or a structurally wrong answer waiting to happen: for any user who
> actually owes money, "when will I be debt free?" today returns *never within 30 years*, because
> debt is held flat.
>
> The scenario ledger is the right substrate and should grow those lines. No DSL, no router, no
> mega-tool. Four primitive classes, in that order, would move the answer to the architecture
> test from "when the question is cash-and-investments shaped" to "when the meaning can be
> composed from state, flow, transformation and predicate".

---

## 1. Current primitive inventory

Traced from `lib/ai/conversation/tools.ts`, `memory-tools.ts`, `scenario-ledger.ts`,
`scenario-crossing.ts`, `scenario-checkpoints.ts`, `active-scenario.ts`, `lib/ai/forecast/
assemble.ts`, `lib/forecast/*`, `lib/ai/assemblers/*`, and the live schema dump (17 tools,
33,470 B of schema).

| tool | concept | deterministic authority | evidence authority | temporal semantics | ceiling / asOf | scenario-compatible | limits |
|---|---|---|---|---|---|---|---|
| `get_financial_snapshot` | STATE at a date | accounts composer; `historicalSnapshot` for past | accounts + snapshot history | instant | `asOf` past ⇒ snapshot with coverage; today ⇒ live + APR/min/freshness | opening of every scenario | debt terms often null ⇒ `missingDebtFields` (knowledge gap) |
| `get_net_worth_history` | STATE over time + CHANGE | `observedChange` (first vs last observation) | snapshot history | range; monthly/daily; downsampled | `clampToCeiling`; nulls carry reasons; `coverage` | — | downsampling ⇒ exact dates via `find_in_balance_history` |
| `find_in_balance_history` | TEMPORAL PREDICATE on history | scan of every observation | snapshot history | first/last above/below, min/max | ceiling; `coverage` | — | one metric per call |
| `explain_net_worth_composition` | STATE decomposed | lens tree | accounts/snapshots | instant | clamped | — | composition, never change |
| `get_transactions` | FLOW evidence (rows) | query + `countTransactions` | ledger rows | window; flow kind; sort | ceiling; `coverage`; `COMPLETABLE_SEARCH_ROWS` | — | 50/page; `moreAvailable` must be read |
| `get_spending` | FLOW measures | economic fold (`foldEconomicRow`) | transactions | any window ≤ 26 mo; by month/category/merchant; `monthlySpending.mean` over whole months | ceiling | spine's spending rate is the same fold | no period-vs-period comparison in one call |
| `get_income` | FLOW + BEHAVIOUR (cadence) | stream activity licence | transactions + streams | 12 mo; per-source cadence, typical amount, still-paying | ceiling; streams reconstructed at asOf | spine's income events | no income *change* input anywhere |
| `get_investments` | STATE (holdings) | `composeInvestments`; priced subset | holdings + prices | instant | past ⇒ snapshot | opening investments | no per-holding scenario |
| `get_pay_dates` | BEHAVIOUR projected | cadence → occurrences | streams | next N | licence-gated | — | — |
| `project_cash` | TRANSFORMATION: baseline cash path | `assembleForecast` → `forecastCash` (accrual + licensed events) | streams + observed spending + accounts | horizon; planned checkpoints; `elapsed` | `asOf` retrospective mode | **the spine** | only assumption: `assumedMonthlySpending`; obligations module exists but is unwired; ONE_OFF_EVENT statements exist in the engine but are not exposed here |
| `investment_scenario` | TRANSFORMATION: instantaneous % move | arithmetic | holdings | **today only** | — | not composable with a horizon | cannot date a shock |
| `scenario_projection` | TRANSFORMATION + ALLOCATION over a horizon | ledger over the spine | spine + accounts | planned checkpoints | asOf = today | **is** the scenario | debt & other assets held flat; no income change; no category spending change |
| `scenario_crossing` | TEMPORAL PREDICATE on a scenario | month-end walk | same | first crossing; `elapsed` | 30-yr wall | same inputs | metric ∈ {netWorth, liquid, investments, debt, otherAssets} — debt never moves |
| `scenario_goal_seek` | SOLVE (one unknown) | bisection over the ledger | same | by date; `timeToTarget` | — | same inputs | one lever: return, monthly contribution, spending cut |
| `reconcile_projection` | COMPARISON: said vs happened | snapshot vs checkpoint | memory + snapshots | past/future horizons | — | — | project_cash checkpoints only |
| `recall` / `remember` | MEMORY | closed payload keys | SpaceMemory | applies-from/to | — | ASSUMPTION payload = monthlySpending or annualReturnPct only | no floor/allocation/goal-rule payload |

**Assumption language** (`SCENARIO_INPUTS`, shared by three tools, carried verbatim in the
envelope): `annualReturnPct | returns[]`, `contributions[]` with four bases (`amount`,
`fractionOfLiquid`, `surplusFraction`, `liquidFloor`+`fractionOfExcess`), `outflows[]` (signed
one-offs), `assumedMonthlySpending`, `granularity`, plus the predicate/solve heads.

**The ledger's lines** (`runScenarioLedger`): `liquid = spine − outflows − contributions`;
`investments = opening × G + Σ c × G(c.date, d)`; `debt = opening` (flat); `otherAssets =
opening` (flat). That single fact drives most of §5.

**Forecast engine statements the engine can take but the tools do not expose** (`lib/forecast/
policy.ts` `StatementSubject`): `STREAM_CONTINUES`, `STREAM_AMOUNT_BASIS`, `EVENT_AMOUNT_BASIS`,
`ONE_OFF_EVENT`. Only `SPENDING_LEVEL` reaches the conversation. There is **no** statement kind
for an income amount change.

**Orientation** (every turn, `thinCore`): current position, 90-day flow frame, 6-month activity
frame, history summary, signals, up to 8 intentions and 6 checkpoints from memory.

## 2. Current compositional model

Composition today happens in exactly one place: **the argument object of a scenario tool**. A
question is compiled by the model into one of three heads (project to date / find crossing /
solve for X) over one assumption set, and the ledger composes state (opening), behaviour (the
spine), transformation (outflows, spending level, returns) and allocation (contribution rules)
into checkpoints. Predicates and solves read those checkpoints. Everything else composes only
in the model's head: a read tool's payload is evidence the model reasons over in prose.

That is a real algebra with a small grammar:

```
scenario := head × opening × spine(spendingLevel?) × outflows* × contributions* × returns
head     := project(to, cadence) | cross(metric, dir, threshold) | seek(target, by, lever)
```

Measured properties of the grammar: conservation (0.00 at 0% over 361 checkpoints), one spine
(`assembleForecast` call-site count = 1), one setup, one presenter, arguments-are-identity
(envelope), explicit omission, elapsed on every produced date.

## 3. Supported reasoning classes (measured, one-turn probes, real Space, gpt-5.1)

| class | probe | result |
|---|---|---|
| STATE (now / at date) | why-change, afford-house | exact |
| FLOW measures | cut-dining, afford-vacation | exact reads; arithmetic on them done in prose (§9) |
| BEHAVIOUR (cadence, pattern) | raise (read side) | exact |
| HISTORY + CHANGE | why-change | exact components; causal narrative labelled "patterns, not exact causes" |
| TRANSFORMATION: one-off outflow | car ($60k, 2027-04-15) | exact, one call |
| TRANSFORMATION: instantaneous shock | shock (−30% both buckets) | exact, today only |
| ALLOCATION: floor rule | floor-1/2/3, six-months | exact; identical args across phrasings |
| TEMPORAL PREDICATE on scenario | floor-*, debt-free | exact |
| SOLVE | goal-seek | exact for one lever; the model chose spending-cut at 0% and reported infeasible honestly |
| JUDGMENT | cash-keep, afford-vacation, afford-house | model, mostly labelled; two answers made **no tool call** |

## 4. Missing primitive classes

Findings are classes, not questions. Each names why composition fails today.

### 4.1 Liability dynamics (payments, interest, payoff)
Debt is a flat line in the ledger. Nothing pays it, nothing accrues on it, no rule can direct
cash to it, and `scenario_crossing{debt ≤ 0}` on a user with debt returns "not within 30 years".
Unlocks: "when will I be debt free", "pay the card off or invest", "snowball vs avalanche",
"interest avoided if I add $500/month", "keep $X liquid and put the rest on the 24% card", "what
does a $320k mortgage do to my cash", "buy the car on a loan". Why composition fails: no
contribution basis targets a liability, no line accrues, no obligation enters the spine
(`obligation.ts` is unwired by design pending debt-term evidence). Smallest contract: a
liability line with `{ balance, apr?, minimumPayment? }` from the accounts authority, an
`allocation` target of `investments | liability(id) | 'highest_apr'`, monthly interest accrual
at ACT/365 when APR is known, and **refusal with a knowledge gap when it is not** (the existing
`missingDebtFields` path). Belongs in code (ledger) + data authority (terms). Interacts with
every existing rule: a floor rule whose target is a liability is the "pay above the floor"
policy; a crossing on `debt` becomes meaningful; goal seek gains a lever.

### 4.2 Income change (stream override from a date)
The engine has `STREAM_CONTINUES` and `STREAM_AMOUNT_BASIS` but no way to say "this stream pays
10% more from January". Live: the model said so and gave a labelled range; in the Slice C probe
it twice reached for a `returns` period from 2028 as a proxy. Unlocks: raise, new job, second
income, job loss, part-time, bonus that repeats, retirement start/stop, benefit changes. Why
composition fails: `outflows` is one-off and cash-only; `assumedMonthlySpending` is the wrong
side. Smallest contract: `incomeChanges: [{ source?, from, to?, multiplier | amountPerPeriod |
stop }]` compiled to a forecast statement on the stream, so the spine — not the ledger — moves.
Belongs in the forecast policy (statement kind) + a pass-through in `buildCashSpine`. Interacts
cleanly: a spine change is upstream of every rule; goal seek can solve over it.

### 4.3 Category spending change
`assumedMonthlySpending` replaces the whole level; "stop eating out" or "rent goes up $400" has
no representation, so the model multiplied $806 × 12 in prose. Unlocks: cut a category, rent
change, subscription change, childcare starts/ends, "what if I spend $500 less", tuition as
recurring. Why composition fails: one scalar level, no per-category delta, no dated recurring
outflow. Smallest contract: `spendingChanges: [{ category? | label, from, to?, delta |
level }]` applied to the observed daily rate (delta) or as a dated recurring event. Belongs in
the forecast policy as `SPENDING_LEVEL` generalised to a dated delta, kept conservation-clean
because it enters the spine. The measured-vs-assumed spending distinction (§9) must ride with
it.

### 4.4 Deterministic measures: period comparison and named surplus
"Am I spending more than I used to?" and "how much cash should I keep?" made **zero tool
calls**: the model computed $42,297.80 ÷ 185 in prose and compared a 90-day window against the
6-month window that contains it. `get_spending` can produce both periods but not the
comparison, and no tool says what "monthly surplus" is — the orientation shows four different
monthly-spending figures for the same Space (90-day 4,609; 6-month 7,050; complete-month mean
4,346, which the spine uses; 12-month 7,000). Unlocks: "more than last year", "savings rate",
"burn rate", "runway", "am I saving enough", "what changed in my spending", and every derived
threshold in §13. Why composition fails: measures exist in code (`clampEconomicSpend`,
`computeAverageMonthlySpending`, `resolveExpenseBaseline`, `compareToForPreset` in the activity
frame) but are not exposed as a comparison with a declared basis. Smallest contract: a
`compare_periods` head on `get_spending`/`get_income` (`period`, `compareTo: previous | same
period last year | custom`) returning both windows and the delta from one fold, plus a
`measures` block naming `monthlySurplus` (income events − spending rate, the spine's own
definition), `savingsRate`, and `runwayMonths` with `basis: DECLARED | MEASURED` exactly as
`expense-baseline.ts` already does for the product. Belongs in evidence retrieval, not the
ledger.

### 4.5 Dated portfolio shock (not a new engine)
`investment_scenario` is today-only; "what if the market drops 30% next month" cannot be
placed on the path. This is **expressible as a returns period** in the existing ledger (a
one-month period with the equivalent annual rate) and needs at most a presentation-level
`shocks: [{ on, pct, component? }]` that compiles to per-component growth. Convenience-adjacent;
ranked last.

Rejected as convenience wrappers: an affordability tool, a house/car/vacation tool, a budget
tool, an emergency-fund tool. Each is a composition of the classes above plus judgment (§7).

## 5. Semantic-compilation findings

Measured on the shipped runtime, one turn each:

- **Wording invariance holds where the contract exists.** "Keep fifty grand around and invest the
  rest", "I don't want my checking and savings below $50k, but anything past that can go into
  the market", "Anything over fifty can go into the market" → all three `{liquidFloor: 50000,
  fractionOfExcess: 1, annualReturnPct: 7}`, same crossing (2035-02-28), no `from`, no surplus
  substitution. The unit of "fifty" was inferred from context correctly.
- **Derived thresholds are compiled by the model with a measure tool.** "Six months of expenses"
  → `get_spending` (12 months) → 6 × 7,000.42 = `liquidFloor: 42002.52`. Correct shape, but the
  measure chosen (12-month all-in average) differs from the spine's 4,346 and from the product's
  `resolveExpenseBaseline`; the envelope stores the literal, so "what if my expenses rise?"
  cannot recompute it (§13).
- **Unrepresentable conditions are now refused, mostly.** Raise: "I'd need a scenario tool that
  lets me modify future income levels, which this toolkit doesn't" + labelled range. Debt
  priority on a debt-free user: correctly said already satisfied. The residual (Slice C probe):
  1 in 3 still narrates a proxy as the condition.
- **What the model may infer safely:** units, dates ("next April" → 2027-04-15), the metric
  ("millionaire" → netWorth ≥ 1M), the direction, inherited assumptions from the envelope.
- **What must be asked or labelled:** a rate the user did not state (labelled illustration —
  Slice C rule, unchanged); a floor the user did not state ("how much cash should I keep" is
  judgment, and was answered as such); financing terms (rate, term) for a purchase.
- **What must never be invented:** figures at dates not returned (now structurally rare); a
  proxy presented as the stated condition (residual, instruction-only defence).
- **What existing evidence resolves automatically:** memory intentions ($750k by 2029, "invest
  half my surplus") surfaced unprompted in 6 of 16 answers via the orientation; debt terms via
  `missingDebtFields`.

No regex is needed anywhere in this path. The failures are contract gaps, not parsing gaps.

## 6. Affordability findings

"Can I afford X" decomposed on the two live cases (vacation, house):

| requirement | authority today | class |
|---|---|---|
| current liquidity | snapshot | deterministic |
| future cash at the date | `project_cash` / scenario with the outflow | deterministic |
| recurring obligations | **not in the spine** (obligation module unwired) | gap 4.1 |
| debt after the purchase (financed) | **none** | gap 4.1 |
| emergency reserve | floor rule + memory intention (if stated) | deterministic given a threshold; threshold itself is §13 |
| purchase timing | `outflows.onDate` | deterministic |
| one-time vs financed | one-time yes; financed no | gap 4.1 |
| user goals | memory intentions | conversation/memory |
| opportunity cost | scenario with/without at a stated return | deterministic, labelled |
| scenario risk | returns periods / shock | deterministic, labelled |
| subjective comfort | model | judgment |

The house answer shows the boundary precisely: the deterministic part (cash, income cadence,
holdings) was read; the missing part (mortgage payment, DTI) was answered from general
knowledge with hedges. With 4.1 and a floor rule the same question becomes: outflow (down
payment) + liability (mortgage) + obligation (payment) + crossing (liquid ≥ reserve) + judgment.
No affordability tool is warranted.

## 7. Debt findings

Currently possible: today's balances, APR/minimum where present (with explicit gaps),
historical payoff dates via `find_in_balance_history`, and the debt line in scenarios — flat.
Not possible: payoff ordering, amortisation, payoff date under payments, interest avoided,
liquidity-preserving paydown, refinancing, a financed purchase. Minimum classes: **4.1** with
its refusal path for unknown terms. Explicit non-goals: minimum-payment inference from history
(the annotation layer already refuses this: "minimum-payment data is too often null").

## 8. Income / spending / budgeting findings

Observed spending, trends by month, categories, merchants, recurring candidates, cadence and
per-source income are all deterministic reads. Salary change, bonus-as-recurring, category
overrides, rent change, savings rate and budget constraints are not representable (4.2, 4.3,
4.4). The four monthly-spending figures on one Space are the concrete evidence that a named
MEASURE contract with a declared basis is missing: the model picked 12-month all-in for the
six-month reserve, the spine uses the 2-complete-month economic mean, the orientation shows a
90-day and a 185-day frame, and the Slice A investigation's "$8,000/month" came from dividing a
7-paycheck window by 3. Semantic ownership should be: **spine rate = projection assumption**,
**measured averages = evidence with window and basis**, **user-stated level = assumption**;
each named where it is read.

## 9. Purchase / event findings

| event | expressible today | via |
|---|---|---|
| buy a car (cash), tuition, medical bill, wedding, down payment | yes | `outflows` |
| bonus, inheritance, sale proceeds (one-off) | yes | negative `outflows` |
| sell an investment | partly | negative contribution moves money out of investments; no tax, no holding selection |
| financed purchase | no | 4.1 |
| salary increase, new job, job loss | no | 4.2 |
| move apartments (rent delta), subscription change | no | 4.3 |
| recurring one-off (tuition each August) | clumsy | repeated `outflows` entries |

The engine's own `ONE_OFF_EVENT` statement (FORECAST-17) duplicates what `outflows` does in the
ledger; that is fine as long as the tool path stays on the ledger side (conservation-tested).

## 10. Investment findings

Facts (composition, concentration with population, priced subset) are exact. Scenario
arithmetic: flat or per-period returns on the whole pot, contributions in four bases,
withdrawals as negative amounts, instantaneous shock today. Missing transformations: returns by
component (crypto vs traditional), dated shock on the path (4.5), rebalancing (an allocation
between investment lines — not needed until returns are per component), withdrawals as a rule
(retiree: "draw 4% a year" is `fractionOfLiquid`'s mirror on investments — a small basis
addition to the same union). Judgment (risk, "too concentrated") is the model's and was
delivered as such. No market forecast is produced anywhere; the default 0% and the labelled
illustration rule are the right posture and must survive any extension.

## 11. Historical / causal findings

`get_net_worth_history.change` + `find_in_balance_history` + `get_transactions` compose
sufficiently for "what changed", "when", and "where did it go"; the why-change answer separated
measured components from "patterns, not exact causes". The remaining causal gap is retrieval
coverage (page/window — closed in 55a2c22/1b83384), not a missing class. No causal classifier.

## 12. Derived-constraint findings

Two viable designs for "six months of expenses", "20% of income", "one paycheck":

| | model computes with a measure tool, engine takes a literal | small derived-threshold contract |
|---|---|---|
| identity across turns | lost — envelope holds `42002.52` | kept — `{ months: 6, of: 'monthlySpending', basis }` |
| recomputation on assumption change | no | yes (spine-consistent) |
| basis ambiguity | model chooses among four figures | declared once, echoed |
| engine complexity | none | one resolver, no new arithmetic |
| generality | any expression | only the named measures |

Recommendation: keep literals as the engine's floor input **and** add a tiny resolver that turns
`{ monthsOfSpending: 6 }` / `{ monthsOfIncome: 1 }` into a literal **inside the tool**, echoing
the measure and basis it used (`resolveExpenseBaseline` precedence: DECLARED > MEASURED). That
is a measure contract (4.4) plus one field on the floor rule, not a DSL. It preserves semantic
identity without letting the model choose the wrong average.

## 13. Phase-transition findings

"After debt reaches zero, start investing" / "once savings hits six months, redirect surplus":
the liquid-floor experience says two-stage crossing-then-scenario **loses identity and drifts**
(crossing-month excess, unrebuilt floor). The right representation is the same one liquidFloor
used: a rule whose eligibility is read from the ledger's own running state each month. For debt:
`{ liquidFloor, fractionOfExcess, target: 'highest_apr' }` pays debt while any exists and, when
the liability line is zero, the same excess has nowhere to go but investments — the phase
transition is a consequence of state, not a scripted event. That needs 4.1, not a phase
primitive. A generic conditional DSL is not required for any policy in this document.

## 14. Conversation-state findings

The envelope (arguments verbatim + six figures) carried floor/return/target revisions correctly
across 30+ measured follow-ups, and a baseline crossing no longer evicts it. It is scenario-
ledger-specific by construction, and that is correct: every future transformation in §4 enters
through `SCENARIO_INPUTS` and is therefore carried for free. Two limits worth recording: (a) a
result-bearing follow-up that changes the *spine* (raise, rent) will need the new field on the
same object — no redesign; (b) horizon is echoed (`assumptionsInForce.horizon`) but a
"what about February?" still depends on the model re-passing `to` — measured fine, keep. Do not
redesign.

## 15. Memory findings

Classification of the examples: "keep six months" = durable **preference/rule** (not
representable in `ASSUMPTION` payload today); "buy a house next year" = **INTENTION** (planned
outlay, representable); "never below $20k" = durable **rule**; "invest 25% of every paycheck" =
durable **allocation rule**. The closed `ASSUMPTION` payload (`monthlySpending`,
`annualReturnPct`) predates the allocation language. The minimal, still-closed extension is an
`INTENTION` payload variant carrying one `SCENARIO_INPUTS` contribution rule — the same object
the envelope carries — so a durable rule and a hypothetical rule are one shape. Not urgent:
memory intentions already surface unprompted in 6 of 16 probe answers. Financial facts stay
out of memory (existing invariant).

## 16. Information-ceiling findings

Every read tool clamps `to` to the ceiling and reports coverage; `project_cash` and the
snapshot support retrospective `asOf`; `find_in_balance_history` scans every observation. Two
cross-tool mismatches: (1) the scenario tools have no `asOf` (always today) while `project_cash`
does — a retrospective scenario would leak today's opening; acceptable as long as it stays
unexposed, but should be stated in the contract; (2) the orientation's 90-day window starts one
day earlier than `get_spending`'s default (24,149.76 vs 24,219.25 for "net cash flow, last 90
days"). Neither composition can create future leakage today because the ledger reads only the
spine and the accounts opening.

## 17. Model / code / data / state / memory boundary

| reasoning | owner |
|---|---|
| what "keep some cash around", "the market", "next April" mean | MODEL |
| which head (project / when / what would it take) | MODEL |
| choosing an unstated rate or share, labelled | MODEL |
| deriving a threshold from a measure | CODE (resolver) once 4.4 exists; MODEL today |
| every projected figure at a date; excess above a floor; crossing; solve; elapsed | CODE |
| conservation, ordering, refusal of malformed rules | CODE |
| today's balances, terms, holdings, transactions, cadence | DATA AUTHORITY |
| whether a debt term is known | DATA AUTHORITY (knowledge gap) |
| the assumptions currently in force and their last result | CONVERSATION STATE |
| durable goals, planned outlays, standing rules | MEMORY |
| "that seems too aggressive", "you're concentrated", comfort, affordability verdict | MODEL |
| future market outcomes | UNKNOWN — scenario assumption, never forecast |
| an unrepresentable condition | MODEL must say so; CODE must have no proxy field to abuse |

## 18. Generality corpus results

Twelve personas × natural multi-concept questions, classified against the inventory (live
where the real Space could exercise it; analytic otherwise, since only one real Space exists):

| persona | question | class |
|---|---|---|
| debt-heavy | "When am I debt free if I add $400/month to the highest card?" | MISSING PRIMITIVE (4.1) |
| debt-heavy | "Pay off or invest?" | MISSING PRIMITIVE (4.1) + judgment |
| high-income/high-spend | "Where is all my money going?" | SUPPORTED EXACTLY |
| high-income/high-spend | "What if I cap dining at $500?" | MISSING PRIMITIVE (4.3) |
| irregular income | "Can I afford $3k in December?" | SUPPORTED WITH MODEL JUDGMENT (spine licence handles cadence; irregular streams may be unlicensed ⇒ INSUFFICIENT EVIDENCE) |
| paycheck-to-paycheck | "How many months could I last?" | SUPPORTED WITH MODEL JUDGMENT; runway measure is a 4.4 gap |
| investor, little cash | "Keep one paycheck in checking, invest the rest" | REQUIRES CLARIFICATION (which paycheck) → floor rule with derived threshold (§12) |
| retiree | "Draw 4% a year — when does it run out?" | MISSING PRIMITIVE (withdrawal rule on investments; small basis addition) |
| saving for a house | "$80k down by 2028 — on track?" | SUPPORTED EXACTLY (crossing liquid ≥ 80k) + memory intention |
| large purchase | "$60k car next April" | SUPPORTED EXACTLY; financed variant MISSING (4.1) |
| incomplete debt terms | "What's my payoff date?" | INSUFFICIENT EVIDENCE — must stay explicit (`missingDebtFields`) |
| multiple goals | "$1M by 2035 and a house in 2028" | SUPPORTED AS LABELLED SCENARIO (outflow + crossing) |
| volatile crypto | "If BTC halves, am I still on track?" | SUPPORTED EXACTLY today-only; dated shock is 4.5 |
| retrospective | "Why did my net worth fall in March?" | SUPPORTED WITH MODEL JUDGMENT |
| retrospective | "What would you have predicted in January?" | SUPPORTED EXACTLY (`project_cash asOf`) |

Sixteen live probes: 7 exact, 4 with judgment, 2 refused honestly (raise, financed house), 2
answered with model arithmetic and no tool (trend, cash-keep), 1 exact-but-degenerate on this
Space (debt-free). The structural gaps cluster on liabilities, income change, category
spending, and comparison measures.

## 19. Adversarial composition results

| composition | outcome |
|---|---|
| floor rule + surplus rule on one date | ordered, second reads what the first left; cash can end under the floor (surplus is a flow) — reported, not clamped |
| one-off inflow + floor | swept the same month, conserved |
| one-off outflow below floor | rule pauses, no sale, conserved |
| goal seek + floor rule | solves return over the rule (6.97% for the 7% crossing's date) |
| baseline crossing inside a hypothetical | no longer evicts (IGNORE) |
| horizon change mid-conversation | echoed in `assumptionsInForce.horizon`; the 81.4%-vs-82% class is visible, not prevented |
| debt + allocation | **unsupported** — debt flat |
| raise + floor | **unsupported** — proxy risk (returns period used as a raise in 3 of 6 Slice C trials) |
| shock + purchase | shock is today-only; cannot be placed on the path with the purchase |
| conflicting populations | `liquid` vs `checking` distinction is explicit everywhere; investment population stated per figure |
| double counting | outflows enter the ledger, never the spine — a surplus rule does not see a scenario outflow (documented; a floor rule does) |
| information leakage | scenario tools have no `asOf` — no retrospective scenario possible, so no leak |

## 20. Scenario-ledger verdict

The ledger is a **line composer over one spine** with the properties that matter (independence
from opening, conservation, explicit rejection, one identity). It is investment/cash-centric
today only because two of its four lines are constants. Extending it means: a liability line
with accrual and a contribution target (4.1); spine-side income and category changes (4.2, 4.3,
entering through the forecast policy so `project_cash` and scenarios stay one spine); a
withdrawal basis on investments. None of that changes the composer, the settle ordering, the
checkpoint plan, the crossing walk, the solver or the envelope. No second engine is warranted.

## 21. Tool-surface recommendation

Measured: the model selected the correct scenario head in 100% of scenario-shaped probes; the
shared `SCENARIO_INPUTS` (≈6 KB per tool, 18 KB of the 33 KB schema) did not cause misuse; the
one measured misuse pattern is **reaching for the nearest field when the right one is absent**
(surplus for floor before Slice A, returns for a raise now). That argues for **few broad heads
over one assumption language**, growing the language (new bases, new spine statements) rather
than the head count, and for read tools to grow *measure/comparison heads* rather than new
tools. Two cautions: keep field descriptions saying what the field is *not* for (the measured
fix in 7859d6c and bca5119), and cap the shared block — a fifth base is fine, a twentieth is a
DSL.

## 22. Architectures rejected

- **Giant intent taxonomy / per-turn router**: the three floor phrasings prove the model already
  compiles meaning when a contract exists; a router would add a second, worse compiler.
- **Giant system prompt**: 234 words today; the measured fixes were contracts, not doctrine.
- **Generic financial DSL exposed to the model**: every policy examined decomposes into
  state-read rules (floor, target) plus spine statements; a DSL would move arithmetic
  semantics into model-authored programs the ledger cannot verify.
- **One mega-tool**: the three heads are different questions; merging them lost nothing measured
  and would blur the when/how-much/what-would-it-take boundary the descriptions now enforce.
- **Dozens of question-specific tools**: affordability, house, car, vacation, budget — all
  compositions of §4 classes plus judgment.
- **Model-only arithmetic**: the two zero-call probes are the residual and are the reason for 4.4.
- **Deterministic prose/rule engine** and **second-pass LLM verifier**: the offline traceability
  scorer found 0 fabricated rows across 210+97+101 table rows once evidence existed; runtime
  policing would guard a failure that structure already removed.

## 23. Ranked next primitive classes

1. **Liability dynamics** (4.1) — unlocks the entire debt class and financed purchases;
   contract: liability line with balance/APR/minimum, accrual, `target` on contribution rules,
   refusal on unknown terms; risk: term evidence quality; scope: ledger line + settle target +
   crossing metric already exists + goal-seek lever; ≈ Slice A sized. Generality: 30+ shapes.
2. **Income change as a spine statement** (4.2) — unlocks raise/loss/new-job/second-income
   questions and stops the returns-proxy; contract: `incomeChanges[]` → `STREAM_AMOUNT_CHANGE`
   statement; risk: basis (gross/net) interplay with FORECAST-9A; scope: policy statement +
   pass-through + echo. Generality: 20+ shapes.
3. **Deterministic measures and period comparison** (4.4, with the §12 resolver) — removes
   model arithmetic from spending/income questions and gives derived thresholds an identity;
   contract: `compareTo` on the flow reads + `measures` with basis; scope: assembler-level,
   no ledger change. Generality: 25+ shapes.
4. **Category / recurring spending change** (4.3) — unlocks budgeting what-ifs; contract:
   `spendingChanges[]` as dated deltas on the spine rate; depends on 3 for the base figure.
5. **Dated shock and withdrawal basis** (4.5 + retiree drawdown) — small additions to the
   existing union; last.

## 24. Proposed slices

- **Slice L1 — liabilities in the ledger**: liability line from accounts terms, ACT/365 accrual,
  minimum payment as a spine obligation only when licensed, `target` on contribution rules,
  crossing on `debt` becomes live. Acceptance: synthetic amortisation cases, a debt-heavy
  fixture, refusal with knowledge gap on null APR; dogfood: "when am I debt free", "pay off or
  invest", "keep $10k and put the rest on the card".
- **Slice I1 — income change statement**: `incomeChanges[]` end to end, echo, envelope
  inheritance. Acceptance: spine equality outside the change window, conservation; dogfood: the
  raise question from the Slice C probe (target: 0 proxies in 6).
- **Slice M1 — measures + comparison**: `compareTo` and `measures{basis}` on `get_spending` /
  `get_income`, `{ monthsOfSpending }` resolver on the floor rule. Acceptance: the four-figure
  Space yields one declared basis per figure; dogfood: "am I spending more than I used to",
  "six months of expenses" (identity survives "what if my expenses rise").
- **Slice S1 — spending changes**: dated category deltas. Acceptance: spine equality outside
  the window; dogfood: "stop eating out", "rent goes up $400".
- Each slice: one capability, deterministic check script in `scripts/ai-baseline/`, no prompt
  growth, envelope unchanged.

## 25. Final architecture test

What determines whether a never-seen, reasonable question can be answered today: **whether its
meaning decomposes into a state read, a flow measure, a one-off or level transformation on cash,
an allocation from cash to investments, a return, and a predicate or solve over that path.**
Inside that space the answer is composed, not anticipated — the probe's floor phrasings, the car,
the goal seek and the debt-free date were never individually engineered. Outside it — anything
that moves a liability, an income stream, or one spending line — the system now refuses or
narrates, which is the honest failure but still a failure. Closing the four classes above moves
the boundary from "cash-and-investments shaped" to "state, flow, transformation, predicate
shaped", which is where most ordinary personal-finance questions live.

**Overall: PARTIALLY COMPOSABLE** — composable within one substrate with a proven grammar;
three transformation classes and one measure class short of general.
