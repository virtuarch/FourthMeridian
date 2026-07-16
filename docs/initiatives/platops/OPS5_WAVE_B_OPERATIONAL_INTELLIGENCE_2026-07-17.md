# OPS-5 Wave B — Operational Intelligence (S7 → S9 → S10)

**Status:** COMPLETE · each stage validated green in isolation · committed (S7 `100dcfb`, S9 `a2d86c5`, S10 `131d2e0`), not pushed
**Date:** 2026-07-17 · branch `feature/v2.5-spaces-completion`
**Scope:** S7 Operational History · S9 Off-ledger Convergence · S10 Cost & Latency Intelligence. Architecture-first; no invented dashboards/metrics; every surface consumes one existing authority.

---

## 0. The governing decision

The mission's absolute prohibitions ("no second JobRun interpretation, no second freshness/provider model, historical values computed differently than live") force one architecture: **the intelligence layer is a stack of PURE READ MODELS over the append-only ledgers that already exist, reusing the live engines at as-of points — never new stored rollups computed by new logic.** The durable substrate is already present (JobRun, the evaluate-alerts JobRun store, FxRate archive, SyncIssue, AuditLog); S7/S9/S10 *expose* the latent intelligence, marking trust honestly. No new tables, no writes, no background workers.

**STOP-condition check (passed):** no second operational authority existed; the concurrent HIST-1 initiative is *financial* history (a different domain); the time model reuses the finance `shellTimeReducer` (no second date authority). It even yielded a reusable primitive — HIST-1's `nearestOnOrBefore`, which S7 consumes for as-of picks.

## 1. Authority map — one authority per concern

| Concern | Single authority | Consumes | Produces | Persists |
|---|---|---|---|---|
| Operational history | `lib/platform/history` (S7) | JobRun · alert store (S5) · FxRate archive — reusing `classifyJobHealth` / `classifyResourceFreshness` at as-of | `OperationalHistoryResult` | nothing (read model) |
| Off-ledger convergence | `lib/platform/convergence` (S9) | JobRun · alert store · SyncIssue · AuditLog transitions (read-only projections) | `ConvergenceResult` (episodes) | nothing |
| Cost & latency | `lib/platform/cost` (S10) | **S7 + S9 only** | `CostResult` (metrics + provenance) | nothing |
| Trust vocabulary | `lib/perspective-engine/types` `CompletenessTier` (reused) | — | observed/derived/estimated/incomplete/unknown | — |
| Time model | `lib/perspectives/time-range` `shellTimeReducer` (reused) | — | asOf/compareTo/window | — |

Every existing authority (JobRun, Scheduler, Freshness/S1, Provider Health/S3, Alert engine/S5, Manual Operations/S4, Platform permissions, AuditLog) is **untouched and consumed**, never bypassed or re-implemented.

## 2. Dependency graph (before → after)

```
BEFORE (Wave A):  point-in-time authorities only
  JobRun ─ Job Health(S2) ─ Provider Health(S3) ─ Alerts(S5) ─ Freshness(S1) ─ Manual Ops(S4)
      (each read-time / current-state; no historical layer)

AFTER (Wave B):  a pure read-model intelligence stack on top — no new persistence
                          ┌──────────── S10 Cost & Latency ────────────┐
                          │  (pure derivation; S7 + S9 ONLY)           │
                          ▼                                            │
      S7 Operational History ──────────────► (consumed by S10) ◄───────┤
        reuse: classifyJobHealth, classifyResourceFreshness            │
        + S5 alert store + FxRate archive, at as-of (nearestOnOrBefore) │
                          ▲                                            │
      S9 Off-ledger Convergence ───────────► (consumed by S10) ◄───────┘
        read-only projections of JobRun/alerts/SyncIssue/AuditLog → episodes

  Ledgers (JobRun, alert store, SyncIssue, AuditLog, FxRate): UNCHANGED, independent.
  Cycles: none (S10 → {S7, S9}; S9 → ledgers; S7 → ledgers + live engines). Leaf: S10.
```

## 3. S7 — Operational History

