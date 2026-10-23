# Agent C — Idempotency, Data Reliability, Jobs, Schema

Branch `remediation/c-idempotency` · worktree `FourthMeridian-remediation/c` · base `cde8fa0` · 19 local commits, **not pushed, not merged**. No live database was touched; every database step ran on a throwaway `postgres:16` container (`rem-c-pg`, removed with `-v`).

## Verification (final, on the committed HEAD `eb34c4a`)

| Gate | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | clean (0 errors) |
| `npm run lint` | 0 errors, 19 warnings (all pre-existing; none in an Agent C file) |
| `prisma migrate deploy` from EMPTY (fresh container) | 134/134 applied (127 at `cde8fa0` + 7 new) |
| `prisma db seed` (CI `ENCRYPTION_KEY`) | passed |
| `npm run audit:ci` | **25/25 REQUIRED passed** |
| `RLS_TARGET_URL=$DATABASE_URL npm run rls:accept` | **34/34** |
| `npm run rls:accept:app` | **98/98** |
| `npm run rls:accept:allowance` (DB-004 touches `RateLimit`) | **15/15** |
| Tests | Each finding's test files and every neighbouring source-pin test, run individually (`npx tsx --require ./scripts/lib/server-only-preload.cjs <file>`). The full `test:unit` was NOT run, per the orchestrator: parallel full runs caused memory-pressure kills. |

Interim issues found and fixed by these gates:
- `audit-db-authority` flagged an implicit owner call in the webhook health default → fixed in `7cad17e`.
- `rls:accept` #17 (every RLS table FORCEd) failed 33/34 on the first DB-004 migration → fixed in `eb34c4a`.

## Migrations (all additive / expand-only; no table or column dropped)

| Migration | SQL summary | Finding |
|---|---|---|
| `20261022000000_user_purge_claim` | `ALTER TABLE "User" ADD COLUMN "purgeStartedAt" TIMESTAMP(3)` | IDEMP-002 |
| `20261022000100_import_batch_file_sha256` | `ADD COLUMN "fileSha256" TEXT`; `CREATE UNIQUE INDEX "ImportBatch_account_file_live_key" ON "ImportBatch"("financialAccountId","fileSha256") WHERE "fileSha256" IS NOT NULL AND "status" IN ('PENDING','PROCESSING','COMPLETED','COMPLETED_WITH_ERRORS')` | IDEMP-001 |
| `20261022000200_job_run_one_running_per_job` | Finalise stale `running` rows (older than 6 min, plus duplicates per job, keeping the newest) as `failed`/`stale`; `CREATE UNIQUE INDEX "JobRun_one_running_per_job" ON "JobRun"("jobName") WHERE "status" = 'running'` | IDEMP-003 |
| `20261022000300_plaid_item_resume_backoff` | `ADD COLUMN "syncResumeAttempts" INTEGER NOT NULL DEFAULT 0`, `ADD COLUMN "syncResumeNextAt" TIMESTAMP(3)` on `PlaidItem` | IDEMP-007 |
| `20261022000400_db009_operational_indexes` | 4 indexes: `PlaidItem(syncIncompleteAt)`, `SyncIssue(plaidItemId,resolved)`, `SpaceGoal(deletedAt)`, `UserSession(revokedAt)` | DB-009 |
| `20261022000500_sec014_platform_grant_read_only` | Conditional `REVOKE INSERT, UPDATE, DELETE ON "PlatformGrant" FROM fm_app`; `DROP POLICY IF EXISTS fm_app_ins/upd/del` (SELECT kept) | SEC-014 |
| `20261022000600_db004_rate_limit_rls` | `ENABLE` + `FORCE ROW LEVEL SECURITY` on `RateLimit`; policies: `fm_app_own_user_buckets` (key `user:%` whose text after the last `:` = `current_fm_user_id()`, USING + WITH CHECK), `fm_auth_all`, `fm_system_all` (each conditional on the role) | DB-004 |
| `20261022000700_db006_role_statement_timeouts` | `ALTER ROLE fm_app/fm_auth/fm_system SET statement_timeout = 15s/5s/60s`, each conditional on `pg_roles`, with `EXCEPTION WHEN insufficient_privilege → NOTICE` | DB-006 |

