# Database Safety Protocol

**Status:** BINDING — for every developer and every agent working in this repo.
**Origin:** a destructive Prisma workflow (`migrate diff` with the live DB passed as the shadow, then `migrate reset`) wiped the local database, destroying un-seeded personal state. This protocol exists so that cannot happen by accident again.

---

## 0. The one rule

**The local database is NOT disposable.** It is a personal development environment that holds **real test data** — a real operator account, connected **Plaid** accounts, real sync history, and manually created Spaces/configuration. **`prisma db seed` does NOT recreate any of that.** Treat this DB as valuable, backed-up state, exactly like a small production DB.

---

## 1. Prohibited without an explicit, backed-up opt-in

Never run these against a database that might hold personal/shared/production data:

| Command | Why it's dangerous |
|---|---|
| `prisma migrate reset` | **DROPs and recreates the schema** — total data loss, seed only restores seed users. |
| `prisma migrate dev` | On drift/failed migration it **offers to reset** — one keystroke from data loss. |
| `prisma db push --force-reset` | Force-resets the schema. |
| `prisma migrate diff --shadow-database-url <URL>` where `<URL>` is the **live DB** | `migrate diff --from-migrations` **RESETS the shadow DB** to replay migrations. Passing the live DB as the shadow wipes it. **This was the actual incident.** |

Do **not** invoke these raw. Use the safe scripts below.

---

## 2. Safe workflow (use these, always)

```
backup  →  migrate  →  verify
```

