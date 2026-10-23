# `recent.activityAvailable` — the metadata-placement probe

**Date:** 2026-09-09 · **Model:** `gpt-5.1` · **Arm:** A2, standalone cell-A condition · **Space:**
`cmrrm846r000j7znwsl67gt1g` · **as-of:** 2026-09-08 · 5 trials

Authority: 658cfd2, bb2f6ec, 55a2c22, 70ac794, a774989.

**Experiment only. No repository code changed** — the added field lives in the gitignored harness.
`ASSESSMENT_WINDOW_DAYS` untouched.

> ## Verdict: **FAILED.** Stop condition invoked.
>
> **11 of 11 `get_transactions` calls used the 90-day assessment window. 0/5 used
> `activityAvailable`. 0/5 switched to it on a later call. Feb-27 retrieval 0/5, citation 0/5,
> widening 0/5.** No answer mentioned the availability span, or 2024, at all.
>
> Semantic placement inside the active financial frame is **not** sufficient. The surviving
> hypothesis is the narrow one the brief names: **GPT-5.1 binds date-bearing retrieval to the window
> over which the salient financial figures are themselves measured.** The remaining problem is not a
> missing coverage field. It is context composition.

---

## 1. Exact experimental context diff

One key appended inside `recent`, sourced from `transactionCorpusSpan` — the same authority
`get_transactions.coverage` uses, under the same information ceiling. Nothing hard-coded.

```diff
  "recent": {
   "window": { "from": "2026-06-11", "to": "2026-09-08", "days": 90 },
   "income": 32704.32,
   "spending": 12342.56,
   "cardAndDebtPayments": 23953.92,
   "netCashFlow": 20378.08,
   "transactionCount": 428,
+  "activityAvailable": { "from": "2024-07-18", "to": "2026-09-08" }
  },
```

Verified before running:

- top-level key order identical;
- **everything outside `recent` byte-identical**;
- **`recent` identical except the one appended key** — same window, same five figures, same order;
- `activityAvailable` spans `2026-02-27`.

No prose explaining which field to use. No mention of Coinbase, February, widening, historical
search, causal evidence, or any tool. Model, system instruction, unknown/unknowable clause, tool
descriptions, `get_transactions` schema and coverage, `evidenceCoverage`, compaction and model
settings all unchanged. Question verbatim: *"Do you think I sold crypto to pay off some of that
debt?"*

---

## 2. The five trials

| | first frame class | first `get_transactions` window | gt calls | hops | latency | switched later | widened | Feb-27 | cites | register |
|---|---|---|---|---|---|---|---|---|---|---|
| **t1** | `FRAME_ASSESSMENT` | `2026-06-11..2026-09-08` transfers text=crypto | 3 | 2 | 7.8 s | no | no | 0 | 0/2 | R0 hedged |
| **t2** | `FRAME_ASSESSMENT` | `2026-06-11..2026-09-08` transfers | 2 | 2 | 7.4 s | no | no | 0 | 0/2 | **R0 asserted** |
| **t3** | `FRAME_ASSESSMENT` | `2026-06-11..2026-09-08` transfers | 1 | 2 | 5.8 s | no | no | 0 | 0/2 | R0 hedged |
| **t4** | `FRAME_ASSESSMENT` | `2026-06-11..2026-09-08` transfers text=coinbase | 3 | 2 | 6.3 s | no | no | 0 | 0/2 | **R0 asserted** |
| **t5** | `FRAME_ASSESSMENT` | `2026-06-11..2026-09-08` transfers | 2 | 2 | 6.5 s | no | no | 0 | 0/2 | R0 hedged |
| | **5/5 FRAME_ASSESSMENT** | | 11 | 2.0 | 6.8 s | **0/5** | **0/5** | **0/5** | **0/5** | hedged 3 · asserted 2 |

`FRAME_ACTIVITY_AVAILABLE` **0/5**. `GENERATED_OTHER` 0/5. `UNWINDOWED` 0/5. `NO_TRANSACTION_CALL`
0/5.

### 2.1 Every `get_transactions` call