Each partial unique index is invisible to Prisma and documented in a schema comment. `prisma migrate diff` (migrations → schema) is clean except one **pre-existing** drift that belongs to DB-008 and was not touched: `ProviderCapabilityObservation_provider_capabilityKey_observedAt` index name.

## Per finding

### IDEMP-002 · PRIV-001 · DB-002 · DB-011 · TEST-009 — `b9fe5fd` — DONE
- **Root cause:** `purgeUser` validated "due" once with a plain read, then ran about 15 independent writes. Two workers both ran the tail. A cancel between selection and tail was lost. Only PERSONAL Spaces were deleted, and soft references survived.
- **Change** (`lib/account-deletion/purge.ts`, `jobs/process-deletions.ts`):
  - **Claim first:** `updateMany where {id, deletionScheduledAt ≤ now, purgeStartedAt null OR ≤ now−30 min}`, requiring count === 1. A stale claim is re-claimable, which gives a crash-safe retry.
  - **One transaction for the destructive tail**, fenced by re-checking `deletionScheduledAt ≤ now AND purgeStartedAt = token` inside it. A cancel at login clears the schedule, so the fence matches nothing and nothing irreversible happens.
  - **Side effects happen once:** the deletion e-mail is sent after commit, only by the committing worker; `itemRemove` runs once (confirmed items flip to REVOKED); a HOLD releases the claim.
  - **PRIV-001 / DB-011:** non-PERSONAL, non-platform Spaces whose only ACTIVE member is the user are deleted together with their Space-owned accounts.
  - **DB-002 scrub:** `AiInvocation.userId` and `InvestmentEvent.createdByUserId` set to null; `BetaAccessRequest(+Event)` rows deleted by e-mail (case-insensitive); `MerchantMergeDecision.decidedByUserId` and `PlatformSetting.updatedById` set to null; user-scoped `MerchantRule` rows deleted.
  - **Audit:** exactly one `ACCOUNT_DELETED` row, hashed e-mail only.
  - `process-deletions` skips users under a live claim.
- **Tests:**
  - `lib/account-deletion/purge.test.ts`, over an in-memory fake that evaluates the where-clauses and rolls back transactions. Proves:
    - two concurrent workers produce one tail, one audit row, one e-mail and one `itemRemove`;
    - a cancel after the claim leaves everything intact;
    - after a crash mid-tail, the rollback leaves everything intact, the claim blocks a live retry, a stale claim completes the purge, and `itemRemove` is not repeated;
    - sole-member SHARED Spaces and their accounts go, while shared-with-others, left-by-user and platform Spaces survive;
    - the scrub, and HOLD releasing the claim.
  - `purge-census.test.ts` (TEST-009, deletion half) parses `schema.prisma` and finds 59 user-keyed columns: 17 cascade, 9 set-null, 10 explicit, 8 documented-retained, 15 Space-cascade. An unclassified column fails the build.
  - The wiring test's pins were updated to `tx.user.delete`.
- **Residual:** `AuditLog` rows that carry `userId` are anonymised by SetNull, not deleted (forensic retention, by design). Actor-identity columns on other people's records are retained and documented in the census.

### IDEMP-001 · SEC-007 · OPS-007 — `d2dd23a` — DONE
- **Root cause:** fingerprint dedupe was a read, not a constraint. There was no idempotency key, no `maxDuration`, no caps, and a PROCESSING batch was excluded from rollback.
- **Change:**
  - **Claim before parse:** the route hashes the bytes (`sha256`) and creates the batch PENDING before parsing. A P2002 returns **409 `duplicate-import`** with the existing batch id.
  - **Index predicate decision:** PENDING / PROCESSING / COMPLETED / COMPLETED_WITH_ERRORS hold the slot. ROLLED_BACK and FAILED free it, so a re-import after a rollback or failure is legitimate.
  - **Limits:** `maxDuration = 300`. 10 MB byte cap (413, checked before reading). 10,000-row cap (the batch is marked FAILED so the slot frees). XLSX inflated-size cap of 64 MB / 512 parts, read from the zip central directory before ExcelJS loads (`lib/imports/zip-bounds.ts`).
  - **Chunked writes:** chunks of 200 rows per tenant transaction; a failing chunk re-runs row by row with the original per-row phases.
  - **Stalled-batch rollback:** a PENDING/PROCESSING batch whose `updatedAt` is older than budget + 60 s becomes rollback-eligible (`rollbackClaimWhere`).
