# Conversation state, memory and orchestration after M1 — investigation

**Date:** 2026-09-20 · **Investigation only. No production code, prompt, tool description, schema or test changed. Nothing committed.**
Authority: `d056898` (M1, HEAD of `v2.6`), parent `c357660` (Debt Overview, a peer commit that landed between M1's acceptance runs and its commit).
Evidence lives under `tmp/inv/` (gitignored): `harness.ts`, `analyze.py`, `det.ts`, `brief-package.ts`, `brief-input-hash.ts`, `render-memories.ts`, `cases-*.json`, and every trace in `tmp/inv/out/*.jsonl`.

> **How this was run, and why it differs from the M1 dogfood.** Every model run executed against a **throwaway clone** of the dev
> database (`fintracker_m1inv`, plus four worker copies and one later snapshot). The harness refuses to start unless both the
> connection URL and the server's `current_database()` name a clone. This was necessary, not cautious: the turn loop has **two**
> durable write paths into `SpaceMemory` — the `remember` tool and a silent `CHECKPOINT` written on every `project_cash` call
> (`turn.ts:290` → `memory-tools.ts:66`) — so withholding a tool is not isolation. Live memory was verified unchanged before and
> after (1 row, `createdAt 2026-09-20 11:52:25.698`, written by real product use, not by any harness).
>
> The primary arm is the **production path**: `runStatelessTurn` (`engine.ts:171`), which rebuilds every request from prose-only
> history plus a restored scenario. The M1 dogfood used an in-process transcript that kept two turns of raw tool results and
> withheld `remember`. Production does neither. Several M1 dogfood conclusions do not survive that correction (§9, §17).

---

## 1. Executive verdict

**M1 remains CLOSED. I1 is READY, with one condition (G5). Four of the five concerns that prompted this investigation were
produced by the M1 dogfood harness, not by the runtime — and the investigation found a different, larger set of defects that the
M1 dogfood could not see.**

1. **The "directive turns skip tools" finding was not a defect, and is not real in production.** On the production path the
   directive got a grounded tool call in **64/64** runs. The M1 harness withheld `remember`; withholding it produces zero-tool
   turns **8/8**, restoring it **0/8** (§14). A directive that asks no question is correctly met with a grounded acknowledgement
   (28/40) or a projection (12/40); the follow-up that *does* ask for computation computed **24/24**.
2. **The $5k "3/4" and the "make it nine" prose multiplication do not reproduce.** Same-chat, the stated figure reached every
   compute call: **169/169**. "Make it nine months" went through `get_baselines([9])` **8/8**. Production's statelessness — no
   tool result survives a turn — is what makes follow-ups deterministic; the M1 harness kept results in context, so the model
   extended them by hand.
3. **The real defect is durable memory's contract.** It cannot represent a rule, a multiplier or a basis. Of 161 `remember`
   calls, 71 were rejected and **none of the 90 stored rows holds the rule faithfully**: 56 froze a derived dollar figure, 27
   pushed a month count or a zero placeholder through a money field, 4 were scenario results the model wrote as checkpoints. The
   product renders the result as the AI-page chip *"Can I afford monthsOfExpenses (~$6)?"*, and one placeholder became
   `surplusFraction: 0` in a fresh-chat scenario. "Remember that I use $5k" is refused 10/10; after "remember this", a fresh chat
   carried the $5k in **2/21**.
4. **The active scenario is sufficient for the role a "conversation-assumption slot" was proposed for — once it exists.** Floor
   kept 14/14 when the envelope held it; 0/6 when an earlier run had dropped it; 2/7 when the rule had lived only in prose for
   eight turns. The gap is *when the envelope is established* and that a stock rule can be compiled to a flow rule under a label
   that says otherwise (2/8 short, 5/8 long).
5. **Daily Brief.** None of the golden failures is attributable to M1: the system prompt and all 17 golden inputs are
   byte-identical before and after it. The production debt case is a separate, real, three-layer defect: CRITICAL is
   mathematically correct (weighted APR 25.16% > 22) but is a rate-only rule with no materiality floor, presented as debt
   health, handed to the model as a bare label it is told to explain — and freshness is one global block, so Schwab was attached
   to a claim Schwab does not touch.
6. **The three old live-check failures are stale fixtures and one stale assumption, not regressions.** The 19-tool surface is a
   cost (54% of it is one block repeated three times), not a routing problem.

No production code, prompt, tool description, schema or test was changed. Live financial data and live memory were not mutated.

---

## 2. Current runtime map

One production turn, end to end. Every arrow is a function that exists today.

```
browser  POST /api/ai/chat  { spaceId, messages:[{role,content}…] }          AnalyzeClient.tsx:227
  → requireUser, rate limit 30/min                                             route.ts:81-87
  → readChatRequest: roles ∈ {user,assistant} only, ≤80 turns, ≤160k chars     request.ts:73-112
  → resolveSpaceContext + 403 on named-Space mismatch                          route.ts:113-119
  → openRuntimeState(cookie fm_ai_state, {userId, spaceId, tail})              route.ts:130, runtime-state.ts:134
  → runStatelessTurn                                                           engine.ts:171
      openTranscript  — REBUILT EVERY REQUEST                                  engine.ts:89
        assembleFullContext (accounts, transactions 90d, snapshots, holdings)
        buildEvidence A2 = FINANCIAL ORIENTATION: thin core + coverage + MEMORY LINE   evidence.ts:323
        system = SYSTEM_INSTRUCTION + "Today is <date>"                        turn.ts:56
        toolSchemas = all 19 tools, always                                     tools.ts openAiToolSchemas()
      replayHistory — PROSE ONLY; tool calls/results never existed client-side engine.ts:130
      slot = restored scenario (or empty)                                      engine.ts:195
      executeTurn                                                              turn.ts:185
        injectScenario → trailing `system` message "ACTIVE SCENARIO …"         active-scenario.ts:250
        loop ≤6 hops: model → tool calls → JSON results appended               turn.ts:244
          per tool result:
            checkpointProjection  (project_cash only → SpaceMemory CHECKPOINT, silent)   turn.ts:290
            captureActiveScenario (scenario_projection | scenario_crossing-with-assumptions
                                   → REPLACE | CLEAR | IGNORE)                 turn.ts:298
  → response { message, knowledgeGaps? }  — prose only                         route.ts:156
  → re-seal scenario against the NEW tail; Set-Cookie (2h, HttpOnly, path-scoped)  route.ts:166-175
browser  appends {user, assistant} prose to localStorage (24h, key user+space) transcript-cache.ts
```

Facts that matter for everything below:

- **Production is stateless per turn.** Nothing about a conversation is stored server-side; there is no Conversation model
  (`route.ts:27-31`, asserted by `route.test.ts:118`). The client holds prose only.
- **Tool results never survive a turn in production.** `compactToolHistory` has no production caller (only
  `scripts/ai-baseline/run.ts`, `interactive.ts`). The next turn sees what the assistant *said*, the orientation, and the
  scenario envelope — nothing else.
- **All 19 tools are exposed on every turn** (47,559 B of schema). There is no router, gate or per-turn selection.
- **There is exactly one conversation per (user, Space).** "New chat" clears the client transcript and its hint cookie
  (`AnalyzeClient.tsx:195`); it deliberately does not touch the scenario cookie, because a new chat's tail digest is `''` and
  can match no seal ever issued (`runtime-state.ts:65-73`). There is **no spin-off / fork concept** anywhere in the product.
- **Memory is injected, not retrieved on demand.** The orientation's memory line lists ACTIVE `INTENTION`s (subject + a
  rendered target) and `CHECKPOINT` horizons on every request (`evidence.ts:263-302`). `ASSUMPTION` rows are not in it.
- **There is no UI or API to view, edit or delete a memory row.** The only mutation is supersession, and only if the model
  chooses to call `remember` (`memory-store.ts:131,197`).

## 3. Authority and state-lifetime table

Actual implementation first; the intended semantics are the last column.

