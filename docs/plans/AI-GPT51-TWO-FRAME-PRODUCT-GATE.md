# Two-measured-frame orientation — the product safety gate

**Date:** 2026-09-12 · **Model:** `gpt-5.1` · **Arm:** A2 · **Space:** `cmrrm846r000j7znwsl67gt1g`
· **as-of:** 2026-09-12 · **50 runs** — 5 questions × 2 conditions × 5 trials

Authority: 658cfd2, bb2f6ec, 55a2c22, 70ac794, a774989, d34330b, 0c0a84b.

**Gate only. No repository code changed** — both contexts are built in the gitignored harness.
`ASSESSMENT_WINDOW_DAYS` untouched. 500/500 tests pass. No retrieval hypothesis was re-tested.

> ## Verdict: **PASS**
>
> | | control (1 frame) | candidate (2 frames) |
> |---|---|---|
> | CLEAN | **25/25** | **14/25** |
> | ACCEPTABLE_WITH_EXPLANATION | 0 | **11/25** |
> | **AMBIGUOUS** | **0** | **0** |
> | **CONTAMINATED** | **0** | **0** |
> | **WRONG** | **0** | **0** |
>
> **Every ACTIVITY figure quoted — 11 trials, 44 figures — carried its own period label.** Zero
> invalid raw-total comparisons across 50 runs. Zero clarification requests across 50 runs.
> "Lately"-type questions stayed anchored to the 90-day frame in **10/10** trials, and the
> adversarial Q4 used the broader frame in **0/5** — it built its own month-by-month comparison
> instead, in both conditions.
>
> Recurring cost: **+236 bytes / +59 tokens** (+7.1% of the orientation, +1.0% of the turn-1 prefix).

---

## 1. Exact contexts

Both conditions share one orientation body; the candidate adds one sibling block. Everything else —
system instruction, tool schemas and descriptions, `evidenceCoverage`, `get_transactions` coverage,
model settings — is identical, and the shipped `recent` block is byte-identical between them.

```jsonc
// CONTROL and CANDIDATE both carry this, unchanged:
"recent":   { "window": { "from":"2026-06-14","to":"2026-09-12","days":90 },
              "income":38031.77, "spending":13919.69,
              "cardAndDebtPayments":27053.92, "netCashFlow":24128.40,
              "transactionCount":449 },

// CANDIDATE adds only this sibling:
"activity": { "window": { "from":"2026-02-01","to":"2026-09-12","days":224 },
              "income":87484.54, "spending":51453.79,
              "cardAndDebtPayments":81271.45, "netCashFlow":39560.14,
              "transactionCount":1102 },
```

All five `activity` figures come from `get_spending({from:'2026-02-01', to:<recent.window.to>})` —
the same `TRANSACTIONS_SUMMARY` authority that produces each corresponding `recent` figure, one-to-one,
no arithmetic in the harness.

**Both frames end on the same day.** 0c0a84b ran at as-of 2026-09-08; today `recent.window` is
`startOfDay(-90)`→wall clock, so the shared end moved to 2026-09-12 and `activity` was rebuilt to
match. Two frames ending on different dates would have been a confound in an ambiguity test, not the
design under test.

The contrasting pair the gate turns on: **spending $13,919.69 over 90 days vs $51,453.79 over 224
days** — a 3.7× difference in raw magnitude, 1.5× in monthly rate.

### 1.1 Context cost

| | bytes | ~tokens |
|---|---|---|
| orientation, control | 3,310 | 828 |
| orientation, candidate | 3,546 | 887 |
| **delta** | **+236** | **+59** |
| | | +7.1% of the orientation · **+1.0% of the turn-1 prefix** |

For scale, the 15 tool schemas already in that prefix are 4,868 tokens. The orientation sits in the
conversation prefix, so the 59 tokens recur in every request — inside the cached region.

---

## 2. Question × condition matrix

| | control | candidate |
|---|---|---|
| **Q1** *"How much am I spending?"* | CLEAN 5 | **CLEAN 4 · ACCEPTABLE 1** |
| **Q2** *"How have I been spending lately?"* | CLEAN 5 | **CLEAN 5** |
| **Q3** *"How am I doing financially?"* | CLEAN 5 | **ACCEPTABLE 5** |
| **Q4** *"Am I spending more than usual?"* | CLEAN 5 | **CLEAN 5** |
| **Q5** *"What's my cash flow looking like?"* | CLEAN 5 | **ACCEPTABLE 5** |
| | **CLEAN 25** | **CLEAN 14 · ACCEPTABLE 11 · AMBIGUOUS 0 · CONTAMINATED 0 · WRONG 0** |

