> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D6.3D — Context Budget & Priority Investigation

**Status:** Investigation only. No code, no schema, no file changes proposed for
this deliverable. This document is a design record to be reviewed before any
Context Budget work is scheduled, and before Ambient Intelligence.

**Scope:** Design the long-term Context Budget and Context Priority architecture
for the Fourth Meridian AI pipeline (D6 Layers 0–3), so that as the number of
intelligence sections grows, prompts stay scoped to what each question actually
needs instead of injecting every section every time.

---

## TL;DR

- The pipeline already has the right bones: a deterministic intent classifier
  (Layer 0), a manifest + assembler registry (Layer 1), a deterministic
  intelligence layer (Layer 2), and prompt assembly (Layer 3). What it does
  **not** have is a *selection* step. Today `buildContext()` assembles the whole
  category manifest, `computeAssessment()` computes every section it can, and
  Layer 3 serializes essentially all of it. The intent route's
  `primarySections` / `supportingSections` / `suppressSections` are **advisory
  emphasis only** — they reorder what the LLM should lead with; they never
  remove anything from the prompt (`lib/ai/intent/prompt.ts` is explicit:
  *"guidance, not a hard filter — the full context is still present below it"*).
- Recommendation: **yes**, evolve toward a context-ranking pipeline, but add it
  as a new deterministic **Selection layer (Layer 2.9)** between Intelligence
  and Prompt Assembly — not by rewriting existing layers. Assemble broadly
  (cheap DB reads), **serialize narrowly** under a token budget.
- Recommendation: **yes** to per-section metadata descriptors and **yes** to a
  **Context Priority Registry** as the single source of truth, replacing the
  hard-coded `primarySections`/`suppressSections` lists currently baked into the
  classifier. This inverts control: each section declares which intents it
  serves, so adding a section never requires editing central routing.
- Budget should be measured primarily in **tokens** (the hard constraint), with
  a composite **priority score** deciding what fills that budget. Confidence and
  freshness are score *modifiers*, not independent budgets. Dependencies are
  **hard inclusion edges**, resolved before trimming.
- Keep selection, ranking, trimming, and all Layer 2 math **fully
  deterministic**. The LLM must never choose its own context. Ambient
  Intelligence consumes this by supplying a *non-user-message* intent source to
  the same selection function.
- Smallest safe slice: ship the registry + a pure `planContextSelection()`
  function in **shadow mode** — compute and audit-log the plan, change nothing
  in the prompt — then flip serialization to honor it behind a flag once the
  plan is validated against real transcripts.

---

## 1. Current architecture (as built) and where the gap is

Confirmed from source. The relevant files:

| Layer | Responsibility | Key files |
|---|---|---|
| 0 | Intent routing (deterministic keyword rules), dynamic transaction windows, follow-up window carry-forward | `lib/ai/intent/classifier.ts`, `lib/ai/intent/types.ts` |
| 1 | Context Builder + Domain Assemblers; manifest → agentScope intersection → parallel assembly | `lib/ai/context-builder.ts`, `lib/ai/domain-manifest.ts`, `lib/ai/assembler-registry.ts`, `lib/ai/assemblers/*` |
| 2 | Deterministic Intelligence (single-pass assessment over assembled context) | `lib/ai/intelligence/annotations.ts` |
| 3 | Prompt assembly, routing block, assessment block, provenance | `lib/ai/intent/prompt.ts`, `app/api/ai/chat/route.ts` |

**How context is chosen today.** `buildContext()` resolves domains as:
`scopeOverride` → else `getDomainManifest(category)` intersected with
`AiAgent.agentScope` (when non-empty). Every resolved domain is assembled in
parallel; per-domain failures are caught and skipped. There is no per-question
narrowing at this stage — the manifest is a per-*category* list, not a
per-*intent* list.

**How the prompt is built today.** Layer 3 renders a `=== QUESTION ROUTING ===`
block from the `IntentRoute`, then a `=== FINANCIAL ASSESSMENT ===` block from
the full `FinancialAssessment`, then the full space context. `confidenceBand()`
tunes *how strictly the model should follow* the routing (HIGH prioritizes
routed sections, LOW allows broader reasoning, UNKNOWN permits all) — but the
underlying sections are all still present.

