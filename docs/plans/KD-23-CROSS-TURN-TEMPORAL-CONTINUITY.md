# KD-23 — Cross-turn temporal continuity

**Status:** OPEN — NOT STARTED. Ticket only, by owner ruling (2026-10-14): *create the ticket, do not implement.*
**Successor to:** KD-16 (SUPERSEDED 2026-10-14; see [`/STATUS.md`](../../STATUS.md) §10 for the history).
**Surface:** `POST /api/ai/chat` — the conversation runtime under `lib/ai/conversation/`.
**Severity:** Medium (an honesty property, not a data defect: every figure the runtime returns is still the ledger's).

## 1. The property

A follow-up turn must either **answer over the same time window as the reply it follows**, or **say that the window changed and what it is now**. It must never do the third thing: answer a semantically equivalent follow-up over a different window without saying so.

This is the one part of the July AI-5 acceptance criterion ("no reply silently changes its time window") that the rebuilt runtime does not pin. KD-16's *mechanism* — a per-turn heuristic window resolver with silent clamps — was deleted with the conversation reset and is not the concern here.

## 2. Why it is not already closed (VERIFIED in code, 2026-10-14)

- **Within a turn**, time is honest by construction: `lib/ai/temporal-scope.ts` keeps *requested / selected / coverage / satisfied* apart; `lib/ai/coverage-envelope.ts` states what exists versus what was loaded; the two measured frames (`recent` 90-day, `activity` six-month, `lib/ai/conversation/activity-frame.ts`) have measured existence rules; `find_in_balance_history` and the exact temporal predicates take first/last/threshold dates off the model.
- **Across turns**, nothing carries the answered window. The runtime is stateless by design (`app/api/ai/chat/route.ts`: "nothing about a conversation is stored"); the sealed `HttpOnly` carrier (`lib/ai/conversation/runtime-state.ts`) holds the active scenario and a telemetry id, not the window of the previous answer. The model sees the prior prose turns and may re-choose a window on its own.
- No test, golden or harness check asserts the cross-turn property.

## 3. Scope (narrow, binding)

**In:** the cross-turn property in §1, for transaction-window questions (spending, income, cash flow, category) and their follow-ups ("and the month before?", "what about this year?", "is that more than usual?").

**Out:** re-introducing a window resolver; any new persistence of transcripts; widening or moving the `recent` assessment window (a9e6a6f §4.1 records why that is forbidden); scenario continuity (already carried by the sealed carrier); Daily Brief.

## 4. Order of work when it is picked up

1. **Measure first.** Add a follow-up corpus to the conversation harness (`docs/plans/AI-CONVERSATION-BASELINE-HARNESS.md`) and record how often the live runtime (a) keeps the window, (b) changes it and says so, (c) changes it silently. The ticket's severity is re-graded from that number before any design.
2. **Prefer a contract over a carrier.** The repository's own evidence is that tool *contracts* move behaviour where prompt rules do not (`bca5119`: a prohibition in a tool description took a 0/5 to 5/5; `7859d6c`: the tool's leading sentence decided routing). The first candidate is therefore a `window` statement in the tool results plus a disclosure rule, measured against the corpus — not a new field in the sealed carrier.
3. **Only if measurement demands it,** carry the last answered window in the sealed carrier (same `{assumptions, result}` discipline as the active scenario: one literal, cleared on failure) and have the runtime disclose a change.
4. Pin whatever ships in the harness and in a unit test over the pure pieces; record the before/after rates in the closure document.

## 5. Acceptance

- Harness: silent window changes 0/N on the follow-up corpus, and every window change is stated in the reply.
- No regression in the existing goldens, the scenario-continuity suite, or the two-frame product gate.
- `docs/systems/ai-foundation.md` (or its successor) describes the cross-turn window rule.

## 6. Record

| Date | Event |
|---|---|
| 2026-07-02 | KD-16 filed (STATUS ledger). |
| 2026-09-07 | KD-16 marked MOOT at the conversation reset ("there are no turns"). |
| 2026-09-13 | Conversation runtime promoted to production; the "moot" ground expired. |
| 2026-10-14 | Reassessed; KD-16 SUPERSEDED as filed; this ticket created by owner ruling. Not implemented. |
