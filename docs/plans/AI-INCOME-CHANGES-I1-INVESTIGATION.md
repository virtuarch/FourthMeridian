# I1 — FUTURE INCOME CHANGES · INVESTIGATION

Branch `v2.6`, from `b9e9fd6` (post-M1 CLOSED).
Status: **DRAFT — Phase 0.** No code written. The contract at the end is a
PROPOSAL awaiting the lead's approval against the evidence above it.

---

## 0. THE ONE FINDING THAT DECIDES THE ARCHITECTURE

`lib/ai/conversation/scenario-ledger.ts` contains **zero occurrences of the
string "income"** (64 KB, the whole deterministic scenario engine). The ledger's
input is:

```ts
export interface LedgerInput {
  opening:       LedgerOpening;
  spine:         readonly SpinePoint[];   // { date, liquid: number|null, isCheckpoint }
  contributions: readonly PlannedMovement[];
  outflows:      readonly PlannedMovement[];
  returns:       readonly ReturnPeriod[];
}
```
— `scenario-ledger.ts:316`

Cash arrives at the ledger **already projected**, as a number per date. Income is
upstream of it and invisible to it.

Two consequences, and they run in opposite directions:

**(a) I1 needs no ledger change at all, and reaches every downstream consumer for
free.** `spineFor()` (`tools.ts:2271`) builds each `SpinePoint` by calling
`runTo(date)` → `assembleForecast`. Change the income events inside
`assembleForecast` and the cash floor, the debt waterfall, the investment
contribution, the crossing search and the goal seek all see the changed cash,
because all of them read the spine and nothing else.

**(b) I1 cannot prove it ran the way every other clause proves it.**
`clausesInForce()` (`scenario-rules.ts:~370`) establishes that a clause executed
by reading it back off **settled movements**. An income transformation settles no
movement — it changes the shape of the cash curve the movements are settled
against. So Condition 2 is not a formality here: I1 must produce its own
execution evidence, from the spine, or it cannot honestly claim to have run.

---

## 1. THE FORECAST SPINE, TRACED

