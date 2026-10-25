/**
 * scripts/db-session-set-guard.test.ts  (AI RELIABILITY — F3, docs/operations/database-safety.md §4b)
 *
 * NO SESSION-LEVEL SETTING THROUGH A POOLER.
 *
 * 2026-10-25: a standalone `SET default_transaction_read_only=on` through the
 * Supavisor transaction pooler stayed on the server connection and was handed
 * to the application; the AI allowance gate's next write failed (25006) and
 * Preview's Conversations and Daily Brief returned 503s.
 *
 *   1. application code, scripts and jobs never send a session-level SET, RESET
 *      or set_config(…, false) through Prisma raw SQL (transaction-local
 *      set_config(…, true) and SET LOCAL are the only forms);
 *   2. the diagnostic wrapper scopes read-only to ONE transaction and refuses
 *      session-level settings before connecting.
 *
 *   npx tsx scripts/db-session-set-guard.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Prisma raw SQL whose statement opens with a session-scoped SET / RESET. */
const RAW_SESSION_SET = /\$(?:executeRaw|queryRaw)(?:Unsafe)?\s*(?:`|\(\s*[`'"])\s*(?:SET\s+(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)|RESET\b)/i;
/** set_config with is_local = false — a session setting under another name. */
const SESSION_SET_CONFIG = /set_config\s*\([^)]*,\s*false\s*\)/i;

console.log("1. no session-level setting in application code, scripts or jobs");
{
  const files = ["lib", "app", "scripts", "jobs"].flatMap((d) => walk(path.join(ROOT, d)));
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (RAW_SESSION_SET.test(src) || SESSION_SET_CONFIG.test(src)) offenders.push(path.relative(ROOT, f));
  }
  check(`no raw session-level SET / RESET / set_config(…, false) in ${files.length} files`, offenders.length === 0, offenders.join(", "));
  check("the detector catches the incident's statement",
    RAW_SESSION_SET.test("await db.$executeRawUnsafe('SET default_transaction_read_only = on')")
      && RAW_SESSION_SET.test("await tx.$executeRaw`SET statement_timeout = 0`")
      && SESSION_SET_CONFIG.test("SELECT set_config('app.user_id', $1, false)"));
  check("…and allows the transaction-scoped forms",
    !RAW_SESSION_SET.test("await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`")
      && !RAW_SESSION_SET.test("await tx.$executeRaw`SET TRANSACTION READ ONLY`")
      && !SESSION_SET_CONFIG.test("SELECT set_config('app.user_id', ${userId}, true)"));
}

console.log("\n2. the diagnostic wrapper is transaction-scoped and refuses session settings");
{
  const script = path.join(ROOT, "scripts", "db-readonly-psql.sh");
  const src = readFileSync(script, "utf8");
  check("one transaction: psql -1", /exec psql "\$url" [^\n]*-1\b/.test(src));
  check("read-only and the timeout are transaction-local", /-c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout/.test(src));
  check("it never issues a session-level read-only SET itself", !/SET default_transaction_read_only/i.test(src.replace(/^#.*$/gm, "")));
  check("the URL is never echoed", !/echo[^\n]*\$\{?(?:url|DIAG_DATABASE_URL)\b/.test(src));

  // The refusals happen BEFORE psql runs: an unreachable URL proves nothing connected.
  const run = (args: string[], url: string | undefined) => spawnSync("bash", [script, ...args], {
    env: { PATH: process.env.PATH ?? "", ...(url === undefined ? {} : { DIAG_DATABASE_URL: url }) } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000,
  });
  const URL = "postgresql://nobody:nothing@127.0.0.1:1/none";
  const noUrl = run(["-c", "select 1"], undefined);
  check("no DIAG_DATABASE_URL ⇒ refused (exit 2)", noUrl.status === 2 && /REFUSED/.test(noUrl.stderr));
  for (const bad of [
    "SET default_transaction_read_only=on",
    "set default_transaction_read_only = on",
    "SET SESSION statement_timeout = 0",
    "select 1; SET search_path = public",
    "RESET ALL",
    "select set_config('x', 'y', false)",
  ]) {
    const r = run(["-c", bad], URL);
    check(`refused before connecting: ${JSON.stringify(bad)}`, r.status === 2 && /REFUSED/.test(r.stderr), `${r.status} ${r.stderr}`);
  }
  for (const ok of ["select current_setting('default_transaction_read_only')", "SET LOCAL work_mem = '8MB'", "SHOW transaction_read_only", "select 1 offset 0"]) {
    const r = run(["-c", ok], URL);
    check(`allowed through the guard: ${JSON.stringify(ok)}`, !/REFUSED/.test(r.stderr ?? ""), r.stderr);
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
