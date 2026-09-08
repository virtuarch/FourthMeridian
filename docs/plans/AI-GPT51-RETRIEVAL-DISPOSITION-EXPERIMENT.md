# gpt-5.1 retrieval-disposition micro-experiment

**Date:** 2026-09-08 · **HEAD:** `4f481b7` · **Status:** experiment. **Nothing adopted, nothing shipped.**

Default model unchanged (`gpt-5.5`). The candidate instruction exists only in
`tmp/disp/disposition.ts` and was never written into `SYSTEM_INSTRUCTION`. Production route
unchanged. No Cost Clip implemented. Operator `SpaceMemory` verified unchanged (5 rows before and
after); everything ran under a throwaway owner.

Authority for the "before" baselines: [AI-COST-CLIP-4-GPT-5-1-EVALUATION.md](AI-COST-CLIP-4-GPT-5-1-EVALUATION.md).

---

## 1. Verdict

# PARTIAL

**The hypothesis is half-confirmed, and the half that fails is not the half we assumed.**

The minimal general contract **materially changes whether gpt-5.1 retrieves** — decisively, on the
worst failure in Cost Clip 4:

| | before | after |
|---|---|---|
| *"did I sell crypto to cover debt?"* — queried the transaction record | **0 / 3** | **5 / 5** |
| *"go back to Jan 1"* — surfaced the measured Jan-1 cash | **0 / 3** | **5 / 5** |

…at **no cost** (−0.4% $/turn), with **zero over-retrieval** (0 pointless re-fetches in 20
follow-up turns), and for **73 tokens**.

**But it does not close the truth-critical gaps, because under-retrieval decomposes into two
defects and the general contract only reaches one:**

> **Willingness to retrieve — fixed.**
> **Choice of lens and window — untouched.**

The residual failures are not refusals any more. They are diligent queries aimed at the wrong
thing: the Jan-1 question now fetches *cash* (via `project_cash`) but never the *balance sheet*, so
the **$37,316 debt is still missing 5/5**; the crypto question now queries transactions every time
but scopes 2 of 5 to the **last 90 days** instead of the Jan–Jul window where the sale happened,
and then concludes *"no, it doesn't look like you sold crypto"*.

**Per the brief's instruction, I stopped here rather than adding instructions to chase those two.**

**One finding reassigns a Cost Clip 4 conclusion** (§7): the scenario clause is **inert**, and the
scenario failures are **entirely the known Cost Clip 2 schema gap** — proven by a control.

---

## 2. The candidate instruction

Appended verbatim to `SYSTEM_INSTRUCTION`. Three sentences, **60 words, 73 tokens** (the existing
instruction is 170 tokens, so 243 total). No tool names, no question types, no examples, no
routing table, no intent categories.

```
The orientation summary is context, not evidence. When an answer depends on financial
facts the tools can establish, retrieve them before answering rather than concluding
that the system does not know. When a deterministic tool can evaluate a consequential
scenario, use it instead of doing that arithmetic yourself, and pass the user's stated
assumptions through exactly as they were stated.
```

**Cost:** 73 tokens per model invocation, ~92% of them cached — **≈ $0.00001 per invocation on
gpt-5.1.** Economically free.

**Not changed, and implicated (§9):** the existing line *"If something is unknown or unknowable,
say so once and move on."*

---

## 3. Phase 1 + 4 — primary retrieval, 5 trials each

| Probe | Marker | Cost Clip 4 baseline | With disposition | Verdict |
|---|---|---|---|---|
| **A** *"How am I looking financially?"* | fetched evidence | 0/3 | **0/5** | **not a failure** — see below |
| **B** *"Go back to Jan 1…"* | liquid **$9,517** surfaced | 0/3 | **5/5** ✅ | improved |
| **B** | **debt $37,316** surfaced | 1/3 | **0/5** ❌ | **not closed** |
| **C** *"sold any crypto to cover debt?"* | transaction record queried | 0/3 | **5/5** ✅ | improved |
| **C** | **Coinbase evidence found** | 0/3 | **3/5** ⚠️ | **not at target** |

