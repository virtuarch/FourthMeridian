# GPT-5.1 causal-evidence experiment — the discriminating run

**Date:** 2026-09-09 · **Model:** `gpt-5.1` · **Arm:** A2 (thin core + coverage envelope + memory
line, 15 tools, Clip-6 compaction) · **Space:** `cmrrm846r000j7znwsl67gt1g` · **as-of:** 2026-09-08

Follows `AI-GPT51-CAUSAL-EVIDENCE-GAP-INVESTIGATION.md`. **Experiment only.** No product or runtime
change shipped. The only injected difference is the one instruction clause named in §2; the harness
lives in gitignored `tmp/causal/` and nothing outside `docs/` is committed by this work.

**Control honoured:** `get_transactions` corpus-span metadata was **not** added before this run.
That control turned out to be the most important design choice in the experiment — see §7.

---

## 1. What was being discriminated

The investigation left two candidate causes for the live failure, and could not separate them from
one session:

| H1 | The **stopping clause** (*"If something is unknown or unknowable, say so once and move on"*) licenses stopping at the balance layer |
| H2 | **Inherited aggregate context** — an aggregate lens established earlier in the conversation persists into a question that needs the event record |

2 × 2, 5 trials per cell, one fixed causal question.

| Cell | Preamble | Instruction clause |
|---|---|---|
| **A** | none | shipped |
| **B** | none | variant |
| **C** | aggregate preamble | shipped |
| **D** | aggregate preamble | variant |

**Causal question (identical in all 20 trials):**
> *"Do you think I sold crypto to pay off some of that debt?"*

**Preamble (C, D only):** *"What was going on with me financially around January this year?"* → *"sure"*
→ causal question. Turns 1–2 establish the aggregate lens; turn 3 is the measured turn.

---

## 2. The instruction variant, verbatim

```
shipped:  If something is unknown or unknowable, say so once and move on.
variant:  If something cannot be established from what you have or from the
          tools, say so once and move on.
```

That is the whole difference. No causal doctrine, no transaction-specific language, no tool
routing, no "always retrieve", no intent taxonomy, no confidence doctrine. 15 words vs 13; the
variant relocates the *unknowability* judgement from the world to the evidence at hand.

---

## 3. The marker — and why it is not word presence

The prior experiment's Coinbase marker tested for the **word**, and the word appeared inside
sentences *denying* the evidence (see §0 of `AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md`, amended
today). This run therefore asserts on the **tool result**, not the prose:

- **Transaction retrieval:** a `get_transactions` call on the *measured turn* (not anywhere in the
  trial — a preamble call does not count).
- **Feb-27 evidence:** the tool **returned** a row dated `2026-02-27` from Coinbase.
- **Event-payment retrieval:** the tool returned the Feb-27 card payments.
- **Citation:** `$8,141.98`, `$1,902.12` or `$10,044.10` in the answer — figures obtainable only
  from those rows.

The ground truth, re-verified against the live corpus before scoring (`tmp/causal/verify2.ts`):

```
2026-02-27   8,141.98   REAL TIME TRANSFER RECD ... FROM: COINBASE
2026-02-27   1,902.12   REAL TIME TRANSFER RECD ... FROM: COINBASE
                       inflow total   10,044.10
2026-02-27   5,000.00 / 4,000.00 / 3,450.65 / 1,000.00  card payments
                       payments total 13,450.65
                       shortfall       3,406.55
```

And the control fact that governs everything below:

```
get_transactions({text:'coinbase', sort:'largest'})   with NO `from`
  -> 18 rows, window {from: null, to: '2026-09-08'}   including both Feb-27 rows
```

**No window is needed to find the evidence. A window is what hides it.**

---

## 4. Primary matrix — 2 × 2 × 5

