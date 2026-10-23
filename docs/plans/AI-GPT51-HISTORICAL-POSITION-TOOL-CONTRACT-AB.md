# A/B: can `get_financial_snapshot`'s description carry the scope contract?

**Date:** 2026-09-08 · **HEAD:** `8ff74a8` · **Status:** measurement. **Nothing implemented.**

Repository untouched — the description was swapped in the schema array at runtime. System
instruction is the **shipped** one, unchanged, with no disposition paragraph. Default model
unchanged. Production route frozen. Operator `SpaceMemory` verified unchanged.

Follows [AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md](AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md) §11.

---

## 1. Verdict

# FAIL

**The revised description changed nothing. Every substantive marker is identical across
conditions.**

| Marker (5 trials each) | **A** current | **B** revised |
|---|---|---|
| `get_financial_snapshot` selected | **0/5** | **0/5** |
| `project_cash` selected | 5/5 | 5/5 |
| liquid **$9,517** surfaced | 5/5 | 5/5 |
| **debt $37,316 surfaced** | **0/5** | **0/5** |
| investments surfaced | 0/5 | 0/5 |
| net worth surfaced | 0/5 | 0/5 |
| information ceiling `asOf ≤ 2026-01-01` | 5/5 | 5/5 |
| redundant double-call | none | none |

**Per the brief I stopped rather than iterating through increasingly explicit descriptions.**
**Tool-description semantics alone are insufficient to move this choice.**

**But the diagnosis reframes the problem, and it may not be a defect to engineer away at all**
(§5): gpt-5.1 is not mis-ranking the tools. It is answering a **narrower but entirely defensible
reading of an ambiguous question** — *"what would you have **told** me"* as *"what forecast would
you have given me"* — and answering that reading well. Evidence: the same model, with the same
shipped description, **does** select `get_financial_snapshot({asOf})` when the question asks about
the position rather than the advice.

---

## 2. The two descriptions

**A — shipped, verbatim from `scripts/ai-baseline/tools.ts`** (83 tokens, 58 words):

```
The position on a date. Omit `asOf` for today (adds per-account freshness, APRs and
available balances); pass `asOf` for a past date (adds the account-level breakdown of
each bucket and the coverage of that date). `liquid` is checking + savings; `checking`
is checking alone. Start here for anything broad, and for any "how was I doing on X".
```

**B — revised** (96 tokens, 64 words; **+13 tokens**):

```
The financial position at a point in time, and the authority on it: net worth, total
assets, liquid balances, investments, digital assets and debt, each with its
account-level composition. Omit `asOf` for today (adds per-account freshness, APRs and
available balances); pass `asOf` for a past date (adds each bucket's account-level
breakdown and that date's coverage). `liquid` is checking + savings; `checking` is
checking alone.
```

**What changed, and why.** B **removes** the question phrase and the routing hint —
*"Start here for anything broad, and for any 'how was I doing on X'"* — which the brief forbids,
and replaces them with an enumeration of the truth the tool owns. It names no other tool, gives no
example, and states no rule about when to call it.

> Note this makes the A/B slightly stronger than "add semantics": it also tests whether a
> **question-shaped hint** was doing any work. It was not — A, which contains the hint, selected
> the snapshot 0/5 for a question that is arguably an instance of it.

---

## 3. Results — 5 trials per condition

Question: *"Go back to Jan 1. What would you have told me then, knowing nothing after that date?"*

**Every trial in both conditions produced exactly one tool call:**

| | Condition A | Condition B |
|---|---|---|
| t1 | `project_cash{to:2026-09-08, asOf:2026-01-01, checkpoints:monthly}` | `project_cash{...}` |
| t2 | `project_cash{to:2026-01-01, asOf:2026-01-01, ...}` | `project_cash{...}` |
| t3 | `project_cash{to:2026-01-01, asOf:2026-01-01, ...}` | `project_cash{to:2026-09-08, asOf:2026-01-01, ...}` |
| t4 | `project_cash{to:2026-12-31, asOf:2026-01-01, ...}` | `project_cash{...}` |
| t5 | `project_cash{to:2026-12-31, asOf:2026-01-01, ...}` | `project_cash{...}` |

