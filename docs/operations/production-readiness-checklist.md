# OPS-4 Production Readiness Checklist

**Walk this before (and once after) the first production deploy carrying OPS-4, and after any change to jobs/scheduling.** Complements `RELEASE_CHECKLIST.md` (general) — this page is the background-jobs slice only. Verified procedures live in `docs/operations/BACKGROUND_JOBS_RUNBOOK.md`.

## 1. Environment variables

- [ ] `CRON_SECRET` set in production (boot-validated; without it every cron request 401s).
- [ ] `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `DATABASE_URL` set (boot-required everywhere).
- [ ] `RESEND_API_KEY`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` set (prod-required; email otherwise captures silently).
- [ ] Preview and production do NOT share secret values (Vercel env scopes — KEY_ROTATION_RUNBOOK ground rule).
- [ ] Deploy boots clean: `[instrumentation] validateEnv passed` in the boot log.

## 2. Migration & schema

- [ ] `prisma migrate deploy` applied through `20260707223000_ops4_s1_jobrun_ledger` (the only OPS-4 migration; S2–S6 added none).
- [ ] `JobRun` table exists; `prisma migrate status` clean.

## 3. Health verification

- [ ] `GET /api/health` → 200 `{status:"ok", db:"ok", commit:<sha>}` (and confirm it exposes NO job state — pinned by its test).
- [ ] External uptime monitor pointed at `/api/health` (OPS-1 S6 ops task — also covers the dispatcher's platform being up).

## 4. Scheduled jobs verification

- [ ] `vercel.json` deploys exactly ONE cron: `/api/jobs/dispatch` @ `0,30 6-7 * * *`; Vercel Crons dashboard shows it registered.
- [ ] Forced tick succeeds: `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/dispatch` → 200 (off-slot: `dispatched: []` no-op is correct).
- [ ] Wrong/missing bearer → 401 (all four job routes).
- [ ] After the first full day: **7 JobRun rows** across the 4 slots, all `succeeded` (query in runbook §3).
- [ ] Ledger `durationMs` for the 07:30 slot's four jobs sums comfortably under 60s.

## 5. Retry verification (notification outbox)

- [ ] `notification-retry` JobRun row present daily and `succeeded`.
- [ ] Any `NotificationDelivery` rows with `status='error'` show `attempts` progressing across days, capped at 3 (dead-letter query in runbook §4).
- [ ] No duplicate emails for one delivery row (spot-check `providerMessageId` on a retried row).

## 6. Dead-job verification

- [ ] `npx tsx scripts/check-job-health.ts` → every registered job `healthy`, exit 0.
- [ ] Negative test performed once: point the script at a copy/branch with a job name that has no rows → reports `never-ran`, exit 1.
- [ ] Operator cadence decided (run it manually each morning, or from any external runner) — it is deliberately NOT self-scheduled.

## 7. Notification verification (end-to-end)

- [ ] A real producer event (e.g. Space invite) creates the Notification row AND a `NotificationDelivery` row with `status='sent'` + `providerMessageId`.
- [ ] `notification-cleanup` ran (JobRun row) and retention behaves (no unread CRITICAL archived).
- [ ] Preference opt-out suppresses the email leg (row `skipped`), in-app row still created.

## 8. Key rotation readiness (S6)

- [ ] `docs/operations/KEY_ROTATION_RUNBOOK.md` read by the operator.
- [ ] Ciphertext audit clean: `npx tsx scripts/audit-ciphertext-versions.ts` → 100% v2, 0 invalid.
- [ ] ENCRYPTION_KEY rotation drill scheduled against a restored backup (the runbook's step 3 — the named tooling gap means the drill starts by writing the script; do this BEFORE any real exposure forces it).
- [ ] Backup restore tested within the current release cycle (RELEASE_CHECKLIST B9 lineage).
