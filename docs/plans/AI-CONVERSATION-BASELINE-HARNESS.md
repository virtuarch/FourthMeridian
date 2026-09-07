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

Ten adapters over authorities that already exist. **Not one computes a financial figure.**

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
| `investment_scenario` | new, §7 | the one genuinely new calculation |

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