| Command | What it does |
|---|---|
| `npm run db:backup` | Timestamped `pg_dump` of the **mutation target** (`DIRECT_URL`, which Prisma Migrate uses — see §2a) → `backups/<db>-<iso>.sql` (gitignored). Refuses when `DATABASE_URL`/`DIRECT_URL` are not provably one database. Fails loudly on an empty/partial dump (row-for-row, in the dump's own snapshot — see below). Restore: see §4. |
| `npm run db:migrate:safe` | `db-guard --mode=migrate-deploy` (target identity) → `db:backup` → `prisma migrate deploy` — applies pending migrations **additively** (never resets). This is the normal way to apply a new migration to your dev DB. |
| `npm run db:migrate` | Routed through `db-guard --mode=migrate-dev` **+ backup** first. **Refuses a non-interactive shell** against a populated (or unreachable) database — on 2026-09-15 a bare `prisma migrate dev` run by an agent session with drift pending reset the dev DB before Prisma's own interactivity refusal printed. From a real terminal it proceeds and Prisma prompts you. |
| `npm run db:reset` | Routed through `db-guard` **+ backup** first. Refuses unless `ALLOW_DESTRUCTIVE_DB=true`; for a target that is **not a recognised clone** (`fintracker`, `postgres`, anything off the `fintracker_<suffix>` convention) it additionally requires a human at a real terminal to **type the exact `host/database`** — the env flag alone may be left exported from an earlier command. A backup of the same database is taken before the reset. |

The **guard** (`scripts/db-guard.ts`, run by every destructive or schema-mutating script) refuses unless **all** of:
1. **Target identity (every mode).** The database Prisma Migrate will actually mutate is resolved the way Prisma resolves it — `DIRECT_URL` (schema.prisma declares `directUrl = env("DIRECT_URL")`) — and `DATABASE_URL` and `DIRECT_URL` must be **provably the same logical database** (§2a). A split, an unprovable pairing, or a missing `DIRECT_URL` is refused before anything is probed, backed up or mutated.
2. **Shadow distinct (every mode).** `SHADOW_DATABASE_URL`, if set, must be provably a *different* database from both.
3. **Clone-only (when armed).** With `FM_DB_GUARD=clone-only`, the target must be a `fintracker_<suffix>` clone.
4. **Mode gate.** reset: `ALLOW_DESTRUCTIVE_DB=true` (+ typed target for non-clones). migrate-dev: a TTY when the target is populated or unknown. migrate-deploy: nothing further (additive).

So the *only* way to reset is a conscious, backed-up act:
```bash
npm run db:backup                                  # if you want a manual one first
ALLOW_DESTRUCTIVE_DB=true npm run db:reset          # backs up the same target, then resets
```

**Row-for-row verification is snapshot-consistent (2026-11-01).** `db:backup` holds one `REPEATABLE READ, READ ONLY` transaction for the whole backup, exports its snapshot, runs `pg_dump --snapshot=<id>`, and only then counts each public table inside that same transaction, comparing with the dump's COPY blocks (a missing block or a short table is a hard failure). Counts are therefore taken in the dump's own snapshot: a live database with crons writing verifies exactly, and no cron pause is needed. The held transaction disables `idle_in_transaction_session_timeout` with `SET LOCAL` (fm_backup's role setting is 15 s). It requires a **session-mode** connection (Supabase `:5432` / `DIRECT_URL`); a transaction pooler (`:6543`) or any snapshot export/import failure fails the backup with that instruction — it never falls back to comparing against live counts (the 2026-11-01 B1 failure: JobRun 27147 → 27148 → 27149 live vs the dump). Mechanism: `scripts/lib/db-backup.core.ts`; tests: `scripts/db-backup.test.ts`.

### 2a. One command, one database (FM-AUDIT-002)

Until 2026-09-21 the guard and the backup read `DATABASE_URL` while Prisma Migrate connected through `DIRECT_URL`. With the two split — which the old clone recipe produced, since it rewrote `DATABASE_URL` only — the guard approved and backed up the **clone** and Prisma reset **live**. The invariant now enforced by `lib/db/target-identity.ts`:

> A supported command never validates or backs up database A and then mutates database B.

"The same logical database" means equal identity keys:

| Family | Identity | Example pair that is the SAME |
|---|---|---|
| local (loopback) | port + database name | `localhost:5432/fintracker_x` ≡ `127.0.0.1/fintracker_x` |
| Supabase | project ref + database name | pooled `<role>.<ref>@<pooler-host>:6543/postgres` ≡ direct `<direct-host-for-ref>:5432/postgres` |
| any other host | exact host + port + database name | — |

Anything not provably the same (two unknown hosts that might be a pooler and its primary) is refused. `db:wipe` checks the same authority before its inventory, backup and Plaid teardown.

---

## 3. Authoring a NEW migration safely

Generating a migration needs a **shadow** database to compute the diff. **Never use the dev DB as the shadow.**

- Set `SHADOW_DATABASE_URL` to a **throwaway** database (a separate empty DB / a disposable container), or
- Add the field to `schema.prisma`, then `npm run db:migrate:safe` (which runs `migrate deploy` — additive, non-destructive), letting a proper migration be authored against a throwaway shadow.

The guard refuses if it ever sees `SHADOW_DATABASE_URL === DATABASE_URL`.

---

## 3a. Migration policy — forward-only, expand/contract

Status markers: **IMPLEMENTED** (enforced in code/CI) · **DECIDED BUT NOT IMPLEMENTED** · **PROPOSED** · **DEPRECATED**.

1. **Forward-only — IMPLEMENTED (no down migrations exist).** A migration is reverted by a *new* migration that reverses it, never by editing or deleting an applied one (applied migrations are checksummed). `prisma migrate resolve --rolled-back` is only for a migration that **failed mid-way** (Postgres rolled it back), not for undoing an applied one.
2. **Expand / contract, two releases apart — DECIDED (review discipline, not mechanically enforced).**
   - *Expand (release N):* add the new table / nullable-or-defaulted column / index / enum value, and ship code that tolerates both shapes. The old app must keep working on the new schema — that is what allows the schema to be applied while the old deployment serves.
   - *Contract (release N+1 or later):* drop the old shape only once no promotable deployment reads it. Never in the same release as the code that made it safe.
   - Never in one step: rename a column, change a type, add `NOT NULL` to a populated column, remove an enum value, drop a table the previous deployment reads.
3. **Data-dependent constraints are preflighted.** A migration that can `RAISE` on existing rows (`SET NOT NULL`, `CHECK`, unique index) ships with a read-only SQL preflight that counts violators, run on a clone and on the target before deploy.
4. **Enum values are written only after the code that knows them is promoted** — an old Prisma client throws on an unknown enum value in a row it reads.
5. **Names are `<YYYYMMDDHHMMSS>_<slug>`, unique and monotone — IMPLEMENTED** (`scripts/audit-migration-names.ts`, REQUIRED tier in CI; legacy date-only names are a closed allowlist). Let `prisma migrate dev --create-only` name the directory (on a throwaway database, §3).
6. **One mechanism — IMPLEMENTED.** `npm run db:migrate:safe` = `scripts/db-guard.ts --mode=migrate-deploy` → `npm run db:backup` → `prisma migrate deploy` (`package.json`). Raw `npx prisma migrate …` bypasses the guard and the backup and is not used on any database that matters. `prisma migrate dev` is local-only and refused non-interactively against a populated database (§2).
7. **Deploys do not migrate — IMPLEMENTED.** `build` is `prisma generate && next build`. The schema is applied by a person before promotion and verified with `npm run db:drift` (read-only, `scripts/check-schema-drift.ts`) — [release-checklist.md](release-checklist.md) §3. A policy migration that lands before the code that sets the tenant identity makes protected tables return **zero rows silently**, so order matters.
8. **Every new table is classified for RLS in the migration that creates it — IMPLEMENTED.** `scripts/migration-rls-census.test.ts` replays every migration and fails if any table ends up without `ENABLE` + `FORCE ROW LEVEL SECURITY` outside its closed exception list. Default privileges grant new tables to nobody. See [SECURITY_MODEL §Database-level tenant isolation](../architecture/SECURITY_MODEL.md#database-level-tenant-isolation-row-level-security).

## 3b. Rehearsal, rollback and restore verification

**Rehearse on a clone of the target's real rows (CI already proves empty → head).**
Throwaway Postgres of the **target's major version**, `FM_DB_GUARD=clone-only`, both `DATABASE_URL` and `DIRECT_URL` pointed at it, restore the owner-supplied dump (filter `SET transaction_timeout` for an older server, §4), then:

```sh
npm run db:drift            # before: exactly the pending set, nothing unknown
npm run db:migrate:safe     # guard → backup (of the clone) → migrate deploy
npm run db:drift            # after: 0 pending
npm run audit:ci            # REQUIRED invariants on the rehearsed rows
RLS_TARGET_URL="$DATABASE_URL" npm run rls:accept   # incl. the GRANT/POLICY census
# any accompanying backfill: dry-run, then --apply, then its audit
docker rm -f -v <container>  # -v: never leak the volume
```

A failure while applying is a finding against the migration (fix with a new migration or a preflight, never by editing history); a failure afterwards is a finding against the code.

**Rollback plan.**

| Situation | Action |
|---|---|
| Migration failed mid-way | Read the error and check what actually applied (a migration is atomic only if its SQL is one transaction); `prisma migrate resolve --rolled-back <name>`; fix forward with a corrected migration |
| Schema applied, new app misbehaves | Redeploy/promote the previous build; the schema stays (additive by rule 2) |
| Schema applied, data looks wrong | Stop writes if needed (maintenance mode); restore the pre-migration backup **into a clone first**, diff, then decide |
| A contract migration shipped too early | New migration re-adding the shape, backfilled from the backup |
| "Undo" an applied migration | Write the reverse as a new migration |

Hard constraints: **never `DISABLE ROW LEVEL SECURITY`** as a recovery lever (a broken policy that over-denies is safe; removing isolation is a security incident and needs the app offline), never hand-revert a policy migration, never edit `_prisma_migrations` by hand.

**Restore verification (owner).** A backup that has never been restored is a hope. Before any Production migration: note the provider's newest backup / PITR window, take the application dump over a **session-mode** connection, restore it into a clone, and compare per-table counts with the source. The timed procedure and its record live in [backup-restore-verification.md](backup-restore-verification.md).

**Record per rehearsal / Production migration** (release ticket): date and operator, target and dump checksum, migrations before → after (0 unfinished, 0 rolled back), preflight counts, `db:drift` result, `audit:ci` and `rls:accept` results, backfill dry-run/applied counts, `migrate deploy` wall time, anomalies.

**Not enforced (owner-accepted):** old-app-on-new-schema compatibility is asserted by review of the migration class, not by running the previous build against the rehearsed clone — PROPOSED as the next step if the beta grows.

---

## 4. Recovery process (if data is lost anyway)

1. **Check `backups/`** first — restore the newest good dump:

   ```bash
   # ⚠️ pg_dump 18 → PG 16. The host tools are 18.x; the server in docker-compose
   # is postgres:16-alpine. A pg_dump 18 file emits `SET transaction_timeout = 0;`
   # (a PG17+ GUC) near line 13, which a PG16 server rejects — so with
   # ON_ERROR_STOP the restore aborts before creating anything.
   grep -v '^SET transaction_timeout = 0;$' backups/<file>.sql \
     | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
   ```

   Verify by diffing per-table `count(*)` against the source before trusting it.
2. No backup? The **Plaid data is not truly lost** — Plaid is the upstream source of truth. Re-registering the account and reconnecting institutions re-imports transaction history (see the reconstruction flow). What's lost and must be rebuilt: the user row, platform grants, Space configuration, and any manual/CSV accounts.
3. Restore the operator account through the **normal product lifecycle** (register → login → MFA), then re-grant platform access via the SYSTEM_ADMIN grant surface — never by injecting a user row.

---

## 4a. Clones, and the guard that makes them mandatory

**Live is exactly `fintracker`. Every disposable copy is `fintracker_<suffix>`.**
That convention is not a style preference — it is the predicate
`lib/db/live-guard.ts` classifies on, because live and every clone share a
byte-identical host, port, user and password. The database NAME is the whole of
the difference.

Cut a clone:

```bash
createdb fintracker_<program>                      # base clone
pg_dump fintracker | psql -q fintracker_<program>
createdb -T fintracker_<program> fintracker_<program>_a   # per-agent copies
```

`createdb -T` is a file-level copy and needs no other session connected to the
TEMPLATE — which is why the per-agent copies are templated off the base clone and
never off `fintracker`.

**Point EVERY mutation-capable URL at the clone, and arm the guard for anything write-capable:**

```bash
FM_DB_GUARD=clone-only \
  DATABASE_URL="postgresql://…/fintracker_<program>_a" \
  DIRECT_URL="postgresql://…/fintracker_<program>_a" \
  npm run <script>
```

`DIRECT_URL` is not optional: it is what `prisma migrate …` connects to. A clone
recipe that rewrites only `DATABASE_URL` leaves Migrate pointed at live — the
db-guard now refuses that split outright (§2a), but a worktree `.env.local` must
still be rewritten for **both** variables.

Armed, `lib/db.ts` refuses — before a client exists — any database it cannot
identify as a clone. Unset, it is inert, so `npm run ai:chat` and the `audit:*`
scripts still reach live deliberately.

> ⚠️ **An EXPORTED `DATABASE_URL` BEATS `--env-file`.** Node's `--env-file` fills
> blanks and never overrides. Five of seven post-M1 agent worktrees wrote to LIVE
> through exactly this: each had a clone URL in its own `.env.local` and inherited
> the parent shell's live one anyway. Check `printenv DATABASE_URL` before blaming
> the file. Setting up a worktree means **rewriting its `.env.local` to its clone**,
> not instructing an agent to remember to export something.

## 4b. Pooled connections: never a session-level `SET` (2026-10-25 incident)

**What happened (Preview, 2026-10-25).**
1. During the `develop` migration, an operator credential check ran `SET default_transaction_read_only=on` as a **standalone statement** through the Supavisor **transaction pooler** (`:6543`), once each as `fm_app`, `fm_auth` and `fm_system`.
2. In transaction-pooling mode, a session-level `SET` **stays on the server connection** after the client disconnects, and the pooler hands that connection to the next client using the same role: the application.
3. Read-only traffic (health probes, scheduler reads) kept the `fm_system` connection alive for 37 minutes. The first write transaction on it was the AI allowance reservation's `rateLimit.upsert`, which failed with Postgres `25006 cannot execute INSERT in a read-only transaction`.
4. Conversations and the Daily Brief returned 503 "allowance couldn't be checked". The gate failed closed, so nothing was written and no provider was called.
5. The fault cleared when the connection recycled.

Evidence: [`docs/plans/PREVIEW-AI-FAILURE-AND-CONVERSATION-PERSISTENCE-2026-10-26.md`](../plans/PREVIEW-AI-FAILURE-AND-CONVERSATION-PERSISTENCE-2026-10-26.md) §1.

**The rule.** Against any pooled Postgres (Supabase `:6543` *and* `:5432` pooler hosts), and **especially** with an application role:

| Never | Instead |
|---|---|
| `SET default_transaction_read_only = on` (or any `SET name = …` / `SET SESSION …`) | `BEGIN READ ONLY;` … `COMMIT;`, or `SET TRANSACTION READ ONLY` as the first statement of an explicit transaction |
| `SET statement_timeout = …` | `SET LOCAL statement_timeout = …` inside the transaction |
| `RESET …`, `set_config(name, value, false)` | `set_config(name, value, true)` (transaction-local; this is what `lib/db/tenant-context.ts` does) |
| `psql -c "SET …" -c "select …"` (each `-c` is its own transaction) | For a one-off: `psql -1` (single transaction) with `SET TRANSACTION READ ONLY` as the first command. Preferred: [`scripts/db-readonly-psql.sh`](../../scripts/db-readonly-psql.sh). Everything runs in one `BEGIN … SET TRANSACTION READ ONLY` transaction that **ends in ROLLBACK**, provided nothing in the input ends it early; the input scan refuses every known way to do that. A remote run requires `DIAG_REQUIRE_ROLE`, a database-side guard that refuses any role able to write, own objects, reach server files or programs, or run unexpected SECURITY DEFINER functions. Those two are the real barriers. On top of them, a best-effort input scan refuses before connecting: statements not starting with SELECT/WITH/VALUES/TABLE/SHOW/EXPLAIN/SET LOCAL, session-level `SET`/`RESET`, `set_config`, SQL-in-a-string executors, meta-commands other than `\echo`/`\qecho`/`\pset`, `:var` interpolation, `$`, control bytes, extra psql arguments, CR, and local, loopback-resolving or redirected URLs. The checked address is pinned with `hostaddr`. The password reaches psql only through a private 0600 pgpass file, and psql runs under `env -i` |

Use `SHOW name` to read a setting; it changes nothing.

**Guards in the repository.**
- `scripts/db-session-set-guard.test.ts` fails CI if application code, scripts or jobs issue a session-level `SET`, `RESET` or `set_config(…, false)` through Prisma raw SQL.
- The same test pins the wrapper's transaction scoping and its refusals.

**If `25006` appears on a primary** (`select pg_is_in_recovery()` is `false`) and no role setting explains it (`pg_db_role_setting`), suspect a leaked session setting. Compare `pg_stat_activity.backend_start` for the role against recent operator activity. Recycled connections clear it. Don't change roles or pooler settings to "fix" it.

---

## 4c. Database roles, RLS and backups — operational rules

The role and policy model is specified in [SECURITY_MODEL §Database-level tenant isolation](../architecture/SECURITY_MODEL.md#database-level-tenant-isolation-row-level-security). What it means for anyone touching a database:

- **Two principals, one database — IMPLEMENTED.** `DIRECT_URL` (migrations) authenticates as the migration principal; the runtime authenticates as `fm_app` / `fm_auth` / `fm_system` through `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM`. `lib/db/target-identity.ts` keys identity on host/port/project/database and ignores the username, so the guard's "same database" verdict still holds. Do not weaken the guard to accommodate the role split.
- **Strict mode in Production — IMPLEMENTED** (`lib/db/strict-mode.ts`): a Production process refuses to boot without `FM_RLS_STRICT=true` and valid role URLs. Outside strict mode the role clients silently fall back to the migration principal, which bypasses RLS — check `activeDbRoles()` / the Platform db-authority report, never assume.
- **Role credentials are set out of band.** Migrations create the roles without passwords; the owner sets them with `ALTER ROLE … PASSWORD` and stores them in the owner's password manager. `fm_backup` never appears in Vercel.
- **Backups run as `fm_backup` (`BYPASSRLS`) — IMPLEMENTED** (`scripts/lib/db-backup.core.ts`). A dump taken as an RLS-subject role is **silently partial**; the row-for-row check in §2 is what catches it. `fm_backup` also needs `SELECT` grants (`BYPASSRLS` skips policies, not privileges).
- **What a dump carries.** `db:backup` uses `--no-owner --no-privileges`: the dump carries tables, rows, RLS flags, policies and the `_prisma_migrations` ledger, but **no GRANTs**, and roles are cluster-level so they are never in a dump. A restore target must have the four roles before the policies restore, and table grants must be re-established before the runtime roles can read (fails closed: `permission denied`). Replaying migrations does not re-grant, because the restored ledger is already at head; re-grant with `npm run db:regrant` (`scripts/db-regrant.ts`, pure core `scripts/lib/acl-core.ts`): it diffs the restore against a freshly migrated reference database and GRANTs what is missing (dry run by default; extra privileges are reported as findings) — **IMPLEMENTED for clones**, proven in CI by `rls:accept` cases 38–41 (restore → permission denied → regrant → exact match → fm_app reads). Running it against a hosted Production restore is owner-gated ([backup-restore-verification §4](backup-restore-verification.md), step 3). Never trust a restored database until `RLS_TARGET_URL=<clone> npm run rls:accept` passes against it.
- **A wipe removes isolation until migrations re-run — IMPLEMENTED behaviour.** `scripts/db-wipe.ts` runs `DROP SCHEMA public CASCADE`, which drops policies, grants and RLS flags with the tables; re-apply with `npm run db:migrate:safe` (the RLS migrations are idempotent about roles).
- **CI proves isolation as the runtime role — IMPLEMENTED.** `.github/workflows/ci.yml` runs `rls:accept`, `rls:accept:app`, `rls:accept:ai`, `rls:accept:plaid`, `rls:accept:foreground` and `rls:accept:allowance` against the throwaway database, connecting as `fm_app` rather than the container superuser every other step uses.
- **`prisma studio` and `prisma db seed` run as the migration principal** and therefore bypass RLS. Use them only on local clones.
- **Diagnostic access to hosted databases** uses a read-only role and the wrapper in §4b, never an application role and never a session-level `SET`.

## 4e. `AuditLog` append-only at the database (DB-010 / PRIV-005) — PLANNED

**Status: PLANNED (design, 2026-11-03).** Not implemented. The pre-beta register deferred it as "needs migration + design"; this section is the design. A builder implements it as one additive migration; it is applied to Preview through the guarded `db:migrate:safe` step, and Production follows the release process.

**The gap (verified on `develop`).** `fm_app` is already append-only on `AuditLog` (INSERT plus a scoped SELECT, no UPDATE or DELETE), and `fm_auth` can only INSERT. But `fm_system` has `SELECT, INSERT, UPDATE, DELETE` and one `FOR ALL` policy (`20261002000100_rls_roles_and_policies`, lines 592 and 598). Every operator route and job runs as `fm_system`, so any one of them can rewrite or delete audit history. Today only application discipline prevents it.

**What legitimately changes an `AuditLog` row** (complete inventory from a source sweep of `app/`, `lib/`, `jobs/` and `scripts/`):

| Writer | Role | Change | Rows |
|---|---|---|---|
| `jobs/data-retention.ts` `runBetaIntakeNetworkMinimisation` | `fm_system` | UPDATE `ipAddress`→NULL, `userAgent`→NULL, `metadata` (adds `uaFamily`, `networkDigest`, `networkMinimisedAt`) | `action = 'BETA_ACCESS_REQUESTED'`, older than 90 days |
| `jobs/product-event-retention.ts` `retainProductEvents` | `fm_system` | DELETE | `action IN PRODUCT_EVENT_ACTIONS`, older than 13 calendar months |
| Account purge: `AuditLog.userId` FK `ON DELETE SET NULL` | referential action | `userId`→NULL | the deleted user's rows |
| `scripts/scrub-audit-emails.ts`, `scripts/scrub-activity-account-names.ts`, `scripts/dev-reset-test-state.ts` | migration principal (owner-run) | metadata scrub / delete | owner-run one-offs; not runtime |

Nothing else in runtime code updates or deletes an audit row.

**Design.** Keep the table grants. Narrow them by column, and replace `fm_system_all` with one policy per command whose predicates are exactly the inventory above:

1. `REVOKE UPDATE, DELETE ON public."AuditLog" FROM fm_system;`
2. `GRANT UPDATE ("ipAddress", "userAgent", "metadata") ON public."AuditLog" TO fm_system;`. A column grant: `action`, `userId`, `spaceId`, `createdAt`, `performedByAdminId` and `id` become immutable to the runtime.
3. `GRANT DELETE ON public."AuditLog" TO fm_system;` is re-granted, but only so the DELETE policy below can admit the retention rows.
4. `DROP POLICY fm_system_all ON public."AuditLog";`, then:
   - `fm_system_sel` FOR SELECT USING (true)
   - `fm_system_ins` FOR INSERT WITH CHECK (true)
   - `fm_system_minimise` FOR UPDATE USING (`action = 'BETA_ACCESS_REQUESTED' AND "createdAt" < now() - interval '90 days'`) WITH CHECK (`"ipAddress" IS NULL AND "userAgent" IS NULL`). The post-image must be minimised.
   - `fm_system_retain` FOR DELETE USING (`action IN (<PRODUCT_EVENT_ACTIONS>) AND "createdAt" < now() - interval '13 months'`)
5. `fm_backup` keeps SELECT, and `fm_app` / `fm_auth` are unchanged.

Notes:

- **The FK `SET NULL` keeps working.** Referential actions run as the table owner and bypass RLS and column privileges, so the purge needs no grant.
- **The owner scripts run as the migration principal**, so they are unaffected. That is the documented break-glass path, and it stays owner-run.
- **The SQL lists must not drift from the code.** The action list and both intervals are duplicated in SQL, so pin them. A unit test parses the migration and asserts the DELETE policy's action set equals `PRODUCT_EVENT_ACTIONS`, the 13-month interval equals `PRODUCT_EVENT_RETENTION_MONTHS`, and the UPDATE predicate's action and 90 days equal `BETA_INTAKE_AUDIT_ACTION` and `BETA_INTAKE_NETWORK_DAYS`. A later change to either constant then fails CI until a follow-up migration moves the policy with it.
- **The window boundaries differ slightly.** The job's `createdAt < cutoff` is computed in UTC calendar arithmetic, while the policy uses `now() - interval`. Both are "older than"; the policy is the outer bound. A row the job selects that the policy rejects is simply not updated (`count` 0), never an error. The job already uses `updateMany`/`deleteMany`, which report counts.

**Residual risk (accepted, stated):**

- **`metadata` is still writable on the aged beta-intake rows** inside the UPDATE policy. That is a narrow window: one action, 90 days or older.
- **`fm_system` can still DELETE product events past 13 months.** That is the retention the privacy policy promises.
- **The migration principal can do anything.** That is true of every table; see SEC-003.

**`rls:accept` cases (next free numbers, 49–56)**, run as each role against the throwaway database:

| # | Role | Probe | Expect |
|---|---|---|---|
| 49 | `fm_system` | UPDATE `action` (or `userId`, `createdAt`) on any row | permission denied (column grant) |
| 50 | `fm_system` | UPDATE `metadata` on a fresh, non-intake row | 0 rows (policy), the row unchanged |
| 51 | `fm_system` | UPDATE `ipAddress`→NULL, `userAgent`→NULL on a 91-day-old `BETA_ACCESS_REQUESTED` row | 1 row |
| 52 | `fm_system` | UPDATE that same aged row leaving `ipAddress` non-null | rejected by WITH CHECK |
| 53 | `fm_system` | DELETE a fresh `SESSION_ACTIVE_DAY` row, and any 14-month-old **non**-product-event row (e.g. `LOGIN`) | 0 rows each |
| 54 | `fm_system` | DELETE a 14-month-old `SESSION_ACTIVE_DAY` row | 1 row |
| 55 | `fm_app` / `fm_auth` | UPDATE or DELETE any row | permission denied (unchanged; regression) |
| 56 | migration principal | DELETE a `User` with audit rows | the rows survive with `userId` NULL (FK path still works) |

**Tests beside the migration:**

- the constant-to-SQL pin above;
- `jobs/data-retention.test.ts` and `jobs/product-event-retention.test.ts` unchanged and green;
- the purge census (`lib/account-deletion/purge-census.test.ts`) still classifies `AuditLog.userId` as NULL via the FK.

**Rollback:** one statement block. Re-grant `UPDATE, DELETE` to `fm_system`, drop the four policies, and recreate `fm_system_all` with `USING (true) WITH CHECK (true)`. Write it into the migration folder's README before applying.

**Proposed extension (not migrated):** a wider network-identifier minimisation of `AuditLog` (IP and user agent on security rows) needs an additive second UPDATE policy plus a metadata guard trigger. The design and SQL are in `docs/operations/data-retention.md`, "Network identifiers". It is an OWNER DECISION and needs S2 review.

---

## 5. For agents specifically

- Never run a destructive Prisma command as a step in a task. If a schema change needs applying, use `npm run db:migrate:safe`.
- Anything write-capable — a test, an eval, a model harness — runs with
  `FM_DB_GUARD=clone-only` against a `fintracker_<suffix>` clone (both `DATABASE_URL` and `DIRECT_URL`).
  ⚠️ The runtime guard is ARMED by that variable and inert without it — a script that
  does not set it is protected only by convention. The destructive npm scripts
  (`db:reset`, `db:migrate`, `db:migrate:safe`, `db:backup`, `db:wipe`) check target
  identity whether or not it is set.
- Withholding a tool is **not** isolation — but durable MEMORY is now closed by default
  (FM-AUDIT-019, `lib/ai/conversation/memory-write-policy.ts`): `remember` and the silent
  `project_cash` checkpoint write only when the turn's context carries `memoryWrites: true`,
  which only the product chat route sets. The `ai:*` harnesses are read-only for memory unless
  `FM_AI_MEMORY_WRITES=clone-only` is set AND the target is a clone (opting in against live is
  refused before anything runs); checks whose purpose is writing memory rows refuse anything
  but a clone. `lib/ai/invocation.ts` still writes an `AiInvocation` row on every model call,
  so a harness still writes usage rows to whatever database it is pointed at.
- Never pass `$DATABASE_URL` as `--shadow-database-url`.
- Take `npm run db:backup` before anything schema-touching.
- Diagnose pooled databases with `scripts/db-readonly-psql.sh` (or `psql -1` with `SET TRANSACTION READ ONLY` / `BEGIN READ ONLY`); never issue a session-level `SET` through a pooler (§4b).
- Never run raw `npx prisma migrate …` against a shared database; never `DISABLE ROW LEVEL SECURITY` (§3a, §3b).
- If unsure whether an operation is destructive, stop and ask.

---

*Sources consolidated (deleted; recover with `git log -- <path>`):*
`docs/operations/migration-safety.md` ·
`docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md` ·
`docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md` ·
`docs/plans/RLS-SILENT-REFUSAL-CAS.md`.
