# Liability dynamics (L1) — implementation investigation

**Date:** 2026-09-15 · **Investigation only. No production code, prompt, tool or schema changed.**
Authority: `docs/plans/AI-COMPOSITIONAL-FINANCE-INVESTIGATION.md` §4.1; 0d80404, 201be37, f070f6d,
4c6d6ab. Prototype: `tmp/floor/liab-proto.ts` (30/30 checks, uncommitted). Evidence probes:
`tmp/floor/debt-evidence.ts`, `debt-legs.ts`, `debt-census.ts`.

> ## Verdict: READY TO IMPLEMENT L1 — as one coherent slice
>
> The repository already owns every authority a liability line needs: a signed balance
> convention (`lib/debt/balance-semantics.ts`), one resolver for APR and minimum
> (`lib/debt/effective-terms.ts`, DebtProfile > flat column), an explicit knowledge-gap channel
> (`missingDebtFields`), a rule that a card payment is two legs of which the CASH leg counts
> (`debt-payment-authority.ts`), an economic fold that keeps debt payments out of spending, and a
> ledger whose settle loop already reads a running balance. What is missing is only the line
> itself: a liability that accrues at its APR, is reduced by stated minimums and by allocation
> rules, and can be a target. Everything else — projection, crossing on `debt`, goal seek, the
> envelope, checkpoint planning, elapsed — composes with no change of head.
>
> Two boundaries keep it honest. **Interest is modelled only when a rate is known** (stated or
> explicitly zero); an unknown rate does not become 0%, it becomes an `unmodelled` liability with
> a gap the answer must name. **Baseline payments are the stated minimum or nothing**; nothing is
> inferred from history and `estimateMinimumPayment` never enters. Debt payments enter the
> **ledger**, not the spine, because the spine's spending rate already excludes them — the one
> spine principle holds and `project_cash` is untouched.
>
> The floor rule with a liability target — "keep $10k and put everything above it on the
> highest-rate card" — is the same `liquidFloor` basis with `target`, and an ordered target list
> `['highest_apr', 'investments']` expresses "pay debt first, then invest" as one scenario with
> the phase transition read from state, not scripted. Both ran in the prototype.

---

## 1. Tree safety

`git status`: no tracked changes; untracked peer files (status-drift audits, the two prior
investigations, the platform-ops investigation, `scripts/audit-visibility-levels.ts`) untouched.
No stash, reset, clean, checkout. Head `4c6d6ab`.

## 2. Current debt authorities

| fact | authority | freshness | nullable | units / sign | coverage |
|---|---|---|---|---|---|
| balance | `FinancialAccount.balance` (Plaid `balances.current`, ingested unmodified) | provider sync (`balanceLastUpdatedAt`) | no (default 0) | native currency; **positive = owed, negative = credit in the user's favour** | every debt account |
| amount owed / credit / state | `lib/debt/balance-semantics.ts` (`amountOwed`, `creditBalance`, `liabilityState`) | derived | — | ≥ 0 | every row (assembler emits all three) |
| APR | `resolveEffectiveDebtTerms`: `DebtProfile.apr` > `FinancialAccount.interestRate` > null | **user-entered only** (`PATCH /api/accounts/[id]`, debt-profile editor); Plaid sync never writes it | yes | percent per year (0–100 validated) | census: 5 of 6 owed accounts across all Spaces; 0 on the dogfood Space |
| minimum payment | same resolver over `minimumPayment` | user-entered only | yes | native currency per cycle | 5 of 6; 0 on the dogfood Space |
| due day / statement close / promo end | `DebtProfile` only | user-entered | yes | day of month; date | **0 rows in the database** |
| credit limit / available | `creditLimit`, `availableBalance` (Plaid) | sync | yes | native | 5 of 7 |
| subtype | `debtSubtype` (string: credit_card, auto_loan, mortgage, …) | Plaid at link / user | yes | — | credit_card 3, auto_loan 1, mortgage 1, null 2 |
| historical balance | snapshot history (`debt` column composed from `amountOwed`), `find_in_balance_history`; as-of reconstruction walks revolving cards back and holds installment loans flat, marked estimated | daily snapshots | per date | ≥ 0 | dogfood Space max $47,685.66 on 2025-10-23 |
| knowledge gaps | `missingDebtFields[]` (`{accountId, field: apr|minimumPayment, label, debtSubtype}`) | derived per read | — | — | emitted only for FULL-visibility rows |
| estimate | `lib/debt.ts estimateMinimumPayment` (max(35, 1% + monthly interest)) | heuristic for display; the obligation module explicitly refuses it as evidence | — | — | never an authority |