- **Tests:**
  - `lib/imports/claim.test.ts`: concurrent claim gives one batch; the loser gets the winner's id; rollback/failed frees the slot; stalled-rollback predicate; caps; source order hash → claim → parse; the migration predicate mirrors `IMPORT_LIVE_STATUSES`.
  - `lib/imports/zip-bounds.test.ts`: zip bomb, zip64, part count; a real ExcelJS workbook still imports.
  - The `authorize.authority` pin was updated to the phase-runner literal.
- **Residual:**
  - A chunk's rows share one transaction, so a chunk-level failure costs one extra pass.
  - The `importRow` fingerprint read is still per row (dedupe *within* a file stays sequential by design).
  - **Not run:** an end-to-end HTTP double-submit through the route. Proven instead at the DB constraint (evidence below) and in the unit test.

### IDEMP-003 · OPS-005 · OPS-006 — `a4586b8` — DONE
- **Root cause:** dispatch did check-then-insert with no row-level claim; the fallback routes bypassed it; there was no reaper; a failed start write still ran the job unguarded.
- **Change:**
  - The partial unique index makes the existing start row the claim: P2002 → `JobAlreadyRunningError`, and the body never runs.
  - Any other start-write failure aborts the run (`JobLedgerUnavailableError`).
  - `finalizeStaleRuns`: `running` rows older than 6 min become `failed`/`stale`. `runJob` does this for its own name; the dispatcher does it at wake start and treats the finalised jobs as due (`STALE_RUN_FINALISED`).
  - The dispatcher reports a refusal as IN_FLIGHT, not as a failure.
  - Fallback route `maxDuration` changed from 60 to 300.
- **Index vs advisory lock:** I chose the index.
  - It is durable and visible in the ledger operators already read.
  - Under the Supabase transaction pooler, session advisory locks are unsafe.
  - Prisma's single `create` is not a transaction that an xact lock could ride on.
- **Tests:**
  - `run.test.ts`: concurrent same-name runs give one body and one refusal; a stale row is finalised and the job runs; a fresh row still refuses; a ledger outage aborts.
  - `dispatch.test.ts`: the wake finalises and dispatches; a fresh running row stays IN_FLIGHT; a refusal is not counted as a failure.
- **Residual:** a job that genuinely runs longer than 6 min (the in-flight window) can be finalised as stale while still running, and a second wake could start it. That is the same window the dispatcher already used. `sync-banks` is now budgeted at 180 s.

### OPS-001 · OPS-010 — `923aec8` — DONE
- **Change** (`jobs/sync-banks.ts`):
  - **Order:** never-synced Items first, then `lastSyncedAt` ascending. Items synced in the last 2 h are skipped as fresh.
  - **Budget:** 180 s; an Item is only started while ≥ 45 s remain. The rest are reported as `deferred`; per-Item slowness over 60 s is reported as `slowItems`.
  - **Continuation:** registry fact `selfContinues` on sync-banks. The dispatcher re-runs the job 15 min after a succeeded run that reported `deferred > 0` (`SELF_CONTINUATION`). No new registry entry, because the job count is pinned by the unowned `lib/platform/policies/job-cadence.test.ts`.
- **Tests:** `jobs/sync-banks-budget.test.ts` with a fake clock. Proves the order, that 10 × 30 s Items give 5 run / 5 deferred, slow-item reporting, admission DENY deferring everything, the continuation's due/not-due cases, and that sync-crypto is unaffected.
- **Residual:** a running Plaid call is not interrupted, because it holds the lease and writes pages. The transport timeout is OPS-004 (Agent E, `lib/plaid/client.ts`).

