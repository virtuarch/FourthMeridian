# Beta cost / token economics — investigation

**Date:** 2026-09-08 · **HEAD:** `666cf6f` · **Status:** investigation. **Nothing implemented.**

Production route unchanged (`503 AWAITING_REDESIGN`). Everything below comes from the saved
artifacts, the durable `ApiUsageCounter` rows, the repository, and a small number of read-only
measurement probes against the live API (§16).

---

## 1. Executive verdict

**The two dogfood sessions cost $0.82, not $15.** The `$15` is real, but it is not these two
sessions — it is the *previous* day's development, and it is dominated by gpt-5.5's price rather
than by anything the harness does badly.

Three findings reframe the whole optimisation question:

| | Finding |
|---|---|
| **1** | **Prompt caching is already working, at 89.2% measured.** The input side of these sessions cost **$0.37**. The obvious "reduce the prompt" levers are attacking tokens that already bill at $0.50/1M instead of $5.00/1M. |
| **2** | **Output is the majority of the bill — 54% here, ~66% on the 31-turn session.** At gpt-5.5's $30/1M output vs $5/1M input, a reasoning token costs **6× an uncached input token and 60× a cached one**. |
| **3** | **Model tier is the single largest lever, by a wide margin.** The same token volumes on **gpt-5.1 cost $0.24 instead of $0.82 — a 70% reduction** with no change to the harness at all. |

The hypothesis in the brief — *"a 15K context sent four times becomes ~60K billed input"* — is
**confirmed structurally and rejected economically**: 49.5% of prompt tokens are within-turn
retransmission, but 89% of them are cache hits, so the entire retransmission bill is ~$0.10.

---

## 2. Pricing and configuration actually in force

Fetched 2026-09-08 from OpenAI's pricing page (standard tier, per 1M tokens):

| Model | Input | Cached input | Output |
|---|---|---|---|
| **gpt-5.5** | **$5.00** | **$0.50** | **$30.00** |
| gpt-5.1 | $1.25 | $0.125 | $10.00 |
| gpt-5 | $1.25 | $0.125 | $10.00 |
| gpt-4.1 | $2.00 | $0.50 | $8.00 |
| gpt-4.1-mini | $0.40 | $0.10 | $1.60 |
| gpt-5-mini | $0.25 | $0.025 | $2.00 |
| gpt-4o-mini | $0.15 | $0.075 | $0.60 |
| gpt-5-nano | $0.05 | $0.005 | $0.40 |

**Configuration actually invoked** (`lib/ai/provider.ts`, `scripts/ai-baseline/run.ts`):
`/v1/chat/completions`, `model: gpt-5.5`, `tools` (15) + `tool_choice: 'auto'` **on every hop**,
`max_completion_tokens: 8000`, no `temperature`, **no `reasoning_effort`** (so gpt-5.5's default,
`medium`), no cache-retention option, `MAX_TOOL_ROUNDTRIPS` loop, Clip 6 compaction
`retainCompletedTurns: 2`.

**`lib/usage/pricing.ts` ships empty**, so the repo has no in-code price authority; the figures
above are external.

---

## 3. What the logs contain, and what they do not

`ApiUsageCounter` and the artifacts record `prompt_tokens`, `completion_tokens` and
`reasoning_tokens`. **Neither records `prompt_tokens_details.cached_tokens`** — `provider.ts`
reads `completion_tokens_details.reasoning_tokens` and nothing else.

> **This is the single biggest measurement gap.** Without cached tokens, no dollar figure the
> repo produces can be correct, because 89% of the input bills at one-tenth the headline rate.

To close it for this investigation I ran a **billing replay** (§16): the exact message array the
harness sent for every round trip was reconstructed from the artifacts — including running the
real `compactToolHistory` at the same points — and re-sent with a 16-token completion budget,
recording `cached_tokens`. The replay reproduces the recorded `promptTokens` **exactly** for 8 of
11 turns and within 1.7% for the other three (the residual is how tool calls are grouped into
hops), so the cached shares below are measured, not assumed.

---

## 4. Cost per turn

Cached share is replay-measured per turn; prompt/completion are the recorded values.

### Session 1 — `interactive-2026-09-08T15-02-08-054Z` (7 turns, 15 invocations, 24 tool calls)

| # | Question | Tool calls | Prompt | Cached | Uncached | Reasoning | Output | $ in | $ out | **$ total** | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | How am I looking financially? | 3 | 14,246 | 11,520 | 2,726 | 348 | 675 | $0.0194 | $0.0203 | **$0.0396** | 13.6s |
| 1 | Go back to Jan 1… knowing nothing after | 4 | 23,708 | 21,760 | 1,948 | 387 | 871 | $0.0206 | $0.0261 | **$0.0467** | 17.6s |
| 2 | Explain what you saw me do, Jan–Jul | 5 | 34,109 | 32,000 | 2,109 | 694 | 1,301 | $0.0265 | $0.0390 | **$0.0656** | 25.2s |
| 3 | Did I sell crypto to cover debt? | 4 | 37,284 | 36,096 | 1,188 | 308 | 769 | $0.0240 | $0.0231 | **$0.0471** | 12.7s |
| 4 | Where am I headed by EOY? | 4 | 61,212 | 55,064 | 6,148 | 283 | 697 | $0.0583 | $0.0209 | **$0.0792** | 13.9s |
| 5 | How plausible is $1M by 2030? | 3 | 38,103 | 26,808 | 11,295 | 271 | 739 | $0.0699 | $0.0222 | **$0.0920** | 23.6s |
| 6 | Help me monitor things to make it happen | 1 | 31,939 | 21,691 | 10,248 | 71 | 382 | $0.0621 | $0.0115 | **$0.0735** | 7.9s |

**Session 1 total: $0.4438** (240,601 prompt · 204,939 cached · 5,434 completion · 114.6s model time)

### Session 2 — `interactive-2026-09-08T15-11-39-523Z` (4 turns, 9 invocations, 8 tool calls)

