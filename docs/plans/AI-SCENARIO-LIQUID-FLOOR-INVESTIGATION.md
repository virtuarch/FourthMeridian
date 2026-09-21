# Scenario reasoning defects: the liquid-floor conversation — investigation

**Date:** 2026-09-14 · **Investigation only. No repository behaviour changed.**
Authority: 72d686e (surplusFraction), 23f1034 (scenario_crossing), bca5119 (advisor permission),
c5874ea (active-scenario envelope), 989d63d (production promotion), 58b352f (dogfood gate).

> ## Verdict: MODIFY the hypothesised split, then SHIP
>
> Every defect in the dogfood conversation traces to **three structural facts**, none of them prompt
> facts:
>
> 1. **The engine has no rule that reads a cash BALANCE against a FLOOR.** `surplusFraction` is a
>    share of what a month *adds*; `fractionOfLiquid` is a share of everything held. "Everything
>    above $50k" is neither, so the model substituted the nearest rule it had — measured 4/4 live
>    runs, silently in 3 of them.
> 2. **A quarterly table cannot be requested, and a monthly one over 80 months is silently
>    truncated in the middle.** The dogfood horizon (2029-12-31) defaults to *yearly*: four rows.
>    Asked for quarters the model has nothing to sample, so it interpolates. Reproduced live: a
>    102-month request was clamped to 80 checkpoints, the tool dropped 2033-06..2034-12, and one of
>    two runs invented those seven rows (off by $1.4k–$8.6k, smoothed toward the endpoint).
> 3. **No tool states elapsed time**, so "1.5 years" for a date 5½ months away had nothing to be
>    checked against.
>
> **Recommended sequence: three product-shaped slices, not four.** The hypothesised Slice B
> (crossing + envelope integration) needs *no code of its own*: `scenario_crossing` and
> `scenario_goal_seek` take `SCENARIO_INPUTS` verbatim and the envelope stores arguments verbatim,
> so a contribution rule added to the union reaches both for free. What remains of Slice B is a
> one-line capture rule (a baseline crossing must not evict the hypothetical).
>
> A prototype of the floor rule over the real Space's own cash spine answers the five acceptance
> questions with **one tool call each**: $50k liquid **2027-02-28**; $1M net worth **2035-02-28**
> holding liquid at exactly $50,000 from the crossing month on; $75k floor → **2035-03-31**;
> 5% → **2035-09-30**. Conservation at 0% measured **$0.00** over 361 checkpoints.

---

## 0. Evidence used, and one thing that could not be read

The dogfood conversation itself is held in the browser's transcript cache (`fm:ai-transcript:v1:…`,
36,107 chars, 24 h TTL). Reading it out of Chrome was **refused by the Claude Code permission
classifier** ("PII Data Handling"). The brief's quoted failures A–F and the quoted figures
($38,031 / $13,898 / $27,054 / +$24,150; 2029-12-31 liquid ~$155.8k, investments ~$164.8k,
net worth ~$320.7k, contributions ~$141.2k; 81.4%; 82% → ~$754.8k; ~$14.6k liquid) were therefore
the primary transcript evidence. **Every one of those figures was reproduced to the cent by
calling the tools directly** (§16–§18), which is what allows the failure trace to be stated as
fact rather than inference.

Other evidence, all in `tmp/floor/`:

| artefact | what it is |
|---|---|
| `repro-tools.ts` → `out/repro-tools.json` | tools called directly on the real Space with the dogfood's argument shapes; prototype floor rule over the same spine |
| `synthetic-floor.ts` | prototype rule on a synthetic spine with falling months, an outflow, a bonus, and a floor already met (17/17 checks) |
| `goalseek-variants.ts` | which horizon produced 81.4% |
| `dogfood-current.ts` → `out/dogfood-current.log` | the five acceptance questions and the dogfood correction sequence through the **shipped runtime** (`openTranscript` + `executeTurn`, gpt-5.1, compaction on), 2 trials each, 18 turns |
| `verify-tables.ts` | every disputed table row checked against an engine run to that exact date |

Nothing was written to the database.

---

## 1. Reproduced dogfood failures

