# 18 — A5: Preview migration evidence (nine migrations applied)

**Date:** 2026-10-22, 19:19–19:31 UTC.

**Authorised:** A5 only, applying the nine pending migrations to the existing shared Preview database per `docs/operations/preview-migration-runbook-beta1.md`.

**Not authorised and not done:**
- A6: merge PR #1.
- A7: the browser campaign.
- Production, GitHub secrets, Vercel environment settings, paid infrastructure.

**Outcome:** **A5 COMPLETE.** All nine applied in order on the first attempt, with no failure, retry, NOTICE fallback or manual SQL. Every §5 check passes. Existing data is identical. `preview-app` (`v2.6` `cde8fa0`) is healthy on the migrated schema.

## 0. Starting state (verified, not assumed)

| Item | Value |
|---|---|
| Worktree / branch | `~/dev/FourthMeridian-remediation/base`, `remediation/beta-1`, clean |
| Starting SHA (local = `origin`) | `1ca308585284c399b4754851c27ff940ce854ec5` |
| PR #1 | OPEN, `mergedAt` null, MERGEABLE, state UNSTABLE only from the secret-free `Deployment health` check (UNVERIFIED by design). `test` ×2, `Architecture audits` ×2, `Public site` ×2, `status-drift-guard` and Vercel all pass. |
| `v2.6` (local = origin) | `cde8fa0`, untouched |
| A5 previously performed? | **No.** Preview had 126 applied, 0 of `202610220%` (§2). |
| Shell | Node 24.21.0; `pg_dump`/`psql` 18.4; no exported `DATABASE_URL`/`DIRECT_URL`/`SHADOW_DATABASE_URL`/`FM_DB_GUARD` |
| Credentials | A fresh mode-600 copy of the Preview migration-principal file (project ref `lqag…`), in `~/fm-rehearsal-private/` (700). Loaded into one subshell at a time. **Deleted** (`rm -P`) after the checks. No value printed or committed. |

## 1. Target identity (read-only, `BEGIN TRANSACTION READ ONLY`, 19:19:21 UTC)

| Check | Expected (runbook §1) | Read |
|---|---|---|
| `transaction_read_only` | on | on |
| `server_version` | 17.6 | 17.6 |
| database / user | postgres / postgres | postgres / postgres (non-superuser, BYPASSRLS, CREATEROLE) |
| Host | Preview pooler | `aws-1-ap-southeast-1.pooler.supabase.com:5432`, user `postgres.lqag…` |
| Applied / unfinished-or-rolled-back | 126 / 0 | 126 / 0 |
| Newest | `20261016000000_customer_ai_allowance_override` | same |
| `JobRun` fingerprint | 1 @ 2026-10-07 19:09:08.654 | **1 @ 2026-10-07 19:09:08.654** (Preview, not Production) |
| Users / Spaces / accounts / transactions | 5 / 14 / 67 / 1,258 (doc 17 §0) | 5 / 14 / 67 / 1,258 |
| User-id hash | `44fc14c1…` | `44fc14c1` |
| `db-guard --mode=migrate-deploy` (identity only, no connection) | pass | `target aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres via DIRECT_URL (LIVE)` |

## 2. Migration set and checksums

- **Pending:** exactly nine. `prisma/` is byte-identical between the rehearsed SHA `0502dc7` and `1ca3085` (`git diff --stat` empty).
- **Repository:** 135 migration directories.
- **Applied history:** names and checksums of all **126** rows in Preview's `_prisma_migrations` are **identical** to `sha256(migration.sql)` of the first 126 directories. Nothing was edited after application.

