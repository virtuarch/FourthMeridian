# S1 — Category Spending Changes · Architecture Investigation

**Date:** 2026-09-22 · **Branch:** `v2.6` · **HEAD:** `52d91a7` · **Mode:** investigation only — no code, tests or database state changed.

**Baseline verified, not assumed:** v2.6 = origin/v2.6 = `52d91a7`; one worktree; `npm run ci` re-run on Node 24.21.0 at `52d91a7` — unit 594/594, typecheck clean, lint 0 errors / 16 warnings, REQUIRED audits 22/22, both jobs green; GitHub run `35658791677` = success; production tool registry = 18 + 2 memory = **20**; only the independently owned status-drift file is untracked. Two scratch measurements (outside the repo) used the real seal and staging functions; one read-only query read the live category decomposition (Jun–Aug 2026). Nothing was written.

---

## 1. Verdict

**READY WITH PREREQUISITE.**

The forecast spine already represents spending the way S1 needs it represented — a **rate** — and it has exactly one place where that rate is consumed. S1 is a piecewise-constant transformation of that rate, fed from the canonical category ledger, attached where I1 attaches, and it composes with L1 / M1 / the floor / the waterfall / goal seek through the machinery that exists.

One **measured** constraint must change first, because it would make the canonical multi-turn acceptance conversation fail before S1 ever runs:

- **P0 — the staged-plan byte budget.** `MAX_PENDING_BYTES = 600` (`lib/ai/conversation/pending-plan.ts:54`). Dogfood A's four staged clauses (Dining cut + raise + months-of-expenses floor + waterfall) measure **616 bytes** with realistic identities — the fourth turn would be refused at staging. The cap was set when the seal was hex and an oversize seal was discarded whole; since FM-AUDIT-018 the seal is base64url (~50% more room) and overflow is explicit. The executed envelope with S1 is far from its ceiling (§17). Re-measure and raise the pending cap (≈1,200 bytes) with a combined-budget test, as the first slice of S1.

Two further findings interact with S1 but do not block it:

- **S1-N1 (new) — interest can be counted twice when L1 models a liability.** The spine's spending rate includes historical `INTEREST` cost flows (card interest charges on the existing balance), and the L1 ledger accrues interest on that same existing balance. The L1 investigation's double-count table (`docs/plans/AI-LIABILITY-DYNAMICS-L1-INVESTIGATION.md` §4) covers purchases vs payments and minimums, not interest. Dormant on the live Space today (Jun–Aug 2026 interest = $0.00; historically 43 rows, $16,158.61), real in general. S1 must therefore treat **Interest as not transformable** (it is governed by liabilities), and the overlap itself should be fixed in parallel (exclude modelled liabilities' interest from the base rate). See §18.
- **Derived-floor wiring is required, not automatic** (§10): the current re-resolution is keyed to a single monthly spending level; S1 makes spending time-varying.

---

## 2. Exact current spending representation in the forecast

**Answer: B — a single continuous daily rate** (constant over the whole horizon). Income is **A — discrete dated events**. Nothing in spending is dated, categorised or periodic.

Trace, from source:

| Stage | Where | What happens to spending |
|---|---|---|
| Measurement | `lib/ai/assemblers/transactions.ts` `buildMonthlyBreakdown` | Each month folded by `foldEconomicRow` (signed, FM-AUDIT-006): `expenseTotal` = gross cost-flow charges, `refundTotal` = credits; `byCategory` = the canonical ledger's lines (`foldCategorySpend`), which reconcile exactly with those totals |
| Baseline | `lib/ai/forecast/assemble.ts:486-494` → `lib/forecast/observed-spending.ts:112` `deriveObservedSpendingRate` | `reliableMonths` (complete, untruncated) → per month `clampEconomicSpend(expenseTotal, refundTotal)` (NET, floored at 0) → mean of the **last ≤3** → `monthlyRate`, `dailyRate = monthlyRate / (365/12)` |
| User override | `tools.ts` `buildCashSpine` `spendingStatement` → `forecastCash` → `assemble.ts` `engineSpending` | `assumedMonthlySpending` becomes an ASSERTS_FACT `SPENDING_LEVEL`; the projection takes it as `USER_ASSUMED` — it **replaces** the observed rate for the whole horizon |
| Fold | `lib/forecast/projection.ts:118-139` `foldWindow` | `spend = dailyRate × days`, `days = daysBetween(asOf, to)` — today excluded ("today's balance already contains today"), every later day inclusive |
| Interval | `projection.ts` `projectCashInterval` | the same `dailyRate`, over the window's inclusive day count; defined as a difference of two cumulative runs |
| Range | `projection.ts:225-230` | low/high by substituting the window's highest/lowest month for the mean |
| Spine | `tools.ts` `buildCashSpine` → `runTo(end, spendingOverride?)` | one `assembleForecast` per date (memoised per spending level); goal seek's `monthlySpendingCut` rebuilds it with an override level |
| Ledger | `scenario-ledger.ts` `runScenarioLedger` | reads **only** the spine's cash; knows nothing about spending |

**The prior expectation is confirmed:** spending is a rate over an interval; income is composed from dated occurrences. S1 must therefore be a transformation of the **rate**, never a set of synthetic dated events (which would re-create the thirteenth-paycheque error the interval code warns about, in reverse).

---

## 3. Canonical baseline authority

**S1 transforms the spine's spending rate, decomposed by the canonical category ledger over the SAME months.**

- **Total rate `R`** — exactly what the spine uses today: the last ≤3 reliable complete months of NET economic spending (`deriveObservedSpendingRate`), or `assumedMonthlySpending` when the user stated a total (STATED).
- **Category rate `c_k`** — the mean, over **those same months**, of the canonical ledger line's net (`netTotal ?? total` of `monthlyBreakdown[].byCategory`, produced by `foldCategorySpend`). Same months is non-negotiable: a category rate over a different window than the total is two measurements pretending to be one decomposition.
- **Declared category baselines** ("I normally spend $800/month dining") — **not supported in S1.** A stated *total* already exists (`assumedMonthlySpending`, STATED rung). A stated *category* level would need its own provenance rung and a rule for reconciling it against a measured total; there is no product surface for it today and adding one silently would turn a sentence into observed history (the M1 measured-vs-declared rule). S1 may express the user's intent as a **SET_RATE from a date** ("set Dining to $800/month from now"), which is a scenario supposition with USER_ASSUMED provenance — not a baseline.

Live decomposition (read-only, Jun–Aug 2026, the three months the forecast averages):

| Category | Jun net | Jul net | Aug net | Mean (≈ `c_k`) |
|---|---:|---:|---:|---:|
| Dining | 1,281.31 | 720.42 | 1,216.83 | ≈ 1,072.85 |
| Shopping | 1,964.30 | 657.58 | 1,949.44 | ≈ 1,523.77 |
| Other (+1 Transfer-labelled SPENDING row, filed under Other) | 1,629.90 | 480.58 | 1,554.06 | ≈ 1,221.51 |
| Travel | 549.01 (3,420.21 − 2,871.20 refund) | 76.47 | 1,150.96 | ≈ 592.15 |
| Subscriptions | 154.94 | 221.13 | 344.19 | ≈ 240.09 |
| Utilities | 170.92 | 119.00 | 152.25 | ≈ 147.39 |
| Fee | 58.18 | 14.85 | 18.88 | ≈ 30.64 |
| Interest | 0 | 0 | 0 | 0 |

Travel shows why S1's execution proof must print the months and values behind a category rate: one refund moved June by $2,871.

---

## 4. S1 transformation algebra

Smallest vocabulary that covers the target sentences — **three operations**, one optional aggregate scope. I1's `STOP`/`START` are deliberately NOT copied.

| Op | Meaning | Required baseline | Field / units | Example |
|---|---|---|---|---|
| `SCALE` | rate from `from` = rate in force × multiplier | measured `c_k` (or total) | `multiplier` (dimensionless, ≥ 0; 0.7 for "cut 30%", 1.2 for "+20%") | "cut Dining 30% from January" |
| `DELTA` | rate from `from` = rate in force + delta | none (additive); a reduction is clamped at zero | `monthly` (USD/month, signed; −500 for "$500 less") | "spend $500 less on Shopping from March" |
| `SET_RATE` | rate from `from` = stated level | none (the level is the statement) | `monthly` (USD/month, ≥ 0) | "set Travel to $300/month from June" |

- **STOP** = `SET_RATE 0` (or `SCALE 0`). A separate op would be a second spelling of the same arithmetic.
- **START is rejected.** A category with no measured baseline has nothing to "start" that `SET_RATE` from a date does not already say (delta from `c_k = 0` is the stated level). A genuinely NEW recurring expense ("daycare $1,500/month from September") is a new obligation, not a category change — out of scope (§22).
- **Scope:** `category` = a vocabulary name, or **omitted** = total spending ("cut all my spending 10%", "spend $500 less a month"). The aggregate scope subsumes goal seek's `monthlySpendingCut` (§12).

Per-operation properties:

| Property | SCALE | DELTA | SET_RATE |
|---|---|---|---|
| Effective date | `from` (ISO, inclusive) — required | same | same |
| End date | `to` (ISO, inclusive), optional → horizon | same | same |
| Zero valid | yes (0 = stop) | result clamped at 0 | yes |
| Negative spending | impossible (multiplier ≥ 0) | clamped at 0, flagged `clampedAtZero` | refused (< 0) |
| Composition | multiplies the rate in force | adds to the rate in force | replaces the rate in force (earlier active rules on that scope stop mattering from `from`) |
| Stacking | yes — "20% in Jan, another 10% in Jul" = ×0.8 then ×0.9 from July (0.72) | yes | a later SET_RATE supersedes |
| Order dependence | resolved by `from` order; **same scope + same `from` + different rules ⇒ refused** as ambiguous at execution | same | same |
| Correction / supersession | by pending-plan identity (§13), never by arithmetic | same | same |
| Rounding | full f64 in the fold; cents only at the display edge; monthly ↔ daily via `365/12` (the existing constant) | same | same |

**Evaluation rule (deterministic, order-free except by date):** for each day `d`, for each category `k`, fold the rules on `k` whose `[from, to]` contains `d`, in ascending `from`, starting from `c_k`; then `T(d) = R + Σ_k (c_k(d) − c_k)`; then fold the active **aggregate** rules on `T(d)` the same way; clamp `T(d) ≥ 0`. Because the rate is piecewise-constant between rule boundaries, this is computed once per segment, not per day.

---

## 5. Time / interval semantics

The engine is **daily** (a daily rate integrated over day counts), so **exact dates are preserved** — a mid-month date is never rounded to a month boundary.

- A rule governs days `d` with `from ≤ d ≤ to` (both inclusive; `to` omitted = horizon). Days on or before `asOf` are never governed (they are observed, not projected) — a `from` ≤ asOf governs from `asOf + 1`, and the proof says so (`governed` vs `requested`, exactly as I1).
- Spend over `(asOf, horizon]` = Σ over segments of `dailyRate(segment) × days(segment ∩ window)`. The interval function uses the same segments, so interval ≡ difference of cumulatives still holds.
- "Starting January" → `from: 2027-01-01`. "Starting March 15" → `2027-03-15`. "For three months" → `to` = the day before `from + 3 months`. "Until June" → `to: 2027-05-31`. "Next month" → first of next month. The **model** turns words into dates (meaning); the **proof** prints `requested` and `governed` so a misread is visible and correctable in one turn.
- "Starting January, then another 10% in July" = two rules, two `from` dates (§13 decides whether the second corrects or adds).
- Month-grain consumers (the M1 floor, the ledger's month-end grid) read the rate **in force on their date** (§10); nothing forces spending changes onto month boundaries.

---

## 6. Category observability / transformability contract

"Measurable" is necessary and not sufficient. The contract adds one axis — **what a request can be applied to** — computed deterministically from `lib/transactions/category-vocabulary.ts`, never from prompt wording.

| Class | Categories | S1 verdict |
|---|---|---|
| TRANSFORMABLE — means what it says | Travel, Fee | accepted |
| TRANSFORMABLE AS A WHOLE BUCKET | Dining (includes groceries), Utilities (includes rent), Shopping, Subscriptions | accepted; the proof carries `contains` and `appliedToWholeBucket: true` |
| TRANSFORMABLE, RESIDUAL | Other (medical, transport, entertainment, personal care, services, home improvement, government, + unplaceable spending) | accepted with `residual: true`; the proof says what it holds |
| NOT TRANSFORMABLE — governed elsewhere | **Interest** (determined by debt balances, modelled by L1) | refused: "model the debt instead" |
| UNSUPPORTED (not tracked) | Groceries, Medical, Entertainment, Transport, PersonalCare, Services, Education | refused (existing `resolveSpendCategory` reason, naming where the money is) |
| NOT SPENDING | Income, Transfer, Payment, Buy, Sell, Dividend, Split | refused |

**Sub-bucket words.** The model owns meaning, but it must have somewhere deterministic to put "restaurants". The contract: `category` accepts a vocabulary name **or the user's own word**, resolved by a closed alias table in the vocabulary:

| Request | Resolves to | Verdict |
|---|---|---|
| "Cut Dining 20%" | Dining | accepted, whole bucket (`contains` = dining AND groceries) |
| "Cut restaurants 20%" | SUBSET_OF Dining | **refused**: "restaurants aren't separated from groceries — I can apply it to Dining as a whole (dining + groceries), if that's what you mean" |
| "Cut groceries 20%" | UNSUPPORTED (inside Dining) | **refused**, same offer |
| "Cut rent 10%" | SUBSET_OF Utilities | **refused**, offer Utilities as a whole |
| "Cut entertainment 50%" | UNSUPPORTED (inside Other) | **refused**, offer Other as a whole (residual) |
| "Cut Other 20%" | Other | accepted, `residual: true` |
| "Cut Medical 30%" | UNSUPPORTED | **refused at staging** — never enters pending |

The alias table is data (a handful of entries per bucket), pinned by a test that every alias resolves and every SUBSET/UNSUPPORTED alias names its bucket. S1 may transform only categories where a new `isTransformableSpendCategory` holds (measurable AND not governed elsewhere).

---

## 7. Category → total reconciliation invariant

Today: Σ ledger line gross = `expenseTotal`, Σ line credits = `refundTotal` (exact, FM-AUDIT-004). But the forecast rate clamps **per month** and category nets clamp **per category**, so Σ `c_k` can exceed `R` when some category's refunds exceed its charges in a month (the excess is `refundsUnapplied`). On the live window, Σ category means ≈ `R`.

**S1 never transforms the total and a category independently.** The invariant:

    T(d) = max(0, R + Σ_k (c_k(d) − c_k)), then aggregate rules on T(d)

- A category change moves the total by exactly its own delta — once.
- Categories not mentioned, uncategorised/unapplied-refund residue (`R − Σ c_k`), and Other are carried inside `R` untouched.
- Nothing assumes Σ `c_k` = `R`; the proof reports `residual = R − Σ c_k` when material.
- Worked example: `R = 5,000`, `c_Dining = 1,000`, SCALE 0.7 ⇒ Dining 700, `T = 4,700`.

Pins: per segment, `T(d) − R = Σ(c_k(d) − c_k)` (+ aggregate rules); with no rules, the fold is byte-identical to today's.

---

## 8. Exact insertion point in the spine

Mirrors I1 where it should, and diverges where the maths does:

1. **Pure module** `lib/forecast/spending-change.ts` (beside `income-change.ts`): `applySpendingChanges({ baseMonthly: R, categoryMonthly: {k: c_k}, rules, horizon }) → { schedule: [{fromISO, toISO, monthlyRate, dailyRate}], executions, rejected }`. No DB, no clock.
2. **Category rates** `deriveCategorySpendingRates(reliableMonths, WINDOW_MONTHS)` in `lib/forecast/observed-spending.ts`, sharing `deriveObservedSpendingRate`'s month selection (one window, by construction).
3. **Projection** `lib/forecast/projection.ts`: `ProjectionSpending` gains an optional `schedule`; `foldWindow`'s `dailyRate × days` becomes `spendBetween(spending, asOf, to)` — the ONE spend term. `projectCash`, `projectCashInterval` and `range` all go through it; with no schedule it is exactly `dailyRate × days`.
4. **Adapter** `lib/ai/forecast/assemble.ts`: accepts `spendingChanges`, resolves the base (OBSERVED or USER_ASSUMED), derives `c_k` from the same reliable months, applies the rules, hands the scheduled spending to `projectCash`, and returns `spendingChanges` (executions) beside `incomeChanges`.
5. **Spine closure** `tools.ts` `buildCashSpine(opts.spendingChanges)` — exactly where I1's rules live, so every `runTo(date)` (every checkpoint, share date, crossing step and solve evaluation) sees them. The ledger needs **no change**.

The licensed engine (`forecastCash`) never answers in production (audit FM-AUDIT-068); it must **ignore** spending changes explicitly and say so, never apply a second, divergent version.

---

## 9. Deterministic ordering

Two layers; S1 lives entirely in the first.

**Spine (`runTo`)** — additive and order-free: opening cash + dated income (I1-transformed) − dated obligations − Σ scheduled spending. Income and spending changes commute.

**Ledger (`settleMovements`)** — unchanged, per settlement date: (1) outflows; (2) on month-ends, interest (ACT/365) then **one** minimum per obligation month (FM-AUDIT-009); (3) allocation rules in stated order (floor → excess → waterfall → investments). The floor reads the running balance after (1)–(2), which now includes S1's effect because the spine does.

So the required order is: **income transformation ∥ spending transformation (spine) → ordinary movements → liability interest/minimums → floor allocation → waterfall / investment contributions.** No new ordering is introduced.

---

## 10. Derived-floor interaction

Current contract (FM-AUDIT-011, `tools.ts` `prepareScenario` + `rebindDerivedFloors`; pinned end to end by `scenario-composition.test.ts` F):

- An ABSOLUTE floor (`liquidFloor` in dollars) never moves.
- A DERIVED floor (`liquidFloorMonthsOfExpenses`) is resolved once from the scenario's scalar `monthlySpending`; the movement carries `floorMonthsOfExpenses`; `run({ monthlySpending })` re-resolves every bound floor at that level.

**S1 does not feed it automatically:** today's binding re-resolves at ONE level per run, and S1 makes spending a function of the date. Required wiring (no new floor logic):

- The floor at a movement dated `d` = N × **T(d)**, the monthly rate in force on `d` (months-of-expenses measures the spending of the period it protects; a forward-looking average would make a floor depend on rules not yet in force).
- `prepareScenario` resolves derived floors from the spine's schedule (a `monthlyRateAt(d)` accessor on the spine), and `rebindDerivedFloors` generalises from a scalar to a date → rate function. The same function serves goal seek.
- Proof: `floorDerivations` gain the `atDate` and `atMonthlySpending` per distinct level, so "nine months of expenses ($X at $Y/month from January)" is printable.
- Pins: floor before the cut = 9 × `R`; after the cut = 9 × `T`; absolute floor identical with and without S1.

---

## 11. L1 / M1 / I1 composition

Required example (all through ONE `scenario_projection` call; every clause through the one spine and the one ledger):

    incomeChanges:   [{ op: SCALE, from: 2027-01-01, multiplier: 1.15 }]
    spendingChanges: [{ category: Dining, op: SCALE, from: 2027-01-01, multiplier: 0.8 }]
    contributions:   [{ liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1, target: [highest_apr, investments] }]

- I1 transforms income occurrences in the spine; S1 transforms the spend term in the same spine; both reach every consumer through `runTo`.
- The floor (M1) re-resolves by date from the S1 schedule (§10).
- L1 settles interest / minimums on month-ends and the waterfall takes the excess above the floor.
- "Where am I next December?" = the run at `to: 2027-12-31`. "Actually make Dining 10%" = the same arguments with the Dining clause replaced by identity (§13), re-run. "What about next June?" = the same arguments at `to: 2027-06-30` — the envelope carries the arguments verbatim, and I1's measured rule ("a June figure is not derivable from a December one") already makes the model re-run.

Composes, does not merely coexist: one closure, one fold, one ledger walk. Nothing parallel.

---

## 12. Goal-seek integration

Generic, not category-specific:

- **Unify the existing solve.** `monthlySpendingCut` today re-runs the spine with a replacement level (ASSERTS_FACT). With S1 present that would silently drop every category rule. Re-express it as an **aggregate DELTA rule** (`{ op: DELTA, monthly: −x, from: asOf }`) appended to the scenario's `spendingChanges` — same arithmetic without S1, correct with it.
- **Category solve** = the same solver over one S1 rule's parameter: `solveFor: spendingChange` with `{ category, from, unit: 'PERCENT' | 'MONTHLY' }`. The evaluated rule is appended to the scenario's own rules (so an existing Dining cut stacks rather than being replaced — stated in the proof).
- **Bounds:** PERCENT ∈ [0, 100] (a SCALE of 1 − p); MONTHLY ∈ [0, `c_k`] (you cannot cut more than you spend). Aggregate: [0, `R`].
- **Monotonicity:** cutting spending raises cash at every date; a derived floor falls with it (releasing more to the waterfall / investments); interest paid falls. Net worth, liquid, investments and debt-reduction are monotone in the cut — the bisection premise holds. A test pins monotonicity on a composed fixture.
- **Impossible goals:** the existing `feasible: false` + `bestReached` at the bound ("even cutting Dining to $0 reaches $X").
- **Multiple category variables** (cut Dining AND Shopping to reach X): refused — one variable per solve; the user can fix one and solve the other. Proportional multi-category solves are a non-goal.
- **Precision:** the solver's existing `precision` (0.01 USD / 0.01 percentage point).
- **Execution proof:** the returned scenario is the ledger run at the solution, and its roster carries the solved rule as EXECUTED — the existing "ledger at the answer" contract.

---

## 13. Pending-plan extension

No new state system. The registry already names S1 as its next entry (`pending-plan.ts` IDENTITY: "when S1 declares `spendingChanges`, the suite goes red until one line is added here").

- `SCENARIO_INPUTS.spendingChanges` — array of `{ category?, op, from, to?, multiplier?, monthly? }`. `stage_assumptions` inherits it automatically (it references `SCENARIO_INPUTS` shapes).
- `IDENTITY.spendingChanges = v => op && from ? \`RATE|${category ?? '*'}|${from}\` : null` — SCALE, DELTA and SET_RATE all say what the rate IS from a date, so "actually make the January cut 15%" (same category, same `from`) **replaces**.
- `subjectOf('spendingChanges', v) = \`RATE|${category ?? '*'}\`` — "then cut it another 10% in July" has the same subject and a different identity, so the existing rule applies: the model must say `inAddition` (stack) or `replace` (correct). Code cannot tell a correction from a second rule by reading fields, and does not pretend to.
- `FIGURES.spendingChanges = { multiplier: 'MULTIPLIER', monthly: 'Money' }` — the existing MULTIPLIER gate already licenses a cut ("a 20% cut" → 0.8, `pending-plan.ts:233`); a DELTA's money is gated on its magnitude.
- **Unsupported / not-transformable categories are refused at staging** (vocabulary resolution runs in the staging validator, not only at execution), so "Cut Medical 30%" never enters pending.
- Retraction ("never mind the Dining cut") = existing `retract` by clause id.
- **P0 prerequisite:** the byte budget (§1, §17).

---

## 14. Execution-proof design

`SpendingChangeExecution` per rule, parallel to `IncomeChangeExecution`, produced by the pure module and carried by the spine (like `incomeChanges.executions`):

    { ruleId, op, scope: 'CATEGORY' | 'TOTAL', category?,
      resolved: { name, class: 'TRANSFORMABLE' | 'WHOLE_BUCKET' | 'RESIDUAL', contains? },
      requested: { fromISO, toISO | null }, governed: { fromISO, toISO } | null,
      baseline: { monthly, basis: 'MEASURED' | 'STATED_TOTAL', months: [YYYY-MM…], values: [...] },
      monthlyBefore, monthlyAfter, clampedAtZero?, affectedProjection: boolean,
      spendingRemovedOverGoverned /* USD, full precision */, reason? }

States the model must distinguish, and where each lives:

| State | Carrier |
|---|---|
| REQUESTED | the tool arguments (verbatim in the envelope) |
| STAGED | pending clause (`fromEarlierInConversation`) |
| EXECUTED | `execution` with `affectedProjection: true` |
| REFUSED | `rejected` / `notApplied` with the vocabulary or validation reason |
| SUPERSEDED | pending identity replacement (the old clause is gone, never executed) |

The clause roster (`scenario-rules.ts` `clausesInForce` / `compactClauses`) gains `spendingChange: [...]` so the envelope's `ran` shows it — the G5 lesson (a dropped clause leaves no key) applies equally. Prose labels never carry authority (`label` stays unapplied, as today).

---

## 15. Active-scenario / rerun behaviour

- `ActiveScenario.assumptions` stores the tool arguments verbatim — `spendingChanges` rides along with no new representation.
- `captureActiveScenario` REPLACEs on a successful `scenario_projection` / assumption-carrying crossing, CLEARs on failure (unchanged).
- Reruns ("what about next June?") re-send the same arguments; the spine re-derives `c_k` from the current reliable months, so the scenario follows fresh data — the transformation is durable for the conversation, never the baseline.
- Goal seek establishes no envelope (unchanged); crossings carry assumptions (unchanged).
- Nothing reaches durable memory: Memory V2 has no spending-change class (and gets none — §22); the checkpoint is recorded only for evidence-based `project_cash`, never for a scenario (unchanged), and dogfood harnesses are memory-read-only by default (FM-AUDIT-019).

---

## 16. Tool / API changes

**B — extend the canonical scenario engine.** No new tool; count stays **20**.

- `SCENARIO_INPUTS.spendingChanges` (shared by `scenario_projection`, `scenario_crossing`, `scenario_goal_seek`, and referenced by `stage_assumptions`).
- `scenario_goal_seek`: `solveFor` gains `spendingChange` (+ `category`, `from`, `unit`); `monthlySpendingCut` re-expressed as an aggregate DELTA.
- `project_cash`: unchanged — it continues to refuse when a plan is in play (staged spending clauses count), so the current trend can never silently answer an S1 question.
- The category argument's description is generated from the vocabulary (as `measure_flows` already is), including the whole-bucket and residual meanings.
- ⚠️ Schema weight: the three scenario tools each serialize `SCENARIO_INPUTS` (~11 KB, 57% of the tool payload — FM-AUDIT-042). S1 adds ~1–1.5 KB × 3. Acceptable; the dedupe remains a backlog item.

---

## 17. Estimated state-envelope impact (measured)

Measured with the real `sealRuntimeStateWithReport` (base64url compact cipher, 3,900-char ceiling), realistic ids and a roster entry per rule:

| Executed envelope | Sealed chars |
|---|---:|
| I1 + L1 + M1 floor + waterfall + return (no S1) | 1,251 |
| + 1 spending rule | 1,547 |
| + 2 rules (January cut, July further cut) | 1,791 |
| + 4 rules across categories (SCALE, DELTA, SET_RATE) | 2,279 |
| + 8 rules | 3,255 |
| 1-rule envelope + a 4-clause pending plan | 2,383 |

| Pending plan | Bytes | Cap |
|---|---:|---:|
| 4 clauses (Dining cut, raise, floor, waterfall) | **616** | **600** |
| 6 clauses (+ July cut, Shopping DELTA) | 948 | 600 |

**The executed envelope stays practical** (≈ 250–300 chars per rule; 8 rules still fit). **The pending cap does not** — it is the constraint S1 hits first. Raise `MAX_PENDING_BYTES` to a measured value (≈1,200), keep `MAX_PENDING_CLAUSES = 8`, and pin a combined worst case (max pending + an S1 envelope) either fitting the seal or producing the explicit continuity marker. No storage redesign is warranted.

---

## 18. Relevant open-audit findings

| Finding | Classification | Why |
|---|---|---|
| **FM-AUDIT-012** category versioning | **INTERACTS, DOES NOT BLOCK** | S1's baseline is the last ≤3 complete months; a forward-only recategorisation inside that window mixes definitions for at most three months. Not a prerequisite, but S1's proof must print the baseline months and per-month values (§14) so drift is visible, and a future category-version field should feed it. |
| **FM-AUDIT-013** pending rows UI vs AI | **INTERACTS, DOES NOT BLOCK** | The forecast baseline reads complete, settled months only; pending rows affect only the current month, which is never in the window. S1's baseline and the Cash Flow page can differ only for the current month, which S1 never uses. |
| **FM-AUDIT-015** negative income rows | **UNRELATED** to S1 | Income side (affects I1's income, not the spending rate). |
| **FM-AUDIT-036** off-grid interest accrual | **INTERACTS, DOES NOT BLOCK** | S1 changes the spine, not the ledger's settlement dates; S1 adds no spine points. Only a derived floor or a share rule dated off-grid adds dates, which is pre-existing. |
| **S1-N1 (new)** interest in the base rate + L1 accrual | **INTERACTS; fix in parallel; Interest made non-transformable** | See §1. Proposed fix: when the ledger models a liability's interest, exclude that liability's historical `INTEREST` cost flows from `R` (and from `c_Interest`); pin "interest counted once" on a composed fixture. Dormant on the live Space (Jun–Aug interest $0). |
| **FM-AUDIT-042** tool payload | INTERACTS | S1 enlarges the shared schema (§16). |

---

## 19. Complete test matrix

Layer key: **U** = pure unit (no DB) · **C** = scenario-composition CI (real tools on fixture data through `cashSpineReads`, `scenario-composition.test.ts` pattern) · **P** = pending-plan / runtime-state unit · **D** = model dogfood (memory-read-only).

| # | Case | Layer | Pin |
|---|---|---|---|
| 1 | one category percentage cut | U, C | SCALE 0.7 on `c_k` ⇒ `T = R − 0.3 c_k` from `from` |
| 2 | absolute monthly reduction | U, C | DELTA −500 ⇒ `T = R − 500`; clamped at 0 when it would go negative |
| 3 | set monthly category rate | U, C | SET_RATE 300 ⇒ delta `300 − c_k` |
| 4 | mid-month effective date | U | `from: 2027-03-15` governs from the 15th; spend over March = 14 days old rate + 17 days new |
| 5 | sequential dated transformations | U, C | Jan ×0.8 then Jul ×0.9 ⇒ 0.72 from July |
| 6 | correction vs additional | P, D | same `from` replaces; different `from` + same subject requires `replace`/`inAddition` |
| 7 | removal | P, D | `retract` removes; the next run carries no rule |
| 8 | unsupported/unobservable refusal | U, P, D | Groceries/Medical/…/Interest refused at staging and execution; never pending, never $0 |
| 9 | broad measurable category semantics | U, D | Dining/Utilities whole-bucket and Other residual echoed; "restaurants"/"rent"/"entertainment" refused with the bucket offer (alias table) |
| 10 | category → total reconciliation | U | per segment `T − R = Σ(c_k(d) − c_k)`; no-rule fold byte-identical to today |
| 11 | refund / reversal baseline | U | `c_k` uses the ledger's net (a refund-heavy month lowers it; a fee rebate nets) — consistent with FM-AUDIT-006 |
| 12 | derived floor recomputation | C | floor = 9 × `R` before, 9 × `T` after the cut, at each movement date |
| 13 | absolute floor unchanged | C | identical `keep` with and without S1 |
| 14 | L1 + M1 + I1 + S1 composition | C | roster shows all four EXECUTED; spine identity vs `project_cash`; one minimum per month |
| 15 | investment allocation | C | excess above the floor reaches investments; ΔNW at 0% = income change + spending removed − Δinterest |
| 16 | debt waterfall | C | highest APR first under S1-freed cash |
| 17 | crossing | C | a threshold is crossed earlier by exactly the S1-freed cash |
| 18 | goal seek over S1 | C | category PERCENT and MONTHLY solves reach the target; monotone; floor at the solved spending |
| 19 | impossible goal | C | `feasible: false`, `bestReached` at the bound (100% / `c_k`) |
| 20 | pending multi-turn assembly | P, D | 4 staged clauses fit the (raised) budget and compose on the 5th turn |
| 21 | executed scenario rerun | C, D | same args at a new `to` reproduce the path; baseline re-derived from current months |
| 22 | fresh-chat isolation | P | an envelope/pending with S1 opens to nothing in a new chat / Space / user (existing pins extended) |
| 23 | scenario envelope capacity | P | 8-rule envelope + max pending fits or yields the explicit continuity marker |
| 24 | execution proof | U, C | every field in §14 present; REFUSED/SUPERSEDED never appear as EXECUTED |
| 25 | conservation | U, C | Σ spending removed over governed windows = Δ cumulative spend; ΔNW identity at 0% |
| + | licensed engine ignores S1 explicitly | U | pin before anyone adds a NET basis producer (FM-AUDIT-068) |
| + | interest counted once (S1-N1) | C | composed fixture with an APR liability and historical interest |
| + | aggregate `monthlySpendingCut` ≡ DELTA rule | U, C | identical results with no category rules; category rules preserved with them |

---

## 20. Dogfood matrix

All runs through `npm run ai:chat` / `ai:baseline` with `FM_AI_MEMORY_WRITES` **unset** (memory-read-only, FM-AUDIT-019). Scored on the tool calls and roster, not on prose.

| Conversation | Turns | Expected |
|---|---|---|
| **A** | "Starting in January, cut Dining by 20%." / "My raise is 15%." / "Keep nine months of expenses in cash." / "Pay the highest APR debt and invest the rest." / "Where am I next December?" | four clauses staged (no refusal on turn 4 after P0); one `scenario_projection` on turn 5 whose roster shows spendingChange (Dining, whole bucket incl. groceries), incomeChange, cashFloor (9 × the rate in force), debtPaydown |
| **B** | "Actually make the Dining cut 10%." / "What about next June?" | the Dining clause REPLACED (same identity), re-run; then a re-run at 2027-06-30 — never a prose interpolation from December |
| **C** | "Then cut Dining another 10% starting July." | a second rule (`inAddition`), roster shows ×0.9 then ×0.9 from July (0.81) |
| **D** | "Cut groceries 30% starting January." | refused at staging; the answer names Dining as the bucket that holds groceries and offers it; nothing staged |
| **E** | "How much would I need to cut Dining to have $100k invested by next December?" | `scenario_goal_seek` with `solveFor: spendingChange` (Dining); feasible answer or `feasible: false` at 100%; the returned scenario is the run at the answer |
| **F** (control) | "Cut Interest 50%." / "Cut restaurants 20%." / "Cut Other 20%." | Interest refused (governed by debt); restaurants refused with the Dining offer; Other accepted with the residual disclosure |

---

## 21. Implementation slices (dependency order)

| Slice | Scope | Pins |
|---|---|---|
| **S1-0** (prerequisite) | Re-measure and raise `MAX_PENDING_BYTES`; combined seal-budget test. Decide + pin **Interest non-transformable**; (parallel, may ship separately) S1-N1 exclusion of modelled liabilities' interest from `R` | P 20, 23 |
| **S1-1** | Pure `spending-change.ts` (algebra, segments, executions, clamps, refusals) + `deriveCategorySpendingRates` (shared window) | U 1–5, 10, 11, 24, 25 |
| **S1-2** | `projection.ts` `spendBetween` (the one spend term; cumulative, interval, range) + adapter wiring in `assemble.ts`; licensed engine ignores explicitly | U 4, 10, 25, licensed-ignore; existing projection pins unchanged with no rules |
| **S1-3** | Vocabulary: `isTransformableSpendCategory`, alias table (SUBSET_OF / UNSUPPORTED), generated description | U 8, 9 |
| **S1-4** | Tool surface: `SCENARIO_INPUTS.spendingChanges`, `toSpendingChangeRules`, `buildCashSpine` closure, roster (`clausesInForce` / `compactClauses`), `scenarioAssumptions` echo | C 1–3, 14, 24 |
| **S1-5** | Derived floor by date: spine `monthlyRateAt`, generalised `rebindDerivedFloors`, floor proof | C 12, 13 |
| **S1-6** | Pending: IDENTITY / subjectOf / FIGURES entries, staging-time vocabulary refusal | P 6–8, 20, 22 |
| **S1-7** | Goal seek: aggregate DELTA unification + `solveFor: spendingChange` | C 18, 19, aggregate ≡ DELTA |
| **S1-8** | Composition CI extension (crossing, waterfall, allocation, conservation, interest-once) | C 14–17, 21, 25 |
| **S1-9** | Dogfood A–F (memory-read-only) + closure report | D |

Each slice commits independently with its pins; `npm run ci` on Node 24 before push.

---

## 22. Explicit non-goals

- A spending-specific tool or projection path (count stays 20; one spine, one ledger).
- Synthetic transactions or dated spending events.
- Declared (stated) **category** baselines, and durable memory of spending changes (Memory V2 gets no class; deferred exactly like durable income expectations).
- Sub-bucket precision the data does not have (restaurants vs groceries, rent vs utilities, medical/entertainment inside Other) — refused honestly until a PFC-detailed producer lands and the vocabulary reclassifies those categories.
- New recurring obligations ("daycare $1,500/month from September") — a different primitive.
- Multi-variable / proportional solves across several categories.
- Transforming Interest (governed by liabilities / L1).
- Fixing FM-AUDIT-012 / 013 / 015 / 036 inside S1 (classified in §18).
- Tool-schema deduplication (FM-AUDIT-042) and a chat figure verifier (FM-AUDIT-017).
