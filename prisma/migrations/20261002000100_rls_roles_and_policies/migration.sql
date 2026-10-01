-- ─────────────────────────────────────────────────────────────────────────────
-- RLS-1 — TENANT ISOLATION AS A DATABASE BOUNDARY
--
-- Public-beta tenant-isolation gate. Authority:
--   docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md
--
-- OWNER DECISION (§38 Q1): RLS ENFORCES TENANCY ONLY.
-- `SpaceAccountLink.visibilityLevel` is a COLUMN-level redaction tier and stays
-- in application code (lib/account-privacy.ts). A policy that reproduced it
-- would create two authorities for one question. These policies answer exactly
-- one question: "is this row in a Space this identity belongs to?"
--
-- ── WHY THIS IS NOT A CHECKBOX ───────────────────────────────────────────────
-- Before this migration the application connected as a role that both OWNED
-- every table and carried BYPASSRLS. Enabling RLS in that state is a silent
-- no-op. The security property arrives only from the combination:
--     a non-owner, NOBYPASSRLS runtime role  +  ENABLE  +  FORCE  +  policies.
--
-- ── OWNERSHIP, DELIBERATELY UNCHANGED ────────────────────────────────────────
-- The schema owner and migration principal stays as it is (`postgres` on
-- Supabase, the bootstrap superuser locally). Supabase's `postgres` is
-- platform-managed and cannot have BYPASSRLS stripped, so reassigning ownership
-- would buy nothing: BYPASSRLS dominates FORCE. What matters, and what this
-- migration delivers, is that NORMAL APPLICATION RUNTIME STOPS USING IT.
--
-- FORCE ROW LEVEL SECURITY is nevertheless set on every protected table. It is
-- a deliberate no-op against today's BYPASSRLS owner; it exists so the design
-- stays correct if ownership ever moves to a non-BYPASSRLS role, and so that no
-- future owner silently bypasses. This is stated plainly rather than implied.
--
-- ── NO CREDENTIALS HERE ──────────────────────────────────────────────────────
-- Roles are created WITH LOGIN and WITHOUT a password. A LOGIN role with no
-- password cannot authenticate under scram-sha-256, so each role is inert until
-- an operator sets its secret out of band. No credential is ever committed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. ROLES ─────────────────────────────────────────────────────────────────
-- Idempotent: these may already exist in an environment seeded by hand.

DO $$
BEGIN
  -- fm_app — ordinary web requests. Subject to RLS. The whole point.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_app') THEN
    CREATE ROLE fm_app LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  ELSE
    ALTER ROLE fm_app NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;

  -- fm_auth — the PRE-IDENTITY path only. Session validation and credential
  -- lookup must read User/UserSession/RecoveryCode BEFORE any app.user_id can
  -- exist; that is the bootstrap paradox, and it is why fm_app cannot serve it.
  -- Narrowly granted below: three tables, nothing else.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_auth') THEN
    CREATE ROLE fm_auth LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  ELSE
    ALTER ROLE fm_auth NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;

  -- fm_system — cron, webhooks, ingestion, operator consoles. Cross-tenant by
  -- necessity, but NOT via BYPASSRLS: it reaches rows through role-scoped
  -- policies (TO fm_system), so every grant of cross-tenant reach is visible in
  -- pg_policies and reviewable in source control.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_system') THEN
    CREATE ROLE fm_system LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  ELSE
    ALTER ROLE fm_system NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;

  -- fm_backup — pg_dump only. The ONE role in this migration that carries
  -- BYPASSRLS, because a dump that honours RLS is a SILENTLY PARTIAL dump and
  -- the existing backup script's only completeness check is "> 100 bytes".
  -- Never present in application runtime configuration.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_backup') THEN
    CREATE ROLE fm_backup LOGIN BYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  ELSE
    ALTER ROLE fm_backup BYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fm_app, fm_auth, fm_system, fm_backup;

