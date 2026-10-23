# V26-FOUNDATION-1 — The Financial Context Frame

**Status:** Plan. No production code, no schema, no migration produced by this pass.
**Audited against:** `v2.6` @ `146a0dd` (2026-07-27). Every file:line below was read from source this session.
**Source thesis:** `FABLE-2.6-CONTEXT-ARCHITECTURE.md` — treated as a product-architecture thesis, not an implementation spec.

**Evidence discipline:** where the thesis and the repository disagree, the repository wins and the delta is stated. Claims I could not verify are marked UNVERIFIED.

---

## 1 · Executive decision

**Adopt the Financial Context Frame — with four material modifications.**

The thesis survives audit. Its central factual claim is not only true, it is worse than stated: **Fourth Meridian currently ships two liquidity opinions that are not merely different thresholds but different physical quantities.**

- `app/api/brief/route.ts:317` — `acct.totalLiquid / acct.netWorth < 0.05` — liquid cash as a fraction of **net worth** (stock ÷ stock, dimensionless).
- `lib/ai/intelligence/annotations/engine.ts:297` — `totalLiquid / estimatedMonthlyExpense` — **months of coverage** (stock ÷ flow, months).

These disagree in both directions. A user with high net worth and modest expenses trips the Brief's warning while the assessment reports `EXCELLENT`; a user with low net worth and high burn passes the Brief while the assessment reports `CRITICAL`. Both surfaces ship today. This is not a hypothetical consistency risk — it is a live, reproducible contradiction between two production surfaces, and it is the strongest argument in the thesis.

### The four modifications

**M1 — Contract before schema; the first slice persists nothing.**
The thesis's v2.6a item 1 bundles model + compiler + persistence + diff + two reader migrations into one step. That inverts the review's own guidance (*"begin with the contract, not the persistence schema"*) and makes the schema define the architecture by accident. The contradiction above is fixable with **zero database change**. See §8.

**M2 — Narrative leaves the sealed frame.**
The thesis places `narrative` inside the frame (§3.1). A sealed frame must be deterministic and reproducible; LLM prose is neither. Narration becomes a separately versioned rendering record referencing `frameId`. See §3, §4.

**M3 — `semanticState` is decomposed, not embedded.**
The thesis's `semanticState` bundles active insights, themes, behavioural patterns, stated facts and life-event markers into one frame field. These have four different lifecycles, trust characteristics and edit semantics. The frame references projections; it does not own them. See §10.

**M4 — Four clocks, never one.**
Truth freshness, compilation freshness, confidence and materiality are separate contracts (§3). The thesis's `provenance` blurs the first two and its `confidence` blurs the third and fourth.

### Reservation carried forward

The thesis's **60–85% token reduction** (§9) is an unmeasured estimate. Worse, it is currently **unmeasurable**: `ApiUsageCounter` is keyed `@@unique([provider, metric, unit, day])` with **no `userId` or `spaceId`** (`prisma/schema.prisma:2390`). Per-Space attribution is structurally impossible today. Baseline instrumentation is a prerequisite, not a follow-up. Do not repeat the figure as established.

---

## 2 · Verified current-state map

### 2.1 Consumer graph — as it actually is

```
             CANONICAL TRUTH (v2.5, converged)
   DayFacts · queryTransactions · getRecentSnapshots · getCurrentPositions
   · classifyAccounts · resolveEffectiveDebtTerms · FX · visibility
                              │
                    buildContext()  lib/ai/context-builder.ts:100
                    5 assemblers + signal detectors
                    writes AuditLog AI_CONTEXT_ASSEMBLED  (:222)
                              │
            ┌─────────────────┴──────────────────┐
            │                                     │
   app/api/ai/chat/route.ts              app/api/brief/route.ts
   :445 buildContext (single)            :512 buildContext (per Space)
   :376 buildContext (master, N Spaces)  ✗ NEVER calls computeAssessment
   :454 computeAssessment                ✓ 4 inline judgment rules
   :404 computeAssessment (master)       :601 reads AiAdvice (seed-only)
   :133 planner  → SHADOW, never applied
   :188 validator → live, annotate mode
```

**`computeAssessment` has exactly two call sites, both in the chat route** (`:404`, `:454`). Verified by exhaustive grep across `lib/` and `app/`.

### 2.2 The divergence, precisely

