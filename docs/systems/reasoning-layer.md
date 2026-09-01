# The reasoning layer

**What it is:** `lib/reasoning/**` — the layer that decides what the assistant is
allowed to say about a person's money, and verifies afterwards that it said only
that.

**What it replaces:** four separate readers of the model's English.

---

## Why a typed boundary at all

Before this, the pipeline flattened typed truth into prose and then tried to
reconstruct the types out of the prose again:

| Layer | Lines | What it does |
|---|---|---|
| `numerical-guard.ts` | ~450 of regex | stateful section scoping, five character-window sizes, a cash-claim vocabulary, a hedge vocabulary, a historical-section detector |
| `output-validator.ts` | a tolerance ladder | reconciles figures against *any number anywhere in the conversation* |
| `assessment-guard.ts` | a third reader | catches a verdict the assessment refused |

All three exist for one reason: **the model was never given a way to say what it
meant.** So we inferred it, four times, with four different vocabularies.

The typed boundary gives it one. The model returns `{ claims[], prose }`, and
every claim carries the `fid` of a figure it was licensed to state. Verification
becomes an identity check.

---

## The address determines the meaning

Every figure the model may state carries four axes. Possession of a number is
never permission to use it in another role.

| Axis | Values | The failure it closes |
|---|---|---|
| `kind` | MEASURE · PREMISE | *"a user who types 'I have $50,000 saved' mints a licence the model can then assert as fact"* — the audit's own words about `output-validator.ts` |
| `unit` | CURRENCY · CURRENCY_PER_MONTH · CURRENCY_PER_YEAR · MONTHS · RATIO · PERCENT · COUNT | `$5,000/month` becoming projected savings of `$5,000` |
| `horizon` | CURRENT · FUTURE | PARITY-3: a net-worth follow-up rebuilt on an invented projection, 5/5, in both entry modes |
| `standing` | MEASURED · OBSERVED_CONTINUATION · ASSUMPTION_DEPENDENT · HYPOTHETICAL | an assumption's answer read as a fact |

### `unit` is the field doing the structural work

The premise-leak risk is concrete: a user says *"assume I spend $5,000/month"*,
and `$5,000` must not become sayable as projected savings, ending debt, or
investment growth. Policing that by **semantic role** means reading prose, which
is what this layer exists to stop doing.

Unit does it structurally instead. A rate is a different unit from a stock;
`statedAs` must render the unit; so that premise can license the sentence
`$5,000/month` and can license no sentence that says `$5,000`. *"Your projected
savings will be $5,000"* can cite no `fid`, and therefore cannot be written.

And the other direction matters as much: a filter that simply suppressed the
number would pass the leak test and be a worse product. The user's own premise
must remain sayable back to them.

### The honest limit

**`unit` does not subsume `FigureRole`.** $15,500 is a GROSS bonus — sayable as a
stated amount, not as money arriving — and both readings are `CURRENCY`. So the
existing `FigureRole` enum is carried on the figure and rendered with its caveat
in its own table section, and the verifier does not check it. What the verifier
enforces is identity, unit, horizon and kind; what the table carries is
everything the model needs to choose the right sentence.

---

## The verifier, in full

```
for each claim:
    fid must exist
    Number-of(claim.statedAs) must equal figure.value
    claim.statedAs must RENDER figure.unit
for each currency / percent / months token in prose:
    must appear as some claim.statedAs        ← no other escape
```

Exact. No tolerance ladder, no hedge vocabulary, no section scoping — those are
all answers to *"did the model mean this number as a claim?"*, and that question
has an answer now: the model said so.

**There is no "or any number the user typed" escape.** That hatch exists once
already and the audit recorded its cost. User numbers reach the verifier the same
way every other number does: as an addressed PREMISE figure with a unit.

---

## One rounding edge

`renderFigure()` is the only place in this layer that rounds. The table prints
it, the deterministic fallback prints it, and the verifier accepts it.