- **`get_financial_snapshot` selection rate: 0% in both conditions.**
- **Debt retrieval rate: 0% in both conditions.**
- **Complete-position retrieval rate: 0% in both conditions** (no trial surfaced net worth, total
  assets, investments and debt together).
- **Redundant-call behaviour: none.** B did not cause the model to call both tools. Every trial in
  both conditions was 1 tool call / 2 model invocations. The concern that a stronger description
  would produce redundant fetching did **not** materialise — but only because the description had
  no effect at all.
- **Information ceiling: 5/5 correct in both.** Every call carried `asOf: 2026-01-01`. The `to`
  values reaching past that date are the **projection horizon**, not a leak — a retrospective
  projection legitimately runs forward from its cutoff. *(My first scoring pass flagged these as
  leaks; the rule was corrected and both conditions rescored identically.)*

**Discrimination control: not run.** It was conditional on B succeeding 5/5. There is nothing to
control for — B never stole anything from `project_cash`, because it never won a single selection.

---

## 4. Answer quality

The answers are **incomplete but not misleading** — a meaningful difference from the original
Cost Clip 4 failure, which concluded *"you're okay for now"* over an unmentioned $37k of debt.
Representative (B, t3):

> *"Here's what I would have told you standing on 2026-01-01 … You had about **$9,517 in cash**
> (checking + savings) available then. I would not be using any information about your balances,
> income, or spending after Jan 1. … I'm **not** modeling investment gains/losses or changes in
> your debt here, just the cash side. … **What the projection would have said (cash only)**"*

It states its cutoff, states its assumptions, **explicitly scopes itself to cash and says so**, and
does not overreach. As an answer to *"what forecast would you have given me"* it is good. As an
answer to *"how would you have assessed me"* it is missing the balance sheet.

---

## 5. Interpretation

**The model is not mis-ranking the tools. It is reading the question differently.**

*"What would you have **told** me then"* is genuinely ambiguous between:

| Reading | Tool | Who chose it |
|---|---|---|
| *"What advice/forecast would you have given?"* | `project_cash` | **gpt-5.1, 10/10** |
| *"How would you have assessed my position?"* | `get_financial_snapshot` | gpt-5.5 |

**The decisive corroboration comes free from the previous experiment.** Same model, same
**shipped** description, question rephrased toward the position:

> *"How was I doing on Jan 1 2026?"* → `get_financial_snapshot({asOf: '2026-01-01'})`, returning
> **liquid $9,517.46 · checking $1,255.20 · savings $8,262.26 · debt $37,316.03 · net worth
> $9,379.88** — the complete position, first attempt.

**So the tool is selected correctly when the question is about the position, under description A.**
The discriminator is the **question's framing**, not the description's semantics. That is why
strengthening the description could not move it: the description was never the binding constraint.

**Three consequences.**

1. **The hypothesis in §11 of the prior experiment is refuted.** The scope contract does not belong
   on the tool description, because the tool description is not what is failing.
2. **This may not be a contract defect at all.** Under *"the model owns meaning"*, choosing which
   reading of an ambiguous question to answer **is the model's job**. gpt-5.1 picks the narrower
   reading and executes it faithfully; gpt-5.5 picks the broader one. That is a judgement
   difference, and the only mechanism that would force the broader reading is one that tells the
   model how to interpret questions — which is the intent taxonomy the constraints forbid.
3. **The beta acceptance test is unaffected.** §12.5 of the beta investigation specifies
   *"how was I doing on Jan 1 2026?"*, and gpt-5.1 passes it. The failing probe is a harder,
   ambiguous phrasing that no acceptance criterion requires.

---

## 6. Economics

