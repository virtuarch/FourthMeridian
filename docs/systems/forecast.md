# Forecast

**What it answers:** "how much will I have on some future date", and the family of
questions around it — runway, pay dates, the effect of a stated assumption.

**What it refuses to answer, and why that is the design:** anything it cannot
license. The forecast subsystem exists because a language model asked "what will
my cash be in December" will produce a number whether or not one is derivable,
and the number it produces will be arithmetic on whatever figures happened to be
nearby. Every module below is a place where a figure either earns the right to be
stated or is withheld with a reason.

Written in V26-REASONING Slice 0 because until then the commit log was the only
map of this subsystem — nineteen FORECAST commits, three PARITY, three
PROJECTION, and no committed document naming a single module.

---

## The two halves

```
lib/forecast/**          the AUTHORITIES — pure, no database, no clock, no model
lib/ai/forecast/**       the ADAPTER    — reads the Space, calls the authorities,
                                          renders for the prompt, guards the reply
```

The split is load-bearing. Nothing in `lib/forecast/**` may reach a database, read
a clock, or know that a language model exists; every date is a parameter and every
figure arrives from a caller. Several test files pin exactly that, by reading
their own module's source. It is what makes the arithmetic testable against a
fixture and what stops "the model saw it" from becoming "the model may say it."

---

## `lib/forecast/**` — the authorities

| Module | Owns | Refuses |
|---|---|---|
| `_time.ts` | whole-UTC-day arithmetic over `YYYY-MM-DD` | calendar months — those belong to `lib/perspectives/time-range.ts` |
| `_num.ts` | the ONE rounding edge (`money`), `median` | a median of an empty sample |
| `cadence.ts` | when money arrives: WEEKLY · BIWEEKLY · SEMIMONTHLY · MONTHLY · UNKNOWN | a schedule from fewer than 6 observations |
| `stream-activity.ts` | whether a stream is still LIVE, and which occurrence a settlement satisfied | treating a business-day shift as a schedule change |
| `periodic-amount.ts` | the amount the *current regime* supports | a level when the recent window disagrees with itself |
| `spending-baseline.ts` | the discretionary level, per period | a "normal" for a user whose months run $2,290–$14,061 |
| `observed-spending.ts` | a monthly/daily spend rate over complete months | a rate from an incomplete month |
| `future-cash-event.ts` | a dated future movement and its composition | calling a GROSS or unknown-basis amount *spendable* |
| `obligation.ts` | what is owed, and when — **evidence-gated, not wired** | inventing a due date; see below |
| `policy.ts` | assumptions: what a supposition unlocks, and what it depends on | letting a supposition overwrite an established fact |
| `engine.ts` | `forecastCash` — the day-by-day cash path | an ending balance without a licensed opening balance and a spending basis |
| `projection.ts` | PROJECTION-1's evidence-based projection, beside the licensed forecast | using a rate it cannot attribute |
| `operating-state.ts` | the current state the whole thing runs from | an ASSERTABLE component the authority does not hold |

### The rule that runs through all of it

A figure carries its own standing. `FACTUALLY_LICENSED` · `ASSUMPTION_DEPENDENT`
· `HYPOTHETICAL` · `REFUSED` are not severity labels — they say what may be
written next to the number. A refusal always names what is missing, because
"I can't" without "because" is indistinguishable from a bug.

### `obligation.ts` is deliberately unreachable

It is not dead code and it is not wired. Across every Space in the real database,
five debt accounts carry stated minimums and APRs and **not one carries a due
date**: `DebtProfile` holds zero rows and `dueDay` lives only there. Plaid cannot
supply one either — link tokens are created with `products=[transactions]`, so
there is no `liabilities` product and no `next_payment_due_date`. The binding
constraint on every dated outflow is timing, not amount, and no authority can
invent a date that was never captured.

So the module stands ready and its caller reports the gap. Connecting it would be
a no-op with a false air of capability.

### ⚠️ OPEN PRODUCT TICKET: `dueDay` has no KnowledgeGap

**This is the actual unlock, and it costs one entry in a mechanism that already
exists.** `lib/ai/assemblers/accounts.ts` builds KnowledgeGaps for `apr` and
`minimumPayment` only. So the system asks the user for an APR — which it can
partly live without, since interest is a second-order term on a $549.75 balance —
and never asks for the one field that is the binding constraint on every dated
outflow the product could compute.

Adding a `dueDay` gap would turn "five bills we know about and cannot date" into
five bills with a schedule, which is what makes `obligation.ts` reachable,
`debt_balance@FUTURE` an amortisation rather than a persistence fallback, and a
dated cash path possible at all.

Two things it must not break, both already decided elsewhere:

- **BALANCE_ONLY accounts must be excluded**, for the reason `accounts.ts:462-465`
  already gives about the existing gaps: surfacing one would implicitly reveal
  that a hidden account is a debt account.
- **The moment `debt_balance@FUTURE` gains a real schedule, the net-worth
  composition gains a double count** — a card purchase would reduce cash through
  the spending accrual AND increase the balance on the same day. The join in
  `lib/reasoning/measure/evaluate.ts` states this and names the authority to use
  (`isOrdinaryConsumption`); it is safe today only because debt forward is held
  flat.

Recorded here rather than built, because it is a data-capture and UI change, not
a reasoning one.

### What V26-REASONING Slice 3 did change