This is not an aesthetic choice. The first measurement found the boundary
contradicting itself: the table printed `$37,006.52` (via `toLocaleString`) for
7 × $5,286.645 = 37006.515, and the verifier accepted only `$37,006.51` (via
`toFixed`), because f64 stores that value as 37006.51499…. **The model was shown
a number and then rejected for writing it back**, in two of seven cases. It is
the same half-cent `engine.ts`'s D-4 note warns about, one layer up.

---

## Files

```
refusal.ts              ONE refusal vocabulary — seven codes, shared with Slice 3
figures/types.ts        LicensedFigure, the four axes, statedAsRendersUnit, renderFigure
figures/table.ts        the flat table, assembled from authorities that already exist
figures/premise.ts      user numbers -> addressed PREMISE figures with rate units
answer/types.ts         Claim, Answer, VerificationFailure
answer/schema.ts        the JSON Schema the provider enforces (strict)
answer/generate.ts      one call, one verify, one repair, then the fallback
answer/for-request.ts   the route's single entry point; the AI_ANSWER_MODE flag
verify/verify.ts        the identity check
render.ts               the table and the four narration rules
```

Everything in `figures/table.ts` is a **unification, not new logic**. Every
MEASURE comes from a function the repository already ships and already trusts:
`licensedFigures` (numerical-guard), `currentAuthorityFigures` and
`projectionFigures` (for-request), `composeInvestments` via the operating state,
and `assessment.ungraded[]` — which is built with four branches and
machine-readable reason codes, is consumed at exactly one site in the whole
application, and which **the model had never seen.**

---

## The flag

| Flag | Values | Unset | Notes |
|---|---|---|---|
| `AI_ANSWER_MODE` | `prose` · `typed` | `prose` | ⚠️ The opposite default from `AI_FORECAST_GUARD_MODE`, on purpose. An unset forecast guard SERVES arithmetic already measured to be wrong. An unset answer mode keeps a working pipeline. The two flags fail in opposite directions and get opposite defaults. |

Under `typed` the three prose guards are **bypassed entirely**, and that is the
design rather than an oversight. All three reconstruct from English what the
model meant; under `typed` the model says what it meant, so running them adds no
fourth opinion — only three chances to redact a licensed sentence. That is
exactly what the Slice 0 baseline measured: three of four `repair`-mode
conformance failures were the guard deleting a sentence that was licensed.

---

## Measured, 2026-09-01

Seven adversarial cases (`npm run ai:answer-boundary`) on the real fixture: the
two premise-echo scenarios that failed 30/30 at FORECAST-11A, three premise-leak
follow-ups, and two cases a boundary could only pass by *not* refusing.

| Model | Gates | Outcomes | Model calls |
|---|---|---|---|
| `gpt-4o-mini` | **7/7** | 2 clean · 2 repaired · 3 fallback | 12 |
| `gpt-4.1` | **7/7** | **7 clean** · 0 repaired · 0 fallback | 7 |

Both are safe. Only one is good: under mini, three of seven users get the
deterministic bullet list instead of an answer, because the model writes figures
into its prose and omits them from `claims`.

### Two predictions the measurement overturned

**The doctrine is not the confound.** The plan predicted that the ~4,250 tokens
of prose doctrine were suppressing compliance, and that cutting them was part of
this slice. Measured with the doctrine removed entirely — the typed block alone,
1,570 tokens instead of 11,400 — compliance did not improve: 2 clean · 1 repaired
· 4 fallback, marginally *worse*. The under-claiming is a model-capability
limit, not a prompt-competition one.

**Which makes it Slice 2's finding, and Slice 2's finding is the reverse of
FORECAST-11's.** That experiment tried a stronger tier against the *prose*
architecture and correctly answered "no — helps D, hurts I, 14x cost." Against
the typed boundary the same question answers yes, decisively, and the cost
argument changes shape too: the stronger tier needs **7 calls where mini needs
12**, because mini pays for a repair or a fallback three times in seven.

The prompt-size result stands on its own and belongs to Slice 7: **1,570 tokens
against 11,400, with no measured quality loss on these cases.**

---

## The full corpus, both architectures

`ai:forecast-conformance` — 35 scenarios, one fixture, one run each.

