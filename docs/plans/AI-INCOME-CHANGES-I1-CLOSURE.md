# I1 — FUTURE INCOME CHANGES · CLOSURE

Branch `v2.6`, `b9e9fd6` → `74a74b9` + this document. Nine commits. Investigation: `AI-INCOME-CHANGES-I1-INVESTIGATION.md`.

## 1. Verdict

**I1: SHIPPED.** The acceptance question and both follow-ups are answered from
deterministic execution. The income rule's execution is proved from the spine's own
record, and that record agrees with the ledger to the cent (§5). Every clause is
retained, and a stale figure no longer survives a change of assumption or horizon
(§12). Remaining gaps are named in §18. None is a correctness hole in what I1 claims.

## 2. Investigation findings (full detail in the investigation note)

- **Canonical income authority.** There is no scalar. Income is a set of streams
  (`ResolvedIncomeStream`, `lib/ai/forecast/streams.ts`), each composed of separately
  owned verdicts:
  - cadence: FORECAST-1
  - activity licence: FORECAST-2
  - level: FORECAST-5
  - gross/net basis: FORECAST-3
- **The forecast spine.** There is one spine: `loadForecastIncomeStreams` →
  `assembleForecast` (single call site, pinned) → `periodicCashEvents` → `forecastCash` /
  `projectCash` → `spineFor` (one `runTo` per date) → `runScenarioLedger`.
  `scenario-ledger.ts` never contains the word "income". It reads pre-projected cash.
- **Source identity.** A source is keyed `<canonicalMerchantKey>@<accountId>`, with a
  display `label`. The key is computed, never persisted, and not durable across a
  reconnect.
- **Cadence.** A closed set of four: WEEKLY, BIWEEKLY, SEMIMONTHLY, MONTHLY. There is
  no annual or quarterly kind.
- **Dates.** Explicit `YYYY-MM-DD`, with inclusive `from`/`to`. Occurrence dates come
  only from `expectedOccurrencesBetween` and are clamped to month length by the
  cadence authority. I1 adds no date arithmetic.
- **Two findings that moved the design:**
  - The typed income-statement vocabulary is unreachable in production. Exactly one
    `subject:` producer exists.
  - A policy-dimension implementation would report without executing, because
    `projectCash` never sees the policy. I1 therefore transforms the **events**.

## 3. The contract

`incomeChanges[]` is declared on `scenario_projection`, `scenario_crossing` and
`scenario_goal_seek`, in `SCENARIO_INPUTS` (`lib/ai/conversation/scenario-inputs.ts`).

```ts
{ op: 'SCALE' | 'SET_RATE' | 'STOP' | 'START',
  source?: string,               // sourceKey; omitted = every INCOME-role stream
  from: 'YYYY-MM-DD',            // inclusive; for STOP, the first date NOT paid
  to?: 'YYYY-MM-DD',             // inclusive; omitted = to the horizon
  multiplier?: number,           // SCALE: >0, ≠1
  amount?: number, per?: 'YEAR' | 'MONTH' | 'OCCURRENCE',   // SET_RATE | START: >0, per required
  basis?: 'NET' | 'GROSS',       // required on SET_RATE/START; optional on SCALE
  cadence?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',              // START only
  label?: string }               // START only, bounded to 40 chars
```

Primitive: `applyIncomeChanges` in `lib/forecast/income-change.ts`. It is pure and
applied in `assembleForecast`, after licensed streams generate their dates and
before either path folds them.

**Supported**
- A: multiplicative change (SCALE)
- B: absolute rate, yearly, monthly or per payment (SET_RATE)
- C: stop (STOP)
- D: new income (START)

Several rules compose in the stated order. A one-off income (E) is **not duplicated**:
it already has a deterministic home as a negative `outflows` entry, and it composes
with I1.

**Refused by name, never approximated**
- a SEMIMONTHLY START
- a rate on a stream with no established cadence
- a rate on a stream the activity authority has stopped licensing
- an aggregate SET_RATE or STOP when more than one income stream exists
- an unknown `source` (the refusal lists the keys that do exist)
- a `per` that is missing or unknown
- a `basis` that is UNKNOWN or missing on SET_RATE/START
- a multiplier ≤ 0 or exactly 1
- an amount ≤ 0
- a SCALE carrying `amount`/`per`
- a STOP carrying an amount
- a START naming a source
- a label on anything but START
- any field of the wrong type
- any undeclared key

## 4. Slice 0 — readiness conditions

1. **Assumption keys ↔ schema.** `ASSUMPTION_KEYS` is now derived from
   `SCENARIO_INPUTS` minus a closed exception list (`['granularity']`, pinned by
   value). A new argument defaults to being an assumption. The real failure was
   worse than the brief expected: an unlisted key would have made a crossing carrying
   only an income change look like a baseline reading, so it would be IGNORED and the
   stale scenario would be left standing.