| trial | class | from | to | text | flow | sort | limit | shown | `covers` |
|---|---|---|---|---|---|---|---|---|---|
| t1 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | crypto | transfers | — | 50 | 0 | false |
| t1 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | card_payments | — | 50 | 45 | false |
| t1 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | coinbase | income | — | 50 | 0 | false |
| t2 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | transfers | — | 50 | 15 | false |
| t2 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | card_payments | — | 50 | 45 | false |
| t3 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | transfers | — | 50 | 15 | false |
| t4 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | coinbase | transfers | — | 50 | 0 | false |
| t4 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | card_payments | — | 50 | 45 | false |
| t4 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | kraken | transfers | — | 50 | 0 | false |
| t5 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | transfers | — | — | 15 | false |
| t5 | `FRAME_ASSESSMENT` | 2026-06-11 | 2026-09-08 | — | card_payments | — | — | 15 | false |

**11 calls. 11 identical windows.** `get_spending({from: "2026-06-11", to: "2026-09-08"})` in t1, t2,
t3, t5 — 4/4. `get_investments({asOf: "2026-06-11"})` in t2 — `recent.window.from` pasted into a
portfolio valuation date again, exactly as 70ac794 recorded.

t1 and t4 are the sharpest specimens: they searched `text: 'coinbase'` and `text: 'kraken'`, got
zero rows, received `windowCoversAvailableRecord: false` alongside a note saying the record runs
`2024-07-18..2026-09-08` — the same span sitting in the orientation as `activityAvailable` — and
searched the same 90 days again with a different keyword. **The boundary was stated twice, in two
places, and the window did not move.**

### 2.2 Did the model distinguish the two periods?

**Never explicitly.** No answer refers to `activityAvailable`, to 2024, or to a period longer than
the window. Two of five scope their negative and gesture past it, at the same rate as every prior
run and in the same terms 55a2c22 produced:

- **t3** — *"it's possible you sold some crypto **earlier than this window**… based on the data I
  have **for 2026-06-11 to 2026-09-08**, I would not conclude that you sold crypto"*
- **t4** — *"If you want, **we can widen the window** (e.g., last 6–12 months)"*

t4 proposes six to twelve months while holding a field that says twenty-six, and asks rather than
acting. The field was not read as an instrument.

### 2.3 Register — unchanged

**R0 hedged 3 · R0 asserted 2 · R1↑ 0 · R2 0 · R3 0** — identical to run-2 cell A (55a2c22) and to
the anchor probe (70ac794). The corpus-span improvement holds; nothing here degraded or improved it.

Per the brief, no calibration doctrine is drawn from this cell: with 0/5 retrieval there is no R2/R3
observation to make. The a774989 R2 4/5 vs calibration R3 5/5 discrepancy stands where it was.

### 2.4 Cost

**Unmeasured** — 55a2c22 §3.5: the harness calls the OpenAI SDK directly and never reaches
`lib/ai/provider.ts`. Hops 2.0 avg, latency 6.8 s avg.

---

## 3. Did `activityAvailable` change behaviour?

**No, on every measure.** 0/11 calls, 0/5 first calls, 0/5 later switches, 0/5 mentions, 0/5 Feb-27
rows, 0/5 citations, 0/5 widenings. The probe is a clean negative — and a *useful* one, because it
pairs with a774989 to isolate the mechanism to a single difference.

| what was placed in context | where | figures measured over it? | window followed | Feb-27 |
|---|---|---|---|---|
| `recent.window` = 90 days | inside `recent` | **yes** | **26/28, 12/12, 11/11** | 0/20, 0/5, 0/5 |
| `recent.window` = 220 days (a774989) | inside `recent` | **yes** | **8/8** | **5/5** |
| `interface.lastViewedRange` (70ac794) | adjacent top-level | no | 0/12 | 0/5 |
| `get_transactions.coverage` (55a2c22) | tool result, every call | no | 0/27 | 0/20 |
| **`recent.activityAvailable`** (here) | **inside `recent`** | **no** | **0/11** | **0/5** |

Three availability statements have now been ignored — one in the tool result, one adjacent, one
**inside the active frame itself**. One measured frame was followed instantly and completely. The
only property that has ever moved the window is **being the period the salient financial figures are
measured over.**

Placement is not the lever. Naming is not the lever. Semantic proximity is not the lever. The brief's
FAILURE reading is exactly right, and it is now supported by a designed contrast rather than by
absence of evidence.

**One boundary this probe does not settle**, and it matters for §4: it cannot separate *"a frame must
carry measured figures to be bindable"* from *"the key literally named `window` is privileged"*. Both
predict everything observed across the five experiments. Only a second frame **with its own figures**
distinguishes them.

---

## 4. Stop condition — invoked

Per the brief, and I am proposing none of these: no renamed availability field, no relocation of the
same field, no additional coverage note, no stronger tool description, no retrieval-disposition
language, no automatic widening, no router, no intent taxonomy, and no broadening of
`ASSESSMENT_WINDOW_DAYS`.