**A is a false alarm, and I am reclassifying it.** Cost Clip 4 marked A `PASS_WITH_DIFFERENCE`, not
a regression — every figure gpt-5.1 gave was correct. Re-reading the answers here confirms it: net
worth $36.4k, liquid $12.4k, traditional $5.0k / digital $19.3k, debt $310, 90-day income $32.7k /
spending $12.3k / net +$20.4k — **all correct, all present in the thin core**. The orientation
genuinely *is* sufficient for a broad "how am I looking". The instruction correctly did **not**
fire. That is Phase-3 evidence, not a Phase-1 failure.

**B — what actually happens now.** The model calls `project_cash({to: …, asOf: '2026-01-01'})` and
reports the correct retrospective opening of **$9.5k** and a month-by-month path. It retrieves
diligently. It just never asks for the *position*, so the debt never appears.

> The disposition converted a **misleading** answer into an **incomplete** one. Cost Clip 4's B
> failure concluded *"you're okay for now"* over an unmentioned $37k of debt. The new answers make
> no such claim — they simply stop at cash. Better, and still not right.

**C — the two misses are scoping, not refusal.** Both failing trials queried
`{from: '2026-06-10', to: '2026-09-07'}` — the default 90-day window — found crypto *up* $4.5k over
that window, and answered *"no, it doesn't look like you sold crypto to cover debt."* The sale was
in **February**. The model looked hard, in the wrong place, and stated a confident negative.

---

## 4. Phase 1 — historical cutoff and the cash challenge (3 trials each way)

Run as the real 2-turn chain: the Jan-1 debt question, then the challenge.

| | without | with |
|---|---|---|
| **Cutoff ≤ 2026-01-01** (no post-cutoff window) | **3/3** ✅ | **3/3** ✅ |
| Debt $37,316 surfaced on turn 1 | 0/3 | **1/3** |
| **Challenge answered correctly** ($9,517 + $1,255, no false ignorance) | **3/3** ✅ | **2/3** ⚠️ |

**The Cost Clip 4 cutoff regression did not reproduce.** Every one of six runs chose `asOf`
≤ 2026-01-01. The `asOf: 2026-01-31` leak observed in session 31 occurred at turn 14 of a long
conversation; standalone, gpt-5.1 picks the right ceiling every time. **Cost Clip 4 called this a
model weakness (A); the correct reading is that it is context-dependent and not stable.** Whether
long-context degradation reproduces it is unresolved (§11).

**The one failure with the disposition is worth quoting**, because it is the exact pattern the
instruction was written to prevent:

> *"No, I'm not sure — and I shouldn't pretend to be. … I **don't actually have your exact
> balances on that date** unless we explicitly pull a snapshot 'as of 2026-01-01', which I didn't
> do."*

It **names the tool it should call and then does not call it.** At n=3 this may be noise, but it
went 3/3 → 2/3 in the direction of worse, and it shows the instruction is not self-enforcing.

---

## 5. Phase 2 — scenario probes

Sixteen turns across four chains, both conditions:

| Probe | without | with |
|---|---|---|
| *"$500 avg on weekdays → EOY"* → *"1k a day?"* → *"2k?"* (×2 trials) | **0 tool calls** | **0 tool calls** |
| *"$500/weekday, invest 75%, 70–80% annually"* (×2 trials) | **0 tool calls** | **0 tool calls** |
| **70–80% range preserved, not collapsed** | **4/4** ✅ | **4/4** ✅ |
| Silent assumption substitution | **none** ✅ | **none** ✅ |

**The scenario clause had no measurable effect.** gpt-5.1 did prose arithmetic in every trial:
*"83 weekdays × $500 ≈ $41,500; net worth $36.4k + $41.5k ≈ $77.9k."*

**Good news that is not attributable to the disposition:** on the 75% question it **refused to
guess** and asked which horizon and which of 70%/80% to use — exactly criterion 5's desired
behaviour — in both conditions. This differs from Cost Clip 4's S2 T2, where a conversation-supplied
horizon let it substitute `fractionOfLiquid: 0.75` silently. **Given a horizon it substitutes;
without one it asks.**