- **One model** (`types.ts`): `OperationalHistoryResult` — as-of · compare-to · window · per-source trend series + per-source as-of state, with a `Completeness` trust (worst tier). Mirrors Financial time (same asOf/compareTo contract; no second date authority).
- **Registry-driven sources** (`sources.ts`): `jobs` → `classifyJobHealth` at as-of · `operations` → JobRun `trigger:"manual"` (observed) · `alerts` → S5's alert store (observed) · `freshness` → `classifyResourceFreshness` at as-of via `nearestOnOrBefore`. Adding a source = one descriptor.
- **No second model:** provider evolution is *composable* from `jobs` + `freshness`; re-deriving provider trust would be a forbidden second provider-health model, so it is documented (reuse S3 when connection-state history exists), not faked. Freshness-of-prices depends on held-instruments-as-of (HIST-1's domain) → honestly `unknown`, not re-modelled.
- Best-effort per source (failure → `unknown`, never breaks the read). Zero writes, zero tables.

## 4. S9 — Off-ledger Convergence

- **Pure read model** (`convergence.ts`): projects each ledger's rows into read-only `ConvergenceEvent`s, then a **pure correlation engine** clusters them (by time proximity) into `ConvergenceEpisode`s answering *what happened · caused · recovered · participated*. The FX incident (fx-rates failed → alert fired → manual run → recovered) becomes **one episode with a derived narrative**.
- **Registry-driven, provider-neutral participants** (`participants.ts`): jobRun · alert store · SyncIssue · AuditLog transitions. Adding a ledger = one participant. No switch statements.
- **Does NOT merge/replace/flatten/reinterpret/persist**; emits no new event (doctrine source-scanned: no `create/update/delete`, no `emit/dispatch/publish`). The ledgers stay independent and untouched.

## 5. S10 — Cost & Latency Intelligence

- **Pure derivation** (`cost.ts` `deriveCostMetrics`) over **S7 + S9 only** — no direct execution/ledger reads, no collectors, no background workers (doctrine source-scanned: no `@/lib/db`, no `findMany`, no `setInterval/queue/cron`).
- Metrics: avg-runtime / latency-drift / runtime-load from S7's latency series (`derived`); projected-daily-load (`estimated` — a projection, honestly tiered); failure-cost / retry-cost / incident-count from S9 episodes (`derived`); **spend-usd honestly `unknown`** (no unit pricing configured — never a fabricated 0).
- Every metric **states its provenance**; Unknown stays Unknown, Estimated stays Estimated.

## 6. Workspace rules (honored)

No new dashboard, no new navigation layer. All three surfaces are **Workspace CONTENT**: read routes + presentation-only widgets (they derive nothing — every verdict/trust arrives precomputed) composed into a single new **History** workspace on the existing Platform Space (reusing Wave A's `WORKSPACE_REGISTRY` identity + `PLATFORM_AREA_WORKSPACES` composition owner + `SpaceShell`).

## 7. Extensibility (one registry entry, not architectural change)

- New historical subsystem → one `OPERATIONAL_HISTORY_SOURCES` descriptor.
- New ledger in the story → one `CONVERGENCE_PARTICIPANTS` entry.
- New cost metric → one branch in `deriveCostMetrics` over the existing S7/S9 shapes.
Future providers/schedulers/alerts/resources flow in through the *existing* authorities they already register with (SCHEDULED_JOBS, RESOURCE_FRESHNESS, PROVIDER_SPECS, the alert rules) — the intelligence layer inherits them for free.

## 8. Validation

Each stage validated green **in isolation** before the next: `tsc --noEmit` clean · `eslint` clean · the stage's unit test green —
- `lib/platform/history/history.test.ts` — engine-reuse (job health & freshness reconstructed the SAME as live), honest trust (observed→derived→unknown), best-effort, doctrine scan.
- `lib/platform/convergence/convergence.test.ts` — story correlation, gap clustering, best-effort, pure-read-model doctrine scan.
- `lib/platform/cost/cost.test.ts` — derivation, unknown-stays-unknown, consumes-S7+S9-only, derived-only doctrine scan.

**Concurrency caveat (honest):** the branch is under heavy concurrent rewrite (HIST-1, TI2-W2, TEST-0, CLEAN-0, COMPLEX-0). During Wave B the full suite intermittently went red on a **concurrent** change (a TI2-W2 KD-17 serializer tripwire; earlier a chat-route export) — **not** in any Wave B file. All Wave B code is green in isolation (tsc + its own tests), committed with explicit pathspec (each verified to contain only its own files). The full-suite figure at any instant reflects the concurrent churn, not this wave.

## 9. Verdict (the mission's required answers)

```
Is Operational History the single historical authority?   YES   (lib/platform/history — one read model over the
                                                                 ledgers, reusing live engines; no second interpretation)
Is Convergence consuming rather than replacing ledgers?   YES   (pure read-only projections + correlation; no merge,
                                                                 no persistence, no new event system)
Is Cost Intelligence purely derived?                      YES   (over S7 + S9 only; no direct reads; provenance-stamped;
                                                                 unknown stays unknown — doctrine-scanned)
Is Platform Operations still modular?                     YES   (three small registry-driven modules; Workspace content;
                                                                 one authority per concern)
Is another monolith forming?                              NO
Is Wave C now unlocked?                                   YES   (the historical substrate that Wave A's S8 Perspective
                                                                 foundation was BLOCKED_ON_S7 now exists — operational
                                                                 Perspectives can bind to S7/S9/S10 with the honest
                                                                 non-finance temporal model documented in Wave A)
```

**Commits (not pushed):** `100dcfb` S7 · `a2d86c5` S9 · `131d2e0` S10.
