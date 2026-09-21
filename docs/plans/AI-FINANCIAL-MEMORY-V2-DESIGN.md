# Durable financial memory V2 — design

**Date:** 2026-09-20 · amended 2026-09-21 · **IMPLEMENTED on `postm1/b-memory-v2` (S1–S6), after an independent adversarial review
(APPROVE WITH REQUIRED CHANGES) and twelve lead rulings. §A below is authoritative: where it contradicts the body, §A wins.**
Statements in the body that a ruling found false are ~~struck~~ and corrected in place.
Authority: `189b6df` (HEAD of `v2.6`). Evidence: `docs/plans/AI-CONVERSATION-STATE-MEMORY-ORCHESTRATION-INVESTIGATION.md`
§5, §6, §15, §16 (G1–G4, G13, G15) and the raw traces under `tmp/inv/out/*.jsonl`, re-read for this design (§0.2).
Clone database used, read-only: `fintracker_postm1_b`.

Architecture, unchanged: **MODEL OWNS MEANING · CONTRACTS OWN SEMANTICS · CODE OWNS MONEY · DATA OWNS TRUTH.**
Three sentences this design is built to keep true: **memory is not financial truth; memory is not an active scenario; a
scenario is not memory.**

---

## A. AMENDMENTS — lead rulings R1–R12 and what was implemented (2026-09-21)

> **This section is authoritative. Where it contradicts the text below, it wins.** The design was reviewed (APPROVE WITH
> REQUIRED CHANGES), the lead ruled on every blocker, and the implementation landed on `postm1/b-memory-v2` as S1–S6. The body
> below is kept as the reasoning of record; statements it makes that the rulings found false are struck and corrected in place,
> and listed here.

### A.1 What the rulings changed

| # | Ruling | What the design said | What is implemented |
|---|---|---|---|
| R1 | **The user's words are passed in, never read off the transcript.** | §7.2: build the gate's evidence "from `messages`" — user = `role: 'user'` messages. **False premise:** the orientation is a `role: 'user'` message (`engine.ts` `openTranscript`) and the active scenario a trailing `role: 'system'` one, so that set contains every balance we hold. | `executeTurn` takes `userTexts` explicitly (`runStatelessTurn` passes `history`'s user messages; an in-process caller accumulates them on its tool context). `turnEvidence(userTexts, messages)` is pure: USER-STATED = those texts + the current one; OURS = every other message content (orientation, envelope, assistant prose, this turn's tool results incl. string leaves), minus a memory write's own echo. `ToolContext.turn?` is optional and harness-safe; nothing the model sees changes. Tests: an `openTranscript`-shaped array (the orientation's balances license nothing); the recorded "Remember this." turn, where `targetAmount` was the envelope's `result.netWorth` — refused. |
| R2 | **"No money field in a rule" was false.** | §0.2, §2.1: "There is **no money field in it**, so $26,078.88 cannot be frozen: the bad state is unrepresentable." `liquidFloor` and `amount` are Money fields. | A Money field with a relational sibling (`liquidFloor` ↔ `liquidFloorMonthsOfExpenses`) needs **positive, strict** user evidence (a currency mark, a K/M suffix, grouping, decimals, or a bare integer ≥ 1,000 in the user's own turns); otherwise it is refused and the refusal names the months field. **Cut from V2 rules:** `amount`+`cadence`, `fractionOfLiquid`+`cadence`, `{liability: id}` targets (ids churn on reconnect), `onDate`, `label`. A rule is a cash floor or a surplus share, with the two target words. |
| R3 | **A remembered planning figure is `REMEMBERED` — never `STATED`.** | §4: `basis: "STATED"`, passed as `statedMonthlySpending`. That would have been a second durable authority beside M1's STATED > DECLARED > MEASURED. | Stamped `basis: "REMEMBERED", scope: "PLANNING"` by code. Not a rung of `resolveExpenseBaseline`; no tool reads it; `lib/liquidity/**`, `lib/ai/measures/**` and the `get_baselines` text are untouched. The line says, per item, *"On ‹date› the user asked to plan with ‹X›/month of spending — not their measured spending, and not in effect unless they say so."* plus one section-level `planningNote` (A.4). |
| R4 | **One vocabulary authority.** | §2.3: `memory-model.ts` "declares the rule field table itself" and keeps its own exclusive-groups table. | The model **imports** `CONTRIBUTION_KEYS`, `unknownContributionKeys`, `contributionBasis`, `contributionName` from `scenario-rules.ts`, which gains `ALLOCATION_TARGET_WORDS`. Which fields exclude each other on an amend is `contributionBasis`'s answer; the only relation kept locally is the floor's relational sibling pair. A stored rule is **nested** — `{v: 2, class: "RULE", rule: {…}}` — so it holds EXACTLY contract keys (`unknownContributionKeys` refuses a whole rule on any foreign key). No label is stored or rendered for a rule; words come from `contributionName`. **One deviation, forced by a guard:** `scenario-ledger.ts` is import-free by test (`baseline.test.ts`), so it cannot read the constant. The constant is instead tied to the ledger's `AllocationTarget` type by the compiler (`satisfies` + an exhaustiveness check), `prepareScenario`'s `toTarget` uses it, and a behavioural parity test asserts the ledger accepts each word and refuses any other. |
| R5 | **Validator split.** | One `validateStated`, incl. "`byDate` must be after `asOf`" — which would have made a goal unreadable the day after its date. | `validateShape` / `validateFields` are **timeless** (read, write, merge). `admitWrite` is about **this call**: the provenance gate and the future-date checks, applied only to supplied fields and exempting any value equal to the current version's. A goal whose `byDate` passed is `LAPSED`, not unreadable; an amend never re-gates what it inherits. |
| R6 | **Priming is measured; it gates the reader.** | §16.5 named the risk and left it to case 12. | `composeMemoryLine(rows, today, {rules: 'clause' \| 'sentence'})`; production uses `MEMORY_LINE_RULES = 'clause'`, which **passed** (A.4). |
| R7 | **Cuts.** | — | Cut: the `PREFERENCE` class (five classes remain, four stateable); the word-number grammar (digits only); words-consistency for legacy rows; "a Label is not a contract field name"; `unreadable: n` in the memory line (kept in `recall` and the panel); `saidAs` for unreadable rows in `recall`; `history[]` in the list response. |
| R8 | **Legacy rows — deterministic.** | §9: words-consistency over `statedAs`. | Readable as-is: `{targetMetric ∈ {netWorth, liquid, investments}, targetAmount > 0, byDate a real date}` → GOAL (LAPSED if past); `{metric, horizon, value}` → PROJECTION. **Planned outlays — the rule implemented:** a no-`v` `{intent, amount, label[, earliest]}` row is a PLANNED_EXPENSE **iff** `intent ∈ {buy, purchase, spend}`, `amount > 0` and `label` is 1–40 chars. Those three are every `intent` value the V1 code, tests and live check ever documented (`starter-topics.test.ts`, `lib/ai/brief/package.test.ts`, `baseline.test.ts`, `memory-store.check.ts`); `intent` was otherwise free text and is exactly where the recorded rows smuggled a rule (`keep-buffer`, `allocation-rule`, whole sentences — 0 of the 106 recorded calls carrying an `intent` used a documented word). Everything else, **including a standalone V1 ASSUMPTION**, is unreadable. `amount: 6` is never read as months. Nothing is rewritten or destroyed by deploy; an unreadable ACTIVE row is superseded only by the user's own later V2 statement on its subject. |
| R9 | **Readers before writers.** | §14: write path (S3) before readers (S4). | S1 model → S2 checkpoints → S3 readers → S4 writers → S5 API → S6 panel. No commit leaves a V1 reader meeting a V2 row (an S2 PROJECTION keeps every key the V1 readers read). |
| R10 | **Bytes are measured.** | "≤ 900 B typical, ≤ 2,000 B worst case". | Measured after `JSON.stringify(…, null, 1)`: **typical 1,204 B** (one rule + one planning figure + one goal), **capped worst case 2,948 B** (max-length subjects and labels, every cap hit), **empty 189 B**. The fixed "nothing listed is in effect" sentence is 187 B. Pinned by test at the measured values plus margin. |
| R11 | **The replay.** | §13 "+ legacy": classify `tmp/inv/out/written-memories.json` in a test. | A **sanitised, committed** fixture (`lib/ai/conversation/fixtures/remember-replay.json`): all 201 recorded calls — arguments, the conversation's user turns, tool-result digests, the figures in prior assistant prose — with every non-round figure remapped. No test reads `tmp/`. Result in A.3. |
| R12 | **Acceptance, on the clone.** | §13 M cases. | A.4. |

### A.2 One change beyond the rulings, forced by R11's replay

**Every `Money` value needs positive user evidence, in digits — not only a rule's floor.** The design's gate refused a value only
when it matched a figure *we* produced ("a value found nowhere is accepted"). Replayed over the recording, that still admitted
`{amount: 6, label: "months-of-expenses"}` for *"Remember that I want six months cash."* and `{amount: 9}` for *"use nine"*: a
month count the user spoke in words is found nowhere, so nothing refused it (5 rows), and R7 had cut the label rule that was the
design's defence. What *we* produced now only sharpens the refusal ("a figure we produced" vs "nobody stated it"). User-side
tokens are the licence's own figures plus bare small integers **not followed by a count unit** ("6 months", "3 years", "50%").
**Cost, accepted and to be measured in use:** *"remember my goal is a million"* is asked for the number once ("$1M", "1,000,000"
and "$1 million" all license it). *Primitive or patch?* Primitive: "memory admits money only in figures the user stated" — one
sentence, every money field, every class.

### A.3 The replay — 201 recorded `remember` calls through `validateFields` + `admitWrite`

Most generous reading: each payload (and a nested `rule`) is offered to **every** class with foreign keys dropped, so the test is
adversarial to the validators rather than to the recording.

| | V1 (recorded) | V2 (replayed) |
|---|---|---|
| stored / admitted | 117 of 201 | **20 of 201** |
| faithful to what the user said | 0 of 90 (investigation) | 20 of 20 by the four assertions below |
| what was admitted | — | 3 RULE `{liquidFloorMonthsOfExpenses: 6[, fractionOfExcess, target]}` · 13 BASELINE `{monthlySpending: 5000}` where the user typed "$5k" · 4 GOAL `{netWorth, 1000000}` where the user typed "$1M" |
| a dollar figure the user did not type | 56 | **0** |
| a month count in a money field | 27 (incl. zeros) | **0** |
| a zero placeholder or a null | 11 + 43 `byDate: null` | **0** |

Residual, named in §16.4 and unchanged: the 4 admitted goals carry a **derived date** (`byDate` = a crossing date). Dates are not
gated — "by 2030" against "in five years" cannot be checked without parsing language.

### A.4 Acceptance — production path, full tool surface, clone `fintracker_postm1_b`, n = 6 per case

159 model turns in all (108 planned; +42 re-measuring two wordings the first run failed; +12 re-running the DECLARED case, whose
first wording — "in June", asked on 2026-09-20 — every run read as June 2026; −3 lost to two provider timeouts). Counts, not rates.

| # | Case | Result |
|---|---|---|
| 1 | "Keep six months of expenses in cash." / "Remember that." → fresh "What cash rule did I want?" | Semantic six-month rule **6 of 6**; dollars in memory **0 of 6**; `remember` refusals 0. **First wording:** 4 of 6 also stored `fractionOfExcess: 1` and a debt-first `target` the user never stated (copied from a three-clause example). **After the wording change:** floor-only **5 of 5** completed runs (one run lost to provider timeouts); fresh chat says the rest "is still open" 5 of 5. |
| 2 | "Use $5k monthly spending for planning." / "Remember that." → fresh "What spending assumption did I ask you to use?" | Stored **6 of 6** (V1: refused 10 of 10). Fresh chat: "a remembered planning figure from 2026-09-20 … not your measured spending" **6 of 6**. |
| 3 | Three-clause strategy / "Remember that." → fresh "What strategy did I want?" then "Run it through next June." | One RULE row with all three fields **6 of 6**; the repeat "Remember that." wrote nothing 6 of 6. Recall first with no tool call and no dollar figure **6 of 6**; computation only when asked **6 of 6**; scenario arguments carried `liquidFloorMonthsOfExpenses: 6`, `fractionOfExcess: 1` and the ordered target **6 of 6**; Agent 3's roster: `cashFloor.ran` true with `statedAs.monthsOfExpenses: 6` 6 of 6, `debtPaydown.ran` true in order 6 of 6, `surplusShare.ran` false 6 of 6. (Not memory's: in 3 of 6 the model passed a *measured* figure as `assumedMonthlySpending`, which the scenario echoes as STATED.) |
| 4 | Seeded strategy → fresh "Actually make the cash buffer nine months." | `op: "amend"` **6 of 6**; floor 9 **and** the original ordering kept 6 of 6; exactly one ACTIVE rule 6 of 6; the six-month version kept as SUPERSEDED 6 of 6. (V1: ordering lost.) |
| 5a | R6 — remembered RULE shown as its **literal clause**; three neutral questions × 6 | **Silent applications: 0 of 18.** "What will my cash be next June?": plain `project_cash`, no clause, 6 of 6. "How am I doing?": no tool, 6 of 6. "How much can I invest this month?": the rule was *consulted* — `get_baselines([6])`, the tool's figure, under an explicit "your remembered rule" — 6 of 6; no scenario was run with the clause. **PASS ⇒ `'clause'` ships.** |
| 5b | R6/R3 — remembered BASELINE; the same three questions × 6 | **First wording: FAIL.** "next June" applied $5k 4 of 6 as "what you asked us to plan with" — never said to be remembered, no measured figure beside it, one with no provenance at all; measured-without-mention 2 of 6. **After `planningNote`:** measured basis **18 of 18**, applications **0 of 18**, presented as observed 0, presented as stated-in-this-conversation 0; the figure offered as available 1 of 6 on "next June". |
| 5c | R3 — the same with a **DECLARED** product figure (`emergency_fund_progress.config.monthlyExpenses = 4800`, seeded in the clone only, removed after) | "What will my cash be next June?": `project_cash` on OBSERVED spending **6 of 6**, the remembered $5k applied **0 of 6**, offered as available 2 of 6. "How much can I invest this month?": `get_baselines` resolved **DECLARED 4,800** 6 of 6 — M1's ladder is untouched and the remembered figure is not a rung of it; applied 0 of 6. Presented as observed 0 of 12; presented as stated-in-this-conversation 0 of 12. |
| 6 | What the model retries with after a refusal | `remember` calls **49**, refusals **0**, retries **0**, coerced retries **0** (V1: 84 refused of 201; 32 of 45 retried rows coerced). The teaching refusals are therefore exercised by unit tests and the replay, not by this sample. |