No Plaid liabilities product is used; there is no statement balance, no payment history from the
issuer, no amortisation schedule anywhere (`lib/perspective-engine/lenses/debt.ts` states this).
The product's one interest figure is `owed × APR/100/12`, flagged estimated.

## 3. Liability term coverage

Across the corpus, terms exist where a user typed them (5 of 6 owed accounts), never from a
provider. The dogfood Space has two cards, one in credit ($35.64) and one owing $9.75, both with
`apr` and `minimumPayment` null and four `missingDebtFields` entries. Real-Space debt dogfood is
therefore degenerate; deterministic acceptance must use synthetic fixtures (§31).

## 4. Payment evidence semantics

A card payment is **two persisted `DEBT_PAYMENT` rows**: the cash leg on checking (negative) and
the liability leg on the card (positive), each carrying `counterpartyAccount` and a
`movementNote` telling the reader not to add the legs. The counted leg is CASH
(`COUNTED_DEBT_PAYMENT_LEG`), because 26 cash legs in the corpus have no connected liability.
The economic fold (`foldEconomicRow`) counts only cost, refund and income flows, so **debt
payments are not spending** and the forecast spine's spending rate does not contain them. The
liability leg alone names which liability received money (`rollupDebtPaymentsByAccount`).

Double-counting risks for L1, and how each is avoided:

- **Card purchases vs card payments.** Purchases on a card are economic spending at purchase
  time and already reduce the spine's cash. Payments are transfers. The current model therefore
  implicitly assumes *new* purchases are settled from cash as they occur and the *existing*
  balance never moves. L1 keeps that: it makes the existing balance dynamic and never adds
  purchases to it.
- **Minimums in the spine.** If stated minimums were added to the spine as outflows, a
  pay-in-full user would be charged twice (purchases in the rate plus the payment). They go in
  the **ledger** against the existing balance, where the spine's rate does not reach.
- **Historical payments as future obligations.** Excluded by design (§24).

## 5. Existing obligation module verdict

`lib/forecast/obligation.ts` (FORECAST-4) licenses a future outflow only from `DEBT_TERMS` (a
stated minimum, never the estimate) or a user assertion, requires a due day to date events,
treats a minimum as a *floor with unknown movement* (`MINIMUM` ⇒ basis UNKNOWN), and refuses
regularity as evidence. It is unwired because no account carries a due day, so wiring it changes
no number (`assemble.ts`: "would be a no-op with a false air of capability"); the assembler
instead counts `activeButUndatedCount`.

**L1 verdict: reuse its licensing semantics, not its event generator.** The ledger settles at
month-ends and needs no due day; a stated minimum settles at the month-end (§20). The rules L1
inherits verbatim: minimum comes only from `resolveEffectiveDebtTerms`; an estimated minimum is
not evidence; a zero balance terminates; nothing is inferred from silence. `obligationEvents`
stays unwired — the spine is not where these payments belong (§25). No modification needed.

## 6. Current ledger ordering

`runScenarioLedger` per checkpoint: `liquid = spine(d) − outflows≤d − contributions≤d`;
`investments = opening × G(asOf,d) + Σ c × G(c.date,d)`; `debt = opening.debt` (flat);
`otherAssets` flat; `netWorth` composed. `settleMovements` orders by date then OUTFLOW before
CONTRIBUTION, contributions in insertion order, each balance-based rule reading `projected −
consumed`. Crossing walks checkpoints; goal seek bisects over `setup.run`. Conservation at 0%
is pinned at every checkpoint.

## 7. Proposed liability line

Built inside `prepareScenario` from the accounts payload the ledger already opens from
(`accounts.accounts[]` carries `id`, `amountOwed`, `apr`, `minimumPayment`, `rateSource`,
`debtSubtype`):

```ts
interface LiabilityLine {
  id: string;            // FinancialAccount id — the same id memory and transactions use
  label: string;         // display name, for narration
  balance: number;       // amountOwed(balance): ≥ 0, positive = owed
  apr: number | null;    // effective APR; null = unknown ⇒ unmodelled, never 0
  minimumPayment: number | null; // stated only; null = no baseline payment
  subtype?: string;
}
```