| Judgment | Brief (inline) | Assessment (canonical) |
|---|---|---|
| Liquidity | `route.ts:317` — `totalLiquid/netWorth < 0.05`, gated on `netWorth > 5000` | `engine.ts:291-303` — coverage months vs `LIQUIDITY_CRITICAL/WARNING/EXCELLENT` |
| Savings rate | `route.ts:408-411` — own fold over `txn.incomeTotal`/`expenseTotal` | cash-flow section, `computeAverageMonthlySpending` (KD-10 shared authority) |
| Debt ratio | `route.ts:436,439` — `totalDebt/totalAssets > 0.5` | debt section + `debtStrategy` |
| Cash ratio | `route.ts:437` — `cash/netWorth` | not an assessment concept |

The Brief's four rules are the deletion target of the first slice.

### 2.3 Duplicate reasoning inventory (v2.6 targets)

| Reasoning | Sites | Note |
|---|---|---|
| Weighted/blended APR | `annotations/engines.ts` (`debtStrategy.weightedAvgApr`) · `lib/perspective-engine/lenses/debt.core.ts:269` · `components/space/widgets/debt/debt-kpis.ts:223` | **B3 did not close this.** `resolveEffectiveDebtTerms` unified *per-account effective APR*; the *balance-weighted fold across accounts* remains triplicated |
| Avalanche ordering | `annotations/engines.ts:604` · widget payoff simulator | |
| Transaction scope | `lib/ai/assemblers/transactions.ts:348` — comment: *"Mirrors the canonical scope in lib/data/transactions.ts"* | a fork by acknowledgement |
| Spending trend | AI monthly buckets vs widget DayFacts compare | |

### 2.4 Persistence and scaffolding — verified

- **No `Conversation`, `Frame`, `Insight`, or `Memory` model exists.** Grep over `prisma/schema.prisma` returns 0.
- **`AiAdvice` has zero production writers.** Only `prisma/seed.ts:787,1264` create. Readers: `lib/data/advice.ts:16`, `app/api/brief/route.ts:601`, `lib/export/assemble.ts:250`. KD-14 confirmed open.
- **All AI notification types are `VOCABULARY`** — `lib/notifications/registry.ts:489`: *"AI — producers are v2.6b (Ambient Intelligence); ALL VOCABULARY"*.
- **Timeline hooks are declared placeholders** — `lib/timeline-types.ts:7` (*"Future: Daily Briefing engine"*), `:108` (`isPreview`, "AI recommendation").
- **Planner is shadow-only** — `lib/ai/context-priority/types.ts:164` `shadow: true`, with a stated SHADOW MODE INVARIANT.
- **`MEMBERS` and `PROVIDERS` are declared domains with no assembler.** Manifest declares 7 (`domain-manifest.ts:43-48,58`); only 5 `registerAssembler` calls exist (`accounts`, `transactions`, `goals`, `holdings`, `snapshot`). Both are silently skipped every request.
- **`ApiUsageCounter`** — no user/space dimension (`schema.prisma:2390`).
- **Double serialization confirmed** — `lib/ai/prompts/context-serializer.ts:506` emits `JSON.stringify(section.data)` in addition to prose blocks.

### 2.5 Reusable infrastructure

- **Claim-lock pattern**: `lib/plaid/sync-lock.ts:74` — conditional `updateMany` as an atomic claim. This is the correct primitive for a compile lock; it is proven in production and needs no new mechanism.
- **Execution-ledger pattern**: `RefreshExecution` / `JobRun` with deployment-SHA stamping (OPS-2B′ `currentDeploymentSha()`) — the provenance discipline the frame should copy verbatim.
- **Incident lifecycle**: `SyncIssue` episode/occurrence with partial-unique concurrency control — the closest existing analogue to frame identity.

### 2.6 Report claims that are stale

| Report says | Actual |
|---|---|
| `lib/ai/context-serializer.ts:506` | `lib/ai/prompts/context-serializer.ts:506` |
| `debt-kpis.ts:223` (bare) | `components/space/widgets/debt/debt-kpis.ts:223` — line correct |
| Snapshot `feature/v2.5-spaces-completion` | branch deleted; v2.5 released as `v2.5.0`, work continues on `v2.6` |
| "Four of five assemblers consume canonical services" | Now five of five — V26-PRE **B2** converged `assemblers/snapshot.ts` onto `getRecentSnapshots()`. The report predates it |

Everything else in §2 of the thesis reproduced exactly, including line numbers.

---

## 3 · Authority boundaries

Five layers. Confusing any two is the failure mode this initiative exists to prevent.

