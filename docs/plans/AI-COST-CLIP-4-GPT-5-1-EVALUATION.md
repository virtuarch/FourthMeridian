# Cost Clip 4 — gpt-5.1 evaluated against the validated gpt-5.5 corpus

**Date:** 2026-09-08 · **HEAD:** `d1ecff0` · **Status:** evaluation. **Nothing adopted, nothing changed.**

Default model unchanged (`gpt-5.5`). Production route unchanged (`503 AWAITING_REDESIGN`). No Cost
Clip implemented. No financial data read or written outside the canonical read authorities.

---

## 1. Verdict

# DO NOT ADOPT — CONDITIONAL on closing one gap

**gpt-5.1 is 79.4% cheaper and 52% faster on the real run, and it fails four of the seven
decision-gate criteria.** The savings are larger than the repriced-volume hypothesis predicted
($0.51 actual vs $0.24 predicted only because gpt-5.1 *also* changed behaviour — see §6).

**The exact reason for the verdict:** gpt-5.1 **systematically under-retrieves**. It answers
open-ended financial questions from the thin core and conversational memory instead of calling
the tools that hold the evidence. This is reproducible, not noise:

> Asked *"does it look like I may've sold any crypto to cover debt?"* — **gpt-5.1 made zero tool
> calls in 3 of 3 trials** and answered by inference from balance deltas, saying *"I can't see
> individual trades here."* **gpt-5.5 made 9–11 `get_transactions` calls in 3 of 3 trials** and
> every time found the actual evidence: two Coinbase transfers on Feb 27 totalling **$10,044.10**,
> against same-day card payments of $5,000 to Amex and $4,000 to Chase.

The system *can* see individual trades. gpt-5.1 told the user it cannot.

**One severe failure is enough to reject the tier, and there are three of that class** (§4.1).

**Why CONDITIONAL rather than a flat no:** on the six slice 1–7 acceptance properties, run
directly, **gpt-5.1 scored 6/6 — and two of them better than gpt-5.5's original dogfood
behaviour** (§5). The failures are not reasoning failures. They are *disposition* failures on
open-ended turns, and the disposition gpt-5.5 supplied was never written down anywhere. That
makes most of this **category B — an underspecified contract gpt-5.5 was compensating for** —
which is fixable without touching the reasoning architecture.

---

## 2. Scope and method

| Corpus | Turns | Notes |
|---|---|---|
| Session 1 — `interactive-2026-09-08T15-02-08-054Z` | 7 | same 15-tool surface as the baseline — **clean comparison** |
| Session 2 — `interactive-2026-09-08T15-11-39-523Z` | 4 | same surface, memory carried over from session 1 — **clean comparison** |
| Session 31 — `interactive-2026-09-07T21-25-37-355Z` | 31 | baseline ran on a **10-tool** surface with no memory or scenario tools — **partially confounded**, flagged per turn |
| **Total** | **42** | |
| Slice 1–7 acceptance properties | 6 | run directly against gpt-5.1 |
| Stochasticity probes | 24 | supersession ×6, retrieval ×18, both models |

**Method.** Each session's **user turns** were replayed as a real conversation: gpt-5.1 chose its
own tools, the real tools executed against the real Space, and Clip 6 compaction and slice 7's
silent checkpoint ran at the same points. The runner mirrors `executeTurn` exactly (same hop cap
of 6, same `max_completion_tokens: 8000`, same message shapes) with one addition — it records
`prompt_tokens_details.cached_tokens`, which the harness does not.

**Isolation.** Everything ran under a **throwaway user**, so memory is scoped to a separate owner
and the operator's own 5 `SpaceMemory` rows were never read, written or deleted. Verified before
and after: **5 rows, unchanged.**

**Data drift.** The replay ran 45–55 minutes after the baseline sessions, so the underlying
financial corpus is effectively identical. Where figures are compared, they are compared against
**the tool output in the same run**, not against the baseline's absolute numbers.

**Confound, stated.** Session 31's baseline had 10 tools. Turns where gpt-5.1 used
`scenario_projection` / `scenario_goal_seek` / `recall` and gpt-5.5 could not are marked
**surface-confounded** and are **not** counted as gpt-5.1 wins.

---

## 3. Results

### 3.1 Classification counts — 42 turns