Individual lines are required — targeting and APR ordering need them — and the aggregate
`debt = Σ balance` is what `netWorth`, `scenario_crossing{metric: debt}` and goal seek's
`measure` read, unchanged. Accounts in credit open at 0 owed (the credit is not an asset the
ledger tracks; today it is likewise excluded from `totalLiabilities`). Withheld (non-FULL)
liabilities keep their aggregate contribution but cannot be targeted or accrue: they are listed
as `unmodelled` with reason `visibility`.

Per-checkpoint output adds `liabilities: [{ id, opening, interest, minimumPaid, extraPaid,
closing }]` and the totals `interestToDate`, `paymentsToDate`.

## 8. Sign convention

| quantity | sign |
|---|---|
| liability balance | ≥ 0, amount owed |
| payment (minimum or allocated) | > 0, reduces balance and reduces liquid by the same settled amount |
| interest | > 0, increases balance, decreases net worth |
| net worth | liquid + investments + otherAssets − Σ balance |
| a credit balance at opening | 0 owed; the credit is reported, not modelled |

No negative-debt arithmetic anywhere; a balance can never go below 0 (§15).

## 9. Interest model

Smallest defensible: **simple interest on the balance carried into the period, ACT/365 over
the actual days between settlements**, accrued once per settlement date before payments:
`interest = balance × apr/100 × days(prev, d)/365`. It is the ledger's existing day-count
convention (`growthFactor`), month-grain like everything else, and the product's own display
figure (`owed × APR/12`) is the same number to within a day's width. It is not a statement
simulator: no daily compounding within the period, no grace period, no statement cycle, no
promo expiry (`promoAprEndDate` has 0 rows — bank it). Accruing before payment is the
conservative reading for a revolving balance; the prototype pins `closing = opening + interest −
payment`. Installment debt uses the same arithmetic (§23).

## 10. APR knowledge-gap behaviour

| state | behaviour |
|---|---|
| known APR | interest modelled |
| explicit 0 (`DebtProfile.apr = 0` or user `assumedApr: 0`) | modelled at zero, not a gap |
| unknown APR | liability is `unmodelled: [{ id, reason: 'APR unknown' }]`; balance moves only by payments; the payload carries the gap and the crossing/solve results carry `interestBasis: 'PARTIAL'` |
| mixed | modelled lines accrue; unmodelled listed; `highest_apr` ranks unknown APR **last** (rank −1) and says so |

"When will I be debt free?" with an unknown APR: the tool returns the payments-only date with
the gap named; the answer must present it as a lower bound and offer `assumedApr`. The scenario
inputs gain `liabilityAssumptions: [{ id, apr?, minimumPayment? }]` so the user can supply a
rate or minimum for one line (provenance USER_ASSUMED, echoed). The model never invents an APR;
the field is the only door and it is echoed.

## 11. Minimum-payment recommendation

**Stated minimums enter the ledger as baseline payments at each month-end while the balance is
positive; unknown minimums enter nothing.** Reasons: the minimum is the only issuer-stated
commitment; it is not in the spine (the economic fold excludes payments); the obligation module
already refuses the estimate; the 5 accounts with a stated minimum and no due day are exactly the
population this serves. With no stated minimum and no user rule the balance accrues interest
and is never paid — an honest result the payload must flag (`noStatedMinimum`), not a reason to
refuse the scenario. Minimum settles as `min(minimumPayment, balance after interest)`.

## 12. Baseline vs hypothetical payment

| statement | enters as | provenance |
|---|---|---|
| "my minimum is $300" | `liabilityAssumptions[].minimumPayment` (overrides null/stated) | USER_ASSERTED |
| "put another $500/month toward it" | contribution rule `{ amount: 500, cadence: monthly, target: { liability } }` | USER_ASSUMED |
| observed $27k of card payments last quarter | evidence only (§24) | — |

Baseline and extra are two settlement steps (§20) with two ledger fields (`minimumPaid`,
`extraPaid`), so $800 is never counted twice and the echo can say "$300 required + $500
chosen". The envelope carries both as arguments.

## 13. Allocation target design