---

## 6. Phase 3 — over-retrieval

Twenty follow-up turns whose answer was already in the immediately preceding tool result.

| Probe | Follow-up | without | with |
|---|---|---|---|
| OR1 | *"explain the september number"* after `project_cash` | 0 re-fetch | **0 re-fetch** |
| OR2 | *"which is bigger, crypto or traditional?"* after `get_investments` | 0 re-fetch | **0 re-fetch** |
| OR4 | *"that feels optimistic honestly"* after a projection | 0 re-fetch | **0 re-fetch** |
| OR5 | *"so what should i do about that?"* after `get_spending` | 0 re-fetch | **0 re-fetch** |
| OR3 | *"do you still remember my goal?"* (goal seeded) | 0 calls — answered from the memory line | **1 `recall`** |

**No over-retrieval regression. Zero pointless re-fetches in 20 turns.**

**OR3 is a behaviour change, and a desirable one.** Without the instruction the model answered from
the orientation's memory line (subject + target only). With it, it called `recall` and got the
user's own words and the supersession history. That is the instruction working as intended — going
to the authority rather than the summary — for **$0.001**.

**This is the strongest positive result in the experiment.** The instruction is *discriminating*,
not "always fetch": it stays silent on A and on every conversational follow-up, and fires on
transaction forensics and on memory.

---

## 7. The scenario control — reassigning a Cost Clip 4 finding

The brief is explicit: *do not blame retrieval disposition for an unavailable deterministic
primitive.* So I ran a control — a scenario `scenario_projection` **can** express faithfully
(monthly cadence, single rate):

> *"What if I invested $8,000 a month from now until the end of 2030, and it returned 10% a year?"*

| | Used `scenario_projection` |
|---|---|
| with disposition | **3/3** |
| without disposition | **3/3** |

**Conclusion, and it changes the reading of both documents:**

1. **The scenario clause is inert.** 6/6 either way — the instruction is doing nothing here.
2. **gpt-5.1's scenario-tool disposition is already correct.** When the tool can express the input,
   it uses it, unprompted, every time.
3. **The Phase 2 prose arithmetic is 100% the Cost Clip 2 schema gap.** gpt-5.1 is not refusing to
   use the tool; it is correctly declining a tool that cannot faithfully represent
   *"$500 per weekday"* and falling back to prose.

> **Cost Clip 4 classified three session-31 turns as SCENARIO_REGRESSION against gpt-5.1
> (T24/T28/T29). On this evidence they should be reattributed to the Cost Clip 2 contract gap.**
> The verdict of that document does not change — the truth regressions stand on their own — but
> gpt-5.1 is owed the correction.

---

## 8. Phase 5 — economics

Measured on the three sets run **both** ways (ED, SCEN, OR — 32 turns each):

| | Turns | Tool calls/turn | Invocations/turn | Prompt | Cached | Completion | Latency | **$/turn** |
|---|---|---|---|---|---|---|---|---|
| gpt-5.1 **without** | 32 | 0.47 | 1.47 | 271,828 | 89.3% | 14,064 | 5.9s | **$0.0065** |
| gpt-5.1 **with** | 32 | **0.53** | 1.53 | 287,780 | **91.5%** | 14,292 | 5.9s | **$0.0065** |
| delta | | **+13%** | +4% | +5.9% | +2.2pts | +1.6% | 0% | **−0.4%** |

On the retrieval-heavy probes (A, B, C — 15 turns with the disposition): **1.73 tool calls/turn**
against a Cost Clip 4 baseline of **0.33**, at **$0.0088/turn**.

| Configuration | $/turn | vs gpt-5.5 |
|---|---|---|
| **gpt-5.5 baseline** (Cost Clip 4, 42 turns) | $0.0585 | — |
| **gpt-5.1 before disposition** | $0.0120 | **−79.5%** |
| **gpt-5.1 + disposition** | **$0.0120** | **−79.6%** |

