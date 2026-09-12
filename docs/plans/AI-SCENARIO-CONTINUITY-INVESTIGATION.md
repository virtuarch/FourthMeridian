# Scenario continuity — why a superseded cash figure came back

**Date:** 2026-09-13 · **Model:** `gpt-5.1` · **Arm:** A2 · **Session:**
`tmp/ai-baseline/interactive-2026-09-12T19-43-51-668Z/interactive__A2__gpt-5.1.json`

Investigation only. **No repository behaviour changed.** 501/501 test files pass. The production
route is untouched.

> ## Root cause, in one paragraph
>
> The deterministic scenario was correct and was **never re-run after its assumption changed**. The
> $15.7k update happened in prose while the raw `scenario_projection` result was *still in context*
> — the model had the structured answer in hand, changed an input, and did the update by hand. Two
> turns later Clip 6 elided that result on schedule, and the only surviving cash figures were two
> assistant sentences: the baseline's, phrased as a live statement, and the scenario's, phrased by
> the assistant itself as *"Previous projection"*. The model took the one that reads current.
> **There is no representation anywhere — context, memory, or checkpoint — that says "the scenario
> under discussion is baseline + a Dec-7 bonus of $15.7k."** Its inputs survive in a tool-call
> argument; its output survives only as English.
>
> **RESULT continuity failed. ASSUMPTION continuity held. CONVERSATIONAL continuity held.**

---

## 1. Transcript reconstruction

14 turns. The relevant span:

| turn | user | tools | the assistant's figure |
|---|---|---|---|
| 7 | *"how much money should i have by 19 october"* | `project_cash{to:2026-10-19}` | $19.9k |
| 8 | *"yea total nw too"* | `get_financial_snapshot` | NW $38,957 |
| **9** | *"by eoy?"* | **`project_cash{to:2026-12-31}`** | **cash $35.9k**, NW ≈ $60k |
| **10** | *"i get a 17k bonus 7 dec … maybe itd be 15k-ish? … what would my nw be then"* | **`scenario_projection{to:2026-12-31, outflows:[{onDate:2026-12-07, amount:-15000, label:"bonus (net)"}]}`** | **cash $50,899 · investments $24,347 · NW $75,246** |
| **11** | *"ga but its exempt as well and yes for fica"* | **none** | net bonus $15,700; *"Previous projection with a $15k net bonus had you around: Year-end cash ~$50.9k … Add the extra ~$700 → **~$75.9k**"* |
| **12** | *"exactly"* | **none** | *"~$75–76k"* — **no cash figure at all** |
| **13** | *"we can decide how much of that bonus to keep liquid vs. invest"* | **none** | *"**~$75–76k net worth, ~$36–37k of that in cash**"* |

The deterministic figures, from the raw tool results:

```
project_cash    projection.endingCash            = 35,898.84
scenario_proj   checkpoints[last].liquid         = 50,898.84   (= 35,898.84 + 15,000.00 exactly)
                checkpoints[last].netWorth       = 75,245.81
                checkpoints[last].investments    = 24,346.97   (MEASURED, HELD_FLAT)
                reconciliation.difference        = 0
```

**The arithmetic was right.** The scenario is the baseline plus the bonus, to the cent.

### 1.1 The error propagates into advice

Turn 13 does not merely misstate a figure; it builds a recommendation on it:

> *"Year-end cash without doing anything special with the bonus ≈ **$36k**."*
> *"If you say … 'I want $18k in cash at minimum,' then excess cash ≈ $36k – $18k = **$18k**."*
> *"…you could **invest the whole bonus** and still end the year with ~**$20k** in cash."*
> *"**Invest: $10k–$15k** of the bonus."*

Against the correct base ($51.6k) the investable excess over an $18k cushion is **~$33.6k**, not
$18k. The advice is understated by roughly the size of the bonus it claims to be allocating.

### 1.2 The sentence contradicts itself

> *"~$75–76k net worth, ~$36–37k of that in cash"* — with investments held flat at $24.3k,
> $75.5k − $24.3k = **$51.2k**, not $36.5k.

The two halves of one clause disagree by about $15k. Whatever produced the cash number did not
derive it from the net-worth number it sits beside.

---

## 2. Model input at the failing turn — traced, not inferred

Rebuilt by replaying the saved transcript through the shipped `compactToolHistory` with the shipped
policy (`retainCompletedTurns: 2`), exactly as `interactive.ts` assembles it. 50 messages.

