# Measures & comparison (M1) — investigation

**Date:** 2026-09-16 · **Investigation only. No production code, prompt, tool or schema changed.**
Authority: a655b38 (HEAD), 2c59c04 (L1, untouched), 0d80404 (liquidFloor), docs/plans/AI-COMPOSITIONAL-FINANCE-INVESTIGATION.md §4.4/§12.
Probes and prototype under `tmp/m1/` (uncommitted): `figures.ts`, `figures2.ts`, `model-probe.ts`, `proto/{period,measure,baseline,synthetic,live,schema-size}.ts`, outputs in `tmp/m1/out/`.

> ## Verdict: READY TO IMPLEMENT M1 — as one coherent slice, with two measure-authority corrections folded into it
>
> Fourth Meridian already owns the money: one economic fold with four call sites, one period parser, one
> completeness vocabulary, one liquid authority, and a `partial`/`truncated` flag on every month. What it
> does not own is the **sentence between two numbers**. Measured today on the recovered Space, the shipped
> runtime answered "am I spending more than I used to", "what's my monthly surplus" and "what's my savings
> rate" with **zero tool calls**, dividing the orientation's 90-day and 185-day totals in prose (7,590/month
> surplus from a seven-paycheck window; a 60% savings rate; a 3-month window compared against the 6-month
> window that contains it). Four other questions got the right tool but a window the model chose alone —
> runway from three months (2.5 months) and "normal" from two (3.4 months) in the same session.
>
> The same Space exposes **five legitimate "monthly spending" figures** — 4,346 / 5,797 / 6,719 / 7,000 /
> 8,636 for 2, 3, 6, 12 and 24 complete months — and none of them is wrong. The missing primitive is a
> language in which a figure **names its window, its basis and its completeness**, a comparison is
> **computed rather than narrated**, and "six months of expenses" **keeps its identity** all the way into a
> scenario. The prototype under `tmp/m1/proto` does exactly that over the existing fold, the existing
> parser and the existing ledger: 47/47 synthetic checks across ten profiles, every live probe deterministic,
> the "$8k surplus" reproduced and explained (8,876 = a three-paycheck July; the cadence baseline gives
> 7,108), and both compositions — threshold → `liquidFloor`, threshold → `['highest_apr','investments']` —
> proven **with no ledger change**.
>
> Two things must be fixed in the same slice or the new head inherits them: the spine, the assessment and
> `get_spending` compute the measured baseline over the same window today by coincidence (all three see the
> 90-day assemble), while the Brief's `monthlyExpenses` bypasses the resolver and `impliedMonthlyIncome`
> divides by days; and no flow measure states whether the transaction record covered its window.

---

## 1. Tree safety

`git status`: no tracked modifications. Untracked peer work left untouched: ten `docs/audits/status-drift/`
files, five `docs/plans/*-INVESTIGATION.md` / recovery docs, `scripts/audit-visibility-levels.ts`. One
pre-existing stash (`stash@{0}` on `feature/phase-2-architecture`) not touched. No stash, reset, clean,
checkout or revert performed. All probes under `tmp/m1/`. Branch `v2.6` at a655b38.

## 2. Existing measure inventory

Traced across `lib/transactions/*`, `lib/ai/assemblers/transactions.ts`, `lib/ai/intelligence/annotations/*`,
`lib/liquidity/expense-baseline.ts`, `lib/forecast/*`, `lib/ai/conversation/*`, `lib/ai/brief/*`, Cash Flow
workspace components, and `scripts/audit-*`.

**One substrate.** `foldEconomicRow` (`lib/transactions/cash-flow.ts:299`) is the single economic fold —
`{SPENDING, FEE, INTEREST} → spendGross`, `REFUND → refunds`, `INCOME (minus NOT_INCOME) → income`;
`TRANSFER`, `DEBT_PAYMENT`, `INVESTMENT`, `ADJUSTMENT`, `UNKNOWN` fall through. Exactly four call sites,
enforced by `cash-flow-fold-authority.test.ts`. `clampEconomicSpend = max(0, gross − refunds)`.

