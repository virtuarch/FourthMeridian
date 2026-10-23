# Fourth Meridian — Independent Product / Reasoning Architecture Audit

**Date:** 2026-08-31 · **Against:** `dd846fc` (PROJECTION-3), branch `v2.6`
**Scope:** `lib/ai/` (32.6k LOC), `lib/forecast/` (10.8k LOC), `app/api/ai/chat/route.ts`, `docs/plans/`
**Posture:** opinionated, evidence-first, no implementation.

---

## 1. Executive verdict

**The foundation is right and rare. The shape built on top of it is wrong, and it is wrong in a way that specifically prevents the product you described.**

You have built something almost nobody building an LLM finance product has: a *licensing substrate*. A number's presence is not permission to say it. `AmountBasis.GROSS` is sayable as a stated amount and not as money arriving. `ConclusionStatus.REFUSED` returns `closing: null` — "never zero, never a partial sum wearing the name" (`engine.ts:235`). Every threshold cites the measurement that set it. `snapshot.authority.test.ts` pins authority by *source scan*, so a regression back to a private query fails even when behaviour looks plausible. That is real engineering and it is the asset. Keep it.

But three structural facts, all verifiable, mean the system cannot behave like "ChatGPT with my financial data" today:

**(a) The model is given prose and asked for prose, and everything else is compensation for that.** The typed truth exists — `CashForecast`, `FinancialAssessment`, `LicensedFigure{value, role, label, horizon}`, `ungraded[]` with machine-readable reason codes. It is flattened to English at the prompt boundary. Then `numerical-guard.ts` — ~450 of its 774 lines are regex vocabulary and stateful section-scope tracking — tries to *reconstruct those types from the model's English on the way out*. The file says so itself: `licensedFigures()` reads "FROM THE TYPED RESULT, NEVER FROM THE RENDERED PROSE" (`:293-297`) — but it must match that against prose, "because prose is all the model was ever given." You have a hand-written discourse parser standing in for structured output.

**(b) There is no cross-domain composition layer, and every symptom you listed is a shadow of its absence.** `forecastCash` reads `state.liquidity` and nothing else — `engine.ts:378-380`: *"`state.investments` is right there on the same object, holding $24,021.19 of which $19,014.63 is crypto, and it is not cash."* `Conclusion` has 14 members; none is `PROJECTED_NET_WORTH`, `PROJECTED_INVESTMENT_VALUE`, or `PROJECTED_DEBT_BALANCE`. So when you ask "what would my net worth be?", the system hands the model a cash path, a *current* net worth, and a current portfolio total, and the model does the only thing available: it improvises a composition. Ending cash becomes net worth. Current investments become future investments. Then every guard fires. **These are not prompt bugs. They are the sound of a missing layer.**

**(c) Sixteen independent mechanisms read the user's message, in six mutually incompatible taxonomies, and they disagree.** Not "several parallel systems" — sixteen, built across at least eight work programmes, ~44 keyword/regex vocabularies, ~130 regexes. On *"what are my projections?"* the intent classifier returns `UNKNOWN`, confidence **0.2**, `answerStyle: CLARIFY`, and prints into the prompt: *"If the question is ambiguous, briefly ask what the user wants to focus on rather than guessing"* — directly above a fully computed deterministic forecast. Two verdicts, one prompt. That is your "broad questions don't work" symptom, verbatim, in the source.

The right move is not more architecture. It is to **collapse sixteen readers into one plan, collapse forecast into one operation of a general scenario engine, and make the model's output typed so the guard becomes an identity check instead of a parser.** Most of what needs to happen is deletion.

---

## 2. Current system map — what actually runs on a turn

Traced from `app/api/ai/chat/route.ts`. Both entry points, in order:

```
POST /api/ai/chat
  auth → rate-limit (30/min) → body caps (50 msgs, 24k chars)

  routeForMessages(messages)                     ── intent classifier (D4)
      8 ordered rules over 7 substring arrays → FinancialIntent + confidence
      + primary/supporting/SUPPRESS domain lists
  resolveTransactionWindow(messages)             ── ~14 regexes + 13-regex safety net
  resolveDrilldown(messages)                     ── 12 patterns + synonym maps
  isAmbiguousBreakdownFollowUp(...)              ── may ABORT the whole request
                                                    with a canned clarification

  ┌─ master (spaceId === 'master') ─────────────────────── THE DEFAULT ENTRY
  │   enumerate eligible Spaces
  │   per Space: loadCoverageEnvelope → planRetrieval → buildContext
  │              → buildForecastSurfaces  ⚠ forecastable = spaceIds.length === 1
  │   if forecast asked and >1 Space → renderForecastScopeRefusal
  │   buildMasterSystemPrompt(...)  ← per-Space blocks, no cap on N
  │
  └─ named Space ───────────────────────────────────────────
      loadCoverageEnvelope(spaceId)              ── 4 indexed aggregates, ~68ms
      planRetrieval(messages, envelope)          ── 20 regexes → Concept[] + NeedLevel
      buildContext(spaceId, ...)                 ── 4 assemblers in parallel
          accounts · transactions_summary · snapshot_history · [holdings_summary]
      buildForecastSurfaces(...)                 ── gated on plan.concepts
          resolveForecastHorizon → resolveAssertedFacts (re-runs the regex
          extractor once per prior user turn) → loadStreams → buildOperatingState
          → forecastCash()   AND/OR   projectCash()
      computeAssessment(ctx)                     ── 13-step annotations engine
      fetchPerLiabilityDebtPayments(ctx)
      buildSpaceSystemPrompt(...)                ── ~57,000 chars for a broad question

  logShadowSelectionPlans(...)   ← D6.3D planner: computed, DB-written, never read
  logShadowRetrievalPlan(...)    ← named-Space branch only

  generateChatReply(systemPrompt, messages)      ── one LLM call, free prose out

  G2  detectAssessmentContradiction   → 'repair': ONE extra LLM call, or fallback
  G3  guardForecastReply              → 'repair': sentence redaction + restoration
  G1  validateOutput + applyEnforcement → 'annotate': appends a caveat

  → { message, knowledgeGaps, knowledgeGapMode }
```

**Where truth becomes prose, and where it becomes truth again:**