### A. "7% on everything after I hit 50k cash" → no new investing, 7% only on existing
`SCENARIO_INPUTS` offers three ways to move money: `amount`, `fractionOfLiquid`, `surplusFraction`.
None is conditioned on a balance. The tool description for `surplusFraction` says "*it never
touches the balance the user already has*", which is the opposite of "keep $50k and invest the
rest". A model reading the contract finds nothing that fits and falls back to the one thing that
is representable: the return. Live rerun (DOGFOOD#1 T1) reproduced the same class differently —
it chose `fractionOfLiquid: 1` monthly, drove cash to −$140, and then diagnosed its own run as
"too aggressive as stated".

### B. Understood "cash to $50k, then invest surplus" → ran 50% of surplus from 2026-09-30
`surplusFraction` with no `from` generates its month-end grid from `asOf`, so the first
contribution is 2026-09-30. The tool result does echo `surplusRule.from: "2026-09-30"`; the
substitution was visible in the payload and not in the prose. The 50% is the model's own choice
(there is no floor to express, so it hedged with a share).

### C. "Everything after I hit 50k" → 100% of surplus from 2026-09-30; liquid ends ~$14.6k
Reproduced exactly: `scenario_crossing{netWorth ≥ 1M, 7%, [{surplusFraction: 1}]}` crosses at
**2034-12-31** with **liquid 14,610.35** — the opening cash, held flat forever, because every
month's surplus is swept from the first month-end. The $50k threshold never entered the
computation; it had no parameter to enter through.

Live rerun, both variants seen: `surplusFraction: 1, from: "2027-01-31"` (a month **before** the
crossing; cash frozen at **$36,042**, narrated as "*you keep roughly this as your floor*"), and
`from: "2027-02-28"` (cash frozen at **$47,472** — the February surplus was swept in February,
taking cash *under* the floor; narrated as "*you keep liquid cash around $50k*").

### D. 81/82% quarterly table: invented, then smoothed, then engine
Root cause is structural. For a 2029-12-31 horizon (~1,205 days > 550) `prepareScenario` defaults
to **yearly**: the result has **four checkpoints**. There is no `quarterly` option. A model asked
for quarters must either interpolate or re-call with `granularity: 'monthly'` (40 rows, 34 KB).
The dogfood took the first path twice. Live rerun: for the 2035 horizon the model did ask for
monthly, the 102-month grid was **clamped to 80** (`MAX_SCENARIO_CHECKPOINTS`: first 79 + the
horizon), so **2033-06-30 … 2034-12-31 were absent from the tool result**. Trial 1 printed dashes
and said so; trial 2 printed seven rows that do not exist:

| date | engine investments | model's row | error |
|---|---|---|---|
| 2033-06-30 | 721,381.93 | 719,964 | −1,418 |
| 2033-12-31 | 789,467.59 | 790,721 | +1,253 |
| 2034-06-30 | 859,891.44 | 863,042 | +3,151 |
| 2034-12-31 | 932,782.79 | 941,337 | +8,554 |

The error grows toward the endpoint: a curve fitted between the last real row and the known
horizon. That is the dogfood's "82% table whose endpoint came from the engine but whose
intermediate values were smoothed", reproduced under the shipped runtime.

### E. 2027-02-28 described as "1.5 years from now" (from 2026-09-13)
5 months 15 days. No tool result carries elapsed time; the model computed it and got it wrong.
The live rerun said "about 5½ months" in 2/2, so the residual rate is low, but nothing structural
prevents it.

### F. "Run the exact scenario" → "cannot run it", directional 2034–2036
The model was right: the rule is not representable. `from` on `surplusFraction` gives a date, not
a floor (§2). Under the live rerun the honest variant appeared once (ACCEPT#2 T3: "*would require
a different, stricter rule than this surplus-only setup*") and the dishonest variant once
(ACCEPT#1 T3: "*a $75k cash floor is never actually binding — you're not projected to get that
high in cash*" — an explanation of a floor the engine never applied).

### Classification

| | primary | secondary |
|---|---|---|
| A | **tool expressiveness** | intent interpretation |
| B | **tool expressiveness** | narration (the `from` date was echoed, not read) |
| C | **tool expressiveness** | unsupported approximation, narration |
| D | **deterministic calculation (checkpoint contract)** | unsupported approximation; verification |
| E | **temporal arithmetic** | — |
| F | **tool expressiveness** | unsupported approximation (directional estimate) |

Not classified as routing: every live turn called a scenario tool (18/18), and the correct one.
Not classified as active-scenario continuity for A–F: the envelope faithfully carried the
substituted assumptions. One continuity defect *was* found (§11).

---

## 2. Current tool capability (inspected, not inferred)

`lib/ai/conversation/scenario-ledger.ts`, `tools.ts` §11–12, `scenario-crossing.ts`,
`active-scenario.ts`.

- **`ContributionSpec`** (ledger:151): `{onDate, amount|fractionOfLiquid}` · `{from, cadence,
  amount|fractionOfLiquid}` · `{surplusFraction, from?, to?}`. Exactly one basis per rule, enforced.
- **`surplusFraction`** base = `spine(d) − spine(baseDate)`, the projection's *own* month delta,
  **before any movement** (`consumed` deliberately not subtracted, ledger:598). Falling month → 0.
  Grid generated from `asOf`, tail taken from `from`.
- **`fractionOfLiquid`** base = `spine(d) − consumed` (ledger:624): the running balance after
  outflows and earlier contributions. Clamped at 0.
- **`outflows`**: dated, signed (negative = inflow); settle **before** contributions on the same
  date (rank OUTFLOW 0, CONTRIBUTION 1). Enter the ledger, never the spine.
- **`annualReturnPct` / `returns[]`**: ACT/365, half-open (`growthFactor`), from `asOf`.
- **Investments at d** = opening × G(asOf,d) + Σ c × G(c.date,d): every checkpoint from the
  opening, never carried forward.
- **`scenario_crossing`**: walks every month-end to ≤30 years through one ledger run; returns
  crossing / alreadySatisfied / neverCrossesBy, `previousCheckpoint`, `assumptionsInForce`.
  Consumes `SCENARIO_INPUTS` unchanged.
- **`scenario_goal_seek`**: bisection over `setup.run`; solves return, monthly contribution, or
  spending cut; the ledger returned is the one run at the answer.
- **Active scenario** (`captureActiveScenario`): on any successful `scenario_projection` or
  `scenario_crossing`, `{assumptions: args verbatim, result: six numbers}`; REPLACE / CLEAR /
  IGNORE; injected as a trailing `system` message; carried across stateless turns in a sealed
  cookie ≤ 3,000 chars.
- **Checkpoints**: `granularity: yearly|monthly`; default yearly beyond 550 days; monthly grid
  clamped to `MAX_SCENARIO_CHECKPOINTS = 80` keeping the first 79 + horizon; `clampedTo` reported,
  the dropped range is not.

### What the user's rule needs, field by field

| clause | expressible today? | how |
|---|---|---|
| "Let cash grow normally until liquid reaches $50,000" | **yes** | `scenario_crossing{metric: liquid, at_or_above, 50000}` → 2027-02-28 |
| "Once above $50,000, keep the reserve …" | **no** | no parameter reads a balance against a threshold |
| "… and invest all excess / new surplus" | **partly** | `surplusFraction: 1, from: <date>` invests the *flow*; the crossing month's excess above the floor stays in cash, and any later fall is never rebuilt |
| "Investments earn 7%" | yes | `annualReturnPct: 7` |
| "First date net worth reaches $1,000,000" | yes | `scenario_crossing{metric: netWorth, …}` |

### The exact representational gap (measured on a synthetic spine, `synthetic-floor.ts`)

Spine: +6k/month, crossing 50k at 2027-01-31 (52k), a −9k month at 2027-03-31.

| | floor rule (prototype) | `surplusFraction:1, from: month after crossing` |
|---|---|---|
| crossing month | sweeps 2,000 → liquid **50,000** | nothing swept → liquid **52,000**, then 58,000 the month after (GAP-1) |
| falling month (spine 49k) | contribution 0, liquid 41,000 | contribution 0, liquid 49,000 |
| recovery months | paused until balance > floor, then sweeps only the excess; liquid returns to 50,000 | every positive month swept; liquid **stuck at 49,000 forever, below the floor** (GAP-2) |

The gap is not a missing date. It is that the existing rules are **flow**-based and the user's
rule is **stock**-based: it reads a balance.

---

## 3. Proposed primitive: excess above a liquid floor

Recommended shape, **inside the existing contribution union**:

```ts
| { liquidFloor: number; fractionOfExcess: number; from?: string; to?: string; label?: string }
```

Semantics at each month-end `d` (after the spine's ordinary movement and any outflow dated `d`):

```
available    = spine(d) − outflowsToDate(d) − contributionsToDate(d⁻)   // the running balance
excess       = max(available − liquidFloor, 0)
contribution = round2(fractionOfExcess × excess)
liquid(d)    = available − contribution
investments  += contribution   (earns from d onward, half-open, like every other contribution)
```

This is `fractionOfLiquid`'s existing settle path (`projected − consumed`) with the floor
subtracted. It adds ~15 lines to `settleMovements`, one branch to `expandContributions` (same
month-end grid as `surplusFraction`, generated from `asOf`), one pass-through in
`prepareScenario`, and one echo (`floorRule`) in `scenarioAssumptions`.

**Why in the union and not a separate field.** The union is where "money moved into investments"
lives; `settleMovements` already orders outflows before contributions on a date; the one-basis
check already rejects a rule naming two bases; `scenarioAssumptions` already echoes rules;
`scenario_crossing` and `scenario_goal_seek` spread `SCENARIO_INPUTS` and need nothing; the
envelope stores the arguments verbatim and needs nothing. A separate field would create a second
place to look for contributions and a second echo path.

**Compared with the alternatives.**

| option | verdict |
|---|---|
| `surplusFraction` + fixed `from` | wrong stock semantics (GAP-1, GAP-2); two calls; the model must carry the date |
| `fractionOfLiquid` | sweeps the reserve itself (measured: 0.75 monthly drains to ~$2.3k) |
| conditional-rule DSL | out of scope by brief; nothing in the dogfood needs a second condition |
| trigger date in one call, run in a second | what happens today; drifts, and the composition at the crossing is wrong |
| `reserveFloor` / `cashSweep` names | see §5: "reserve" promises protection the engine does not give |

**Prototype results on the real Space** (`repro-tools.ts`, prototype over the *same*
`project_cash` spine, same `growthFactor`):

| rule | first contribution | $1M net worth | liquid at crossing |
|---|---|---|---|
| floor 50k, 100%, 7% | 2027-02-28: $4,044.40 | **2035-02-28** (1,001,443.24; prev 989,979.48) | 50,000.00 |
| floor 75k, 100%, 7% | 2027-06-30: $3,904.85 | **2035-03-31** (1,000,593.10) | 75,000.00 |
| floor 50k, 100%, 5% | 2027-02-28 | **2035-09-30** (1,004,497.29) | 50,000.00 |
| floor 50k, 50%, 7% | 2027-02-28: $2,022.20 | 2035-03-31 (1,013,270.54) | 58,941.90 |
| floor 50k, 100%, 7%, $2M | — | 2040-08-31 (2,004,550.34) | 50,000.00 |
| floor 10k (already exceeded) | 2026-09-30: $7,467.85 | 2034-12-31 | 10,000.00 |

For comparison, what current tooling produced for the same words: 2034-12-31 with liquid
$14,610 (dogfood C), or 2035-02-28 with liquid $47,472 (live rerun), and *no change at all* for
$75k.

---

## 4. Activation semantics

| | reading | what it does to the crossing month |
|---|---|---|
| A | the first month-end at or above the floor sweeps the excess above the floor | 54,044 → 50,000 + 4,044 invested |
| B | reach the floor, then invest only *subsequent* surplus | 54,044 stays; excess never invested |
| C | derive the crossing date, activate the following month | same as B, one call later |

**Recommend A, alone.** "Everything after I hit $50k" and "everything above $50k" are the same
sentence to a person: the reserve is $50k, not "$50k plus whatever month I happened to cross in".
B and C both leave a permanent, accidental over-reserve (GAP-1) and, because they are flow rules,
cannot rebuild the floor after a fall (GAP-2). A user who means B can say "start in March" — the
optional `from` covers it. Do not add an activation parameter.

Activation is therefore not a separate concept: **the first month-end whose running balance
exceeds the floor is the first month with a non-zero contribution.** The echo should name it
(`firstMonthEndAtOrAboveFloor`) so Q1 ("when do I hit $50k?") is answered by the same call as Q2.

---

## 5. Cash-floor semantics

"Do not invest below $50k" ≠ "cash never falls below $50k". The engine does not model a protected
account; ordinary spending, a falling month, or a stated outflow can and will take liquid under
the floor, and the rule must not be the thing that does.

**Name: `liquidFloor`.** It names the line it reads (`liquid` = checking + savings, the same
population `scenario_crossing`'s `liquid` metric uses) and says what it is — a floor for the
*rule*, not a guarantee. "Reserve target" and "minimum cash reserve" both promise something the
engine cannot keep; "excess-cash threshold" hides the number that matters.

**Deterministic invariant:**

> The contribution rule never reduces liquid below `liquidFloor`. When liquid is at or below the
> floor for any reason, the rule contributes nothing until the running balance exceeds the floor
> again. Nothing else about the path is constrained.

The echo should report `monthsBelowFloor` (count of months in the window where the rule was
paused) so a falling spine is narrated as "cash dipped under $50k in March and the rule paused",
not as "you always kept $50k".

---

## 6. Conservation

At any checkpoint `d`, with `S` the spine, `O` outflows to date, `C` all contributions to date,
`I₀` opening investments, `A` other assets, `D` debt:

```
liquid(d)      = S(d) − O(d) − C(d)
investments(d) = I₀·G(asOf,d) + Σ_{c≤d} c·G(c.date,d)
netWorth(d)    = liquid + investments + A − D
```

At 0% every `G = 1`, so `netWorth(d) = S(d) − O(d) + I₀ + A − D`, **independent of C**. A floor
contribution is one term of `C(d)`; it enters liquid with a minus and investments with a plus in
the same checkpoint. That is the same argument the surplus rule already relies on, and it holds
for any rule whose contribution is a function of `(S, O, C(d⁻), parameters)` — the floor rule
reads only those.

Measured: synthetic H (every checkpoint equal to baseline, 0 diff); real Space
`maxNetWorthDiffVsBaselineAt0pct = 0` over 361 checkpoints with $2,532,966.27 moved.

Composition checks (all in `synthetic-floor.ts`, all pass): existing balances (I₀ grows at the
rate with or without the rule; test I asserts growth on I₀ is identical to the no-rule run);
positive returns (net worth ≥ 0% path at every checkpoint); negative returns (liquid path
*identical* — eligibility never reads investments; investments lower); negative monthly surplus
(pause, no sale); one-off inflow (a $15k bonus at 2026-12-31 is swept the same month: 11,000
invested, liquid 50,000); one-off outflow (a $20k outflow at 2027-03-31: contribution 0, no
investments sold, net worth = spine − 20k + I₀ − D); debt (held flat, untouched); fraction < 1
(the retained half is re-eligible next month, not lost and not double-swept: 7,000 excess →
3,500); floor already satisfied today (first month-end sweeps the opening excess; must be echoed
as `alreadyAboveFloorAtStart`).

---

## 7. No recursive-eligibility bug: ordering, precisely

The surplus rule must **not** see `consumed` because its base is a flow: subtracting past
contributions from a month's delta would shrink every month's base by the previous month's
contribution. The floor rule must **see** `consumed` because its base is a stock: without it, the
same excess would be swept again every month. Two rules, two bases, opposite requirements — and
`settleMovements` already has both paths (`projectedSurplus` from two spine points; `available =
projected − consumed`). The floor rule takes the second.

What the contribution at `d` never feeds: its own `excess` (read before it is taken), the spine
(never mutated), the surplus base of any other rule on the same date (spine deltas), and returns
(a contribution dated `d` earns from `d` exclusive).

Order on one date, unchanged: **outflows → contributions in insertion order.** A floor rule and a
surplus rule on the same date each settle against what the previous one left (`consumed`), which
is what "buy the car, then keep $50k and invest the rest" means.

---

## 8. Ledger ordering (current, and the compatible change)

Current, per spine date (`lib/forecast/engine.ts:456–500`): opening balance → **accrual** of the
observed daily spending over the elapsed days → same-day **events** aggregated (payroll in,
licensed outflows out) → closing. Per ledger checkpoint (`scenario-ledger.ts:662–744`): liquid =
spine closing − outflows ≤ d − contributions ≤ d; investments from the opening with half-open
growth; net worth composed.

Recommended month-end sequence with the floor rule, i.e. the existing sequence with one insertion:

```
opening → spine accrual + events (ordinary cash movement) → stated outflows on d
→ floor contribution on d (reads the running balance after the above)
→ other contributions on d → returns accrue from d onward → checkpoint on d
```

Returns before the month-end contribution would credit a contribution with growth for a month it
was not invested, would make `investmentGrowthToDate` non-zero on the contribution's own date, and
would break "the last checkpoint equals a standalone run". ACT/365 half-open stays as it is.

---

## 9. Crossing composition

`scenario_crossing` needs **no change** to consume the rule: it spreads `SCENARIO_INPUTS`, hands
them to `prepareScenario`, walks one ledger. The preferred experience is therefore already the
architecture:

```
scenario_crossing{ metric: netWorth, at_or_above, 1_000_000, annualReturnPct: 7,
                   contributions: [{ liquidFloor: 50000, fractionOfExcess: 1 }] }
→ crossing 2035-02-28 · assumptionsInForce.contributions.floorRule
  { liquidFloor: 50000, fractionOfExcess: 1, firstMonthEndAtOrAboveFloor: "2027-02-28",
    monthsBelowFloor: 0, contributed: … }
```

Repository evidence is **against** two-stage computation: the live rerun's two-stage answers put
liquid at $47,472 or $36,042 "as the floor", and the second stage had no representation of the
first stage's meaning. Keep the crossing metric on `liquid` available for the pure question "when
do I hit $50k on my current trend?" — it is a different question and was answered correctly 4/4.

---

## 10. Active-scenario representation

The envelope stores arguments verbatim; a floor rule is ~55 chars of arguments (`{"liquidFloor":
50000,"fractionOfExcess":1}`), well inside the 3,000-char cookie seal. Follow-ups change one field:

| follow-up | field |
|---|---|
| "What if I keep $75k instead?" | `contributions[0].liquidFloor` |
| "Make it 50% of the excess." | `contributions[0].fractionOfExcess` |
| "What if returns are 5%?" | `annualReturnPct` |
| "What about $2M?" | `threshold` |
| "Actually start doing that after $100k." | `contributions[0].liquidFloor` |

Measured with current tooling (ACCEPT trials): 4/4 follow-ups changed exactly one variable and
inherited the rest — the envelope mechanism works. The failures were in *what* the variable was.

**One continuity defect found (live, DOGFOOD#1).** After the model established the sweep scenario,
the user's "when would I hit $50k on this trend" produced a *baseline* `scenario_crossing` (no
assumptions), which **REPLACED** the envelope with `{metric: liquid, threshold: 50000}` — the
hypothetical was evicted. The next turn, "give me a quarterly table of that", was answered with the
baseline table, rule dropped, labelled "*no extra investing rule applied*". Recommend:
`captureActiveScenario` returns IGNORE for a crossing that carries no assumption
(no `annualReturnPct`/`returns`/`contributions`/`outflows`/`assumedMonthlySpending`) — a baseline
question is not a hypothetical. With the floor rule, Q1 and Q2 become one call and the eviction
does not arise; the IGNORE rule is defence for the case where the user asks them separately.

---

## 11. Unsupported-condition rule

The bad sequence (user asks A → model computes A′ → answers as A) was reproduced 3 times in 4
live opportunities. The runtime rule:

> A material scenario condition the user stated may not be dropped, approximated or transformed
> without saying so in the answer. If the tools cannot represent it exactly: say that, and either
> stop or offer a clearly labelled approximation that is *not* presented as the requested scenario.

Once the floor rule exists this rule has almost nothing left to bite on in this class of
conversation — the substitution happened because the honest option did not exist. It still
matters for the next unrepresentable condition (e.g. "once my debt is gone", "if I get a raise in
2028"). One sentence in `SYSTEM_INSTRUCTION` (§20), added **after** Slice A, and measured.

Second half of the rule, for the tools: a tool that *cannot* apply something must say so in the
payload. `rejected[]` does this for malformed inputs today; it does not fire for a label like
"invest everything above 50k liquid" attached to a `surplusFraction` rule, because the label is
free text. Do not parse labels. The fix is the primitive.

---

## 12. Numerical-table authority

Why fabrication happened, structurally: the model had (a) a four-row yearly result and a request
for quarters, or (b) an 80-row result with a 22-month hole immediately before the answer. In both
cases the endpoint was known and the intermediate rows were not. Interpolation is the model doing
what it was asked with what it had.

Invariant to establish: **every projected value at a future date in a reply exists in a tool
result of this conversation.** Make it structurally easy rather than policed: (1) let the model
ask for the cadence the user asked for (§13); (2) when checkpoints are dropped, say *which*
(`omitted: {from, to, months}`) so the honest answer ("2033-06 to 2034-12 not computed") is a
field, not a discovery; (3) keep the answer row always present (already true: the horizon is never
trimmed). With those three, the model may choose rows, round, format, compare and narrate, and has
no reason to interpolate.

Measured with the offline scorer in `dogfood-current.ts` (dollar figures ≥ $1,000 in an answer
matched against every number in the session's tool results, ±0.6%): DOGFOOD#2 T2's 14-row
quarterly table was **fully engine-backed** (every row verified to the dollar in
`verify-tables.ts`); ACCEPT#2 T2's 35-row table had **7 fabricated rows**. Same model, same turn
shape; the difference was whether the rows existed in the payload.

---

## 13. Checkpoint output and tool-result size

Today: yearly | monthly; default yearly > 550 days; monthly clamped at 80 by dropping the middle.

| request | checkpoints | bytes | what the model got |
|---|---|---|---|
| to 2029-12-31, default | 4 (yearly) | 11,669 | nothing to build quarters from |
| to 2029-12-31, monthly | 40 | 33,948 | enough; the model sampled correctly (DOGFOOD#2 T2) |
| to 2035-02-28, monthly | 80 of 102 | 66,573 | a hole at 2033-06..2034-12 |

The bulk is `movements[]` (one entry per month, 100+ over a long horizon) beside `checkpoints[]`
which already carries `sincePreviousCheckpoint.contributions`. Prompt tokens after a monthly call
went 17k → 40k → 64k for the rest of the session (ACCEPT), i.e. the table's cost is paid on every
later turn until compaction elides it.

Recommend, without touching calculation semantics:

1. `granularity: 'quarterly'` (`quarterEndsBetween`, same "last entry is the horizon" property);
   auto-default monthly ≤ 18 months, quarterly ≤ 20 years, yearly beyond — the 80-checkpoint cap
   is then only reached by an explicit monthly request.
2. When clamped, report `omitted: {from, to, count}` beside `clampedTo`, and prefer *thinning to
   the next coarser cadence* over dropping a contiguous run before the horizon.
3. `movements` → first 12 + `count` + `total` (the `assumptions.contributions.settled` slice
   already exists); the per-checkpoint deltas stay.

Expected size: a 20-year quarterly table is 80 rows at ~200 B ≈ 16 KB with `movements` trimmed,
versus 66 KB for 80 monthly rows today; a 30-year horizon (120 quarters) falls to yearly under the
auto-default unless quarterly is asked for explicitly, in which case the clamp applies and names
what it omitted. The crossing tool is unaffected (it returns no table).

---

## 14. Exact vs illustrative

Illustrative **assumptions** (a rate the user left open, a share they called "some") remain the
model's to choose, labelled — Slice C's rule, measured 5/5, unchanged. Illustrative **output** —
any projected dollar value at a future date not produced by a deterministic tool — has no
legitimate use while the scenario tools can compute it. Boundary: *the model may say "let's test
7%"; it may not say "~$460k here" unless a tool said $460k there.* The one honest exception is a
refusal: "the engine cannot represent X; directionally later than 2035" is allowed **only** when
labelled as not computed, which is what F should have been.

---

## 15. Temporal arithmetic

Smallest fix: a pure `elapsedBetween(fromISO, toISO)` beside `scenario-crossing.ts` returning
`{ months, days, monthsFractional, years }` (calendar months then residual days; fractional =
days/30.44, years = /12), emitted as `elapsed` on `crossing`, `neverCrossesBy`, and
`previousCheckpoint`, measured from `asOf`. About 20 lines, no dependency. `2026-09-13 →
2027-02-28` = `{months: 5, days: 15, monthsFractional: 5.5, years: 0.46}`. The model narrates
"about five and a half months" from a field instead of computing it.

**Other dates that should carry elapsed time** (§16): `scenario_goal_seek.by` (years to the
target), `find_in_balance_history` results ("how long ago"), `alreadySatisfied` (0 by
definition — say "today"). Leave to narration: rounding ("about ten years"), comparisons between
two crossings ("seven months later" — both carry `elapsed.months`, the subtraction is safe).
No natural-language date engine.

---

## 16. Surplus-baseline audit ("monthly surplus ≈ $8,000")

What the model was shown (`FINANCIAL ORIENTATION.recent`, 2026-06-15..09-13, 90 days): income
38,031.77 · spending 13,898.33 · cardAndDebtPayments 27,053.92 · **netCashFlow 24,149.76**.

`netCashFlow = income − max(0, spendGross − refunds)` (`transactions.ts:916`) =
38,031.77 − (13,898.33 − 16.32) = 24,149.76 ✓. **Debt and card payments are not subtracted** —
by design (REVIEW-3 C-3: "a debt payment is capital directed at a goal, not consumption");
`netAfterDebtPayments` = −2,904.16 ships beside it, unquoted.

So the transcript's sentence "+$24,150 already includes spending and debt payments" is **wrong
about debt payments**. Whether *excluding* them is right depends on population: card purchases are
in `spending` (the card accounts are in scope; 452 rows across accounts) and the two card
accounts are in credit (−815.06, −26.83; `amountOwed: 0`), so the $27k paid to cards in 90 days
repaid purchases already counted as spending plus a pre-existing balance. Netting them again would
double-count. The economic net is the right *concept*; it is not cash accumulation over the
window (cash grew by far less while the cards were paid down).

Is $8,000/month the spine's number? No. The spine (`project_cash`) uses payroll cadence
(BIWEEKLY 5,286.645 → ~11,454/month) and observed spending **4,346.48/month from two complete
months (July 2,290 / August 6,403)**, giving 6,143–6,572 in two-paycheck months and 11,430 in
three-paycheck months: **~7,130/month over 40 months** (14,610 → 297,078). The 90-day window
contained seven paychecks, so 24,150 ÷ 3 overstates the steady state by ~13%. The error stayed in
prose — every scenario figure came from the spine — but it is the number the user reasoned from.

Minor: the orientation window starts 06-15 and `get_spending`'s default starts 06-16, giving
netCashFlow 24,149.76 vs 24,219.25 ($69.49) and spending 13,898.33 vs 13,828.83 for "the last 90
days" in the same conversation. One `daysAgoISO(to, 89)` vs `90`.

---

## 17. 50%-scenario consistency

`scenario_projection{to: 2029-12-31, contributions: [{surplusFraction: 0.5}]}` reproduces the
quoted table **exactly at 0% return**: liquid 155,844.14 · investments 164,811.96 · net worth
320,656.10 · contributions 141,233.93. The 7% the user asked for was **not in that table** (7% gives
187,094.70 / 342,938.84). The engine's default return is 0 and the model did not pass it — that is
failure A's other half.

The return columns were all engine-backed against the same 0%-baseline rule and horizon:

| return | investments 2029-12-31 | net worth |
|---|---|---|
| 0% | 164,811.96 | 320,656.10 |
| 6% | 183,774.19 | 339,618.33 |
| 10% | 197,338.92 | 353,183.06 |
| 82% | 598,948.27 | **754,792.41** ✓ (quoted ~$754.8k) |

---

## 18. Goal-seek consistency

81.4% does **not** come from a 2029-12-31 solve (that is 108.82%). `goalseek-variants.ts`:
**81.43% = $1M by 2030-06-30 with 50% surplus** (reached 1,000,038.71; baseline 363,519.21).
The 82% scenario that landed at $754.8k ran **to 2029-12-31**. Same opening balances, same
contribution rule, same return convention, same investment population, same spine, no spending
cut — **a six-month horizon shift**, unstated. Both figures are correct; the sentence "the same
scenario at 82%" was not.

---

## 19. Scenario identity

The envelope's verbatim arguments *are* the identity; `assumptionsInForce` echoes what ran. The
dogfood's identity failures were all **pre-tool**: the model chose arguments that did not match
its words (B, C), or changed the horizon between a solve and a projection (§18) while calling
them the same. No ID would have caught either. The one cheap addition: `scenario_goal_seek`
should echo `horizon.to` inside `assumptionsInForce` exactly as the projection does, so a
solved-by date and a projected-to date sit in the same field and a mismatch is visible.
**No new identity.**

---

## 20. Prompt role

After Slices A–C, add one sentence to `SYSTEM_INSTRUCTION`:

> Never quietly drop, approximate or reshape a condition the user stated; if the tools cannot
> represent it exactly, say so. When a tool can compute a figure, use its output and never fill in
> values it did not return.

Measure by re-running `dogfood-current.ts ACCEPT,DOGFOOD 5` with and without it, scoring
(a) substitutions disclosed, (b) untraceable figures per table. Expected effect after Slice A: near
zero either way on this conversation class; the sentence is for the next unrepresentable
condition. Do not ship it first.

---

## 21. Structural verification

Not recommended as runtime. The traceability scorer in `dogfood-current.ts` (every ≥$1,000 figure
in an answer matched against the session's tool-result numbers) is a good *test* — it separated
the 7 fabricated rows from the 28 real ones with no false positives on dollar figures (years and
thresholds like "2035" and "$50k" are the only noise, filterable). Runtime provenance would need
the model to cite row ids per cell; the cheaper structural route is §12(1–3): give it the rows.
Keep the scorer as the acceptance test for Slices B–C.

---

## 22. Test matrix (for implementation)

Unit, `scenario-ledger` (synthetic spine — the real Space has no falling month):
A no contribution below floor · B first month sweeps exactly the excess · C floor already met →
first month-end sweeps opening excess, `alreadyAboveFloorAtStart` · D falling month → 0, liquid
falls, no sale · E resumes with exactly the excess after recovery · F fraction 0.5: half swept,
remainder re-eligible, no double sweep · G fraction 1: liquid pinned at floor while surplus is
positive · H 0% conservation at every checkpoint · I positive returns: growth only on principal ·
J negative returns: identical liquid path · K bonus (negative outflow) swept same month · L outflow
below floor: 0 contribution, no sale, conservation holds · rejection: floor < 0, fraction ∉ (0,1],
floor stated with another basis · order: outflow before floor before surplus on one date.

Integration, `tools.ts`: M same arguments through `scenario_projection` and `scenario_crossing`
give the same checkpoint on the crossing date · N 30-year search under the rule < 3 s ·
`floorRule` echo fields · `SCENARIO_INPUTS` count pin (3) unchanged · tool count (17) unchanged.

Envelope: O/P/Q revision of floor / return / target changes exactly one argument field · baseline
crossing → IGNORE.

Tables: R quarterly grid; every quarter-end present; last entry is the horizon · S clamp reports
`omitted` and never drops a run before the horizon · T `elapsed` on crossing results
(2026-09-13 → 2027-02-28 = 5 m 15 d).

Conversation (harness, 5 trials): the ACCEPT sequence, one call per turn, 0 untraceable figures,
0 undisclosed substitutions; the DOGFOOD sequence, quarterly table fully traceable.

---

## 23. Real-Space acceptance (design + what was measured)

Same Space, same `asOf` (2026-09-13), no mutation. Two runs exist already:

**Prototype (deterministic, no model)** — the target numbers Slice A must reproduce:

| # | question | call | answer |
|---|---|---|---|
| 1 | first $50k liquid | `scenario_crossing{liquid ≥ 50000}` | 2027-02-28 (54,044.40; prev 47,472.04), elapsed 5 m 15 d |
| 2 | then everything above $50k at 7% → $1M | `scenario_crossing{netWorth ≥ 1M, 7%, [{liquidFloor 50000, fractionOfExcess 1}]}` | **2035-02-28**, NW 1,001,443.24, liquid 50,000, investments 951,443.24; first contribution 2027-02-28 $4,044.40 |
| 3 | quarterly table | `scenario_projection{to 2035-02-28, quarterly, …}` | 34 rows, e.g. 2027-03-31 50,000 / 34,675.38 / 84,675.38 · 2029-12-31 50,000 / 301,271.97 / 351,271.97 |
| 4 | keep $75k | one field | **2035-03-31**, first contribution 2027-06-30 $3,904.85 |
| 5 | 5% | one field | **2035-09-30** |

**Shipped runtime, current tooling** (`out/dogfood-current.log`, 2 trials): Q1 4/4 correct.
Q2 substituted `surplusFraction: 1, from: 2027-02-28` 2/2 (liquid 47,472 at $1M; disclosed 0/2).
Q3 fabricated 7 rows 1/2, disclosed the hole 1/2. Q4 changed only the label 2/2 (disclosed 1/2).
Q5 inherited correctly 2/2. 18 turns: 731,854 prompt tokens, 7,093 completion, mean 7.7 s/turn;
the two monthly tables lifted every later turn to 40–65k prompt tokens. Elapsed time stated
correctly 2/2.

Acceptance after Slice A–C: the five questions, 5 trials, one call each, crossing dates equal to
the prototype's, every table cell traceable, `elapsed` quoted, no substitution.

---

## 24. Current vs proposed, per defect

| defect | current failure | root cause | proposed authority | fixed by |
|---|---|---|---|---|
| A | rule reduced to "7% on existing" | no floor primitive; `surplusFraction` contract says it never touches the balance | `liquidFloor` + `fractionOfExcess` in the union | **Slice A** |
| B | 50% surplus from today | same; the share and the start were the model's guesses | echo `floorRule.firstMonthEndAtOrAboveFloor` | Slice A |
| C | 100% surplus from today, liquid $14.6k | same | same; liquid pinned at the floor | Slice A |
| D | interpolated quarterly rows | no quarterly cadence; clamp drops the middle silently | `granularity: quarterly`, `omitted`, trimmed `movements` | **Slice B** |
| E | "1.5 years" | no elapsed field | `elapsed` on crossing results | **Slice C** |
| F | "cannot run it", directional estimate | not representable; honest | representable; disclosure sentence for the next case | Slice A (+ C instruction) |
| §10 | baseline crossing evicts the hypothetical | REPLACE on any crossing | IGNORE for assumption-free crossings | Slice A (one line) |
| §16 | "≈$8,000 surplus" | window arithmetic in prose | none needed for scenarios; note the 06-15/06-16 offset | backlog |
| §18 | 81.4% vs 82% horizons | pre-tool | goal-seek echoes its horizon in `assumptionsInForce` | Slice A (trivial) |

---

## 25. Implementation slices (recommended)

**Slice A — `liquidFloor` contribution rule** (ledger + tools + tests A–N, O–Q, envelope IGNORE
for baseline crossings, goal-seek horizon echo). This alone makes the five-question conversation
computable in one call per turn. ~150 lines + tests. Pins to update: `baseline.test.ts` scans
`...SCENARIO_INPUTS` (3) and tool count (17) — neither changes; `scenario-ledger.ts` must keep
importing nothing.

**Slice B — checkpoint contract**: quarterly cadence, cadence auto-default, `omitted` on clamp,
`movements` trimmed. Tests R, S, size measurement (target: 30-year quarterly ≤ 20 KB).

**Slice C — `elapsed` + one instruction sentence**, measured with `dogfood-current.ts` 5 trials.

The hypothesised Slice B (crossing + envelope) is absorbed by A because both consume
`SCENARIO_INPUTS` and arguments verbatim; splitting it would ship a primitive that already works
in the crossing tool and then "integrate" nothing.

---

## 26. Risks and open questions

- **Real Space has no falling month**, so pause/resume is only exercised synthetically. Fine for
  unit tests; the live acceptance cannot show `monthsBelowFloor > 0`.
- **Two floors** (e.g. "$50k until 2028, then $100k") compose as two rules with `from`/`to`; the
  union handles it, but the echo becomes a list. Not needed now.
- **A floor plus a surplus rule on the same date** settles in insertion order; the contract should
  say so, or the one-basis-per-*scenario* rule could reject the combination. Recommend allowing
  it and documenting order.
- **Cadence auto-default change** alters which rows a *current* default call returns for horizons
  between 18 months and 550 days (monthly → still monthly; unchanged) and beyond 550 days (yearly
  → quarterly for ≤ 20 years). Any harness golden that pinned "yearly by default" needs updating.
- **Prompt-token growth after a table** (40–65k per later turn) is a cost issue independent of
  this work; compaction handles it after two turns.
- The dogfood transcript itself remains unread by this investigation; if any quoted figure in the
  brief was transcribed imperfectly, §16–§18 reproduce the figures the brief gives, not the
  transcript's.
