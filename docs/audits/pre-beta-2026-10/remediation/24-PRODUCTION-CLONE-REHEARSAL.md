# 24 — Production backup, isolated restore and full migration rehearsal

**Date:** 2026-10-22 23:56 → 2026-10-23 00:30 UTC.

**Production:** `qirf…`, PG 17.6. **Read-only throughout.** The final check, after all work, matched the starting fingerprint (88 migrations, md5 `9ea5829f99dc879274eb8af4cf17c8e6`, 2 users, 5,135 transactions).

**Not done:** no merge of PR #10, no v2.6 deployment, no Production setting change.

## 1. Access and protections

| Control | Evidence |
|---|---|
| Connection | Supabase **session pooler** (IPv4) `aws-1-ap-southeast-1.pooler.supabase.com:5432`, user `postgres.qirf…`, db `postgres`, read from the dashboard Connect panel. The direct host is IPv6-only |
| Credential | Owner-created libpq `PGPASSFILE` in `~/fm-rehearsal-private/prod/` (directory 700, file 600, one line). The password was never in chat, command arguments, environment variables, shell history or the repository. The verifier refuses on wrong mode, owner or field match, or when FileVault is off. **Deleted with `rm -P` after use** |
| Read-only | `pg_dump` reads in its own snapshot. Every other Production query ran inside `BEGIN TRANSACTION READ ONLY` (verified `read_only=on`). The dump was refused unless the identity and migration fingerprint matched |
| At rest | FileVault **On**. No Time Machine destination. Evidence directory 700, files 600 |

## 2. Backup (Production, read-only)

| Item | Value |
|---|---|
| File | `prod-20261022T235646Z.dump` (custom format, `--schema=public --no-owner`, ACLs kept) |
| Size / SHA-256 | 3,107,581 B / `56f027df21fb48d6ba0521e9b7d86fb55084fd6aef1d61fd2304c6c0d15600d0` (re-verified OK at the end) |
| Contents | 56 TABLE DATA, 168 INDEX, 139 CONSTRAINT, 1 ACL, 0 policies (Production has no RLS yet) |
| **Duration** | **86 s** (`pg_dump` through the pooler) |
| Consistency | The per-table fingerprint before and after the dump differs only in `UserSession` (activity timestamps). The dump is one snapshot |

## 3. Isolated restore and validation

**Environment:**
- disposable `postgres:17.6` on `127.0.0.1`, reproducing Supabase's role model;
- a separate superuser; restore **as a non-superuser `postgres` with BYPASSRLS + CREATEROLE**;
- removed with its volume afterwards; Docker volumes 23 → 23.

| Check | Result |
|---|---|
| **Restore duration** | **1.13 s** (first run); 1.24 s and 1.63 s on re-runs; 0 errors |
| Data | **All 56 tables, 58,374 rows**: row counts + per-row MD5 identical to live Production |
| Migration history | 88, md5 `9ea5829f…` (= Production) |
| Catalog | 480 entries (relations + ACLs, constraints, policies, functions, enums): **identical to live** |
| Roles | `postgres` non-superuser BYPASSRLS CREATEROLE; `anon` / `authenticated` / `service_role` present |

## 4. Migration rehearsal (47 pending)

| Item | Result |
|---|---|
| Delta | Exactly **47**: `20260801_v26_investments_history_snapshot_completeness` → `20261022001000_db008_provider_capability_index_name` |
| Command | `npm run db:migrate:safe` from `v2.6` as the non-superuser `postgres` |
| **Duration** | **4.5–6.0 s end to end** (guard + pre-migration dump + deploy). The 47 executed in a **0.36 s window** |
| Longest lock | `20261002000100_rls_roles_and_policies` **69 ms** (creates 4 roles; FORCE RLS on 56 tables; 220 policies) |
| Result | 135 applied, 0 failed. 4 `fm_*` roles with `statement_timeout` 15s / 5s / 60s. `postgres` ADMIN (no SET) on them. 63 FORCE-RLS tables, 246 policies, 565 grants. `PlatformGrant`→`fm_app` SELECT; `RateLimit` FORCE RLS; 0 invalid indexes. **Identical to Preview after A5** |
| Integrity (old columns only) | 54/56 tables byte-identical. `JobRun`: the 1 stale `running` row → failed (by design). `_prisma_migrations` 88 → 135 |

## 5. Data convergence: two defects found and fixed (PR #12)

The migrations add event identity, economic date and flow ownership but **populate nothing**. On Production's data, the first audit run after migrating failed 3 REQUIRED invariants (flow-desync, economic-date-persistence, event-identity).

| Finding | Cause | Fix |
|---|---|---|
| All 5,135 rows: `flowType` set, `flowAuthority` NULL (INV-A) | `scripts/backfill-flow-authority.ts` was **deleted in `0f1063f` as a "completed one-shot"**. It had been run on Dev/Preview, **never on Production** | Restored and registered (OPERATIONAL). It refuses unprovable rows: the 50 refusals were stale pre-v5 "income" credits on liability accounts → `repair-liability-income-credits --include-deleted` first (10 live, 40 tombstones) |
| 2,783 / 4,634 events pinned to the **posting** date | `backfill-event-identity --apply` built facts **without `authorizedAt`**. B-6 (`c1036dd`) updated only the dry-run copy. `repair-event-pin-drift` then propagated the wrong pin to rows | One shared builder `lib/transactions/backfill-event-facts.ts` for the dry run and the apply. Regression test with the clone's real case + a control reproducing the defect |
| `backfill-event-identity` found 0 eligible rows | It requires `economicDate`; the economic-date backfill must run first | The sequence below |

