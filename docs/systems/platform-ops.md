# Platform Ops

## Purpose

Platform Ops is Fourth Meridian's operating-the-product platform: a typed
background-job runtime plus the observability that answers "is the machine
running, and is the data it produces actually good?". It is deliberately
separate from customer tenancy — these are the operator's tools for running the
service itself, not a customer feature.

Two concerns live here:

1. **Execution** — a registry of scheduled jobs, a single dispatcher, an
   append-only run ledger, and one manual-operations path onto that same
   ledger.
2. **Observability** — three *distinct* health authorities (job execution,
   resource freshness, provider health) plus an alert engine that consumes
   them. The load-bearing design rule is that these authorities are never
   conflated: a green job is not proof of fresh data.

## Authority

- **Job execution health** — `lib/jobs/health.ts` (`checkScheduledJobHealth`,
  `classifyJobHealth`). The single dead-job detector and rich-metrics read
  model over the `JobRun` ledger. Answers "did each registered job run when it
  should, and is any silently broken?"
- **Resource freshness** — `lib/platform/resource-freshness.ts`
  (`checkResourceFreshness`, `classifyResourceFreshness`). Content-derived
  freshness (`MAX(date)` over the underlying archive), computed *only* from the
  data, never from `JobRun.status`. Answers "is the underlying resource
  actually fresh?"
- **Provider health** — `lib/platform/provider-health.ts`
  (`getProviderHealth`, `buildProviderHealth`, `deriveProviderTrust`). Treats
  each external provider (Plaid, Open Exchange Rates) as a first-class resource
  and *synthesizes* over the other authorities — it recomputes none of them.
- **Alert evaluation** — `lib/alerts/evaluate.ts` (`evaluateAlertRules`) +
  `lib/alerts/run.ts` (`evaluatePlatformAlerts`). Classifies breach signals
  over the three authorities' output; holds no health computation of its own.
- **Authorization** — `lib/platform/policy.ts` (`hasPlatformAccess`) is the pure
  decision; `lib/platform/authorize.ts` (`requirePlatformAccess`,
  `requireFreshPlatformAccess`) is the session-aware adapter. This axis is
  strictly orthogonal to customer Space membership.

## Inputs

- **The single dispatch cron** — `vercel.json` fires `POST /api/jobs/dispatch`
  at `0,30 0,6,7,12,18 * * *` (UTC half-hour slots). This is the only external
  trigger for scheduled work.
- **The job registry** — `SCHEDULED_JOBS` (`lib/jobs/registry.ts`): each entry
  names its daily fire slot(s), an optional `expectedEveryHours` cadence, and a
  dynamically-imported idempotent body.
- **Underlying content archives** — `FxRate`, `PriceObservation`,
  `PositionObservation` (read by freshness probes).
- **`ApiUsageCounter`** — per-provider call/token volume (written by
  `lib/usage/record.ts`), read for provider call counts.
- **Connection health** — `lib/connections/health.ts` (sync-provider recency),
  consumed by both provider health and alerting.
- **`PlatformSetting`** — key/value overrides (alert rule enable/disable via
  `alert_rule_enabled:<ruleId>`).
- **`PlatformGrant`** rows + the session user's role — the authz inputs.
- **Manual-operation requests** — `POST` bodies to the operations route.

## Outputs

- **`JobRun` rows** — the append-only execution ledger (see Persistence).
- **Read-model JSON** served by the authorized routes under
  `app/api/platform/platform-ops/`: `job-health`, `resource-freshness`,
  `provider-health`, `operations`, `alerts`, `api-usage`, `connection-health`,
  `rate-limits`, `env-status`.
- **Alert emails** — the `platform-alert` template sent to
  `env.PLATFORM_ALERTS_EMAIL` (OPS-1 `sendEmail`) on breach.
- **`AuditLog` rows** — every manual operation (execute and dry-run) is audited.
- **Platform Ops Space widgets** — rendered from the section registry in
  `PLATFORM_AREAS.PLATFORM_OPS.sections` (`lib/platform/policy.ts`).

## Canonical contracts

- `ScheduledJob` (`lib/jobs/registry.ts`) — one daily unit of work.
- `runJob(name, fn, { trigger })` (`lib/jobs/run.ts`) — THE only writer of
  `JobRun`. `trigger` ∈ `"cron" | "manual" | "script"`.