### A.5 The final durable model — exact JSON

```json
{ "kind": "INTENTION",  "payload": { "v": 2, "class": "GOAL", "targetMetric": "netWorth", "targetAmount": 1000000, "byDate": "2030-12-31" } }
{ "kind": "INTENTION",  "payload": { "v": 2, "class": "PLANNED_EXPENSE", "label": "car", "amount": 20000, "earliest": "2027-03-01" } }
{ "kind": "INTENTION",  "payload": { "v": 2, "class": "RULE", "rule": { "liquidFloorMonthsOfExpenses": 6, "fractionOfExcess": 1, "target": ["highest_apr", "investments"] } } }
{ "kind": "ASSUMPTION", "payload": { "v": 2, "class": "BASELINE", "monthlySpending": 5000, "basis": "REMEMBERED", "scope": "PLANNING" } }
{ "kind": "CHECKPOINT", "payload": { "v": 2, "class": "PROJECTION", "metric": "liquid", "horizon": "2026-12-31", "value": 51598.84,
    "basis": { "spendingSource": "OBSERVED", "dailyRate": 142.9, "monthsAveraged": ["2026-07", "2026-08"], "incomeEvents": 7, "userAssumptions": [], "openingCash": 13330.97 } } }
{ "status": "RETIRED",  "payload": { "v": 2, "class": "RULE", "retired": true } }
```

`byDate`, `earliest` optional; a GOAL's `targetAmount` may be `0` only with `targetMetric: "debt"`; a RULE is `liquidFloorMonthsOfExpenses`
**or** `liquidFloor` (+ optional `fractionOfExcess`, `target`), **or** `surplusFraction` (+ optional `target`), with optional `from` / `to`;
a BASELINE is exactly one of `monthlySpending` / `annualReturnPct`. What the model sends: `remember({op?, subject, statedAs, goal | plannedExpense | rule | baseline, set?, unset?, replace?})`.

### A.6 Also true of the implementation, and not in the body below

- **An identical re-statement writes nothing** ("Remember that." after the item is on record: `unchanged: true`).
- **Every RULE write echoes `otherRulesInForce`**, so a second subject for one strategy is visible to the model.
- **The panel lives in `components/dashboard/MemoryPanel.tsx`,** not `components/ai/`: that directory is presentation-only by an
  existing guard (no `fetch`), and the guard was kept rather than loosened. It says "noted as", never "you said".
- **`reconcile_projection` does not yet report `restedOn`** (§10): that edit is in `tools.ts`, outside this agent's ownership.
  `recall` reports it. Legacy USER_STATED checkpoints stay readable.
- **DELETE writes one content-free `AuditLog` row** — `AI_MEMORY_ERASED`, `{kind, versionsErased}` — never what the item said.
- **A debt-free goal and an open-ended goal are goals but not starters or Brief plans**: `PlanGoal` is frozen as a positive target
  with a deadline.

---

## 0. One-page summary

**The defect.** Memory can hold a number and a label; users state rules, multipliers and bases. Every admissible `INTENTION`
shape *requires* a number (`memory-store.ts:60`), validation checks that a key is *present*, not that it has a value
(`memory-store.ts:96`), and the refusal text names the missing key — so the model supplies one. Re-reading the traces: of 69
turns containing a rejected `remember`, 44 retried and stored in the same turn, and **32 of those 45 retried rows carried a
coerced amount** (30 a month count or a zero, 2 a null). The refusal taught the coercion. The model's *first* instinct was
usually right: 36 first attempts reached for semantic keys, and one wrote — verbatim — the scenario contract's own clause:
`rule: {liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: ["highest_apr","investments"]}`. It was refused.

**The design, in eight decisions.**

1. **~~Six~~ Five semantic classes, no enum migration.** ~~Five~~ Four things a user can state — `GOAL`, `PLANNED_EXPENSE`, `RULE`,
   `BASELINE` (~~`PREFERENCE`~~ — cut, R7) — and one thing the system observes — `PROJECTION`. They are a **versioned discriminator inside the existing
   `payload` Json** (`{v: 2, class: …}`), stored under the three existing `MemoryKind`s. No enum value, no column, no
   migration, no `prisma generate` on the shared client. What that costs is stated in §11; the additive SQL for the alternative
   is given there and not recommended.
2. **A rule is stored in the scenario contract's own vocabulary.** "Keep six months of expenses, then highest-APR debt, then
   invest the rest" is `{liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: ["highest_apr","investments"]}` — the
   exact object a `contributions[]` item takes (`tools.ts:2455-2501`). ~~There is **no money field in it**, so $26,078.88 cannot
   be frozen: the bad state is unrepresentable, not detected.~~ **Corrected (R2):** `liquidFloor` IS a money field, so the bad
   state is *detected*: a dollar floor is admitted only on positive evidence that the user typed those dollars, and is otherwise
   refused in favour of `liquidFloorMonthsOfExpenses`. The stored payload nests the clause — `{v, class, rule: {…}}` (R4). "Run my remembered strategy" is the model copying that object
   into a scenario call, where the existing echo (`floorRule.derivedFrom`, `assumptionsInForce`) shows the user what ran.
   Memory code never imports, calls or compiles for a scenario tool; a parity test keeps the two vocabularies one.
3. **Field-wise amendment, row-per-version.** "Make it nine months" is `op: "amend", set: {liquidFloorMonthsOfExpenses: 9}`:
   code merges onto the prior row, validates the *whole* merged rule, and writes a **new row** that supersedes it — the
   supersession-creates-a-row property is kept. A `record` that would silently drop a field the prior version held is refused
   unless the caller says `replace: true`. Lossy supersession (G4) becomes a deliberate act with an echo, not an accident.
4. **A stated baseline gets a durable home; the anchor rule is replaced.** `BASELINE {monthlySpending: 5000}` persists on its
   own, stamped by code `basis: ~~"STATED"~~ "REMEMBERED", scope: "PLANNING"` (R3 — never one of M1's three words; not a rung of the
   expense baseline). It reaches a calculation **only** when the model passes it as the existing explicit argument, in a
   conversation where the user asks to plan with it, saying that it was remembered. No tool reads memory into a
   money calculation; a source scan pins `recallMemories(` in `tools.ts` to its one existing call site (`reconcile_projection`).
5. **Value-typed validation and one provenance primitive.** Every numeric field has a unit by type (`Money`, `Months`,
   `Fraction`, `Percent`, `ISODate`); null, empty and zero are not values. **A `Money` value is ~~refused when it is a figure
   *we* produced~~ admitted only when the user stated it, in digits** (§A.2) — and "what the user wrote" is passed in explicitly,
   never read off the transcript, whose `role: 'user'` messages include the orientation (R1).
   That is what stops a projected net worth becoming "the user's goal". Refusals carry the correct shape built from the
   caller's own payload.
6. **Remembering never computes.** The memory line (sent on every request) lists items *as stated, on the date stated*, under
   a fixed sentence that nothing listed is in effect. `recall` returns the same, plus words. The only path to a number is an
   explicit tool call whose arguments the user sees echoed.
7. **Automatic checkpoints are kept, narrowed, and moved out of "what the user wants".** `project_cash` still records what it
   said — but **not** when the projection rested on a conversational spending figure (`basis.spending.source ===
   'USER_STATED'`), which by the code's own argument for excluding scenarios is a hypothetical, and which today *supersedes*
   the evidence-based statement for the same horizon. `remember` can no longer mint a `CHECKPOINT`. `basis` becomes a closed,
   code-written key set.
8. **The user can see, stop and erase.** A self-contained "Memory" panel on the AI page backed by
   `GET /api/ai/memory`, `PATCH /api/ai/memory/[id]` (retire) and `DELETE /api/ai/memory/[id]` (erase with history), scoped to
   `{spaceId, ownerUserId}` on every query. Retirement is a tombstone row, so *when* and *in what words* are kept with no new
   column. Legacy rows are never rewritten: a pure fail-closed reader decides per row whether it is readable, and unreadable
   rows are hidden from the model's line, the starters and the Brief and shown to the user as "couldn't read this reliably —
   saved on ‹date›: ‹their words›" with a delete.

**~~Seven~~ Six slices**, re-ordered readers-before-writers (R9; §A.1), each its own commit; S1 is pure and changes no behaviour. **No migration.** Estimated
model-sampled acceptance: 80 turns on the clone (§13).

### 0.1 What I verified in current code (path:line)