| Classification | Count | Share |
|---|---|---|
| **PASS** | **23** | 54.8% |
| **PASS_WITH_DIFFERENCE** | **7** | 16.7% |
| **TRUTH_REGRESSION** | **3** | 7.1% |
| **SCENARIO_REGRESSION** | **4** | 9.5% |
| **MEMORY_REGRESSION** | **2** | 4.8% |
| **TOOL_REGRESSION** | **2** | 4.8% |
| **PRODUCT_REGRESSION** | **1** | 2.4% |
| **Regressions total** | **12** | **28.6%** |

### 3.2 Per-turn — sessions 1 and 2 (clean comparison)

| # | Question | gpt-5.5 tools | gpt-5.1 tools | Classification |
|---|---|---|---|---|
| S1 T0 | How am I looking financially? | 3 | **0** | PASS_WITH_DIFFERENCE |
| S1 T1 | Go back to Jan 1… | 4 | **1** | **TRUTH_REGRESSION** |
| S1 T2 | Explain Jan–Jul | 5 | **1** | PASS_WITH_DIFFERENCE |
| S1 T3 | Did I sell crypto to cover debt? | 4 (`get_transactions`) | 2 (`get_investments`) | **TOOL_REGRESSION** |
| S1 T4 | Where am I headed by EOY? | 4 | 1 | **PASS** (marginal win) |
| S1 T5 | Is $1M by 2030 plausible? | 3 | 1 | **PRODUCT_REGRESSION** |
| S1 T6 | Help me monitor it | 1 `remember` | 1 `remember` | **MEMORY_REGRESSION** |
| S2 T0 | Do you still remember my 2030 goal? | 1 `recall` | 1 `recall` | **PASS** |
| S2 T1 | Make it 750k by 2029 | 3 | 1 | **MEMORY_REGRESSION** (+ product) |
| S2 T2 | $500/weekday, 75% invested, 70–80% | 2 `scenario_projection` | 1 | **SCENARIO_REGRESSION** |
| S2 T3 | Help keep me in check | 2 `remember` | **0** | PASS_WITH_DIFFERENCE |

### 3.3 Per-turn — session 31 (material differences only)

| # | Question | Classification | Note |
|---|---|---|---|
| T0 | How am I looking? | PASS_WITH_DIFFERENCE | 0 vs 1 call |
| T7 | What's realistic for next summer? | **TOOL_REGRESSION** | 0 vs 3 calls |
| T14 | Back to Jan 1, eradicate the $37k debt | **TRUTH_REGRESSION** | **post-cutoff leak** — see §4.1 |
| T15 | Cash was ~1k? are you sure? | **TRUTH_REGRESSION** | 0 calls; *"I don't know your exact cash"* |
| T18 | Interest paid, full history | PASS | **$16,159 both** — exact agreement |
| T20 | College tuition paid | PASS_WITH_DIFFERENCE | **$13,978.75 both**; 5.1 typo'd the headline as $13,979.75 |
| T24 | $500/weekday — EOY? | **SCENARIO_REGRESSION** | 0 calls with `scenario_projection` available |
| T28 / T29 | 1k a day? / 2k? | **SCENARIO_REGRESSION** ×2 | prose arithmetic; scenario parameters not inherited |
| T10–13, T25–27 | scenario chains | PASS (**surface-confounded**) | 5.1 used the scenario tools; 5.5 had none and did prose arithmetic |
| T16 | What did I actually do vs your plan | PASS | 5.1 called `recall` + 4 evidence tools |
| all others (21) | — | PASS | no material difference |

---

## 4. Material behavioural differences

### 4.1 The three truth regressions

**① S1 T1 — the Jan-1 assessment that lost the debt.**
gpt-5.5 called `get_financial_snapshot(asOf)`, `get_spending(asOf)`, `get_income(asOf)`,
`get_investments(asOf)` and reported: net worth **$9,380**, liquid **$9,517**, **debt $37,316**,
investments $37,178. gpt-5.1 called **one** tool — `project_cash({to: '2026-01-01', asOf:
'2026-01-01'})`, a **zero-day horizon** — then wrote:

> *"I don't have the full January-1 net worth breakdown in this tool call"*

