-- Final read-only verification before REVOKE CREATE ON SCHEMA public (A: PUBLIC, B: anon/authenticated/service_role).
SELECT 1 AS n, 'schema public ACL (unchanged since first check?)' AS fact, (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS value
UNION ALL SELECT 2, 'objects in public NOT owned by postgres (expect 0)',
  ((SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner <> 'postgres'::regrole)
 + (SELECT count(*) FROM pg_proc  WHERE pronamespace = 'public'::regnamespace AND proowner <> 'postgres'::regrole)
 + (SELECT count(*) FROM pg_type  WHERE typnamespace = 'public'::regnamespace AND typowner <> 'postgres'::regrole))::text
UNION ALL SELECT 3, 'default privileges that grant in schema public', coalesce((SELECT string_agg(pg_get_userbyid(defaclrole) || ':' || defaclobjtype::text || ':' || defaclacl::text, ' ; ') FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace), 'none')
UNION ALL SELECT 4, 'table privileges held by anon/authenticated/service_role in public', coalesce((SELECT string_agg(DISTINCT g.grantee || ':' || g.privilege_type, ', ') FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.grantee IN ('anon','authenticated','service_role')), 'none')
UNION ALL SELECT 5, 'sessions now by role (who is connected)', coalesce((SELECT string_agg(usename || '=' || c, ', ') FROM (SELECT usename, count(*) c FROM pg_stat_activity WHERE usename IS NOT NULL GROUP BY 1) s), 'none')
UNION ALL SELECT 6, 'publications (realtime) covering public tables', coalesce((SELECT string_agg(DISTINCT pubname, ', ') FROM pg_publication_tables WHERE schemaname = 'public'), 'none')
UNION ALL SELECT 7, 'pg_cron jobs (if extension present)', CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN 'pg_cron installed' ELSE 'pg_cron not installed' END
UNION ALL SELECT 8, 'last applied migration', (SELECT max(migration_name) FROM public._prisma_migrations WHERE finished_at IS NOT NULL)
ORDER BY 1;