| Fact | Where |
|---|---|
| closed key sets per kind; `requireOneOf` is a **key-presence** test (`keys.includes(k)`) | `lib/ai/conversation/memory-store.ts:55-73`, `:96` |
| every admissible INTENTION shape requires a number (`targetAmount` or `amount`) | `memory-store.ts:57-60` |
| `validatePayload` is top-level only; `targetMetric`, `label`, `intent`, `CHECKPOINT.basis` are unvalidated content | `memory-store.ts:79-102` |
| ASSUMPTION refused without an ACTIVE INTENTION/CHECKPOINT on the same subject | `memory-store.ts:190-195`, `:209-223` |
| supersession = new row + prior → SUPERSEDED, keyed on exact `(owner, kind, subject, ACTIVE)` | `memory-store.ts:225-249` |
| `supersedesId` is `@unique` (a row can replace exactly one row); `MemoryStatus.RETIRED` **already exists**, unused | `prisma/schema.prisma:730-734`, `:760` |
| `remember` offers all three kinds incl. CHECKPOINT; `payload` is `additionalProperties: true`, shapes described in prose | `lib/ai/conversation/memory-tools.ts:167-181` |
| silent CHECKPOINT on every non-retrospective `project_cash`; copies `basis.openingCash` — **a past balance — into memory** | `memory-tools.ts:66-116` (`:104`), called at `turn.ts:290` |
| `project_cash` already says whether it rested on a stated figure | `tools.ts:1734-1739` (`spending.source: 'USER_STATED' \| 'OBSERVED' \| 'NONE'`) |
| memory line renders `${targetAmount} ${targetMetric} by ${byDate}` / `${label} ~${amount}`; reads ACTIVE only and applies **no** `appliesTo`/`byDate` expiry; ASSUMPTIONs absent | `lib/ai/conversation/evidence.ts:263-302` (`:273-275`), caps `:232-234` |
| starters + Brief share `selectMemoryPlans`; a planned expense qualifies with any `amount > 0`, any ≤40-char label, any string `intent` — hence "Can I afford monthsOfExpenses (~$6)?" | `lib/ai/conversation/starter-topics.ts:184-222` (`:205-209`), `:240-248` |
| Brief `plans` block is that selector's output, unchanged | `lib/ai/brief/package.ts:257-286`; rows loaded at `lib/ai/brief/load.ts:62-73,144` |
| Brief watermark counts this owner's memory rows / ACTIVE rows / `max(createdAt)` | `lib/ai/brief/watermark.ts:163-165` |
| `reconcile_projection` is the one tool that reads memory; it fails closed per row | `tools.ts:2931-3036` (read at `:2944`), `reconcile.ts:139-157`, `METRIC_FIELD` `tools.ts:2926` |
| AI page reads memory once, server-side, for starters only | `app/(shell)/dashboard/analyze/page.tsx:71-81` |
| scenario clause vocabulary | `tools.ts:2431-2517` (`liquidFloorMonthsOfExpenses` `:2478`, `target` `:2487`, `assumedMonthlySpending` `:2507`); `scenario-ledger.ts:96` (`AllocationTarget`), `:250-261` (`ContributionSpec`) |
| "N months of expenses" resolved in code from the scenario's own spending level | `tools.ts:1989-2007` → `lib/ai/measures/baseline.ts:281-310` |
| STATED > DECLARED > MEASURED, "nothing here persists" | `lib/liquidity/expense-baseline.ts:30-39,64-70`; `get_baselines.statedMonthlySpending` `tools.ts:883` |
| the active scenario is transient by design | `lib/ai/conversation/active-scenario.ts:32-36` |
| guards that constrain this design: exactly one write-verb tool and it is `remember`; the store may name only `db.spaceMemory`; `tools.ts` holds no Prisma client; the system instruction says nothing about memory | `scripts/ai-baseline/baseline.test.ts:187-190`, `:204-209`, `:193-196`, `:1741-1742,1789-1790` |
| `audit-goals-tombstone` forbids the identifiers `SpaceGoal`, `GoalStatus`, `GoalCategory`, `GoalType`… | `scripts/audit-goals-tombstone.ts:52-62` — V2 names avoid all of them |
| AI sub-routes inherit the fixed-height conversation chrome (`startsWith`) | `lib/space-nav.ts:128`, `components/ui/DashboardChrome.tsx:59` |
| the one live row (clone of dev): `CHECKPOINT liquid-2026-12-31`, `spendingSource: "USER_STATED"`, `userAssumptions: ["spending baseline 4346.48 …"]`, `openingCash: 13330.97` | `select … from "SpaceMemory"` on `fintracker_postm1_b`, read-only transaction |

That last row is the design's B4 case in miniature: the only memory the product has ever written for a real user is a
projection resting on a "stated" figure that is in fact the *measured* mean the model re-typed as an assumption, with a past
balance stored beside it.

### 0.2 What the traces add to the investigation

All 28 trace files: **201** `remember` calls, 84 rejected, 117 stored (`batch1`+`batch2` alone reproduce the investigation's
161 / 71 / 90). New readings, all from tool *arguments*:

- **The shapes the model reaches for are the scenario contract's.** Rejected keys observed: `monthsOfExpenses`,
  `targetAmountRule`, `months`, `liquidFloorMonthsOfExpenses`, `cashFloorMonthsOfExpenses`, `bufferRule{monthsOfExpenses}`,
  and for ordering `allocationOrder`, `priority`, `priorityOrder`, `ordering`, `rules[]`, `target` — overwhelmingly with the
  literal values `["highest_apr","investments"]`. The model does not need a new vocabulary taught to it. It needs the one it
  already uses for scenarios to be admissible.
- **`intent + label` with no number** was the single most common rejected shape (29 of 84): the model tried to store a rule as
  words with no amount, was told `a INTENTION needs all of … intent + amount + label`, and came back with `amount: 0` or
  `amount: 6`. The placeholder is the schema's doing.
- **`statedAs` is model-authored and already contaminated.** One stored row's `statedAs` reads *"…then invest ~0 from
  2026-09-20"* and another *"…invest the rest ~30000"* — the memory line's own rendering of a coerced row, copied back in as
  "the user's words". V2 therefore never derives meaning from `statedAs` (§5, §9).
- **A derived *date* also became a goal.** "How long until I hit $1M?" → `scenario_crossing` → "Remember this strategy" →
  attempted `{targetMetric: "netWorth", targetAmount: 1000000, byDate: "2035-02-28"}`. The user asked a question; the crossing
  date became their deadline. §7 handles the amount; the date is a residual risk named in §16.

---

## 1. Semantic classes

A class earns its place only with a distinct **lifecycle**, distinct **readers**, or distinct **validation**.

| Class | What it is | Stored under | Distinct because | Status |
|---|---|---|---|---|
| `GOAL` | a level the user wants a measure to reach, optionally by a date | `INTENTION` | lapses at `byDate`; read by starters and Brief `plans.goals` (progress arithmetic); validated as `Money` + closed metric | existing shape 1, tightened |
| `PLANNED_EXPENSE` | a one-off outlay the user intends | `INTENTION` | never lapses by date; read by starters ("Can I afford…") and Brief `plans.planned`; validated as label + `Money` | existing shape 2, tightened |
| `RULE` | a standing allocation policy, in scenario-contract clauses | `INTENTION` | **no money required**; amendable field-wise; read by the memory line / `recall` / the panel only; validated against the contribution vocabulary | **new** |
| `BASELINE` | a figure the user stated *for planning* | `ASSUMPTION` | can go **stale**; never a starter or a Brief fact; always labelled STATED; reaches a tool only as an explicit argument | existing kind, anchor rule replaced |
| `PREFERENCE` | a disposition with no number | `INTENTION` | **figure-free by validation**; no expiry; no reader but the line, `recall` and the panel; can never be translated into arguments | **new**, last slice |
| `PROJECTION` | what `project_cash` said, when, on what evidence | `CHECKPOINT` | written by **code only**; settles at its horizon; read by `reconcile_projection`, one starter topic, Brief `nextCheckpoint`; never part of "what the user wants" | existing, narrowed (§10) |

**Considered and not added.**

- **Decision / intention as its own class** ("I've decided to sell the car"). Every instance decomposes: dated with money → a
  planned one-off; standing → a `RULE`; a level → a `GOAL`; no number → a `PREFERENCE`. No distinct lifecycle, reader or
  validation. *Rejected.*
- **Planned inflow** ("a $15k bonus in March"). It has the `outflows[]` shape with a negative amount, but it is a claim about
  future income, which is I1's territory and adjacent to the deferred `TESTIMONY` kind. *Out of scope until I1 lands.*
- **A relational goal** ("reach six months of expenses in cash"). "Keep N months" is a floor — a `RULE` with only a floor
  clause (§2). A second place to store a multiplier would be two authorities for one sentence. *Rejected.*
- **`monthlyIncome` as a `BASELINE` measure.** `get_baselines` takes `statedMonthlyIncome`, but no scenario tool does, so "run
  my strategy" could narrate it without applying it. **Admissibility rule: a baseline measure exists in memory only if a tool
  argument takes it and echoes it as stated in *every* tool that could use it.** Today that is `monthlySpending` and
  `annualReturnPct`. *Deferred to I1.*
- **Anchoring a baseline to a subject** (`forSubject`). `appliesTo` was unset in every one of 201 observed writes. *Not built.*

**Enum migration required? No** — see §11 for the reasoning, the cost, and the alternative's SQL.

---

## 2. Rules, compositionally

### 2.1 The clause vocabulary *is* the contribution contract

A `RULE` payload is `{v: 2, class: "RULE"}` plus fields drawn from — and only from — the `contributions[]` item schema
(`tools.ts:2455-2501`), minus what is not a standing rule:

| Field | Type | Meaning (identical to the scenario contract) |
|---|---|---|
| `liquidFloorMonthsOfExpenses` | `Months` (0 < n ≤ 120) | the floor as a **multiplier of the expense baseline in force when evaluated** |
| `liquidFloor` | `Money`, user-stated | the floor in dollars the *user* said ("keep $50k liquid") |
| `fractionOfExcess` | `Fraction` (0 < f ≤ 1) | share of cash above the floor moved each month-end |
| `surplusFraction` | `Fraction` | share of what each month adds |
| `amount` + `cadence` | `Money`, user-stated + `monthly \| yearly` | a fixed scheduled amount ("$500 a month to the card") |
| `fractionOfLiquid` + `cadence` | `Fraction` + cadence | a share of the balance on a schedule |
| `target` | `AllocationTarget` or ordered list: `investments`, `highest_apr`, `{liability: id}` | where it goes; a list waterfalls |
| `from`, `to` | `ISODate` | optional bounds, as in the contract |

Excluded on purpose: `onDate` (a one-off is a planned event, not a standing rule) and `label` (`statedAs` is the label).

**Exactly one basis**, by the ledger's own rule (`scenario-ledger.ts:557-559`): the floor pair, or `surplusFraction`, or
`amount`+`cadence`, or `fractionOfLiquid`+`cadence`. **One exception, because users say it:** a floor **alone** —
`{liquidFloorMonthsOfExpenses: 6}` with no `fractionOfExcess` and no `target` — is admissible. "Keep six months of expenses in
cash" states a floor and says nothing about the excess; inventing `fractionOfExcess: 1` would be memory guessing. When asked
to *run* it, the model must choose a disposition and say which, exactly as the contract already instructs for an unstated
share (`tools.ts:2466-2468`). `fractionOfExcess` or `target` without a floor or another basis is refused.

**Where the baseline identity lives.** "Six months" is multiplier + baseline identity. The multiplier is the value. The
identity is the *field name*: months **of expenses**, resolved at evaluation by the one authority
(`resolveMonthsOfExpensesFloor`, `baseline.ts:285`) from the spending level the scenario runs at. I considered an explicit
`of: "EXPENSE_BASELINE"` field and rejected it: a field with one legal value invites the illegal one (the ledger's own
argument about cadence, `scenario-ledger.ts:241-246`), and embedding a *particular* baseline in the rule would recreate "two
assumptions wearing one sentence" (`baseline.ts:278-279`). If the user also has a remembered planning figure, it is a separate
`BASELINE` item, and the model passes both — one as the clause, one as `assumedMonthlySpending` — so the floor and the
spending in force remain one number by construction.

### 2.2 Exact JSON

What is **stored** (row `kind` / `subject` / `statedAs` / `payload`):

```json
{ "kind": "INTENTION", "subject": "cash-strategy",
  "statedAs": "Keep six months of expenses, then pay highest-APR debt, then invest the rest",
  "payload": { "v": 2, "class": "RULE", "rule": {
    "liquidFloorMonthsOfExpenses": 6, "fractionOfExcess": 1,
    "target": ["highest_apr", "investments"] } } }
```
```json
{ "kind": "ASSUMPTION", "subject": "planning-spending",
  "statedAs": "Use $5k monthly spending for planning",
  "payload": { "v": 2, "class": "BASELINE", "monthlySpending": 5000,
    "basis": "REMEMBERED", "scope": "PLANNING" } }
```
```json
{ "kind": "INTENTION", "subject": "net-worth-target",
  "statedAs": "I want $1M of net worth by the end of 2030",
  "payload": { "v": 2, "class": "GOAL",
    "targetMetric": "netWorth", "targetAmount": 1000000, "byDate": "2030-12-31" } }
```
```json
{ "kind": "INTENTION", "subject": "car",
  "statedAs": "a car, around $20k, not before March 2027",
  "payload": { "v": 2, "class": "PLANNED_EXPENSE",
    "label": "car", "amount": 20000, "earliest": "2027-03-01" } }
```
```json
{ "kind": "INTENTION", "subject": "cash-comfort",
  "statedAs": "I prefer keeping more cash than most people",
  "payload": { "v": 2, "class": "PREFERENCE",
    "topic": "cash_buffer", "note": "prefers holding more cash than is typical" } }
```

`basis` and `scope` on a `BASELINE` are **stamped by code, never supplied by the model**. They exist because "a stored row is
read months later" with no tool description beside it (`memory-tools.ts:90-94`), so the row says what it is.