-- ── 2. IDENTITY ──────────────────────────────────────────────────────────────
-- The request identity arrives as a transaction-local GUC set by
-- lib/db/tenant-context.ts:
--     BEGIN; SET LOCAL app.user_id = '<id>'; ... COMMIT;
--
-- SET LOCAL, never SET. The production connection is the Supabase Transaction
-- Pooler (pgbouncer transaction mode): a server connection is returned after
-- every transaction, so a session-level GUC would leak to whichever tenant
-- borrows that connection next. SET LOCAL is discarded at COMMIT *and* at
-- ROLLBACK, which is also what makes a failed transaction leave no residue.
--
-- STABLE, not VOLATILE: it lets the planner treat the value as constant within
-- a statement, which is what allows the membership lookup to be hashed or
-- materialised ONCE per query instead of re-evaluated per row.

CREATE OR REPLACE FUNCTION current_fm_user_id() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

-- The Spaces this identity may act in. ACTIVE is load-bearing: SpaceMember rows
-- are never deleted — revocation is a status flip — so a policy that omitted it
-- would keep serving removed members.
--
-- ⚠️ SECURITY DEFINER, AND IT HAS TO BE. This is the one self-reference in the
-- whole design: SpaceMember carries a tenancy policy, and that policy needs to
-- know which Spaces you belong to — which means reading SpaceMember. As
-- SECURITY INVOKER this recurses until Postgres aborts with "stack depth limit
-- exceeded"; the acceptance suite catches it on the first query. Running the
-- lookup as the function owner breaks the cycle.
--
-- It is safe to define away the policy here because the function is
-- PARAMETERLESS and SELF-SCOPED: it can only ever return the Spaces of
-- current_fm_user_id(). There is no argument through which a caller could ask
-- it about somebody else. This is an enumerated, auditable bypass — it appears
-- in the bypass inventory, and it is the reason fm_app needs no BYPASSRLS.
--
-- Parameterless and used as `IN (SELECT fm_visible_space_ids())`, so the planner
-- evaluates it ONCE per statement as an InitPlan rather than per row.
CREATE OR REPLACE FUNCTION fm_visible_space_ids() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT sm."spaceId" FROM "SpaceMember" sm
     WHERE sm."userId" = current_fm_user_id()
       AND sm.status   = 'ACTIVE'
  $$;

-- The canonical account-subtree predicate (investigation §16).
--
-- Plain SQL, not plpgsql, so the planner INLINES it and the measured plan shapes
-- are preserved: correlated EXISTS, Memoize on the account probe, membership set
-- hashed once. Flattening this to `financialAccountId IN (...)` measured 4x
-- SLOWER because it defeats the ordered index scan — do not "optimise" it.
--
-- MANY-TO-MANY IS LOAD-BEARING: 21 of 37 accounts are ACTIVE-linked into 2-4
-- Spaces. There is deliberately no denormalised Transaction.spaceId, because a
-- single-valued column cannot represent a row with four legitimate tenants.
--
-- Deliberately SECURITY INVOKER and plain SQL, so the planner can INLINE it —
-- that is what preserves the measured plan shape. It reaches membership through
-- fm_visible_space_ids() rather than joining SpaceMember itself, which is what
-- keeps it non-recursive while staying inlinable.
CREATE OR REPLACE FUNCTION fm_account_visible(acct text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1
        FROM "SpaceAccountLink" sal
       WHERE sal."financialAccountId" = acct
         AND sal.status  = 'ACTIVE'
         AND sal."spaceId" IN (SELECT fm_visible_space_ids())
    )
  $$;

GRANT EXECUTE ON FUNCTION current_fm_user_id(), fm_visible_space_ids(),
                          fm_account_visible(text)
  TO fm_app, fm_auth, fm_system;

-- ── 3. BASE GRANTS ───────────────────────────────────────────────────────────
-- Least privilege. fm_app gets no TRUNCATE and no REFERENCES anywhere, and is
-- granted nothing at all on the operational/forensic families (§4 below).

-- Sequences: Prisma uses cuid() defaults, but autoincrement tables exist.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fm_app, fm_system;

-- fm_backup needs SELECT on EVERYTHING, and BYPASSRLS alone does not give it.
-- BYPASSRLS exempts a role from POLICIES; it says nothing about GRANTS. A
-- backup role with the attribute but without the privilege produces
--     pg_dump: error: query failed: ERROR: permission denied for table ...
-- which at least fails loudly — unlike the partial-dump case this role exists
-- to prevent. The acceptance suite asserts the complete dump, which is how this
-- was found.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fm_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO fm_backup;

