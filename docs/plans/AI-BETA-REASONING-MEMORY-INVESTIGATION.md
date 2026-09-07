# Beta reasoning + memory — investigation

**Date:** 2026-09-08 · **HEAD:** `ccd6fa9` · **Status:** investigation. **Nothing implemented.**

Production route unchanged (`503 AWAITING_REDESIGN`). Evidence below comes from reading the
repository and from read-only probes against Chris' real Space, plus the 24-turn gpt-5.5 A2
dogfood at `tmp/ai-baseline/interactive-2026-09-07T21-25-37-355Z/`.

---

## 1. Executive verdict

| Area | Verdict | Why |
|---|---|---|
| **Historical as-of coherence** | **BLOCKS BETA** | 4M told Chris he had **$1,255** cash on Jan 1 when he had **$9,517**, then built debt advice on it. It only corrected because he pushed back. The substrate is complete and correct — **the defect is a naming collision in two tool adapters**, and the whole fix is one tool plus one rename. |
| **Deterministic scenario arithmetic** | **SHOULD HAVE BEFORE BETA** | Three turns of consequential arithmetic were done in prose. The model happened to get them *right* — I verified every figure — but a goal-seek in turn 13 produced *"mid-40% annualized returns"* and *"~$90K/year additional surplus"* that are derivable from nothing. |
| **Narrow durable memory** | **SHOULD HAVE BEFORE BETA** | Not for continuity of understanding — compaction already proved prose carries that. For **goals and forecast checkpoints**, which no amount of re-fetching can reconstruct. One table, three record kinds. |

**The strongest single finding:** the historical substrate can already answer everything Area 2
needs. Eight lenses at an arbitrary `asOf`, **all assertable, 303 ms, ~360 tokens**, with
account-level components. And `loadForecastIncomeStreams(asOf)` already reconstructs the
income world *as it then was*. The gap is that **every tool pins `asOf` to today**.

**The second-strongest:** a retrospective projection **already runs**. From 2026-01-01, using
only evidence through that date, the engine projects **$27,966.38** for 2026-09-07. Actual:
**$12,382.81**. Forecast reconciliation is computable today.

---

## 2. Repository evidence — the seams that exist

### Forecast / scenario

| Seam | Does | Time dimension? |
|---|---|---|
| `lib/forecast/projection.ts` `projectCash` | cash from opening + dated events − spending accrual | ✅ (endpoint; the tool loops it for month-ends) |
| `lib/forecast/engine.ts` `forecastCash` | the strictly-licensed path | ✅ |
| `scripts/ai-baseline/scenario.ts` `applyInvestmentScenario` | % move on named components → net-worth delta | ❌ **one instant only** |
| `lib/ai/economic-concepts.ts` `composeInvestments` | traditional + digital, disjoint | ❌ current only |

**Grepped for growth / compounding / return-rate / investment-contribution arithmetic across
`lib/forecast/**` and the harness: none exists.** Every occurrence of "contribution" in
`lib/forecast` means `netCashContribution` — *whether a dated event may count as cash* — not a
transfer into investments. There is no compounding anywhere in the repository.

### Historical / as-of

| Seam | Provides | Verified |
|---|---|---|
| `lib/history/exploration.ts` `resolveExplorationNode` | 9 lens roots at any date, with components, `assertable`, `unavailableReason` | ✅ probed |
| `lib/data/snapshots.ts` `getRecentSnapshots` | 770 daily rows, 2024-07-21 → 2026-09-07 | ✅ |
| `lib/ai/assemblers/snapshot.ts` `projectSnapshotSection` | crypto-coverage refusal (`aggregateAuthorisation`) | ✅ wired in Clip 2 |
| `lib/data/accounts-asof.ts` `getAccountsAsOf` | per-account balance at a date **with `{method, tier}`** — `cash-walkback` / `card-walkback` (derived), `before-coverage` (incomplete), `held-flat` (estimated) | ✅ probed |
| `lib/ai/forecast/streams.ts` `loadForecastIncomeStreams(spaceId, asOf)` | **income world as it was at `asOf`** | ✅ probed |
| `lib/investments/valuation.ts` `getInvestmentValueAsOf` | investment value at a date, with completeness | ✅ |
| `queryTransactions` / transactions assembler | any window, `dateTo` bound | ✅ |

