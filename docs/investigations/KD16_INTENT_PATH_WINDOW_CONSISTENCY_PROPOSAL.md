# KD-16 — Contradictory Data-Availability Claims Across Intent Paths

**Status:** **LOGGED** 2026-07-02 as KD-16 in the STATUS.md §7 register. Design record; no implementation.
**Date:** 2026-07-02
**Severity:** Medium-High — correct figures, contradictory availability claims; directly erodes the trust the v2.4.5 hardening bought.
**Owner milestone:** v2.6a (Advisor Intelligence / AI-5).

---

## 1. Problem statement

Within a single conversation the AI produced a complete 24-month month-by-month comparison, then — on the immediately following, semantically equivalent question ("show me my spending trend since 2024") — claimed it could only provide the last three months. Both replies drew on the same underlying data. The system asserted two contradictory statements about its own data availability, minutes apart, with no numeric error for the validator to catch.

## 2. Root architectural concern

**The active time window is not conversational state — it is re-derived per turn from message-text heuristics, and its failure mode is a silent fallback.**

Evidence (`app/api/ai/chat/route.ts:289-313`, `resolveTransactionWindow`):

1. If the latest message parses to an explicit window (`classifyFinancialIntent` → `windowOptionFromRoute`), use it — "last 24 months" parses, yielding an ~24-month window (clamped by `MAX_EXPLICIT_WINDOW_DAYS = 800`, `lib/ai/assemblers/transactions.ts:165`).
2. Else, inherit a previous window **only if** `looksLikeFollowUp(latest)` fires.
3. Else `undefined` → the assembler's default rolling window: **90 days** (`WINDOW_FULL_DAYS`, `transactions.ts:136,787`).

For "since 2024" specifically, the classifier **does** match an explicit year (`lib/ai/intent/classifier.ts:392-408`) — but resolves it to the **closed calendar year** (2024-01-01 → 2024-12-31, `isPastYear` branch), semantically misreading "since 2024" (= 2024 → today) as "in 2024". The floor is then silently clamped by `MAX_EXPLICIT_WINDOW_DAYS = 800` (≈ 2024-04-24 as of 2026-07-02) with no disclosure. Meanwhile the SPENDING TRENDS block reports "Complete months analyzed: N" (`app/api/ai/chat/route.ts:1358-1371`), which the model then narrates as a capability limit ("I can only provide…"). Whichever combination produced the observed reply, every candidate mechanism is a *silent context-selection divergence* — the user asked one window, got another, and was told it was a system limit.

Four compounding factors:

- **Semantic misread:** "since <year>" resolves to a closed past-year window, not year-to-present — a deterministic wrong answer to the user's actual question.

- **Silent degradation:** the prompt never tells the model "this is a default window, not the user's request," so the model presents a context-selection artifact as a system limitation.
- **Heuristic divergence:** each intent path (explicit window, follow-up inheritance, drilldown bounds, ambiguity guard) resolves the window independently; the same defect class KD-11 co-located but explicitly deferred reconciling ("intentionally different token sets… deferred to a future ticket," `lib/ai/intent/keywords.ts`).
- **No memory:** nothing persists the previously honored window, so the system cannot notice it is contradicting the answer it gave one turn earlier.

The validator is structurally blind here (KD-2 caveat: membership, not consistency) — every number in both replies reconciles.

## 3. Proposed scope

1. **Window-resolution characterization suite** (extends the KD-11 pattern): pin current behavior for a canonical phrasing corpus — "last N months", "since <year>", "since <month>", "YTD", "this year", "trend since 2024", bare follow-ups. Documents today's gaps before anything changes.
2. **Fix the semantic gaps** the corpus exposes in `classifyFinancialIntent` — "since <year>" must resolve to year-start → today (not the closed calendar year); genuinely unparsed phrasings must be distinguishable from "no window requested". Vocabulary/semantics work only, no architecture change.
2b. **Disclosed clamping:** when `MAX_EXPLICIT_WINDOW_DAYS` trims a requested floor, the trim must be stamped into the context (like KD-7's `COVERAGE LIMIT`) so the model discloses it instead of silently answering over a shorter span.
3. **Disclosed fallback:** when the resolved window is a *default* (path 3), stamp that provenance into the assembler options and the prompt ("window: default 90-day — the user did not specify one"), and instruct the model to state the window it is answering over and offer the longer view — never to claim a capability limit.
4. **Single window resolver:** all intent paths (summary, drilldown, trends, ambiguity guard) must consume one resolved-window object rather than re-deriving bounds.
5. **(Boundary with AI-5/WS-1.)** Persisting the active window as durable conversation state is the Advisor Conversation Layer's job. KD-16 stops at: deterministic resolution, disclosed provenance, one resolver, tests. If AI-5 lands first, KD-16 items 3-4 become its acceptance substrate.

## 4. Acceptance criteria

- [ ] Characterization suite covers the phrasing corpus; every case asserts the resolved window (or documented default) — green.
- [ ] "Show me my spending trend since 2024" resolves to a Jan-2024 → today window (floor clamped by `MAX_EXPLICIT_WINDOW_DAYS`, with the clamp disclosed in the prompt), not a closed calendar-2024 window and not the 90-day default.
- [ ] Any reply produced under a *default* window states the window explicitly and never phrases it as a data or capability limit; a reply may only claim data is unavailable when the assembler reported truncation/absence (KD-7 sentinel or empty result).
- [ ] For any two consecutive turns with semantically equivalent window requests, the resolved windows are identical (test-asserted on the corpus pairs, including the 24-month → since-2024 reproduction).
- [ ] Exactly one window-resolution code path feeds all transaction-context consumers; grep-level check that no consumer re-derives dates from message text.
- [ ] `tsc --noEmit`, `lint`, and existing intent/classifier suites green; no prompt-format regression for explicit-window cases.

## 5. Non-goals

No persisted cross-request conversation state (AI-5 WS-1). No new NLU machinery beyond vocabulary additions. No change to `MAX_EXPLICIT_WINDOW_DAYS` or fetch-cap semantics (KD-7 governs honesty about depth).
