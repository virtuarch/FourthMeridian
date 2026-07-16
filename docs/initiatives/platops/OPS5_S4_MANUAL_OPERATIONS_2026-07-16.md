# OPS-5 S4 — Manual Operations

**Status:** IMPLEMENTED · validated · committed (not pushed)
**Date:** 2026-07-16 · branch `feature/v2.5-spaces-completion`
**Slice:** OPS-5 (Platform Operations) S4 — the "Run Now" / manual operational controls slice of
`docs/initiatives/platops/PLATOPS_OBSERVABILITY_INVESTIGATION_2026-07-16.md` §5 / roadmap S4.

---

## 1. What shipped

A **future-safe command registry** for platform manual operations, and the smallest safe surface
that exercises it end-to-end: an operator with a **PLATFORM_OPS WRITE grant** can run selected
scheduled jobs **on demand** from the Platform Operations Space, through the **canonical** execution
path, fully observable.

- **`lib/platform/operations/registry.ts`** — the command registry. A complete six-kind operation
  vocabulary (`run-now · refresh · retry · backfill · dry-run · invalidate`) plus the concrete
  `(kind × target-job)` commands registered today. Pure data + pure lookups — no I/O.
- **`lib/platform/operations/execute.ts`** — the single manual-execution seam. Routes a command onto
  `runJob(trigger:"manual")` (mutating run) or builds a dry-run plan (no execution). Pure core with
  injected I/O (the `run.ts` / `health.ts` idiom) → unit-testable without a DB.
- **`app/api/platform/platform-ops/operations/route.ts`** — `GET` (registry + recent manual-run
  history, READ) and `POST` (invoke a command, **fresh WRITE** + rate-limit + audit).
- **`components/platform/widgets/OpsManualOperationsWidget.tsx`** — the **Manual Operations** panel:
  per-target Run Now / Dry Run buttons, a **safe confirmation** dialog for mutating runs, live
  status feedback, and the recent manual-run history (the audit trail). A new `ops_manual_operations`
  section on the existing single-Overview Platform Space.
- **`lib/audit-actions.ts`** — `PLATFORM_OPERATION_EXECUTED` / `PLATFORM_OPERATION_DRY_RUN`.
- Tests: `registry.test.ts` (22 checks), `execute.test.ts` (21 checks).

**No schema change, no migration.** Everything reuses existing tables.

---

## 2. How it honors the requirements

> **Never bypass canonical execution. Reuse runJob() / permissions / audit trail / JobRun.**

- A `run-now` command does **not** carry job logic. `resolveJobBody(targetJob)` returns the *exact*
  `run` closure from `SCHEDULED_JOBS` (`lib/jobs/registry.ts`), and `runOperation` runs it through
  `runJob(jobName, body, { trigger: "manual" })`. So a manual run executes the **byte-identical body**
  the dispatcher runs on a cron tick, and lands its own `JobRun` row in the one append-only ledger —
  visible in Job Health / freshness exactly like a cron run. **One execution path, one ledger.**
- `runJob` already accepted `trigger:"manual"` in its vocabulary (OPS-4 S1) — a manual run was always
  meant to be a first-class ledger citizen; this slice is the first caller.
- **Permissions:** `requireFreshPlatformAccess("PLATFORM_OPS","WRITE")` — the live-revocation gate the
  investigation §5 prescribes and Growth's Approve/Deny already uses. Reads use the READ variant.
- **Audit:** every invocation (mutating run *and* dry-run) writes an `AuditLog` row with
  `performedByAdminId` and operation-identity metadata — the platform WRITE-surface convention.
- **In-flight lock — reusing `JobRun`, not a new table:** a mutating run is refused if a **non-stale
  `running` `JobRun`** exists for the job (`isInFlight`, using the *same* `STALE_RUNNING_HOURS` window
  the dead-job detector uses). A double-click, or a manual run racing a cron tick, cannot double-run;
  a crashed run's stale corpse never locks the job forever.

> **Everything should remain observable.**

Mutating runs → a `JobRun` row (status/duration/summary/error) **and** an `AuditLog` row. Dry-runs →
an `AuditLog` row (no `JobRun`, because nothing executed — a dry-run must never look like a real run,
which would re-create the very false-green the incident was about). The panel renders the recent
manual-run history inline.

> **Command registry. No duplicated execution paths. Future operations register cleanly.**

The registry is a flat, typed table (the `SCHEDULED_JOBS` / `PLATFORM_AREAS` house idiom). Adding a
future operation is **one entry**: register a kind on a target (or add a target). The engine resolves
the canonical body by name — it never re-implements a job.

---

## 3. Design decisions (and why)

### 3.1 Full six-kind taxonomy, but only the safe kinds wired
`OPERATION_KINDS` documents all six kinds — the vocabulary is complete, so the registry is genuinely
future-safe. But only kinds with a **real canonical body and a safe profile today** are
`status:"active"` and materialize into commands: **`run-now`** and **`dry-run`**. The other four are
`status:"reserved"` with the precise reason they aren't wired and what unblocks them:

| Kind | Status | Rationale |
|---|---|---|
| `run-now` | active | Executes the canonical body via `runJob(trigger:"manual")`. |
| `dry-run` | active | Preflight only — plans, writes nothing. |
| `refresh` | reserved | Semantic specialization of `run-now` for idempotent fetch jobs — **served by `run-now`, not a second execution path**. Promote only if a job needs a genuinely different refresh body. |
| `retry` | reserved | Same canonical body as `run-now` for idempotent jobs. A dedicated retry awaits a job whose retry differs from a fresh run (resume-from-checkpoint). |
| `backfill` | reserved | Needs a bounded range parameter + a canonical range body (`scripts/backfill-fx-rates.ts` is the candidate). Deferred as heavier/parameterized by the investigation §9. |
| `invalidate` | reserved | No cache/freshness target owns an invalidation contract yet (destructive → WRITE + explicit confirm when it does). |

This is the honest expression of the investigation's "Run Now for FX first, keep destructive
automatic-only, defer backfill" — **reserving** kinds rather than shipping duplicate buttons that all
call the same body. Reserving is not a stub: the taxonomy, the register-cleanly seam, and the tests
that forbid a reserved kind from leaking into a command are all real.

### 3.2 Target selection (safety)
Only **idempotent, safe-to-re-run, non-destructive** job bodies are registered as targets —
`fetch-fx-rates`, `fetch-security-prices`, `sync-crypto` (the investigation §5 candidate set;
`fetch-fx-rates` is the incident's direct remedy). Everything else is listed in `EXCLUDED_TARGETS`
**with its reason** and ratcheted by a test:
- `sync-banks` — has its own per-item manual refresh with a 60-min cooldown; a fleet-wide sweep must
  respect those locks (out of this slice).
- `process-deletions`, `purge-trash` — **destructive; automatic-only** (investigation §5).
- `notification-cleanup`, `notification-retry`, `rate-limit-sweep` — low operator value.

A later hand adds a target consciously; it cannot expose a destructive job by reflex without tripping
`registry.test.ts`.

### 3.3 UI placement — attach, don't fork
The panel is a **new section on the existing single-Overview Platform Space** (`ops_manual_operations`
in `PLATFORM_AREAS` + `PLATFORM_WIDGET_REGISTRY`), rendered through the shared `SpaceShell`. This
respects the investigation §7 rules: **do not build a standalone ops dashboard**, and **do not**
register a new `WORKSPACE_REGISTRY` workspace (that is S6, gated on SD-3). Materialization rides the
existing `ensurePlatformSections` create-only backfill — no new bootstrap machinery.

---

## 4. Architecture / conflict check

Per the standing instruction to consume rather than recreate, and to stop on any architectural
conflict: **none was found.** OPS-4 (job ledger/registry/dispatch/health), the PlatOps Space, the
grant/audit stack, and SD-8 are all consumed, not redesigned.

- A **concurrent OPS-5 S1** session landed `ops_resource_freshness` (content-aware freshness) on the
  same Space during this work. That is an orthogonal concern (freshness of *data* vs. *running* a
  job); the two coexist as sibling sections. Shared files (`lib/platform/policy.ts`,
  `PlatformSpaceDashboard.tsx`) were edited additively and this commit uses an explicit pathspec so
  the two slices serialize cleanly.

The result is **simpler than the alternatives** (zero new schema; the in-flight lock is `JobRun`
itself), which meets the "commit only if architecture is simpler or materially improved" bar.

---

## 5. Validation

- `npx tsc --noEmit` — clean.
- `npx eslint` (all changed files) — clean.
- `npm run test:unit` — **271/271** passed, including the financial-doctrine oracle and the two new
  suites (`registry.test.ts`, `execute.test.ts`).

UI validated by tsc + eslint + source-scan tests (the project's convention; localhost is behind an
auth wall not reachable by the browser harness). No live external API calls were made.

---

## 6. Files

**New**
- `lib/platform/operations/registry.ts`
- `lib/platform/operations/execute.ts`
- `lib/platform/operations/registry.test.ts`
- `lib/platform/operations/execute.test.ts`
- `app/api/platform/platform-ops/operations/route.ts`
- `components/platform/widgets/OpsManualOperationsWidget.tsx`

**Edited (additive)**
- `lib/audit-actions.ts` — two operation actions.
- `lib/platform/policy.ts` — `ops_manual_operations` section (order 6).
- `components/platform/PlatformSpaceDashboard.tsx` — widget import + registry + section note.

---

## 7. Follow-ups (out of this slice, register cleanly later)

- **Backfill** — wire `scripts/backfill-fx-rates.ts` as a bounded, range-parameterized canonical body.
- **Invalidate** — once a cache/freshness marker owns an invalidation contract.
- **S6** — when Platform converges onto `WORKSPACE_REGISTRY` (SD-3), the panel can graduate from a
  card to a dedicated "Operations" workspace; the registry and engine are unchanged by that move.
- **Bootstrap-if-empty FX** variant (investigation §5) — a `run-now` that also seeds a cold archive;
  belongs with S1's freshness work, not here.