| Stage | Representation | Fidelity |
|---|---|---|
| Ledger → assemblers | typed domain payloads | full |
| assemblers → assessment / forecast | typed, provenance-decomposed | full |
| **→ system prompt** | **English + `JSON.stringify` dumps** | **collapsed** |
| model | free prose | none |
| **← guards** | **regex over prose, reconstructing types** | **partial, lossy** |

That table is the whole diagnosis.

---

## 3. What is working well — preserve this

1. **The authority pattern.** One module owns one semantic decision, pinned by source scan. `snapshot.authority.test.ts:53-72` asserts the assembler holds *no* `db` import. `visibility.ts:52-64` deliberately shares one gate between the data layer and the assemblers "so [they] can never disagree." This is the discipline that makes the codebase trustworthy. Never relax it.

2. **Refusal as a type, not a string.** `ConclusionStatus.REFUSED` → `closing: null` with a `missing[]` list. `UngradedSection{verdict, reasonCode, detail}`. This is the correct primitive and it is what will make honest hedging possible later, once you actually use it (see §11).

3. **Provenance decomposed per field, not per record.** `amountProvenance` independent of `basisProvenance`; `timingProvenance` independent of both. `AmountBasis.GROSS ≠ UNKNOWN` — "the same for spendability, different for truthfulness" (`future-cash-event.ts:51-53`). Almost everyone gets this wrong. You got it right.