### IDEMP-004 — `4408e7f` — DONE
- The scheduled wallet sweep claims the Connection wallet lease, the same one the manual route and Refresh All take, and releases it in `finally`. A held wallet is skipped and counted (`skippedLocked`).
- The manual route keeps the attempt stamp, the sync and the finaliser inside the try whose `finally` releases the lease.
- **Tests:** `lib/crypto/wallet-refresh-lock.test.ts`. The existing `wallet-refresh` / `initial-connection` / `refresh-routes` pins still pass.

### IDEMP-005 (fence only) — `7a09b26` — DONE
- `claimPlaidItemSyncLockAt` returns the fencing token. `withPlaidItemSyncLock` releases conditionally on `syncLockedAt = token` and warns when its lease was taken over.
- **Tests:** `lib/plaid/sync-lock-fence.test.ts`.
- **Residual:** `lib/plaid/webhook-sync.ts` (not owned) still uses the unfenced claim/release primitives, which keep their old signature. Cursor CAS is not addressed.

### IDEMP-006 · FIN-007 — `5e59c89`, `7cad17e` — DONE
- **IDEMP-006:**
  - A verified sync trigger whose identical body (`sha256`) arrived within 10 min is recorded as `DUPLICATE_SUPPRESSED` and starts no pipeline.
  - The store is the existing `RateLimit` table: key `plaid-webhook:<sha>`, 10-min buckets, atomic upsert, current + previous bucket checked, swept by `sweep-rate-limits`. It fails open.
  - **TTL, not a permanent unique:** trigger bodies carry no timestamp, so two genuine notifications can be byte-identical.
  - No schema change and no route change; the writer's allowlist is pinned by an unowned test.
- **FIN-007:**
  - ITEM/ERROR with `ITEM_LOGIN_REQUIRED` | `INVALID_ACCESS_TOKEN` → NEEDS_REAUTH.
  - `USER_PERMISSION_REVOKED` | `USER_ACCOUNT_REVOKED` → REVOKED.
  - Both go through `setPlaidItemHealth` with `systemDb` (`lib/plaid/webhook-health.ts`).
  - **Not mapped, by decision:**
    - other ITEM/ERROR codes, which may be transient (ERROR locks the Item out of every sync path);
    - `PENDING_EXPIRATION`, because the Item still syncs until the date — the brief listed it, but marking it NEEDS_REAUTH would stop up to 7 days of good data.
- **Tests:** `lib/plaid/webhook-dedupe.test.ts`; `webhook-receiver.test.ts` extended (the ITEM/ERROR `ITEM_LOGIN_REQUIRED` case now expects `HEALTH_TRANSITION`).
- **Residual:** two truly simultaneous duplicate deliveries are serialised by the atomic upsert, so only one is new.

### SEC-009 (adoption) — `2c3cb54` — DONE
- `lib/jobs/cron-auth.ts` (`timingSafeEqual` after an explicit length check; unset secret refuses), used in all six `/api/jobs/*` routes. Integrating with Agent A's `lib/security/cron-secret.ts` is an import swap.
- **Tests:** `lib/jobs/cron-auth.test.ts`.

### IDEMP-007 — `db9ec8c` — DONE
- A "ran" attempt that leaves the Item still incomplete increments `syncResumeAttempts` and sets `syncResumeNextAt` with backoff of 15 min, 1 h, 6 h, then daily.
- A lost lock race is not counted as an attempt. The loader only selects Items whose slot has elapsed, and the counter is reset once the Item completes.
- `syncIncompleteAt` age alone could not drive this, because every failure re-stamps it.
- **Tests:** `jobs/resume-backoff.test.ts`. A blocked Item over 2 days gets 6 attempts with 15/60/360/1440-minute gaps, instead of 576.

### IDEMP-010 — `55d564a` — DONE
- Member DELETE refuses before any write:
  - leaving a PERSONAL Space → 400;
  - the last ACTIVE OWNER leaving a SHARED Space → 409 "transfer ownership first".