| Channel | What it actually is | Lifetime | Survives new chat | Can reach a calculation | Model-visible | User-visible | Goes stale? | Superseded by | Intended role |
|---|---|---|---|---|---|---|---|---|---|
| **FINANCIAL DATA** | Postgres via assemblers and the 17 read/compute tools; re-read every turn | durable | yes | **is** the calculation input | via orientation + tool results | yes (whole product) | yes, per source; disclosed by `get_financial_snapshot`, M1 completeness, Brief freshness | the next sync | current truth |
| **CONVERSATION TRANSCRIPT** | `{role, content}` prose in browser localStorage, replayed each request | 24 h / until New chat / sign-out | **no** | only if the model re-types a number into a tool argument | yes | yes | yes — a figure quoted three turns ago is still "said" | nothing; it only grows | current assumptions and context |
| **CURRENT-TURN ASSUMPTIONS** | **No object exists.** A stated figure ("use $5k") lives as transcript text, or as a tool *argument* for one call (`statedMonthlySpending`, `assumedMonthlySpending`) | one tool call | no | yes, for that call | only as prose afterwards | only as prose | n/a | the next tool call's arguments | — (this is the gap examined in §7) |
| **ACTIVE SCENARIO** | `{assumptions: <verbatim tool args>, result: 6 numbers}`; AES-GCM cookie bound to user + Space + last-assistant digest, ≤3,000 chars, 2 h | until replaced, cleared by a failed scenario, 2 h, or a new chat | **no** (by design) | yes — the model re-sends the arguments; code does not apply them | yes (trailing `system` message) | no | yes — `result` is a snapshot of one run; the envelope never re-computes | the next successful `scenario_projection` / assumption-bearing `scenario_crossing` | the one hypothetical under discussion |
| **DURABLE MEMORY** | `SpaceMemory` rows, user-owned within a Space; closed payload key set per kind (`memory-store.ts:55`) | until superseded (never deleted) | **yes** | **no code path** reads it into a calculation except `reconcile_projection` (checkpoints). Only via the model re-typing it | yes — memory line every turn + `recall` | **barely**: AI-page starter chips and the Brief's `plans` block; no list, no delete | yes — nothing expires an intention | a later `remember` on the same (kind, subject) | prior intentions, goals, decisions, checkpoints |
| **TOOL RESULTS** | JSON in the server-side `messages` array | **one request** in production | no | yes, within the turn | yes, within the turn | no (prose only reaches the client) | n/a | — | evidence for this answer |

Two structural properties hold today and should be kept: **no tool reads memory into a money calculation**, and **no
memory payload can hold a balance by key name**. One does not hold: the `amount` / `targetAmount` keys accept any number, so a
*derived* figure can be frozen into memory (§5).

## 4. Semantic turn taxonomy — used ONLY for evaluation

These ten classes are evaluation labels. Nothing below recommends making them production intents, and §16 explains why none is needed.
Production path, all 19 tools, gpt-5.1, empty memory at the start of each run, n = 5–8 per row (n = 40 for the isolated directive).

| # | Class / prompt | Financial read | Deterministic compute | Memory write | Scenario slot | What the runtime did | Correct contract |
|---|---|---|---|---|---|---|---|
| 1 | FACT — "How much did I spend last month?" | 5/5 `measure_flows` | — | 0 | — | exact | read required; nothing persists |
| 2 | INTERPRETIVE — "Am I spending more?" | 5/5 `measure_flows` (+compare) | — | 0 | — | exact | read + comparison required |
| 3 | IMMEDIATE SCENARIO — "What happens if I keep six months of expenses and invest the rest?" | 5/5 | 5/5 `scenario_projection`, semantic floor 5/5 | 0 | REPLACE 5/5 | exact | compute required; slot set; no memory |
| 4 | DIRECTIVE — "Keep six months of expenses, pay my highest-interest cards first, then invest." | **40/40** | 12/40 ran a scenario; 28/40 read baselines/snapshot only | tried 16/40, **stored 6/40** | set 12/40 | grounded acknowledgement or a projection — never a bare ack, never zero tools | see §9: read is enough; compute is optional; memory should be *offered*, not assumed |
| 5 | CONVERSATION ASSUMPTION — "Use $5k instead." | 39/39 `get_baselines(statedMonthlySpending: 5000)` | — | 0 (when asked to remember: **rejected 10/10**) | — | recomputed every derived figure in code | read required; **must not** become durable unless asked |
| 6 | FOLLOW-UP MUTATION — "Make it nine months." | 15/16 `get_baselines([9])` | — | superseded 7/8 when six had been remembered | unchanged | deterministic threshold 39,118.32 | read required; identity must survive (it does, as a tool argument; it does not, in memory — §8) |
| 7 | FOLLOW-UP EVALUATION — "What does that look like by next June?" | 24/24 | **24/24** | 0 | REPLACE 23/24 | computed every time | compute **required** — the strict class |
| 8 | DURABLE INTENTION — "From now on I want to keep six months of expenses in cash." | 5/5 | 0 | **5/5, all as frozen dollars** (`targetAmount: 26078.88`) | — | right instinct, wrong representation | memory write, holding the *rule* |
| 9 | PREFERENCE — "I prefer keeping more cash than most people." | 0/5 | 0 | **0/5** | — | conversational; nothing stored | a durable preference is reasonable; **no memory kind can hold one** |
| 10 | CORRECTION — "Actually, don't do six months anymore. Use nine." | 7/10 | 0 | **10/10**, exactly one ACTIVE row after | — | supersession mechanics correct (15/15 incl. fresh chat) | supersede; the *new* row must not lose what the old one held (it does — §5) |

**Can the architecture distinguish these without an intent taxonomy? Yes — the model already does.** Class 1/2/3/7 routed to
the right deterministic tool 39/39. "Remember that I want six months cash" wrote memory and ran **no** projection (5/5);
"For this scenario use six months" wrote **no** memory (10/10). The distinctions the brief asked about are made correctly by
tool selection alone. What fails is never the *classification*; it is the **representation available after the class is
recognised** (memory) and one **silent substitution** inside the compute class (§9).

## 5. Memory vs conversation vs scenario — findings

Fifteen questions, answered from code and from 161 observed `remember` calls.