4. **Deterministic arithmetic, everywhere it matters.** `computeAverageMonthlySpending`, `classifyAccounts`, `computeConcentration` shared with the Allocation panel, `canonicalWindowChange` shared with the Space launcher. The "one number, one authority" instinct is correct and has already caught real bugs (CF-7's $18,936.74 / 79% double-count).

5. **Measurement culture.** Every regex window in `numerical-guard.ts` cites the incident that set it. `FORECAST-15` measured shadow 8/8 vs repair 0/10 before deciding. The gpt-4.1 tier experiment answered *no* and was recorded as *no*. This is the single best thing about the project and it must survive the simplification.

6. **The STATUS-DRIFT audit series.** These are the only accurate record of current state. They are also **uncommitted** — eight untracked files at repo root. Commit them.

---

## 4. Architectural scar tissue

### 4a. Two shadow planners, one of which is not shadow

- `lib/ai/context-priority/*` (~900 lines) computes a `SelectionPlan` against `DEFAULT_CONTEXT_BUDGET_TOKENS = 6000`. It is **genuinely dead**: its only call site writes an audit row. It runs on every turn, both entry points, and costs a DB write. It is *explicitly superseded* — `retrieval-plan.ts:26` calls its position "the structural mistake this replaces."
- `lib/ai/retrieval-plan.ts` still declares **"SHADOW ONLY. Nothing here changes what is assembled, what is serialized, or what the model sees"** (`:7-8`). That sentence is false at five sites. It gates whether a forecast is computed at all (`route.ts:577-578`), and drives `omitDomainJson`, `omitTransactionAnalysis`, `suppressHistoricalSpending`. The route comment at `:543` still says "Nothing consults this plan" — three lines above the block that consults it.
- Both write `AuditAction.AI_CONTEXT_SELECTION_PLANNED` with incompatible payload shapes. Two exports named `PLANNER_VERSION`.

### 4b. Sixteen message readers, 44 vocabularies, six taxonomies

Three separate pay-date vocabularies (`pay-dates.ts:61-84`, `retrieval-plan.ts:299-308`, `assemble.ts:419-421`), one of which is dead. Two spending-reduction vocabularies. Three net-worth/overview vocabularies. `keywords.ts:44-48` records that the payoff/update vocabularies were deliberately left divergent and "noted for a future ticket."

The phrase `how am i doing` is hard-coded in **four** places (`classifier.ts:86`, `retrieval-plan.ts:213`, `:216`, `economic-concepts.ts:223`) — and they disagree: the routing block marks `snapshot_history` PRIMARY and instructs *"Do NOT open with historical aggregates or long-run trends"*, while CF-8 marks it REQUIRED *because the question is about shape over time*. Both sentences ship in the same prompt.

**A demonstrable misroute, verified by execution:** `DEBT_WORDS` contains `'owe'`, matched by bare `String.includes`. `"where can i lower my expenses?"` matches `owe` inside `lower`. Rule 4 (`CURRENT_DEBT_STATUS`) evaluates before rule 7 (`SPENDING_REDUCTION`), first match wins, and the route emits `suppressSections: [TRANSACTIONS_SUMMARY, HOLDINGS_SUMMARY]` — instructing the model to suppress the exact domain a spending question needs. CF-8 independently marks transactions REQUIRED on the same turn.

### 4c. Dead authority in the forecast subsystem

- **`lib/forecast/obligation.ts` (434 lines) is unreachable in production.** The single call site hard-codes the empty case: `obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true }` (`assemble.ts:241`). Consequence: `KNOWN_OBLIGATION_SCHEDULE`, `MONTHLY_BURN_RATE` and `CASH_RUNWAY` are permanently answered from a constant, and **every forecast's outflow side is empty unless the user names an event by hand.** This is not scar tissue to delete — it is a missing capability being masked by a constant.
- Also dead outside tests: `scenarioCash`, `explainPolicy` (which `render.ts:7` *names as wired* in a comment), `unlockedByPolicy`, `forecastAsk` + `asksSomethingAlreadyLicensed` (a complete dead router), all four `describe*` helpers.
- `engine.ts:290-293` contains an unreachable ternary arm, calling `netCashContribution` twice on the same object.

### 4d. The vocabulary itself is the duplication

**~42 distinct status/standing/provenance/confidence/licence types across the guard + assessment + forecast layers; ~130 enum members in the forecast subsystem alone.** Exact duplicates:

| A | B | Members |
|---|---|---|
| `GuardMode` | `ForecastGuardMode` | `off · shadow · repair` — byte-identical `resolve*` bodies |
| `ConfidenceLevel` | `CompletenessLevel` | `LOW · MEDIUM · HIGH` |
| `HeuristicSeverity` | `RiskSeverity` | `info · warning · critical` |

And **"we don't know" is spelled eight ways**: `INSUFFICIENT_DATA`, `UNKNOWN`, `BLOCKED_BY_DATA`, `UNRELIABLE`, `LOW_INCOME_SAMPLE`, `REFUSED`, `NONE`, `NOT_APPLICABLE`. `assessment-guard.ts:118-124` then flattens seven of those unions into a flat `string[]` and interpolates it into a regex — **the type system's distinctions are erased at exactly the point the guard needs them.**

### 4e. Tombstones and ghosts

Five `FinanceDomains` constants with no assembler and zero references (`TRANSACTIONS_RAW`, `HOLDINGS_RAW`, `MEMBERS`, `PROVIDERS`, `PLATFORM_HEALTH`). Three manifest lists byte-identical to `FINANCE_CORE`, kept deliberately. Eleven W2 Goals-retirement tombstones. `import { } from '@/lib/ai/visibility';` — an empty named import (`transactions.ts:61`). A dangling doc reference to `docs/investigations/` which does not exist. A truncated comment block in `route.ts:117-127` whose orphaned continuation reappears at `:164`. `POLISH 5`/`POLISH 6` — internal slice names — ship *into the prompt text*. Zero `TODO`/`FIXME` markers repo-wide, while five open defects live in commit prose.

**410 slice-tag mentions across 20 non-test prompt-layer files.** The commit log is the only map of the subsystem, and there is no `docs/systems/forecast.md` for ~20 modules of user-visible behaviour.

### 4f. Two competing answer paths in one prompt

`assemble.ts:358` — `hasLicensedAnswer = !('refused' in forecast) && fullCashPath.closing !== null`. A projection is produced **only when the licensed path produced nothing**. `render.ts:69-77` then inverts FORECAST-11's "a refusal is the answer" rule and demotes the engine to `'STRICTER FORECAST (not the answer here):'`. The comment records why: *"rendering the refusal first produced the contradiction measured in the live UI: 'I cannot provide a specific ending cash figure' followed immediately by that figure."*

**That is your symptom #1, and the fix was re-ordering plus the prose instruction `'Do NOT open by saying you cannot provide a figure.'`** — precisely the class of remedy that `assessment-guard.ts:12-15` and `numerical-guard.ts:6-18` both declare structurally insufficient. Two answer paths, two statuses, and a precedence rule that has already flipped once is the largest live scar in the subsystem.

---

## 5. Product-goal gaps — what actually blocks "ChatGPT with my financial data"

Ordered by how much each one costs you.

### G1 — Assumptions do not survive the turn. By explicit doctrine.

`fact-continuity.ts:40-44`: *"⚠️ FACTS ONLY. `REQUESTS_ASSUMPTION` and `REQUESTS_SCENARIO` statements are skipped here and stay per-turn... 'Assume I spend $4,000' three turns ago must not silently price today's answer."* Suppositions are read from `question` (this turn) only (`assemble.ts:78-82`).

Your specification:
```
"Nah, assume I spend $5K/month."     → assumption set        ✅ works
"What would my net worth be?"        → assumption GONE       ❌
"What if Bitcoin goes up 10%?"       → no scenario axis      ❌
"And what about February?"           → horizon inherits ✅, assumption gone ❌
"Okay, what's realistic though?"     → no way to express     ❌
```

Only the **horizon** survives (`for-request.ts:91-102`). This single rule breaks four of the five turns in your worked example. And the concern behind the rule is correct — a stale assumption silently pricing today's answer is genuinely dangerous. The rule is the wrong solution to the right problem: what is needed is not *forgetting*, it is *lifecycle* — an assumption that is explicitly `active`, visible in the answer's framing, and dismissible by "what's realistic though?".

### G2 — No cross-domain composition. "Projected net worth" is not expressible.

Nothing in `lib/forecast/` reads `state.debt` or `state.investments` forward. The system can *police* a net-worth forecast (`for-request.ts:232` registers `a.netWorth` as a CURRENT authority so the guard can tell "your current net worth is $40,986.53" from "would be $75,022.17") — **it can police it but it cannot produce it.**

Missing, structurally: a return authority (no `AmountBasis` analogue for asset growth); a debt-balance authority (`obligation.ts` models a payment, never a trajectory); a shared double-count guard (card spending vs card payment, documented independently in two files); a `Requirement` axis that can express "this conclusion needs a *projected* value of X"; and a currency guard on `forecastCash`'s own summation — `cashDeltaOf` discards `c.currency` (`engine.ts:298`).

### G3 — Broad questions route to "ask a clarifying question."

`"what are my projections?"` → intent `UNKNOWN`, confidence 0.2, `answerStyle: CLARIFY`. `"where do you think I'll be next year?"`, `"what should I be worried about?"`, `"how risky are my investments?"`, `"what's changed?"` — none has a keyword entry. Meanwhile the assessment engine has already computed 15 sections of exactly the material those questions want, and `holdings_summary` is only assembled if CF-7's `WHOLE_PICTURE_VOCABULARY` happens to match.

Domains are serialized independently and the joining is left to the model (`context-serializer.ts:662-681` is a flat loop). The **only** composition authority in the codebase is `composeInvestments`, and it composes two components of *one* domain — and its prompt output is a *prohibition on cross-domain arithmetic*, not a composition.

### G4 — The default entry point refuses forecasts.

`master-surfaces.ts:87`: `const forecastable = spaceIds.length === 1;`. With two or more Spaces, a forecast question gets `renderForecastScopeRefusal` — ~1,600 chars of "You MUST NOT construct the projection yourself." Master is the entry most turns use. A user with a Personal and a Household Space asking "what are my projections?" gets a refusal at the front door.

### G5 — The known-bad arithmetic is *not* being repaired in production.

`AI_FORECAST_GUARD_MODE` defaults to `shadow` and is set **nowhere** — not in `.env.local`, not in `.env.example`, not in `lib/env.ts`. FORECAST-15's own acceptance measured **shadow: 8 raw authority violations → 8 reach the user; repair: 10 → 0**, and concluded *"Controlled active should launch with repair enabled."* The `$5K × 3` symptom you observed is the D/I premise echo: 30 samples, `$30,000` printed 30×, the deterministic `$30,226.49` cited 0×. **The boundary that catches it is off.**

Meanwhile `AI_FORECAST_PROJECTION` defaults **ON**, and `assemble.ts:129-135` states that ten scenarios of the accepted corpus *"now fail BY DESIGN"* — 32/35 flag-off vs ~21/35 flag-on.

### G6 — Knowledge gaps are ungated in the prompt.

`context-serializer.ts:698-710` emits the gaps block unconditionally — no intent, no plan reaches it. `extractKnowledgeGaps` reads `ctx.domains.accounts.data.knowledgeGaps` *outside* the domain loop, so `omitDomainJson` cannot suppress it. The only intent gating (`filterGapsByIntent`) applies to the response card and **never filters APR** — `gap-intent.ts:35`: *"APR is always included."* Your cash-projection question shipped `[Chase Freedom] APR not set — affects payoff calculations and interest cost` because it always does.

---

## 6. Target reasoning model

Do not extend the current shape. Replace it with five layers, in which **forecast is not special**.

```
1  LEDGER          provider facts, balances, transactions, positions
                   ── unchanged. This is good.

2  MEASURES        named deterministic quantities, each with
                   { id, value|null, unit, currency, asOf|horizon,
                     provenance, standing, missing[] }
                   liquid cash · monthly spending · monthly net income ·
                   debt balance · portfolio value · concentration ·
                   net worth · runway · savings rate · ...
                   ⚠️ t = now and t = horizon are THE SAME SHAPE.
                   "Current net worth" and "projected net worth" are one
                   measure evaluated at two points on a time axis.

3  SCENARIO        a named, ordered set of assumption deltas with lifecycle
                   { id, dimension, statedAs, origin, stance,
                     effectiveFrom, status: active|superseded|dismissed }
                   BASE is a scenario (observed continuation).
                   "flat / +5% / -10%" are three scenarios.
                   "assume $5K/month" is a delta on BASE.
                   "what's realistic though?" = revert to BASE.
                   FORECAST = evaluate the measure set at t=horizon under S.

4  PLAN            ONE model call: question + conversation → typed plan
                   { measures[], horizon?, scenarioDeltas[], breadth }
                   No figures. No arithmetic. Selection only.

5  NARRATE         ONE model call: measure set (typed, licensed) → typed answer
                   { claims: [{ measureId, standing, hedge }], prose }
                   Verification = claim.measureId must exist and the prose
                   figure must equal that measure. An IDENTITY check.
```

Three properties this buys you that the current shape cannot have:

- **Broad questions become the easy case, not the hard case.** "How am I doing?" is `measures: [everything relevant], horizon: none`. The composition happens in layer 2, deterministically, not in the model's head.
- **The guard becomes trivial.** Today it is a discourse parser with stateful section scoping. Under structured output it is `claims.every(c => measures.has(c.measureId) && figureMatches(c))`. Delete ~450 lines of regex.
- **Uncertainty becomes a property carried into narration, not a veto applied to it.** A measure with `standing: OBSERVED_CONTINUATION` and `missing: ['net basis for income']` narrates as *"probably around $43K if your recent income and spending continue — I can't verify whether your paycheck figure is gross or net, so treat it as a range."* That is exactly the register you asked for, and it falls out of the type rather than out of doctrine.

**Forecast is one operation.** `forecastCash` collapses into "evaluate `net_worth`, `liquid_cash`, `debt_balance` at t=horizon under scenario S." The 14-member `Conclusion` matrix becomes "which measures have a licence at which t." The `EVIDENCE_BASED_PROJECTION` vs `FACTUALLY_LICENSED` two-answer-path problem dissolves, because they become one measure with two standings, not two competing sections.

---

## 7. Deterministic vs model boundary

**Code must own:**
- All arithmetic, without exception. Every sum, product, ratio, projection, composition. This is already the doctrine and it is right.
- Licence: which measures may be stated at which t, with which standing.
- Refusal reasons, as codes with detail strings.
- Identity: two figures with the same name in two places must come from one call site.
- Composition: net worth = f(cash, investments, debt) is code, not narration.
- Verification of the model's claims against measure identity.

**The model must own:**
- **Question interpretation.** What is being asked, what is relevant, what horizon, which assumptions changed, whether this is a follow-up. *This is currently owned by 16 regex mechanisms and it is the single biggest thing to hand over.*
- **Selection**: which measures to fetch. A wrong selection costs relevance, never truth.
- **Judgment over evidence**: "this month looks unusual", "spending is volatile", "concentration is the risk here."
- **Register and narration**: hedge word choice, ordering, what to lead with, what to leave out.
- **Scenario framing**: proposing "flat / +5% / -10%" as reasonable bands to *offer* — the numbers themselves computed in code.

**Neither may infer:**
- A figure not traceable to a measure.
- A basis (gross/net) that was never established.
- That silence is zero.
- That a historical average is a current-normal level.
- That a current value is a future value.
- Cross-Space totals over knowingly overlapping accounts.

### The disagreement I want to put on the record

`conversation-scope.ts:44-47` states: *"Topic change is deliberately NOT detected: doing that well needs the model, and a model in this position would put question interpretation inside the trust boundary CF-1/CF-2/CF-3 exist to keep it out of."*

**This belief is the root cause of §4b, and I think it is wrong.** It conflates two different trust boundaries. "The model must not compute figures" is correct and load-bearing. "The model must not interpret the question" does not follow, and it costs you the product. A misinterpreted question produces an *irrelevant* answer; a mis-computed figure produces a *false* one. Those are not the same risk and they do not deserve the same boundary.

The evidence that the regex approach is failing at exactly this job is in the repo: the `owe`/`lower` misroute; the three divergent pay-date vocabularies with a documented field disagreement; `how am i doing` in four places giving two contradictory instructions in one prompt; and a broad projections question routed to `CLARIFY` while a forecast is being rendered beside it. **You are already paying the cost of model-quality interpretation; you are just paying it in regexes and getting worse results.**

---

## 8. Cross-domain composition

The composition layer needs three things that do not exist:

**A time axis on measures.** Not a separate "forecast" subsystem — a `t` parameter. `net_worth@now` and `net_worth@2026-12-31` are the same measure, differently licensed. This alone dissolves symptoms #4 and #5 on your list.

**Component authorities for the non-cash legs.** Each needs a real producer, not a placeholder:
- *Investments forward*: a `ReturnBasis` vocabulary — `NONE (flat) | USER_ASSUMED | SCENARIO_BAND` — and explicitly **not** `DERIVED_FROM_HISTORY` until the price series is trustworthy. You said not to design trajectory around known-bad data; I agree, and the way to honour that is to make "flat" the licensed base case and everything else an explicit scenario. That is also exactly the register you described: *"nobody knows where Bitcoin will be in December... if your portfolio stays flat, around A. At +5%, around B."* **Flat-as-base is not a limitation; it is the honest answer, and it is cheap.**
- *Debt forward*: amortisation from `debtProfile` terms — which is what `obligation.ts` was built for and is currently short-circuited to `[]`.
- *Cash forward*: exists today.

**A composition guard.** The card-spending/card-payment double count is documented independently in `projection.ts:29-38` and `spending-baseline.ts:66-71`. A three-ledger composition faces it at every join. One shared authority, not two comments.

**Master mode needs the same treatment.** The current answer to overlapping Spaces is prohibition (`"figures from different space blocks OVERLAP and must NEVER be added together"`). The right answer is a deduplicated composition over distinct `FinancialAccount` ids — you already do exactly this for `distinctAccountCount` (`route.ts:492`). Generalise it and the front-door forecast refusal goes away.

---

## 9. Conversation state

Today: **no store, five independent backward walks over the raw message array, each with its own rules**, plus a full regex battery re-run per prior turn (worst case `detectConcepts` + `resolveConceptBreadth` twice per turn, plus `extractForecastStatements` N+1 times).

What you need is one small, explicit, per-conversation object — **not durable memory**:

```
ConversationState {
  horizon:   { value, statedAt, statedAs } | null
  scenario:  Delta[]     // each: dimension, value, statedAs, statedAt,
                         //       status: active | superseded | dismissed
  facts:     Assertion[] // survives; already correct today
  focus:     { measures[], statedAt } | null   // "and what about February?"
  lastAnswer:{ measureIds[], scenarioId }      // "what would my net worth be?"
}
```

Rules that make it safe — and these are the ones that answer your "without becoming dangerous global state":

1. **Every active assumption is visible in the answer.** *"Assuming $5K/month, you'd be around $39K."* An assumption the user cannot see is the dangerous one; an assumption named in every sentence it prices is not.
2. **Deltas have effective dates and supersession**, never overwrite.
3. **"What's realistic though?" is a first-class operation** — `dismiss all scenario deltas, evaluate BASE`. It is not a keyword; the planner emits it.
4. **Assumptions never mutate a measure's provenance.** `assemble.ts` already gets this right: a supposition licenses a calculation, it does not rewrite a fact. Keep that invariant exactly.
5. **Scoped to the conversation.** Not persisted beyond it. That is the difference between conversation state and memory, and it is why this ships first.

`ai-5-advisor-intelligence.md` WS-1 specified exactly this substrate and was APPROVED 2026-07-02 with no implementation. It is still the right slice.

---

## 10. Memory readiness

**I agree with your sequencing, and I disagree with the repo's stated reason for rejecting a store.**

`fact-continuity.ts:14-32` rejects durable facts because *"The Knowledge Gaps doctrine tells the user, in the prompt, that a value supplied in conversation 'has NOT been saved'. A durable store of asserted financial facts would make that sentence false."* **That is a UI copy problem being used as an architecture argument.** The sentence is a promise you chose to make; if the product needs persistence, you change the sentence and add consent. Do not let it calcify into a boundary.

The *real* reasons to defer memory are better ones, and they are both in the repo:

1. **`FinancialAccount.balance` is a mutable `Float` overwritten on every sync, with no history table** (`V26-FOUNDATION-3`). There is no `BalanceObservation`. A forecast checkpoint that says "on Aug 31 we projected X" cannot be *reconciled* against reality later, because the reality of Aug 31 is gone. **This is the actual gate, and it is a data-model gate, not an AI gate.**
2. **There is no stable measure identity to checkpoint against.** You cannot store "projected ending cash was X under assumptions A" until `measure_id` exists as a first-class thing. §6 layer 2 creates it. Memory without it stores prose.

**Design now (cheap, no schema):** measure IDs; scenario deltas with `statedAt` / `effectiveFrom` / `effectiveUntil` / `status` — the temporal semantics you named, built for the in-conversation case first, where they cost nothing and are immediately useful. Get the *shape* right in memory before it touches Postgres.

**Postpone:** any store. The Insight lifecycle. The attention auction. Novelty decay. Notification producers. The full sealed Frame.

**Eventual model, when it comes — three ledgers, and the boundary is sharp:**

| Ledger | Holds | Never holds |
|---|---|---|
| **Intentions** | goals, plans, preferences, decisions, expected life events | any financial value derivable from the ledger |
| **Checkpoints** | "on date D, under assumptions A, measure M projected V" — immutable, effective-dated | a current value |
| **Testimony** | user-asserted facts the providers cannot know (gross vs net, "that was a one-off") | anything a provider *does* know |

The invariant that keeps memory from becoming a competing database: **memory may hold assumptions, intentions, and past *statements about* measures. It may never hold a measure.** A checkpoint is a claim about the past shape of a projection, not a number about today. Reconciliation is then trivially safe: compare `checkpoint.projectedValue` against `measure(M, t=now)` — one is history, one is truth, they can never be confused because they are different types.

Your sequencing (reasoning → conversation state → narrow memory → reconciliation) is right. My one amendment: **steps 1 and 2 are the same slice.** The scenario abstraction *is* the reasoning fix. Building "reasoning" first and conversation state second means building the reasoning layer without the concept it most needs.

---

## 11. Guard / verification review

Three post-generation guards plus two prompt-level doctrine layers, with **measured overlap**:

| | Guard | Default | Actually enforcing? |
|---|---|---|---|
| G1 | `validateOutput` — numeric membership over prompt text | `annotate` | **yes**, append-only |
| G2 | `detectAssessmentContradiction` — 13 regexes vs assessment | `shadow` (set to `repair` in `.env.local`) | locally yes, prod default no |
| G3 | `guardForecastReply` — licence over prose | `shadow`, set nowhere | **no** |

**Placement is right; medium and defaults are wrong.**

*Right:* last, before the user; reading the typed result for the licence; append-only annotation so a false positive costs a caveat not an answer; instrumented before enforcing.

*Wrong, and specifically:*

**G1's tolerance is a ±$500 amnesty.** `for (const unit of [1,10,100,1000]) if (Math.round(s/unit)*unit === c) return true;` — a prompt containing `$1,600.00` reconciles a fabricated `$2,000`; `$2,499` reconciles `$2,000`. It is also **unit-blind**: `matches()` sees only `value`, so a claimed `3.2 months` of runway reconciles against a source `$3.20`. And it treats the *entire* system prompt — hundreds of numbers — as the source set, plus user turns. With coarsening, the union of accepted values covers most of the low-magnitude number line. **G1 is close to a no-op against a plausible fabrication.**

**Three guards catch the same failure.** On the canonical `$10,000 × 3 = $30,000` case: G3 fires `UNLICENSED_PRODUCT`, G1 independently flags `$30,000`, and the prompt already contains G4's *"do not multiply any monthly income, monthly spending, or net cash flow figure by a number of months."* Four layers, one failure.

**The typed refusal record exists and nobody uses it.** `assessment.ungraded[]` — built with four branches, machine-readable `UngradedReasonCode`, and a ready-to-print `detail` string — is consumed at exactly **one** site in the entire app (`app/api/brief/route.ts:668`, for an APR gap). The assessment serializer never renders it. `assessment-guard.ts` never reads it — it re-derives the same four refusals from raw classification comparisons and **hard-codes its own worse prose**. That hard-coding is a live bug: `refusalPreservingFallback` says liquidity is UNKNOWN because *"there is no expense baseline for this window"*, but `engine.ts:541-552` shows two causes, and in a Space with no checking accounts the guard tells the user the wrong reason — while the right one sits in the same object.

> **This is the cleanest possible statement of "guards compensating for an upstream representation problem": a typed refusal with a reason is computed, dropped at the prompt boundary, and then re-derived — badly — from the model's prose.**

**Refusal concatenated beside a valid answer — structurally guaranteed, not hypothetical.** `numerical-guard.ts:700-708` does `out += "\n\nEnding cash cannot be stated: ..."` — append, never replace, with no check that an answer still stands. And a projection exists *only when* `fullCashPath` produced no closing figure (`assemble.ts:358`), while projection figures are registered as `FigureHorizon.FUTURE` licences and therefore survive redaction. So on any projection turn that trips one finding under `repair`, the user gets: *[licensed projection]* + *"Ending cash cannot be stated."* **Symptom #1 on your list, generated by the guard that exists to prevent it.**

Then G1 runs after G3 and appends *"one or more figures above could not be automatically verified"* — including over the deterministic figures G3 just restored.

**What to do:**

1. **Today, free:** set `AI_FORECAST_GUARD_MODE=repair`. Its own acceptance data says 8/8 violations currently reach users. Add both forecast flags to `lib/env.ts` and `.env.example`.
2. **Render `ungraded[]` into the prompt.** This is a one-file change that kills roughly half of G2's reason for existing.
3. **Then collapse to one guard, under structured output.** Claim → measure identity. Delete `numerical-guard`'s regex layer, `output-validator`'s tolerance ladder, and G2 entirely. What survives is: does every figure in the answer correspond to a measure the model was licensed to state? That check is exact, has no false positives, and needs no hedge vocabulary.

---

## 12. Prompt / context review

Measured, single Space, broad question: **~57,000 chars ≈ 14,000 tokens** (the repo's own estimate, 8–15k, agrees; with a real 90-row snapshot it is plausibly 16–18k).

| Class | Share |
|---|---|
| Raw `JSON.stringify` domain dumps | **36.1%** |
| Static doctrine constants | 32.9% |
| Pure-instruction lines inside "data" sections | 6.7% |
| Figures wrapped in ≥25 words of instruction | 7.0% |
| Assessment values | 7.4% |
| Bare data rows | 3.4% |

**Roughly 45% instruction / 55% data on a broad question. On a simple question it inverts to ~73% rules / 27% data** — every turn pays ~4,250 tokens of doctrine before a single number appears.

**Answering your question 9 directly: both, simultaneously, for the same values.** Every transaction rollup is emitted twice — as prose blocks and again inside `JSON.stringify(section.data)`. `computeAverageMonthlySpending` reaches the prompt **four** times: two assessment lines, one context line, plus the underlying `monthlyBreakdown` in prose *and* in JSON. The architecture doc already names the fix and it was never done (`FABLE-2.6-CONTEXT-ARCHITECTURE.md:183`: *"prose blocks or raw JSON per section, not both"*).

**Contradictions shipping in one prompt:**
- `RESPONSE_STYLE`: *"Never expose internal field names, type codes, or category labels."* — beside `context-serializer.ts:165` instructing the model to *"use the derived `amountOwed`, `creditBalance`, and `liabilityState` fields — NEVER the raw signed `balance`"*, read out of a JSON dump.
- The routing block's *"If the question is ambiguous, briefly ask what the user wants to focus on"* — above a computed forecast.
- `EXPLAINABILITY_DOCTRINE` rule 1 and CF-8 disagreeing about whether to open with historical aggregates.
- Two `POLISH` slice names leaking into prompt text.
- A dev-only invariant throw whose production branch pushes `[DATA INCONSISTENCY — category figures under review]` into the prompt — a debug artifact addressed to the model.

**Rules stated 3–6 times each:** "don't invent" (4 places), "name the analysis window" (6), attribution limit (3), completeness phrasing (2), income-confidence-LOW (4).

**Sections explaining the architecture to the model rather than giving it facts:** `Authority precedence` (2,947 chars describing your own trust model), `=== QUESTION ROUTING ===` (~1,100 chars explaining the intent classifier, ending with *"This routing is guidance for focus and ordering only"*), `TRANSACTION SCOPE — what was asked for, and what was actually loaded`, `=== AVAILABLE EVIDENCE ===` (*"This is NOT what was loaded below"*), the omitted-payload notice. **Answering your question 8: the prompt is large because the architecture is explaining itself.**

**Missing from the prompt:** `ungraded[]` (the typed refusal reasons); any cost-basis or return context for investments; any scenario/assumption *state* (only this turn's); and any stable prefix — `assembledAt`/`requestedAt` timestamps sit inside the JSON dumps and `Today's date:` is line 3, so **no two turns share a byte-identical prefix and provider prompt caching never engages.**

---

## 13. Simplification plan

**Delete outright — no behaviour change, ~2,000+ lines:**

| Target | Lines | Note |
|---|---|---|
| `lib/ai/context-priority/**` | ~900 | shadow, superseded by CF-8, costs a DB write per turn |
| `lib/ai/intent/{classifier,keywords,prompt,types}.ts` + `=== QUESTION ROUTING ===` | ~900 | contradicts CF-8, misroutes `lower`→`owe`, sends CLARIFY over a live forecast |
| `scenarioCash`, `explainPolicy`, `unlockedByPolicy`, `forecastAsk`, `asksSomethingAlreadyLicensed`, 4× `describe*` | ~400 | zero non-test callers |
| Dead `FinanceDomains` members + 3 identical manifest lists + Goals tombstones | ~100 | |
| `import { } from '@/lib/ai/visibility'` | 1 | |
| Duplicate `DAY_MS` ×7, `money()` ×4, `median()` ×2, `daysBetween` ×3 *with three different semantics* | ~60 | the `daysBetween` divergence is a latent bug |

**Collapse:**

- 3 pay-date vocabularies → 1. 2 spending vocabularies → 1. 3 net-worth vocabularies → 1. Then → **0**, once the planner is a model call.
- `GuardMode` ≡ `ForecastGuardMode` → one. `ConfidenceLevel` ≡ `CompletenessLevel` → one. `HeuristicSeverity` ≡ `RiskSeverity` → one.
- **The eight spellings of "we don't know" → one `Refusal { code, detail, dimension }`.** This is the highest-leverage type change in the codebase: it makes `ungraded[]` renderable, makes G2 unnecessary, and stops `verdictTokens()` from flattening your type system into a regex.
- Six taxonomies (domains / concepts / intents / intent-families / breadth / temporal) → **one**: measures + horizon + scenario.
- Two answer paths (`forecastCash` + `projectCash`) → one measure with two standings.
- Prompt: **prose blocks *or* JSON, never both.** Drop `snapshot_history.history[]` from the JSON (17.6 KB → 617 B) and `accounts[]` where not needed (13.4 KB → 2.96 KB).

**Demote:**

- FORECAST from a subsystem to an operation.
- The intent classifier's `confidence` to nothing — it is a keyword count presented to the model as calibrated confidence.
- Doctrine from ~4,250 tokens/turn to a stable, cacheable prefix under 1,000. Most of it is compensating for the prose representation and dies with it.

**Do not delete, but fix:** `obligation.ts` is not scar tissue — it is a wired-empty capability that silently makes `CASH_RUNWAY` and `MONTHLY_BURN_RATE` answer from a constant. Either connect it to `debtProfile` terms or make the constant an explicit, disclosed refusal.

---

## 14. Target end state

When this is done, a turn looks like:

```
message + ConversationState
   ↓  PLAN (one model call, typed out, no figures)
      { measures: [net_worth, liquid_cash, portfolio_value, monthly_spending,
                   monthly_income, debt_balance, concentration],
        horizon:  2026-12-31,
        scenarios: [BASE, {investments: +5%}, {investments: -10%}] }
   ↓  RESOLVE (pure code)
      for each measure × scenario × t:
        value | null · standing · provenance · missing[]
      compositions (net worth) computed here, once, deterministically
   ↓  NARRATE (one model call)
      in:  the measure set as typed primitives — no doctrine about how to
           behave, because the types already say what may be claimed
      out: { claims: [{measureId, standing}], prose }
   ↓  VERIFY (pure code)
      every figure in prose ↔ a claimed measure. Identity, not regex.
   ↓  response
```

Properties:

- **Broad questions are the default path.** "How am I doing?" and "what are my projections by year end?" differ only in the measure list and whether `horizon` is set.
- **Uncertainty changes standing and language, never permission.** A measure with `standing: OBSERVED_CONTINUATION` narrates as *"you're tracking toward"*; `ASSUMPTION_DEPENDENT` narrates as *"assuming $5K/month"*; `REFUSED` narrates as *"I can't put a number on that because X"* — and crucially, refusal of *one* measure never suppresses the others, because they are separate objects rather than sections competing for the lead.
- **The conversation carries state the user can see.** Every active assumption appears in the answer. "What's realistic though?" clears them.
- **The user never meets a domain, an authority, a status, or a routing decision.**
- **The prompt is small and mostly cacheable.** Primitives, not prose; doctrine collapses because the types carry the rules.
- **One guard**, exact, with no vocabulary.
- **Memory, when it arrives, plugs into layer 3 as a source of scenario deltas and into a checkpoint table keyed on `measure_id`** — it cannot become a competing truth store, because it holds no measures.

---

## 15. Path from here

**Do now (this week, low risk, high value):**

0. **Set `AI_FORECAST_GUARD_MODE=repair`.** Register both forecast flags in `lib/env.ts` and `.env.example`. Decide `AI_FORECAST_PROJECTION` deliberately rather than by default. *Zero engineering; closes a live correctness gap your own acceptance data quantified.*
0b. Commit the STATUS-DRIFT audits. Write `docs/systems/forecast.md`. **Rotate the OpenAI key in `.env.local` — it is a live-looking `sk-proj-…` in plaintext.**

**Slice 1 — The structured answer boundary.** Model emits `{claims[], prose}` where each claim references a measure ID. Verification becomes identity. *This is the highest-leverage change in the entire system:* it deletes the discourse parser, deletes G1's tolerance ladder, makes G2 unnecessary, and removes most of the reason the prompt is 45% instruction. Everything else gets cheaper afterward. **Do this first.**

**Slice 2 — Measures with a time axis, and ConversationState.** One slice, not two: the scenario abstraction *is* the reasoning fix. Deliverable: `measure(id, t, scenario) → {value|null, standing, missing[]}`; `net_worth` composed deterministically at any `t`; assumptions and horizon carried with explicit lifecycle and always visible in the answer. **This unblocks your entire worked conversation and it closes symptoms #4, #5 and the assumption-loss defect at once.**

**Slice 3 — One planner.** Delete the intent classifier and `context-priority`. Replace CF-8's 20 regexes with a model call emitting a typed plan (measures + horizon + scenario deltas). Collapse the six taxonomies. **Broad questions start working here.** This is where "how am I doing?" and "what should I be worried about?" stop being unroutable.

**Slice 4 — The non-cash forward legs.** `ReturnBasis` with flat-as-base and explicit scenario bands. Debt amortisation from `debtProfile` (connect `obligation.ts` or disclose the gap). The shared double-count guard. Deduplicated master composition — which removes the front-door forecast refusal.

**Slice 5 — Prompt rebuild.** Primitives, one serialization not two, `ungraded[]` rendered, stable cacheable prefix, doctrine cut to what the types cannot express.

**Can wait:** durable memory of any kind. The Insight lifecycle. The attention auction. Notifications and unprompted speech. The full sealed/persisted Frame. Investment trajectory from historical prices.

**Explicitly do NOT build:**
- More guards. You have four layers on one failure; the answer is a better representation, not a fifth.
- More statuses. You have ~42 vocabularies and eight words for "unknown." Every new one makes the guard's `verdictTokens()` flattening worse.
- A durable store of asserted *financial values*. Memory holds intentions, assumptions, and checkpoints — never a measure.
- Anything optimising `forecast-scenarios.ts`. Of 59 conformance scenarios, **3 are broad questions**, and the forecast corpus's 35 scenarios all run against one fixture. It measures whether the model refrains from exceeding its licence — a real property, worth keeping as a regression net — but it does not measure whether the product works, and the acceptance bar has already been moved once to admit a shipped feature (`NO_HISTORICAL_BASELINE` retired; `NO_INVENTED_ENDING_CASH` now hard-codes an allowlist `(?!42[,.]?5|39[,.]?2|10[,.]?228)`). **Add ~20 broad-question scenarios scored on usefulness *and* honesty before you trust any conformance number again.**

---

## 16. Risks and disagreements

**1. I disagree with the anti-model doctrine on interpretation** (`conversation-scope.ts:44-47`). See §7. This is the single belief that produced 16 message readers, and I think it costs you the product. Misinterpretation ≠ falsehood.

**2. I disagree with the stated reason for rejecting durable facts** (`fact-continuity.ts:14-32`). A prompt sentence you wrote is not an architectural constraint. The real gate is that `FinancialAccount.balance` has no history, so checkpoints cannot be reconciled — which is a data-model problem you should name as such. Agreeing with the conclusion for the wrong reason is how a defer becomes a permanent boundary.

**3. I disagree with your sequencing on one point.** You proposed reasoning → conversation state → memory → reconciliation. Steps 1 and 2 are one slice. Scenario-with-lifecycle *is* the reasoning primitive that broad questions and multi-turn refinement both need. Building "reasoning" first without it means building it twice.

**4. Risk in my own recommendation:** structured output moves narration into a constrained format, and there is a real chance the first version sounds worse — more clipped, less like the register you want. Mitigation: keep `prose` as a free-text field on the answer object, verified against `claims[]` rather than generated from them. The model still writes the sentence; it just also declares what it claimed.

**5. Risk: deleting the intent classifier removes a working suppression signal for narrow questions.** Some narrow routes are genuinely well-tuned. Mitigation: sequence it after Slice 1, keep the conformance corpus running as a regression net during the swap, and accept a temporary regression on narrow questions in exchange for broad ones working at all. Given the product you described, that is the right trade.

**6. Risk in something you asked for.** "Do not have it constantly ask me for information derivable from the data" is right — but `spending-baseline.ts:16-26` records that *this user's* discretionary spending has **no current regime**: calendar months ranging $2,290 to $14,061, a 6.1× spread. The honest answer there is not an average and it is not a refusal — it is *"your spending swings a lot month to month, so I'd give you a range rather than a number: somewhere between $X and $Y depending on the month."* **Make sure "stop refusing" does not become "always produce a point estimate."** Ranges and volatility disclosure are the product, not a fallback from it.

**7. Governance risk, and it is real.** Fourteen days, ~35 modules, two new subsystems, two new env flags, one schema migration — and zero committed documentation. STATUS.md is 14 days stale and cites a file deleted seven cycles ago. Two production defaults contradict their own acceptance decisions. **The audit series is excellent and uncommitted.** The simplification below will be much harder to do safely if the next fourteen days look like the last fourteen.

---

## Final question, answered plainly

> *If you inherited Fourth Meridian today and your job was to turn it into "ChatGPT that understands my financial life," what would you simplify first, what would you build next, and what would you refuse to add until later?*

**Simplify first: the boundary between the model and the truth.** Today the model receives English and returns English, and ~1,700 lines of regex across three guards try to recover meaning from both directions. Make the model return a typed answer whose figures reference measure IDs. That one change deletes the discourse parser, deletes the numeric-tolerance amnesty, deletes the assessment guard's reason for existing, and removes most of the 45% of your prompt that is instruction. Everything else on this list gets cheaper the day after.

In the same breath, delete the sixteen-reader routing sediment: `context-priority` (dead), the intent classifier (actively harmful — it tells the model to ask a clarifying question while a forecast is rendered beside it), three redundant pay-date vocabularies, and the eight spellings of "unknown."

**Build next: measures on a time axis, and scenarios with a lifecycle.** One primitive — `measure(id, t, scenario)` — under which `net_worth@now` and `net_worth@Dec-31` are the same object differently licensed, `forecast` is one operation rather than a subsystem, `flat / +5% / -10%` are three evaluations, and "assume $5K/month" is a delta that survives the turn *because it is visible in every answer it prices*. Then one model-driven planner on top of it. That is the entire conversation you wrote out in your brief, and none of it works today because these two things do not exist.

**Refuse until later: durable memory, the insight lifecycle, unprompted speech, and any further guard.** Memory is blocked on a data-model fact — balances have no history, so a forecast checkpoint cannot be reconciled against what actually happened — and on the absence of stable measure identity. Both are fixed by the work above, which is the real reason to sequence it after, not before. And refuse, specifically, to answer any future failure with another layer: you already have four layers on the multiplication bug, and the one that would actually catch it is turned off.

**One thing you already have that most teams never build: a system that knows the difference between a number it may state and a number it merely possesses.** Do not trade that away for fluency. The whole argument above is that you do not have to — the licensing substrate is not what makes the product feel bureaucratic. Prose is. Change the medium and the substrate becomes invisible, which is exactly where you wanted it.