| | at turn 11 | at turn 12 | **at turn 13** |
|---|---|---|---|
| scenario **result** raw (`50898.84`) in a tool message | **YES** | **YES** | **NO** |
| scenario `assumptions` block (structured) | YES | YES | **NO** |
| scenario **call arguments** (`amount: -15000`, `onDate: 2026-12-07`) | YES | YES | **YES** ([42]) |
| scenario cash in assistant **prose** (`$50.9k`) | YES | YES | **YES** ([44], [46]) |
| baseline **result** raw (`35898.84`) in a tool message | YES | NO | **NO** |
| baseline cash in assistant **prose** (`$35.9k`) | YES | YES | **YES** ([40]) |
| the `$15.7k` assumption | — | YES | **YES** ([46], [48]) — **prose only, never a tool input** |
| any machine-readable *"current scenario = baseline + Dec-7 bonus @ $15.7k"* | **NO** | **NO** | **NO** |

**Answers to the brief's explicit questions, at turn 13:**

- Could gpt-5.1 still see the raw `scenario_projection` result containing ~$50.9k? **NO.**
- Could it see the assistant prose containing ~$50.9k? **YES** — twice.
- Could it see the earlier `project_cash` baseline ~$35.9k? **YES, in assistant prose only** ([40]);
  the raw result was elided.
- Could it see the later $15.7k assumption? **YES, in assistant prose only.**
- Could it see a machine-readable current-scenario statement? **NO. No such representation exists.**

**All eleven tool results in the conversation were elision stubs at turn 13.** Total tool-result
payload in that request: **136 bytes**, 2.5% of retained content. Every financial figure the model
could reach was English.

### 2.1 The decisive detail: how the two survivors are phrased

The surviving prose does not present the two figures neutrally.

- [40] (turn 9): *"By **end of 2026 (Dec 31)**, a reasonable estimate is: — **Cash (checking +
  savings): about $35.9k**"* — reads as the live year-end projection.
- [46] (turn 11): *"**Previous projection** with a $15k net bonus had you around: Year-end cash:
  ~$50.9k"* — the assistant labelled the *newer, superseding* figure as **previous**, because at
  that moment it was revising it upward to $15.7k.

So at turn 13 the more recent number is the one that reads superseded, and the superseded number is
the one that reads current. The model did not pick at random; **it picked the sentence that looks
like a standing statement.**

---

## 3. Clip 6 state

Policy, verified against `compaction.ts`: user messages, assistant prose and **tool CALLS (name and
arguments)** survive byte for byte; raw tool-result CONTENT older than the active turn plus 2
completed turns becomes `{"elided":true,"tool":"…"}`.

| turn | tools | elided | retained | tool-result bytes in the NEXT request |
|---|---|---|---|---|
| 9 | `project_cash` | 1 | 2 | 7,325 |
| 10 | `scenario_projection` | 1 | 2 | 7,594 |
| 11 | **none** | 1 | 1 | 4,461 |
| 12 | **none** | 1 | **0** | **431** |
| 13 | **none** | 0 | 0 | 431 |

**A turn with no tool calls still counts as a completed turn.** `compaction.ts` defines a turn as
"user message → assistant message that finally answers in prose", which is correct and deliberate —
but it means turns 11 and 12, which called nothing, consumed the entire retention window. The
scenario result survived exactly two toolless turns and was gone by turn 12.

This is Clip 6 doing precisely what it says. It is a **contributing** condition, not the cause: §7
shows the failure occurs with the result retained, and §2.1 shows the model had an unambiguous
prose statement of the right figure and did not use it.

---

## 4. Provenance of every figure in the bad answer

| figure | provenance | evidence |
|---|---|---|
| **~$24.3k investments** | scenario result → turn-10 prose → carried | `checkpoints[last].investments = 24,346.97` (`MEASURED, HELD_FLAT`) |
| **$15.7k bonus** | **fresh model arithmetic in prose**, turn 11 | `17,000 × 7.65% = 1,300.50`; `17,000 − 1,300 ≈ 15,700`. Never passed to any tool. |
| **~$75–76k net worth** | scenario result **+ prose delta** | `75,245.81 + 700 = 75,945.81` → "~$75.9k" (turn 11) → "~$75–76k" (turns 12, 13) |
| **~$36–37k cash** | **the superseded `project_cash` baseline** | see below |

**Where ~$36–37k came from — numerically:**

