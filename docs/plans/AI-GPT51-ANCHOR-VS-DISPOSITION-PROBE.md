# Anchor vs disposition — where GPT-5.1's transaction window comes from

**Date:** 2026-09-09 · **Model:** `gpt-5.1` · **Arm:** A2, cell-A condition (no preamble, shipped
instruction) · **Space:** `cmrrm846r000j7znwsl67gt1g` · **as-of:** 2026-09-08 · 5 trials

Authority: `AI-GPT51-CAUSAL-EVIDENCE-GAP-INVESTIGATION.md` (658cfd2), the 2×2 (bb2f6ec), the
corpus-span implementation and rerun (55a2c22).

**Probe only. No repository code changed** — the anchor lives in the gitignored experiment harness;
`git status` shows no tracked modification outside `docs/`.

**Result in one line: the window is copied, not chosen — but only from one field.**
12 of 12 `get_transactions` calls used `recent.window` to the exact day. The injected irrelevant
range attracted **0/12** calls and **0/5** mentions. Neither H1 nor H2 survives in the form stated;
§5 gives the reading that does.

---

## 1. The anchor

Injected into the A2 orientation body immediately after `recent`, structurally identical to it, and
carrying **no financial claim** — no amount, no account, no total, so nothing about it can make a
figure in the orientation false:

```jsonc
 "recent": {
  "window": { "from": "2026-06-11", "to": "2026-09-08", "days": 90 },   // the real thin core
  "income": 32704.32, "spending": 12342.56, ...
 },
 "interface": {
  "lastViewedRange": { "from": "2025-10-01", "to": "2025-10-31", "days": 31 }   // ← injected
 },
```

October 2025 is inside the transaction corpus (`2024-07-18..2026-09-08`), so a search there returns
real rows; it is nowhere near the Feb-27 event, is not February, and has no bearing on a crypto/debt
causal question. **`recent.window` was left in place** — the point is to see which one wins.

Verified before running: every other key in the body is byte-identical with and without the
injection, and the anchor sits between `recent` and `netWorthHistory`.

Nothing else moved: same model, same system instruction and unknown/unknowable clause, same tool
schemas and descriptions, same coverage metadata, same compaction, same question
(*"Do you think I sold crypto to pay off some of that debt?"*), no preamble.

---

## 2. The five trials

| | first window class | first window | gt calls | tool calls | hops | latency | noticed `covers:false` | widened | unwindowed | Feb-27 | cites |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **t1** | `ANCHOR_RECENT` | `2026-06-11..2026-09-08` text=crypto flow=transfers | 2 | 5 | 2 | 12.8 s | no | no | no | no | 0/3 |
| **t2** | `ANCHOR_RECENT` | `2026-06-11..2026-09-08` flow=transfers | 3 | 3 | 2 | 11.2 s | no | no | no | no | 0/3 |
| **t3** | `ANCHOR_RECENT` | `2026-06-11..2026-09-08` flow=transfers | 2 | 4 | 2 | 8.4 s | **yes** | no | no | no | 0/3 |
| **t4** | `ANCHOR_RECENT` | `2026-06-11..2026-09-08` flow=transfers | 2 | 4 | 2 | 12.0 s | no | no | no | no | 0/3 |
| **t5** | `ANCHOR_RECENT` | `2026-06-11..2026-09-08` text=Coinbase flow=transfers | 3 | 3 | 2 | 12.1 s | **yes** | no | no | no | 0/3 |
| | **5/5 ANCHOR_RECENT** | | **12** | 3.8 avg | 2.0 | 11.3 s avg | **2/5** | **0/5** | **0/5** | **0/5** | **0/5** |

`ANCHOR_INJECTED`: **0/5**. `ANCHOR_OTHER`: 0/5. `GENERATED_BOUNDED`: 0/5. `UNWINDOWED`: 0/5.
`NO_TRANSACTION_CALL`: 0/5.

### 2.1 Every `get_transactions` call, exactly

| trial | from | to | text | flow | sort | shown | `windowCoversAvailableRecord` |
|---|---|---|---|---|---|---|---|
| t1 | 2026-06-11 | 2026-09-08 | crypto | transfers | — | 0 | false |
| t1 | 2026-06-11 | 2026-09-08 | — | card_payments | — | 45 | false |
| t2 | 2026-06-11 | 2026-09-08 | — | transfers | — | 15 | false |
| t2 | 2026-06-11 | 2026-09-08 | — | card_payments | — | 45 | false |
| t2 | 2026-06-11 | 2026-09-08 | — | spending | — | 3 | false |
| t3 | 2026-06-11 | 2026-09-08 | — | transfers | — | 15 | false |
| t3 | 2026-06-11 | 2026-09-08 | — | card_payments | — | 45 | false |
| t4 | 2026-06-11 | 2026-09-08 | — | transfers | — | 15 | false |
| t4 | 2026-06-11 | 2026-09-08 | — | card_payments | — | 45 | false |
| t5 | 2026-06-11 | 2026-09-08 | Coinbase | transfers | — | 0 | false |
| t5 | 2026-06-11 | 2026-09-08 | — | card_payments | — | 45 | false |
| t5 | 2026-06-11 | 2026-09-08 | Robinhood | transfers | — | 0 | false |

