# PRE-EXECUTION PLANNING CONTINUITY · CLOSURE

## 1. Verdict

**CLOSED.**

Clauses stated across bare turns now compose 6/6, and the follow-ups that change the
raise or the horizon recompute 6/6. Nothing crossed an epistemic boundary to get there,
and there is no remembered raise. Section 26 says what this generalises to.

## 2. Heads

The branch is `pcont/planning-continuity`, in an isolated worktree. Concurrent
Markets/UI work in the main checkout was not touched.

| | commit |
|---|---|
| start | `f3ef01b` (v2.6) |
| final | this document on top of `5e3423f` |

## 3. Original failure

The sequence was: a raise, then a nine-month floor, then highest-APR-first, then
"invest above the floor", then "next December?".

Reproduced on the production path with n=6, **0/6** executed scenarios carried all
four clauses (I1 had measured 1/6).

| clause | where it went |
|---|---|
| the raise | prose only |
| the floor and debt order | written as **durable** Memory V2 RULE rows every bare turn |

At the question turn the model ran a baseline `project_cash` in 6/6. Memory correctly
does not auto-activate, so the rules had "survived" and still never ran.

Measured separately: "For this scenario, keep nine months in cash" was written durably
3/3. That is a live *hypothetical ≠ durable* violation, and its cause was that
`remember` was the only structured carrier available.

## 4. State ownership

| state | carrier | lifetime | reaches execution |
|---|---|---|---|
| financial truth | the authorities (accounts, streams, measures) | — | yes, always |
| durable memory | Memory V2 `SpaceMemory` | until retired | **never** (it reaches the orientation only) |
| prose | client history | 24 h | no |
| **pending plan (new)** | sealed runtime state, the `pending` field | the conversation, 2 h | merged into the next scenario run |
| executed scenario | sealed runtime state, the `scenario` field (envelope) | until replaced or cleared | re-run with its arguments |

## 5. Options evaluated

See `AI-PREEXECUTION-PLANNING-CONTINUITY-INVESTIGATION.md` §4. Five options:
- A: Memory V2 expansion
- B: conversation-scoped pending state
- C: a hybrid of the two
- D: extending the executed envelope
- E: parsing the user's prose

## 6. Selected architecture

The hybrid (C).
- A typed, conversation-scoped **pending plan** holds clauses that have been stated but
  not yet run.
- It sits beside the envelope in the seal, never inside it.
- Memory V2 keeps durable preferences and plans. Its code is unchanged apart from
  exporting its provenance check for reuse.

## 7. Why the others lost

- **A — Memory V2 expansion.**
  - It solves only the raise.
  - Execution still would not happen without auto-activation.
  - It would need an unstable `sourceKey`.
  - It adds one memory class per scenario primitive.
  - It makes the durable-hypothetical violation worse.
- **D — extending the executed envelope.** The envelope means "this ran". Putting
  unexecuted clauses inside it would give them a result's authority.
- **E — parsing the user's prose.** The repo deliberately deleted its sentence
  extractors.

## 8. Persistence semantics

| statement | behaviour |
|---|---|
| "I'm getting a 10% raise…" / "Assume…" / "Starting January…" | pending (conversation only) |
| "What if…" | runs now; if it can't run yet, pending |
| "Remember that I'm getting a raise…" | honest: no durable home (§12); 6/6 wrote no income row |
| "I always want six months…" | durable RULE via `remember` (correct, measured) |
| "For this scenario, keep nine months…" | pending only. It went to durable memory 3/3 before; now 0/6. |

A, B and D share their conversation semantics. They differ only at the durable
boundary, which is the line FORECAST-8's `routeStatement` already draws.

## 9. Provenance contract

- Every staged figure has to be one the user said, and to half a cent. That includes
  zero, multipliers read from the percentage, Money, Months, Fraction and Percent.
- The check is Memory V2's own (`userStatedFigure` wraps `admitWrite`'s rule). There is
  one gate, not two.
- At execution each clause is echoed as `EARLIER_IN_CONVERSATION` or reported
  `supersededByThisCall`.
