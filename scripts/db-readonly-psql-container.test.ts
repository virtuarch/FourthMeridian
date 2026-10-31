/**
 * scripts/db-readonly-psql-container.test.ts  (2026-10-31 — security review of the
 * read-only Production diagnostic helper, PR #159)
 *
 * The DATABASE-side half of scripts/db-readonly-psql.sh's guarantees, proved
 * against a THROWAWAY local Postgres container (never Preview, never Production):
 *
 *   - the DIAG_REQUIRE_ROLE guard PASSES for a correct restricted role and prints
 *     `verified` (the old `ELSE (1/0)::text` guard was constant-folded by Postgres
 *     and could never pass — reproduced here too);
 *   - it REFUSES superuser, BYPASSRLS, CREATEROLE, a direct write grant, a column
 *     UPDATE grant, sequence USAGE, write rights INHERITED through membership
 *     (INHERIT and NOINHERIT), pg_write_all_data, CREATE on a schema, CREATE on the
 *     database, and a role-name mismatch;
 *   - every reviewer bypass is refused (or fails) with ZERO rows committed, even
 *     connected as the superuser (canary table and sequence checked);
 *   - the password never appears in output under bash -x / SHELLOPTS=xtrace /
 *     a bad percent-escape;
 *   - the real investigation SQL runs end to end through the helper as an
 *     `fm_diag_ro` created from prod-diag-readonly-role.md §2 (placeholder expiry),
 *     masks emails, buckets country, and prints read_only_guard = on and
 *     read_only_role_guard = verified — including via the owner's zsh sequence.
 *
 * The helper refuses localhost; these runs set the TEST-ONLY override
 * DIAG_ALLOW_LOCAL=1 (loud on stderr; never for a real database).
 *
 * Container: `docker run -d --rm` postgres:16-alpine on 127.0.0.1 (docker-assigned
 * free port), random password, no named volume; torn down with `docker rm -f -v`.
 * SKIPs (exit 0, with a SKIP line) when docker or psql is unavailable.
 *
 *   npx tsx scripts/db-readonly-psql-container.test.ts
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
}

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "db-readonly-psql.sh");
const INVESTIGATION = path.join(ROOT, "docs", "operations", "sql", "beta-request-prod-investigation.sql");
const ROLE_DOC = path.join(ROOT, "docs", "operations", "sql", "prod-diag-readonly-role.md");

const sh = (cmd: string, args: string[], input?: string) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, input });
const has = (cmd: string, args: string[]) => { const r = sh(cmd, args); return r.status === 0; };

if (!has("docker", ["info", "--format", "{{.ServerVersion}}"])) {
  console.log("SKIP db-readonly-psql-container: docker is not available — the database-side guard checks did not run.");
  process.exit(0);
}
if (!has("psql", ["--version"])) {
  console.log("SKIP db-readonly-psql-container: psql is not on PATH — the database-side guard checks did not run.");
  process.exit(0);
}

const NAME = `fm-helper-pg-${process.pid}-${randomBytes(3).toString("hex")}`;
const SUPER_PW = randomBytes(18).toString("hex");
let started = false;
function teardown() {
  if (!started) return;
  started = false;
  spawnSync("docker", ["rm", "-f", "-v", NAME], { encoding: "utf8", timeout: 60_000 });
}
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { teardown(); process.exit(130); });

const tmp = mkdtempSync(path.join(tmpdir(), "db-ro-psql-container-"));
try {
  const runC = sh("docker", ["run", "-d", "--rm", "--name", NAME, "-e", `POSTGRES_PASSWORD=${SUPER_PW}`, "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
  if (runC.status !== 0) throw new Error(`docker run failed: ${runC.stderr}`);
  started = true;
  const portOut = sh("docker", ["port", NAME, "5432/tcp"]).stdout.trim().split("\n")[0] ?? "";
  const PORT = portOut.split(":").pop() ?? "";
  if (!/^\d+$/.test(PORT)) throw new Error(`no port mapping: ${portOut}`);

  // Superuser psql straight to the container (setup and row counts only — never the helper's path).
  const su = (sql: string) => spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres", "-c", sql], {
    encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", PGPASSWORD: SUPER_PW } as unknown as NodeJS.ProcessEnv,
  });
  const suFile = (file: string) => spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres", "-f", file], {
    encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", PGPASSWORD: SUPER_PW } as unknown as NodeJS.ProcessEnv,
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = su("select 1").status === 0;
    if (!ready) spawnSync("sleep", ["1"]);
  }
  if (!ready) throw new Error("container never became ready");

  // ── Schema matching the columns the investigation reads (+ things it must NOT read). ──
  const setup = su(`
    CREATE TABLE "BetaAccessRequest" (id text PRIMARY KEY, email text NOT NULL, status text NOT NULL, note text,
      "createdAt" timestamptz NOT NULL, "decidedAt" timestamptz, "redeemedAt" timestamptz, "inviteTokenHash" text);
    CREATE TABLE "BetaAccessRequestEvent" (id serial PRIMARY KEY, email text NOT NULL, "receivedAt" timestamptz NOT NULL, source jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "AuditLog" (id serial PRIMARY KEY, action text NOT NULL, metadata jsonb, "ipAddress" text, "userAgent" text, "createdAt" timestamptz NOT NULL DEFAULT now(), "userId" text);
    CREATE TABLE "RateLimit" (key text PRIMARY KEY, count int NOT NULL);
    CREATE TABLE "User" (id text PRIMARY KEY, email text);
    CREATE TABLE canary (n int);
    CREATE SEQUENCE canary_seq;
    ALTER TABLE "BetaAccessRequest" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BetaAccessRequest" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "BetaAccessRequestEvent" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BetaAccessRequestEvent" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY; ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "RateLimit" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RateLimit" FORCE ROW LEVEL SECURITY;
    INSERT INTO "BetaAccessRequest" VALUES
      ('req_000000aaaaaa', 'ab@gmail.com',           'PENDING',  NULL,        now() - interval '3 hours', NULL, NULL, 'SECRET_TOKEN_HASH_1'),
      ('req_000000bbbbbb', 'abc@example.org',        'APPROVED', 'hello',     now() - interval '2 hours', now(), NULL, 'SECRET_TOKEN_HASH_2'),
      ('req_000000cccccc', 'johnsmith1234@gmail.com','PENDING',  'let me in', now() - interval '1 hour',  NULL, NULL, NULL);
    INSERT INTO "BetaAccessRequestEvent" (email, "receivedAt", source) VALUES
      ('ab@gmail.com', now() - interval '3 hours', '{"country":"ZZCOUNTRY","utmSource":"x"}'),
      ('johnsmith1234@gmail.com', now() - interval '1 hour', '{}');
    INSERT INTO "AuditLog" (action, metadata, "ipAddress", "userAgent")
      SELECT 'BETA_ACCESS_REQUESTED', jsonb_build_object('emailHash', encode(sha256(convert_to(lower(email), 'UTF8')), 'hex')),
             '203.0.113.77', 'Mozilla/5.0 (Macintosh) AppleWebKit Chrome/120' FROM "BetaAccessRequest";
    INSERT INTO "AuditLog" (action, metadata, "ipAddress", "userAgent", "userId") VALUES ('USER_LOGIN', '{}', '198.51.100.99', 'curl/8', 'u1');
    INSERT INTO "RateLimit" VALUES ('ip:access-request:abc', 3), ('ip:login:zzz', 9);
    INSERT INTO "User" VALUES ('u1', 'owner@example.com');
  `);
  check("container schema + seed rows created", setup.status === 0, setup.stderr);

  // fm_diag_ro exactly as documented (§2), placeholder expiry → now + 24 h.
  const doc = readFileSync(ROLE_DOC, "utf8");
  const sec2 = doc.slice(doc.indexOf("## 2."));
  const block = /```sql\n([\s\S]*?)```/.exec(sec2)?.[1] ?? "";
  check("prod-diag-readonly-role.md §2 SQL found", /CREATE ROLE fm_diag_ro/.test(block) && block.includes("<APPROVAL_TIME_PLUS_24H_UTC>"));
  const expiry = new Date(Date.now() + 24 * 3600_000).toISOString();
  const roleSql = path.join(tmp, "role.sql");
  writeFileSync(roleSql, block.replace("<APPROVAL_TIME_PLUS_24H_UTC>", expiry));
  const created = suFile(roleSql);
  check("§2 role SQL runs as written (one transaction)", created.status === 0, created.stderr);
  const RO_PW = `Ro!p@ss/w:rd#${randomBytes(6).toString("hex")}`;   // raw specials: what the owner's prompt may receive
  check("fm_diag_ro password set (container only)", su(`ALTER ROLE fm_diag_ro PASSWORD '${RO_PW}'`).status === 0);

  const helper = (args: string[], o: { user: string; pw: string; require?: string; bashArgs?: string[]; env?: Record<string, string>; rawUrl?: string }) =>
    spawnSync("bash", [...(o.bashArgs ?? []), SCRIPT, ...args], {
      encoding: "utf8", timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "", DIAG_ALLOW_LOCAL: "1",
        DIAG_DATABASE_URL: o.rawUrl ?? `postgresql://${o.user}:${o.pw}@127.0.0.1:${PORT}/postgres?sslmode=disable`,
        ...(o.require ? { DIAG_REQUIRE_ROLE: o.require } : {}), ...(o.env ?? {}),
      } as unknown as NodeJS.ProcessEnv,
    });
  const count = (sql: string) => su(sql).stdout.trim();

  console.log("\n1. P1-a — the role guard can pass (and the old guard could not)");
  {
    const old = spawnSync("psql", ["-X", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", PORT, "-U", "fm_diag_ro", "-d", "postgres", "-c",
      "SELECT CASE WHEN current_user = 'fm_diag_ro' THEN 'verified' ELSE (1/0)::text END"], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", PGPASSWORD: RO_PW } as unknown as NodeJS.ProcessEnv,
    });
    check("reviewer's finding reproduced: the OLD `ELSE (1/0)::text` guard fails even for the right role (constant-folded)",
      old.status !== 0 && /division by zero/.test(old.stderr), `${old.status} ${old.stdout} ${old.stderr}`);
    const r = helper(["-c", "select 1 as after_guard"], { user: "fm_diag_ro", pw: RO_PW, require: "fm_diag_ro" });
    check("new guard: fm_diag_ro ⇒ exit 0, read_only_guard on, read_only_role_guard verified, then the query runs",
      r.status === 0 && /read_only_guard\s*\n-+\n\s*on\b/.test(r.stdout) && /read_only_role_guard\s*\n-+\n\s*verified\b/.test(r.stdout) && /after_guard/.test(r.stdout),
      `${r.status} ${r.stdout} ${r.stderr}`);
    console.log(r.stdout.split("\n").map((l) => `      | ${l}`).join("\n"));
  }

  console.log("\n2. P1-b — the role guard refuses every way to write");
  {
    const pw = `pw_${randomBytes(8).toString("hex")}`;
    const mk = su(`
      CREATE ROLE diag_writer NOLOGIN; GRANT INSERT ON canary TO diag_writer;
      CREATE ROLE diag_super     LOGIN SUPERUSER PASSWORD '${pw}';
      CREATE ROLE diag_bypass    LOGIN BYPASSRLS PASSWORD '${pw}';
      CREATE ROLE diag_createrole LOGIN CREATEROLE PASSWORD '${pw}';
      CREATE ROLE diag_direct    LOGIN PASSWORD '${pw}'; GRANT INSERT ON canary TO diag_direct;
      CREATE ROLE diag_colupd    LOGIN PASSWORD '${pw}'; GRANT UPDATE (n) ON canary TO diag_colupd;
      CREATE ROLE diag_seq       LOGIN PASSWORD '${pw}'; GRANT USAGE ON SEQUENCE canary_seq TO diag_seq;
      CREATE ROLE diag_inherit   LOGIN INHERIT PASSWORD '${pw}';   GRANT diag_writer TO diag_inherit;
      CREATE ROLE diag_noinherit LOGIN NOINHERIT PASSWORD '${pw}'; GRANT diag_writer TO diag_noinherit;
      CREATE ROLE diag_pwad      LOGIN PASSWORD '${pw}'; GRANT pg_write_all_data TO diag_pwad;
      CREATE ROLE diag_schema    LOGIN PASSWORD '${pw}'; GRANT CREATE ON SCHEMA public TO diag_schema;
      CREATE ROLE diag_db        LOGIN PASSWORD '${pw}'; GRANT CREATE ON DATABASE postgres TO diag_db;
      CREATE ROLE diag_readall   LOGIN PASSWORD '${pw}'; GRANT pg_read_all_data TO diag_readall;
    `);
    check("negative-case roles created", mk.status === 0, mk.stderr);
    for (const [role, reason] of [
      ["diag_super", /is superuser/], ["diag_bypass", /bypass row-level security/], ["diag_createrole", /CREATEROLE/],
      ["diag_direct", /can write .*canary/], ["diag_colupd", /can write .*canary/], ["diag_seq", /can write .*canary_seq/],
      ["diag_inherit", /can write .*canary/], ["diag_noinherit", /can write \(.*via diag_writer\).*canary/],
      ["diag_pwad", /pg_write_all_data|can write/], ["diag_schema", /CREATE \(via diag_schema\) on schema: public/],
      ["diag_db", /CREATE on database postgres/],
    ] as Array<[string, RegExp]>) {
      const r = helper(["-c", "select 1 as after_guard"], { user: role, pw, require: role });
      check(`refused: ${role}`, r.status !== 0 && /role guard refused/.test(r.stderr) && reason.test(r.stderr) && !/verified|after_guard/.test(r.stdout),
        `${r.status} ${r.stdout} ${r.stderr}`);
    }
    const mismatch = helper(["-c", "select 1 as after_guard"], { user: "fm_diag_ro", pw: RO_PW, require: "diag_readall" });
    check("refused: connected role ≠ DIAG_REQUIRE_ROLE", mismatch.status !== 0 && /connected as fm_diag_ro, expected diag_readall/.test(mismatch.stderr) && !/after_guard/.test(mismatch.stdout), mismatch.stderr);
    const readAll = helper(["-c", "select 1 as after_guard"], { user: "diag_readall", pw, require: "diag_readall" });
    check("pg_read_all_data alone is fine (verified)", readAll.status === 0 && /verified/.test(readAll.stdout), `${readAll.status} ${readAll.stderr}`);
  }

  console.log("\n3. P2-a / P3 — bypasses committed nothing, even as the superuser");
  {
    const evil = path.join(tmp, "evil.sql");
    writeFileSync(evil, "COMMIT;\ninsert into canary values (1);\n");
    const gset = path.join(tmp, "gset.sql");
    writeFileSync(gset, "select 'COMM' || 'IT' as x \\gset\n:x\ninsert into canary values (1);\n");
    const asSuper = { user: "postgres", pw: SUPER_PW };
    const before = { rows: count("select count(*) from canary"), seq: count("select last_value || ':' || is_called from canary_seq") };
    const attempts: Array<[string, string[]]> = [
      ["\\c (no argument) then INSERT", ["-c", "\\c", "-c", "insert into canary values (1)"]],
      ["\\connect postgres then INSERT", ["-c", "\\connect postgres", "-c", "insert into canary values (1)"]],
      ["\\gset + :x interpolation building COMMIT (file)", ["-f", gset]],
      ["\\gset + :x interpolation (-c)", ["-c", "select 'COMM' || 'IT' as x \\gset", "-c", ":x", "-c", "insert into canary values (1)"]],
      ["-fFILE (joined) with COMMIT; INSERT", [`-f${evil}`]],
      ["--file=FILE with COMMIT; INSERT", [`--file=${evil}`]],
      ["exact -f FILE with COMMIT; INSERT", ["-f", evil]],
      ["-d override", ["-d", `postgresql://postgres:${SUPER_PW}@127.0.0.1:${PORT}/postgres`, "-c", "select 1"]],
      ["-v ON_ERROR_STOP=0", ["-v", "ON_ERROR_STOP=0", "-c", "insert into canary values (1)"]],
      ["set_config(…, 'f'::boolean)", ["-c", "select set_config('transaction_read_only', 'off', 'f'::boolean)", "-c", "select 1"]],
      ["set_config(…, NOT true)", ["-c", "select set_config('default_transaction_read_only', 'off', NOT true)"]],
      ["\\! shell", ["-c", "\\! true"]],
      ["\\o file", ["-c", `\\o ${path.join(tmp, "out.txt")}`]],
      ["backtick in \\echo", ["-c", `\\echo \`touch ${path.join(tmp, "pwned")}\``]],
      ["DO block INSERT", ["-c", "DO $$ BEGIN INSERT INTO canary VALUES (1); END $$"]],
      ["CTE INSERT", ["-c", "WITH x AS (INSERT INTO canary VALUES (1) RETURNING 1) SELECT * FROM x"]],
      ["END; then INSERT", ["-c", "select 1; END; insert into canary values (1)"]],
    ];
    for (const [name, args] of attempts) {
      const r = helper(args, asSuper);
      check(`refused before connecting: ${name}`, r.status === 2 && /REFUSED/.test(r.stderr) && !/read_only_guard/.test(r.stdout), `${r.status} ${r.stdout} ${r.stderr}`);
    }
    // Not keyword-visible, so it reaches the database: the read-only transaction must stop it.
    for (const [name, sql] of [["nextval()", "select nextval('canary_seq')"], ["setval()", "select setval('canary_seq', 99)"]] as const) {
      const r = helper(["-c", sql], asSuper);
      check(`fails inside the read-only transaction: ${name}`, r.status !== 0 && /read-only transaction/.test(r.stderr), `${r.status} ${r.stderr}`);
    }
    const ro = helper(["-c", "show transaction_read_only"], asSuper);
    check("even the superuser's session is read-only inside the helper", ro.status === 0 && /transaction_read_only\s*\n-+\n\s*on/.test(ro.stdout), ro.stdout);
    const after = { rows: count("select count(*) from canary"), seq: count("select last_value || ':' || is_called from canary_seq") };
    check(`ZERO rows committed: canary ${before.rows}→${after.rows}, sequence ${before.seq}→${after.seq}`, before.rows === "0" && after.rows === "0" && before.seq === after.seq);
    check("no file was written by \\o or a backtick", !existsSync(path.join(tmp, "out.txt")) && !existsSync(path.join(tmp, "pwned")));
  }

  console.log("\n4. P2-b / P2-c — URL redirection and the password");
  {
    for (const [name, url] of [
      ["?host= → the container", `postgresql://postgres:${SUPER_PW}@remote.invalid:1/postgres?host=127.0.0.1&port=${PORT}&sslmode=disable`],
      ["?hostaddr= → the container", `postgresql://postgres:${SUPER_PW}@remote.invalid:${PORT}/postgres?hostaddr=127.0.0.1&sslmode=disable`],
      ["?options= weakening read-only", `postgresql://postgres:${SUPER_PW}@127.0.0.1:${PORT}/postgres?sslmode=disable&options=-c%20default_transaction_read_only%3Doff`],
      ["multi-host", `postgresql://postgres:${SUPER_PW}@remote.invalid:1,127.0.0.1:${PORT}/postgres?sslmode=disable`],
    ] as const) {
      const r = helper(["-c", "select 1"], { user: "", pw: "", rawUrl: url });
      check(`refused even with DIAG_ALLOW_LOCAL=1: ${name}`, r.status === 2 && /REFUSED/.test(r.stderr) && !r.stdout, r.stderr);
    }
    const noLocal = spawnSync("bash", [SCRIPT, "-c", "select 1"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "",
      DIAG_DATABASE_URL: `postgresql://postgres:${SUPER_PW}@127.0.0.1:${PORT}/postgres?sslmode=disable` } as unknown as NodeJS.ProcessEnv });
    check("without DIAG_ALLOW_LOCAL the container URL is refused", noLocal.status === 2 && /local\/loopback/.test(noLocal.stderr), noLocal.stderr);
    const inherited = helper(["-c", "select current_setting('search_path') as sp"], { user: "fm_diag_ro", pw: RO_PW, require: "fm_diag_ro",
      env: { PGPASSWORD: "wrong", PGUSER: "postgres", PGOPTIONS: "-c search_path=evil_inherited", PGHOST: "nowhere.invalid", PGSERVICE: "nope" } });
    check("inherited PGPASSWORD/PGUSER/PGOPTIONS/PGHOST/PGSERVICE are ignored", inherited.status === 0 && /verified/.test(inherited.stdout) && !/evil_inherited/.test(inherited.stdout), `${inherited.status} ${inherited.stderr}`);
    for (const [mode, bashArgs, env] of [["bash -x", ["-x"], {}], ["SHELLOPTS=xtrace", [], { SHELLOPTS: "xtrace" }], ["bash -xv", ["-xv"], {}]] as const) {
      const ok = helper(["-c", "select 1"], { user: "fm_diag_ro", pw: RO_PW, require: "fm_diag_ro", bashArgs: [...bashArgs], env: { ...env } });
      check(`${mode}, successful run: password absent from stdout/stderr`, ok.status === 0 && /verified/.test(ok.stdout) && !`${ok.stdout}${ok.stderr}`.includes(RO_PW.slice(0, 12)),
        `${ok.status} ${ok.stderr.slice(0, 300)}`);
      const bad = helper(["-c", "select 1"], { user: "fm_diag_ro", pw: `${RO_PW}%zz`, require: "fm_diag_ro", bashArgs: [...bashArgs], env: { ...env } });
      check(`${mode}, bad percent-escape: refused, password absent`, bad.status === 2 && !`${bad.stdout}${bad.stderr}`.includes(RO_PW.slice(0, 12)), `${bad.status} ${bad.stderr.slice(0, 300)}`);
    }
    const wrongPw = helper(["-c", "select 1"], { user: "fm_diag_ro", pw: `${RO_PW}x`, require: "fm_diag_ro" });
    check("wrong password: psql's auth error does not contain the password", wrongPw.status !== 0 && !`${wrongPw.stdout}${wrongPw.stderr}`.includes(RO_PW.slice(0, 12)), wrongPw.stderr);
  }

  console.log("\n5. the real investigation, end to end, as fm_diag_ro");
  {
    const check5 = (label: string, r: SpawnSyncReturns<string>) => {
      const out = r.stdout;
      check(`${label}: exit 0`, r.status === 0, `${r.status} ${r.stderr}`);
      check(`${label}: read_only_guard = on, read_only_role_guard = verified (first rows)`,
        /^\s*read_only_guard\s*\n-+\n\s*on\s*\n/.test(out) && /read_only_role_guard\s*\n-+\n\s*verified\b/.test(out), out.slice(0, 400));
      check(`${label}: sections A–F all ran`, ["== A.", "== B.", "== C.", "== D.", "== E.", "== F."].every((s) => out.includes(s)));
      check(`${label}: ≤3-char local parts show 1 char (a…@gmail.com, a…@(custom domain)); longer ones 2 (jo…)`,
        out.includes("a…@gmail.com") && out.includes("a…@(custom domain)") && out.includes("jo…@gmail.com") && !out.includes("ab…@"));
      check(`${label}: no raw email, IP, user agent, note, token hash or country value`,
        !/ab@gmail|abc@example|johnsmith|203\.0\.113|198\.51|Mozilla|let me in|SECRET_TOKEN|ZZCOUNTRY|owner@example/.test(out));
      check(`${label}: country is bucketed present/absent`, /\bpresent\b/.test(out) && /\babsent\b/.test(out));
      check(`${label}: RLS limits F to the intake key (1 window, max 3)`, /\n\s*1 \|\s+3\s*\n/.test(out), out.slice(-300));
    };
    const r = helper(["-f", INVESTIGATION], { user: "fm_diag_ro", pw: RO_PW, require: "fm_diag_ro" });
    check5("bash", r);
    for (const [name, sql] of [["\"User\"", 'select 1 from "User" limit 1'], ["inviteTokenHash", 'select "inviteTokenHash" from "BetaAccessRequest" limit 1']]) {
      const d = helper(["-c", sql], { user: "fm_diag_ro", pw: RO_PW, require: "fm_diag_ro" });
      check(`fm_diag_ro cannot read ${name} (permission denied)`, d.status !== 0 && /permission denied/.test(d.stderr), d.stderr);
    }
    const pre = suFile(path.join(ROOT, "docs", "operations", "sql", "prod-diag-role-precheck.sql"));
    check("prod-diag-role-precheck.sql runs (rows 12–14 = the role guard's PUBLIC tripwires: none / 0 / false)",
      pre.status === 0 && /12 \| role guard: schemas where PUBLIC holds CREATE \(expect none\)\s*\| none/.test(pre.stdout)
        && /13 \| [^\n]*\| 0\s*\n/.test(pre.stdout) && /14 \| [^\n]*\| false/.test(pre.stdout), `${pre.status} ${pre.stdout} ${pre.stderr}`);
    if (has("zsh", ["--version"])) {
      // The owner's sequence (prod-diag-readonly-role.md §4), host swapped for the container
      // and the TEST-ONLY local override added. The password arrives on stdin, as from the hidden prompt.
      const seq = [
        `read -rs "DIAG_PW?fm_diag_ro password: "; echo`,
        `DIAG_ALLOW_LOCAL=1 DIAG_DATABASE_URL="postgresql://fm_diag_ro:\${DIAG_PW}@127.0.0.1:${PORT}/postgres?sslmode=disable" \\`,
        `DIAG_REQUIRE_ROLE=fm_diag_ro \\`,
        `  scripts/db-readonly-psql.sh -f docs/operations/sql/beta-request-prod-investigation.sql`,
        `rc=$?; unset DIAG_PW; exit $rc`,
      ].join("\n");
      const z = spawnSync("zsh", ["-f", "-c", seq], { cwd: ROOT, encoding: "utf8", input: `${RO_PW}\n`, timeout: 60_000,
        env: { PATH: process.env.PATH ?? "", HOME: tmp } as unknown as NodeJS.ProcessEnv });
      check5("owner zsh sequence", z);
      check("owner zsh sequence: password absent from output", !`${z.stdout}${z.stderr}`.includes(RO_PW.slice(0, 12)));
    } else {
      console.log("  SKIP owner zsh sequence: zsh not installed");
    }
  }
} catch (e) {
  failures++;
  console.error(`  ✗ container test aborted — ${(e as Error).message}`);
} finally {
  teardown();
  rmSync(tmp, { recursive: true, force: true });
}
const left = spawnSync("docker", ["ps", "-a", "--filter", `name=^${NAME}$`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
check(`container ${NAME} removed (docker rm -f -v)`, left === "", left);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
