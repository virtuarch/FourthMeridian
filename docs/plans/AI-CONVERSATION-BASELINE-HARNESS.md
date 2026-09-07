# AI conversation baseline harness

**An experiment, not an architecture.** Nothing here is a proposal for the production
conversational layer, and no part of it runs in the product: `app/api/ai/chat` still returns
`503 AWAITING_REDESIGN`.

Follows [AI-CONVERSATION-RESET.md](AI-CONVERSATION-RESET.md) →
[AI-CONVERSATION-INVESTIGATION.md](AI-CONVERSATION-INVESTIGATION.md) §12 →
[AI-CONVERSATION-GOLDENS.md](AI-CONVERSATION-GOLDENS.md).

---

## 1. Hypothesis

> A capable model given **(1)** conversation history, **(2)** clean structured financial
> evidence, **(3)** deterministic tools where arithmetic matters and **(4)** a short
> behavioural instruction may already deliver most of the Fourth Meridian experience —
> without intent classifiers, MeasureId, figure licensing, answer schemas, prose scanners,
> repair loops, deterministic fallbacks, doctrine prompts, conversation lifecycles, or
> another rules engine for relevance.

**The experiment must be able to disprove it.** Three deliberate choices make failure
visible rather than absorbed:

- The **hardest** conversations are the probes, not the easy ones. Eight-turn assumption
  stacking, a wrong premise, a format complaint that previously returned a 502.
- **A1 carries `computeAssessment` completely unmodified**, so if the rules layer helps, it
  gets to win on its own terms.
- **No automated scorer.** A human reads the transcripts, so a bad answer cannot be scored
  as passing by a metric that measures the wrong thing.

## 2. Boundaries

| | |
|---|---|
| Production route | **Untouched.** `503 AWAITING_REDESIGN`. |
| New production code | One additive function on the provider seam (§9). Nothing else. |
| Writes | None to financial data. The provider's existing `ApiUsageCounter` still counts tokens. |
| Data | **Real**, read-only, through canonical authorities. |
| Persistence | None. No conversation store, no memory, no `AiAdvice`. |
| Artifacts | `tmp/ai-baseline/<run-id>/` — **gitignored**, contains real balances. |
| Size | 6 harness files + 1 test, ~1,400 lines. If it approaches a framework, stop. |

## 3. Evidence arms

Each arm answers one question, and they are different questions, so a result is
attributable.

| Arm | Given | Tools | The question |
|---|---|---|---|
| **A0** | full assembled context, **assessment withheld** | no | Can a model infer relevance and materiality from clean evidence alone? |
| **A1** | full assembled context **+ `computeAssessment`** | no | Does the deterministic verdict layer help the conversation, or fight it? |
| **A2** | thin core (~1–2k tok) + coverage envelope | yes | Is a compact orientation plus retrieval on demand enough? |
| **A3** | nothing but the date | yes | Can model tool selection replace deterministic routing? |

**A0/A1 assemble all four domains explicitly and do not run `resolveDomains`.** Measured
(investigation §5a): the router excludes `holdings_summary` from *"how am I looking
financially?"* on a Space that is 66% crypto by net worth. Running it inside the
broad-context arms would hand them a third of the picture missing and turn every arm into a
test of the router. Deterministic routing is what **A3 is measured against**; it must not
run inside its rivals.

**A2's thin core** carries totals, the canonical investment composition, a 90-day cash-flow
summary, net-worth latest + change, signals and the coverage envelope. It deliberately
omits per-account rows, the snapshot series, category/merchant rollups and position detail
— those are what tools are for.

## 4. Model tiers

Selected by **probing the live API on 2026-09-07**, not from documentation. What that
probe found:

| Family | Parameters | Tools via `/v1/chat/completions` |
|---|---|---|
| `gpt-4o-mini`, `gpt-4.1` | `max_tokens`, `temperature` honoured | ✅ |
| `gpt-5.x` | **`max_completion_tokens`**, temperature must be default | ✅ |
| `gpt-5.6-*`, `gpt-6-*` | `max_completion_tokens` | ❌ *"Function tools with reasoning_effort are not supported … in /v1/chat/completions"* |