### Persistence

| Model | State | Consequence |
|---|---|---|
| `SpaceGoal` / `GoalCheckIn` / `GoalContribution` | **TOMBSTONED.** `audit-goals-tombstone` is a **REQUIRED** CI audit forbidding any non-test reference to `SpaceGoal`, `GoalStatus`, `GoalCategory`… | **Memory must be a new model.** Reusing these fails the build. |
| `AiAdvice` | exists, **zero write path** (KD-14) | Wrong shape anyway — it stores generated prose, not structured intent. |
| `Conversation` / `ChatMessage` | **do not exist**, by documented design | Nothing to extend; nothing to unwind. |

---

## 3. Dogfood failure map

| Turn | Question | Deterministic | Model-derived | Verdict |
|---|---|---|---|---|
| 10 | 2030 yearly table | `project_cash` → cash checkpoints (`$38,244` … `$384,577`) | the entire **"Implied net worth"** column (cash + $23,957 non-cash − $25 debt) | arithmetic correct; unverifiable |
| 11 | "invest half my liquidity each year at 8%" | **nothing — zero tool calls** | cash-after-transfer, investment balance, compounding, net worth, all 5 years | **correct** (I re-derived every cell; the recurring $26 offset is the $25.46 debt, correctly applied) |
| 12 | "50% in 2028, 23 in 2029, 31 in 2030" | **nothing** | same ledger with per-year returns | **correct**, and it correctly inherited the prior scenario |
| 13 | "how could I reach $1M by 2030?" | `project_cash` only | **$591K gap** (correct); **"mid-40% annualized returns"**; **"~$90K/year additional investable surplus"** | the last two are **goal-seeks derivable from nothing** |
| 14 | "go back to Jan 1 2026… act as if you know nothing after" | `get_income`, `get_spending` (windowed correctly ✅), `explain_net_worth_change` ×2 | — | **WRONG: cash $1,255** |
| 15 | "cash was around 1k? are you sure?" | `explain_net_worth_change`, `get_net_worth_history` | — | corrected to **$9,517** only after challenge |

**Model arithmetic being *correct* is not the reassurance it looks like.** It is unrepeatable,
unverifiable, and invisible to every test in the repository. Turn 13 is what it looks like when
the same capability is asked for something it cannot derive.

---

## 4. Scenario arithmetic findings

### 4.1 What is actually missing

Precisely five things, none of which exist anywhere:

1. **Investment value over time** under stated returns (compounding).
2. **Contributions** — cash → investments, periodic or one-off.
3. **Per-period return assumptions** ("8%/yr", then "50% in 2028").
4. **Net-worth composition over time** (cash + investments − debt at each checkpoint).
5. **Goal-seek** — solve for the unknown that reaches a target.

Everything else the goldens ask for **already works**: `project_cash` handles *"what if I
spend $8K now"* and *"what if I wait until February"* (turns 2–3 did exactly that), and
`investment_scenario` handles *"what if Bitcoin goes up 15%"* at the current instant (turn 5).

### 4.2 The smallest primitive

> **One deterministic scenario ledger, driven by the cash spine that already exists.**

**Not a DSL. Not a planner.** A structured argument the model fills in from the conversation:

```
scenario_projection({
  to: "2030-12-31",
  granularity: "yearly" | "monthly",
  contributions: [ { from, to?, amount, cadence: "monthly"|"yearly" }
                 | { onDate, amount } ],              // cash → investments
  outflows:      [ { onDate, amount, label } ],       // one-off cash out (car, trip)
  returns:       [ { from, to, annualPct } ],         // default: 0 (flat)
  spendingOverride?: number,
})
```

Returns, per checkpoint: `cash`, `investments`, `debt`, `netWorth`, and the movements that
produced them.

**Why it cannot double count.** Cash comes from `projectCash(asOf → checkpoint)` — the
existing authority, re-run independently per checkpoint exactly as Clip 3 established — and
then contributions are **subtracted from cash and added to investments** in the same step. A
transfer is one movement recorded twice with opposite signs, never two events.

**Where each input comes from:**

