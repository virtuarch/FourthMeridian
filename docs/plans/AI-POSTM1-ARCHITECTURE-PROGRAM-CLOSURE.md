# POST-M1 ARCHITECTURE & CORRECTNESS PROGRAM — CLOSURE

**Branch:** `postm1/integration` · **Base:** `v2.6` · **Slices:** 9 · **Commits:** 45
**Preceded by:** `AI-CONVERSATION-STATE-MEMORY-ORCHESTRATION-INVESTIGATION.md` (the evidence)
**Design record:** `AI-FINANCIAL-MEMORY-V2-DESIGN.md` (Memory V2, amended with the twelve rulings)

Seven specialist agents worked in isolated worktrees against throwaway database clones; one
of them (Agent 7) implemented nothing and reviewed everything, twice. This document records
what the program decided, what it measured, and what it deliberately left open.

---

## 1. THE QUESTION THIS PROGRAM ASKED OF EVERY CHANGE

> Did we add a reusable financial primitive, or did we patch a question?

Nothing here is a handler for a phrase. Every fix is a rule in code that a future question
inherits for free. Four things were proposed during the program and REFUSED on that test:
a six-month handler, a Schwab exception, an annual-spending tool, and schema de-duplication
(measured: 0 tokens saved, and trimming tool prose cost the semantic floor 5/6 → 0/6).

---

## 2. WHAT SHIPPED, BY SLICE

### D — ACCOUNTING: a payment is not a cost
`lib/transactions/debt-service.ts` decomposes debt cash flow:
`netPaydown = max(0, payments − newChargesOnLiabilities − debtProceeds)`.
The after-paydown net subtracts only the cash that REDUCED debt, so a card payment settling
purchases already counted as spending no longer manufactures a deficit. New borrowing is
never credited, so overspending financed on a card still reads as overspending.
`meanPerReliableMonth` makes every monthly money figure a complete-month mean; no
day-normalised money figure survives in the assessment.

### A — DAILY BRIEF & ASSESSMENT: a verdict carries its reason
- `ClassificationReason<T>`: scope, the rung that fired, its operands, its thresholds, and
  the population it was computed over. The debt grade is named for what it measures (the
  RATE on the owed balance); the BURDEN against income, expenses and cash is stated
  separately and left UNGRADED on purpose.
- Freshness belongs to the CLAIM it feeds (`claim-evidence.ts`, 7 claims → populations), not
  to the Space. A stale brokerage may caveat an investment claim and must not caveat a debt
  claim.
- A movement joins a balance change only through the account it posted on, and only inside
  the window that was cited.
- `pctOfOpening`: the window authority decides when a percentage of an opening value means
  anything. This closed an 11,937.8% debt "change" over a $9.75 base.
- A 429 no longer costs a Brief (`lib/ai/rate-limit-retry.ts`).

### C — SCENARIO SEMANTIC INTEGRITY: the code says what ran
- `clausesInForce` reports, from the LEDGER'S OWN MOVEMENTS, which clauses ran and which did
  not — never from the caller's arguments. A floor that never bound says so.
- A rule is named from its FIELDS; a caller's label never reaches the ledger or the envelope.
- **An argument a scenario tool's own schema does not declare is REFUSED BY NAME** and echoed
  on every path, including an infeasible goal seek. Replay of 310 recorded scenario calls:
  0 would be refused.

### E — SCENARIO PAYLOAD: the difference is a field
`positionChange` puts the difference between two positions in the payload with its operands,
so the model never subtracts two tool figures in prose. `project_cash` takes a `from` and
states what comes in, goes out and remains over that interval. Cost is pinned: < 1 KB at any
row count.

### B — DURABLE FINANCIAL MEMORY V2: a remembered rule keeps its meaning
Six slices, **no migration**. A memory is a typed semantic class, not free text:

| Class | What it holds |
|---|---|
| RULE | the scenario contract's own clause vocabulary — never frozen dollars |
| BASELINE | a planning figure, stamped `basis: "REMEMBERED"`, which NO measure reads |
| GOAL / PLANNED_EXPENSE | the user's own target or intended outlay |
| PROJECTION | a projection WE made, recorded only when it rests on evidence |

Three invariants decide everything else:
1. **Money must be USER-STATED, exactly.** A figure is licensed only if the user typed it, to
   half a cent. Our own figures — including ones the user loosely echoes ("so about 270k?") —
   are refused. Months, fractions and percentages are gated the same way.
2. **Memory is never financial truth.** No measure, baseline resolver, forecast or liquidity
   reader can see a remembered figure. It reaches arithmetic only when the model passes it
   explicitly, and the answer says it is remembered.
3. **Memory never acts by itself.** It activates no scenario and re-seeds no envelope.

**Checkpoint narrowing:** a projection resting on a figure the user stated is a hypothetical,
and hypotheticals are not recorded at all. Measured in the final dogfood: only the 5
evidence-based projections wrote a row.

### F — HARNESS: a check that cannot fail is not a check
Ten live assertions were pinned to figures and dates that had drifted. Every one now derives
its as-of, horizon and expected figures from the run, and every mutation planted in the code
was caught. Two assertions had silently stopped checking anything. One check was WRITING a
projection checkpoint into the real Space; it now uses a throwaway Space (see §6).

---

## 3. WHAT THE INDEPENDENT REVIEW FOUND (and what happened to it)