…and did not go and get it, despite `get_financial_snapshot({asOf})` existing for exactly this.
It never mentioned the **$37,316 of debt** — the dominant fact about that date — and concluded
*"you're okay for now"*. **Reproducible 2 of 3 trials.**

**② S31 T14 — a post-cutoff leak.** The user said *"lets go back to 1 jan 2026 … act as if you
know nothing about anything after that time period"*. gpt-5.5 queried **2025-07-01 → 2025-12-31**.
gpt-5.1 queried `{from: '2025-12-01', to: '2026-01-31', asOf: '2026-01-31'}` — **a full month
after the stated cutoff** — and built its whole debt-payoff plan on figures contaminated by it
("you're bringing in about $15k/month", "+$18,289 net cash flow").

> The **deterministic layer behaved correctly**: `clampToCeiling` honoured the ceiling it was
> given. The model chose the wrong ceiling. Slice 3 makes the cutoff *enforceable*; it cannot make
> the model *pick the right date*.

**③ S31 T15 — declining to look.** The user challenged the cash figure. gpt-5.5 re-queried and
corrected itself to **$9,517.46**, explaining the population difference — the slice-1 behaviour.
gpt-5.1 made **zero tool calls** and said:

> *"I **don't know** your exact cash on 1 Jan 2026 … If you remember roughly what your cash
> actually was then … tell me that and I'll reframe the plan"*

Asking the user to supply from memory a figure the financial authority holds to the cent is the
inversion of the entire product. This one is **downstream of ②** — having never fetched the
figure, it had nothing to re-check — but the claim of ignorance is false either way.

### 4.2 The memory regression, and the test that reframes it

In the replay, gpt-5.1 minted **date-stamped subjects**: `net-worth-target-2030`, then
`net-worth-target-2029`. Because supersession keys on `subject`, the $750K goal did **not**
supersede the $1M one, leaving **two contradictory ACTIVE intentions**:

```
ACTIVE  INTENTION  net-worth-target-2030   $1,000,000 by 2030-12-31
ACTIVE  INTENTION  net-worth-target-2029   $  750,000 by 2029-12-31
```

**But the seeded-store test changes the reading.** With the store pre-seeded exactly as gpt-5.5
writes it (`subject: "net-worth-target"`), asked *"actually make the goal 750k by 2029"*:

| Model | Trials | Subject chosen | Result |
|---|---|---|---|
| **gpt-5.1** | 3 | `net-worth-target` ×3 | **3/3 superseded correctly** |
| gpt-5.5 | 3 | `net-worth-target` ×3 | 3/3 superseded correctly |

**gpt-5.1 reuses an existing key perfectly.** It only diverges when *minting* a key, and its
naming instinct is date-derived — so a change of target date produces a new key. **On the real
adoption path (an existing store written by gpt-5.5), this failure does not occur.** It remains a
regression in the replayed corpus and a genuine risk for new users.

### 4.3 The scenario regressions

**S2 T2 — an assumption substituted, and disclosed.** The user said *"$500 per weekday … invested
75% of the avg $500"*. gpt-5.1 passed `fractionOfLiquid: 0.75` monthly — **75% of the projected
cash balance**, a different quantity entirely — and said so:

> *"I modeled '75% of weekday trading profits' as 75% of your available cash each month, because
> I don't actually observe your future $500/day profits."*

That reasoning is wrong: the user *stated* the rate, which makes it a `USER_ASSUMED` input and
exactly what the tool exists to consume. Result: **$1.04M** against gpt-5.5's **$1.42M–$1.56M**.
It also collapsed the user's 70–80% range to a single 75%.

> **Per the brief's instruction, this is judged on how each model handled the same schema gap.**
> Both had to work around the missing weekday cadence. gpt-5.5 worked around it **faithfully but
> expensively** (40 enumerated dated contributions, 3,468 output tokens). gpt-5.1 worked around it
> **cheaply but unfaithfully**. Under the same contract, gpt-5.1 is materially worse here — not
> because of the gap, but because of what it substituted.