`GOAL` and `PLANNED_EXPENSE` keep the legacy key names (`targetMetric`, `targetAmount`, `byDate`; `label`, `amount`,
`earliest`) so `selectMemoryPlans` and the Brief's `PlanGoal`/`PlanExpense` types do not move. `intent` is dropped: it was
free content with no reader. `targetMetric` closes to the `scenario_goal_seek.measure` enum — `netWorth | liquid |
investments | debt` (`tools.ts:2754`) — and `byDate` becomes **optional** ("I want $1M" is a goal; a forced date is an invented
date).

What the model **sends** — one tool, the class named by which property is present, so `class` and shape cannot disagree:

```json
{ "subject": "cash-strategy",
  "statedAs": "Keep six months of expenses, then pay highest-APR debt, then invest the rest",
  "rule": { "liquidFloorMonthsOfExpenses": 6, "fractionOfExcess": 1, "target": ["highest_apr", "investments"] } }
```

…and what "run my remembered strategy through next June" becomes, **written by the model**, echoed by the scenario tool:

```json
{ "to": "2027-06-30", "assumedMonthlySpending": 5000,
  "contributions": [ { "liquidFloorMonthsOfExpenses": 6, "fractionOfExcess": 1,
                       "target": ["highest_apr", "investments"],
                       "label": "remembered strategy (stated 2026-09-20)" } ] }
```

The clause is an identity copy. There is nothing to compile, so there is no compiler to drift.

### 2.3 Keeping the vocabularies one without coupling the code

- `memory-model.ts` (new, §14 S1) is **pure and import-free**, like `scenario-ledger.ts`. It declares the rule field table
  itself. It does not import `tools.ts`, the ledger, the measures layer or the active scenario.
- A **parity test** imports the *exported tool definitions* (`findTool('scenario_projection').parameters`) and asserts: every
  `RULE` field ∈ `contributions.items.properties`; `target` words ⊆ the `AllocationTarget` words; `GOAL.targetMetric` values =
  `scenario_goal_seek.measure` enum; `PLANNED_EXPENSE` keys ⊆ `outflows.items.properties ∪ {earliest}`. If Agent 3 renames a
  clause, this fails loudly in *their* run — which is the intent. Reading the exported object, not source text, survives
  Agent E's schema de-duplication.
- **Source-scan guards:** `memory-store.ts` / `memory-tools.ts` / `memory-model.ts` contain no `findTool(`, no runtime import
  of `./tools`, `./scenario-ledger`, `./scenario-crossing`, `./active-scenario` or `@/lib/ai/measures`; `tools.ts` contains
  exactly one `recallMemories(` call; `active-scenario.ts` does not import the store.

**Primitive or patch?** *Primitive.* "Semantic identity survives storage" — the same principle as M1's `derivedFrom`. It
contains no six and no $5k, and it answers no particular question.

**Rejected:** (a) adding `monthsOfExpenses?: number` to the current payload — leaves the required money field, the free-text
holes and the lossy supersession in place, and creates a second name for an existing contract field; (b) a nicer nested shape
(`keep: {…}, then: […]`) — prettier, and a translation layer the model must get right every time, where today's evidence is
that it already writes the contract's keys unprompted; (c) storing the rule as prose only — 0 structure to amend, and the
fresh-chat translation becomes a parse.

---

## 3. Superseding one clause

**Mechanics: a versioned rule document, patched field-wise, one new row per version.**

```json
{ "op": "amend", "subject": "cash-strategy",
  "statedAs": "Actually make it nine months",
  "set": { "liquidFloorMonthsOfExpenses": 9 } }
```

1. Code finds the owner's current item on `(kind, subject)` — the most recent row with no successor.
2. It merges `set` / `unset` onto that row's fields. **Mutually exclusive groups swap rather than accumulate**: setting
   `liquidFloorMonthsOfExpenses` removes `liquidFloor` and vice versa; setting a member of another basis removes the current
   basis's fields. The groups are a table in `memory-model.ts`, tested exhaustively.
3. The **whole merged document** is validated by the same function as a fresh write. An amendment that leaves an invalid rule
   is refused with what would remain — e.g. `unset: ["liquidFloorMonthsOfExpenses"]` leaves `fractionOfExcess` with nothing to
   be above: *"removing the floor leaves `fractionOfExcess: 1` with no floor. Retire the whole rule, or set a different basis
   (e.g. `surplusFraction`) in the same call."*
4. A **new row** is created with `supersedesId` → the prior, prior → `SUPERSEDED`, in one transaction, exactly as today
   (`memory-store.ts:225-249`). The result echoes `changed: [{field, from, to}]` and `kept: {…}`, so the model can tell the
   user "nine months now; cards first, then invest — unchanged".

**History.** Supersession-creates-a-row is **kept**. The chain is the version history; `recall(includeHistory)` and the panel
show it. The amended row's `statedAs` is the amendment's words; the item's *meaning* is always rendered from its fields by one
pure renderer (§5), never from `statedAs`, so a chain of terse amendments still reads as a full sentence.

**How the model addresses a clause.** By `subject` (it is in the memory line on every request — the mechanism behind the
measured 15/15 supersession) and by **field name**, which is the scenario contract's name and is also in the line. No clause
ids.

**Replacement cannot silently lose a field (G4).** A `record` on a subject that already holds an item is:
- refused if the class differs — *"`cash-buffer` already names a GOAL. Use another subject, or retire that item first."*
  This is what stops `{liquid: 39118.32}` replacing a strategy;
- refused if the new payload lacks a field the current version holds, **unless `replace: true`** — *"the current rule also
  says `target: ["highest_apr","investments"]`, `fractionOfExcess: 1`. If the user changed one part, use `op: "amend"` with
  `set`. If they replaced the whole rule, repeat with `replace: true`."* With `replace: true` the write succeeds and echoes
  `dropped: […]`;
- otherwise an ordinary supersession.

**Rejected: row-per-clause.** (1) `target` ordering is a relation *between* clauses; split across rows it needs ordering
metadata. (2) The ledger requires the floor pair to travel together (`scenario-ledger.ts:585-589`); separate rows mean memory
must recompose them — a second rule compiler. (3) `supersedesId` is `@unique`, so a replacement strategy cannot supersede three
rows. (4) The traces already show the model splitting one sentence into `cash-buffer` + `allocation-order` rows, after which
"run my strategy" had to reassemble them; row-per-clause would make that the norm. **Rejected: in-place update** — it would
be the first edit of a memory's content anywhere and would discard "then six, now nine".

**Limit, stated:** one allocation per `RULE` item. Two standing rules are two items; the model composes
`contributions: [a, b]` and the scenario echo shows the order it chose.

**Primitive or patch?** *Primitive* — "supersession never silently drops a field" holds for every class and mentions no
particular rule.

---

## 4. Durable stated baselines

**Representation.** `BASELINE` (§2.2), exactly one of `monthlySpending: Money` or `annualReturnPct: Percent (0–100)`.

