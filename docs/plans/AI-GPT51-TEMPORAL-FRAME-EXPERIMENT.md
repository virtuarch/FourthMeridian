# Temporal frame — the final experiment

**Date:** 2026-09-09 · **Model:** `gpt-5.1` · **Arm:** A2, standalone cell-A condition (no preamble,
shipped instruction) · **Space:** `cmrrm846r000j7znwsl67gt1g` · **as-of:** 2026-09-08 · 5 trials

Authority: 658cfd2 (investigation), bb2f6ec (2×2), 55a2c22 (corpus coverage + rerun), 70ac794
(anchor probe).

**Experiment only. No repository code changed** — the alternate frame lives in the gitignored
harness. `ASSESSMENT_WINDOW_DAYS` was not touched.

> ## The answer
>
> **Yes. Changing only the active financial frame changes the model's transaction search frame —
> completely, and on the first call.**
>
> 5/5 first searches bound to the experimental window exactly. Feb-27 Coinbase retrieval went
> **0/20 → 5/5**, citation **0/20 → 5/5**. Not one trial independently chose a different period, in
> either direction, in any of the four experiments.
>
> **The temporal-frame hypothesis is confirmed. Retrieval disposition is closed as a line of
> investigation.**

---

## 1. The experimental frame, and why it is truthful

`recent` is not a date range — it is a window **plus five figures measured over it**. Widening the
window alone would have injected false totals, so the figures were recomputed over the new window by
`get_spending`, the same `TRANSACTIONS_SUMMARY` authority that produces the shipped ones.

| | shipped (`ASSESSMENT_WINDOW_DAYS = 90`) | experimental |
|---|---|---|
| window | `2026-06-11 .. 2026-09-08`, 220 → **90 days** | `2026-02-01 .. 2026-09-08`, **220 days** |
| income | 32,704.32 | **82,157.09** |
| spending | 12,342.56 | **49,711.34** |
| cardAndDebtPayments | 23,953.92 | **78,171.45** |
| netCashFlow | 20,378.08 | **35,975.14** |
| transactionCount | 428 | **1,068** |

`2026-02-01` is the smallest calendar-clean extension containing `2026-02-27`, and it places the
event 26 days inside the window rather than on its boundary. Verified before running:

- the key **order** of the orientation body is identical;
- **every key except `recent` is byte-identical**;
- `recent` keeps its name, its shape and its structural position;
- no field was added anywhere.

No instruction about transactions, history, widening, Coinbase, February, debt payoff or causal
evidence was added. The system prompt, tool schemas, tool descriptions, coverage metadata and
compaction are untouched.

---

## 2. The five trials

| | first window class | first `get_transactions` window | gt calls | hops | latency | Feb-27 rows | cites $8,141.98 / $1,902.12 | widened | unwindowed | register |
|---|---|---|---|---|---|---|---|---|---|---|
| **t1** | `FRAME_EXPERIMENTAL` | `2026-02-01..2026-09-08` flow=transfers text=coinbase limit=50 | 2 | 2 | 10.1 s | **2** | **2/2** | no | no | **R2** |
| **t2** | `FRAME_EXPERIMENTAL` | `2026-02-01..2026-09-08` flow=transfers sort=largest limit=50 | 1 | 3 | 11.8 s | **2** | **2/2** | no | no | **R2** |
| **t3** | `FRAME_EXPERIMENTAL` | `2026-02-01..2026-09-08` flow=transfers limit=50 | 1 | 2 | 6.5 s | **1** | **1/2** | no | no | **R2** |
| **t4** | `FRAME_EXPERIMENTAL` | `2026-02-01..2026-09-08` flow=transfers sort=largest limit=20 | 1 | 3 | 9.3 s | **2** | **2/2** | no | no | **R3** |
| **t5** | `FRAME_EXPERIMENTAL` | `2026-02-01..2026-09-08` flow=transfers text=coinbase limit=50 | 3 | 2 | 7.9 s | **2** | **2/2** | no | no | **R2** |
| | **5/5** | | 8 total | 2.4 | 9.1 s | **5/5** | **5/5** | **0/5** | **0/5** | **R2 4 · R3 1** |

`FRAME_90DAY`: 0/5. `GENERATED_BOUNDED`: 0/5. `NO_TRANSACTION_CALL`: 0/5.

### 2.1 Every `get_transactions` call