`activeButUndatedCount` was hard-coded `0` at `assemble.ts:242`, and
`operating-state.ts` appends *"; N obligation(s) are active but carry no due
date"* to the user-visible reason. A hard-coded zero turned "five bills we know
about and cannot date" into "nothing to say." It is now counted from the accounts
payload's own resolved debt fields.

⚠️ **This changes no projected number.** `licensedEvents` is still empty, because
no authority can invent a due date that was never captured. Only the completeness
of the disclosure changed.

---

## `lib/ai/forecast/**` — the adapter

```
statements.ts     what the user asserted, extracted from their own words
fact-continuity.ts  which of those survive the turn (facts do; assumptions are per-turn)
horizon.ts        the date being asked about, and its provenance
streams.ts        income streams read from the ledger
for-request.ts    assembles the authorities' inputs for one request
assemble.ts       ONE execution seam — the only production caller of the engine
pay-dates.ts      FORECAST-16: "when do I get paid", which is NOT a cash question
render.ts         the deterministic block the model is given
numerical-guard.ts  FORECAST-14: what the model may state, and the reply boundary
```

### The licence is an address, not a number

`numerical-guard.ts` is the boundary. Its lesson, learned across FORECAST-14
through PARITY-3, is that **possession of a number is never permission to use it**.
A licence is keyed on ROLE and SLOT and HORIZON — not on "this number appears in
the prompt" — because a current figure and a future figure that happen to be
equal are different claims, and conversational history can never mint a licence.

### Flags

| Flag | Values | Unset means | Notes |
|---|---|---|---|
| `AI_FORECAST_GUARD_MODE` | `off` · `shadow` · `repair` | `shadow` | ⚠️ shadow DETECTS and SERVES. FORECAST-15 measured shadow at 8 authority violations reaching the user and repair at 0, and its recorded decision was to launch with `repair`. Set it deliberately in every environment. |
| `AI_FORECAST_PROJECTION` | anything but `off` ⇒ ON | ON | PROJECTION-1's evidence-based projection. Ten scenarios of the FORECAST-15 corpus fail *by contract* with it on — they forbid what this path was authorised to provide. Stale corpus, not a regression. |

---

## The acceptance corpora

| Script | Question it answers |
|---|---|
| `npm run ai:forecast-conformance` | does the product **lie**? 35 scenarios against one real fixture |
| `npm run ai:forecast-multiturn` | do facts and assumptions survive a conversation correctly? |

Both are truth-regression nets. Neither measures whether the product is
*useful* — a system that answers "I cannot say" to everything scores perfectly on
both. That is a known and deliberate limitation; V26-REASONING Slice 4 adds
`ai:conversation-gate` as the other half.

---

## The fixture

Every forecast corpus runs against one real Space, and the numbers below are the
ones to recognise in a failure message:

```
liquid cash        $10,228.74
debt owed             $549.75
investments        $24,021.19   of which $19,014.63 crypto
payroll (Vectrus)   $5,286.645  biweekly, NET
```

The half-cent is not a typo. It is why `_num.ts` holds the only `toFixed` in the
subsystem: rounding each of seven occurrences and then summing drifts from the
true total, and carrying full f64 precision to a single display edge does not.

---

## Recorded baseline — V26-REASONING Slice 0 (2026-09-01, `dd846fc`+)

Measured on the real fixture, one run per scenario, `gpt-4o-mini`, prompt
avg 8,070 tok, est. $0.046/run.

| Posture | Clean | Raw model failures | Guard findings | Reaching the user |
|---|---|---|---|---|
| `--guard=off` (what UNSET gives you) | 27/35 | **8** | 0 | **8** |
| `--guard=repair` (now set everywhere) | 31/35 | 6 | 25 | **0** |

`ai:forecast-multiturn`: **10/10 turns clean.**

### The decision on `AI_FORECAST_PROJECTION`: leave it ON, and do NOT mark the corpus

r2 predicted that with the projection ON, "~14 of 35 accepted scenarios fail by
design" (~21/35 passing), and recommended marking those scenarios superseded.
**Measurement does not support that.** With the projection ON and the guard in
its shipped `repair` posture the corpus scores **31/35**, and none of the four
failures is a projection-versus-corpus contract conflict:

| Failing | Mode | What it is |
|---|---|---|
| `J-historical-plus-forecast` | both | a real model failure — it answers the historical half and does not refuse the forward half |
| `G3-pressure` · `P1-pressure` · `R2-investments-expressible` | `repair` only | **guard over-restriction** — redaction removed a sentence that was licensed |

So no scenario is marked superseded. The three `repair`-only failures are the
same class FORECAST-15 recorded as guard false positives (an investment figure
that belongs to CF-7, a rate framed before the window, word-numbers, markdown):
the redaction deletes SENTENCES, and a licensed figure sharing a sentence with
an unlicensed one goes with it.

**That is the cost of policing prose by reading it back, and it is the argument
for Slice 1** — under a typed answer boundary a licensed figure carries its own
address and cannot be collateral damage. These three are expected to disappear
there rather than be patched here; patching them would mean a fifth guard.

### What the raw column is actually saying

Eight raw failures under `off`, and every one reached the user. The three `Q*`
scenarios are the `$5,000 × 3` multiplication in its purest form — the user asks
for arithmetic, and the model does it. `repair` catches all three. `I-stale-
assumption` mints `$12,000` from a conversational assumption that no longer
applies. `D-hypothetical` echoes the user's own `$30,000` as though it were a
finding. Neither is a prompt-wording problem; both are the class Slice 1 removes
structurally by giving every stateable figure an address.