**12 calls. 12 identical windows. Not one boundary shifted by even a day.**

### 2.2 The copying is not confined to `get_transactions`

Every date argument the model produced in the whole probe, across every tool:

```
get_spending    ({from: "2026-06-11", to: "2026-09-08"})     ×3
get_transactions({from: "2026-06-11", to: "2026-09-08", …})  ×12
get_investments ({asOf: "2026-06-11"})                       ×1     ← t1
get_investments ({asOf: "2026-09-08"})                       ×1     ← t1
get_investments ({})                                         ×2
```

`recent.window.from` was pasted into an `asOf` on a different tool, where it means "value the
portfolio on this date" — a parameter with no relationship to a 90-day activity window. The model is
not selecting a period; **it is filling date-shaped parameters from the two date-shaped values in
front of it.**

### 2.3 Did the model treat the injected range as relevant?

**No, in any sense.** Zero of the five answers mention October, `2025-10`, the last-viewed range, or
the `interface` block at all. The anchor was neither borrowed mechanically nor reasoned about. It was
ignored.

### 2.4 The unplanned natural experiment

`recent.window.from` is `startOfDay(-90)` — **90 days before the wall clock**, not before `asOf`. The
2×2 runs executed on 2026-09-08, when the field read `2026-06-10`; this probe ran on 2026-09-09, when
it reads `2026-06-11`.

| | context field said | model's `from` |
|---|---|---|
| run 2 (2026-09-08), cells A+B | `2026-06-10` | **14/16 calls `2026-06-10`**, 2 at `2026-06-11` |
| this probe (2026-09-09) | `2026-06-11` | **12/12 calls `2026-06-11`** |

The copied value moved when the field moved. That was not designed, and it is the strongest single
piece of evidence here: the window is not a stable habit ("about three months back"), it is a
**read** of a specific field that tracks that field's drift.

### 2.5 Register, and what the model said about its own boundary

Same classification scheme as bb2f6ec.

| | register | note |
|---|---|---|
| t1 | **R0 asserted** | *"probably not, at least not in the last 90 days"* + *"It looks like you kept the crypto stack while attacking the cards from income/cash"* |
| t2 | R0 hedged | *"I can't actually see any crypto sales in the data you sent, so I can't say"* |
| t3 | **R0 asserted** | *"probably not… the observed pattern is 'big recent debt paydowns funded by income'"* — then *"If you want, I can widen the wi[ndow]"* |
| t4 | R0 hedged | *"the pattern is consistent with you using salary and bank cash… It's still possible there were crypto sales"* |
| t5 | R0 hedged | *"It's **not evidenced in the last 90 days**… It's still possible you sold crypto **before June 11**"* |

**R0 hedged 3 · R0 asserted 2 · R1↑ 0 · R2 0 · R3 0** — identical to run-2 cell A. The corpus-span
effect measured in 55a2c22 reproduces and does not degrade under the injected anchor.

t5 is the sharpest specimen in three experiments:

> *"I can **widen the search back to when your crypto balances started dropping** to see if there's a
> clear 'sell → bank deposit → card payoff' chain."*

It names the correct search, derives the correct starting point from evidence it already holds, and
then stops and asks. **It is not that the model cannot find February. It is that it will not go
there without being told to.**

### 2.6 Cost

**Unmeasured.** `AiInvocation` recorded zero rows again, for the reason established in 55a2c22 §3.5:
the experiment harness calls the OpenAI SDK directly and never reaches `lib/ai/provider.ts`. Hops
(2.0 avg) and latency (11.3 s avg) are the only efficiency figures, and the higher latency here vs
run-2 cell A (7.8 s) sits alongside a *lower* hop count, so it is provider-side variance, not extra
work.

---

## 3. Did the irrelevant anchor attract retrieval?

**No. 0/12 calls, 0/5 answers.** By the brief's primary discriminator, **H1 as stated is not
supported**: the model does not select a window by copying *the most salient explicit date range in
context*. A second explicit range, structurally identical and adjacent, exerted no pull at all.

## 4. Did `recent.window` still dominate?