> **The entire ~79% saving survives.** The expectation in the brief — that corrected gpt-5.1 would
> cost more than $0.012/turn — **did not materialise**, for two reasons: the extra retrieval lands
> on the cached prefix (cache rate *rose* to 91.5%), and gpt-5.1 answers more briefly when it has
> real evidence, offsetting the extra hop. **The instruction is economically free.**
>
> The caveat matters: this measures the cost of the retrieval it *does* perform. If the two
> remaining gaps (lens, window) were closed, tool calls/turn would rise further toward gpt-5.5's
> 1.52 — and even at gpt-5.5's full call volume, gpt-5.1's prices would keep it near −75%.

---

## 9. Success criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Zero truth regressions in the targeted probes | **FAIL** — B never surfaces the $37,316 debt (0/5); the challenge went 3/3 → 2/3 |
| 2 | Correct historical cutoff | **PASS** — 6/6 both conditions |
| 3 | Coinbase evidence retrieved reliably | **FAIL** — 3/5 against a 5/5 target (from 0/3) |
| 4 | No consequential prose arithmetic where deterministic tooling applies | **PASS** — 6/6 when the tool can express the input (§7); the rest is Cost Clip 2 |
| 5 | No silent scenario-assumption substitution | **PASS** — asked for clarification instead, 4/4 |
| 6 | No material over-retrieval regression | **PASS** — 0 pointless re-fetches in 20 follow-ups |
| 7 | Meaningful cost advantage remains | **PASS** — −79.6%, unchanged |

**5 of 7 pass. Both failures are the same defect: query scope, not retrieval willingness.**

---

## 10. Attribution

| Finding | Model | Contract | Known schema gap |
|---|---|---|---|
| Willingness to retrieve at all | — | **CONFIRMED — and the general contract fixes it** (0/3 → 5/5 twice) | — |
| **Choice of lens** (cash via `project_cash` instead of the position) | contributing | **PRIMARY** — nothing says an assessment needs the whole position; `get_financial_snapshot(asOf)` returns it in one call and the model does not know to prefer it | — |
| **Choice of window** (90-day default on a "did I ever…" question) | **PRIMARY** | contributing | — |
| One residual false-ignorance (`ED` t2) | **PRIMARY** | contributing — *"If something is unknown or unknowable, say so once and move on"* still licenses exactly this, and it was deliberately left untouched | — |
| Scenario prose arithmetic | — | — | **PRIMARY — Cost Clip 2**, proven by control (§7) |

**The hypothesis in the brief was right about the mechanism and incomplete about the scope.** The
A2 contract *is* underspecified about the orientation being insufficient, and saying so *does*
recover retrieval. It does not — and arguably cannot, without enumerating things the constraints
forbid — tell the model *which* evidence answers *which* shape of question.

---

## 11. Exact recommended next action

**Do not ship this instruction yet, and do not iterate on its wording.**

It is free, it is safe, and it fixes a real defect — but shipping it now would create the
impression that the gap is closed when the two truth-critical markers still fail. It is worth
banking only as part of a change that also addresses scope.

**The single next experiment, and it is a measurement, not an instruction:**

> **Test whether the *tool contract* — not the system prompt — can carry the scope signal.**
> `get_financial_snapshot`'s description already says *"Start here for anything broad, and for any
> 'how was I doing on X'."* gpt-5.1 did not follow it. Measure whether that is because the
> description is not read, or because `project_cash` looked like a better match for
> *"what would you have told me then"*. A/B the two descriptions against probe B, 5 trials.

That keeps the fix where the constraints allow it — in a tool's own description of what it answers
— rather than growing the system instruction into a routing doctrine.

**Explicitly not recommended:** adding examples, adding question types, adding "for a historical
assessment call X", or adding a sentence per failing probe. The brief asked whether the principle
works. **It works for willingness and not for scope, and that is the answer.**

---

## 12. Answers to the brief

