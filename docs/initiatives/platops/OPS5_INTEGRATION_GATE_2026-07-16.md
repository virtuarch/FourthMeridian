# OPS-5 Integration Gate — Platform Operations Maturity Validation

**Status:** GATE COMPLETE · 2026-07-16 · branch `feature/v2.5-spaces-completion`
**Scope:** prove OPS-5 (S1–S5) behaves as one coherent operational system, not five independently-correct slices. Read-only except one genuine integration bug fix (Part E/F, §11). Did NOT begin S6.
**Method:** first-hand reads of the load-bearing correctness surfaces (freshness state machine, single execution path, alert engine) + four parallel deep audits (S2 job-health, S3 provider-health, S4 manual-ops, UI/dead-code).

---

## 0. Verdict summary

| Question | Answer |
|---|---|
| OPS-5 internally coherent? | **YES** (after the §11 fix) |
| Single authority preserved? | **PARTIAL** (one deliberate, documented duplication — §3) |
| Operational monolith forming? | **NO** (dashboard 215 LOC, policy 183 LOC, flat registry lookup) |
| Ready for S6? | **YES** |
| Production-ready? | **PARTIAL** (fixed the false-red; residual: dispatcher SPOF needs an external uptime check) |
| Critical fixes required before S6? | **NO** (the one critical fix is applied; the rest are documented follow-ons) |

---

## 1. Authority map (Part A — one owner per concern)

| Concern | Canonical owner | Notes |
|---|---|---|
| Resource freshness | `lib/platform/resource-freshness.ts` (S1) | content-derived (`MAX(archive.date)`), never `JobRun.status` |
| Completeness | S1 (frontier ratio) | sole computer |
| Freshness trust | S1 (`FreshnessTrust`) | resource-scoped |
| Job health / execution state | `lib/jobs/health.ts` (S2/OPS-4) | JobRun ledger only; single detector (ratcheted) |
| Provider health synthesis | `lib/platform/provider-health.ts` (S3) | consumes S1 + connection-health + JobRun + ApiUsageCounter |
| Provider trust | S3 (`deriveProviderTrust`) | its one judgement; consumes S1 trust, doesn't recompute |
| Manual operation execution | `lib/platform/operations/` (S4) | one path → `runJob(trigger:"manual")` |
| Alert evaluation / suppression / history | `lib/alerts/` (S5) | JobRun ledger IS the store |
| Quota | **nobody** | honestly null everywhere (S3 `remainingQuota:null`); `quota-low` dormant |
| Scheduler silence | S2 job-health (`overdue`) → consumed by S5 | |
| Last success / last failure / latency / failure-streak | **two computers** — see §3 | job-health (per-job, recent) + provider-health (per-provider, 7-day) |
| Cadence | two subjects, not duplicated | job cadence (S2 registry) vs resource cadence (S1 descriptor) |

**Every concern has exactly one owner except the JobRun-window execution metrics (§3).**

## 2. Dependency graph (Part C — DAG, no cycles)

```
JobRun ledger (OPS-4)                    ApiUsageCounter (Wave-2 S7)
   │  ▲                                        │
   │  │ trigger:"manual"                       │
   ▼  │                                        │
 Rich Job Health (S2) ──┐        Connection Health ──┐   Resource Freshness (S1)
   │       ▲            │                │           │        │        │
   │       │ runJob     │                ▼           ▼        ▼        │
 Manual Operations (S4) │        Provider Health (S3) ◀───────┘        │
   │ (route: AuditLog)  │                │                             │
   │                    │                │                             │
   └──── produces ──────┘                │                             │
                                         ▼                             ▼
                              Alerting (S5) ◀──────────────────────────┘
                              consumes: job-health, connection-health, resource-freshness
                              produces: evaluate-alerts JobRun (= alert history/suppression)
                              side effect: OPS-1 email
```

Per-node (consumes / produces / consumers / side-effects / persistence / lifecycle):