| # | Question | Tool calls | Prompt | Cached | Uncached | Reasoning | Output | $ in | $ out | **$ total** | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Do you still remember my 2030 goal? | 1 | 9,953 | 8,448 | 1,505 | 31 | 117 | $0.0117 | $0.0035 | **$0.0153** | 4.9s |
| 1 | Make the goal 750k by 2029 | 3 | 14,642 | 13,568 | 1,074 | 551 | 890 | $0.0122 | $0.0267 | **$0.0389** | 21.5s |
| 2 | $500/weekday trading, invest 75%… | 2 | 35,070 | 34,048 | 1,022 | 3,002 | 7,829 | $0.0221 | $0.2349 | **$0.2570** | 92.7s |
| 3 | Help keep me in check… | 2 | 77,188 | 75,648 | 1,540 | 184 | 491 | $0.0455 | $0.0147 | **$0.0603** | 19.5s |

**Session 2 total: $0.3714** (136,853 prompt · 131,712 cached · 9,327 completion · 138.7s model time)

### Distribution

| | |
|---|---|
| **Combined** | **$0.8152** |
| User turns | 11 |
| **Mean $/turn** | **$0.0741** |
| **Median $/turn** | **$0.0603** |
| Cheapest turn | $0.0153 — *"do you still remember my 2030 goal?"* |
| **Most expensive turn** | **$0.2570** — *"$500/weekday trading…"* (32% of the entire bill) |
| Cost per minute of model time | $0.193 |
| Cost per minute of wall-clock conversation (~16 min) | **~$0.051** |
| Input : output split | **$0.372 : $0.443** — output is **54%** |

> **The expensive turn is not the big one.** The 77,679-token turn cost **$0.060**; the
> 35,070-token turn cost **$0.257**. Prompt size is a poor predictor of cost; output is a good one.

---

## 5. Reconciling the ~$15 impression

The durable counters (`ApiUsageCounter`, UTC day buckets) are unambiguous about volume:

| UTC day | Model | Calls | Prompt | Completion |
|---|---|---|---|---|
| **2026-09-08** | gpt-5.5 | 24 | **377,454** | **14,761** |
| 2026-09-08 | gpt-4.1 | 11 | 54,573 | 573 |
| 2026-09-07 | gpt-5.5 | 146 | 2,164,785 | 71,384 |
| 2026-09-07 | gpt-4.1 | 250 | 2,625,538 | 28,146 |

**The 2026-09-08 gpt-5.5 row is exactly the two sessions** — 377,454 / 14,761 / 24 calls matches
their summed totals to the token. Nothing else ran on gpt-5.5 that day.

| Scope | Cost |
|---|---|
| **The two dogfood sessions specifically** | **$0.8152** (measured caching) |
| All UTC-2026-09-08 development (adds 11 gpt-4.1 probe calls) | **$0.85 – $0.93** |
| All UTC-2026-09-07 development | **$6.27 – $18.45** — cached share unknown for that day |
| Both days, gpt-5.5 only, **priced at the uncached headline rate** | **$15.29** |

**Two readings of "$15", and I cannot choose between them from the repo:**

1. **A list-price view.** gpt-5.5 across both days at $5/$30 with no cache credit is **$15.29** —
   an almost exact match. Any dashboard or mental arithmetic that multiplies total tokens by the
   headline rate lands here.
2. **A billed view.** If $15 is genuinely billed spend, then 2026-09-07 cached far worse than
   2026-09-08 did (plausible: that day was batch probe runs with differing prefixes and long gaps,
   and cache entries expire after ~5–10 minutes of inactivity on the in-memory default).

**What would resolve it:** the OpenAI dashboard's *cached input* line for those two days, or —
the durable fix — recording `prompt_tokens_details.cached_tokens` as a third `ApiUsageCounter`
unit. Until then this is a range, and I am not going to present either end as exact.

**What is certain either way:** yesterday cost roughly 15–20× what these two sessions cost, and
the difference is volume of *development* runs, not the cost of a conversation.

---

## 6. Where the tokens came from

### 6.1 Fixed overhead, measured exactly

Measured by differencing real API calls (§16):

| Component | Tokens per **model invocation** |
|---|---|
| Tool schemas (15 tools) | **3,567** |
| System instruction (+ date line) | **186** |
| A2 evidence body (thin core + coverage envelope + memory line) | **698** (S1) / **786** (S2) |
| **Fixed floor per invocation** | **~4,451 – 4,539** |

That floor is paid on *every hop*, not every turn.

### 6.2 The named turns, decomposed

**A — "How am I looking financially?"** · 14,246 prompt · 2 invocations · 3 tool calls · **$0.0396**

| Call | Prompt | = tools | + system | + evidence | + conversation & tool content | Cached |
|---|---|---|---|---|---|---|
| 1 | 4,761 | 3,567 | 186 | 698 | 310 | 56% |
| 2 | 9,485 | 3,567 | 186 | 698 | 5,034 | 93% |

**62.5% of this turn's prompt is fixed overhead.** The conversation contributed 310 tokens on the
first hop. This is the shape of every cheap turn: the floor dominates.

**B — "Where am I headed by EOY?"** · 61,212 prompt · **3 invocations** · 4 tool calls · **$0.0792**

| Call | Prompt | Conversation & tool content | Cached |
|---|---|---|---|
| 1 | 17,883 | 13,432 | 95% |
| 2 | 20,346 | 15,895 | 84% |
| 3 | 21,960 | 17,509 | 92% |

Fixed overhead 13,353 (22%). **Retransmission 38,229 (63.5%)** — the third hop exists because the
model called `remember` after answering. Dominant contributor: **round-trip count × a 20K context**.

**C — "help keep me in check…"** · 77,188 prompt · **3 invocations** · 2 tool calls · **$0.0603**
— see §7.

**D — "do you still remember my 2030 goal?"** · 9,953 prompt · 2 invocations · 1 tool call · **$0.0153**

| Call | Prompt | Conversation & tool content | Cached |
|---|---|---|---|
| 1 | 4,863 | 324 | 76% |
| 2 | 5,090 | 551 | 93% |

**91.2% of this turn is fixed overhead.** The actual work — one `recall`, a 145-token result, a
117-token answer — is under 900 tokens. **This is the purest tool-schema-tax turn in the corpus.**

**E — the trading scenario** · 35,070 prompt · 2 invocations · 2 tool calls · **$0.2570**

Input was only $0.0221 (97% cached). The cost is entirely on the output side:

| Output component | Tokens | Cost |
|---|---|---|
| **Tool-call arguments** (two `scenario_projection` calls, 1,734 tok each) | **3,468** | **$0.1040** |
| Reasoning | 3,002 | $0.0901 |
| Visible answer | ~226 | $0.0068 |
| (unattributed remainder) | ~1,133 | $0.0340 |

**Tool-call arguments are billed as output at $30/1M**, and this turn spent more on *writing
arguments* than on reasoning.

### 6.3 Unique vs retransmitted

Defining **unique** as the largest (final) prompt in a turn and **retransmitted** as everything
resent on earlier hops:

| Turn | Invocations | Final call | Total prompt | Retransmitted | Multiplier | Cached |
|---|---|---|---|---|---|---|
| S1 T0 | 2 | 9,485 | 14,246 | 4,761 | 1.50× | 80.9% |
| S1 T1 | 2 | 13,955 | 23,708 | 9,753 | 1.70× | 91.8% |
| S1 T2 | 2 | 19,790 | 34,109 | 14,319 | 1.72× | 93.8% |
| S1 T3 | 2 | 21,642 | 37,284 | 15,642 | 1.72× | 96.8% |
| S1 T4 | 3 | 21,960 | 60,189 | 38,229 | **2.74×** | 90.0% |
| S1 T5 | 2 | 21,248 | 38,205 | 16,957 | 1.80× | 70.4% |
| S1 T6 | 2 | 16,133 | 32,041 | 15,908 | 1.99× | 67.9% |
| S2 T0 | 2 | 5,090 | 9,953 | 4,863 | 1.96× | 84.9% |
| S2 T1 | 2 | 9,478 | 14,642 | 5,164 | 1.54× | 92.7% |
| S2 T2 | 2 | 25,387 | 35,070 | 9,683 | 1.38× | 97.1% |
| S2 T3 | 3 | 25,967 | 77,188 | 51,221 | **2.97×** | 98.0% |

**Unique 190,135 · retransmitted 186,500 · 49.5% of all prompt tokens are within-turn
retransmission.** The hypothesis is confirmed in structure.

**But it is economically small.** Retransmitted tokens are the *most* cacheable thing in the
system — hop *n*+1's prefix is hop *n*'s prompt verbatim — and they measured 89–98% cached. At
$0.50/1M the entire 186,500 tokens of retransmission cost **≈ $0.10**. Halving round trips would
save roughly **$0.05 across both sessions**, or 6% of the bill.

---

## 7. Incident: why "help keep me in check" cost 77,679 tokens

**It cost $0.0603.** The token count is alarming and the money is not, and the difference is the
whole point of this section.

**Arithmetic.** Three model invocations of ~25.7K each:

```
25,534  (hop 1) + 25,687  (hop 2) + 25,967  (hop 3)  = 77,188 prompt
                                                     +    491 completion  = 77,679 total
```

Each ~25.7K breaks down as:

```
  3,567   tool schemas (15 tools)
    186   system instruction
    786   A2 evidence body
 ~21,000  conversation + retained tool content
 ───────
 ~25,540  per invocation
```

The ~21,000 of conversation is dominated by **one previous turn**. At this turn's start the
harness measured `toolCallArgs: 4,433` and `toolResults: 11,538`. The previous turn (E) had made
two `scenario_projection` calls, each carrying **1,734 tokens of arguments** and returning
**~3,672 tokens of result**:

```
  3,468   the two scenario_projection ARGUMENT blobs
  7,345   the two scenario_projection RESULT payloads
 ───────
 10,813   from a single prior turn — 51% of the retained conversation
```

**Ranked contributors:**

| Contributor | Tokens | Share |
|---|---|---|
| **Round trips × context** (3 hops of the same ~25.7K) | 51,221 retransmitted | **66.4%** |
| Retained `scenario_projection` payloads + arguments from the prior turn | 10,813 × 3 hops | ~42% of the prompt |
| Tool definitions | 3,567 × 3 = 10,701 | 13.9% |
| A2 evidence + system | 2,916 | 3.8% |
| **Model reasoning** | 184 | 0.2% |
| Memory payloads themselves | ~270 | 0.3% |

**So: accumulated tool payloads from the previous turn, multiplied by three round trips.** Not
prose, not memory, not reasoning.

**Why three hops for a turn with no arithmetic in it?** Because **the first `remember` was
rejected**:

```
remember({ kind:"INTENTION", subject:"financial-accountability",
           payload:{ intent:"...", label:"accountability preference" } })
  -> stored:false  "a INTENTION needs all of targetMetric + targetAmount + byDate,
                    or all of intent + amount + label"
```

The model retried with `amount: 0` and it stored. **A payload-contract rejection cost one full
extra retransmission of ~25.7K tokens** — about a third of the turn.

### 7.1 The two `remember` writes, classified

| # | What it stored | Classification |
|---|---|---|
| 1 | Nothing — rejected for a missing `amount` on an intention that has no amount | **WRONG KIND (contract mismatch).** The *intent* was right; the taxonomy had no shape for it. Cost: one round trip |
| 2 | `INTENTION` / `financial-accountability` / `{intent:"Tell me when something may negatively affect me…", amount: 0, label:"accountability preference"}` | **TOO VAGUE + WRONG KIND.** A standing *advisory preference* coerced into the INTENTION shape with a semantically empty `amount: 0` |

**On the "vague duplicate preferences" worry: it has not happened yet, but the mechanism for it is
now visible.** Across both sessions there are five `remember` calls and only **one** is
preference-shaped. The rest are correct and well-behaved:

| Turn | Write | Verdict |
|---|---|---|
| S1 T4 | `CHECKPOINT liquid-2026-12-31`, superseding the one slice 7 had already written silently | **REDUNDANT.** Slice 7 wrote this checkpoint automatically from `project_cash`'s own basis block; the model then wrote it again, replacing a **structured** basis with a **prose** one. Cost is trivial; the loss of structure is not — `reconcile_projection`'s `diffBasis` can no longer compare fields against it |
| S1 T6 | `INTENTION net-worth-target` $1M by 2030 | **GOOD** |
| S2 T1 | `INTENTION net-worth-target` $750K by 2029, superseding the above | **GOOD** — correct supersession, correct chain |
| S2 T3 ×2 | above | **WRONG KIND / TOO VAGUE** |