1. **Instruction tested:** §2, verbatim.
2. **Token cost:** **73 tokens** (60 words); instruction grows 170 → 243 tokens; ~$0.00001/invocation.
3. **Primary retrieval before/after:** transaction querying **0/3 → 5/5**; Jan-1 cash **0/3 → 5/5**;
   Coinbase **0/3 → 3/5**; Jan-1 debt **1/3 → 0/5**; broad assessment 0/3 → 0/5 (correctly).
4. **Stochastic 5×:** §3 — B liquid 5/5, B debt 0/5, C transactions 5/5, C Coinbase 3/5, A 0/5.
5. **Historical cutoff:** **6/6 correct in both conditions**; the Cost Clip 4 leak did not reproduce.
6. **Scenario tool use:** 0/16 on inexpressible inputs (both conditions); **6/6 on an expressible
   one** (both conditions) — the clause is inert and the gap is Cost Clip 2.
7. **Over-retrieval:** **0 pointless re-fetches in 20 follow-ups**; one desirable new `recall`.
8. **Tool calls/turn:** 0.47 → 0.53 on the comparable sets (+13%); 0.33 → 1.73 on A/B/C.
9. **Cost/turn:** $0.0065 → $0.0065 (−0.4%) on the comparable sets.
10. **Remaining saving vs gpt-5.5:** **−79.6%** ($0.0585 → $0.0120).
11. **Remaining regressions:** Jan-1 debt not surfaced (0/5); Coinbase 3/5; one false-ignorance in 3.
12. **Model vs contract vs schema gap:** §10 — willingness is **contract** (fixed); lens is
    **contract** (open); window is **model** (open); scenario arithmetic is the **known Cost Clip 2
    schema gap** (reassigned from gpt-5.1).
13. **Verdict: PARTIAL.**
14. **Next action:** §11 — A/B the *tool description* against probe B before touching the system
    instruction again.
15. **Files changed:** §13.
16. **Probes run:** §14.
17. **Measurement spend:** §15.

---

## 13. Files changed

- **`docs/plans/AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md`** — this document. **Nothing else.**

The candidate instruction lives in gitignored `tmp/disp/disposition.ts` and was never written into
`scripts/ai-baseline/run.ts`. Default model unchanged. `app/`, `lib/`, `prisma/`, `components/`,
`scripts/` untouched. 495/495 tests pass.

## 14. Probes run

| Set | Turns | Condition |
|---|---|---|
| A, B, C — primary retrieval | 15 | with (5 trials each) |
| ED — cutoff chain + cash challenge | 12 | with ×3, without ×3 (2 turns each) |
| SCEN, SCEN75 — scenario | 32 | with ×2, without ×2 |
| SCENOK — expressible-scenario control | 6 | with ×3, without ×3 |
| OR1–OR5 — over-retrieval | 40 | with ×2, without ×2 |
| Instruction token measurement | 2 | gpt-4.1 |
| **Total** | **107 model turns** | |

## 15. Measurement spend

**$0.607** — every run recorded, none estimated.

| Run | Cost |
|---|---|
| A/B/C ×5, with | $0.1324 |
| ED without / with | $0.0831 / $0.0785 |
| SCEN without / with | $0.0392 / $0.0413 |
| OR without / with | $0.0850 / $0.0866 |
| SCENOK with / without | $0.0316 / $0.0290 |
| Instruction token measurement | ~$0.001 |

## 16. Unresolved

1. **Does the cutoff failure return in long context?** It was clean 6/6 standalone and failed at
   turn 14 of a 31-turn session. Context length is the untested variable.
2. **Is the `ED` t2 false-ignorance suppressed by removing *"say so once and move on"*?** Deliberately
   not tested — it would have changed two things at once.
3. **Would closing the lens/window gap erode the 79.6%?** Tool calls/turn would rise toward gpt-5.5's
   1.52; on gpt-5.1 prices the saving should hold near −75%, but that is arithmetic, not measurement.
4. **Does the disposition help gpt-5.5?** Not tested. If it does, it is worth shipping independently
   of any tier decision.