- A clause is **confirmed** only when nothing refused it. Otherwise it is reported
  `notConfirmed` and kept.
- Memory never enters the pending plan. No code path exists for that.

## 10. Temporal and supersession contract

**Clause identity** comes from fields through a closed registry, never from text.

**Supersession rules**
- A restatement with the same identity replaces the earlier clause and keeps its id.
- A contribution field-merges, but a floor's units are mutually exclusive.
- A same-subject rule with a different date needs `replace` (a correction) or
  `inAddition` (a second rule).
- Narrowing a waterfall requires retract, then restage.

**At execution**
- The current call wins over any staged clause on identity or subject.
- Horizon, granularity and search windows are never assumption content.

## 11. Fresh-chat contract

- The seal is bound to (user, Space, digest of the last reply).
- A fresh chat, another Space or another user opens nothing. This is tested
  deterministically.
- Measured 6/6 for E (a hypothetical is not inherited) and 6/6 for J (an unrelated
  chat carries nothing).

## 12. Memory V2 changes

- Behaviour is unchanged.
- `userStatedFigure` is exported, the same check rather than a copy.
- `remember`'s description changed:
  - its standing-rule example is now "I always want…";
  - a condition for the projection being assembled is sent to staging.

A durable income expectation is **deferred**. It needs a source identity that survives
reconnects and a contract for reconciling it against real paychecks.

## 13. Pending-state design (`lib/ai/conversation/pending-plan.ts`)

| property | value |
|---|---|
| owner | the route, sealed AES-GCM, httpOnly, 2 h |
| clause | one item of an existing scenario argument, keys derived from `SCENARIO_INPUTS` |
| limits | 8 clauses, 600 B; seal ceiling 3,900 (measured) |
| written by | `stage_assumptions` only |
| read by | the scenario tools only |
| consumed | by a successful projection or crossing |
| kept | on failure, on refusal, and by a goal seek |

- **Before a run:** conditions are staged into the pending plan.
- **After a run:** staging is refused; a change goes through a re-run with the change.
- **`project_cash`:** refuses while a plan is in play (staged or run) unless
  `ignoreStaged` is set, and then it says what it left out.

## 14. Executed-scenario interaction

- A scenario result echoes `argumentsRun`, the merged arguments. The envelope captures
  these, so "what ran" stays true.
- An empty pending plan after a run means no staged clause is ever applied twice.

## 15. Deterministic tests

| file | what it covers |
|---|---|
| `pending-plan.test.ts` | ~60 assertions: lifecycle, supersession, subjects, provenance, caps, forgery, S1 planted gate, every review blocker |
| `runtime-state.test.ts` §8 | two slots, fresh-chat / Space / user isolation, and the worst-case seal |
| `scripts/ai-baseline/planning-continuity.check.ts` (`npm run ai:planning-check`) | the production tools on a clone, with no model; blockers 1 and 2 end to end |

## 16. Dogfood results: before → after (production path, clones, n=6, 0 errored turns)

| case | before | final |
|---|---|---|
| **A** sequential composition: all four executed | 0/6 | **6/6** |
| **B** + "make the raise 15%": 15% executed, all kept, 10% gone | 0/6 | **6/6** |
| **C** + "next June?": recomputed, all kept | 0/6 | **6/6** |
| C: no stale figure | — | 6/6 |
| D one-shot composition (I1 regression) | 6/6 | 6/6 |
| L envelope follow-ups (raise / June) | 6/6 / 6/6 | 6/6 / 6/6 |
| E hypothetical not inherited by a fresh chat | — | 6/6, 6/6 |
| F "remember my raise": no durable income row | — | 6/6 |
| G remembered floor not auto-activated | — | 6/6 |
| H superseding raise: ran 1.12 only | — | 6/6 |
| I S1 spending cut never staged or executed | — | 6/6 |
| J unrelated fresh chat: nothing carried | — | 6/6 |
| "for this scenario…" written durably | 3/3 | **0/6** |
| `remember` calls in the sequence | 18 | 0 |

