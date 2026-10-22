# 09 — Reliability, Idempotency and Observability

Integration branch `remediation/beta-1`. Detail: `agent-reports/C-idempotency-data.md`, `E-observability-ops.md`, `D-ai-reliability.md`. Evidence: `04`.

## 1. Idempotency and concurrency (P1)

| Finding | Was (runtime) | Now | Commit |
|---|---|---|---|
| **IDEMP-001** CSV import | two concurrent identical submits ⇒ 6 rows → 12; PROCESSING batch un-rollbackable | file SHA-256 claimed BEFORE parsing under a partial unique `(account, fileSha256)` on live statuses ⇒ the second submit gets 409 with the winner's id; rolled-back/failed batches don't block re-import; `maxDuration 300`; 10 MB / 10,000 rows / 64 MB XLSX inflation caps; 200-row chunked writes; stalled PROCESSING batches rollbackable | `d2dd23a` |
| **IDEMP-002** account purge | two concurrent runs both executed the destructive tail (4 ACCOUNT_DELETED rows for 2 users) | claim-first `User.purgeStartedAt`; tail re-checks the schedule inside ONE transaction; e-mail once after commit; crash-reclaim after 30 min; sole-member SHARED Spaces deleted with their accounts (PRIV-001); soft references scrubbed (DB-002); table-census test | `b9fe5fd` |
| **IDEMP-003** job dispatch | concurrent wakes ran 11/11 jobs twice | partial unique "one running row per job"; aborts if the start-ledger write fails; stale runs finalised at the next wake; fallback routes at 300 s | `a4586b8` |
| **SEC-AI-003** AI retries | one 429'd turn ⇒ 18 provider calls | client `timeout 90 s, maxRetries 0`; one turn deadline (270 s) shared by every hop and the guidance call; ≤ 3 attempts and ≤ 60 s backoff per hop ⇒ 3 calls | `a926adf` |
| **IDEMP-009** AI spend ledger | fire-and-forget; errors swallowed | ledger write awaited before the response; failures captured and counted durably; a write-dead ledger fails the allowance CLOSED (`LEDGER_UNTRUSTED`) | `7e84b32` |

P2/P3 also closed: IDEMP-004 wallet lease in the sweep, IDEMP-005 fenced Plaid lock release (C + webhook path `6cd5cc2`), IDEMP-006 webhook duplicate suppression, IDEMP-007 resume backoff, IDEMP-008 per-account collision isolation (partial), IDEMP-010 last-owner/PERSONAL guards, IDEMP-011/013 conditional writes and P2002→409 (`d56d0f7`), OPS-001/010 budgeted oldest-first bank sweep with continuation.

## 2. Observability (P1)

| Finding | Was (runtime) | Now | Commit |
|---|---|---|---|
| **OBS-001** | a 30-day-stale evaluation read "Quiet / ok" | posture age-gated on the evaluator's resolved cadence + 2 h ("Unknown — evaluator silent") | `bf2da56` |
| **OBS-002** | a dead job dropped out of the alert | `dead` fires critical (same breach as overdue) | `37c179b` |
| **OBS-003** | `captured` e-mail counted delivered, suppressed 20 h | outside development `captured` ⇒ skipped, no suppression, `undelivered: NO_EMAIL_TRANSPORT`; widget shows delivery status | `534a611` |
| **OPS-002** | `/api/health` = `SELECT 1` | `scheduler { lastDispatchAt, lastAlertEvaluationAt, lastBackstopCronAt, overdueJobs, alertEvaluatorOverdue }` (no names, no e-mail, no commit SHA); reader on `systemDb` in `lib/jobs/` (`10010fd`) | `bf2da56` |
| **OBS-004** | no rule read sync incidents | `sync-incident-critical` rule, one breach per Item; `provider-unhealthy` per connection | E |

Also: OBS-008 delivery errors to Sentry; OBS-009 rate-limited `platform_access_denied` anomaly rows; OBS-011 no destination address in summaries; OBS-015 delivery circuit-broken when the ledger is write-dead; OPS-004 transport timeouts (Plaid 30 s, prices 10 s); UI-010 kill-switch panel independent of the policies read; UI-021 kill-switch route on its own rate-limit bucket (`40c7a5e`).
**OBS-012** (no dispatcher heartbeat): addressed by the existing `lastBackstopCronAt` (the five-minute cron writes a `JobRun` every fire, so a dead Vercel cron is visible within minutes) plus `overdueJobs` for a dispatcher-only failure; no extra row written.

## 3. Data lifecycle

Retention schedule (`docs/operations/data-retention.md`, daily `purge-trash` job): sessions 30 d after revocation, AI invocations 90 d, job runs 90 d, refresh executions 60 d, webhooks 30 d, resolved sync issues 90 d, usage counters 90 d, waitlist 180 d, Daily Briefs 90 d. Plaid token wiped after confirmed removal (PRIV-004). Trash hard-purge: owner decision.

## 4. Database safety

Migrations (all additive): import file hash + partial unique; `User.purgeStartedAt`; JobRun one-running partial unique; webhook body hash; DB-009 indexes; SEC-014 PlatformGrant read-only for `fm_app`; DB-004 RateLimit RLS (ENABLE + FORCE, own-bucket policy); DB-006 role statement timeouts (15 s / 5 s / 60 s; conditional, may need manual application on Supabase). Migrate-from-empty 134/134 on the integrated branch.

## 5. Operational gates (owner)

External monitor registration; `RESEND_API_KEY` + `PLATFORM_ALERTS_EMAIL` on Preview and Production; one proven alert delivery per environment; walk the dead-evaluator runbook on Preview; Sentry alert rules for `area:alert-delivery` / `area:operational-ledger`. Steps in `E-observability-ops.md` §2 and `11`.

## 6. Deferred

IDEMP-008 `(userId, institutionId)` partial unique (needs a data check on Production first), IDEMP-005 cursor CAS, IDEMP-012 snapshot versioning, OPS-011 queue, DB-005 pool sizing (measure), SEC-AI-001 fleet gate, PRIV-007 alert on unrevoked deletion (visible on the convergence surface today).