**The gap.** Selection is emphasis, not inclusion. As Layer 2 grows (the roadmap
already names Upcoming Merchant, Spending Trends, Holdings, plus the existing
Liquidity / Cash Flow / Debt / Goals / Investment Readiness / Spending
Opportunity / Risk & Opportunity sections), the prompt grows monotonically. The
architecture has an intent signal and a natural registry seam, but nothing
consumes the intent signal to *drop* low-value sections under a budget.

---

## 2. Question 1 — Domain × intent importance map

Two things need mapping, because the pipeline has two kinds of "context":
**Layer 1 context domains** (raw assembled data) and **Layer 2 assessment
sections** (interpreted findings). Both must participate in budgeting.

Legend: **R** = required (answer is wrong/empty without it) · **S** = supporting
(referenced to justify or qualify) · **O** = optional (include only if budget
allows / explicitly requested) · **–** = omit unless explicitly named.

### 2a. Layer 1 context domains

| Domain (`FinanceDomains`) | Debt | Spending | Investment | Cash-flow | Goal | Overview | Unknown |
|---|---|---|---|---|---|---|---|
| `accounts` (balances, net worth, debt metadata) | R | S | R | S | S | R | R |
| `transactions_summary` (cash flow, categories, monthly) | S | R | S | R | S | S | S |
| `snapshot_history` (net-worth trend) | S | O | S | S | S | S | O |
| `goals` | S | O | S | O | R | S | O |
| `holdings_summary` | – | – | R | – | O | O | O |
| `members` | – | – | – | – | O | O | – |
| `providers` (data-health / plumbing) | S* | S* | S* | S* | S* | S* | S* |

\* `providers` is **diagnostic-only**: promote to S when data health materially
changes the answer (stale/needs-reauth accounts undermine a number the answer
depends on), otherwise omit. It should never be a primary section.

### 2b. Layer 2 assessment sections (`FinancialAssessment`)

| Section | Debt | Spending | Investment | Cash-flow | Goal | Overview | Unknown |
|---|---|---|---|---|---|---|---|
| `dataQuality` | R | R | R | R | R | R | R |
| `cashFlow` | S | R | S | R | S | S | S |
| `debt` | R | S | S | S | S | S | S |
| `debtStrategy` | R | O | S | O | O | O | O |
| `liquidity` | S | S | R | S | S | S | S |
| `capitalAllocation` | R | O | R | S | S | S | O |
| `spendingOpportunities` | O | R | O | S | O | O | O |
| `goalAlignment` | S | O | S | O | R | S | O |
| `investmentReadiness` | O | – | R | O | O | O | O |
| `riskOpportunities` (executive summary) | R | R | R | R | R | R | R |

Two sections are **always-on** regardless of intent: `dataQuality` (it gates the
confidence of every other claim and is cheap) and `riskOpportunities` (already
used in Layer 3 as the executive-summary engine — the single lead conclusion).
These form the **Required floor** the budget can never trim below.

> **Current-state accuracy note.** Only four Layer 1 assemblers exist today
> (`accounts`, `transactions`, `goals`, `snapshot`). `holdings_summary`,
> `members`, and `providers` are declared in `FinanceDomains` and referenced by
> the manifest but have **no registered assembler yet**, so they currently
> resolve and are skipped (`no_assembler`). The matrix above is target-state
> importance; it is intentionally forward-looking so the registry can be
> populated as those assemblers land.

---

## 3. Question 2 — Inclusion tiers

Collapsing the matrix into the five tiers you named, per section, keyed by intent
affinity:

- **Always** (never trimmed, no intent needed): `accounts`, `dataQuality`,
  `riskOpportunities`. These are the Required floor.
- **Usually** (included unless budget-starved or intent explicitly suppresses):
  `transactions_summary`, `cashFlow`, `debt` for finance intents;
  `snapshot_history` when the question is at all temporal.
- **Only when requested / intent-matched**: `holdings_summary` +
  `investmentReadiness` (investment intents), `debtStrategy` (debt-payoff
  intents), `spendingOpportunities` (spending intents), `goalAlignment` +
  `goals` (goal intents), `members` (household/governance questions).