### 2.1 Frame selection, tools, and period labelling

| | | quotes RECENT | quotes ACTIVITY | every ACTIVITY figure labelled | tool windows | avg calls · hops · latency |
|---|---|---|---|---|---|---|
| **Q1** | control | 4/5 | — | — | none | 0.0 · 1.0 · 2.3 s |
| | candidate | 5/5 | **1/5** | **1/1** | none | 0.0 · 1.0 · 1.9 s |
| **Q2** | control | 5/5 | — | — | `get_spending{}` ×5 (default) | 1.0 · 2.0 · 5.7 s |
| | candidate | 5/5 | **0/5** | n/a | `get_spending{}` ×5 (default) | 1.0 · 2.0 · 5.5 s |
| **Q3** | control | 5/5 | — | — | none | 0.0 · 1.0 · 5.5 s |
| | candidate | 5/5 | **5/5** | **5/5** | none | 0.0 · 1.0 · 5.9 s |
| **Q4** | control | 5/5 | — | — | 90-day window ×5, one 31-day sub-window | 1.2 · 2.2 · 4.3 s |
| | candidate | 5/5 | **0/5** | n/a | **90-day window ×4, one 31d/61d split** | 1.2 · 2.2 · 4.3 s |
| **Q5** | control | 5/5 | — | — | none | 0.0 · 1.0 · 2.6 s |
| | candidate | 5/5 | **5/5** | **5/5** | none | 0.0 · 1.0 · 2.8 s |

**Not one `get_spending` call in the candidate condition used the activity window.** Q2 used the
tool's own default in both conditions; Q4 used `2026-06-14..2026-09-12` — `recent.window`, exactly —
in 4/5 candidate trials, and a self-built 31-day / 61-day split in the fifth. The broader frame was
available and was not reached for on any question where a recent basis is the right one.

**Answer length** (candidate vs control): Q1 +13%, Q2 +20%, Q3 +1%, Q4 **−9%**, Q5 +10%. Q2's +20%
is one outlier trial that quoted **no** activity figure, so it is variance, not frame cost.

### 2.2 Contamination: none found

- **Cross-frame labelling: 11/11 trials clean.** Every trial that quoted an activity figure attached
  it to its own window, in the model's own words — *"Since Feb 1 (2026-02-01 → 2026-09-12)"*,
  *"Last ~7 months (2026-02-01 to 2026-09-12)"*, *"Over a longer window (since Feb 1)"*,
  *"Year-to-date-ish (2026-02-01 to 2026-09-12)"*.
- **Recent label on an activity figure:** 0/50.
- **Activity label on a recent figure:** 0/50.
- **One frame's window paired with another's values:** 0/50.
- **Invalid raw-total comparison ($13,919.69 vs $51,453.79 as magnitudes):** **0/50.**
- **Clarification requests:** **0/50.** No answer in either condition asked the user which period
  they meant.

---

## 3. Question by question

### Q1 — *"How much am I spending?"* (the underspecified one)

**Both conditions answer immediately and identically in substance.** All ten pick the 90-day basis
and state it: *"Over the last 90 days (Jun 14 – Sep 12), you've spent $13,919.69 total… roughly
$4,640 per month."* Neither condition asked for a date range.

The one candidate trial that used both did the thing the brief hoped for rather than the thing it
feared — it **normalized**:

> *"**Last 90 days (2026-06-14 to 2026-09-12):** You spent **$13,919.69**. That's roughly **$4,600
> per month** on average. **Since Feb 1, 2026 (about 7.5 months):** You spent **$51,453.79**, which
> averages around **$6,800 per month**. So depending on how you slice it, your recent burn looks
> like **$4.6k–$6.8k per month**."*

Two truthful periods, both labelled, both converted to a common rate, and a range the user can act
on. Scored ACCEPTABLE_WITH_EXPLANATION because it is longer than the one-line answer; it is arguably
a **better** answer than the control's.