-- ── 4. TABLES fm_app MUST NOT REACH AT ALL ───────────────────────────────────
-- Revoking is stronger and simpler than inventing a permissive policy. These
-- are operator-facing forensic ledgers and deployment-global telemetry. Several
-- carry DELIBERATELY soft, nullable tenant references so the ledger SURVIVES
-- deletion of what it observed — which is exactly the case a tenant-keyed policy
-- would break. AiInvocation additionally has no tenant column BY DESIGN, as a
-- recorded privacy decision; adding one to satisfy RLS would reverse it.
--
-- fm_system reaches them through role-scoped policies below.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AiInvocation', 'ApiUsageCounter', 'PlatformSetting',
    'SyncIssue', 'SyncIssueOccurrence', 'JobRun',
    'RefreshExecution', 'RefreshEndpointAccountCoverage', 'ProviderCall',
    'RefreshEndpointResult', 'NotificationDelivery',
    'ProviderCapabilityObservation', 'MerchantMergeDecision'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- RateLimit is the one operational table the WEB RUNTIME genuinely must write,
-- on every request, including unauthenticated ones. Its subject is embedded in
-- an opaque text key ("user:ai-chat:<id>"), so there is nothing to write a
-- predicate against. It holds no financial data. Granted to fm_app explicitly
-- and left without RLS, as a recorded non-tenant operational exception.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."RateLimit" TO fm_app, fm_system;

-- BetaAccessRequest is pre-tenant by construction: the subject has no User row
-- yet, so no SELECT predicate can exist. Anonymous INSERT only; reads are
-- operator work.
REVOKE ALL ON TABLE public."BetaAccessRequest" FROM fm_app;
GRANT INSERT ON TABLE public."BetaAccessRequest" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."BetaAccessRequest" TO fm_system;
ALTER TABLE public."BetaAccessRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BetaAccessRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_insert   ON public."BetaAccessRequest" FOR INSERT TO fm_app   WITH CHECK (true);
CREATE POLICY fm_system_all   ON public."BetaAccessRequest" FOR ALL    TO fm_system USING (true) WITH CHECK (true);

-- ── 5. GLOBAL REFERENCE DATA ─────────────────────────────────────────────────
-- One vendor answer serves every tenant; a tenant column here would write the
-- same fact N times and let two accounts disagree about the market. Readable by
-- all; writable because user-triggered imports legitimately mint instruments and
-- merchants. No DELETE for fm_app — merges are operator work.
--
-- RESIDUAL, recorded not hidden: Merchant/MerchantAlias row EXISTENCE is a
-- cross-tenant inference channel, and MerchantAlias.sample holds a raw bank
-- descriptor from some tenant's transaction. RLS protects rows, not this. It is
-- unchanged by this migration and tracked as P2.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Instrument', 'InstrumentAlias', 'PriceObservation',
    'CorporateActionTerms', 'FxRate', 'Merchant', 'MerchantAlias'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO fm_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
  END LOOP;
END $$;

-- ── 6. THE PRE-IDENTITY AUTH SURFACE ─────────────────────────────────────────
-- Exactly three tables, reachable by fm_auth and nothing else. fm_auth has no
-- grant on any financial table, so a compromised auth credential cannot read
-- money.

GRANT SELECT, UPDATE         ON TABLE public."User"         TO fm_auth;
GRANT SELECT, INSERT, UPDATE ON TABLE public."UserSession"  TO fm_auth;
GRANT SELECT, UPDATE         ON TABLE public."RecoveryCode" TO fm_auth;

