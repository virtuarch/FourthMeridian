# Production: revoke CREATE on schema `public` (A + B) — PROPOSED, NOT EXECUTED

Owner approved A+B in principle (2026-10-31), subject to final dependency verification. Execution needs the owner's separate go.

## Verified read-only on Production, 2026-10-31

- Schema `public` ACL: `{postgres=UC/postgres,=UC/postgres,anon=UC/postgres,authenticated=UC/postgres,service_role=UC/postgres,fm_app=U/postgres,fm_auth=U/postgres,fm_system=U/postgres,fm_backup=U/postgres}`. This is unchanged since the first check.
- Objects in `public` not owned by `postgres`: 0. That covers tables, views, sequences, functions and types. Migrations run as `postgres`.
- Default privileges in `public`: only `postgres:r:{fm_backup=r/postgres}`, which is table SELECT for backups and is unaffected.
- `anon`, `authenticated` and `service_role` hold no table privileges in `public`.
- No realtime publication covers `public`. `pg_cron` is not installed. No extensions live in `public`.
- Connected roles at check time: `authenticator`, `postgres`, `pgbouncer`, `supabase_admin`, `fm_system`. None of these depends on CREATE in `public`; the app roles hold USAGE only, via their own grants.
- Last applied migration: `20261022001000_db008_provider_capability_index_name`.

## Change (run as `postgres` in the Supabase SQL editor, in one transaction)

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
-- A: nobody inherits CREATE through PUBLIC any more
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- B: Supabase API roles lose CREATE (Preview parity); USAGE is kept
REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;
COMMIT;
```

This changes only the schema's ACL. It takes no table locks and touches no data. USAGE is kept for everyone who had it.

## Verification, immediately after

```sql
SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public';
-- expect: {postgres=UC/postgres,=U/postgres,anon=U/postgres,authenticated=U/postgres,service_role=U/postgres,fm_app=U/postgres,fm_auth=U/postgres,fm_system=U/postgres,fm_backup=U/postgres}
SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND has_schema_privilege(oid, 'public', 'CREATE') ORDER BY 1;
-- expect exactly: postgres, supabase_admin
```

Then re-run `prod-diag-role-precheck.sql`. Row 7 must read `USAGE`. After that, check app health: Production `/api/health` returns 200, and a signed-in page loads.

## Rollback (restores the exact prior ACL)

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
GRANT CREATE ON SCHEMA public TO PUBLIC;
GRANT CREATE ON SCHEMA public TO anon, authenticated, service_role;
COMMIT;
```

Running these as `postgres` re-creates the same `…=UC/postgres` entries.
