# Background Jobs Runbook (OPS-4)

**Audience:** the operator. **Scope:** everything scheduled. **Last verified:** 2026-07-10 against the working tree (OPS-4 S0–S5).
**Re-verified 2026-10-22 (OPS-012 / TEST-014, pre-beta remediation) against `vercel.json`, `lib/jobs/registry.core.ts`, `lib/jobs/dispatch.ts`, `app/api/jobs/*/route.ts` and `lib/alerts/rules.ts`.** Two crons, 13 registered jobs, 300 s dispatch budget, 9 alert rules (8 live). Sections 7–9 replaced the stale "no alerting / 60 s / multi-slot cron" text.
**Companions:** `INCIDENT_RESPONSE_RUNBOOK.md` (incidents) · `docs/operations/KEY_ROTATION_RUNBOOK.md` (secrets) · `docs/operations/OPS4_PRODUCTION_READINESS_CHECKLIST.md` (pre-deploy walk).

## 1. Architecture in one paragraph

**P1 HUMAN OPERABILITY (2026-10-08) — WAKE ≠ EXECUTION.** One Vercel cron (`vercel.json`: `GET /api/jobs/dispatch`, CRON_SECRET bearer auth) now WAKES the dispatcher every 15 minutes (`*/15 * * * *`). It decides nothing. The dispatcher (`lib/jobs/dispatch.ts`) reads the newest `JobRun` per registered job and each job's resolved EXECUTION CADENCE (`lib/jobs/cadence-policy.core.ts`) and runs, through `runJob()`, every job that is DUE: never ran, or its newest run started at least (cadence − 5 min) ago. A job whose newest row is `running` and younger than six minutes is in flight and is never dispatched twice (the overlap guard). A continuation (`sync-crypto-continuation`) runs only after its primary's newest run reported deferred work, ≥ 15 min later, once per primary run. Every run still leaves an append-only `JobRun` row; jobs stay idempotent, sequential in registry order, and individually isolated.

**Where cadence comes from (one knob per job, never two):**

| Origin | Jobs | How an operator changes it |
|---|---|---|
| `REFRESH_POLICY` | `sync-banks` (BANK, default 24h, floor 6h), `sync-crypto` (WALLET, default 6h, floor 4h) | Policies workspace → Bank/Wallet refresh cadence (fresh PLATFORM_OPS CONTROL). The refresh policy IS the execution cadence. |
| `FOLLOWS_PRIMARY` | `sync-crypto-continuation` | Not editable; runs after deferred work. |
| `SETTING` / `DEFAULT` | `fetch-fx-rates` (default 24h, 6–168h), `fetch-security-prices` (24h, 6–168h), `evaluate-alerts` (6h, 1–168h) | Policies workspace → Execution cadence (fresh CONTROL **+ a structured reason**; audited as `JOB_CADENCE_CHANGED` / `JOB_CADENCE_RESET`). Stored as `PlatformSetting` `job_cadence_hours_<job>`; reset = delete the row. |
| `FIXED` | `process-deletions` (24h — the 7-day grace is legal semantics), `notification-cleanup`, `notification-retry`, `purge-trash`, `rate-limit-sweep` (24h) | Not editable. |

Floors and bounds are code-owned (`lib/jobs/registry.core.ts` `cadence`, `lib/platform/refresh-policy.core.ts` `REFRESH_CADENCE_FLOOR_HOURS`): no operator setting may ask the platform to call a provider more often than its floor. Changing a cadence runs nothing; the next wake applies it. The historical `hourUTC`/`minuteUTC` on each registry entry now derive only the DEFAULT cadence (daily anchors → 24h; `[0,6,12,18]` → 6h); the dispatcher no longer matches slots, so any wake may run any due job.

## 2. The scheduled jobs (expected execution)

