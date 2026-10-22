# Migration safety: expand/contract, forward-only, rehearsal, rollback, restore (TEST-008)

**Status:** policy + runbook, 2026-10-22 (remediation Agent F). Steps marked **OWNER** touch a live database or a Vercel project and are executed by the owner; everything else is engineering (ENG). Facts about Production are from `production-cutover-plan.md` §1–2 and `06-DATABASE-RELIABILITY.md` (DB-008); nothing below has been run against Production.

## 1. The rules

1. **Forward-only.** There are 0 down migrations across 126 and there will be none: a migration is reverted by a *new* migration that reverses it, never by editing or deleting an applied one. `prisma migrate resolve --rolled-back` is for a migration that *failed mid-way* (Postgres rolled it back), not for undoing an applied one.
2. **Expand / contract, two releases apart.** Any change the running app would notice is split:
   - **Expand (release N):** add the new table / nullable-or-defaulted column / index / enum value; deploy code that writes both old and new shapes (or reads the new with a fallback). The old app must keep working on the new schema — this is what lets the schema be applied *while the old deployment serves* (cutover plan §2 verdict).
   - **Contract (release N+1 or later):** once no deployment that could be promoted reads the old shape, drop it. A contract migration is never shipped in the same release as the code change that made it safe.
   - Never in one step: renaming a column, changing a type, adding `NOT NULL` to a populated column, removing an enum value, dropping a table the previous deployment reads.