**S31 T24/T28/T29 — consequential arithmetic in prose with the tool available.** Asked *"if I
made $500 avg on weekdays what does my EOY look like"*, gpt-5.1 made **no tool call**, computed
`260 weekdays × $500 ≈ $130,000` in prose, and answered for **a full year** when the horizon was
~4 months — landing on *"you'd likely be over $200k net worth, possibly more."* gpt-5.5 (which had
no scenario tool) at least anchored on the **83 remaining weekdays** and the real projection base
of $38,243.50. On the *"1k a day?" / "2k?"* follow-ups, gpt-5.1 gave ranges and **did not inherit**
the established scenario parameters (15% growth, half of cash invested at each year-end) that
gpt-5.5 carried forward correctly.

### 4.4 Where gpt-5.1 is better

- **Acceptance sweep 6/6** (§5), including two properties it handles *better* than the 5.5 dogfood.
- **S1 T4** — identical projection and checkpoints, and it did **not** make the redundant
  model-written `CHECKPOINT` that the cost investigation flagged in gpt-5.5. The slice-7 silent
  checkpoint fired correctly.
- **S2 T3** — declined to coerce a standing preference into the broken `INTENTION` shape. gpt-5.5
  wrote `amount: 0` junk. 5.1 stored nothing, which is arguably more correct under a contract with
  no shape for a preference — though it also never told the user it had not been recorded.
- **Epistemic qualification is consistently excellent** — *"that's math, not reality"*, risk of
  ruin, taxes, "this is not a forecast" — with no prompting.
- **Exact figure agreement** wherever it did call the tool: $16,159 interest, $13,978.75 tuition,
  $38,386.40 EOY cash and all four month-end checkpoints, $9,517.46 / $1,255.20 / $8,262.26 on
  Jan 1.

### 4.5 Figure mismatches

**Only one consequential figure mismatch exists**, and it is the assumption substitution in §4.3
(**$1.04M vs $1.42–1.56M**). Every other figure gpt-5.1 stated matched the deterministic tool
output exactly. One cosmetic slip: S31 T20 headlined **$13,979.75** and detailed **$13,978.75**
(a $1 transposition; the tool value is $13,978.75).

**There are no invented figures.** Notably, gpt-5.1 did *not* reproduce gpt-5.5's original turn-13
fabrication — it refuses cleanly when it cannot compute (§5, Q5).

---

## 5. Slice 1–7 acceptance properties — **6/6 PASS**

Run directly against gpt-5.1, in one session, total cost **$0.0408**.

| # | Property | Result |
|---|---|---|
| 1 | *"How was I doing on Jan 1 2026?"* (§12.1/12.5) | **PASS** — `get_financial_snapshot({asOf})` → **liquid $9,517.46**, **checking $1,255.20**, **savings $8,262.26**, debt $37,316.03, all three named distinctly, first attempt |
| 2 | *"cash was around 1k? are you sure?"* | **PASS, better than the 5.5 original** — no contradiction, no re-fetch needed: *"'cash was around 1k' is true only if you mean checking alone… closer to $9.5k"* |
| 3 | Jan-1 advice with no post-cutoff evidence (§12.9) | **PASS** — no post-Jan-1 figure cited |
| 4 | Deterministic projection | **PASS** — $38,386.40 and all four checkpoints, with the held-flat caveat |
| 5 | Reconciliation (slice 7) | **PASS** — used `reconcile_projection` and correctly explained IN_FLIGHT is *projection vs the same projection re-run*, **not** vs the current balance |
| 6 | Unreachable target (§12.16) | **PASS** — *"even at an absurd +500% per year the model only reaches about $384,304"*; `feasible: false` reported, nothing invented |

> **This is the most important table in the document.** When the question is direct, gpt-5.1
> exercises every property slices 1–7 established, correctly, cheaply and fast. The regressions in
> §4 are not failures of capability.

---

## 6. Cost — measured, not repriced

Actual runs on both models. gpt-5.5 cached shares are replay-measured (cost investigation §3);
gpt-5.1 cached tokens are recorded live.

| Session | Turns | gpt-5.5 prompt / cached / completion / reasoning | gpt-5.5 $ | gpt-5.1 prompt / cached / completion / reasoning | gpt-5.1 $ | Saving |
|---|---|---|---|---|---|---|
| S1 | 7 | 240,601 / 204,939 / 5,434 / 2,362 | $0.4438 | 126,408 / 100,096 / 6,004 / **0** | **$0.1054** | **76.2%** |
| S2 | 4 | 136,853 / 131,712 / 9,327 / 3,768 | $0.3714 | 45,671 / 35,072 / 1,406 / **0** | **$0.0317** | **91.5%** |
| S31 | 31 | 589,469 / 525,805 / 35,417 / 26,274 | $1.6437 | 720,005 / 607,360 / 15,197 / **0** | **$0.3687** | **77.6%** |
| **Corpus** | **42** | **966,923 / 862,456 / 50,178 / 32,404** | **$2.4589** | **892,084 / 742,528 / 22,607 / 0** | **$0.5058** | **79.4%** |

