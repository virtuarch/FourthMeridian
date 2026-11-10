/**
 * scripts/lib/platform-ai-memory-precheck.core.ts  (Platform AI operational memory — the Preview pre-enable check, PURE core)
 *
 * Design v2 §6 / D1: memory is effective only when conversations are on, the
 * memory purge is on, AND the precheck has verified 7-day transcript retention.
 * This is that check. Run on the target AFTER the migration
 * 20261110120000_platform_ai_operational_memory is applied and BEFORE either
 * memory flag is set. It proves, from the catalog only:
 *
 *   · the SECURITY DEFINER inventory this migration adds (S2 O1 (b)):
 *       fm_platform_ai_memory_soft_delete(text)          EXECUTE fm_app only
 *       fm_purge_platform_ai_memory(integer)              EXECUTE fm_system only
 *       fm_purge_platform_ai_memory_for_operator(text)    EXECUTE fm_system only
 *     each DEFINER, search_path pg_catalog, public, OWNED by a role that bypasses
 *     RLS (else 0 rows under FORCE RLS, silently), no PUBLIC / API / fm_auth
 *     EXECUTE; the two trigger functions INVOKER and EXECUTE-less;
 *   · the table: RLS ENABLED + FORCED, fm_system holds no privilege, fm_app no
 *     DELETE and NO UPDATE on "deletedAt" (O1 (b));
 *   · D1: PlatformAiMessage keeps at most 7 days — the purgeAfter default is
 *     createdAt + 7 days and the bound CHECK says 7 days (20261108120000).
 *
 * READ-ONLY: pg_proc / pg_roles / pg_class / pg_attrdef / pg_constraint and the
 * has_*_privilege functions. It reads NO memory or conversation row. The script
 * runs it in ONE transaction opened with `SET TRANSACTION READ ONLY`.
 */

export const MEMORY_PRECHECK_FUNCTIONS = [
  { signature: "public.fm_platform_ai_memory_insert()", definer: false, exec: "none" },
  { signature: "public.fm_platform_ai_memory_immutable()", definer: false, exec: "none" },
  { signature: "public.fm_platform_ai_memory_soft_delete(text)", definer: true, exec: "fm_app" },
  { signature: "public.fm_purge_platform_ai_memory(integer)", definer: true, exec: "fm_system" },
  { signature: "public.fm_purge_platform_ai_memory_for_operator(text)", definer: true, exec: "fm_system" },
] as const;

export const MEMORY_PRECHECK_READ_ONLY_STATEMENT = "SET TRANSACTION READ ONLY";

const sigValues = MEMORY_PRECHECK_FUNCTIONS.map((f) => `('${f.signature}')`).join(",\n               ");

export const MEMORY_PRECHECK_FUNCTIONS_SQL = `
SELECT f.sig AS signature,
       p.oid IS NOT NULL AS present,
       coalesce(p.prosecdef, false) AS definer,
       coalesce(array_to_string(p.proconfig, ','), '') AS config,
       coalesce(r.rolbypassrls, false) AS owner_bypassrls,
       coalesce(r.rolsuper, false) AS owner_super,
       CASE WHEN p.oid IS NULL THEN false ELSE has_function_privilege('fm_system', p.oid, 'EXECUTE') END AS system_exec,
       CASE WHEN p.oid IS NULL THEN false ELSE has_function_privilege('fm_app', p.oid, 'EXECUTE') END AS app_exec,
       CASE WHEN p.oid IS NULL THEN false ELSE has_function_privilege('fm_auth', p.oid, 'EXECUTE') END AS auth_exec,
       CASE WHEN p.oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN false
            ELSE has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') END AS api_exec,
       CASE WHEN p.oid IS NULL THEN false
            ELSE EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') END AS public_exec,
       CASE WHEN p.oid IS NULL OR to_regprocedure('public.current_fm_user_id()') IS NULL THEN false
            ELSE has_function_privilege(p.proowner, to_regprocedure('public.current_fm_user_id()'), 'EXECUTE') END AS owner_exec_uid
  FROM (VALUES ${sigValues}) AS f(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
  LEFT JOIN pg_roles r ON r.oid = p.proowner
 ORDER BY f.sig`;

export const MEMORY_PRECHECK_TABLE_SQL = `
SELECT c.oid IS NOT NULL AS present,
       coalesce(c.relrowsecurity, false) AS rls,
       coalesce(c.relforcerowsecurity, false) AS forced,
       CASE WHEN c.oid IS NULL THEN false
            ELSE has_table_privilege('fm_system', c.oid, 'SELECT') OR has_table_privilege('fm_system', c.oid, 'INSERT')
              OR has_table_privilege('fm_system', c.oid, 'UPDATE') OR has_table_privilege('fm_system', c.oid, 'DELETE') END AS system_any,
       CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege('fm_app', c.oid, 'DELETE') END AS app_delete,
       CASE WHEN c.oid IS NULL THEN false ELSE has_column_privilege('fm_app', c.oid, 'deletedAt', 'UPDATE') END AS app_update_deleted_at
  FROM (SELECT to_regclass('public."PlatformAiMemoryFact"') AS oid) t
  LEFT JOIN pg_class c ON c.oid = t.oid`;