| Input | Source | Provenance |
|---|---|---|
| opening cash | `project_cash` / accounts | MEASURED |
| income events | `loadForecastIncomeStreams` | MEASURED |
| spending | observed rate, or the user's override | MEASURED / USER_STATED |
| opening investments | `composeInvestments` | MEASURED |
| debt | accounts (held flat unless stated) | MEASURED |
| **returns** | **the user, always** | **USER_ASSUMED** |
| **contributions** | **the user, always** | **USER_ASSUMED** |

**Default return is 0%, not a market average.** Turn 10's table is exactly this primitive with
no contributions and no returns — which means one tool answers turns 10, 11 and 12.

### 4.3 Goal-seek

`"how do I get to $1M by 2030?"` is one unknown in the ledger above. **Binary search over the
same deterministic function**, ~40 iterations, microseconds:

```
scenario_goal_seek({ target: 1_000_000, by: "2030-12-31",
                     solveFor: "annualReturnPct" | "monthlyContribution" | "monthlySurplus",
                     ...same scenario inputs })
→ { required, feasible, ledger, unreachable?: reason }
```

`feasible: false` when no value in a sane range reaches the target — which is a real answer,
and better than a number.

**Against the four questions asked of every new abstraction:**

- *What dogfood failure requires it?* Turns 11, 12 and 13 — three consecutive turns of
  consequential prose arithmetic, one of which invented two advice-shaped figures.
- *Why can't an existing seam do it?* No compounding, contribution or goal-seek arithmetic
  exists anywhere in the repository. Verified by grep and by reading `lib/forecast/**`.
- *Smallest form?* One tool over `projectCash`, plus a solver that calls it. ~200 lines,
  in `scripts/ai-baseline/`, no engine change.
- *What does it let us avoid?* A separate projection engine, a scenario DSL, per-asset
  modelling, Monte Carlo, and any prompt rule telling the model not to do maths.

---

## 5. Historical as-of findings

### 5.1 Root cause of the $1,255 / $9,517 contradiction — **not an engine defect**

Both figures are correct. They describe different populations, and **two tools call both of
them "cash"**:

```
explain_net_worth_change{date: 2026-01-01, lens: 'cash'}
  → 1255.20   assertable: true   [Rewards Checking 250.71, CHASE COLLEGE 1004.49]

get_net_worth_history{2026-01-01}.cash
  → 9517.46   ( = SnapshotDataPoint.liquid = totalCash + totalSavings )
```

The exploration tree is internally coherent — it has a **separate `savings` lens** ($8,262.26)
and a `liquidity` lens that literally reports *"Cash now: 9517.46"*. My history adapter maps
`cash: p.liquid`. **A model cannot reconcile two fields with the same name and different
populations, and it should not have to.**

**Classification: TOOL CONTRACT.** Fix: rename the history field to `liquid` (or
`cashAndSavings`), and have `explain_net_worth_change` state the lens population.

### 5.2 `financial_snapshot(asOf)` — the substrate is already complete

Probed at 2026-01-01 and 2026-09-07:

| | |
|---|---|
| Lenses resolved | net-worth, assets, cash, savings, investments, crypto, debt, liquidity |
| Latency | **303 ms** (cold) / 143 ms |
| Composed payload | **1,445 bytes ≈ 361 tokens** |
| All assertable | **yes**, at both dates |
| Components | account-level (`Rewards Checking 250.71`, `Platinum Card® 24904.34`, …) |

2026-01-01 in full: net worth **$9,379.88**, assets $46,695.91, cash $1,255.20, savings
$8,262.26, investments $3,558.86, crypto $33,619.59, debt $37,316.03. And genuine nuance
survives: the crypto lens reports `value 33,619.59` against `explained 21,070.78`, because two
wallet components are unassertable on that date.

**One tool. Eight existing calls. No new authority.**

### 5.3 Information cutoff — **already works, and it is impressive**

`loadForecastIncomeStreams(spaceId, asOf)` reconstructs the income world as it then was:

| Stream | at `asOf = 2026-01-01` | at `asOf = 2026-09-07` |
|---|---|---|
| Abacus payroll | **CURRENT**, eligible, $5,015.68 | **SILENT**, not eligible |
| Vectrus payroll | **does not exist** | CURRENT, eligible, $5,286.64 |

**No post-`asOf` leakage.** That is exactly *"act as if you know nothing after Jan 1"*.

### 5.4 The two semantics, and what separates them