- **Only when supporting another section** (pulled in by dependency, not on its
  own merit): `snapshot_history` behind `debt`/`goalAlignment`; `liquidity`
  behind `investmentReadiness`/`capitalAllocation`; `providers` behind any
  section whose numbers are degraded by stale data.
- **Never unless explicitly named**: `transactions_raw` / `holdings_raw` (line
  item detail — the codebase deliberately keeps these out of default context),
  `platform_health`, and `members` for pure single-user finance questions.

---

## 4. Question 3 — Should Fourth Meridian adopt a context-ranking pipeline?

**Yes, and it fits the existing architecture cleanly** because the seams already
exist (registry pattern, an intent object, a pure assessment object). The
proposed flow maps onto the current layers like this:

```
Layer 0   Intent (classifier OR ambient trigger)
              │  intent, temporalFrame, confidence, transactionWindow
              ▼
Layer 1   Context Builder  ── assemble broadly (manifest) ─────────┐
              │  SpaceContext_AI.domains                            │  cheap DB reads;
              ▼                                                     │  broad assembly is fine
Layer 2   Intelligence  ── compute all feasible sections ──────────┘
              │  FinancialAssessment
              ▼
Layer 2.9 SELECTION  (NEW, deterministic)
              │  1. gather candidate sections + descriptors (registry)
              │  2. resolve Required floor
              │  3. score by intent affinity × base priority × confidence × freshness
              │  4. close over dependencies (hard edges)
              │  5. trim Optional/Supporting to fit token budget
              ▼  SelectionPlan { included[], trimmed[], reasons[], tokensUsed }
Layer 3   Prompt Assembly ── serialize ONLY selected sections ─────
```

The important architectural decision: **budget at serialization, not at
assembly, in the first instance.** Assembly from Prisma is cheap and already
fault-tolerant; the expensive resource is the *prompt*, not the query. So the
Selection layer decides what Layer 3 renders. (A later slice can extend the same
`SelectionPlan` backward to skip assembling Optional domains that were not
selected — see §10 slice order — but that is a subtractive optimization, not the
core mechanism.)

This respects the project rule "additive before subtractive": Layer 2.9 is
purely additive, and can run in shadow mode producing a plan that changes
nothing until validated.

---

## 5. Question 4 — How should budget be measured?

Distinguish the **constraint** from the **ranking signal**.

**Constraint (one, hard): tokens.** The budget is a token ceiling for the
assembled context portion of the system prompt (excluding the fixed instruction
scaffold). Everything else is a knob that decides how that fixed number of tokens
is spent. Token cost per section must be **deterministically estimable** — a
character/heuristic count computed from the serialized section, not a model call.
Each descriptor carries an `estimatedTokens` (static upper bound) that the
Selection layer refines with the actual serialized length when available.

**Ranking signal (composite score), applied to non-floor sections:**

```
score(section, intent) =
      baseImportance(section)                     // tier weight from descriptor
    × intentAffinity(section, intent)             // 0 (suppress) … 1 (primary)
    × confidenceFactor(section.confidence)        // LOW findings are worth fewer tokens
    × freshnessFactor(section.freshness)          // stale data is worth fewer tokens
```

- **Importance** = the tier (Always/Usually/…) as a base weight.
- **Intent affinity** = replaces today's `primarySections`/`suppressSections`;
  0 means "suppress for this intent," which is a hard exclude (unless it is the
  Required floor).
- **Confidence** = the pipeline already computes per-section confidence
  (`ConfidenceLevel` on assessment sections). A LOW-confidence debt section is
  worth fewer tokens than a HIGH-confidence one; this is a natural, already-present
  input.
- **Freshness** = derivable from existing provenance (`assembledAt`,
  `balanceLastUpdatedAt`, snapshot recency). Stale sections score lower so the
  budget favors data the answer can actually stand on.

**Dependency graph is not a budget** — it is a *constraint on the selection set*
(hard inclusion edges applied before trimming). Do not treat it as a scoring
axis.

So: **tokens = the box; importance × affinity × confidence × freshness = how you
fill it; dependencies = things that must travel together.**

---

## 6. Question 5 & 6 — Section metadata + a Priority Registry