| Node | Consumes | Produces | Consumers | Side effects | Persistence | Lifecycle |
|---|---|---|---|---|---|---|
| **S1 Freshness** | archives (FxRate, PriceObservation), JobRun (surface only) | `ResourceFreshnessResult` | S3, S5, widget | none | none (read-time) | per-request |
| **S2 Job Health** | JobRun only | `ScheduledJobsHealth` | S3, S5, widget | none | none | per-request |
| **S3 Provider Health** | S1, connection-health, JobRun, ApiUsageCounter | `ProviderHealthResult` | widget | none | none | per-request |
| **S4 Manual Ops** | SCHEDULED_JOBS body, JobRun (lock) | `OperationRunResult` | route/widget | **runJob**, AuditLog | JobRun (`trigger:"manual"`) | on-demand |
| **S5 Alerting** | S1, connection-health, S2 job-health, JobRun (suppression) | `AlertRunSummary` | route/widget | **OPS-1 email** | JobRun (`evaluate-alerts`) | daily (07:30) |

**Cycles: none.** `lib/alerts` is a leaf — nothing imports it back (verified: only `email/templates/platform-alert.ts`, the route, and the job body import it). No upstream authority imports alerting.

## 3. Duplication audit (Part A/B — the one real finding)

**`provider-health.ts` re-derives JobRun-window execution metrics** (`summarizeJobRuns`, lines 256–312) — availability/success-rate, latency, last-failure, failure-streak — **instead of consuming `lib/jobs/health.ts`**, and copies its constants (`PROVIDER_FAILING_STREAK=3` ≙ `FAILURE_STREAK_THRESHOLD`, `PROVIDER_STALE_RUNNING_HOURS=2` ≙ `STALE_RUNNING_HOURS`).

- **Deliberate + documented:** the header (lines 78–83) states it is kept local "so this slice does not import from a module a concurrent slice is actively editing." That concurrency justification has now **expired** (S2 and S3 are both landed).
- **Subtle divergence (latent):** provider-health counts a stale-`running` row into `failed`/`errorRate`; job-health counts `failedRuns` only on `status==="failed"` (folding stale-running into the streak alone). So the two success/availability figures can differ for the same job — though over **different windows** (provider 7-day vs job-health recent-5) and **different subjects** (provider vs job), so they are related-but-distinct, not the same number computed twice.
- **Correction (recommended, not a blocker):** extract a shared failure/stale-running classification primitive (`isFailureRun` + the two constants) into `lib/jobs/health.ts` and have provider-health import it; leave each slice's aggregation window as its own. This removes the mirrored constants and the divergence risk. **Not fixed in this gate** — it is a design consolidation of a just-landed slice, not a correctness bug, and touches S3's public metric semantics.

No other concern is computed twice. Trust (S1 resource-trust vs S3 provider-trust) and cadence (job vs resource) are distinct concerns, not duplication. S3 consumes S1's freshness/trust rather than recomputing (verified: `freshnessFromResourceReport` copies `healthState`/`ageDays`/caveat verbatim).

## 4. Consumption audit (Part B)

| Consumer | Should consume | Actually consumes | Verdict |
|---|---|---|---|
| S3 Provider Health | S1 freshness, connection-health, JobRun | S1 `checkResourceFreshness`, `getConnectionHealth`, JobRun, ApiUsageCounter | ✅ correct |
| S5 Alerting — freshness | S1 Resource Freshness | `checkResourceFreshness()` | ✅ correct |
| S5 Alerting — job health | S2 Job Health | `checkScheduledJobHealth()` | ✅ correct |
| S5 Alerting — provider | (gate graph: Provider Health S3) | `getConnectionHealth()` **directly** | ⚠️ deliberate — see below |
| S4 Manual Ops | canonical execution | `runJob` + `SCHEDULED_JOBS` body | ✅ proven single-path |
| S2 Job Health | JobRun only | JobRun only | ✅ correct |

**S5 provider concern consumes connection-health directly, not S3 Provider Health.** This is a deliberate atomic-concern mapping, and it is defensible:
- Each S5 rule maps to ONE atomic authority: `provider-unhealthy` → connection state (connection-health), `resource-stale` → freshness (S1), `job-failing`/`scheduler-silent` → job health (S2). The **union of these atomic rules covers everything S3's blended trust reflects** (S3 rolls up exactly connection + freshness + job-availability). No coverage gap.
- Consuming S3's blended trust for the provider rule would **entangle freshness into the provider alert** and risk **double-firing** with `resource-stale` on a stale archive. Atomic mapping avoids that.
- connection-health is THE authority for connection state; S3 is a sibling *aggregator* that itself consumes connection-health — so S5 is not skipping a layer, it consumes the same base authority.