| trial | from | to | text | flow | sort | limit | shown | `covers` |
|---|---|---|---|---|---|---|---|---|
| t1 | 2026-02-01 | 2026-09-08 | coinbase | transfers | — | 50 | **2** | false |
| t1 | 2026-02-01 | 2026-09-08 | — | card_payments | — | 50 | 50 | false |
| t2 | 2026-02-01 | 2026-09-08 | — | transfers | largest | 50 | 50 | false |
| t3 | 2026-02-01 | 2026-09-08 | — | transfers | — | 50 | 50 | false |
| t4 | 2026-02-01 | 2026-09-08 | — | transfers | largest | 20 | 20 | false |
| t5 | 2026-02-01 | 2026-09-08 | coinbase | transfers | — | 50 | **2** | false |
| t5 | 2026-02-01 | 2026-09-08 | crypto | transfers | — | 50 | 0 | false |
| t5 | 2026-02-01 | 2026-09-08 | — | card_payments | — | 200 | 50 | false |

**8 calls. 8 identical windows.** Every `from` is `2026-02-01`; every `to` is `2026-09-08`.

The binding is not confined to `get_transactions`: `get_spending({from: "2026-02-01", to:
"2026-09-08"})` in t1, t2 and t4 — 3/3. The same behaviour the anchor probe recorded, pointed at a
different frame.

`text: 'coinbase'` was used with the 90-day frame in earlier runs and returned **0 rows**. The
identical call inside this frame returns **2**. The keyword was never the problem.

### 2.2 Feb-27 retrieval

| | |
|---|---|
| **Trials returning ≥1 Feb-27 Coinbase row** | **5/5** (0/20 across bb2f6ec and 55a2c22) |
| Trials returning **both** rows | 4/5 — t3 returned only `$8,141.98` (newest-first, limit 50) |
| **Answers citing the amounts** | **5/5** — four cite both, t3 cites the one it received |
| Independently chose a different temporal frame | **0/5** |
| Widened or retried after a partial result | **0/5** |
| Performed an unwindowed search | **0/5** |
| Noticed `windowCoversAvailableRecord: false` | 0/5 — every call still reported it; still no widening |

The model did not become more curious. It became **correctly aimed**, once and immediately, and did
exactly as much work as before — in fact slightly less (8 `get_transactions` calls across 5 trials,
against 12 in the 90-day probe, because the first search succeeded instead of provoking keyword
flailing).

### 2.3 Payment-event retrieval — the secondary observation

**0/5 retrieved the same-day card payments** ($5,000 Amex, $4,000 Chase, $3,450.65 Chase, $1,000
Amex, total $13,450.65). **0/5 cited $13,450.65. 0/5 computed the $3,406.55 shortfall.**

Two trials (t1, t5) *did* reach for the payment side unprompted — `flow: card_payments` over the same
frame — which answers the brief's secondary question: **finding Coinbase does naturally prompt the
model to inspect payments.** Both then defaulted to newest-first over a 220-day window and received
June–August payments instead of February's. What the model retrieved on the payment side was:

- t2, t4: one Feb-27 row, a `$1,500 Internet transfer from JPMORGAN CHASE` — a transfer, not one of
  the four card payments;
- t3: `$1,500` Amex on 2026-03-02 and `$2,500` Amex on 2026-04-13.

So three of five built their causal story on payments **weeks after** the inflow, not the same day.
That matters for §2.4.

### 2.4 R1 / R2 / R3, observed naturally

No causal or confidence instruction was added.

| | register | what it actually said |
|---|---|---|
| **t1** | **R2** | *"On 2026-02-27 there are two inbound transfers from Coinbase… Total: $10,044.10"* — then **refuses R3**: *"I can't prove 'this specific $X of crypto liquidation directly paid this specific $Y of debt'"* |
| **t2** | **R2** | *"that cash likely helped with debt payoff **or general cash needs**"* … *"the tools don't tag those dollars to a specific payoff, so I can't prove the linkage — only that the timing and flows line up"* |
| **t3** | **R2** | Refuses R3 **and qualifies R2**: *"I can't see inside Coinbase to know whether that money was from **selling** crypto versus cash you already had there"* |
| **t4** | **R3** | *"**Yes, I think you almost certainly did**"* … *"using that liquidity, directly or indirectly, to knock down some of your debt"* |
| **t5** | **R2** | *"those dollars **plausibly** helped"* … *"What I can't see directly is: 'this specific Coinbase sale went to this exact card payment'"* |