**Provenance so it is never mistaken for observed truth:**
- `basis: "STATED"` and `scope: "PLANNING"` in the payload, code-stamped;
- `statedAt` (the conversation's clock, `memory-tools.ts:193`) — *when*;
- `statedAs` — *the words*, bounded to 280 chars, display-only;
- the memory line lists it under **`planningAssumptions`** (never beside measured figures), each with `basis: "STATED"`, its
  date, and `stale: true` past the threshold (§6);
- the panel lists it under **"Planning figures you gave me — not measured from your accounts"**.

**How a calculation comes to use it — one way only.** The model reads it in the line or from `recall` and passes it as
`get_baselines.statedMonthlySpending` or `assumedMonthlySpending` / `annualReturnPct` on a projection or scenario. Those tools
already echo it as `STATED` / `USER_STATED` and already resolve "months of expenses" from it (`tools.ts:1960-1965`,
`:1997-2001`). **No tool gains a memory read.** Guard: `recallMemories(` occurs once in `tools.ts`.

This also closes G13 (fresh-chat false continuity, 8/10): when no `BASELINE` is remembered the line says so in one clause
(`planningAssumptions: "none remembered"`), so "what spending assumption were we using?" has a true answer either way.

**The ASSUMPTION-needs-an-anchor decision: REPLACE.**
- *Why it existed* (`memory-store.ts:190-195`): "assume I spend $6K" said in passing must not persist.
- *What the evidence says:* the model does not store passing assumptions — "Use $5k instead" produced **0 writes in 39**. The
  rule therefore blocks only the case it should allow: an explicit "remember that", refused **10/10**, after which a fresh
  chat carried the figure **2/21**. The model already draws the passing/durable line by tool choice (investigation §4: 15/15).
- *Keep* — rejected: it is the direct cause of G3.
- *Relax* (anchor optional) — rejected: `appliesTo` was unset in 201/201 writes and anchoring has no reader; an optional field
  nobody sets is dead contract.
- *Replace with a deterministic "did the user ask?" check* — rejected: that is an intent parser.
- *Replace with:* (1) standalone persistence; (2) a closed measure set tied to echo-able arguments (§1); (3) the provenance
  stamp and separate rendering above; (4) staleness shown, never silently trusted; (5) the user's ability to see and retire it
  (§8), which is the control the original rule was standing in for.

**Note for the lead (M1 is closed; nothing changes there).** `statedMonthlySpending` is described as what "the user STATED in
this conversation" (`tools.ts:883`). A remembered figure re-stated by the model on the user's behalf, visibly, fits the
mechanism but not quite the words. I propose **no** M1 text change; the acceptance run measures whether the model passes a
remembered baseline. If it does not, that is a finding for the lead, not a licence to edit M1.

**Primitive or patch?** *Primitive.* No $5k, no spending special case: a typed, provenance-stamped, separately rendered slot
for any measure a tool can take as an explicit argument.

---

## 5. What fresh-chat recall means

### 5.1 The memory line (every request — bytes are budgeted)

Built by a new **pure** `composeMemoryLine(rows, todayISO)` in `memory-model.ts`; `evidence.ts:memoryLine` becomes the two
scoped reads plus that call. Rows pass through the fail-closed reader first (§9), then the single `inForce` rule (§6).

```json
"memory": {
 "meaning": "What this user asked us to remember, as they stated it on the dates shown. None of it is in effect and none of it is a current figure: nothing here has been applied to any number. To use one, pass its fields as explicit arguments to the tool that takes them and say that you are using what they asked you to remember.",
 "goals":   [{ "subject": "net-worth-target", "statedAt": "2026-09-08", "targetMetric": "netWorth", "targetAmount": 1000000, "byDate": "2030-12-31" }],
 "rules":   [{ "subject": "cash-strategy", "statedAt": "2026-09-20", "rule": { "liquidFloorMonthsOfExpenses": 6, "fractionOfExcess": 1, "target": ["highest_apr", "investments"] } }],
 "planningAssumptions": [{ "subject": "planning-spending", "statedAt": "2026-09-20", "monthlySpending": 5000, "basis": "STATED" }],
 "planned": [{ "subject": "car", "statedAt": "2026-09-08", "label": "car", "amount": 20000, "earliest": "2027-03-01" }],
 "preferences": [{ "subject": "cash-comfort", "topic": "cash_buffer", "note": "prefers holding more cash than is typical" }],
 "projectionsOnRecord": { "count": 1, "horizons": ["2026-12-31"], "note": "statements we made; `reconcile_projection` compares them with what happened. Never current balances." },
 "unreadable": 2
}
```

- **Rules appear as their literal fields**, because those fields *are* the arguments. Rendering them as prose would make the
  fresh-chat run a parse; rendering them as dollars is the defect.
- **No `statedAs`**, as today — raw words have already carried scenario language into this table (§0.2).
- **Caps:** goals 3, rules 3, planning assumptions 2, planned 3, preferences 2, horizons 6 (today: 8 + 6). Empty sections are
  omitted. **Budget, asserted by test:** a typical line (one rule, one baseline, one goal) ≤ 900 B; the capped worst case
  ≤ 2,000 B, against an estimated ≈ 1,400 B for today's worst case (8 intentions + 6 horizons; to be measured in S4).
- **Empty state** keeps its nudge and the pinned phrase (`baseline.test.ts:1769`): *"Nothing has been remembered for this user
  yet. When they ask you to remember a goal, a plan, a standing rule or a planning figure — or change one — record it with
  `remember`."*
- `unreadable: n` is included when n > 0, because a summary covering part of a store must not narrate the whole of it
  (`evidence.ts:252-258`).

### 5.2 `recall`

Parameter `kind` becomes `class` (the six classes); `includeSuperseded` becomes `includeHistory`. Returns:

```
{ scope, meaning,                       // same sentence as the line
  stated: [{ subject, class, statedAt, state, inWords, fields, saidAs }],
  projectionsWeMade: [{ subject, metric, horizon, value, statedAt, restedOn }],
  unreadable: [{ savedOn, saidAs }] }   // words only — never the payload
```

`inWords` comes from the one renderer, `describeMemory(item)` — e.g. *"Keep 6 months of expenses in cash; each month-end move
all of the cash above that to the highest-APR debt first, then to investments."* The same function feeds the panel. It is the
single copy, as `selectMemoryPlans` is for plans.

`unreadable` deliberately returns `saidAs`: in the coerced legacy rows **the words are the faithful part** and the payload is
the wrong part. The model can say "you have an older note — 'keep six months of expenses, cards first, then invest' — that I
can't read reliably; shall I record it properly?", and a V2 write on the same subject supersedes the old row. Self-healing,
non-destructive, initiated by the user.

### 5.3 "You previously said…" without activating anything

- The `meaning` sentence is on the line and on every `recall`.
- **No code path** turns a memory into an argument: no tool reads the store into a calculation; `captureActiveScenario`
  continues to `IGNORE` `remember` and `recall`; nothing in the store touches the scenario slot.
- "Run my remembered strategy" computes because the **model** issues a scenario call whose arguments the tool echoes. A
  remembered item that is *not* passed is *not* in the echo, so the user can always tell what ran.

**Primitive or patch?** *Primitive* — one pure composer, one renderer, one in-force rule, shared by every reader.

---

## 6. Expiration, applicability, supersession, correction

**Stored status — the existing enum, now fully used:** `ACTIVE`, `SUPERSEDED` (replaced by a later version), `RETIRED`
(withdrawn).

**Derived state — computed by one pure `stateOf(item, today)`, never stored:**

| State | Rule | Line / starters / Brief | Panel |
|---|---|---|---|
| `IN_FORCE` | ACTIVE, inside `appliesFrom..appliesTo`, not lapsed | shown | "Remembered" |
| `STALE` | an IN_FORCE `BASELINE` older than `BASELINE_STALE_AFTER_DAYS` (180) | shown with `stale: true` | badge: "you gave me this N months ago" |
| `NOT_YET` | `appliesFrom` in the future | hidden | "Starts ‹date›" |
| `LAPSED` | `appliesTo` passed, or a `GOAL` whose `byDate` passed | hidden | "Lapsed", with retire / delete |
| settled | a `PROJECTION` whose horizon passed | count only; reconcilable | "Projections I made" |

- Today `inForce` exists only in `starter-topics.ts:139-143`; the memory line applies no expiry, so a lapsed goal is still
  "what this user has decided". V2 has **one** definition.
- **Staleness is displayed, never enforced.** Only a `BASELINE` goes stale: a dollar level drifts. A `RULE` does not — it holds
  no level and is re-evaluated against current evidence each time, which is the point of §2. A user-stated `liquidFloor` in
  dollars is theirs; it is shown with its date. The 180-day threshold is a named constant and a product judgement, not a fact.
- **Applicability windows** remain the optional `appliesFrom` / `appliesTo` columns, now validated (real dates, from ≤ to).

**Corrections.**

| The user says | Operation | Result |
|---|---|---|
| "Actually make it nine months" | `amend` + `set` | new version; other fields kept and echoed |
| "Forget the six-month rule; use nine" | `amend` + `set` | same — the instruction replaces a value |
| "Stop doing that" / "forget my strategy" | `retire` | a **tombstone row** (below); item leaves every reader |
| "Drop the debt-first part" | `amend` + `set: {target: "investments"}` | merged rule validated as a whole |
| "Forget the six-month part" (nothing else said) | `amend` + `unset` → invalid remainder | refusal naming what would remain; the model asks |
| deletes it in the panel | `DELETE` | the item **and its whole history** are erased |

**Retirement is a tombstone row**, not a column:
`{status: RETIRED, supersedesId: <prior>, statedAs: "Stop doing that", payload: {v: 2, class: "RULE", retired: true}}`,
with the prior → `RETIRED`. This records *when* it was withdrawn and *in what words* with **no schema change**, keeps "every
change of mind is a row", and keeps the chain unbroken: a later re-statement on that subject supersedes the tombstone. Every
reader already filters `status: ACTIVE`, so a tombstone is invisible to them by construction. A panel retirement writes the
same row with `statedAs: "Retired by you in Memory."`. *Rejected:* a nullable `retiredAt` column — additive, but it needs
`prisma generate` on a client shared by every peer worktree and a deploy-ordering step `build` does not perform, and it keeps
less.

**The model can retire; only the user can delete.** `remember` has no delete operation: a conversation cannot destroy history.
Deletion is a user-interface act on the user's own rows. It removes every row of that `(owner, kind, subject)` chain — someone
erasing what the assistant remembers does not expect the previous version to survive. Nothing else is retained. The Brief
watermark moves in both cases (`memoryCount` / `memoryActiveCount`, `watermark.ts:163-164`), so a Brief that mentioned the
item regenerates — no change needed in Agent 1's files.

---

## 7. Validation of values and semantics

### 7.1 Units are part of the type

`memory-model.ts` declares each class as a table of `field → type`. A type is a pure predicate returning a reason:

| Type | Admits | Refuses — null, `""`, NaN and non-numbers always |
|---|---|---|
| `Money` | finite, **> 0**, ≤ 1e12, ≤ 2 decimals; then the provenance gate (§7.2) | `0` (the placeholder), negatives |
| `MoneyOrZero` | as `Money` but ≥ 0 — used **only** by `GOAL.targetAmount` when `targetMetric === "debt"` ("debt-free") | — |
| `Months` | finite, 0 < n ≤ 120 | 0, a dollar-sized number |
| `Fraction` | 0 < f ≤ 1 | 0 (the `surplusFraction: 0` case), 75 for 75% |
| `Percent` | 0 ≤ p ≤ 100 | — |
| `ISODate` | a real calendar day, `YYYY-MM-DD`; `byDate` must be after the conversation's `asOf` | `null` (43 stored rows today), `"2030"`, 31 February |
| `Enum<…>` | a listed word | everything else (`targetMetric: "monthsOfExpensesInCash"`) |
| `Label` | 1–40 printable chars, contains a letter, **is not a contract field name**, no `_ [ ] { } "` | `monthsOfExpenses`, `["highest_apr","investments"]` |
| `Note` | 1–140 chars, **contains no figure** (no digits after removing `401(k)`-style tokens; `extractFigures` finds nothing) | any number — a preference with a number is a rule, a baseline or a goal |
| `Subject` | `^[a-z0-9][a-z0-9-]{1,47}$` | — |
| `Words` (`statedAs`) | 1–280 chars | empty |

**"A money field rejects a month count" — how.** Primarily by construction: months have their own field and type, and the
traces show `amount: 6` only ever appeared as a *retry after* `monthsOfExpenses` was refused. A `RULE` has no bare money field
(`amount` is admissible only with `cadence`); a `PLANNED_EXPENSE`'s `Label` cannot be a contract field name; and the refusal
for a rule-shaped key under the wrong class points at `RULE` rather than listing `amount` as a missing key. I deliberately did
**not** add a magnitude heuristic ("money under 100 is suspicious") — that is a guess about the user's life.

**Closed key sets survive.** Each class has a closed field set; unknown keys are refused; **no class has a field that could
name a balance** — the existing `currentCash / balance / liquid / netWorth / …` test (`baseline.test.ts:1681-1685`) passes
unchanged, since `liquid` and `netWorth` exist only as enum *values* of `targetMetric`, never as keys. The one place a balance
*is* in memory today — `CHECKPOINT.basis.openingCash`, reachable by the model through unvalidated `basis` — is closed in §10.

### 7.2 A figure we produced is not something the user stated

The shape cannot protect a `GOAL`: its amount is dollars by nature, and the observed failure is a projected net worth stored as
the user's goal. The deterministic signal the turn loop already holds:

> **Provenance gate.** A `Money` value is **refused** when it matches a figure *we* produced — any number in **this turn's
> tool results** (`rec.toolCalls[].result`, walked as JSON), or any figure in an **assistant** message of the replayed
> history — **and** matches no figure in any **user** message, including the current one.

- Matching reuses the licence's tolerance (`lib/ai/brief/licence.ts:56`, `extractFigures` — pure, import-free): a stored value
  is compared at the precision the prose token was written at, so `271000` is caught against "$271,433.64" and `5000` is
  licensed by the user's "$5k". A small closed word-number grammar ("a million", "twenty thousand", "20 grand") is added for
  **user** text only, to reduce false refusals.
- **Why both sources.** Production keeps no tool result across turns (investigation §2), so on "Remember this." one turn after
  a scenario, the figure exists only in assistant prose. This-turn results catch the other common path (`get_baselines` →
  `remember` in one turn, which is how `26078.88` was frozen 45 times).
- **Positive evidence only.** A value found nowhere is accepted: the gate never requires the user to have typed digits, so
  "remember my goal is a million" cannot be locked out by a parsing miss.
- **Plumbing.** `ToolContext` gains an optional, read-only `turn?: { userTexts, assistantTexts, toolNumbers() }` (a type in
  `tools.ts` — no Prisma, no behaviour). `executeTurnInner` builds it from `messages` and `rec.toolCalls`. The `remember` tool
  **fails closed** without it — *"this write path has no conversation evidence, so a money value cannot be checked"* — and a
  source scan asserts the turn loop supplies it. The store's direct API (scripts, live checks) is unaffected: the gate is a
  property of the *tool* path, which is where a model is.
- The same gate covers `liquidFloor`, a scheduled `amount`, `monthlySpending` and `PLANNED_EXPENSE.amount` — one primitive for
  every `Money` field. This is what stops `liquidFloor: 30000` (= 6 × $5k, computed by us) standing in for
  `liquidFloorMonthsOfExpenses: 6`.

**Refusal text:** *"271433.64 is a figure we computed — it is in this conversation's results, and the user never stated it. A
projection is not their goal. Record a goal only with a number they said; if they want this one, ask them to say it."*

**Primitive or patch?** *Primitive* — "memory admits what the user stated; a figure we produced is not theirs" is stated once
and applied to every money field in every class. Its failure modes are in §16.

### 7.3 Refusals that teach

The measured mechanism of failure was the refusal itself (§0: 32 of 45 retried rows coerced). Every V2 refusal returns:

```
{ stored: false,
  reason:   one sentence — what is wrong with THIS value or key,
  expected: the correct shape for what they appear to be storing, built from their own payload where possible,
  example:  one complete valid call }
```

- **Unknown key → the right class, not a missing-key list.** `{goal: {targetMetric: "liquid", monthsOfExpenses: 6}}` →
  *"`monthsOfExpenses` is not a goal field. 'Keep N months of expenses' is a standing RULE:
  `rule: {liquidFloorMonthsOfExpenses: 6}` — add `fractionOfExcess` and `target` only if the user said what happens to the
  rest."*
- **Observed synonyms map to the canonical field *in refusal text only***: `monthsOfExpenses | months | bufferMonths |
  cashBufferMonths | cashFloorMonthsOfExpenses` → `liquidFloorMonthsOfExpenses`; `allocationOrder | priority | priorityOrder |
  ordering | surplusAllocationOrder` → `target`; `monthlySpending | assumedMonthlySpending` inside a rule → *"a planning figure
  is its own item: `baseline: {monthlySpending: 5000}`"*. **Nothing is ever auto-coerced.** A synonym table that changed what is
  *accepted* would be guessing; one that improves the *message* is diagnostics.
- **Never name a field as "missing" when the class is wrong.** `a INTENTION needs all of intent + amount + label` is the
  sentence that produced `amount: 0`.
- **A CHECKPOINT from the model:** *"Projections are recorded automatically when `project_cash` states one from observed
  evidence. A scenario result is a hypothetical and is never remembered. To keep the plan behind it, record the rule, planning
  figure or goal the user stated."*

---

## 8. User agency

**The smallest surface that makes durable memory defensible: see it in plain language, understand it is not current truth,
stop it, erase it.**

### 8.1 Routes (new, self-contained under `app/api/ai/memory/`)

| Route | Does | Returns |
|---|---|---|
| `GET /api/ai/memory?spaceId=…` | this user's items in this Space | `{ remembered[], planningFigures[], projections[], unreadable[], noLongerUsed[] }` — each with `id, class, inWords, statedAt, saidAs, state`, and `history[]` |
| `PATCH /api/ai/memory/[id]` body `{spaceId, action: "retire"}` | tombstone (§6) | the updated list |
| `DELETE /api/ai/memory/[id]?spaceId=…` | erase the item and its whole chain | the updated list |

**Auth and ownership — the chat route's rule, verbatim** (`app/api/ai/chat/route.ts:81-119`):
- `requireUser()`; rate-limited via `limitByUser`;
- `resolveSpaceContext(user.id, spaceId)` and **403 when the named Space does not come back as itself** — the fallback that is
  right for a stale cookie is wrong here too;
- the scope is `{ spaceId: ctx.spaceId, ownerUserId: user.id }` and **every row lookup carries all three** —
  `where: {id, spaceId, ownerUserId}`. Another member's id is a **404**, never a 403: existence is not disclosed;
- **no `userId` parameter exists on any route**, as none exists on either tool (`memory-tools.ts:33-39`). A Space owner or
  admin cannot list, retire or delete another member's memory. No `SYSTEM_ADMIN` bypass;
- any member who can reach the Space manages **their own** memory, whatever their role;
- routes import **no `db`**. They call new functions in `memory-store.ts` (`listOwnMemories`, `retireMemory`,
  `deleteMemoryChain`), so "the only Prisma model the write path can reach is `SpaceMemory`" (`baseline.test.ts:204-209`)
  stays a one-file claim. `remember` remains the only write *tool*.

### 8.2 Where it lives

**A "Memory" control on the AI page, beside "New chat", opening an overlay panel** — `components/ai/MemoryPanel.tsx`, mounted
from `AnalyzeClient.tsx`'s existing `controls` slot, fetching on open.

- *Why the AI page:* memory is per `(user, Space)` and the AI page is already bound to the active Space
  (`analyze/page.tsx:20`). It is where memory is written and where its effects are felt.
- *Why a panel and not `/dashboard/analyze/memory`:* every path under `/dashboard/analyze` is treated as the fixed-height
  conversation surface (`DashboardChrome.tsx:59` via `space-nav.ts:128`); a sub-route would need chrome changes a peer is
  actively making.
- *Why not Settings:* Settings is a **global** utility destination with a composition registry (`lib/settings/workspaces`)
  that a peer is editing, and memory is per-Space — it would need a Space picker and a registry entry. *Rejected for V2.*
- **Touches no navigation file, no Settings file, no Debt workspace file.**

**Copy.** Title: *"What Fourth Meridian remembers for you in ‹Space›"*. Under it, always: *"These are things you told the
assistant, on the dates shown. They are not your current finances, and nothing here changes any number unless you ask the
assistant to use it."* Sections: **Remembered** (goals, plans, rules, preferences — each as the `inWords` sentence, "You said
this on 20 Sep 2026", **Stop using** · **Delete**) · **Planning figures you gave me — not measured from your accounts** ·
**Projections I made — not things you asked me to remember** · **Couldn't read these reliably** (*saved on ‹date›: "‹their
words›"* · **Delete**) · **No longer used** (collapsed). Delete uses `components/atlas/ConfirmDialog`.

### 8.3 Deliberately not built

Editing in the panel (a form is a second translation of the clause vocabulary; to change something, tell the assistant, or
delete and restate) · creating memory from the panel · "use this now" / "run this" buttons (**they would make memory activate a
scenario**) · household sharing or visibility · export · search, paging (capped at 50) · undo for delete · restoring a retired
item (say it again) · a Settings entry · notifications · any Brief surface change (Agent 1).

---

## 9. B3 — legacy rows

**Principles.** Never guess. Never rewrite. Judge a legacy row against the contract it was written under, **by value**, and
fail closed. `amount: 6` is never reinterpreted as six months — it is simply not rendered as money.

One pure function, `readMemory(row) → Readable | Unreadable`, in the spirit of `readCheckpoint` (`reconcile.ts:139-157`).
**Every reader goes through it — with one stated exception.** A row with `payload.v === 2` is validated by the same function as a write (validate-on-read). The exception is `reconcile.ts`'s `readCheckpoint`, which is held import-free by a source guard (`baseline.test.ts`: "the ledger and the compactor remain pure" — the same rule covers reconcile), so it cannot call `readMemory`. It therefore re-implements the projection reading it needs, fails closed the same way, and now also refuses a conditional projection (§A.7). The guard was not loosened to make this sentence true.
A row with no `v` is legacy:

| Legacy shape | Readable **iff** | Read as |
|---|---|---|
| `INTENTION {targetMetric, targetAmount, byDate}` | `targetMetric ∈ {netWorth, liquid, investments}` · `targetAmount` finite > 0 · `byDate` a real ISO date · **words-consistency** (below) | `GOAL` |
| `INTENTION {intent, amount, label[, earliest]}` | `amount` finite > 0 · `label` passes `Label` (so `monthsOfExpenses` fails) · `intent` a string · **words-consistency** | `PLANNED_EXPENSE` |
| `ASSUMPTION {monthlySpending}` / `{annualReturnPct[, appliesTo]}` | value in type range · **words-consistency** for money | `BASELINE` |
| `CHECKPOINT {metric, horizon, value[, basis]}` | `readCheckpoint` passes · `metric ∈ METRIC_FIELD` · `subject === metric + "-" + horizon` · `statedAs` matches the code template `Projected … (checking plus savings) for …` · `basis` an object holding only the six code-written keys | `PROJECTION` |
| anything else — null values, string `basis`, unknown keys, mixed shapes | — | `Unreadable` |

**Words-consistency — the deterministic discriminator that is not a guess.** A legacy money value is readable only if **the
row's own `statedAs` states that figure** (`extractFigures`, licence tolerance). It interprets nothing: it declines to render a
number the row's own words do not support. Against the observed failures:

| Row | Verdict | Why |
|---|---|---|
| `{amount: 6, label: "months of expenses to keep in cash"}`, "Keep six months of expenses…" | **unreadable** | no money figure 6 in the words |
| `{amount: 0, label: "Keep six months…"}` | **unreadable** | `amount` not > 0 |
| `{targetMetric: "liquid", targetAmount: 26078.88, byDate: null}` | **unreadable** | `byDate` is not a date (43 rows) |
| `{targetMetric: "monthsOfExpenses", targetAmount: 9, byDate: "2030-01-01"}` | **unreadable** | metric outside the legacy enum |
| `{amount: 20000, label: "car"}`, "a car around 20k in 2027" | **readable** | unchanged behaviour |
| `{targetMetric: "netWorth", targetAmount: 1000000, byDate: "2030-12-31"}`, "I want $1M by 2030" | **readable** | unchanged |
| a model-written `CHECKPOINT` of a scenario result (4 observed) | **unreadable** | subject / template / basis do not match the code writer |
| the live `CHECKPOINT liquid-2026-12-31` | **readable** | code-written; `reconcile_projection` additionally reports `restedOn: "USER_STATED"` (§10) |

**Honest limit.** A frozen-dollar row that happens to carry a valid `byDate` *and* whose words quote the dollars — e.g.
`{liquid, 39118.32, "2027-06-30"}`, "…(currently $39,118.32)" — is a structurally valid legacy goal and reads as one. Nothing
at read time can show it was derived, and declaring it malformed would be a guess. It is shown to the user like any goal, with
a delete. (Such rows were written by harnesses on clones; none exists in the live dev data.)

**What happens to an unreadable row.**
- **Hidden from:** the memory line's items, starters, Brief `plans` (through `selectMemoryPlans`, whose signature and return
  type do not change — no edit in `lib/ai/brief/**`), and `reconcile_projection` (reported `unusable`, as it already does).
