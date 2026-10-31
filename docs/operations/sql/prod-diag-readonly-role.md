# Production read-only diagnostic role, `fm_diag_ro` (EXECUTED AND RETIRED 2026-10-31)

**Status.** The owner approved this on 2026-10-31. The role was created per §2, with the helper pinned at `8320dc3`, and it was used for one masked, read-only investigation. Every run printed `read_only_guard = on` and `read_only_role_guard = verified`. The role was then dropped per §6: afterwards there were 0 roles, 0 policies and 0 sessions. Findings: [docs/plans/BETA-REQUEST-PROD-INVESTIGATION-RESULTS-2026-10-31.md](../../plans/BETA-REQUEST-PROD-INVESTIGATION-RESULTS-2026-10-31.md).

The helper has been hardened since that run, after a third independent review:
- the run ends in ROLLBACK, never COMMIT;
- `DIAG_REQUIRE_ROLE` is mandatory for remote hosts;
- every statement's first word must be on an allowlist;
- the role guard is stricter (§5).

Re-using this document for another run needs the owner's separate approval again. Creating the role is a Production schema/security change.

Owner decision 6 (2026-10-31) asked for the exact SQL, privileges, security review and rollback **before** anything was executed.

Purpose: run `docs/operations/sql/beta-request-prod-investigation.sql` (through `scripts/db-readonly-psql.sh`) with a database-enforced least-privilege, read-only identity, instead of the owner's admin connection.

## 1. Design

| Property | Value | Why |
|---|---|---|
| Login | yes, own password, `VALID UNTIL` = approval + 24 h | dedicated, expiring, individually revocable |
| Superuser, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION | **no** | row-level security and grants apply |
| `default_transaction_read_only` | `on`, at the role level | read-only is enforced by the database, not only by the helper |
| `statement_timeout` / `idle_in_transaction_session_timeout` | 60 s / 60 s | cannot hold locks or run away |
| `CONNECTION LIMIT` | 2 | |
| Schema | `USAGE` on `public` only | |
| Table access | **column-level SELECT** on the 4 tables the query reads, and only the columns it reads | no other table, and no other column (no tokens, no `redeemedUserId`, no `inviteTokenHash`) |
| Row-level security | one `FOR SELECT` policy per table. `AuditLog` is limited to the beta request and decision actions. `RateLimit` is limited to `ip:access-request:%` keys | cannot read other audit history or other limiter keys |
| Functions, sequences, write privileges | none | |

## 2. SQL: create (run as the Supabase `postgres` role, in ONE transaction)

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';   -- CREATE POLICY takes ACCESS EXCLUSIVE on hot tables: never queue behind app traffic (retry on timeout)

-- Role. The password is set ONLY with psql `\password fm_diag_ro` (§4) — never ALTER ROLE … PASSWORD '…' in the SQL editor
-- (the plaintext would land in query history / logs / pg_stat_statements).
-- VALID UNTIL: set to (approval time + 24 h, UTC) when executing — replace the placeholder.
CREATE ROLE fm_diag_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2 VALID UNTIL '<APPROVAL_TIME_PLUS_24H_UTC>';
ALTER ROLE fm_diag_ro SET default_transaction_read_only = on;
ALTER ROLE fm_diag_ro SET statement_timeout = '60s';
ALTER ROLE fm_diag_ro SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public TO fm_diag_ro;

-- Column-level SELECT: exactly the columns the investigation reads.
GRANT SELECT (id, email, status, note, "createdAt", "decidedAt", "redeemedAt") ON public."BetaAccessRequest"      TO fm_diag_ro;
GRANT SELECT (email, "receivedAt", source)                                      ON public."BetaAccessRequestEvent" TO fm_diag_ro;
GRANT SELECT (action, metadata, "ipAddress", "userAgent", "createdAt")          ON public."AuditLog"               TO fm_diag_ro;
GRANT SELECT (key, count)                                                       ON public."RateLimit"              TO fm_diag_ro;