| candidate | value | fits? |
|---|---|---|
| **baseline `project_cash` ending cash** | **35,898.84** | **✔ the "$36k" the model states explicitly later in the same answer** |
| baseline + the $700 FICA delta | **36,598.84** | **✔ accounts for the "$37k" upper bound** |
| scenario liquid − the $15,000 bonus | 35,898.84 | identical to the baseline *by construction* — not separable |
| orientation cash today | 14,610.26 | ✗ |
| the model's own stated NW − investments | 50,650 – 51,650 | ✗ — off by ~$15k |
| the 2026-09-08 `liquid-2026-12-31` checkpoint | 38,386.40 | ✗, and not in context (§6) |
| scenario liquid (correct answer) | 50,898.84 | ✗ |

The lower bound is settled by the model's own words later in the same turn: *"Year-end cash
**without doing anything special with the bonus** ≈ $36k."* That sentence relabels the **pre-bonus
baseline** as the **post-bonus, uninvested** figure. The upper bound "$37k" is best explained as the
baseline plus the $700 prose delta (36,599 → "~$37k"); that reading is inference, the lower bound is
not.

**The most economical description of the mechanism:** the model carried forward the *increment* it
had computed in prose (+$700) and applied it to the *wrong base* — the baseline instead of the
scenario.

---

## 5. Current scenario-continuity architecture

**`scenario_projection` returns** (`tools.ts:1379`): `asOf`, `horizon`, `reconciliation`,
**`assumptions`** (returns / contributions / outflows / spending, each with `provenance` and a
refusal note where nothing is in force), `opening`, `checkpoints`, `movements`.

**`assumptionsInForce` is not part of it.** That key exists only on `scenario_goal_seek`
(`tools.ts:1561`), on every path including refusals. `scenario_projection` returns the same
structure under the name `assumptions`. Both are produced by the same pure helper
`scenarioAssumptions(setup, ledger, returns)`.

**Where it lives: in the tool's return value, and nowhere else.** It is not persisted to
conversation state, not written to `SpaceMemory`, not checkpointed, and not reconstructed from the
transcript. It exists for exactly as long as Clip 6 keeps that one tool message raw — **two
completed turns**, tool-calling or not.

**What happens when the user changes one assumption in prose without re-calling the tool:** nothing
deterministic happens. The scenario ledger is stateless and per-call; `runScenarioLedger` is a pure
function of the arguments supplied on that call. `$15,000 → $15,700` updated **no** state. The
$15,700 figure never entered any tool on any turn of this session.

**What *does* survive** is the call's **arguments** — Clip 6 preserves them verbatim, so at turn 13
the model could still read `{"onDate":"2026-12-07","amount":-15000,"label":"bonus (net)"}`. The
question *"what scenario are we in?"* is answerable from context. The question *"what did it come
out to?"* is not.

---

## 6. Checkpoint and memory interaction

`SpaceMemory` for this Space, 8 rows. The three written during this session:

```
19:54:42  CHECKPOINT  liquid-2026-10-19   value 19,896.54   ← turn 7  project_cash
19:56:51  CHECKPOINT  liquid-2026-12-31   value 35,898.84   ← turn 9  project_cash  (THE BASELINE)
          (no row)                                          ← turn 10 scenario_projection
```

- Was the ~$35.9k baseline checkpointed? **Yes**, automatically, at 19:56:51.
- Was the scenario checkpointed? **No.**
- Should it be, by design? **No** — `checkpointProjection` returns `null` for any tool other than
  `project_cash` (`memory-tools.ts:71`), documented at `memory-tools.ts:57`: *"ONLY THE
  DETERMINISTIC PROJECTION IS CHECKPOINTED. A `scenario_projection` …"*. That is Slice 7's deliberate
  boundary and this investigation does not propose changing it.
- Did the memory line surface the older baseline as a competing value? **No.** The orientation is
  built **once, at session start (19:43:51)** — before either checkpoint was written. The memory line
  the model saw reads `projectionsOnRecord: {count: 1, horizons: ["2026-12-31"]}` with **no amount**,
  and that 1 refers to a checkpoint from 2026-09-08 ($38,386.40). **It cannot have supplied
  $36–37k.** `NOT CAUSAL`.

**But it leaves a durable asymmetry worth recording:** the superseded baseline is now the only
year-end statement on record. A future session's `reconcile_projection` will compare reality against
**$35,898.84 with no bonus**. The conversation's actual conclusion left no trace.

---

## 7. Reproduction — and what it actually found

Sequence per the brief, gpt-5.1, shipped A2/tools/instruction/compaction, 5 trials per condition.

**The live failure did not reproduce. A different one did.**

| | |
|---|---|
| Runs where the bonus turn called `scenario_projection` | **2 / 10** (A t1, B t1) |
| Runs where it called `project_cash` instead | **8 / 10** |
| Of the 2 true-scenario runs, final answer preserved the scenario (~$51.6k) | **2 / 2** |
| Symptom reproduced (bonus narrated, baseline reported) | **1 / 10** — B t4 |