| Default cadence (origin) | JobRun name | Body | What it does |
|---|---|---|---|
| 24h (BANK refresh policy) | `sync-banks` | `jobs/sync-banks.ts` | Plaid incremental transaction sync, every ACTIVE item of non-deactivated users; per-item isolation; failures classify to `PlaidItem.status` + user notification |
| 24h (editable 6–168h) | `fetch-fx-rates` | `jobs/fetch-fx-rates.ts` | Previous closed UTC day's missing FX quotes via provider failover; append-only archive; re-run is a no-op |
| 24h (fixed) | `process-deletions` | `jobs/process-deletions.ts` | Irreversible account purge for users past the grace window; resumable — "the cron IS the retry" |
| 24h (fixed) | `notification-cleanup` | `lib/notifications/cleanup.ts` | OPS-3 retention: auto-archive read, delete aged-archived, reap expired |
| 24h (fixed) | `notification-retry` | `jobs/retry-notifications.ts` | Retries failed email deliveries (see §4) — runs AFTER cleanup by registry order, never re-mails aged-out rows |
| 24h (fixed) | `purge-trash` | `jobs/purge-trash.ts` | Deletes goals trashed > 7 days |
| 24h (fixed) | `rate-limit-sweep` | `jobs/sweep-rate-limits.ts` | Deletes RateLimit window rows older than 24h |
| 24h (fixed) | `plaid-removal-retry` | `jobs/plaid-removal-retry.ts` | Re-attempts Plaid `/item/remove` for connections shown REVOKED whose removal Plaid never confirmed (each keeps billing) |
| 24h (fixed) | `product-event-retention` | `jobs/product-event-retention.ts` | Deletes the five product-event AuditLog actions older than 13 months; never security or operator rows |
| 24h (editable 6–168h) | `fetch-security-prices` | `jobs/fetch-security-prices.ts` | Daily historical security prices. **Vendor-gated** — a successful no-op until a price adapter is registered |
| 6h (WALLET refresh policy) | `sync-crypto` | `jobs/sync-crypto.ts` | Every-syncable-wallet sweep; regenerates wealth history for the wallets it synced. `sync-crypto-continuation` follows it when the work budget deferred wallets |
| 6h (editable 1–168h) | `evaluate-alerts` | `jobs/evaluate-alerts.ts` | Alert pass over the six authorities (§7). Sequenced last in registry order; 20h re-notify window ⇒ an ongoing breach mails about once a day. Its JobRun summary IS the alert history + suppression store. Delivery needs `PLATFORM_ALERTS_EMAIL` **and** `RESEND_API_KEY`; without either, the summary records `deliveryStatus: "skipped"` with `undelivered.reason` (`NO_DESTINATION` / `NO_EMAIL_TRANSPORT`) and the breach is retried next cycle, never suppressed |

**A normal day at the defaults ≈ 19 JobRun rows** from the 13 registered jobs (`sync-crypto` and `evaluate-alerts` four times each, the daily jobs once, the continuation only when work was deferred), plus `resume-stale-imports` on its own `*/5` cron. The dispatcher is woken 96 times a day; a wake with nothing due logs a no-op line — **and writes nothing**, which is why a dispatcher wake is not an observable fact anywhere in the product (see §9). The Jobs workspace shows each job's cadence (origin) · last run · next due.

## 3. Production verification (after any deploy touching jobs)

1. `GET /api/health` → `{status:"ok", db:"ok"}` (process + DB up).
2. Next morning (or `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/dispatch` to force a tick): check the ledger —
   `SELECT "jobName","status","startedAt","durationMs" FROM "JobRun" ORDER BY "startedAt" DESC LIMIT 10;`
3. `npx tsx scripts/check-job-health.ts` → all rows `healthy`, exit 0.
4. Vercel dashboard → Crons: the dispatch invocations show 200 (any 500 = at least one job failed that slot).

## 4. Retry behavior (what retries what)