Extend the existing contribution rule with **`target`**, default `'investments'` — every
existing argument object keeps its meaning and its captured envelope. A liability payment is
"money moved from cash into a liability" exactly as a contribution is money moved from cash
into investments; the same four bases apply (`amount`, `fractionOfLiquid`, `surplusFraction`,
`liquidFloor` + `fractionOfExcess`). Negative amounts (withdrawals) stay investments-only;
a negative amount with a liability target is rejected ("a payment cannot be negative; to model
new borrowing use a new liability"). The description changes from "moved from cash into
investments" to "moved from cash into investments or toward a liability". No rename of the
model-facing field.

Acceptance: "Keep $10k and put everything above it toward my highest-interest debt" compiles to
`{ liquidFloor: 10000, fractionOfExcess: 1, target: 'highest_apr' }` — the same basis, one new
field.

## 14. Multiple-liability semantics

`target` is `'investments' | { liability: id } | 'highest_apr'`, or an **ordered list** of
those (§17). Ranking for `highest_apr`: APR descending (unknown last), then balance descending,
then id ascending — deterministic and pinned (prototype: equal APR ⇒ larger balance; equal both
⇒ id order). Lowest-balance and pro-rata are not needed by any question in the corpus and are
banked.

## 15. Overpayment

`paymentSettled = min(requested, balance after interest)`; a balance never goes negative. The
unplaced remainder **waterfalls to the next target in the list**; with no next target it
**stays liquid** — it was never consumed, so nothing is destroyed (prototype G: $5,000 rule,
$1,200 owed ⇒ $1,200 paid, $3,800 liquid; with `['A', 'investments']` ⇒ $3,800 invested the
same month). Conservation is pinned either way.

## 16. Highest-APR waterfall

`'highest_apr'` pays the top-ranked liability until it is zero and continues with the same
settlement to the next, in the same month (prototype C/D: the month A clears, $813.33 to A and
$186.67 to B). This is avalanche; leaving the remainder liquid until next month would delay
paydown for no reason and would make the payoff month's cash a spike. Conservation: `netWorth =
baseline − Σ opening balances − interestToDate` at every checkpoint, pinned.

## 17. Liquid-floor interaction

At each date: spine → outflows → interest → minimums → allocation rules read `available =
spine − consumed`, take `max(available − floor, 0) × fraction`, and waterfall it. If ordinary
movement takes cash under the floor the rule pays nothing, the minimum is still paid, nothing is
sold, and it resumes with the current excess when cash recovers (prototype E/F over a spine with
two falling months). Identical semantics to the investment floor rule; the only difference is
where the money lands.

## 18. Phase-transition recommendation

**Include the ordered target list in L1.** `target: ['highest_apr', 'investments']` with a
floor basis is "keep $10k, pay debt first, then invest" as one scenario: in the payoff month
the excess clears the last card and the rest is invested the same settlement; afterwards every
excess is invested and cash stays at the floor (prototype). No crossing-then-second-scenario, no
conditional DSL, no phase primitive: the transition is the waterfall running out of liabilities.
The cost of including it is one array type on `target`; the cost of leaving it out is a
two-stage approximation of exactly the kind liquidFloor removed.

## 19. Conservation identities

| event | liquid | investments | debt | net worth |
|---|---|---|---|---|
| $1,000 payment at 0% | −1,000 | 0 | −1,000 | 0 |
| $100 interest | 0 | 0 | +100 | −100 |
| $1,000 investment contribution | −1,000 | +1,000 | 0 | 0 |
| $5,000 rule, $1,200 owed, no fallback | −1,200 | 0 | −1,200 | 0 |
| outflow $X | −X | 0 | 0 | −X |

General: `netWorth(d) = spine(d) − outflows(d) + I₀·G + Σ c·G − Σ_l balance_l(d)` where each
balance is `opening + Σ interest − Σ payments`; every payment appears once in `consumed` and
once in a balance. All pinned in the prototype (cases A, C/D, G, I, J).

## 20. Settlement ordering

At each planned date `d`, in this order:

1. spine cash movement (given; unchanged by L1)
2. scenario outflows dated `d`
3. interest on each modelled liability for `days(prev, d)`
4. stated minimum payments, `min(minimum, balance)`
5. allocation rules dated `d`, insertion order, each reading `spine − consumed`, waterfalling
   through its targets
6. investments from the opening (contributions earn from their date, half-open — unchanged)
7. checkpoint: aggregate debt, net worth

Derivation: 1–2 and 5–7 are today's order; 3 precedes 4 so a minimum reduces a balance that
already carries the month's interest (conservative, matches issuer practice); 4 precedes 5 so a
floor rule reads cash after the required payment — "everything above $10k" means above the
floor *after* what must be paid. Crossing-month implication: the payoff checkpoint is the first
month-end whose aggregate balance is 0 after step 5, so `debt ≤ 0` crosses in the month the
last payment settles, and `previousCheckpoint` shows the residual it cleared.

## 21. Crossing integration

No change to `scenario_crossing`: `metric: 'debt', direction: 'at_or_below', threshold: 0`
now walks a moving line. Payoff month, `elapsed`, `previousCheckpoint` (the last positive
balance), `alreadySatisfied` (opening Σ owed = 0, as on the dogfood Space today), and
`neverCrossesBy` (prototype B: $300 minimum on $10k at 24% ends the 40-month window at $3,779)
all come from existing code. Partial APR knowledge: `assumptionsInForce.liabilities` lists the
modelled and unmodelled lines and `interestBasis`.

## 22. Goal-seek integration

Reuse the `monthlyContribution` lever with a `target` on the solved schedule: "what extra
monthly payment gets me debt free by December 2028" is `solveFor: monthlyContribution, measure:
'debt', target: 0, by: 2028-12-31, contributionTarget: 'highest_apr'`. Two small additions:
`'debt'` joins `measure` and the solver's direction flips for it (the first amount at which
debt at the horizon is ≤ 0, bracket [0, Σ balance + interest]). No `monthlyDebtPayment` lever.
Bisection over a monotone-in-payment horizon debt is well-posed.

## 23. Financed-purchase implications

The line shape suffices; what a financed purchase needs is a **new hypothetical liability
opening on a date**: `newLiabilities: [{ label, onDate, principal, apr, minimumPayment |
termMonths }]` plus the down payment as an `outflows` entry, optionally `otherAssets` for the
vehicle. That is one more input array and a `termMonths → level payment` helper. Recommend a
**follow-up slice (L1.1)** after L1 lands, so L1's acceptance stays about existing debt. Nothing
in L1's design blocks it: new liabilities join the same list and the same settlement.

## 24. Debt-subtype verdict

**One generic line.** Revolving and installment debt differ in how a provider reconstructs
history (cards walk back, loans hold flat) and in what "minimum" means (level payment vs floor),
but the ledger arithmetic — accrue, pay minimum, pay extra, never below zero — is identical. The
subtype is carried for narration and for L1.1's term-based payment; it changes no settlement
rule.

## 25. Historical-payment inference verdict

**No.** Observed card payments are BEHAVIOUR EVIDENCE (the cash leg total, "you paid $27k to
cards last quarter"), never a CONTRACTUAL MINIMUM. The obligation module already refuses
regularity; `estimateMinimumPayment` is display-only. L1 baseline payments come from stated
terms alone; history stays a `get_transactions`/`get_spending` fact the model may cite.

## 26. project_cash / one-spine impact

**Scenario tools only.** The spine's spending rate is economic spending, which excludes debt
payments, so payments live in the ledger with no double count and `project_cash` is untouched.
The known limitation becomes explicit in `project_cash`'s payload: "existing liability balances
are not reduced and their payments are not deducted by this projection; use a scenario for that"
— a sentence in `basis`, not a change of arithmetic. One spine, one setup, one presenter remain.

## 27. Net-worth integration

`netWorth = liquid + investments + otherAssets − Σ balance` at every checkpoint, in the one
place the ledger composes it; crossing and goal seek read that line. Pinned by the prototype's
identities; the production test is the same assertion over the real ledger.

## 28. Conversation-envelope impact

`target`, `liabilityAssumptions` and (L1.1) `newLiabilities` are arguments of the same scenario
tools, so the envelope carries them verbatim with no change. Follow-ups change one field each:
"$500 extra" → a rule's `amount`; "make that $800" → same field; "keep $15k" → `liquidFloor`;
"target the highest-APR one" → `target`; "what if the APR were 18%" → `liabilityAssumptions[].apr`;
"when am I debt free" → the crossing head over the same object; "by next December" →
`searchThrough` or goal seek `by`. The IGNORE rule for assumption-free crossings needs
`liabilityAssumptions` added to `ASSUMPTION_KEYS`.

## 29. Memory implications (banked)

"Always keep $20k before paying extra debt" = durable rule (floor + target); "debt free by 2028"
= INTENTION `{ targetMetric: 'debt', targetAmount: 0, byDate }` — representable today; "pay
highest APR first" = preference. The first and third need the INTENTION-carries-a-rule payload
noted in the compositional report §15. Balances, APRs and minimums stay financial-data authority.

## 30. Tool-surface impact

No new tool. `SCENARIO_INPUTS` gains `contributions[].target` and `liabilityAssumptions[]`;
`scenario_goal_seek.measure` gains `'debt'`. Results gain `liabilities[]` per checkpoint,
`assumptionsInForce.liabilities` (modelled/unmodelled, `interestBasis`), and `interestToDate`.
Estimated schema growth ≈ 1.2 KB across three tools. Descriptions must say what `target` is
*not* for (new borrowing) — the measured lesson from the surplus and returns proxies.

## 31. Prototype results

`tmp/floor/liab-proto.ts`, 30/30: A (0% APR, minimum, payoff month exact), B (24% APR ACT/365
accrual, minimum after interest, never-crosses within window), C/D (two APRs, waterfall in the
clearing month), E/F (floor targeting debt, pause under the floor, resume, no sale), G
(overpayment, remainder liquid or invested by fallback), H (unknown APR unmodelled, explicit 0
modelled), I (0% conservation at every checkpoint), J (interest identity), phase transition
(one scenario), plus adversarial below.

## 32. Adversarial results

| case | behaviour |
|---|---|
| APR missing | unmodelled, payments only, gap named |
| minimum missing | no baseline payment, `noStatedMinimum` |
| due date missing | irrelevant — month-end settlement |
| 0% promotional APR | explicit 0 modelled; expiry banked (0 rows) |
| payment exceeds balance | clamped, remainder liquid or next target |
| two equal APRs | balance desc, then id |
| liability reaches zero mid-allocation | waterfall continues same settlement |
| floor drops below threshold after payment | rule pays 0 next month, minimum still paid |
| negative cash | stated amount paid only up to the balance; warned like outflows |
| new interest after partial payment | accrues on the reduced balance next period |
| multiple payments same month | insertion order; both settle |
| outflow + debt payment same date | outflow, minimum, then rule sees what is left |
| debt payment + investment same date | both settle in insertion order |
| user APR override vs provider | `liabilityAssumptions` wins, echoed USER_ASSUMED |
| closed / paid-off liability | opens at 0, accrues and pays nothing |
| stale terms | freshness is per-row in the accounts payload; echo `rateSource` and let narration say so — no engine change |

## 33. Recommended L1 boundary

**One coherent slice**: liability lines with accrual, stated minimums, `target` on the existing
contribution rule (single or ordered list, `highest_apr` waterfall), `liabilityAssumptions`,
crossing on `debt` becoming live, goal seek `measure: 'debt'`. Defer: new hypothetical
liabilities and term-based payments (L1.1), promo expiry, lowest-balance/pro-rata targets,
memory payload. Splitting A/B/C would ship a moving debt line nobody can direct money at, which
is the same half-capability the obligation module was left unwired to avoid.

## 34. Proposed deterministic acceptance

Ledger tests (synthetic): the §19 identities at every checkpoint; each §31 case; §32 table;
ordering pins; rejection of negative liability payments, unknown target ids, a rule naming two
targets outside a list. Tool tests: crossing `debt ≤ 0` payoff month and elapsed; goal seek
`measure: debt`; `assumptionsInForce.liabilities` echo; envelope inheritance across the §28
follow-ups; baseline-crossing IGNORE with `liabilityAssumptions`. Real Space (`ai:liquid-floor-
check` sibling): opening liabilities from the payload = today's `amountOwed` (0 and 9.75),
`missingDebtFields` reproduced as `unmodelled`, `alreadySatisfied` for debt-free, and a
`liabilityAssumptions` override on the $9.75 card producing a one-month payoff. Dogfood (with a
synthetic debt fixture Space if one can be seeded without touching the real one): "when will I
be debt free", "$500 extra on the card", "keep $10k and pay the highest-rate card, then invest",
"invest this $5k or pay down debt" (two scenarios, same horizon, compared).

## 35. Estimated files / scope

`scenario-ledger.ts` (liability types, settle steps 3–5, per-checkpoint lines; ~200 lines),
`tools.ts` (opening liabilities from the payload, `target` and `liabilityAssumptions` in
`SCENARIO_INPUTS`, echo, `measure: debt`; ~120 lines), `active-scenario.ts` (one key),
`scenario-crossing.test.ts` / new `liability-dynamics.test.ts` (~300 lines), a real-Space check
script, baseline pins (tool count unchanged, `...SCENARIO_INPUTS` count unchanged). Comparable to
Slice A plus Slice B.

## 36. Overall verdict

**READY TO IMPLEMENT L1.** The authorities exist and are already single-owner; the prototype
reproduces every identity; the only evidence gap — APR and minimum are user-entered and absent
on the dogfood Space — is handled by refusal-with-gap and a user override, which is the same
posture the product already takes.
