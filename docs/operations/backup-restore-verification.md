# Backup and restore verification: the timed rehearsal (G0 · owner-executed)

**Status:** procedure, 2026-10-22 (remediation Agent F). Every step here is **OWNER** unless marked ENG, because every step reads a live database's credentials or its dump. The G0 gate (`12-BETA-RELEASE-PLAN.md` §1) requires "restore rehearsal record with RPO/RTO in `docs/operations/`": the record template is §6 and the filled record is appended to this file.

## 1. Definitions used here

- **RPO** (recovery point objective): how much data can be lost — the age of the newest restorable backup at the moment of failure. Measured, not promised: `now − backup timestamp`.
- **RTO** (recovery time objective): how long until the app serves again from a restore. Measured as the wall time of §4 from "decision to restore" to "health 200 + login works".
- **Scratch database:** a throwaway Postgres that holds the restore. Never the target, never the dev database.

## 2. The roles and the backup credential

Migration `20261002000100_rls_roles_and_policies` creates `fm_backup` as `LOGIN BYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER` **with no password**: it exists so a dump can bypass RLS (a dump as `fm_app` is silently partial — `rls-acceptance.ts` case 29 proves it), and it cannot authenticate until a password is set. It appears in no Vercel variable and never will.

**Setting the `fm_backup` password (OWNER, once per environment, over the session pooler as `postgres`):**

```sql
-- generate locally: openssl rand -hex 24 ; never paste the value into chat or a ticket
ALTER ROLE fm_backup WITH LOGIN PASSWORD '<value>';
ALTER ROLE fm_backup SET statement_timeout = 0;          -- a dump is long-running by nature
ALTER ROLE fm_backup SET idle_in_transaction_session_timeout = '15s';
```

Store the value in the owner's password manager under "FM <env> fm_backup". Rotate it after every rehearsal that used it from a laptop (`ALTER ROLE fm_backup WITH PASSWORD '<new>'`). To disable the role between uses: `ALTER ROLE fm_backup NOLOGIN;` (re-enable with `LOGIN`).

Verify the role shape before trusting a dump taken with it:

```sql
SELECT rolname, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin
  FROM pg_roles WHERE rolname = 'fm_backup';
-- expect: t, f, f, f, t
```

## 3. Taking the dump (OWNER)

```sh
# Session pooler (port 5432 on Supabase; the transaction pooler cannot run pg_dump).
export PGPASSWORD='<fm_backup password from the password manager>'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump "postgresql://fm_backup@<host>:5432/postgres?sslmode=require" \
  --no-owner --no-privileges --format=plain \
  --file "backups/<env>-${STAMP}.sql"
unset PGPASSWORD
shasum -a 256 "backups/<env>-${STAMP}.sql" | tee "backups/<env>-${STAMP}.sql.sha256"
```

- `--no-owner --no-privileges`: the clone restores under one role; grants and RLS policies are re-created by the migrations, not by the dump (the dump carries tables, rows, indexes, constraints and the `_prisma_migrations` ledger).
- `backups/` is gitignored (`.gitignore`), and the **local-dump policy** (§7) applies from the moment the file exists.
- A PG 18 `pg_dump` against a 16/17 server emits `SET transaction_timeout`; filter it on restore (below).

## 4. The timed restore rehearsal (OWNER; ENG may drive the commands with the owner present)

Start the clock at T0 = the decision to restore.

