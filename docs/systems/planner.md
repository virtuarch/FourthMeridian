# The planner — a recorded per-class decision

**Flag:** `AI_REASONING_PATH` · **Default:** `legacy`
**Measured:** 2026-09-01, against `7e4e197`, `gpt-4o-mini`
**Decision:** the planner owns **forecast** and **broad**. The other three
classes stay on legacy routing, and the reason is the measure catalogue, not the
planner.

---

## What the planner is

One structured model call. In: the question, the conversation's state, and a
catalogue of what *can* be measured. Out: which measures, at which instants,
under which scenarios.

**No financial figures go in and no financial figures come out.** A wrong plan
costs relevance and cannot cost truth. That is the entire safety argument for
letting a language model do this job, and it is sufficient.

The planner is even told the *ids* of the conversation's active assumptions and
the user's own words for them — never their values. It can reference a delta; it
cannot learn what number the delta carries, so it cannot arrive at one by
arithmetic on the way past.

---

## The measurement

112 real questions, harvested from this repository's own conformance corpora,
operator harnesses and tests (`lib/ai/conformance/real-questions.json`).

| class | n | planner answered | overlap | legacy blank | legacy CLARIFY |
|---|---|---|---|---|---|
| **forecast** | 14 | 13/14 | **13/14** | 1 | **14** |
| **broad** | 7 | 6/7 | 2/7 | **5** | 5 |
| spending-income | 46 | 44/46 | 42/46 | 0 | 46 |
| debt | 5 | 5/5 | 5/5 | 0 | **0** |
| other | 40 | 37/40 | 18/40 | 21 | 37 |

### ⚠️ The classifier returns UNKNOWN on 97 of 112 real questions

And the prompt then prints, from `intent/prompt.ts`:

> *"If the question is ambiguous, briefly ask what the user wants to focus on
> rather than guessing."*

On *"what are my projections?"* it returns `UNKNOWN / 0.20 / CLARIFY` while CF-8
has resolved FORECAST and the engine has produced a cash path. **The question was
not ambiguous — this classifier did not understand it**, which is a different
fact and must not be reported to the user as their problem.

That is fixed independently of the cutover: the invitation is now withheld
whenever CF-8 resolved any concept at all. The rest of the UNKNOWN guidance —
*"you may draw on any section as needed"* — is still correct and still printed.

*(The master-mode call site passes no concepts, because master computes no
retrieval plan. That divergence predates this slice; PARITY-2's lesson says it
should not persist, and Slice 6 is where it is addressed.)*

---

## Why two classes flipped

**forecast** — the planner selects the same measures legacy's concepts imply on
13 of 14, and legacy asks for clarification on **all fourteen**.

**broad** — legacy resolves **nothing** on five of seven. This is the class the
whole programme exists for: *"how am I doing?"* is not a spending question or a
debt question, it is every question at once, and a classifier that must pick one
returns UNKNOWN.

## Why three did not, and it is the catalogue

**A large share of `spending-income` and `other` are transaction questions.**
*"What was my biggest purchase?"*, *"Who do I pay the most?"*, *"Show me the
largest transactions"*, *"Do you have anything from 2025?"* — and there is **no
`MeasureId` for a transaction record or for a coverage claim.**

Asked for the biggest purchase, the planner returned
`real_assets_value, debt_balance, net_worth` — a confident wrong reading of a
question legacy's domain routing serves correctly.

**`debt` is simpler:** legacy is right on all five and asks for clarification on
none. There is nothing to win.

The plan anticipated exactly this — *"if a narrow legacy route is materially
better, preserve it until the planner actually earns replacement"* — and this is
where it lands. Flipping those classes would trade a working route for a
vocabulary that cannot express the question.

**What would change the answer:** measures for the things people actually ask
about that are not aggregates — a largest-transaction lookup, a merchant rollup,
a coverage claim. That is a catalogue question, not a planner question, and it is
the next thing to build here.

---

## The termination condition, and where it is not met

This repository has shipped two shadow planners and **ended neither**.
`lib/ai/context-priority` was never once consulted, ran for months, and wrote a
database row on every chat turn — Slice 0 of this programme deleted it.
`retrieval-plan.ts` still carried a `SHADOW ONLY. Nothing here changes what is
assembled` header that had been false at five call sites since CF-9, with
`route.ts` asserting *"Nothing consults this plan"* three lines above the block
that consults it. **Shadow mode here is 0-for-2 at ending.**

So this one's ending is written down:

- a fixed sample of real questions ✅
- a recorded decision per class ✅ (this document)
- the legacy branch for a class deleted in the same commit that flips it —
  **partially:** the QUESTION ROUTING block's clarification invitation is
  removed, but `lib/ai/intent/**` still supplies `primarySections` and
  `transactionWindow` to the three classes that did not flip, so it stays
- `scripts/compare-plans.ts` deleted when the last class flips — **not yet**,
  because three classes have not flipped

### ⚠️ Two deviations, recorded rather than papered over

**The sample is 112, not the 200 the plan specified.** 112 is every question this
repository actually holds. Reaching 200 would mean *writing* 88 questions and
calling them real, which is exactly the kind of number this programme exists to
stop producing. The right way to reach 200 is to harvest them from production
traffic, which needs a capture this product does not have — recorded as the
prerequisite for revisiting the three unflipped classes.

**`compare-plans.ts` survives this slice.** It is scaffolding and it is still
load-bearing, because the cutover is incomplete. It is registered OPERATIONAL
with its deletion condition in its own header and in the audit registry, which is
the treatment the two previous shadow planners did not get.

---

## Verified end to end

The Slice 4 conversation gate, re-run with the planner choosing every measure
instead of the quarantined stand-in: **7/7 clean.** Identical selections on all
seven turns.

> T7 — *"What your Bitcoin will actually be worth in December is not known —
> nobody can know a future market price, and this product does not estimate one.
> As of now, your digital assets are $19,014.63. If they went up 10% (as an
> illustration), $20,916.09. If they went down 10%, $17,113.16. These are just
> scenarios, not predictions."*

### Two defects that run found

**A dismissal was re-announced on every later turn.** `dismissedThisTurn` asked
"has a dismissal happened?" rather than "did one happen *this* turn". The turn
after *"what's realistic though?"* still carried the notice, the model read *"do
not attribute any scenario below to them"* as *"do not use the scenarios"*,
answered with a single flat figure — and **called a future value "measured"**.
Deltas now carry `dismissedAtTurn`.

**The framing forbade use where it meant to forbid attribution.** Illustrations
are the right answer to an unknowable question; what must not happen is calling
one the user's. The notice now says so, and future figures that are not MEASURED
carry `NOTHING MEASURED THIS` beside their standing.
