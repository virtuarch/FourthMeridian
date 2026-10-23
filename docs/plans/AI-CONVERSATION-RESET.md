# AI conversation reset

**Date:** 2026-09-07 · **Branch:** `v2.6` · **Scope:** demolition only.

**No replacement architecture has been chosen.** This document records what was
removed, what was deliberately kept, and why. It proposes nothing.

---

## 1. Why

The conversational layer had grown into a safety apparatus that answered
questions about itself instead of about the user's money. Nine programmes of work
— CF-1…CF-12, A1…A6, FORECAST-1…18, PARITY-1…3, PROJECTION-1, V26-REASONING
0…8 — each added a correct mechanism to close a real, measured failure, and the
sum of them stopped being a product.

At the end there were, between the user's sentence and the answer: a lexical
intent classifier, a conversation-scope resolver, a temporal-claim reader, a
retrieval planner, an economic-concept resolver, a drilldown resolver, an
ambiguity guard, a prompt serializer with its own doctrine, a forecast statement
extractor, a fact-continuity extractor, a horizon parser, a figure-licence table,
a typed answer schema, an answer verifier, a repair loop, a deterministic
figure-dump fallback, an assessment-contradiction guard, a numerical guard, a
prose numerical sweep, a planner shadow-comparison harness, and six environment
flags gating combinations of the above.

Every one of those was justified in isolation. Together they made the assistant
a machine that recites.

## 2. Product north star

> **ChatGPT with access to my financial world.**

A person should be able to type "how am I looking financially", "break it down",
"that's cash right?", "nah assume I spend like 6 grand a month", "February?",
"what's actually realistic though?" — and be understood. They should never need
to know that Fourth Meridian has measures, concepts, scopes, horizons, licences,
or domains.

Financial truth underneath must stay trustworthy. **Provenance and safety exist
to support the conversation, not to become it.**

## 3. The dogfood failures that triggered this

Local dogfooding, one session:

| Turn | What happened |
|---|---|
| *"how much money will i have by november"* | **"If these patterns continue, you could have about $36,533.63 by November."** — a good answer. |
| *"break it down for me"* | A deterministic figure dump containing **competing November values**: projected closing cash `$4,813.79`, projected net worth `$28,823.97`, current cash `$16,976.35`, current net worth `$40,986.53`, monthly income `$12,665.59`, monthly spending `$4,156.68`, monthly net `$8,508.91`, estimated monthly debt payments `$8,451.69`, total liabilities `$11.09` — plus duplicated measures, scenario bands, refusals and APR warnings. None of it explained the $36,533.63. |
| *"this is alot layman's terms"* | Essentially the same dump. |
| *"lose the bullet points..just talk to me regular"* | **"AI provider error. Please try again."** |

Three failures in four turns, and they are three different failures:

1. **A follow-up was not a follow-up.** "Break it down" re-entered the pipeline as
   a fresh question and re-planned from scratch, so the answer it was breaking
   down was not an input to anything.
2. **A refusal-shaped safety layer produced an unsafe artifact.** The dump was
   the *deterministic fallback* — the thing the architecture reached for when it
   could not license prose. It is maximally provenanced and it presented five
   mutually inconsistent "November" figures to a person who asked one question.
3. **A plain formatting request crashed it.** "Just talk to me regular" is
   trivially satisfiable and returned a 502.

The programme's own acceptance data agreed, and said so plainly: under the
non-enforcing default posture, **eight raw arithmetic failures per run reached the
user**, three of them the `$5,000 × 3` multiplication — the user asks for
arithmetic, the model does it, beside a deterministic block holding the right
answer. The response to that was a fourth guard. It should have been this.

---

## 4. What was removed

**123 files changed · +525 / −27,617 lines.** Deleted, not disabled: nothing
below survives behind a flag.

### Whole directories

