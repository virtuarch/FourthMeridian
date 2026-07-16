# OPS-5 S2 — Rich Job Health

**Status:** IMPLEMENTED · validated green (tsc · eslint · unit 269/269) · committed, not pushed
**Date:** 2026-07-16 · branch `feature/v2.5-spaces-completion`
**Scope discipline:** presentation + operational maturity over the **existing** OPS-4 substrate. No scheduling redesign, no `JobRun` redesign, no new authority, zero writes, zero migrations.

---

## 0. The gap this closes

OPS-4 shipped the execution substrate: the `JobRun` ledger (one table, one writer — `runJob`), the dispatcher/registry, and `lib/jobs/health.ts` (the dead-job detector). But the detector only ever surfaced a **coarse** verdict: it selected `{ startedAt, status }`, classified into `healthy | never-ran | overdue | failing`, and dropped everything else. The ledger already stored `durationMs`, `completedAt`, `errorSummary`, and `trigger` — none of it reached an operator.

This slice turns "success/failure" into **operational health**, entirely by widening the read over data that already exists. Every brief field maps to `JobRun` or the registry — nothing is fabricated.

| Brief field | Where it comes from |
|---|---|
| Last Run | `JobRun.startedAt` of the newest row |
| Next Expected Run | **registry** `hourUTC`/`minuteUTC` → `nextExpectedRun()` (JobRun records only the past) |
| Cadence | registry `expectedEveryHours` (default 24) |
| Average Runtime | mean `JobRun.durationMs` over succeeded runs in the window |
| Last Runtime | `durationMs` of the most recent completed run |
| Failure Streak | leading failed runs (`consecutiveFailures`, unchanged logic) |
| Historical Success Rate | succeeded / (succeeded + failed) over the window |
| Last Failure | most recent `status:"failed"` row → `startedAt` + `errorSummary` |
| Manual Runs | count of `JobRun.trigger === "manual"` in the window |
| Health | `classifyJobHealth()` — now six states (below) |

### Health states

The four OPS-4 states plus two the brief adds, in precedence order:

- **never-ran** — no `JobRun` row for the name.
- **running** — newest row is `running` and fresh (< `STALE_RUNNING_HOURS`): a run is in flight *now*. (New. Strictly more informative than the `healthy` it used to fall through to.)
- **dead** — newest run older than `expectedEveryHours × DEAD_CADENCE_MULTIPLE` (×3): the schedule has been silently stopped for **many** cycles — the "escalate now" signal, distinct from a single late slot. (New.)
- **overdue** — newest run older than cadence + `GRACE_HOURS`: one missed window.
- **failing** — the last `FAILURE_STREAK_THRESHOLD` (3) runs all failed (a stale `running` row counts as a crash; a fresh one breaks the streak).
- **healthy** — none of the above.

A stale `running` row is **not** `running` — it is a crashed run and feeds the failure streak exactly as before.

---

## 1. Architecture — one authority, no duplication

The constraint was **"no duplicate health logic; reuse the existing `JobRun` authority."** The entire slice is an **in-place widening of the single detector** — `lib/jobs/health.ts` — not a second module that queries `jobRun`.

- `classifyJobHealth()` stays the **one** pure classifier. It now also derives the rich metrics in the **same single pass** over the **same window** — one `findMany` per job feeds both status and stats. No second query, no persisted counter, no health table.
- The streak/classification result is **unchanged** for the four pre-existing states except the two intentional additions. The window widened (`RUNS_EXAMINED 5 → HISTORY_EXAMINED 50`) so success-rate/averages are meaningful; the streak scan stops at the first non-failure, so a wider window can never change a *status* — only deepen the *stats*. (The redundant first clause of the streak loop was removed — `isFailureForStreak` already encodes the fresh-vs-stale `running` distinction.)
- `nextExpectedRun()` is a **schedule projection** (forward), deliberately distinct from `dispatch.dueJobs()` (backward "is it due at this tick?"). It reads the registry — the authority that already owns the schedule — because `JobRun` stores only what has happened.
- The route (`app/api/platform/platform-ops/job-health`) and widget (`OpsJobHealthWidget`) are pure serializer/presentation over the detector output. No health logic leaked into either. The read stays gated by `requirePlatformAccess("PLATFORM_OPS","READ")`; `JobRun.summary` is never forwarded (no user content / money crosses the boundary).

