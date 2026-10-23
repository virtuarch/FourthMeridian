# Dogfood tuning — evidence report and proposed clip

**Date:** 2026-09-07 · **Branch:** `v2.6` · **Status:** investigation + plan. **Nothing implemented.**

Sources — two real interactive sessions on Chris' Space, same arm (A2), same tools, same
instruction:

| | Session | Turns | Tool calls | Tokens |
|---|---|---|---|---|
| **gpt-4.1** | `tmp/ai-baseline/interactive-2026-09-07T16-40-15-143Z` | 20 | 10 | 279,688 |
| **gpt-5.5** | `tmp/ai-baseline/interactive-2026-09-07T17-06-08-842Z` | 14 | 50 | 812,223 |

Production route unchanged (`503 AWAITING_REDESIGN`). Everything proposed below is a change
to a **tool contract**, the **harness**, or **context retention** — no planner, no router, no
state machine, no memory, no prose guard.

---

## 1. The headline correction

The product conclusion — *gpt-5.5 is better suited than gpt-4.1* — holds on **external-world
epistemics** and **retrieval initiative**, and the evidence supports not engineering around
those. But two of the failures attributed to gpt-4.1 were **not model failures**, and the
distinction changes what to build:

> **`project_cash` has never been able to return an evidence-based projection.**

The tool builds a synthetic context carrying **only the accounts domain**:

```ts
const fakeCtx = { space: {...}, domains: { [FinanceDomains.ACCOUNTS]: { data: accounts } } };
```

PROJECTION-1 derives its spending rate from `reliableMonths(transactionsDomain)`. With no
transactions domain it gets zero months, cannot assert a rate, and returns `closing: null`.
Measured directly:

| `project_cash` context | → 2026-12-31 | → 2027-12-31 |
|---|---|---|
| ACCOUNTS only *(today)* | `null` | `null` |
| ACCOUNTS + TRANSACTIONS | **$38,243.50** | **$128,827.54** |

So on the EOY question:

- **gpt-4.1 relayed the tool's refusal honestly** — *"I can't give a reliable end-of-year net
  worth projection right now."* That was correct behaviour against a broken tool.
- **gpt-5.5 hand-rolled the arithmetic in prose** and produced `$38,989.36` — **$745.86 off**
  the engine's `$38,243.50`.