| | **A** no preamble / shipped | **B** no preamble / variant | **C** preamble / shipped | **D** preamble / variant |
|---|---|---|---|---|
| **Transaction retrieval** (measured turn) | **5/5** | **5/5** | **3/5** | **2/5** |
| `get_transactions` anywhere in trial | 5/5 | 5/5 | 4/5 | 4/5 |
| **Feb-27 evidence returned** | **0/5** | **0/5** | **0/5** | **0/5** |
| **Feb-27 citation in prose** | **0/5** | **0/5** | **0/5** | **0/5** |
| **Event-payment retrieval** (Feb-27 payments) | **0/5** | **0/5** | **0/5** | **0/5** |
| any `flow: card_payments` call at all | 2/5 | 0/5 | 0/5 | 1/5 |
| **R0 hedged absence** | 2 | 3 | 1 | 1 |
| **R0 asserted absence** | 3 | 2 | 4 | 2 |
| **R1↑ affirmative, balance evidence only** | 0 | 0 | 0 | **2** |
| **R2 "transactions show"** | **0** | **0** | **0** | **0** |
| **R3 "X caused Y"** | 0 | 0 | 0 | 0 |
| avg tool calls, measured turn | 5.2 | **2.4** | 2.6 | 2.8 |
| avg model hops, measured turn | 3.8 | **2.6** | 3.4 | 2.8 |
| avg hops, whole trial | 3.8 | 2.6 | 7.4 | 6.6 |
| avg latency, measured turn | 9.3 s | **6.4 s** | 8.5 s | 9.3 s |
| avg latency, whole trial | 9.3 s | 6.4 s | 34.1 s | 35.3 s |

**Registers** (per the investigation §9): R1 *"the evidence suggests X"* (balance series) · R2
*"transactions show X"* (event record) · R3 *"X caused Y"* (nothing available). **R0** is the
negative form this experiment produced and the investigation had no cell for. **R1↑** is an
affirmative stated above the strength its evidence licenses.

### 4.1 The windows chosen — every one of them

28 `get_transactions` calls across the measured turns. **28/28 supplied a `from`. 0/28 omitted it.**

| Cell | windows |
|---|---|
| **A** | `2026-06-10..2026-09-08` × 15 — *every call, every trial* |
| **B** | `2026-06-10..2026-09-08` × 5 — *every call, every trial* |
| **C** | `2025-12-20..2026-02-05`, `2026-01-01..2026-01-31` × 2, `2025-12-15..2026-02-15` × 3 |
| **D** | `2026-01-01..2026-01-31` × 2, `2025-12-15..2026-02-15` |

`2026-06-10..2026-09-08` is **exactly** the A2 thin core's `recent.window` — the 90-day span
printed in the context every turn. Cells A and B did not choose a window; they **inherited the only
one on the page**. Cells C and D moved off it, onto the *preamble's* topic (January), and landed
just as wrong — the evidence is in **late February**.

Re-verified: **every window chosen was genuinely empty of Coinbase rows.** The tool answered each
question correctly. The questions were the wrong ones.

### 4.2 What the answers actually said

Confident false negatives, in 11 of the 18 negative answers:

- **A t1** — *"I searched transfers for 'coinbase', 'binance', 'kraken', and 'crypto' and found **no
  matches** in that window."*
- **A t4** — *"**probably not**, at least not in the last ~3 months … Crypto balance went up, not
  down."*
- **B t5** — *"Short answer: **probably not**."*
- **C t1** — *"I **don't** see evidence that you sold crypto to pay the debt; it looks like you
  mostly used **income and bank cash**."*
- **D t2** — *"**no transfers from a crypto platform into your bank** in January."*
- **D t4** — *"You **almost certainly did not** sell much (if any) crypto to make those January debt
  payments."*

And two affirmatives reached **without** the event record — both in D, both from the balance series
alone, both stated above R1 strength:

- **D t1** (never called `get_transactions` on any turn) — *"**yes, almost certainly some of it**"*,
  built from Jan 31 → Apr 30 debt −$26.8k against crypto −$16k.
- **D t3** — *"**yes, it's very likely** you sold or moved some crypto in that period to help reduce
  debt, but we can't say this exact sale paid that exact card."*

D t3 is the most interesting single trial in the experiment: it reaches the right conclusion, from
the wrong layer, and **spontaneously refuses R3** while doing so.

---

## 5. Calibration phase — 5 runs, evidence pre-loaded

Separate harness (`tmp/causal/calibration.ts`). The Feb-27 evidence is placed in context by
**real tool executions against the live corpus** — `get_net_worth_history` Jan–Mar,
`get_transactions` Feb Coinbase, `get_transactions` Feb 25 – Mar 1 card payments — then, under the
**shipped** instruction:

> *"so its likely i sold crypto in february then, no?"*

| Marker | Result |
|---|---|
| Tool calls | **0/5** — the evidence is already there; no re-fetch. 1.0 hop, 3.4 s avg |
| Cites `$8,141.98` / `$1,902.12` / `$10,044.10` | **5/5** ✅ |
| Cites the crypto balance fall (≈$16k) | **5/5** |
| Reaches **R2** *"transactions show"* | **5/5** ✅ |
| **Stops** at R2 | **0/5** ❌ |
| Asserts **R3** — the *purpose* of the sale | **5/5** ❌ (4 flat, 1 hedged on destination) |
| Cites the payment total `$13,450.65` | **0/5** ❌ — *"$13–14k"*, *"many thousands"*, *"several large card payments"* |
| Notices the **$3,406.55 shortfall** | **0/5** ❌ |
| Flags "sold" as inference rather than observation | 1/5 (t2) |

Representative:

- **t1** — *"It's very likely you **sold or withdrew crypto in February** (at Coinbase), moved the
  cash to your bank, and then **used a chunk of it to pay down credit cards**."*
- **t2** — *"classic **'sell crypto, move cash to bank, pay down cards'** pattern"* … and, to its
  credit, *"we can't see the actual trades on Coinbase here, so 'sold crypto' is an **inference**,
  not directly measured"* — an R2 caveat on the *sale*, none on the *purpose*.
- **t5** — *"used the proceeds to pay down debt **and/or rebuild cash**"* — the only run that leaves
  the destination open.

Every run structures the answer under a literal **"Observed pattern"** heading. The transfers and
the payments are put side by side, and the arithmetic between them is never performed. $10,044.10
in and $13,450.65 out is a **fact that argues against** the clean story; it sat in context, in five
consecutive runs, unused.

---

## 6. Cost

Per-trial dollar cost was **not captured**. `AiInvocation` recorded **0 rows** for
`surface: 'causal-experiment'` despite the harness wrapping every turn in
`runWithAiInvocationContext`.

> **Corrected 2026-09-09.** This section originally attributed that to the Slice-3 chokepoint's
> fire-and-forget write (`void recordAiInvocation(...)`) being lost when a short-lived script exits.
> The corpus-span rerun added a 6-second flush before disconnect and still recorded **zero** rows,
> which falsifies that explanation. The actual cause: this harness calls the **OpenAI SDK directly**
> (`client.chat.completions.create`) and never reaches `lib/ai/provider.ts`, so `recordOpenAiUsage`
> — and the `AiInvocation` write with it — is never invoked. `runWithAiInvocationContext` was
> setting a context nothing consumed. The exit-race remains a plausible risk in the fire-and-forget
> design but is **unproven**, and this observation is no longer evidence for it. See
> `AI-GPT51-CORPUS-SPAN-SLICE.md` §6. No code was changed for this in either slice.

**107 model invocations** total (102 primary + 5 calibration). At the $0.0120/turn gpt-5.1 figure
measured in Cost Clip 4, the whole experiment is **≈$0.5–0.9 — an estimate, not a measurement.**
Relative cost across cells is carried faithfully by the hop counts in §4: **B is the cheapest cell
on every axis** (2.6 hops, 2.4 calls, 6.4 s) and retrieves exactly as often as A.

---

## 7. Answers

### 1. Does the stopping clause materially affect retrieval?

**No.** A vs B: **5/5 vs 5/5** on the measured turn, **0/5 vs 0/5** on the evidence. C vs D moves
3/5 → 2/5, the wrong direction and inside noise at n=5. The clause is **not the binding
constraint** on retrieval.

It does affect *cost*: B took 2.4 calls and 2.6 hops against A's 5.2 and 3.8 — A burned four
`get_transactions` calls per trial re-searching the same empty window with different merchant
keywords. On this evidence the variant is **cheaper for identical retrieval**, and that is the only
thing it buys. It does not justify a prompt change on its own.

### 2. Does inherited aggregate context materially affect retrieval?