| measure | authority | formula | window | deterministic | exposed |
|---|---|---|---|---|---|
| window spending (gross) | assembler `expenseTotal` (`transactions.ts:906`) | Σ cost flows | 90 d default; explicit ≤ 800 d | yes | `thinCore.recent`, `activity`, `get_spending.totals`, Brief |
| window spending (clamped) | `economicSpend` (`cash-flow-projection.ts:229`) | max(0, gross − refunds) | UI period | yes | Cash Flow "Spending" tile |
| net cash flow (economic) | `netCashFlow` (`transactions.ts:916`) | income − clamped spend | 90 d | yes | orientation, `get_spending`, assessment |
| net after debt payments | `netAfterDebtPayments` (`:917`) | above − debt payments | 90 d | yes | assessment `deficitCause` only |
| net cash flow (liquidity) | `perspectiveTotals(...,'liquidity')` | cashIn − cashOut | UI period | yes | Cash Flow hero (default perspective) |
| monthly spending mean #1 | `computeAverageMonthlySpending` (`metrics.ts:266`) | Σ reliable months / n, `!partial && !truncated`, ≥1 | 90 d ⇒ 2–3 months | yes | assessment, `/expense-baseline` route, Brief |
| monthly spending mean #2 | `deriveObservedSpendingRate` (`observed-spending.ts:118`) | last ≤3 reliable months / n | `WINDOW_MONTHS=3` over the 90-d assemble | yes | `project_cash`, `scenario_*` (the spine) |
| monthly spending mean #3 | `get_spending.monthlySpending.mean` (`tools.ts:363`) | whole months / n, `!partial` only, ≥2 | caller's window, default 90 d | yes | AI tool |
| monthly spending level #4 | `deriveSpendingBaseline` FORECAST-6 (`spending-baseline.ts:218`) | median of in-band 28-day periods, {SPENDING, FEE} only | unbounded | yes | engine `SpendingSource`; **UNKNOWN on the live Space** |
| rolling 3-mo average | `computeMetricTrend` (`metrics.ts:229`) | Σ last 3 / **literal 3** | 90 d | yes | trends |
| monthly income | `impliedMonthlyIncome` (`engine.ts:127`) | incomeTotal / windowDays × 30 | 90 d | yes | Brief `behavior.monthlyIncome` |
| monthly debt payments | `estimatedMonthlyDebtPayments` (`engine.ts:135`) | debtPaymentTotal / windowDays × 30 | 90 d | yes | Brief |
| income by month | `monthlyBreakdown[].incomeTotal` | fold per month | window | yes | `get_income.byMonth` |
| income cadence | `loadForecastIncomeStreams` | merchantKey@accountId, ≥3 obs, licence | 730 d | yes | `get_income.sources`, spine, `get_pay_dates` |
| category spending | `byCategory` / `monthlyBreakdown[].byCategory` | debit-only Σ, `SERIALIZED_SPENDING_FLOWS` (no INTEREST) | window | yes | `get_spending`, UI |
| recurring candidates | `buildRecurringCandidates` | merchants seen ≥2, mean amount | 90 d | yes | `get_spending.recurring` |
| expense baseline | `resolveExpenseBaseline` (`expense-baseline.ts:84`) | DECLARED > MEASURED > null | — | yes | assessment, Liquidity workspace |
| runway | `liquidityCoverageMonths` (`engine.ts:401`) + `LiquidityWorkspace.tsx:257` | totalLiquid / baseline; UNKNOWN on ≤0 | — | yes | Brief, Liquidity hero |
| savings rate | **none** — `SAVINGS_RATE` exists only as a licence name (`operating-state.ts:388`) | — | — | — | deleted from the Brief (BRIEF-1) |
| surplus | **none** — `surplusRule` is a contribution rule, not a measure | — | — | — | — |
| net-worth change | `observedChange` (`snapshot-window.ts:147`) | last − first, refuses same-day | any | yes | `get_net_worth_history.change`, Brief |
| investment contributions | `summarizePeriodFlows` (`investment-flows-core.ts:202`) | contributions + transfers in/out | period | yes | Investments workspace only |
| debt service (stock) | `computeDebtAggregate` (`debt/aggregates.ts:111`) | Σ minimums, weighted APR | now | yes | Debt KPIs |

**Duplicate/conflicting definitions** (all confirmed in code): four monthly-spending means with three
month-populations (`!partial&&!truncated` vs `!partial` vs 28-day) and three minimums (1 / 2 / 3); gross vs
clamped "spending" (AI frames vs UI tile, differing by `refundTotal`); income normalised by **30-day**
division while spending is a **calendar-month** mean; three "months" constants (30, 365/12, 365.2425/12);
runway with one denominator but two numerators (ledger `totalLiquid` vs `reachableNow`); "Net cash flow"
label on the liquidity hero vs `netCashFlow` meaning the economic net in every AI payload.

## 3. Conflicting spending semantics (re-measured 2026-09-16, recovered world)

`tmp/m1/out/figures-0916.log`, `live-0916b.log`. All from the one fold; every figure is legitimate.