**Recommendation:** keep as-is (atomic mapping is cleaner for alerting). If strict S1→S3→S5 layering is preferred, re-point `provider-unhealthy` at S3 — but only after de-duplicating the double-fire against `resource-stale`. Documented for the reviewer's call; not changed.

No layer-skipping shortcuts found in any slice (no raw product-table reads for health/freshness anywhere — grep-ratcheted in S1/S3).

## 5. Manual Operations (Part D) — PROVEN single path

Cron and manual execution share **exactly one body and one wrapper**:

```
cron    dispatch.ts:97   runner(job.name,      job.run,                 {trigger:"cron"})
manual  execute.ts:131   deps.runJob(jobName,  resolveJobBody(target),  {trigger:"manual"})
                                               └─ resolveJobBody(t) === SCHEDULED_JOBS[t].run  (identity, ratcheted)
                         deps.runJob === realRunJob   (the sole JobRun writer)
```

- **Dry-run** executes nothing, writes no JobRun (ratcheted `runJob NOT called`).
- **Side effects:** JobRun (`trigger:"manual"`, in `runJob`) + AuditLog (`performedByAdminId`, in the route, on both run and dry-run).
- **In-flight lock:** the running JobRun row (STALE_RUNNING_HOURS window shared with the health detector) → 409; no new lock table. Application-level check-then-act (not DB-atomic) — acceptable given idempotent-only targets + rate-limit + UI guard.
- **Authz:** `requireFreshPlatformAccess("PLATFORM_OPS","WRITE")` on the whole action surface. Reserved kinds honestly gated; destructive jobs excluded (ratcheted).

## 6. Alert correctness (Part E)

| Rule | Authority | Trips on | False-green? | False-red? | Spam? | Recurse? |
|---|---|---|---|---|---|---|
| resource-stale | S1 freshness | `stale`, or `empty` **and not blocked** (§11 fix) | No (content-derived) | No (idle skipped; blocked-empty skipped) | No (suppress-while-open) | No |
| provider-unhealthy | connection-health | any non-HEALTHY | No | No (only real states) | No (one aggregate signal) | No |
| job-failing | S2 job-health | `failing` streak | No | No | No | No (see below) |
| scheduler-silent | S2 job-health | `overdue` | No | **No — `never-ran` excluded** (fresh-deploy safe) | No | No |
| quota-low | — (dormant) | never | n/a | n/a | n/a | n/a |

- **Can suppression hide unrelated alerts?** No — suppression is keyed per `dedupeKey` (rule + target); a suppressed provider alert cannot hide a job alert.
- **Can evaluation alert on itself?** `evaluate-alerts` is a registered job, so job-health watches it — but the evaluator **never throws** (best-effort), so it can never produce a `failed` JobRun → never trips `job-failing` on itself. If the dispatcher dies, `evaluate-alerts` goes `overdue` but cannot run to alert — the known dispatcher SPOF (§10), not a spurious self-alert.
- **Dormancy:** `quota-low` is `live:false` and cannot fire even if force-enabled — honest until a quota authority exists (none does; §1).

## 7. Freshness correctness (Part F) — the original failure mode

`classifyResourceFreshness` derives health from the **observation only**; the ledger adds caveats, never the state:

| Scenario | healthState | Correct? |
|---|---|---|
| **Job succeeded + archive stale** | `stale` (+ false-green caveat) | ✅ NOT healthy/green — the incident fix |
| Archive empty (tracked, not blocked) | `empty` (critical) | ✅ |
| Archive empty (blocked pipeline) | `empty`, trust `unknown` | ✅ honest — **and no longer alerts (§11)** |
| Archive empty (nothing tracked) | `idle` | ✅ vacuously healthy |
| Archive partial (fresh, frontier < 1) | `fresh`, trust `medium` | ✅ surfaced, not paged |
| Archive delayed (within grace) | `fresh` | ✅ grace absorbs jitter |
| Job failed + archive fresh | `fresh` (lastAttemptStatus surfaced) | ✅ content fresh regardless of last job |

## 8. Provider extensibility (Part G)

Adding a provider (Coinbase / Polygon / AlphaVantage / CSV Import) is **registry-entry-only** — one `ProviderSpec` append to `PROVIDER_SPECS`; the driver derives everything generically (no `switch(provider.key)` anywhere). A `via:"resource"` entry points at an S1 descriptor id; `via:"connection"` at a connection source. Only prerequisite: the upstream S1 descriptor / ApiUsageCounter metering must exist — an authority concern, not an edit to provider-health. Same story for S1 (add a descriptor) and S5 (add a rule = one registry entry + one evaluator branch).

