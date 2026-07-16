# AI

## Purpose

The AI subsystem is Fourth Meridian's Space-scoped financial chat. Its governing
doctrine is **deterministic-first**: the system computes provenance-carrying
facts and assessments deterministically, and the LLM only *narrates* them. The
model is an interpreter of grounded context, never a financial authority — it is
structurally prevented from calculating figures, inventing data, or seeing
account data the requesting Space is not permitted to see.

## Authority

- **The provider boundary** — `lib/ai/provider.ts` (`generateChatReply`) is the
  ONLY file in the codebase permitted to import the OpenAI SDK. Model:
  `gpt-4o-mini`. Every AI feature calls through here so the provider stays
  swappable behind one seam.
- **Context assembly** — `lib/ai/context-builder.ts` (`buildContext`) is the one
  entry that turns a Space into grounded `SpaceContext_AI`, via the assembler
  registry (`lib/ai/assemblers/`).
- **Visibility** — `lib/ai/visibility.ts` (`grantsTransactionDetail`,
  `grantsAccountDetail`, `TRANSACTION_DETAIL_VISIBILITY`) is the single
  predicate deciding which account data may enter AI context.
- **Output validation** — `lib/ai/output-validator.ts` (`validateOutput`,
  `applyEnforcement`) holds the LLM's numeric claims to the grounded prompt.
- **Intent routing** — `lib/ai/intent/classifier.ts`
  (`classifyFinancialIntent`) is a pure deterministic router.
- **The chat endpoint** — `app/api/ai/chat/route.ts` orchestrates permission,
  context, prompt, model call, validation, and response.

## Inputs

- **Request** — `{ spaceId: string | "master", messages: [{ role, content }] }`
  to `POST /api/ai/chat`.
- **Session + membership** — the authenticated user and their `SpaceMemberRole`
  (server-side query; `VIEWER` is rejected).
- **Space financial context** — assembled from accounts, transactions,
  snapshots, goals, and holdings, gated by each account link's
  `visibilityLevel`.
- **The user's own prior turns** — a secondary reconciliation source for the
  output validator (a user may quote a figure the model echoes).
- **`AI_OUTPUT_VALIDATION_MODE`** — env var selecting enforcement
  (`shadow | annotate | block`; default `annotate`).

## Outputs

- **Response** — `{ message, knowledgeGaps, knowledgeGapMode }`. `message` is
  the (possibly enforcement-adjusted) reply; `knowledgeGaps` mirrors the
  deterministically-computed missing fields so the client renders structured
  input cards; `knowledgeGapMode` is `"form" | "clarification"`.
- **`ApiUsageCounter` rows** — call and token counts recorded (fire-and-forget)
  per model after each completion.
- **`AuditLog` rows** — `AI_CONTEXT_ASSEMBLED` (inside `buildContext`),
  `AI_CONTEXT_SELECTION_PLANNED` (shadow), and `AI_OUTPUT_VALIDATION_FLAGGED`
  when a numeric claim fails to reconcile.

## Canonical contracts

- `generateChatReply(systemPrompt, messages)` (`lib/ai/provider.ts`) — the sole
  sanctioned path to the LLM.
- `SpaceContext_AI` and its sub-types (`lib/ai/types.ts`, re-exported from
  `lib/ai/index.ts`) — the assembled grounded context.
- `KnowledgeGap` (`lib/ai/types.ts`) — a field the user has not entered,
  computed at context time (e.g. by the accounts assembler).
- `IntentRoute` / `classifyFinancialIntent` (`lib/ai/intent/`) — deterministic
  routing hints.
- `ValidationResult` / `validateOutput` and `EnforcementMode` /
  `applyEnforcement` (`lib/ai/output-validator.ts`).
- `TRANSACTION_DETAIL_VISIBILITY` + the `grants*` predicates
  (`lib/ai/visibility.ts`).
- `FinancialAssessment` / `computeAssessment` (`lib/ai/intelligence`) — the
  deterministic assessment the model narrates.

## Persistence

- **The AI subsystem writes no chat state.** There is no `Conversation`,
  `ChatMessage`, or `conversationId` model in `prisma/schema.prisma`, and the
  chat route header explicitly lists "conversation persistence, memory" as not
  implemented. Each request is stateless: history is whatever the client sends
  in `messages`.
- **Knowledge gaps are not a persisted table.** They are recomputed
  deterministically at context time and surfaced to the client. When a user
  wants to *save* a gap value (e.g. APR), the client's save form writes it to
  the account's own fields — the chat never persists it. The prompt rules force
  the model to state plainly that a value supplied in conversation has NOT been
  saved.
- **What is persisted is audit and usage only** — `AuditLog` (context assembled,
  selection planned, validation flagged) and `ApiUsageCounter` (calls/tokens).

## Consumers

- **`app/api/ai/chat/route.ts`** — the primary consumer, for both a single Space
  and `"master"` (all eligible Spaces aggregated via `Promise.allSettled`, each
  with a per-Space boundary in the prompt).