2. **Execution proof.** Covered in §5.
3. **Declared ⇒ consumed.** `scenario-contract.test.ts` requires every declared
   argument to be read by `prepareScenario`. It was proved against the real key:
   declaring `incomeChanges` with no consumer turned the suite red by name.

Also landed before any write-capable run: `lib/db/live-guard.ts`, wired into
`lib/db.ts` before the client is constructed.
- When `FM_DB_GUARD=clone-only` is set, it refuses any database not named
  `fintracker_<suffix>`, checking both the URL and the server.
- It was proved end to end. Armed, it refused by name. Disarmed, the identical command
  printed `CONNECTED TO: fintracker`.

## 5. Execution evidence

`applyIncomeChanges` returns an `IncomeChangeExecution` per rule. It is built from the
diff of the event arrays and contains:
- `matched`
- `occurrencesChanged`
- the dates actually changed
- `requested` / `governed` windows (governed is null when the rule and the projection
  do not meet)
- nominal and spendable totals before and after
- `scope`
- `overlapsRules`
- `ran` and `reason`

`ran` is `occurrencesChanged > 0`. It never comes from an argument or a label.

The sixth roster clause, `incomeChange`, is built only from these executions. It is
`'NONE'` in a named slot when no rule was stated or none changed a pay date, and it
carries these disclosures:
- `didNotRun[].reason`
- `notCash`
- `everyStream`
- `overlapping`

**The cross-check.** With no contributions and no return in force, the cash a +10%
rule adds equals the income its execution record says it added: **14,274.21 = 14,274.21**.
The two figures come from independent paths, the event diff and the fold-plus-ledger.
This is pinned in `income-change.check.ts`.

## 6. Recomputation contract

- **Changed assumption.** `RECOMPUTE_SENTENCE` is one definition, placed on
  `scenario_projection` and `scenario_crossing`: re-run on any assumption or horizon
  change, and never scale, add, subtract or re-date a prior result in prose. It is
  modelled on `get_baselines`, the one tool that already carried such a sentence and
  scored 5/6. It is generic, not tied to I1.
- **Changed horizon.** The tool sentence could not reach this case, because a model
  that has decided no tool is needed never reads a tool description. The fix is
  `covers`, a fourth envelope member derived in the same literal. It states the one
  date the six figures are for and, only when the roster shows a clause that bends
  the path, that another date is a different computation. It is a fact, not doctrine.
  The marker stays bare.

## 7. Composition (live clone, `npm run ai:income-check`, relational assertions only)

- **Cash floor.** Liquid ends at the floor with or without the raise
  (Δliquid 0.00). The raise lands past the floor (Δnet worth +14,274.21).
- **Debt.** The highest-APR waterfall runs in the same result as the income rule.
- **Investments.** Everything above the floor is swept. Net worth rises by the raise.
- **Crossing.** A cash target is reached earlier (2027-11-30 → 2027-09-30). A raise
  never delays a crossing.
- **Goal seek.** The solve states the income clause it ran under. A raise never
  raises the return the solve requires.
- **Full strategy.** All clauses report `ran: true` in one result.

None of the floor, waterfall, contribution, crossing or goal-seek code changed. They
see the raise because the spine they read was built with it.

## 8. Memory boundary

In dogfood, turns running only scenario tools made **0 of 7** durable writes (and 0 in
the final run; see §12).
- The writes observed came from `remember`, which is user-directed, and from
  `project_cash`'s pre-existing checkpoint. `project_cash` now refuses
  `incomeChanges`, so an I1 figure cannot become a durable checkpoint.
- No income rule or income figure appeared in any SpaceMemory payload.
- Memory V2's closed field sets cannot represent an income rule, and I1 added none.
  This gap is recorded for a later memory-vocabulary slice.
- A `sourceKey` is not durable across a reconnect, so it must never reach durable
  memory.
- A fresh chat inherits no scenario: the cookie is bound to a digest of the last
  assistant message.

## 9. Source and cadence ambiguity

- **Named source.** Exact `sourceKey` match, or a refusal that lists the keys that
  exist.
- **Unqualified SCALE.** Reaches every projection-eligible INCOME-role stream and
  **names them** (`everyStream`).
- **Measured on the real Space:** 79 of 79 inflow rows carry `flowType: INCOME`,
  including three bank-interest streams. `streams.ts` never consults `incomeClass`, so
  the role filter separates nothing there. The disclosure is what makes a wrong reading
  correctable. There is no name matching anywhere.
- **Unit conversion is code's.** `perOccurrenceFromAnnual` and
  `perOccurrenceFromMonthly` sit in `cadence.ts` beside `monthlyEquivalent`, under its
  pinned evaluation order, and round-trip exactly for all four kinds. $180k a year on
  a biweekly job is 6,923.08 a paycheque, not 15,000.

