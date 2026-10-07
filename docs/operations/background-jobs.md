# Background Jobs Runbook (OPS-4)

**Audience:** the operator. **Scope:** everything scheduled. **Last verified:** 2026-07-10 against the working tree (OPS-4 S0–S5).
**Verified 2026-07-25 against `vercel.json` and `lib/jobs/registry.ts` (OPS-2C-8).** The Hobby-tier warning that stood here is retired: the deployment is on a paid plan and the multi-slot cron is live. See §8.
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
| 24h (editable 6–168h) | `fetch-security-prices` | `jobs/fetch-security-prices.ts` | Daily historical security prices. **Vendor-gated** — a successful no-op until a price adapter is registered |
| 6h (WALLET refresh policy) | `sync-crypto` | `jobs/sync-crypto.ts` | Every-syncable-wallet sweep; regenerates wealth history for the wallets it synced. `sync-crypto-continuation` follows it when the work budget deferred wallets |
| 6h (editable 1–168h) | `evaluate-alerts` | `jobs/evaluate-alerts.ts` | Alert pass over job-health / connection-health / resource-freshness / **AI failures** (`lib/platform/ai/failures.ts`). Every :30 slot since 2026-10-07 (was 07:30 only — a 24h detection latency); sequenced last in each slot; 20h re-notify window ⇒ an ongoing breach mails about once a day. Its JobRun summary IS the alert history + suppression store. Delivery requires `PLATFORM_ALERTS_EMAIL` (production-required since 2026-10-07; unset ⇒ every breach records `skipped`) |

**A normal day at the defaults ≈ 17 JobRun rows** from the 11 registered jobs (`sync-crypto` and `evaluate-alerts` four times each, the daily jobs once, the continuation only when work was deferred), plus `resume-stale-imports` on its own `*/5` cron. The dispatcher is woken 96 times a day; a wake with nothing due logs a no-op line — **and writes nothing**, which is why a dispatcher wake is not an observable fact anywhere in the product (see §9). The Jobs workspace shows each job's cadence (origin) · last run · next due.

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

`lib/jobs/health.ts` (read-only over JobRun): per job — `never-ran` (no rows) → `overdue` (newest run older than its RESOLVED cadence + 2h grace — the same cadence the dispatcher executes by, so a cadence change moves the expectation with it) → `failing` (3 consecutive failures; a `running` row older than 2h counts as a crashed run) → `healthy`. Run it: `npx tsx scripts/check-job-health.ts` (nonzero exit when unhealthy). It is NOT itself scheduled and sends nothing — detection only, by S5's fence. `/api/health` deliberately carries no job state (public endpoint).

## 6. Failure handling & manual recovery

| Symptom | Diagnosis | Recovery |
|---|---|---|
| Dispatch tick 500 in Vercel | Ledger: `SELECT * FROM "JobRun" WHERE status='failed' ORDER BY "startedAt" DESC;` → `errorSummary` | Fix cause; next daily run self-heals. To re-run NOW: curl the job's own fallback route (`/api/jobs/sync-banks`, `/api/jobs/fetch-fx-rates`, `/api/jobs/process-deletions`) with the CRON_SECRET bearer — same bodies, same ledger names |
| All ticks 401 | CRON_SECRET unset/rotated wrong | See KEY_ROTATION_RUNBOOK §CRON_SECRET |
| No JobRun rows at all today | Cron not firing (vercel.json, plan tier, deploy) or dispatcher route broken | Vercel Crons dashboard; hit `/api/jobs/dispatch` manually; `check-job-health` will show every job `overdue` |
| One job `overdue`, siblings fine | Job deregistered or its slot edited | `lib/jobs/registry.ts` diff history |
| Job `failing` (3+ streak) | Broken dependency (Plaid creds, FX provider, DB) | `errorSummary` in ledger; FX gaps self-heal via `scripts/backfill-fx-rates.ts`; Plaid item health is per-item (`PlaidItem.status`) |
| Stale `running` row (>2h) | Process died before the completion write (documented S1 crash shape) | Nothing to clean — the row is forensic; the next scheduled run proceeds normally (idempotent bodies). Detector counts it as a failure |
| Duplicate email suspected | See S4 closeout's residual window | Check the delivery row's `attempts`/`providerMessageId`; bounded by the 3-attempt cap |
| Detach ONE job from the dispatcher | — | Add its own vercel.json cron pointing at its fallback route (revert lever, no code change); dispatcher keeps running the rest unless deregistered |

## 7. Standing limits (accepted, by ruling)

No JobRun retention sweep yet (~7 rows/day; revisit at PO1 rollups). No alerting — the operator runs `check-job-health` (email-on-absence is PO1 Phase 5 territory). Digests and snapshot cadence deferred with reasons (S3 closeout). The 60s `maxDuration` bounds each dispatch tick; if a slot's summed runtime ever approaches it, split the slot (ledger `durationMs` is the early-warning data).

## 8. The live cron schedule

`vercel.json` carries **two** cron entries:

| Path | Schedule | What it drives |
|---|---|---|
| `/api/jobs/dispatch` | `0,30 0,6,7,12,18 * * *` | the dispatcher — every registry slot the 10 registered jobs declare |
| `/api/jobs/resume-stale-imports` | `*/5 * * * *` | a first-run-import backstop, **outside `SCHEDULED_JOBS`** (see §9) |

The Hobby-tier limitation that constrained this to one daily tick is retired; the
multi-slot schedule is live and §1/§2 are literal. `vercel.json` must fire the dispatcher
at **every slot any registry entry declares** — a registry slot with no matching cron
entry never fires, silently. That coupling is checked by reading both files together;
nothing enforces it at build time.

**FX freshness does not depend on the cron.** FX conversions do not depend on the 06:30 cron. `lib/money/server-context.ts` runs an opportunistic **stale-while-revalidate** refresh (`lib/money/fx-freshness.ts`): when a conversion is requested and the newest closed day (yesterday UTC) is missing from the archive but older rows exist, it serves the cached rate immediately and fires one best-effort background `fetchFxRates()` (in-process throttle: ≤1/30 min; never blocks the request; a cold/empty archive falls through to the existing bootstrap + RateMiss path). This keeps rates current independently of cron cadence; the scheduled `fetch-fx-rates` job remains intact and authoritative.

## 9. Two disclosed gaps

**Dispatcher invocations are not recorded.** `dispatchDueJobs` logs a line and returns;
a slot with no due jobs writes nothing at all. A "tick" is therefore **not an observable
fact** anywhere in the product. The Scheduler surface reports *last recorded execution*
— a different, honest fact — and never claims a tick. A silent dispatcher is detected as
`overdue` by the dead-job detector (§5), not by tick observation. Closing this would mean
a new operational fact written by the dispatcher.

**`resume-stale-imports` has no health report.** It runs every five minutes on its own
cron entry and writes `JobRun` rows, but it is absent from `SCHEDULED_JOBS` — and
`checkScheduledJobHealth` iterates that registry. So the most frequent job on the
platform has **no health classification and no alert coverage**. Platform Operations
discloses it as an *external cron* rather than folding it in with registry jobs or
inventing a health state for it. Registering it is an open decision, not an oversight.