**Yes to both, and they are the same mechanism.** Rather than Prompt Assembly (or
the classifier) hard-coding which sections matter, each section declares a
**descriptor**, and a registry is the single source of truth the Selection layer
reads. This is the natural extension of the pattern already in the codebase
(`assembler-registry.ts`, `signal-registry.ts`, `domain-manifest.ts` are all
registries).

### 6a. Descriptor shape (proposed, illustrative — not a code change)

```
ContextSectionDescriptor {
  key:            string          // "debt", "transactions_summary", …
  layer:          'DOMAIN' | 'ASSESSMENT'
  baseImportance: 'ALWAYS' | 'USUALLY' | 'ON_REQUEST' | 'SUPPORTING' | 'NEVER'
  intentAffinity: Record<FinancialIntent, number>   // 0..1; 0 = suppress
  dependsOn:      string[]        // hard inclusion edges (keys)
  estimatedTokens: number         // static upper-bound cost
  confidenceFrom: (assessment) => ConfidenceLevel   // read existing confidence
  freshnessFrom:  (section)    => Freshness          // read existing provenance
}
```

### 6b. Why a registry beats hard-coded routing

- **Scalability of the exact problem you raised.** Adding "Spending Trends" today
  would mean editing the classifier's per-intent `primarySections`/`supporting`/
  `suppress` lists in several places. With a registry, the new section ships one
  descriptor declaring its own affinities and dependencies. Central routing is
  never touched — this is the inversion of control that makes growth safe.
- **Testability.** Selection becomes a pure function of (intent, descriptors,
  budget). You can unit-test "debt question at 4k budget includes exactly {…}"
  without a model or a DB.
- **Auditability / provenance.** The `SelectionPlan` (what was included, what was
  trimmed, and why) is a deterministic artifact that drops straight into the
  existing `AuditLog` (`AI_CONTEXT_ASSEMBLED` already records
  `resolvedDomains`/`skippedDomains`; add `selectionPlan`).
- **Migration path.** The classifier keeps producing the *intent*; its
  `primarySections`/`suppressSections` become a thin derivation from the registry
  during transition, then are removed. `getDomainManifest()` stays as the
  category-level "what could exist"; the registry decides "what this question
  gets."

---

## 7. Question 7 — How Ambient Intelligence consumes this

The whole point of the Selection layer is that **intent is an input, not
necessarily a user message.** Make `planContextSelection(intent, descriptors,
budget)` intent-*source*-agnostic:

- **Chat (today):** intent from `classifyFinancialIntent(userMessage)`.
- **Ambient (later):** intent synthesized from a trigger — a fired signal (e.g.
  `LIQUIDITY` critical), a scheduled daily-brief goal, or a detected life event.
  The trigger names the intent + budget; the same selection function builds the
  best context deterministically, with no human turn.

This is why Selection must live as a **standalone pure module**, not inline in
`app/api/ai/chat/route.ts`. Ambient Intelligence then becomes: *pick a trigger →
map trigger to intent + budget → run the identical deterministic pipeline.* No
part of Ambient needs to "manually select sections," which is your stated
long-term goal. Ambient also gets to run at a *different budget* (a proactive
nudge might use a much smaller token ceiling than an interactive deep-dive) for
free, because budget is already a parameter.

---

## 8. Question 8 — What stays deterministic / what must never be LLM-driven

**Must remain deterministic (never LLM):**

- Intent classification floor (an LLM *assist* may later augment UNKNOWN cases,
  but there must always be a deterministic fallback — see risk R6).
- **Section selection, ranking, dependency closure, and budget trimming.** The
  set of context the model receives must be reproducible and auditable. If the
  LLM chose its own context, provenance and testability collapse and the system
  could silently drop the data a correct answer requires.
- All Layer 2 math: balances, cash-flow buckets, debt classifications,
  liquidity coverage, confidence levels, freshness. These are already pure and
  must stay pure.
- Token estimation, provenance, signals.

**The LLM's job stays exactly what it is today:** given a deterministically
selected, budgeted, provenance-stamped context, decide *phrasing, prioritization,
and recommendation* for the user's specific question. It interprets; it does not
select.

---

## 9. Deliverables — architecture, models, risks, tradeoffs

### 9a. Proposed architecture (summary)