| | Question | Needs |
|---|---|---|
| **STATE AS OF** | *"What did I have on Jan 1?"* | `financial_snapshot(asOf)` — §5.2 |
| **INFORMATION AS OF** | *"What would you have advised me on Jan 1?"* | the above **+ every evidence tool bounded by `asOf`** |

They differ in one parameter, not in architecture: state needs a *date*; information needs a
*ceiling on every read*. `get_spending`/`get_income`/`get_transactions` already take `to`;
`get_financial_snapshot`, `get_investments` and `project_cash` do not.

### 5.5 Retrospective projection — **works today**

Running `assembleForecast` with `asOfISO: 2026-01-01`, streams from that date and spending
from evidence through that date only:

| Horizon | Projected then | Actual |
|---|---|---|
| **2026-09-07** | **$27,966.38** | **$12,382.81** |

Spending basis: $248.20/day over Oct–Dec 2025. Income: the Abacus stream. **This is forecast
reconciliation, and it needs no new machinery** — see §7 for the one thing it *cannot* do.

> **⚠️ FIGURE CORRECTED 2026-09-08 (during slice 3).** This section first read $18,448.92,
> from a probe that passed `totalLiquid: 0` because I misread `getAccountsAsOf`'s nested row
> shape. With the correct opening balance of $9,517.46 the projection is **$27,966.38** —
> exactly $9,517.46 higher, which is the arithmetic confirming both runs. The shipped tool
> takes opening cash from the snapshot authority and returns the corrected figure.

---

## 6. Minimal memory design

**Do not implement.** This is the design.

### 6.1 What memory is for — and what it demonstrably is not for

Compaction (Clip 6) already proved that **conversational continuity does not need memory**:
after eliding a payload 15 turns old, the model understood the reference from preserved prose
and re-fetched. So memory is *not* for understanding.

Memory is for the two things re-fetching cannot reconstruct:

1. **What the user decided or intends** — "$1M by 2030", "wait until February", "$8K summer".
2. **What we said, when, and under what assumptions** — a dated statement, not a fact.

### 6.2 One table

```
model SpaceMemory {
  id           String    @id @default(cuid())
  spaceId      String
  createdByUserId String?

  kind         MemoryKind        // INTENTION | ASSUMPTION | CHECKPOINT
  subject      String            // "net-worth-target", "summer-2027-spending"
  payload      Json              // shape per kind — see below
  statedAs     String            // the user's own words, or 4M's sentence

  statedAt     DateTime @default(now())
  appliesFrom  DateTime?
  appliesTo    DateTime?

  status       MemoryStatus @default(ACTIVE)   // ACTIVE | SUPERSEDED | RETIRED
  supersedesId String?  @unique
  supersedes   SpaceMemory? @relation("chain", fields: [supersedesId], references: [id])
  supersededBy SpaceMemory? @relation("chain")

  @@index([spaceId, kind, status])
  @@index([spaceId, subject, statedAt])
}
```

**Three kinds, deliberately. Not four.** `TESTIMONY` (category D — "employer pays housing",
"that was a transfer") is **deferred**: it is the only kind that would let memory contradict a
provider authority, and nothing in the dogfood needed it. Add it when a transcript demands it.

**Payloads** (small, typed per kind, never free-form financial state):

```
INTENTION  { targetMetric: "netWorth", targetAmount: 1000000, byDate: "2030-12-31" }
           { intent: "purchase", amount: 20000, label: "car", earliest: "2027-03" }
ASSUMPTION { monthlySpending: 5000 }  |  { annualReturnPct: 8, appliesTo: "investments" }
CHECKPOINT { metric: "cash", horizon: "2026-12-31", value: 38243.50,
             basis: { spending: {...}, income: {...} }, toolCallId }
```

### 6.3 The invariant, enforced structurally

> **Memory may hold intentions, assumptions and dated statements. It may never hold current
> financial truth.**

Enforced by *shape*, not by a rule: a `CHECKPOINT` payload **requires** a `horizon` and its
`value` is only meaningful with `statedAt`. There is no field in which "current cash" could be
stored without lying about what it is. An `INTENTION` holds a *target*, never a balance.

Proposed guard, mirroring `audit-goals-tombstone`: a source scan asserting no memory read path
feeds a figure into a position where a provider authority is expected.