| Path | Files | What it was |
|---|---|---|
| `lib/reasoning/**` | 25 | The V26-REASONING layer: `ReasoningPlan` planner, `MeasureId` catalogue and evaluator, conversation/scenario lifecycle (`derive`, `turn`, `types`), `LicensedFigure`/`FigureTable`/premise extraction/magnitude grammar, the typed `Answer` schema and narrator, `verifyAnswer` + repair, `deterministicFallback`, master dedupe, refusal and render. |
| `lib/ai/chat/**` | 3 | `message-analysis` (routing, window carry-forward, drilldown, ambiguity, gap filtering), `conversation-scope` (CF-4), `master-surfaces`. |
| `lib/ai/intent/**` | 6 | The lexical intent classifier, keyword tables, gap intent, intent prompt and types. |
| `lib/ai/prompts/**` | 5 | `system-prompt`, `doctrine`, `context-serializer`, `assessment-serializer`, `format` (the four surviving helpers were extracted first — see §5). |
| `lib/ai/conformance/**` | 5 | Scenario fixtures, forecast scenarios, scoring, the real-questions corpus. |

### Individual modules

`lib/ai/retrieval-plan.ts` (CF-8 planner) · `lib/ai/output-validator.ts` (prose
numerical sweep) · `lib/ai/assessment-guard.ts` (A5 contradiction guard) ·
`lib/ai/claim-detection.ts` · `lib/ai/forecast/numerical-guard.ts` (FORECAST-14
figure licence + redaction) · `lib/ai/forecast/horizon.ts` (lexical horizon) ·
`lib/ai/forecast/statements.ts` and `fact-continuity.ts` (regex extraction of
asserted facts and suppositions) · `lib/ai/forecast/render.ts` (prompt block) ·
`lib/ai/forecast/for-request.ts` (route orchestration + figure licensing).

### The route

`app/api/ai/chat/route.ts` went from 696 lines of orchestration to 66 lines that
authenticate, rate-limit, and return **`503` with `status: "AWAITING_REDESIGN"`**
and a plain sentence. `AnalyzeClient` already renders a non-OK response's `error`
as the assistant's turn, so the user is told the truth in the place they asked
the question. No client change was needed and none was made.

### Operator harnesses (14 scripts, 14 npm entries)

`check-answer-boundary` · `check-assessment-conformance` ·
`check-bounded-superlatives` · `check-conformance-scenarios` ·
`check-conversation-gate` · `check-conversation-scope` ·
`check-evidence-awareness` · `check-forecast-conformance` ·
`check-forecast-multiturn` · `check-temporal-conformance` · `compare-plans` ·
`audit-bounded-disclosure` · `audit-temporal-framing` · `audit-retrieval-plan`.

All fourteen are recorded as **tombstones** in `scripts/audit-registry.ts` rather
than erased, so the runner refuses a script silently reappearing under one of
those names, and so the next design can see what was being measured.

### Flags (6)

`AI_ANSWER_MODE` · `AI_REASONING_PATH` · `AI_PROMPT_SHAPE` ·
`AI_ASSESSMENT_GUARD_MODE` · `AI_OUTPUT_VALIDATION_MODE` ·
`AI_FORECAST_GUARD_MODE`. Removed from `lib/env.ts` and `.env.example`. A flag
whose code is gone is not a kill switch; it is a lie in the environment surface.

### Audit actions (2)

`AI_CONTEXT_SELECTION_PLANNED` and `AI_OUTPUT_VALIDATION_FLAGGED` had no writers
left. `AuditLog.action` is a plain `String`, so **historical rows are unaffected**
and still render; neither appeared in the admin filter groups.

### Documentation

`docs/systems/reasoning-layer.md`, `docs/systems/planner.md` and
`docs/systems/model-tier.md` were deleted — all three describe removed machinery
as current. `docs/systems/ai-foundation.md` and `docs/systems/forecast.md` were
corrected in place: the doctrine in both is durable, the implementation maps were
not. `STATUS.md` records the reset.

---

## 5. What was deliberately preserved

The rule applied throughout:

> **KEEP** "here are Christian's transactions and the deterministic total."
> **REMOVE** "here are fourteen rules deciding whether the chatbot is
> linguistically licensed to mention that total."

Nothing under `lib/` outside the list in §4 was touched. In particular:

### Financial truth and data authority — untouched

Provider integrations, Plaid ingestion, accounts, balances, transactions,
historical transactions, Space snapshots, historical balance observations,
holdings, `PositionObservation`, `PriceObservation`, `PositionCoverage`,
`PositionReconstruction`, `CorporateActionTerms`, frozen history, observation
provenance, account deduplication, investment reconstruction, transfer
resolution, merchant and category aggregation, the transaction read authority
and every drilldown selector.

**No migration was required. No financial history or provider truth was
touched.** The schema is byte-identical.

### `lib/ai/**` — what stayed, and why it is not "AI"

| Module | Why it survives |
|---|---|
| `visibility.ts` | `TRANSACTION_DETAIL_VISIBILITY` — the single `[FULL]` predicate. Consumed by **twelve** production modules across accounts, transactions, imports, investments and transfers. Never was a chat concern. |
| `types.ts` | The domain payload contracts every assembler and consumer speaks. |
| `assemblers/**` | Read the canonical authorities and re-decide nothing. Consumed by the Brief and the expense-baseline route. |
| `context-builder.ts`, `assembler-registry.ts`, `domain-manifest.ts` | `buildContext` — generic grounded evidence assembly. The Brief depends on it. |
| `signals/**` | Deterministic signal detection over assembled domains. |
| `intelligence/**` | `computeAssessment`, the annotation engines, trajectory, debt strategy, per-liability debt payments. **This is deterministic financial knowledge, not narration**, and the Daily Brief reads it. |
| `coverage-envelope.ts` | CF-5's evidence census — what exists as distinct from what was loaded. Generic retrieval, useful to anything. |
| `domain-relevance.ts` | CF-6 — which domains a Space can supply, so a category label cannot decide what evidence exists. |
| `economic-concepts.ts` | CF-7 — `composeInvestments`. A **double-count prevention rule** (`totalInvestments + totalDigitalAssets` overstated by 79% before it existed), not a chatbot concept. |
| `bounded-selection.ts` | CF-1 — a bounded list carries its denominator. Produced by the assemblers. |
| `temporal-scope.ts` | CF-2's four window authorities. **Produced by the transactions assembler**, so it is retrieval, not conversation. |
| `spending-categories.ts` | The flow-derived non-spending category set. |
| `format.ts` | **New file** — `fmtMoney` / `fmtMonthYear` / `approxMonths` / `getTransactionsSummary`, extracted verbatim from the deleted `prompts/format.ts` because the intelligence engines and signal detectors use them. |
| `provider.ts` | The single OpenAI import site. **Currently reader-less, on purpose** — it is the seam the next layer plugs into. |

### Deterministic forecast — preserved by extraction

`lib/forecast/**` (the engine and its ten authorities) is untouched, with its
full unit suite including the mutation harnesses.

`lib/ai/forecast/` was **split rather than deleted**, which is the one behavioural
change in this commit:

- **kept** `streams.ts` (the bounded ledger read), `assemble.ts` (the one
  execution seam), `pay-dates.ts` (FORECAST-16's licensed dates);
- **removed** the natural-language half — `horizon.ts`, `statements.ts`,
  `fact-continuity.ts` — and the narration half, `render.ts` and
  `numerical-guard.ts`.

`assembleForecast` previously took `question: string` plus the whole message
history and ran two regex extractors inside a deterministic module. It now takes
`statements: UserStatement[]` — **FORECAST-8's own typed vocabulary, already in
`lib/forecast/policy.ts`** — and calls `routeStatement` to decide where each one
belongs. `resolvePayDates` takes an explicit ask and window instead of a
sentence. The properties that mattered survive and are now pinned:

- an `ASSERTS_FACT` reaches the **operating state**; anything else becomes a
  `PolicyAssumption` — the FORECAST-8 distinction, structurally;
- the **last** statement about a subject wins, so a correction is an append;
- two movements sharing a day and a role stay two movements (the identity defect
  that once lost a $1,500 payout behind a $15,500 bonus);
- `UNKNOWN` is never downgraded into a basis;
- **no regular expression is declared anywhere in the module**, asserted by test.

New file: `lib/ai/forecast/assemble.test.ts` — 34 checks over the real-Space
fixture carried across from the deleted integration suite. It exists because the
extraction changed a deterministic financial module and the tests that covered it
were deleted along with the architecture they mostly measured.

`AI_FORECAST_PROJECTION` was **kept**. It is not conversation machinery: it
selects between two deterministic engine results, both computed and tested.

---

## 6. What remains available to the future conversation layer

These are the clean extension points. None requires the removed architecture, and
none is a stub.

| Seam | Signature, in one line |
|---|---|
| **Grounded context** | `buildContext(spaceId, userId, { scopeHint, transactionWindow, drilldown, evidence, question })` → `SpaceContext_AI` |
| **Evidence census** | `loadCoverageEnvelope(spaceId)` → what exists vs. what was loaded, in four states |
| **Domain resolution** | `resolveDomains({ manifest, agentScope, evidence, question })` → domains + a reason per decision |
| **Deterministic assessment** | `computeAssessment(ctx)` → `FinancialAssessment`, graded or explicitly ungraded |
| **Debt rollup** | `fetchPerLiabilityDebtPayments(ctx)` → payments per creditor |
| **Concept composition** | `composeInvestments(accounts)` → a composition, or a refusal to compose |
| **Bounded lists** | `boundedSelection(all, limit)` → items **plus their denominator** |
| **Forecast** | `loadForecastIncomeStreams(...)` → `assembleForecast({ ctx, streams, horizon, asOfISO, statements })` → `CashForecast` |
| **Pay dates** | `resolvePayDates(streams, asOfISO, { ask, stated })` → licensed dates, or none with a reason |
| **Transactions** | `queryTransactions(...)` — the canonical keyset read authority, with every drilldown selector |
| **Visibility** | `TRANSACTION_DETAIL_VISIBILITY` — one predicate, fails closed |
| **The model** | `generateChatReply` / `generateStructured` in `lib/ai/provider.ts` — the only OpenAI import site |

Everything above is deterministic except the last row.

---

## 7. What comes next — and what must not

**No replacement architecture has been chosen.** Deliberately.

**The next design starts from exemplar conversations, not from the previous
architecture.** Write the transcripts first — the ones in §2, and the dogfood
session in §3 answered the way a person would answer them — and let the required
machinery fall out of what those transcripts need. Do not start from the list of
things that were removed and ask which to rebuild; that list is a record of nine
programmes each solving the previous one's side effects.

Three things the removed layer learned that are worth carrying, stated as
constraints on any design rather than as components to port:

1. **Possession of a number is not permission to use it.** A current figure and a
   future figure that happen to be equal are different claims. Conversational
   history can never mint an authority.
2. **A refusal is an answer to a question; make sure it is the question asked.**
   "Ending cash: REFUSED" in front of "when is payday" reads as the system
   failing, not as care.
3. **A safety mechanism that changes what the user reads is part of the product.**
   The figure dump in §3 was the safety net, and it was the worst artifact of the
   session. Whatever polices the next layer has to be judged on the sentence the
   user ends up reading.

And one that this reset itself is the evidence for: **when the answer to a
measured failure is a fourth guard, the architecture is the failure.**

---

## 8. Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean (0 errors outside the gitignored `prototype/` harnesses, which are excluded from the app tsconfig and were already failing at `HEAD~1`). |
| `npm test` (`scripts/run-tests.ts`) | **490/490 passed.** Baseline before the purge: 517/517. 28 test files deleted, 1 added. |
| `next build` | Compiles; route count drops by 0 (the chat route remains, answering 503). |
| Registry ↔ disk reconciliation | `npm run audit:list` clean — 14 tombstones, no orphans in either direction. |
| Schema | Unchanged. **No migration.** |
| Reader-less by design | `lib/ai/provider.ts`, `lib/ai/intelligence/debt-payments.ts`, `lib/ai/forecast/{assemble,streams,pay-dates}.ts`. All are preserved capability with tests, not dead adapters. |