| # | Migration | SHA-256 (prefix) |
|---|---|---|
| 1 | `20261022000000_user_purge_claim` | `246c0eedbc0cfdde` |
| 2 | `20261022000100_import_batch_file_sha256` | `0bb07ac362bb63fd` |
| 3 | `20261022000200_job_run_one_running_per_job` | `caee67a0a435f7cc` |
| 4 | `20261022000300_plaid_item_resume_backoff` | `193cf348fe894e37` |
| 5 | `20261022000400_db009_operational_indexes` | `aeee364ebd41ddb9` |
| 6 | `20261022000500_sec014_platform_grant_read_only` | `663a8daf3319aa1b` |
| 7 | `20261022000600_db004_rate_limit_rls` | `c7d570f5f616b134` |
| 8 | `20261022000700_db006_role_statement_timeouts` | `bb855cfe11cd3c36` |
| 9 | `20261022001000_db008_provider_capability_index_name` | `fd58c599de12f84a` |

## 3. Preflight (runbook §3, read-only)

| Check | Expected | Read |
|---|---|---|
| The nine present | 0 rows | 0 |
| New columns / index names already exist | none | none |
| `JobRun` `running` | 0 | 0 |
| Owner of the 10 affected tables | postgres | all postgres |
| `ADMIN` on `fm_app`, `fm_auth`, `fm_system`, `fm_backup` | t | t (`set_option` f, as known) |
| Old truncated index `…_observedAt` | 1 | 1 |
| `RateLimit` RLS / FORCE / policies | f / f / 0 | f / f / 0 |
| `PlatformGrant` → `fm_app` | `DELETE,INSERT,SELECT,UPDATE` | same |
| `PlatformGrant` policies | `fm_app_del, fm_app_ins, fm_app_sel, fm_app_upd, fm_system_all` | same |
| Non-idle client sessions (excluding self) | 0 | 0. Idle only: PostgREST, Supavisor auth_query, two `supabase_admin` (exporter). |
| Waiting locks | none | 0 |
| `max_connections` | 60 | 60 |
| FORCE-RLS tables / policies / `fm_*` table grants | 62 / 246 / – | 62 / 246 / 568 |
| Role defaults | idle timeout 15s on `fm_app`/`fm_auth`/`fm_system` | same; no `statement_timeout` yet |

**No conflicting operation:**
- No local `prisma`/`pg_dump`/`pg_restore`/`psql` process.
- Supabase's daily physical backup runs around 22:53 UTC (doc 17 §2), about 3.5 h after this window.
- Crons are Production-only (one-row `JobRun`).
- The Supabase dashboard was **not** re-read today (deviation, see §10). The fresh logical dump below is the recovery point.

**v2.6 compatibility (gate 9), checked in the `cde8fa0` source:**
- `PlatformGrant` is written only through `db` (the migration principal): `app/api/admin/platform-grants/route.ts:151` and `[grantId]/route.ts:59`.
- `RateLimit` is written through `db` (`lib/rate-limit.ts:102`) and `systemDb`/`fm_system` (`lib/platform/ai/allowance-reservation.ts`).
- No `cde8fa0` path writes either table as `fm_app`, so the REVOKE (`…000500`) and the RLS (`…000600`, which grants `fm_system_all`) cannot break the live code.
- The new columns are nullable or defaulted, and `cde8fa0` does not read them.

## 4. Backup and restore verification (runbook §2)

**Platform backups:** Pro plan, 7 daily PHYSICAL backups, **PITR disabled** (doc 17 §2). So the logical dump is the point-in-time recovery point.

| Artefact | Detail |
|---|---|
| Fresh dump (pre-migration recovery point) | `~/fm-rehearsal-private/a5/preview-pre-a5-20261022T192112Z.dump`: `pg_dump --format=custom --no-owner --schema=public` as the migration principal (BYPASSRLS), **with ACLs**. 1,135,028 B. SHA-256 `3720830a3eb5d799701b22fafe689a637cb5e4ccc7d942a4c0f35937148bb0b1`. Holds 71 TABLE DATA, 246 POLICY, 62 ROW SECURITY and 214 INDEX entries. |
| Guard's automatic backup (inside `db:migrate:safe`) | `postgres-2026-10-22T19-24-54-570Z.sql`, plain SQL `--no-owner --no-privileges`, 4.33 MB. `verified row-for-row across 52 non-empty table(s)`. Moved from the worktree's gitignored `backups/` to `~/fm-rehearsal-private/a5/guard-backup-…sql`. SHA-256 `83cf7f031ca4164900c62c3b623e41c5f20d13d0e72b6d210a7233e6beb22272`. |
| Storage | `~/fm-rehearsal-private/` (700), files 600. Outside the repository, not uploaded anywhere. |

