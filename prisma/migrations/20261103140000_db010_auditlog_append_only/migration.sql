-- DB-010 / PRIV-005 — AuditLog append-only at the database (one additive migration)
--
-- Design (authority): docs/operations/database-safety.md §4e.
--
-- THE GAP. fm_app is already append-only on AuditLog (SELECT + INSERT) and
-- fm_auth may only INSERT, but fm_system held SELECT, INSERT, UPDATE, DELETE and
-- one FOR ALL policy (20261002000100_rls_roles_and_policies, lines 592 / 598).
-- Every operator route and job runs as fm_system, so any of them could rewrite
-- or delete audit history.
--
-- THE FIX. Keep the table grants, narrow them by column, and replace
-- fm_system_all with one policy per command whose predicates are EXACTLY the
-- runtime inventory:
--   * UPDATE — jobs/data-retention.ts runBetaIntakeNetworkMinimisation:
--       ipAddress → NULL, userAgent → NULL, metadata rewritten, on
--       action = BETA_INTAKE_AUDIT_ACTION rows older than BETA_INTAKE_NETWORK_DAYS.
--   * DELETE — jobs/product-event-retention.ts retainProductEvents:
--       action IN PRODUCT_EVENT_ACTIONS rows older than PRODUCT_EVENT_RETENTION_MONTHS.
--
-- ⚠️ THE ACTION LIST AND BOTH INTERVALS ARE DUPLICATED FROM CODE.
-- jobs/auditlog-append-only-policy.test.ts parses this file and pins them to
-- PRODUCT_EVENT_ACTIONS (lib/audit-actions.ts), PRODUCT_EVENT_RETENTION_MONTHS
-- (jobs/product-event-retention.ts), BETA_INTAKE_AUDIT_ACTION and
-- BETA_INTAKE_NETWORK_DAYS (jobs/data-retention.ts). Changing a constant fails
-- CI until a follow-up migration moves the policy with it.
--
-- UNCHANGED
--   * fm_backup (SELECT, BYPASSRLS), fm_app (fm_app_sel / fm_app_ins) and
--     fm_auth (fm_auth_ins) — no statement below names them.
--   * AuditLog.userId FK ON DELETE SET NULL (account purge): referential actions
--     run as the table owner, bypassing RLS and column privileges.
--   * Owner-run scripts (scrub-audit-emails, scrub-activity-account-names,
--     dev-reset-test-state) run as the migration principal — the documented,
--     owner-only break-glass path.
--
-- BOUNDARIES. The jobs compute their cutoff in UTC arithmetic; the policies use
-- now() - interval. Both mean "older than"; the policy is the outer bound. A row
-- the job selects but the policy rejects is simply not changed (count 0) — the
-- jobs use updateMany / deleteMany, which report counts and never throw on 0.
--
-- PROOF: rls:accept cases 49–56 (scripts/rls-acceptance.ts).
-- ROLLBACK: README.md in this folder.

-- 1. No table-wide UPDATE / DELETE for the runtime operator role.
REVOKE UPDATE, DELETE ON TABLE public."AuditLog" FROM fm_system;

-- 2. UPDATE only the three minimisation columns. action, userId, spaceId,
--    createdAt, performedByAdminId and id become immutable to the runtime.
GRANT UPDATE ("ipAddress", "userAgent", "metadata") ON TABLE public."AuditLog" TO fm_system;

-- 3. DELETE is re-granted, admitted only by fm_system_retain below.
GRANT DELETE ON TABLE public."AuditLog" TO fm_system;

-- 4. One policy per command.
DROP POLICY fm_system_all ON public."AuditLog";

CREATE POLICY fm_system_sel ON public."AuditLog" FOR SELECT TO fm_system USING (true);

CREATE POLICY fm_system_ins ON public."AuditLog" FOR INSERT TO fm_system WITH CHECK (true);

-- The post-image must be minimised.
CREATE POLICY fm_system_minimise ON public."AuditLog" FOR UPDATE TO fm_system
  USING (action = 'BETA_ACCESS_REQUESTED' AND "createdAt" < now() - interval '90 days')
  WITH CHECK ("ipAddress" IS NULL AND "userAgent" IS NULL);

CREATE POLICY fm_system_retain ON public."AuditLog" FOR DELETE TO fm_system
  USING (
    action IN (
      'SESSION_ACTIVE_DAY',
      'SPACE_VIEWED',
      'BRIEF_VIEWED',
      'TRANSACTIONS_VIEWED',
      'MANUAL_ASSET_VALUE_UPDATED',
      'CONNECTION_LINK_STARTED',
      'CONNECTION_LINK_EXITED',
      'FIRST_SYNC_SUCCEEDED',
      'AI_TURN_FAILED'
    )
    AND "createdAt" < now() - interval '13 months'
  );