### 6.4 Temporal identity and supersession

The Sep $15K → Oct $8K → Nov "cancelled" chain:

```
m1  INTENTION summer-2027-spending  {15000}  statedAt Sep 8   status SUPERSEDED  supersededBy m2
m2  INTENTION summer-2027-spending  { 8000}  statedAt Oct 3   status SUPERSEDED  supersededBy m3
m3  INTENTION summer-2027-spending  {  ...}  statedAt Nov 14  status RETIRED     supersedes m2
```

Active state is `status = ACTIVE` for a subject; history is the chain. **No versioning system,
no event log** — one nullable self-relation and one enum.

### 6.5 Retrieval — model-driven, consistent with A2

**Do not inject memory into every prompt.** Two tools, symmetric with everything else:

```
recall({ kind?, subject?, includeSuperseded? })   → active memories, newest first
remember({ kind, subject, payload, statedAs })    → writes one record, supersedes prior ACTIVE
```

**Why this is enough, on the evidence:** A2/A3 already demonstrated that a model with no
pre-loaded evidence chooses the right tools from natural questions — the whole point of
`--arm A3`. *"How are we doing?"* is not a harder retrieval problem than *"what was my biggest
purchase in August"*, and that one needed no router.

**One concession worth testing:** a **≤200-token active-intentions line in the thin core** —
subjects and targets only, no values — so the model knows a goal exists without being told to
look. That is the same shape as the coverage envelope already in A2's core. Measure it; drop
it if the model finds goals without it.

**⚠️ `remember` is the first write tool in the harness.** Every existing tool is read-only and
a test asserts it. That test must gain a deliberate, narrow exception — memory only, never
financial data — rather than being weakened.

---

## 7. Forecast reconciliation

**What §5.5 gives free:** *"what we would say today, standing at Jan 1"* — recomputable at any
time from immutable history.

**What it cannot give:** *what we actually said*. The retrospective recomputation uses today's
code and today's evidence-through-that-date. If Chris had said *"assume I spend $6K"*, the
recomputation will not know. **A checkpoint records a statement; the retrospective records a
capability.** Both are useful and they are not the same thing.

**Minimum checkpoint** — written when 4M states a projection:

```
CHECKPOINT { metric: "cash", horizon: "2026-12-31", value: 38243.50,
             basis: { spendingSource: "OBSERVED", dailyRate: 142.90,
                      monthsAveraged: ["2026-07","2026-08"],
                      incomeEvents: 8, userAssumptions: [] } }
statedAt: 2026-09-08
```

Every field already exists in `project_cash`'s `basis` block. **The write is a copy, not a
computation.**

Reconciliation then reads: checkpoint (what we said) + `financial_snapshot(asOf: horizon)`
(what happened) → *"we had you tracking toward $38.2K; you finished at $40.7K, about $2.5K
ahead"*. Mid-flight it compares against `financial_snapshot(today)` and can attribute the
difference to the basis that has since changed.

**No stale truth is stored**, because a checkpoint is not readable as a current balance — it
carries a horizon and a `statedAt`, and both are required.

---

## 8. Beta priority

| | Classification | Reasoning |
|---|---|---|
| **Historical as-of coherence** | **BLOCKS BETA** | It produced a **materially wrong figure to the user's face** and built advice on it. Self-corrected only under challenge. Substrate is complete; the fix is one tool + one rename + `asOf` on three tools. Cheapest high-severity item on the list. |
| **Scenario arithmetic** | **SHOULD HAVE** | Not blocking: the model's arithmetic was correct in this session and the pattern (deterministic spine + stated assumptions) is sound. But it is unverifiable and untestable, and goal-seek fabricates. Ship the ledger; goal-seek can follow. |
| **Memory — INTENTION + CHECKPOINT** | **SHOULD HAVE** | Beta continuity across sessions is a product promise. One table, two tools. |
| **Memory — ASSUMPTION** | **SHOULD HAVE** (same table, free) | Needed for §7's basis and for "actually make it $8K". |
| **Memory — TESTIMONY** | **SAFE TO DEFER** | The only kind that can contradict a provider. No dogfood evidence demands it. |
| **A goal-progress surface / notifications** | **SAFE TO DEFER** | Conversation is the surface for beta. |

---

