-- DB-006 (2026-10-22) — per-role statement timeouts.
--
-- No statement timeout existed: a runaway query held a pooled connection until
-- the lambda died. Role-level defaults (a session may still SET LOCAL a longer
-- one deliberately):
--   fm_app    15 s   tenant request path (matches the idle-in-transaction 15 s
--                    lib/db/tenant-context.ts sets per transaction)
--   fm_auth    5 s   login / session surface — small single-row statements
--   fm_system 60 s   jobs, sweeps, operator reads
-- The migration principal and fm_backup are untouched (migrations and dumps
-- must not be cut off). Conditional on each role existing; a deploy principal
-- without the privilege to ALTER ROLE logs a NOTICE instead of failing the
-- deploy (apply by hand in that case — recorded in the Agent C report).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('fm_app', '15s'), ('fm_auth', '5s'), ('fm_system', '60s')) AS t(role, timeout) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role) THEN
      BEGIN
        EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r.role, r.timeout);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'DB-006: no privilege to ALTER ROLE % — set statement_timeout = % by hand', r.role, r.timeout;
      END;
    END IF;
  END LOOP;
END $$;