-- Row-level security (all four tables FORCE RLS; without a policy this role sees zero rows).
CREATE POLICY fm_diag_ro_sel ON public."BetaAccessRequest"      FOR SELECT TO fm_diag_ro USING (true);
CREATE POLICY fm_diag_ro_sel ON public."BetaAccessRequestEvent" FOR SELECT TO fm_diag_ro USING (true);
CREATE POLICY fm_diag_ro_sel ON public."AuditLog"               FOR SELECT TO fm_diag_ro
  USING (action IN ('BETA_ACCESS_REQUESTED','BETA_ACCESS_APPROVED','BETA_ACCESS_DENIED',
                    'BETA_INVITATION_CREATED','BETA_INVITATION_RESENT','BETA_INVITATION_REVOKED'));
CREATE POLICY fm_diag_ro_sel ON public."RateLimit"              FOR SELECT TO fm_diag_ro USING (key LIKE 'ip:access-request:%');

COMMIT;
```

Before the `CREATE POLICY` lines, check that RLS is enabled on `BetaAccessRequestEvent` and `RateLimit` in Production:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('BetaAccessRequest','BetaAccessRequestEvent','AuditLog','RateLimit');
```

A policy on a table without RLS is harmless, but the column grants still apply.

## 3. Verification after creation (as the owner, read-only)

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolconnlimit, rolvaliduntil, rolconfig FROM pg_roles WHERE rolname = 'fm_diag_ro';
SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'fm_diag_ro' ORDER BY 1,2;
SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE 'fm_diag_ro' = ANY (roles);
SELECT count(*) AS memberships FROM pg_auth_members WHERE member = 'fm_diag_ro'::regrole;   -- expect 0
```

Then, connected **as `fm_diag_ro`**:
1. `SHOW transaction_read_only;` must return `on`.
2. `SELECT 1 FROM "User" LIMIT 1;` must fail with *permission denied*.
3. `SELECT "inviteTokenHash" FROM "BetaAccessRequest" LIMIT 1;` must fail with *permission denied*.
4. `UPDATE "RateLimit" SET count = count WHERE false;` must fail (read-only or permission denied).

## 4. Running the investigation with it

1. **Set the password** (owner, Supabase SQL editor or psql as `postgres`): `\password fm_diag_ro`. Use a generated password and keep it in your password manager.
2. **Build the URL.** Preferred: the DIRECT host
   `postgresql://fm_diag_ro:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require`.
   - The direct host may be IPv6-only unless Supabase's IPv4 add-on is enabled.
   - If it is unreachable, use Supavisor in **session mode** (port 5432) with username `fm_diag_ro.<project-ref>`:
     `postgresql://fm_diag_ro.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres?sslmode=require`.
   - Through the pooler, `CONNECTION LIMIT 2` counts server connections, not clients.
