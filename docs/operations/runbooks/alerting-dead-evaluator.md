# Runbook — the alert evaluator (or the whole scheduler) has gone silent

**Trigger:** any of
- the external monitor on `GET /api/health` fires on `scheduler.alertEvaluatorOverdue == true`, `scheduler.lastBackstopCronAt` older than 20 min, `scheduler.overdueJobs > 0`, or `scheduler: null`;
- Platform Ops → Overview → Alerts chip reads **"Unknown — evaluator silent"**;
- Jobs workspace shows `evaluate-alerts` (or every job) `overdue` / `dead`.

**Why it matters:** every platform alert is sent by `evaluate-alerts`, which runs inside the dispatcher cron. While it is silent **no alert of any kind will reach you** — treat this as a P1 even if nothing else looks wrong.

**Verified against:** `vercel.json`, `app/api/jobs/dispatch/route.ts`, `app/api/health/route.ts` (2026-10-22).

## 1. Read the health block (1 min)

```bash
curl -s https://<host>/api/health | jq .
```

| What you see | Most likely cause | Go to |
|---|---|---|
| HTTP 503, `db: "error"` | Database unreachable — everything is down, the scheduler included | `docs/operations/incident-response.md` (database) |
| `scheduler: null` on a 200 | DB answers `SELECT 1` but the JobRun ledger cannot be read (permissions / RLS / schema drift) | §4 |
| `lastBackstopCronAt` stale (> 20 min) **and** `lastDispatchAt` stale | Vercel cron is not invoking the deployment at all | §2 |
| `lastBackstopCronAt` fresh, `lastDispatchAt` / `lastAlertEvaluationAt` stale | Cron fires, but the dispatcher route fails (401 = CRON_SECRET, 500 = a job/route error) | §3 |
| `lastDispatchAt` fresh, `alertEvaluatorOverdue: true` | Dispatcher runs other jobs; `evaluate-alerts` fails or is never due | §5 |

## 2. Vercel cron not firing

1. Vercel → Project → Settings → **Cron Jobs**: both entries present (`/api/jobs/dispatch` `*/15`, `/api/jobs/resume-stale-imports` `*/5`) and enabled. Cron jobs run **only on the Production deployment**; a promoted rollback without `vercel.json` drops them.
2. Vercel → Logs, filter `/api/jobs/`: are invocations arriving at all? (`vercel logs <prod-url> --no-branch` from the CLI.)
3. Plan / billing: a downgraded plan can silently disable sub-daily crons.
4. Redeploy the current production commit if the cron list is empty; confirm the next `*/5` tick lands within 5 minutes by re-reading `lastBackstopCronAt`.

## 3. Dispatcher route failing

1. Force one dispatch with the cron secret (never paste the secret into a ticket or chat):
   ```bash
   curl -s -o /dev/stderr -w "%{http_code}\n" -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/dispatch
   ```
   - **401** → `CRON_SECRET` on Vercel differs from what Vercel Cron sends (rotated in one place only). Follow `docs/operations/key-rotation.md` § CRON_SECRET: set the new value in Vercel env (Production), redeploy, re-run the curl.
   - **500** → at least one job failed this wake; the body lists `dispatched[].error`. Siblings still ran. Read the ledger: `SELECT "jobName","status","errorSummary","startedAt" FROM "JobRun" ORDER BY "startedAt" DESC LIMIT 20;`
   - **200 with `dispatched: []`** → nothing was due. If `evaluate-alerts` is overdue yet not due, its cadence setting is wrong (Policies → Execution cadence) — or the start-row write is failing (§4).
2. After a 200 that ran `evaluate-alerts`, `lastAlertEvaluationAt` must move within a minute.

## 4. Ledger unreadable or write-dead

A JobRun write failure is swallowed by design and reported to Sentry (`area: operational-ledger`, tag `phase: start`, `schema_drift: true` for P2021/P2022). Check Sentry first. The classic cause is a deploy that shipped code ahead of its migration: run `npx prisma migrate status` against the target database (read-only) and apply the pending migration through the normal deploy procedure. While the start row cannot be written, `evaluate-alerts` deliberately sends **nothing** (OBS-015 circuit breaker; its summary would say `LEDGER_WRITE_FAILED` if it could be written).

## 5. Evaluator runs but fails

- Jobs workspace → `evaluate-alerts` → last failure summary; or Run Now (fresh WRITE, audited) to reproduce.
- A succeeded run that delivered nothing is not this runbook — see `email-delivery-verification.md`.

## 6. Close-out

1. `curl …/api/health`: `alertEvaluatorOverdue: false`, `overdueJobs: 0`, `lastBackstopCronAt` < 5 min.
2. Overview Alerts chip shows a real verdict (Quiet / Firing), not "evaluator silent".
3. If the outage exceeded the 20 h re-notify window, expect a fresh batch of alert emails on the first good run — that is the backlog, not a new incident.
4. Record the incident (cause, duration, detection path) in `STATUS.md`. If the external monitor did NOT fire, fix the monitor first.
