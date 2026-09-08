# Corpus-span authority on `get_transactions` — implementation + 2×2 rerun

**Date:** 2026-09-09 · **Model:** `gpt-5.1` · **Arm:** A2 · **Space:** `cmrrm846r000j7znwsl67gt1g`
· **as-of:** 2026-09-08 · Baseline experiment: **bb2f6ec**

Implementation and measurement. The intervention is the smallest one the causal-evidence experiment
justified: **a result that declares the boundary of its own authority.** Nothing else changed — no
prompt, no tool description, no model configuration, no compaction, no other tool.

**Headline: the hypothesis is falsified as stated, and half-confirmed as it matters.**
Corpus-span metadata did **not** cause the model to widen its search (0/20) and Feb-27 evidence
retrieval stayed at **0/20**. It did change what the model *says* about a windowed miss:
confident absence claims fell from **11/18 → 5/19** of negatives, and explicit acknowledgement that
the record extends past the searched window rose from **2/20 → 6/20**.

---

## 1. Implementation

Three files, 258 insertions, no behavioural change to which rows are read.

| File | Change |
|---|---|
| `lib/data/transaction-query-core.ts` | `TransactionCorpusBounds`, `TransactionCoverage`, and the **pure** `transactionCoverage()` shaping function (+73) |
| `lib/data/transaction-query.ts` | `transactionCorpusSpan()` — the DB authority, composing the same population the pager does (+70, incl. doctrine) |
| `scripts/ai-baseline/tools.ts` | `get_transactions` composes the two and returns `coverage` beside `window` (+27, mostly comment) |

### 1.1 The returned shape

```jsonc
{
  "window":   { "from": "2026-06-10", "to": "2026-09-08" },     // evidence SEARCHED
  "coverage": {                                                  // evidence there WAS to search
    "transactionsAvailableFrom": "2024-07-18",
    "transactionsAvailableTo":   "2026-09-08",
    "windowCoversAvailableRecord": false,
    "note": "Searched 2026-06-10..2026-09-08. Transactions are available from 2024-07-18 to
             2026-09-08; rows outside the searched window were not read, so an empty or short
             result describes this window only, not the whole available record."
  },
  "shown": 0, "rows": []
}
```

`coverage` is the codebase's own idiom, not a new one — `get_financial_snapshot` and
`get_net_worth_history` already return `coverage.historyAvailableFrom` / `historyAvailableTo`, and
`PositionCoverage` persists the same statement for wallets. `get_transactions` was the one read
surface that did not declare its boundary, which is why it was the one that produced a confident
false negative.

`note` appears **only** when the window is partial. A search that covers the record carries no note
— there is nothing to qualify.

### 1.2 The corpus authority, exactly

```ts
const agg = await db.transaction.aggregate({
  where: { AND: [
    bankingTransactionWhere(args.spaceId),                       // ← the ONE population authority
    { economicDate: { not: null, ...(ceiling ? { lte: ceiling } : {}) } },
  ]},
  _min: { economicDate: true }, _max: { economicDate: true },
});
```

- **Population:** `bankingTransactionWhere(spaceId)` — the same FlowType population, KD-15
  transaction-detail visibility and soft-delete predicate `queryTransactions` itself composes. Not a
  second population path.
- **Column:** `economicDate` — the L8-B chronology, the column `orderByForSort` orders on. Rows with
  a null `economicDate` cannot be placed in time and are excluded, the same rows the keyset already
  refuses to page.
- **Ceiling:** `asOf` bounds the max. **This is load-bearing.** Without it a retrospective read at
  `asOf: 2026-01-01` would learn from the metadata that transactions exist into September — leaking
  through the back door the date filter closes at the front. Verified live: at `asOf: 2026-01-01`
  the reported span ends `2026-01-01`.
- **Never derived from:** the requested window, `recent.window`, the returned rows, any filter
  (`text` / `flow` / `category`), or a hard-coded date. Four separate source-scan tripwires pin each.
- **When it cannot be established:** both ends stay `null` with an `unavailableReason`. No
  substitution, ever.

### 1.3 What deliberately did NOT change