- **The assembler registry** — assemblers self-register on import via the
  barrel (`lib/ai/assemblers/index.ts`), so `buildContext` sees them all.
- **Other AI features** must go through `generateChatReply`; direct SDK use
  anywhere else is forbidden.

## Invariants

- **Single provider seam.** Only `lib/ai/provider.ts` imports `openai`. The
  route re-asserts this; `lib/ai/index.ts` inherits the `server-only` guard.
- **The model narrates, it never calculates.** Every figure the model may state
  is already present, formatted, in the grounded system prompt. The output
  validator enforces this by *membership with tolerance*: each flag-eligible
  numeric claim in the reply must reconcile — within `max($0.01, 0.5%)` plus
  coarse-rounding tolerance — to a number in the prompt or a prior user turn.
  Bare integers (years, counts) are not flag-eligible, keeping false positives
  near zero.
- **Enforcement is append-only and non-destructive.** `annotate` appends one
  fixed caveat; `block` replaces the reply with a fixed notice; `shadow` leaves
  it unchanged. The model's own text is never edited, so a false positive costs
  a redundant caveat, never a corrupted answer. Validation failures are
  swallowed (non-fatal) so they can never break the chat.
- **Visibility fails closed.** Transaction-level detail enters context only from
  links with `FULL` visibility. `BALANCE_ONLY` contributes balance totals only —
  its rows never enter a prompt. `SUMMARY_ONLY`, `PRIVATE`, and legacy `SHARED`
  are excluded. Absence of a grant is exclusion. The transactions-summary and
  drilldown queries share the one predicate so they cannot disagree.
- **Attribution honesty (never invent a per-account breakdown).** When a total
  is correct but no per-account rollup exists, the prompt is instructed to
  answer along a dimension that IS present, then disclose once that per-account
  attribution is unavailable. The membership validator cannot catch a fabricated
  split (the total is right), so this is enforced by a prompt rule plus the fact
  that the dimension is simply absent from context.
- **Coverage/truncation honesty.** When a transactions summary is fetch-capped,
  the prompt states the covered date window and that earlier data is not
  included, so truncated figures are never presented as complete.
- **No persistence claims.** The model is instructed never to claim it saved,
  remembered, or will persist a user-supplied value across sessions.
- **`VIEWER` is excluded** from AI chat (same rule as the Daily Brief);
  `buildContext` carries a second membership guard as defense in depth.

## Known limitations

- **No conversation state.** No streaming, no persisted history, no memory, no
  model-initiated actions — each turn is stateless. The client owns history.
- **Knowledge is not durably captured by the chat.** Gaps are recomputed, and
  saving a value is a deliberate form write to the account, not a chat side
  effect. There is no learned per-user knowledge store.
- **Output validation is membership-only.** It verifies a claimed number exists
  among the sources; it cannot verify the model applied it to the *right*
  question, which is why the attribution guardrail is a separate prompt-level
  defense.
- **Default enforcement is `annotate`, not `block`.** An unverified figure is
  flagged, not withheld, unless the env mode is set to `block`.
- **Numeric-form coverage is bounded.** The validator handles money, percent,
  coverage-months, and k/M/B abbreviations; documented forms like numeric ranges
  and scientific notation are intentionally out of scope.

## Extension points

- **Add an assembler** — create `lib/ai/assemblers/<domain>.ts`, call
  `registerAssembler` at its foot, add one import line to the barrel.
- **Swap the model or provider** — change `CHAT_MODEL` (or the client) in
  `lib/ai/provider.ts`; no route or business logic changes.
- **Tune enforcement** — set `AI_OUTPUT_VALIDATION_MODE`
  (`shadow | annotate | block`) with no code change; it is the kill switch back
  to observational.
- **Add an intent** — extend the ordered rules in
  `lib/ai/intent/classifier.ts` (pure; more-specific intents first).
- **Widen visibility rules** — only by editing `lib/ai/visibility.ts`, which
  requires re-auditing `SpaceAccountLink.visibilityLevel` first.

## Why the architecture is this way

The subsystem is built on the premise that an LLM is an unreliable calculator
but a capable narrator, and that a personal-finance product cannot ship a
figure it cannot vouch for. So the numbers are computed deterministically with
provenance and handed to the model already formatted; the model's job is to
explain them in plain language. The output validator then closes the loop by
*checking* — not trusting — that every figure in the reply traces back to a
grounded source, and it does so by membership rather than recomputation so it
stays a pure, fast, side-effect-free string function.

The single provider boundary exists so the vendor is one seam, not a hundred
call sites — the codebase can move off OpenAI without touching a route. The one
visibility predicate exists because a privacy rule duplicated is a privacy rule
that eventually disagrees with itself; sharing the `FULL` gate across the data
layer and the assemblers means transaction detail and identifying fields can
never leak through a drifted copy, and the rule fails closed by construction.
Conversation persistence and durable memory are deliberately *not* built yet:
statelessness keeps the trust surface small while the deterministic-and-narrate
core is proven out, and the prompt is explicit that the model must never imply a
persistence capability it does not have.