**Yes, and it was measured wrong once already.** Counting `get_transactions` anywhere in the trial
gives 5/5, 5/5, 4/5, 4/5 and says "no effect". Counting it on the **measured turn** — the only
honest denominator, since a preamble call answers the preamble's question — gives:

| no preamble | **10/10** |
| with preamble | **5/10** |

The aggregate lens **halves** event-record retrieval on the causal turn. But it does something
worse than suppress: in C and D the model *did* retrieve, and retrieved **in January**, because
January is what the conversation had been about. The inherited context does not merely reduce
retrieval — it **redirects the window onto the conversational topic instead of the question's
subject**.

### 3. Does the combination explain the live failure?

**Partly, and it under-predicts it.** The live failure was one confident answer that stopped at the
balance layer. This experiment reproduced something **worse than the live failure, in every cell**:
20/20 failed to reach the evidence, and 11/18 negatives asserted absence rather than hedging it.

The live session at least never claimed to have looked. Here, cells A–D searched for `coinbase`,
`binance`, `kraken` and `crypto` — inside a 90-day window ending five months after the event — and
reported *"found no matches"* as a finding. **A windowed absence became a stated absence.** H1 and
H2 together do not account for that; the third factor does.

### 4. If D still fails, what hypothesis survives?

D fails 5/5. The surviving hypothesis is **H3: window selection**, and it is not a model-disposition
problem — it is a **tool-contract** problem, in two parts:

1. **`get_transactions` never says what it did not look at.** It returns
   `{window: {from, to}, shown, rows}`. A window with 0 Coinbase rows and a corpus with 18 are
   indistinguishable in the response. Nothing in the result invites a second, wider question.
2. **The only date range visible anywhere in context is the thin core's 90-day `recent.window`.**
   With no preamble the model adopts it verbatim — 20/20 calls in A and B. With a preamble it
   adopts the preamble's range instead. In neither case does it know a corpus spanning
   **2024-07-18 → 2026-09-07** exists behind the tool.

The control the brief imposed — *do not add corpus-span metadata before running* — is what makes
this conclusion available. Had the metadata been present, A/B/C/D would likely have moved together
and the design would have measured nothing. Holding it constant is why H3 is now the *measured*
survivor rather than a hypothesis competing with H1 and H2.

Note the asymmetry the ground truth exposes: **the model never needs a window at all.**
`get_transactions({text: 'coinbase', sort: 'largest'})` with no `from` returns all 18 rows. Every
one of the 28 calls narrowed a search that would have succeeded unnarrowed. This is a contract that
makes the wrong call the natural one.

### 5. Once transaction evidence is supplied, does confidence calibration become appropriate automatically?

**No — it half-corrects, then overshoots.** With the evidence in hand the register moves **R1 → R2
in 5/5** — the amounts are cited exactly, the sale is described as observed at the transfer layer,
and no run hedges into false ignorance. That much *is* automatic and needs no instruction.

Then **5/5 continue into R3**, asserting the *purpose* — *"used a chunk of it to pay down credit
cards"*, *"to fund those payments"*. The evidence supports two dated inflows and four dated
payments on one day. It does not support intent. Supplying evidence fixed the **floor** of the
register and did nothing to the **ceiling**.

### 6. Is confidence calibration downstream of retrieval, or an independent problem?

**Both, and the split is clean:**

- **R1 → R2 is downstream of retrieval.** No instruction produced it; evidence alone did, 5/5. Fix
  retrieval and this half fixes itself. Nothing should be built for it.
- **R2 → R3 is independent.** It appeared in 5/5 calibration runs *with* full evidence, and in 2/5
  D trials *without* any (the R1↑ affirmatives) — it survives both the presence and the absence of
  the event record, so it cannot be a retrieval artefact.

The independent half is smaller and rarer than it looks, though. R3 overclaim only fires once the
model believes it has the story; in 18 of 20 primary trials the failure was the opposite —
**asserted absence**, which is R0 overclaim. Both are the same underlying habit: *stating a
conclusion at a strength the evidence in hand does not license*. Absence and intent are its two
faces.

### 7. Does the $3,406.55 gap affect the model's causal language?