In 8 of 10 runs the model routed the bonus to **`project_cash`, which has no input for a one-off
amount**, and packed the bonus into `statedAs` — a free-text field whose documented scope is *"the
user's own words for that assumption"* about `assumedMonthlySpending`:

```
project_cash{ to: "2026-12-31", assumedMonthlySpending: 4346.48,
              statedAs: "user has a $15k net bonus on 2026-12-07 added on top of current pattern" }
  → projection.endingCash = 35,909.27          (baseline 35,898.84 — a $10.43 difference)
  → appliedUserFacts: ["spending baseline 4346.48 USD: \"user has a $15k net bonus on
                        2026-12-07 added on top of current pattern\""]
```

**The tool echoed the bonus sentence back inside a provenance field and changed the answer by ten
dollars.** B t4 then wrote:

> *"Using your stated assumption (keep spending at about $4,346/month and **add a $15k net bonus**):
> **End-of-year liquid (cash): still about $36k** … That's essentially your current projection
> (~$35.9k) plus the $15k bonus minus the regular spending you'll do after Dec 7"*

That is the live symptom exactly — bonus narrated as included, baseline reported — reached by a
completely different route, and with a fabricated reconciliation (spending from Dec 7–31 is ~$3.5k,
not $15k). **`appliedUserFacts` made a $15k assumption look honoured when it was discarded.**

This is a **second, independent defect** of the same family and, on these 10 runs, the more frequent
one. It is not the cause of the session under investigation — there, `scenario_projection` was
called correctly.

---

## 8. Compaction discriminator — **inconclusive, and reported as such**

| condition | baseline resurrected in the final turn | scenario preserved | raw scenario visible at the final turn |
|---|---|---|---|
| A — shipped Clip 6 | 2/5 | 1/5 | false 5/5 |
| B — scenario result pinned through the allocation turn | 3/5 | 1/5 | true 1/5 (only where a scenario existed) |

**These numbers do not test the hypothesis.** Only **2 of 10** runs produced a deterministic scenario
at all (A t1, B t1), and both preserved it correctly in both conditions — so the discriminator has
**n = 1 per arm**. The 2/5-vs-3/5 split is dominated by the eight runs where there was never a
scenario result to retain or elide, and reporting it as a compaction result would be a measurement
error. Within the brief's 5-trial cap this question cannot be answered; any future attempt must first
force `scenario_projection` to fire.

What *can* be said without more trials, from §2.1: at turn 13 the model **had an unambiguous prose
statement of the correct figure** (*"Year-end cash: ~$50.9k"*) and did not use it. Retaining the
same figure in a second format is not obviously the missing ingredient.

---

## 9. Negative control — ordinary continuity is fine

`"By EOY?"` → `"What about October?"`, 5 trials.

**5/5 answered correctly (~$23.5k) with no tool call**, reading `checkpoints[2].closingCash =
23,468.61` out of the still-raw `project_cash` result from the previous turn. Horizon inheritance,
figure selection from a structured result, and month-end reading are all intact.

The distinction is sharp: the control's evidence was **one turn old and still raw**. The scenario's
was **three turns old and elided** — and, unlike the control, had been *revised in prose* in between.

---

## 10. Root-cause attribution

| | cause | verdict |
|---|---|---|
| **C** | **No durable within-conversation representation of a scenario RESULT.** The ledger is stateless and per-call; the output lives only in one tool message and in English. | **PRIMARY** |
| **I** | **The assumption changed without re-running the tool — while the tool result was still in context.** Turn 11 revised $15k → $15.7k in prose with the raw scenario at hand. From that moment the authoritative result was stale and nothing said so. | **PRIMARY** |
| **B** | **Assistant prose retained an insufficient — in fact actively misleading — representation.** The superseding figure was labelled *"Previous projection"*; the superseded one read as a standing statement. Turn 12 then dropped cash entirely. | **PRIMARY** |
| **A** | Clip 6 elision. Real and correctly timed (two toolless turns consumed the window), and it removed the last structured trace. But §7 shows the symptom occurs with the result present, and §8 cannot show retention helps. | **CONTRIBUTING** |
| **E** | Model saw both values and chose the wrong one. True — but §2.1 shows the surviving prose made the wrong one look current. Selection failure with a mislabelled menu. | **CONTRIBUTING** |
| **F** | Fresh prose arithmetic. The $700 was computed correctly; it was applied to the wrong base. Arithmetic fine, base wrong. | **CONTRIBUTING** |
| **D** | `assumptionsInForce`/`assumptions` reachable only inside a tool result. True (§5) — but assumptions were *not* what was lost; the call arguments survived to turn 13. | **NOT CAUSAL here** |
| **G** | The answer followed some other value in context. | **NOT CAUSAL** — §4 excludes every other candidate numerically |
| **H** | Harness/state-assembly bug. | **NOT CAUSAL** — the replay reproduces the request exactly; compaction behaved to spec |
| — | `scenario_projection` arithmetic. | **NOT CAUSAL** — exact to the cent, `reconciliation.difference = 0` |
| **NEW** | **`project_cash.statedAs` accepts a bonus it cannot model and echoes it back in `appliedUserFacts`.** Not implicated in this session; the dominant failure in reproduction. | **SEPARATE DEFECT, same family** |