**Restore check:** a disposable `postgres:17.6` container on `127.0.0.1`, removed with `-v` afterwards. Docker volume count 23 before and after.

| Check | Result |
|---|---|
| Per-table row count + MD5 of every row, 71 tables incl. `_prisma_migrations` (21,085 rows) | **identical** to live |
| Full catalog: relations + ACLs + RLS flags, 175 constraints, 246 policies (roles, cmd, qual, check), functions + ACLs, enums | **1,196 lines identical**. Only the `public` schema owner label differs, a container artefact. |
| `_prisma_migrations` / `JobRun` / users / FORCE-RLS / `fm_*` grants / `PlatformGrant` → `fm_app` | 126 / 1 @ 2026-10-07 19:09:08.654 / 5 / 62 / 568 / `DELETE,INSERT,SELECT,UPDATE` |
| Errors | `pg_restore --exit-on-error` stopped at the **trailing** `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` block (role absent in plain Postgres). Every later list entry is also a `DEFAULT ACL`, which governs future objects only. |

**Recovery note:** for a real restore into a new Supabase project, `supabase_admin` exists. Into anything else, run without `--exit-on-error` so the `postgres` default ACLs also restore.

**Fingerprint method:**
- `md5(string_agg(to_jsonb(row)::text ORDER BY … COLLATE "C"))` per table, excluding the four new columns.
- Run with `SET LOCAL TimeZone='UTC'` and `SET LOCAL extra_float_digits=1`.
- Supabase runs `extra_float_digits=0` and stock Postgres runs 1. Without pinning it, the four tables with `double precision` columns hash differently while the data is identical. That explained a first diff against the morning baseline; it was diagnosed before any conclusion was drawn.

## 5. Execution

The data fingerprint was re-read at T0 (19:24 UTC): identical to the dump-time fingerprint. 126 applied, 0 non-idle sessions, 0 running jobs.

```
cd ~/dev/FourthMeridian-remediation/base     # 1ca3085, clean
PATH=/opt/homebrew/opt/node@24/bin:$PATH; set -a; . <creds>; set +a
npm run db:migrate:safe
```

| Step | Output |
|---|---|
| Command start | 2026-10-22 19:24:53 UTC |
| `db-guard` | `target …pooler.supabase.com:5432/postgres via DIRECT_URL (LIVE)` |
| `db:backup` | `verified row-for-row across 52 non-empty table(s)` (4229.4 KB) |
| `prisma migrate deploy` | `135 migrations found`; nine `Applying migration …` lines in order; `All migrations have been successfully applied.` Exit 0. **No DB-006 NOTICE.** |
| Migration window (`_prisma_migrations`) | `…000000` 19:28:53.275 → `…001000` finished 19:29:06.657. Each `applied_steps_count=1`, no logs. |
| Command end | 19:29:07 UTC. Most of the 4 min was the guard's dump and its count verification. |

## 6. Post-migration verification (runbook §5)

Catalog checks ran read-only as the migration principal (19:29–19:31 UTC).

