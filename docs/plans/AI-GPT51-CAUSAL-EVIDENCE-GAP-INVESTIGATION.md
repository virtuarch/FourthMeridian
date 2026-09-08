# gpt-5.1 causal transaction-evidence gap

**Date:** 2026-09-09 · **HEAD:** `2ae717d` · **Status:** investigation. **Nothing implemented.**

Source: the live A2 dogfood at `tmp/ai-baseline/interactive-2026-09-08T20-53-48-380Z`
(gpt-5.1, 9 turns). No prompt, tool, schema or route was changed.

---

## 1. Verdict

**The model was one tool call away from the evidence, knew that class of evidence existed, said
out loud that it was missing, and did not fetch it — then raised its confidence two turns later
without acquiring anything new.**

Three findings, in order of how much they change the picture:

| | Finding |
|---|---|
| **1** | **The evidence needs no window reasoning at all.** `get_transactions({text: 'coinbase', sort: 'largest'})` — **no `from`, no `to`** — returns the two Feb-27 transfers as the top rows of 18 ranked across the whole corpus. `get_transactions` has **no default window** (unlike `get_spending`'s 90 days). The retrieval was one call with the simplest possible arguments. |
| **2** | **The model was told the evidence existed, on every turn.** The A2 core carries `evidenceCoverage.transactions = { availability: "AVAILABLE", span: 2024-07-18 → 2026-09-07, count: 4228 }`. It knew a 4,228-row transaction record spanning February was available while writing *"Without the individual trade records, I can't prove you sold."* |
| **3** | **My own prior experiment's result was wrong, and the correction matters.** AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md reports "Coinbase evidence found 3/5". Re-reading the transcripts: **0/5 retrieved it.** The marker matched the *word* "Coinbase" — which appeared in sentences like *"there's **no** transfer that clearly looks like Coinbase sell proceeds in this 90-day window."* All five trials used the same window. §7 has the amendment. |

**The live failure is not the experiment's failure.** The experiment failed at **window selection**
(right lens, wrong window, 5/5). The live conversation failed at **lens selection** — it never
reached the transaction lens at all, across four turns of an explicitly causal thread.

---

## 2. The failure chain

| Turn | Question | Tools | What it had |
|---|---|---|---|
| T3 | *"What was going on with me financially around January?"* | `get_net_worth_history(2025-12-15..2026-01-31, daily)` | balance series |
| T4 | *"sure"* | `get_spending(2026-01-01..2026-01-31)` | January aggregates |
| **T5** | **"Do you think I sold crypto to pay off some of that debt?"** | **none** | the above, unchanged |
| T6 | *"what about in a later month?"* | `get_spending(March)` · `get_net_worth_history(Feb 15..Mar 31)` | more of the same lens |
| T7 | *"what were my assets from jan to march?"* | `get_net_worth_history(Jan..Mar, monthly)` | same lens, wider window |
| **T8** | **"so its likely i sold crypto in february then, no?"** | **none** | **nothing new since T7** |

**T5 is the diagnostic turn.** The answer is *well calibrated* and names its own gap:

> *"That ~$2k drop could be pure market movement, pure selling, or a mix. **Without the individual
> trade records, I can't prove you sold** … it's **plausible** you sold at least some crypto."*

It identifies precisely the evidence that would settle the question, and stops.

**T8 is the calibration turn.** With **zero tool calls and no new evidence**, the register moves
from *"plausible"* to:

> *"**Very high likelihood** you sold a significant amount of crypto in or around February."*

The escalation came from re-reading the same balance series over a wider window (T7). **Confidence
rose while evidence did not.**

Every lens the model chose across T3–T8 was an **aggregate or series** lens — net-worth history,
spending rollups. It never switched to the **event** lens, in a thread that was explicitly about
an event.

---

## 3. What was available and unused

Measured live against the real Space:

```
get_transactions({ from: '2026-02-01', to: '2026-02-29', text: 'coinbase', sort: 'largest' })
  → 2026-02-27  Coinbase   8141.98
    2026-02-27  Coinbase   1902.12          rankedOver 2 · rankingIsComplete true
```

```
get_transactions({ from: '2026-02-25', to: '2026-03-01', flow: 'card_payments', sort: 'largest' })
  → 2026-02-27  American Express Ach Pmt   -5000.00
    2026-02-27  Payment to Chase card      -4000.00
    2026-02-27  Payment to Chase card      -3450.65
    2026-02-27  American Express Ach Pmt   -1000.00
```

**Two corrections to the brief's own figures**, both from this measurement:

- The same-day card payments total **$13,450.65 across four payments**, not $5,000 + $4,000. The
  earlier gpt-5.5 dogfood surfaced two of the four.
- **The transfers do not cover the payments.** $10,044.10 in against $13,450.65 out on the same
  day — a gap of $3,406.55 that had to come from somewhere else. **Neither model surfaced this**,
  and it is exactly the kind of nuance the event record adds and the balance series cannot.

---

## 4. Could `get_transactions` have retrieved it cleanly?

**Yes, more cleanly than expected.** With **no date arguments at all**:

```
get_transactions({ text: 'coinbase', sort: 'largest', limit: 5 })
  → window { from: null, to: '2026-09-08' }     rankedOver 18
    2026-02-27  Coinbase    8141.98
    2026-02-27  Coinbase    1902.12
    2025-04-29  Coinbase    -200.00   …
```

`get_transactions` applies `dateFrom` **only when `from` is supplied** — there is no default
window. With `sort: 'largest'` the read pages the whole corpus to exhaustion, so the February
transfers surface first *without the model having to reason about dates at all*.

**This is the single most important fact in the investigation.** Window selection — the thing that
defeated the prior experiment — is not even required here. The only thing standing between the
model and the evidence was *thinking of the tool*.

---

## 5. Window and coverage behaviour — a real contract weakness

A windowed miss is **indistinguishable from a true absence**:

```
get_transactions({ from: '2026-06-10', to: '2026-09-07', text: 'coinbase' })
  → { rows: [], shown: 0, rankedOver: 0, rankingIsComplete: true, pagesRead: 1 }
```

**`rankingIsComplete: true` on an empty result reads as authoritative absence.** It means
"complete *within this window*"; nothing in the payload says the corpus extends to 2024-07-18.

This is an **asymmetry with every sibling tool**:

| Tool | States corpus bounds? |
|---|---|
| `get_net_worth_history` | ✅ `coverage.historyAvailableFrom` / `historyAvailableTo` |
| `get_financial_snapshot` | ✅ `coverage.historyAvailableFrom` / `historyAvailableTo` |
| **`get_transactions`** | ❌ **returns `window` only — never the span it sits inside** |

The prior experiment's three "found" answers are what this produces in practice — confident
negatives scoped to a self-chosen window:

> *"There's **no transfer that clearly looks like** exchange / Coinbase sell proceeds to checking
> **in this 90-day window**."*

The model was honest about its window. Nothing told it the window was 3% of the record.

**Note this is the mechanism behind the EXPERIMENT's failure, not the live one** — in the live
conversation the tool was never called, so no window was ever chosen.

---

## 6. The system instruction

The A2 instruction's retrieval clause is three sentences:

> *"Use the financial evidence and tools you are given. Never state a figure you were not given or
> cannot compute from what you were given. **If something is unknown or unknowable, say so once and
> move on.**"*

**T5 followed that last clause verbatim.** It declared the trade records unavailable, said so once,
and moved on — which is the instructed behaviour when something is *unknowable*, and the wrong
behaviour when it is merely *un-fetched*. The instruction does not distinguish those.

This clause was already flagged as implicated in the disposition experiment (`ED` t2:
*"I don't actually have your exact balances … which I didn't do"*) and deliberately left untouched
so that experiment changed one thing. **This is the second live instance.**

---

## 7. Amendment to the prior experiment

`AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md` §3 reports probe C as **"Coinbase evidence found
3/5"** and treats criterion 3 as a near-miss. Re-reading the five transcripts:

| Trial | `get_transactions` window | Mentions "Coinbase" | **Cites the Feb-27 evidence** |
|---|---|---|---|
| t1 | 2026-06-10 .. 2026-09-07 | yes — *"there's **no** transfer…"* | **no** |
| t2 | 2026-06-10 .. 2026-09-07 | no | **no** |
| t3 | 2026-06-10 .. 2026-09-07 | yes — *"we could look for … labelled 'Coinbase'"* | **no** |
| t4 | 2026-06-10 .. 2026-09-07 | no | **no** |
| t5 | 2026-06-10 .. 2026-09-07 | yes — *"I don't see any transfers … from Coinbase"* | **no** |

**Corrected: 0/5, not 3/5.** All five chose the same 90-day window; the marker matched the word in
negative sentences. The experiment's PARTIAL verdict does not change — willingness still went
0/3 → 5/5 — but criterion 3 was a **clean fail**, and my "3/5" overstated it. The prior document
should carry this amendment.

---

## 8. Attribution by layer

| Layer | Verdict | Evidence |
|---|---|---|
| **Evidence-lens selection** | **PRIMARY** | Four turns of an explicitly causal thread; every tool chosen was an aggregate/series lens; the event lens was never reached |
| **Confidence calibration** | **PRIMARY, and independent** | T5 → T8 escalated *plausible* → *very high likelihood* with zero new evidence. Fixing retrieval would not by itself fix this |
| **System instruction** | **CONTRIBUTING** | *"say so once and move on"* is precisely what T5 did; second live instance |
| **Conversational inheritance** | **CONTRIBUTING** | An aggregate lens established at T3 persisted through T8. Note the *other* live session called `get_transactions` unprompted with an explicit historical range at turn 1 — no inherited lens to escape |
| **Tool contract / schema** | **CONTRIBUTING, different failure** | Windowed absence is indistinguishable from true absence (§5). Caused the experiment's failure; irrelevant to the live one, where no window was chosen |
| **Historical-window selection** | **NOT the live cause** | §4 — no window is needed; `sort: largest` with no `from` finds it |
| **Retrieval willingness** | **NOT the cause** | The model called four distinct tools this session, and `get_transactions` with an explicit Jan–Sep range in the sibling session |

---

## 9. The three registers, and why the distinction is load-bearing

| Register | Supported by |
|---|---|
| *"The evidence suggests X"* | the balance series alone — what T5 correctly said |
| *"Transactions show X"* | **the event record** — two Coinbase transfers of $10,044.10 on Feb 27, alongside $13,450.65 of card payments the same day |
| *"X caused Y"* | **nothing available** — same-day coincidence is not intent |

The event record moves register 1 → 2. It **cannot** reach 3, and the $3,406.55 shortfall between
the transfers and the payments is a concrete reason to keep it out of 3.

gpt-5.5's earlier answer sat correctly in register 2 (*"it strongly looks like… the only
uncertainty is whether the crypto drop was entirely from selling"*). gpt-5.1's T8 sits in an
**overclaimed register 1** — the language of register 2 (*"very high likelihood"*) on the evidence
of register 1.

---

## 10. Candidate interventions, least machinery first

| # | Intervention | Attacks | Machinery | Risk |
|---|---|---|---|---|
| **1** | **Qualify the "unknown or unknowable" clause** so it licenses closing a question only when the system genuinely cannot know it. One clause, already implicated twice. | instruction licence | **none** — edits an existing sentence | Low. It currently rewards stopping |
| **2** | **`get_transactions` returns its corpus span**, exactly as `get_net_worth_history` and `get_financial_snapshot` already do. Makes a windowed miss self-evidently partial. | tool contract / absence semantics | **none** — one field, existing pattern | Very low. Does not touch the live failure |
| **3** | **The retrieval-disposition sentence** (already written and measured). Fixes willingness, demonstrably not lens or window. | willingness | 73 tokens | Measured PARTIAL; not shipped |
| **4** | A clause on **escalating confidence** — before strengthening a causal claim, prefer the record over the series. | lens + calibration | one sentence, closer to doctrine | Medium. This is the only candidate that addresses the primary cause, and the one most at risk of becoming doctrine |
| **5** | Surface `evidenceCoverage.transactions` more prominently in the core. | awareness | none | **Low value** — §1 shows it is already there and was already ignored |

### Rejected

- **An intent router or causal-question taxonomy.** Forbidden, and it would encode "certain words
  mean call `get_transactions`" — the exact thing the product principle rules out.
- **Making `get_transactions` mandatory for any question mentioning an asset.** A routing table
  wearing a different hat.
- **A default window on `get_transactions`.** It would *create* the experiment's failure mode in
  the one tool that does not have it.
- **Prompting the model to always fetch before answering.** Measured already: the disposition
  experiment showed no over-retrieval, but "always fetch" would break the follow-up behaviour that
  20 turns proved correct.

---

## 11. A focused discriminating experiment

The primary cause has two plausible mechanisms and the instruction has a third. They are separable
in **one 2×2**, and it needs no code change — the instruction variant is injected at runtime, as
the previous two experiments did it.

**Question (fixed):** *"Do you think I sold crypto to pay off some of that debt?"*

| | shipped instruction | "unknown/unknowable" clause qualified |
|---|---|---|
| **standalone** (no preamble) | A | B |
| **after the aggregate-lens preamble** (replay T3, T4 first) | C | D |

5 trials per cell, 20 runs, gpt-5.1. **Marker: does the answer cite the Feb-27 amounts?** —
objective, and immune to the word-matching error that produced the 3/5 mistake (§7).

**What each contrast decides:**

- **A vs C** — isolates **conversational inheritance**. If A retrieves and C does not, the
  aggregate lens is sticky and the fix belongs near turn-level behaviour, not the instruction.
- **A vs B** — isolates the **instruction licence**. If B retrieves and A does not, intervention 1
  is sufficient on its own.
- **C vs D** — whether the instruction fix survives an inherited lens, which is the live condition.
- **D still failing** would mean the primary cause is genuinely lens selection, and none of
  interventions 1–3 reach it.

**Also worth one cell:** re-run T8 with the transactions already in context, to test whether
**calibration** improves on its own once the evidence is present, or whether the escalation is
independent of what is known.

---

## 12. Recommendation

**Fix intervention 2 now; run the experiment before touching anything else.**

- **Intervention 2 (corpus span on `get_transactions`) is worth doing regardless.** It is one
  field, it copies a pattern two sibling tools already use, it costs nothing, and it removes a
  contract weakness that has already produced three confident negatives in a measured corpus. It
  does not address the live failure and should not be sold as doing so.
- **Everything else waits on §11.** Two interventions have now been shipped or tested on a
  hypothesis about *why* the model stops, and one of my own measurements was wrong (§7). The
  distinguishing experiment is 20 cheap runs and it decides between three candidate causes that
  imply three different fixes.
- **Do not accept T8 as tolerable model behaviour.** Retrieval breadth is arguably a judgement
  call — a model may reasonably answer from a balance series. **Raising confidence without
  acquiring evidence is not a judgement call**, and it is the half of this failure least likely to
  be fixed by a retrieval intervention.

**Not a beta blocker.** No figure was wrong, the direction of the conclusion was right, and the
user could have asked a follow-up. What was lost is the difference between *"the evidence
suggests"* and *"transactions show"* — which is the difference the product exists to make.

---

## 13. Files changed

- **`docs/plans/AI-GPT51-CAUSAL-EVIDENCE-GAP-INVESTIGATION.md`** — this document. **Nothing else.**

No prompt, tool description, schema, route or model configuration was modified.
`AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md` should carry the §7 amendment; it is not edited here
so that this investigation lands as one reviewable change.

## 14. Probes run

| Probe | Established |
|---|---|
| Read the 9-turn live artifact | the failure chain, T5's self-declared gap, T8's evidence-free escalation |
| Read the sibling 4-turn session | `get_transactions` IS used unprompted with an explicit historical range — willingness is not the cause |
| `get_transactions` source read | **no default window**; `dateFrom` applied only when `from` is given |
| Four live tool calls against the real Space | the evidence retrieves with no date arguments; empty windowed result returns `rankingIsComplete: true` with no corpus span; the same-day payments total $13,450.65 |
| A2 evidence-body read | `evidenceCoverage.transactions` states AVAILABLE, span and count on every turn |
| Re-read of the 5 prior probe-C transcripts | the 3/5 was a word match on negative sentences — **0/5** actually retrieved |

**Measurement spend: ~$0.00** — all read-only, no model calls.
