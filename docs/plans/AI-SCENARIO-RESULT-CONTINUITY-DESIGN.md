# Scenario result continuity — design

**Date:** 2026-09-13 · **Design only. No repository behaviour changed.** 501/501 test files pass.

Authority: 1d67786 (investigation), 54eb8e1 (applied-facts fix), b6c7cf1, 0b6d794, cf729e8,
Clip 6, 50de1aa / 666cf6f.

> ## Recommendation
>
> **An active-scenario envelope: `{assumptions, result}`, written together from one successful
> `scenario_projection` call, held in conversation runtime, injected once per turn immediately
> before the user's message, cleared on a failed recomputation.**
>
> **~106 tokens**, of which only ~32 are genuinely new — the assumptions already survive Clip 6 as
> tool-call arguments. **No schema, no migration, no new store, no new financial logic.** The write
> hook is the line `checkpointProjection` already occupies, with the opposite tool filter.
>
> The invariant it buys: **there is never a current result that was not produced by the assumptions
> shown beside it**, because the pair has one write site and no partial-update path. What it does
> *not* buy is compelled recomputation — §5.4 states the residual honestly.

---

## 1. Current architecture

Inspected, not inferred.

**1. What `scenario_projection` returns** (`tools.ts` `presentScenario`): `asOf`, `horizon`,
`reconciliation`, `assumptions`, `opening`, `checkpoints[]`, `movements`, `rejected`, `warnings`,
`basis`, `qualification`. On the live example: **4,074 bytes / ~1,019 tokens**.

**2–3. Structured assumptions.** `assumptions` comes from the pure helper
`scenarioAssumptions(setup, ledger, returns)`: `returns` (or a refusal note), `contributions`
(`scheduled`/`total`/`settled`/`provenance`), `outflows` (`count`/`settled`/`provenance`),
`spending` (`source`/`monthly`). `scenario_goal_seek` emits the **same structure** under the name
`assumptionsInForce`, on every path including refusals. **`scenario_projection` has no field called
`assumptionsInForce`.**

**4. Retained after the call:** the assistant tool-call message (name + arguments, verbatim) and the
`role: 'tool'` result message.

**5. What survives Clip 6:** user messages, assistant prose, and **tool CALLS including arguments**
survive byte for byte; raw tool-result CONTENT older than the active turn plus 2 completed turns
becomes `{"elided":true,"tool":"…"}`. Measured in 1d67786: at the failing turn the scenario's
**arguments were still present** and its **result was a stub**.

**6. Checkpointed:** `project_cash` only. `checkpointProjection` returns `null` for every other tool
(`memory-tools.ts:71`), documented at `:57`. Scenarios are deliberately not durable.

**7. Anything resembling a current-scenario representation: none.** `scenario-ledger.ts` is a pure
function (677 lines, zero data access); `prepareScenario` runs per call; `run.ts` and
`interactive.ts` hold only `messages` and `turns`. There is no conversation-scoped financial state
of any kind.

**8. Where goal-seek differs:** it takes `SCENARIO_INPUTS` **plus** `target`, `by`, `solveFor`,
`measure`, and returns a solved lever value (or `feasible: false` with how far the range got)
alongside the ledger at that value. **Its assumption half is identical; its result half is a
different shape.** §12.

### 1.1 The tool is already fully re-specifiable

`scenario_projection(to, granularity, annualReturnPct, returns, contributions, outflows,
assumedMonthlySpending)` — **every assumption is an argument, and the tool is stateless.** A
follow-up with a changed assumption is already expressible today by calling it again with the
updated set.

**This is the most important fact in the design: no new financial logic is needed. The remedy is
state exposure, not computation.**

---

## 2. The failure mechanism, restated precisely

```
turn  9  project_cash  →  baseline EOY liquid 35,898.84      → CHECKPOINTED (durable)
turn 10  scenario_projection{outflows:[{2026-12-07, -15000}]}
                       →  liquid 50,898.84  (= baseline + 15,000.00 exactly)  → not checkpointed
turn 11  user changes the assumption to ~15,700
         model updates in PROSE.  RAW RESULT STILL IN CONTEXT.  Tool not re-run.
turn 12  prose carries net worth only — no cash figure at all
turn 13  no structured figure anywhere; the model reconstructs cash from prose
         and picks 35,898.84 (+700) — the superseded baseline
```

Three properties made the last step possible:

1. **No machine-readable current figure existed.** All eleven tool results were stubs; 136 bytes,
   2.5% of retained content.
2. **The surviving prose mislabelled the newer figure.** The assistant itself wrote *"**Previous**
   projection with a $15k net bonus had you around ~$50.9k"* while the baseline read as a standing
   statement. The superseded number carried the more authoritative-sounding label.