The retrieval question is answered as far as metadata can answer it. **Five experiments, 55 trials,
one mechanism, now bounded on both sides:**

> The model binds date-bearing tool parameters to the window over which the orientation's financial
> figures are measured. Give it a truthful 220-day frame and it finds the evidence on the first call,
> 5/5. Tell it — anywhere, in any words — that more history exists without measuring anything over
> it, and nothing changes, 0/28.

### 4.1 The next decision is context composition, not retrieval

The question is no longer *"how do we tell the model the record is longer?"* It is:

> **Should the orientation carry a second truthful financial frame, measured over a longer period,
> alongside the 90-day assessment frame — and if so, what does it measure and what does it cost?**

That is a product decision with real costs on both sides, and it should be taken deliberately rather
than as a retrieval fix. Laying out what is actually known:

**What a second measured frame would have to be.** Not a date range. A window plus its own figures,
produced by the same `TRANSACTIONS_SUMMARY` authority — which is exactly what a774989 built and what
made the window move. `ASSESSMENT_WINDOW_DAYS` and `computeAssessment` would be untouched; the
90-day frame stays the assessment, and the longer frame is a second, separately-labelled
measurement.

**What it would cost.**
- *Tokens:* one more figure block per turn. Small, and 55a2c22 measured the harness at ~2–3 hops per
  turn, so the marginal cost is modest — but it is per-turn, forever.
- *Ambiguity:* two truthful "spending" numbers in one orientation, differing by 4× (12,342.56 over 90
  days vs 49,711.34 over 220). Every downstream sentence the model writes must pick one, and
  a774989's answers show it *does* narrate whichever frame it was given (*"$78k of card/debt payments
  in 220 days"*). Two frames means two candidate answers to *"how much do I spend?"* — a real
  regression risk that this series has not measured.
- *Which period:* 220 days was chosen to contain a known event. A product cannot choose a window by
  knowing the answer in advance. The natural candidates are calendar-anchored (12 months, YTD), and
  their cost is that they are still finite — a 12-month frame moves the wall to 2025 rather than
  removing it.

**The alternative composition strategy worth weighing against it.** The orientation could carry the
assessment frame alone and let the *conversation* establish a longer frame when a question needs one
— which is precisely what cells C and D already demonstrate: with a preamble about January, every
window became January. The model follows a conversational frame as readily as a context frame. That
would make historical investigation a **two-turn** interaction rather than a one-turn one, at zero
token cost and zero ambiguity cost, and the open question is whether that is acceptable product
behaviour or a failure to answer the question asked.

**Before either is chosen, the cheapest thing that would inform the choice** is the discriminator
§3 names: does a second frame *with figures* get bound, or is the key named `window` privileged? That
is 5 trials and it decides whether "a second measured frame" is even an available design. I am not
running it without direction, because it is the first experiment in this series whose result feeds a
product decision rather than a diagnosis.

### 4.2 The reasoning defect that outlives all of this

**R2→R3 calibration** remains the only unresolved reasoning defect, and a774989 sharpened rather than
settled it: R2 4/5 when the model assembled its own evidence and mostly missed the same-day payments,
against R3 5/5 when those payments were pre-loaded beside the inflows. Whether juxtaposition or
disposition drives the overclaim is untested, and — as the brief directs — no doctrine is drawn from
these 5-trial cells.

---

## 5. Threats

- **n = 5.** 0/11 and 5/5-classification are unambiguous at this n. Nothing else here is claimed.
- **One field name, one position.** `activityAvailable` was appended last inside `recent`. A
  different name or ordinal position is exactly what the stop condition forbids chasing, and §3's
  contrast table is why: three placements have now failed and only the measured frame has succeeded.
- **The a774989 contrast moved six things** (window + five figures) where this probe moved one, so
  "measured figures" is the *plausible* active ingredient, not an isolated one. §3 states the
  alternative it cannot exclude.
- **Register classification is by reading**, per trial, quoted in §2.2–2.3.
- **Cost unmeasured** (§2.4). Runs hours apart against the same model string.

---

## 6. What this probe changed

**No repository code.** The added field and harness are in gitignored `tmp/causal/`.
`ASSESSMENT_WINDOW_DAYS`, `recent`, the system prompt, tool schemas and descriptions,
`get_transactions` coverage and `evidenceCoverage` are all untouched. This document is the only
artefact; nothing was implemented.
