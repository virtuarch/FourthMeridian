# The chat tier — a recorded decision

**Flag:** `AI_CHAT_MODEL` · **Default:** `gpt-4o-mini` (unchanged)
**Measured:** 2026-09-01, against `2fe3c58`
**Decision:** `gpt-4o-mini` under `AI_ANSWER_MODE=prose`. `gpt-4.1` when, and
only when, `AI_ANSWER_MODE=typed`. **The two flags move together.**

---

## Why this was asked again

`provider.ts` carried `const CHAT_MODEL = 'gpt-4o-mini'` as a literal for the
life of the product. FORECAST-11 measured a stronger tier against it and
answered **no** — "helps D, hurts I, 14× cost" — and that finding was honest and
correctly recorded.

**But it was measured against the prose architecture**, where the extra
capability had nothing to grip: no structured output to be precise into, and a
prompt where a third of the budget was raw JSON dumps. Slice 1 changed both
halves of that measurement, so the question is genuinely a different one.

---

## Truth · usefulness · register, scored apart

Scored separately because they move differently, and because a stronger narrator
is also better at writing fluent, confident prose *around a wrong plan* — an
answer that reads better and is aimed at the wrong question. Scoring them
together would reward exactly that.

### Truth — unlicensed figures reaching the user

| | `gpt-4o-mini` | `gpt-4.1` |
|---|---|---|
| answer-boundary gates (7 cases) | **7/7** | **7/7** |
| forecast corpus (35 scenarios) | — | 31/35, 0 redactions |

**A tie, and that is the important result.** The boundary makes both tiers safe.
Nothing below is a truth argument; the tier decision is entirely about whether
the safe answer is also a useful one.

### Usefulness — did it answer the question

| | `gpt-4o-mini` | `gpt-4.1` |
|---|---|---|
| answered the question | 4/7 | **7/7** |
| deterministic bullet-list fallback | **3/7** | 0/7 |
| model calls for 7 answers | 11 | **7** |

The failure mode is specific and it is not stupidity: mini writes figures into
its prose and omits them from `claims`. The answer is then discarded whole, and
the user gets a 22-line bullet dump of every licensed figure instead of a
sentence. Safe, and not an answer.

### Plan quality, scored apart from narration

The discriminating case is `I-stale-premise` — the user said *"assume I spend
$4,000 a month"* on a previous turn, and the forecast did not apply it.

> **mini:** *"If spending continues at the observed rate, your projected cash at
> the end of the next 3 months is $21,980.39 … Note that your current net worth
> is $33,700.17 and total liabilities are $549.75."*
>
> **gpt-4.1:** *"If you spend $4,000 a month over the next 3 months, your cash
> trajectory will differ from the projected scenario based on your recent
> average spending. However, the system has not computed a forecast using your
> stated $4,000/month spending assumption, so I cannot provide an exact ending
> cash figure for that scenario … If you want to see a forecast based on
> $4,000/month, let me know."*

Both are true. Only one answers the question. mini answers a **different**
question fluently and then appends two unrelated figures; 4.1 names the gap
between what was asked and what was computed, and offers the next step.

This is the reverse of the risk the plan warned about — here the stronger tier
is better at the **plan**, not merely at the prose.

### Register

mini's non-fallback answers are perfectly acceptable. Its fallbacks are not: a
bullet list is not a register, it is the absence of one. 4.1 consistently states
the limitation *inside* a useful answer rather than as the answer.

---

## Cost, honestly

List price, at the current ~10.4k-token prompt:

| | calls for 35 scenarios | est. cost |
|---|---|---|
| `gpt-4o-mini` typed | 59 (11 clean · 24 needing a second call) | ~$0.10 |
| `gpt-4.1` typed | 43 (27 clean · 8 needing a second call) | ~$0.96 |

**~9.7×, not 14×** — because mini pays for a repair or a fallback in 24 of 35
turns and 4.1 pays for one in 8. The per-token multiple is 13×; the per-answer
multiple is smaller, and the gap closes further with Slice 7.

**And Slice 7 changes the arithmetic materially.** The typed block alone was
measured at **1,570 tokens against 11,400** with no quality loss on the boundary
cases (see `reasoning-layer.md`). At that prompt size, 43 calls of `gpt-4.1`
cost about **$0.21** — roughly twice today's mini bill on today's prompt, for a
tier that answers every question instead of three in seven.

⚠️ Latency is the real cost, not money: p50 **20.9 s** against mini's **3.9 s**.
That is a product decision this document does not make, and it is the strongest
argument for the split below.

---

## Input to Slice 5: split the tiers

The planner is a small structured classification over a question and a measure
catalogue, with **no financial figures in and none out**. A wrong plan costs
relevance and cannot cost truth. Narration is where the capability gap actually
showed up, in every case above.

So the shape to build toward is a **cheap planner and a strong narrator**, which
was not an available option at FORECAST-11 because there was no planner. It also
addresses the latency finding: a fast planner can run while nothing is blocked.

Recorded here as an input to Slice 5, not built here.

---

## What is NOT decided

The default stays `gpt-4o-mini`, because `AI_ANSWER_MODE` still defaults to
`prose` and under prose the FORECAST-11 answer stands. Flipping the tier alone
would buy the cost of the frontier model without the boundary that makes it
worth paying — which is why both flags carry a warning pointing at the other.