3. **Run** the owner command sequence. Paste the whole block into zsh, from the repository root. It runs in a `( … )` subshell, and a trap unsets the password on exit, Ctrl-C or kill. The password is read by a hidden prompt; it is never echoed and never in a command line. The helper call is ONE line on purpose, with no `\` continuations: a broken continuation would turn the `VAR=…` prefixes into plain shell assignments.
   ```zsh
   (
     trap 'unset DIAG_PW' EXIT INT TERM
     read -rs "DIAG_PW?fm_diag_ro password: "; echo
     DIAG_DATABASE_URL="postgresql://fm_diag_ro:${DIAG_PW}@db.<project-ref>.supabase.co:5432/postgres?sslmode=require" DIAG_REQUIRE_ROLE=fm_diag_ro scripts/db-readonly-psql.sh -f docs/operations/sql/beta-request-prod-investigation.sql
   )
   ```
   - Through the pooler, swap in the session-mode host and the `fm_diag_ro.<project-ref>` user name from step 2.
   - Password characters: generate the password from letters and digits only. Raw `:` `!` `~` and the like work. `@ / ? #` must be percent-encoded (`%40 %2F %3F %23`), and a literal `%` as `%25`. Otherwise the helper refuses the URL without echoing it: an `@` after the host could point the connection somewhere else. The helper splits the password out of the URL and hands it to psql only through a 0600 pgpass file in a private directory, which is removed on exit. psql runs under `env -i` with an allowlisted environment, so the password never appears in `ps`, in an environment, in a trace or in an error. The helper prints the psql binary it resolved (`db-readonly-psql: using psql at …`) before connecting: check that it is the one you expect. It always adds `require_auth=scram-sha-256`. `sslrootcert=` is accepted with `sslmode=verify-full`, and `channel_binding=require` is optional. A literal `%` must be typed as `%25`; a malformed escape is refused without echoing the value.
   - The pgpass file lives in `${TMPDIR:-/tmp}/db-readonly-psql.XXXXXX/` and is removed on normal exit, error, Ctrl-C, HUP and TERM. A `kill -9` cannot be trapped. After one, remove it by hand: `rm -rf "${TMPDIR:-/tmp}"/db-readonly-psql.*`.
   - Run the helper as `scripts/db-readonly-psql.sh`, not `bash scripts/…`. Its `#!/bin/bash -p` shebang ignores `BASH_ENV`/`ENV`, `SHELLOPTS` and functions exported by the calling shell.
   - The host name is resolved first. A name that resolves to loopback or to an unspecified address (`localtest.me`, `*.nip.io`, `*.sslip.io`, a hosts-file entry) is refused, and so is a name that cannot be resolved.
   - Do **not** set `DIAG_ALLOW_LOCAL`. It is a test-only override for the throwaway-container tests and prints a warning.
   - The output must begin with exactly these two results:
     ```
      read_only_guard 
     -----------------
      on
     (1 row)

      read_only_role_guard 
     ----------------------
      verified
     (1 row)
     ```
   - If the role guard refuses, the run stops before the investigation, with `ERROR:  role guard refused: …` naming the reason (the full list is in §5). Nothing ran, so nothing to undo. Stop, and report the message.
   - **PUBLIC grants count.** The guard counts privileges granted to PUBLIC. Production's schema `public` granted CREATE to PUBLIC until 2026-10-31, when change A was executed ([prod-revoke-schema-create.md](prod-revoke-schema-create.md)). Before that, the guard would have refused with `role guard refused: fm_diag_ro has CREATE (via fm_diag_ro) on schema: public`. Precheck rows 12–18 ([prod-diag-role-precheck.sql](prod-diag-role-precheck.sql)) list everything that would trip it, before the role is created.
   - **SECURITY DEFINER allowlist.** A SECURITY DEFINER function runs with its owner's rights, so the guard refuses any that `fm_diag_ro` can EXECUTE in a schema it can USE. There are two exceptions, matched by schema, name and argument types, and only while they are declared `STABLE` or `IMMUTABLE`: `public.fm_visible_space_ids()` and `public.fm_may_join_space(text)`.
     - These are Production's RLS helpers: `LANGUAGE sql STABLE`, read-only SELECTs.
     - Migration `20261006000000_rls_function_execute_least_privilege` already revokes their EXECUTE from PUBLIC. If that holds on Production, `fm_diag_ro` cannot execute them at all, and the allowlist is only a fallback.
     - Revoking EXECUTE from PUBLIC again here would be a Production change outside this scope, so it is not done.
     - Any other reachable SECURITY DEFINER function, or either of these turned VOLATILE, makes the guard refuse. Precheck row 15 lists them.

## 5. Security review

**Can it write?** No. **Writes are prevented by privileges:** the role holds no INSERT/UPDATE/DELETE/TRUNCATE privilege on anything, and its RLS policies are `FOR SELECT` only.

**The real barriers are database-side:**
1. **One explicit transaction, ended by ROLLBACK.** The helper's first command is `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout …`, and its last command is `ROLLBACK`; there is no `psql -1` and no COMMIT. On any error psql stops and the server aborts the transaction. A rolled-back transaction also reverts session-level `set_config`, and the container test proves this.
2. **The role guard,** which is mandatory for every remote run.

The helper's input scan is **best-effort** defence in depth on top of those: a keyword scan cannot see SQL assembled at run time. It allowlists the first word of each statement and refuses known SQL-in-a-string executors, transaction control, `$`, interpolation and meta-commands. The role-level `default_transaction_read_only` is a default the role could override.