```sh
T0=$(date -u +%s)

# 1. Scratch database, same major as the target (Production is PG 17.6).
docker run -d --name fm-restore -e POSTGRES_USER=fm -e POSTGRES_PASSWORD=fm \
  -e POSTGRES_DB=fintracker_restore -p 127.0.0.1:0:5432 postgres:17
PORT=$(docker port fm-restore 5432/tcp | head -1 | awk -F: '{print $NF}')
SCRATCH="postgresql://fm:fm@127.0.0.1:$PORT/fintracker_restore"
until docker exec fm-restore pg_isready -U fm -d fintracker_restore >/dev/null 2>&1; do sleep 1; done

# 2. Integrity of the file, then restore (ON_ERROR_STOP: a partial restore is a failed restore).
shasum -a 256 -c "backups/<env>-<STAMP>.sql.sha256"
grep -v '^SET transaction_timeout' "backups/<env>-<STAMP>.sql" | psql "$SCRATCH" -v ON_ERROR_STOP=1 -q
T_RESTORED=$(date -u +%s)

# 3. What the dump does and does not restore (see database-safety §4c):
#    - Policies, RLS flags and the _prisma_migrations ledger ARE in the dump (restored above).
#    - Roles are cluster-level and are NEVER in a dump: the four roles must exist on the
#      scratch BEFORE the restore, or the policy statements fail.
#    - GRANTs are NOT in the dump (--no-privileges). Because the ledger is at head, replaying
#      migrations does NOT re-grant: the runtime roles fail closed ("permission denied") until
#      grants are re-established. Re-grant from a freshly migrated reference database
#      (IMPLEMENTED for clones; CI proof: rls:accept cases 38-41):
#        REGRANT_REFERENCE_URL=<empty DB with migrations applied> \
#        REGRANT_TARGET_URL="$SCRATCH" npm run db:regrant            # dry run: missing / extra
#        REGRANT_REFERENCE_URL=... REGRANT_TARGET_URL="$SCRATCH" npm run db:regrant -- --apply
#      Any EXTRA privilege it reports is a finding; record it before choosing --revoke-extra.
#    The drift check below proves only that the ledger is at head:
export DATABASE_URL="$SCRATCH?schema=public" DIRECT_URL="$DATABASE_URL" FM_DB_GUARD=clone-only
npm run db:drift                      # expect: 0 pending, 0 unknown
#    If the target predates the RLS migrations (Production today), apply them here:
#    npm run db:migrate:safe

# 4. Completeness: the same read-only counts on the scratch and on the source, same minute.
for t in '"User"' '"FinancialAccount"' '"Transaction"' '"PlaidItem"' '"Space"'; do
  echo -n "$t scratch="; psql "$SCRATCH" -Atc "select count(*) from $t";
done
#    Source counts: run the same SELECTs as fm_backup (BYPASSRLS) on the source. Equal = complete.

# 5. The app boots against the scratch (ENG): a local `next start` with the three role URLs
#    pointing at the scratch (passwords set with ALTER ROLE on the scratch), FM_RLS_STRICT=true.
#    Pass = GET /api/health → {"status":"ok"} and one real login (the owner's test user) + TOTP.
T_SERVING=$(date -u +%s)

echo "restore: $((T_RESTORED - T0)) s; serving: $((T_SERVING - T0)) s"
docker rm -f -v fm-restore
```

**RPO** = T0 − (dump timestamp, or the Supabase backup / PITR point you would actually use). **RTO** = `T_SERVING − T0`.

A rehearsal is **PASSED** when: sha256 matches, restore ran with `ON_ERROR_STOP` and exited 0, drift is 0, every count matches, health is `ok`, one login succeeds. Anything else is FAILED and the cause is a finding before cutover.

### 4.1 Before a restored database serves traffic: re-apply retention (Platform AI conversations, B11)

**Rule (S2, OD-7 activation (b)).** After restoring any environment that holds the B11 tables (`PlatformAiConversation`, `PlatformAiMessage`), run the purge, by dispatch or by the job, **BEFORE the app or any flag is enabled**, and **record the counts**.

A restore brings back rows that retention had already removed as of the backup point:
- messages more than 90 days old (per message, from creation; OD-7);
- conversations an operator deleted (`docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md` §7.3).

On a target without the B11 migration, step 1 reports the functions as absent and this section does not apply.

1. **Prove the purge can see the rows.**
   - A `--no-owner` restore re-owns the two `SECURITY DEFINER` functions to the restoring role. Under FORCE RLS, a definer whose owner lacks BYPASSRLS deletes 0 rows **silently**.
   - Run the read-only pre-enable check against the restored target: `npm run report:platform-ai-conversations-precheck -- --env=local` for a scratch database.
   - On FAIL, the functions must be re-owned to a BYPASSRLS principal before you go on. That is an **OWNER** step.
2. **Purge until nothing more is removed, before the app or flags are enabled.**
   - **Scratch, local or Preview-shaped target:** run `npm run ops:platform-ai-conversations-purge -- --env=local` (or `--env=preview`). Repeat while it prints "more remain".
   - **A target that is or will become Production:** the manual dispatch always refuses Production, and the purge runs only as the scheduled `purge-trash` job (07:30 UTC). **OWNER-GATED GAP:** there is no on-demand Production trigger for that job today (`/api/jobs/dispatch?only=` admits `comms-automations` only). Until the owner decides how to provide one, hold traffic (deny-all firewall or maintenance), keep the conversations flag **off**, and do not open the app until one `purge-trash` run has succeeded against the restored database. This PR deliberately adds no Production dispatch.