- `JobHealthReport` / `ScheduledJobsHealth` (`lib/jobs/health.ts`) — status
  (`healthy | never-ran | running | overdue | dead | failing`) plus rich
  metrics.
- `ResourceFreshnessReport` / `ResourceFreshnessDescriptor`
  (`lib/platform/resource-freshness.ts`) — states `fresh | stale | empty | idle`
  plus a `FreshnessTrust` roll-up.
- `ProviderHealthReport` / `ProviderSpec` (`lib/platform/provider-health.ts`) —
  `ProviderTrust` ∈ `OPERATIONAL | DEGRADED | STALE | FAILING | UNKNOWN`.
- `OperationCommand` / `runOperation` (`lib/platform/operations/`) — the
  future-safe command vocabulary (`run-now · refresh · retry · backfill ·
  dry-run · invalidate`) and its execution seam.
- `AlertRuleDefinition` / `AlertSignal` / `AlertRunSummary` (`lib/alerts/`).
- `PlatformGrantCtx` + `hasPlatformAccess(area, needed, grants)`
  (`lib/platform/policy.ts`).

## Persistence

- **`JobRun`** (`prisma/schema.prisma`) is the one execution store: `jobName`,
  `trigger`, `executionId`, `status`, `startedAt`, `completedAt`, `durationMs`,
  `summary` (JSON — counts/kinds/IDs only, never user content or money),
  `errorSummary` (truncated message, no stack). Append-only: `runJob` writes one
  start row and exactly one completion write.
- **Freshness, provider health, and job health create NO tables and perform NO
  writes** — every fact is computed read-time from data that already exists.
- **The alert store IS the `JobRun` ledger.** `evaluate-alerts` runs are
  `JobRun` rows whose `summary` (`AlertRunSummary`) records what fired; the next
  cycle reads recent summaries to drive suppression. No alert table exists.
- **`ApiUsageCounter`** — per `(provider, metric, unit, day)` counters.
- **`PlatformGrant`** — one row per `(userId, area)`; revocation is a status
  flip (`ACTIVE → REVOKED`) with provenance, never a delete.
- **`PlatformSetting`** — alert-rule overrides and other platform toggles.
- **`BetaAccessRequest`** — the Growth & Revenue beta queue (a sibling platform
  area, not Platform Ops proper).

## Consumers

- **The dispatcher** (`lib/jobs/dispatch.ts`) — selects due `SCHEDULED_JOBS` per
  slot and runs each through `runJob` with per-job isolation.
- **Manual Operations** (`lib/platform/operations/execute.ts`) — resolves a
  registered command's target body from `SCHEDULED_JOBS` and runs it through the
  *same* `runJob(trigger:"manual")` path.
- **Provider health** consumes job health (via a windowed `JobRun` read),
  resource freshness (for archive providers), connection health (for sync
  providers), and `ApiUsageCounter`.
- **The alert engine** consumes job health, resource freshness, and connection
  health; delivers via OPS-1 email.
- **Platform Ops routes + widgets** consume all the above read models behind
  `requirePlatformAccess`.

## Invariants

- **One execution path, one ledger.** `runJob` is the only code that writes
  `JobRun`; a manual run executes the byte-identical body the cron runs and is
  indistinguishable in the ledger except by `trigger`.
- **The false-green invariant.** Resource freshness is derived from content
  only. A `succeeded` job over a stale or empty archive still reads `stale` /
  `empty`, and the `JobRun` success is surfaced *beside* the content truth as an
  explicit "job success is not resource freshness" caveat, never used to derive
  the state. `fetch-fx-rates` returning `source:"none"` and vendor-gated
  `fetch-security-prices` are the concrete cases this catches.
- **Provider trust is worst-wins.** `deriveProviderTrust` returns the worse of
  the content axis and the execution axis; quota is honest-`null` because
  neither Plaid nor OXR exposes a pollable quota fact this app stores.
- **Authorities are never re-derived downstream.** Provider health imports
  freshness and connection health rather than recomputing staleness; the alert
  engine classifies over authority *output* and never queries a product table.
- **The authz axis is orthogonal.** Platform access is decided from
  `PlatformGrant` rows alone; `lib/platform/policy.ts` knows nothing about
  `SpaceMemberRole` (tripwired by `lib/platform-surface.test.ts`). `SYSTEM_ADMIN`
  is a break-glass bypass living in the adapter, not the pure policy. `WRITE`
  implies `READ`; only `ACTIVE` grants count.