**Two frames did not make Q1 worse.** 459 characters against the control's 343 at worst.

### Q2 — *"How have I been spending lately?"*

The cleanest result in the gate. **10/10 anchored to the last 90 days; 0/5 candidate trials quoted a
single activity figure.** Both conditions call `get_spending` with no window, get the tool default,
and produce the same category breakdown. The word *"lately"* kept the model on the recent frame with
the broader one sitting right beside it.

### Q3 — *"How am I doing financially?"*

**5/5 candidate trials used both frames; 5/5 labelled both correctly.** The brief permits this for a
broad question provided no silent substitution occurs, and there was none:

> *"**Recent flow (last 90 days):** Income ~$38.0k · Spending ~$13.9k · Card & debt payments ~$27.1k
> · Net cash flow +$24.1k. **Over a longer window (since Feb 1):** Income ~$87.5k · Spending ~$51.5k
> …"*

Answer length is **+1%** against control — the second frame displaced narrative rather than adding to
it.

One observation **identical in both conditions**, so not caused by the second frame: every trial
notes *"no reported liabilities, though there are 2 debt accounts on file"*. That is the orientation's
own `liabilities: 0` beside `accountCounts.liabilities: 2`, and it is out of scope here.

### Q4 — *"Am I spending more than usual?"* (the adversarial one)

**The strongest evidence in the gate, and it is a null result by design.**

**0/5 candidate trials used the activity frame at all.** Instead, both conditions did the right
thing: fetched a monthly breakdown and compared **months to months**.

> *"June (partial): $2,158 · July: $2,290 · **August: $6,403 ← big spike** · September so far:
> $3,068… Baseline: June–July look like your 'normal' level, roughly low-$2k per month. August is
> almost 3× that — driven by Airbnb / travel / shopping. That looks like a one-off heavy month, not a
> new steady state."*

Candidate t2 went further and built its own normalized comparison — *"Last 31 days (Aug 13–Sep 12):
$6,178.96 → about $6.2k/month. Prior 61 days (Jun 14–Aug 13): $7,913.01 over 61 days → about
$3,880/month"* — dividing each period by its own length before comparing.

**No trial compared $13,919.69 against $51,453.79.** No trial invented a canonical "usual"; every one
derived a baseline from the month series and said so. Candidate answers were **9% shorter** than
control.

### Q5 — *"What's my cash flow looking like?"*

**5/5 candidate trials present both frames as two explicitly-headed blocks**, each complete and each
labelled:

> *"**Last 90 days (2026-06-14 → 2026-09-12):** Income $38,031.77 · Spending $13,919.69 · Card & debt
> payments $27,053.92 · Net cash flow +$24,128.40. **Since Feb 1 (2026-02-01 → 2026-09-12):** Income
> $87,484.54 · Spending $51,453.79 · Card & debt payments $81,271.45 · Net cash flow +$39,560.14. So
> you're clearly cash-flow positive over both windows."*

Correct, labelled, and not misleading. **It is also the one place where the candidate is noticeably
more report-like than the control**, which gave a single conversational block. +10% length, two
tables where there was one. This is the honest quality cost of the design, and it is a style cost,
not a truth cost — the brief's own `ACCEPTABLE_WITH_EXPLANATION` band.

---

## 4. Gate criteria

| PASS criterion | result |
|---|---|
| No material cross-frame contamination | **PASS** — 0/50; 11/11 activity-quoting trials fully labelled |
| No materially wrong conclusions caused by the second frame | **PASS** — 0 WRONG, 0 AMBIGUOUS |
| Recent/lately questions stay anchored to recent evidence | **PASS** — Q2 5/5, Q4 5/5, Q1 5/5 lead with the 90-day basis; 0 tool calls used the activity window |
| Broader values correctly period-labelled | **PASS** — 11/11 |
| Ordinary questions not more awkward or clarification-heavy | **PASS** — 0/50 clarifications; lengths +13/+20/+1/−9/+10% |
| Second frame behaves as context, not a competing truth | **PASS** — used on broad/longitudinal questions, ignored on recent ones, never substituted |