| window | from..to | total | complete months | per complete month | note |
|---|---|---|---|---|---|
| last 2 complete months | 07-01..08-31 | 8,692.96 | 2 | **4,346.48** | the spine's figure; `get_spending` default; assessment MEASURED |
| last 3 complete months | 06-01..08-31 | 17,391.10 | 3 | **5,797.03** | what the model chose for "runway" |
| last 6 complete months | 03-01..08-31 | 40,312.00 | 6 | **6,718.67** | |
| last 12 complete months | 2025-09-01..08-31 | 84,005.01 | 12 | **7,000.42** | |
| last 24 complete months | 2024-09-01..08-31 | 207,272.36 | 24 | **8,636.35** | |
| PAST_QUARTER (90 d) | 06-17..09-16 | 15,353.73 | 2 (+2 partial) | 4,346.48 | total ÷ 3 = 5,118 — the prose figure |
| PAST_6_MONTHS (184 d) | 03-17..09-16 | 42,684.03 | 5 (+2 partial) | 7,194.02 | total ÷ 6 = 7,114 — the prose figure |
| orientation `recent` | 06-18..09-15 | 15,278.14 | — | — | no per-month figure; the model divided |
| orientation `activity` | 03-15..09-15 | 43,830.95 | — | — | same |
| August / July | | 6,402.93 / 2,290.03 | 1 / 1 | — | spread 2.8× inside the 2-month mean |

The dimensions that separate them, derived from the code: **window length**, **calendar completeness**
(whole months vs clipped), **central tendency** (mean vs FORECAST-6 median), **flow set** (INTEREST in or
out), **refund netting** (gross vs clamped), **declared vs measured**, **category scope**, **one-off
inclusion** (always included in every mean; FORECAST-6 alone excludes outliers), **transfer/debt-payment
treatment** (always excluded by the fold — this dimension does not actually vary), **partial-period
treatment** (excluded from means, included in totals). Income adds **paycheck count per window** (July held
three biweekly deposits: 15,865 vs 10,563).

## 4. Expense-baseline authority

`resolveExpenseBaseline` (`lib/liquidity/expense-baseline.ts:84-95`): bases `DECLARED | MEASURED`, precedence
DECLARED > MEASURED > `null` (a non-positive declared value falls through). DECLARED comes only from
`emergency_fund_progress.config.monthlyExpenses`; MEASURED is `computeAverageMonthlySpending` over the
assembler's 90-day window (≥1 reliable month, no cap). Provenance: `{ amount, basis }` + `describeExpenseBaseline`.
Consumers: assessment engine (`engine.ts:393`), `/api/spaces/[id]/expense-baseline`, Liquidity workspace/hero,
Wealth workspace pass-through.

**Not consumers, though they compute the same thing:** the forecast spine (`assemble.ts:400-419`, user statement
→ else `deriveObservedSpendingRate`), the scenario ledger (`tools.ts:1803`), the orientation (raw totals), the
Brief (`package.ts:233` reads the raw `computeAverageMonthlySpending`, so a Space with a DECLARED baseline
prints the MEASURED figure beside a DECLARED coverage). The engine's own precedence is the **inverse**
(`engine.ts:298-332`: authority over supposition unless COUNTERFACTUAL) but is unreachable in practice because
`assumedMonthlySpending` enters as `ASSERTS_FACT` and displaces the observed rate.

Verdict: **reuse `resolveExpenseBaseline`'s two rungs and add the third** — STATED (this conversation) —
in one resolver that the measure head, the scenario preparer and the Brief all call. No new resolver.

## 5. Measure vs baseline

- **MEASURE** = what happened over a requested period: total, per-complete-month, months, completeness. Code
  owns it entirely once `measure + period + category` are chosen. "How much did I spend in August" = measure.
- **BASELINE** = the representative rate for forward reasoning: `{ amount, basis, window }`. Code owns the
  resolution **given a basis**; the model owns the choice of basis and window, and must say which. "What's my
  normal spending" = the model asking for a baseline and choosing (or being told) the window.
- **DERIVED** = arithmetic over baselines and state: surplus, savings rate, runway, thresholds. Code owns it
  entirely; every result carries numerator and denominator.

Code never decides whether a lifestyle is "normal". It offers `completeMonths: N` and reports the spread
(`highest`, `lowest`) so the model can reason about it.

## 6. Declared vs measured