| Layer | Owns | Mutable | Examples |
|---|---|---|---|
| **Canonical truth** | Row-level financial fact | Yes | `Transaction`, `FinancialAccount`, `SpaceSnapshot`, `PositionObservation`, `DebtProfile`, `SyncIssue` |
| **Canonical understanding** | Derived judgment over truth at an instant | **No — sealed** | `FinancialContextFrame`: assessment, confidence, evidence pointers, compact projections |
| **Semantic memory** | Facts about the *user*, not their ledger | Yes, with provenance | `StatedFact`, `ObservedPattern`, `LifeEvent`, `Insight` lifecycle |
| **Rendering** | Prose/voice/layout over a sealed frame | Regenerable | `FrameNarration`, Brief copy, chat reply |
| **Request-scoped context** | Presentation hints only | Ephemeral | current page, open workspace, drilldown selection |

**The frame is a projection, never a second truth.** It holds aggregates, classifications and *pointers*. Any consumer needing rows goes to canonical services, as today.

### 3.1 The four clocks — never collapsed

```
truthFreshness       as-of stamps of the canonical inputs
                     ("Chase balances are 3 days old")
compilationFreshness when this frame was sealed
                     ("compiled 4 minutes ago")
confidence           completeness/reliability per conclusion
                     ("liquidity HIGH, cash-flow LOW — income coverage 40%")
materiality          is a delta worth speaking about
                     ("net worth moved 0.2% — real, not material")
```

A frame can be **freshly compiled over stale truth**. A conclusion can be **arithmetically correct and low-confidence**. A delta can be **real and immaterial**. Three separate fields and one separate rule engine. The existing KD-7/KD-10 honesty patterns and the connection-card freshness vocabulary are the precedent.

---

## 4 · Proposed domain contracts

Exploratory TypeScript. Not final code, and deliberately **not** a Prisma model.

