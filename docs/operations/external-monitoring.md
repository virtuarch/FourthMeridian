# External monitoring of `/api/health` (OBS-001 / OPS-002)

**Audience:** the owner / operator. **Status:** the route ships the signals; **registering the monitor is an OWNER action** (nothing in this repository can do it). **Last verified:** 2026-10-22 against `app/api/health/route.ts` and `app/api/health/scheduler-signals-core.ts` (remediation branch `remediation/e-observability`).

## 1. Why an external monitor is not optional

Every alert this platform can send is evaluated by a job (`evaluate-alerts`) that the dispatcher cron runs. If the cron stops — plan change, rotated `CRON_SECRET` (every tick becomes a 401), a broken dispatch route, a deploy that never fires it — **the platform cannot tell anyone**, because the thing that would tell you is the thing that stopped. Inside the product the only tell is the Alerts posture chip reading *"Unknown — evaluator silent"* (OBS-001 fix) and `dead` rows in the Jobs workspace, which someone has to be looking at.

The dead-man's switch therefore has to live outside: an uptime monitor that polls `GET /api/health` and alerts on the **content** of the `scheduler` block, not only on the HTTP status.

## 2. What the route returns

Unauthenticated, rate-limited 30 requests / minute / IP, `Cache-Control: no-store`.

```json
{
  "status": "ok",
  "db": "ok",
  "scheduler": {
    "lastDispatchAt": "2026-10-22T06:30:04.118Z",
    "lastAlertEvaluationAt": "2026-10-22T06:30:09.552Z",
    "lastBackstopCronAt": "2026-10-22T06:55:01.004Z",
    "overdueJobs": 0,
    "alertEvaluatorOverdue": false
  },
  "time": "2026-10-22T06:58:12.000Z"
}
```

| Field | Meaning | Source |
|---|---|---|
| `status` / `db` | `ok` when `SELECT 1` answered; otherwise HTTP **503** with `status: "degraded"`, `db: "error"`, `scheduler: null` | the database probe |
| `scheduler.lastDispatchAt` | newest start of any **registered** job — the dispatcher last executed something then. A wake with nothing due writes nothing, so this ages normally between executions (see §4) | `JobRun` ledger |
| `scheduler.lastAlertEvaluationAt` | newest **succeeded** `evaluate-alerts` run. Null if it never completed a cycle | `JobRun` ledger |
| `scheduler.lastBackstopCronAt` | newest run of the five-minute `resume-stale-imports` cron (its own `vercel.json` entry). It writes a row on **every** fire, so this proves Vercel cron is firing at all | `JobRun` ledger |
| `scheduler.overdueJobs` | registered jobs whose newest run is older than their resolved cadence + 2 h grace (the same test the Jobs workspace applies). Never-ran jobs are not counted | ledger + cadence policy |
| `scheduler.alertEvaluatorOverdue` | `true` when `lastAlertEvaluationAt` is null or older than the evaluator's cadence (default 6 h, operator-editable 1–168 h) + 2 h | ledger + cadence policy |
| `scheduler: null` on a 200 | the database answered but the ledger could not be read — treat as an alert, not as "no data" | — |

**Deliberately absent:** job names, error summaries, the alert mailbox, user counts and — since OPS-014 / OBS-010 — the commit SHA. The decision was to **drop the SHA outright** rather than gate it behind a secret; the deployment identity lives on every `JobRun` / `RefreshExecution` row and as Sentry's `release`.

**Rate-limit note (OBS-010):** the limiter fails open on a store error by design; that is safe here because the DB probe runs immediately after it. If the store is down because the database is down, the probe fails and the caller gets the 503 that is the right signal. Fail-open can never turn a dead database into a 200.

## 3. Registering a monitor (OWNER action)

Poll **every 5 minutes** from at least two regions. Alert on **any** of:

1. HTTP status ≠ 200 for 2 consecutive polls (DB down or route down).
2. `scheduler` is `null` on a 200 (ledger unreadable).
3. `scheduler.alertEvaluatorOverdue == true` (the alert evaluator is silent — nothing else will tell you).
4. `scheduler.lastBackstopCronAt` older than **20 minutes** (Vercel cron is not firing at all; the backstop fires every 5).
5. `scheduler.overdueJobs > 0` for 2 consecutive polls (a job's schedule has stopped; the Jobs workspace names it).

Optional, lower priority: `scheduler.lastDispatchAt` older than the longest registered cadence + grace (26 h at the defaults). Do not alert on it with a tight threshold — see §4.

### UptimeRobot (HTTP(s) + keyword)
- Monitor type: HTTP(s). URL: `https://<production host>/api/health`. Interval: 5 min.
- Add a second monitor of type **Keyword** on the same URL, keyword `"alertEvaluatorOverdue":false`, alert when keyword **does not exist**. Add a third keyword monitor for `"status":"ok"`.
- UptimeRobot cannot do time arithmetic on `lastBackstopCronAt`; cover (4) with Better Stack or Checkly, or accept (3) as the primary silence signal (the evaluator runs through the same cron).

### Better Stack (Uptime)
- Create a monitor: URL `https://<production host>/api/health`, check frequency 3–5 min, regions ≥ 2.
- Expected status 200. Add a **response-body assertion**: contains `"alertEvaluatorOverdue":false` and contains `"status":"ok"`.
- Add a second monitor with the body assertion **does not contain** `"scheduler":null`.

### Checkly (API check, recommended — can do time arithmetic)
```js
// Checkly API check → "Setup & teardown" → response assertion script
const body = JSON.parse(response.body);
const minutesAgo = (iso) => iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity;
expect(response.status).toBe(200);
expect(body.status).toBe("ok");
expect(body.scheduler).not.toBeNull();
expect(body.scheduler.alertEvaluatorOverdue).toBe(false);
expect(minutesAgo(body.scheduler.lastBackstopCronAt)).toBeLessThan(20);
expect(body.scheduler.overdueJobs).toBe(0);
```
Run every 5 minutes from two locations; alert after 2 failures; route alerts to a channel that is **not** the platform's own alert mailbox (if Resend is down, that mailbox is down with it).

### Verification steps (the owner, after registering)
1. `curl -s https://<host>/api/health | jq .` — confirm the five `scheduler` fields are present and `alertEvaluatorOverdue` is `false`. If it is `true` on first read, the evaluator has not succeeded within its cadence: see `docs/operations/runbooks/alerting-dead-evaluator.md` before trusting the monitor.
2. Force a true positive without touching production data: in the monitor, temporarily change the assertion to `alertEvaluatorOverdue == true` and confirm the alert fires and reaches the chosen channel; then restore it.
3. Record the monitor's URL and the alert channel in `STATUS.md` (owner-maintained).
4. Preview: crons never run on Preview, so `alertEvaluatorOverdue` is permanently `true` there. **Do not register a silence monitor on Preview**; an HTTP-200 monitor only.

## 4. Known limits (stated, not hidden)

- `lastDispatchAt` is the last **execution**, not the last **wake**: the dispatcher persists nothing on a wake with nothing due (OBS-012). `lastBackstopCronAt` is the closest honest proxy for "Vercel cron is firing"; a per-wake heartbeat row is Agent C's territory (`lib/jobs/dispatch.ts`) and is listed as an out-of-scope need in the remediation report.
- `overdueJobs` includes `sync-crypto-continuation`, which legitimately idles when no wallet work is deferred; a lone `1` that the Jobs workspace attributes to the continuation is not an incident. (Job health has the same quirk; the two agree by construction.)
- The route reads the production database. A monitor at 5 min from 2 regions is 24 requests/hour — well inside the 30/min/IP limit and negligible load (three indexed reads).