-- ── 7. SPACE-SCOPED TABLES WITH A DIRECT spaceId ─────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AiAgent', 'SpaceGoal', 'SpaceDashboardSection', 'ImportMappingProfile',
    'SpaceSnapshot', 'AiAdvice', 'SnapshotAmendment', 'SpaceAccountLink'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    -- USING governs which existing rows are visible/eligible.
    EXECUTE format($f$CREATE POLICY fm_app_sel ON public.%I FOR SELECT TO fm_app
                      USING ("spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);
    -- WITH CHECK governs the row being written. This is what stops a
    -- cross-Space INSERT.
    EXECUTE format($f$CREATE POLICY fm_app_ins ON public.%I FOR INSERT TO fm_app
                      WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);
    -- Both clauses, and they differ: USING protects the existing row, WITH CHECK
    -- the POST-IMAGE. That asymmetry is precisely what prevents a row being
    -- MOVED across a tenant boundary.
    EXECUTE format($f$CREATE POLICY fm_app_upd ON public.%I FOR UPDATE TO fm_app
                      USING ("spaceId" IN (SELECT fm_visible_space_ids()))
                      WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_del ON public.%I FOR DELETE TO fm_app
                      USING ("spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── 8. SPACE-SCOPED *AND* USER-PRIVATE ───────────────────────────────────────
-- spaceId alone is INSUFFICIENT here: a shared household Space holds two
-- people's private rows. Both keys are required and both are NOT NULL.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['SpaceMemory', 'DailyBrief'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY fm_app_sel ON public.%I FOR SELECT TO fm_app
                      USING ("spaceId" IN (SELECT fm_visible_space_ids())
                             AND "ownerUserId" = current_fm_user_id())$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_ins ON public.%I FOR INSERT TO fm_app
                      WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids())
                                  AND "ownerUserId" = current_fm_user_id())$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_upd ON public.%I FOR UPDATE TO fm_app
                      USING ("spaceId" IN (SELECT fm_visible_space_ids())
                             AND "ownerUserId" = current_fm_user_id())
                      WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids())
                                  AND "ownerUserId" = current_fm_user_id())$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_del ON public.%I FOR DELETE TO fm_app
                      USING ("spaceId" IN (SELECT fm_visible_space_ids())
                             AND "ownerUserId" = current_fm_user_id())$f$, t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── 9. USER-SCOPED TABLES ────────────────────────────────────────────────────
-- Notification is keyed on userId, NOT on its 45%-null and unindexed spaceId.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'PlaidItem', 'Connection', 'CreditScore', 'Notification',
    'NotificationPreference', 'RecoveryCode', 'UserSession', 'PlatformGrant'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY fm_app_sel ON public.%I FOR SELECT TO fm_app
                      USING ("userId" = current_fm_user_id())$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_ins ON public.%I FOR INSERT TO fm_app
                      WITH CHECK ("userId" = current_fm_user_id())$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_upd ON public.%I FOR UPDATE TO fm_app
                      USING ("userId" = current_fm_user_id())
                      WITH CHECK ("userId" = current_fm_user_id())$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_del ON public.%I FOR DELETE TO fm_app
                      USING ("userId" = current_fm_user_id())$f$, t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- fm_auth reaches the pre-identity trio through role-scoped policies. It cannot
-- set app.user_id, because the whole point is that no identity exists yet.
CREATE POLICY fm_auth_all ON public."UserSession"  FOR ALL TO fm_auth USING (true) WITH CHECK (true);
CREATE POLICY fm_auth_all ON public."RecoveryCode" FOR ALL TO fm_auth USING (true) WITH CHECK (true);

-- ── 10. User — the tenant root ───────────────────────────────────────────────
-- A user sees themselves. Co-members' display identity is served by the
-- application through rosterForViewer, not by widening this policy.

GRANT SELECT, UPDATE ON TABLE public."User" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."User" TO fm_system;
ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."User" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel    ON public."User" FOR SELECT TO fm_app USING ("id" = current_fm_user_id());
CREATE POLICY fm_app_upd    ON public."User" FOR UPDATE TO fm_app
  USING ("id" = current_fm_user_id()) WITH CHECK ("id" = current_fm_user_id());
CREATE POLICY fm_auth_all   ON public."User" FOR ALL TO fm_auth   USING (true) WITH CHECK (true);
CREATE POLICY fm_system_all ON public."User" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 11. Space — plus the platform-grant arm ──────────────────────────────────
-- Four platform Spaces carry a non-null platformArea and have ZERO SpaceMember
-- rows; they are reachable only through PlatformGrant. A membership-only policy
-- would hide them from everyone, including the operators who own them.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."Space" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."Space" TO fm_system;
ALTER TABLE public."Space" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Space" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."Space" FOR SELECT TO fm_app
  USING (
    "id" IN (SELECT fm_visible_space_ids())
    OR ("platformArea" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "PlatformGrant" g
           WHERE g."userId" = current_fm_user_id()
             AND g.status   = 'ACTIVE'
             AND g.area     = "Space"."platformArea"))
  );