**Rehearsed sequence** (from a pristine restore; timings from the final run):

| Step | Duration | Result |
|---|---|---|
| restore | 1.63 s | = live snapshot |
| `npm run db:migrate:safe` (47) | 4.52 s | 135 |
| `repair-liability-income-credits --include-deleted --apply` | 1.07 s | 50 rows reclassified (refund economics; 10 live, 40 tombstones) |
| `backfill-flow-authority --apply` | 3.60 s | 5,085 stamped (+25 crypto ledger) → all 5,135 owned |
| `backfill-economic-date --apply` | 7.29 s | 5,135 (3 contradictory → posting fallback) |
| `backfill-event-identity --apply` (fixed) | 20.76 s | 4,634 events / 5,110 observations (25 crypto rows out of scope by design) |
| `repair-event-pin-drift --apply` | 1.05 s | 35 pending-chain rows re-pinned |
| re-run checks (pin drift, projection drift, economic date, flow authority) | ~3 s | **0** remaining in each |
| **Data steps total** | **≈ 35 s** | — |

## 6. Post-migration audits, RLS and compatibility

| Check | Result |
|---|---|
| `npm run audit:ci` on the migrated, converged clone | **27/28 REQUIRED pass**. The 28th, `audit-schema-drift`, needs a superuser (known); run as the container superuser it is **clean (0 drift statements)** |
| `rls:accept` (`RLS_TARGET_URL`, a template copy of the converged clone) | **37/37**, incl. "missing `app.user_id` fails closed". The other 5 suites seed their own DBs (pass in CI on v2.6) |
| **Old app** (Production code `9ea5881` build) on the migrated, converged clone, as `postgres` | health ok; login 401/200; dashboard 200; **4,538** transactions in the busiest Production Space (Σ first 200 = $41,169.49); malformed Bearer 307; 0 server errors ⇒ **migrate-then-deploy is safe** |
| **v2.6 in Production mode** (`VERCEL_ENV=production`, `FM_RLS_STRICT=true`, 3 role URLs) on the clone | Boots (strict); health ok with the `scheduler` block (real Production last-dispatch); login; dashboard 200; **4,513** transactions, **all with event identity + economic date**. Difference vs old = **25 crypto-wallet rows, Σ $0.22** (excluded from banking reads by design; Σ first 200 = $41,169.27 = old − $0.22); 0 server errors |

## 7. Failure and recovery drill (fresh restore)

| Step | Result |
|---|---|
| Inject a duplicate Plaid external id on a second account (what `20261004000000`'s unique index forbids) | injected |
| `db:migrate:safe` | **Failed at exactly `20261004000000`** (P3018 / 23505) after 28 earlier migrations applied; that migration recorded unfinished; **no partial effect** (index absent) |
| Blind re-run | **Refused (P3009)** |
| Recovery: remove the bad row → `prisma migrate resolve --rolled-back` → re-run | **135 applied, 0 unfinished, 4 s** |
| Lesson | A mid-sequence failure leaves an intermediate, consistent schema. The old app tolerates every intermediate state; **v2.6 must not deploy until 135 + the data steps are complete** |

**Incident during the drill (contained):**
- A scripting error ran `npx prisma` outside the worktree, and npx downloaded `prisma@8.0.0-rc.26` into the npx cache.
- No database was contacted: no schema in that directory, and the process was killed while still installing.
- The cache entry was removed.
- The drill now refuses to run outside the worktree and uses only the repo's pinned `node_modules/.bin/prisma`.

## 8. Measured times (for the cutover window)

| Phase | Measured |
|---|---|
| Production backup (`pg_dump` via pooler) | **86 s** |
| Local restore (PG 17.6) | **1.1–1.6 s** |
| Migrations (47) | **0.36 s** execution; **4.5–6 s** via `db:migrate:safe` |
| Data convergence (5 scripts) | **≈ 35 s** |
| Audits (`audit:ci`) | 41 s |
| **Expected cutover database phase** | **≈ 3 minutes** (backup + migrate + data steps + checks), excluding network latency to Supabase (the steps run over the pooler, not locally; allow 2–3×) |

**Recovery limits:**
- A real recovery restores into a new Supabase project or in place: RTO is minutes, not measured on Supabase.
- RPO = the pre-cutover dump (C1). Writes after it are lost on a data restore.
- PITR is off.

## 9. Evidence (private, `~/fm-rehearsal-private/prod/`, 700/600, 4.6 MB)

- The dump + SHA-256.
- Live, restored, pre/post and final fingerprints; catalogs.
- Logs: `migrate.log`, `rehearsal-run.log`, `backfill.log`, `audit-ci*.log`, `rls-accept.log`, `drill.log`.
- `compat-old.json` / `compat-new.json`, `timings.txt`.

The redundant plain-SQL copies written by the migrate guard on the clone were removed (`rm -P`). The primary dump is kept. Delete after the cutover.