## 9. UI ownership (Part H) — clean

**0 widgets compute a verdict.** All nine Ops widgets self-fetch their `/platform-ops/*` route and render precomputed JSON; client work is presentation only (label maps, `timeAgo`, number formatting, counting/filtering arrays, severity→colour, worst-first ordering). Every health/trust/freshness/alert/provider verdict arrives precomputed from `lib/platform/*` / `lib/alerts` / `lib/jobs/health`.

## 10. Runtime behavior (Part J) — degrades honestly

| Condition | Behavior |
|---|---|
| Cold start / first install / no JobRun | job-health → `never-ran` (scheduler-silent excludes it → **no false page**); freshness → `empty`/`idle`; FX empty → resource-stale records (emails only if `PLATFORM_ALERTS_EMAIL` set) |
| No providers / no connections | connection-health total 0 → provider-unhealthy no signal; provider-health OPERATIONAL/UNKNOWN |
| FX outage (archive stale) | freshness `stale` even on green job → resource-stale warns |
| Price outage (vendor-gated) | freshness `empty` trust `unknown` → **no false page** (§11) |
| Mixed provider/resource states | each rule fires independently; suppression per-key |
| Manual-only runs | ledgered `trigger:"manual"`; job-health `manualRuns` counts them |
| Scheduler disabled (dispatcher dead) | jobs go `overdue`; **but evaluate-alerts also can't run → no in-app signal.** Residual SPOF — needs an external uptime check on `/api/jobs/dispatch` (S5 report §7). |
| No email destination | alerts evaluated + recorded; delivery `skipped` (honest, surfaced) — never a guessed send |

## 11. Integration fix applied (the one genuine bug)

**Bug (false-red, cross-slice semantic drift):** S1 marks a *blocked* pipeline's empty archive (e.g. `security-prices` with no price vendor — A8-3B) as `healthState:"empty"` **but `trust.level:"unknown"`** — its explicit "honest, not a false alarm" signal. S5's `resource-stale` fired on `healthState==="empty"` **regardless of that trust signal**, so on every production deployment with held instruments and no price vendor it would page the operator (critical) about a gated no-op they cannot fix.

**Fix:** `evaluateResourceStale` now fires on `empty` **only when `trust.level !== "unknown"`** (a genuine failure), while `stale` (always has data, never blocked-relevant) always fires. This respects S1's honesty contract end-to-end. Regression tests added (blocked-empty → no fire; genuine-empty → fires). `lib/alerts/evaluate.ts` + `lib/alerts/alerts.test.ts`.

## 12. Dead-code ledger (Part K — documented only, NOT deleted)

The whole **placeholder subsystem in `PlatformSpaceDashboard.tsx` is now unreachable** — every one of the 16 materialized section keys resolves to a real widget, so the placeholder branch never renders:

| File:line | Item | Why obsolete |
|---|---|---|
| `PlatformSpaceDashboard.tsx:106–126` | `PLATFORM_SECTION_REGISTRY` (15 keys) | notes never rendered (widget always wins) |
| `PlatformSpaceDashboard.tsx:128–130` | `sectionNote()` | only caller is the dead PlaceholderCard |
| `PlatformSpaceDashboard.tsx:148–172` | `PlaceholderCard` | never reached |
| `PlatformSpaceDashboard.tsx:186` | ternary `: <PlaceholderCard/>` | dead branch |
| `PlatformSpaceDashboard.tsx:34` | `Wrench` import | used only by PlaceholderCard |
| `PlatformSpaceDashboard.tsx:3–31` | header "placeholder render surface" framing | real widgets replaced all bodies |
| 7 × "Lands in PO1.x…" notes | stale slice references | those widgets shipped |
| `policy.ts:32–33, 43–44, 54–55` | "all placeholder widgets in PO1.0" comments | no longer placeholders |

No OPS-4 leftovers (only accurate historical provenance). No pre-S1/S2/S3 logic made obsolete by OPS-5 beyond the placeholder subsystem. **Recommendation:** delete the placeholder subsystem during S6 (workspace decomposition), which will restructure this file anyway.