1. **What causes `remember` today?** The model choosing the tool, nudged by two pieces of text: the tool description ("Use it
   when they state a goal… a plan… or when they change one") and — only while memory is empty — the orientation's memory-line
   note: *"When they state a goal, a plan, or a change of mind, record it with `remember`"* (`evidence.ts:271`). Separately,
   **code** writes a `CHECKPOINT` silently on every non-retrospective `project_cash` result (`memory-tools.ts:66`): 36 of 600
   turns, 17 of them resting on a user-stated $5k that was never meant to be durable.
2. **Who decides?** The model decides *whether* and *what*; code decides *if it is admissible* (closed top-level key set,
   required key groups, the ASSUMPTION-needs-an-anchor rule). Code does not classify.
3. **What memory type does the directive create?** `INTENTION` — there is no other candidate — and **it does not fit**. The two
   admissible shapes are `{targetMetric, targetAmount, byDate}` and `{intent, amount, label}`; both **require a number**. A rule
   has none. Of 161 calls, **71 were rejected** (32 for rule-shaped keys such as `monthsOfExpenses`, `allocationOrder`,
   `bufferRule`, `priorityOrder`; 29 for a missing required key; 10 unanchored assumptions). The 90 that were stored:

   | What was stored | Count | Example |
   |---|---|---|
   | derived dollars frozen into a target | 45 | `{targetMetric:"liquid", targetAmount:26078.88, byDate:null}` |
   | derived dollars frozen into `amount` | 11 | `{label:"Keep $30k cash, then pay highest-APR debt…", amount:30000}` |
   | a month count in the **money** field | 16 | `{label:"monthsOfExpenses", amount:6}` |
   | a zero placeholder to satisfy the schema | 11 | `{intent:"allocation-rule", amount:0, label:"Keep six months…"}` |
   | months smuggled through free-text `targetMetric` | 3 | `{targetMetric:"monthsOfExpenses", targetAmount:9, byDate:"2030-01-01"}` |
   | a **scenario result** written as a CHECKPOINT by the model | 4 | `{metric:"net-worth", horizon:"2027-06-30", value:88617.84, basis:{surplusRule…}}` |

   **Not one stored row represents the rule within the schema's meaning.** 43 stored targets carry `byDate: null` — validation
   checks that the *key* is present, not that it has a value. `CHECKPOINT.basis` and `targetMetric` are unvalidated free
   content. One run stored a projected net worth as the user's **goal** (`{targetMetric:"netWorth", targetAmount:271433.64,
   byDate:"2029-09-30"}`).
4. **Does writing memory establish an active scenario?** No. `captureActiveScenario` returns `IGNORE` for every tool except
   `scenario_projection` and an assumption-bearing `scenario_crossing`. The two stores never touch.
5. **Should it?** No. A remembered intention is a statement about what the user wants; a scenario is a computed pair. Coupling
   them would make every remembered sentence a calculation.
6. **What happens in a new chat?** The memory line renders each ACTIVE intention as `${label} ~${amount}` or
   `${targetAmount} ${targetMetric} by ${byDate}` on every request. "What was the strategy I wanted?" was restated correctly
   from that line in 9/10 runs when an intention was on record. With nothing on record the model said so in 5/6 and invented one in 1/6.
7. **Does a remembered strategy automatically become a calculation assumption?** **No code path does this** — and that
   property should be kept. But the *model* does it: "Run my strategy through next June" in a fresh chat ran a scenario in
   7/8 runs from the memory line alone. The placeholder problem then becomes a money problem: a row stored as
   `{…label:"…then invest", amount:0}` rendered as *"…then invest ~0"* and the model ran `surplusFraction: 0`. A schema
   workaround became a calculation input.
8. **Should it?** Only on request, and only through arguments the user can see echoed — which is what happens. What must not
   happen is the coercion in (3) reaching the arguments.
9. **Can stale or superseded intentions affect calculations?** SUPERSEDED: no — `recallMemories` and the memory line read
   `status: ACTIVE` only. **Stale ACTIVE: yes.** Nothing expires an intention; `appliesTo` is optional and unset in every
   observed write; there is no UI to retire one. A frozen `$26,078.88` remains "what the user wants" indefinitely.
10. **How is "make it nine months" represented when six was remembered?** A new row on the same `(kind, subject)`, prior row
    → SUPERSEDED. Mechanically sound in **15/15**, including fresh chats, because the model re-uses the subject it reads in
    the memory line. **But the replacement is lossy**: in the strategy case the prior row held "six months; cards first; then
    invest" and the superseding row was `{targetMetric:"liquid", targetAmount:39118.32}` — the debt and investment ordering
    left memory without anyone deciding it should.
11. **Can memory preserve "six months of expenses"?** **No.** No payload key can hold a multiplier or a basis. 56 of 90 stored
    rows froze dollars; the rest misused a money field.
12. **If the expense baseline changes next month?** A frozen row keeps the old dollars: `26,078.88` is six times *September's*
    two-month mean. The user's intention was a rule; memory holds one month's evaluation of it. And in a fresh chat it is
    ambiguous which the model will use — observed both: `liquidFloorMonthsOfExpenses: 6` (recomputed, correct) and
    `liquidFloor: 30000` (frozen).
13. **Can a user say "remember that I want six months cash" without running a projection?** Yes — 5/5 wrote memory and ran no
    projection.
14. **Can a user say "for this scenario use six months" without creating memory?** Yes — 10/10 wrote nothing.
15. **Can the system distinguish those today?** Yes, reliably, through the model's tool choice. The boundary the architecture
    wants is the boundary the model already draws. The defect is entirely on the far side of it: what memory can hold.

## 6. Fresh-chat / spin-off findings

There is **no spin-off concept in the product** — one conversation per (user, Space); "New chat" is a client-side reset. A
fresh chat was therefore simulated exactly as production does it: empty history, no scenario (a new chat's tail digest matches
no seal), orientation rebuilt, memory line re-read.

| What | Survives a fresh chat? | Mechanism | Measured |
|---|---|---|---|
| transcript | no | client cache cleared | — |
| active scenario | no, by design | seal bound to last-assistant digest | — |
| "Use $5k" with nothing remembered | no | it was only ever a tool argument and prose | "What spending assumption were we using?" → **8/10 answered "$4,346.48, measured" as though it were continuity**; 2/10 said nothing was on record |
| "Use $5k… Remember that." | **no** | `ASSUMPTION` is refused without an anchoring intention (`memory-store.ts:209`) — a deliberate product decision | rejected 10/10; the model **disclosed** the refusal honestly every time; fresh-chat projection used $5k in 0/8 |
| full chat A, then "Remember this." | **partly** | the strategy sentence survives as a label; the $5k does not (INTENTION cannot carry `monthlySpending`, rejected by name) | fresh-chat "Run that strategy" computed in 8/10 with the L1 target 8/8, **but with the $5k in 2/21** across all remember variants |
| strategy, nothing remembered | no | — | "Run that strategy…" → **7/10 refused correctly**; **3/10 invented one** (a three-month buffer; "all surplus to debt then invest") and ran it |
| model-selected memory (no explicit request) | sometimes | the model stored the isolated directive unprompted in 6/40 | when it had, the fresh chat found and ran it; when it had not, the fresh chat ran the **baseline** `project_cash` and called it "your current pattern" (4/7) |
| superseded intention | the new one only | ACTIVE filter | 15/15 |

**Consequence.** The same words — "run my strategy through next June" — produce materially different scenarios in chat A and
in a fresh chat after "remember this": chat A keeps 6 × $5,000 = $30,000 and spends at $5,000; the fresh chat keeps
6 × $4,346 = $26,079 and spends at $4,346 (or keeps a frozen $30,000 while spending at $4,346). Nothing tells the user the
basis moved. That is not memory becoming truth — it is memory **silently losing** an assumption the user asked it to keep.

## 7. The $5k assumption

**Where it lives.** Nowhere structured. After "Use $5k instead" the figure exists as (a) the user's sentence in the client
transcript, (b) one tool call's `statedMonthlySpending` argument, gone when the request ends, and (c) the assistant's prose.
`get_baselines` echoes it as **STATED** (never DECLARED — DECLARED is the product setting). A scenario inherits it only when the
model re-types it as `assumedMonthlySpending`; once a scenario has run, the envelope carries it verbatim.

**Measured on the production path.** Every same-chat compute or baseline call after the statement carried 5000:
**169 / 169**, across five sequences and two tool arms; in-process 12/12. Sequence 1–4 of the brief: 8/8, 8/8, 8/8, 8/8.

**So why did M1 see 3/4?** That run used a harness that is not production: an in-process transcript, `remember` withheld, n = 4.
It does not reproduce. **The 3/4 is not an orchestration defect; it was small-n noise from a non-production harness**, and I
reported it with more weight than it deserved.

**What is actually missing is narrower and different from what M1 proposed.** Not a "conversation-assumption slot" — within a
chat the transcript plus the envelope are demonstrably sufficient. What is missing is a **durable home for a stated baseline when
the user asks for one**: the ASSUMPTION kind refuses to stand alone and INTENTION cannot carry it (§6: 2/21).

## 8. "Make it nine months"

Sequence: "Keep six months of expenses." → "How much is that?" → "Make it nine months." → "How much is that?" → "What would I
have left to invest?" → "What does that do to my June projection?" (n = 8 production, 5 in-process).

| Turn | Tool path | Arithmetic |
|---|---|---|
| Keep six months | `get_baselines([6])` 8/8 (+ `remember`, frozen $) | code: 26,078.88 |
| How much is that? | none 7/8 — restates the previous answer | none |
| **Make it nine months** | **`get_baselines([9])` 8/8** | **code: 39,118.32. Zero prose multiplications.** |
| How much is that? | none 8/8 | none |
| What would I have left to invest? | none 4/8, `get_baselines` 4/8 | the gap 25,787.35 is the tool's `vsLiquid.difference`, restated |
| What does that do to my June projection? | `recall` 5/8 → **"no June projection exists yet"** (correct); `project_cash` 2/8; scenario with `liquidFloorMonthsOfExpenses: 9` 1/8 | one prose subtraction (78,626 − 39,118) in the `project_cash` branch |

The desired chain — *nine months → semantic threshold → canonical baseline → deterministic amount* — **is what happens**. The
M1 finding (prose multiplication in 3/10) came from the in-process harness, where the prior tool result was still in context
and the model extended it by hand. In production the result is gone, so the model asks again. **Statelessness, which looks like
a weakness, is what makes this turn deterministic.**

**Harmless vs authoritative arithmetic, as observed.** Harmless and labelled: "at $4,500/month that's about 3 months"
(an illustrative rate the model chose and said it chose). Authoritative and not code's: the net-worth gain "about $65k higher"
(101,975 − 36,791) in 4/8 June projections, and 78,626 − 39,118 above. Both are differences between two tool figures that the
scenario payload does not itself state.

**Where identity is actually lost: memory, not arithmetic.** The scenario call kept the semantic form in 7/8
(`liquidFloorMonthsOfExpenses: 9`). Memory did not, in 8/8.

## 9. Directive vs computation — re-run with the corrected contract

Prompt: "Keep six months of expenses, pay my highest-interest cards first, then invest." Production path, 19 tools.

| Context | n | No tool | Read only (grounded ack) | Ran a scenario | Tried `remember` | Stored | Unsupported $ figure |
|---|---|---|---|---|---|---|---|
| A — isolated first message | 40 | **0** | 28 | 12 | 16 | 6 | 8 |
| B — after "How am I looking financially?" | 8 | 0 | 4 | 4 | 2 | 0 | 2 |
| C — after "What should I do with my money right now?" | 8 | 0 | 5 | 3 | 0 | 0 | 4 |
| D — after an existing scenario | 8 | 0 | 0 | **8** | 0 | 0 | 0 |

Classification of the isolated directive (n = 40): FINANCIAL COMPUTATION 12 · grounded ACKNOWLEDGEMENT 28 · MEMORY WRITE 6
(attempted 16) · SCENARIO-STATE CHANGE 12 · bare ACKNOWLEDGEMENT ONLY 0 · zero-tool 0. Every read-only answer quoted the
threshold (26,078.88) and the gap to cash (12,747.91) **from the tool**. The "unsupported" column is overwhelmingly illustrative
figures the model chose and labelled; the two cases of real concern are below.

Strict follow-up — the computation class:

| Follow-up | n | Computed | Scenario tool | L1 target | Semantic floor | Literal floor | **Floor dropped** |
|---|---|---|---|---|---|---|---|
| "What does that look like by next June?" | 8 | **8** | 8 | 8 | 6 | 0 | **2** |
| "Make it nine months." → "…by next June?" | 8 | **8** | 7 | 7 | 7 | 0 | 0 |
| "What does that look like?" (no date) | 8 | 3 | 2 | 2 | 2 | 0 | 0 — 5/8 answered from the existing envelope or asked for a horizon |

**Was the M1 "directive turns skip tools" finding a defect? No.** It does not occur on the production path at all (0/64), and
even where it occurred it was an acceptable reading of an instruction that asks no question. It was produced by my M1 harness
(§17, attribution arm).

**The defect that *is* here.** In 2/8 strict follow-ups — and again in fresh chats — the model ran `{surplusFraction: 1,
target: […]}` for "keep six months…": a FLOW rule substituted for a STOCK rule. Cash never reaches the floor, the label still
says "after keeping 6 months of expenses", and the answer narrates the plan as run. This is precisely the silent substitution
the liquid-floor slice (0d80404) was built to stop, reappearing when the floor is one clause of a three-clause rule. It is
invisible to the user because **a contribution `label` is free text the model writes, and nothing checks it against the rule
that ran**.

## 10. Monthly debt payments — the last day-normalised money figure

**Where.** `lib/ai/intelligence/annotations/engine.ts:136-137`:
`estimatedMonthlyDebtPayments = debtPaymentTotal / windowDays × 30`.

**What it measures.** `debtPaymentTotal` is Σ|amount| over the debt-payment authority's counted **cash legs**
(`selectDebtPaymentCashLegs`, `lib/transactions/debt-payment-authority.ts:89`; accumulated at `transactions.ts:838-853`). The
liability-side leg of the same payment is `NEUTRAL` and is excluded, so a card payment is **not** double-counted. It is an
**observed historical flow**, not an obligation and not a projection. `windowDays` is the *requested* 90 days, not the covered span.

**Consumers.** Only three: the Brief package (`package.ts:243` → shown to the model), the Brief material digest
(`digest.ts:105`, bucketed — it can flip regeneration), and the A1 evidence arm. It feeds **no** classification. The Brief
prompt tells the model "behavior figures are monthly averages over behavior.window" (`prompt.ts:36`), which is true of
`monthlyIncome` and `monthlyExpenses` after M1 and false of this field.

**Concrete behaviour on the recovered Space (clone, 2026-09-20).**

| Basis | Figure |
|---|---|
| engine: 22,120.13 ÷ 90 × 30 | **7,373.38** |
| complete-month mean, 2 months (Jul 9,993.63 · Aug 5,946.02) | **7,969.83** |
| complete-month mean, 3 months | 8,451.69 |
| complete-month mean, 6 months | 9,770.13 |
| complete-month mean, 12 months | 10,297.62 |

The per-month rows already exist (`MonthlyBreakdownEntry.debtPaymentTotal`, `types.ts:590`) and M1's `measure_flows`
already computes the complete-month mean over them (`measure: cardAndDebtPayments`). Nothing wires that back into the assessment.

**Is day-normalisation semantically right?** No, for the same reason it was wrong for income: the figure is printed beside two
complete-month means under one label, on a different month population. **Should M1 have owned it?** Yes in spirit — it is the
same defect M1 fixed for `impliedMonthlyIncome`, and the M1 report flagged it as left behind. It is not an L1 concern: L1 owns
*contractual* minimums projected forward (`scenario-ledger.ts:894`), a different quantity.

**Four quantities share the words "monthly debt payment" and must stay distinct:** observed cash-leg flow (this figure and
`measure_flows`), Σ stated minimums now (`lib/debt/aggregates.ts:140`), the user's chosen payoff payment (`lib/debt/payoff.ts`),
and the ledger's projected minimums (L1).

**A second survivor.** `metrics.ts:115` computes every category's `monthlyEquivalent` as `cat.total / windowDays × 30`, and
**that one feeds classification** (`engines.ts:400-401`, the spending-opportunity severity). It was not in the M1 report.

**The larger finding this exposed.** `deficitCause` (`engine.ts:152-157`) is graded on `netAfterDebtPayments = netCashFlow −
debtPaymentTotal`. `netCashFlow` is income − *all* spending, **including purchases made on cards**. Subtracting the card
payments that settle those purchases counts them twice. On this Space: income 31,756.70 − spending 16,344.82 = +15,428.20;
minus card payments 22,120.13 = −6,691.93 ⇒ `DEBT_DRIVEN`. The user pays cards in full; there is no deficit. The assembler's own
comment already says so (`tools.ts` `get_spending`: "on a Space where cards are paid in full these are transfers to a card, not
debt burden, and the purchases they settle are already inside `spending`"). This label reaches the Brief model and is part of §12a.

## 11. Forward spending

`project_cash` already computes it. `lib/forecast/projection.ts:134-137`: `spend = dailyRate × days`, surfaced as the named
component *"projected spending at the observed rate"* (or *"…at your assumed rate"*) under `projection.basis.components`.
Measured on the clone:

| Call | Projected spending component |
|---|---|
| `project_cash({to: 2026-12-31})` | 14,575.59 |
| `project_cash({to: 2027-12-31})` | 66,733.35 |
| same, `assumedMonthlySpending: 5000` | 76,716.15 |

| Question | Expressible today? | By what |
|---|---|---|
| "If I keep spending like this, what will I spend through next December?" | **yes, exactly** | `project_cash` component (from today to a date) |
| "What if I spend $5k/month next year?" | **yes, from today** | `assumedMonthlySpending` |
| "How much will I spend **next year**?" (calendar 2027) | **almost** — two calls and a subtraction (66,733.35 − 14,575.59 = 52,157.76 = 4,346.48 × 12) | missing: a `from` on the projected components |
| "What if I cut spending 20% next year?" | **no** | S1: a relative, dated change. Only an absolute whole-level replacement exists; `scenario_goal_seek` can *solve* a cut but cannot *accept* one |
| "What if I stop eating out next year?" | **no** | S1: the forward engine has no category anywhere (`policy.ts`, `observed-spending.ts`: zero occurrences of "category"; refusal argued at `spending-baseline.ts:32-41`) |

**Verdict.** "baseline × horizon" is **not** a missing generic capability: the projection machinery owns it and already
returns it. The M1 unseen-corpus failure ("$5,797 × 12 ≈ $69,600" in prose) was a *routing* miss — the model asked
`get_baselines` instead of `project_cash` — plus one genuinely missing parameter (a future-dated window). No `annualSpending`
tool is warranted. The relative and categorical changes are S1, unchanged from the compositional investigation §4.3.

## 12. Daily Brief live failures — attribution

**Method.** (a) `git diff c357660 d056898 -- lib/ai/brief` → M1 touched `package.ts`, `types.ts`, `package.test.ts` only; not
`prompt.ts`, not `fixtures.ts`. (b) The goldens are pure fixture packages, so the exact model input was hashed at both commits
(`tmp/inv/brief-input-hash.ts`): **the system prompt and all 17 golden user messages are byte-identical before and after M1.**
M1 cannot have caused a golden failure; the model received the same bytes. (c) The check was then re-run cleanly against the
clone at HEAD, 5 samples per golden, nothing else using the API.

A first attempt at (c) ran concurrently with the chat batches and recorded 23 "refusals". All 23 were `429` rate-limit errors:
the Brief generator makes one call with **no retry** (`generate.ts:5`), so a provider 429 is a refused Brief. That run is
discarded — but the behaviour is itself a finding: **a transient 429 in production yields no Brief**, and the 3-minute failure
cooldown then applies.

Clean run: 85 runs, 85 accepted, 59 fully passing; live section 6/6.

| Failing check | Rate | Deterministic or sampled | Classification | Why |
|---|---|---|---|---|
| `01-quiet` — "quiet day wrote 2–3 observations (ceiling 1)" | 0/5 | sampled, but **stable** | **PRE-EXISTING** | the model reliably writes 2–3 CONTEXT observations on a quiet day despite `prompt.ts:24`. Consistent with the 41–45/48 recorded when the Brief shipped |
| `15-quiet-again` — same | 0/5 | sampled, stable | **PRE-EXISTING** | same |
| `09-stale` — must mention stale data | 1/5 | sampled | **HARNESS DEFECT** (stale expectation) | the expectation dates from 0e1cf1e; the prompt has since (b025468, Brief 4) told the model *not* to write freshness-only observations because the page shows them. `fixtures.ts` was last edited in fd41f5a without touching this expectation |
| `10-needs-reauth` — must mention reconnecting | 0/5 | sampled | **HARNESS DEFECT** | same |
| `05-crypto-down` — `quiet=true, expected false` | 2/5 | sampled | **MODEL VARIANCE** | an importance judgement at a threshold |
| `06-concentrated` — missing NVDA / "concentrat" | 3/5 | sampled | **MODEL VARIANCE** | selection among three candidate observations |
| `13-three-weeks` | 4/5 | sampled | **MODEL VARIANCE** | one unlicensed `$85`, correctly dropped by the licence |
| `14b-shared-owner-b` | 4/5 | sampled | **MODEL VARIANCE** | one "market causality" phrase |
| (M1-session only) live: "no observation was dropped by the licence — DATA_QUALITY / SHOWN_ON_PAGE" | passed 1/1 here | sampled | **MODEL VARIANCE** | the model wrote a freshness-only observation and code deleted it, as designed; the check counts the attempt |

**M1 REGRESSION: none. LIVE-DATA DRIFT: none** (goldens use no live data). The seven failures reported in the M1 session and
the eight here are the same population sampled twice.

## 12a. Daily Brief forensic case: debt severity and claim-scoped freshness

Two consecutive generations on 2026-09-20, read from the `DailyBrief` row (clone snapshots taken at ~17:46Z and ~17:52Z). The
evidence package is **not stored** with a Brief (only the narration and two hashes), so both packages were rebuilt
deterministically with `loadBriefPackage` against the clones (`tmp/inv/out/brief-package-{A,B}.json`).

| | Brief A (17:44:18Z) | Brief B (17:48:18Z, after the crypto refresh) |
|---|---|---|
| Headline | "Debt remains in a critical zone, with a recent jump alongside higher travel spending" | "Debt remains in a critical zone while cash and investments stay relatively stable" |
| Debt observation | "classified in the most stressed zone … rose by about $1,164 in the past week and about $1,039 over the past month. These figures may be out of date for Schwab and your crypto wallets but still point to a tight debt situation." | "classified in the most severe tier, driven by how you've been using and repaying it, not by today's balance alone. This view could be out of date because Charles Schwab data is over a month old and needs reconnecting." |
| Evidence paths the model cited | `behavior.debt`, `recentChanges.w1.debt`, `recentChanges.m1.debt`, `freshness.staleSources` | `behavior.debt`, `freshness`, `currentState.debt` |
| Net worth | 35,438 | 36,791 |
| `sourceWatermark` / `materialDigest` | `e4574a…` / `7c6dba` | `ec2b5d…` / `ab8003` |

### 1. What exactly makes debt CRITICAL

One rule, `engine.ts:316`: **`weightedAvgAPR > APR_CRITICAL_THRESHOLD` (22)**. The full ladder is: any unknown APR ⇒
`INSUFFICIENT_DATA`; else owed-weighted APR `> 22` ⇒ `CRITICAL`; `> 15` ⇒ `WARNING`; else liabilities declining ⇒ `IMPROVING`;
else `HEALTHY`. Confidence is `HIGH` for every graded verdict by construction (`engine.ts:329`).

Reproduced from the clone:

| Account | Owed | APR (user-entered 2026-09-20 11:43Z, `DebtProfile`) | Limit | Utilisation |
|---|---|---|---|---|
| Chase credit card | 1,123.25 | 24.99% | 37,700 | 3.0% |
| Amex Platinum | 50.44 | 28.99% | — | — |

Weighted APR = (1,123.25 × 24.99 + 50.44 × 28.99) ÷ 1,173.69 = **25.16% > 22 ⇒ CRITICAL, confidence HIGH.**
Theoretical interest if carried: 1,173.69 × 25.16% ÷ 12 ≈ **$24.61/month**. Debt is 8.8% of liquid and 3.2% of net worth.

CRITICAL is **deterministic**. It was `INSUFFICIENT_DATA` until 11:43Z the same day: **entering the true APRs is what created the
verdict**, because it removed the unknown-rate refusal. Balance size, utilisation, debt-to-liquid, debt-to-income, payment
behaviour and revolving-vs-transacting are **not inputs anywhere** (`grep utilization|debtToIncome|debtToLiquid
lib/ai/intelligence` → 0). There is **no materiality floor**: $1,174 and $117,400 at 25% grade identically.

### 2. "Driven by how you've been using and repaying it" — **MODEL INTERPRETATION, and the opposite of the truth**

| Candidate metric | In the package? | Value | Participated in severity? |
|---|---|---|---|
| weighted APR | **no** | 25.16% | **yes — the only input** |
| utilisation | no (credit limit never enters the assessment) | 3.0% | no |
| balance trend | yes, `recentChanges.w1.debt` | +1,163.94 (+11,937.8%) | no (only used for IMPROVING vs HEALTHY, below the APR rungs) |
| card-payment behaviour | yes, `behavior.monthlyDebtPayments` | 7,373.38 | no |
| `deficitCause` | yes | `DEBT_DRIVEN` | no — and itself a double-count artefact (§10) |
| revolving behaviour / interest actually paid | no | — | no |
| debt-to-liquid, debt-to-income | no | 8.8%, ~9% of a month's income | no |

The package hands the model the **bare label** `{"classification":"CRITICAL","aprCompleteness":"FULL"}` (`package.ts:252`) — no
rate, no burden, no reason. The prompt then instructs: a debt classification at WARNING or CRITICAL **is NOTABLE**
(`prompt.ts:22`), and *"Say what a classification means in plain words. Never repeat field names or codes"* (`prompt.ts:44`).
Told to explain a label it was given no explanation for, the model reached for the nearest behavioural figures in the package
(7,373/month of card payments, `DEBT_DRIVEN`) and invented a cause. Usage and repayment are **not** why the label fired — a
high *rate* is — and the behavioural evidence says the opposite: this user pays cards in full.

### 3–4. Why Schwab (and, before it, crypto) is attached to a debt claim

Freshness is **one global block** (`BriefPackage.freshness`, `types.ts:74-94`; built at `package.ts:195-216` from
`staleSourcesForBrief`). No figure in the package carries a source, an account or a population. The prompt asks the model to make
the dependency judgement itself — *"qualify only conclusions that rest on them, name the source, and never … guess which
connection they came from"* (`prompt.ts:43`) — while giving it nothing to judge with. The caveat is therefore a guess, which the
same sentence forbids.

The debt population is two credit-card accounts at Chase and American Express; both sources are `CURRENT`. **Charles Schwab
contributes zero to the debt balance, the debt trend, the APR blend and the classification.** Neither do the wallets. The
previous caveat ("may be out of date for Schwab and your crypto wallets") had **no semantic relevance** to the debt claim. After
the refresh, crypto correctly left `staleSources` and therefore left the sentence; Schwab stayed in the list and stayed in the
sentence. That the caveat tracked the *global list* exactly, and the claim's population not at all, is direct proof that the
Brief attaches **Space-level source freshness, not claim-level evidence completeness**.

The code-side guard cannot catch it: `onlyReportsFreshness` (`contract.ts:118`) drops an observation only when *every* cited
path is a freshness path; this one also cites `behavior.debt`. The licence checks numbers only (`licence.ts:99-100`); a
classification claim and a freshness attribution are both strings and pass unchecked.

This is the same defect M1 found and fixed for flow measures (§29 of the M1 investigation: a NEEDS_RECONNECT brokerage with zero
banking rows must not make spending incomplete). The Brief has not had that correction.

### 5. Severity wording

| Phrase | Source | Verdict |
|---|---|---|
| "critical" | the upstream enum value, which the prompt forbids repeating only by omission (`GLOBAL_FORBIDDEN` lists SAFE, HEALTHY… but **not** CRITICAL or WARNING, `fixtures.ts:44`) | A — faithful |
| "most severe tier" / "most stressed zone" | appears nowhere in code, prompt, package or contract | **B — amplification.** True of the enum's ordering, but it presents a rate threshold as a ranking of the user's situation |
| "debt remains in a critical zone" (headline, both Briefs) | `prompt.ts:22` makes it NOTABLE, so it leads | A, forced by the prompt's importance rule |
| "tight debt situation" | nowhere | **D — invented.** Nothing in the package measures tightness; liquidity is `SAFE` at 3.1 months in the same package |
| "flagged as critical despite small dollar balance" | the model noticed `currentState.debt` = 1,173.69 | C — the model correctly saw the tension and could not resolve it, because the metric that resolves it (the APR) was withheld |

### 6. The travel association — **CORRELATED BUT NOT CAUSALLY ESTABLISHED in the evidence; TRUE in the ledger**

The $1,440.83 Dorra Obhur Hotel charge posted 2026-09-18 **on the Chase credit card**. It is inside the +1,163.94 weekly debt
movement (the card was paid $1,000 on 09-15, then took this charge, a pending $532.62 and ~$600 of smaller travel rows). So the
association is factually right. But the model **could not have known**: `BriefActivityRow` deliberately carries no account, no
account type and no institution (`recent-activity.ts:13-18`), and the prompt forbids the link — *"do not say one thing funded
another unless the package shows both"* (`prompt.ts:35`). Headline A's "a recent jump alongside higher travel spending" is
juxtaposition by temporal proximity that happened to be true. The expense is independently worth surfacing (33% of the 4,346
monthly baseline); whether it belongs in the *debt* narrative is something only code can establish, and today code does not.

A presentational hazard rides with it: `recentChanges.w1.debt.pct = 11937.8` and `m1 = 773.4`, because the base was ~$10. Percent
change over a near-zero base is arithmetic without meaning; M1's comparison contract returns `pct: null` for exactly this case.

### 7. Claim-scoped completeness matrix

| Claim | Evidence population | Relevant sources | Irrelevant sources | Completeness today | Caveat the Brief attaches | Semantically correct caveat |
|---|---|---|---|---|---|---|
| debt severity | 2 card accounts + their APRs | Chase, Amex (CURRENT) | Schwab, wallets | complete | Schwab stale (A: + wallets) | **none** |
| debt trend (w1/m1) | `SpaceSnapshot.liabilities` | Chase, Amex | Schwab, wallets | complete | same global caveat | **none** |
| travel spending | banking rows, 7 days | Chase, Amex | Schwab, wallets | complete (M1: `observed`) | none (correct by luck) | none |
| expense baseline | reliable months, banking rows | Chase, Amex | Schwab, wallets | complete | none | none |
| liquid buffer / runway | checking + savings | Chase, Amex | Schwab, wallets | complete | Brief A attached "Investment and crypto balances … may be out of date" to the CASH observation (which also cited the weekly net-worth change, the one part that does depend on them) | **none on the cash figure** |
| investment concentration | priced positions | wallets, **Schwab** | banks | **partial** (`populationIsComplete: false`) | Schwab stale | **correct** |
| net worth | everything | **all** | — | partial while Schwab is stale | Schwab stale | **correct** |

Two of seven claims legitimately depend on Schwab. The Brief attached the Schwab caveat to four.

### 8. Reconciling the two generations

| | Changed A→B? | Why |
|---|---|---|
| watermark | yes | position/price rows moved (`watermark.ts:146-160`) |
| material digest | yes | net worth crossed a $1,000 bucket (35,438 → 36,791) **and** `staleSources` changed (it is a digest input, `digest.ts:122`) |
| regeneration | correct | digest moved ⇒ reason `change` ⇒ one model call |
| debt classification | **recomputed, unchanged** | `computeAssessment` runs on every package assembly (`load.ts:179`); APRs and balances did not move |
| debt deltas (w1 +1,163.94, m1 +1,039.31) | unchanged, still in package B | Brief B simply did not cite them — model sampling |
| stale-source list | wallets removed, Schwab kept | correct |

Nothing was cached that should not have been. **The debt conclusion's persistence is expected**: its only input (the APRs) did
not change.

### 9. Is the severity model product-sound?

| Layer | Verdict |
|---|---|
| **Calculation** | **Correct.** 25.16% is the right owed-weighted rate. |
| **Classification** | **Correct as written, unsound as designed.** A rate threshold alone, no materiality floor, no behaviour test, emitted at HIGH confidence. It cannot distinguish a transactor with a $50 statement balance from a revolver with $40k. |
| **Scope** | **Defective.** The field is named `debt.classification` / `DebtHealthClassification` and the prompt treats it as the health of the user's debt. What it measures is *"the rate on what you currently owe exceeds 22%"* — a property of the cards, not of the situation. |
| **Narration** | **Defective, and forced.** The model was given a label without its reason, told it is NOTABLE, told to explain it in plain words and forbidden the code. "Most severe tier", "tight debt situation" and the usage/repayment causal story are the predictable result. |

### 10. Relation to the seven golden failures

Shared root cause with **one** of them and unrelated to the rest. The golden failures are model-sampled quiet-day and
freshness-mention variance over byte-identical inputs (§12). The production case and the golden family both trace to the same
architectural fact: **the Brief asks the model to perform judgements that only code can ground** — which sources a claim rests
on, and what a classification means. There is **no golden with a CRITICAL or WARNING debt classification** (`fixtures.ts`: the
only match is a *liquidity* WARNING), so the behaviour in this case is entirely unmeasured by the suite.

**Reusable gap exposed:** *claim-scoped evidence* — a classification should travel with the reason it fired, and a figure should
travel with the population it rests on, so that completeness is a property of a claim rather than of a Space. M1 built this for
flow measures. The Brief, the assessment and the orientation have not adopted it.

## 13. Old live-harness failures — classification

Re-run against the clone at HEAD. All three fail **identically on `c357660` and on `a655b38`**, so none is an M1 regression.

| Check | Failing assertion | Class | What the future test should assert |
|---|---|---|---|
| `ai:scenario-check` | `baseline EOY cash === 35898.84` | LIVE FINANCIAL FIXTURE | that `project_cash` returns a finite figure; capture it as `B` |
| | `+15,000 figure === 50898.84` | LIVE FINANCIAL FIXTURE hiding a SEMANTIC INVARIANT | `scenario.liquid === B + 15000` to the cent |
| | `carrying 50,898.84 with no assistant prose` | STRUCTURAL, pinned to a fixture | the injected envelope contains `String(B + 15000)` |
| | `deterministic recalculation 51598.84` | LIVE FIXTURE hiding a SEMANTIC INVARIANT | `=== B + 15700` |
| | `exactly $700 above the previous scenario` | **SEMANTIC INVARIANT** (fails only because its operands are pinned) | unchanged, computed from the two runs |
| | `envelope shows only the replacement` | STRUCTURAL, pinned | contains `B+15700`, not `B+15000` |
| | `baseline checkpoint and prose untouched` | STRUCTURAL, pinned | prose still contains `String(B)` |
| `ai:temporal-check` | `first_below 1000 … value === 17.12000000000003` | LIVE FINANCIAL FIXTURE (a float pinned to 14 places) | the returned value equals the daily series' own value on the returned date, is `< threshold`, and `previousObservation.value ≥ threshold` |
| | `highest debt … 37437.04` (now 37,449.11 after history regeneration) | LIVE FINANCIAL FIXTURE | the returned maximum is `≥` every point in the same series, and its date is a date in that series |
| `ai:liability-check` | `payments-only payoff over an unknown rate is PARTIAL/NONE` | **STALE ASSUMPTION** — the test presumes the live Space has unknown APRs; the user entered both on 2026-09-20 11:43Z, so `COMPLETE` is now the *correct* answer | make the precondition explicit: run the assertion only when an owed line has `apr === null`, else assert `COMPLETE`; the unknown-rate semantics are already pinned purely in `liability-dynamics.test.ts` |

No ACTUAL REGRESSION in any of the ten.

## 14. Tool and context economics

**Exposure.** All 19 tools are sent on every production turn (`engine.ts:103`). There is no gating.

| Tool | Schema bytes | | Tool | Schema bytes |
|---|---|---|---|---|
| `scenario_goal_seek` | 9,077 | | `get_transactions` | 1,293 |
| `scenario_crossing` | 8,635 | | `explain_net_worth_composition` | 1,001 |
| `scenario_projection` | 8,066 | | `recall` | 974 |
| `measure_flows` | 3,670 | | `get_spending` | 950 |
| `get_baselines` | 3,058 | | `investment_scenario` | 936 |
| `find_in_balance_history` | 1,804 | | `reconcile_projection` | 848 |
| `project_cash` | 1,691 | | `get_income`, `get_financial_snapshot`, `get_investments`, `get_pay_dates` | 687 / 632 / 584 / 463 |
| `remember` | 1,674 | | **Total** | **47,559** |
| `get_net_worth_history` | 1,496 | | | |

**Structural waste, measured:** the three scenario tools are **25,778 B — 54% of the whole surface** — because
`SCENARIO_INPUTS` (~7 KB) is spread into each of them. M1 added 9.1 KB; the repeated scenario block is 2.8× that and predates M1.

**Does the surface hurt routing? No evidence that it does.** Same sequences, three exposures (production path, gpt-5.1):

| Metric | all 19 | reduced 9 | core 4 |
|---|---|---|---|
| "…by next June?" after "Use $5k": computed / carried $5k | 8/8 · 8/8 | 6/6 · 6/6 | 6/6 · 6/6 |
| isolated directive: zero-tool turns | 0/8 | 0/6 | 0/6 |
| directive → June: computed | 8/8 | 6/6 | 4/6 |
| directive → June: semantic floor kept | 6/8 | 6/6 | 2/6 |
| directive → June: **floor dropped** | 2/8 | 0/6 | 2/6 |
| "Make it nine": `get_baselines([9])` | 8/8 | 6/6 | n/a (tool present, sequence not run) |
| prompt tokens per model call | ≈ 11,960 | ≈ 11,540 | ≈ 5,810 |
| latency per model call | 2.1 s | 2.6 s | 2.4 s |

The reduced arm is slightly better on the floor (6/6 vs 6/8) and the core arm is *worse* (2/6) — no monotone relationship, and
n is small. Routing on the full surface was correct in 39/39 fact / interpretive / scenario / evaluation turns. **The 19-tool
surface is a cost, not a routing problem.** About half of every call's prompt is tool schema; roughly 80% of it is served from
the provider's prompt cache, so the marginal cost is modest. **No router, hierarchy or gating is justified by this evidence.**
The one change the numbers do support is deduplicating the scenario input block, which is a serialisation change, not an
architecture.

**One result about evaluation itself.** Removing a single tool changed the behaviour of all the others:

| Exposure | Isolated directive: zero-tool turns |
|---|---|
| all 19 tools (production) — stateless | 0 / 40 |
| all 19 tools — in-process | 0 / 8 |
| `remember` withheld — stateless | **8 / 8** |
| `remember` withheld — in-process | **8 / 8** |

With the write tool absent the model treats the directive as something to acknowledge; with it present the model grounds the
acknowledgement in `get_baselines` first. **A harness that strips a tool is not measuring the product.** This is what produced the
M1 "directive turns skip tools ~50%" finding.

**Compaction and assumption retention.** `compactToolHistory` does not run in production, so it cannot affect retention there.
What matters is stronger: production keeps **no** tool result across turns. That did not cost accuracy on any measured sequence
— it *raised* deterministic tool use on follow-ups (in-process "Keep six months of that." → no tool 4/5, reading the earlier
payload; stateless → `get_baselines` 8/8).

## 15. Adversarial composition matrix

Two 12–13 turn conversations plus fresh-chat tails, n = 4 each, production path. STATE · FLOW · MEASURE · BASELINE ·
COMPARISON · THRESHOLD · FLOOR · LIABILITY TARGET · HORIZON · MUTATION · MEMORY.

| # | Turn | Tool path (of 8) | What held | What was lost |
|---|---|---|---|---|
| 0 | How am I looking financially? | none 8/8 | answered from the orientation (STATE) | — |
| 1 | Am I spending more? | `measure_flows` + compare 8/8 | COMPARISON in code | — |
| 2 | What's my monthly surplus? | `get_baselines` 8/8 | BASELINE, derived figure with operands | — |
| 3 | Keep six months of expenses in cash. | `get_baselines` 8/8 | THRESHOLD from code | not stored anywhere but prose |
| 4 | How much is six months? | none 5/8, `get_baselines` 3/8 | restated | — |
| 5 | Use $5k instead. | `get_baselines(stated 5000)` **8/8** | every derived figure recomputed | — |
| 6 | Make it nine months. | `get_baselines([9])` 4/8, none 4/8 | 45,000 from the tool when called | 4/8 computed 5,000 × 9 in prose (round numbers, stated by the user) |
| 7 | Pay my highest-interest cards first. | mixed; none 4/8 | — | clause lives only in prose |
| 8 | Then invest the rest. | none 4/8; scenario 1/8 | — | clause lives only in prose |
| 9 | **What does that look like by June?** | `scenario_projection` **8/8** | L1 target **8/8**, $5k **7/8** | **nine-month floor kept 3/8**; `surplusFraction` substituted 7/8 |
| 10 | Actually assume a 7% return. | `scenario_projection` 4/4, `annualReturnPct: 7` 4/4 | **envelope inheritance exact 4/4** — every other argument identical | whatever t9 dropped stays dropped |
| 11 | How long until I hit $1M? | `scenario_crossing` 4/4, same arguments + 7% | envelope inheritance exact 4/4 | same |
| 12 | Remember this strategy. | `remember` ×2, 4/4 | stored | as frozen dollars / placeholders (§5) |
| F1 | [fresh] What strategy did I want? | none or `recall` | restated from the memory line | the $5k, the 7% |
| F2 | [fresh] Run my strategy through next June. | scenario 4/4, L1 target 4/4 | the ordering | $5k 2/4; 7% 2/4; floor 3/4 |
| F3 | [fresh] Forget the six-month rule; use nine. | `remember` 1/4 | — | 3/4 changed nothing durable |

**Where semantic state is lost, exactly** (all June-evaluation turns that ran a scenario, n = 45):

| State before the evaluation | Floor kept |
|---|---|
| an envelope already held the floor | **14 / 14** |
| an envelope existed **without** the floor (an earlier run had dropped it) | **0 / 6** — the envelope faithfully propagates the earlier substitution |
| no envelope yet, ≤ 4 prior turns | 17 / 18 |
| no envelope yet, ≥ 8 prior turns | **2 / 7** |

The envelope is perfect at keeping what it holds and perfect at keeping a mistake. Rule clauses stated *before* the first
scenario run exist only as prose, and prose decays with distance.

A second loss, smaller: **interpolation between envelope endpoints.** When the envelope's horizon differs from the date asked
about, 5 of 150 dated evaluations were answered with no tool call and an estimate ("roughly $80–90k in cash by end of June";
"roughly mid-$70k by June is consistent"). These are fabricated financial claims, hedged but authoritative in form — the same
family as the invented checkpoint dates fixed in 201be37. 4 of the 5 occurred in reduced-tool arms.

## 16. Proven architectural gaps

| # | Gap | Evidence | Layer |
|---|---|---|---|
| G1 | **Memory cannot represent a rule, a multiplier or a basis.** Every admissible INTENTION shape requires a number. | 71/161 writes rejected; 0/90 stored rows faithful; 56 froze derived dollars; AI-page chip "Can I afford monthsOfExpenses (~$6)?"; Brief `plans` shows a $6 planned expense; one placeholder became `surplusFraction: 0` in a fresh-chat scenario | memory contract |
| G2 | **Memory validation is top-level and presence-only.** `byDate: null` passes; `targetMetric` and `CHECKPOINT.basis` are free content; the model can write a CHECKPOINT for a *scenario* result, which the product rule forbids. | 43 null `byDate`; 4 model-written checkpoints; a projected net worth stored as the user's goal | memory contract |
| G3 | **A stated baseline has no durable home, even on request.** | "Remember that" rejected 10/10 (disclosed honestly); fresh-chat $5k 2/21 | memory contract |
| G4 | **Supersession is lossy.** Replacing a row on a subject discards clauses the new row does not restate. | strategy row → `{liquid: 39118.32}`; ordering gone | memory contract |
| G5 | **A stock rule is silently compiled to a flow rule.** `label` is unverified free text, so the answer narrates a floor that did not run. | 2/8 short, 5/8 long, 6/6 once the envelope holds the substitution | orchestration / scenario contract |
| G6 | **Rule clauses stated before the first scenario run are prose-only.** | floor kept 2/7 at ≥ 8 turns vs 14/14 once in the envelope | conversation state |
| G7 | **Claim-scoped evidence is missing outside M1.** A classification travels without its reason; a figure travels without its population; freshness is global to the Space. | Brief debt case (§12a); `deficitCause` double-count | assessment + Brief |
| G8 | **Debt severity is a rate threshold presented as debt health**, with no materiality floor, at HIGH confidence. | CRITICAL on $1,174 at 3% utilisation | assessment |
| G9 | **`netAfterDebtPayments` double-counts card-funded spending**, so a full-payer is graded `DEBT_DRIVEN`. | +15,428 economic net → −6,692 | assessment |
| G10 | Two day-normalised money figures survive: `estimatedMonthlyDebtPayments`, and per-category `monthlyEquivalent` (which feeds severity). | §10 | assessment |
| G11 | Scenario results carry no change-since-opening; the model subtracts. | 4/8 "about $65k higher" | scenario payload |
| G12 | No future-dated window on projected components. | "next year" = two calls and a subtraction | projection payload |
| G13 | Fresh-chat **false continuity**: asked what "we were using", the model reports the current default as though it were remembered. | 8/10 | orchestration |
| G14 | Live harnesses still pin personal money. | 10 assertions, §13 | tests |
| G15 | The user cannot see, edit or delete what the assistant remembers about them. | no route, no UI | product |

## 17. Things that looked like gaps and are NOT

| Claim (source) | Verdict | Evidence |
|---|---|---|
| "Directive turns skip tools ~50%" (M1 report) | **Not a defect, and not real on the production path.** | 0/64; caused by withholding `remember` in the M1 harness (8/8 vs 0/8) |
| "The stated $5k reaches the first scenario call only 3/4" (M1 report) | **Not reproducible.** | 169/169 same-chat; 12/12 in-process |
| "'Make it nine months' is multiplied in prose 3/10" (M1 report) | **Not on the production path** for a measured baseline (8/8 through the tool). It recurs only for a *user-stated round figure* (5,000 × 9, 4/8) — explanatory arithmetic over two numbers the user supplied. | §8, §15 |
| "A structured conversation-assumption slot is missing" (M1 report) | **Not proven, and partly disproven.** Within a chat, transcript + envelope carried the $5k 169/169 and the 7% 4/4. The real gap is narrower (G6) and different (G3). | §7, §15 |
| "Durable memory might silently become current financial truth" | **No code path does this**, and none should be added. | §5.7 |
| "Remembering might activate a scenario" | It does not. | `captureActiveScenario` IGNOREs `remember` |
| "The 19-tool surface hurts routing" | No evidence. | §14 |
| "M1 broke the Daily Brief" | No. | §12 |
| "Compaction loses assumptions" | It does not run in production. | §2 |
| "`remember` vs 'for this scenario' cannot be distinguished" | They are, 15/15, by tool choice alone. | §4 |
| "`debtPaymentTotal` double-counts both legs of a card payment" | It does not; the liability leg is NEUTRAL. | §10 |

## 18. Recommended implementation order

Nothing here was implemented. For each: *is this a reusable architectural primitive, or are we patching a question?*

1. **Give memory a shape for a standing rule (G1, G3, G4).** One new admissible INTENTION shape whose fields are the *same
   vocabulary the scenario contract already uses* — `monthsOfExpenses`, `target` ordering, `monthlySpending` and its basis — so
   a remembered rule is re-evaluated against the current baseline rather than frozen, and supersession replaces field-wise.
   **Primitive.** It is "semantic identity survives storage", the same principle as M1's `derivedFrom`. It answers no particular
   question.
2. **Make memory validation value-aware and close the two free-content holes (G2).** Required keys must have values; `amount` /
   `targetAmount` must not accept a figure that came from a tool in the same turn; `remember` must not mint CHECKPOINTs (code
   already does, for the one tool where it is right). **Primitive** — it is the closed-payload invariant finishing its own job.
3. **Carry the reason with the classification, and the population with the figure (G7, G8, G9, G10).** `debt` ships
   `{classification, because: {weightedApr, threshold, owed, monthlyInterestIfCarried}}`; freshness is attached per claim
   through the population-aware mapping M1 already built; `deficitCause` stops subtracting payments that settle spending it
   already counted; the two day-normalised figures move to the complete-month mean. **Primitive** — claim-scoped evidence,
   one concept, four call sites. Fixing the Brief's sentence instead would be a patch.
4. **Let a stated rule establish the scenario it describes (G5, G6).** The envelope is proven sufficient once it exists (14/14).
   The smallest change is that a rule is compiled to scenario arguments when it is *stated*, not when it is first evaluated,
   and that the echo names any stock rule that ran as a flow rule. **Primitive, with a caveat:** the first half is an
   orchestration contract and must be measured, not assumed; the second half (an echo that contradicts its own label) is pure
   code and is the part I would build first.
5. **Scenario and projection payload completions (G11, G12).** `changeSinceOpening` on the scenario result; an optional `from`
   on projected components. **Primitives**, both tiny.
6. **Deduplicate `SCENARIO_INPUTS` in the serialised schema (−~14 KB).** Serialisation, not architecture.
7. **Convert the ten pinned live assertions (G14)** as specified in §13.
8. **A memory surface for the user (G15).** Product work; listed because durable memory without it is not defensible for long.

Explicitly **not** recommended: a conversation-assumption slot, an intent router, tool gating, a change to the system
instruction, or any per-question handler. None is supported by the evidence.

## 19. Should I1 proceed?

**I1 is READY, with one condition.** I1 adds `incomeChanges` to the scenario contract; it enters the *spine*, rides the existing
envelope, and depends on nothing in G1–G4 or G7–G10. The envelope was exact on every inheritance measured here.

The condition is **G5**: I1 adds another clause to a rule that is already being compiled lossily. A raise stated three turns
before "what does that look like" is exactly the shape that lost the floor in 5/7 long conversations. I1's own acceptance should
therefore include a multi-turn assembly case, and the echo-contradiction check from item 4 should land with or before it.

Nothing else blocks I1. **G1–G4 should be fixed before any slice that encourages users to say "remember this"** — today that
sentence produces a row the product renders as nonsense. G7–G9 are live in production in the Daily Brief now and are the most
user-visible defects in this document; they are independent of I1 and S1 and can proceed in parallel.

Safe to wait for S1: G12 (it is S1-adjacent), the relative and categorical spending changes (§11).

**M1 remains CLOSED.** No M1 deterministic contract needs correction. Two M1 *report* conclusions are withdrawn (§17), and two
authority defects adjacent to M1's scope were found that M1 did not own (G9, G10).

## 20. Evidence index

| Conclusion | Evidence |
|---|---|
| production is stateless; no tool result survives a turn; compaction has no production caller | `engine.ts:171-209`, `route.ts:27-31,156-175`, grep of `compactToolHistory` callers |
| two durable write paths | `turn.ts:290`, `memory-tools.ts:66-111,160-205` |
| memory's closed key set; ASSUMPTION anchoring; supersession key | `memory-store.ts:55-73,197-249` |
| 600+ turn traces: every tool call, argument, memory row before/after, scenario before/after, figure provenance | `tmp/inv/out/{batch1,inproc,batch2,batch3,matrix,attrib}.w*.jsonl` (≈ 1,000 turns) |
| aggregation | `python3 tmp/inv/analyze.py batch1` (etc.) |
| how the product renders coerced memory rows | `tmp/inv/render-memories.ts` over `tmp/inv/out/written-memories.json` — pure, no DB |
| debt CRITICAL reproduced | `engine.ts:295-325`, `constants.ts:29`, `DebtProfile` rows in the clone (24.99% / 28.99%, entered 2026-09-20 11:43Z) |
| Brief packages A and B | `tmp/inv/out/brief-package-{A,B}.json` via `tmp/inv/brief-package.ts` |
| Brief narration A and B | `DailyBrief.content` in clones `fintracker_m1inv` and `fintracker_m1inv_w5` |
| travel charge on the card | `Transaction` join `FinancialAccount` in the clone: 2026-09-18, −1,440.83, SPENDING, posted, type `debt`, Chase |
| golden inputs identical across M1 | `tmp/inv/out/brief-hash-{head,pre}.txt` (diff empty) |
| clean golden run / contaminated run | `tmp/inv/out/brief-full-head-clean.log` / `brief-goldens-head.log` |
| debt payments, forward spending, schema bytes | `tmp/inv/det.ts` output (§10, §11, §14) |
| old live checks at HEAD on the clone | `ai:scenario-check` 7 ✗, `ai:temporal-check` 2 ✗, `ai:liability-check` 1 ✗, `ai:liquid-floor-check` pass, `ai:measures-check` pass |

**Harness notes.** Model `gpt-5.1` (`CHAT_MODEL`), production arm A2, `asOf` 2026-09-20, empty memory at the start of each run,
four workers each on its own database copy. The figure-provenance detector has false positives (it matched year numbers as
operands); every quantitative claim above was therefore computed from tool *arguments* and memory rows, not from that detector,
and the prose claims were read by hand. Sample sizes are 4–8 per cell except where pooled; differences of one or two runs are
not treated as findings anywhere in this document.

**Isolation.** Six clone databases were created for this work (`fintracker_m1inv`, `_w1`–`_w5`) and dropped at the end. To
re-run: `createdb fintracker_m1inv && pg_dump fintracker | psql fintracker_m1inv`, then `createdb -T fintracker_m1inv
fintracker_m1inv_w{1..4}`, then `tmp/inv/run.sh <cases> <reps>`. Live `SpaceMemory` held 1 row before and after
(`createdAt 2026-09-20 11:52:25.698`). The earlier M1-session `ai:brief-check` run wrote `AiInvocation` telemetry rows to the
live database, which is that script's documented behaviour; nothing else was written.
