# Background Jobs Runbook (OPS-4)

**Audience:** the operator. **Scope:** everything scheduled. **Last verified:** 2026-07-10 against the working tree (OPS-4 S0–S5).
**⚠️ Current deployment is Vercel Hobby (free) tier — active cron is ONE run/day, not the full slot schedule. See §8 before relying on any 06:30/07:00/07:30 job firing automatically.**
**Companions:** `INCIDENT_RESPONSE_RUNBOOK.md` (incidents) · `docs/operations/KEY_ROTATION_RUNBOOK.md` (secrets) · `docs/operations/OPS4_PRODUCTION_READINESS_CHECKLIST.md` (pre-deploy walk).

## 1. Architecture in one paragraph

One Vercel cron (`vercel.json`: `GET /api/jobs/dispatch`, CRON_SECRET bearer auth — full slot schedule `0,30 6-7 * * *`, **but see §8: the active Hobby-tier schedule is `0 6 * * *`, one run/day**) fires the dispatcher (`lib/jobs/dispatch.ts`), which selects jobs due at the current half-hour UTC slot from the typed registry (`lib/jobs/registry.ts`) and runs each through `runJob()` (`lib/jobs/run.ts`) — every run leaves an append-only `JobRun` row (start write + exactly one completion write; counts-only summaries, never user content or monetary values). Jobs are idempotent, sequentially executed in registry order, and individually isolated: one failure never blocks a sibling. Slot matching (not exact-minute) tolerates late cron fire.

## 2. The scheduled jobs (expected daily execution)

| UTC slot | JobRun name | Body | What it does |
|---|---|---|---|
| 06:00 | `sync-banks` | `jobs/sync-banks.ts` | Plaid incremental transaction sync, every ACTIVE item of non-deactivated users; per-item isolation; failures classify to `PlaidItem.status` + user notification |
| 06:30 | `fetch-fx-rates` | `jobs/fetch-fx-rates.ts` | Previous closed UTC day's missing FX quotes via provider failover; append-only archive; re-run is a no-op |
| 07:00 | `process-deletions` | `jobs/process-deletions.ts` | Irreversible account purge for users past the grace window; resumable — "the cron IS the retry" |
| 07:30 | `notification-cleanup` | `lib/notifications/cleanup.ts` | OPS-3 retention: auto-archive read, delete aged-archived, reap expired |
| 07:30 | `notification-retry` | `jobs/retry-notifications.ts` | Retries failed email deliveries (see §4) — runs AFTER cleanup by registry order, never re-mails aged-out rows |
| 07:30 | `purge-trash` | `jobs/purge-trash.ts` | Deletes goals trashed > 7 days |
| 07:30 | `rate-limit-sweep` | `jobs/sweep-rate-limits.ts` | Deletes RateLimit window rows older than 24h |

**A normal day = 7 JobRun rows** (4 dispatcher ticks; 07:30 carries four jobs) — this is the *paid-tier* expectation. On the current **Hobby tier only the 06:00 tick fires**, so a normal day = 1 JobRun row (`sync-banks`); see §8 for what covers the rest. The dispatcher logs a no-op line for any tick with nothing due.

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

`lib/jobs/health.ts` (read-only over JobRun): per job — `never-ran` (no rows) → `overdue` (newest run older than `expectedEveryHours`(24) + 2h grace) → `failing` (3 consecutive failures; a `running` row older than 2h counts as a crashed run) → `healthy`. Run it: `npx tsx scripts/check-job-health.ts` (nonzero exit when unhealthy). It is NOT itself scheduled and sends nothing — detection only, by S5's fence. `/api/health` deliberately carries no job state (public endpoint).

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

## 8. Vercel Hobby (free) tier — active cron reality

The project currently deploys on the **Vercel Hobby (free) tier, which rejects any sub-daily cron at deploy time** (a schedule finer than once/day fails the build). So `vercel.json` carries a single daily entry — `GET /api/jobs/dispatch` at `0 6 * * *` — instead of the full `0,30 6-7 * * *`. The dispatcher, registry, per-job routes, and CRON_SECRET auth are all unchanged; only how often the cron fires is reduced. Vercel Hobby may also fire the tick anywhere within the scheduled hour.

**Covered automatically (fires daily via the 06:00 tick):**

- `sync-banks` (06:00 slot) — the one registry slot the daily tick lands on.

**Reachable but NOT automatically scheduled on Hobby** (the 06:30/07:00/07:30 slots never auto-fire). Each is still a deployed, CRON_SECRET-guarded route — run on demand with the bearer token:

- `fetch-fx-rates` (06:30) → `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/fetch-fx-rates` — but see FX note below; usually unnecessary.
- `process-deletions` (07:00) → `POST/GET /api/jobs/process-deletions` (bearer). Run when account-deletion grace windows are elapsing.
- `notification-cleanup` · `notification-retry` · `purge-trash` · `rate-limit-sweep` (07:30) → dispatched only when the dispatcher runs at the 07:30 slot. On Hobby, force them by curling `/api/jobs/dispatch` at ~07:30 UTC (bearer), or trigger their bodies via the dispatcher manually. These are maintenance/retention jobs — delay is tolerable, but don't assume they ran.

Because most slots don't auto-fire, `check-job-health` (§5) will report those jobs as `never-ran`/`overdue` on Hobby — **expected on this tier, not an incident.** Judge health from the manual-run ledger, not the schedule.

**FX freshness while cron-limited.** FX conversions do not depend on the 06:30 cron. `lib/money/server-context.ts` runs an opportunistic **stale-while-revalidate** refresh (`lib/money/fx-freshness.ts`): when a conversion is requested and the newest closed day (yesterday UTC) is missing from the archive but older rows exist, it serves the cached rate immediately and fires one best-effort background `fetchFxRates()` (in-process throttle: ≤1/30 min; never blocks the request; a cold/empty archive falls through to the existing bootstrap + RateMiss path). This keeps rates reasonably current without a frequent cron. The scheduled `fetch-fx-rates` job remains intact and authoritative for cron-capable environments.

**Upgrade path (restore sub-daily dispatch), in preference order:**

1. **Paid Vercel plan** — set `vercel.json` back to `0,30 6-7 * * *` (or finer). No code change; §1/§2 become literal again and this section reverts to documentation. Simplest path once off Hobby.
2. **External pinger** — any scheduler that can issue an authenticated HTTP GET (GitHub Actions `schedule:`, cron-job.org, an uptime monitor) hits `/api/jobs/dispatch` with the CRON_SECRET bearer at each half-hour slot (06:00/06:30/07:00/07:30 UTC). Keeps the free tier; moves the schedule off Vercel. Store CRON_SECRET as the runner's secret; never commit it.
3. **Platform Operations scheduler** — the eventual in-house PlatOps cadence layer (`docs/plans/platform-ops-roadmap.md`) owns scheduling directly, retiring the dependence on Vercel cron entirely. Longest-horizon option.