Three bases, always echoed, never substituted: `STATED` (this conversation; wins), `DECLARED` (product
setting), `MEASURED` (window named, complete-month count named). Income: `STATED`, `CADENCE` (licensed streams
at settled level — the spine's basis), `MEASURED` (complete-month mean). Prototype `baseline.ts`; §B of the
synthetic harness proves a stated 0 falls through and never becomes a silent zero.

## 7. Recommended named measures

| name | keep? | formula | basis carried | why |
|---|---|---|---|---|
| `spending` per period | yes (measure) | Σ cost flows; `perCompleteMonth` | window, completeness | already the fold |
| `income` per period | yes (measure) | Σ INCOME; `perCompleteMonth` | window, paycheck-count visible via months | |
| `economicNet` per period | yes (measure) | income − clamped spend | window | the honest name for the 90-day "net" |
| `monthlySurplus` | yes (derived) | incomeBaseline − expenseBaseline | both bases | §17 |
| `savingsRate` | yes, one definition | (incomeB − expenseB) / incomeB | both bases | §8 |
| `runwayMonths` | yes (derived) | liquid / expenseBaseline | expense basis | §9 |
| `burnRate` | **no** | = expense baseline | — | a synonym, not a measure |
| `cashFlow` | **no new name** | — | — | collides with the UI's liquidity net (§18) |

No per-question tools. All of the above are outputs of two heads (§21).

## 8. Savings-rate verdict

One definition only: **economic net as a share of observed income**, over baselines — `(incomeBaseline −
expenseBaseline) / incomeBaseline`, with `basis` stating that income is nominal deposits (not gross pay) and
that debt payments and investment contributions are allocations of the surplus, not deductions. Reasons: the
fold has no liquidity axis in the AI layer (cash in − cash out exists only in the UI DayFacts), so
"cash saved / income" cannot be computed honestly here; net-worth increase / income mixes market movement and is
a different question already answered by `get_net_worth_history.change`. Guard: require a recurring income
basis (`CADENCE` or `STATED`); a MEASURED income mean that is only interest (the retiree profile produced an
exact −2,817%) must refuse with "no recurring income level established". Live: 62.05% on the 2-month
baseline, 41.35% on the 6-month, 38.89% on the 12-month — the window is the answer, and the tool names it.

## 9. Runway verdict

`runwayMonths = liquid / expenseBaseline` where `liquid = totalLiquid` (checking + savings, `account-classifier.ts:251`,
the same authority as `get_financial_snapshot.liquid`). Investments and digital assets excluded (not liquid);
no `eligibleLiquid` or restricted-cash concept exists in the repo. Minimum debt service is **not** in the
baseline (the fold excludes DEBT_PAYMENT); when minimums are known a second figure `withMinimumDebtService`
ships beside it (on the live Space none are on record: 0 `DebtProfile` rows, `missingDebtFields` for both
cards). A zero/unknown baseline is `unavailable`, never Infinity (`engine.ts:360-385` doctrine). Live: 3.36
months on the 2-month baseline, 2.17 on 6-month, 2.09 on 12-month, 2.92 on a stated $5k.

## 10. Derived-threshold design

`{ monthsOfExpenses: 6 }` resolves in code to `{ rule: '6 months of expenses', monthsOfExpenses: 6, amount,
baseline: { amount, basis, window, completeMonths } }`. Identity preserved: the envelope can carry the rule,
and a later basis change recomputes the amount. No expression DSL: multiplier × one named baseline only.
Live: 6 months = 26,078.88 (MEASURED 2-mo), 40,312.02 (6-mo), 42,002.52 (12-mo), 30,000 (STATED 5k).

## 11. Comparison design

`compare(measure, period, compareTo, category?)`: two measures from the same fold; `comparedOn: 'total'`
when the windows have equal days or are both whole with equal month counts, else `'perCompleteMonth'`;
`change: { abs, pct | null, direction }` or `change: null` + `notComparable` when a side holds no whole month
and lengths differ; `completeness` = worst side; `caveats` name partial months. Period-vs-period only; a
baseline-vs-baseline comparison is two baseline calls and the model's sentence (§25).

## 12. Period semantics

Reuse `compareToForPreset` (the ONE parser; `financial-window.test.ts:109` fails the build on a second) for
`MTD | QTD | YTD | PAST_MONTH | PAST_QUARTER | PAST_6_MONTHS | PAST_YEAR`; add explicit calendar `month`,
`quarter`, `year` (as `ExplicitCashFlowPeriod` already models), `completeMonths: N`, and `from/to`. Pins:

| request | resolution |
|---|---|
| this month | `MTD` → 09-01..09-16, `TO_DATE`, partial |
| last month / previous month | `{ month: '2026-08' }`, whole |
| last 30 days | `{ from, to }` (no preset; `PAST_MONTH` is a *calendar* month, 08-17..09-16 = 31 d) |
| prior 30 days | `compareTo: 'PREVIOUS'` = the 30 days ending the day before |
| last 90 / previous 90 days | `PAST_QUARTER` (92 d) or explicit; PREVIOUS = same length before |
| trailing / prior six months | `PAST_6_MONTHS` + PREVIOUS |
| YTD / prior-year equivalent | `YTD` + `SAME_PERIOD_LAST_YEAR` (`subYears` both ends: 2025-01-01..2025-09-16) |
| complete calendar months | `completeMonths: N` — ends on the last month-end before the ceiling |
| partial current month | any window ending at the ceiling: `partialMonths` names it |

Rolling presets are FLOW-closed and exclusive of the anchor day (`addDaysISO(start, 1)`), so PAST_MONTH on 09-16
is 08-17..09-16, never 08-16..09-16 — the model-probe's own comparison used the latter (32-day windows).

## 13. Partial-period semantics

Rule: **`PREVIOUS` on a to-date or ceiling-clamped period = the same elapsed days of the prior unit**
(Sep 1–16 vs Aug 1–16), kind `ELAPSED_EQUIVALENT`. An explicit whole prior month is allowed but yields
`change: null` with `notComparable` and both totals. No extrapolation anywhere; `perCompleteMonth` is null on a
partial-only window. This differs from the Cash Flow workspace, which compares MTD against the *whole* previous
month (`previousEquivalentPeriod`, `cash-flow-insights.ts:62`) with a stamp that covers only pre-coverage —
a UI disclosure gap worth its own note, out of M1 scope. Live: Sep-to-date 4,739.87 vs Aug 1–16 4,159.24 →
+580.63, +13.96%.

## 14. Completeness model

Adopt the platform vocabulary `CompletenessTier = observed | derived | estimated | incomplete | unknown`
(`lib/perspective-engine/types.ts:88`) with `reason`, `coverageFrom`, `byComponent`. Period partiality is a
separate axis (`period.calendarComplete`, `partialMonths`). Inputs: corpus span (`transactionCorpusSpan`,
per-Space), fetch cap (`truncated`), and **per-component source health mapped only onto accounts that put
rows into the measure's population**. Today no flow measure carries any of this (only `get_transactions` has
`coverage`); that is the gap. Live: every flow measure `observed`; Schwab `incomplete` for stock components
only.