| Check | Expected | Read |
|---|---|---|
| Applied / bad | 135 / 0 | **135 / 0** |
| The nine, in order, finished | 9 | 9, start times strictly increasing in lexical order; checksums = §2 |
| Columns | 4 | `ImportBatch.fileSha256 text NULL` · `PlaidItem.syncResumeAttempts integer NOT NULL DEFAULT 0` · `PlaidItem.syncResumeNextAt timestamp NULL` · `User.purgeStartedAt timestamp NULL` |
| Indexes valid + ready | 7 | 7/7 `indisvalid` and `indisready` |
| Old truncated index name | 0 | 0 (renamed to `…_observ_idx`) |
| Invalid indexes in `public` | 0 | 0 |
| `RateLimit` RLS / FORCE | t / t | **t / t** |
| `RateLimit` policies | `fm_app_own_user_buckets, fm_auth_all, fm_system_all` | same. `fm_app` predicate: key `user:%` whose suffix = `:` + `current_fm_user_id()`, non-null identity, `USING` = `WITH CHECK`. |
| `PlatformGrant` → `fm_app` | SELECT | **SELECT** (`fm_system` keeps DML, `fm_backup` SELECT) |
| `PlatformGrant` policies | `fm_app_sel, fm_system_all` | same |
| Role defaults | `statement_timeout` 15s / 5s / 60s + idle 15s | `fm_app {idle…=15s, statement_timeout=15s}` · `fm_auth {…, 5s}` · `fm_system {…, 60s}` · `fm_backup` unchanged |
| FORCE-RLS tables | 63 | 63 |
| Policies | 246 (+3 −3) | 246 |
| `fm_*` table grants | 568 − 3 | 565 (`fm_app` INSERT/UPDATE/DELETE on `PlatformGrant` revoked) |

**Catalog diff, before → after (1,196-line catalog):** exactly the intended set and nothing else:
- −3 `PlatformGrant` `fm_app` write policies;
- +3 `RateLimit` policies;
- +6 new indexes;
- 1 index renamed;
- `PlatformGrant` ACL `fm_app=arwd` → `fm_app=r`;
- `RateLimit` RLS `ff` → `tt`.

### RLS and privilege behaviour on live Preview (logged in as each role, read-only transactions, Supavisor 6543)

| Role | Observed |
|---|---|
| `fm_app`, no `app.user_id` | `bypassrls=false`; `RateLimit` visible **0** (fails closed; truth 308); `FinancialAccount` visible 0; `PlatformGrant` INSERT/UPDATE/DELETE privilege **false**, SELECT true; `statement_timeout` **15s** |
| `fm_app` as the real user with the most buckets (hash `6f0ea002`) | `RateLimit` visible **139** = that user's buckets per the BYPASSRLS ground truth, **0 foreign**; foreign `PlatformGrant` rows 0 |
| `fm_auth` | `RateLimit` 308 (all); `FinancialAccount` SELECT privilege false; `statement_timeout` **5s** |
| `fm_system` | `RateLimit` 308 (all); `statement_timeout` **1min** |

**Write-denial tests** (`INSERT` refused, cross-user bucket write refused, `pg_sleep` cancelled by the timeout) were **not** repeated on shared Preview, so as to make no write attempts there. They passed on the restored Preview copy in A2 (doc 16 §2) against byte-identical migrations, and the privilege and policy state above is the precondition they rely on.

**RLS suites:** the six `rls:accept*` suites create fixtures, so they are not run against shared Preview. They passed on the migrated Preview copy (A2: 37/98/72/20/67/15) and in GitHub CI on `1ca3085`.

### Drift

- `npx tsx --env-file=<creds> scripts/check-schema-drift.ts`: `135 migration(s) on disk · 135 applied — ✓ in step`, exit 0.
- `audit-schema-drift` needs a superuser (A2 finding 2), so the read-only `db:drift` above is the documented Preview alternative. It ran green in GitHub CI on `1ca3085`.

### Data integrity

- Per-table fingerprint before (`fp-before`, = T0) vs after: **all 70 data tables identical** (row counts and MD5).
- The only change is `_prisma_migrations` 126 → 135.
- New columns hold only NULL / 0 (`purgeStartedAt` set 0/5; Plaid non-default 0/12; `fileSha256` 0).
- `…000200`'s `JobRun` cleanup touched 0 rows (`JobRun` hash identical).
- A later re-read after the health probes: `RateLimit` 308 → 309, i.e. the app's rate limiter **still writes** under the new RLS; all other tables unchanged.

**The event-identity INV-7 non-vacuity failure** (A2 finding 1) is a pre-existing property of Preview data and is unaffected. The audit was not re-run here: it is a CI-corpus check, and the migrations do not touch event tables (hashes identical).