## 9. Smallest recommended sequence

Each slice is independently shippable and independently revertible.

| # | Slice | Size | Why first |
|---|---|---|---|
| **1** | **Fix the naming collision.** `get_net_worth_history.cash` → `liquid`; `explain_net_worth_change` states its lens population. | ~20 lines + 2 tests | The beta blocker's root cause. Hours. |
| **2** | **`financial_snapshot(asOf)`.** One tool composing the 8 exploration lenses; `asOf` defaults to today. Existing `get_financial_snapshot` gains the same parameter. | ~80 lines | 303 ms, ~360 tokens, all authorities existing. Closes the blocker. |
| **3** | **`asOf` ceiling on evidence tools.** `get_investments`, `project_cash` (and the `from` of income/spending defaults) accept and honour `asOf`. | ~40 lines | Turns "state as of" into "information as of". Enables §7. |
| **4** | **`scenario_projection`.** The ledger over `projectCash` checkpoints. | ~200 lines | Retires three turns of prose arithmetic. |
| **5** | **`scenario_goal_seek`.** Binary search over slice 4. | ~60 lines | Retires the fabricated figures in turn 13. |
| **6** | **`SpaceMemory` + `recall`/`remember`.** One migration, two tools, the write-tool test exception. | ~150 lines + migration | Beta continuity. |
| **7** | **Checkpoint-on-projection + reconciliation.** 4M writes a CHECKPOINT when it states a projection. | ~40 lines | Falls out of 4 + 6. |

Slices 1–3 are the beta blocker and are **~140 lines total**.

> **✅ SLICES 1–3 SHIPPED 2026-09-08.** See the harness doc §13d. The dogfood question that
> exposed the blocker now answers **$9,517 liquid / $37,316 debt correctly on the first
> attempt**, and a follow-up challenge produces the checking/savings distinction rather than a
> contradiction.
>
> **✅ SLICE 4 SHIPPED 2026-09-08.** `scenario_projection` over `scenario-ledger.ts`, a pure
> function with no imports. See the harness doc §13e. Turns 10–12 now resolve to **one tool
> call each with zero prose arithmetic**, and turn 13 no longer invents a figure. The
> invariant holds by construction: `buildCashSpine` was factored out of `project_cash` and
> there is exactly **one** `assembleForecast` call site, so the last checkpoint and a
> standalone run to the same horizon are the same number (**$384,719.74**, measured).
>
> **§4.2's argument shape was incomplete, and only running it showed that.** A contribution
> cannot always be an amount: asked to *"invest half my liquidity each year"*, gpt-4.1 wrote
> `amount: -0.5` and the ledger moved fifty cents, consistently and wrongly. Contributions
> gained `fractionOfLiquid`; a dollar amount under $1 is refused. **Q1 is answered as
> proposed** — the default return is 0% and the payload says so in words.
>
> Slices 5–7 remain open.

---

## 10. Explicitly NOT to build

- **No planner, intent router, conversational state machine, prose guard, or summariser.** The
  dogfood shows none is needed, and compaction proved prose carries continuity.
- **No scenario DSL.** A typed tool argument the model fills in is not a language.
- **No Monte Carlo, no distributions, no expected returns.** The user states the return; code
  does the arithmetic.
- **No second historical authority.** Everything Area 2 needs already exists.
- **No revival of `SpaceGoal`.** It is tombstoned by a REQUIRED audit. Memory is a new table.
- **No memory injected into every prompt** beyond (possibly) a ≤200-token subject line.
- **No TESTIMONY kind for beta.**
- **No `AiAdvice` write path** — wrong shape, and KD-14 is a separate question.
- **No prompt rules** telling the model not to do arithmetic. Give it the tool instead.

---

## 11. Open questions — genuine product judgement

1. **Default return assumption.** I propose **0% (flat)**, so an unstated return never invents
   market optimism. The alternative is refusing to project investments at all without a stated
   rate. *Flat is my recommendation; it is a product call.*
2. **Should 4M volunteer a checkpoint?** Writing one on every projection is cheap and makes
   reconciliation automatic — but it means 4M records things unasked. Alternative: only on an
   explicit goal. *I lean automatic, silent, and visible on request.*