## 15. Category-measure composition

`category` is a filter on the same measure — `monthlyBreakdown[].byCategory` is per month, debit-only, no
INTEREST (KD-17: ≤ spending). Live: Dining Aug 1,216.83 vs Jul 720.42 (+68.91%); Travel YTD 19,228.04 vs
25,526.60 a year earlier (−24.67%); Travel is 32.45% of YTD spending (code arithmetic). No category tools.

## 16. Income-measure composition

Same head, `measure: 'income'`. The contract must preserve: observed deposits ≠ gross pay ≠ salary
(`operating-state.ts:70-81` refuses an aggregate "operating income"); paycheck count per month (visible in
`months[]`, cadence in `get_income.sources`); CADENCE vs MEASURED basis. Live: 6-month mean 11,791.40 vs
cadence 11,454.61 (26 × 5,286.645 / 12); income Q3-to-date vs the same 78 days of Q2: +19.93%.

## 17. Surplus definition

Historical defect (`AI-SCENARIO-LIQUID-FLOOR-INVESTIGATION.md:522-549`): `recent.netCashFlow` 24,150 ÷ 3 =
"$8,000/month" from a window holding seven biweekly paychecks. Reproduced today twice: the model's 22,769.94 ÷
3 = 7,590 (zero tool calls), and the prototype's honest **measure** `economicNet` over the last 2 complete
months = 8,876.20 (July had three paychecks). Canonical replacement: **`monthlySurplus = incomeBaseline
(CADENCE) − expenseBaseline`** = 11,454.61 − 4,346.48 = **7,108.13** — the spine's own steady state
("~7,130/month over 40 months" in the floor investigation). Card payments, transfers and investment
contributions are allocations, not deductions (`transactions.ts:912-917` doctrine); irregular income is
excluded by the cadence basis and visible in the measure.

## 18. Cash-flow terminology

Not the same thing. In the product, "Cash Flow" is the **liquidity** net (cashIn − cashOut, default
perspective of the workspace); in every AI payload `netCashFlow` is the **economic** net. M1 must not mint a
user-visible "cash flow" figure: name the measure `economicNet` and the derived one `monthlySurplus`.

## 19. Net-worth comparison reuse

`observedChange` / `get_net_worth_history.change` already computes stock change with the right refusals. M1
stays on flows; "am I doing better than three months ago" = `change` (stock) + `compare` (flows) + the
model's judgment. No financial-health score.

## 20. Debt / investment measure scope

L1 provides dynamic liabilities in scenarios, not measured debt flows. `cardAndDebtPayments` is a flow
measure the head can expose; total debt / interest paid / DTI need APRs and minimums that are user-entered
only (0 rows) — out of M1. Investment contributions live in `summarizePeriodFlows` (workspace-only); the
measure language generalises (a period, a fold, a completeness) but the fold is different, so investments
stay a separate authority in M1.

## 21. Tool-surface recommendation

Measured (`tmp/m1/proto/schema-size.ts`, schema bytes): one merged mega tool 4,267 B; two heads
(`measure_flows` 2,983 B + `get_baselines` 1,458 B) 4,441 B; extending both `get_spending` and `get_income`
with period + compareTo 4,604 B plus `get_baselines`. Plus one contribution field ×3 scenario tools (1,089 B).

Recommendation: **C — two heads**, and `get_spending` / `get_income` keep their evidence role.
- `measure_flows({ measure, period, compareTo?, category?, asOf? })` — measure + comparison in one call, because
  a comparison is two measures and the model must never receive one side and compute the other.
