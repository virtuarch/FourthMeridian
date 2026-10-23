# GPT-5.1 promotion dogfood gate

**Date:** 2026-09-13 · **Model:** `gpt-5.1` · **Arm:** A2, shipped runtime · **Space:**
`cmrrm846r000j7znwsl67gt1g` · **as-of:** 2026-09-12 · **17 user turns, one continuous session**

Evaluation only. **No repository behaviour changed**, no defect patched mid-session, no instruction
added. Session artifact: `tmp/gate/out/session.json` (gitignored; every figure below is quoted from
it). Runtime: thin core + `recent`/`activity` frames (25efa81), coverage envelope (55a2c22), memory
line (50de1aa), active-scenario envelope (c5874ea), 15 tools with the 7859d6c descriptions, Clip 6,
applied-facts boundary (54eb8e1).

> ## Verdict: **PROMOTE WITH KNOWN ISSUES — after one blocker is fixed.**
>
> Everything the last five slices built worked in a natural conversation, including the exact
> sequence that produced 1d67786. Scenario establishment, revision, and cross-turn continuity were
> flawless; the callback at turn 13 recovered $51,598.84 and $75,945.81 with no tool call and no
> recomputation, twelve turns after every raw tool result had been elided.
>
> One turn produced a **confident false negative on a factual question the data answers** (turn 6),
> and it is not a new subsystem — it is the known newest-first ranking defect, reaching the primary
> evidence instead of the secondary. That is the single thing to fix first.
>
> Cost: **$0.1974 for 17 turns — $0.0116/turn**, 80.2% of prompt tokens cached, zero unpriced
> invocations.

---

## 1–2. Session

17 user turns, 28 provider invocations, 12 tool calls, **0 turn errors, 0 failed tool calls, 0
malformed arguments**.

## 3. Experience verdict

It reads as a financially informed conversation, not a report generator. It opened with a broad
assessment nobody had to ask twice for, moved into spending, back to January, into a causal
question, into a projection, a scenario, a revision, advice, a goal check, a callback, and a
correction — and inherited context at each step without being told to. Judgments are hedged where
they should be (*"probably"*, *"if this continues"*, *"held flat in the projection"*) and firm where
the data is firm. Two answers ran long; none was evasive, and none refused to reason because
uncertainty existed.

## 4. Turn by turn