Agent 7 reviewed twice, implemented nothing, and rejected no slice. Five blockers:

| # | Finding | Resolution |
|---|---|---|
| B1 | The retired subtraction survived under an alias: an unmeasured paydown defaulted to the payments total and was STATED as fact | An unmeasured paydown is `null`; the ladder grades on the economic net and DEBT_DRIVEN needs a measurement |
| B2 | A source LABEL was used as an identity, so a current "Chase" overwrote a stale "Chase" and the caveat lost its source | One entry per source; reach computed from the source itself |
| B3 | The movement guard dropped the most legitimate debt narrative (a type-attested payment has no nameable counterparty) | `DEBT_PAYMENT` is the authority's verdict: it touches both sides. A cited movement must also be dated inside the cited window |
| B4 | This user's real money was pinned into pure tests | Synthetic values of the same shape, twice (it reappeared in the Memory V2 tests) |
| M1 | Memory's licence used the Brief's ROUNDING tolerance, so "so about 270k?" licensed our 271,433.12 | Exact to half a cent, plus the digit-fragment and bare-integer holes |

Accepted with the finding recorded, not fixed: a supplied after-paydown net without its
decomposition still grades DEBT_DRIVEN while reporting `netPaydown: null` (unreachable in
production; the assembler always emits both).

---

## 4. MEASUREMENTS

Every claim below was measured on a throwaway clone, on the production path, with the full
tool surface. Withholding a tool is not isolation: the turn loop has two durable write paths.

- **Unit suite** 570/570 files · **typecheck** clean · **lint** 0 errors on 120 changed files
- **Live checks** 11/11 pass, all now independent of the run date
- **Dogfood** 11 cases × 6 repetitions = 192 turns, 0 errors, 89 memory writes, 0 refusals,
  0 scenario arguments refused, envelope max 1,413 chars of a 3,000 ceiling
- **Brief goldens** 19 scenarios × 6 samples: 13 scenarios clean, 4 at 5/6, the 2 quiet days at 0/6

### The dogfood matrix (n = 6 each, production path, full tool surface)

| Case | What it proves | Result |
|---|---|---|
| A1 | a cash rule stores as a rule, with no dollars | 6/6 |
| A1 | a fresh chat recalls it with no tool call | 6/6 |
| A2 | a stated planning figure stores as REMEMBERED | 6/6 |
| A2 | …is described as remembered, never as measured | 6/6 |
| A2 | …and never displaces the measured figure | 6/6 |
| A3 | a three-clause strategy reaches the engine as clauses, ordered | 6/6 |
| A4 | "make it nine months" amends: one ACTIVE rule, ordering kept | 6/6 |
| A4 | a fresh chat runs the AMENDED rule | 6/6 |
| B5 | same-chat scenario keeps all three clauses | 6/6 |
| B6 | a stated spending figure is applied by the engine | 5/6 |
| B6 | **a changed assumption is RECOMPUTED** | **2/6** |
| B6 | **a new horizon is RECOMPUTED** | **2/6** |
| B6b | a strategy assembled over separate turns reaches the engine | 4/6 |
| E12 | calendar-year spending is computed, not annualised in prose | 5/6 |
| E13 | **a cut "starting January" is modelled from January** | **0/6** |
| F14 | with no memory, no strategy is invented | 6/6 |
| C7 | a small high-rate debt is not framed as critical | 6/6 |

The three bold rows are the open gaps in §5. Every no-tool answer in B6 disclosed that nothing
had been recomputed.

---

## 5. WHAT IS STILL OPEN

1. **A changed assumption is sometimes answered without recomputing.** "Make it nine months"
   recomputed 3/6; a new horizon after a long chat recomputed 1/6. The no-tool answers
   DISCLOSE that nothing was run, which is honest, but the figures in them are composed in
   prose. This is a system-instruction decision, not a tool gap.
2. **A change that starts on a future date has no representation.** "Cut spending 20% starting
   January" is applied from TODAY, and the 20% is computed by the model. This is I1's shape.
3. **A measured figure is sometimes passed back as a stated assumption**, relabelling OBSERVED
   as USER_STATED — which now also suppresses the checkpoint.
4. **Quiet-day Brief goldens fail 0/12**, unchanged and deliberately so: standing
   classifications are in the package every day. The cure needs a product decision (may a
   standing WARNING go unsaid on day two?).
5. Recorded in the design doc, not built: the concurrent first-record race (needs a migration),
   an amend inheriting a legacy goal's ungated amount, and "remember my raise in March".

---

## 6. A SAFETY FAILURE, RECORDED

Five of seven agent worktrees had a `.env.local` copied from the main tree, still pointing at
the LIVE database. An exported `DATABASE_URL` beats `--env-file`, so every result the agents
reported was genuinely from a clone — but a command run WITHOUT that export went to live. One
did: `applied-facts.check.ts` wrote a duplicate projection checkpoint into the real Space
before Agent 6 changed it to use a throwaway Space.

Live damage, audited read-only: two identical `SpaceMemory` rows (the table was empty before
this program), no test Spaces, no test users, no unexpected audit rows. Nothing was deleted;
that is the user's decision.

**The rule this should have been:** an agent worktree's `.env.local` is rewritten to its clone
at setup, and the guard belongs in the script, not in the instruction. The clone-guard pattern
(`current_database()` checked at runtime) is the thing that worked.