| Metric | gpt-5.5 | gpt-5.1 | Delta |
|---|---|---|---|
| **Corpus cost** | **$2.4589** | **$0.5058** | **−79.4%** |
| **$ per user turn** | $0.0585 | **$0.0120** | −79.4% |
| **10-turn conversation** | ~$0.51 | **~$0.10** | −79% |
| **25-turn conversation** | ~$1.35 | **~$0.28** | −79% |
| **Latency per turn** | 18.4s | **8.8s** | **−52%** |
| Completion tokens/turn | 1,195 | **538** | −55% |
| **Reasoning tokens** | **32,404** | **0** | **−100%** |
| Cache hit rate | **89.2%** | 83.2% | −6.0 pts |
| Tool calls/turn | 1.52 | **0.76** | **−50%** ← the regression, in one number |
| Model invocations/turn | 1.76 | 1.67 | −5% |

**The saving is larger than the hypothesis, and partly for the wrong reason.** The cost
investigation's repriced-volume estimate was $0.2407 for sessions 1+2; the measured figure is
**$0.1371 — 43% lower still.** That is not a bonus: **half of it comes from gpt-5.1 making half
as many tool calls**, which is the same behaviour §4 classifies as a regression. **Some of this
discount is the product being cheaper because it is doing less.**

Two honest observations:

- **gpt-5.1 emitted zero reasoning tokens across all 42 turns.** It is not reasoning less
  effectively on the acceptance properties, but the 32,404 reasoning tokens gpt-5.5 spent were
  the largest single output component and gpt-5.1 simply does not spend them here.
- **gpt-5.1 used *more* prompt tokens on session 31** (720K vs 589K) — the baseline ran on a
  10-tool surface, and gpt-5.1's answers are longer. It is still 77.6% cheaper.

---

## 7. Decision gate

| # | Criterion | Result |
|---|---|---|
| 1 | Zero truth regressions | **FAILED — 3** (§4.1) |
| 2 | Zero historical-authority regressions | **FAILED — 1** (S31 T14 post-cutoff leak) |
| 3 | Zero memory ownership / supersession regressions | **FAILED in replay — 2**; **PASSED 3/3 on a pre-existing store** (§4.2) |
| 4 | Zero consequential arithmetic regressions | **FAILED — 3** (S31 T24/T28/T29 prose arithmetic with the tool available) |
| 5 | Scenario / goal-seek trustworthy | **PARTIAL** — 6/6 acceptance incl. unreachable-target honesty; but an assumption was substituted (§4.3) |
| 6 | Broad financial / advisor answers materially useful | **PARTIAL** — well-written, strong epistemics, **systematically under-evidenced** |
| 7 | Savings substantial in the actual run | **PASSED — 79.4%** |

**One of seven passes cleanly.** Per the brief — *"do not average away a serious regression; one
severe financial-truth failure is enough to reject the tier"* — the verdict is **DO NOT ADOPT**.

---

## 8. Model weakness vs contract weakness vs shared defect

| Finding | A: model | B: contract | C: shared | Reading |
|---|---|---|---|---|
| **Under-retrieval** (2 truth, 2 tool, 1 product, 3 scenario) | contributing | **PRIMARY** | — | **Nothing in the system instruction or any tool description says "fetch the evidence before you assess".** gpt-5.5 did it by disposition, so the requirement was never written down. The instruction says *"Use the financial evidence and tools you are given"* — which gpt-5.1 satisfies by using the thin core. **This is an implicit contract gpt-5.5 was silently honouring.** |
| **Memory subject minting** | contributing | **PRIMARY** | — | Proven by measurement: 3/3 correct against an existing key, 0/2 when minting. The subject is free text with no vocabulary, and `remember`'s description only says *"re-use it to update the same thing"* — which cannot bind the first write |
| **asOf ceiling choice** (S31 T14) | **PRIMARY** | — | — | The parameter is documented as *"Information ceiling: pretend today is this date"* and gpt-5.5 read the same words correctly. This one is gpt-5.1 |
| **Scenario assumption substitution** | **PRIMARY** | — | contributing | The missing weekday cadence is **C**, shared, and already logged as Cost Clip 2. But gpt-5.5 stayed faithful to the stated inputs under the same gap and gpt-5.1 did not |
| **Preference not stored** (S2 T3) | — | — | **PRIMARY** | The `INTENTION` contract has no shape for a standing preference. gpt-5.5 coerced it with `amount: 0`; gpt-5.1 dropped it. **Both wrong, differently** — already logged as Cost Clip 3 |

