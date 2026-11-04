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


> ## ⚠️ Reachable only by code, since the AI conversation reset
>
> **The forecast engine and its authorities are intact, tested and correct. What
> was removed is everything that turned a sentence into a forecast, and a
> forecast into prose.** Deleted: `horizon.ts` (a date phrase → a window),
> `statements.ts` and `fact-continuity.ts` (regex extraction of asserted facts
> and suppositions), `render.ts` (the prompt block), `for-request.ts` (route
> orchestration) and `numerical-guard.ts` (the figure licence and reply
> redaction).
>
> `assembleForecast` now takes `UserStatement[]` — FORECAST-8's own typed
> vocabulary — instead of `question: string` and a message history, so the whole
> subsystem is a function of values with no natural-language surface anywhere.
> `resolvePayDates` likewise takes an explicit ask and window. Nothing in
> production calls either today; the capability is preserved and pinned by
> `lib/ai/forecast/assemble.test.ts` for whatever conversation layer comes next.
>
> See [AI foundation §9 — the conversation reset](./ai-foundation.md#9-history-the-2026-09-07-conversation-reset--deprecated-machinery).

---

## The two halves

```
lib/forecast/**          the AUTHORITIES — pure, no database, no clock, no model
lib/ai/forecast/**       the ADAPTER    — reads the Space, calls the authorities
```

There used to be a third job in the adapter — rendering for a prompt and guarding
the reply — and it is gone. The adapter's whole surface is now: read the ledger,
compose the inputs, run the engine once.

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
| `periodic-amount.ts` | the amount the *current regime* supports (median of the regime; one deviating payment, including the newest, is an outlier — see below) | a level when the recent window disagrees with itself |
| `spending-baseline.ts` | the discretionary level, per period | a "normal" for a user whose months swing several-fold |
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

### `periodic-amount.ts`: the newest payment is judged like every other one

**IMPLEMENTED** (AI reliability fix, `89a46ad`). The backward walk used to seed its
level from the NEWEST payment. One deviating paycheck at the head (a bonus-sized or
otherwise unusual deposit) therefore became the level, every older payment read as a
deviation from it, the run hit `BREAK_RUN`, and the regime was truncated to one point,
so the stream's amount was refused. The same payment mid-series was correctly an
outlier. Now the head is tested against the `MIN_OBSERVATIONS` points behind it: when
those agree and the head does not, the head is ONE deviation, held out as a
provisional outlier, the established level is asserted, and the deviation is
disclosed as `latestDeviation` (date, value, level, signed percentage). A low head is
treated the same way, with its sign. Two deviating heads are still a new level
(`BREAK_RUN` unchanged) and are refused as too young; a regime too short to judge the
head is not rescued. Pinned by `periodic-amount.test.ts` D5–D12 (D5, D9, D10 fail on
the old code). Whether a deviating newest payment is a one-off or a new level is
genuinely unknown until the next one arrives; the consumer discloses both readings
(see `income-completeness.ts` below).

### Income evidence: what deposits can and cannot establish

Durable conclusions from the v2.6 income-truth investigation (read-only; no figures
are carried here):

- **Robust statistics only.** A stream's level is a median over its current regime,
  never a mean. A single bonus-sized payment under a mean manufactures a phantom pay
  rise. (`lib/ai/assemblers/transactions.ts` `buildRecurringCandidates` still uses a
  mean and ignores dates; it is a spending rollup and must not be read as income
  cadence.)
- **Cadence is decided by date shape, not by "two payments most months".** BIWEEKLY
  needs a dominant 14-day gap and a stable weekday, and produces three-payment months;
  SEMIMONTHLY lands on two days of the month with the weekday scattered and gaps of
  roughly 13–18 days. `cadence.ts` breaks the 14–15-day tie on day-of-month spread.
- **A change of payer is two streams, never one.** An old stream ending as a new one
  starts, with no shared entity-like tokens in the descriptors, is a handover between
  two streams. Streams are keyed `<canonical merchant key>@<accountId>`
  (`lib/ai/forecast/streams.ts` `sourceKey`, via `normalizeMerchant`). The
  investigation recommended keying on the raw descriptor instead, because the enriched
  merchant drifts (the reason DF-4 keys the dedupe fingerprint on the raw descriptor,
  `lib/transactions/fingerprint.ts`). That recommendation is **not implemented**.
  There is no payer-identity resolution for income.
- **Net deposits only.** Gross pay is not observable. A step in net pay cannot be
  separated from a withholding, benefits or contribution change, so code may say "the
  level changed on this date", never "a raise". A changed descriptor, cadence and
  weekday anchor are observations; a job or employer change is an inference (a payroll
  provider migration produces the same three signals).
- **The date is the bank's posting date** at day precision (`@db.Date`), not the
  employer's payday. A "Friday" pattern is a posting pattern.
- **Absence is not evidence.** Income into an unconnected institution is invisible, and
  history starts where the connection starts, not where the stream started.
- **PROPOSED, not built:** a first-class income-stream truth object (interval
  histogram retained as evidence, level segments with competing explanations and a
  required `unknowns` list) inside sealed truth, and a separate expected-income
  artifact with its own model version and invalidation conditions. An expectation is
  falsifiable by the passage of time, so it must not be sealed inside truth. A
  forward-looking recommendation ("after your next paycheck you could put X toward
  debt") also needs an obligations model, a confirmed runway floor and invalidation
  conditions, none of which exist; the observed pattern and the next expected payment
  are the only honest parts of that sentence today.

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
partly live without, since interest is a second-order term on a small card balance —
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
  the spending accrual AND increase the balance on the same day. The measure
  layer that used to state this (`lib/reasoning/measure/evaluate.ts`) was deleted
  with the conversation layer, so the warning is recorded HERE, where the
  subsystem lives: the authority to reach for is `isOrdinaryConsumption`, and the
  composition is safe today only because debt forward is held flat.

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
streams.ts        income streams read from the ledger (the only database edge)
assemble.ts       ONE execution seam — the only caller of the engine
pay-dates.ts      FORECAST-16: "when do I get paid", which is NOT a cash question
```

Three files, and each takes explicit values. `assembleForecast` receives a
`ForecastHorizon`, the resolved streams, and `UserStatement[]`; it decides where
each statement belongs by calling FORECAST-8's `routeStatement`, so an
`ASSERTS_FACT` reaches the operating state and everything else becomes a
`PolicyAssumption`. It parses nothing, and a test pins that it declares no regular
expression at all.

### `income-completeness.ts`: an unpriced paycheck is never a silent zero

**IMPLEMENTED** (AI reliability fix `89a46ad`; FIN-001 sibling `07d59a8`).
`projectCash` drops, inside `foldWindow`, any future occurrence whose amount is not
assertable, and this is correct: the licence stays with the authorities. The defect
was what happened next. A CURRENT, projection-eligible payroll stream whose amount had
been refused contributed $0, and the result was still labelled a complete
evidence-based estimate with a fixed sentence saying payroll was inferred from cadence.
`lib/ai/forecast/income-completeness.ts` (pure) now says, per stream, what reached the
projected total. A material omission of a FlowRole.INCOME stream makes the projection
INCOMPLETE, with the evidence the platform holds and one stated consequence: the
ending figure if the omitted occurrences arrived at the last observed amount. The
statuses `AMOUNT_UNESTABLISHED`, `RECENTLY_SILENT` (schedule intact, at most
`RECENT_SILENCE.MAX_UNSATISFIED_OCCURRENCES` due slots unpaid) and `UNKNOWN` block when
material. `LAPSED` is disclosed and never blocks. An INTEREST stream never makes a
projection incomplete. Materiality is `MATERIALITY` (1% of opening cash plus counted
income, $50 floor), a measured policy constant, and immaterial omissions are still
listed. Nothing here picks which level is right. Pinned by `income-completeness.test.ts`.
The tool surface is in
[AI foundation §2.3](./ai-foundation.md#23-cash-projection-honesty-project_cash-and-reconcile_projection--implemented).

### What produced those statements, and what must produce them next

The licence machinery that used to sit here — `numerical-guard.ts`, keyed on ROLE
and SLOT and HORIZON rather than on "this number appears in the prompt" — was
deleted with the conversation layer, along with the five acceptance corpora
(`ai:forecast-conformance`, `ai:forecast-multiturn` and their siblings) that
measured a language model against it and the `AI_FORECAST_GUARD_MODE` flag that
switched it on.

**The lesson it taught is worth more than the code was, and it is recorded here
rather than in a deleted file:** possession of a number is never permission to
use it. A current figure and a future figure that happen to be equal are
different claims. Conversational history can never mint a licence. Whatever
speaks about a forecast next has to answer that, and it does not inherit an
answer.

What is *not* in question is the arithmetic. Every figure the engine produces is
licensed or refused by `lib/forecast/**` before any narration exists, and that
half is unit-tested without a model.

### Flags

| Flag | Values | Unset means | Notes |
|---|---|---|---|
| `AI_FORECAST_PROJECTION` | anything but `off` ⇒ ON | ON | PROJECTION-1's evidence-based projection, used only where the licensed path refused. Kept through the AI conversation reset because it selects between two DETERMINISTIC engine results, not between two narrations. |

`AI_FORECAST_GUARD_MODE` was removed: the guard it switched no longer exists.

---

## The fixture

The forecast tests run against one synthetic fixture. The values below are
invented fixture values (no real Space's figures), and they are the ones to
recognise in a failure message:

```
liquid cash        $12,000.00
debt owed             $600.00
investments        $25,000.02   of which $20,000.01 crypto
payroll (Employer A) $4,928.412 biweekly, NET
```

The half-cent is not a typo. It is why `_num.ts` holds the only `toFixed` in the
subsystem: rounding each of seven occurrences and then summing drifts from the
true total, and carrying full f64 precision to a single display edge does not.

---
## Recorded baselines

The V26-REASONING Slice 0 acceptance table that stood here measured a **language
model** against the forecast guard across 35 scenarios, and both the model path
and the guard are gone. It is preserved in git and summarised in
[AI foundation §9](./ai-foundation.md#9-history-the-2026-09-07-conversation-reset--deprecated-machinery); the
short version is the one worth carrying forward: under the non-enforcing default
**eight raw arithmetic failures per run reached the user**, and three of them were
the `$5,000 × 3` multiplication in its purest form — the user asks for arithmetic
and the model does it, beside a deterministic block holding the right answer.

That is the failure the next conversation layer is being designed against.