- **No default window.** `dateFrom` is still applied only when the model supplies `from` — pinned.
- **Explicit windows still honoured**; nothing is widened; nothing is re-queried. The tool still
  issues exactly one read path per call.
- **`rankingIsComplete` keeps its own, narrower meaning** — every row matching these filters *inside
  the window* was read and ranked. It is not fused with `coverage`, and a test asserts both that
  `rankingIsComplete: true` coexists with `windowCoversAvailableRecord: false` and that neither is
  computed from the other.
- **The tool description was not touched.** The brief permits a description change to describe the
  new field; it was not required, and changing it would have made the rerun measure two variables
  instead of one. A tripwire pins the description free of the words `coverage` / `corpus` /
  `available record`.
- No system prompt, retrieval-disposition instruction, unknown/unknowable clause, model
  configuration, compaction, reasoning architecture, production route, or other financial tool.

### 1.4 Consumers

`get_transactions` results are consumed by the model, not by typed code — `tsc --noEmit` is clean
outside gitignored `prototype/`. The one existing source-scan on the result shape
(`baseline.test.ts` 13f, *"get_transactions names its instant"*) still passes unmodified. Two
pre-existing "no aggregates" tripwires in `transaction-query.test.ts` had to be **scoped to the
row-query region** rather than the whole file, because the corpus span is an aggregate in the same
file: they were scoped, not relaxed, and a new assertion pins that the bounds read carries no
`_sum` / `_count` / `groupBy` of its own.

---

## 2. Tests — the ten required proofs

**`lib/data/transaction-corpus-coverage.test.ts`** (new, pure, in CI) and additions to
`lib/data/transaction-query.test.ts` and `scripts/ai-baseline/baseline.test.ts`; plus
**`scripts/ai-baseline/transaction-corpus.check.ts`** (`npm run ai:corpus-check`), which needs a
database and so sits outside the DB-free suite, following the `memory-store.check.ts` precedent.

| # | Required | Where | Result |
|---|---|---|---|
| 1 | Unwindowed result reports the full span | pure §1 + live §1 | ✅ live: `2024-07-18..2026-09-08`, 18 Coinbase rows |
| 2 | Windowed result reports window and span independently | pure §2 + live §2 | ✅ span identical across four different windows |
| 3 | Empty windowed result still reports the span | pure §3 + live §2 | ✅ `shown: 0`, span unchanged, note present |
| 4 | `rankingIsComplete: true` does not imply corpus completeness | pure §4 + live §2 | ✅ both coexist; neither derived from the other |
| 5 | A window wholly inside the record stays visibly partial | pure §5 | ✅ 4 windows incl. off-by-one-day at each end |
| 6 | A window covering the record is recognizable | pure §6 + live §5 | ✅ `windowCoversAvailableRecord: true`, inclusive both ends |
| 7 | Filters do not shrink the span to matching rows | pure §7 + live §3 | ✅ signature admits only window+corpus; `text`/`flow`/`category` cannot reach it |
| 8 | Ranking/pagination behaviour unchanged | `baseline.test.ts` 13g + §14 | ✅ no default window, no widening, no re-query, same read paths |
| 9 | No transaction values or rows altered | 13g + read-only surface | ✅ corpus read returns no rows; adapter has no Prisma client and no write verb |
| 10 | Consumers compatible or minimally updated | §1.4 | ✅ no consumer type changed; two tripwires scoped, none relaxed |

Plus, beyond the minimum: the information ceiling bounds the span (live §4), and unavailable bounds
are represented rather than fabricated (pure §8).

```
npm run test        →  500/500 passed   (baseline 499 + 1 new file)
npm run ai:corpus-check →  ALL PASSED   (18 live assertions)
```

---

## 3. The rerun — before → after

Identical harness, model, questions, preamble, instruction conditions, 5 trials per cell, markers
and classification scheme. The corpus-span field is the only variable.

**All 27 `get_transactions` calls on the measured turns carried `coverage`. All 27 supplied a
`from`. None omitted it.** (Run 1: 28 calls, 28 with `from`, 0 carrying coverage.)

### 3.1 Compact matrix