| | Calls/turn | Invocations/turn | Prompt | Cached | Completion | Latency | **$/turn** |
|---|---|---|---|---|---|---|---|
| **A** current | 1.0 | 2.0 | 52,673 | 80.4% | 2,478 | 8.0s | **$0.0086** |
| **B** revised | 1.0 | 2.0 | 52,564 | 66.2% | 2,622 | 6.4s | **$0.0106** |

Token volumes are within 0.2%. The $/turn difference is **cache variance at n=5**, not a cost of
the description: B adds **13 tokens** to a prefix that is ~90% cached in steady state
(≈ $0.000002/invocation). **Neither description has a measurable economic effect.**

---

## 7. Recommended next action

**Stop trying to close this by contract, and treat it as a tier judgement instead.**

Two attempts have now failed to move this behaviour by contract — a system-instruction paragraph
(prior experiment: fixed *willingness*, not *scope*) and a tool description (this experiment: no
effect). Both remaining levers would violate the standing constraints: telling the model how to
interpret *"what would you have told me"* is an intent taxonomy, and enumerating tools per question
shape is a router.

**The question to put to the product owner is therefore not "how do we fix this?" but:**

> Given that gpt-5.1 passes the specified acceptance question, is 79.6% cheaper, and answers the
> *ambiguous* phrasing narrowly-but-honestly rather than broadly — is that an acceptable product,
> or is the broader reading part of what Fourth Meridian is?

**If the broader reading is required**, the honest options are (a) keep gpt-5.5 for its
interpretive breadth and accept the 5× price, or (b) accept a narrower assistant at a fifth of the
cost. **This is a product decision, not an engineering one, and I am not going to disguise it as
one by adding instructions until the test passes.**

**Not recommended:** a third description iteration, examples in the description, a question-shape
hint, or any per-question rule. The measurement says the description is not the lever.

---

## 8. Deliverable summary

| | |
|---|---|
| **Exact A description** | §2 |
| **Exact B description** | §2 |
| **Token difference** | **+13** (83 → 96) |
| **5× results** | §3 — identical on every substantive marker |
| **`get_financial_snapshot` selection rate** | **0/5 (A) · 0/5 (B)** |
| **Debt retrieval rate** | **0/5 (A) · 0/5 (B)** |
| **Complete-position retrieval rate** | **0/5 both** |
| **Redundant-call behaviour** | none in either condition; 1 call / 2 invocations throughout |
| **Discrimination control** | not run — conditional on B passing 5/5 |
| **Economics** | §6 — no measurable difference |
| **Verdict** | **FAIL** |
| **Next action** | §7 — escalate as a tier/product judgement, not a contract fix |

## 9. Files changed

- **`docs/plans/AI-GPT51-HISTORICAL-POSITION-TOOL-CONTRACT-AB.md`** — this document. **Nothing else.**

`scripts/ai-baseline/tools.ts` is **unmodified**; both descriptions live in gitignored
`tmp/ab/desc.ts` and were injected at runtime. No other tool description was touched. No system
instruction change. 495/495 tests pass.

## 10. Probes run

| Run | Trials | Model |
|---|---|---|
| Condition A — current description, probe B | 5 | gpt-5.1 |
| Condition B — revised description, probe B | 5 | gpt-5.1 |
| Description token measurement | 2 | gpt-4.1 |

## 11. Measurement spend

**$0.097** — A $0.0430, B $0.0528, token measurement ~$0.001.

## 12. Unresolved

1. **Would gpt-5.5 also pick `project_cash` under description B?** Not tested. If it still picks the
   snapshot, the interpretive difference is confirmed as a model trait rather than a prompt artefact.
2. **Does the ambiguity matter in practice?** In a real conversation the user would follow up
   (*"what about my debt?"*), and gpt-5.1 answered exactly that correctly in the prior experiment's
   challenge turn. The cost of the narrower reading may be one extra turn, not a wrong answer.
3. **Is removing the question-phrase hint from A a loss elsewhere?** B removed *"Start here for
   anything broad"*. This A/B shows it was not doing work on *this* question; whether it helps on
   others was not measured.