3. **The assumption changed with the answer on screen.** Turn 11 revised $15k → $15.7k while the raw
   result was still raw. That is where truth left the engine.

---

## 3. Requirements

| | |
|---|---|
| **R1** | A result and the assumptions that produced it are written together and replaced together. No path updates one without the other. |
| **R2** | When a recomputation is attempted and fails, there is **no** current result. The old one is not left labelled current. |
| **R3** | Survives Clip 6 without retaining raw tool payloads and without widening the retention window. |
| **R4** | Transient. A hypothetical must not become durable user intent, must not reach `SpaceMemory` by default, and must not leak into a later session. |
| **R5** | Does not become a second source of financial truth. It is *what the stated hypothetical comes to*, never *what is true*. |
| **R6** | Costs nothing on turns where nothing changed — no recomputation merely because a turn happened. |
| **R7** | No new financial logic, no schema, no migration, no prose parser, no classifier. |
| **R8** | Verifiable structurally: a test can replay the stored assumptions and reproduce the stored result. |

---

## 4. Candidate comparison

| | correctness | size | Clip 6 | persistence | stale prevention | model burden | tokens |
|---|---|---|---|---|---|---|---|
| **A · envelope** | pair is atomic by construction | ~1 type + 1 hook + 1 injection | orthogonal — not a tool message | runtime only | **structural for R1/R2; visible-not-compelled for prose drift** | none — written by the loop | **~106** |
| B · replay from tool history | recomputes stale assumptions with equal fidelity | small | fine | runtime | **none** — replays A₁ faithfully | none | ~0 + a full tool run **every turn** |
| C · pin the raw result | figure survives | trivial | **fights Clip 6's stated doctrine** | runtime | **negative** — makes staleness durable | none | **~1,019/turn** |
| D · transient checkpoint-shaped record | works | larger — the checkpoint payload is single-metric (`{metric, horizon, value, basis}`); a scenario needs four metrics + the assumption set | fine | runtime, but the **name invites durability confusion** | as A | none | ~106 |
| E · no new state | — | zero | — | — | **fails** | high | 0 |

**Why E is rejected, on evidence rather than taste.** 1d67786 §2.1: the model had an unambiguous
prose statement of the correct figure and did not use it, because the *surviving prose labelled the
newer figure as previous*. An instruction would be asking the model to distrust its own earlier
sentence. And 54eb8e1's validation is the control: making the `project_cash` schema truthful
**worked structurally** (5/5 claimed nothing) while **behaviour did not move** (5/5 still chose
`project_cash`). Structure changes outcomes; exhortation does not.

**Why C is rejected.** `compaction.ts` states the architecture it encodes: *"a stale payload sitting
in context is exactly what would stop it [re-fetching]. Re-fetching is the feature."* Pinning a
result whose assumptions may have drifted makes the stale figure *more* durable, not less. And the
1d67786 discriminator could not show retention helps (n = 1 per arm).

**Why B is rejected as primary, and kept as a component.** Replay is feasible — the arguments
survive — but it re-runs the *stale* assumption set with perfect fidelity, so it does not address
the failure, and it costs a scenario computation per turn. **B is, however, exactly what makes A
verifiable (§14) and what makes A cheap: A is B's answer, computed once, at the moment the tool
ran.**

**Why D is rejected.** The hook position is right and is adopted; the *shape* is wrong (single-metric,
built for cross-session reconciliation) and the *name* would blur the persistence boundary R4 exists
to defend.

---

## 5. Recommended remedy

### 5.1 Shape — derived from existing types, inventing nothing

```jsonc
activeScenario: {
  "tool": "scenario_projection",
  "computedAtTurn": 10,
  "assumptions": { /* the tool-call arguments object, verbatim */
    "to": "2026-12-31", "granularity": "monthly",
    "outflows": [{ "onDate": "2026-12-07", "amount": -15000, "label": "bonus (net)" }]
  },
  "result": { /* projected from the tool's own output at the horizon */
    "asOf": "2026-09-12", "to": "2026-12-31",
    "liquid": 50898.84, "investments": 24346.97, "debt": 0, "netWorth": 75245.81
  }
}
```

**423 bytes / ~106 tokens** against the raw result's 4,074 B / ~1,019 tok.

`assumptions` is the **arguments object verbatim** — already the complete, canonical assumption set
(`SCENARIO_INPUTS` + `to`), already preserved by Clip 6 elsewhere in the transcript. No new type is
declared for it. **The only genuinely new content is `result`: 128 bytes / ~32 tokens.**