- **Job-level:** there is no generic retry framework by ruling. Each job's next scheduled run is its retry; bodies are idempotent and resumable. The only bounded in-call retry is `withPlaidRetry` (2 attempts, transient Plaid errors only).
- **Notification email retries:** `notification-retry` consumes `NotificationDelivery` rows with `status="error"` and `attempts < 3` (1 create-time + 2 retries, fixed daily cadence). Claim-first increment prevents duplicate sends; rows whose notification is archived/expired/read (or recipient email unresolvable) are closed as `skipped`. **`error` at 3 attempts = the dead-letter state** — query it: `SELECT * FROM "NotificationDelivery" WHERE status='error' AND attempts>=3;`

## 5. Dead-job detection

`lib/jobs/health.ts` (read-only over JobRun): per job — `never-ran` (no rows) → `running` (fresh in-flight row) → `dead` (newest run older than 3 × its RESOLVED cadence) → `overdue` (older than cadence + 2h grace) → `failing` (3 consecutive failures; a `running` row older than 2h counts as a crashed run) → `healthy`. The cadence is the one the dispatcher executes by, so a cadence change moves the expectation with it. CLI: `npx tsx scripts/check-job-health.ts` (nonzero exit when unhealthy).

It IS now alerted (§7): `job-failing` on `failing`, `scheduler-silent` on `overdue` **and `dead`** (OBS-002 — `dead` used to drop out of the firing set). `/api/health` carries a non-sensitive `scheduler` block (`overdueJobs` count, last dispatch, last alert evaluation, last backstop cron) for an external monitor — see `docs/operations/external-monitoring.md`.

## 6. Failure handling & manual recovery

| Symptom | Diagnosis | Recovery |
|---|---|---|
| Dispatch tick 500 in Vercel | Ledger: `SELECT * FROM "JobRun" WHERE status='failed' ORDER BY "startedAt" DESC;` → `errorSummary` | Fix cause; next due wake self-heals. To re-run NOW: Platform Ops → Jobs → Run Now (audited), or curl a fallback route with the CRON_SECRET bearer (`/api/jobs/sync-banks`, `/api/jobs/fetch-fx-rates`, `/api/jobs/fetch-security-prices`, `/api/jobs/process-deletions`) — same bodies, same ledger names. `evaluate-alerts` has no fallback route: curl `/api/jobs/dispatch` (runs every due job) |
| All ticks 401 | CRON_SECRET unset/rotated wrong | See KEY_ROTATION_RUNBOOK §CRON_SECRET |
| No JobRun rows at all today | Cron not firing (vercel.json, plan tier, deploy) or dispatcher route broken | `docs/operations/runbooks/alerting-dead-evaluator.md` — the external monitor on `/api/health` should already have fired |
| One job `overdue`, siblings fine | Job deregistered, cadence edited, or (for `sync-crypto-continuation`) simply no deferred wallet work | `lib/jobs/registry.core.ts` diff history; Policies → Execution cadence |
| Job `failing` (3+ streak) | Broken dependency (Plaid creds, FX provider, DB) | `errorSummary` in ledger; FX gaps self-heal via `scripts/backfill-fx-rates.ts`; Plaid item health is per-item (`PlaidItem.status`) |
| Stale `running` row (>2h) | Process died before the completion write (documented S1 crash shape) | Nothing to clean — the row is forensic; the next scheduled run proceeds normally (idempotent bodies). Detector counts it as a failure |
| Duplicate email suspected | See S4 closeout's residual window | Check the delivery row's `attempts`/`providerMessageId`; bounded by the 3-attempt cap |
| Detach ONE job from the dispatcher | — | Add its own vercel.json cron pointing at its fallback route (revert lever, no code change); dispatcher keeps running the rest unless deregistered |
| Alerts chip reads "Unknown — evaluator silent" | `evaluate-alerts` has not succeeded within cadence + 2h (OBS-001) | `docs/operations/runbooks/alerting-dead-evaluator.md` |
| Alerts widget "Undelivered" | No transport / destination / provider error / ledger write failure | `docs/operations/runbooks/email-delivery-verification.md` |

## 7. Alerting (live)

`evaluate-alerts` evaluates 9 rules (`lib/alerts/rules.ts`; 8 live, `quota-low` dormant) over six authorities and emails `PLATFORM_ALERTS_EMAIL` via Resend:

| Rule | Fires on | Dedupe (20h re-notify) |
|---|---|---|
| `resource-stale` | FX / price archive stale (warn) or genuinely empty (critical) | per resource |
| `provider-unhealthy` | an unhealthy syncing connection; ERROR / NEEDS_REAUTH critical | **per connection** (OBS-004) |
| `job-failing` | 3 consecutive failed runs | per job |
| `scheduler-silent` | a job `overdue` or `dead` (critical) | per job |
| `ai-provider-failing` | quota refusals; every call failed; ≥3 failures | `:quota` / `:errors` |
| `ai-spend-fleet-high` | fleet estimated AI spend ≥ threshold; any unpriced model | per UTC day |
| `ai-spend-user-high` | one customer ≥ per-user threshold | per day + opaque ref |
| `sync-incident-critical` | an ACTIVE critical sync incident (unpersisted bank transactions, cursor held) | **per Plaid Item** (OBS-004) |
| `quota-low` | dormant — no authority yet | — |

Delivery truth (OBS-003/008/011/015): `sent` = the provider **accepted** the message (no delivery event is observed); `captured` counts only in development/test — elsewhere it is `skipped` + `undelivered.NO_EMAIL_TRANSPORT`, nothing suppressed; a provider `error` also goes to Sentry; the summary stores `destinationConfigured`, never the address; if the evaluator's own JobRun start row failed, delivery is circuit-broken (`LEDGER_WRITE_FAILED`) to prevent an alert storm.

**The alerting path cannot report its own death** — it runs inside the cron it watches. The dead-man's switch is external: `docs/operations/external-monitoring.md` (OWNER action).

## 8. The live cron schedule

`vercel.json` carries **two** cron entries:

| Path | Schedule | What it drives |
|---|---|---|
| `/api/jobs/dispatch` | `*/15 * * * *` | wakes the dispatcher; it runs every job DUE by ledger + cadence (§1). `maxDuration = 300` s |
| `/api/jobs/resume-stale-imports` | `*/5 * * * *` | first-run-import backstop, **outside the registry** (§9); `maxDuration = 300` s; writes a JobRun row on every fire, which `/api/health` exposes as `scheduler.lastBackstopCronAt` |

The per-job fallback routes (`sync-banks`, `fetch-fx-rates`, `fetch-security-prices`, `process-deletions`) keep `maxDuration = 60` s and are CRON_SECRET-guarded. Preview never runs crons.

**FX freshness does not depend on the cron.** `lib/money/server-context.ts` runs an opportunistic stale-while-revalidate refresh (`lib/money/fx-freshness.ts`): when yesterday's closed day is missing but older rows exist, it serves the cached rate and fires one best-effort background `fetchFxRates()` (≤1/30 min, never blocks). The scheduled `fetch-fx-rates` job stays authoritative.

## 9. Disclosed gaps and standing limits

**Dispatcher wakes are not recorded** (OBS-012). A wake with nothing due writes nothing, so "dispatcher dead" and "woken, nothing due" look the same until jobs go overdue. Proxies: `lastBackstopCronAt` proves the cron provider reaches the deployment; `alertEvaluatorOverdue` / `overdueJobs` catch a dead dispatcher within one cadence + 2h. A one-row-per-wake heartbeat in `lib/jobs/dispatch.ts` would close it (open, owned by the jobs workstream).

**`resume-stale-imports` has no health report.** It writes JobRun rows but is absent from `SCHEDULED_JOBS`, so `checkScheduledJobHealth` never classifies it and no rule covers it; Platform Ops discloses it as an *external cron*. Registering it is an open decision.

**Retention.** Only notifications, RateLimit rows and product-event audit rows are pruned; JobRun, RefreshExecution and AuditLog otherwise grow unbounded (DB-001).

**Transport timeouts** (OPS-004): Plaid 30 s (axios), CoinGecko/Tiingo 10 s, FX 15 s, wallet chains 10 s. No automatic circuit breaker; the AI kill switch is manual.