- **Counted** in the memory line (`unreadable: n`) and returned by `recall` as `{savedOn, saidAs}` only.
- **Shown to the user** in the panel: *Couldn't read this reliably — saved on 20 Sep 2026: "Keep six months of expenses, pay my
  highest-interest cards first, then invest."* · **Delete**.
- **Superseded, non-destructively, only by the user's own later statement** on that subject.
- **No migration touches a row. No status is changed in bulk. Nothing is destroyed.** *Rejected:* a migration marking
  malformed rows `SUPERSEDED` — a guess applied at scale, semantically irreversible, and unnecessary once every reader is
  fail-closed. A read-only `scripts/audit-memory-legacy.ts` reports verdict counts so the lead can see real data before and
  after.

**The conservative failure direction is deliberate.** A legitimate legacy row whose words omit the figure ("user wants a car")
becomes unreadable and costs one re-statement. A wrong row rendered as money costs trust, and in one observed case became
`surplusFraction: 0` in a calculation.

---

## 10. B4 — automatic checkpoints

**Still useful? Yes, narrowly.** "What did you tell me, and were you right?" is the one thing re-fetching cannot reconstruct
(`reconcile.ts:7-17`), and it has three real readers: `reconcile_projection`, the starter "Check my ‹horizon› cash
projection", and the Brief's `nextCheckpoint`. But a projection result is **not a user intention**, and the evidence — 17 of 36
silent checkpoints resting on a conversational $5k, plus the one live row — says today's writer records hypotheticals as
statements.

| Question | Decision | Why |
|---|---|---|
| Does it belong in durable *user* memory? | **Same table, separate class (`PROJECTION`), never in "what the user wants".** | The table's charter is already "what the user decided, **and what we said**" (`schema.prisma:687`). A second table needs a migration and two readers' worth of plumbing to separate things one discriminator already separates. The separation that matters is semantic and is enforced: its own line key (`projectionsOnRecord`, already so), its own `recall` group, its own panel section under **"Projections I made — not things you asked me to remember"**, and it is excluded from every rendering of goals, rules and plans. |
| Should a projection resting on a STATED assumption be recorded? | **No.** `checkpointProjection` returns null when `projection.basis.spending.source === 'USER_STATED'`. | (1) It is a conditional projection — the code's own reason for never checkpointing `scenario_projection`: reconciling it "would measure whether they did what they said, not whether we were right" (`memory-tools.ts:57-61`). `assumedMonthlySpending` makes `project_cash` exactly that. (2) **It is lossy supersession again:** the subject is `liquid-‹horizon›` (`memory-tools.ts:95`), so "project to year end" then "…what if I spend $5k?" *replaces* the evidence-based statement with the hypothetical, and a later "were you right?" grades the hypothetical. |
| …or record it with the basis prominent? | **Rejected.** | It would need a second subject per horizon, exclusion from starters and the Brief, and a reconciliation that by construction cannot measure accuracy — machinery for a number nobody should grade. |
| Can `remember` mint a CHECKPOINT? | **No.** The tool has no `PROJECTION` shape; the store exposes a separate `recordProjection()` that only the turn loop calls. | 4 model-written checkpoints were all scenario results — the thing the product rule forbids. |
| The `basis` free-content hole? | **Closed.** `basis` becomes a closed key set — `spendingSource, dailyRate, monthsAveraged, incomeEvents, openingCash`, plus `userAssumptions` tolerated on legacy rows — written by code only. | `basis.openingCash` is a past balance. It stays, because `diffBasis` needs it to explain a variance, but it is reachable only by the code writer, is dated by `statedAt`, and is rendered nowhere except inside `reconcile_projection`'s own diff. |
| Legacy `USER_STATED` checkpoints (incl. the live one)? | **Readable as-is.** `reconcile_projection` adds `restedOn: "USER_STATED"` and one sentence: the difference reflects that assumption as much as our accuracy. | Nothing hidden, nothing rewritten; the result becomes honest about what it compares. |
| Growth? | One ACTIVE row per horizon, as today; the user can delete any. **No expiry job** — not built. | |

**A hypothetical never silently becomes "what the user wants"** — four independent properties: scenario tools are never
checkpointed (existing guard, `baseline.test.ts:1896-1900`); a `project_cash` run on a stated figure is no longer
checkpointed; `remember` cannot write a projection; and a `GOAL` amount we computed is refused (§7.2).