/** D1 — the conversation retention as the DATABASE holds it (the default and the bound CHECK). */
export const MEMORY_PRECHECK_RETENTION_SQL = `
SELECT coalesce((SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                   JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                  WHERE d.adrelid = to_regclass('public."PlatformAiMessage"') AND a.attname = 'purgeAfter'), '') AS purge_default,
       coalesce((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                  WHERE c.conrelid = to_regclass('public."PlatformAiMessage"') AND c.conname = 'PlatformAiMessage_purgeAfter_bounded'), '') AS purge_bound`;

export interface MemoryFunctionRow {
  signature: string; present: boolean; definer: boolean; config: string;
  owner_bypassrls: boolean; owner_super: boolean;
  system_exec: boolean; app_exec: boolean; auth_exec: boolean; api_exec: boolean; public_exec: boolean;
  /** The function's OWNER may EXECUTE public.current_fm_user_id() (revoked from PUBLIC in 20261006000000). */
  owner_exec_uid: boolean;
}
export interface MemoryTableRow { present: boolean; rls: boolean; forced: boolean; system_any: boolean; app_delete: boolean; app_update_deleted_at: boolean }
export interface MemoryRetentionRow { purge_default: string; purge_bound: string }
export interface PrecheckLine { ok: boolean; text: string }

const SEARCH_PATH = /(^|,)search_path=pg_catalog, ?public(,|$)/;
/** '7 days' exactly — never 70 or 17 (PostgreSQL deparses it as '7 days'::interval). */
const SEVEN_DAYS = /(^|[^0-9])7 days/;

/** PURE — one verdict line per check; every line must PASS before any memory flag is set. */
export function evaluateMemoryPrecheck(fns: readonly MemoryFunctionRow[], tables: readonly MemoryTableRow[], retention: readonly MemoryRetentionRow[]): { ok: boolean; lines: PrecheckLine[] } {
  const lines: PrecheckLine[] = [];
  const add = (ok: boolean, text: string) => lines.push({ ok, text });
  for (const spec of MEMORY_PRECHECK_FUNCTIONS) {
    const r = fns.find((f) => f.signature === spec.signature);
    if (!r || !r.present) { add(false, `${spec.signature}: present (the migration is applied)`); continue; }
    add(r.definer === spec.definer, `${spec.signature}: SECURITY ${spec.definer ? "DEFINER" : "INVOKER"}`);
    add(SEARCH_PATH.test(r.config), `${spec.signature}: search_path = pg_catalog, public`);
    if (spec.definer) add(r.owner_bypassrls || r.owner_super, `${spec.signature}: OWNER bypasses RLS (rolbypassrls=${r.owner_bypassrls}, rolsuper=${r.owner_super})`);
    if (spec.exec === "fm_app") add(r.owner_exec_uid, `${spec.signature}: its OWNER may EXECUTE public.current_fm_user_id() (else every soft delete fails)`);
    add(r.app_exec === (spec.exec === "fm_app"), `${spec.signature}: fm_app EXECUTE ${spec.exec === "fm_app" ? "granted" : "absent"}`);
    add(r.system_exec === (spec.exec === "fm_system"), `${spec.signature}: fm_system EXECUTE ${spec.exec === "fm_system" ? "granted" : "absent"}`);
    add(!r.auth_exec && !r.api_exec && !r.public_exec, `${spec.signature}: no EXECUTE for fm_auth, the API roles or PUBLIC`);
  }
  const t = tables.length === 1 ? tables[0] : null;
  if (!t || !t.present) add(false, "PlatformAiMemoryFact: present (the migration is applied)");
  else {
    add(t.rls && t.forced, "PlatformAiMemoryFact: row-level security ENABLED and FORCED");
    add(!t.system_any, "PlatformAiMemoryFact: fm_system holds no table privilege (the purge functions are its only path)");
    add(!t.app_delete, "PlatformAiMemoryFact: fm_app holds no DELETE");
    add(!t.app_update_deleted_at, "PlatformAiMemoryFact: fm_app holds no UPDATE on \"deletedAt\" (O1 (b): the definer is the sole soft-delete path)");
  }
  const ret = retention.length === 1 ? retention[0] : null;
  add(!!ret && SEVEN_DAYS.test(ret.purge_default), `D1: PlatformAiMessage.purgeAfter default is createdAt + 7 days (${ret?.purge_default || "absent"})`);
  add(!!ret && SEVEN_DAYS.test(ret.purge_bound), `D1: PlatformAiMessage_purgeAfter_bounded says 7 days (${ret?.purge_bound || "absent"})`);
  return { ok: lines.every((l) => l.ok), lines };
}

export function renderMemoryPrecheck(env: string, at: string, v: { ok: boolean; lines: PrecheckLine[] }): string {
  return [
    `PLATFORM AI MEMORY — PRE-ENABLE CHECK (read-only) · env=${env} · ${at}`,
    ...v.lines.map((l) => `  ${l.ok ? "PASS" : "FAIL"}  ${l.text}`),
    "",
    v.ok
      ? "  RESULT: PASS — 7-day retention verified; record this output before PLATFORM_AI_MEMORY_PURGE_ENABLED / PLATFORM_AI_MEMORY_ENABLED are set."
      : "  RESULT: FAIL — do NOT enable PLATFORM_AI_MEMORY_ENABLED or PLATFORM_AI_MEMORY_PURGE_ENABLED.",
  ].join("\n");
}
