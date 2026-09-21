# PRE-EXECUTION PLANNING CONTINUITY · INVESTIGATION

- **Branch:** `pcont/planning-continuity`, cut from `v2.6` at `f3ef01b`. It is an isolated
  worktree: concurrent Markets/UI work is active in the main checkout and is untouched.
- **Databases:** clones `fintracker_pc`, `_a`..`_d`. Live was fingerprinted read-only first:
  `User 5 · Space 13 · Transaction 4836 · SpaceMemory 0 · AiInvocation 384 (last 2026-09-20 17:48)`.

**Verdict: READY WITH CONDITIONS.** The conditions are in §9.

---

## 1. Current state ownership (traced in production code)

| carrier | owner / where | lifetime · scope | money? | activates execution? | reaches the model | reaches code |
|---|---|---|---|---|---|---|
| **Prose history** | browser; `localStorage` 24 h; posted every turn (`request.ts:73`) | per user × Space × browser; "New chat" clears it | as prose only | no | `replayHistory` (`engine.ts:130`), user/assistant only | only as `userTexts` for the memory gate |
| **Sealed runtime state** | route; cookie `fm_ai_state`, AES-256-GCM, httpOnly (`runtime-state.ts`, `route.ts:166`) | 2 h; bound to user + Space + sha256 of the last assistant turn, so a fresh chat can never open it | yes: the envelope's args and six result figures | no; it restores the envelope | the ACTIVE SCENARIO `role:system` slot, last before the question | never |
| **Memory V2** | `SpaceMemory` rows scoped `{spaceId, ownerUserId}` | durable across conversations until retired | user-stated only (`admitWrite`) | **no, by design** (`REMEMBERED`: "no resolver reads it") | memory line inside the orientation, every turn (`evidence.ts:288`) | never (PROJECTION rows are read only by `reconcile`) |
| **`remember` / `recall`** | model tools (`memory-tools.ts`) | writes durable rows | gated | no | tool results | — |
| **BASELINE ("planning figure")** | Memory V2 ASSUMPTION class | durable; STALE after 180 d | yes | no; `planningAssumptions[]` in the orientation plus `PLANNING_NOTE` | orientation | never |
| **Executed scenario** | `prepareScenario(a, …)` reads ONLY the model's args (`tools.ts:2145`) | one call | computes it | it *is* execution | tool result | the ledger |
| **Active scenario** | `captureActiveScenario` (REPLACE / CLEAR / IGNORE), sealed as above | until replaced, cleared or the cookie expires | args + results + `covers` | no | envelope slot | never |
| **Checkpoint** | `checkpointProjection` after `project_cash` (`turn.ts:282`) | durable PROJECTION row | yes, a projected figure | no | memory line (count and horizons only) | `reconcile_projection` |

**No carrier holds "a condition the user stated in this conversation that has not yet
run".** The only structured cross-turn path is durable Memory V2. It cannot represent
an income change, or a bare debt order (a RULE needs a basis: `memory-model.ts:257`).
And it *should not* represent a scenario-local clause (§3).

There is no server-side conversation id: `route.test.ts` forbids a Conversation write
or any module-level Map. The conversation's identity is the sealed binding
`(userId, spaceId, tail)`.

## 2. Reproduced failure (current HEAD, production path `runStatelessTurn`, clones, n=6)

The sequence: raise → 9-month floor → highest APR first → invest above floor → "next
December?" → "make the raise 15%" → "next June?".

**Executed scenarios containing all four clauses: t4 0/6 · t5 0/6 · t6 0/6.**
That is worse than I1's 1/6.

Where each clause lived, every rep:

| turn | tools | where the clause survives |
|---|---|---|
| t0 raise | none (6/6) | **prose only**. Nothing can hold it. |
| t1 floor | `remember` (6/6) | **durable RULE** `{liquidFloorMonthsOfExpenses: 9}` |
| t2 debt | `remember` | RULE amended with `target: ['highest_apr']` |
| t3 invest | `remember` | RULE amended to `target: ['highest_apr', 'investments']`, `fractionOfExcess: 1` |
| t4 "next December?" | **`project_cash` 6/6** | baseline. **Neither the remembered rule nor the raise was applied.** |
| t5 / t6 | partial scenarios | whichever clause the model reconstructed from prose |