- `get_baselines({ statedMonthlySpending?, statedMonthlyIncome?, spendingWindow?, monthsOfExpenses?, asOf? })`
  — baselines with basis, `monthlySurplus`, `savingsRate`, `runway`, `thresholds[]`, plus the evidence
  the model needs for judgment (measured spread, current liquid).
- `liquidFloorMonthsOfExpenses` on the contribution rule of the three scenario tools.

Rejected: per-question tools; a mega tool (merges "what happened" with "what to assume"); extending
`get_spending` alone (its description leads with spending, and the income comparison in the probe went to
`get_income`). Discoverability lesson from bca5119/7859d6c: the description must say what the head is *for*
("more than", "on average", "per month", "compared with") and forbid dividing a window total.

## 22. Scenario composition

Proven live with **no ledger change**: threshold 26,078.88 → `{ liquidFloor: 26078.88, fractionOfExcess: 1 }`
→ $1M crossing 2035-01-31, liquid held at 26,078.88, first sweep 2026-11-30; and the scenario's own
`assumptionsInForce.spending.monthly === 4,346.48`, the same figure the threshold multiplied. "Use $5k; keep
six months of that" → floor 30,000 (STATED) + `assumedMonthlySpending: 5000` → crossing 2035-08-31. The
smallest integration is a resolver in `prepareScenario` (`tools.ts:1566`) that turns
`liquidFloorMonthsOfExpenses` into the literal using the scenario's own spending level (stated first, else
observed) and echoes `{ liquidFloor, derivedFrom: { rule, baseline } }` on `floorRule`. The ledger stays pure.

## 23. L1 composition

Proven live: `{ liquidFloor: 26078.88, fractionOfExcess: 1, target: ['highest_apr','investments'] }` with
`liabilityAssumptions` (APRs are not on record) → first sweep 2026-11-30 placed 502.68 + 24.86 on the two
cards, 3,720.35 to investments; by 2028-12-31 debt 0, investments 226,249.41, liquid at the floor. No
debt-specific threshold logic.

## 24. Conversation override behaviour

"How much do I normally spend?" → `get_baselines` (MEASURED, window named). "Use $5k instead" →
`statedMonthlySpending: 5000` (tool arg, this turn; the active-scenario envelope carries it via
`assumedMonthlySpending` once a scenario runs). "Keep six months of that in savings" →
`liquidFloorMonthsOfExpenses: 6` + `assumedMonthlySpending: 5000` (envelope). "Make it nine" → the same
envelope with 9 (arguments-are-identity, c5874ea). "Put everything above it toward my cards" → `target:
['highest_apr','investments']`. Within-conversation inheritance rides the existing envelope; nothing is
durable unless `remember` is asked (the ASSUMPTION payload already allows `monthlySpending`).

## 25. Model-judgment boundary

`get_baselines` returns measured spread, declared/stated levels, liquid, runway, and requested thresholds. It
never returns `recommendedCash`. "How much cash should I keep" remains the model's sentence over three exact
numbers; the model probe already does this well when it has them (cash-keep answer) — the defect was only
that it multiplied 4,346 × 6 itself.

## 26. Real-Space measurements (2026-09-16)

| figure | value | window | basis | completeness | reach |
|---|---|---|---|---|---|
| spending baseline (spine) | 4,346.48/mo | 07-01..08-31, 2 complete | MEASURED | observed | corpus 2024-07-18..2026-09-15 |
| recent 90-d spending | 15,353.73 | 06-17..09-16 | measure | observed | |
| 6-month spending | 40,312.00 (6,718.67/mo) | 03-01..08-31 | measure | observed | |
| 12-month spending | 84,005.01 (7,000.42/mo) | 2025-09-01..08-31 | measure | observed | |
| income baseline | 11,454.61/mo | streams as of 09-16 | CADENCE (BIWEEKLY 5,286.645) | observed | 21 obs |
| income 6-mo mean | 11,791.40/mo | 03-01..08-31 | MEASURED | observed | |
| monthly surplus | 7,108.13 | baselines | CADENCE − MEASURED(2) | observed | |
| economicNet measure | 8,876.20 / 5,606.99 / 5,158.41 per month | 2 / 6 / 12 complete | measure | observed | |
| current liquid | 14,610.26 | now | checking + savings | observed | |
| six-month threshold | 26,078.88 | × MEASURED(2) | derived | observed | |
| runway | 3.36 months | | liquid / MEASURED(2) | observed | |
| savings rate | 62.05% | baselines | one definition | observed | |

Not golden constants; they move with the data.

## 27. Liquid-floor pin-drift classification