| Architecture | Clean | How zero unlicensed figures was achieved |
|---|---|---|
| prose + `--guard=repair` (mini) | **31/35** | 25 guard findings, 17 replies **redacted**, 8 replaced by a fallback |
| typed (`gpt-4.1`) | **31/35** | 27 clean · 5 repaired · 3 fallback · **0 redactions, no regex ran** |

The score is the same. The mechanism is not, and neither are the failures.

**Under prose+repair, three of the four failures were the guard deleting a
sentence that was licensed** — `G3-pressure`, `P1-pressure`,
`R2-investments-expressible`. Redaction removes whole sentences, so a licensed
figure sharing a sentence with an unlicensed one goes with it.

**Under typed, none of the four is a redaction.** They are:

| Failing | What it actually is |
|---|---|
| `D-hypothetical` · `J-historical-plus-forecast` | **stale corpus.** Both require the reply to REFUSE the forward half for want of an income basis. PROJECTION-1 ships an evidence-based path that computes it, and the answers say plainly that the net basis is not established. These are the scenarios the plan predicted `AI_FORECAST_PROJECTION` would supersede — they surface here rather than under prose because the typed boundary lets the projection actually answer. |
| `H-pressure-biweekly` | **narration gap, not a truth failure.** The scenario requires the reply to say "seven". The answer neither says seven nor accepts the user's six — it simply does not mention the count. |
| `Q4-two-per-month` | ⚠️ **a real regression, and it names the boundary's limit.** The model echoed the user's "two paychecks per month" while using the correct licensed figures. The typed boundary is a **figure** boundary, not a **framing** boundary: it can prove that every number is addressed, and it has nothing to say about a sentence that misdescribes a cadence. Under prose, `NO_TWO_PER_MONTH` was enforced by doctrine; under typed the prose guards are bypassed and nothing enforces it. Framing is Slice 4's and Slice 5's to own. |

### The three defects the first measurement found, in the boundary itself

Worth recording, because each was invisible to reading and obvious to running:

1. **The table contradicted the verifier.** `renderFigure` — see above.
2. **The table withheld figures the prompt asserts.** The horizon length, and
   the combined investments total the operating state prints six lines above.
   The model was shown a number and forbidden to say it. (This is also, on the
   evidence, the `R2-investments-expressible` false positive the prose guard
   records: `currentAuthorityFigures` omits the combined total for the same
   reason.)
3. **The table is a licence, not a menu.** Three pay-date scenarios failed under
   typed and passed under prose, because the table handed a "when is my next
   paycheck?" turn every assessment scalar it had and the model duly used one.
   FORECAST-16's finding is that a pay-date question is answered with DATES; the
   table is now scoped by the capability CF-8 already resolved.

---

# Measures on a time axis (Slice 3)

`lib/reasoning/measure/**` — one primitive under which `net_worth@now` and
`net_worth@2026-12-31` are the same object, differently licensed. Forecast stops
being a subsystem and becomes an **operation**.

## No new arithmetic

Every evaluator is a thin adapter over an authority that already exists:

| Measure | Authority |
|---|---|
| `liquid_cash@NOW` · `debt_balance@NOW` · `net_worth@NOW` | the accounts payload's own totals |
| `monthly_spending` · `monthly_income` · `savings_rate` | the assessment's cash-flow section |
| `runway_months` | the assessment's liquidity section |
| `liquid_cash@DATE` | `forecastCash`, then `projectCash` |
| `concentration_top_weight` | `computeConcentration`'s published verdict, read not re-run |

`parity.test.ts` asserts each equals what the original produces on the real
fixture. **Parity, not novelty.** The whole layer contains exactly **six**
multiplications and the test names every one of them; a seventh has to be
justified in a diff.

`net_worth@NOW` reads the payload's own `netWorth` rather than re-summing the
components — the accounts authority already decided what participates and how
currency was converted, and this repository has a whole memory of what happens
when two chains compute the same current value.

## A value or reasons — never both, never neither

`Resolution` is a discriminated union, so `value: null` beside
`standing: MEASURED` is **unrepresentable** rather than merely wrong. That
combination is the shape of the most-repeated defect in this repository's record:
`nativeBalance ?? 0` making UNKNOWN equal a confirmed zero, and a
NOT-NULL-DEFAULT-0 balance column rendering a withheld account as $0.00.

