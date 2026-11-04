/**
 * scripts/lib/platform-ai-conversations-precheck.core.ts  (S2 REQUIRED 2 — the Preview pre-enable check, PURE core)
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §2.4 "The Preview
 * pre-enable check" and §12. Supabase role attributes differ from a local
 * PostgreSQL (where the principal is usually a superuser): before ANY flag is
 * set, prove on the live target that the OWNER of each SECURITY DEFINER
 * function bypasses RLS — under FORCE RLS a non-bypassing owner matches 0
 * rows and deletes 0 rows, silently (fail-OPEN for retention).
 *
 * The catalog query below is READ-ONLY (pg_proc, pg_roles, pg_class and the
 * has_*_privilege functions); it reads no conversation row. The script runs it
 * in ONE transaction that opens with `SET TRANSACTION READ ONLY` (never a
 * session SET through a pooler — the 2026-10-25 incident).
 *
 * Output: one PASS / FAIL line per check, no host, URL, id or content.
 */

/** The four functions the migration creates, and the SECURITY mode each must have. */
export const PRECHECK_FUNCTIONS = [
  { signature: "public.fm_purge_platform_ai_conversations(integer)", definer: true },
  { signature: "public.fm_platform_ai_touch_conversation()", definer: true },
  { signature: "public.fm_platform_ai_message_settle()", definer: false },
  { signature: "public.fm_platform_ai_conversation_soft_delete()", definer: false },
] as const;

export const PRECHECK_TABLES = ["PlatformAiConversation", "PlatformAiMessage"] as const;

export const PRECHECK_READ_ONLY_STATEMENT = "SET TRANSACTION READ ONLY";

/** One row per function: existence, security mode, search_path, owner attributes and EXECUTE grants. */
export const PRECHECK_FUNCTIONS_SQL = `
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
            ELSE EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') END AS public_exec
  FROM (VALUES ('public.fm_purge_platform_ai_conversations(integer)'),
               ('public.fm_platform_ai_touch_conversation()'),
               ('public.fm_platform_ai_message_settle()'),
               ('public.fm_platform_ai_conversation_soft_delete()')) AS f(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
  LEFT JOIN pg_roles r ON r.oid = p.proowner
 ORDER BY f.sig`;

/** One row per table: RLS posture and fm_system's (absent) table privileges. */
export const PRECHECK_TABLES_SQL = `
SELECT t.name AS name,
       c.oid IS NOT NULL AS present,
       coalesce(c.relrowsecurity, false) AS rls,
       coalesce(c.relforcerowsecurity, false) AS forced,
       CASE WHEN c.oid IS NULL THEN false
            ELSE has_table_privilege('fm_system', c.oid, 'SELECT') OR has_table_privilege('fm_system', c.oid, 'INSERT')
              OR has_table_privilege('fm_system', c.oid, 'UPDATE') OR has_table_privilege('fm_system', c.oid, 'DELETE') END AS system_any,
       CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege('fm_app', c.oid, 'DELETE') END AS app_delete
  FROM (VALUES ('PlatformAiConversation'), ('PlatformAiMessage')) AS t(name)
  LEFT JOIN pg_class c ON c.oid = to_regclass('public."' || t.name || '"')
 ORDER BY t.name`;

export interface FunctionRow {
  signature: string; present: boolean; definer: boolean; config: string;
  owner_bypassrls: boolean; owner_super: boolean;
  system_exec: boolean; app_exec: boolean; auth_exec: boolean; api_exec: boolean; public_exec: boolean;
}
export interface TableRow { name: string; present: boolean; rls: boolean; forced: boolean; system_any: boolean; app_delete: boolean }

export interface PrecheckLine { ok: boolean; text: string }

const SEARCH_PATH = /(^|,)search_path=pg_catalog, ?public(,|$)/;

/** PURE — the verdict lines for the catalog rows. Every check must pass before any flag is enabled. */
export function evaluatePrecheck(fns: readonly FunctionRow[], tables: readonly TableRow[]): { ok: boolean; lines: PrecheckLine[] } {
  const lines: PrecheckLine[] = [];
  const add = (ok: boolean, text: string) => lines.push({ ok, text });
  for (const spec of PRECHECK_FUNCTIONS) {
    const r = fns.find((f) => f.signature === spec.signature);
    if (!r || !r.present) { add(false, `${spec.signature}: present (the migration is applied)`); continue; }
    add(r.definer === spec.definer, `${spec.signature}: SECURITY ${spec.definer ? "DEFINER" : "INVOKER"}`);
    add(SEARCH_PATH.test(r.config), `${spec.signature}: search_path = pg_catalog, public`);
    if (spec.definer) {
      add(r.owner_bypassrls || r.owner_super, `${spec.signature}: OWNER bypasses RLS (rolbypassrls=${r.owner_bypassrls}, rolsuper=${r.owner_super})`);
    }
    const isPurge = spec.signature.startsWith("public.fm_purge_");
    add(r.system_exec === isPurge, `${spec.signature}: fm_system EXECUTE ${isPurge ? "granted" : "absent"}`);
    add(!r.app_exec && !r.auth_exec && !r.api_exec && !r.public_exec, `${spec.signature}: no EXECUTE for fm_app, fm_auth, the API roles or PUBLIC`);
  }
  for (const name of PRECHECK_TABLES) {
    const t = tables.find((x) => x.name === name);
    if (!t || !t.present) { add(false, `${name}: present (the migration is applied)`); continue; }
    add(t.rls && t.forced, `${name}: row-level security ENABLED and FORCED`);
    add(!t.system_any, `${name}: fm_system holds no table privilege (the purge function is its only path)`);
    add(!t.app_delete, `${name}: fm_app holds no DELETE`);
  }
  return { ok: lines.every((l) => l.ok), lines };
}

export function renderPrecheck(env: string, at: string, v: { ok: boolean; lines: PrecheckLine[] }): string {
  return [
    `PLATFORM AI CONVERSATIONS — PRE-ENABLE CHECK (read-only) · env=${env} · ${at}`,
    ...v.lines.map((l) => `  ${l.ok ? "PASS" : "FAIL"}  ${l.text}`),
    "",
    v.ok
      ? "  RESULT: PASS — record this output in the PR D enable checklist before any flag is set."
      : "  RESULT: FAIL — do NOT enable PLATFORM_AI_CONVERSATIONS_ENABLED or PLATFORM_AI_PURGE_ENABLED.",
  ].join("\n");
}