`result` is a projection of `presentScenario`'s last checkpoint. It carries the four metrics and the
two dates and nothing else — no movements, no per-period table, no prose. Those remain in the raw
result while it lives and are re-fetchable after.

### 5.2 Why no fingerprint

The brief asks. **Not needed, and adding it would defend against a mutation the design forbids.**
A fingerprint protects a pair that can be updated independently; here there is exactly one write
site and it assigns both halves from one tool result, so `result` cannot come from assumptions other
than the ones beside it. The right guard is the **replay test** (§14), which proves the coupling
empirically rather than asserting it with a hash. If the envelope ever gains a partial-update path,
that is the moment to add a fingerprint — and the moment to ask why it gained one.

### 5.3 Why a single active scenario

Sufficient for beta, and the evidence is the failure itself: it involved **one** hypothetical
revised in place. Multiple named scenarios would require user-visible identity ("scenario 42"),
which the product target explicitly rejects. Comparison across hypotheticals is already available by
calling the tool twice and reading both results in one turn — no long-lived branch needed. **Build
one slot.**

### 5.4 What this does and does not guarantee — stated plainly

**Guaranteed (R1, R2):** no current result ever exists that was not produced by the assumptions
shown beside it, and a failed recomputation leaves no current result at all.

**Not guaranteed:** that the model re-runs the tool when it revises an assumption in prose. Nothing
short of a prose parser can detect that, and a parser is rejected.

**What actually changes at the failing turn.** With the envelope, turn 13 would have seen a
structured `liquid: 50,898.84` sitting beside `outflows[0].amount: -15000`, and its own prose saying
$15.7k. The likely outcomes, in order: re-run (correct); use 50,898.84 + 700 = 51,598.84 (correct to
the dollar, by the same prose arithmetic it already performed); reach for the baseline anyway. The
third is now the *worst-supported* option rather than the best-labelled one.

> **The remedy inverts which figure carries structural authority.** Today the superseded baseline is
> the only checkpointed, structured year-end number and the scenario is prose. After this, the
> scenario is the structured one and the baseline is a sentence. That inversion is the mechanism,
> and §14/§16 make it measurable.

---

## 6. Lifecycle

```
NONE ──(scenario_projection succeeds)──────────────► ACTIVE(A₁, R₁)
ACTIVE(A₁,R₁) ──(scenario_projection succeeds A₂)──► ACTIVE(A₂, R₂)      whole replacement
ACTIVE(A₁,R₁) ──(scenario_projection fails / unavailable)──► NONE        R2
ACTIVE(A,R)   ──(any other turn: advice, prose, project_cash)──► ACTIVE(A,R)   unchanged   R6
```

- **Create / update — one site.** In `executeTurnInner`, on the line
  `const checkpointed = await checkpointProjection(toolCtx, call.name, result);`. That hook already
  exists, already filters by tool name, is already silent, and already *"cannot affect the answer"*.
  The envelope is the same hook with the opposite filter and a conversation-local destination.
  **Both halves are assigned in one statement from one `result`.** There is no setter for either
  half alone.
- **Invalidate.** A scenario call that returns `unavailable` or throws **clears** the envelope. The
  new assumptions remain conversationally understood; there is simply no current total (§13).
- **Recompute.** The model calls the tool again with the updated set — which the envelope is showing
  it, so restating is cheap rather than a memory exercise.
- **Consume.** Injected once per turn (§8).
- **Clear.** On failure only. **Not** on a turn count and **not** on topic change: both would be
  heuristics, and a self-describing stale envelope (it carries `computedAtTurn` and its own
  assumptions) is strictly safer than an absent one. Named residual: a scenario from twenty turns
  ago still presents as active.

---

## 7. Interaction with Clip 6

**No change to compaction, and no coupling to it.** The envelope is not a tool-result message, so
`compactToolHistory` — which only rewrites `role: 'tool'` content — never touches it. The retention
window stays at 2. Raw scenario payloads keep ageing out exactly as they do now, and the re-fetching
doctrine is preserved: the envelope holds six numbers, not a payload, so it cannot substitute for
calling the tool.

**Placement matters for cost.** The envelope is held in a loop variable and written into a single
reserved slot **immediately before the user's message**, replaced each turn rather than appended.
Placing it early (right after the orientation) would invalidate the prompt cache for everything
after it on every scenario change; placing it last confines that to the tail. State this in the
implementation slice — it is the difference between ~32 new tokens and re-paying for the whole
prefix.

---

## 8. Interaction with `project_cash` baselines

**Baseline evidence is not deleted or demoted.** `project_cash` keeps returning what it returns, the
orientation keeps saying what it says, and the model can discuss both.

