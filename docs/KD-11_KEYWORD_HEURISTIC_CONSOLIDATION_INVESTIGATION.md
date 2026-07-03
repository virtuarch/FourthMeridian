# KD-11 — Duplicated / Drifting Keyword Heuristics (Chat Route vs. Intent Classifier)

**Status:** Investigation only. No code changes. No files edited. STATUS.md untouched.
**Branch:** `feature/phase-2-architecture`
**Date:** 2026-07-02
**Ticket (STATUS.md L146):** "Duplicated, drifting keyword heuristics between chat route and intent classifier; only classifier is tested" — Medium, target v2.4.5, Open.

---

## 1. Executive Summary

Two separate bodies of keyword/regex heuristics decide AI-chat behaviour, and they have already drifted
apart. The **tested, purpose-built** classifier lives in `lib/ai/intent/classifier.ts` (Layer 0, D4) and
is a pure `message → IntentRoute` function with a standalone test fixture (`classifier.test.ts`). A
**second, untested** pile of heuristics lives inline in `app/api/ai/chat/route.ts` (~L184–573): payoff
detection, update-intent detection, follow-up detection, ambiguity guarding, month parsing, and
drilldown resolution.

Three keyword sets exist in *both* files under near-identical names with **different contents**
(`PAYOFF_*`, `UPDATE_ACTION_*`, `UPDATE_FIELD_*`). Because each file re-derives the "same" intent from a
divergent word list, the classifier can route a message one way while the route's gap/form logic reacts
another way — a silent, per-message inconsistency that no test protects against.

The smallest honest fix is **not** a behaviour-preserving mechanical dedupe — the lists genuinely differ,
so consolidation forces a deliberate reconciliation. Recommended path: make `lib/ai/intent/` the single
authoritative home, land **characterization tests** capturing today's route behaviour first, then extract
the route's heuristics into tested submodules and collapse the duplicated keyword lists into shared
exported constants. This is additive (new modules + re-exports), leaves the route as a thin caller, and
touches **the same file KD-7 will touch** — so sequencing matters (see §6).

**Scope: detection/routing heuristics only.** No prompt-copy wording, no financial calculation, no
schema, no assembler logic is in KD-11 scope.

---

## 2. Impact Map

| Surface | File / lines | Role today | KD-11 effect |
|---|---|---|---|
| Intent classifier (authoritative candidate) | `lib/ai/intent/classifier.ts` | Pure `classifyFinancialIntent`; 9 ordered rules + `detectTransactionWindow` | Becomes single source of truth; gains re-exported shared keyword constants |
| Classifier tests | `lib/ai/intent/classifier.test.ts` | `tsx` fixture, exits 0/1; only tested heuristic surface | Extend to cover migrated route heuristics |
| Intent barrel | `lib/ai/intent/index.ts` | Exports classifier + prompt serializer | Add exports for shared keyword constants + new conversation heuristics |
| Chat route heuristics | `app/api/ai/chat/route.ts` L184–573 | Payoff / update / follow-up / ambiguity / month / drilldown heuristics (inline, untested) | Bodies move into `lib/ai/intent/`; route imports them |
| Chat route handler | `app/api/ai/chat/route.ts` L1643–1863 | Calls `routeForMessages`, `resolveTransactionWindow`, `resolveDrilldown`, `detectsPayoffIntent`, `detectsExplicitUpdateIntent`, ambiguity guard | Call sites unchanged in shape; imports repoint to intent module |
| Prompt serializers | `app/api/ai/chat/route.ts` `serializeContextBlock` / `serializeAssessmentBlock` | Consume domain data + route | **Out of KD-11 scope** but share the file (KD-7 territory) |
| Downstream consumers of `IntentRoute` | `serializeRoutingBlock` (`lib/ai/intent/prompt.ts`), `planContextSelection` (`lib/ai/context-priority`) | Read the route object | No contract change — `IntentRoute` shape is untouched |

**Blast radius:** two files change (`lib/ai/intent/*` grows, `app/api/ai/chat/route.ts` shrinks to a
caller). No API contract, no `IntentRoute` shape change, no DB, no migration.

---

## 3. Current Heuristic Map

### 3a. Lives in the classifier (`lib/ai/intent/classifier.ts`) — TESTED

