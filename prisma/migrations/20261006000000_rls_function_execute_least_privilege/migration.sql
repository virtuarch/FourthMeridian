-- RLS-EXECUTE — THE FIVE POLICY FUNCTIONS WERE EXECUTABLE BY PUBLIC
--
-- Found on Preview after the RLS cutover (2026-10-06): every function the RLS
-- migrations created in `public` carried EXECUTE for PUBLIC — four through the
-- explicit GRANT (granting on a function with a NULL ACL first materialises the
-- built-in PUBLIC=X default) and fm_beta_request_is_intake through the default
-- itself. A schema-level ALTER DEFAULT PRIVILEGES cannot remove that: per-schema
-- defaults only ADD to the global ones.
--
-- Reachability on Preview was proven contained (Data API exposes no table, and a
-- PostgREST session has no app.user_id, so current_fm_user_id() is NULL and
-- fm_visible_space_ids() is empty), but fm_may_join_space(id) is SECURITY
-- DEFINER and answered "is this a Space with no members" for any caller holding
-- an id. Least privilege should not depend on the Data API staying closed.
--
-- WHO NEEDS WHAT — read from the live pg_policies on Preview, not assumed:
--
--   function                    sec       evaluated by policies of   callers in code
--   current_fm_user_id()        INVOKER   fm_app (112)              none (comments only)
--   fm_visible_space_ids()      DEFINER   fm_app (121)              fm_account_visible (INVOKER ⇒ runs as caller)
--   fm_account_visible(text)    INVOKER   fm_app (6)                none
--   fm_may_join_space(text)     DEFINER   fm_app (2)                none
--   fm_beta_request_is_intake   INVOKER   fm_app (1), fm_auth (1)   none
--
-- No policy targets PUBLIC, fm_system or fm_backup with any of them, and fm_auth
-- only through the intake predicate. A function referenced by a policy is
-- executed with the privileges of the role the policy is evaluated for, so these
-- grants are exactly the set that keeps every policy evaluable. The owner keeps
-- EXECUTE implicitly, and the two DEFINER functions run as the owner inside.
-- fm_backup has BYPASSRLS and evaluates no policy. No signature, body, policy,
-- table grant or role attribute changes here.

-- 1. Nobody by default.
REVOKE ALL ON FUNCTION public.current_fm_user_id()         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_visible_space_ids()       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_account_visible(text)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_may_join_space(text)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fm_beta_request_is_intake(
  "BetaAccessRequestStatus", text, timestamp, timestamp, timestamp, text, timestamp, text
) FROM PUBLIC;

-- 2. Roles that were granted but evaluate none of these.
REVOKE ALL ON FUNCTION public.current_fm_user_id(), public.fm_visible_space_ids(),
                       public.fm_account_visible(text)
  FROM fm_auth, fm_system;
REVOKE ALL ON FUNCTION public.fm_may_join_space(text) FROM fm_system;

-- 3. Exactly what the policies need.
GRANT EXECUTE ON FUNCTION public.current_fm_user_id(), public.fm_visible_space_ids(),
                          public.fm_account_visible(text), public.fm_may_join_space(text)
  TO fm_app;
GRANT EXECUTE ON FUNCTION public.fm_beta_request_is_intake(
  "BetaAccessRequestStatus", text, timestamp, timestamp, timestamp, text, timestamp, text
) TO fm_app, fm_auth;

-- 4. Supabase's API roles hold nothing here either, stated explicitly in case a
--    platform default ever granted them directly. Safe where they do not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE $r$REVOKE ALL ON FUNCTION public.current_fm_user_id(), public.fm_visible_space_ids(),
                 public.fm_account_visible(text), public.fm_may_join_space(text),
                 public.fm_beta_request_is_intake("BetaAccessRequestStatus", text, timestamp, timestamp, timestamp, text, timestamp, text)
               FROM anon, authenticated, service_role$r$;
  END IF;
END $$;