The distinction is carried by shape, not by precedence rules: the envelope is the only object that
pairs a figure **with the hypothetical assumptions that produced it**. A baseline has no
`assumptions` block because nothing was assumed. So *"which is current?"* does not need a rule —
*"current, given what you said"* is structurally a different object from *"projected from
evidence"*, and the envelope says so on its face.

No precedence logic is proposed. If dogfood shows the model conflating them, that is a measurement
to act on, not something to pre-empt with a rule.

---

## 9. Interaction with checkpoints

**No policy change.** `checkpointProjection` continues to return null for scenarios.

The asymmetry 1d67786 flagged — the superseded baseline is durable, the scenario is not — is
**partially addressed and deliberately not closed**. The envelope makes the scenario the structurally
authoritative figure *within the conversation*; it remains non-durable *across* conversations, which
is correct under R4.

**Could a recalled checkpoint confuse the active scenario?** Not today: the orientation's memory line
names `projectionsOnRecord` with horizons and **no amounts** (verified 1d67786 §6), so it cannot
supply a competing figure. `reconcile_projection` can surface an amount on demand, and the two answer
different questions — a checkpoint is *a statement made in the past*, the envelope is *the
hypothetical now*. If a precedence rule ever becomes necessary it belongs at the state level and
should be stated as: a checkpoint is never the current scenario, and the current scenario is never a
checkpoint.

---

## 10. Interaction with `SpaceMemory`

**Not the store, and this is the sharpest boundary in the design.**

- 50de1aa made memory **user-owned durable intent**; a hypothetical is neither durable nor an
  intention. *"If Bitcoin rises 20% by December"* must not become a belief on record.
- Memory is per-Space and per-user across sessions, so a scenario stored there would leak into later
  conversations — a direct R4 violation.
- The explicit path already exists and stays: if the user says *"remember I'm expecting a $15.7k
  bonus"*, that is a `remember` call, user-initiated, with its own `statedAs`.

The envelope dies with the process. That is the feature.

---

## 11. Model vs code responsibility

Unchanged from the architecture the design exists to protect:

- **The model owns meaning.** It decides that *"actually call it $15.7k"* means the outflow amount
  becomes −15,700, and it expresses that by calling the tool with the updated set. No parser, no
  classifier, no intent taxonomy.
- **Code owns money.** Every figure in the envelope came from the ledger. The envelope adds no
  arithmetic — it is a projection of a result, not a computation over one.

The smallest interface for "update / add / remove / re-horizon" is **the existing tool**, because it
already takes the complete assumption set (§1.1). The envelope's contribution is that the model can
*see* the set it is amending rather than reconstructing it from a transcript.

---

## 12. Interaction with `scenario_goal_seek`

**Assumption half: identical** — both tools take `SCENARIO_INPUTS`, and goal-seek's
`assumptionsInForce` is the same `scenarioAssumptions()` output under a different name.

**Result half: different** — goal-seek produces a solved lever value, a feasibility verdict, and the
ledger at the solution.

**Recommendation: design the envelope so goal-seek fits, implement `scenario_projection` first.**
`result` gains optional `solveFor` / `solvedValue` / `feasible` and the assumptions half is untouched.
Do not build it in the first slice: goal-seek did not participate in the observed failure, and a
union type carried for a case nobody has hit is the kind of generality §18 rejects.

---

## 13. Failure and retry

The explicit transition, per the brief:

> assumptions change → recomputation attempted → **fails** → **the envelope is cleared**.

Consequences, in order of importance:

1. The new assumptions remain conversationally understood (they are in the user's message and the
   model's prose — untouched).
2. There is **no current scenario result**. The model cannot cite a total that was never computed.
3. The prior result is **not** retained "just in case". Retaining R(A₁) under a changed assumption
   set is the exact failure this design exists to prevent, and a failed retry is precisely when the
   temptation is strongest.
4. The failure is observable in the turn record (the tool result already carries `unavailable` /
   `error`), so a dogfood session shows how often this path fires.

---

## 14. Structural verification

Three seams, in increasing strength. None inspects prose.

1. **One write site, both halves** — a source tripwire in the style of `baseline.test.ts` §13h:
   `result` is never assigned except in the same statement as `assumptions`, and no exported setter
   exists for either alone.
2. **Replay coupling (the real one).** Given an envelope, re-running `scenario_projection` with
   `envelope.assumptions` must reproduce `envelope.result` **exactly**. This is candidate B used as a
   verifier rather than a mechanism, and it is what catches any future path that lets the pair drift
   — including a hypothetical "update the envelope from prose" shortcut, which would fail replay
   immediately.
3. **The reproduction.** Deterministic, no model: baseline EOY → scenario +15,000 → scenario
   +15,700 → an advice turn with the raw results elided. Assert the envelope's assumptions are
   −15,700, its result is 51,598.84, the −15,000 result is gone, the baseline is untouched, and
   Clip 6 elision changed none of it. Plus the R6 case: scenario → unrelated prose turn → advice
   leaves the envelope byte-identical and triggers no recomputation.

---

## 15. Cost

| | |
|---|---|
| Envelope, serialized | **423 B / ~106 tokens** |
| Genuinely new content (`result`) | **128 B / ~32 tokens** — the assumptions already survive Clip 6 as tool-call arguments |
| Against the orientation (~887 tok) | ~12% |
| Against the turn-1 prefix (~5,890 tok) | **~1.8%** |
| Raw result it replaces in the long run | 4,074 B / ~1,019 tok |
| Extra tool calls per turn | **none** (R6) |
| Cache impact | confined to the tail by the placement rule in §7 |

---

## 16. Migration and database impact

**None.** No Prisma model, no migration, no column, no new table, no index. The envelope is a
TypeScript value in a loop variable and dies with the process.

---

## 17. Implementation slice boundaries

**In the slice:**

1. A pure module: the envelope type and `projectActiveScenario(args, result) → envelope | null` —
   returns null for any tool that is not `scenario_projection` and for any unusable result, mirroring
   `checkpointProjection`'s shape.
2. The write hook in `executeTurnInner`, beside `checkpointProjection`, assigning both halves in one
   statement; clear on failure.
3. Injection into the reserved trailing slot in `run.ts` and `interactive.ts`, replaced not appended.
4. Tests: the three seams in §14, DB-free where the logic is pure and a `.check.ts` for the live
   replay — the `applied-facts.check.ts` precedent.

**Not in the slice:** goal-seek (§12), routing/tool discoverability, clearing heuristics, any
durability, any checkpoint-policy change, any prompt or tool-description change.

**Expected size:** one new pure file, ~3 edited lines in `executeTurnInner`, ~4 in each loop owner,
plus tests. Comparable to 54eb8e1.

---

## 18. Rejected complexity

Each with what it would have prevented that the recommendation does not:

| rejected | why |
|---|---|
| Scenario session manager / graph / branching tree | Prevents nothing here. The failure involved one scenario revised in place. |
| Durable scenario table or `SpaceMemory` storage | Violates R4; a hypothetical would become a belief and leak across sessions. |
| Named, user-visible scenario IDs | The product target rejects them explicitly, and the failure needed none. |
| Event-sourced conversation state | Prevents nothing beyond the atomic pair, at a large multiple of the size. |
| Prose parser / scenario DSL / intent classifier | Would be the deterministic English parser the brief forbids, and 54eb8e1 shows behaviour does not follow instructions anyway. |
| Fingerprint / hash | Defends a partial-update path the design does not have (§5.2). |
| Widening Clip 6 retention | Candidate C — fights compaction doctrine, makes staleness durable, unsupported by the discriminator. |
| Recompute on every turn | Candidate B — costs a scenario run per turn and faithfully replays the stale set. |
| Auto-clearing on turn count or topic change | A heuristic; a self-describing stale envelope is safer than an absent one. |

---

## 19. Is this sufficient to unblock promotion?

**Necessary, not sufficient on its own — and the honest gate is a measurement, not this document.**

What it closes: the mechanical enabler (no machine-readable current figure at the deciding turn), the
authority inversion (the scenario becomes the structured figure, the baseline a sentence), and R1/R2
structurally.

What it leaves open: the model can still revise an assumption in prose without re-running, and the
envelope will then show assumptions that disagree with the conversation. That disagreement is
*visible and machine-readable on one side*, which is a large improvement over an ambiguous prose
menu, but it is not compulsion.

**Proposed gate:** implement the slice, then re-run the deterministic reproduction (§14.3) **and**
the live sequence from 1d67786 — baseline → scenario → prose revision → advice — and measure how
often the advice turn is grounded in the current assumption set. Promotion should depend on that
number. If prose revision without recomputation remains frequent, the next smallest lever is tool
*discoverability* — which 54eb8e1 already flagged as a separate open question (5/5 still chose
`project_cash`) and which this design deliberately does not touch.

---

## 20. Kept separate

Untouched: routing / tool discoverability, `project_cash` (closed at 54eb8e1), Clip 6 policy,
checkpoint policy, `SpaceMemory` shape, the activity frame (25efa81), card-payment ranking, R2→R3
causal calibration, model selection, production-route promotion mechanics. **No repository behaviour
changed by this document.**