## 10. Deterministic test matrix

| file | what it pins |
|---|---|
| `lib/forecast/income-change.test.ts` | 312 assertions: all 38 matrix classes that are unit-reachable, 13 cross-execution invariants, metamorphic properties (removal recovers the baseline, determinism, +15% > +10%, out-of-horizon ≡ input, purity, `ran ⇔ changed > 0`) |
| `lib/ai/conversation/income-clause.test.ts` | the sixth clause from executions to envelope; forgery; overlap on both sides; label cleaning |
| `lib/ai/conversation/scenario-contract.test.ts` | declared ⇒ classified ⇒ consumed, each check planted |
| `lib/db/live-guard.test.ts` | the predicate, the planted accidents, the wiring |
| `scripts/ai-baseline/income-change.check.ts` | live-path composition, the evidence/ledger identity, all four review blockers through the tool |

## 11. Adversarial review

The independent reviewer attacked 24 vectors and found **4 blockers**, all fixed
in `52c69ec` and each pinned through the tool:
1. A SCALE silently discarded a stated `amount`.
2. The roster printed per-rule income that a later overlapping rule had overwritten
   (2× wrong), and `overlapsRules` had no reader.
3. `label` was an unchecked free-text channel into the envelope. This reopened G5.
4. A wrongly typed field was dropped, which **widened** the rule (a numeric `to`
   ran to the horizon; a numeric `source` hit every stream).

These review observations were also closed:
- honest refusal for an unlicensed stream
- `project_cash` no longer refuses over `granularity`
- `investment_scenario` closed
- `countsAsCash`/`overlaps` carried into the envelope

Found before the review, by tests and by running:
- three evidence defects (changed dates taken from the governed set; the wrong silence
  reason; an unclamped window that went inverted)
- a false `notCash` alarm on an ordinary raise
- a pre-I1 roster that crashed `compactClauses`
- an unbounded START label
- `project_cash` silently dropping `incomeChanges`
- `get_income` documented as returning a `sourceKey` it did not return

## 12. Dogfood

Production path (`runStatelessTurn`, prose-only history plus the sealed envelope), 4 clones,
n = 6 per case. The **final** column is the finished code (`74a74b9`). Cases A, D, H
and E were re-measured on it (30 + 42 turns). The other cases come from the full
114-turn run on `52c69ec`, and the one change since then does not touch them.

| case | at `52c69ec` | final |
|---|---|---|
| A: "+10% from January, cash next December?" → scenario runs the raise | 2/6 | **6/6** |
| B: income + 6-month floor + invest above floor | 6/6 | 6/6 |
| C: income + highest-APR first + invest the rest | 6/6 | 6/6 |
| **D: full composition: income + 9-month floor + APR + invest, in ONE run** | 6/6 | **6/6** |
| **D → "Actually make the raise 15%": recomputed at 1.15, every clause kept** | 6/6 | **6/6** |
| **D → "What about next June?": recomputed** | 2/6 | **6/6** |
| **D → "What about next June?": no stale figure** | 4/6 | **6/6** |
| D → June recompute kept the 15% raise | 6/6 | 6/6 |
| E: clauses stated one per bare turn, then "next December?", all in one run | 1/6 | 1/6, see §18 |
| E: that turn discloses the clauses it left out | — | 6/6 |
| E → "make it nine months": no stale figure | 3/6 | 5/6 |
| F: fresh chat inherits no scenario | 6/6 | 6/6 |
| G: "cut travel 20%" (S1) never sent as an income change | 6/6 | 6/6 |
| H: "$150k → $180k in March": SET_RATE actually ran | 0/6 | 3/6 (the rest refused by name and disclosed) |
| I: contract stops + consulting starts | 6/6 | 6/6 |
| J: raise + $20k bonus (bonus as a negative outflow) | 5/6 | 5/6 |

Across all runs:
- scenario-only turns that wrote durable memory: **0** (14 turns in the full run, 12 in
  the final re-run)
- errors: **0**
- no refused clause was ever described as included

Figure provenance on the final A/D/H re-run:
- 178 TOOL, 14 USER, 2 ORIENTATION, 2 UNTRACED
- 4 DERIVED_IN_PROSE. Each is a stated-range restatement ("about $180k") or a
  difference between two tool figures. None is a scenario figure computed in prose.

## 13. Before → after

| | post-M1 | I1 |
|---|---|---|
| changed assumption recomputed | 2/6 | **6/6** (D "make the raise 15%"); E's bare-statement chat is 3/6 no-stale, see §18 |
| new horizon recomputed | 2/6 | **6/6**, and a stale figure given 6/6 → **0/6** |
| future-dated spending change | outside I1 | still outside I1; `spendingChanges` refused by name; model discloses the limitation (§18) |