-- Space creation is self-service: the creator is made OWNER in the same
-- transaction, so no membership exists yet at INSERT time.
CREATE POLICY fm_app_ins ON public."Space" FOR INSERT TO fm_app WITH CHECK (true);
CREATE POLICY fm_app_upd ON public."Space" FOR UPDATE TO fm_app
  USING ("id" IN (SELECT fm_visible_space_ids()))
  WITH CHECK ("id" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_system_all ON public."Space" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 12. SpaceMember — closes the users/search roster oracle at the DB ────────
-- DELETE is not granted to fm_app: membership rows are never deleted, only
-- status-flipped.

GRANT SELECT, INSERT, UPDATE ON TABLE public."SpaceMember" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SpaceMember" TO fm_system;
ALTER TABLE public."SpaceMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SpaceMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."SpaceMember" FOR SELECT TO fm_app
  USING ("spaceId" IN (SELECT fm_visible_space_ids()) OR "userId" = current_fm_user_id());
CREATE POLICY fm_app_ins ON public."SpaceMember" FOR INSERT TO fm_app
  WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()) OR "userId" = current_fm_user_id());
CREATE POLICY fm_app_upd ON public."SpaceMember" FOR UPDATE TO fm_app
  USING ("spaceId" IN (SELECT fm_visible_space_ids()))
  WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_system_all ON public."SpaceMember" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 13. SpaceInvite — the invitee is NOT yet a member ────────────────────────
-- A membership-only policy would make an invitation invisible to the one person
-- who must act on it.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SpaceInvite" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SpaceInvite" TO fm_system;
ALTER TABLE public."SpaceInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SpaceInvite" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."SpaceInvite" FOR SELECT TO fm_app
  USING ("spaceId" IN (SELECT fm_visible_space_ids()) OR "invitedUserId" = current_fm_user_id());
CREATE POLICY fm_app_ins ON public."SpaceInvite" FOR INSERT TO fm_app
  WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_app_upd ON public."SpaceInvite" FOR UPDATE TO fm_app
  USING ("spaceId" IN (SELECT fm_visible_space_ids()) OR "invitedUserId" = current_fm_user_id())
  WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()) OR "invitedUserId" = current_fm_user_id());