**Totally. 12/12, to the day, plus every date argument on two other tools.** By the brief's
discriminator this points at H2 — except H2 as stated ("a general preference for bounded/recent
searches") does not fit either, because the earlier C/D cells searched **January**, which is neither
recent nor self-generated. It was the conversation's frame.

## 5. Interpretation — neither hypothesis, and the brief said not to force it

The two hypotheses share a false premise: that the model is *choosing* a window. Across three
experiments and 45 trials it has never once done so. It fills the date parameters from **whatever
frame the context already establishes**:

- **No conversation to inherit** → the orientation's own `recent.window`. 12/12 here, 14/16 in run 2,
  and the value tracks the field's daily drift (§2.4).
- **A conversation to inherit** → that conversation's period. January, in every C/D trial.
- **A visible range that frames nothing** → ignored entirely. 0/12 here.

So the operative rule is not *salience* (H1) and not *recency* (H2). It is **frame inheritance**: the
model adopts the temporal frame that the surrounding evidence or conversation has already
established, and never asks whether the question needs a different one. The injected anchor was
correctly ignored precisely because it framed nothing — that is the model behaving *well*, and it is
why H1 fails.

Against the brief's three H2 sub-diagnoses, the fit is unambiguous:

| preference for recency | **No.** C/D chose January, four months before the "recent" window, whenever the conversation pointed there |
| preference for bounded searches | **Descriptively true, causally empty.** 39/39 windowed calls across three experiments, and 0 unwindowed — but this is the symptom, not the reason |
| **inability to choose a question-relevant historical window** | **Yes.** The question names no date. February is derivable only from evidence the model has not yet fetched. Faced with "I don't know when", it does not treat that as a reason to search unbounded — it reuses the frame it was handed |

The corpus-span field (55a2c22) makes the consequence of an inherited frame **visible** — 2/5 answers
here scope the negative to the window and one quotes the boundary date back — without making the
model **replace** the frame. Disclosure and choice are separate faculties, and only the first has
been given a mechanism.

One boundary this probe does **not** settle: whether `recent.window` won because it is structurally
privileged (first, financial, attached to the figures) or because a last-viewed-UI-range is
*correctly* irrelevant to a money question. A single non-attracting anchor cannot separate "copies
only the financial frame" from "copies only a relevant frame". §6 is designed around that.

---

## 6. Smallest next experiment

**The anchor field is identified. Do not change it yet.**

The field is `recent.window`, from `thinCore()` in `scripts/ai-baseline/evidence.ts:129`:

```ts
recent: txn ? { window: { from: txn.startDate, to: txn.endDate, days: txn.windowDays }, … }
```

sourced from the `TRANSACTIONS_SUMMARY` assembler's default `ASSESSMENT_WINDOW_DAYS = 90` rolling
window (`lib/ai/assemblers/transactions.ts:232`, W4). That constant is **load-bearing for
`computeAssessment`** — W4's own doctrine records that varying it changed graded conclusions on the
live corpus. It must not be touched to fix a retrieval symptom, and nothing here proposes to.

**The next probe, 5 trials, one variable, no code change:**

> Ask the same question with `recent.window` **carrying a different range** — a real, longer
> orientation window (say 365 days) that still frames the same figures truthfully. Does the copied
> window follow it?

- **If it follows** → the model copies *the financial frame*, whatever it says, and the intervention
  space is "what frame does the orientation establish", which is a context-composition question with
  a real product cost (a 365-day assessment window is a different assessment).
- **If it does not follow** → `recent.window` is not the anchor per se and something narrower is
  (position, the word "recent", the 90-day framing), which changes what any fix would target.

Either way the answer is needed **before** anyone proposes changing what the orientation shows, and
it costs five trials.

A second, independent question worth its own five trials, because §2.5 t5 makes it cheap to test:
**the model repeatedly offers to widen and waits.** Whether that is disposition or an unstated
belief that widening needs permission is untested, and the two call for entirely different work.

**Explicitly not proposed:** automatic widening, a default window, mandatory unwindowed search,
routing, a causal taxonomy, date-selection code, any change to `ASSESSMENT_WINDOW_DAYS`,
`recent.window`, the system instruction, the tool description, or coverage metadata.

---

## 7. Threats

- **n = 5.** The 12/12 and 0/12 figures are unambiguous at this n; nothing else here is.
- **One anchor, one flavour.** `interface.lastViewedRange` is transparently non-financial. A neutral
  range that framed *financial* content would test something different, and §6 is the cheaper first
  question.
- **The natural experiment in §2.4 was not designed.** It rests on one field moving one day between
  two runs, with 14/16 vs 12/12 as the evidence. It is corroborating, not decisive.
- **Register classification is by reading**, per trial, listed in §2.5 so it can be audited. The
  mechanical markers (windows, rows returned, amount citation) are asserted on tool results.
- **Cost unmeasured** (§2.6).
- **Runs are hours apart** against the same model string; provider drift is uncontrolled.

---

## 8. What this probe changed

**No repository code.** The anchor and harness live in gitignored `tmp/causal/`. This document is the
only artefact. No production or runtime behaviour was modified, and no fix was implemented.
