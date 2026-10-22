# Preview migration runbook — beta-1 (nine migrations)

**Scope:** apply `20261022000000` … `20261022001000` (PR #1, `remediation/beta-1`) to the **shared Preview database only**.

**Who:** owner, or an operator the owner names. Every step below that connects to Preview is an owner-approved action. Nothing here touches Production.

**Order:** migrate Preview **before** merging PR #1.

- The migrations are expand-only, so the current `v2.6` code (`cde8fa0`) runs on the migrated schema. The pre-migration-merge window is safe.
- The PR's code reads `User.purgeStartedAt`, so it does **not** run on the unmigrated schema.

Facts below were read from Preview on 2026-10-22 with `BEGIN TRANSACTION READ ONLY`. They are the expected preflight values; any difference is a stop.

## 0. Prerequisites

| # | Check | Expected |
|---|---|---|
| 0.1 | Owner approval recorded for: Preview backup, Preview migration, PR #1 merge (three separate approvals) | written |
| 0.2 | Working tree | `remediation/beta-1` at the PR head; `git status` clean |
| 0.3 | Node | 24 (`/opt/homebrew/opt/node@24/bin` first on PATH) |
| 0.4 | `pg_dump --version` | ≥ 17 (18.4 on the owner's Mac; a newer pg_dump can dump 17.6) |
| 0.5 | Shell environment | no exported `DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL` or `FM_DB_GUARD`. `env \| grep -E 'DATABASE_URL\|DIRECT_URL\|FM_DB_GUARD'` prints nothing. An exported `DATABASE_URL` beats `--env-file`; that is how five agent worktrees once pointed at live. |
| 0.6 | Credentials file | a **fresh** file outside the repo, mode 600, holding only the Preview `DATABASE_URL` and `DIRECT_URL` for the Preview Supabase project (ref begins `lqag…`). Never paste it into chat or a report. Delete it at the end. |
| 0.7 | Crons | Vercel crons run on Production only (`environment-separation.md` §3). Preview's whole `JobRun` ledger is one row. Nothing will start a job mid-migration. |
| 0.8 | Rehearsal | `FM_CI_PG_IMAGE=postgres:17.6 npm run ci` green on the PR head (`14-PREVIEW-RELEASE-VALIDATION.md` §5). Preferably also the restored-copy rehearsal (§5 option B). |

## 1. Target verification (read-only)

Run with the credentials file loaded into the **current shell only**: `set -a; . <file>; set +a`. Then:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT current_setting('transaction_read_only');           -- on
SELECT current_setting('server_version');                  -- 17.6
SELECT current_database(), current_user;                   -- postgres, postgres
SELECT count(*) FROM _prisma_migrations
 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL; -- 126
SELECT count(*) FROM _prisma_migrations
 WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;  -- 0
SELECT max(migration_name) FROM _prisma_migrations;        -- 20261016000000_customer_ai_allowance_override
SELECT count(*), max("startedAt") FROM "JobRun";           -- 1, 2026-10-07 19:09:08.654  (Preview fingerprint)
SELECT count(*) FROM "User";                               -- 5 (± new test sign-ups)
ROLLBACK;
```

**Why the `JobRun` line is the identity check.** Production runs the dispatcher every 15 minutes, so its ledger has thousands of rows and a `max("startedAt")` within the last 15 minutes. One row from 2026-10-07 can only be Preview.

On 2026-10-22, PR deployment `dpl_J8du…` (`/api/health` scheduler block) reported this same instant, which proves that deployment is wired to this database.

**Stop** on any mismatch.

## 2. Backup and restore verification

1. **Platform backup (read from the Supabase dashboard on 2026-10-22; doc 17 §2).**
   - Preview project `fourth-meridian-preview` (VirtuArch org, **Pro** plan, Nano compute).
   - **Daily PHYSICAL backups, 7 kept** (15–21 Oct, newest 21 Oct 22:53 UTC, all COMPLETED), so the nearest platform recovery point can be up to about 24 h old.
   - **PITR is DISABLED** (paid add-on), so there is no point-in-time recovery to the moment before step 4.
   - Recovery options shown:
     - in-place **Restore** of a daily backup, which replaces the Preview database;
     - **Restore to new project** (beta), which leaves Preview untouched.
   - Re-read the newest backup time on the day and record it.
   - Because there is no PITR, step 2's logical dump is **the** pre-migration recovery point. Do not skip it.
2. **Logical dump with privileges.**
   - `npm run db:backup` uses `--no-owner --no-privileges`. That is not enough here: migrations `…000500` (REVOKE) and `…000600` (RLS policies) change grants and policies, and a dump without privileges cannot restore them.
   - Take a second dump:
     ```bash
     ts=$(date -u +%Y%m%dT%H%M%SZ)
     pg_dump --format=custom --no-owner --file "backups/preview-pre-beta1-$ts.dump" "$DIRECT_URL_WITHOUT_PRISMA_PARAMS"
     shasum -a 256 "backups/preview-pre-beta1-$ts.dump" | tee "backups/preview-pre-beta1-$ts.dump.sha256"
     ```
   - `postgres` on Supabase has `BYPASSRLS`, so the dump is complete (RLS acceptance case 28 proves the same property for `fm_backup`).
3. **Restore verification (local, disposable).** Restore into a throwaway `postgres:17.6` container, never into Preview:
   ```bash
   docker run -d --rm --name fm-restore-check -e POSTGRES_PASSWORD=fm -p 127.0.0.1::5432 postgres:17.6
   # create the roles the grants name (no login, no password):
   docker exec fm-restore-check psql -U postgres -c "CREATE ROLE fm_app NOLOGIN; CREATE ROLE fm_auth NOLOGIN; CREATE ROLE fm_system NOLOGIN; CREATE ROLE fm_backup NOLOGIN BYPASSRLS;"
   docker exec -i fm-restore-check pg_restore -U postgres -d postgres --no-owner < backups/preview-pre-beta1-$ts.dump
   ```
   - **Pass:** the `_prisma_migrations` count (126), `JobRun` (1), `User` (5) and the FORCE-RLS table count (62) match §1.
   - Remove the container with `docker rm -f -v fm-restore-check`. The `-v` matters: without it the volume leaks.
   - Supabase-only objects (`extensions` schema, `auth`/`storage` schemas) may report restore warnings. Only `public` is in scope.
4. **Stop** if the dump or the restore check fails.

## 3. Preflight (read-only)

| Check | SQL (inside `BEGIN READ ONLY … ROLLBACK`) | Expected on 2026-10-22 |
|---|---|---|
| The nine are all pending | `SELECT migration_name FROM _prisma_migrations WHERE migration_name LIKE '202610220%'` | 0 rows |
| No new column or index name already exists | see `14-PREVIEW-RELEASE-VALIDATION.md` §4 | none |
| No `running` JobRun (needed by `…000200`) | `SELECT count(*) FROM "JobRun" WHERE status='running'` | 0 |
| Migration principal owns the tables | `pg_tables.tableowner` for User, ImportBatch, JobRun, PlaidItem, SpaceGoal, SyncIssue, UserSession, PlatformGrant, RateLimit, ProviderCapabilityObservation | all `postgres` |
| `ADMIN` on the `fm_*` roles (needed by `…000700`) | `pg_auth_members` for `current_user` | `fm_app`, `fm_auth`, `fm_system`, `fm_backup` = true |
| Index to rename exists under the truncated name | `pg_indexes.indexname = 'ProviderCapabilityObservation_provider_capabilityKey_observedAt'` | 1 |
| RateLimit has no RLS and no policy yet | `relrowsecurity`, `relforcerowsecurity`, `pg_policies` | false, false, none |
| PlatformGrant before state | `fm_app` privileges; policies | `DELETE,INSERT,SELECT,UPDATE`; `fm_app_del, fm_app_ins, fm_app_sel, fm_app_upd, fm_system_all` |
| Quiet database | `pg_stat_activity` non-idle in this database, excluding self | 0 |
| Connections | `max_connections` | 60 |

## 4. Execution

```bash
cd ~/dev/FourthMeridian-remediation/base          # PR head
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
set -a; . <preview-credentials-file>; set +a
npm run db:migrate:safe                           # db-guard (migrate-deploy: DATABASE_URL ≡ DIRECT_URL) → db:backup → prisma migrate deploy
```

- Use `db:migrate:safe` only. Never raw `prisma migrate dev` / `reset`, and never `db:migrate` (`database-safety.md`).
- Expected output: nine `Applying migration …` lines, then `All migrations have been successfully applied.`
- `…000700` may print `NOTICE: DB-006: no privilege to ALTER ROLE …`. On Preview it should not: §3 shows `ADMIN` on every `fm_*` role. If it does, finish §5 first, then apply the three `ALTER ROLE … SET statement_timeout` statements by hand.
- Expected duration: seconds. Every affected table has ≤ 300 rows. The four `CREATE INDEX` statements (not `CONCURRENTLY`) take a brief write lock.

## 5. Post-migration checks (read-only)

```sql
BEGIN TRANSACTION READ ONLY;
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;  -- 135
SELECT count(*) FROM _prisma_migrations WHERE migration_name LIKE '202610220%' AND finished_at IS NOT NULL; -- 9
SELECT table_name||'.'||column_name FROM information_schema.columns
 WHERE (table_name,column_name) IN (('User','purgeStartedAt'),('ImportBatch','fileSha256'),('PlaidItem','syncResumeAttempts'),('PlaidItem','syncResumeNextAt')); -- 4 rows
SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 WHERE c.relname IN ('ImportBatch_account_file_live_key','JobRun_one_running_per_job','PlaidItem_syncIncompleteAt_idx',
  'SpaceGoal_deletedAt_idx','SyncIssue_plaidItemId_resolved_idx','UserSession_revokedAt_idx',
  'ProviderCapabilityObservation_provider_capabilityKey_observ_idx');                            -- 7 rows, all true
SELECT count(*) FROM pg_indexes WHERE indexname='ProviderCapabilityObservation_provider_capabilityKey_observedAt'; -- 0
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public."RateLimit"'::regclass;  -- true, true
SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE tablename='RateLimit';
  -- fm_app_own_user_buckets,fm_auth_all,fm_system_all
SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
 WHERE table_name='PlatformGrant' AND grantee='fm_app';                                             -- SELECT
SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE tablename='PlatformGrant';
  -- fm_app_sel,fm_system_all
SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('fm_app','fm_auth','fm_system') ORDER BY 1;
  -- each keeps idle_in_transaction_session_timeout=15s and gains statement_timeout = 15s / 5s / 60s
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relforcerowsecurity;                                               -- 63 (62 + RateLimit)
ROLLBACK;
```

**RLS behaviour checks.**
- `SET ROLE` is **not** available: on Preview the migration principal holds `ADMIN` on the `fm_*` roles, but `set_option = false` (PostgreSQL 16+ semantics, read 2026-10-22).
- Connect **as the role** instead, with the role login URLs the owner holds for Preview (the RLS cutover's role file, never printed). Each check runs in a read-only transaction:

```sql
-- as fm_app (no app.user_id set)
BEGIN TRANSACTION READ ONLY;
SELECT count(*) FROM "RateLimit";                                   -- 0: fails closed without an identity
SELECT has_table_privilege(current_user,'"PlatformGrant"','INSERT'); -- false
SHOW statement_timeout;                                             -- 15s (new session picks up the role default)
ROLLBACK;
-- as fm_system
BEGIN TRANSACTION READ ONLY;
SELECT count(*) > 0 FROM "RateLimit";                               -- true: sees every bucket
SHOW statement_timeout;                                             -- 1min
ROLLBACK;
```

- If the role URLs are not to hand, the catalog checks above plus the PostgreSQL 17.6 rehearsal (RLS suites green on 17.6) are the evidence. Record which was used.

**Drift.**
- `npx tsx --env-file=<preview-credentials-file> scripts/check-schema-drift.ts` must exit 0 with no pending, unfinished or unknown migration.
- `scripts/audit-schema-drift.ts` compares migrations with the schema and does not need Preview.

**Application.** `GET https://preview-app.fourthmeridian.com/api/health` through Vercel SSO, or with the automation-bypass header. It still serves `cde8fa0`: `status: ok`, `db: ok`. This proves the current code runs on the migrated schema.

Only then: merge PR #1 (a separate owner approval), let Preview redeploy, re-read `/api/health` (now with the `scheduler` block and no `commit`), and run the browser matrix (`15-BROWSER-SMOKE-MATRIX.md`).

## 6. Failure response and recovery

| Situation | Response |
|---|---|
| §1–§3 mismatch | Stop. Nothing has been changed. Record what differed. |
| A migration fails (Prisma prints `Migration failed` and stops) | **(1)** Do not re-run blindly. **(2)** `npx prisma migrate status` (same env) shows the failed migration. **(3)** Each migration file is sent as one script, so a failure normally leaves no partial effect: verify with the §5 check for that migration only. **(4)** If nothing applied: fix the cause, `npx prisma migrate resolve --rolled-back <name>`, then `npm run db:migrate:safe` again. **(5)** If it applied partially: complete or undo by hand using the rollback SQL in the PR description, then `resolve --applied` or `--rolled-back` accordingly. Never `migrate reset`. |
| `…000200` fails creating `JobRun_one_running_per_job` (duplicate `running` rows appeared after its UPDATEs) | Not possible on Preview while crons are Production-only. If seen: something is running jobs against Preview. Stop and find it before retrying. |
| `…000700` NOTICE instead of applying | Apply by hand as the table owner: `ALTER ROLE fm_app SET statement_timeout='15s'; ALTER ROLE fm_auth SET statement_timeout='5s'; ALTER ROLE fm_system SET statement_timeout='60s';` |
| Post-check fails, or `preview-app` (`cde8fa0`) degrades after migration | The code needs no rollback: it predates the migrations. Undo the specific migration with the PR's rollback SQL in reverse order, then `prisma migrate resolve --rolled-back <name>`. **Never re-grant `PlatformGrant` writes to `fm_app` (SEC-014).** |
| Data damaged / unknown state | Restore (owner): Supabase PITR to the step-2 timestamp, or `pg_restore` of the step-2 dump into a **new** Supabase database followed by repointing Preview env (a separate, owner-approved configuration change). Then re-run §1 and §5. |
| Statement timeouts cut real Preview work after merge | `ALTER ROLE <role> RESET statement_timeout;` restores the prior state (role-level setting only, no data). Record the query that hit the limit. |

At the end, delete the credentials file and record in the release ticket: §1 values, dump file name and SHA-256, restore-check result, migration output, §5 results, and the drift check line.