CREATE POLICY fm_app_del ON public."SpaceInvite" FOR DELETE TO fm_app
  USING ("spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_system_all ON public."SpaceInvite" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 14. FinancialAccount — the tenancy pivot ─────────────────────────────────
-- Reached through SpaceAccountLink on its OWN id. ownerSpaceId is deliberately
-- NOT used: it is vestigial, populated on 0 of 37 rows.
-- The ownerUserId arm keeps a just-created account visible to its creator in the
-- same transaction, before any link exists.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."FinancialAccount" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."FinancialAccount" TO fm_system;
ALTER TABLE public."FinancialAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."FinancialAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."FinancialAccount" FOR SELECT TO fm_app
  USING ("ownerUserId" = current_fm_user_id() OR fm_account_visible("id"));
CREATE POLICY fm_app_ins ON public."FinancialAccount" FOR INSERT TO fm_app
  WITH CHECK ("ownerUserId" = current_fm_user_id());
CREATE POLICY fm_app_upd ON public."FinancialAccount" FOR UPDATE TO fm_app
  USING ("ownerUserId" = current_fm_user_id() OR fm_account_visible("id"))
  WITH CHECK ("ownerUserId" = current_fm_user_id() OR fm_account_visible("id"));
CREATE POLICY fm_app_del ON public."FinancialAccount" FOR DELETE TO fm_app
  USING ("ownerUserId" = current_fm_user_id());
CREATE POLICY fm_system_all ON public."FinancialAccount" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 15. THE ACCOUNT SUBTREE ──────────────────────────────────────────────────
-- Every one of these reaches a tenant only through financialAccountId. This is
-- where the money lives, and where RLS earns its cost.
--
-- NOTE ON NULLABILITY: Transaction.financialAccountId and
-- Holding.financialAccountId are nullable in the schema (0 such rows exist). A
-- NULL makes fm_account_visible() return false, so such a row would be invisible
-- to everyone and rejected by WITH CHECK. The companion schema migration makes
-- both NOT NULL so the policy cannot change behaviour for a shape the schema
-- still permits.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Transaction', 'TransactionEvent', 'TransactionObservation',
    'PositionObservation', 'Holding', 'InvestmentEvent',
    'InvestmentEventCoverage', 'PositionCoverage', 'PositionReconstruction',
    'DebtProfile', 'AccountConnection', 'ProviderAccountIdentity', 'ImportBatch'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY fm_app_sel ON public.%I FOR SELECT TO fm_app
                      USING (fm_account_visible("financialAccountId"))$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_ins ON public.%I FOR INSERT TO fm_app
                      WITH CHECK (fm_account_visible("financialAccountId"))$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_upd ON public.%I FOR UPDATE TO fm_app
                      USING (fm_account_visible("financialAccountId"))
                      WITH CHECK (fm_account_visible("financialAccountId"))$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_del ON public.%I FOR DELETE TO fm_app
                      USING (fm_account_visible("financialAccountId"))$f$, t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── 16. ONE-HOP DESCENDANTS ──────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."GoalCheckIn" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."GoalCheckIn" TO fm_system;
ALTER TABLE public."GoalCheckIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."GoalCheckIn" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."GoalCheckIn" FOR SELECT TO fm_app
  USING (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                  AND g."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_app_ins ON public."GoalCheckIn" FOR INSERT TO fm_app
  WITH CHECK (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                       AND g."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_app_upd ON public."GoalCheckIn" FOR UPDATE TO fm_app
  USING (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                  AND g."spaceId" IN (SELECT fm_visible_space_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                       AND g."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_app_del ON public."GoalCheckIn" FOR DELETE TO fm_app
  USING (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                  AND g."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_system_all ON public."GoalCheckIn" FOR ALL TO fm_system USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SnapshotAmendmentDay" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."SnapshotAmendmentDay" TO fm_system;
ALTER TABLE public."SnapshotAmendmentDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SnapshotAmendmentDay" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."SnapshotAmendmentDay" FOR SELECT TO fm_app
  USING (EXISTS (SELECT 1 FROM "SnapshotAmendment" a WHERE a."id" = "amendmentId"
                  AND a."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_app_ins ON public."SnapshotAmendmentDay" FOR INSERT TO fm_app
  WITH CHECK (EXISTS (SELECT 1 FROM "SnapshotAmendment" a WHERE a."id" = "amendmentId"
                       AND a."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_app_upd ON public."SnapshotAmendmentDay" FOR UPDATE TO fm_app
  USING (EXISTS (SELECT 1 FROM "SnapshotAmendment" a WHERE a."id" = "amendmentId"
                  AND a."spaceId" IN (SELECT fm_visible_space_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM "SnapshotAmendment" a WHERE a."id" = "amendmentId"
                       AND a."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_app_del ON public."SnapshotAmendmentDay" FOR DELETE TO fm_app
  USING (EXISTS (SELECT 1 FROM "SnapshotAmendment" a WHERE a."id" = "amendmentId"
                  AND a."spaceId" IN (SELECT fm_visible_space_ids())));
CREATE POLICY fm_system_all ON public."SnapshotAmendmentDay" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 17. CLASS-H TABLES — CONJUNCTION, THE SAFE READING ───────────────────────
-- Both have TWO independent owner paths that can disagree. The conjunction hides
-- a straddling row from BOTH tenants rather than disclosing to either that a
-- cross-tenant pair exists. Both tables are effectively unread today, so the
-- safe reading costs nothing — and it is chosen now, before a reader lands.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."GoalContribution" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."GoalContribution" TO fm_system;
ALTER TABLE public."GoalContribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."GoalContribution" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."GoalContribution" FOR SELECT TO fm_app
  USING (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                  AND g."spaceId" IN (SELECT fm_visible_space_ids()))
         AND fm_account_visible("financialAccountId"));
CREATE POLICY fm_app_ins ON public."GoalContribution" FOR INSERT TO fm_app
  WITH CHECK (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                       AND g."spaceId" IN (SELECT fm_visible_space_ids()))
              AND fm_account_visible("financialAccountId"));
CREATE POLICY fm_app_del ON public."GoalContribution" FOR DELETE TO fm_app
  USING (EXISTS (SELECT 1 FROM "SpaceGoal" g WHERE g."id" = "goalId"
                  AND g."spaceId" IN (SELECT fm_visible_space_ids()))
         AND fm_account_visible("financialAccountId"));
CREATE POLICY fm_system_all ON public."GoalContribution" FOR ALL TO fm_system USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."DuplicateAccountCandidate" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."DuplicateAccountCandidate" TO fm_system;
ALTER TABLE public."DuplicateAccountCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DuplicateAccountCandidate" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."DuplicateAccountCandidate" FOR SELECT TO fm_app
  USING (fm_account_visible("accountAId") AND fm_account_visible("accountBId"));
CREATE POLICY fm_app_ins ON public."DuplicateAccountCandidate" FOR INSERT TO fm_app
  WITH CHECK (fm_account_visible("accountAId") AND fm_account_visible("accountBId"));
CREATE POLICY fm_app_upd ON public."DuplicateAccountCandidate" FOR UPDATE TO fm_app
  USING (fm_account_visible("accountAId") AND fm_account_visible("accountBId"))
  WITH CHECK (fm_account_visible("accountAId") AND fm_account_visible("accountBId"));
CREATE POLICY fm_system_all ON public."DuplicateAccountCandidate" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- MerchantRule — the tenant key is decided by a `scope` enum the schema does not
-- constrain against it. The companion schema migration adds that CHECK; the
-- policy accepts either arm so it stays correct for both scopes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."MerchantRule" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."MerchantRule" TO fm_system;
ALTER TABLE public."MerchantRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MerchantRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."MerchantRule" FOR SELECT TO fm_app
  USING ("ownerUserId" = current_fm_user_id() OR "spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_app_ins ON public."MerchantRule" FOR INSERT TO fm_app
  WITH CHECK ("ownerUserId" = current_fm_user_id() OR "spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_app_upd ON public."MerchantRule" FOR UPDATE TO fm_app
  USING ("ownerUserId" = current_fm_user_id() OR "spaceId" IN (SELECT fm_visible_space_ids()))
  WITH CHECK ("ownerUserId" = current_fm_user_id() OR "spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_app_del ON public."MerchantRule" FOR DELETE TO fm_app
  USING ("ownerUserId" = current_fm_user_id() OR "spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_system_all ON public."MerchantRule" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 18. AuditLog — append-only, with a split read ────────────────────────────
-- 56% of rows have a NULL spaceId and 3 have neither key: SetNull is a
-- deliberate anonymisation posture, not an oversight. A tenant-keyed SELECT
-- therefore makes the majority of the forensic log unreachable by fm_app — which
-- is correct, provided an operator path exists. It does: fm_system.
-- INSERT is permissive because there are 90 independent writers and the shared
-- shape helper has no spaceId parameter at all.

GRANT SELECT, INSERT ON TABLE public."AuditLog" TO fm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."AuditLog" TO fm_system;
ALTER TABLE public."AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_sel ON public."AuditLog" FOR SELECT TO fm_app
  USING ("userId" = current_fm_user_id() OR "spaceId" IN (SELECT fm_visible_space_ids()));
CREATE POLICY fm_app_ins ON public."AuditLog" FOR INSERT TO fm_app WITH CHECK (true);
CREATE POLICY fm_system_all ON public."AuditLog" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 19. DEFAULT PRIVILEGES ───────────────────────────────────────────────────
-- Belt and braces for the Data API exposure closed in Slice 0: a future table
-- created by the migration role must never be auto-granted to the PostgREST
-- roles again. Idempotent and safe where those roles do not exist.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role';
  END IF;
END $$;

-- Future tables are granted to nobody by default. Each new table must be
-- classified explicitly in a follow-up migration, which is the intended
-- friction: an unclassified table is unreachable rather than wide open.