| Tier | Model | Notes |
|---|---|---|
| `control` | `gpt-4o-mini` | The surviving production default. The floor. |
| `mid` | `gpt-4.1` | Fast (~1.3 s). The smoke-run model. |
| `ceiling` | `gpt-5.5` | **Strongest model that supports tools through this seam**, so it can run all four arms. |
| `frontier` | `gpt-6-astra` | Newest available, but **A0/A1 only** — no tools via chat completions. The runner records `toolsUnavailableReason` rather than crashing. |

Reaching `gpt-6-astra` with tools needs the Responses API. That is a provider-seam change,
deliberately **not** made for this experiment.

## 5. Probes

Ten conversations, every one multi-turn, drawn from the goldens. Turns are replayed against
a **growing transcript** — continuity is part of what is tested.

| Probe | Turns | Discriminates |
|---|---|---|
| `broad` | 3 | Prioritising without a rules engine; a correction that must move a number |
| `projection` | **8** | **The state probe.** Assumptions carry, stack, and get dropped on "what's realistic". Turn 2 is the reset's founding failure |
| `cadence` | 3 | Three-paycheck month vs a pay cut — inferred (A0/A1) vs read from a tool (A2/A3) |
| `debt` | 3 | **The A0-vs-A1 diagnostic.** Materiality at $25 and at $25,000 |
| `investments` | 3 | **The scope diagnostic.** Composition vs a within-subset concentration |
| `affordability` | 3 | Judgment composed from several facts, plus a target set earlier in the thread |
| `networth` | 3 | A wrong premise; then component attribution via `lib/history` |
| `spending` | 3 | Glance → explain → deep dive, driven only by the user |
| `strategy` | 3 | A grounded view, or a list of metrics |
| `format` | 4 | Format instructions stay format instructions |

**The goldens' answers are never sent to the model.** `whatItDiscriminates` reaches the
artifact for the human reader only, and a test pins that.

## 6. Tool surface

Eleven adapters over authorities that already exist. **Not one computes a financial figure.**

| Tool | Adapts | Notes |
|---|---|---|
| `get_financial_snapshot` | accounts assembler + `composeInvestments` | totals, per-account with freshness, missing debt fields |
| `get_spending` | transactions assembler, any window ≤ ~26 months | card payments named apart from spending |
| `get_transactions` | `queryTransactions` | 12 filters, keyset; "largest" ranked over a bounded page |
| `get_income` | transactions assembler **+ `loadForecastIncomeStreams`** | **the cadence evidence** — per-source cadence, activity, typical amount |
| `get_investments` | accounts + holdings | composition **and** a scoped position subset that says it is one |
| `get_net_worth_history` | `getRecentSnapshots({rows: 1100})` | reaches past the 90-row context cap; downsampled |
| `explain_net_worth_change` | `resolveExplorationNode` | `lib/history` — 9 lenses, progressive drilldown, **first AI consumer** |
| `project_cash` | `assembleForecast` | **both paths, always** (§8) |
| `get_pay_dates` | `resolvePayDates` | licence-gated occurrences |
| `investment_scenario` | new, §7 | a stated % move, at the current instant |
| `scenario_projection` | `scenario-ledger.ts` over the same cash spine, §7b | net worth over time under stated contributions and returns |

**Read and calculate only.** No write verb exists in the vocabulary; `tools.ts` imports no
Prisma client and contains no `.create(`/`.update(`/`.delete(`. Tested.

Names are the **user's** vocabulary. No `assembler`, `domain`, `measure`, `licence`,
`scope`, `spine` or `planner` may appear in a tool name — tested — because a model should
not have to learn Fourth Meridian's internals to ask a question.

## 7. Investment scenario arithmetic

The one calculation the investigation found genuinely missing. **Smallest possible.**

```
input   named components (from composeInvestments) + a percentage the USER stated
output  per-component delta and scenario value, total delta,
        scenario net worth (only when an authoritative current net worth exists)
```

**It is arithmetic over a hypothesis, not a forecast.** It predicts nothing, infers no
expected return, extrapolates no history and assigns no probability — tested by source scan.
Every result carries a `basis` sentence saying so, and that nothing else moves: cash, debt
and unnamed holdings are held exactly as they are.

Generic: a component is anything the caller can name and value. Nothing in it knows what
Bitcoin is. An unmatched component is **reported as unresolved**, never silently dropped —
"what if Bitcoin does 10%" answered without Bitcoin in it is the wrong answer stated
confidently.

It lives under `scripts/` because it has no production caller. If the experiment shows the
product needs it, it moves to `lib/investments/` — not before.