**No. 0/5 noticed it, and 0/5 could have.** None cited the $13,450.65 payment total precisely —
they said *"$13–14k"*, *"many thousands"*, *"several large card payments"* — so the subtraction was
never available to be performed. The rounding is what removes it.

This matters because the gap is the one fact in the corpus that **argues against** the tidy story.
$10,044.10 in cannot have funded $13,450.65 out; at least $3,406.55 came from somewhere else, and
that is a concrete, arithmetic reason to stop at R2. The model had both numbers in context, side by
side under its own *"Observed pattern"* heading, in five consecutive runs, and rounded one of them
into uselessness before comparing.

Consistent with everything already established: **the model does not do consequential arithmetic**,
including the arithmetic that would have restrained it. It is not that the gap failed to move the
language — the gap was never computed.

### 8. What is the smallest justified intervention now?

**One tool-contract change, in the result — not the prompt, not the description.**

`get_transactions` should say what it did not look at. When a window was applied and the underlying
corpus extends beyond it, the result should carry the corpus span alongside the window it actually
searched:

```
{ window: {from: '2026-06-10', to: '2026-09-08'},
  corpus: {from: '2024-07-18', to: '2026-09-07'},   // <- the whole intervention
  shown: 0, rows: [] }
```

Why this and nothing else:

- It is **the measured cause.** 28/28 calls windowed; every window verified genuinely empty; the
  unwindowed call returns the evidence. Nothing else in the 2 × 2 discriminated.
- It **cannot route.** It adds no rule, no keyword, no question class, no tool mapping. It states a
  fact about the data the tool just read. The model keeps every decision it already owns.
- It **fixes the dangerous failure directly.** *"Found no matches in that window"* stops being
  utterable as *"no matches"* once the result itself says the window was 90 days of a 26-month
  corpus. Turning **asserted absence into scoped absence** is worth more than any confidence
  instruction, and it comes from the data rather than from doctrine.
- It is **already the shape of this codebase.** Coverage envelopes, `PositionCoverage`,
  `cryptoValuationStatus` — every one is the same move: *the result declares the boundary of its own
  authority.* `get_transactions` is the one read surface that does not, which is why it is the one
  that produced a confident false negative.

**Explicitly not now:**

- Not the instruction variant. It changed no retrieval outcome. Its cost saving (−31% hops in A vs
  B) is real but is a Cost-Clip question, measured on the full corpus, not a causal-evidence one.
- Not a causal-question taxonomy, intent router, or "always call `get_transactions`" rule. The model
  called the tool in 15/20 trials unprompted. **Willingness was never the defect** — the prior
  experiment already fixed that, and this one confirms it held.
- Not a confidence doctrine for R3. It is a genuine and independent finding (§answer 6), but it is
  second in line: with the corpus span in the result, most R0/R1↑ overclaims lose their premise, and
  what remains of R3 should be re-measured before anything is written for it.

**Sequencing:** ship the corpus span, re-run this exact 2 × 2 unchanged, and see how much of the
register problem survives it. That re-run is the honest gate for any further work.

---

## 8. Threats to these conclusions

- **n = 5 per cell.** The C-vs-D difference (3/5 vs 2/5) is noise. The claims that carry are the
  ones at 0/20 and 10/10 vs 5/10.
- **One question, one corpus, one Space.** The window-anchoring finding is strong here because the
  thin core prints exactly one date range; a context with several visible ranges may behave
  differently.
- **The preamble is a proxy** for the live session's inherited lens, not a reproduction of it. It
  establishes the same aggregate framing in 2 turns instead of 7.
- **Calibration pre-loads evidence via real tool calls**, so the model sees a plausible transcript —
  but it never *chose* those calls, and a model that retrieved on its own might narrate differently.
- **Cost is an estimate** (§6), not a measurement.

---

## 9. What was changed by this work

- **This document.**
- **`AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md`** — new §0 erratum and five in-place amendments
  correcting the Coinbase marker from **3/5 to 0/5**. Documentation only; that document's verdict
  (**PARTIAL**) and diagnosis are unchanged, and the corrected figure strengthens rather than
  weakens its §10 window conclusion.
- **Nothing else.** No prompt, tool, schema, route, or model configuration was modified. The harness
  (`tmp/causal/`) is gitignored and is not part of this commit.