**R2 4/5, R3 1/5** — against **R3 5/5** in bb2f6ec's calibration phase.

That is a large difference and it deserves a careful reading rather than a claim. The obvious
candidate is §2.3: in the calibration phase the Feb-27 card payments were **pre-loaded beside the
inflows, same day**, and 5/5 asserted the purpose. Here the model assembled its own evidence, mostly
did **not** get the same-day payments, and instead saw payments weeks later — a looser coincidence,
and 4/5 hedged accordingly, three of them refusing the causal link in their own words.

**Read as: the R2→R3 overclaim may be substantially driven by same-day juxtaposition in the
evidence, not by a fixed disposition.** That is an observation from one 5-trial cell against another
5-trial cell with a different evidence path — suggestive, not established, and explicitly **not**
acted on here.

t3 is the best answer any of these four experiments produced. It reached R2, cited the figure,
declined R3, *and* declined the unstated half of R2 — that a Coinbase withdrawal is not proof of a
Coinbase **sale**. No instruction produced that.

### 2.5 Cost

**Unmeasured**, for the reason established in 55a2c22 §3.5: the harness calls the OpenAI SDK directly
and never reaches `lib/ai/provider.ts`, so no `AiInvocation` row is written. Hops (2.4 avg) and
latency (9.1 s avg) are the only efficiency figures.

---

## 3. Interpretation

Four experiments, 50 trials, one mechanism:

```
ACTIVE FINANCIAL FRAME  →  TEMPORAL TOOL ARGUMENT BINDING  →  SEARCH POPULATION  →  EVIDENCE FOUND / MISSED
```

| frame in context | window the model used | Feb-27 found |
|---|---|---|
| `recent.window` = 90 days | that 90 days, 26/28 calls, tracking its daily drift | 0/20 |
| a conversation about January | January | 0/10 |
| an adjacent range framing nothing | ignored entirely, 0/12 | 0/5 |
| **`recent.window` = 220 days** | **that 220 days, 8/8 calls** | **5/5** |

Every earlier hypothesis is now closed by measurement:

- **Retrieval willingness** — never the defect. The tool was called in 15/20, 17/20, 5/5, 5/5.
- **The stopping clause** — no effect on retrieval (5/5 vs 5/5 in bb2f6ec).
- **Anchor copying of any salient range** — falsified; an adjacent structural twin exerted zero pull.
- **A 90-day or recency bias** — falsified; the model used 220 days the moment the frame said 220,
  and January when the conversation said January.
- **The information ceiling in the tool result** — real, fixed in 55a2c22, and **not** what governs
  the window: `windowCoversAvailableRecord: false` was reported on all 8 calls here and on all 27
  calls there, and produced no widening in either.

What remains is a single, simple statement: **the model binds date parameters to the temporal frame
the orientation establishes, and does not question that frame.** It never generated an independent
question-relevant window in 50 trials — not once, in either direction. The frame is not an influence
on the search; within this evidence it *is* the search.

The corollary matters for anything built next: **the orientation's window silently determines what
the model can discover.** A 90-day frame does not merely bias retrieval toward recent evidence; it
makes older evidence effectively unreachable, and — before 55a2c22 — made the model confident it did
not exist.

---

## 4. Smallest product intervention — recommended, not implemented

### 4.1 The constraint that shapes everything

`recent.window` comes from `thinCore()` (`scripts/ai-baseline/evidence.ts:129`) ← the
`TRANSACTIONS_SUMMARY` assembler's `ASSESSMENT_WINDOW_DAYS = 90`
(`lib/ai/assemblers/transactions.ts:232`).

**That constant cannot be broadened to fix retrieval.** W4's own doctrine records what happens when
the assessment window varies: on this live corpus a 30-day window graded `deficitCause`
`NOT_APPLICABLE` against a deficit under 90, reported `estimatedMonthlyExpenses` null, and moved
`impliedMonthlyIncome` by ~3%. `computeAssessment`'s thresholds and fixtures are calibrated to 90
days. Widening it to 220 would change **what the product concludes about the user's finances** in
order to change what the model searches — trading a truth defect for a retrieval fix. Not
acceptable, and not proposed.

Note also that this experiment did not merely widen a window: it recomputed five figures. Any real
intervention faces the same coupling. **The window and the figures travel together, and only the
figures are load-bearing for assessment.**

### 4.2 The recommendation