The better-looking answer was the one that violated the boundary. **5.5 masked a tool bug
that 4.1 surfaced.** Both models hand-rolled when the tool would not answer: 4.1 did the same
thing for 2027 (`$132,886` vs the engine's `$128,827.54`).

**Implication:** fix the tool first and re-measure the tier. Some of the 4.1 gap may close.

---

## 2. Findings

| | Finding | Classification | Root cause |
|---|---|---|---|
| **A** | History token explosion | **TOOL CONTRACT** | No monthly granularity; oversized daily payload |
| **B** | Context accumulation | **CONTEXT MANAGEMENT** *(smaller lever than assumed)* | Round-trip amplification ≫ retention |
| **C** | Monthly checkpoints invented | **TOOL CONTRACT** | `project_cash` returns an endpoint, and `null` at that |
| **D** | 2027 blank response | **HARNESS** | `max_completion_tokens: 1500` consumed by reasoning tokens |
| **E** | Dubai blank response | **HARNESS** | Identical to D |
| **F** | Historical coverage semantics | **TOOL CONTRACT** | Tool bypasses the assembler that already refuses |
| **G** | Assumption transparency | *(preserve — no change)* | Already works |
| **H** | `get_transactions` ranking | **TOOL CONTRACT** | No flow filter; ranks abs() over a bounded page |
| **I** | Temporal composition | **TOOL CONTRACT** | Two of nine results carry no effective instant |
| **J** | Model picker accepts anything | **HARNESS** | Unvalidated free-text model id |

### A — History retrieval token explosion

**Turn 6:** *"how much in assets did i have month by month 2025?"* → **33 tool calls, 5 round
trips, 145,550 prompt tokens** for a 12-row table.

The model's **first call was correct**:

```
get_net_worth_history{from: 2025-01-01, to: 2025-12-31, maxPoints: 370}
  → 29,456 bytes (~7,364 tok), 183 DAILY points
```

It then made 32 more calls — 12 `get_net_worth_history` single-day queries and 20
`explain_net_worth_change` calls — to recover month-ends it could not reliably pick out of a
183-point daily series.

Two contract defects:

1. **No monthly granularity.** The tool downsamples *evenly* (`i % step === 0`), which never
   lands on month boundaries. `maxPoints` also silently clamps at 200 while the model asked
   for 370.
2. **The payload is the whole series.** 159 bytes × 183 points, when a year of month-ends is
   12 points ≈ 1,900 bytes.

**Not a 5.5 problem to engineer around — but note the asymmetry:** gpt-4.1 answered the same
question in **one call and 20,768 tokens** (7× cheaper) by trusting the daily series. Both
answers used the *same wrong numbers* (finding F). 5.5's extra calls were verification
behaviour that a better contract removes.

**Quantified waste:** ~145,550 → an estimated **~14,000** tokens with a monthly option
(one call, ~2K payload, 2 round trips). **≈90% reduction on this turn.**

### B — Context accumulation

Measured across the 5.5 session:

| | |
|---|---|
| Cumulative retained tool-result tokens by turn 13 | **~33,215** |
| Cumulative user + assistant tokens | **~3,568** |
| Ratio | **9.3 : 1** |
| Retained tool payload as a share of a late-turn prompt | **30–64%** |
| Total prompt tokens billed | **794,528** |

**The hypothesis is half right.** Raw tool payloads do dominate the conversation transcript
9:1 — but retention alone does not explain the cost. At turn 13 the whole context is ~36K
tokens, yet the turn billed **101,572 prompt tokens across 2 round trips**. The multiplier is
**round trips**: every hop resends everything accumulated so far *including the payloads
appended earlier in the same turn*.

So the ordering is:

1. **Reduce calls per turn** (A, C) — biggest lever, and it is a contract fix.
2. **Then** compact old payloads — worth ~30% of a late prompt, and only worth doing after
   (1) lands, because (1) changes what there is to compact.

Verified separately: the assistant tool-call message is small (191 bytes) and carries **no
replayed reasoning blob**, so nothing hidden is inflating the transcript.

### C — Monthly cash projection checkpoints

**Turn 4** produced the month-by-month table with **zero tool calls** and `roundTrips: 1`.
Every number except the `$12,382.81` opening was **computed by the model in prose**, because
turn 3's `project_cash` returned:

```json
"evidenceBasedProjection": { "endingCash": null, "spendingBasis": { "kind": "USER_ASSUMED" } }
```

Two defects, both in the adapter:

1. The `fakeCtx` starvation of §1 — `endingCash: null`.
2. **The `spendingBasis` label is a lie.** The tool emits `USER_ASSUMED` whenever
   `observedSpending` is absent, even when the user assumed nothing.

`projectCash` is a **pure function**. Monthly checkpoints need no engine change and no new
subsystem — the tool can call it once per month boundary over `[asOf, monthEnd]` and return
the series. Cost is microseconds.

### D + E — Blank responses (same root cause)

Both turns recorded `finish_reason: 'length'`, `assistant: ''`, **`error: null`**, `ok: true`.

| Turn | Question | Completion tokens |
|---|---|---|
| 7 | 2027 month by month | 1,972 |
| 9 | Dubai house | **exactly 1,500** = the harness cap |

Reproduced against the live API:

| `max_completion_tokens` | `reasoning_tokens` | content | finish |
|---|---|---|---|
| **1500** | **1500** | **0 chars** | `length` |
| 8000 | 1536 | 2,024 chars | `stop` |

**gpt-5.x reasoning tokens count against `max_completion_tokens`.** On hard questions the
model spends the entire budget reasoning and emits nothing.

Compounding it, `executeTurn` treats `''` as an answer:

```ts
if (out.toolCalls.length === 0) { rec.assistant = out.content; break; }
...
if (rec.assistant === null && !rec.error) { rec.error = '...'; }   // '' !== null
```

So the blank was never recorded as an error. **Not a capability gap, not context exhaustion,
not a tool error, and 2027 projections work fine** ($128,827.54, measured).

### F — Historical coverage semantics

**The engine already knows.** Raw `Snapshot` rows carry `aggregateAuthorisation`,
`cryptoValuationState`, `cryptoAssertable`, `cryptoLastKnown`, `assetSideContaminated` and
`cryptoUnavailableReason`. For 2025-01-01:

```json
"netWorth": { "assertable": false, "state": "UNAVAILABLE",
              "unassertableComponents": ["crypto"],
              "refusalReason": "AGGREGATE_COMPONENT_UNASSERTABLE" }
"cryptoUnavailableReason": "HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE"
"cryptoValuationState": "unavailable"   "cryptoAssertable": false
```

`projectSnapshotSection` — a **pure, exported, already-tested** function in the snapshot
assembler — turns exactly this into `netWorth: null`, `digitalAssets: null`, a
`digitalAssetsUnavailableReason`, and a section-level `unassertableCryptoPoints` count.

**`get_net_worth_history` bypasses it**, reading raw `Snapshot` fields directly (I wrote it
that way to get past the assembler's 90-row cap). It gained depth and lost provenance.

| Month-end 2025 | Tool reports today | The assembler would report |
|---|---|---|
| Jan–Jul | `digitalAssets: 15516.70`, `netWorth: −6837.37` | `null` + `HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE` |
| Aug | `26186.27`, `−5097.82` | `null` + reason |
| Sep onward | `48965.13`, `19264.21` | same (assertable) |

**407 of 770 snapshots (53%) are unassertable.** The crypto coverage boundary is
**2025-09-01**. The repeated `$15,516.70` is a stale figure on a contaminated row — not
measured, not reconstructed.

**This is why the model told Chris he had negative net worth in early 2025.** Both models did;
it is not a hallucination, it is the tool asserting numbers the engine already refuses.

### G — Assumption transparency

Working. `project_cash` already returns `strictlyLicensed.refusedBecause`,
`evidenceBasedProjection.spendingBasis`, `appliedUserFacts`, `incomeEventsCounted` and
`policyAssumptions`. 5.5 used them well. **No change** beyond fixing the mislabelled
`spendingBasis` (§C) and adding the checkpoint series. **Do not dampen the projection.**

### H — `get_transactions` ranking

`queryTransactions` supports `flowTypes` (SPENDING / INCOME / TRANSFER / DEBT_PAYMENT). **The
tool does not expose it.** Plus `'largest'` ranks `Math.abs(amount)` over a **100-row page
taken newest-first**, so on a long window it ranks only the newest 100 — silently wrong twice
over.

### I — Temporal composition

Seven of nine tool results carry an instant. **Two do not:**

| Tool | Temporal field |
|---|---|
| `get_investments` | **none** |
| `get_transactions` | **none** |
| `investment_scenario` | **none** — and it returns a *current-instant* scenario net worth |

Observed in the batch smoke run: the model glued `investment_scenario`'s current scenario net
worth to `project_cash`'s February cash figure and presented them as one answer.

### J — Model picker accepts anything

Session `interactive-2026-09-07T16-37-53-568Z`: Chris typed his first question at the
`Choose [1-4…]` prompt. `TIERS[raw] ?? raw` accepted it as a model id, and **three turns then
failed with `400 invalid model ID`** before he gave up. The picker validates nothing.

---

## 3. What NOT to engineer around

These are genuine 4.1-only weaknesses that 5.5 already handles. **Do not build guards.**

| | 4.1 | 5.5 |
|---|---|---|
| Age percentile | invented US median net worth by cohort from model memory | *"I can't give a true percentile from your financial data alone — I'd need a benchmark dataset"* |
| BYD in Riyadh | invented pricing | asked for the model/price |
| Portfolio question | answered generically, **no `get_investments` call** | called it; used the real 79% concentration, stale Schwab accounts and unpriced holdings |
| Retrieval initiative | 10 tool calls / 20 turns | 50 / 14 |

**External-world facts remain an EXTERNAL AUTHORITY GAP** — no tool exists, and none is
proposed here. The correct behaviour is what 5.5 already does: reason from measured finances,
name what it would need, and ask.

---

## 4. Proposed tuning clip

Ordered by leverage. **All of it is contract, harness and payload.** No new module except one
pure helper.

### Clip 1 — Harness: stop losing answers *(D, E, J)*

`lib/ai/provider.ts`
- `generateWithTools`: default `maxTokens` 1500 → **8000** for modern-dialect models (keep
  1500 for `gpt-4.1`/`gpt-4o-mini`, where it is content-only).
- Capture `completion_tokens_details.reasoning_tokens` into `ToolTurnResult.usage`.

`scripts/ai-baseline/run.ts`
- `executeTurn`: treat empty/whitespace content as a failure —
  `if (!out.content?.trim() && out.toolCalls.length === 0)` → record an error naming
  `finishReason` and the reasoning-token spend.
- Add `reasoningTokens` to `TurnRecord.usage` and to `sumTurns`.

`scripts/ai-baseline/interactive.ts`
- Print `finishReason` when a turn produces no text.

`scripts/ai-conversation-baseline.ts`
- `chooseModel`: reject an unrecognised entry (re-prompt), instead of `TIERS[raw] ?? raw`.

### Clip 2 — `get_net_worth_history`: granularity + coverage *(A, F)*

`scripts/ai-baseline/tools.ts`
- Route rows through **`projectSnapshotSection(rows, 'full')`** instead of reading raw
  `Snapshot` fields. Nulls, `digitalAssetsUnavailableReason` and `unassertableCryptoPoints`
  come for free from the authority that already computes them.
- Add `granularity: 'monthly' | 'daily'`, **default `monthly` when the range exceeds 92 days**.
  Monthly = the last point in each calendar month.
- Add a `coverage` block: `{ pointsUnassertable, firstFullyAssertableDate, reason }`.
- Drop `maxPoints` for the monthly path; keep it for `daily` and stop silently clamping —
  report the clamp.

Description gains one line: *"Ask for monthly granularity for a month-by-month series; each
point states whether its net worth is assertable."*

### Clip 3 — `project_cash`: real projections + checkpoints *(C, G, and half of A/B)*

`scripts/ai-baseline/tools.ts`
- **Pass the transactions domain into the forecast context.** One line; unblocks PROJECTION-1.
- Fix `spendingBasis`: emit `{ kind: 'NONE', reason }` when neither observed nor assumed,
  rather than mislabelling it `USER_ASSUMED`.
- Add `checkpoints: 'monthly' | 'none'` (default `monthly` when the horizon exceeds ~45 days):
  call the **existing pure `projectCash`** once per month-end and return
  `[{ monthEnd, openingCash, inflows, spending, closingCash }]`.
- Return `basis` naming the income cadence, deposit count, spending rate and its window —
  the pattern §G says to preserve, as data rather than prose.

### Clip 4 — `get_transactions`: semantic flow *(H)*

- Add `flow: 'spending' | 'income' | 'transfers' | 'card_payments' | 'all'` → map to
  `queryTransactions.flowTypes`. **The model chooses**; no keyword routing.
- Rank `'largest'` **within the filtered flow**, and state the page bound in the result
  (`rankedOver`, `pageBounded: true`) so a truncated ranking is never silent.

### Clip 5 — Temporal identity *(I)*

- Every tool result carries exactly one of `asOf` (instant), `window` (range) or `horizon`
  (projection). `get_investments` and `get_transactions` gain `asOf`.
- `investment_scenario` gains `effectiveAt: asOf` and renames its output to make the instant
  explicit — it is a **current-position** scenario and must not be composed with a future
  cash figure.

*No MeasureId. Three fields.*

### Clip 6 — Context compaction *(B)* — **only after re-measuring**

After clips 2–3, turn 6 should fall from 33 calls / 29KB to ~1 call / ~2KB. Re-run the same
session and re-measure before touching retention.

If retained payload still exceeds ~25% of a late-turn prompt, the smallest fix is: after a
turn's assistant text lands, replace tool-result **content** older than the last 2 turns with
a stub — `{tool, arguments, shape, elidedBytes}` — keeping `tool_call_id` linkage intact.
Conversation transcript untouched. The model can always re-fetch.

**Not proposed now.** Measure first.

---

## 5. Expected diff

| File | Change |
|---|---|
| `lib/ai/provider.ts` | +~15 · reasoning-aware token budget, `reasoningTokens` in usage |
| `scripts/ai-baseline/run.ts` | +~15 / −2 · blank-answer detection, reasoning tokens in totals |
| `scripts/ai-baseline/interactive.ts` | +~5 · surface `finishReason` |
| `scripts/ai-conversation-baseline.ts` | +~8 / −2 · validate the model choice |
| `scripts/ai-baseline/tools.ts` | +~140 / −40 · clips 2–5 |
| `scripts/ai-baseline/baseline.test.ts` | +~60 · below |
| `docs/plans/AI-CONVERSATION-BASELINE-HARNESS.md` | update §6, §12, §14 |

**No `lib/` financial authority changes. No production route change. No new subsystem.**
`projectSnapshotSection`, `projectCash`, `queryTransactions` and the exploration tree are all
consumed as they are.

## 6. Tests

New checks in `scripts/ai-baseline/baseline.test.ts` (pure, no model, no DB):

1. Empty/whitespace assistant content with no tool calls **records an error** — the D/E bug.
2. `finishReason` is carried onto the turn record and into the artifact.
3. The token budget is reasoning-aware: modern-dialect models get the larger cap.
4. `usesModernParams` / budget mapping is table-driven and covers 4.1, 4o-mini, 5.x, 6.x.
5. An unrecognised model entry is rejected, not passed through as an id.
6. `get_net_worth_history` **imports `projectSnapshotSection`** and does not read
   `totalCrypto` / `netWorth` off a raw row (source scan — the bypass must not return).
7. Monthly granularity yields one point per calendar month, month-end dated.
8. A point whose net worth is unassertable is emitted as `null` **with a reason**, never as a
   number and never dropped.
9. `project_cash` passes the transactions domain (source scan on `fakeCtx`).
10. `spendingBasis` is never `USER_ASSUMED` when no user fact was applied.
11. Monthly checkpoints are produced by `projectCash`, not by arithmetic in the adapter
    (source scan: no `+`/`*` over money in the checkpoint builder).
12. Checkpoint closings are monotonic in the horizon and the last equals the endpoint.
13. `get_transactions` exposes a flow filter that maps to `flowTypes`, and `'largest'` ranks
    within the filtered flow.
14. Every tool result carries exactly one temporal field.
15. `investment_scenario` result names its effective instant.

Plus a **live re-run** of the same three questions that failed, measuring before/after:

| Question | Before | Target |
|---|---|---|
| *"month by month 2025"* | 33 calls · 145,550 tok · wrong numbers | ≤3 calls · <20,000 tok · unassertable months stated |
| *"cash growth month by month"* | 0 calls · prose arithmetic · $38,989.36 | ≥1 call · engine checkpoints · $38,243.50 |
| *"2027 month by month"* | **blank** | an answer, or a stated reason |

## 7. Open question for the product owner

`project_cash` returns both paths. On this Space the **strictly-licensed path always refuses**
(it needs a NET/GROSS basis on every income event — six assertions), and the **evidence-based
projection** is the only one that answers. Clip 3 makes the second path work as designed; it
does **not** decide which deserves product authority.

That decision is still open, and the tuned harness is how to inform it.