3. **Record** the counts in the §6 row's notes: `conversations removed` and `messages removed` from the dispatch output, or the `PLATFORM_AI_CONVERSATIONS_PURGED` audit row / the `purge-trash` JobRun summary. Keep the counts in the record, not in this file's prose.

**Rehearsed:** `npm run rls:accept:ai-conversations` cases 79–81 run this exact sequence on throwaway databases only (never Preview or Production):
- a `pg_dump` "backup";
- the source purges its expired exchange;
- a `--no-owner` `pg_restore` into a second database brings the exchange back;
- the pre-enable check against the restored copy PASSES;
- the dispatch against the restored copy removes the exchange, and its audit row records the counts.

**Backups themselves still hold the rows** until the provider's retention removes them: "removed from backups within M days" is **pending OWNER-VERIFY (OD-9)**. Copies held by the AI provider are governed by the provider's terms. Our purge does not reach them, and no document may claim it does.

## 5. Supabase-side backups (OWNER, read-only)

Dashboard → Database → Backups: record the plan's backup cadence, the newest backup time, and whether PITR is enabled (UNVERIFIED as of this document). If PITR is enabled, the rehearsal can additionally restore to a point in time into a **new** Supabase project (never in place) and run §4 steps 3–5 against it; record it as a second row in §6.

## 6. The record (append below; one row per rehearsal)

| Date (UTC) | Env | Dump timestamp | sha256 (first 16) | PG major src→scratch | Restore s | Serving s | **RPO** | **RTO** | Counts equal? | Health/login | Result | Operator |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 05:43–05:47 | preview (ledger 146) | 2026-11-03T05:43:46Z | not recorded (dump `rm -P`'d after the run) | 17 → 17 (local throwaway) | 1 | — (no app boot) | ≈ 0 (fresh read-only snapshot) | ≈ 3 min to a regranted, readable clone: dump 174 s · start PG 2 s · reference migrate 2 s · restore 1 s · `db:regrant` 2 s | dump verified row-for-row by `db:backup`; 89/89 public tables restored | fm_app read OK after regrant; app boot + `/api/health` **not run** | **PARTIAL PASS** — see notes | Session 2 |

**2026-11-03 Preview rehearsal notes (Session 2).** Restore of the `--no-privileges` dump into a vanilla PostgreSQL 17: 3 errors, all Supabase-platform (`supabase_vault` extension, `vault.secrets`), none in `public`. Before regrant the runtime role was refused (`permission denied for table Instrument`), confirming the gap; `db:regrant` dry run reported **680 missing, 0 extra**; `--apply` ran 680 GRANTs in one transaction, re-diff **0 / 0**, and fm_app read the table. `rls:accept` against the restored clone: 36/38 — the two failures (cases 28/38) are an artefact of restoring a *Supabase* dump into a non-Supabase server (the restored `auth` schema is not dumpable by `fm_backup`), not of the regrant. Not yet done: app boot + `/api/health` against the clone (needs a production build in the heavy slot), and a restore into a Supabase-shaped target. Nothing was written to Preview.

The first PASSED row for `production` closes the G0 line item "restore rehearsal record with RPO/RTO".

## 7. Local-dump policy (OWNER)

A dump of Preview or Production holds real people's financial records. From the moment it exists on a laptop:

1. **Encrypt at rest or delete within 24 h.** Encrypt with `age` or `gpg` to the owner's key (`gpg --symmetric --cipher-algo AES256 backups/<file>.sql && shred -u backups/<file>.sql`, or `age -p`); keep only the `.gpg`/`.age` and the `.sha256`.
2. **Never** copy a dump into a chat, a ticket, a cloud drive, a worktree other than `backups/`, or a container image. `backups/` and `tmp/` are gitignored and excluded from typecheck/lint, which keeps them out of the tree but not off the disk.
3. The 2026-10-16 incident is the reference: throwaway containers leaked 751 anonymous volumes (43 GB) of restored data; every scratch database is removed with `docker rm -f -v`, and `docker volume ls -qf dangling=true` is checked after a rehearsal.
4. Rotate `fm_backup`'s password after a rehearsal that used it from a laptop (§2).
5. A dev-database backup (`npm run db:backup`, local only) is covered by the same rule: the dev database holds real Plaid test connections.