| | **A** | **B** | **C** | **D** | **total** |
|---|---|---|---|---|---|
| **Transaction retrieval** (measured turn) | 5/5 → **4/5** | 5/5 → **5/5** | 3/5 → **3/5** | 2/5 → **5/5** | 15/20 → **17/20** |
| **First search empty** | 4/5 → **2/5** | 0/5 → **0/5** | 2/5 → **1/5** | 0/5 → **2/5** | 6/20 → **5/20** |
| **Recognized the window was partial** (prose) | 1/5 → **2/5** | 1/5 → **3/5** | 0/5 → **0/5** | 0/5 → **1/5** | **2/20 → 6/20** |
| **Widened / retried the search** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | **0/20 → 0/20** |
| **Ran a covering search** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | **0/20 → 0/20** |
| **Feb-27 Coinbase evidence returned** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | **0/20 → 0/20** |
| **Cited $8,141.98 / $1,902.12 / $10,044.10** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | **0/20 → 0/20** |
| **Same-day card-payment evidence retrieved** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | 0/5 → **0/5** | **0/20 → 0/20** |
| **R0 hedged** | 2 → **3** | 3 → **5** | 1 → **3** | 1 → **3** | 7 → **14** |
| **R0 asserted** | 3 → **2** | 2 → **0** | 4 → **1** | 2 → **2** | **11 → 5** |
| **R1↑** (affirmative, balance evidence only) | 0 → **0** | 0 → **0** | 0 → **1** | 2 → **0** | 2 → **1** |
| **R2** *"transactions show"* | 0 → **0** | 0 → **0** | 0 → **0** | 0 → **0** | **0 → 0** |
| **R3** *"X caused Y"* | 0 → **0** | 0 → **0** | 0 → **0** | 0 → **0** | **0 → 0** |
| avg tool calls (measured turn) | 5.2 → **3.4** | 2.4 → **2.4** | 2.6 → **2.8** | 2.8 → **2.4** | 3.3 → **2.8** |
| avg model hops | 3.8 → **2.4** | 2.6 → **2.6** | 3.4 → **2.6** | 2.8 → **3.0** | 3.2 → **2.7** |
| avg latency (measured turn) | 9.3 s → **7.8 s** | 6.4 s → **6.7 s** | 8.5 s → **7.6 s** | 9.3 s → **8.2 s** | 8.4 s → **7.6 s** |
| **cost** | — | — | — | — | **not measured, §3.5** |

*Registers use bb2f6ec's scheme verbatim: **R0 hedged** = negative explicitly scoped to the window
or the data; **R0 asserted** = a flat negative conclusion, or an alternative causal account stated
as fact; **R1↑** = affirmative above the strength balance-series evidence licenses; **R2** =
"transactions show"; **R3** = "X caused Y". Classification is by reading, per trial, listed in §3.4
so it is auditable.*

### 3.2 The windows chosen — after

| Cell | windows on the measured turn |
|---|---|
| **A** | `2026-06-10..2026-09-08` × 6, `2026-06-11..2026-09-08` × 1 — still the thin core's `recent.window` |
| **B** | `2026-06-10..2026-09-08` × 7, `2026-06-11..2026-09-08` × 1 |
| **C** | `2025-12-20..2026-02-10`, `2025-12-15..2026-01-31`, `2025-12-15..2026-02-15` |
| **D** | `2026-01-01..2026-02-15`, `2026-01-01..2026-01-31` × 4, `2025-12-15..2026-02-15` × 3 |

Unchanged in character. `windowCoversAvailableRecord` was **false on all 27 calls**, and not one
provoked a wider call.

### 3.3 What the note actually changed — verbatim

Six answers referred to evidence outside the searched window, against two before. Every one was
read and confirmed in context, not matched on a token:

| | |
|---|---|
| **A t1** | *"If you think you might have sold crypto **earlier than June 10**, I can go farther back and check that specifically."* |
| **A t5** | *"It's possible you did it earlier or via a platform whose cash-out isn't **in this 90-day slice**."* |
| **B t1** | *"Look **earlier than June 11** if you think you might have sold crypto just before this 90-day window."* |
| **B t2** | *"**This only covers the last 90 days. You could have sold crypto earlier than that.**"* + *"Widen the window (e.g., last 6–12 months)"* |
| **B t3** | *"You might have sold crypto **earlier than June 10** … if you want, **we can widen the date range**."* |
| **D t4** | *"If you did sell some crypto, it looks small and/or **earlier/later than January** … I can look over a **longer window** (say Nov–Mar)."* |