`npm run ai:liquid-floor-check` at 2026-09-13: **7 failed** (`tmp/m1/out/liquid-floor-check.log`), all
numeric drift of ~1,028 in net worth (opening investments changed with the recovered closes), plus the $75k
floor crossing moving 2035-03-31 → 2035-04-30. Classification of the harness's 41 assertions:

| class | assertions | keep as |
|---|---|---|
| SEMANTIC INVARIANT | 0% conservation (§4); two-bases refusal; floor-without-share refusal; goal-seek solves to the crossing's return; movements total conserved | exact, unchanged |
| STRUCTURAL INVARIANT | first contribution on the first month-end at/above floor; liquid == floor at crossing; monthsBelowFloor 0; quarterly rows == monthly rows on the same dates; thinning names its omitted dates; horizon echoed; 35 rows ending at horizon; elapsed carried; assumptionsInForce present | exact, unchanged |
| LIVE FINANCIAL FIXTURE | $1M crossing 2035-02-28 at 1,001,443.24; investments 951,443.24; previous 989,979.48; 2027-03-31 / 2029-12-31 rows; $75k → 2035-03-31; 5% → 2035-09-30; 50% → 2035-03-31 with liquid 58,941.90; $2M → 2040-08-31; first contribution 4,044.40; $50k crossing 2027-02-28 / 54,044.40 | **convert** |

Smallest correction (not implemented): keep the dates and amounts that are *relations* — `$75k crossing ≥ $50k
crossing`, `5% crossing > 7% crossing`, `50% share crossing ≥ full share` and liquid > floor, `$2M > $1M`, `the
last quarterly row IS the crossing the search found` (relational, already), `first contribution == availableBefore
− floor` — and move the seven exact money/date pins to `liquid-floor-contribution.test.ts` (synthetic spine,
already 40+ checks) or to an explicitly named snapshot block gated by `CHECK_SNAPSHOT=1`. The crossing *date*
2035-02-28 held through the recovery; its *value* did not.

## 28. ETH-gap impact

`evidenceCoverage.chains.ETH = { fromISO: null, claimsHistory: false }`. No flow measure touches ETH (no
transactions in the banking population). Affected: stock history before the ETH position was connected —
`get_net_worth_history` / `find_in_balance_history` `digitalAssets` component — should carry `byComponent.
digitalAssets: 'incomplete'` with `coverageFrom`. Current position is authoritative; M1 flows unaffected.

## 29. Schwab-gap impact

Source health `BANK: NEEDS_RECONNECT` since 2026-08-17 with 0 transactions on its three accounts. The naive
mapping (any stale BANK source ⇒ incomplete) marked **every** spending figure incomplete in the first live
run; the population-aware mapping (source health attached only to accounts with rows in the measure's
population) restores `observed` for all 29 flow probes and marks `investment:Charles Schwab` `incomplete`
for stock components. Completeness must be measure-specific.

## 30. Prototype results

`tmp/m1/proto/synthetic.ts`: **47/47** — A measured basis/window, B stated/declared/measured distinct,
C income cadence vs measured (BIWEEKLY 26, retiree interest-only, quarterly irregular), D surplus, E
period-vs-period (calendar, completeMonths, YTD-vs-last-year, rolling), F partial month (elapsed-equivalent;
whole-month refusal), G category (incl. zero-vs-zero), H thresholds keep identity through "use $5k" and
"make it nine", I runway (+ minimum-debt-service variant), L incomplete propagation (pre-coverage, fetch cap,
stale bank component, stale investment ignored), M zero denominators (never Infinity/NaN), N every derived
figure ships with numerator and denominator. `tmp/m1/proto/live.ts`: J and K compositions above; 52
assembler reads for 29 measures + 12 comparisons (two reads per comparison, cacheable by window).

## 31. Unseen-question corpus

| question | class | composition |
|---|---|---|
| Has my lifestyle gotten more expensive? | composable + judgment | `compare(spending, completeMonths 6, PREVIOUS)` + category compares |
| How much more am I saving now than last quarter? | exactly composable | `compare(economicNet, QTD, PREVIOUS)` |
| How long could I live off cash if my paycheck stopped? | exactly composable | `get_baselines.runway` (+ `withMinimumDebtService`) |
| Was travel actually a big part of my spending this year? | exactly composable | `measure(spending, YTD, Travel)` vs `measure(spending, YTD)` — share is code |
| Keep a year's expenses untouched. | exactly composable | `liquidFloorMonthsOfExpenses: 12` |
| Use my recent spending, not the six-month average. | exactly composable | `spendingWindow: { completeMonths: 2 }` echoed as MEASURED |
| Use the $5k number I gave you instead. | exactly composable | `statedMonthlySpending: 5000` / `assumedMonthlySpending` |
| How much of my income am I actually keeping? | composable + judgment | `savingsRate` (one definition, stated) + `cardAndDebtPayments` measure |
| Did paying off my cards materially change my monthly cash flow? | honest refusal in M1 | needs a dated regime split; `compare(cardAndDebtPayments, …)` shows the payments fell, but "change in cash flow *because*" is causal (I1/S1 territory) |
| Compare the last three complete months with the three before that. | exactly composable | `compare(spending, completeMonths 3, PREVIOUS)` — live: −24.13% |