## 8. Forecast: both paths, always

The investigation measured that on this Space the **strictly-licensed** path REFUSES in
every configuration tested (it requires a NET/GROSS basis on every income event plus a
spending baseline — six assertions), while **PROJECTION-1** answers with ~$32,099.85.

`project_cash` returns **both**, every time, plus opening cash, the spending basis, applied
user facts and the licensed path's `refusedBecause` list.

> **The harness must not choose.** Which deterministic result deserves product authority is
> an open question this experiment exists to inform. Quietly returning whichever reads
> better would destroy the evidence.

## 9. The one production change

`lib/ai/provider.ts` gains `generateWithTools` — one request, one response, usage recorded,
raw tool calls returned. **Additive, with no production caller.**

The tool **loop** is deliberately not in the provider: the caller owns which tools exist,
how results are shaped and when to stop. Burying that in the seam would make the boundary an
agent runtime.

It also selects the parameter dialect by model family (§4), because sending the wrong one is
a 400.

## 10. Conversation state

**The transcript is the state.** One growing message array per case — user turns, assistant
turns, tool calls and **their JSON results** — handed to the model every turn.

No lifecycle enum, no assumption store, no scenario object, no scope graph. If eight turns
of assumption stacking fail under this, **that is the finding**, and `UserStatement[]`
(which already exists in `lib/forecast/policy.ts` and which `assembleForecast` already
consumes) is the next thing to test — after the transcript shows it is needed, not before.

## 11. Artifacts

`tmp/ai-baseline/<run-id>/` — **gitignored** (real balances, merchant names, transcripts).

Per case, one JSON file `<probe>__<arm>__<model>.json` recording: probe + what it
discriminates, arm + its question, model, tools offered (and why not, if unavailable),
Space id and name, as-of date, the system instruction verbatim, the **full evidence body**,
then per turn — user text, every tool call with arguments and result, round trips,
assistant text, latency, token usage, finish reason, any error — plus totals and blank
human-review fields.

Also `INDEX.md` (the readable surface) and `index.json`.

`INDEX.md` organises the two experimental dimensions explicitly:

- **same probe + same model, arms side by side** → evidence strategy
- **same probe + same arm, models side by side** → model quality

and calls out three diagnostics by name: **A0 vs A1**, **investment scope**, and
**projection state + the two forecast paths**.

## 12. Metrics

**Mechanical only, and deliberately tiny:** provider succeeded, answer non-empty, latency,
prompt/completion/total tokens, tool-call count, tool round trips, provider errors, artifact
completeness.

**Not rebuilt:** claim extraction, prose numerical sweep, figure licensing, answer
validation, repair, rubric scoring, LLM judge. The previous architecture's scorers were
wrong before the model twice as often, and later ten times.

## 13. Human review

The transcripts **are** the result. Each artifact carries blank fields — accuracy,
relevance, conversation, conciseness, judgment, follow-up, notes — scored 1–5 by a person,
never populated automatically.

## 14. Known limitations

1. **One Space.** Everything is Chris' Space. Jane's has 151 transactions; the seeded Spaces
   have none. At least one probe should eventually run against a thin Space.