3. **Does a superseded intention ever resurface?** "Trip cancelled" then three months later
   "actually, the trip is back on" — new record, or reactivate? *New record is simpler; the
   chain preserves the history either way.*
4. **How long does an ASSUMPTION live?** A scenario assumption stated mid-conversation is
   per-turn today. Does *"assume I spend $6K"* survive into next week's session? *I lean no by
   default — an ASSUMPTION should need to be attached to an INTENTION to persist.*
5. **Goal-seek honesty ceiling.** Should `scenario_goal_seek` refuse to report a required
   return above some threshold, or report "142%/yr" and let the model call it unrealistic?
   *I lean report-and-let-the-model-judge, consistent with the whole boundary.*
6. **Whose memory is it?** `SpaceMemory` is Space-scoped, so a shared Space's members see each
   other's intentions. Correct for a household, possibly wrong for a goal. *Needs a decision
   before the migration, not after.*

---

## 12. Proposed acceptance tests

**Slice 1–2 — as-of coherence**
1. `financial_snapshot(asOf: 2026-01-01)` returns cash **$1,255.20** AND savings **$8,262.26**
   AND liquid **$9,517.46** as three distinctly named fields.
2. No field named `cash` ever carries a checking+savings total (source scan, both tools).
3. Every returned lens carries `assertable` and, when false, a reason.
4. The crypto lens on 2026-01-01 reports `explained < value` rather than a bare figure.
5. Live: *"how was I doing on Jan 1 2026?"* → cash **$9,517** or **$1,255 (checking only)**,
   never one presented as the other.

**Slice 3 — information cutoff**
6. `get_investments(asOf)` / `project_cash(asOf)` return nothing dated after `asOf`.
7. `loadForecastIncomeStreams(2026-01-01)` yields Abacus CURRENT and **no Vectrus** (pins the
   behaviour §5.3 measured).
8. A retrospective projection from 2026-01-01 to 2026-09-07 returns **$27,966.38** from an
   opening of $9,517.46, and changing the cutoff changes the answer.
9. Live: *"what would you have advised me on Jan 1?"* cites no post-Jan-1 evidence.

**Slice 4–5 — scenario arithmetic**
10. Zero contributions + zero returns ⇒ checkpoints **identical** to `project_cash` (the
    scenario ledger is the cash spine plus movements, never a second projection).
11. A contribution reduces cash and increases investments by the same amount at the same
    checkpoint — **no double count**, asserted on the composed net worth.
12. Per-year returns compound only within their stated year.
13. The last checkpoint equals a standalone run to the same horizon (the Clip 3 invariant,
    extended).
14. Every returned figure carries MEASURED / USER_ASSUMED provenance; returns and
    contributions are **never** MEASURED.
15. Goal-seek: solving for a return that reaches a target, then running the ledger at that
    return, reaches the target (round-trip).
16. An unreachable target returns `feasible: false` with a reason, not a huge number.
17. Live: turns 11–13 reproduce with **zero prose arithmetic** — every figure traceable.

**Slice 6–7 — memory**
18. A second `remember` on the same subject supersedes the first; `recall` returns one ACTIVE.
19. Superseded records remain retrievable with `includeSuperseded`.
20. No memory payload can hold a current balance — schema/shape test.
21. `recall` is read-only; `remember` is the **only** write tool, and the read-only assertion
    on every other tool still holds.
22. A CHECKPOINT requires a `horizon` and a `statedAt`; one without both is rejected.
23. Reconciliation: a CHECKPOINT of $38,243.50 for 2026-12-31 plus a later snapshot produces a
    signed variance and names the basis that changed.
24. Live, new session: *"how are we doing?"* → recalls the $1M intention, fetches **current**
    truth, and states progress **without** quoting the old projection as a current balance.

---

## Appendix — probes run

Read-only, against Chris' Space (`cmrrm846r000j7znwsl67gt1g`), deleted after use:
`resolveExplorationNode` across 9 lenses at 2026-01-01 and 2026-09-07; raw `SpaceSnapshot`
field comparison; `getAccountsAsOf` with method/tier; `loadForecastIncomeStreams` at two
cutoffs; `assembleForecast` retrospectively from 2026-01-01 at three horizons; grep sweeps
across `lib/forecast/**` for growth/contribution arithmetic; `audit-goals-tombstone` scope;
schema inspection for existing persistence.
