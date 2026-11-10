/**
 * scripts/platform-ai-conversations-precheck.test.ts  (S2 REQUIRED 2 + PR D — the pre-enable / pre-disable checks, PURE)
 *
 * The verdict functions over synthetic catalog rows, the phase parser, the
 * read-only / no-content shape of the SQL, and one spawn proving a refusal
 * exits 2 before any database contact. No database, no network. The same SQL
 * is run against real PostgreSQL by scripts/platform-ai-conversations-acceptance.ts.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/platform-ai-conversations-precheck.test.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PRECHECK_FUNCTIONS, PRECHECK_FUNCTIONS_SQL, PRECHECK_READ_ONLY_STATEMENT, PRECHECK_TABLES, PRECHECK_TABLES_SQL, PREDISABLE_SQL,
  evaluatePrecheck, evaluatePredisable, parsePrecheckPhase, renderPrecheck, renderPredisable,
  type FunctionRow, type PolicyRow, type TableRow,
} from "./lib/platform-ai-conversations-precheck.core";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const goodFn = (signature: string, definer: boolean): FunctionRow => ({
  signature, present: true, definer, config: "search_path=pg_catalog, public",
  owner_bypassrls: definer, owner_super: false,
  system_exec: signature.startsWith("public.fm_purge_"), app_exec: false, auth_exec: false, api_exec: false, public_exec: false,
});
const goodFns = (): FunctionRow[] => PRECHECK_FUNCTIONS.map((f) => goodFn(f.signature, f.definer));
const EXPIRY_QUAL = `(("purgeAfter" > (now() AT TIME ZONE 'UTC'::text)) AND (EXISTS ( SELECT 1 FROM "PlatformAiConversation" c WHERE ((c.id = "PlatformAiMessage"."conversationId") AND (c."operatorUserId" = current_fm_user_id())))))`;
const goodPolicies = (): PolicyRow[] => [{ name: "fm_app_sel", qual: EXPIRY_QUAL }, { name: "fm_app_upd", qual: EXPIRY_QUAL }];
const goodTables = (): TableRow[] => PRECHECK_TABLES.map((name) => ({ name, present: true, rls: true, forced: true, system_any: false, app_delete: false }));

console.log("\npre-enable — evaluatePrecheck\n");
{
  const v = evaluatePrecheck(goodFns(), goodTables(), goodPolicies());
  check("the migration's intended shape PASSES (every line)", v.ok && v.lines.every((l) => l.ok), v.lines.filter((l) => !l.ok));
  const noBypass = goodFns().map((f) => (f.definer ? { ...f, owner_bypassrls: false } : f));
  const nb = evaluatePrecheck(noBypass, goodTables(), goodPolicies());
  check("a definer owned by a NON-bypass role FAILS on exactly the two OWNER lines", !nb.ok && nb.lines.filter((l) => !l.ok).length === 2 && nb.lines.filter((l) => !l.ok).every((l) => /OWNER bypasses RLS/.test(l.text)));
  const superOwner = noBypass.map((f) => (f.definer ? { ...f, owner_super: true } : f));
  check("a superuser owner counts as bypassing (local PostgreSQL shape)", evaluatePrecheck(superOwner, goodTables(), goodPolicies()).ok);
  check("a missing function FAILS (the migration is not applied)", !evaluatePrecheck(goodFns().slice(1), goodTables(), goodPolicies()).ok);
  check("fm_app EXECUTE on the purge FAILS", !evaluatePrecheck(goodFns().map((f) => (f.signature.startsWith("public.fm_purge_") ? { ...f, app_exec: true } : f)), goodTables(), goodPolicies()).ok);
  check("a table without FORCE RLS FAILS", !evaluatePrecheck(goodFns(), goodTables().map((t) => ({ ...t, forced: false })), goodPolicies()).ok);
  check("any fm_system table privilege FAILS", !evaluatePrecheck(goodFns(), goodTables().map((t) => ({ ...t, system_any: true })), goodPolicies()).ok);
  check("a wrong search_path FAILS", !evaluatePrecheck(goodFns().map((f) => ({ ...f, config: "search_path=public" })), goodTables(), goodPolicies()).ok);
  const old = goodPolicies().map((p) => ({ ...p, qual: p.qual.replace(/\("purgeAfter" > \(now\(\) AT TIME ZONE 'UTC'::text\)\) AND /, "") }));
  const pre = evaluatePrecheck(goodFns(), goodTables(), old);
  check("a policy WITHOUT the expiry predicate FAILS on exactly the two expiry lines (a restore of a pre-20261105120000 backup)",
    !pre.ok && pre.lines.filter((l) => !l.ok).length === 2 && pre.lines.filter((l) => !l.ok).every((l) => /expiry on read/.test(l.text)), pre.lines.filter((l) => !l.ok));
  check("a MISSING expiry policy FAILS", !evaluatePrecheck(goodFns(), goodTables(), goodPolicies().slice(1)).ok);
  const out = renderPrecheck("preview", "2026-01-01T00:00:00.000Z", nb);
  check("the FAIL render tells the reader not to enable either flag", /RESULT: FAIL — do NOT enable PLATFORM_AI_CONVERSATIONS_ENABLED or PLATFORM_AI_PURGE_ENABLED/.test(out));
}

console.log("\npre-disable — evaluatePredisable (PR D, S2 disable order)\n");
{
  const row = (o: Partial<{ conversations: number; messages: number; reader_bypassrls: boolean; reader_super: boolean }> = {}) =>
    ({ conversations: 0, messages: 0, reader_bypassrls: true, reader_super: false, ...o });
  check("a BYPASSRLS reader with 0 conversations and 0 messages PASSES", evaluatePredisable([row()]).ok);
  check("a remaining conversation FAILS", !evaluatePredisable([row({ conversations: 1 })]).ok);
  check("a remaining message FAILS", !evaluatePredisable([row({ messages: 2 })]).ok);
  const blind = evaluatePredisable([row({ reader_bypassrls: false })]);
  check("FAIL-CLOSED: a NON-bypass reader's zeros are NOT proof (every line fails — under FORCE RLS it sees 0)",
    !blind.ok && blind.lines.every((l) => !l.ok), blind.lines);
  check("a superuser reader counts as bypassing", evaluatePredisable([row({ reader_bypassrls: false, reader_super: true })]).ok);
  check("no role row, or two, FAILS", !evaluatePredisable([]).ok && !evaluatePredisable([row(), row()]).ok);
  check("a non-integer count FAILS (never read as 0)", !evaluatePredisable([{ ...row(), conversations: "0" as unknown as number }]).ok);
  const r = renderPredisable("preview", "2026-01-01T00:00:00.000Z", evaluatePredisable([row({ conversations: 3 })]));
  check("the FAIL render says: keep the purge flag ON, conversations off first, purge, check again",
    /RESULT: FAIL — keep PLATFORM_AI_PURGE_ENABLED ON\. Unset PLATFORM_AI_CONVERSATIONS_ENABLED first/.test(r));
}

console.log("\nthe phase flag and the SQL's shape\n");
{
  check("--phase absent ⇒ pre-enable (the documented default command is unchanged)", parsePrecheckPhase(["--env=preview"]) === "pre-enable");
  check("--phase=pre-disable / --phase=pre-enable parse", parsePrecheckPhase(["--phase=pre-disable"]) === "pre-disable" && parsePrecheckPhase(["--phase=pre-enable"]) === "pre-enable");
  check("an unknown or repeated --phase ⇒ refused (null)", parsePrecheckPhase(["--phase=after"]) === null && parsePrecheckPhase(["--phase=pre-disable", "--phase=pre-enable"]) === null);
  check("the read-only statement is the transaction-scoped one (never a session SET through a pooler)", PRECHECK_READ_ONLY_STATEMENT === "SET TRANSACTION READ ONLY");
  for (const [name, sql] of [["functions", PRECHECK_FUNCTIONS_SQL], ["tables", PRECHECK_TABLES_SQL], ["pre-disable", PREDISABLE_SQL]] as const) {
    // String literals (privilege names, signatures) are data, not statements.
    const bare = sql.replace(/'[^']*'/g, "''");
    check(`${name} SQL writes nothing (no INSERT / UPDATE / DELETE / DDL / SET / EXECUTE, no call of the purge)`,
      !/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|SET|EXECUTE|COPY|CALL)\b/i.test(bare) && !/fm_purge_platform_ai_conversations\s*\(/.test(bare), bare.slice(0, 200));
  }
  check("the pre-disable SQL reads COUNTS only from the two tables (no column of a conversation or message)",
    /SELECT count\(\*\) FROM public\."PlatformAiConversation"/.test(PREDISABLE_SQL) && /SELECT count\(\*\) FROM public\."PlatformAiMessage"/.test(PREDISABLE_SQL)
      && !/contentEncrypted|operatorUserId|"id"|createdAt|deletedAt|purgeAfter/.test(PREDISABLE_SQL));
  const script = readFileSync(path.join(process.cwd(), "scripts/platform-ai-conversations-precheck.ts"), "utf8");
  check("the script runs the pre-disable read in the SAME read-only transaction shape",
    /if \(phase === "pre-disable"\) \{\s*const rows = await db\.\$transaction\(async \(tx\) => \{\s*await tx\.\$executeRawUnsafe\(PRECHECK_READ_ONLY_STATEMENT\);\s*return tx\.\$queryRawUnsafe<PredisableRow\[\]>\(PREDISABLE_SQL\);/.test(script));
  check("the database client is imported only AFTER every gate", script.indexOf('await import("@/lib/db")') > script.indexOf("if (!gate.ok) refuse(gate.reasons);"));
}

console.log("\na refusal exits 2 before any contact (spawned, synthetic env)\n");
{
  const run = (...args: string[]) => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL; delete env.DIRECT_URL; delete env.VERCEL_ENV;
    return spawnSync(process.execPath, [...process.execArgv, path.join(process.cwd(), "scripts/platform-ai-conversations-precheck.ts"), ...args], { encoding: "utf8", env });
  };
  const bad = run("--env=local", "--phase=sometime");
  check("an invalid --phase ⇒ exit 2, REFUSED — nothing was read", bad.status === 2 && /REFUSED — nothing was read/.test(bad.stderr), { status: bad.status, err: bad.stderr.slice(0, 200) });
  const noTarget = run("--env=preview", "--phase=pre-disable");
  check("pre-disable with no provable target ⇒ exit 2 (the env guard), nothing read", noTarget.status === 2 && /REFUSED — nothing was read/.test(noTarget.stderr), { status: noTarget.status, err: noTarget.stderr.slice(0, 200) });
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