**Per the instruction, none of the B or C findings were patched during this run.**

**The strategic read:** most of the gap is **B**, and B is cheap. The retrieval disposition is a
*token-contract* question — a sentence in the system instruction or in the tool descriptions —
not a planner, router or state machine. If a retrieval-disposition clip closes it, gpt-5.1 becomes
a **79% saving on a corpus where it already passes 6/6 acceptance properties**. That is the single
highest-value follow-up available, and it is why this verdict is CONDITIONAL rather than closed.

**What it must not become:** a rule enumerating which tool to call for which question. That is the
intent router the constraints forbid.

---

## 9. Conditions for re-evaluation

Re-run this exact evaluation, unchanged, after **either** of:

1. **A retrieval-disposition clip** — the smallest change that makes "assess from the evidence,
   not from the orientation summary" explicit. Success = questions A/B/C in the retrieval probe
   reach ≥ 2 tool calls and surface the key evidence in 3/3 trials on gpt-5.1.
2. **Cost Clips 2 + 3** (already recommended independently) — closing the weekday-cadence gap and
   the preference contract removes the C-shaded findings and lets the A/B ones be judged alone.

**Gate for a future ADOPT:** criteria 1–4 at zero, criterion 5 with no assumption substitution,
and the acceptance sweep still 6/6. Criterion 7 is already satisfied by a wide margin.

**Not recommended:** adopting gpt-5.1 for "mechanical" turns only. The cost investigation already
measured that shape at a 6% saving, and deciding which turns are mechanical requires the
classifier the constraints forbid.

---

## 10. Answers to the brief

1. **Turns evaluated:** 42 replayed + 6 acceptance + 24 stochasticity = **72 model turns**.
2. **Counts:** PASS 23 · PASS_WITH_DIFFERENCE 7 · TRUTH 3 · SCENARIO 4 · MEMORY 2 · TOOL 2 ·
   PRODUCT 1 (**12 regressions / 42**).
3. **Material differences:** §4 — under-retrieval (reproducible 3/3), a post-cutoff leak, a
   declined re-check, date-stamped memory subjects, an assumption substitution, prose arithmetic
   with the tool available; and, in gpt-5.1's favour, no redundant checkpoint write, no coerced
   preference, better epistemic qualification, 6/6 acceptance.
4. **Figure mismatches:** one consequential ($1.04M vs $1.42–1.56M, from the substituted
   assumption); one cosmetic ($1 transposition). No invented figures.
5. **Tool-selection differences that mattered:** `get_investments` instead of `get_transactions`
   for a transaction-forensics question; `project_cash` (0-day) instead of
   `get_financial_snapshot(asOf)` for a historical position; **zero calls** on three
   evidence-bearing questions.
6. **gpt-5.5 cost:** **$2.4589** / 42 turns.
7. **gpt-5.1 cost:** **$0.5058** / 42 turns.
8. **Measured saving:** **79.4%** ($0.0585 → $0.0120 per turn).
9. **Cache:** 89.2% → 83.2% (−6.0 pts; fewer, more variable prefixes).
10. **Latency:** 18.4s → **8.8s** per turn (**−52%**).
11. **Reasoning 32,404 → 0; completion 1,195 → 538 per turn (−55%).**
12. **Advisor quality:** prose is excellent — clearer structure, better epistemic hedging, no
    fabrication. **But it advises from a thinner evidence base**, and twice built a plan on facts
    it declined to fetch. On the closed acceptance questions it is the better advisor; on
    open-ended ones it is the weaker one.