A new deterministic **Layer 2.9 Selection** stage consuming `IntentRoute` +
`SpaceContext_AI` + `FinancialAssessment`, driven by a **Context Priority
Registry** of per-section descriptors, emitting a **`SelectionPlan`** that Layer 3
serializes against a token budget. Assembly stays broad; serialization becomes
narrow.

### 9b. Data flow

`intent (chat or ambient)` → `buildContext()` (broad) → `computeAssessment()`
(all feasible) → `planContextSelection(intent, descriptors, budget)` →
`SelectionPlan{ included, trimmed, reasons, tokensUsed }` → Layer 3 serializes
included only → LLM.

### 9c. Priority model

Tiered inclusion, not free-form knapsack (chosen for determinism +
explainability):

1. **Floor:** include all `ALWAYS` sections (Required floor) unconditionally.
2. **Dependency closure:** for every included section, include its `dependsOn`
   set (mark them `included-as-dependency`).
3. **Candidate ranking:** score remaining sections by
   `importance × intentAffinity × confidence × freshness`; drop affinity-0
   (suppressed) sections.
4. **Greedy fill:** add candidates in descending score until the next section
   would exceed the token budget; re-close dependencies on each add.
5. **Record:** everything not included is logged in `SelectionPlan.trimmed` with
   its score and the reason (`suppressed` / `over-budget` / `low-confidence`).

Greedy-tiered over optimal knapsack because it is deterministic, O(n log n),
trivially unit-testable, and its trim decisions are human-explainable — which
matters more here than squeezing the last token.

### 9d. Dependency model

Hard, directed inclusion edges declared per descriptor (`dependsOn`). Examples
grounded in the current code:

- `debtStrategy` → `debt`, `accounts` (it reasons over debt classification and
  account APRs).
- `investmentReadiness` → `liquidity`, `debt` (readiness already weighs
  emergency coverage and high-APR debt).
- `capitalAllocation` → `debt`, `liquidity`, `cashFlow` (allocation evidence
  spans these — `CapitalAllocationEvidence`/`AllocationEvidenceDomain` exist
  today).
- `goalAlignment` → `goals`, `transactions_summary`.
- Any assessment section → its underlying Layer 1 domain(s).

Rule: **a section may never be serialized without its dependencies**, even under
budget pressure — if the closure doesn't fit, drop the *dependent* section, not
its dependency. This prevents dangling references (the assessment mentions a debt
strategy while the debt numbers were trimmed away).

### 9e. Risks

- **R1 — Trimming removes needed context → wrong/incomplete answers.** Mitigation:
  conservative Required floor; shadow mode first; validate trims against real
  transcripts before enforcing.
- **R2 — Token estimates drift from reality.** Mitigation: estimate from the
  actual serialized string length where possible; treat descriptor
  `estimatedTokens` as an upper bound; log estimated-vs-actual.
- **R3 — Dependency omission → dangling references** (assessment cites a trimmed
  number). Mitigation: dependency closure is mandatory and tested; drop dependents
  not dependencies.
- **R4 — Registry vs manifest duplication** during migration (two places seem to
  decide "what domains exist"). Mitigation: keep `getDomainManifest()` as
  category-level availability; registry decides per-question selection; document
  the boundary; remove classifier section-lists only after the registry is
  authoritative.
- **R5 — Over-trimming at low confidence** (a LOW-confidence-but-critical debt
  finding gets starved). Mitigation: severity can pin a section into the floor
  (e.g. a CRITICAL `riskOpportunities`/`debt` finding is never trimmed regardless of
  score) — reuse existing `severity`/`priority` fields.
- **R6 — Ambient uses a bad synthesized intent** and builds misleading context.
  Mitigation: Ambient intents must map to the same deterministic affinities;
  no LLM-chosen sections; UNKNOWN widens rather than narrows.
- **R7 — Behavioral regression vs today's "everything" prompt.** Mitigation:
  shadow mode + a feature flag + A/B on transcripts; the flag defaults off until
  parity is shown.

### 9f. Tradeoffs

- **Assemble-broad / serialize-narrow** (recommended) keeps assembly simple and
  fault-tolerant but wastes some DB work building sections that get trimmed.
  Alternative — budget assembly too — saves queries but couples Selection back
  into Layer 1 and complicates the fault model. Defer that coupling to a late,
  optional slice.