- Keyword groups: `DEBT_WORDS`, `INVEST_WORDS`, `PAYOFF_WORDS`, `UPDATE_ACTION_WORDS`,
  `UPDATE_FIELD_WORDS`, `SPENDING_CUT_WORDS`, `CASH_FLOW_WORDS`, `GOAL_WORDS`, `ALIGN_WORDS`,
  `READINESS_WORDS`, `OVERVIEW_WORDS`, `STATUS_WORDS` (L42–105).
- 9 ordered `RULES` → `IntentRoute` (L151–301); `UNKNOWN` fallback (L304).
- `detectTransactionWindow(text, now)` (L341–416): `LAST_N_MONTHS`, `CALENDAR_MONTH` (last/this),
  `YTD`/explicit-year; `NUMBER_WORDS` map (L326); `MAX_LOOKBACK_MONTHS = 24`.

### 3b. Lives inline in the chat route (`app/api/ai/chat/route.ts`) — UNTESTED

| Heuristic | Lines | What it does |
|---|---|---|
| `PAYOFF_INTENT_KEYWORDS` + `detectsPayoffIntent` | L184–194, 552–557 | Gates whether `minimumPayment` knowledge gaps are returned |
| `UPDATE_ACTION_KEYWORDS` + `UPDATE_FIELD_KEYWORDS` + `detectsExplicitUpdateIntent` | L200–209, 566–573 | Gates `knowledgeGapMode: 'form' \| 'clarification'` |
| `FOLLOW_UP_PATTERNS` + `MONTH_NAME_RE` + `looksLikeFollowUp` | L252–285 | Window carry-forward eligibility |
| `FINANCIAL_SUBJECT_WORDS` + `namesFinancialSubject` | L326–336 | Ambiguity guard: is a breakdown self-descriptive? |
| `MONTH_DISPLAY` / `MONTH_NUM` + `buildBreakdownClarification` | L339–342, 395–398, 375–385 | Month-name → label / month number |
| `CATEGORY_SYNONYMS` / `NON_SPENDING_CATEGORY_SET` / `GENERIC_DRILLDOWN_SUBJECTS` / `DRILLDOWN_EVIDENCE_PATTERNS` + `detectDrilldownCategory` / `detectDrilldownMerchant` / `detectDrilldownLimit` / `resolveDrilldown` | L401–546 | Resolve a transaction drilldown request |
| `isAmbiguousBreakdownFollowUp` / `hasPriorFinancialContext` | L348–368 | Ambiguity guard entry points |
| `resolveTransactionWindow` | L297–316 | Carry-forward window (calls classifier per prior message) |
| `NON_SPENDING` (again) | L645 | Redefined a **third** time inside `serializeContextBlock` |

### 3c. Duplicated across both files (the core KD-11 defect)

| Concept | Classifier | Route | Same contents? |
|---|---|---|---|
| Payoff vocabulary | `PAYOFF_WORDS` (L54) | `PAYOFF_INTENT_KEYWORDS` (L184) | **No** — see §4 |
| Update action verbs | `UPDATE_ACTION_WORDS` (L61) | `UPDATE_ACTION_KEYWORDS` (L200) | **No** |
| Update field nouns | `UPDATE_FIELD_WORDS` (L66) | `UPDATE_FIELD_KEYWORDS` (L207) | **No** |
| Month-name parsing | `detectTransactionWindow` (calendar phrases) | `MONTH_NAME_RE` / `MONTH_NUM` / `MONTH_DISPLAY` (bare month names) | **Overlapping, not shared** |
| Financial-subject vocabulary | `DEBT_/INVEST_/CASH_FLOW_/GOAL_WORDS` + category words | `FINANCIAL_SUBJECT_WORDS` (L326) | **Overlapping, hand-maintained twice** |
| Non-spending categories | (assembler-side) | `NON_SPENDING_CATEGORY_SET` (L417) **and** `NON_SPENDING` (L645) | **Defined twice within the route alone** |

---

## 4. Drift Risks (concrete, present-tense)

The duplicated lists have **already diverged**:

- **Payoff.** Route-only tokens: `minimum payment`, `monthly payment`, `schedule`, `amortize`,
  `amortization`, `how many months`, `when will`. Classifier-only tokens: `paid off`, `get out of debt`,
  `pay it down`, `schedule to pay`, `plan to pay`, `amortiz` (stem). A message like *"what's my
  amortization schedule"* trips the route's payoff gate (min-payment gap surfaced) via `amortization` +
  `schedule`; the classifier matches on `amortiz`. Reverse-drift examples (*"help me get out of debt"*)
  route to `DEBT_PAYOFF_PLAN` in the classifier but do **not** flip the route's `detectsPayoffIntent`,
  so min-payment gaps are withheld from a genuine payoff question.