Run 1's two, for comparison, are weaker in kind: A t4 *"if you **remember** selling crypto earlier"*
(contingent on the user's memory, not on a record) and B t3 *"a slightly longer window"* (no
statement that one exists).

**Note the shape of the improvement: the model offers to widen and stops.** Not one of the six acted
on its own offer inside the turn. It treats the corpus span as something to report to the user and
ask about, not as a reason to issue a second call.

### 3.4 Register classification, per trial

| | run 1 (bb2f6ec) | run 2 (corpus span) |
|---|---|---|
| **A** | hedged t1 t2 · asserted t3 t4 t5 | hedged t2 t3 t4 · asserted t1 t5 |
| **B** | hedged t1 t3 t4 · asserted t2 t5 | **hedged t1 t2 t3 t4 t5** |
| **C** | hedged t2 · asserted t1 t3 t4 t5 | hedged t1 t4 t5 · asserted t3 · **R1↑ t2** |
| **D** | hedged t5 · asserted t2 t4 · R1↑ t1 t3 | hedged t3 t4 t5 · asserted t1 t2 |

The two strongest false negatives in run 1 have no counterpart in run 2. Gone: *"I searched
transfers for 'coinbase', 'binance', 'kraken', and 'crypto' and found **no matches**"* (A t1) and
*"You **almost certainly did not** sell much (if any) crypto"* (D t4). Their nearest run-2
equivalents are *"no transfers to or from major crypto ramps **in the transactions I checked**"*
(B t3) and *"I don't see direct evidence … it looks small and/or earlier/later than January"* (D t4).

The five asserted negatives that remain (A t1, A t5, C t3, D t1, D t2) all assert an **alternative
causal account** — *"points more to market moves"*, *"paychecks + normal cash flow"* — rather than
claiming a search found nothing. That is a different and weaker error than the one this slice
targeted, and it is the same R2→R3 habit pointed the other way: a conclusion stated at a strength
the evidence in hand does not license.

### 3.5 Cost — not measured, and the earlier explanation was wrong

`AiInvocation` recorded **0 rows** for this rerun too, including after a deliberate 6-second flush
before disconnect. The flush proved the bb2f6ec report's stated cause wrong: the experiment harness
calls the **OpenAI SDK directly** (`client.chat.completions.create`) and never reaches
`lib/ai/provider.ts`, so the Slice-3 chokepoint — and `recordOpenAiUsage` with it — is never
invoked. `runWithAiInvocationContext` was setting a context nothing consumed.

Per-trial dollar cost is therefore **not measured** for either run, and no estimate is offered in
the matrix. Hops and latency carry the relative comparison faithfully: the rerun is **cheaper**
(3.2 → 2.7 avg hops, 8.4 s → 7.6 s), driven almost entirely by cell A, where the run-1 pattern of
four sequential keyword re-searches of the same empty window appeared once instead of twice.

The correction to bb2f6ec §6 is recorded in §6 below.

---

## 4. Answers

### 1. Does corpus-span metadata cause GPT-5.1 to recognize a windowed negative as partial evidence?

**Partly — in the prose, in a minority of trials.** Explicit acknowledgement that the record extends
past the searched window went **2/20 → 6/20**, and five of the six are in cells A and B, where the
90-day window sat inside a 26-month record and the note said so in as many words. Two answers quote
the boundary date back (*"earlier than June 10"*, *"earlier than June 11"*), which is only derivable
from the metadata.

But 14/20 read a `windowCoversAvailableRecord: false` and a note saying the result *"describes this
window only, not the whole available record"* and still wrote their answer as if the window were the
record. **Telling the model the boundary is not the same as the model treating the boundary as
actionable.**

### 2. Does it autonomously widen or remove the window after recognizing that?

**No. 0/20, in every cell.** Not one trial issued a second, wider `get_transactions` call; not one
dropped `from`; not one ran a search that covered the record. Three trials *offered* to
(*"we can widen the date range"*, *"I can go farther back"*, *"I can look over a longer window"*) and
then ended the turn awaiting permission.