## `net_worth@FUTURE` does not refuse wholesale

```
1. leg resolves to a VALUE                     → use it
2. leg UNRESOLVED, leg@NOW is MEASURED,
   and leg is not the SUBJECT of the question  → persistence fallback
3. otherwise                                   → UNRESOLVED, carrying its reasons

standing = the WEAKEST leg
```

Two constraints stop this becoming invention:

- **A fallback may only hold a currently-MEASURED value constant.** It may never
  originate one. There is exactly **one** fallback form, so the set is closed and
  cannot grow into a library of guesses.
- **It may never be applied to the SUBJECT of the question.** Asked *"what will
  my debt be in December?"*, holding debt flat and answering $549.75 would answer
  a different question in the voice of an answer — the shape of the defect
  PROJECTION-3 closed, inverted.

Currency is checked at every join, which it was not before: `forecastCash` sums
`cashDelta` with no currency check at all (`cashDeltaOf` discards `c.currency`).

**Rejected: a `completeness: COMPLETE | CONDITIONAL | PARTIAL` axis.** Derivable —
if any leg used a fallback the composition is `ASSUMPTION_DEPENDENT` and
`dependsOn` names which one — and a parallel enum is how a codebase gets from
three vocabularies to forty-two, in the slice whose purpose is to unify them.

## Investments forward are deliberately poor

