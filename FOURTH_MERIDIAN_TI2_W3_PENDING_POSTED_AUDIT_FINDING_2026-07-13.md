# TI2-W3 — Pending↔Posted Disclosure Dedup: Gate Audit Finding (Closed, No Code Change)

**Date:** 2026-07-13
**Slice:** TI2-W3 (gated) — pending↔posted disclosure dedup in the `buildContext()` transactions assembler.
**Outcome:** **Closed without implementation.** The gate audit shows the defect does not occur; the write-path tombstone already prevents it. Recorded here so a future audit does not re-raise the same question from scratch.
**Source of scope:** `FOURTH_MERIDIAN_TI2_BUILDCONTEXT_WIRING_INVESTIGATION_2026-07-13.md` §4.1 and §6 ("Pending↔posted disclosure" row); `CLAUDE_CODE_PROMPT_ti2_w3_pending_dedup_gated_2026-07-13.md`.

---

## The question the gate answers

Money totals in the AI transactions assembler are already safe: `incomeTotal` / `expenseTotal` / `netCashFlow` are **settled-only** (`lib/ai/assemblers/transactions.ts` — pending rows never enter them), and Plaid tombstones a pending row when it posts (`lib/plaid/syncTransactions.ts:454–471`), which every read filters via `deletedAt IS NULL`. So in the normal lifecycle a pending predecessor is not even fetched.

The only residue W3 would protect against is a **missed or delayed `removed[]`**: a *live* pending row coexisting with its *live* posted successor, inflating `pendingDebitTotal` / `pendingDebitCount` / `transactionCount` and possibly firing a stale `PENDING_DEBIT` signal. W3 is explicitly **gated**: implement the dedup pass only if that condition actually occurs in the corpus.

## The audit

A permanent, read-only validation command was added following this repo's `audit:flow-desync` idiom:

- **Script:** `scripts/audit-pending-posted-desync.ts`
- **Command:** `npm run audit:pending-posted`

It counts DISTINCT live pending rows `P` (`pending = true`, `deletedAt IS NULL`, `plaidTransactionId` set) for which a live posted row `Q` (`deletedAt IS NULL`) has `Q.pendingTransactionRef = P.plaidTransactionId` — exactly the `PENDING_AWAITING_POST` relationship in `RelationshipResolver.resolvePendingPosted`.

## Result (2026-07-13, dev corpus)

```
live pending rows (corpus)              : 0
…with a live posted successor (defect)  : 0

[AUDIT] PASSED — zero live pending rows have a live posted successor.
```

The defect count is **0**. (The corpus additionally has **0** live pending rows at all right now, so there is nothing for a dedup pass to correct even in principle.)

## Decision

- **Do NOT implement** the TI2-W3 §2 dedup pass. Building a correction for a defect the write path already prevents would be speculative complexity (the investigation's own stop condition).
- **No change** to `lib/ai/assemblers/transactions.ts`, `lib/ai/types.ts`, or any accumulator. No new `plaidTransactionId` / `pendingTransactionRef` columns were added to the assembler query.
- The audit command is retained as the **standing gate**: if a future change to the sync/tombstone path is suspected of leaving live pending predecessors, run `npm run audit:pending-posted`. A non-zero count is the trigger to reopen TI2-W3 §2 (in-memory `Set` pass + a `pendingAlreadyPostedCount` / `pendingAlreadyPostedTotal` disclosure field — disclosure over silent correction, per KD-7 / KD-17 / KD-18).

## Explicitly still out of scope (regardless of the audit)

Per the investigation §4.2 / §4.3: duplicate detection in `buildContext` (would re-verify write-time dedup; cross-source duplicates sail through either way), `transferCandidate` / `refundCandidate` in the summary domain (explanation-scoped, belongs to the drilldown path), and any persistence of a relationship fact (the ratified TI4 read-time posture stands).