```ts
// ── Identity ────────────────────────────────────────────────────────────────
export interface FrameIdentity {
  frameId:            string;   // globally unique (cuid)
  spaceId:            string;
  version:            number;   // per-Space monotonic, gap-free
  previousFrameId:    string | null;
  compilerSchemaVersion:   number; // shape of the frame
  compilerBehaviorVersion: number; // reasoning that produced it
  compositionKey:     string;   // household/member identity (see §10.3)
  idempotencyKey:     string;   // dedupes repeated triggers
}

// ── Provenance: how this frame came to exist ────────────────────────────────
export interface FrameProvenance {
  compiledAt:      string;              // ISO — compilation freshness
  deploymentSha:   string;              // currentDeploymentSha() — OPS-2B′
  trigger:         CompilationTrigger;
  coalescedTriggers: CompilationTrigger[];  // what this compile absorbed
  durationMs:      number;
  /** Truth freshness — as-of per canonical input. NOT compiledAt. */
  inputs: Array<{
    domain:     string;   // 'accounts' | 'transactions' | ...
    asOf:       string | null;
    source:     string;   // canonical service name
    degraded:   boolean;
  }>;
  warnings:        FrameWarning[];
  incompleteDomains: string[];  // declared-but-unassembled (MEMBERS/PROVIDERS today)
}

export interface FrameWarning {
  code:    string;   // 'DOMAIN_UNASSEMBLED' | 'FX_ESTIMATED' | 'TRUNCATED' | ...
  domain:  string;
  detail:  string;
}

// ── Confidence: per-conclusion, not per-frame ───────────────────────────────
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface FrameConfidence {
  /** Keyed by assessment section id — liquidity, cashFlow, debt, ... */
  bySection: Record<string, {
    level:  ConfidenceLevel;
    reasons: string[];              // 'INCOME_COVERAGE_PARTIAL', 'APR_GAPS'
    inputCompleteness: number | null; // 0..1, null when not quantifiable
  }>;
}

// ── Evidence: pointers, never copies ────────────────────────────────────────
export interface FrameEvidence {
  /** Keyed by claim id. Every assessment claim must resolve to ≥1 pointer. */
  byClaim: Record<string, EvidencePointer[]>;
}

export type EvidencePointer =
  | { kind: 'transaction';  ids: string[] }
  | { kind: 'account';      ids: string[] }
  | { kind: 'snapshotRange'; from: string; to: string }  // dates, not rows
  | { kind: 'syncIssue';    ids: string[] }              // shared breach identity
  | { kind: 'position';     ids: string[] }
  | { kind: 'statedFact';   ids: string[] };

// ── The frame ───────────────────────────────────────────────────────────────
export interface FinancialContextFrame {
  identity:    FrameIdentity;
  provenance:  FrameProvenance;

  /** Compact projections of canonical reads. NOT row dumps. */
  financialState:   FinancialStateProjection;
  /** User-scoped platform truth from the SAME authorities Ops reads. */
  operationalState: OperationalStateProjection;

  /** THE judgment layer — computeAssessment output, promoted to frame-resident. */
  assessment:  FinancialAssessment;   // existing type, reused unchanged

  confidence:  FrameConfidence;
  evidence:    FrameEvidence;

  /** References only. Insights/StatedFacts/Patterns live in their own tables. */
  semanticRefs: {
    activeInsightIds: string[];
    statedFactIds:    string[];
    observedPatternIds: string[];
  };

  // NOTE: no `narrative`. See M2 — narration is a separate rendering record.
}

// ── Triggers ────────────────────────────────────────────────────────────────
export type TriggerClass =
  | 'SYNC_COMPLETED' | 'IMPORT_COMPLETED' | 'MANUAL_REFRESH'
  | 'SCHEDULED' | 'USER_CORRECTION' | 'ACCOUNT_LINKED' | 'GOAL_CHANGED';

export interface CompilationTrigger {
  class:      TriggerClass;
  spaceId:    string;
  occurredAt: string;
  /** Correlates to the causing execution — RefreshExecution/JobRun id. */
  causeRef:   { kind: 'refreshExecution' | 'jobRun' | 'request'; id: string } | null;
  /** Set when the trigger cannot change financial value (metadata-only). */
  financiallyInert: boolean;
}

// ── Compilation outcome ─────────────────────────────────────────────────────
export type CompilationResult =
  | { status: 'SEALED';      frame: FinancialContextFrame; delta: FrameDelta | null }
  | { status: 'UNCHANGED';   existingFrameId: string; reason: 'NO_MATERIAL_INPUT_CHANGE' }
  | { status: 'COALESCED';   intoIdempotencyKey: string }
  | { status: 'LOCK_HELD';   heldBy: string; retryAfterMs: number }
  | { status: 'FAILED';      error: string; lastHealthyFrameId: string | null;
                             partial: { domainsCompiled: string[] } };

// ── Semantic delta — a domain contract, not a JSON diff ─────────────────────
export type DeltaKind =
  | 'liquidityCoverageChanged'  | 'cashFlowStatusChanged'
  | 'debtBurdenChanged'         | 'investmentReadinessChanged'
  | 'priorityAdded'             | 'priorityResolved' | 'priorityReordered'
  | 'confidenceChanged'         | 'providerFreshnessDegraded'
  | 'providerFreshnessRecovered';

export interface FrameDelta {
  fromFrameId: string;
  toFrameId:   string;
  /** Layered — see §7. Consumers subscribe to a layer, not to raw diffs. */
  structural:  StructuralChange[];   // sections appeared/disappeared
  financial:   FinancialChange[];    // magnitudes moved
  assessment:  AssessmentChange[];   // classifications moved
  confidence:  ConfidenceChange[];   // certainty moved
  operational: OperationalChange[];  // freshness/health moved
  /** The subset eligible to become an Insight or notification. */
  material:    Array<{ kind: DeltaKind; severity: 'INFO'|'NOTABLE'|'URGENT';
                       claimId: string; rationale: string }>;
}
```

**Why `assessment` reuses `FinancialAssessment` unchanged:** it already exists (`lib/ai/intelligence/annotations/types.ts:567`), is pure over context, and is guard-tested. Redefining it would fork the very authority this initiative is consolidating.

---

## 5 · Persistence options

| | A · Normalized relational | B · JSON snapshot + indexed metadata | C · Hybrid (recommended) |
|---|---|---|---|
| Shape | ~8–12 tables mirroring frame sections | one row, `payload Json`, few columns | relational identity/provenance/index columns + versioned `payload Json` for sections |
| Query patterns | rich SQL over any field | key lookup only; payload opaque to SQL | latest-by-Space, version range, trigger class, warning presence — all indexed; section detail read in app |
| Migration risk | **High** — every contract change is a migration; the schema becomes the architecture (the failure mode M1 exists to prevent) | Low | Low — payload evolves under `compilerSchemaVersion`; columns change rarely |
| Version evolution | painful; old rows need backfill | trivial but unvalidated | `compilerSchemaVersion` gates a reader that upcasts old payloads |
| Retention | complex cascade deletes | trivial row delete | trivial row delete |
| Size | smallest | largest | small if projections stay compact (§2 guardrail) |
| Operational inspection | good | poor without tooling | good — Ops reads columns; inspector renders payload |
| Concurrency | many-row transaction | single-row insert | single-row insert + claim lock |