13. **Attribution:** §8 — primarily **B (contract)** for under-retrieval and memory subjects,
    **A (model)** for the ceiling choice and the assumption substitution, **C (shared)** for the
    preference contract and the weekday cadence.
14. **Verdict: DO NOT ADOPT — CONDITIONAL.**
15. **Reason:** three truth regressions, one historical-authority regression and three
    consequential-arithmetic regressions, all traceable to one reproducible behaviour —
    **gpt-5.1 answers financial questions without fetching the evidence.** 79.4% cheaper is not
    worth telling a user *"I don't know your cash on Jan 1"* when the system knows it to the cent.
16. **Files changed:** `docs/plans/AI-COST-CLIP-4-GPT-5-1-EVALUATION.md` only.
17. **Probes/tests run:** §11.
18. **Measurement spend:** §12.

---

## 11. Probes and tests run

| Probe | Turns / trials | Output |
|---|---|---|
| Session 1 replay, gpt-5.1 | 7 | `tmp/cost/eval/S1-gpt51.json` |
| Session 2 replay, gpt-5.1 (memory carried over) | 4 | `tmp/cost/eval/S2-gpt51.json` |
| Session 31 replay, gpt-5.1 | 31 | `tmp/cost/eval/S31-gpt51.json` |
| Slice 1–7 acceptance sweep, gpt-5.1 | 6 | `tmp/cost/eval/ACC-gpt51.json` |
| Supersession stochasticity, both models, pre-seeded store | 6 | inline |
| Under-retrieval stochasticity, both models, 3 questions | 18 | inline |
| Repo test suite | 495 files | all pass, unchanged |

**A discarded first session-1 run** ($0.1025) was thrown away after I found my runner had omitted
slice 7's silent checkpoint; it was fixed and the session re-run before any analysis.

---

## 12. Measurement spend

**≈ $1.53.** Exactly recorded where the runner captured usage; structurally estimated for the two
multi-trial probes.

| Run | Cost |
|---|---|
| Session 1 replay (discarded) | $0.1025 |
| Session 1 replay | $0.1054 |
| Session 2 replay | $0.0317 |
| Session 31 replay | $0.3687 |
| Acceptance sweep | $0.0408 |
| Supersession probe (6 trials, both models) | ~$0.18 *(estimated)* |
| Under-retrieval probe (18 trials, both models) | ~$0.70 *(estimated)* |

> **Incidental finding, and it matters for Cost Clip 1.** `ApiUsageCounter` recorded **none** of
> this evaluation. The counters are incremented inside `lib/ai/provider.ts`, and these probes call
> the OpenAI SDK directly to capture `cached_tokens` — which the provider does not expose. **The
> durable counters only see traffic that goes through the provider boundary**, so any figure they
> produce is a floor, not a total.

---

## 13. Unresolved questions

1. **Would a retrieval-disposition clip close the gap without becoming a router?** The whole
   CONDITIONAL rests on this and it is untested.
2. **Is under-retrieval a gpt-5.1 trait or an A2-thin-core interaction?** The thin core is *good
   enough* to answer "how am I looking" plausibly, which may be what suppresses the tool call. An
   A3 (no pre-loaded evidence) run would separate them — and A3 already exists in the harness.
3. **Does gpt-5.1 mint stable subjects if `remember`'s description carries a small controlled
   vocabulary?** The seeded-store result (3/3) suggests yes, cheaply.
4. **Is zero reasoning tokens a configuration artefact?** gpt-5.1 emitted none across 72 turns.
   If reasoning is available and simply not triggered, the quality ceiling may be higher than
   measured here.
5. **How would gpt-5 (same price as 5.1) or gpt-4.1 compare?** Not evaluated; gpt-4.1 was measured
   at −55% in the cost investigation and is the incumbent for the cheaper arms.

---

## 14. Files changed

- **`docs/plans/AI-COST-CLIP-4-GPT-5-1-EVALUATION.md`** — this document. **Nothing else.**

Default model unchanged. No Cost Clip implemented. `app/`, `lib/`, `prisma/`, `components/` and
`scripts/` untouched; probe scripts and artifacts live in gitignored `tmp/cost/`. The operator's
`SpaceMemory` rows were verified unchanged (5 before, 5 after).