### The load-bearing rule: no fake metrics

Every metric is a value the ledger provided or `null`. Nulls render as an em-dash — the widget never invents a number. This is pinned in `job-health-format.test.ts` (null/negative → `—`).

---

## 2. Cross-slice boundaries (consume, don't recreate)

OPS-5 has three sibling slices touching this surface. They are **three distinct authorities**, and this slice consumes the other two rather than recreating them:

| Concern | Owner | S2's relationship |
|---|---|---|
| **Job execution health** (did it run / how is it doing) | **S2 — `lib/jobs/health.ts` over `JobRun`** | *this slice* |
| **Resource/content freshness** (is the underlying data fresh) | S1 — `lib/platform/resource-freshness.ts` over `MAX(archive.date)`, **explicitly not `JobRun`** | untouched; orthogonal authority |
| **Manual-run production** (Run Now / Dry Run) | S4 — `lib/platform/operations` → `runJob(…, {trigger:"manual"})` | **consumed:** the "Manual Runs" metric counts `JobRun.trigger === "manual"` |

The **"Manual Runs" metric is a producer/consumer seam with S4, not a conflict.** S4's `execute.ts` runs a manual command through `runJob(jobName, body, { trigger: "manual" })` — a first-class `JobRun` tagged `manual`. S2 does **not** build any Run-Now control (that write path is S4's); it simply counts what S4 produces. Before S4 lands a manual run the count reads `0` — an honest read of the ledger, not a fabricated figure. This is the "if another OPS-5 slice owns a concern, consume it" rule applied literally.

**No architectural conflict was found.** The one decision worth recording (above): "Next Expected Run" and "Manual Runs" are the two brief fields with no `JobRun` column, and both are sourced from an existing authority (registry schedule; S4's trigger) rather than a new mechanism.

---

## 3. Files

**Changed (mine — the only files staged):**
- `lib/jobs/health.ts` — six states + rich metrics + `nextExpectedRun()`, all in the one pure pass; widened read select + window.
- `app/api/platform/platform-ops/job-health/route.ts` — serializes the rich report; `counts` gains `running`/`dead`.
- `components/platform/widgets/OpsJobHealthWidget.tsx` — rebuilt: health counts + one expandable row per job, worst-first, each expanding to the full metric grid + last-failure detail.
- `components/platform/widgets/job-health-format.ts` — **new**, pure presentation helpers (duration/percent/cadence/relative-time, status severity/label/tone); extracted so they are DOM-free unit-testable.
- `lib/jobs/job-health.test.ts` — extended: running/dead states + precedence, every rich metric, `nextExpectedRun` projection (daily / intraday-array / wrap / half-hour / unknown).
- `components/platform/widgets/job-health-format.test.ts` — **new**, formatter + em-dash-on-null + severity-ordering guards.

**Deliberately NOT touched:** the scheduler, dispatcher, registry, `runJob`, the `JobRun` model/schema (no migration), `/api/health` (still job-state-free, per its frozen OPS-1 header), and every sibling slice's file.

---

## 4. Validation

- `tsc --noEmit` — clean.
- `eslint` (all six changed files) — clean. (`Date.now()` was moved out of the component render into the `relTime` util default, mirroring the `widget-kit.timeAgo` idiom, to satisfy `react-hooks/purity`.)
- `npm run test:unit` — **269/269** (268 prior + the new formatter test). The extended `job-health.test.ts` re-asserts the OPS-4 fences it already carried: read-only over `JobRun` (no writes / no second ledger), no alerting/queue/telemetry, single `classifyJobHealth` implementation, `/api/health` unextended, dispatcher never reads the health module.
- UI: browser verification is blocked on localhost for this repo (auth wall + MCP not authorized); tsc + eslint + the DOM-free formatter/detector unit tests are the sanctioned validation path.

## 5. Commit

Shared branch with concurrent sessions (S1/S4 agents' uncommitted work is present in the tree). Committed with an **explicit pathspec of only the six files above** — no `git commit -a`, nothing belonging to another slice staged. Not pushed.