### 10.1 Which continuity failed

1. **Conversational — HELD.** The model tracked the subject perfectly across four turns.
2. **Assumption — HELD.** $15.7k was carried in prose, correctly, to the last turn; the scenario's
   original inputs survived machine-readably in the tool-call arguments.
3. **RESULT — FAILED.** The deterministic output became unreachable, was superseded by a prose
   revision that never re-entered the engine, and was then out-competed by an older figure that read
   as current.

### 10.2 Does "code owns money" hold across a conversation?

**No.** It holds *within a turn*: `scenario_projection` computed $50,898.84 and the model reported it
faithfully. It stops holding at the next turn boundary. At turn 11 a $700 change to a consequential
projection was applied by the model, in prose, to a figure it could still see in structured form; by
turn 13 every money figure in context was English. **The invariant is currently per-call, not
per-conversation, and nothing in the system detects or announces the moment it lapses.**

---

## 11. Smallest remedy class — not a design, and not implemented

Stated as *classes*, because choosing between them is a product decision this investigation does not
make. In rough order of size:

- **(i) Make a superseded scenario un-usable rather than merely old.** The failure needs the stale
  figure to be *reachable and plausible*. Any mechanism that ties a result to the assumptions that
  produced it — so that a changed assumption invalidates the figure rather than silently orphaning
  it — removes the menu the model chose wrongly from. This is the class the evidence points at most
  directly.
- **(ii) Make a prose revision of a deterministic figure impossible, or visibly not authoritative.**
  The $700 edit is where truth left the engine, and it happened *with the engine's answer in view*.
- **(iii) Give a scenario result the same durability the baseline already has.** Today the
  superseded baseline is checkpointed and the scenario is not (§6) — the asymmetry is backwards for
  this failure. Slice 7's boundary was deliberate and this is not a recommendation to cross it, but
  the asymmetry should be a conscious choice rather than a side effect.
- **(iv) Close the `project_cash.statedAs` hole** (§7) — a tool that echoes an assumption it cannot
  apply. Independent of scenario continuity, and arguably more urgent because it is more frequent.

**Explicitly rejected**, per the brief and on the evidence:

- Any prompt instruction ("always remember scenarios", "prefer the latest number", baseline-vs-
  scenario routing). §2.1 shows the surviving evidence was *mislabelled*, not merely unemphasised;
  an instruction would be asking the model to distrust its own earlier sentence.
- A scenario intent classifier, or regexes over assistant prose.
- Simply widening Clip 6's retention window. §8 cannot show retention helps, §7 shows the symptom
  without elision, and a stale payload sitting in context is exactly what `compaction.ts` argues
  against.
- Changing checkpoint policy. Out of scope by instruction.

---

## 12. Promotion

**This should block promotion of the experimental assistant into the production route, on severity
rather than frequency.**

- The user-visible output was a **consequential financial recommendation** — how much of a $15.7k
  bonus to invest — built on a cash figure understated by ~$15k, with the investable surplus
  understated by ~$15.6k (§1.1).
- It was **self-inconsistent within one sentence** (§1.2) and stated with no hedge.
- The reproduction found a **second, more frequent route** to the same class of output (§7), so this
  is not a single unlucky path.
- `code owns money` — the architectural invariant the whole design rests on — **does not currently
  hold across turn boundaries** (§10.2), and nothing detects the lapse.

Frequency is genuinely unknown: 1/10 in reproduction, and the live instance is 1 known occurrence.
That uncertainty is an argument for measuring before shipping, not for shipping.

---

## 13. Kept separate

Untouched, per the brief: activity frame (closed at 25efa81), card-payment ranking, R2→R3 causal
calibration, standing-preference memory shape, `AiInvocation` telemetry, production-route promotion
mechanics, model selection. No repository behaviour changed; every harness used here is in
gitignored `tmp/scen/`.