## 17. Primary composition

**6/6.** It is proven by `argumentsRun` and the clause roster in each executed result,
not by what the prose claimed.

## 18. Mutation and horizon

- **B, raise changed:** 6/6.
- **C, horizon changed:** 6/6, with no stale December figure.

## 19. Adversarial review

The independent review found **3 blockers**, all fixed in `4d07bb0`:
1. A staged 1.1 overrode "actually 15%" said in the current turn. It ran at 1.1 and
   was credited as the newer statement.
2. A clause the engine refused was reported applied and then consumed, so it was lost.
3. Corrections to a rule's date or unit stacked into a second rule (×1.265), including
   a floor carrying both units.

Also closed:
- zero was not gated;
- `project_cash`'s retrospective bypass;
- outflow identity collisions;
- replacements were only reported for contributions.

The final two misses were found in the matrix, not by the review, and are fixed in
`5e3423f`.

## 20. Memory and persistence audit (final runs)

| case | durable writes |
|---|---|
| sequence (A–C) | 0 |
| G | RULE ×6, from "I always want…": intended |
| E, G, I | CHECKPOINT ×6 each, from `project_cash` in chats with no plan in play: pre-existing behaviour |

No hypothetical and no income figure was ever promoted. The pending plan never touches
memory.

## 21. Live DB safety

- All 40 harness processes confirmed a `fintracker_pc_*` clone via `current_database()`
  with the guard armed.
- Live before: `5|13|4836|0|384`. After: `5|13|4847|0|385`.
- The difference is the live app's own activity:
  - 11 transactions from a bank sync at 12:21:03 UTC;
  - one Daily Brief invocation at 12:21:40 UTC (`surface: brief`, `brief_daily_…`, gpt-5.1).
- None of it came from this work. `SpaceMemory` stayed at 0.

## 22. Payload and token cost

| item | before | after | note |
|---|---|---|---|
| tool schemas | 64,321 B | 67,461 B | +4.9%; `stage_assumptions` references shapes instead of copying them, which would have cost ~11 KB |
| system instruction | — | unchanged (240 words) | |
| pending slot | — | ≤ ~700 B | only while clauses are staged |
| scenario result | — | + `argumentsRun` | |

## 23. Suite, typecheck, lint

- Tests: 582/582.
- Tracked-source typecheck is clean.
- Changed-file lint is clean.

## 24. Commits

| commit | contents |
|---|---|
| `a3b36e8` | investigation |
| `486976e` | db-safety test reads committed files only |
| `297db14` | primitive |
| `df5755e` | wiring |
| `4d07bb0` | review blockers |
| `5e3423f` | final misses |
| (this) | closure |

## 25. Remaining gaps

- **Durable income expectation** (deferred, §12).
- **`userTexts` is client-posted history.** A user could forge their own earlier turns.
  This is the same trust model Memory V2 has.
- **Pending is lost silently** on an error turn (the client appends error text, so the
  digest breaks), on a Space switch, and after the 2 h TTL. The envelope already had
  the same exposure.
- **Licensing is by number, not by meaning.** "Keep nine months" licenses 1.09 as a
  multiplier. This is inherited from Memory V2's gate.
- **`FIGURES` is a hand-kept list beside the schema.** It fails closed for unmapped
  numbers, but no test requires completeness.
- **The in-turn PENDING slot is not rewritten after a stage or a consumption.** The
  tool results carry the truth.

## 26. S1 readiness, and the final architectural test

**S1 needs one identity rule and one `FIGURES` entry**, and a planted test proves the
gate catches their absence. It needs no new carrier, no memory class and no field.

> *Did we build a general mechanism for preserving unexecuted planning semantics across
> turns, or teach Fourth Meridian to remember an income raise?*

A general mechanism. The raise, the floor, the debt order and "invest the rest" travel
through the same typed carrier:
- keyed off the scenario's own schema;
- superseded by field identity;
- licensed by the user's own words;
- consumed by execution.

Nothing income-specific was added, and nothing was added to durable memory.
