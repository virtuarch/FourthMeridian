-- ============================================================================
-- PROPOSED Production diagnostic access for B1 preflight (2026-11-01)
-- STATUS: AWAITING OWNER APPROVAL. Nothing in this file has been run.
--
-- Where:    Supabase dashboard → Production project → SQL editor. This is the
--           owner's authenticated Chrome session; no credentials leave the
--           dashboard.
-- Purpose:  run ONLY the four read-only verification queries Q1–Q4
--           (PRE-BETA-READINESS-SESSION2-2026-11-01.md §9), as a restricted
--           role, then revoke.
-- Role:     fm_diag_ro_b1. NOLOGIN (no password exists, so nothing can sign in
--           as it), NOBYPASSRLS, no superuser/createdb/createrole/replication.
--           The dashboard's postgres user assumes it only inside a READ ONLY
--           transaction (SET LOCAL ROLE).
-- Columns:  Q1  BetaAccessRequest: status, decidedAt, invitedAt,
--               inviteTokenHash (IS NOT NULL test only), redeemedAt, createdAt.
--               No email, note, IP or user agent.
--           Q2  PlatformSetting rows registration_mode,
--               require_totp_system_admin, AI-paused and kill keys only.
--           Q3  system catalogs (readable by any role) plus _prisma_migrations
--               names and timestamps.
--           Q4  User.deletionScheduledAt only; JobRun jobName, status,
--               startedAt.
-- Lifetime: created, used and dropped in one sitting (target < 30 min).
-- ============================================================================

-- Session 2 independent review: APPROVE WITH 4 REQUIRED CHANGES. All four are
-- applied below.
--   (1) Q3's grants line now uses aclexplode over pg_class.relacl. The fix is
--       in PRE-BETA-READINESS-SESSION2 §9: information_schema only shows
--       grants the current role takes part in, so as this role it reads 0.
--   (2) Read-only pre-checks (step 0).
--   (3) SET LOCAL ROLE only, inside BEGIN…COMMIT; check that the SQL editor
--       actually shows results.
--   (4) PG15+/16 role membership note.

-- ── 0. PRE-CHECKS (read-only, run as the dashboard user, before step 1) ─────
-- a. Table owners and RLS state. CREATE POLICY requires the table owner.
-- SELECT relname, pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname IN ('BetaAccessRequest','PlatformSetting','User','JobRun','_prisma_migrations');
-- b. Existing policies. A RESTRICTIVE policy on PUBLIC would be ANDed with
--    ours and silently undercount.
-- SELECT tablename, policyname, permissive, roles FROM pg_policies
--   WHERE tablename IN ('BetaAccessRequest','PlatformSetting','User','JobRun');
-- c. Record the schema ACL BEFORE the grant, for the step-4 comparison.
-- SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public';
-- d. The editor shows results and the session starts clean.
-- SELECT current_user, current_setting('transaction_read_only');

-- ── 1. GRANT (one transaction) ──────────────────────────────────────────────
-- PG15+/16: if GRANT … TO postgres errors because the creator already holds
-- membership, the transaction rolls back cleanly. Re-run without that line;
-- the creator can already SET ROLE to it.
BEGIN;
CREATE ROLE fm_diag_ro_b1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT fm_diag_ro_b1 TO postgres;                -- lets the dashboard user SET LOCAL ROLE to it
GRANT USAGE ON SCHEMA public TO fm_diag_ro_b1;
GRANT SELECT (status, "decidedAt", "invitedAt", "inviteTokenHash", "redeemedAt", "createdAt") ON "BetaAccessRequest" TO fm_diag_ro_b1;
GRANT SELECT (key, value, "updatedAt") ON "PlatformSetting" TO fm_diag_ro_b1;
GRANT SELECT ("deletionScheduledAt") ON "User" TO fm_diag_ro_b1;
GRANT SELECT ("jobName", status, "startedAt") ON "JobRun" TO fm_diag_ro_b1;
GRANT SELECT (migration_name, finished_at, rolled_back_at) ON "_prisma_migrations" TO fm_diag_ro_b1;
-- RLS is forced on app tables, so add a SELECT-only policy for this role
-- (PlatformSetting limited to the Q2 keys):
CREATE POLICY fm_diag_ro_b1_sel ON "BetaAccessRequest" FOR SELECT TO fm_diag_ro_b1 USING (true);
CREATE POLICY fm_diag_ro_b1_sel ON "PlatformSetting"   FOR SELECT TO fm_diag_ro_b1
  USING (key IN ('registration_mode', 'require_totp_system_admin') OR key ILIKE '%ai%paused%' OR key ILIKE '%kill%');
CREATE POLICY fm_diag_ro_b1_sel ON "User"              FOR SELECT TO fm_diag_ro_b1 USING (true);
CREATE POLICY fm_diag_ro_b1_sel ON "JobRun"            FOR SELECT TO fm_diag_ro_b1 USING (true);
COMMIT;
-- (If a table has RLS disabled, its CREATE POLICY is harmless; if CREATE
-- POLICY errors, the whole transaction rolls back and nothing is left behind.)

-- ── 2. USE: SET LOCAL ROLE only, never a session SET ROLE ───────────────────
-- A session SET leaked through Supavisor once (Preview, 10-25).
-- Probe first, to confirm the editor shows the result of the final SELECT:
-- BEGIN; SET LOCAL ROLE fm_diag_ro_b1; SET TRANSACTION READ ONLY;
--   SELECT current_user, current_setting('transaction_read_only');   -- expect fm_diag_ro_b1 | on
-- ROLLBACK;
-- Then run each of Q1–Q4 (verbatim from PRE-BETA-READINESS-SESSION2 §9) as:
-- BEGIN; SET LOCAL ROLE fm_diag_ro_b1; SET TRANSACTION READ ONLY; <Qn>
-- ROLLBACK;   -- read-only anyway; ROLLBACK keeps the result visible in the editor
-- After the last query: SELECT current_user;   -- expect postgres (no leaked role)

-- ── 3. REVOKE (one transaction, same sitting) ───────────────────────────────
BEGIN;
DROP POLICY IF EXISTS fm_diag_ro_b1_sel ON "BetaAccessRequest";
DROP POLICY IF EXISTS fm_diag_ro_b1_sel ON "PlatformSetting";
DROP POLICY IF EXISTS fm_diag_ro_b1_sel ON "User";
DROP POLICY IF EXISTS fm_diag_ro_b1_sel ON "JobRun";
REVOKE ALL ON "BetaAccessRequest", "PlatformSetting", "User", "JobRun", "_prisma_migrations" FROM fm_diag_ro_b1;
REVOKE USAGE ON SCHEMA public FROM fm_diag_ro_b1;
REVOKE fm_diag_ro_b1 FROM postgres;
DROP ROLE fm_diag_ro_b1;
COMMIT;

-- ── 4. VERIFY REVOKED ───────────────────────────────────────────────────────
-- SELECT count(*) FROM pg_roles WHERE rolname = 'fm_diag_ro_b1';                 -- expect 0
-- SELECT count(*) FROM pg_policies WHERE policyname = 'fm_diag_ro_b1_sel';      -- expect 0
-- SELECT nspacl FROM pg_namespace WHERE nspname = 'public';                     -- expect identical to pre-check 0c
-- SELECT count(*) FROM pg_auth_members WHERE roleid NOT IN (SELECT oid FROM pg_roles);  -- expect 0