The risk the brief names — *keep me honest*, *warn me about risk*, *protect my goal* all landing as
separate vague INTENTIONs — is real precisely because there is **no kind for a standing
preference**, so each one will be coerced into INTENTION with a different `subject`, and
supersession keys on `subject`. Two differently-worded preferences would therefore **not**
supersede each other. Not fixing it here, as instructed.

---

## 8. The tool-schema tax

Measured exactly by incremental addition (§16), on gpt-4.1's tokenizer (the gpt-5.5 total is
3,567 — 2.6% higher):

| Tool | Tokens | Share |
|---|---|---|
| **`scenario_goal_seek`** | **739** | **21.3%** |
| **`scenario_projection`** | **600** | **17.3%** |
| `remember` | 329 | 9.5% |
| `get_transactions` | 233 | 6.7% |
| `project_cash` | 210 | 6.0% |
| `get_net_worth_history` | 198 | 5.7% |
| `recall` | 181 | 5.2% |
| `explain_net_worth_change` | 169 | 4.9% |
| `reconcile_projection` | 153 | 4.4% |
| `investment_scenario` | 136 | 3.9% |
| `get_financial_snapshot` | 134 | 3.9% |
| `get_income` | 118 | 3.4% |
| `get_spending` | 114 | 3.3% |
| `get_investments` | 99 | 2.8% |
| `get_pay_dates` | 63 | 1.8% |
| **Total** | **3,476** (gpt-4.1) / **3,567** (gpt-5.5) | |

**The two scenario tools are 38.6% of the entire tool surface.** They are the ones that gained the
shared `SCENARIO_INPUTS` block in slice 5 — `scenario_goal_seek` carries every scenario input
*plus* its own three, and every parameter description is a full sentence.

**Cost across the two sessions:** 24 invocations × 3,567 = **85,608 tokens = 22.7% of all prompt
tokens**. At the headline rate that is $0.428; **at the measured cached rate it is $0.043**, about
5% of the bill.

### 8.1 Can fewer tools be exposed per turn?

**CURRENTLY AVAILABLE — model-native, no router.** OpenAI ships **tool search**: add
`{"type": "tool_search"}` to the tools array and mark expensive definitions `"defer_loading": true`.
The model then sees only the search tool up front and loads what it needs at runtime. It is
supported on **gpt-5.4 and later**, so gpt-5.5 qualifies. Two caveats that matter here:

- **It is Responses-API only.** The harness is on `/v1/chat/completions`. Adopting it means an API
  migration, not a parameter.
- It is documented as *"designed to preserve the model's cache"* — tools load at the **end** of the
  context under that API — but OpenAI publishes **no quantified savings**, so any number I gave
  would be invented.

This satisfies the constraint exactly: **the model decides, not a router.** No intent classifier,
no keyword matching, no planner.