## 13. Platform Space monolith watch (Part I)

Not a monolith yet: `PlatformSpaceDashboard.tsx` = 215 LOC, `policy.ts` = 183 LOC, render is a flat registry lookup (no growing switch/if-chain). **One structural risk:** section keys are authored in **three independent lists** — `PLATFORM_AREAS[*].sections` (16), `PLATFORM_WIDGET_REGISTRY` (16), `PLATFORM_SECTION_REGISTRY` (15) — and have **already drifted** (`sec_anomalies` present in two, absent from the section registry; benign only because widget-wins). This is the exact seam S6 should collapse: derive the section list + widget binding from one source. **Recommend addressing in S6, not now** (restructuring registries pre-S6 would be the redesign the gate forbids).

## 14. Production readiness (Part L)

| Outage / condition | Trust the dashboard? |
|---|---|
| Provider outage | ✅ connection-health + provider-health surface it; provider-unhealthy alerts |
| Scheduler outage | ⚠️ jobs show `overdue` **if you look**, but the alerter can't page (SPOF) — needs external uptime check |
| FX outage | ✅ freshness `stale` even on green job; resource-stale alerts |
| Price outage (vendor-gated) | ✅ honest `empty`/`unknown`, no false page (§11) |
| Manual maintenance | ✅ ledgered `trigger:"manual"`, audited, in-flight-locked |
| Large backlog | ✅ metrics are windowed reads; no unbounded compute |
| Empty deployment / first install | ✅ never-ran/idle/empty honest; no false pages; email skipped until configured |

**Verdict: PARTIAL** — production-trustworthy after the §11 fix, with one residual: the dispatcher is a single point of failure and the alerter cannot page on its own silence; an out-of-band uptime check on `/api/jobs/dispatch` is required before relying on push alerting in production. (Documented in the S5 report as deferred; restated here as the top production caveat.)

## 15. Follow-on readiness (Part M)

| Slice | Prereqs satisfied | Remaining blockers | Expected seam |
|---|---|---|---|
| **S6 Workspace decomposition** | 9 sections + widget registry live; render is a flat lookup; SpaceShell convergence done (SD-2E) | the three-list drift (§13) should be collapsed here; delete placeholder subsystem (§12) | register the Ops workspaces in `WORKSPACE_REGISTRY`; one section source-of-truth |
| **S7 Operational history** | JobRun/ApiUsageCounter/freshness are all read-time facts today | no dated rollup table exists (all current-window) | a `PlatformSnapshot`-idiom dated rollup job (rides the dispatcher) |
| **S8 Operational Perspectives** | doctrine sanctions non-financial Perspectives | **hard-gated on S7** (needs time-series); must NOT reuse the finance asOf/compareTo reducer | a non-finance temporal model over S7 rollups |
| **S9 Off-ledger convergence** | `runJob` + JobRun ledger exist | SWR-FX, Plaid webhook/connect-time, manual scripts write no JobRun | wrap the off-ledger paths in `runJob` or a lightweight emission |
| **S10 Cost & latency intelligence** | ApiUsageCounter volume + `estimateUnitSpendUsd` wired (dormant); provider-health has latencyMs | `UNIT_PRICES_USD` empty; per-provider latency is whole-job only | populate prices; per-provider latency emission |

**Consolidation that should precede/accompany S7:** the §3 shared JobRun-metric primitive (once history exists, both job-health and provider-health rollups should compute from one definition).

---

## Final verdict

```
OPS-5 internally coherent?        YES        (after the §11 false-red fix)
Single authority preserved?       PARTIAL    (one deliberate, documented JobRun-metric
                                              duplication: job-health vs provider-health, §3)
Operational monolith forming?     NO         (215/183 LOC, flat registry lookup;
                                              three-list section-key drift to collapse in S6)
Ready for S6?                     YES
Production-ready?                 PARTIAL    (trustworthy after §11; residual: dispatcher SPOF
                                              needs an external uptime check on /api/jobs/dispatch)
Critical fixes required before S6? NO         (the one critical fix is applied; the rest are
                                              documented follow-ons for S6/S7)
```

**Integration fixes committed:** the §11 `resource-stale` blocked-pipeline false-red fix (+ regression tests). No other code changed. Validation: tsc clean · eslint clean · unit **273/273** · alerts.test 52 checks. Not pushed. **S6 not started.**