- **Update action.** Route lacks `record`, `adjust`, `modify` (classifier has them) and adds `add`
  (classifier lacks). *"adjust my APR"* → classifier routes `UPDATE_KNOWLEDGE`, but the route's
  `detectsExplicitUpdateIntent` returns false → gap card renders as light `clarification` instead of a
  `form`. The two layers disagree on the same message.
- **Update field.** Classifier's field list is far broader (`balance`, `limit`, `credit limit`,
  `due date`, `statement`, `my chase`, `my card`, `my account`); the route recognises only APR / rate /
  minimum-payment. Any update to a non-APR field is classified as `UPDATE_KNOWLEDGE` yet never renders
  the immediate form.
- **Structural drift risk.** Because the lists are physically separate and only one side has tests, any
  future edit to the classifier's vocabulary (its tests will still pass) silently widens the gap with the
  route. The defect is *self-worsening*: nothing fails when they diverge further.
- **Triple-defined `NON_SPENDING`.** The same category-exclusion set is written three times
  (route L417, route L645, and the assembler); an edit to one is not propagated.
- **Untested blast surface.** ~12 route heuristics have **zero** test coverage
  (`detectsPayoffIntent`, `detectsExplicitUpdateIntent`, `looksLikeFollowUp`,
  `isAmbiguousBreakdownFollowUp`, `hasPriorFinancialContext`, `resolveDrilldown`,
  `detectDrilldownCategory/Merchant/Limit`, `resolveTransactionWindow`, `buildBreakdownClarification`).

---

## 5. Recommended Minimal Fix

**Authoritative module:** `lib/ai/intent/`. It is already the tested, dependency-light, pure-function
home for message interpretation, with a clean barrel (`index.ts`) and an established test fixture. The
route should own orchestration (auth, context assembly, prompt building, LLM call) — **not** vocabulary.

This consolidation is *inherently a reconciliation*, not a byte-for-byte refactor, because the duplicated
lists differ. Do it in the smallest deliberate steps:

1. **Characterize first (safety net).** Before moving anything, add a `tsx` fixture (mirroring
   `classifier.test.ts`) that pins the **current** output of every route heuristic for a corpus of
   messages. This makes the subsequent reconciliation a reviewed diff, not a guess.
2. **Single source of truth for shared vocabulary.** Introduce `lib/ai/intent/keywords.ts` exporting the
   canonical `PAYOFF`, `UPDATE_ACTION`, `UPDATE_FIELD`, and non-spending-category lists. Reconcile each
   duplicated pair to **one** agreed list (default: the union, reviewed token-by-token in the same PR).
   Re-export via `index.ts`. Both the classifier and the route import from here.
3. **Extract conversation-level heuristics** (follow-up, ambiguity, drilldown, bare-month parsing) into a
   tested submodule, e.g. `lib/ai/intent/conversation.ts`, keeping the exact function signatures the
   route already calls. The route changes from *defining* to *importing*.
4. **Collapse `NON_SPENDING`** to one exported constant consumed everywhere.
5. **Extend tests** so the migrated heuristics are covered at the same bar as the classifier; wire the
   characterization corpus in as regression cases.

**Deliberately out of scope for the minimal fix:** merging the route's month parsing *into*
`detectTransactionWindow` (functionally distinct — bare-month labelling vs. window resolution), any
prompt-copy change, and any assembler/window/drilldown *logic* change (KD-7 territory). Keep KD-11 a pure
extraction + list-reconciliation; do not alter what a heuristic decides beyond the reviewed list merge.

**Sizing:** two-PR shape recommended — PR-A = characterization tests only (zero behaviour change);
PR-B = extraction + reconciliation + re-exports. Consistent with "additive before subtractive" and
"do not implement multiple decisions in one branch/commit."

---

## 6. Collision Risk with KD-7

**Medium — same file, mostly different regions, one shared dependency.**

- **Shared file.** KD-7's implementation checklist (its §8-E) edits `app/api/ai/chat/route.ts`; KD-11
  also edits that file. KD-7 works in the **serialization / prompt-copy** region (the "exact sum / ONLY
  valid month-by-month" lines and the `cat.total / windowDays * 30` average copy, around
  `serializeContextBlock`). KD-11 works in the **top-of-file heuristic constants + detection functions**
  (L184–573). Different regions → conflicts are unlikely but not impossible if both land in the same
  window; whoever lands second rebases.