**ALSO CURRENTLY AVAILABLE — and much cheaper to try.** The 3,567 tokens are mostly *prose in
parameter descriptions*, and the two scenario tools own 38.6% of it. Tightening those descriptions
is a token-contract change with no architecture at all. It cannot plausibly reach zero — the
descriptions are load-bearing (§8 of the beta investigation: "never supply a rate the user did not
state" is doing real work) — but the *shape* of the saving is known and testable offline.

**SPECULATIVE.** Namespacing the tool surface (OpenAI recommends <10 functions per namespace) so a
"scenario" namespace defers as a unit. Sensible, but it presupposes the Responses migration.

**Honest framing:** at the measured cache rate, the entire tool-schema tax is **$0.043 across both
sessions**. This is a *latency and context-window* story more than a cost story. Ranked
accordingly in §12.

---

## 9. The tool-result tax

Both sessions, 32 tool calls:

| Tool | Calls | Mean result tok | Max | Total result tok | Mean **argument** tok |
|---|---|---|---|---|---|
| **`scenario_projection`** | 3 | **2,821** | **3,673** | **8,464** | **1,160** |
| `scenario_goal_seek` | 4 | 1,156 | 1,460 | 4,624 | 28 |
| `get_transactions` | 4 | 1,005 | 2,894 | 4,018 | 29 |
| `get_spending` | 3 | 1,293 | 1,386 | 3,879 | 13 |
| `get_financial_snapshot` | 5 | 589 | 959 | 2,946 | 4 |
| `get_income` | 3 | 753 | 814 | 2,260 | 13 |
| `get_investments` | 2 | 567 | 910 | 1,134 | 4 |
| `project_cash` | 1 | 813 | 813 | 813 | 11 |
| `remember` | 5 | 151 | 267 | 756 | 81 |
| `get_net_worth_history` | 1 | 553 | 553 | 553 | 16 |
| `recall` | 1 | 145 | 145 | 145 | 19 |
| **All** | **32** | | | **29,592** | |

**Downstream retransmission.** A result stays in context for its own turn's remaining hops and for
the next two completed turns before Clip 6 elides it — so a payload is resent roughly **3–5 times**.
A 3,673-token `scenario_projection` result therefore lands ~15,000 tokens of prompt over its life,
almost all cached (**~$0.008**).

### 9.1 The one genuine offender

**`scenario_projection`'s ARGUMENTS, not its results — and they are billed as output.**

In the trading turn the model passed **40 explicitly enumerated monthly contributions and 40
enumerated outflows**, twice (a 70% and an 80% variant — both legitimate questions, not
duplicates):

```
scenario_projection({ to, granularity, annualReturnPct: 70,
  contributions: [ {amount:6375, onDate:"2026-09-30", label:"75% of $500 per weekday trading avg"},
                   {amount:8250, onDate:"2026-10-31", ...}, … 40 entries … ],
  outflows:      [ … 40 entries … ] })
```

- **1,734 argument tokens per call** versus 4–81 for every other tool — **14× to 290× larger**
- Across both sessions, tool-call arguments were **4,262 tokens = 28.9% of all completion tokens =
  $0.128**, and `scenario_projection` alone is **3,479 of those 4,262 (82%)**
- **Root cause is a schema gap, not model waste.** The tool offers `monthly` and `yearly` cadences.
  *"$500 per weekday"* maps to neither, so the model correctly did the only thing available:
  computed each month's amount itself and enumerated them. **The absence of a cadence forced the
  model back into arithmetic** — the exact thing slices 4–5 exist to prevent, leaking in through
  the argument surface

### 9.2 Classifying result verbosity — nothing here should be deleted for cost

| Tool | Required authority | Useful detail | Lazy candidate | Verdict |
|---|---|---|---|---|
| `get_financial_snapshot` | totals, `basis`, `coverage`, `assertable` | per-account rows, APRs, freshness | the account-level `buckets` array on the historical path | Mostly justified; the historical path returns 5 buckets × account rows even when the question is one number |
| `get_spending` | window, totals, coverage | `byCategory`, `byMonth` | `topMerchants` (12), `recurring` (12) | 1,293 mean is defensible for a cash-flow question; the two 12-item lists are ~40% of it |
| `get_income` | per-source cadence, activity, `why` | `incomeSources.items` | — | Justified. This is the cadence evidence the forecast rests on |
| `get_investments` | `composition` + coverage | `positionDetail` subset, `unpricedPositions` | position-level detail | Justified; `scopeWarning` is load-bearing |
| `get_transactions` | rows, `complete` flag | — | — | Justified; the 2,894 max is a `sort:largest` exhaustive read, which is the point |
| `project_cash` | `projection`, `basis`, `establishment` | `checkpoints`, `range`, `excluded` | month-end `checkpoints` when nobody asked for a table | Justified |
| `scenario_projection` | checkpoints, `reconciliation`, `assumptions` | `movements` (settled amounts), `warnings` | **`movements` up to 12 entries + `assumptions.contributions.settled` up to 12 — the same data twice** | **Some duplication.** `settled` and `movements` overlap |
| `scenario_goal_seek` | `required`, `feasible`, `searchRange`, `assumptionsInForce` | the full `scenario` ledger at the solution | **the embedded `scenario` block — a second full projection payload inside the answer** | **The largest single lazy candidate** |
| `recall` / `remember` | the record + `meaning` | — | — | Justified; 145–267 tokens |

**Nothing above recommends removing provenance, coverage or refusal reasons.** Every reduction
named is *duplication* or *detail nobody asked for on this call*.

---

## 10. Conversation growth after Clip 6

### 10.1 Measured, over 31 turns

From `interactive-2026-09-07T21-25-37-355Z` (31 turns, gpt-5.5, same arm and compaction policy) —
transcript composition at the start of each turn:

| Turn | Transcript | System | User prose + evidence | Assistant prose | Tool-call args | Tool results |
|---|---|---|---|---|---|---|
| 0 | 933 | 206 | 727 | 0 | 0 | 0 |
| 5 | 4,963 | 206 | 774 | 781 | 311 | 2,891 |
| 10 | 3,435 | 206 | 831 | 1,739 | 498 | 161 |
| 15 | 12,719 | 206 | 965 | 3,317 | 739 | 7,492 |
| 20 | 9,614 | 206 | 1,043 | 4,543 | 1,096 | 2,726 |
| 25 | 9,207 | 206 | 1,129 | 5,444 | 1,198 | 1,230 |
| 30 | 9,617 | 206 | 1,179 | **6,505** | 1,318 | **409** |

**Clip 6 is doing its job.** Tool results are the volatile term — they spike to 13,734 and fall
back to 409 — and they do **not** trend upward. The transcript at turn 30 (9,617) is smaller than
at turn 15 (12,719).

**What dominates growth after Clip 6 is accumulated assistant prose**, at a measured **~217
tokens/turn** (6,505 over 30 turns). Adding tool-call arguments, **permanent growth is ~261
tokens/turn** — the slowest-growing component in the system.

> **Assistant prose is the growth term, and it is also the thing the brief's principle protects:**
> *conversation remembers what we were talking about.* At 261 tok/turn, mostly cached, it costs
> about **$0.00013 per turn per turn of history**. It is not a problem yet and does not need a
> summariser.

### 10.2 What a normal conversation costs

Projection from the measured constants: fixed 4,483/invocation, permanent growth 261 tok/turn,
retained results ~3,500, **1.61 invocations/turn** and **1,142 completion tok/turn** (all measured
from the 31-turn session), at the measured 89.2% cache rate. **Extrapolated beyond turn 31.**

| Turns | Prompt at that turn | $ that turn | **Cumulative session $** (gpt-5.5) | gpt-5.1 | gpt-4.1 | gpt-5-mini |
|---|---|---|---|---|---|---|
| **10** | 18,590 | $0.0526 | **$0.51** | $0.16 | $0.20 | $0.03 |
| **25** | 24,905 | $0.0588 | **$1.35** | $0.41 | $0.56 | $0.08 |
| **50** | 35,429 | $0.0692 | **$2.95** | $0.88 | $1.29 | $0.18 |
| **100** | 56,477 | $0.0900 | **$6.94** | $2.02 | $3.27 | $0.40 |

**Cost grows sub-linearly per turn** — turn 100 costs 1.7× turn 10, not 10× — because the growing
part is the cheapest part (cached prefix) and the constant part (output) is the expensive part.
**Nothing here is a runaway.** The 100-turn prompt of ~56K is also comfortably inside the context
window.

---

## 11. Caching

**Measured, not assumed.**

| | |
|---|---|
| Are cached tokens visible in the responses? | **Yes** — `usage.prompt_tokens_details.cached_tokens` |
| Are they captured by the harness? | **No.** `provider.ts` reads only `completion_tokens_details.reasoning_tokens` |
| Measured hit rate across both sessions | **89.2%** (335,872 of 376,635 replayed prompt tokens) |
| Per-turn range | 67.9% – 98.0% |
| Discount in force | gpt-5.5 cached input **$0.50/1M vs $5.00/1M — 90%** |
| Value of caching on these two sessions | **~$1.51 saved**; without it the bill would be **$2.33** instead of **$0.82** |

**What is cacheable and is being cached.** Caching is automatic above 1,024 tokens, matches the
longest previously-computed prefix in 128-token increments, and the prefix **includes tool
definitions**. Direct evidence: a call with `tools` returned `cached_tokens: 3,712` — a 128-multiple
covering the 3,567-token tool block plus the system message — while the immediately preceding call
*without* tools returned `cached_tokens: 0`.

**Message ordering is currently correct** and nothing is accidentally destroying cacheability:
system → static A2 evidence → append-only turns. The evidence body is built once per session and
never rewritten.

**The one real cache defect is Clip 6's interaction with it.** OpenAI documents that replacing
earlier content "prevent[s] reuse from that point onward". Elision rewrites messages *in the
middle* of the array, so the shared prefix ends at the newly-elided message. This is visible:

| Turn | Elided this turn | Cached |
|---|---|---|
| S1 T3 | 4 | **96.8%** |
| S1 T5 | 4 | **70.4%** |
| S1 T6 | 4 | **67.9%** |

**So I ran the A/B — the whole corpus replayed with compaction disabled:**

| | Prompt | Cached | Uncached | Input cost |
|---|---|---|---|---|
| **Compaction ON** (current) | 376,635 | 335,872 (89.2%) | 40,763 | **$0.3718** |
| **Compaction OFF** | 478,625 | 446,464 (**93.3%**) | 32,161 | **$0.3840** |

> **Clip 6 removes 101,990 prompt tokens — 21.3% — and saves $0.0123. That is 3.2% of the input
> bill and 1.5% of the total.** It also *increases* uncached tokens by 8,602, because it trades
> cheap cached tokens for fewer, dearer uncached ones.
>
> **Clip 6 is still net-positive, but its economic value has essentially evaporated now that
> caching is measured.** Its remaining justification is context-window headroom, not money. I
> expected to find it net-negative; it is not, and I am reporting the measurement rather than the
> expectation.

**Not currently set and worth noting:** `prompt_cache_retention`. The default for organisations
without Zero Data Retention is `"24h"`; with ZDR it is `"in_memory"` (~5–10 min idle). Chris's turns
were 1–2 minutes apart so this did not bite, but a user who leaves a conversation for 20 minutes
and returns would pay full rate on their next turn. **Which default applies here depends on the
org's data-retention setting, which I cannot read from the repo.**

---

## 12. Model-tier economics

**Identical token volumes, repriced** (377,454 prompt · 336,651 cached · 14,761 completion):

| Scenario | Input | Output | **Total** | vs baseline |
|---|---|---|---|---|
| **A. Everything gpt-5.5 (actual)** | $0.3723 | $0.4428 | **$0.8152** | — |
| **B. 3 mechanical turns on gpt-4.1, rest gpt-5.5** | | | **$0.7648** | **−6%** |
| **C₁. Whole session gpt-5.1** | $0.0931 | $0.1476 | **$0.2407** | **−70%** |
| C₂. Whole session gpt-4.1 | $0.2499 | $0.1181 | **$0.3680** | −55% |
| C₃. Whole session gpt-5-mini | $0.0186 | $0.0295 | **$0.0481** | −94% |
| C₄. Whole session gpt-4.1-mini | $0.0500 | $0.0236 | **$0.0736** | −91% |

**Scenario B is the disappointment, and it is the important result.** Routing the three clearly
mechanical turns (S1 T3 historical retrieval, S2 T0 goal recall, S2 T1 parameter change) to gpt-4.1
saves **$0.05 — 6%** — because mechanical turns are *already* the cheap ones. Cost concentrates in
the turns where judgement is wanted, which are exactly the turns you would not route away.

> **Any per-turn routing scheme has to be built before the turn is answered, cannot know whether a
> question is mechanical until it has been read, and would need a classifier to decide — which is
> the intent router the constraints forbid.** Scenario B is therefore both low-value and
> architecturally expensive. **I recommend against it.**

**Scenario C₁ is the finding.** gpt-5.1 is a full reasoning model at **¼ the input and ⅓ the output
price** of gpt-5.5. A **70% reduction with a one-line configuration change, no routing, no
classifier, no architecture.** The open question is quality, and this investigation cannot answer
it — the prior model comparison in this arc (FORECAST-12) found that a *differently-worse* model
reintroduced original failures, and it reversed a tier decision on measurement. **The same standard
applies: gpt-5.1 must be measured on these transcripts before it is adopted.**

### 12.1 Turn classes, on the evidence

**Plausibly cheaper-model-safe** (all deterministic-tool-owned; the model formats and explains):
goal recall (S2 T0, $0.0153); parameter changes to an existing scenario (S2 T1); historical
retrieval (S1 T3, 4 `get_transactions` calls); rendering a projection table; "which was biggest".

**Judgement-bearing** (broad assessment, ambiguous causal inference, multi-domain planning,
external-world epistemics): S1 T0 "how am I looking"; S1 T2 "explain what you saw me do"; S1 T5
"how plausible is $1M"; S2 T2 the trading scenario — where the model correctly called 70–80%
annual returns an assumption carrying the whole goal.

**The one true observation about reasoning spend:** reasoning was **41.5%** of completion tokens
across these two sessions and **74%** on the 31-turn session (26,274 of 35,417). It is the largest
single output component in long conversations.

### 12.2 Reasoning-effort control — a hard constraint, measured

gpt-5.5 defaults to `medium`. I tried to lower it and the API refused:

```
400 Function tools with reasoning_effort are not supported for gpt-5.5 in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.
```

So on the current API surface there are exactly **two** settings: `medium` (default) or `none`.
Measured on the trading turn's final hop (identical prefix):

| Setting | Completion | Reasoning | Latency | Cached | Answer |
|---|---|---|---|---|---|
| default (`medium`) | 325 | 134 | 6.0s | 25,216 | correct, with the 70/80% table |
| **`none`** | **188** | **0** | **3.7s** | **0** | correct, tighter, same figures |

**Two caveats that matter more than the saving.** (1) Changing `reasoning_effort` **invalidates the
cache** — the `none` call returned `cached_tokens: 0` — so mixing efforts within a session would
destroy cache locality and could cost more than the reasoning saves. (2) One sample on one hop is
not evidence that `none` preserves judgement on the turns where judgement matters. **Graduated
effort requires the Responses API.**

---

## 13. Cost targets for beta

Grounded in measured per-turn costs, at the current gpt-5.5 configuration and the measured 89%
cache rate.

| Class | Measured today | **Token target** | **$ target (gpt-5.5)** | $ at gpt-5.1 |
|---|---|---|---|---|
| Memory recall / write | $0.0153 | ≤ 10K prompt, ≤ 300 completion | **≤ $0.015** | ≤ $0.005 |
| Simple factual financial question | $0.0396 | ≤ 15K prompt, ≤ 700 completion | **≤ $0.04** | ≤ $0.012 |
| Deterministic projection follow-up | $0.0389–$0.0471 | ≤ 25K prompt, ≤ 900 completion | **≤ $0.05** | ≤ $0.015 |
| Broad financial assessment | $0.0396–$0.0656 | ≤ 35K prompt, ≤ 1.3K completion | **≤ $0.07** | ≤ $0.021 |
| Complex planning turn | $0.0792–$0.2570 | ≤ 40K prompt, ≤ 3K completion | **≤ $0.12** | ≤ $0.036 |
| **10-turn normal conversation** | ~$0.51 projected | ~190K prompt | **≤ $0.60** | ≤ $0.18 |
| **25-turn deep planning conversation** | ~$1.35 projected | ~500K prompt | **≤ $1.50** | ≤ $0.45 |

**Answering the question directly:**

- **Pennies per ordinary turn: already true.** The median turn is **6.0¢**; the cheapest is 1.5¢.
- **<$1 for 10 turns: already true.** ~**$0.51**.
- **$1–3 for a deep 25-turn planning session: already true.** ~**$1.35**.

**Fourth Meridian is already inside the targets a beta would want — on the most expensive model
OpenAI sells.** The realistic ambition is not to reach pennies-per-turn; it is to reach
**sub-penny** per ordinary turn and **~$0.15 for a 10-turn conversation**, and the evidence says
that is a *model-tier* decision, not a token-engineering one.

The only target that needs guarding is the complex planning turn, where a single question cost
**$0.257** — 32% of a two-session bill — driven by 3,468 tokens of enumerated tool arguments.

---

## 14. Optimisation opportunities, ranked by ROI

| # | Optimisation | Measured current waste | Expected token reduction | Expected $ reduction (per these 2 sessions) | Product risk | Complexity | Evidence |
|---|---|---|---|---|---|---|---|
| **1** | **Evaluate gpt-5.1 as the default tier** | gpt-5.5 costs 4× input / 3× output of gpt-5.1 | 0 tokens | **−$0.57 (−70%)** | **Medium** — quality unproven; FORECAST-12 showed a tier swap can reintroduce failures | **Trivial** (one constant) + a real eval | **Strong on price, none on quality** |
| **2** | **Add a weekday/weekly cadence + a rate form to `scenario_projection`** | 3,479 output tokens of enumerated arguments; 82% of all argument tokens | −3,400 output tokens/occurrence | **−$0.10 on the trading turn (−40% of that turn)** | **Low** — it *removes* model arithmetic, strengthening the slice-4 boundary | Low | **Strong** — measured, and root-caused to a schema gap |
| **3** | **Record `cached_tokens`** (usage counter + artifact) | Every cost figure the repo can produce is wrong by ~65% | 0 | $0 — but makes every other item measurable | **None** | Trivial | **Strong** |
| **4** | **Make `remember`'s INTENTION contract accept a preference** | 1 rejected write = 1 extra round trip = 25,687 tokens | −25K prompt per occurrence | −$0.015/occurrence, and stops `amount: 0` junk entering memory | **Low**, but it is a *memory-taxonomy* change, not a cost change | Low | **Strong** — one measured incident |
| **5** | **Trim the two scenario tool descriptions** | 1,339 of 3,567 schema tokens (38.6%), resent 24× | −~600 tok/invocation → −14,400 | **−$0.007** | **Medium** — descriptions are load-bearing ("never supply a rate the user did not state") | Low | **Strong on size, weak on headroom** |
| **6** | **Make `scenario_goal_seek`'s embedded `scenario` ledger opt-in** | 4,624 result tokens across 4 calls, containing a second full projection | −~800 tok/call | −$0.002 | **Medium** — the ledger is what makes the answer checkable | Low | Moderate |
| **7** | **Suppress the model's redundant CHECKPOINT write** | 1 duplicate write; replaced a structured basis with prose | −~400 tok | <$0.001 | **Low** — improves `reconcile_projection` | Low | Moderate — one occurrence |
| **8** | **Reduce round trips** | 49.5% of prompt is within-turn retransmission | −186,500 prompt tokens | **−$0.05 (−6%)** | **High** — fewer hops means fewer tool calls, which is the product | High | Strong measurement, **poor ROI** |
| **9** | **Tool search / `defer_loading`** | 85,608 schema tokens (22.7% of prompt) | −~3,000 tok/invocation | **−$0.04** at cached rates | Medium | **High** — requires a Responses API migration | Moderate — no published numbers |
| **10** | **Retune or retire Clip 6** | Saves 21.3% of prompt for **$0.012 (1.5%)** | +102,000 tokens if removed | **−$0.012 if kept**; ~$0 either way | Low | Trivial | **Strong — A/B measured** |
| **11** | **Smaller completion budget** | `max_completion_tokens: 8000`; max observed 7,829 | 0 (a cap is not a cost) | $0 | **High** — this cap was raised *because* it was truncating answers | Trivial | **Strong evidence against** |
| **12** | **`reasoning_effort`** | Reasoning is 41.5%/74% of completion | −~130 tok/hop | ~−$0.004 | **High** — and it **zeroes the cache** | Blocked on chat completions | **Strong evidence of the constraint** |

### Answering the five questions, for the top three

**#1 — gpt-5.1 as default.** *(1)* Attacks the $0.443 output bill and the $0.372 input bill
simultaneously — the only lever that touches both. *(2)* $0.57 of $0.82 on these sessions; ~$2.00
of ~$2.95 on a 50-turn conversation. *(3)* **Yes, it could damage behaviour, and that is the whole
risk** — every slice in this arc was validated on gpt-5.5. *(4)* No architecture; one constant.
*(5)* **Yes** — the 11 turns here plus the 31-turn session can be replayed and diffed
mechanically, and the deterministic-tool outputs give an objective anchor the earlier model
comparisons lacked.

**#2 — a cadence for rates.** *(1)* Attacks the largest single output component: 3,479 tokens of
enumerated arguments, 82% of all argument tokens, $0.104 on one turn. *(2)* ~$0.10 per
rate-shaped scenario question. *(3)* **No — it improves behaviour.** The model enumerating 40
monthly amounts *is* consequential arithmetic leaking back through the argument surface, which is
what slices 4–5 exist to stop. *(4)* One optional field on an existing schema; the ledger already
expands schedules. *(5)* **Yes** — S2 T2 can be re-run against the new schema and the argument
tokens counted.

**#3 — record `cached_tokens`.** *(1)* Attacks the fact that every cost number the repo can
produce is ~65% too high. *(2)* $0 directly; it is the instrument, and without it #1 and #10
cannot be evaluated in production. *(3)* No. *(4)* No — one field in an existing counter.
*(5)* Yes, trivially.

---

## 15. Recommended cost-clip sequence — **not implemented**

> Each clip is independently shippable, independently revertible, and mechanically testable
> against these exact transcripts.

**Cost Clip 1 — Instrument before optimising.**
→ Capture `prompt_tokens_details.cached_tokens` in `provider.ts`; add `cached_tokens` as a third
`ApiUsageCounter` unit and to the harness `usage` record.
→ **Savings: $0.** Makes every subsequent clip measurable and every existing cost figure correct.
→ **Regression:** the harness suite; assert an artifact carries a cached-token field; re-run one
short interactive session and confirm the recorded hit rate lands near 89%.

**Cost Clip 2 — Close the argument-enumeration hole.**
→ Give `scenario_projection` contributions a rate form — a `weekday`/`weekly` cadence, or an
`amountPerWeekday` — so *"$500 per weekday"* is one clause rather than 40 dated entries.
→ **Savings: ~3,400 output tokens (~$0.10) per rate-shaped scenario question**, ~40% of the most
expensive turn measured.
→ **Regression:** re-run S2 T2's question; assert argument tokens drop below ~200 and the ledger's
checkpoints match the enumerated run to the cent. Existing slice-4 tests must stay green.

**Cost Clip 3 — Give memory a shape for a standing preference.**
→ Either a `PREFERENCE` kind, or an INTENTION variant whose required set is `{intent, label}` with
no `amount`.
→ **Savings: one round trip (~25K prompt, ~$0.015) per occurrence**, and it stops `amount: 0`
entering the store. Also the first structural defence against the vague-duplicate-preference
accumulation the brief is worried about.
→ **Regression:** replay S2 T3's `remember` argument; assert it stores on the first attempt.
Ownership, supersession and closed-key-set tests must stay green.

**Cost Clip 4 — Measure gpt-5.1 against these transcripts.**
→ **Measurement, not a change.** Replay both sessions and the 31-turn session on gpt-5.1; compare
tool selection, figure accuracy against the deterministic tools, refusal behaviour, and the
as-of/provenance properties slices 1–7 established.
→ **Savings if adopted: ~70% of the entire bill.**
→ **Regression:** the beta acceptance tests in `AI-BETA-REASONING-MEMORY-INVESTIGATION.md` §12,
re-run against gpt-5.1 output. **Do not adopt on price alone.**

**Cost Clip 5 — Decide Clip 6's future on the measurement, not the intuition.**
→ Either keep compaction and accept it is now a context-window policy worth 1.5%, or widen
`retainCompletedTurns` to trade its 3.2% input saving for better cache locality.
→ **Savings: ~$0 either way.** The value of this clip is *removing a belief*, not tokens.
→ **Regression:** the compaction A/B replay in this investigation, re-run at the chosen setting.

**Deliberately NOT in the sequence:** per-turn model routing (§12 — 6% for a forbidden classifier);
round-trip reduction (6%, high product risk); tool-search migration (needs the Responses API, and
the tax it attacks is $0.043); smaller completion budgets (the evidence says the opposite).

---

## 16. Probes run

All read-only against the live API and the local database. **Total measurement spend: ~$1.30.**

| Probe | What it established | Cost |
|---|---|---|
| `ApiUsageCounter` query | Per-model, per-UTC-day token volumes; exact reconciliation of the two sessions | $0 |
| Artifact enumeration (23 artifacts) | Per-session token totals and list-price costs across the whole harness history | $0 |
| **Component differencing** (gpt-5.5) | Tool-schema cost **3,567 tok**; system **186**; A2 evidence **698–786** | $0.248 |
| **Per-tool incremental differencing** (gpt-4.1, 17 calls) | Exact per-tool schema cost for all 15 tools | $0.098 |
| **Billing replay, compaction ON** | Per-call prompt **and cached** tokens for all 24 invocations; reproduces recorded totals | $0.383 |
| **Billing replay, compaction OFF** | The Clip 6 A/B: 21.3% fewer tokens for 3.2% less money | $0.396 |
| **`reasoning_effort` probe** | `reasoning_effort` is **rejected with function tools** on chat completions; `none` works and zeroes the cache | ~$0.18 |
| Pricing + caching + tool-search documentation | Current rates, cache semantics, `tool_search` availability | $0 |

**No financial data was read or written by any probe.** No repository file outside
`docs/plans/` and gitignored `tmp/` was modified.

---

## 17. Unresolved questions

1. **Which "$15" is Chris looking at?** List-price arithmetic ($15.29 across both days on gpt-5.5)
   or billed spend? The OpenAI dashboard's cached-input line for 2026-09-07/08 settles it.
2. **What was the cache hit rate on 2026-09-07?** It is the difference between a $6.27 day and an
   $18.45 day, and nothing in the repo records it. Cost Clip 1 prevents the question recurring.
3. **Which `prompt_cache_retention` default applies to this organisation** — `24h` or `in_memory`?
   It decides whether a user who steps away for 20 minutes pays 10× on their next turn.
4. **Does gpt-5.1 preserve the behaviour slices 1–7 validated?** Unknown, and it is the single
   highest-value open question in this document.
5. **Would the Responses API change the economics enough to justify migrating?** It unlocks
   `tool_search` *and* graduated `reasoning_effort`, the two levers currently blocked. Neither has
   published savings figures.
6. **Why did the trading turn pass 40 `outflows` as well as 40 `contributions`?** The contributions
   are explained by the missing cadence; the outflows are not, and I did not establish it.
7. **Is 89.2% representative?** It was measured on two short, densely-spaced sessions. A session
   with 20-minute gaps would look different, and no artifact in the corpus has that shape.

---

## 18. Files changed

- **`docs/plans/AI-BETA-COST-ECONOMICS-INVESTIGATION.md`** — this document. **Nothing else.**

No implementation, no schema change, no harness change, no production change. `app/`, `lib/`,
`prisma/`, `components/` and `scripts/` are untouched; probe scripts live in gitignored `tmp/cost/`.