| FAIL criterion | result |
|---|---|
| Broader frame hijacks recent questions | **no** — 0/25 |
| Raw totals across unequal periods compared directly | **no** — 0/50 |
| Figures mislabeled | **no** — 0/50 |
| Model oscillates unpredictably between frames | **no** — selection is stable and question-appropriate: Q2/Q4 recent-only 10/10, Q3/Q5 both 10/10, Q1 recent 4/5 |
| User must now specify periods | **no** — 0/50 clarifications |
| Assessment quality degrades to enable retrieval | **no** — Q4, the assessment-quality question, is unchanged and marginally better |

**GATE: PASS.**

### 4.1 What this gate does not claim

- **n = 5 per cell, one Space, one model string.** The 0/50 counts are unambiguous at this n; the
  per-question length deltas are not.
- **Five questions, chosen adversarially but not exhaustively.** Questions naming an explicit period
  (*"how much did I spend in July?"*), comparative questions across frames, and multi-turn sequences
  where one frame is established and another needed were not tested.
- **Two frames, not three.** Nothing here says the property survives a third.
- **The 224-day frame is answer-aware.** §5 keeps that out of the recommendation.
- **Cost unmeasured** (harness bypasses `lib/ai/provider.ts`, 55a2c22 §3.5). Latency and hops are
  within noise of each other between conditions.
- **Grading is by reading**, per trial, with the quotes above so the classification can be audited.
  The mechanical checks (figure detection, labelling proximity, raw-total comparison, clarification
  language) are stated in the harness and were re-read rather than trusted — an earlier pass of the
  figure detector under-counted because it required thousands separators and missed *"$13,920"*.

---

## 5. Recommendation — a narrow implementation investigation, not an implementation

The architecture passes. What remains unanswered is **what the production activity frame means**, and
this gate deliberately does not decide it.

**Scope of the next investigation — three questions, no code:**

1. **What period?** The gate's 224 days starts at 2026-02-01 because an experiment needed February.
   A product cannot choose a window by knowing the answer. The candidates each carry a different
   contract and a different failure at the edges — calendar year-to-date (meaningful to users,
   collapses to nothing each January), trailing N months (stable width, arbitrary N), the settled
   history horizon (maximal reach, unbounded and variable per Space), or another deterministic
   financial period. **This is a product-semantics decision, not a tuning parameter.**

2. **What does the second assembly cost?** A second `TRANSACTIONS_SUMMARY` over a longer window on
   every orientation build. Its latency, row count and read cost are unmeasured, and a 26-month
   horizon on a large Space is a different proposition from 224 days on this one. The 59-token
   context cost is known; the *assembly* cost is not.

3. **What happens at the edges the gate did not test?** A frame that is empty or near-empty (a new
   Space, a Space whose history starts last month), a frame identical to `recent` (when the corpus is
   shorter than the assessment window), and the questions §4.1 lists. Each has an obvious truthful
   answer; none has been measured.

**Where the code would go, when it is authorised:** one additional assembly in `thinCore()`
(`scripts/ai-baseline/evidence.ts`), emitted as a sibling of `recent`, with `recent`,
`ASSESSMENT_WINDOW_DAYS` and `computeAssessment` untouched. The shape is settled by 0c0a84b and this
gate; only the period and its cost are open.

**Conversational/on-demand reframing is now the documented fallback, not the direction.** It works —
cells C/D showed the model follows a conversational frame as readily — but it turns a one-turn
question into two, and the gate has removed the reason to prefer it: two frames cost 59 tokens, 0
contamination, 0 clarifications, and 0 degradation on ordinary questions.

---

## 6. Open issues, kept separate

Untouched and not conflated, per the brief:

1. **Card-payment ranking** — 0c0a84b §2.2: `flow: card_payments` defaults newest-first across a wide
   window and misses same-day events. An event-ranking/relevance issue, unrelated to frames.
2. **R2→R3 causal calibration** — R3 varied 5/5 (preloaded juxtaposition) → 1/5 (widened frame) →
   3/5 (two frames). No causal doctrine drawn or proposed.
3. **Harness cost telemetry** — still unmeasured; the experimental scripts bypass
   `lib/ai/provider.ts`. Not fixed here.

---

## 7. What this gate changed

**No repository code.** Both contexts and the harness are in gitignored `tmp/causal/`.
`ASSESSMENT_WINDOW_DAYS`, `recent`, the system instruction, tool schemas and descriptions,
`get_transactions` coverage and `evidenceCoverage` are untouched. This document is the only artefact,
and nothing was implemented.