**Dependency on Agent 5** (owns `project_cash` result shaping): the writer reads `result.retrospective`, `result.horizon.to`,
`result.projection.endingCash`, `result.projection.basis.{openingCash, incomeEventsCounted, spending.{source, dailyRate,
monthsAveraged}}`. It already fails safe (returns null) if any is absent. S2 adds a fixture test of that exact shape so a
reshaping fails a test rather than silently ending checkpoints. **Cross-agent request:** keep `basis.spending.source`.

**Primitive or patch?** *Primitive* — "only an evidence-based statement is a statement" is the rule the code already applies to
scenarios, extended to the one tool that could evade it.

---

## 11. Migration and operational constraints

**This design needs NO schema migration: no enum value, no column, no index, no data migration.**

- The class is a discriminator inside the existing `payload Json`; `RETIRED` already exists in `MemoryStatus`
  (`schema.prisma:733`); retirement time and words are kept by a tombstone row (§6); both existing indexes serve every query.
- Consequently: no `prisma migrate` of any kind, **no `prisma generate`** against the `node_modules` every peer worktree
  shares, no deploy-ordering hazard from `build` not running `migrate deploy`, and no possibility of the non-interactive
  `migrate dev` reset that destroyed the dev database on 2026-09-15.
- **Rollback is a code revert.** V2 rows remain valid JSON under the old code. The old *readers* would mis-render a V2 `RULE`
  through the planned-expense branch (`undefined ~undefined`), so S4 (readers) must not be reverted alone while V2 rows exist —
  noted in §14.

**What is lost by not changing the enum — stated plainly.**
1. **The database cannot constrain or index by class.** `kind` stays coarser than the semantic class (four classes share
   `INTENTION`). Class is enforced in one TypeScript module, not by Postgres.
2. **SQL analytics need a JSON path** (`payload->>'class'`).
3. **The supersession key is `(owner, kind, subject)`, not `(owner, class, subject)`.** Compensated in code: a write whose
   subject already names a different class is refused (§3).
4. **`PREFERENCE` sits under `INTENTION`** ("what the user decided or wants") — a slight stretch of the enum's words.
5. Readers fetch the owner's ACTIVE rows and classify in memory — immaterial at ≤ 50 rows, a real cost at thousands.

**Recommendation: no enum change for V2.** The payload needs the `v` discriminator *regardless* — it is the only way to tell a
legacy `{intent, amount, label}` row from a V2 planned expense — so the class costs nothing extra to carry there, and it buys
an implementation no other agent must coordinate with. Revisit if class-level constraints or analytics become a requirement.

**If the lead prefers enum values anyway** — additive, no row rewritten, hand-applied as this repo requires:

```sql
-- prisma/migrations/<ts>_memory_kind_rule_preference/migration.sql
-- ADDITIVE ONLY. No existing row is read or written. Existing values keep their meaning.
ALTER TYPE "MemoryKind" ADD VALUE IF NOT EXISTS 'RULE';
ALTER TYPE "MemoryKind" ADD VALUE IF NOT EXISTS 'PREFERENCE';
```

Apply with `prisma db execute --file … --schema prisma/schema.prisma`, then `prisma migrate resolve --applied <name>`.
**Never `prisma migrate dev`.** Caveats: a new enum value cannot be *used* in the transaction that adds it, so the file holds
only these statements; `schema.prisma` must change to match and **`prisma generate` must then be run once, by the lead**,
because the generated client is shared across worktrees; and in every environment the SQL must be applied **before** code that
writes the new values deploys, since `build` will not do it. The design is otherwise unchanged (`RULE` and `PREFERENCE` move
out of `INTENTION`; the `v`/`class` discriminator stays for legacy detection). The optional `retiredAt` column
(`ALTER TABLE "SpaceMemory" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3);`) is likewise additive and likewise not needed.

---

## 12. Readers and writers after V2

**Writers**

| # | Writer | Path | Classes | Notes |
|---|---|---|---|---|
| W1 | `remember` tool — `record` / `amend` / `retire` | `memory-tools.ts` → `memory-store.ts:rememberStated` | GOAL, PLANNED_EXPENSE, RULE, BASELINE, PREFERENCE | typed validation + provenance gate; **cannot write PROJECTION**; cannot delete |
| W2 | turn-loop checkpoint | `turn.ts:290` → `memory-tools.ts:checkpointProjection` → `memory-store.ts:recordProjection` | PROJECTION | `project_cash` only, non-retrospective, **`spending.source !== 'USER_STATED'`**, closed `basis` |
| W3 | panel retire | `PATCH /api/ai/memory/[id]` → `retireMemory` | any user class | tombstone row |
| W4 | panel delete | `DELETE /api/ai/memory/[id]` → `deleteMemoryChain` | any, incl. PROJECTION and unreadable | erases the `(owner, kind, subject)` chain |
| W5 | live check | `scripts/ai-baseline/memory-store.check.ts` | all | throwaway users/Space; clone only |

No other writer exists or is added. `memory-store.ts` remains the only file that names `db.spaceMemory`.

**Readers** — every one through `readMemory` and the single `stateOf`:

| # | Reader | GOAL | PLANNED_EXPENSE | RULE | BASELINE | PREFERENCE | PROJECTION | legacy readable | legacy unreadable |
|---|---|---|---|---|---|---|---|---|---|
| R1 | memory line (`evidence.ts`) | fields | fields | literal clause | `planningAssumptions`, STATED, stale flag | topic + note | count + horizons | as its mapped class | **count only** |
| R2 | `recall` | `inWords` + fields | same | same | same | same | `projectionsWeMade` | as mapped class | `{savedOn, saidAs}` |
| R3 | starters (`analyze/page.tsx` → `selectStarterTopics`) | chip (debt-free wording for `debt`) | chip | — | never | never | nearest future `liquid` horizon, topic only | as mapped class | **hidden** |
| R4 | Brief `plans` (`brief/load.ts` → `package.ts` → `selectMemoryPlans`) | dated goals only (type unchanged) | yes | — | never | never | `nextCheckpoint` topic | as mapped class | **hidden** |
| R5 | `reconcile_projection` | — | — | — | — | — | reconciled; `restedOn` reported | code-written: reconciled | `unusable` |
| R6 | Brief watermark (`watermark.ts`) | counts rows / ACTIVE rows / `max(createdAt)` — class-blind, **unchanged**; moves on record, amend, retire, delete | | | | | | | |
| R7 | Memory panel (`GET /api/ai/memory`) | sentence | sentence | sentence | own section | sentence | own section | as mapped class | **own section, words + delete** |

`RULE`, `BASELINE` and `PREFERENCE` deliberately have **no** starter and **no** Brief presence in V2: a starter that ran a rule
would be one click from memory activating a scenario, and a Brief naming a rule is Agent 1's decision. Open-ended goals (no
`byDate`) are omitted from `selectMemoryPlans` so `PlanGoal.byDate: string` does not change under Agent 1.

Known, unchanged: `analyze/page.tsx` and `brief/load.ts` read `limit: 50` across kinds, so a user with many projection
horizons could crowd out goals. S4 splits the page's read by kind; the Brief's loader is Agent 1's.

---

## 13. Test plan

Layers: **U** pure unit (`memory-model.test.ts`, `stated-figures.test.ts`, `starter-topics.test.ts`) · **S** source-scan guard
(`scripts/ai-baseline/baseline.test.ts`) · **L** live DB check on the clone (`memory-store.check.ts`) · **M** model-sampled on
the clone through `tmp/postm1/harness.ts` — production path, **all tools**, n = 8 per case, distributions reported, never a
rate under n = 5.

| # | Case | Layer | Assertion |
|---|---|---|---|
| 1 | remember a six-month expense rule | U, L, M | U: the rule validates; ~~**no money key is admissible in it**~~ **a dollar floor is admissible only on positive user evidence, and is otherwise refused naming the months field** (R2). L: stored under `INTENTION`, `class RULE`. M: 8× "From now on keep six months of expenses in cash. Remember that." → stored rows hold `liquidFloorMonthsOfExpenses: 6`; **0 rows hold a dollar figure** (today 8/8 frozen); rejection rate reported |
| 2 | the expense baseline changes later | U, S | U: `composeMemoryLine` and `describeMemory` output for the rule is byte-identical under any baseline — nothing in the row can move because nothing in it is a level. S: the store does not import the measures layer |
| 3 | a fresh chat recalls the semantic rule, not frozen dollars | U, M | U: the line carries the literal clause and no money. M: fresh chat, "What strategy did I want?" → answer states months, not a dollar floor as the rule (a priced figure is acceptable only if it came from a tool call in that turn) |
| 4 | remember a $5k planning baseline | U, L, M | L: a standalone `BASELINE` persists (the anchor check is replaced). M: 8× "Use $5k/month as my spending assumption. Remember that." → stored 8/8 (today 0/10) |
| 5 | a fresh chat distinguishes remembered assumption from observed spending | U, M | U: it renders under `planningAssumptions` with `basis: "STATED"`; with none remembered the line says so. M: fresh "What spending assumption were we using?" → names the remembered $5,000 as the user's figure; fresh "How much do I spend a month?" → **measured**, from `measure_flows`/`get_baselines`, with the $5k at most mentioned as a planning figure |
| 6 | strategy: floor + highest APR + invest | U, L, M | U: the three-field rule validates; the parity test passes. M: the first-message directive followed by "remember that strategy" → one `RULE` row with all three fields |
| 7 | six → nine changes the floor only | U, L, M | U: `amend` merge keeps `fractionOfExcess` and `target`; exclusive groups swap. L: new row, prior `SUPERSEDED`, chain intact. M: seeded rule, "Actually make it nine months" → active row has 9 **and** the original `target` (today: ordering lost) |
| 8 | "stop doing that" / supersession | U, L, M | L: tombstone row; prior `RETIRED`; no reader returns it; a re-statement supersedes the tombstone. U: a `record` that would drop a field is refused without `replace: true`, and echoes `dropped` with it. M: seeded rule, "Stop doing that." → retired 8/8 reported |
| 9 | malformed null values rejected | U | `byDate: null`, `targetAmount: null`, `amount: null`, `""`, NaN → refused, each with a teaching `expected` |
| 10 | zero placeholders rejected | U | `amount: 0`, `surplusFraction: 0`, `liquidFloorMonthsOfExpenses: 0` → refused; `GOAL {debt, 0}` accepted (debt-free) and **only** that |
| 11 | a derived scenario result cannot masquerade as a goal | U, M | U: gate refuses a value present in tool numbers / assistant text and absent from user text; accepts the user's "$1M"; accepts a value found nowhere; rounding honoured both ways. M: seeded assistant prose quoting a projected net worth, "Remember this as my goal." → 0 stored goals carrying the projected figure |
| 12 | memory does not automatically activate a scenario | S, M | S: no `findTool(` and no scenario import in the memory files; `captureActiveScenario` ignores `remember`/`recall`; `recallMemories(` appears once in `tools.ts`. M: seeded rule, fresh "What will my cash be next June?" → count of turns that ran a scenario carrying the remembered clause without being asked; **target 0/8**, a failure here is a design finding (§16.5) |
| 13 | "run my remembered strategy" explicitly computes | M | fresh "Run my remembered strategy through next June." → `scenario_projection` with `liquidFloorMonthsOfExpenses: 6` and the ordered `target`; with a remembered baseline, `assumedMonthlySpending: 5000`; the tool echo shows both. Report floor-kept k/8 separately — the G5 stock→flow substitution is Agent 3's echo check, not a memory defect |
| 14 | stale / superseded memory excluded | U | `stateOf`: SUPERSEDED, RETIRED, `appliesTo` passed, `byDate` passed, `NOT_YET` → absent from line, starters, plans; a 181-day-old `BASELINE` → present with `stale: true` |
| 15 | the user can inspect and retire | U, L | route handlers with an injected store: scope on every query; another member's id → 404; named-Space mismatch → 403; retire → tombstone; delete → chain gone; no `userId` parameter; routes import no `db` |
| + | legacy (B3) | U | every row in `tmp/inv/out/written-memories.json` plus the distinct stored trace shapes classified: the §9 table holds row for row; **none renders as money**; the two legitimate examples still render |
| + | checkpoints (B4) | U, S | fixture `project_cash` results: OBSERVED → recorded with closed `basis`; USER_STATED → **not** recorded; retrospective → not; a model-supplied projection shape → refused |
| + | budget | U | line ≤ 900 B typical, ≤ 2,000 B capped worst case |