### Existing `v2.6` application

| Probe (automation bypass header; value read from the Vercel API, never printed) | Before (19:20:00) | After (19:30:46–47, ×3) |
|---|---|---|
| `GET preview-app.fourthmeridian.com/api/health` | 200 `{"status":"ok","db":"ok","commit":"cde8fa0"}` | 200 ×3, same body |
| `GET /login` | – | 200 (`validateEnv passed`) |
| Vercel runtime logs, alias `dpl` `fintracker1-f91ui0jz9…`, last 20 min | – | 5 entries, all 200, all mine; **0** error/permission/timeout lines |

## 7. Security regression check

- `PlatformGrant` self-grant: closed (SEC-014). Not reversed.
- No role gained a privilege. The only grant-level change is three revocations.
- `RateLimit` moved from no RLS to FORCE RLS with user isolation.
- No Vercel env, GitHub secret or Production object was touched. `preview-app` is still on `cde8fa0` (alias unchanged).

## 8. Files (owner-private, not in the repository)

`~/fm-rehearsal-private/a5/` holds:
- `preflight.txt`, `postcheck.txt`, `migrate.log` (URLs redacted);
- `repo-checksums.txt` / `db-checksums.txt`;
- `fp-{before,t0,restored,after,after2}.txt`;
- `obj-{before,restored,after}.txt`;
- `rls-roles.txt`, `drift.txt`, `health-{before,after}.txt`, `vercel-logs.txt`;
- both backups with their SHA-256.

Delete after the Production cutover, as for the A2 artefacts.

## 9. Recovery position now

- **Code rollback:** none needed. `v2.6` predates the migrations and runs on the migrated schema.
- **Schema rollback:** the PR's rollback SQL in reverse order, then `prisma migrate resolve --rolled-back` (runbook §6). **Never re-grant `PlatformGrant` writes to `fm_app`.**
- **Data rollback** (none needed; data unchanged): restore `preview-pre-a5-20261022T192112Z.dump` into a **new** database. This is a separate owner approval.

## 10. Deviations

1. **Supabase dashboard not re-read today.** The backup posture is doc 17 §2 (read earlier on 2026-10-22). Mitigation: the fresh logical dump, restore-verified, is the recovery point.
2. **Dump scope `--schema=public`** (as A2) rather than the whole database. The `auth`/`storage` schemas are unused by the app and untouched by the migrations.
3. **Credentials:** the runbook asks for a fresh file. It was a fresh 600 copy of the existing Preview credentials file, deleted afterwards. The original `tmp/rls-preview-cutover/preview.env` in the main checkout (2026-10-06, gitignored, 600) remains: deleting it is outside A5.
4. **Restore check:** `--exit-on-error` stopped in the trailing default-ACL block (§4). Every object was verified identical regardless.
5. **Write-denial and RLS suites** not run on shared Preview (§6), by design.

## 11. Remaining before A6 (merge PR #1)

| # | Item | State |
|---|---|---|
| A5 | Preview migrations | **DONE** (this doc) |
| CI | PR #1 checks at `1ca3085` | green except `Deployment health` (UNVERIFIED by design). A docs-only push of this report would re-run them. |
| A1d | Push this doc + checkpoint commit to PR #1 | **needs approval** (local only) |
| A6 | Merge PR #1 → `v2.6` | **needs approval.** Technical precondition (migrated Preview) is now met. On merge: Preview redeploys `v2.6`; re-read `/api/health` (expect the `scheduler` block, no `commit`); the first `v2.6` push is the GitHub-side trusted-health test. |
| D15 | Preview registration | still **open** on `cde8fa0`; `invite_only` default arrives with A6. Set `registration_mode` explicitly if open sign-up is wanted. |
| D12 full / D14 | Branch-DB isolation; provider-key checks (Plaid sandbox, OpenAI project, Resend) | owner. D14 gates A7 (doc 17 §6). |
| A7 | Browser pass | not approved; after A6 + Gate 0 |

Production remains untouched.