| # | turn | tools | verdict |
|---|---|---|---|
| 0 | *"How am I looking financially?"* | — | **PASS** — broad read off the orientation, both frames labelled, $750k goal referenced |
| 1 | *"What changed over the last month?"* | `explain_net_worth_change` | **FAIL** — §6, levels narrated as a change |
| 2 | *"How's my spending been lately?"* | `get_spending` | **PASS** — monthly series, August spike explained by merchant |
| 3 | *"Am I spending more than usual?"* | — | **PASS** — compared months, not raw totals; reused the in-window breakdown |
| 4 | *"What was going on with me back in January?"* | `get_net_worth_history` | **PASS** — full historical balance sheet, no future leakage |
| 5 | *"Do you think I sold crypto to pay off some of that debt?"* | `get_spending`, `get_transactions` | **PASS_WITH_NOTE** — searched Dec–Jan (the conversation's frame), found nothing there, **scoped the claim and offered to widen** |
| 6 | *"Can you check? I'm fairly sure I cashed out some crypto this year."* | `get_transactions` | **FAIL** — §6, right window, paged off the evidence, confident negative |
| 7 | *"Where do you think I'll be by end of year?"* | `project_cash`, `get_financial_snapshot` | **PASS** — $35.9k deterministic, assumptions stated, explicit "does not predict markets" |
| 8 | *"…assume about $15k hits my account on the 7th."* | `scenario_projection` | **PASS** — REPLACE, active = 50,898.84 |
| 9 | *"Actually it'll be closer to $15.7k after FICA."* | `scenario_projection` | **PASS** — REPLACE, active = 51,598.84, `-15700` in assumptions |
| 10 | *"How much should I keep liquid versus invest?"* | — | **PASS** — advice on $51.6k from the envelope, no baseline resurrection |
| 11 | *"What about by February?"* | `project_cash` | **PASS_WITH_NOTE** — §7, correct arithmetic done in prose where the ledger could have done it |
| 12 | *"How does this affect my 2029 goal?"* | `scenario_goal_seek` | **PASS** — carried `-15700` forward; reported the target **infeasible** rather than inventing a rate |
| 13 | *"What was that year-end number again, with the bonus?"* | — | **PASS** — §10, the gate's sharpest result |
| 14 | *"Do you still remember what my actual goal is?"* | — | **PASS** — $750,000 by 2029-12-31 |
| 15 | *(correction: "savings $12,345 can't be a chunk of an $11k jump")* | — | **PASS** — §15, full, specific retraction |
| 16 | *"Overall, how am I actually doing?"* | — | **PASS** — synthesis, no new figures invented |

**13 PASS · 2 PASS_WITH_NOTE · 2 FAIL.**

## 5. Tool use

`explain_net_worth_change` 1 · `get_spending` 2 · `get_net_worth_history` 1 · `get_transactions` 2 ·
`project_cash` 2 · `get_financial_snapshot` 1 · `scenario_projection` 2 · `scenario_goal_seek` 1.
Not used: `get_income`, `get_investments`, `recall`, `remember`, `reconcile_projection`,
`get_pay_dates`, `investment_scenario`.

**Necessity:** every call was warranted. **No redundant calls, no failures, no malformed arguments.**
7 of 17 turns used no tool and were right not to — the figures were in the envelope or the
still-retained window. `recall` was never needed because the memory line already carried the goal;
`remember` was never needed because the user stated no new durable intention.

## 6. Financial-truth failures

### FAIL — turn 1: a composition narrated as a change (**MAJOR, newly discovered**)

The model asked `explain_net_worth_change{date: 2026-09-12, lens: 'net-worth'}` and got a
**composition of the position on that date**:

```jsonc
{ "value": 38957.23, "unexplainedRemainder": 19341.08,
  "components": [ {"label":"Investments","value":5005.89}, {"label":"Crypto","value":null},
                  {"label":"Cash","value":2264.46}, {"label":"Savings","value":12345.80} ] }
```

It then wrote: *"**Savings component on the date: $12,345.80** — That's a big, stable chunk of the
net worth jump"* and *"**unexplained remainder of $19,341.08** … crypto price movement is almost
certainly a major driver"*. Both are **balances**, presented as contributions to an $11,242 change.
$12,345.80 cannot be a component of $11,242.40.

**This is a name-vs-capability mismatch of exactly the class 7859d6c fixed elsewhere.** The tool is
called `explain_net_worth_**change**`, its description ends *"Use for 'why did my net worth drop'"* —
and it takes **one `date`**, hard-codes `fromISO: dateISO, toISO: dateISO`, and has no comparison
parameter. It cannot compute a change. Its own payload says so (*"This is ONE component of the
position on that date"*) and the model read past it.

Bounded: every number quoted is a real balance, and the model retracted completely when challenged
(§15). But the attribution was materially wrong and unprompted.

### FAIL — turn 6: right window, paged off the evidence (**BLOCKER, known defect class**)

User: *"Can you check? I'm fairly sure I cashed out some crypto at some point this year."*

The model chose the **correct** window — `get_transactions{from: 2026-01-01, to: 2026-09-12,
flow: transfers, limit: 50}` — which **contains** the 2026-02-27 Coinbase inflows. The result:

```
shown: 50   moreAvailable: true   (default sort: newest-first)
oldest row returned: 2026-03-03
coverage: { transactionsAvailableFrom: "2024-07-18", …, windowCoversAvailableRecord: false }
```

**The 50 newest transfers stop three days short of the evidence.** The model then wrote *"Your bank
transactions Jan–Sep 2026 don't show obvious crypto off-ramps"* — a confident negative over a window
it searched but only sampled. `moreAvailable: true` and `windowCoversAvailableRecord: false` were
both in the result and neither was acted on. `text: 'coinbase'` would have returned both rows.

This is **the known newest-first ranking defect** (banked from 0c0a84b as a card-payment issue),
reaching the **primary** evidence. It is a blocker by outcome: a normal conversational sequence
produced a materially false factual claim about the user's own history.

**No other financial-truth failure occurred.** Every deterministic figure quoted in the session
matches its tool result to the cent.

## 7. Projection

`project_cash` to 2026-12-31 → **$35,898.84**, with the opening cash, income and spending basis
named, investments explicitly *"held flat in the projection (no price moves assumed)"*, and the
caveat *"does not try to predict crypto or market moves"*. Net worth framed as an implication of
those assumptions, not as a forecast. **PASS.**

## 8. Scenario establishment

Turn 8, from a natural sentence with no leading: `scenario_projection{to: 2026-12-31,
outflows: [{onDate: 2026-12-07, amount: -15000, label: 'completion bonus (cash inflow)'}]}` →
`REPLACE`, active liquid **50,898.84** = baseline + 15,000.00 exactly. **PASS** — 7859d6c holding in
free conversation, not just in the A/B.

## 9. Scenario revision

Turn 9, *"Actually it'll be closer to $15.7k after FICA"* — the exact 1d67786 failure point.
`scenario_projection` re-run with `-15700` → `REPLACE`, active **51,598.84 / 75,945.81**. **No prose
adjustment, no $700 added by hand.** **PASS.**

## 10. Active-scenario continuity

The gate's sharpest result. At turn 13, twelve turns after the scenario ran:

- **all 12 tool messages in the transcript were elision stubs**; `51598.84` appears in **no** tool
  message;
- exactly **one** envelope, 396 bytes, at the tail;
- the model answered *"$51,598.84 … $75,945.81"* with **no tool call and no recomputation**, in 2.7 s
  for $0.0043.

The 1d67786 failure is fully inverted: the deterministic result, not the superseded baseline, is what
survives and is what gets used. The envelope stayed correct and unchanged through turns 10–16,
including two turns that called other tools.

## 11. Historical reasoning

Turn 4 retrieved the January balance sheet in full — net worth ~$11.2k, debt $32,576, liquid ~$8.1k,
traditional ~$3.6k, crypto ~$32.1k — contrasted it with today, and characterised the period
correctly (*"lots of crypto, lots of debt, a thin cushion"*). No future leakage; no figure after the
ceiling. **PASS.**

## 12. Transaction / causal reasoning

Turn 5 is the improvement and turn 6 is the defect, and they are worth reading together.

At turn 5 the model inherited the conversation's January frame and searched `2025-12-15..2026-01-31`
— the wrong period for the February evidence. But it did **not** produce the bb2f6ec failure: it said
*"I don't see direct evidence … **in that December–January window**"*, and offered *"we can zoom out
over a longer window (e.g. through spring) and search specifically for exchange-related transfers"*.
**That is 55a2c22 working exactly as designed** — a windowed absence stayed a windowed absence.

At turn 6 the user took that offer, the model widened correctly, and **paging** — not framing, not
disclosure, not willingness — hid the evidence (§6).

**R2→R3 calibration did not misfire.** Across both turns the model stayed at *"plausible"*, separated
price movement from sales, and never asserted intent. The known causal-overclaim risk did not
materialise here — arguably because it never reached the evidence that triggers it.

## 13. Memory

Turn 14 recalled $750,000 by 2029-12-31 correctly from the memory line, with no `recall` call needed
and **no duplicate or contradictory goal**. No financial measure was written to memory during the
session. `checkpointProjection` fired silently for `project_cash` as designed; `scenario_projection`
wrote nothing. **PASS.** The standing-preference defect did not arise naturally and was not probed.

## 14. Clip 6 / long context

56 transcript messages, 12 tool messages, **12 elided**. Prompt tokens per turn peaked at 51,096
(turn 7) and settled to ~12,000 once tool payloads aged out — compaction doing its job. The turn-13
callback proves the important property: **normal callbacks did not break, and the thing that carried
them was structured state, not surviving prose.**

## 15. Correction and recovery

Turn 15 challenged the turn-1 misattribution. The reply:

> *"You're absolutely right… I treated that $12,345.80 as if it were 'the amount your savings
> increased over the month.' In reality, that's just the **level** of your savings on that date, not
> the *change*… **a $12,345 savings balance can't be 'a chunk of' an $11,242 change** without knowing
> what it was before. I over-interpreted."*

It named the error, explained the mechanism, enumerated what the data could and could not support,
and did not defend the original answer. **PASS**, and it independently confirms the §6 diagnosis.

## 16. Conversational quality

Strong. Natural inheritance across all 17 turns; hedging proportionate; the January→today contrast
(*"January-you couldn't realistically talk about $750k. September-you can"*) is the kind of framing a
report cannot produce. Weaknesses: turns 12 and 16 are long, and several answers end with a menu of
next steps that becomes repetitive. **MINOR.**

## 17. Cost and latency

Fully measured — `executeTurn` runs through `lib/ai/provider`, so `AiInvocation` captured every
invocation. **28 rows, 0 unpriced.** Subset-aware pricing (Slice 2), uncached = prompt − cached.

| | |
|---|---|
| Provider invocations | 28 (17 turns) |
| Prompt tokens | 343,412 |
| — cached | **275,456 (80.2%)** |
| — uncached | 67,956 |
| Completion tokens | 7,803 |
| Reasoning tokens | **0** |
| Tool calls | 12 |
| **Total cost** | **$0.1974** |
| Mean / median per turn | **$0.0116 / $0.0119** |
| Highest turn | $0.0248 (turn 7, 51,096 prompt tokens, 3 invocations) |
| Provider latency | 128.3 s total, 7.5 s mean per turn |

For scale: the whole 17-turn session costs about what **two** gpt-5.5 turns cost in the Cost Clip 4
corpus. Economics remain materially favourable.

## 18–19. Defects

| severity | defect | new or banked |
|---|---|---|
| **BLOCKER** | **`get_transactions` newest-first paging hides in-window evidence, and `moreAvailable: true` is not acted on.** Turn 6: correct window, `shown: 50`, oldest row 2026-03-03, evidence at 2026-02-27, answer *"don't show obvious crypto off-ramps"*. | **Banked class, new reach.** Known as card-payment ranking (0c0a84b); this is the same defect hitting the **primary** evidence. |
| **MAJOR** | **`explain_net_worth_change` is named for a change it cannot compute.** One `date`, `fromISO === toISO`, no comparison parameter, description invites *"why did my net worth drop"*. Turn 1 narrated balances as contributions to a change. | **Newly discovered.** Same class as the 7859d6c contract defect. |
| **MAJOR** | **A horizon change left the ledger.** Turn 11 (*"What about by February?"*) called `project_cash{to: 2027-02-28}` and added the $15.7k **in prose**; `scenario_projection{to: 2027-02-28, outflows:[…]}` was exactly representable, and the active scenario still says `to: 2026-12-31`. Arithmetic correct ($53,901 + $15,700 → *"~$94k"* net worth), envelope honestly labelled — but code did not own the money. | **Newly discovered.** 7859d6c fixed establishment and amount-revision; **horizon revision was not covered.** |
| **MINOR** | Long answers and repetitive "next steps" menus on turns 12 and 16. | New, cosmetic. |
| **OBSERVATION** | Turn 5 inherited the conversation's January frame rather than the question's subject. Did **not** cause a false claim — the answer was scoped and offered to widen. | Banked (bb2f6ec / a774989 frame inheritance); **now bounded by 55a2c22.** |
| **OBSERVATION** | R2→R3 causal overclaim **did not occur**. The model held at *"plausible"* and separated price from sales throughout. | Banked; did not surface. |
| **OBSERVATION** | Standing-preference memory shape never arose. Weekday scenario primitive deliberately not exercised. | Banked; out of scope. |

## 20–21. Verdict — **PROMOTE WITH KNOWN ISSUES, after the blocker**

Against the promotion standard:

| criterion | |
|---|---|
| Broad current-state reasoning trustworthy | **yes** — turns 0, 2, 3, 16 |
| Historical reasoning works naturally | **yes** — turn 4, no leakage |
| Deterministic projections used when calculation matters | **mostly** — 4 of 5 money moments; turn 11 is the exception |
| Scenario establishment / revision / continuity | **yes, all three, cleanly** |
| No stale financial result silently became current | **yes — zero occurrences**, and turn 13 proves the mechanism |
| Memory authority clean | **yes** |
| Compaction did not break callbacks | **yes** — 12/12 elided, callback exact |
| Remaining defects bounded and independently fixable | **yes** |
| Economics materially favourable | **yes** — $0.0116/turn, 80% cached |

Against the blocking conditions: no materially false *current* state, no stale scenario used, no
scenario assumptions lost, no historical leakage, no memory override, and recovery after correction
was excellent. **One blocking condition is met:** a normal sequence produced a materially false
factual claim — not about current state, but about the user's own transaction history, stated
confidently, on a question the data answers.

That one is narrow, understood to the row, and already the top of the banked list. Everything the
recent slices were built to protect held under free-form use.

## 22. Smallest promotion scope, once the blocker is closed

Promote the **A2 conversation runtime as it stands** — thin core with both measured frames, coverage
envelope, memory line, active-scenario envelope, the 15-tool surface, Clip 6, gpt-5.1 — behind the
existing frozen route, with **no prompt or tool changes**, and with the two MAJOR defects carried as
known issues. Nothing in this session argues for shipping less than the whole runtime; the defects
are tool-contract and tool-ranking issues inside it, not architectural ones.

## 23. The one blocker to solve first

**`get_transactions` must not let a correct window return a confident absence.** The evidence was in
scope and was cut off by a 50-row newest-first page while `moreAvailable: true` sat unread in the
same payload. That is one tool's ordering-and-completeness contract — the same shape of problem
55a2c22 solved for *window* coverage, now needed for *page* coverage. It should be the next slice,
and this gate should be re-run after it.

---

**Working-tree note:** uncommitted UI edits in `app/`, `components/` and `app/globals.css` belong to
another session. They were not read, modified, staged or committed by this gate, and this commit
contains only this document.
