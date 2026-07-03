# KD-18 — Debt-Payment Attribution Honesty Guardrail: Implementation Checklist

**Status:** Checklist only — awaiting approval. No code changes in this deliverable.
**Branch:** `feature/phase-2-architecture`
**Milestone:** v2.4.5 (absorbed 2026-07-02). **Guardrail only** — the per-liability payment capability is ratified into v2.5.5 FlowType (destination attribution requirement) and is explicitly OUT of scope here.
**Investigation:** `docs/investigations/DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md`
**Defect in one sentence:** the prompt presents per-month `debtPaymentTotal` scalars next to named liabilities with no statement that attribution is unknown, so per-account questions produce fabricated allocations that the membership validator structurally cannot catch.

---

## 1. The fix in one sentence

Tell the model — explicitly, in the serialized context — that debt payments (and account-dimension flows generally) are **not attributed per account**, and instruct it to answer per-account questions with the available totals plus a plain "per-account attribution isn't available yet," never an invented per-account split.

This adds **honesty, not capability**: no schema, no migration, no aggregation change, no new rollups, no UI.

## 2. Impact map

```
app/api/ai/chat/route.ts   ← ALL changes live here
  ├─ monthly breakdown section (debt payments / transfers lines)
  │     └─ [ADD] one-time attribution disclosure line
  ├─ system-prompt rules block (near the existing debtPaymentTotal rule, ~:970)
  │     └─ [ADD] non-attribution rule (debt payments, transfers, per-account
  │              interest/income/spending — the §6 watch-list class)
  └─ everything else                                          [UNCHANGED]

lib/ai/assemblers/transactions.ts    UNCHANGED (no aggregation change)
lib/ai/types.ts                      UNCHANGED
lib/ai/output-validator.ts           UNCHANGED (attribution stays out of its scope by design)
UI / schema / migrations             UNCHANGED
```

**Blast radius:** AI answers to per-account flow questions change from a fabricated table to totals + explicit limitation + (naturally) an offer of what it can answer. All other answers unchanged — the disclosure is one context line and one rule.

## 3. Affected files

| # | File | Change |
|---|------|--------|
| 1 | `app/api/ai/chat/route.ts` | Disclosure line in the monthly/debt serialization + non-attribution rule in the rules block. Both as named string constants so tests can pin them. |
| 2 | `app/api/ai/chat/attribution-guardrail.kd18.test.ts` (new; or co-located per repo preference) | Standalone tsx test: source tripwires that the constants exist and are pushed into the prompt lines; wording snapshot so the disclosure can't silently vanish or drift. |

**Explicitly NOT changed:** aggregation code, `debtPaymentTotal` semantics, drilldown, validator, schema, stored data, `mapPlaidCategory`, any UI. No `byLiability` rollup (that is the v2.5.5 capability).

## 4. Proposed content (for approval — do not code yet)

**Context disclosure** (once, in the monthly-breakdown section, adjacent to the existing "other flows" lines):

> ATTRIBUTION LIMIT: debt payments, transfers, income, and spending totals are NOT attributed to specific accounts/cards in this data. Totals are exact; which specific card/account a debt payment went to (or a transfer came from/went to) is not recorded here.

**Prompt rule** (in the rules block near the existing `debtPaymentTotal` rule):

> If the user asks for a per-card / per-account breakdown of debt payments, transfers, interest, income, or spending: state plainly that per-account attribution is not available yet, give the relevant totals, and offer what CAN be answered. NEVER construct a per-account or per-card table by allocating totals across accounts — any such allocation would be invented.

**Decision point for approval:** disclosure emitted always (recommended — simpler, deterministic, costs one line) vs. only when >1 liability exists (saves a line for single-card users; adds a conditional).

## 5. Validation checklist

- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] New KD-18 test green (constants exist, serialized, wording pinned)
- [ ] Existing suites still green: `transactions.kd17.test.ts`, `transactions.privacy.test.ts`, `output-validator.test.ts`
- [ ] Targeted chat test: re-ask "How much credit card debt have I paid from January to now? Show me month to month and each card" → expect monthly totals + explicit non-attribution statement; **no per-card columns**
- [ ] Negative check: an ordinary question ("what did I spend in January?") is unaffected

## 6. Rollback plan

Single revert of one commit. Prompt-text only; no data, no schema, no stored state.

## 7. Risks / notes

- **Perceived capability regression:** the AI previously "answered" per-card questions (falsely); it will now decline that slice. This is the point — release note should frame it as a corrected false claim, with the real capability scheduled (v2.5.5 FlowType).
- **Prompt-size cost:** ~2 lines. Negligible.
- **The rule is prose to the model** — same class as other prompt rules; the test pins its presence, not model obedience. Structural prevention arrives with the v2.5.5 `byLiability` data. If model non-compliance is observed, escalate wording or add a deterministic output check (out of scope here).