## 14. Performance and payload

| | before | after |
|---|---|---|
| tool schemas, total | 52,988 B | 64,321 B (+21%, ≈ +2.8k tok) |
| `scenario_projection` schema | 8,516 B | 12,425 B |
| envelope, worst case the contract produces | ~423 B design | 963 B / ~241 tok (ceiling 1,000 B) |
| roster, no income rule | — | +25 B (`"incomeChange":"NONE"`) |

The `incomeChanges` item schema is spread into three tools. I did not repeat the
de-duplication experiment that was already rejected: this growth is the same shape
the rejected experiment measured, and it brings no new evidence. Prompt caching
covers the static schema.

## 15. Suite, typecheck, lint

- **Tests:** 581/581. This includes 4 new test files.
- **Typecheck:** tracked source is clean. The remaining errors are all in `.next/`,
  `prototype/` or untracked `tmp/`.
- **Lint:** clean on every changed file. Three `assemble.ts` unused-import warnings
  pre-date I1.

## 16. Database safety

- All model and tool runs went to `fintracker_i1` or `fintracker_i1_{a..d}`, with the
  guard armed. The harness asserts both halves: the URL before any import, and
  `current_database()` after connecting.
- **Live, read-only fingerprint at the end:**
  - User 5 / Space 13 / Transaction 4,836 / SpaceMemory 0, identical to session start
  - last `AiInvocation` at 2026-09-20 17:48 UTC, before this session
  - The clone carries the session's model traffic instead.
- The old post-M1 clones and worktrees were not touched.
- The I1 clones (`fintracker_i1`, `_a`..`_d`) are left in place. Deleting them is the
  user's call.

## 17. Files and commits

| commit | slice |
|---|---|
| `d637044` | DB clone guard |
| `816a13f` | investigation note |
| `96024b5` | readiness conditions 1 & 3 |
| `0cc824a` | the primitive, spine integration, sixth clause |
| `ac12e07` | test matrix, evidence defects, `project_cash` closed, `RECOMPUTE_SENTENCE` |
| `f261dc5` | `basis` on SCALE, routing |
| `f15a88b` | `covers`, `get_income.sourceKey`, clause test, live check |
| `52c69ec` | the four review blockers |
| `74a74b9` | "Run tools rather than offering to", `source` copy-exactly |

## 18. Remaining gaps

- **Clauses stated one bare turn at a time, before any scenario has run, compose 1/6.**
  This is the largest open item.
  - The model stores the floor and debt rules through `remember`, which is correct
    Memory V2 behaviour. Memory V2 has **no field for an income rule**, and there is
    no envelope until a scenario runs. So "starting January my income increases 10%",
    stated alone, survives only in prose.
  - At "what do I have next December?" the model usually runs a baseline
    `project_cash`. It states which clauses it left out (6/6), so it is honest, but
    it is incomplete.
  - Closing this properly needs either an income vocabulary in Memory V2, or a
    pending-assumptions carrier for clauses stated before any run. Both redesign
    closed architecture, which the brief forbids without evidence. This finding is
    that evidence.
- **The salary replacement still fails half the time:** the model reaches for an
  account id instead of a `sourceKey` (3/6 ran). Every miss is refused by name and
  disclosed. None ran as a different income.

- **Interest counted as income** by the flow classifier on the real Space. An
  unqualified raise reaches it. This is disclosed, not fixed: fixing it is a
  classifier and `streams.ts` change, outside I1.
- **Memory V2 cannot hold an income rule.** A durable "I'm getting a raise in January"
  needs a vocabulary slice.
- **The overlap semantic is ordered.** It is disclosed on every line, but a model may
  still find per-rule figures confusing. The cash figures are always correct.
- **A future-spending change** is correctly refused as an argument, but the model may
  approximate it through `assumedMonthlySpending` from today. It discloses the
  simplification when it does, but the percentage is computed in prose. That is S1's
  problem.
- **The tool schema grew 21%.**
- **`scenario_goal_seek`** can be slow under concurrent load (the reviewer saw a
  9-minute baseline call during the dogfood). This is not caused by I1.

## 19. S1 readiness

**Ready for its own investigation.** I1 leaves S1 four reusable pieces:
- a pattern: transform dated events inside `assembleForecast`, and prove it with a diff
- a closed-argument machinery that already refuses `spendingChanges` by name
- a derived continuity policy that will classify a new argument automatically
- a `covers` / recompute contract that is generic

The one structural difference S1 must face: **spending is a RATE, not dated events**
(`projection.ts`: "Income is DATED … Spending is a RATE"). A dated spending change
therefore cannot reuse the event transform. It needs a piecewise daily rate in
`projectCash`'s fold, which is a change to the fold rather than to its inputs. That is
S1's first investigation question.
