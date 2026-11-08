/**
 * scripts/platform-ai-memory-precheck.test.ts  (Platform AI memory — the pre-enable check, PURE)
 *
 * The verdict over synthetic catalog rows (the migration's intended shape
 * PASSES; each defect FAILS its own line), the read-only / no-row shape of the
 * SQL, and one spawn proving a refusal exits 2 before any database contact. The
 * same SQL runs against real PostgreSQL in scripts/platform-ai-memory-acceptance.ts.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/platform-ai-memory-precheck.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  MEMORY_PRECHECK_FUNCTIONS, MEMORY_PRECHECK_FUNCTIONS_SQL, MEMORY_PRECHECK_RETENTION_SQL, MEMORY_PRECHECK_TABLE_SQL,
  evaluateMemoryPrecheck, renderMemoryPrecheck,
  type MemoryFunctionRow, type MemoryRetentionRow, type MemoryTableRow,
} from "./lib/platform-ai-memory-precheck.core";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const goodFns = (): MemoryFunctionRow[] => MEMORY_PRECHECK_FUNCTIONS.map((f) => ({
  signature: f.signature, present: true, definer: f.definer, config: "search_path=pg_catalog, public",
  owner_bypassrls: true, owner_super: false,
  system_exec: f.exec === "fm_system", app_exec: f.exec === "fm_app", auth_exec: false, api_exec: false, public_exec: false, owner_exec_uid: true,
}));
const goodTable = (): MemoryTableRow[] => [{ present: true, rls: true, forced: true, system_any: false, app_delete: false, app_update_deleted_at: false }];
const goodRet = (): MemoryRetentionRow[] => [{ purge_default: "((now() AT TIME ZONE 'UTC'::text) + '7 days'::interval)", purge_bound: `CHECK (("purgeAfter" <= ("createdAt" + '7 days'::interval)))` }];
const failing = (fns: MemoryFunctionRow[], t = goodTable(), r = goodRet()) => evaluateMemoryPrecheck(fns, t, r).lines.filter((l) => !l.ok).map((l) => l.text);

{
  const v = evaluateMemoryPrecheck(goodFns(), goodTable(), goodRet());
  check("the migration's intended shape PASSES (every line)", v.ok && v.lines.every((l) => l.ok), v.lines.filter((l) => !l.ok));
  check("the inventory: 3 DEFINER (soft delete → fm_app; two purges → fm_system) + 2 INVOKER triggers",
    MEMORY_PRECHECK_FUNCTIONS.filter((f) => f.definer).map((f) => `${f.signature}:${f.exec}`).join() ===
      "public.fm_platform_ai_memory_soft_delete(text):fm_app,public.fm_purge_platform_ai_memory(integer):fm_system,public.fm_purge_platform_ai_memory_for_operator(text):fm_system");
  const mut = (i: number, p: Partial<MemoryFunctionRow>) => goodFns().map((f, j) => (j === i ? { ...f, ...p } : f));
  const sd = MEMORY_PRECHECK_FUNCTIONS.findIndex((f) => f.signature.includes("soft_delete"));
  const pg = MEMORY_PRECHECK_FUNCTIONS.findIndex((f) => f.signature.includes("fm_purge_platform_ai_memory(integer)"));
  const imm = MEMORY_PRECHECK_FUNCTIONS.findIndex((f) => f.signature.includes("immutable"));
  check("FAIL: a definer owned by a non-bypass role", failing(mut(sd, { owner_bypassrls: false })).some((t) => /OWNER bypasses RLS/.test(t)));
  check("FAIL: the immutability trigger made DEFINER", failing(mut(imm, { definer: true })).some((t) => /immutable\(\): SECURITY INVOKER/.test(t)));
  check("FAIL: fm_system can EXECUTE the soft delete", failing(mut(sd, { system_exec: true })).some((t) => /soft_delete\(text\): fm_system EXECUTE absent/.test(t)));
  check("FAIL: fm_app can EXECUTE the purge", failing(mut(pg, { app_exec: true })).some((t) => /fm_purge_platform_ai_memory\(integer\): fm_app EXECUTE absent/.test(t)));
  check("FAIL: PUBLIC can EXECUTE", failing(mut(pg, { public_exec: true })).some((t) => /PUBLIC/.test(t)));
  check("FAIL: the soft delete's owner cannot EXECUTE current_fm_user_id()", failing(mut(sd, { owner_exec_uid: false })).some((t) => /current_fm_user_id/.test(t)));
  check("FAIL: search_path missing", failing(mut(sd, { config: "" })).some((t) => /search_path/.test(t)));
  check("FAIL: a function absent", failing(goodFns().slice(1)).some((t) => /present/.test(t)));
  check("FAIL: fm_app holds UPDATE on deletedAt (O1 (b))", failing(goodFns(), [{ ...goodTable()[0], app_update_deleted_at: true }]).some((t) => /deletedAt/.test(t)));
  check("FAIL: RLS not forced / fm_system privilege / fm_app DELETE",
    failing(goodFns(), [{ ...goodTable()[0], forced: false }]).length === 1 && failing(goodFns(), [{ ...goodTable()[0], system_any: true }]).length === 1
      && failing(goodFns(), [{ ...goodTable()[0], app_delete: true }]).length === 1);
  check("FAIL (D1): the conversation retention is still 90 days",
    failing(goodFns(), goodTable(), [{ purge_default: "((now() AT TIME ZONE 'UTC'::text) + '90 days'::interval)", purge_bound: `CHECK (("purgeAfter" <= ("createdAt" + '90 days'::interval)))` }]).length === 2);
  check("FAIL (D1): '17 days' is not 7", failing(goodFns(), goodTable(), [{ purge_default: "'17 days'", purge_bound: "'17 days'" }]).length === 2);
  check("FAIL: the table absent", failing(goodFns(), [{ ...goodTable()[0], present: false }]).some((t) => /present/.test(t)));
  check("render: PASS / FAIL result lines", /RESULT: PASS/.test(renderMemoryPrecheck("local", "t", v)) && /RESULT: FAIL/.test(renderMemoryPrecheck("local", "t", { ok: false, lines: [] })));
  const all = MEMORY_PRECHECK_FUNCTIONS_SQL + MEMORY_PRECHECK_TABLE_SQL + MEMORY_PRECHECK_RETENTION_SQL;
  check("the SQL reads the catalog only — no memory or conversation ROW, no write",
    !/FROM public\."PlatformAi/.test(all) && !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/.test(all.replace(/'(UPDATE|DELETE|INSERT|SELECT|EXECUTE)'/g, "")));
}
{
  const r = spawnSync(process.execPath, [...process.execArgv, path.join(process.cwd(), "scripts/platform-ai-memory-precheck.ts")], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  check("no --env ⇒ REFUSED, exit 2, nothing read", r.status === 2 && /REFUSED — nothing was read/.test(r.stderr), r.stderr.slice(0, 200));
}

if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll Platform AI memory precheck checks passed.");