**Separate the two jobs `recent` is currently doing, inside `recent`, without moving the assessment
window.** One added field, no figure changes, no assessment change:

```jsonc
"recent": {
  "window": { "from": "2026-06-11", "to": "2026-09-08", "days": 90 },   // UNCHANGED — computeAssessment's
  "income": 32704.32, "spending": 12342.56, …                           // UNCHANGED — measured over it
  "activityAvailable": { "from": "2024-07-18", "to": "2026-09-08" }     // NEW — the transaction record's own span
}
```

`recent.window` keeps its exact present meaning: *the period these five figures are measured over*.
`activityAvailable` states a different, equally true fact: *the period there is transaction activity
to ask about*. It is the same value `get_transactions.coverage` already returns, sourced from the
same authority (`transactionCorpusSpan`), lifted to the one place the model demonstrably reads
temporal frames from.

**Why this and not the alternatives:**

- **Not broadening `ASSESSMENT_WINDOW_DAYS`** — §4.1.
- **Not a second top-level date field.** 70ac794 measured that directly: an adjacent range that
  framed nothing attracted 0/12 calls. Position is not the lever; *being part of the financial
  frame* is. That is why this belongs inside `recent`.
- **Not the tool result.** 55a2c22 already put the corpus span there. It changed what the model
  **says** (confident negatives 11/18 → 5/19) and nothing about what it **searches** (0/20 widened,
  0/27 calls affected). The frame is read **before** the first call; the tool result arrives after
  the window has been chosen.
- **Not automatic widening, a default window, mandatory unwindowed search, routing, a causal
  taxonomy, or date-selection code.** The model chooses its window correctly the moment the frame is
  correct. Nothing needs to be taken away from it.

### 4.3 This recommendation is a hypothesis, and it is cheap to test

I have measured that the model binds to `recent.window`. I have **not** measured that it will bind to
a sibling field inside `recent` that is not the window the figures are measured over. The honest
prediction is uncertain in a specific way: the model may keep using `window` (the figures' period)
and ignore `activityAvailable` exactly as it ignored `evidenceCoverage.span` — which has sat in the
orientation, true and unused, through all 50 trials.

**Validate before building: 5 trials, the shipped 90-day `recent` plus the one added field, the same
question.** If the first `get_transactions` window reaches back past February, the intervention works
and costs one field. If it does not, the surviving hypothesis is narrower and specific — *the model
binds to the window its figures are measured over, and to nothing else* — in which case the frame and
the assessment cannot be separated inside `recent`, and the question becomes a product one: whether
the orientation should carry a second, longer activity frame **with its own truthful figures**,
alongside the 90-day assessment. That is a context-composition decision with a real token cost and a
real "which number does the user mean" cost, and it should be taken deliberately rather than as a
retrieval fix.

### 4.4 Not this slice, and now better understood

The **R2→R3 calibration defect** is the only reasoning defect left standing, and §2.4 has changed its
shape: 4/5 stayed at R2 with explicit refusals when the model assembled its own evidence, against
5/5 R3 when same-day payments were pre-loaded. Before anything is written for it, that difference
should be measured deliberately — because if juxtaposition is doing the work, the intervention is
about **how evidence is composed**, not about a confidence instruction.

---

## 5. Threats

- **n = 5.** The 5/5 and 8/8 figures are unambiguous at this n. The R2/R3 comparison in §2.4 is 5
  trials against 5 trials with a different evidence path, and is presented as an observation.
- **One frame, one direction.** 220 days was tested; a shorter frame, or one that excludes February
  while a conversation points at it, was not.
- **The frame change moved six things** — the window and five figures — because truthfulness required
  it. The window is the plausible active ingredient, but this design cannot isolate it from the
  figures, and §4.1 notes any real intervention inherits the same coupling.
- **Register classification is by reading**, per trial, quoted in §2.4 so it can be audited. The
  mechanical markers (windows, rows returned, amount citation) are asserted on tool results.
- **Cost unmeasured** (§2.5).
- Runs are hours apart against the same model string; provider drift is uncontrolled.

---

## 6. What this experiment changed

**No repository code.** The alternate frame and harness are in gitignored `tmp/causal/`.
`ASSESSMENT_WINDOW_DAYS`, `recent.window`, the system prompt, the tool schemas and descriptions, and
`get_transactions` coverage are all untouched. This document is the only artefact, and no fix was
implemented.
