# Roadmap Revision Proposal — Post-Hardening AI Evolution

**Status:** **APPROVED & APPLIED** 2026-07-02 — the recommended structure is now live in STATUS.md §5 (v2.4.5 absorbs KD-17 + max-50 copy fix; v2.5.5 Financial Intelligence added; v2.6 split into v2.6a/v2.6b; KD-16/KD-17 in the §7 register; AI-5 in the §3 ledger). This document is now an immutable decision record; STATUS.md is the current-state authority.
**Date:** 2026-07-02
**Baseline:** STATUS.md §5 (v2.4.5 → v2.5 → v2.6 → v3.0), with KD-2/3/4/5/7/10/11/13/15 complete or in closeout.

---

## Part 1 — Do the conversation-quality issues belong after v2.4.5?

**Yes, with two carve-outs.** v2.4.5 is a correctness gate; its exit criteria (privacy tests, live validation, atomicity, observability, rate limits) are unaffected by conversation quality. Adding orchestration scope would delay the production gate for work that doesn't move it. The tested issues — silent window changes, unexplained context switches, mechanical validator notices, non-propagated uncertainty, cross-intent contradictions, the max-50 leak — are v2.6a scope (AI-5).

**Carve-out 1 — KD-17 (January "Other" anomaly) is NOT conversation quality.** The investigation (`docs/investigations/KD17_JANUARY_OTHER_CATEGORY_ANOMALY_INVESTIGATION.md`) confirms a deterministic aggregation defect: category rollups use `abs(signed net)` including credits while `expenseTotal` counts debits only, so a credit categorized `Other` produces mathematically impossible figures that the membership validator cannot catch. That is precisely the defect class v2.4.5 exists to close. **Recommend: absorb KD-17 into v2.4.5 scope.** (It also blocks AI-5 WS-3, which would otherwise propagate confidence onto corrupted category figures.)

**Carve-out 2 — the "Too many messages (max 50)" raw error string.** The graceful-compression *design* is AI-5 WS-5, but replacing the leaked internal string with a user-facing message is a copy-level fix that can ride v2.4.5 hygiene at near-zero risk.

Also log KD-16 (contradictory availability claims across intent paths) in the register **now**, owned by v2.6a — unlogged defects rot even when correctly deferred.

## Part 2 — Evaluation of the proposed structure

Proposed: **v2.5 Financial Intelligence** (flowType, transaction semantics, metadata, cleanup) → **v2.6a Advisor Conversation Layer** → **v2.6b Ambient Intelligence**.

**The sequencing instinct is right; the v2.5 rescope is the flaw.**

What's right:
- Data semantics before advisor behavior before ambient behavior is the correct dependency chain. Confidence propagation (AI-5 WS-3) is only as good as the transaction semantics underneath it, and KD-17's side findings (`Fee` mapped but excluded from `BANKING_CATEGORIES`; `Groceries` unreachable from the Plaid mapper; no explicit sign doctrine for category rollups) are fresh evidence that a dedicated transaction-semantics milestone has real content — flowType (`docs/investigations/TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md`) and metadata depth already have investigations waiting.
- The 2.6a/2.6b split formalizes the existing gate ("may not speak unprompted until it cannot misquote a number") and extends it: **may not speak unprompted until it can hold a coherent conversation when prompted.**

What's wrong:
- Renaming v2.5 to Financial Intelligence **silently drops the current v2.5 scope**: SAL read-cutover, WorkspaceAccountShare retirement, legacy `Account` out of read paths, visibility enforcement in every assembler, design tokens. That is open migration debt — dual-write seams and dual read paths age badly, and every month they stay open, new code (including Financial Intelligence itself) builds on two sources of truth. Seam closure must not lose its milestone.
- Financial Intelligence *wants* v2.5's output: single read path, legacy tables retired. Doing transaction-semantics work while the legacy `Account` path still feeds readers means doing it twice.

## Recommended structure

| Milestone | Name | Scope | Gate to next |
|---|---|---|---|
| **v2.4.5** | Stabilization / Verification | As today **+ KD-17 fix + max-50 copy fix**; log KD-16 | All existing exit criteria; category invariant checked, not prose |
| **v2.5** | Spaces Completion + Design Foundation | **Unchanged** (SAL cutover, WAS retirement, legacy Account out, UI-1 tokens) | Zero WAS reads; zero legacy-Account reads; two-user BALANCE_ONLY proof |
| **v2.5.5** | **Financial Intelligence** *(new)* | flowType classification; transaction-semantics doctrine (sign rules, Fee/Groceries reachability, category population contracts); metadata depth; transaction cleanup tooling; KD-6 re-encryption rides here if not done in v2.5 | Semantics contracts test-enforced; one canonical aggregation doctrine across summary/monthly/drilldown |
| **v2.6a** | **Advisor Intelligence (AI-5)** | Conversation state substrate; window/context-change disclosure; confidence propagation; intent-path consistency (KD-16); graceful compression; advisor-quality presentation | The eight observed failures reproduced as tests and green; no silent window change; no contradictory availability claims |
| **v2.6b** | Ambient Intelligence | Current v2.6 scope (scheduler/D5, AiAdvice path, Daily Brief, signals→notifications, AI Inbox, planner live, KD-9, KD-12, KD-14) | One week of scheduled briefs, zero validator failures — unchanged |
| **v3.0** | Launch (L-1) | Unchanged, zero new surface | Unchanged |

Notes:
- v2.5.5 is deliberately a *point* milestone: pure data-semantics, no new product surface, no UI beyond what cleanup tooling needs. If it grows product ambitions, that is scope creep — cut it back.
- KD-8 (master-mode prompt bounds / silent Space omission) fits v2.6a WS-2/WS-5 more naturally than its current v2.5–v2.6 straddle.
- Plaid production application still starts during the v2.6 window (longest external lead time) — the a/b split doesn't move it.
- The AI evolution ladder, stated as doctrine: **v2.4.5 makes every answer honest → v2.5/v2.5.5 make the data it speaks from singular and semantically sound → v2.6a makes conversations coherent → v2.6b earns the right to speak unprompted → v3.0 sells it.** Each phase's exit criteria are the next phase's entry criteria.

## Decisions (resolved 2026-07-02)

1. KD-17 absorbed into v2.4.5 — **approved**.
2. v2.5.5 accepted as a new point milestone — **approved**.
3. AI-5 initiative charter (`docs/initiatives/ai5/AI-5_ADVISOR_INTELLIGENCE_PROPOSAL.md`) and KD-16 register entry (`docs/investigations/KD16_INTENT_PATH_WINDOW_CONSISTENCY_PROPOSAL.md`) — **approved and logged**.

All three applied to STATUS.md (§3 ledger, §5 roadmap, §7 register, §11 summary) on 2026-07-02.