2. **`gpt-6-astra` cannot do tool arms** through this seam.
3. **Nine of thirteen positions cannot be priced** on this Space ("no RAW_CLOSE price within
   7 days") — a local price-archive gap. It makes the investment probe *more* discriminating,
   not less, but it is not a production-representative valuation state.
4. **Cost is not attributable per turn** in the product (`ApiUsageCounter` has no
   `userId`/`spaceId`). The harness measures it directly instead.
5. **The account's rate limit is a real constraint on the broad-context arms.** The
   organisation's `gpt-4.1` cap is **30,000 tokens per minute**, and A0/A1 prompts are
   ~18–20k — so two turns inside a minute trips a 429. The first smoke run lost three of
   twelve cases to it. The runner now retries **only** 429s, bounded, honouring the
   provider's suggested wait, and records every retry on the turn with quota waiting kept
   **out** of `latencyMs`. This is worth carrying into any product decision: an always-on
   13k-token context is not only a cost question, it is a throughput question.
6. **No streaming**, so latency is time-to-complete, not time-to-first-token. A 4-tool turn
   feels worse than the number suggests.
7. **Temperature is not held constant across tiers** — `gpt-5.x` rejects an override, so
   classic models run at 0.3 and modern ones at their default. Noted, not corrected.
8. **A0/A1 skip `resolveDomains` deliberately** (§3). They are therefore *better* than
   today's production retrieval, which is the point.
9. **Single sample per cell.** Nothing here is statistically significant, and it is not
   meant to be — it is meant to be read.

## 13b. Dogfood tuning (clips 1–5, 2026-09-07)

Applied after the gpt-4.1 vs gpt-5.5 dogfood comparison. Evidence and root causes:
[AI-CONVERSATION-DOGFOOD-TUNING.md](AI-CONVERSATION-DOGFOOD-TUNING.md). All five are tool
contract, harness or payload — no planner, router, state machine, memory or prose guard, and
no `lib/` financial authority changed.

1. **Reasoning-aware completion budget.** `gpt-5.x` reasoning tokens are billed inside
   `max_completion_tokens`; a shared 1,500 cap was fully consumed by reasoning on two
   questions, returning `''` with `finish_reason: length`. Modern dialect now gets 8,000, and
   **an empty answer is recorded as a failure** instead of passing a `=== null` check.
2. **`get_net_worth_history` routes through `projectSnapshotSection`** — the pure function the
   snapshot assembler already uses — and gained `granularity: monthly` plus a `coverage`
   block. It previously read raw snapshot rows, which discarded
   `aggregateAuthorisation.netWorth.assertable` and reported 407 unassertable points as facts.
3. **`project_cash` receives the transactions domain.** Without it PROJECTION-1 saw zero
   reliable months and returned `closing: null` for every horizon, which is why both models
   hand-rolled the arithmetic. It also gained deterministic month-end checkpoints and an
   explicit `basis`, and its spending source is no longer mislabelled `USER_ASSUMED`.
4. **`get_transactions` gained a semantic `flow`** (spending / income / transfers /
   card_payments / refunds) mapped onto canonical `FlowType`, and **`sort: "largest"` now
   pages the keyset cursor to exhaustion** so a ranking covers the whole requested window
   rather than the newest page of it. The ceiling is the assembler's own
   `TRANSACTION_FETCH_LIMIT` (5,000), shared so a ranking and the summary beside it agree
   about what "all of them" covered; reaching it reports `rankingIsComplete: false` with a
   caveat rather than truncating silently. Plain `newest`/`oldest` still read one page.
5. **Every tool result names one instant** — `asOf`, `window` or `horizon`.
   `investment_scenario` states `effectiveAt` and that it does not move forward in time.

**The projection product decision (2026-09-07).** For an ordinary conversational projection
the **evidence-based estimate is the answer** when it is available. The strictly-licensed path
is retained as `establishment` — its `notEstablished` list is the honest account of what is
not pinned down — and it qualifies the estimate rather than competing with it. The strict path
is not deleted and its refusal reasons are preserved.

**The checkpoint invariant.** Every month-end checkpoint is an independent
`projectCash(asOf → thatMonthEnd)`. Balances are never carried forward from the previous
checkpoint, so the last checkpoint **is** the standalone endpoint for the same horizon rather
than nearly it. Verified on real data at 2026-12-31, 2027-12-31 and a mid-horizon 2027-06-30.

**Measured, same three questions, same model (`gpt-5.5`):**

| | Tool calls | Tokens | Payload | Latency | Answer |
|---|---|---|---|---|---|
| Before | 36 | 243,495 | 61,754 B | 103.0 s | contaminated · prose arithmetic · **blank** |
| After | **3** | **28,047** | **14,265 B** | **22.6 s** | coverage stated · engine figures · answered |

−92% calls, −88.5% tokens, −77% payload, −78% latency. *(Not perfectly controlled: the
"before" turns carried six turns of prior context. Tool-call counts and payload bytes are
directly comparable and are the dominant driver.)*

**Clip 6 (context compaction) is deliberately not implemented** — re-measure retention now
that a turn makes one call instead of thirty-three.

## 13c. Clip 6 — context compaction (2026-09-07)

**Context garbage collection. Not memory, not summarisation, not state.** One helper,
`scripts/ai-baseline/compaction.ts`, ~150 lines, pure.

**The policy.** After a turn's assistant prose lands, raw `role: 'tool'` content older than
the last **two completed turns** is replaced by `{"elided":true,"tool":"<name>"}` — 49 bytes
against a 3,222-byte mean payload. Everything else survives byte for byte: user messages,
assistant answers, and every assistant tool CALL (name and arguments, so `tool_call_id`
linkage is untouched).

**A turn is read off the transcript, not modelled.** It runs from a user message to the
assistant message that answers in prose. An assistant message carrying `tool_calls` is
mid-turn; one with **empty content is a failure, not an answer**, so a blank turn never
closes and never advances the window — its evidence is intact exactly when somebody would
look at it, and ages out later like any other turn. The **artifact keeps every payload
verbatim regardless**; diagnosis happens there, not in the model's context.

**What is deliberately not done:** nothing is summarised, no financial value is carried
forward, no judgement is made about which evidence mattered, and no message is dropped —
only emptied. If a later turn needs an elided figure the model calls the tool again. **That
is the feature**, not a cost: a stale payload sitting in context is exactly what would stop
a re-fetch.

**Measured — same 16-turn `session` probe, same model (`gpt-5.5`), before and after:**

| | Before | After | Δ |
|---|---|---|---|
| Total prompt tokens | 549,613 | **178,167** | **−67.6%** |
| Largest single prompt | 65,102 | **19,517** | **−70.0%** |
| Final retained tool tokens | 19,994 | **366** | **−98.2%** |
| Final tool-result share of transcript | 81.6% | **7.9%** | −73.7 pp |
| Late-turn (T8+) share | 82.0% | **34.1%** | −47.9 pp |
| Latency | 140.0 s | **106.1 s** | −24.2% |
| Completion / reasoning tokens | 7,980 / 3,518 | 7,073 / 2,823 | −11% / −20% |
| Turns answered · errors · blanks | 16 · 0 · 0 | 16 · 0 · 0 | — |

11 elisions removed **43,999 bytes** from context across the session.

**Continuity held on every referential follow-up:**

| Turn | Behaviour |
|---|---|
| *"pull em up in table for me"* | Same table, no re-fetch — the payload was still in the window. |
| *"which one was the biggest?"* | Same answer ($146.60, My Skin Health Care). |
| *"are you sure?"* | Answered from the retained payload; **before** it re-fetched, **after** it did not need to. Same figure. |
| *"based on what you said earlier about my pending transactions…"* (15 turns back, long elided) | **Re-fetched with 6 tool calls** and answered coherently. It understood the reference from preserved prose and never claimed to have lost the conversation. |

**Privacy side effect — quantified, not built.** After two completed turns, raw financial
payloads stop being retransmitted on every subsequent request. Across this session
**87.4% of tool-payload bytes (47,867 of 54,774) were no longer resent** by the final turn.
By category, entirely elided by the end: account balances and per-account detail
(`get_financial_snapshot`, 12,435 B), cash projections (`project_cash`, 10,565 B), net-worth
history (`get_net_worth_history`, 6,160 B), category and merchant rollups (`get_spending`,
5,410 B), and holdings (`get_investments`, 4,693 B). Only the most recent
`get_transactions` rows (6,907 B of 15,511 B) remained in flight. Conversational prose is
unchanged. *No privacy feature was built and no product copy changed — this is a
measurement for the later AI-egress audit.*

**Turn it off** with `--no-compaction` on either mode, which is also how the "before" column
above was produced.

## 13d. As-of coherence + information ceiling (slices 1–3, 2026-09-08)

The beta blocker from
[AI-BETA-REASONING-MEMORY-INVESTIGATION.md](AI-BETA-REASONING-MEMORY-INVESTIGATION.md).
Three tool-contract changes, no new authority, no engine change.

**1 — the naming collision.** `get_net_worth_history` mapped `cash: p.liquid` (checking +
savings) while `explain_net_worth_change{lens:'cash'}` returns the checking bucket. On
2026-01-01 that is **$9,517.46 vs $1,255.20**, both called "cash", both correct about their
own population. 4M quoted the smaller one and built debt advice on it.
**No result field is named `cash` any more** — `liquid` and `checking` are separate and
named — and a single-lens answer now carries `population { covers, siblingLenses }`.

**2 — `get_financial_snapshot(asOf)`.** Omit `asOf` for today (accounts authority: per-account
freshness, APRs, available balances). Pass a past date and it composes
`projectSnapshotSection` totals with the exploration tree's account-level buckets —
**213 ms, ~344 tokens, five buckets, coverage attached**. Nothing in the adapter adds two
money numbers: `liquid`, `checking` and `savings` each come from a different authority that
already computed them.

**3 — an information ceiling.** `get_spending`, `get_income`, `get_transactions`,
`get_investments` and `project_cash` take `asOf`. It is a **ceiling, not a default** — it
overrides a later explicit `to`, because a model that resolves the window first and the cutoff
second leaks the future without noticing. Critically it reaches
`loadForecastIncomeStreams(ceiling)`, which reconstructs the income world as it was: at
2026-01-01 the Abacus payroll is CURRENT and **Vectrus does not exist**.

`project_cash(asOf)` runs a **retrospective projection** — opening balance from the snapshot
authority for that date, spending windowed to the cutoff, engine run from that date. It labels
itself `retrospective: true` so it is never read as a current expectation. From 2026-01-01:
**$27,966.38** projected for 2026-09-07 against an actual **$12,382.81**.

**Measured, the exact question that failed:**

| | Before | After |
|---|---|---|
| First answer | *"only $1,255.20 cash"* → wrong advice | *"$9,517 liquid, $37,316 debt"* — **correct first time** |
| Under challenge | flip-flopped to $9,517 | explains checking $1,255 / savings $8,262 / liquid $9,517 and refines the advice |
| Tool calls · tokens | 4 · 28,804 | **3 · 10,701** |

## 13e. The scenario ledger (slice 4, 2026-09-08)

Turns 11–13 of the gpt-5.5 dogfood did three consecutive turns of consequential arithmetic
**in prose**: a five-year contribution-and-compounding table, then the same table with
per-year returns. Every figure was correct — I re-derived all of them — and not one was
reproducible, testable or traceable.

`scenario_projection` is one tool over `scenario-ledger.ts`, a pure function with **no
imports at all**. It computes nothing about cash: every checkpoint's balance arrives from
`projectCash(asOf → that date)`, and the ledger applies only what the user stated.

**One spine, two tools.** `buildCashSpine` was factored out of `project_cash`; both tools go
through it and a test asserts there is exactly **one** `assembleForecast` call site in
`tools.ts`. That is why the last checkpoint equals a standalone run to the same horizon —
by construction, not by comparison. Measured: the 2030-12-31 checkpoint and
`project_cash(to: 2030-12-31)` both return **$384,719.74**.

| Property | How it is guaranteed |
|---|---|
| No double count | a contribution is **one movement, two signs, one step** — cash down, investments up. At 0% the composed net worth is unchanged, asserted |
| No drift | investments at *d* are `opening × G(asOf,d) + Σ contribution × G(c,d)` — never last checkpoint carried forward |
| Returns compound only inside their stated period | half-open interval intersection; adjacent years tile exactly (×1.08 × ×1.08), and overlapping periods are **refused**, not blended |
| Default return is **0%** | an unstated return never becomes a market average; the result says so in words |
| A house does not vanish | assets that are neither cash nor investments are carried as `otherAssets`, held flat, and the opening is **reconciled against the accounts authority** in the payload |
| Provenance | every line carries the *set* of sources that produced it — `PROJECTED_FROM_EVIDENCE`, `MEASURED`, `HELD_FLAT`, `USER_ASSUMED`. A stated return can never read as measured |

**The defect the live run found — and reading the code would not have.** Asked to *"invest
half my liquidity each year at 8%"*, gpt-4.1 filled in `amount: -0.5`. The ledger moved fifty
cents. The table came back internally consistent to the penny and answered a question nobody
asked. **A share is not an amount** — half of the balance is only knowable at each date, from
the projection — so contributions gained `fractionOfLiquid`, the spine is evaluated on every
share date (marked `isCheckpoint: false`, so it is not a row in the table), and a dollar
amount under **$1** is now refused as a fraction in disguise. The share is of what *remains*:
on a date carrying both, an outflow settles first.

**Turns 10–13 re-run, gpt-4.1, one tool call each, zero prose arithmetic:**

| Turn | Before | After |
|---|---|---|
| 10 — yearly table to 2030 | the whole "implied net worth" column was model arithmetic | `scenario_projection` → **$408,677** at 2030, 1 call, 7.9k tok |
| 11 — "invest half my liquidity at 8%" | **zero tool calls**, five years of compounding in prose | `fractionOfLiquid: 0.5` → **$457,182**, with each year's share settled and reported ($19,193 → $54,889 → … → $81,478) |
| 12 — per-year returns 50/23/31 | zero tool calls, inherited scenario re-derived in prose | one call, correctly inherits the contributions → **$624,548** |
| 13 — "how could I reach $1M?" | invented *"mid-40% annualized returns"* and *"~$90K/year additional surplus"* | **no figure invented** — names the levers, states the $375k gap from the tool's own number, and offers to run them. Slice 5 (goal-seek) is what makes it numeric |

Payload is ~4.3–5.7 KB (~1.1–1.4k tokens) for a five-year table with every movement itemised.

## 14b. Interactive operator mode

**The A2 arm with a keyboard on the front.** Same thin-core evidence, same ten tools,
same ~140-word instruction, **same turn executor**, same artifact shape. Nothing about the
system under test differs — a session that had drifted from the batch runs would not be
comparable with them, and comparability is the whole reason the batch runs exist.

```bash
npm run ai:chat                     # pick a model at startup, default gpt-4.1
npm run ai:chat -- --model ceiling  # skip the picker
npm run ai:chat -- --space <id>     # a different Space
```

- **Model chosen at startup**, defaulting to `gpt-4.1` — the tier the recorded smoke run
  used, so a session and a probe run are directly readable against each other. The picker
  marks any model that **cannot call tools**, and choosing one is **refused** rather than
  silently downgraded: A2 is a tool arm, and running it without tools would be a different
  experiment wearing the same label.
- **In-session:** `/tools` shows the last turn's calls with their arguments and results,
  `/cost` shows tokens so far, `/exit` ends it.
- **The transcript is written after every turn and on Ctrl-C**, not only on a clean exit —
  a dogfooding session is abandoned at least as often as it is finished.
- Artifact: `tmp/ai-baseline/interactive-<timestamp>/interactive__A2__<model>.json`, with
  every field a probe artifact has plus `mode: "interactive"`, `sessionId` and `startedAt`.
  Key parity is asserted by test.

> **⚠️ It fixes nothing.** Every failure in §14 is still present: the current-versus-future
> instant confusion when `investment_scenario` meets `project_cash`, the licensed forecast's
> refusal, `get_transactions` ranking by absolute amount so "largest" can surface income.
> Those are what there is to dogfood.

## 15. Commands

```bash
npm run ai:chat                                            # interactive operator mode (A2)
npm run ai:baseline -- --list                              # probes, arms, models
npm run ai:baseline -- --smoke --dry-run                   # resolve the matrix, call nothing
npm run ai:baseline -- --smoke                             # 12 cases: 3 probes × 4 arms × mid
npm run ai:baseline -- --probe projection --arm A0 --model mid
npm run ai:baseline -- --probe projection --all-models
npm run ai:baseline -- --arm A0,A1 --model ceiling --all-probes
npm run ai:baseline -- --probe debt --arm A0,A1 --model control,mid,ceiling
npm run ai:baseline -- --space <spaceId> --probe broad --arm A2 --model mid
npm run ai:baseline -- --all                               # 120 cases — must be asked for
npm run ai:baseline -- --probe session --arm A2 --model ceiling   # the 16-turn retention probe
npm run ai:baseline -- --probe session --arm A2 --model ceiling --no-compaction
```

**Nothing runs without an explicit selection.** `--all` is 120 whole conversations against a
paid API; it is never the default and never implied.

## 16. What each arm will tell us

| Comparison | What it settles |
|---|---|
| **A0 vs A1** | Whether the deterministic verdict layer belongs in a conversation. If A0 says *"you basically don't have debt"* and A1 talks about missing APRs, most of the advisor-rules layer is unnecessary — the largest simplification available to this product. |
| **A0 vs A2** | Whether ~13k tokens of always-on context buys anything a 2k orientation plus tools does not. |
| **A2 vs A3** | Whether a thin core is load-bearing, or whether the model can start from nothing. |
| **control vs mid vs ceiling** | How much of the desired behaviour is model capability rather than architecture. |
| **`cadence` across arms** | Whether good evidence beats a wired rule: A0/A1 must infer the three-paycheck month; A2/A3 can read it. |
| **`projection` turns 5–8** | Whether conversation state is something we build. |

**None of these is answered by argument.** They are answered by reading transcripts.
