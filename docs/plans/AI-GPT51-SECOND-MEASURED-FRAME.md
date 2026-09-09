# Two measured financial frames — the final discriminator

**Date:** 2026-09-09 · **Model:** `gpt-5.1` · **Arm:** A2, standalone cell-A condition · **Space:**
`cmrrm846r000j7znwsl67gt1g` · **as-of:** 2026-09-08 · 5 trials

Authority: 658cfd2, bb2f6ec, 55a2c22, 70ac794, a774989, d34330b.

**Experiment only. No repository code changed** — the second frame lives in the gitignored harness.
`ASSESSMENT_WINDOW_DAYS` untouched. 500/500 tests pass.

> ## Verdict: **H1 confirmed. Both success criteria met.**
>
> **A — frame selection:** 4/5 first `get_transactions` calls chose the broader measured frame, and
> **15 of 15 date-bearing arguments across every tool** used it. `FRAME_RECENT` 0, `FRAME_MIXED` 0,
> `GENERATED_OTHER` 0. Feb-27 rows returned 4/5, both amounts cited 4/5.
>
> **B — no confusion:** **0/5 cross-frame contamination.** Every figure quoted was labelled with its
> own period (*"over this same 2026-02 to 2026-09 window"*, *"over the 220-day window"*, *"over the
> last 90 days"*). No cross-frame arithmetic, no mislabelled comparison, no borrowed window.
>
> **Cost: +236 bytes / +59 tokens — +7.2% of the orientation, +1.0% of the turn-1 prefix.**
>
> One real cost, in 1 of 5: **t4 made no tool calls at all** and answered from the 90-day figures —
> correctly labelled, but without retrieving. That did not happen in a774989 (5/5 called).

---

## 1. Exact context diff

One sibling block appended after `recent`. `recent` is byte-identical, d34330b's failed
`activityAvailable` field is absent (asserted by the harness, which throws if it appears).

```diff
  "recent": {
   "window": { "from": "2026-06-11", "to": "2026-09-08", "days": 90 },
   "income": 32704.32, "spending": 12342.56, "cardAndDebtPayments": 23953.92,
   "netCashFlow": 20378.08, "transactionCount": 428
  },
+ "activity": {
+  "window": { "from": "2026-02-01", "to": "2026-09-08", "days": 220 },
+  "income": 82157.09, "spending": 49711.34, "cardAndDebtPayments": 78171.45,
+  "netCashFlow": 35975.14, "transactionCount": 1068
+ },
  "netWorthHistory": { … },
```

Verified before running: `recent` identical, everything outside `activity` byte-identical, key order
`space, currency, current, recent, activity, netWorthHistory, signals, note, evidenceCoverage,
memory`, and the window contains 2026-02-27.

**On the name.** `activity` says what the block *measures*, not what to use it for. Nothing in it
mentions history, transactions, causality, February or Coinbase, and the model was told nothing about
which frame to use. (`activity` also exists as `IncomeStream.activity` — a state string in
`get_income` results; a top-level block carrying a window and five totals cannot be mistaken for it.
The name was checked against that collision deliberately, per the slice-1 `cash` lesson.)

### 1.1 Provenance of every second-frame figure

All five come from `get_spending({from: '2026-02-01', to: '2026-09-08'})` — the `get_spending` tool
over the `TRANSACTIONS_SUMMARY` assembler, which is **the same authority that produces the
corresponding `recent` figure**. No arithmetic was performed in the harness; the mapping is
one-to-one:

| field | source |
|---|---|
| `window.{from,to,days}` | `result.window.{from,to,days}` |
| `income` | `result.totals.income` |
| `spending` | `result.totals.spending` |
| `cardAndDebtPayments` | `result.totals.cardAndDebtPayments` |
| `netCashFlow` | `result.totals.netCashFlow` |
| `transactionCount` | `result.window.transactionCount` |

No 90-day figure was copied under a longer range. `asOf` has not moved since a774989, and the
recomputed values match it exactly.

### 1.2 Context cost

| | bytes | ~tokens |
|---|---|---|
| system instruction | 781 | 196 |
| tool schemas (15) | 19,472 | 4,868 |
| orientation, shipped | 3,288 | 822 |
| orientation, with second frame | 3,524 | 881 |
| **the second frame** | **+236** | **+59** |
| | | **+7.2% of the orientation · +1.0% of the turn-1 prefix** |

Tokens by the repo's own `tok()` estimator (`length / 4`). The orientation is one message in the
conversation prefix, so the 59 tokens are present in **every request of the conversation** — but they
sit in the cached prefix, which is where prompt caching is cheapest. This is a recurring cost and it
is small: the tool schemas alone are 83× larger.

---

## 2. The five trials

| | first frame | first `get_transactions` window | gt calls | frames used | hops | latency | Feb-27 rows | cites both | 90d figs in prose | 220d figs in prose | cross-frame error | register |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **t1** | `FRAME_ACTIVITY` | `2026-02-01..2026-09-08` transfers text=coinbase | 3 | ACTIVITY ×3 | 2 | 14.9 s | **2** | **yes** | 0 | 0 | **none** | **R3** |
| **t2** | `FRAME_ACTIVITY` | `2026-02-01..2026-09-08` transfers text=coinbase | 2 | ACTIVITY ×2 | 2 | 7.9 s | **2** | **yes** | 0 | 1, labelled | **none** | **R3** |
| **t3** | `FRAME_ACTIVITY` | `2026-02-01..2026-09-08` transfers text=coinbase | 4 | ACTIVITY ×4 | 2 | 8.0 s | **2** | **yes** | 0 | 1, labelled | **none** | **R3** |
| **t4** | `NO_TRANSACTION_CALL` | — | 0 | — | 1 | 5.5 s | 0 | no | 4, labelled | 0 | **none** | **R1↑** |
| **t5** | `FRAME_ACTIVITY` | `2026-02-01..2026-09-08` transfers text=coinbase | 3 | ACTIVITY ×3 | 2 | 8.9 s | **2** | **yes** | 0 | 2, labelled | **none** | **R2** |
| | **4/5 ACTIVITY** | | 12 | **15/15 calls** | 1.8 | 9.0 s | **4/5** | **4/5** | | | **0/5** | R3 3 · R2 1 · R1↑ 1 |

`FRAME_RECENT` **0/5**. `FRAME_MIXED` **0/5**. `GENERATED_OTHER` **0/5**. `UNWINDOWED` 0/5. Frame
switching mid-trial: **0/5** — no trial mixed frames across its own calls.

### 2.1 Frame selection across *every* date-bearing tool

| trial | call | frame |
|---|---|---|
| t1 | `get_transactions{from:2026-02-01,to:2026-09-08,flow:transfers,text:coinbase}` → 2 rows | ACTIVITY |
| t1 | `get_transactions{… text:crypto}` → 0 · `get_transactions{… flow:card_payments}` → 50 | ACTIVITY ×2 |
| t2 | **`get_spending{from:2026-02-01,to:2026-09-08}`** | **ACTIVITY** |
| t2 | `get_transactions{… text:coinbase}` → 2 · `{… card_payments}` → 50 | ACTIVITY ×2 |
| t3 | **`get_spending{from:2026-02-01,to:2026-09-08}`** | **ACTIVITY** |
| t3 | `get_transactions` ×4 (coinbase→2, kraken→0, binance→0, card_payments→50) | ACTIVITY ×4 |
| t3 | `get_investments{}` | no date args |
| t4 | *(no calls)* | — |
| t5 | **`get_spending{from:2026-02-01,to:2026-09-08}`** | **ACTIVITY** |
| t5 | `get_transactions` ×3 (coinbase→2, binance→0, card_payments→50) | ACTIVITY ×3 |

**Frame selection is coherent across tools, not just `get_transactions`.** All three `get_spending`
calls used the broader frame too. Not one call in the probe used the 90-day window — a complete
reversal of every prior experiment, where 11/11, 12/12 and 26/28 used it.

Compare directly with d34330b, which changed one thing: whether the broader range carried figures.

| | broader range present | figures measured over it | calls using the broader range |
|---|---|---|---|
| d34330b (`recent.activityAvailable`) | yes, inside `recent` | **no** | **0/11** |
| **this probe (`activity` sibling)** | yes, as a sibling | **yes** | **15/15** |

That is the discriminator the previous five experiments could not resolve. **The key is not named
`window`, and position is not privileged. A frame becomes bindable when figures are measured over
it.** H1 confirmed; H2 falsified.

### 2.2 Feb-27 retrieval and citation

| | |
|---|---|
| Trials returning both Coinbase rows | **4/5** (all four that called the tool) |
| Answers citing **both** `$8,141.98` and `$1,902.12` | **4/5** |
| Answers citing one | 0 |
| Answers citing neither | 1 — t4, which retrieved nothing |
| Same-day card payments retrieved | **0/5** |
| `$13,450.65` cited | 0/5 |
| `$3,406.55` computed | 0/5 |

Every `flow: card_payments` call ran over the full 220 days with default newest-first and a 50-row
limit, so it returned June–September payments. The frame was right; the **ranking** was not. This is
the "different retrieval problem" of failure-mode 4, and per the brief it is reported without adding
machinery: `sort: 'largest'` or a narrower window would have found the Feb-27 payments, and the model
chose neither.

> **Scorer correction, made before this report.** My first pass scored t3 as citing 0/2, because the
> marker required a thousands separator and t3 wrote `(8141.98 + 1902.12)`. Corrected to 4/5. Same
> class of error as the 3/5→0/5 erratum, caught by re-reading the transcripts rather than trusting
> the count.

### 2.3 Cross-frame confusion — none found

Every figure quoted in prose was attached to its own period, in the model's own words:

- **t2** — *"Over this same **2026-02 to 2026-09 window**, your card and debt payments total
  **$78,171.45**"* ✓
- **t3** — *"Here's the pattern in the data (**February–September 2026**)"* … *"your total card/debt
  payments over the **220-day window** are **$78,171.45**"* ✓
- **t5** — *"over the **220-day window** you've paid **$78,171.45**"* … *"your overall net cash flow
  over this **220-day window** is strongly positive (~$36k)"* ✓
- **t4** — *"Over the **last 90 days**: Income **$32,704.32**, Spending **$12,342.56**, Card & debt
  payments **$23,953.92**, Net cash flow **+$20,378.08**"* ✓ — all four are the 90-day values, all
  four correctly labelled
- **t1** — quotes no frame totals at all ✓

**No trial mixed the two.** No 220-day figure was called "recent"; no 90-day and 220-day total were
compared as if commensurable; no window was paired with the other frame's values; no transaction
count was silently blended.

One reasoning observation that is *not* cross-frame contamination but is worth recording: t3 argues
$78,171.45 of card payments is *"much more than what would be covered by paycheck income alone"*. It
is comparing card payments against the **same** frame's net cash flow (+$35,975.14), which is
arithmetically fair — but `cardAndDebtPayments` are transfers to cards whose purchases are already
inside `spending`, so the comparison double-counts. That semantic trap exists in the shipped
90-day block too and is unrelated to having two frames.

### 2.4 Register — observed, no doctrine drawn

**R3 3/5 · R2 1/5 · R1↑ 1/5.**

- **t1, t2, t3** reach R3: *"I'd describe it as: yes, you effectively used crypto money to pay off a
  chunk of that debt"* (t1), *"yes, you effectively sold crypto and used the proceeds to pay down
  debt"* (t2), *"at least part of your debt pay-down was funded by crypto sales"* (t3). All three
  first state the R2 evidence exactly and explicitly disclaim the dollar-level link, then assert the
  purpose anyway.
- **t5** holds at R2 and refuses both halves: *"I can't directly see inside Coinbase, so I don't know
  if that $10k was from selling crypto vs. moving existing USD"*, *"can't tag those dollars to those
  payments with certainty"*.
- **t4** is **R1↑** — *"probably yes, at least indirectly"* from **zero tool calls**, on aggregate
  figures alone, then partially withdrawn (*"I can't definitively say from this alone"*).

a774989 produced R2 4/5 · R3 1/5 on the same question with a single widened frame. This cell is R3
3/5. The visible difference is payment evidence: here 4/5 called `card_payments` and received 50 rows
against a774989's 2/5, and here the orientation itself states `cardAndDebtPayments: 78,171.45`
beside the frame. **Consistent with the juxtaposition hypothesis, and explicitly not a finding** —
two 5-trial cells with different evidence paths, and the brief directs that no calibration doctrine be
drawn from them. It is not conflated with frame selection: frame selection is 15/15 regardless of
register.

### 2.5 Cost

**Unmeasured** — 55a2c22 §3.5: the harness calls the OpenAI SDK directly and never reaches
`lib/ai/provider.ts`. Hops 1.8 avg, latency 9.0 s avg. Context cost is measured and reported in §1.2.

---

## 3. Product decision

**1. Can GPT-5.1 choose between two truthful measured financial frames according to the question?**

**Yes.** 15 of 15 date-bearing arguments selected the broader frame for a causal question about an
undated past event, across three different tools, with zero mixing. The choice was not instructed —
nothing told it which frame to use, and the name carries no routing hint. Given two truthful measured
periods it picked the one that could contain an answer.

**2. Does a second measured frame solve the causal retrieval problem without degrading interpretation
of recent finances?**

**Retrieval: yes** — Feb-27 evidence 0/20 → 4/5, citation 0/20 → 4/5.
**Interpretation: no degradation observed** — 0/5 cross-frame errors, and the one trial that quoted
90-day figures labelled all four correctly.

**But with one unexplained cost: t4 made no tool calls at all.** In a774989's single widened frame,
5/5 retrieved; here 4/5 did. A richer orientation gives a plausible-looking answer without
retrieving, and t4 took it. n=1, so this is a flag, not a finding — and it is the single most
important thing to watch if this ships.

**3. Does the second frame create ambiguity or cross-frame contamination?**

**Not in this cell.** But the probe tested exactly one question, and it is the *favourable* one: a
causal question about the past, where the broader frame is obviously the better tool. The ambiguity
risk lives in the opposite question — *"how much do I spend?"* now has two truthful answers,
$12,342.56 and $49,711.34. **This experiment did not test that**, and §4 makes it the gate.

**4. Is this architecture suitable for the thin orientation?**

**Provisionally yes, on cost and on this evidence.** +59 tokens, +1.0% of the turn-1 prefix, in the
cached prefix. That is cheap against the 4,868 tokens of tool schemas already there. The thin core's
own doctrine — *"a compact orientation, not a context dump"* — is not violated by one more measured
block of the same shape as the one beside it.

**5. If yes, what is the smallest production shape?**

One additional `TRANSACTIONS_SUMMARY` assembly in `thinCore()`, emitted as a sibling of `recent`,
with `recent` and `ASSESSMENT_WINDOW_DAYS` untouched:

```ts
// scripts/ai-baseline/evidence.ts — thinCore()
recent:   { window: <90d>,  … },      // UNCHANGED. computeAssessment's window.
activity: { window: <N d>,  … },      // NEW. Same shape, same authority, its own figures.
```

Three decisions the slice needs, none of which this experiment settles:

- **What N is.** 220 days was chosen because it contains a known event, which a product cannot do. A
  calendar-anchored window (12 months, or year-to-date) is the honest candidate — and it is still
  finite, so it moves the wall rather than removing it.
- **What it costs to assemble.** A second `TRANSACTIONS_SUMMARY` over a longer window is a second
  bounded read on every orientation build. Its latency and row cost are unmeasured.
- **The naming and labelling**, which must not become routing. `activity` worked; the shape did the
  work, not the word.

**Before any of that: the ambiguity gate.** Run the same 5-trial design against
*"How am I looking financially?"* and *"How much do I spend a month?"* — the questions where two
truthful spending figures could produce a wrong or confusing answer. This probe measured that two
frames do not confuse the model on a question that clearly wants the wider one. It did not measure
the case that clearly wants the narrower one, and that is where the regression would be.

**6. Should 4M prefer conversational reframing instead?**

**No longer the leading option, but it stays viable as a fallback.** Cells C/D showed the model
follows a conversational frame just as readily, at zero token cost — but it makes historical
investigation a two-turn interaction, and the whole point of this series is that the user asked a
one-turn question and got a confident wrong answer. Two measured frames answer it in one turn, for
59 tokens, with no observed confusion. That is the better product on this evidence, *provided* the
ambiguity gate passes.

---

## 4. Stop condition

Honoured. This was the final retrieval/context-composition discriminator, and no further
field-placement, naming, availability or date-anchor experiment is proposed. The retrieval question
is closed:

> Across six experiments and 60 trials, GPT-5.1 never chose a window; it bound date parameters to a
> **measured financial frame**. Give it only a 90-day frame and it searches 90 days, however the
> record's true extent is described to it. Give it two truthful measured frames and it picks the one
> that fits the question, coherently across tools, without confusing their figures.

The one recommended next step is not another placement experiment — it is the **ambiguity gate**
(§3.5), which tests the composition against the questions this probe deliberately did not ask.
Nothing is implemented here.

Two things remain open and are named rather than closed:

- **The `card_payments` ranking gap** (§2.2) — right frame, wrong ranking, 0/5 same-day payments.
  Reported, no machinery proposed.
- **R2→R3 calibration** (§2.4) — the only unresolved reasoning defect, still untested against the
  juxtaposition hypothesis.

---

## 5. Threats

- **n = 5, one question.** 15/15 and 0/5 are unambiguous at this n; the R3 3/5 vs a774989's 1/5 is
  not, and is presented as an observation.
- **The favourable question.** §3.3 — the ambiguity risk lives in questions this cell did not ask.
- **220 days was chosen knowing the answer.** A product cannot. §3.5.
- **t4's zero-call answer is n=1** and may be ordinary variance rather than a cost of the second
  frame.
- **A scorer error was found and corrected mid-analysis** (§2.2); the corrected figures are from
  re-read transcripts.
- **Cost unmeasured** (§2.5). Runs hours apart against one model string.

---

## 6. What this experiment changed

**No repository code.** The second frame and harness are in gitignored `tmp/causal/`.
`ASSESSMENT_WINDOW_DAYS`, `recent`, the system prompt, tool schemas and descriptions,
`get_transactions` coverage and `evidenceCoverage` are untouched. This document is the only artefact;
neither direction was implemented.
