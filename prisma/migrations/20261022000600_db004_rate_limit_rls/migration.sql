-- DB-004 (2026-10-22) — RateLimit gets row-level security.
--
-- fm_app held full CRUD on RateLimit with no policy, so a tenant session
-- could read or reset any bucket — other users' AI in-flight reservations
-- included ("user:ai-inflight:<id>"). Keys are built in lib/rate-limit.ts as
--   user:<name>:<userId>   ip:<name>:<ip>   key:<name>:<identifier>
-- and the AI allowance uses user:ai-inflight:<userId> through fm_system. A
-- cuid contains no ':', so the user id is exactly the text after the LAST ':'
-- of a user:… key — a safe predicate for the tenant role.
--
-- Roles after this migration:
--   fm_app    own user:… buckets only (ip:/key: buckets unreachable — no
--             tenant code path uses them; lib/rate-limit.ts runs on `db`)
--   fm_auth   all buckets (pre-identity login/registration limits key on IP or
--             identifier; there is no user to scope by)
--   fm_system all buckets (allowance reservation, sweeps, operator views)
-- ENABLE, not FORCE: the table owner (`db`, the current rate-limit client)
-- keeps bypassing RLS exactly as before, so no limiter behaviour changes.
ALTER TABLE public."RateLimit" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_app') THEN
    EXECUTE $p$CREATE POLICY fm_app_own_user_buckets ON public."RateLimit" FOR ALL TO fm_app
      USING ("key" LIKE 'user:%' AND current_fm_user_id() IS NOT NULL
             AND right("key", length(current_fm_user_id()) + 1) = ':' || current_fm_user_id())
      WITH CHECK ("key" LIKE 'user:%' AND current_fm_user_id() IS NOT NULL
             AND right("key", length(current_fm_user_id()) + 1) = ':' || current_fm_user_id())$p$;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_auth') THEN
    EXECUTE 'CREATE POLICY fm_auth_all ON public."RateLimit" FOR ALL TO fm_auth USING (true) WITH CHECK (true)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_system') THEN
    EXECUTE 'CREATE POLICY fm_system_all ON public."RateLimit" FOR ALL TO fm_system USING (true) WITH CHECK (true)';
  END IF;
END $$;
