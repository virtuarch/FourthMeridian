# 20261103140000_db010_auditlog_append_only — review notes (DB-010 / PRIV-005)

**Design (authority).** `docs/operations/database-safety.md` §4e.

**Purpose.** Make `AuditLog` append-only at the database for the runtime operator role
`fm_system`. Before this migration `fm_system` held `SELECT, INSERT, UPDATE, DELETE` and one
`FOR ALL` policy (`fm_system_all`, `20261002000100_rls_roles_and_policies` lines 592 / 598), so
any operator route or job could rewrite or delete audit history.

**Statements.**

1. `REVOKE UPDATE, DELETE` on `AuditLog` from `fm_system`.
2. `GRANT UPDATE ("ipAddress", "userAgent", "metadata")` to `fm_system` (column grant).
3. `GRANT DELETE` to `fm_system` again, admitted only by `fm_system_retain`.
4. `DROP POLICY fm_system_all`; create `fm_system_sel` (SELECT, true), `fm_system_ins`
   (INSERT, true), `fm_system_minimise` (UPDATE of aged `BETA_ACCESS_REQUESTED` rows, post-image
   must have `ipAddress` and `userAgent` NULL) and `fm_system_retain` (DELETE of product events
   older than 13 months).

`fm_backup`, `fm_app` and `fm_auth` are unchanged. No schema (table or column) change, so no
Prisma schema change and no table rewrite; the DDL takes only the brief catalog locks of
`GRANT` / `REVOKE` / `CREATE POLICY`.

**Runtime writers kept working.** `jobs/data-retention.ts` `runBetaIntakeNetworkMinimisation`
(UPDATE via `updateMany`) and `jobs/product-event-retention.ts` `retainProductEvents` (DELETE via
`deleteMany`). The account purge's `AuditLog.userId` `ON DELETE SET NULL` runs as the table owner.

**Drift pin.** `jobs/auditlog-append-only-policy.test.ts` parses `migration.sql` and asserts the
DELETE policy's action set equals `PRODUCT_EVENT_ACTIONS`, its interval equals
`PRODUCT_EVENT_RETENTION_MONTHS`, and the UPDATE policy's action and interval equal
`BETA_INTAKE_AUDIT_ACTION` and `BETA_INTAKE_NETWORK_DAYS`.

**Proof.** `rls:accept` cases 49–56 (`scripts/rls-acceptance.ts`), run against CI's throwaway
database.

**Apply.** Preview through the guarded `npm run db:migrate:safe` after review; Production follows
the release process. Never `prisma migrate dev`.

## ROLLBACK

One block, run as the migration principal. It restores the pre-migration posture exactly
(table-level `UPDATE, DELETE` for `fm_system` and the single `FOR ALL` policy).

```sql
BEGIN;
REVOKE UPDATE ("ipAddress", "userAgent", "metadata") ON TABLE public."AuditLog" FROM fm_system;
GRANT UPDATE, DELETE ON TABLE public."AuditLog" TO fm_system;
DROP POLICY IF EXISTS fm_system_sel      ON public."AuditLog";
DROP POLICY IF EXISTS fm_system_ins      ON public."AuditLog";
DROP POLICY IF EXISTS fm_system_minimise ON public."AuditLog";
DROP POLICY IF EXISTS fm_system_retain   ON public."AuditLog";
CREATE POLICY fm_system_all ON public."AuditLog" FOR ALL TO fm_system USING (true) WITH CHECK (true);
COMMIT;
```

After a rollback, mark the migration rolled back
(`prisma migrate resolve --rolled-back 20261103140000_db010_auditlog_append_only`) through the
guarded tooling before re-applying any fix.