This is the sharpest result in the rerun. The model treats a partial window as something to
**disclose and ask about**, not as a gap to close itself — even holding a tool call that would close
it and a result stating the range that would work.

### 3. Does Feb-27 evidence retrieval improve from 0/20?

**No. 0/20 → 0/20.** No Coinbase row from 2026-02-27 was returned in any trial, no answer cited
$8,141.98, $1,902.12 or $10,044.10, and no same-day card-payment evidence was retrieved. The
information-ceiling defect was real and is now closed; **it was not the whole retrieval defect.**

### 4. Does inherited aggregate context still suppress transaction retrieval?

**Not in this run, and the run-1 effect no longer looks stable.** Measured-turn retrieval:

| | run 1 | run 2 |
|---|---|---|
| no preamble (A+B) | 10/10 | **9/10** |
| with preamble (C+D) | 5/10 | **8/10** |

D moved 2/5 → 5/5, which is what closed the gap. At n=5 per cell that is not a finding, and I will
not present it as one. What survives across both runs is the **directional** half, which is
unambiguous and unchanged: with a preamble the model searches **January**; without one it searches
the thin core's 90-day window. Both are the wrong place. The lens redirects the window even when it
does not suppress the call.

### 5. Does the qualified unknown/unknowable clause add anything once the evidence boundary is truthful?

**Its only measurable effect is on the register, and it is now the cleanest cell in the run.** B is
**5/5 hedged, 0/5 asserted** — the only cell with no confident negative at all — against 3/5 hedged
in run 1. B also produced 3 of the 6 partial-window acknowledgements.