- The decision lives in the pure module `leave-guard.ts`.
- **Tests:** `leave-guard.test.ts`. The `rls-t2` and `personal-single-user` pins still pass.

### PRIV-004 — `1202478` — DONE (token half)
- After a confirmed or already-gone `itemRemove`, `encryptedToken` is overwritten with the `""` sentinel. The column stays NOT NULL to avoid widening a type read by about 10 unowned modules. An unconfirmed removal keeps the token for the retry path.
- **Tests:** `lib/plaid/disconnect-token-scrub.test.ts`.
- **Residual:** key rotation is not addressed.

### IDEMP-008 (partial) — `da16b01` — DONE (per-account catch)
- Each exchanged account's body runs in a try that absorbs only P2002. The account is skipped, not imported and not synced, and an `UPSERT_ERROR` SyncIssue is recorded via `lib/plaid/exchange-collision.ts`.
- That helper is a separate module because the unowned `connection-establishment.test.ts` forbids `recordSyncIssue(` anywhere in `exchangeToken.ts`. The pin's intent — an admission policy outcome must never look like a failure — is preserved; please confirm the helper is acceptable.
- **Tests:** `exchange-account-isolation.test.ts` (structural, because the exchange is end-to-end Plaid + DB).
- **Not done:** the `(userId, institutionId)` TOCTOU half.

### Retention: PRIV-003 · DB-001 · OBS-007 · PRIV-012 — `d3aa0ed` — DONE
- `jobs/data-retention.ts`, run as the body of the existing `purge-trash` registration, so no registry change was needed.
- Mechanics: id-batched (1000 × ≤ 20 batches per table per run), age predicate repeated on the delete, per-table isolation, system principal.
- **Tests:** `jobs/data-retention.test.ts`.
- **`purge-trash` decision:** I did NOT implement a time-based hard purge of trashed Spaces or accounts. The financial data is "restorable" and the product's permanent-delete routes are the user's explicit erasure. This is an **owner decision**.

### DB-009 `19b0c11` · SEC-014 `10f47bf` · DB-004 `6c65b67` + `eb34c4a` · DB-006 `e6cbc71` — DONE
- **SEC-014:** grep confirms no fm_app code path writes `PlatformGrant`; the only writers are `app/api/admin/platform-grants/**` via `db`.
- **DB-004 key analysis:** keys are built as `user:<name>:<userId>`, `ip:<name>:<ip>` and `key:<name>:<id>`. A cuid contains no `:`, so the text after the last `:` is the user id. fm_app cannot reach `ip:` / `key:` buckets; no tenant code uses them, since `lib/rate-limit.ts` runs on `db`.
- **Real Postgres proof (SET ROLE):**
  - fm_app as `userA` sees only its own 2 of 4 buckets; updating userB's bucket matches 0 rows; inserting a userB bucket gets an RLS violation; with no identity it sees 0.
  - fm_auth and fm_system each see all 4.
  - fm_app inserting into `PlatformGrant` gets `permission denied`; fm_app's privileges on it = SELECT.
  - `rolconfig` shows `statement_timeout=15s / 5s / 60s`; all 4 DB-009 indexes are present.
- **Test:** `scripts/migration-hardening.test.ts` pins the statements.
- **Residual (DB-006):** on a hosted principal without ALTER ROLE privilege the migration emits a NOTICE, and the timeouts must be applied by hand. Separately, a fm_system statement over 60 s (for example a long wealth regeneration) will now be cancelled — watch on Preview.

## Retention schedule (for `docs/operations`)

