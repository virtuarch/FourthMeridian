-- Read-only pre-check before creating fm_diag_ro (Production RLS + effective PUBLIC permissions). Run as postgres; changes nothing.
WITH t(tbl) AS (VALUES ('BetaAccessRequest'),('BetaAccessRequestEvent'),('AuditLog'),('RateLimit')),
need(tbl, col) AS (VALUES
  ('BetaAccessRequest','id'),('BetaAccessRequest','email'),('BetaAccessRequest','status'),('BetaAccessRequest','note'),
  ('BetaAccessRequest','createdAt'),('BetaAccessRequest','decidedAt'),('BetaAccessRequest','redeemedAt'),
  ('BetaAccessRequestEvent','email'),('BetaAccessRequestEvent','receivedAt'),('BetaAccessRequestEvent','source'),
  ('AuditLog','action'),('AuditLog','metadata'),('AuditLog','ipAddress'),('AuditLog','userAgent'),('AuditLog','createdAt'),
  ('RateLimit','key'),('RateLimit','count'))
SELECT 1 AS n, 'role fm_diag_ro already exists (expect 0)' AS chk, count(*)::text AS result FROM pg_roles WHERE rolname = 'fm_diag_ro'
UNION ALL
SELECT 2, 'RLS enabled / forced: ' || t.tbl, coalesce(c.relrowsecurity::text || ' / ' || c.relforcerowsecurity::text, 'TABLE MISSING')
  FROM t LEFT JOIN pg_class c ON c.relname = t.tbl AND c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT 3, 'required columns missing (expect none)',
       coalesce(string_agg(n.tbl || '.' || n.col, ', '), 'none')
  FROM need n WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                                 WHERE ic.table_schema = 'public' AND ic.table_name = n.tbl AND ic.column_name = n.col)
UNION ALL
SELECT 4, 'policies on these tables that apply to PUBLIC (expect none)',
       coalesce(string_agg(p.tablename || ':' || p.policyname || ':' || p.cmd, ', '), 'none')
  FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN (SELECT tbl FROM t) AND 'public' = ANY (p.roles)
UNION ALL
SELECT 5, 'table privileges granted to PUBLIC on these tables (expect none)',
       coalesce(string_agg(c.relname || ':' || a.privilege_type, ', '), 'none')
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (SELECT tbl FROM t) AND a.grantee = 0
UNION ALL
SELECT 6, 'any table/view in public granted to PUBLIC (expect 0)', count(*)::text
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 0
UNION ALL
SELECT 7, 'PUBLIC privileges on schema public (CREATE must be absent)',
       coalesce(string_agg(a.privilege_type, ', '), 'none')
  FROM pg_namespace s CROSS JOIN LATERAL aclexplode(s.nspacl) a WHERE s.nspname = 'public' AND a.grantee = 0
UNION ALL
SELECT 8, 'SECURITY DEFINER functions in public executable by PUBLIC (expect none)',
       coalesce(string_agg(p.proname, ', '), 'none')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
   AND has_function_privilege('public', p.oid, 'EXECUTE')
UNION ALL
-- 12-18: what would make scripts/db-readonly-psql.sh's DIAG_REQUIRE_ROLE guard refuse fm_diag_ro
-- (it counts PUBLIC grants; it checks every non-system schema, not only public).
SELECT 12, 'role guard: schemas where PUBLIC holds CREATE (expect none)',
       coalesce(string_agg(s.nspname, ', '), 'none')
  FROM pg_namespace s CROSS JOIN LATERAL aclexplode(coalesce(s.nspacl, acldefault('n', s.nspowner))) a
 WHERE a.grantee = 0 AND a.privilege_type = 'CREATE'
   AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_(toast|temp_)'
UNION ALL
SELECT 13, 'role guard: tables/sequences in any non-system schema writable by PUBLIC (expect 0)', count(*)::text
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE a.grantee = 0 AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_(toast|temp_)'
   AND ((c.relkind IN ('r','p','v','m','f') AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
     OR (c.relkind = 'S' AND a.privilege_type IN ('USAGE','UPDATE')))
UNION ALL
SELECT 14, 'role guard: PUBLIC holds CREATE on this database (expect false)',
       has_database_privilege('public', current_database(), 'CREATE')::text
UNION ALL
SELECT 15, 'role guard: SECURITY DEFINER functions PUBLIC can execute in a schema PUBLIC can use (allowlisted = OK; any other ⇒ guard refuses)',
       coalesce(string_agg(n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ') ' || p.provolatile::text
         || CASE WHEN n.nspname = 'public' AND p.provolatile IN ('s','i')
                  AND ((p.proname = 'fm_visible_space_ids' AND oidvectortypes(p.proargtypes) = '')
                    OR (p.proname = 'fm_may_join_space' AND oidvectortypes(p.proargtypes) = 'text'))
                 THEN ' [allowlisted]' ELSE ' [REFUSED]' END, ', '), 'none')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef AND p.oid >= 16384   -- every user-created function, pg_catalog included
   AND has_schema_privilege('public', n.oid, 'USAGE') AND has_function_privilege('public', p.oid, 'EXECUTE')
UNION ALL
SELECT 16, 'role guard: foreign servers PUBLIC can use (expect 0)', count(*)::text
  FROM pg_foreign_server fs WHERE has_server_privilege('public', fs.oid, 'USAGE')
UNION ALL
SELECT 17, 'role guard: user mappings for PUBLIC (expect 0)', count(*)::text
  FROM pg_user_mappings WHERE umuser = 0
UNION ALL
SELECT 18, 'role guard: dblink* functions PUBLIC can execute (expect none)',
       coalesce(string_agg(DISTINCT p.proname::text, ', '), 'none')
  FROM pg_proc p WHERE p.proname LIKE 'dblink%' AND has_function_privilege('public', p.oid, 'EXECUTE')
UNION ALL
SELECT 9, 'server version', current_setting('server_version')
UNION ALL
SELECT 10, 'current user (must be postgres)', current_user::text
UNION ALL
SELECT 11, 'expiry to use in step 2 (now + 24 h, UTC)', to_char((now() + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:00') || '+00'
ORDER BY 1, 2;