The role guard is `DIAG_REQUIRE_ROLE=fm_diag_ro`. It is a plpgsql `DO` block that RAISEs, so Postgres cannot constant-fold it the way it folded the earlier `ELSE (1/0)` form, which could never pass. Every catalog reference is `pg_catalog`-qualified, and `search_path` is pinned to `pg_catalog` while the guard runs. It aborts unless all of the following hold, for this role **and every role it can become** (`pg_has_role … MEMBER`, so inherited or via `SET ROLE`):
- the session is exactly this role;
- not superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION;
- not a member of `pg_write_all_data`, `pg_read_all_data`, `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program`, `pg_signal_backend`, `pg_checkpoint`, `pg_maintain` or `pg_create_subscription`;
- owns no object: none in `pg_shdepend` for this database or shared, and no relation, function, type or schema;
- no INSERT/UPDATE/DELETE/TRUNCATE on any table or column, no USAGE/UPDATE on any sequence, and no ownership of or UPDATE on any large object; also, `lo_compat_privileges` is off;
- no CREATE on any schema or on the database;
- no USAGE on any foreign server, no user mapping for the role or for PUBLIC, and no EXECUTE on any `dblink*` function;
- no EXECUTE on any user-created SECURITY DEFINER function (oid ≥ 16384, `pg_catalog` included) in a schema it can use, except `public.fm_visible_space_ids()` and `public.fm_may_join_space(text)` while they are STABLE or IMMUTABLE (§4).

All of this is proved against a throwaway `postgres:17-alpine` container (Production runs 17.6) by `scripts/db-readonly-psql-container.test.ts`. Precheck rows 12–18 list anything in Production that would trip the guard.

**Can it read beyond the investigation?**
- Only the listed columns of 4 tables.
- Audit rows only for 6 beta actions.
- Limiter rows only for the intake key.
- Raw email, IP and user agent ARE readable by this role, because the investigation computes on them. That exposure is bounded by: the owner holding the only password, a 24-hour expiry, 2 connections, the helper's masked output, and the rollback below.

**Residual risks:**
0. **Masked output can still re-identify people (quasi-identifiers).** No single column contains PII, but a combination can single someone out: created hour, free-mail domain, local-part length bucket, note length, network sharing and submission counts, especially in a small population (20 requests). Treat the masked output as personal data. Share it only with people who need it, don't publish it, and don't join it with other sources.
1. Anyone holding the password could run their own `SELECT email …`. Mitigations: expiry, immediate drop after use, no sharing.
2. The policy and grant DDL is a Production schema change (owner approval).
3. Supabase may log role creation (expected).
4. `ALTER ROLE … SET` settings apply at login and are not session-leakable through the pooler, because they are role-scoped.

**Not given:** BYPASSRLS, `pg_read_all_data`, `pg_read_server_files`, membership in `fm_backup` / `fm_system`, any function EXECUTE beyond PUBLIC's defaults (the guard refuses those it can't allowlist), `CREATE`, foreign servers or user mappings.

## 6. Rollback (one transaction, idempotent)

```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'fm_diag_ro';   -- DROP ROLE does not end open sessions

BEGIN;
SET LOCAL lock_timeout = '3s';
DROP POLICY IF EXISTS fm_diag_ro_sel ON public."BetaAccessRequest";
DROP POLICY IF EXISTS fm_diag_ro_sel ON public."BetaAccessRequestEvent";
DROP POLICY IF EXISTS fm_diag_ro_sel ON public."AuditLog";
DROP POLICY IF EXISTS fm_diag_ro_sel ON public."RateLimit";
REVOKE ALL ON public."BetaAccessRequest", public."BetaAccessRequestEvent", public."AuditLog", public."RateLimit" FROM fm_diag_ro;
REVOKE USAGE ON SCHEMA public FROM fm_diag_ro;
DROP ROLE IF EXISTS fm_diag_ro;
COMMIT;
```

**Recommended:** run the rollback as soon as the investigation output is captured. Expiry happens anyway 24 h after approval. If `DROP ROLE` reports dependencies, run `DROP OWNED BY fm_diag_ro;` and retry. The role owns nothing, so this is not expected.

**Validated on Preview (rolled back, nothing kept):**
- the §2 SQL, the full investigation with only these grants, and the §6 rollback all work;
- the role sees exactly the beta rows (831 other audit rows and 648 other limiter keys are hidden);
- reads of `"User"`, `"inviteTokenHash"`, `SELECT *` and `"userId"` are refused, and an UPDATE or INSERT is refused;
- expiry is enforced through Supavisor as well.

## 7. Approval checklist (owner)

- [ ] Approve the role creation SQL in §2 for Production.
- [ ] Set the password interactively; do not share it.
- [ ] Run the §3 verification checks.
- [ ] Run the investigation and paste the masked output.
- [ ] Run the §6 rollback.