```
loadForecastIncomeStreams(spaceId, asOf)            lib/ai/forecast/streams.ts:110
  → ResolvedIncomeStream[]  { sourceKey, label, role, cadence, activity,
                              amount, projectionEligible, settledDepository, … }

buildCashSpine(ctx, { asOf, assumedMonthlySpending })   tools.ts:1551
  → CashSpine { asOf, retrospective, openingBasis, accounts,
                runTo(end, spendingOverride?) → AssembledForecast }   tools.ts:1638

assembleForecast(input)                              lib/ai/forecast/assemble.ts:171
  ── THE ONLY PRODUCTION CALL TO forecastCash, pinned by
     scripts/ai-baseline/baseline.test.ts:1394 (`assembleForecast(` call sites === 1)
  1. statements → facts applied to the AUTHORITIES (spending baseline, amount basis)
  2. statements → PolicyAssumption[] via routeStatement()
  3. one-off dated events (ONE_OFF_EVENT subject, FORECAST-17) → FutureCashEvent[]
  4. FOR EACH STREAM:  periodicCashEvents(activity, cadence, amount,
                          horizon.from, horizon.to, role, settledDepository)
                       → FutureCashEvent[]            assemble.ts:351-361
  5. forecastCash(state, events, policy)            [LICENSED path]
  6. projectCash({ openingCash, events, spending, from, to })   [PROJECTION-1 path]

spineFor(shareDates, monthlySpending)                tools.ts:2271-2281
  → SpinePoint[]   (liquid = runTo(date, override).projection?.closing ?? null)

runScenarioLedger({ opening, spine, contributions, outflows, returns })
  → LedgerResult → clausesInForce() → scenarioAssumptions() → the model
```

**Step 4 is the insertion point.** It is the single place where a licensed income
stream becomes dated future cash, and it is inside the one function that pins
itself to one call site.

### Why not the other candidates

| Candidate | Rejected because |
|---|---|
| `runScenarioLedger` | knows nothing about income; would require inventing an income concept in the ledger — a second income model. |
| `projectCash` / `forecastCash` | fold events; they do not generate them. A transformation here would have to re-derive which events are income. |
| `loadForecastIncomeStreams` | the DB edge. Transforming here would make a hypothetical look like an observation, and retro-runs reconstruct the *then-current* world through it. |
| a new I1 projection function | a second forecast engine. Forbidden by the brief and by `assemble.ts`'s own header. |

---

## 2. CANONICAL INCOME AUTHORITY

There is no single "current income" scalar. Income is a **set of streams**, each
carrying separately-owned verdicts:

| Question | Authority | Field |
|---|---|---|
| who pays, into which account | `streams.ts` grouping | `sourceKey = <canonicalMerchantKey>@<accountId>` |
| how often | FORECAST-1 `lib/forecast/cadence.ts` `deriveCadence` | `cadence: CadenceResult` |
| is it still live | FORECAST-2 `lib/forecast/stream-activity.ts` | `activity`, `projectionEligible` |
| how much per occurrence | FORECAST-5 `lib/forecast/periodic-amount.ts` `deriveCurrentPeriodicAmount` | `amount: PeriodicAmount \| null` |
| gross or net | FORECAST-3 `lib/forecast/future-cash-event.ts` | `amount.basis: NET \| GROSS \| UNKNOWN` |

`ResolvedIncomeStream` (`streams.ts:59`) is the composition of those verdicts and
is the closest thing to an income authority. **It is deliberately not a number.**

### Source identity — SETTLED, and already addressable

`sourceKey = <canonical merchant key>@<accountId>` (`streams.ts:126`), with a
human `label` "so a prompt can name a stream without leaking an id"
(`streams.ts:61`). The account is part of the identity **by measurement**:
"interest payment" across two savings accounts produced a nonsense gap histogram
that resolved into two clean monthly series once the account joined the key
(`cadence.ts:~99`).

The precedent for aggregate addressing already exists: `StreamContinuationAssumption`
uses **`sourceKey: string | null`, where `null` means "every projection-eligible
stream"** (`policy.ts:256`). I1 should reuse that convention rather than mint one.

The model can already DISCOVER a `sourceKey`: `get_pay_dates` returns
`{ sourceKey, label, … }` per source (`pay-dates.ts:67,117`).

⚠️ **A `sourceKey` embeds an `accountId`, and account ids churn when a connection
is re-linked** — `scenario-rules.ts:~64` records this as the reason no durable
structure keeps one. So a `sourceKey` may live in the ephemeral conversation
envelope and **must never reach durable memory**. This is load-bearing for the
Memory V2 boundary (§8).

---

## 3. CADENCE — A CLOSED SET OF FOUR, AND NO ANNUAL

```ts
export const CadenceKind = {
  WEEKLY: 'WEEKLY',        // 52/yr
  BIWEEKLY: 'BIWEEKLY',    // 26/yr — NOT 24
  SEMIMONTHLY: 'SEMIMONTHLY', // 24/yr
  MONTHLY: 'MONTHLY',      // 12/yr
} as const;
```
— `cadence.ts:49`

There is **no ANNUAL and no QUARTERLY cadence kind.** Consequences for I1:

- "$180k salary" is an **annual rate**, not a cadence. It can only be applied to a
  stream that already has one, by `annualAmount / annualFactor(kind)`.
- `monthlyEquivalent(amount, kind) = amount * annualFactor(kind) / 12` is the
  canonical conversion and its **evaluation order is pinned** — "amount × annual ÷ 12"
  and "amount × monthlyFactor" disagree in the last bits for 14 of 60 measured
  pairs (`cadence.ts:~160`). Any annual→per-occurrence derivation I1 adds belongs
  **in `cadence.ts` beside it**, never inline at a call site.
- A stated cadence I1 cannot express (quarterly, annually-as-a-schedule) must be
  **refused by name**, not approximated.

---

## 4. THE VOCABULARY I1 SHOULD EXTEND

`lib/forecast/policy.ts` already holds the typed statement vocabulary, and it was
built to be extended:

```ts
export type StatementSubject =
  | { kind: 'SPENDING_LEVEL';       amount; currency; periodBasis }
  | { kind: 'STREAM_AMOUNT_BASIS';  sourceKey; basis }
  | { kind: 'EVENT_AMOUNT_BASIS';   eventId;   basis }
  | { kind: 'STREAM_CONTINUES';     sourceKey; continues }
  | { kind: 'ONE_OFF_EVENT';        amount; currency; basis;
                                    direction; role; dateISO }   // FORECAST-17
```
— `policy.ts:1034`

```ts
export interface UserStatement {
  mode: StatementModeKind;      // ASSERTS_FACT | REQUESTS_ASSUMPTION | REQUESTS_SCENARIO
  subject: StatementSubject;
  statedAs: string;             // ⚠️ DERIVED from the numbers, never caller prose (see §5)
  asOfISO: string;
}
```

**Semantic class E — one-time income — IS ALREADY BUILT.** "I get a $20,000 bonus
in December" is `ONE_OFF_EVENT` with `direction: 'INFLOW'`, shipped as FORECAST-17
(`5190c29`). I1 does not re-implement it; I1 **verifies it composes** and does not
duplicate it.

So I1's genuinely new work is classes **A (multiplicative), B (replacement rate),
C (stop), D (new recurring income)** — all four of which are transformations of, or
additions to, the *dated occurrence series* produced at step 4 of §1.

---

## 5. THE APPLIED-FACTS INVARIANT (non-negotiable for I1)

`54eb8e1` — a caller-supplied `statedAs` was quoted verbatim into `appliedFacts`,
so a "$15k bonus" sentence rode into the applied channel attached to a $4,346
spending figure; the projection moved $10.43 and the result reported the bonus as
applied. The wording is now **derived from the amount** (`tools.ts:1583`
`spendingStatement`), and the model-facing `statedAs` was removed.

**I1 must do the same.** An `incomeChanges` entry carries structured fields only;
the sentence describing it is generated by code from those fields. No caller
prose reaches `appliedFacts`, the roster, or the envelope. The same rule already
demoted contribution `label` (`scenario-rules.ts:~220`).

---

## 6. SLICE 0 — THE THREE READINESS CONDITIONS, AS FOUND

### Condition 1 — assumption keys vs schema

The hand-written list:

```ts
const ASSUMPTION_KEYS = [
  'annualReturnPct', 'returns', 'contributions', 'outflows',
  'assumedMonthlySpending', 'liabilityAssumptions',
] as const;
```
— `active-scenario.ts:222`

**It is NOT the preservation list.** Arguments are preserved *verbatim*
(`withoutUnappliedLabels` ∘ `withoutRefusedArguments`). `ASSUMPTION_KEYS` feeds
exactly one predicate, `carriesAssumptions(args)` (`active-scenario.ts:229`),
which decides whether a **`scenario_crossing`** call is a hypothetical at all:

```ts
if (toolName === CROSSING_TOOL && !carriesAssumptions(args)) return { action: 'IGNORE' };
```

So the real I1 failure mode is worse than "silently dropped from continuity":
a `scenario_crossing` carrying **only** an income change would be judged a
baseline reading of the current trend, return `IGNORE`, and **leave the previous
scenario standing** — a stale result surviving a question that changed the world.

The authoritative schema is `SCENARIO_INPUTS` (`tools.ts:2588`), spread into all
three scenario tools (`:2699`, `:2752`, `:2932`). `scenario-rules.ts` already has
the readers: `schemaKeys()` / `schemaItemKeys()` (`:110`, `:117`), already used by
`refuseUnknownArguments()` (`:134`) against the tool's own `parameters`.

**Required invariant:** every key `SCENARIO_INPUTS` declares is classified as
either an ASSUMPTION or explicitly NOT one; a key in neither list fails a guard.

### Condition 2 — execution proof

The existing mechanism, for contrast (`scenario-rules.ts:~370`):

> READ OFF THE SETTLED MOVEMENTS … never off the arguments and never off a label.
> A rule the ledger rejected settled nothing and is therefore reported as not
> having run, which is the truth about it.

`clausesInForce` returns a **closed roster** in which `ran: false` is a value, so
"the clause is missing from the echo" is unrepresentable. `compactClauses` puts
`'NONE'` — a word in a named slot — into the envelope for the same reason.

I1 settles no movement, so I1 needs the equivalent: a record written **by the
transformer, at the moment it transforms**, naming which occurrences it changed.
Requested ≠ executed must be visible in the result.

### Condition 3 — accepted key must have a consumer

Half of this already exists and is already aimed at I1 by name:

> `prepareScenario` reads the keys it knows and never looked at the rest, so
> `incomeChanges`, `contribution`, `floor` — a premature, misspelt or invented
> argument — ran the scenario WITHOUT that clause and said nothing … The closed
> set is therefore not a second list to keep in step. It is read off the SAME
> object the model was shown — the tool's `parameters` — so an argument the schema
> gains (I1's `incomeChanges`) is accepted the moment it is declared, and never
> before.
— `scenario-rules.ts:88-104`

`refuseUnknownArguments` closes "accepted but not declared". What is **not**
closed is the converse: **declared but never consumed.** Nothing today catches a
key added to `SCENARIO_INPUTS` that no production code reads.

`active-scenario.ts:189` names the same example:

> A refused `incomeChanges` left in the remembered arguments would be re-read on
> every later turn as part of the scenario — the label problem again, as a key.

The repo anticipated I1 in two files. Slice 0 is closing doors the authors left
marked.

---

## 7. WHAT I1 MUST NOT TOUCH

- `measure_flows`, `get_baselines`, `get_income`, `get_spending` — **measured past.**
  A future income rule is a scenario assumption and may not reach them. The
  separation is structural: those tools never call `assembleForecast`.
- Observed transaction history, account balances, declared product truth.
- Memory V2 — an I1 rule is not a durable belief. The active-scenario envelope is
  explicitly **transient**: "never SpaceMemory, never a checkpoint, never a row …
  It dies with the process, and that is the feature" (`active-scenario.ts:33`).

---

## 8. THE FOUR FINDINGS THAT CHANGED THE DESIGN

### 8.1 The typed income vocabulary is UNREACHABLE in production

`assembleForecast` consumes `ONE_OFF_EVENT` statements, `STREAM_AMOUNT_BASIS`
statements and `additionalEvents`. A grep for production producers of a
`subject: {` literal across `lib/` and `app/` returns **exactly one**:
`tools.ts:1586`, a `SPENDING_LEVEL`. Consequences, all verified:

- `assertedBasis` (`assemble.ts:187`) is **always an empty Map** in production.
- `input.additionalEvents` is **never supplied** — `assemble.ts:101-107` says so
  in writing and calls it "a reported gap rather than a hidden one".
- `assertedPeriodicAmount` (`periodic-amount.ts:342`) has **no non-test caller**.
- `grep 'STREAM_AMOUNT_BASIS\|STREAM_CONTINUES\|sourceKey' lib/ai/conversation/*.ts`
  → **zero hits**. Nothing in the conversation layer can name a stream.

So semantic class **E (one-time income) is NOT already shipped** on the income
spine, as an earlier reading of FORECAST-17 suggested. What IS shipped is a
different, working route: a **negative `outflow`** in `scenario_projection`
(`tools.ts:2665` — *"Use a NEGATIVE amount for a one-off inflow such as a bonus"*),
which lands in the ledger and never touches income at all.

**Decision: I1 does not re-implement class E.** A dated one-off inflow already has
a deterministic, executed, movement-evidenced home, and the roster already proves
it ran (`fixedAmounts` / `outflows`). I1 covers **A, B, C, D** — transformations of,
and additions to, the RECURRING dated occurrence series — and the test matrix
verifies E composes with them rather than duplicating it.

### 8.2 A policy assumption alone would report without executing

`applyPolicy` produces a `PolicyResolution` consumed by `forecastCash` — the
**licensed** path. On the real Space the licensed path REFUSES, because every
derived payroll amount carries `basis: UNKNOWN` and FORECAST-3 will not guess a
tax treatment. The answer therefore comes from PROJECTION-1's `projectCash`
(`assemble.ts:405-411`, `:445`), whose input is:

```ts
projectionInput = { openingCash, events, spending, fromISO, toISO, currency };
```

**`projectCash` never sees the policy.** An `INCOME_CHANGE` expressed only as a
sixth `AssumptionDimension` would appear in every explanation and move no money —
the exact "requested ≠ executed" failure Condition 2 exists to prevent, arrived at
by the most respectable-looking route available.

**Decision: I1 transforms the EVENTS**, at the one place a licensed stream becomes
dated cash, and records what it did there.

### 8.3 Aggregation already disagrees with itself; I1 must not join in

Ten independent monthly-income aggregations exist. Three feed adjacent answers off
**different month populations**: the Brief uses `reliableMonths` (`metrics.ts:294`),
`measure_flows` uses `monthsSpanned(period)` with zero-fill (`measure.ts:233`), and
`get_baselines` prefers the cadence sum (`baseline.ts:196-212`). Separately,
`streams.ts:119` reads by `flowType` alone and **never consults `incomeClass`**.

**Decision: I1 adds no eleventh aggregation.** It changes dated occurrences and
lets every existing consumer keep its own definition. I1 never computes "monthly
income".

### 8.4 Three downstream consumers cannot see an income change, by construction

Documented rather than "fixed", because each refusal is deliberate:

| Consumer | Why I1 does not reach it |
|---|---|
| runway / liquidity | expense-only: `runway = liquid / expense.amount` (`baseline.ts:319-328`). No income term exists to change. |
| savings rate | refuses a MEASURED income basis outright (`baseline.ts:305-317`); it reads CADENCE or STATED. A scenario supposition is neither. |
| `measure_flows`, `get_income`, the Brief | **measured past.** A future rule may not reach them — that is §7's boundary, and it is structural: none of them calls `assembleForecast`. |

`scenario_goal_seek`'s solvable levers (`tools.ts:2889`) and `scenario_crossing`'s
metrics (`scenario-crossing.ts:30`) likewise carry no income member. I1 adds none:
the brief asks for income changes to **compose with** goal seek and crossings, and
they do — through the spine — without either needing an income vocabulary.

---

## 9. THE I1 CONTRACT — APPROVED

### 9.1 Where it lives

| Layer | Module | Role |
|---|---|---|
| primitive | `lib/forecast/income-change.ts` **(new)** | pure. Transforms `FutureCashEvent[]`; returns the events AND the execution record. |
| units | `lib/forecast/cadence.ts` | gains the two inverses of `monthlyEquivalent`, beside it, under the same pinned evaluation order. |
| spine | `lib/ai/forecast/assemble.ts` | applies the rules at the one place a stream becomes dated cash. |
| argument | `lib/ai/conversation/scenario-inputs.ts` **(new)** | `SCENARIO_INPUTS` extracted so the schema is ONE literal two modules can read. |
| evidence | `lib/ai/conversation/scenario-rules.ts` | a sixth roster clause, read off the execution record. |
| continuity | `lib/ai/conversation/active-scenario.ts` | `ASSUMPTION_KEYS` derived, not hand-written. |

### 9.2 The argument

```ts
incomeChanges: [{
  op: 'SCALE' | 'SET_RATE' | 'STOP' | 'START',
  source?: string,          // a sourceKey from get_pay_dates / get_income.
                            // Omitted = EVERY projection-eligible income stream.
  from:   'YYYY-MM-DD',     // inclusive. The first occurrence the rule governs.
  to?:    'YYYY-MM-DD',     // inclusive. Omitted = to the horizon.
  multiplier?: number,      // SCALE only. 1.1 for "+10%".
  amount?:   number,        // SET_RATE | START.
  per?: 'YEAR' | 'MONTH' | 'OCCURRENCE',   // SET_RATE | START. What `amount` is per.
  basis?: 'NET' | 'GROSS',  // SET_RATE | START. Required — never guessed.
  cadence?: 'WEEKLY'|'BIWEEKLY'|'SEMIMONTHLY'|'MONTHLY',  // START only.
  label?: string,           // START only. The name of a THING, bounded, never a rule.
}]
```

### 9.3 The four operations

| Op | Sentence | Semantics |
|---|---|---|
| **SCALE** | "starting January my income increases 10%" | every governed occurrence's amount × `multiplier`. Basis and `observedSettled` are PRESERVED; provenance becomes HYPOTHETICAL. |
| **SET_RATE** | "starting March I make $15,000 per month" | every governed occurrence's amount becomes the stated rate, normalised to the target stream's own cadence by `cadence.ts`. |
| **STOP** | "this income stops after June" | no governed occurrence is generated. `from` is the first date NOT paid. |
| **START** | "starting February I receive $3,000 per month" | a new synthetic stream generates occurrences on `cadence` between `from` and `to`. |

### 9.4 Source identity — the contract, and where it refuses

`source` is a `sourceKey` (`<canonicalMerchantKey>@<accountId>`), discoverable by
the model from `get_pay_dates` and `get_income`, which already return it.

- **An unknown `source` is REFUSED by name**, and the refusal lists the keys that
  do exist. The refusal is the discovery path — cheaper than a roster tool and
  self-correcting.
- **`source` omitted = every projection-eligible income stream.** This is the
  existing convention: `StreamContinuationAssumption.sourceKey: null` already
  means exactly that (`policy.ts:256`).
- **SCALE may be aggregate.** "My income increases 10%" scales every stream by
  10%, which is what the sentence means whatever the streams are.
- **SET_RATE and STOP may NOT be aggregate when more than one income stream is
  projection-eligible.** "I make $15k/month from March" against three streams is
  genuinely ambiguous — replace all income, or replace the salary? The rule is
  refused and the streams are named. With exactly one stream it is unambiguous and
  it runs.
- **The model never decides which transactions are salary.** It selects an
  existing key or it is refused. There is no name matching anywhere in I1.

⚠️ A `sourceKey` embeds an `accountId` and is **not durable across a reconnect**
(`scenario-rules.ts:64`). It may live in the ephemeral envelope; it must never
reach Memory V2. See §9.8.

### 9.5 Units — code owns every conversion

`per` is normalised to a per-occurrence amount against the TARGET STREAM'S OWN
cadence, in `lib/forecast/cadence.ts`, beside `monthlyEquivalent` and under its
pinned evaluation order (`amount × annual ÷ 12`, because the two orders disagree
in the last bits for 14 of 60 measured pairs):

```
per: 'YEAR'        perOccurrence = amount / annualFactor(kind)
per: 'MONTH'       perOccurrence = amount * 12 / annualFactor(kind)
per: 'OCCURRENCE'  perOccurrence = amount            (cadence must be known)
```

**Explicitly unsupported, and refused by name rather than approximated:**
a QUARTERLY or ANNUAL *cadence* (`CadenceKind` has four members and `annualFactor`
is an exhaustive switch over them); a rule against a stream whose cadence is
`UNKNOWN` (there is no schedule for a rate to be a rate OF — FORECAST-5's own
refusal, inherited); a `per: 'OCCURRENCE'` rate with no established cadence.

### 9.6 Dates

Every date reaching the contract is an explicit `YYYY-MM-DD`; the model does the
natural-language interpretation and the contract does none. `from` is **inclusive**
— the first occurrence governed. `to` is **inclusive**. "After June" is
`from: '2027-07-01'`, and the boundary is tested in both directions.

No new date arithmetic: occurrence dates are `expectedOccurrencesBetween`'s, and
governance is an ISO string comparison over dates that authority already produced.

### 9.7 EXECUTION EVIDENCE — Condition 2

The transformer returns, per rule, a record built from the event arrays it
actually changed:

```ts
interface IncomeChangeExecution {
  ruleId: string;  op: IncomeChangeOpKind;
  matched: { sourceKey: string; label?: string }[];
  occurrencesChanged: number;
  firstChangedISO: string | null;  lastChangedISO: string | null;
  governedInflowBefore: number;  governedInflowAfter: number;
  ran: boolean;             // occurrencesChanged > 0. Never set by a caller.
  reason?: string;          // required whenever `ran` is false
}
```

`ran` is computed from the diff, never from the presence of an argument. A rule
whose window falls outside the horizon, or which matched no stream, reports
`ran: false` **with the reason**, and the answer may not describe it as included.
This is the `liabilityAssumptions` precedent — the one existing non-movement
transformation that is evidenced — generalised: *a structure the spine consumes
and returns.*

### 9.8 Memory V2 — no change, and the gap named

`Memory V2` field sets are closed (`memory-model.ts:159-175`). `BASELINE` is
`{monthlySpending, annualReturnPct}`, restricted to exactly one key; `RULE`'s keys
are a strict subset of `CONTRIBUTION_KEYS`. **No class can hold an income fact,
and I1 adds none.** Jamming an income change into a dollar field is exactly what
the brief forbids. The gap is recorded here for a later memory-vocabulary slice.

Running an I1 scenario writes no memory row; the envelope is transient by design.

---

## 10. STOP CONDITIONS — none triggered

| Condition | Verdict |
|---|---|
| requires rewriting the forecast architecture | **No.** One insertion point inside the single existing spine; the ledger is untouched. |
| canonical income authority ambiguous enough to create a second truth source | **No** for the forecast: `ResolvedIncomeStream` → `periodicCashEvents` is one chain. The ten measured aggregations are a real problem (§8.3) and I1 stays out of it by adding no aggregation. |
| source-specific income cannot be represented without guessing | **No.** `sourceKey` exists, is already exposed to the model, and an unknown one is refused. |
| the contract requires model-side financial arithmetic | **No.** Every conversion is in `cadence.ts`. |
| continuity cannot preserve the rule without redesigning Memory V2 | **No.** The envelope is ephemeral and preserves arguments verbatim; Memory V2 is untouched. |
| implementation would require writing to live | **No.** Guard landed and proven (`d637044`). |
| a future-spending change is required | **No.** S1 is not needed for any of A–D. |
| deterministic execution evidence cannot be produced | **No.** §9.7. |