| Table | Kept for | Deleted when | Notes |
|---|---|---|---|
| `UserSession` | 30 days after revocation | `revokedAt < now − 30 d` | Live sessions are never touched |
| `AiInvocation` | 90 days | `occurredAt < now − 90 d` | `userId` set to null on account purge |
| `JobRun` | 90 days | `startedAt < now − 90 d` AND status ≠ `running` | |
| `RefreshExecution` (+ `RefreshEndpointResult`, `ProviderCall`, `RefreshEndpointAccountCoverage` by cascade) | 60 days | `startedAt < now − 60 d` | |
| `ProviderCall` | 60 days | `startedAt < now − 60 d` | |
| `PlaidWebhookEvent` | 30 days | `receivedAt < now − 30 d` | |
| `SyncIssue` (+ `SyncIssueOccurrence` by cascade) | 90 days after resolution | `resolved` AND `resolvedAt` (or `updatedAt` on legacy rows) `< now − 90 d` | Open issues are kept at any age |
| `ApiUsageCounter` | 90 days | `day < now − 90 d` | |
| `BetaAccessRequest` | 180 days | DENIED (`decidedAt`), PENDING (`createdAt`), APPROVED with invite expired (`inviteExpiresAt`) older than 180 d | REDEEMED kept until account deletion, which deletes it by e-mail |
| `BetaAccessRequestEvent` | 180 days | `receivedAt < now − 180 d` | Also deleted on account purge |
| `DailyBrief` | 90 days | `briefDay < now − 90 d` | |
| Unchanged | — | — | `AuditLog` security rows (forensic); product events (13 months, existing job); `Notification` (existing cleanup); `RateLimit` (24 h sweep) |

Runs daily at 07:30 UTC as the `purge-trash` job.

## Real-Postgres concurrency evidence (throwaway `postgres:16`)

**IDEMP-001**, two concurrent inserts claiming the same `(financialAccountId, fileSha256)` on the seeded database:
- A: `ERROR: duplicate key value violates unique constraint "ImportBatch_account_file_live_key"`
- B: `INSERT 0 1`, leaving exactly 1 live batch.
- A third claim while that batch is live was refused the same way (this is the route's 409 path).
- After rolling the batch back, the same file claimed again: `INSERT 0 1`, leaving `PENDING,ROLLED_BACK`.

**IDEMP-003**, two concurrent `running` start rows for one job:
- A: `ERROR: duplicate key value violates unique constraint "JobRun_one_running_per_job"`
- B: inserted, leaving exactly 1 running row.
- After completion, a new claim succeeded.

## Not done or deferred, with reasons
- **IDEMP-011 / IDEMP-013 (outside my paths, reported):**
  - invite-approve status predicate — `app/api/platform/growth-revenue/requests/[id]/approve/route.ts` (Agent A);
  - password-reset `updateMany` count assertion — `app/api/auth/reset-password/route.ts` (Agent A);
  - P2002 → 409 on HOME link — `lib/accounts/space-account-link.ts` (unowned);
  - registration unique race P2002 → 409 — `app/api/auth/register/route.ts` (Agent A).
- **IDEMP-008, `(userId, institutionId)` TOCTOU:** needs a partial unique index plus handling in the duplicate gate; deferred.
- **IDEMP-005, cursor CAS and the two lock-free callers:** deferred; the callers are not owned — `lib/plaid/webhook-sync.ts`, the admin inline sync, and `scripts/recover-plaid-item-transactions.ts`.
- **`purge-trash` trashed-data hard purge:** owner decision on the window and notice.

## Out-of-scope needs (paths)
- `lib/platform/operations/registry.ts` — the `EXCLUDED_TARGETS["purge-trash"]` text still says "No-op since W2"; it now runs retention. Text update only (unowned).
- `lib/plaid/webhook-sync.ts` — switch to `claimPlaidItemSyncLockAt` + fenced release (IDEMP-005).
- `scripts/lib/db-authority-baseline.json` — `audit-db-authority` reports 3 implicit owner calls closed since the baseline. Regenerate with `npx tsx scripts/audit-db-authority.ts --write-baseline` to lock that in (Agent F).
- `docs/operations/` — place the retention table (orchestrator / Agent E).
- `lib/plaid/client.ts` — Plaid transport timeout (OPS-004, Agent E), the other half of the per-Item deadline.
- DB-006 on Production/Preview — confirm the migration principal can ALTER ROLE; otherwise apply the three settings by hand.
