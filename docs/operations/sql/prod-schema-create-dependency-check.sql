-- Read-only: who would lose CREATE on schema public if PUBLIC's CREATE is revoked, and who owns objects there.
WITH pub AS (SELECT oid, nspowner, nspacl FROM pg_namespace WHERE nspname = 'public'),
direct AS (SELECT a.grantee FROM pub, aclexplode(pub.nspacl) a WHERE a.privilege_type = 'CREATE' AND a.grantee <> 0),
rels AS (SELECT relowner AS own, count(*) AS n FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) GROUP BY 1),
fns  AS (SELECT proowner AS own, count(*) AS n FROM pg_proc  WHERE pronamespace = (SELECT oid FROM pub) GROUP BY 1),
typs AS (SELECT typowner AS own, count(*) AS n FROM pg_type  WHERE typnamespace = (SELECT oid FROM pub) AND typtype IN ('e','c','d') AND typrelid = 0 GROUP BY 1)
SELECT r.rolname,
       r.rolcanlogin                                         AS can_login,
       r.rolsuper                                            AS superuser,
       has_schema_privilege(r.oid, 'public', 'CREATE')       AS create_now,
       (r.rolsuper
        OR pg_has_role(r.oid, (SELECT nspowner FROM pub), 'USAGE')
        OR EXISTS (SELECT 1 FROM direct d WHERE pg_has_role(r.oid, d.grantee, 'USAGE'))) AS create_after_revoke,
       coalesce((SELECT n FROM rels WHERE own = r.oid), 0)   AS tables_views_seq_owned,
       coalesce((SELECT n FROM fns  WHERE own = r.oid), 0)   AS functions_owned,
       coalesce((SELECT n FROM typs WHERE own = r.oid), 0)   AS enum_types_owned
  FROM pg_roles r
 WHERE r.rolname !~ '^pg_'
   AND (has_schema_privilege(r.oid, 'public', 'CREATE')
        OR EXISTS (SELECT 1 FROM rels WHERE own = r.oid) OR EXISTS (SELECT 1 FROM fns WHERE own = r.oid))
 ORDER BY (has_schema_privilege(r.oid, 'public', 'CREATE') AND NOT (r.rolsuper
        OR pg_has_role(r.oid, (SELECT nspowner FROM pub), 'USAGE')
        OR EXISTS (SELECT 1 FROM direct d WHERE pg_has_role(r.oid, d.grantee, 'USAGE')))) DESC, r.rolname;

-- Second statement (run separately in the SQL editor, which shows only the last result):
-- Read-only: schema owner, who owns the migration-created tables, and where extension objects live.
SELECT 'schema public owner' AS fact, pg_get_userbyid(nspowner)::text AS value FROM pg_namespace WHERE nspname = 'public'
UNION ALL SELECT 'owner of _prisma_migrations', coalesce((SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE relname = '_prisma_migrations' AND relnamespace = 'public'::regnamespace), 'n/a')
UNION ALL SELECT 'owners of public tables (distinct)', (SELECT string_agg(DISTINCT pg_get_userbyid(relowner)::text, ', ') FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p'))
UNION ALL SELECT 'last applied migration', coalesce((SELECT max(migration_name) FROM public._prisma_migrations WHERE finished_at IS NOT NULL), 'n/a')
UNION ALL SELECT 'extensions installed in schema public', coalesce((SELECT string_agg(extname, ', ') FROM pg_extension WHERE extnamespace = 'public'::regnamespace), 'none')
UNION ALL SELECT 'event triggers', coalesce((SELECT string_agg(evtname, ', ') FROM pg_event_trigger), 'none')
UNION ALL SELECT 'database-level CREATE for PUBLIC', CASE WHEN has_database_privilege('public', current_database(), 'CREATE') THEN 'yes' ELSE 'no' END;
