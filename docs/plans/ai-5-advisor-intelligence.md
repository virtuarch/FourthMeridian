# AI-5 — Advisor Intelligence (Initiative Proposal)

**Status:** **APPROVED** 2026-07-02 — initiative allocated as AI-5 in the STATUS.md §3 ledger (Planned). Design record; no implementation yet.
**Date:** 2026-07-02
**Owner milestone:** v2.6a (approved — `docs/ROADMAP_REVISION_PROPOSAL_2026-07.md`)
**Depends on:** v2.4.5 exit (validator live ✅, KD-17 category-correctness fix), KD-16 window resolver.
**Gates:** v2.6b Ambient Intelligence — the system may not speak unprompted until it can hold a coherent conversation when prompted.

---

## 1. Thesis

v2.4.5 made every individual answer trustworthy. The remaining failures are all *between* answers: the AI changes time windows without saying so, contradicts its own availability claims, computes downstream metrics from inputs it just flagged as incomplete, leaks implementation limits, and caveats like a compiler. These are not data defects — they are the absence of an advisor-level conversational state.

**Design doctrine (inherited, non-negotiable):** deterministic-first. AI-5 adds a *deterministic, persisted conversation-state layer* that the intent classifier, context builder, and prompt serializer consume. It does not add a second reasoning LLM above the validator. The validator, context builders, and financial engine remain authoritative; if any LLM pass is added (WS-6), it sits **below** the validator and may never introduce numbers.

## 2. Architecture sketch

```
User turn
  → Intent classification            (existing, consumes state)
  → ConversationState read/update    (NEW — deterministic)
      • active time window + provenance (explicit | inherited | default)
      • active entities (accounts, categories, merchants, goals)
      • last resolved intent + last answered window
      • disclosed caveats (income completeness, truncation, estimates)
      • conversation goal (payoff plan, budget review, …)
  → Context selection / builders     (existing, consume state)
  → Financial engine + assessments   (existing, authoritative)
  → Prompt serialization             (existing + state-aware disclosures)
  → LLM                              (narrates, as today)
  → Validator                        (authoritative, unchanged position)
  → [optional presentation pass]     (WS-6, below validator, no new numbers)
  → Response
```

## 3. Workstreams

### WS-1 · Conversation State Substrate
The core. A persisted, deterministic `ConversationState` object (per conversation, versioned schema) with a single read/update path in the chat route. Replaces per-turn re-derivation heuristics (`resolveTransactionWindow`'s message-rescanning, follow-up keyword scans) as the source of continuity.
*Exit:* one state object drives window + entity continuity; follow-up heuristics demoted to state-update signals; state round-trips across requests; characterization tests.

### WS-2 · Active Window & Context-Change Disclosure
Builds on KD-16. The state carries the active window and its provenance; any turn whose effective window differs from the previous answered window triggers a mandatory, serializer-emitted disclosure ("previous answer covered 24 months; this one covers YTD — because you asked 'since January'").
*Exit:* the two observed failures (silent 2-month → YTD switch; 24-month → "only three months") are reproduced as tests and pass; no reply changes window silently.

### WS-3 · Confidence & Completeness Propagation
Extends the KD-7/KD-10 honesty pattern from transactions to *derived assessments*. Assessment inputs gain completeness metadata (income completeness, truncation, estimate provenance); savings rate, runway, cash-flow quality, and investment readiness either carry the caveat forward into their prompt blocks or are withheld (KD-10's `null` doctrine) — deterministically, in `annotations.ts`, not by prompt exhortation.
*Exit:* an income-completeness warning provably reaches every downstream metric's prompt block or suppresses it; no derived metric is presented clean when an input was flagged.

### WS-4 · Intent-Path Consistency
Companion to KD-16 and successor to KD-11's deferred reconciliation: one window resolver, one entity resolver, shared by summary/drilldown/trends/gap-gating. Availability claims ("I only have…") may originate *only* from assembler-reported truncation/absence, never from context-selection defaults.
*Exit:* KD-16 acceptance criteria green; cross-intent contradiction corpus green.

### WS-5 · Graceful Context Compression
Long conversations currently die at the KD-3 body guard ("Too many messages in one request (max 50)"). Replace the raw 400 with deterministic history compression: retain system-relevant turns + running summary + ConversationState (which already preserves continuity), and disclose compression in the prompt. Implementation limit never reaches the user.
*Exit:* >50-message conversations continue coherently; the raw limit string is unreachable from the UI; state survives compression.

### WS-6 · Advisor-Quality Presentation
Validator notices and caveats rendered as advisor language. First pass is template-work (deterministic phrasing variants keyed to notice type + context). Only if templates prove insufficient: a post-validator rephrase pass, hard-constrained (may not add/alter numeric tokens; validator re-runs on its output; fails open to the template).
*Exit:* no user-visible mechanical notice strings; any rephrase pass is provably number-preserving.

### WS-7 · Follow-up & Goal Reasoning (stretch — cut first)
Conversation-goal tracking in state (e.g., an active payoff plan), so multi-turn advisory flows resume instead of restarting, and the debt-payoff missing-data behavior (already good) becomes a pattern: request → remember → resume.
*Exit:* one end-to-end multi-turn advisory flow (payoff planning) resumes across turns and across the WS-5 compression boundary.

## 4. Sequencing & dependencies

WS-1 first (everything consumes it). WS-2 + WS-4 next (both are KD-16-adjacent; smallest user-visible wins). WS-3 parallel-safe (lives in the deterministic engine). WS-5 after WS-1 (compression must preserve state). WS-6 last of core. WS-7 stretch.

KD-17 (category sign asymmetry) is **not** AI-5 scope — it is a v2.4.5-class correctness defect and must land before WS-3 builds on category figures.

## 5. Non-goals

No second authoritative LLM; no LLM above the validator. No ambient/unprompted behavior (v2.6b). No marketplace/billing/messaging surface (§8 doctrine). No re-litigation of Phase-2 decisions.

## 6. Initiative-level exit criteria

- The eight observed conversation-quality failures from the 2026-07 testing session are each reproduced as a test and pass.
- One week of natural-usage testing with zero contradictory availability claims and zero silent window changes.
- Every derived metric either carries its input caveats or is withheld — verified by test, not prompt prose.
- Validator remains byte-position authoritative; any presentation pass is number-preserving by construction.