- **Greedy-tiered vs optimal knapsack:** greedy is deterministic and explainable;
  knapsack squeezes marginally more value per token at the cost of opaque,
  harder-to-test decisions. Choose greedy.
- **Central registry vs distributed declaration:** a registry centralizes the
  source of truth (easy to audit) but is one more module to keep in sync with new
  sections. Net positive given the growth problem it solves.
- **Confidence/freshness as score modifiers vs hard gates:** modifiers are softer
  and avoid cliff effects, but a purely score-based approach can starve a rare
  critical-but-low-confidence finding — hence the severity pin (R5).

---

## 10. Question 9 — Smallest safe implementation slice + order

The smallest slice that moves toward this architecture **without changing any
current behavior**:

**Slice 1 (smallest safe step): Registry + pure planner in shadow mode.**
Introduce the Context Priority Registry (descriptors for the sections that exist
*today* only) and a pure `planContextSelection(intent, descriptors, budget)`
function with unit tests. Wire it into the chat route to compute a `SelectionPlan`
and write it to the existing `AuditLog` metadata **only**. The prompt is
unchanged — Layer 3 still serializes everything. This lets us observe, on real
traffic, exactly what *would* be trimmed, with zero risk. Purely additive; fully
reversible.

Then, in order:

1. **Slice 1 — Registry + planner, shadow mode** (above). No prompt change.
2. **Slice 2 — Deterministic token estimation.** Add `estimatedTokens` and record
   estimated-vs-actual serialized size per section in the plan. Still shadow.
3. **Slice 3 — Enforce trimming behind a flag.** Layer 3 honors `SelectionPlan`
   for Optional/Supporting sections under budget; Required floor guaranteed;
   `suppress` becomes real omission. Flag defaults off; enable after transcript
   parity review.
4. **Slice 4 — Invert routing control.** Move `primarySections`/`supporting`/
   `suppressSections` out of `classifier.ts` into descriptor `intentAffinity`;
   the classifier now emits intent only. Remove the duplicated lists.
5. **Slice 5 — Ambient entry point.** Expose `planContextSelection` to a
   non-chat intent source (signal/scheduled trigger) at a configurable budget.
   Ambient Intelligence builds on this.
6. **Slice 6 (optional, subtractive, last) — Assembly budgeting.** Extend the
   plan backward so Layer 1 can skip assembling Optional domains that were not
   selected. Only after everything above is stable.

This order is deliberately **additive before subtractive** (per project rules):
nothing is removed or trimmed for real until the deterministic plan has been
observed in shadow and validated. Each slice is independently shippable and
reversible, and none of them requires schema changes (the plan rides in existing
`AuditLog` metadata; descriptors are code, not tables).

---

## Key file references

- `lib/ai/context-builder.ts` — Layer 1 entry; manifest → agentScope → parallel
  assembly; audit log with `resolvedDomains`/`skippedDomains` (natural home for
  `selectionPlan`).
- `lib/ai/domain-manifest.ts` — per-*category* domain lists; stays as
  availability, not per-question selection.
- `lib/ai/assembler-registry.ts`, `lib/ai/signal-registry.ts` — the registry
  pattern the Context Priority Registry should mirror.
- `lib/ai/types.ts` — `FinanceDomains`, `ContextDomainSection` (has
  `assembledAt` → freshness), `SpaceContext_AI`.
- `lib/ai/intent/classifier.ts`, `lib/ai/intent/types.ts` — Layer 0; current home
  of `primarySections`/`supportingSections`/`suppressSections` (to be inverted
  into descriptors in Slice 4).
- `lib/ai/intent/prompt.ts` — Layer 3 routing block; confirms routing is
  *advisory, not a filter* (`confidenceBand`, "full context still present below").
- `lib/ai/intelligence/annotations.ts` — Layer 2 `computeAssessment`; source of
  per-section `ConfidenceLevel`, `severity`/`priority`, and the section set the
  registry must describe.
- `app/api/ai/chat/route.ts` — serializes routing + full assessment + full
  context today; the injection point for the shadow-mode `SelectionPlan`.

---

*Investigation only. No approved decision is re-litigated here; this proposes a
new additive layer and defers all enforcement behind shadow mode and a feature
flag for separate approval.*