- **Shared dependency — drilldown.** KD-7 changes drilldown *truncation semantics* in the assembler
  (`matchedTotal`/`totalCount`/`truncated`) and reads `txn.drilldown` in the prompt. KD-11 relocates
  `resolveDrilldown` (the request *resolver*) out of the route. These are different halves (resolver vs.
  assembler+prompt) and do not overlap in logic, but both touch the drilldown feature — coordinate so
  KD-11's move is a pure relocation and does not alter the resolved `AssemblerOptions['drilldown']`
  shape KD-7 depends on.
- **Line-number churn.** KD-7's checklist cites specific line numbers in route.ts. If KD-11 lands first
  and removes ~390 lines of heuristics from the top of the file, KD-7's line references shift. Mitigation:
  land KD-11 (or at least PR-B) **before** KD-7, or have KD-7 re-anchor to symbols rather than lines.

**Mitigations:** (a) sequence — prefer KD-11 extraction before KD-7's route edits, or explicitly
serialize the two on this branch; (b) KD-11 must not touch `serializeContextBlock`, the assembler, or
drilldown *semantics*; (c) if parallel, split by region and rebase, treating route.ts as a known contended
file.

---

## 7. Validation Checklist (for the eventual implementation — do NOT implement yet)

- [ ] `npx prisma generate` — no schema change expected; confirm clean.
- [ ] `npx tsc --noEmit` — imports repointed; no `IntentRoute` contract change.
- [ ] `npm run lint`.
- [ ] `npx tsx lib/ai/intent/classifier.test.ts` — existing classifier fixture still green.
- [ ] New `tsx` fixture for migrated route heuristics passes (characterization corpus + new cases).
- [ ] Grep proof of dedup: `PAYOFF`, `UPDATE_ACTION`, `UPDATE_FIELD`, `NON_SPENDING` each defined **once**
      (in `lib/ai/intent/`), imported elsewhere — zero remaining inline copies in `route.ts`.
- [ ] Route-behaviour parity (or reviewed, intentional deltas) for: min-payment gap gating
      (`detectsPayoffIntent`), gap-mode form/clarification (`detectsExplicitUpdateIntent`), window
      carry-forward (`resolveTransactionWindow`), ambiguity clarification, drilldown resolution.
- [ ] Targeted `/api/ai/chat` manual check: payoff question surfaces min-payment gap; "adjust my APR"
      renders the form card; "break it down" with no prior topic still asks the clarifying question;
      a drilldown follow-up still attaches evidence.
- [ ] Confirm no prompt-copy / calculation change (diff shows only heuristic relocation + list merge).

---

## 8. Final Recommendation

Proceed with KD-11 as a **two-PR consolidation** onto `lib/ai/intent/` as the authoritative module:
first land characterization tests that pin current route-heuristic behaviour (zero behaviour change), then
extract the route's inline heuristics into tested `lib/ai/intent/` submodules and collapse the three
duplicated keyword pairs (`PAYOFF_*`, `UPDATE_ACTION_*`, `UPDATE_FIELD_*`) plus the triple-defined
`NON_SPENDING` set into single exported constants. Reconcile each divergent list token-by-token in review
— this is the one non-mechanical decision and must be explicit, not incidental. Keep the change a pure
extraction: no prompt wording, no calculation, no drilldown/window *logic* change.

**Sequence against KD-7.** Both edit `app/api/ai/chat/route.ts`. Land KD-11's extraction before KD-7's
route/prompt edits (or serialize them on this branch) so KD-7 can re-anchor to a thinner file, and ensure
KD-11 never touches `serializeContextBlock`, the transactions assembler, or drilldown truncation
semantics — those belong to KD-7.

Per project working style, this ticket stays at *investigation + checklist* until the D11 → … sequence
reaches it or it is explicitly approved for implementation. **No code, migrations, routes, UI, or
STATUS.md have been modified.**

---

## 9. Out of Scope

- Any prompt-copy wording, advisor doctrine, or response-style text.
- Any financial calculation, window resolution *logic*, or drilldown *semantics* (KD-7 owns drilldown/
  window truncation).
- `serializeContextBlock` / `serializeAssessmentBlock` internals.
- The `IntentRoute` / `TransactionsSummaryData` type contracts.
- STATUS.md edits, schema, migrations, and any UI.