No special cases added.

## 32. Generality results

Ten synthetic profiles through the same code (steady, debt-heavy, high-spend with a one-off, irregular
quarterly income, paycheck-to-paycheck, retiree/no payroll, house saver, investment-heavy, incomplete source,
category-heavy): every one yields baselines or an honest refusal (retiree: no income baseline ⇒ surplus and
savings rate unavailable; incomplete source ⇒ tier incomplete with `coverageFrom`). Nothing in the prototype
reads the live user's shape; the only Space-specific fact is which accounts feed which population.

## 33. Proposed output schemas

Measure: `{ measure, category?, unit, period{from,to,days,kind,label,calendarComplete,clampedToCeiling}, total,
months[{month,value,partial}], completeMonths, partialMonths[], perCompleteMonth|null, highest, lowest, basis,
completeness{tier,reason,coverageFrom?,byComponent?} }` (~600 B for 12 months).
Comparison: `{ measure, category?, left, right, comparedOn, change{abs,pct|null,direction}|null,
notComparable?, completeness, caveats[] }`.
Baselines: `{ expense{amount,basis,window?,completeMonths?,months?}, income{amount,basis,streams?}, monthlySurplus,
savingsRate, runway, thresholds[{rule,monthsOfExpenses,amount,baseline}], liquid, spread }`.
Floor echo: `floorRule.derivedFrom: { rule, monthsOfExpenses, baseline{amount,basis} }`.

## 34. Deterministic acceptance

Pure suite (CI, no DB) mirroring `tmp/m1/proto/synthetic.ts`: A–N over the ten profiles, plus period pins
(§12 table), plus the source scan that the head contains no `/ days` or `/ 30` normalisation and the
scenario tools contain no second baseline resolver.

## 35. Live-authority acceptance

`scripts/ai-baseline/measures.check.ts`: `measure(spending, PAST_QUARTER).total === get_spending().totals.
spending` on the same window; `perCompleteMonth(completeMonths 2) === project_cash basis.spending` monthly
equivalent; `get_baselines.expense.amount === resolveExpenseBaseline(...).amount` for the assessment's window;
threshold amount === `floorRule.liquidFloor` in a scenario run; every flow measure `observed` while the
corpus covers the window; no figure differs from its canonical authority by more than `MONEY_EPSILON`.
No personal money constants.

## 36. Recommended exact M1 boundary

One slice, **M1**: (1) `lib/ai/measures/{period,measure,baseline}.ts` from the prototype, `resolveExpenseBaseline`
gaining `STATED`; (2) `measure_flows` + `get_baselines` heads in `tools.ts` (19 tools; `baseline.test.ts`
count bump); (3) `liquidFloorMonthsOfExpenses` resolved in `prepareScenario`, echoed on `floorRule`; (4) the two
authority corrections — Brief `monthlyExpenses` reads the resolver; `impliedMonthlyIncome` becomes the
CADENCE/MEASURED baseline — and `coverage` on the new head; (5) description-level prohibition on dividing
window totals, no system-prompt growth. Do **not** split M1A/M1B: the threshold without the baseline head has
no basis to name, and the head without the threshold leaves the model multiplying.

## 37. Estimated files / scope

~9 files: 3 new modules (~400 LOC, mostly the prototype), `tools.ts` (+2 heads ≈ 180 LOC, watch the 700-LOC
aiarch guard on routes — not on tools), `scenario` preparer (+30), `expense-baseline.ts` (+10), `brief/package.ts`
(+5), `engine.ts` (+5), 1 pure test, 1 live check, `baseline.test.ts` tool count. No migration, no ledger
change, no prompt change.

## 38. Overall verdict

**READY TO IMPLEMENT M1.** The measure authority exists and is single (the fold, the parser, the tiers, the
liquid total); what is missing is the contract that names window, basis and completeness and computes the
comparison and the threshold. The two measure-authority defects found (Brief bypasses the resolver;
income normalised by days) are small and belong inside the slice, not before it.

## Architecture test

Nothing here teaches an answer. `measure_flows` is one verb over six flow kinds × any period × any category
× an optional comparison; `get_baselines` is three bases × two flows and four derivations that are pure
arithmetic over them; the scenario field is one multiplier over one named baseline. "Am I spending more?",
"what's my savings rate?" and "keep six months and invest the rest" are all compositions of those, and so are
the ten unseen questions. The design stopped being a catalogue at the point where `burnRate` and `cashFlow`
were rejected as synonyms; if a third head or a seventh derived figure is ever proposed, that is the signal
to stop.