**Recommendation: C — hybrid.**

Indexed columns: `frameId`, `spaceId`, `version`, `previousFrameId`, `compilerSchemaVersion`, `compilerBehaviorVersion`, `compositionKey`, `idempotencyKey`, `compiledAt`, `deploymentSha`, `triggerClass`, `sealedAt`, `warningCount`, `incompleteDomainCount`. Payload: `financialState`, `operationalState`, `assessment`, `confidence`, `evidence`, `semanticRefs`.

Rationale: this is the same shape the repo already trusts for `RefreshExecution` and `SyncIssue` — queryable operational metadata beside a structured detail blob — so Ops inspection, retention and concurrency all reuse proven patterns. Critically, it lets the **contract** evolve during v2.6 without a migration per iteration, which is exactly what M1 requires.

**Guardrail (from the review's §2):** the payload must hold aggregates and pointers only. Explicitly forbidden inside a frame: transaction row arrays, full snapshot series (reference by date range), raw position histories, widget-specific payloads. A size ceiling should be asserted by a guard test, not by hope.

---

## 6 · Compiler lifecycle

```
trigger  →  intake  →  coalesce  →  claim lock  →  compile  →  seal  →  diff
                ↑                        │                        │
                └──── debounce window ───┘                  UNCHANGED? no new frame
```

**Intake.** Triggers are recorded, not executed. Each carries `class`, `spaceId`, `causeRef`, `financiallyInert`.

**Coalescing.** A debounce window (proposed 60s, configurable) collapses triggers per `spaceId`. Multiple transaction webhooks from one sync, or one `RefreshExecution` touching six accounts, produce **one** compile. `financiallyInert` triggers (metadata-only edits, operational health changes with no value change) never start a compile alone; they ride the next one.

**Lock.** Reuse the proven claim pattern from `lib/plaid/sync-lock.ts:74` — a conditional `updateMany` that succeeds for exactly one worker. Two workers must never seal conflicting versions. The lock is per `spaceId`.

**Idempotency.** `idempotencyKey = hash(spaceId, coalescedTriggerIds, compilerBehaviorVersion)`. A repeat within the window returns `COALESCED`, not a second frame.

**Version allocation.** `version = max(version) + 1` **inside** the same transaction as the insert, with a partial unique index on `(spaceId, version)`. The lock makes contention rare; the constraint makes correctness independent of the lock.

**Persistence transaction.** Seal and insert are one transaction. Nothing outside it — notably no Plaid call, no LLM call, no email — per the KD-4 rule already enforced in `mergeArchivedDuplicateIntoCanonical` and `purgeUser`.

**Unchanged compile.** If every input's as-of and every assessment classification are identical to the previous frame, return `UNCHANGED` and write **no** frame. This is the single most important defence against frame-history explosion. A scheduled daily compile over an untouched Space must not mint a frame.

**Failure.** A failed compile **never** mutates or deletes the last healthy frame. It records a failure row with partial-domain detail and returns `FAILED` with `lastHealthyFrameId`. Readers fall back to the last sealed frame and disclose its age. Retry is the next trigger — the schedule is the retry, exactly as `jobs/process-deletions.ts` treats the cron as its retry loop.

**Sealing.** Once inserted, a frame row is immutable. Enforce with a guard test and, if cheap, a DB rule. No `UPDATE` path may exist in the repository for a sealed frame.

---

## 7 · Semantic diff model

Raw JSON comparison is explicitly rejected: it cannot distinguish "net worth moved £3" from "liquidity fell from SAFE to CRITICAL", and it produces noise proportional to payload size.

**Five layers, then one eligibility rule.**

1. **Structural** — sections/domains appeared or disappeared (a provider was linked; MEMBERS finally assembles). Never itself material.
2. **Financial** — magnitudes moved. Carries absolute and relative change plus the confidence of both endpoints.
3. **Assessment** — a *classification* moved: `SAFE → WARNING`, a priority added/resolved/reordered, readiness flipped. **This is the layer that matters most**, because it is the layer users are told about.
4. **Confidence** — certainty moved without any number moving (income coverage improved because a paycheck was categorised). Frequently *more* important than a financial delta and invisible to a JSON diff.
5. **Operational** — freshness degraded/recovered, provider health changed, sync issue opened/resolved. Evidence pointer is the `SyncIssue` id — the shared breach identity that today's three disconnected detection stacks lack.

**Materiality** is a separate rule per `DeltaKind`, not a global threshold:

- Classification crossings are material by default (a boundary crossed *is* the news).
- Financial magnitude requires both a relative floor **and** an absolute floor, so small accounts don't scream and large ones don't hide.
- Confidence changes are material only when they change a *classification* or lift a section out of `LOW`.
- Operational changes are material when they degrade truth the user was previously told was fresh.
- Anything with endpoint confidence `LOW` is at most `INFO`, never `URGENT`. **A low-confidence conclusion may never produce an urgent insight.**

---

## 8 · First vertical slice — challenged and revised

The stated preference bundles: single-Space frame + deterministic assessment + persistence + shadow compilation + Chat reader + Brief reader + comparison telemetry.

**I recommend splitting it, and the repository evidence supports this.**

The live defect is the Brief/assessment contradiction (§2.2). Killing it requires **no schema, no compiler, no persistence** — only a shared contract and the deletion of four inline rules. Persistence buys reproducibility and diffing, both of which are v2.6b prerequisites, neither of which is needed to end the contradiction. Shipping the contract first also satisfies the review's own M1 and produces the proof that validates the schema before it is written.

**Recommended first slice — `V26-F1-A` · Assessment convergence, in memory:**

1. Define `FinancialContextFrame` and companions as **types + a pure `compileFrame(ctx)`** producing a sealed in-memory frame from existing `buildContext` + `computeAssessment`. No DB, no migration.
2. Brief calls `compileFrame` and renders `frame.assessment`; **the four inline rules at `route.ts:317,408-411,436-439` are deleted**, not synchronised.
3. A source-scan guard pins that no surface outside the compiler computes an assessment-class judgment — the same shape as `cash-flow-fold-authority.test.ts`.
4. Shadow telemetry: log legacy-verdict vs frame-verdict per Brief render behind a flag. This is the comparison dataset that de-risks everything after.
5. Baseline instrumentation for §13 metrics (compile duration, serialized tokens, section counts).

**Then `V26-F1-B` — persistence + shadow compile + Chat reader**, once the contract has survived contact with two real consumers.

This is not a smaller ambition; it is the same ambition with the schema arriving *after* its own proof.

---

## 9 · Migration sequence

Each package is independently reviewable and independently revertable.

| # | Package | Objective | Files | Depends | Tests | Rollout gate | Rollback |
|---|---|---|---|---|---|---|---|
| **WP-1** | Frame contract + pure compiler | `compileFrame(ctx)` returns a sealed in-memory frame | new `lib/ai/frame/*` | — | contract unit tests; determinism (same ctx ⇒ identical frame modulo provenance) | none (dead code) | delete dir |
| **WP-2** | Brief converges | Brief renders `frame.assessment`; 4 inline rules deleted | `app/api/brief/route.ts` | WP-1 | golden Brief output; authority guard | flag `FRAME_BRIEF` | flag off |
| **WP-3** | Divergence telemetry | log legacy-vs-frame verdict | brief route, `lib/monitoring` | WP-2 | — | on in preview first | flag off |
| **WP-4** | Baseline metrics | §13 numbers before behaviour changes | serializer, chat route | — | — | measurement only | — |
| **WP-5** | Persistence | hybrid table, seal, retention | schema + migration | WP-1..3 green | concurrency, immutability, size ceiling | shadow write | drop table; frame stays in-memory |
| **WP-6** | Compiler lifecycle | triggers, coalescing, lock, idempotency | `lib/ai/frame/compiler`, job registry | WP-5 | lock contention, unchanged-compile, failure isolation | shadow compile | disable trigger intake |
| **WP-7** | Chat reader | chat reads latest frame + staleness policy | chat route | WP-6 | parity vs rebuild | flag `FRAME_CHAT` | flag off |
| **WP-8** | Semantic diff | `FrameDelta` + materiality | `lib/ai/frame/delta` | WP-6 | delta classification fixtures | shadow | — |
| **WP-9** | Ops frame inspector | §14 surface | platform widgets | WP-5 | surface guards | — | — |

**Explicitly out of this initiative's first phase:** Insight table, notification producers, timeline events, embeddings, Voice, Coinbase, search, household composition. WP-1's contract must merely not *prevent* them.

---

## 10 · Risks and open decisions

**10.1 Stale frames.** A frame sealed over 3-day-old Chase data is honest only if the surface says so. Mitigation: `truthFreshness` is rendered, never hidden; a surface needing fresher truth triggers a compile and discloses. Risk if botched: users are told confident things about stale money.

**10.2 Concurrency.** Two workers sealing "version N+1". Mitigated by claim lock **plus** a `(spaceId, version)` unique constraint — belt and braces, because the lock is an optimisation and the constraint is the guarantee.

**10.3 Household composition.** `SpaceFrame → HouseholdFrame` is a **separate compiler**, not concatenation. It must handle account dedup (the Brief already dedups by account id — that logic moves into the composer), member visibility, currency normalisation, conflicting confidence, failed/stale component Spaces, duplicated liabilities and transfers, and cross-Space priority ranking. `compositionKey` in `FrameIdentity` exists so the single-Space contract does not preclude it. **Not in the first slice.**

**10.4 Frame bloat.** The stated defence is aggregates-and-pointers. Enforce with a guard test asserting a payload size ceiling and banning row arrays. Without it, this becomes a second transactions table.

**10.5 Evidence retention.** Evidence pointers can dangle — a referenced transaction may be tombstoned or purged (`purgeUser` hard-deletes). **Do not promise complete historical reconstruction.** The honest contract: a pointer resolves *or* the reader reports "evidence no longer available", exactly as the FX layer reports `amount: null` rather than inventing a figure.

**10.6 Privacy / visibility.** Frames are per-Space and must respect `SpaceAccountLink` visibility. A `BALANCE_ONLY` member must not receive a frame carrying transaction-derived evidence. The existing visibility predicate gates the data; the frame must not become a bypass. `lib/ai/visibility.ts` relocation (a v2.5 boundary obligation, still open) should land before or with WP-5.

**10.7 Compiler cost.** Event-driven compilation could cost *more* than lazy compilation for inactive Spaces receiving daily scheduled compiles. The `UNCHANGED` path is the mitigation and must be implemented in WP-6, not deferred.

**10.8 Failed domains.** `MEMBERS`/`PROVIDERS` are declared-but-unassembled today and silently skipped. In a frame this becomes a recorded `incompleteDomains` warning — an improvement, but it means the first frames ship with known gaps. Decide: ship the assemblers, or delete the routing.

**10.9 User corrections.** A correction (recategorised transaction) must trigger recompilation, or the frame contradicts what the user just did. Trigger class exists; the wiring is WP-6.

**10.10 Deterministic vs generated narrative.** Resolved by M2 — narration is a separate versioned record referencing `frameId`, regenerable, validator-gated, and may introduce no new financial claim.

### Open decisions requiring a product call

**D1 — Which liquidity semantics is canonical?** Coverage-months (assessment) or percent-of-net-worth (Brief)? **This changes what users are told.** My recommendation is coverage-months: it is dimensionally correct, already confidence-aware, and shares its denominator with cash flow (KD-10). But this is a product decision and I will not make it silently. **Blocks WP-2.**

**D2 — Frame retention.** The thesis proposes 90-day dailies / 2-year weeklies / permanent monthlies. That is a storage-cost, privacy and GDPR-erasure decision. Note `purgeUser` must cascade frames. **Blocks WP-5.**

**D3 — Are stated facts in v2.6 scope?** User-taught memory ("rent is 800 KWD") needs source-message provenance, effective dates, editability, deletion, verification state, visibility scope and conflict resolution before a single row is written. Recommend **deferring to v2.6b** and shipping `statedFactIds` as an empty reference in the first contract.

---

## 11 · Acceptance criteria

1. **No contradiction.** For a given frame, Chat and Brief produce no contradictory assessment. Enforced by construction (one authority) and pinned by a source-scan guard banning assessment-class judgments outside the compiler.
2. **Traceability.** Every AI answer references the frame version it reasoned from.
3. **No duplicate folds.** Frame compilation performs no unauthorised duplicate financial fold; the transactions assembler's acknowledged scope fork (`transactions.ts:348`) is closed or explicitly waived with a recorded reason.
4. **Failure isolation.** A compiler failure never destroys or mutates the last healthy frame; readers fall back and disclose.
5. **Four clocks distinguishable.** Truth freshness, compilation freshness, confidence and materiality are separately readable on every frame.
6. **Shadow comparability.** Legacy and frame behaviour can be compared per render before any user is switched.
7. **Operator inspection.** An operator can answer *why this frame exists* — trigger, coalesced triggers, inputs and as-of times, warnings, previous frame, delta.
8. **Immutability.** No code path updates a sealed frame; a guard test proves it.
9. **Suite green.** Full suite passes; the new guards run in CI (393/393 today, tracked = on disk).

---

## 12 · Recommended first implementation ticket

> **V26-F1-A · Frame contract + Brief assessment convergence**
>
> Land the `FinancialContextFrame` domain contract and make the Daily Brief render the canonical assessment instead of its own inline judgments. **No Prisma model, no migration, no persistence in this ticket.**
>
> **1. `lib/ai/frame/` (new)**
> - `types.ts` — `FinancialContextFrame`, `FrameIdentity`, `FrameProvenance`, `FrameConfidence`, `FrameEvidence`, `EvidencePointer`, `CompilationTrigger`, `CompilationResult`. Reuse `FinancialAssessment` from `lib/ai/intelligence/annotations/types.ts` unchanged. **No `narrative` field.**
> - `compile.ts` — `compileFrame(ctx: SpaceContext_AI, trigger: CompilationTrigger): FinancialContextFrame`. Pure: calls `computeAssessment(ctx)`, projects compact `financialState`/`operationalState`, populates `confidence` from existing section confidence, populates `evidence` with pointers only. `identity.version` is `0` and `frameId` is caller-supplied — this ticket seals in memory and persists nothing.
>
> **2. `app/api/brief/route.ts`**
> - Behind flag `FRAME_BRIEF` (default **off**), call `compileFrame` and render `frame.assessment`.
> - **Delete**, do not synchronise, the four inline rules: low-liquidity `:317`, savings-rate `:408-411`, debt-ratio `:436,439`, cash-ratio `:437`. With the flag off the legacy path stays byte-identical.
> - Resolve **D1** before writing the liquidity copy. If D1 is unresolved, stop and ask.
>
> **3. Guard — `lib/ai/frame/frame-authority.test.ts`**
> - Model on `cash-flow-fold-authority.test.ts`. Assert no file outside `lib/ai/frame/` and `lib/ai/intelligence/` computes an assessment-class judgment (liquidity classification, savings rate, debt ratio, readiness). The Brief must fail this test before the deletion and pass after.
> - Assert `compileFrame` is deterministic: same context ⇒ identical frame except `provenance.compiledAt`/`durationMs`.
> - Assert the frame carries no row arrays (bloat ceiling).
>
> **4. Telemetry (flag-gated)**
> - On each Brief render with the flag on, record legacy verdict vs frame verdict for the four judgments. Console/Sentry breadcrumb is sufficient — no schema.
>
> **Constraints:** no migration; no `AiAdvice` write; no notification producer; no embeddings; do not modify `computeAssessment` or any canonical v2.5 service; do not touch the chat route.
>
> **Done when:** suite green (394/394 with the new guard), `tsc` clean, lint clean, flag off ⇒ Brief output unchanged, flag on ⇒ Brief renders the canonical assessment and the guard passes.

---

## Appendix · Verification index

| Claim | Evidence |
|---|---|
| `computeAssessment` has 2 call sites, both chat | `app/api/ai/chat/route.ts:404,454` |
| Brief never assesses | `app/api/brief/route.ts` — no `computeAssessment` import or call |
| Brief inline judgments | `route.ts:317, 408-411, 436-437, 439` |
| Assessment liquidity = coverage months | `annotations/engine.ts:291-303` |
| APR triplication | `annotations/engines.ts` · `perspective-engine/lenses/debt.core.ts:269` · `space/widgets/debt/debt-kpis.ts:223` |
| Assembler scope fork | `lib/ai/assemblers/transactions.ts:348` |
| No Conversation/Frame/Insight model | `prisma/schema.prisma` — grep returns 0 |
| `AiAdvice` zero production writers | writers: `prisma/seed.ts:787,1264` only |
| AI notifications all VOCABULARY | `lib/notifications/registry.ts:489` |
| Timeline placeholders | `lib/timeline-types.ts:7,108` |
| Planner shadow-only | `lib/ai/context-priority/types.ts:164` |
| Double serialization | `lib/ai/prompts/context-serializer.ts:506` |
| `ApiUsageCounter` has no space dimension | `prisma/schema.prisma:2390` |
| MEMBERS/PROVIDERS unassembled | manifest `:43-48,58` vs 5 `registerAssembler` calls |
| Claim-lock precedent | `lib/plaid/sync-lock.ts:74` |
| Audit write per context build | `lib/ai/context-builder.ts:222` |