3. **Data-dependent constraints are preflighted.** A migration that can `RAISE` on existing rows (`SET NOT NULL`, `CHECK`, unique index) ships with a read-only SQL preflight that counts violators, run on a clone and on the target before `migrate deploy` (cutover plan §1 "Data preflight": null `financialAccountId` 0, bad `MerchantRule` scope 0, duplicate PLAID identities 0).
4. **Enum values are additive and deferred.** An old Prisma client throws on an unknown enum value in a row it reads, so a new value is written only after the code that knows it is promoted (cutover plan §2 #31: seed the `MERCHANT_OPS` Space *after* promotion).
5. **Names are `<YYYYMMDDHHMMSS>_<slug>`**, unique and monotone (`scripts/audit-migration-names.ts`, REQUIRED in CI). The 24 legacy date-only names are a closed allowlist. Let `prisma migrate dev --create-only` name the directory.
6. **One mechanism.** `npm run db:migrate:safe` = `scripts/db-guard.ts --mode=migrate-deploy` (target identity) → `npm run db:backup` → `prisma migrate deploy`. Raw `npx prisma migrate …` bypasses the guard and the backup and is not used on any database that matters. `prisma migrate dev` is for the local dev database only and is refused non-interactively (the 2026-09-15 reset).
7. **Deploys do not migrate.** `build` is `prisma generate && next build`. The schema is applied by a person, before promotion, and verified by `npm run db:drift` (read-only) — `release-checklist.md` §3.

## 2. Rehearsing `prisma migrate deploy` on a clone (ENG; OWNER supplies the dump)

Goal: prove the pending set applies cleanly from the *target's actual state and rows*, not from empty (CI already proves empty → head).

```sh
# 1. A throwaway Postgres matching the target major (Production is PG 17.6; CI is 16 — use 17 here).
docker run -d --name fm-rehearsal -e POSTGRES_USER=fm -e POSTGRES_PASSWORD=fm \
  -e POSTGRES_DB=fintracker_rehearsal -p 127.0.0.1:0:5432 postgres:17
PORT=$(docker port fm-rehearsal 5432/tcp | head -1 | awk -F: '{print $NF}')
export DATABASE_URL="postgresql://fm:fm@127.0.0.1:$PORT/fintracker_rehearsal?schema=public" DIRECT_URL="$DATABASE_URL"
export FM_DB_GUARD=clone-only     # lib/db/live-guard.ts: the database name must classify NON_LIVE

# 2. Restore the OWNER-provided dump (pg_dump of the target taken as fm_backup / postgres).
#    PG 18 pg_dump output needs `SET transaction_timeout` filtered for a 16/17 server.
grep -v '^SET transaction_timeout' /path/to/target-dump.sql | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q

# 3. Drift before: must show exactly the pending set, nothing unknown.
npm run db:drift            # scripts/check-schema-drift.ts, read-only

# 4. Apply exactly as production will, through the guarded path.
npm run db:migrate:safe     # guard → backup (of the clone) → prisma migrate deploy

# 5. Prove the result.
npm run db:drift                                   # 0 pending
npm run audit:ci                                   # REQUIRED invariants on the rehearsed rows
RLS_TARGET_URL="$DATABASE_URL" npm run rls:accept  # 37 cases incl. the GRANT/POLICY census
# any data backfill that accompanies the set, dry-run then --apply, then its audit

# 6. Record (see §5) and destroy.
docker rm -f -v fm-rehearsal
```

A failure at step 4 is a finding against the migration, fixed by a new migration or a preflight — never by editing the applied history. A failure at step 5 is a finding against the code.

## 3. Rollback plan

| Situation | Action | Why it is safe |
|---|---|---|
| Migration failed mid-way on the target | Postgres rolled the statement batch back; `prisma migrate resolve --rolled-back <name>` after reading the error; fix forward with a corrected migration | `_prisma_migrations` records the failure; nothing partial is left (one transaction per migration) |
| Schema applied, new app misbehaves | **Redeploy the previous build** (`vercel promote <previous deployment>`); the schema stays — it is additive by rule 2 | the old app never selects unknown columns; new tables are invisible to it |
| Schema applied, data looks wrong | Stop writes if needed (maintenance), restore the **pre-migration backup** taken by `db:migrate:safe` (or the Supabase PITR point — §4) into a clone first, diff, then decide | a restore is only ever rehearsed on a clone before it touches the target |
| A contract migration shipped too early | New migration re-adding the dropped shape, backfilled from the backup | forward-only; the backup is the source |
| Need to "undo" an applied migration | Write the reverse as a new migration | no down migrations exist; hand-editing history desyncs every environment |

Hard constraints from the cutover plan (§9): never `DISABLE ROW LEVEL SECURITY`; never hand-revert a policy migration; promoting the pre-cutover deployment re-opens the shared-`NEXTAUTH_SECRET` defect and is for total outage only.

## 4. PITR / restore verification (OWNER)

Supabase Micro provides daily backups; PITR is an add-on — **UNVERIFIED** whether it is enabled on `fourth-meridian-production` (`qirfzvvaeddukjiphims`). The owner checks Database → Backups and records the answer. Either way, a backup that has never been restored is a hope, so:

1. Before any Production migration: note the newest Supabase backup time (or PITR recovery window) and take the application dump (`pg_dump` over the session pooler, as in cutover plan §5 A1; sha256 recorded).
2. Restore that dump into a clone (§2 step 2) and run `npm run db:drift` + one read-only count per core table (users, financial accounts, transactions) against the live numbers from the same minute. Equal counts = the dump is complete.
3. Keep the record (§5). The timed version of this — RPO/RTO measured — is `backup-restore-verification.md`.

## 5. The record to keep (per rehearsal / per Production migration)

One row appended to the release ticket and mirrored in STATUS §3 for a Production run:

| Field | Example |
|---|---|
| Date / operator | 2026-10-2x, owner |
| Target | clone of `qirfzvvaeddukjiphims` dump `production-…-pre-v26-<ts>.sql` sha256 `…` (or Production itself) |
| Migrations before → after | 88 → 126 applied, 0 unfinished, 0 rolled back |
| Preflight counts | null `financialAccountId` 0 / `MerchantRule` scope 0 / PLAID dupes 0 |
| Drift | `npm run db:drift` exit 0 after |
| Audits | `audit:ci` PASS (n audits), `rls:accept` 37/37 |
| Backfills | `backfill-economic-date` dry-run n rows → applied n |
| Duration | `migrate deploy` wall time |
| Anomalies | none / text |

## 6. Where this is enforced

- Naming: `scripts/audit-migration-names.ts` (REQUIRED tier, every CI run).
- Apply-from-empty: `ci.yml` `architecture` job (`prisma migrate deploy` + seed + audits + RLS suites).
- Target identity + backup-before-migrate: `scripts/db-guard.ts`, `scripts/db-backup.ts` (`npm run db:migrate:safe`).
- Drift before promotion: `npm run db:drift` — a manual OWNER step in `release-checklist.md` §3.
- Not enforced (owner-accepted, TEST-008): old-app-on-new-schema compatibility is asserted by review of the migration class table (cutover plan §2), not by running the old build against the rehearsed clone. Doing so is possible (`vercel build` of the previous SHA pointed at the clone) and is the next step if the beta grows past five users.