**The failure is not "the income clause has nowhere to go".**
- The floor and debt clauses DID survive, durably, and still never reached execution,
  because memory correctly does not auto-activate.
- Each "survival" was also a durable cross-conversation write of a scenario-local
  condition.

## 3. Semantic classification (measured: each statement as turn 1 of a fresh chat, n=3)

| statement | tools today | durable write today | should be |
|---|---|---|---|
| "I'm getting a 10% raise starting January." | none | 0/3 | conversation pending (a supposition for scenarios, per I1's contract); durable only on explicit request, and there is no durable home yet (§6) |
| "Assume I get a 10% raise starting January." | none | 0/3 | conversation pending |
| "What if I get a 10% raise starting January?" | scenario runs 3/3 | 0/3 | executes now; pending if not yet runnable |
| "Remember that I'm getting a 10% raise…" | none | 0/3; the model says honestly it can't | explicit durable request; **not satisfiable safely yet** (§6), must stay honest |
| "Keep nine months of expenses in cash." | `remember` | **3/3** | pending by default; ambiguous as a standing preference |
| "**For this scenario**, keep nine months in cash." | `remember` | **3/3 ✗** | **pending only.** Today it violates *hypothetical ≠ durable*. |
| "I always want at least six months of expenses in cash." | `remember` | 3/3 ✓ | durable RULE (correct today) |
| "Pay highest APR debt first." | none | 0/3 | pending |
| "For this calculation, pay highest APR debt first." | none | 0/3 | pending only |
| "Invest everything above the floor." | none | 0/3 | pending |
| "Starting January cut travel 20%." | none | 0/3 | S1. Not representable; must be disclosed. Would be pending once typed. |
| "I plan to buy a $40,000 car next June." | `remember` | 2/3 (PLANNED_EXPENSE) ✓ | durable intention (correct today) **and** pending as a one-off outflow if a scenario is being assembled |

**One mechanism is not sufficient.**
- A standing preference ("I always…", "remember…") and a plan the user is on record for
  (a car next June) are durable user semantics. Memory V2 already models them, with
  provenance and supersession.
- "For this scenario…", "assume…", "what if…" and bare planning imperatives mid-plan are
  conversation-scoped. Today they have *no* home except durable memory, and a live
  invariant violation (row 6) is the result.

**A vs B vs C have the same conversation semantics and a different durable eligibility.**
- A is a claim about the world. FORECAST-8's `routeStatement` sends an ASSERTS_FACT
  *upstream*, and for future income that authority has no input (I1 §9.8).
- B and C are suppositions.
- For scenario execution I1 treats all three as suppositions (a raise next January is
  not this month's payroll). So they share the pending representation.
- They differ only at the durable boundary, and today none of them can cross it.

This is justified, not an accident: it is the same boundary FORECAST-8 already draws.

## 4. Options

**A — Memory V2 expansion (an income/planned-change class).**
- Solves t0 only. The t4 failure (remembered rules not reaching execution) remains,
  unless memory *auto-activates*, which breaks invariant 2.
- It needs a durable source identity. `sourceKey` embeds an account id that churns on
  reconnect, which the brief forbids persisting.
- It adds one class per scenario primitive (income, then spending, then shocks…).
  Memory becomes a shadow scenario schema.
- It makes the row-6 violation *worse*: more hypotheticals land durably.
- **Rejected.**

**B — Conversation-scoped pending assumptions.**
- Closes t0 through t4 without any durable write.
- It needs an owner that is per-conversation, tamper-proof and fresh-chat-proof. The
  sealed runtime state is exactly that, and it is the only carrier with those
  properties (§1).
- On its own it does not address durable preferences. Those are already served.

**C — Hybrid (B plus explicit promotion into Memory V2).**
- B for everything a scenario can execute.
- Memory V2 unchanged for standing preferences and plans.
- Promotion of an income expectation into durable memory is **deferred** (§6),
  not faked.
- The hybrid holds by keeping the two carriers disjoint *in code*: a pending clause
  never reaches memory, and memory never enters pending.
- **Selected.**

**D — Extend the executed scenario envelope with draft clauses.**
- The envelope means "this ran": `{assumptions, ran, result, covers}` is built in one
  literal from one successful execution, and "a failed recomputation CLEARS" is its
  non-negotiable half.
- A draft inside it would give unexecuted clauses the authority of a result. `covers`
  would describe figures computed without them.
- **Rejected.** The envelope and pending state must be *siblings in the same seal*, not
  one object.

**E — Code parses user prose into clauses.**
- The repo deliberately deleted its regex extractors ("nothing here parses, matches or
  interprets a sentence", `assemble.ts`).
- The model owns meaning.
- **Rejected.**

## 5. Selected design — `PENDING PLANNING STATE`

**Ownership and lifetime**
- It is a sibling field of `scenario` inside the sealed runtime state
  (`runtime-state.ts`, VERSION 2).
- It is bound to `(userId, spaceId, tail)`, lives 2 h and is server-sealed, so the
  client cannot read or forge it.
- A fresh chat has tail `''` and opens nothing. A different Space or user opens nothing.
- There is no database row and no module state, so the `route.test.ts` invariants hold.

**Vocabulary: derived, closed, typed**
- A pending clause is one entry of an existing scenario argument: `key ∈
  scenarioAssumptionKeys()` (derived from `SCENARIO_INPUTS`) and `value` = one array
  item, or the scalar, of that argument.
- There is no second schema. The staging tool's parameters are *read off*
  `SCENARIO_INPUTS`.
- Each assumption key has exactly one **identity rule** in a closed registry.
  - A test fails if `SCENARIO_INPUTS` gains an assumption key with no identity rule.
  - This is the S1 forward-compatibility gate: `spendingChanges` would need one line
    and nothing else.

**Identity and supersession** (no free-text matching)

| key | identity |
|---|---|
| `incomeChanges` | `RATE` (SCALE and SET_RATE both define the rate from a date) \| `STOP` \| `START:<label>`, plus `source ?? '*'`, plus `from` |
| `contributions` | its basis (`contributionBasis`): FLOOR \| SURPLUS_SHARE \| BALANCE_SHARE \| AMOUNT:<date> |
| `outflows` | `onDate` |
| `returns` | `from` |
| `liabilityAssumptions` | `liabilityId` |
| `annualReturnPct` · `assumedMonthlySpending` | the key itself |

- Restating the same identity **replaces** it: "make the raise 15%" replaces the 10%.
- Contributions **field-merge** into the same identity, like Memory V2's `amend`. That
  is how "keep nine months" → "highest APR first" → "invest the rest" become one floor
  rule.
- A contribution whose basis is undetermined merges into the single pending
  contribution, or is refused by name.
- `retract: [id]` removes a clause.

**Provenance**
- Every staged figure (Money / Months / Fraction / Percent / multiplier) must be licensed
  by the user's own words, through **the same `admitWrite` authority Memory V2 uses**.
  - A tool-derived figure cannot enter pending.
  - A remembered figure the user did not restate cannot enter pending.
- Each clause records `stagedAt` (a turn ordinal).
- At execution, each clause in the result is attributed as `THIS_CALL` or
  `EARLIER_IN_CONVERSATION`. Remembered memory is **never** merged and has no
  attribution path.

**Execution merge**
- The scenario tools (`prepareScenario`) merge pending clauses with the call's args by
  identity.
  - **Pending wins** a conflict. Pending is consumed at every successful execution, so
    anything in it was stated *after* the last run, and the call's copy comes from the
    older envelope.
  - Every conflict is reported, so the precedence is never silent.
- The merged args are what execute. The envelope captures the **merged** args, so "what
  ran" stays true.
- On success pending is **cleared** (consumed): executed state now carries the clauses.
- On failure or refusal pending is kept.

**Horizon is not content.** `to`, `granularity` and `searchThrough` are not assumption
keys and never enter pending.

**Model visibility.** The pending state is a `role:system` slot named `PENDING
ASSUMPTIONS`, placed immediately before the envelope. It carries clause ids, keys,
values and when each was staged, plus one factual line: "stated in this conversation,
not yet run; the next scenario run applies them".

**Budget**
- ≤ 8 clauses and ≤ 700 bytes serialised. Staging beyond either is refused by name.
- `MAX_SEALED_CHARS` rises from 3,000 to 3,600, because pending and a worst-case
  envelope must fit together. A cookie's hard limit is 4,096 bytes including name and
  attributes.

**Durable memory boundary**
- The staging tool never writes memory.
- `remember`'s description will state that a condition for *this* calculation
  ("for this scenario", "assume", "what if") is staged, not remembered.
- Memory V2 code is unchanged.

## 6. Durable income expectation: not in this slice

"Remember that I'm getting a 10% raise" stays **honestly unsatisfiable**. Today the
model already says so (3/3). The next turn can stage it as a pending clause for this
conversation. A durable income expectation needs three things this slice would have
to invent:
1. a reconnect-stable source identity (merchant-level, not `sourceKey`);
2. a reality-reconciliation contract (confirmed when the larger paychecks arrive,
   invalidated when they don't);
3. a rule for when a remembered expectation may be *offered* for a scenario.

Adding it now would be exactly the reactive one-field-per-feature patch the brief
forbids.

## 7. Threat model → control

| threat | control |
|---|---|
| hypothetical becomes durable | staging never writes memory; `remember` description boundary; row-6 measured before and after |
| memory silently activates | memory is never merged into pending or into execution (no code path) |
| remembered presented as STATED | no memory → pending path; `admitWrite` licenses only the user's own words |
| tool-derived figure laundered | same `admitWrite` gate at staging |
| pending masquerades as executed | separate field, separate slot, separate marker; only a successful execution writes the envelope |
| arbitrary text becomes executable | closed keys (schema-derived), item keys checked by `refuseUnknownItemKeys`, labels bounded and START-only |
| stale pending | consumed on execution; 2 h seal; retract; supersession by identity |
| cross-conversation / Space / user leak | sealed binding (tail / spaceId / userId) |
| oversize | clause and byte caps at staging; seal ceiling raised with measured headroom |
| result figures in pending | the value is an argument item; no result field exists in the type |

## 8. Acceptance matrix

| # | case | target |
|---|---|---|
| A | sequential 4-clause assembly → t4 executes all four (argument roster) | 6/6 |
| B | + "make the raise 15%": 15% runs, 10% gone, other clauses kept | 6/6 |
| C | + "next June?": horizon recomputed, all clauses kept, no stale figure | 6/6 |
| D | one-shot composition (I1) | 6/6, no regression |
| E | "Assume…" then run then fresh chat: nothing inherited, no durable write | 6/6 |
| F | "Remember that I'm getting a raise": honest; no durable income row | 6/6 |
| G | a remembered RULE does not auto-apply in a fresh chat | 6/6 |
| H | superseding / conflicting raises | last wins, disclosed |
| I | malformed / unsupported (S1) clause | refused by name |
| J / K | unrelated new chat / other Space | nothing inherited (deterministic) |
| L | existing envelope follow-ups | no regression |

## 9. Conditions

1. The dogfood must show the staging tool is actually used. If the model does not
   stage bare clauses, the carrier is dead weight and the slice is NOT CLOSED.
2. The row-6 durable violation must fall. Otherwise the tool boundary has failed.
3. The seal budget must hold at the worst case (a test pins it).
4. No change to I1's primitive, the spine, the ledger, or Memory V2 code.

## 10. Implementation slices

1. `pending-plan.ts`: pure. Clause type, identity registry, stage / retract / merge /
   consume, caps, provenance gate. Plus tests, including the S1 planted fixture.
2. Runtime state v2: `pending` beside `scenario`; seal/open with either present; budget.
3. The `stage_assumptions` tool (schema derived) plus the `PENDING ASSUMPTIONS` slot.
4. The `prepareScenario` merge, attribution in the result, consume on success.
5. Tool descriptions (`remember` boundary, scenario tools). The system instruction is
   unchanged (at its ceiling).
6. Dogfood, adversarial review, closure.
