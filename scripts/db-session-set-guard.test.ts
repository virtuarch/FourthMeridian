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
 *   2. the diagnostic wrapper (scripts/db-readonly-psql.sh) scopes read-only to
 *      ONE transaction and, BEFORE connecting, refuses session-level settings,
 *      meta-commands, interpolation, extra psql arguments and local / redirected
 *      URLs; psql gets a password-free argv and the password only in its env
 *      (proved with a fake psql — no network). The database-side half (role
 *      guard, zero rows written) is scripts/db-readonly-psql-container.test.ts.
 *
 *   npx tsx scripts/db-session-set-guard.test.ts
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  check("tracing is switched off on the first executable line", /^#!\/usr\/bin\/env bash\n\{ set \+x \+v; \} 2>\/dev\/null/.test(src));
  check("one transaction: psql -1", /^psql "\$url" [^\n]*-1\b/m.test(src));
  check("read-only and the timeout are transaction-local", /-c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout/.test(src));
  check("it never issues a session-level read-only SET itself", !/SET default_transaction_read_only/i.test(src.replace(/^#.*$/gm, "")));
  check("the URL / password is never echoed or printed",
    !/(?:echo|printf '[^']*' )[^\n]*\$\{?(?:url|raw|DIAG_DATABASE_URL|PGPASSWORD|DECODED_PW|pw_enc|userinfo)\b/.test(src));
  check("the role guard cannot be constant-folded (no 1/0 trick; a DO block RAISEs)",
    !/1\s*\/\s*0/.test(src) && /RAISE EXCEPTION 'role guard refused/.test(src) && /SELECT 'verified'::text AS read_only_role_guard/.test(src));

  // A fake psql records its argv and environment: proves what WOULD reach psql
  // without any network, and that everything refused never reached it.
  const tmp = mkdtempSync(path.join(tmpdir(), "db-ro-psql-test-"));
  const fakeBin = path.join(tmp, "bin"); mkdirSync(fakeBin);
  const rec = path.join(tmp, "rec");
  writeFileSync(path.join(fakeBin, "psql"), `#!/bin/sh\nmkdir -p '${rec}'\nprintf '%s\\n' "$@" > '${rec}/argv'\nenv > '${rec}/env'\nexit 0\n`);
  chmodSync(path.join(fakeBin, "psql"), 0o755);
  const reached = () => existsSync(path.join(rec, "argv"));
  const run = (args: string[], url: string | undefined, opts: { bashArgs?: string[]; env?: Record<string, string> } = {}) => {
    rmSync(rec, { recursive: true, force: true });
    return spawnSync("bash", [...(opts.bashArgs ?? []), script, ...args], {
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ...(url === undefined ? {} : { DIAG_DATABASE_URL: url }), ...(opts.env ?? {}) } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8", timeout: 20_000,
    });
  };
  const refused = (r: ReturnType<typeof run>) => r.status === 2 && /REFUSED/.test(r.stderr) && !reached();
  // Remote-shaped, unresolvable (RFC 2606 .invalid): passes URL validation, can never connect.
  const URL = "postgresql://nobody:nothing@guard-test.invalid:1/none";

  console.log("  — URL validation (refused before psql runs)");
  for (const junk of ["", "   ", "not-a-url", "DIAG_DATABASE_URL="]) {
    const r = run(["-c", "select 1"], junk);
    check(`a non-URL value ⇒ refused, never a local-socket fallback: ${JSON.stringify(junk)}`, refused(r) && !/\/tmp\/\.s\.PGSQL/.test(r.stderr), `${r.status} ${r.stderr}`);
  }
  check("no DIAG_DATABASE_URL ⇒ refused (exit 2)", refused(run(["-c", "select 1"], undefined)));
  const badUrls: Array<[string, string]> = [
    ["localhost", "postgresql://u:p@localhost:5432/db"],
    ["LOCALHOST (case)", "postgresql://u:p@LOCALHOST:5432/db"],
    ["localhost. (trailing dot)", "postgresql://u:p@localhost.:5432/db"],
    ["*.localhost", "postgresql://u:p@db.localhost:5432/db"],
    ["127.0.0.1", "postgresql://u:p@127.0.0.1:5432/db"],
    ["127.1.2.3 (127/8)", "postgresql://u:p@127.1.2.3:5432/db"],
    ["127.1 (shorthand)", "postgresql://u:p@127.1:5432/db"],
    ["2130706433 (integer form)", "postgresql://u:p@2130706433:5432/db"],
    ["0x7f000001 (hex form)", "postgresql://u:p@0x7f000001:5432/db"],
    ["0177.0.0.1 (octal form)", "postgresql://u:p@0177.0.0.1:5432/db"],
    ["0.0.0.0", "postgresql://u:p@0.0.0.0:5432/db"],
    ["[::1]", "postgresql://u:p@[::1]:5432/db"],
    ["::1 bare", "postgresql://u:p@::1/db"],
    ["unix socket path (%2F)", "postgresql://u:p@%2Ftmp:5432/db"],
    ["empty host (socket fallback)", "postgresql://u:p@/db"],
    ["empty host + ?host=/tmp", "postgresql://u:p@/db?host=/tmp"],
    ["?host= override", "postgresql://u:p@remote.invalid:1/db?host=127.0.0.1"],
    ["?hostaddr= override", "postgresql://u:p@remote.invalid:1/db?hostaddr=127.0.0.1"],
    ["?service=", "postgresql://u:p@remote.invalid:1/db?service=local"],
    ["?options=", "postgresql://u:p@remote.invalid:1/db?options=-c%20default_transaction_read_only%3Doff"],
    ["&HOST= (case)", "postgresql://u:p@remote.invalid:1/db?sslmode=require&HOST=localhost"],
    ["multi-host (commas)", "postgresql://u:p@remote.invalid:1,127.0.0.1:5432/db"],
    ["unknown parameter", "postgresql://u:p@remote.invalid:1/db?target_session_attrs=any"],
    ["sslmode=disable on a remote host", "postgresql://u:p@remote.invalid:1/db?sslmode=disable"],
    ["sslmode=prefer on a remote host", "postgresql://u:p@remote.invalid:1/db?sslmode=prefer"],
    ["no password", "postgresql://u@remote.invalid:1/db"],
    ["empty password", "postgresql://u:@remote.invalid:1/db"],
  ];
  for (const [name, u] of badUrls) {
    const r = run(["-c", "select 1"], u);
    check(`refused before connecting: ${name}`, refused(r), `${r.status} ${r.stderr}`);
  }
  {
    const r = run(["-c", "select 1"], "postgresql://u:p@remote.invalid:1/db?host=127.0.0.1", { env: { DIAG_ALLOW_LOCAL: "1" } });
    check("DIAG_ALLOW_LOCAL=1 never re-enables ?host= / redirection parameters", refused(r), r.stderr);
    const l = run(["-c", "select 1"], "postgresql://u:p@127.0.0.1:1/db?sslmode=disable", { env: { DIAG_ALLOW_LOCAL: "1" } });
    check("DIAG_ALLOW_LOCAL=1 (test-only) is loud on stderr", reached() && /WARNING — DIAG_ALLOW_LOCAL=1 is a TEST-ONLY override/.test(l.stderr), l.stderr);
    const t = run(["-c", "select 1"], "postgresql://u:p@127.0.0.1:1/db", { env: { DIAG_ALLOW_LOCAL: "true" } });
    check("DIAG_ALLOW_LOCAL other than exactly 1 ⇒ still refused", refused(t), t.stderr);
  }

  console.log("  — what psql receives: password-free argv, password only in its env, no inherited PG*");
  {
    const r = run(["-c", "select 1"], " 'DATABASE_URL=postgresql://fm_diag_ro.ref:p%40ss%2Fw%3Ard@Pooler.Example.com:6543/postgres?pgbouncer=true&connection_limit=1' ", {
      env: { PGPASSWORD: "inherited-wrong", PGHOST: "127.0.0.1", PGPORT: "1", PGUSER: "postgres", PGDATABASE: "x", PGSERVICE: "s", PGSERVICEFILE: "/x",
             PGPASSFILE: "/x", PGOPTIONS: "-c default_transaction_read_only=off", PGSSLMODE: "disable", PGHOSTADDR: "127.0.0.1", PSQLRC: "/x", PAGER: "sh", PSQL_PAGER: "sh" },
    });
    const argv = reached() ? readFileSync(path.join(rec, "argv"), "utf8").split("\n") : [];
    const env = reached() ? readFileSync(path.join(rec, "env"), "utf8").split("\n") : [];
    check("normalised URL (trim, NAME=, quotes) reaches psql", r.status === 0 && reached(), `${r.status} ${r.stderr}`);
    check("argv URL: password-free, host lower-cased, sslmode=require added, Prisma params dropped",
      argv[0] === "postgresql://fm_diag_ro.ref@pooler.example.com:6543/postgres?sslmode=require", argv[0]);
    check("argv never contains the password (ps-safe)", !argv.some((a) => /p@ss|p%40ss/.test(a)));
    check("psql runs with -X -w -1 and ON_ERROR_STOP=1", ["-X", "-w", "-1", "ON_ERROR_STOP=1"].every((f) => argv.includes(f)));
    check("PGPASSWORD = the DECODED URL password (inherited value discarded)", env.includes("PGPASSWORD=p@ss/w:rd"), env.filter((l) => l.startsWith("PG")).join(" "));
    const pgVars = env.filter((l) => /^(PG|PSQL)/.test(l)).map((l) => l.split("=")[0]).sort();
    check("no inherited PG*/PSQL* variable reaches psql (only PGCONNECT_TIMEOUT, PGPASSWORD)", JSON.stringify(pgVars) === JSON.stringify(["PGCONNECT_TIMEOUT", "PGPASSWORD"]), pgVars.join(","));
    check("PGCONNECT_TIMEOUT=10, PAGER and DIAG_DATABASE_URL not passed on",
      env.includes("PGCONNECT_TIMEOUT=10") && !env.some((l) => /^(PAGER|DIAG_DATABASE_URL)=/.test(l)));
    const raw = run(["-c", "select 1"], "postgresql://u:p@ss/w:rd#!x@remote.example.com:5432/postgres");
    const rawEnv = reached() ? readFileSync(path.join(rec, "env"), "utf8").split("\n") : [];
    check("a raw password with @ / : # ! (owner prompt) is split correctly", raw.status === 0 && rawEnv.includes("PGPASSWORD=p@ss/w:rd#!x"), raw.stderr);
  }

  console.log("  — the password never reaches stdout/stderr (bash -x, SHELLOPTS=xtrace, bad percent-escape)");
  {
    const secret = `Leak${Math.random().toString(36).slice(2, 10)}Secret`;
    for (const [name, pw] of [["bad escape %zz", `${secret}%zz`], ["truncated escape %4", `${secret}%4`], ["%00", `${secret}%00`], ["good escape", `${secret}%21`]] as const) {
      for (const [mode, bashArgs, env] of [["plain", [], {}], ["bash -x", ["-x"], {}], ["SHELLOPTS=xtrace", [], { SHELLOPTS: "xtrace" }], ["bash -xv", ["-xv"], {}]] as const) {
        const r = run(["-c", "select 1"], `postgresql://u:${pw}@remote.example.com:5432/db`, { bashArgs: [...bashArgs], env: { ...env } });
        const out = `${r.stdout}${r.stderr}`;
        check(`${name} under ${mode}: password absent from output${name === "good escape" ? "" : ", refused"}`,
          !out.includes(secret) && (name === "good escape" ? r.status === 0 : refused(r)), `${r.status} ${out.slice(0, 300)}`);
      }
    }
  }

  console.log("  — arguments: exact -c TEXT / -f FILE + harmless output flags only");
  const file = path.join(tmp, "q.sql"); writeFileSync(file, "select 1;\n");
  const commitFile = path.join(tmp, "commit.sql"); writeFileSync(commitFile, "COMMIT;\ninsert into canary values (1);\n");
  for (const [name, args] of [
    ["-fFILE (joined)", [`-f${commitFile}`]], ["--file=FILE", [`--file=${commitFile}`]], ["--file FILE", ["--file", file]],
    ["-d override", ["-d", "postgresql://u:p@127.0.0.1/db", "-c", "select 1"]], ["--dbname=", ["--dbname=postgres", "-c", "select 1"]],
    ["-h", ["-h", "127.0.0.1", "-c", "select 1"]], ["-p", ["-p", "5432", "-c", "select 1"]], ["-U", ["-U", "postgres", "-c", "select 1"]],
    ["-v ON_ERROR_STOP=0", ["-v", "ON_ERROR_STOP=0", "-c", "select 1"]], ["--set=ON_ERROR_STOP=0", ["--set=ON_ERROR_STOP=0", "-c", "select 1"]],
    ["-1 duplicate", ["-1", "-c", "select 1"]], ["--single-transaction", ["--single-transaction", "-c", "select 1"]],
    ["-o FILE", ["-o", path.join(tmp, "out"), "-c", "select 1"]], ["-L FILE", ["-L", path.join(tmp, "log"), "-c", "select 1"]],
    ["-cTEXT (joined)", ["-cselect 1"]], ["--command=", ["--command=select 1"]], ["positional dbname", ["postgres"]],
    ["-P pager=on", ["-P", "pager=on", "-c", "select 1"]], ["-f with a directory", ["-f", tmp]], ["-f missing value", ["-f"]], ["-c missing value", ["-c"]],
    ["exact -f FILE whose contents COMMIT", ["-f", commitFile]],
  ] as Array<[string, string[]]>) {
    const r = run(args, URL);
    check(`refused before connecting: ${name}`, refused(r), `${r.status} ${r.stderr}`);
  }
  for (const [name, args] of [
    ["-f FILE", ["-f", file]], ["-c TEXT", ["-c", "select 1"]], ["-A -t -q -x", ["-A", "-t", "-q", "-x", "-c", "select 1"]],
    ["-F , -P format=csv", ["-F", ",", "-P", "format=csv", "-c", "select 1"]],
    ["the real investigation file", ["-f", path.join(ROOT, "docs", "operations", "sql", "beta-request-prod-investigation.sql")]],
  ] as Array<[string, string[]]>) {
    const r = run(args, URL);
    check(`allowed through to psql: ${name}`, r.status === 0 && reached(), `${r.status} ${r.stderr}`);
  }

  console.log("  — input scan: meta-commands, interpolation, transaction control, session settings");
  for (const bad of [
    "SET default_transaction_read_only=on", "set default_transaction_read_only = on", "SET SESSION statement_timeout = 0",
    "select 1; SET search_path = public", "SET LOCAL work_mem = '8MB'; SET search_path = public", "RESET ALL",
    "select set_config('x', 'y', false)", "select set_config('transaction_read_only', 'off', 'f'::boolean)",
    "select set_config('x', 'y', NOT true)", "select set_config('x', 'y', true)", "select SET_CONFIG ('x','y',true)",
    "COMMIT", "commit; insert into canary values (1)", "END;", "end transaction", "ROLLBACK", "abort", "BEGIN", "START TRANSACTION READ WRITE",
    "SET TRANSACTION READ WRITE", "SAVEPOINT a", "PREPARE TRANSACTION 'x'", "insert into canary values (1)", "update canary set n = 1",
    "delete from canary", "truncate canary", "create temp table t (x int)", "select 1 into t2", "drop table canary", "copy canary from program 'id'",
    "DO $$ begin insert into canary values (1); end $$", "call p()", "notify c", "select pg_advisory_lock(1)", "select pg_terminate_backend(1)",
    "select dblink_exec('x', 'y')", "select lo_import('/etc/passwd')", "discard all", "lock canary",
    "\\c", "\\c postgres", "\\connect postgres", "select 'COMM' || 'IT' as x \\gset", "\\gexec", "\\gx", "select 1 \\g /tmp/x",
    "\\! touch /tmp/x", "\\o /tmp/x", "\\w /tmp/x", "\\i /tmp/x", "\\ir x", "\\include x", "\\copy canary from stdin", "\\lo_import x",
    "\\setenv PAGER sh", "\\s /tmp/x", "\\set ON_ERROR_STOP 0", "\\unset ON_ERROR_STOP", "\\\\", "\\pset pager on", "\\echo ok \\o /tmp/x",
    "select 1 \; commit", "\\echo `touch /tmp/x`", "select `id`",
    ":x", "select :'x'", "select :\"x\"", "select :{?x}", "select 1 from t where a = :x",
  ]) {
    const r = run(["-c", bad], URL);
    check(`refused before connecting: ${JSON.stringify(bad)}`, refused(r), `${r.status} ${r.stderr}`);
  }
  for (const ok of [
    "select current_setting('default_transaction_read_only')", "SET LOCAL work_mem = '8MB'", "SHOW transaction_read_only", "select 1 offset 0",
    "select '2026-10-31'::date", "\\echo == A", "\\qecho x", "\\pset footer off", "select count(*) from \"BetaAccessRequest\" where status = 'PENDING'",
  ]) {
    const r = run(["-c", ok], URL);
    check(`allowed through the guard: ${JSON.stringify(ok)}`, r.status === 0 && reached(), `${r.status} ${r.stderr}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
