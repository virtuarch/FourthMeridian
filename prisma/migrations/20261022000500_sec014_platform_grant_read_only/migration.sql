-- SEC-014 (2026-10-22) — PlatformGrant is read-only to the tenant role.
--
-- 20261002000100 put PlatformGrant in the user-keyed loop, which granted
-- fm_app SELECT/INSERT/UPDATE/DELETE with an fm_app_ins policy whose WITH
-- CHECK is empty: any tenant session could INSERT a grant row for itself and
-- open the platform Spaces (whose fm_app SELECT policy trusts ACTIVE grants).
-- No fm_app code path writes the table — the only writers are
-- app/api/admin/platform-grants/** through the migration principal (`db`),
-- verified by grep. SELECT stays: the Space policy and the session's own
-- grant read need it.
--
-- The three write policies are dropped with the grants so the catalogue
-- states the rule rather than relying on the missing privilege alone.
-- Conditional on the role existing (plain Postgres before the RLS roles).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fm_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE public."PlatformGrant" FROM fm_app;
  END IF;
END $$;

DROP POLICY IF EXISTS fm_app_ins ON public."PlatformGrant";
DROP POLICY IF EXISTS fm_app_upd ON public."PlatformGrant";
DROP POLICY IF EXISTS fm_app_del ON public."PlatformGrant";
