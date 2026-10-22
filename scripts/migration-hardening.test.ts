/**
 * scripts/migration-hardening.test.ts  (DB-009 · SEC-014 · DB-004 · DB-006 — Agent C)
 *
 * Pins the four hardening migrations' load-bearing statements and the schema
 * indexes Prisma must know about (so `migrate diff` stays clean). Behaviour was
 * proven on a throwaway Postgres 16 under SET ROLE fm_app / fm_auth / fm_system
 * (Agent C report: RateLimit visibility, PlatformGrant self-grant refused,
 * role statement_timeout, indexes present).
 *   npx tsx scripts/migration-hardening.test.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const m = (dir: string) => readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");
const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf("\n}\n", schema.indexOf(`model ${name} {`)));

const db009 = m("20261022000400_db009_operational_indexes");
for (const [mdl, idx, cols] of [["PlaidItem", "PlaidItem_syncIncompleteAt_idx", "syncIncompleteAt"], ["SyncIssue", "SyncIssue_plaidItemId_resolved_idx", "plaidItemId, resolved"], ["SpaceGoal", "SpaceGoal_deletedAt_idx", "deletedAt"], ["UserSession", "UserSession_revokedAt_idx", "revokedAt"]] as const) {
  check(`DB-009: ${idx} created and declared in the schema`, db009.includes(`CREATE INDEX "${idx}"`) && model(mdl).includes(`@@index([${cols}])`));
}

const sec014 = m("20261022000500_sec014_platform_grant_read_only");
check("SEC-014: fm_app loses INSERT/UPDATE/DELETE on PlatformGrant, conditional on the role", /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'fm_app'\)[\s\S]*REVOKE INSERT, UPDATE, DELETE ON TABLE public\."PlatformGrant" FROM fm_app/.test(sec014));
check("SEC-014: SELECT is not revoked", !/REVOKE[^;]*SELECT[^;]*PlatformGrant/.test(sec014));
check("SEC-014: the three fm_app write policies are dropped", ["fm_app_ins", "fm_app_upd", "fm_app_del"].every((p) => sec014.includes(`DROP POLICY IF EXISTS ${p} ON public."PlatformGrant"`)));

const db004 = m("20261022000600_db004_rate_limit_rls");
check("DB-004: RLS ENABLED on RateLimit but NOT forced (owner `db` limiter unchanged)", /ENABLE ROW LEVEL SECURITY/.test(db004) && !/FORCE ROW LEVEL SECURITY/.test(db004));
check("DB-004: fm_app scoped to its own user: buckets, both USING and WITH CHECK", (db004.match(/right\("key", length\(current_fm_user_id\(\)\) \+ 1\) = ':' \|\| current_fm_user_id\(\)/g) ?? []).length === 2 && /current_fm_user_id\(\) IS NOT NULL/.test(db004));
check("DB-004: fm_auth and fm_system keep all buckets", /fm_auth_all ON public\."RateLimit"[^']*USING \(true\)/.test(db004) && /fm_system_all ON public\."RateLimit"[^']*USING \(true\)/.test(db004));

const db006 = m("20261022000700_db006_role_statement_timeouts");
check("DB-006: fm_app 15s, fm_auth 5s, fm_system 60s", /\('fm_app', '15s'\), \('fm_auth', '5s'\), \('fm_system', '60s'\)/.test(db006));
check("DB-006: conditional on the role and tolerant of a missing ALTER ROLE privilege", /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\.role\)/.test(db006) && /EXCEPTION WHEN insufficient_privilege/.test(db006));
check("DB-006: the migration principal and fm_backup are untouched", !/fm_backup/.test(db006.replace(/^--.*$/gm, "")));

if (failures > 0) { console.error(`\n❌ migration hardening: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ migration hardening: all checks passed");