That is suggestive, not established: A vs B is a 2-vs-0 difference in asserted negatives at n=5, and
the clause changed retrieval in neither run (5/5 both times, 0/5 evidence both times). It remains
cheaper (2.4 calls vs A's 3.4). **No prompt change is being proposed on this evidence**, per the
brief; it is worth a dedicated measurement with a larger n if the register defect is ever taken up.

### 6. Does the prior 11/18 confident-negative behavior disappear or materially improve?

**Materially improves; does not disappear.** Asserted negatives fell from **11/18 (61%) to 5/19
(26%)** of negative answers, and the two most dangerous specimens have no counterpart in the rerun.
Hedged negatives more than doubled, 7 → 14.

This is the one thing the intervention was most directly aimed at, and it moved. It is worth being
precise about *why*: the note gives the model a truthful sentence to write. *"In the transactions I
checked"* and *"this only covers the last 90 days"* are cheap to say once the result says them
first. What it does not do is make the model go and check.

And the five remaining asserted negatives are a **different error** — asserting *"paychecks and
normal cash flow"* as the explanation rather than asserting a search came back empty. Closing the
information ceiling converted an over-claimed absence into an over-claimed alternative.

### 7. Does the model reach R2 once it actually retrieves the event evidence?

**Unchanged and untested by this rerun: R2 = 0/20, because retrieval is still 0/20.** The
calibration phase from bb2f6ec remains the only evidence on this, and it was not re-run (nothing in
this slice touches the case where the evidence is already in context). It answered the question
already, 5/5: **with the event record in hand the model reaches R2 automatically**, cites the
amounts exactly, and needs no instruction to do it — then continues into R3 in 5/5.

### 8. What causal/calibration defect remains after the information-ceiling defect is removed?

Two, and the rerun separates them cleanly.

**(B) — another retrieval defect exists, and it is now isolated.** The brief asked whether the
answer is A (corpus authority fixes retrieval, leaving only R2→R3) or B (another retrieval problem
remains). It is **B**. 27 of 27 calls were windowed, every window was wrong, and telling the model
the window was partial changed neither the window nor the decision to re-search. The residue is
**window *choice*** — distinct from window *disclosure*, which is now fixed:

- With no conversational anchor, the model adopts the only date range printed in context — the thin
  core's `recent.window` — in 13 of 14 calls across A and B, both runs.
- With one, it adopts the conversation's topic — January — and never revisits it when the question's
  subject is elsewhere.
- The question named no date. February is derivable only from the evidence, which is exactly what a
  windowed search cannot reach.

The corpus span made the *consequence* of that choice visible without making the *choice* better.

**The R2→R3 calibration defect is untouched and remains second in line.** bb2f6ec established it is
independent of retrieval (5/5 with full evidence, and 2 trials asserting purpose with none), and
this slice deliberately added no confidence or causation instruction, so the discrimination the
brief asked to preserve is preserved. One R1↑ affirmative appeared here (C t2, *"yes, it's very
likely you sold some crypto"*, argued from a January cash shortfall with no event record), against
two in run 1 — the habit is intact.

### Smallest justified next intervention

**Measure whether the model will use a wider window when nothing else is anchoring it — before
building anything.** The 0/20 no-widen result has two candidate explanations this run cannot
separate:

1. the model does not *choose* to widen (a disposition), or
2. the model does not know it *may* widen without asking (it offered three times and waited).

Those call for different work, and the cheap discriminator is a 5-trial probe that keeps everything
else fixed and simply asks the same causal question in a context where the thin core's
`recent.window` is not the only date range on the page. If the window follows whatever range is
visible, the anchor is the cause and the fix is in the context, not the tool. If it still lands on
90 days, the disposition is the cause.

**Explicitly not now:**
- No prompt change on this rerun's evidence, per the brief — including the clause result in §answer 5.
- No confidence or causation instruction. The discrimination is preserved and R2→R3 has not been
  re-measured under a truthful boundary.
- No default window, no auto-widening, no re-query, no routing of causal questions to
  `get_transactions`. The 0/20 widen rate is a reason to understand the choice, not to take it away
  from the model.

---

## 5. Threats

- **n = 5 per cell.** Every cell-level movement here (A 5/5→4/5, D 2/5→5/5, B's 0 asserted
  negatives) is inside noise. The claims that carry are the totals: 0/20 widened, 0/20 evidence,
  27/27 windowed, and the 11/18 → 5/19 register shift.
- **Register classification is mine, by reading.** The criteria are bb2f6ec's, applied per trial and
  listed in §3.4 so the classification can be checked rather than trusted. The mechanical markers
  (retrieval, windows, rows returned, amount citation) are asserted on tool results, not prose.
- **The two runs are 26 hours apart** against the same model string. Provider-side drift is not
  controlled for.
- **Cost is not measured** (§3.5), so the efficiency comparison rests on hops and latency alone.
- **The calibration phase was not re-run**, so question 7 is answered from bb2f6ec, not from a
  measurement under the new boundary.

---

## 6. Corrections and follow-ups

**Correction to `AI-GPT51-CAUSAL-EVIDENCE-EXPERIMENT.md` §6.** That report attributed the zero
`AiInvocation` rows to fire-and-forget writes being lost when a short-lived script exits. A
6-second flush before disconnect in this rerun produced zero rows as well, and the actual cause is
that the experiment harness calls the OpenAI SDK directly and never reaches the `lib/ai/provider.ts`
chokepoint. The amendment is applied in place there.

**Follow-up issue, recorded not fixed:** *"Short-lived harness processes can exit before
asynchronous `AiInvocation` persistence completes."* This remains a plausible risk in the
fire-and-forget design — but note it is **unproven**, and the one observation that appeared to
support it has now been explained by the bypass above. Any work on it should reproduce it first,
through a harness that actually reaches the chokepoint. Deliberately not addressed in this slice:
telemetry lifecycle does not belong in a reasoning experiment.

---

## 7. What this slice changed

- `lib/data/transaction-query-core.ts`, `lib/data/transaction-query.ts`,
  `scripts/ai-baseline/tools.ts` — the implementation above.
- `lib/data/transaction-corpus-coverage.test.ts` (new), `lib/data/transaction-query.test.ts`,
  `scripts/ai-baseline/baseline.test.ts`, `scripts/ai-baseline/transaction-corpus.check.ts` (new),
  `package.json` (`ai:corpus-check`).
- This document, and the §6 correction to the prior report.
- **Nothing else.** No prompt, tool description, model configuration, compaction, reasoning
  architecture, production route, or other financial tool. 500/500 tests pass.