`FLAT` (the base case) or `SCENARIO_BAND` (the user's own "what if it goes up
10%", carrying HYPOTHETICAL standing). **There is no `DERIVED_FROM_HISTORY` and
it must not be added**: BTC prices exist only from 2025-08-03, ETH is a rolling
365 days, and investment *quantities* are back-projected where no event replay
exists. A return derived from that series would be a prediction wearing an
authority's clothes.

Flat-as-base is not a limitation; it is the honest answer, and it is the register
the brief asked for: *"nobody knows where Bitcoin will be in December — if your
portfolio stays flat, around A; at +5%, around B."*

## Dispersion is a product feature

Everything else here works to stop the assistant refusing useful answers.
`dispersion` is the only thing stopping that degrading into a confident point
estimate: this Space's discretionary spending runs $2,290 to $14,061, a 6.1×
spread with **no current regime**, and a mean over that is arithmetically correct
and reads as a settled level.

It is carried on `monthly_spending` and is **not** promoted into `range` —
`range` is reserved for scenarios, which are two answers to two questions, where
dispersion is a statement about the past.

## Two corrections to the plan, from repository evidence

**"One shared authority, not two comments" — there was nothing to merge.**
The plan read `projection.ts:29-38` and `spending-baseline.ts:66-71` as two
copies of the double-count rule. They are different statements:
`spending-baseline` **exports** `isOrdinaryConsumption`, which is the shared
authority and already has one implementation; `projection.ts`'s comment is a
measured finding about why it projects no debt paydown at all. What was actually
missing is the rule **at the join**, where three ledgers meet — now stated in
`composeNetWorth` and pinned.

**The join is safe today only because debt is held flat.** A card purchase
reduces future cash through the spending accrual and would also raise the card
balance. It cannot double-count now, because the debt leg contributes nothing
that moves with spending. The composition therefore gets the **total** right and
the **split** wrong — a card purchase is modelled as cash leaving rather than
debt rising, and net worth is the same either way. **If `debt_balance@FUTURE`
ever gains a real schedule, this join gains a double count on the same day.**

---

# Scenario and ConversationState (Slice 4)

`lib/reasoning/scenario/**` — the conversation in the brief, working.

## Lifecycle, not forgetting

`fact-continuity.ts:40-44` makes assumptions per-turn by explicit doctrine; only
the horizon survives. **The concern behind that rule is exactly right** — a stale
assumption silently pricing today's answer is a real defect. But the rule breaks
four of the five turns of the conversation the product exists for.

What is needed is neither memory nor forgetting. It is **lifecycle**: a delta
that is ACTIVE, visible in every answer it prices, and dismissable in one
sentence is not a stale assumption — it is a stated one.

## The five rules that make it safe

1. **Every ACTIVE delta appears in the answer it prices.** Passed to narration as
   a required framing item, rendered as `you MUST name these in your answer`. An
   assumption the user cannot see is the dangerous one.
2. **Deltas supersede, never overwrite.** `statedAtTurn`, `supersededBy`,
   `effectiveFrom/Until`. "Make that $6K" does not erase the $5K — it records
   that at turn 2 the user said one thing and at turn 4 another.
3. **`DISMISS_ALL` is first-class**, and it runs **before** the same turn's own
   deltas are collected — otherwise "forget that, what if it's $6K?" dismisses
   the delta the same sentence just created.
4. **An assumption licenses a calculation; it never rewrites a fact.** Pinned:
   no scenario, across all seven turns, changes a present value.
5. **Scoped to the conversation. Never persisted.** That is the line between
   conversation state and memory, and it is why this ships and memory does not.

## How an assumption reaches a figure

`assembleForecast` reads suppositions from `question` and nothing else —
FORECAST-13 drew that line deliberately. So an ACTIVE delta is replayed into the
effective question **as the user's own sentence, verbatim**.

That is not a workaround: it is what *"the assumption is still in force"* means,
expressed in the only vocabulary the forecast authorities accept, and it means no
second path can price an answer differently from the first.

An INVESTMENT_RETURN delta does **not** go that way — it becomes a
`ReturnBasis.SCENARIO_BAND` on the measure layer, because no forecast authority
models returns and inventing one there is what `DERIVED_FROM_HISTORY` is banned
for.

## The gate

```
npm run ai:conversation-gate                     # seven turns, with the model
npm run ai:conversation-gate -- --structure-only # no model, no key, no cost
```

**A fallback counts as a FAILURE.** The deterministic list is safe — that is what
`ai:answer-boundary` measures and why it exists — and it is not an answer. The
first version of this gate passed two turns on fallbacks, because the bullet dump
happens to contain the words the prose patterns were looking for.

The seventh turn **must decline**, and it is not decoration: a gate made only of
turns that must be answered is passed by a system that answers everything.

**Result, `gpt-4.1`: 7/7 clean, no repairs, no fallbacks.**

> T7 — *"Nobody can know what Bitcoin will actually be worth in December. If it
> stays at its current value, your digital assets would be $19,014.63. If it went
> up 10% (just as an illustration, not a prediction), $20,916.09. If it went down
> 10%, $17,113.16. These are just examples, not forecasts."*

## Five defects the gate found, all in code that already shipped

| Defect | What it did |
|---|---|
| **`$5K` read as `$5.00`** | `statements.ts` extracted $5.00 from *"assume I spend $5K/month"* — the second turn of the conversation the product exists for. The forecast projected **$20.53** of spending over four months and an ending balance of $57,788. Nothing refused, nothing flagged: the number was licensed, the arithmetic correct, the premise wrong by three orders of magnitude. **The same hole existed in four separate patterns** — `statements.ts`, `premise.ts`, the verifier's prose sweep, and its `valueOf`. |
| **The horizon resolver could not read a bare month** | *"And what about February?"* resolved to nothing — the named-month branch requires a preposition (`through`/`until`/`by`) — so the turn silently kept December while the user had asked about February. PROJECTION-1's defect exactly: a different question, answered silently, with a different number. |
| **An unaddressed number inside a licensed label** (twice) | An illustrative band carried `10%` in its **label** and a dismissal notice carried `$5K` in its **text**. Both put a number in front of the model inside content with no `fid`; the model wrote it, the sweep found it unaddressed, and a correct answer was discarded. Now pinned: no rendered label or withheld line may carry a money token that is not a figure. |
| **A dismissed assumption was unquotable** | The model wrote *"dropping your $5,000/month assumption"* — the right sentence — and the answer was discarded, because with the delta dismissed nothing carried 5000. Dismissing removes an assumption's **licence to price an answer**; it does not remove the user's right to hear what they said. |
| **The gate's own scorer, twice** | It scored *"future price movements are not predictable"* a failure because it looked for `unpredictable`, and *"Nobody can know…"* a failure because it looked for `nobody knows`. This programme's own record: a scorer that disagrees with the transcript is the thing that is wrong. |

## What is temporary here

`derive.ts`'s extractor and `turn.ts`'s `selectMeasures` are **marked for
deletion in Slice 5** and quarantined so they can be deleted whole. Deciding what
a sentence means is the planner's job; these are the smallest thing that
demonstrates the lifecycle, not the right way to read a sentence. Nothing else in
`lib/reasoning/**` reads a message.

---

# Master composition (Slice 6)

`lib/reasoning/master/dedupe.ts` — the default entry point stops refusing.

## What master did

```ts
// master-surfaces.ts:87
const forecastable = spaceIds.length === 1;
```

With two or more eligible Spaces, a forecast question got ~1,600 characters of
*"You MUST NOT construct the projection yourself"* — and **master is the entry
point most turns use.** The stated reason was sound as far as it went: *"with two
or more there is no deduplicated balance to project from."*

**But the product already deduplicates, three lines away.** `route.ts` computes
`distinctAccountCount` as a set over every Space's `accountIds`, and the Brief
route does the same — *"an account shared into two Spaces counts once"*. What was
missing was not the technique but the will to apply it to **balances**.

## What it refuses, and why each refusal is real

Deduplication is only sound when the rows can be identified and their values
added. Four conditions make that false, and **each is a defect this repository
has already recorded once**:

| Condition | The defect it prevents |
|---|---|
| **rows don't add up to the declared totals** | ⚠️ found by the acceptance run — see below |
| `reportingBalance: null` | V25-FINAL-1 made it nullable *"so no consumer can read an unavailable balance as worth 0"* |
| `redactedCount > 0` | a hidden account is not an absent one |
| `totalsUnconverted` | the payload says its own totals are partial |

It **never falls back to adding the totals** — that is the cross-Space sum over
overlapping accounts the whole product forbids, and it is the one thing a caller
might reach for when this refuses.

## ⚠️ The defect the acceptance found

The first implementation recomputed totals from the per-account rows and
**silently lost any class that had no rows.** The fixture Space declares
`totalDigitalAssets: 19,014.63` with `counts.digitalAssets: 4` and carries no
digital-asset rows, so the composition returned `$0.00` — and the answer read:

> *"Your digital assets (including Bitcoin) are projected to be $0.00 on December
> 31, 2026, even if Bitcoin goes up 10%."*

That is the single most-repeated defect in this repository's record wearing a new
costume: `nativeBalance ?? 0` making UNKNOWN equal a confirmed zero, a
NOT-NULL-DEFAULT-0 balance column rendering a withheld account as $0.00. **An
absent row is not an empty class.**

Each Space's rows are now checked against that Space's own declared totals before
anything is unioned, and a mismatch refuses by name.

*(The fixture's incompleteness is a fixture gap, not a product one: the accounts
assembler emits a row per account at `scopeHint: 'full'`, which is what master
uses. The gate completes the rows in its own setup rather than perturbing a
fixture every other corpus depends on being byte-stable.)*

## It was never about the count of Spaces

`forecastable = spaceIds.length === 1` refused on arithmetic about *Spaces*.
Whether a combined figure can be stated is a question about *accounts*. Three
Spaces that deduplicate cleanly compose; **one** Space with a hidden account does
not — and that is pinned.

## Acceptance

The Slice 4 conversation gate, re-run against two Spaces sharing a checking
account:

```
[MASTER] 5 distinct accounts, 1 shared placement(s) deduplicated
[MASTER] liquid: 10228.74 (one Space) -> 12728.74 (two Spaces, one shared
         account + $2,500 savings)
[MASTER] dedup correct — the shared account is counted once.
  7/7 turns clean
```

A naive sum would have read $22,957.48 of liquid cash from $12,728.74 of actual
money.

**One shared body, not a master branch.** PARITY-1/2/3 exist because master and
named-Space diverged once already, and `system-prompt.ts` records the lesson:
*"an allowlist of capabilities is a list that is always one capability out of
date."* Master composes a deduplicated context and then takes exactly the path a
named Space takes.