- **In-flight lock without a lock table.** A manual run is refused when a
  non-stale `running` `JobRun` exists for the job, using the same staleness
  window (`STALE_RUNNING_HOURS`) the dead-job detector uses.
- **Ledger writes are best-effort.** A `JobRun` write failure is logged and
  swallowed — observability must never break the job it observes.
- **`never-ran` is not alertable.** It is an operator-decides state; only
  `overdue` (scheduler-silent) and `failing` job states fire.

### Platform-grant capability matrix

`PlatformArea × PlatformAccessLevel`, decided by `hasPlatformAccess`. Areas are
each backed by exactly one system-singleton Space (`Space.platformArea`); a
capability name like `PLATFORM_OPS_MANAGE` is derived display sugar for
`(PLATFORM_OPS, WRITE)`, never a stored primitive.

| Area | READ grants | WRITE grants |
| --- | --- | --- |
| `PLATFORM_OPS` | View job health, freshness, provider health, alerts, API usage, rate limits, env status | Invoke Manual Operations (Run Now / Dry Run) |
| `SECURITY_OPS` | View audit feed, auth posture, sessions, anomalies | (reserved for future security actions) |
| `GROWTH_REVENUE` | View signups/activation, beta-access queue | Approve/deny beta requests |
| `CUSTOMER_SUCCESS` | View operational sync-issue triage | (reserved) |

`SYSTEM_ADMIN` bypasses all of the above (break-glass) and is redirected to the
admin surface rather than the platform Space host.

## Known limitations

- **`quota-low` alert rule is dormant.** The vocabulary exists (`ALERT_RULES`)
  but `live: false` — there is no provider-quota authority anywhere; OXR's
  `GET /api/usage.json` is the documented, uncalled path to populate it.
- **Provider quota is always `null`.** By design (honest-null); the fields are
  structurally ready but unpopulated.
- **`manualRuns` metrics read `trigger === "manual"`.** Correct today, but only
  the operations route produces such rows; jobs never manually run report `0`.
- **`fetch-security-prices` is vendor-gated.** It is a successful no-op until a
  price adapter is registered; freshness marks its empty archive `blocked`
  (trust `unknown`) so alerting does not false-red.
- **Manual operation kinds `refresh / retry / backfill / invalidate` are
  reserved.** Only `run-now` and `dry-run` materialize into commands; each
  reserved kind carries its precise unblock reason.
- **Sub-daily jobs depend on the paid Vercel cron.** The multi-slot schedule is
  gated by the plan tier, not by code.

## Extension points

- **Add a job** — one `SCHEDULED_JOBS` entry (idempotent body, dynamic import),
  plus a `vercel.json` slot only if it needs a new fire time.
- **Add a freshness resource** — one `ResourceFreshnessDescriptor` with a
  `probe()`; the pure classifier already owns the semantics.
- **Add a provider** — one `ProviderSpec` naming its producing job, usage key,
  and which freshness authority feeds it.
- **Add a manual operation** — register a target/kind in
  `lib/platform/operations/registry.ts`; execution reuses `runJob`.
- **Add an alert rule** — one `ALERT_RULES` entry plus (for a live rule) one
  evaluator branch over an existing authority.
- **Add a platform area** — one `PlatformArea` enum value + one `PLATFORM_AREAS`
  metadata entry + re-run the idempotent seed.

## Why the architecture is this way

The whole design crystallized around one incident: the platform could report a
green FX job while the FX archive was cold, because job-execution success was
being read as data health. The fix was to make **separation of authorities**
structural — job health, content freshness, and provider health are three
independent read models, and downstream layers *consume* rather than recompute
them. Freshness derives health from `MAX(date)` alone and surfaces execution
facts only beside it, so a false-green becomes visible instead of invisible.

Everything else follows from wanting that separation to stay cheap and honest.
Health is computed read-time over facts that already exist, so there are no
counter tables to drift and every classifier is a pure function unit-testable
with an injected fake client (the house pattern shared across `health.ts`,
`resource-freshness.ts`, `provider-health.ts`, and the alert engine). The
`JobRun` ledger is reused as the alert store and the in-flight lock rather than
minting new tables, keeping the surface small. Manual operations route through
the single `runJob` path so an operator action and a cron tick are the same
execution with the same ledger evidence. And platform authorization is a
separate axis from customer Space membership because operating the product is
categorically not a tenant capability — conflating them would be a
confused-deputy risk, so the two never mix.