**Model budget:** A (cases 1, 3, 13): 3 turns × 8 = 24 · B (4, 5): 3 × 8 = 24 · C (7, 8, seeded by the store): 2 × 8 = 16 ·
D (11): 8 · E (12): 8 → **80 turns**. **Headline metrics against today:** rejection rate (44%), faithful stored rows (0/90),
coerced-after-rejection rows (32/45), fresh-chat $5k carry (2/21).

---

## 14. Implementation plan — ordered, independently committable

| Slice | What becomes true | Files | Overlap |
|---|---|---|---|
| **S1 — the model (pure)** | classes, field types, `validateStated`, `mergeAmend`, `readMemory` (incl. legacy), `stateOf`, `describeMemory`, `composeMemoryLine`, refusal builder. **No behaviour change**: nothing imports it yet. | `lib/ai/conversation/memory-model.ts` (new) · `memory-model.test.ts` (new) · parity checks appended to `scripts/ai-baseline/baseline.test.ts` | reads Agent 3's exported schema in a test only |
| **S2 — checkpoints (B4)** | a projection on a stated figure is not recorded; `basis` is closed; `recordProjection` is a separate store entry point; `reconcile_projection` reads via `readMemory` and reports `restedOn` | `memory-tools.ts` · `memory-store.ts` · `reconcile.ts` · `tools.ts` (the `reconcile_projection` block, `:2926-3036`, only) · `baseline.test.ts` §20a (checks **added**) | **Agent 5**: depends on `project_cash`'s `basis.spending.source` (fixture test) |
| **S3 — the write path** | `remember` takes typed shapes and `op`; provenance gate; class-aware supersession; drop-guard; tombstone retire; the anchor rule is gone; `remember` cannot mint a CHECKPOINT | `memory-store.ts` · `memory-tools.ts` · `stated-figures.ts` (new) + test · `tools.ts` (`ToolContext.turn` — a type, `:116-121`) · `turn.ts` (build the turn evidence, ≈15 lines near `:239`) · `baseline.test.ts` §19 · `scripts/ai-baseline/memory-store.check.ts` | **Agent 3** may also touch `turn.ts` (scenario capture) — adjacent lines, separate concern. **Agent E**: `remember`'s schema grows ≈1.2 KB. Imports `extractFigures` from **Agent 1's** `lib/ai/brief/licence.ts` (read-only; see requests) |
| **S4 — the readers** | the line is `composeMemoryLine`; starters and plans read through `readMemory`; one `stateOf`; debt-free chip wording; the page reads by kind | `evidence.ts` · `starter-topics.ts` · `starter-topics.test.ts` · `app/(shell)/dashboard/analyze/page.tsx` · `baseline.test.ts` §19a | none in `lib/ai/brief/**` — `selectMemoryPlans`' signature and return type are frozen. **Ship S3 and S4 together or S4 first**: a V2 row must never meet a V1 reader |
| **S5 — the user's surface** | list / retire / delete; the panel | `app/api/ai/memory/route.ts`, `app/api/ai/memory/[id]/route.ts` (+ tests) · `components/ai/MemoryPanel.tsx` (new) · `components/dashboard/AnalyzeClient.tsx` (one control) · `components/ai/ai.test.ts` · `memory-store.ts` (`listOwnMemories`, `retireMemory`, `deleteMemoryChain`) | touches no nav, Settings or Debt file |
| **S6 — acceptance** | the §13 M cases and the legacy audit | `scripts/ai-baseline/memory-v2.check.ts` (new, clone-guarded) · `scripts/audit-memory-legacy.ts` (new, read-only) · harness case files under `tmp/` (untracked) | model budget ≈ 80 turns |
| **S7 — PREFERENCE** | the fifth stated class is exposed in the tool, the line and the panel | `memory-model.ts` (defined in S1; enabled here) · `memory-tools.ts` | last, because it is the least evidenced (0/5 attempts) and the only free-text class |

**Guards that will change — declared now, none loosened:**
- `baseline.test.ts:1690-1709` — the three "an INTENTION holds… / …or a planned outlay / an ASSUMPTION carries…" checks assert
  V1 shapes are *writable*. They become: V2 shapes are writable; V1 shapes are refused on write and still readable through
  `readMemory`. The forbidden-balance-key loop (`:1681-1685`) and the CHECKPOINT-needs-a-horizon check stay as they are.
- `baseline.test.ts:1762-1799` — six regexes pin `memoryLine`'s source text. They are replaced by **behavioural** tests that
  call the pure `composeMemoryLine` (no balance can appear; bounded per section; ACTIVE and in-force only; speaks for all of
  memory; the empty state names `remember`). The scope regex (`memoryLine(spaceId, ctx.userId)`) and the "system instruction
  says nothing about memory" checks stay.
- `memory-store.check.ts` — the assumption-attachment check is replaced by "a standalone BASELINE persists" and "the tool path
  refuses a PROJECTION".
- **Unchanged and still passing:** exactly one write-verb tool and it is `remember` (`:187-190`); the store names only
  `db.spaceMemory` (`:204-209`); `tools.ts` holds no Prisma client; neither memory tool takes a user id.

**Explicitly out of scope:** a conversation-assumption store (same-chat assumptions work 169/169); any router, intent parser,
tool gate or system-instruction change; any change to `SCENARIO_INPUTS`, the ledger, `measure_flows` or `get_baselines`; G5 /
G6 (Agent 3); any file under `lib/ai/brief/**`; `monthlyIncome` baselines and planned inflows (I1); household sharing;
`TESTIMONY`; panel editing; a Settings entry; expiry jobs; any migration.

**Cross-agent requests.**
1. **Agent 1 / lead:** `extractFigures` is a pure, import-free figure reader living in `lib/ai/brief/licence.ts`. S3 imports it
   read-only. If the lead prefers no `conversation → brief` import, hoist it unchanged to a neutral module
   (`lib/ai/figures.ts`) and re-export it from `licence.ts`.
2. **Agent 1 (optional, later):** opt the Brief into open-ended goals and debt-free goals by widening `PlanGoal`; nothing in V2
   requires it.
3. **Agent 3:** treat the parity test as a contract — a renamed or removed contribution field is a memory-visible change. When
   I1 adds `incomeChanges`, decide then whether it is a rememberable clause; V2 does not admit it.
4. **Agent 5:** keep `projection.basis.spending.source` (`'USER_STATED' | 'OBSERVED' | 'NONE'`) on `project_cash`.
5. **Agent E:** `remember`'s schema grows ≈ 1.2 KB; the `rule` sub-schema describes its fields in one line ("the same fields,
   with the same meanings, as a `contributions` item") rather than repeating them.

---

## 15. Primitive or patch?

| Abstraction | Verdict | Reasoning |
|---|---|---|
| semantic classes as a versioned payload discriminator | **primitive** | each class has a distinct lifecycle, reader set or validation (§1); none is named after a question |
| a `RULE` stored in the scenario contract's vocabulary | **primitive** | semantic identity survives storage; no six, no $5k; any future clause Agent 3 adds is one table row |
| the floor-alone exception | **primitive, watch it** | it follows from "never invent what the user did not say"; it is also the one place memory admits something the ledger would refuse, so it is tested as such |
| field-wise `amend`, row-per-version | **primitive** | one merge function for every class |
| the drop-guard (`replace: true`) | **primitive** | "supersession never silently drops a field" — class-independent |
| `BASELINE` with a code-stamped basis | **primitive** | a slot for any measure a tool takes as an explicit echoed argument; the admissibility rule is general |
| typed fields (`Money`, `Months`, `Fraction`…) | **primitive** | units in the type; the closed-payload invariant finishing its own job |
| the provenance gate | **primitive, with a known heuristic edge** | one statement for every money field; the word-number grammar is the part closest to a patch and is confined to *reducing false refusals* — it can never admit a figure that is ours |
| teaching refusals + the synonym table | **diagnostics, not contract** | it changes messages only and never what is accepted; if it ever coerces, it has become a patch |
| tombstone retirement | **primitive** | reuses the chain; no new concept in the schema |
| `readMemory` + words-consistency for legacy rows | **primitive** | fail-closed read, the `readCheckpoint` pattern generalised; the consistency rule is deterministic and interprets nothing |
| not recording a `USER_STATED` projection | **primitive** | the existing scenario rule, applied uniformly |
| `PREFERENCE` | **weakest — provisional** | real semantics but zero observed demand; shipped last, figure-free, never translated to arguments; cut it if the review disagrees |
| the Memory panel | **product surface**, not an abstraction | the minimum that makes durable memory defensible (G15) |

---

## 16. How this design could still fail

1. **The model may still store dollars where a multiplier was meant.** The gate catches `liquidFloor: 26078.88` and
   `liquidFloor: 30000` when the figure exists in our results or our prose. It does **not** catch a figure the model computes
   silently inside the `remember` call and that appears nowhere else. The traces suggest this is rare; it is not impossible.
2. **Word-numbers.** "Remember my goal is a million" after the assistant wrote "$1,000,000" is a false refusal if the
   user-side grammar misses the phrase. It is recoverable in one turn ("say the number"), but it is friction the user did not
   earn, and word-number parsing is where this codebase has been bitten before (`$5K` read as `$5.00`; guard false positives).
3. **An adopted figure.** "Yes — make *that* my goal" about a projected net worth is refused, by design: the user never stated
   it. Some users will find that pedantic. I hold it is right — a goal should be a number the user said — but it is a product
   judgement made inside a validator.
4. **Derived *dates* are not gated.** `byDate: "2035-02-28"` taken from a crossing passes; "by 2030" against "in five years"
   cannot be checked without parsing language. Making `byDate` optional removes the pressure to invent one; it does not remove
   the failure.
5. **Showing the literal clause on every request may prime auto-application.** The line says nothing is in effect, but a model
   that sees `liquidFloorMonthsOfExpenses: 6` may run it for "what will June look like?". Case 12 measures this. If it fails,
   the fallback is to show rules in the line as subject + one sentence and the literal clause only in `recall` — trading a
   more reliable boundary for a less faithful fresh-chat translation.
6. **Memory cannot make the scenario faithful.** A perfectly stored floor can still be run as `surplusFraction: 1` (G5: 2/8
   short, 5/8 long). This design makes the rule explicit and copyable; the echo-contradiction check is Agent 3's. Until it
   lands, "run my remembered strategy" can still narrate a floor that did not run.
7. **One tool, three operations.** `remember` with `op` keeps "exactly one write tool" true, but fresh-chat "forget the
   six-month rule; use nine" produced a write in only 1/4 today. If `amend` / `retire` are not discovered from the description,
   the fix is measurement and wording, not a second tool — and that must itself be measured rather than assumed.
8. **`replace: true` may become a reflex.** A model refused for dropping a field may retry with `replace: true` rather than
   `amend`. The loss is then explicit and echoed, which beats today, but it is still a loss. Report the rate.
9. **Words-consistency will hide some legitimate legacy rows** whose `statedAs` paraphrased without the figure. Deliberately
   conservative; it costs those users a re-statement, and only the panel tells them why.
10. **Structurally valid frozen legacy goals still read as goals** (§9, honest limit). Only the user can remove them.
11. **No database constraint on class** (§11). A future writer that bypasses `memory-store.ts` could store anything in
    `payload`; the source-scan guard is the only fence.
12. **`PREFERENCE.note` is model-authored prose on every request.** Bounded, figure-free and user-owned — but it is the one
    free-text channel, and a rule can be smuggled into it as words ("prefers keeping six months of expenses"). Nothing false is
    stored, but structure is lost silently.
13. **`statedAs` is the model's paraphrase, not a transcript.** The panel says "you said" over words the assistant wrote. I
    considered storing the user's verbatim message instead; "Remember this." is the verbatim message in the most common case
    and carries nothing. The copy may need to be "noted as".
14. **The provenance gate trusts user-role text that came from a browser.** A user can spoof their own history to store a
    derived figure. They can only deceive their own memory, so this is accepted rather than defended.
15. **Two people, one Space.** Each member has their own rule; the assistant runs the asker's. A household with conflicting
    strategies gets no reconciliation — out of scope, and a real product question.
16. **The remembered baseline depends on M1 wording it does not own.** If the model declines to pass a remembered figure as
    `statedMonthlySpending` because that argument is described as stated "in this conversation", case 5/13 will show it, and
    the remedy is a lead decision on closed M1 text — not something this design may do.
17. **Tombstones and versions grow the table** without bound. At human scale this is nothing; there is deliberately no
    retention policy, and one may eventually be needed.
