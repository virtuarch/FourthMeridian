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
 * Container: `docker run -d --rm` postgres:17-alpine (Production runs 17.6) on 127.0.0.1 (docker-assigned
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
  const runC = sh("docker", ["run", "-d", "--rm", "--name", NAME, "-e", `POSTGRES_PASSWORD=${SUPER_PW}`, "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
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
    -- Production's two SECURITY DEFINER RLS helpers: STABLE, SECURITY DEFINER, EXECUTE to PUBLIC (the default).
    CREATE FUNCTION public.fm_visible_space_ids() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public AS $$ SELECT id FROM public."User" $$;
    CREATE FUNCTION public.fm_may_join_space(space text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public AS $$ SELECT space IS NOT NULL $$;
    GRANT EXECUTE ON FUNCTION public.fm_visible_space_ids(), public.fm_may_join_space(text) TO PUBLIC;
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
  const RO_PW = `Ro!p:ss-w~rd_${randomBytes(6).toString("hex")}`;   // raw : ! ~ are fine; @ / ? # must be percent-encoded
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
      CREATE ROLE diag_srvprog   LOGIN PASSWORD '${pw}'; GRANT pg_execute_server_program TO diag_srvprog;
      CREATE ROLE diag_srvfiles  LOGIN PASSWORD '${pw}'; GRANT pg_write_server_files TO diag_srvfiles;
      CREATE ROLE diag_signal    LOGIN PASSWORD '${pw}'; GRANT pg_signal_backend TO diag_signal;
      CREATE ROLE diag_ckpt      LOGIN PASSWORD '${pw}'; GRANT pg_checkpoint TO diag_ckpt;
      CREATE ROLE diag_subscr    LOGIN PASSWORD '${pw}'; GRANT pg_create_subscription TO diag_subscr;
      CREATE ROLE diag_srv_inh   LOGIN PASSWORD '${pw}'; CREATE ROLE diag_srv_mid NOLOGIN; GRANT pg_execute_server_program TO diag_srv_mid; GRANT diag_srv_mid TO diag_srv_inh;
      CREATE ROLE diag_owner_tbl LOGIN PASSWORD '${pw}'; CREATE TABLE owned_by_diag (x int); ALTER TABLE owned_by_diag OWNER TO diag_owner_tbl;
      CREATE ROLE diag_owner_fn  LOGIN PASSWORD '${pw}'; CREATE FUNCTION owned_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION owned_fn() OWNER TO diag_owner_fn;
      REVOKE EXECUTE ON FUNCTION owned_fn() FROM PUBLIC;
      CREATE ROLE diag_lo        LOGIN PASSWORD '${pw}'; SELECT lo_create(424242); GRANT UPDATE ON LARGE OBJECT 424242 TO diag_lo;
      CREATE ROLE diag_rsf       LOGIN PASSWORD '${pw}'; GRANT pg_read_server_files TO diag_rsf;
      CREATE ROLE diag_maintain  LOGIN PASSWORD '${pw}'; GRANT pg_maintain TO diag_maintain;
      CREATE FOREIGN DATA WRAPPER fm_dummy_fdw; CREATE SERVER fm_dummy_srv FOREIGN DATA WRAPPER fm_dummy_fdw;
      CREATE ROLE diag_fsrv      LOGIN PASSWORD '${pw}'; GRANT USAGE ON FOREIGN SERVER fm_dummy_srv TO diag_fsrv;
      CREATE ROLE diag_umap      LOGIN PASSWORD '${pw}'; CREATE USER MAPPING FOR diag_umap SERVER fm_dummy_srv;
    `);
    check("negative-case roles created", mk.status === 0, mk.stderr);
    for (const [role, reason] of [
      ["diag_super", /is superuser/], ["diag_bypass", /bypass row-level security/], ["diag_createrole", /CREATEROLE/],
      ["diag_direct", /can write .*canary/], ["diag_colupd", /can write .*canary/], ["diag_seq", /can write .*canary_seq/],
      ["diag_inherit", /can write .*canary/], ["diag_noinherit", /can write \(.*via diag_writer\).*canary/],
      ["diag_pwad", /pg_write_all_data|can write/], ["diag_schema", /CREATE \(via diag_schema\) on schema: public/],
      ["diag_db", /CREATE on database postgres/],
      ["diag_srvprog", /member of pg_execute_server_program/], ["diag_srvfiles", /member of pg_write_server_files/],
      ["diag_signal", /member of pg_signal_backend/], ["diag_ckpt", /member of pg_checkpoint/], ["diag_subscr", /member of pg_create_subscription/],
      ["diag_srv_inh", /member of pg_execute_server_program/], ["diag_owner_tbl", /owns database objects/], ["diag_owner_fn", /owns database objects/],
      ["diag_lo", /can write a large object/],
      ["diag_readall", /member of pg_read_all_data/], ["diag_rsf", /member of pg_read_server_files/], ["diag_maintain", /member of pg_maintain/],
      ["diag_fsrv", /can use a foreign server/], ["diag_umap", /user mapping exists|owns database objects/],
    ] as Array<[string, RegExp]>) {
      const r = helper(["-c", "select 1 as after_guard"], { user: role, pw, require: role });
      check(`refused: ${role}`, r.status !== 0 && /role guard refused/.test(r.stderr) && reason.test(r.stderr) && !/verified|after_guard/.test(r.stdout),
        `${r.status} ${r.stdout} ${r.stderr}`);
    }
    const mismatch = helper(["-c", "select 1 as after_guard"], { user: "fm_diag_ro", pw: RO_PW, require: "diag_readall" });
    check("refused: connected role ≠ DIAG_REQUIRE_ROLE", mismatch.status !== 0 && /connected as fm_diag_ro, expected diag_readall/.test(mismatch.stderr) && !/after_guard/.test(mismatch.stdout), mismatch.stderr);

    // SECURITY DEFINER: the two STABLE Production helpers are allowlisted; anything else is refused.
    const ro = (sql = "select 1 as after_guard") => helper(["-c", sql], { user: "fm_diag_ro", pw: RO_PW, require: "fm_diag_ro" });
    const can = su("select has_function_privilege('fm_diag_ro', 'public.fm_visible_space_ids()', 'EXECUTE') and has_function_privilege('fm_diag_ro', 'public.fm_may_join_space(text)', 'EXECUTE')").stdout.trim();
    const base = ro();
    check("fm_diag_ro CAN execute the two STABLE SECURITY DEFINER helpers (PUBLIC) and the guard still passes",
      can === "t" && base.status === 0 && /verified/.test(base.stdout), `${can} ${base.status} ${base.stderr}`);
    const path0 = ro("show search_path");
    check("the guard restores search_path afterwards (pinned to pg_catalog only while it runs)", path0.status === 0 && /"\$user", public/.test(path0.stdout), path0.stdout);
    su(`CREATE FUNCTION public.fm_evil_writer() RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER AS 'INSERT INTO public.canary VALUES (1)'`);
    const evilFn = ro();
    check("a VOLATILE writer SECURITY DEFINER function executable by PUBLIC ⇒ refused",
      evilFn.status !== 0 && /SECURITY DEFINER function\(s\).*fm_evil_writer\(\)/.test(evilFn.stderr) && !/after_guard/.test(evilFn.stdout), evilFn.stderr);
    su("DROP FUNCTION public.fm_evil_writer()");
    su("ALTER FUNCTION public.fm_may_join_space(text) VOLATILE");
    const vol = ro();
    check("an allowlisted name turned VOLATILE ⇒ refused", vol.status !== 0 && /fm_may_join_space\(text\)/.test(vol.stderr), vol.stderr);
    su("ALTER FUNCTION public.fm_may_join_space(text) STABLE");
    su(`CREATE FUNCTION public.fm_may_join_space(space integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS 'SELECT true'`);
    const sig = ro();
    check("an allowlisted name with a different signature ⇒ refused", sig.status !== 0 && /fm_may_join_space\(integer\)/.test(sig.stderr), sig.stderr);
    su("DROP FUNCTION public.fm_may_join_space(integer)");
    su("ALTER DATABASE postgres SET lo_compat_privileges = on");
    const loc = ro();
    check("lo_compat_privileges = on ⇒ refused", loc.status !== 0 && /lo_compat_privileges/.test(loc.stderr), loc.stderr);
    su("ALTER DATABASE postgres RESET lo_compat_privileges");
    su("CREATE USER MAPPING FOR PUBLIC SERVER fm_dummy_srv");
    const pubMap = ro();
    check("a user mapping for PUBLIC ⇒ refused", pubMap.status !== 0 && /user mapping exists/.test(pubMap.stderr), pubMap.stderr);
    su("DROP USER MAPPING FOR PUBLIC SERVER fm_dummy_srv");
    const ext = su("CREATE EXTENSION dblink");
    const dbl = ro();
    check("dblink installed (EXECUTE to PUBLIC) ⇒ refused", ext.status === 0 && dbl.status !== 0 && /dblink function/.test(dbl.stderr), `${ext.stderr} ${dbl.stderr}`);
    su("DROP EXTENSION dblink");
    const cat = su("CREATE FUNCTION pg_catalog.fm_cat_writer() RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER AS 'INSERT INTO public.canary VALUES (1)'");
    const catR = ro();
    check("a user-created VOLATILE SECURITY DEFINER function in pg_catalog (oid >= 16384) ⇒ refused",
      cat.status === 0 && catR.status !== 0 && /pg_catalog\.fm_cat_writer\(\)/.test(catR.stderr), `${cat.stderr} ${catR.stderr}`);
    su("DROP FUNCTION pg_catalog.fm_cat_writer()");
    const again = ro();
    check("back to the Production shape ⇒ verified again", again.status === 0 && /verified/.test(again.stdout), again.stderr);
  }

  console.log("\n3. P2-a / P3 — bypasses committed nothing, even as the superuser");
  {
    const evil = path.join(tmp, "evil.sql");
    writeFileSync(evil, "COMMIT;\ninsert into canary values (1);\n");
    const gset = path.join(tmp, "gset.sql");
    writeFileSync(gset, "select 'COMM' || 'IT' as x \\gset\n:x\ninsert into canary values (1);\n");
    const asSuper = { user: "postgres", pw: SUPER_PW };
    const nulFile = path.join(tmp, "nul.sql");
    writeFileSync(nulFile, Buffer.from("select 1;\nCOM\u0000\nMIT;\ninsert into canary values (1);\n", "binary"));
    const caseLabelFile = path.join(tmp, "caselabel.sql");
    writeFileSync(caseLabelFile, "SELECT 1 AS case;\nEND;\ninsert into canary values (1);\n");
    const crlfFile = path.join(tmp, "crlf.sql");
    writeFileSync(crlfFile, "select 1;\r\nend\r\n;\r\nselect nextval('canary_seq');\r\n");
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
      ["NUL byte in a file: COM\\0\\nMIT;", ["-f", nulFile]],
      ["bare END (-c 'select 1; end')", ["-c", "select 1; end"]],
      ["END AND NO CHAIN", ["-c", "select 1; END AND NO CHAIN"]],
      ["END with CR before ';' (-c)", ["-c", "select 1;\rend\r;"]],
      ["END with newline before ';' (-c)", ["-c", "select 1;\nend\n;"]],
      ["CRLF file with a bare END", ["-f", crlfFile]],
      ["'case' in a string to balance an END", ["-c", "select 'case'; end"]],
      ["CASE as a column label to balance an END", ["-c", "SELECT 1 AS case; END; insert into canary values (1)"]],
      ["CASE label + END in a file", ["-f", caseLabelFile]],
      ["dollar-quote tag with digits ($q1$)", ["-c", "select $q1$x$q1$"]],
      ["query_to_xml running an INSERT from a string", ["-c", "select query_to_xml('insert into canary values (1) returning 1', true, true, '')"]],
      ["ts_stat running SQL from a string", ["-c", "select * from ts_stat('select to_tsvector(''x'')')"]],
      ["U&'…' escape", ["-c", "select U&'\\0043OMMIT'"]],
      ["SET LOCAL statement_timeout", ["-c", "SET LOCAL statement_timeout = 0"]],
      ["\\pset 'pager'", ["-c", "\\pset 'pager' on"]],
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
    // The run ENDS IN ROLLBACK (no -1/COMMIT): the server counts a rollback, and a
    // rolled-back transaction reverts even a session-level set_config.
    const stat = () => Number(count("select xact_rollback from pg_stat_database where datname = 'postgres'"));
    const rb0 = stat();
    const plain = helper(["-c", "select 1 as ok"], asSuper);
    spawnSync("sleep", ["1"]);
    const rb1 = stat();
    check(`a successful helper run ends in ROLLBACK (xact_rollback ${rb0}→${rb1})`, plain.status === 0 && rb1 >= rb0 + 1, `${plain.status} ${plain.stderr}`);
    const rev = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres",
      "-c", "BEGIN", "-c", "SELECT set_config('application_name', 'leaked_setting', false)", "-c", "ROLLBACK", "-c", "SHOW application_name"], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", PGPASSWORD: SUPER_PW } as unknown as NodeJS.ProcessEnv });
    check("PostgreSQL: ROLLBACK reverts a SESSION-level set_config made inside the transaction",
      rev.status === 0 && rev.stdout.includes("leaked_setting") && (rev.stdout.trim().split("\n").pop() ?? "") !== "leaked_setting", rev.stdout);
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
      check(`${label}: local part ≤2 chars shows NONE (…@gmail.com), 3 chars shows 1 (a…@(custom domain)), longer shows 2 (jo…)`,
        / …@gmail\.com/.test(out) && !out.includes("a…@gmail.com") && out.includes("a…@(custom domain)") && out.includes("jo…@gmail.com") && !out.includes("ab…@"));
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
    const row = (n: number) => (pre.stdout.split("\n").find((l) => new RegExp(`^\\s*${n} \\|`).test(l)) ?? "").split("|").pop()?.trim() ?? "(missing)";
    const r15 = "public.fm_may_join_space(text) s [allowlisted], public.fm_visible_space_ids() s [allowlisted]";
    check("prod-diag-role-precheck.sql runs (rows 12–18 = the role guard's PUBLIC tripwires: none / 0 / false / only the allowlisted pair / 0 / 0 / none)",
      pre.status === 0 && row(12) === "none" && row(13) === "0" && row(14) === "false" && row(15).split(", ").sort().join(", ") === r15
        && row(16) === "0" && row(17) === "0" && row(18) === "none",
      `${pre.status} 12=${row(12)} 13=${row(13)} 14=${row(14)} 15=${row(15)} 16=${row(16)} 17=${row(17)} 18=${row(18)} ${pre.stderr}`);
    if (has("zsh", ["--version"])) {
      // The owner's sequence (prod-diag-readonly-role.md §4), host swapped for the container
      // and the TEST-ONLY local override added. The password arrives on stdin, as from the hidden prompt.
      const zblock = /```zsh\n([\s\S]*?)```/.exec(readFileSync(ROLE_DOC, "utf8"))?.[1] ?? "";
      check("§4 owner block: a ( … ) subshell with a trap that unsets the password, and no line continuations",
        /^\s*\(\s*\n\s*trap 'unset DIAG_PW' EXIT INT TERM\n/.test(zblock) && !/\\\n/.test(zblock) && /\n\s*\)\s*$/.test(zblock), zblock);
      const seq = zblock
        .replace("db.<project-ref>.supabase.co:5432", `127.0.0.1:${PORT}`)
        .replace("sslmode=require", "sslmode=disable")
        .replace('DIAG_DATABASE_URL="', 'DIAG_ALLOW_LOCAL=1 DIAG_DATABASE_URL="');
      check("§4 owner block adapted to the container (host, sslmode, test-only override)", seq.includes(`127.0.0.1:${PORT}`) && seq.includes("DIAG_ALLOW_LOCAL=1 DIAG_DATABASE_URL="));
      const z = spawnSync("zsh", ["-f", "-c", seq], { cwd: ROOT, encoding: "utf8", input: `${RO_PW}\n`, timeout: 60_000,
        env: { PATH: process.env.PATH ?? "", HOME: tmp } as unknown as NodeJS.ProcessEnv });
      check5("owner zsh sequence", z);
      check("owner zsh sequence: password absent from output", !`${z.stdout}${z.stderr}`.includes(RO_PW.slice(0, 12)));
      const zi = spawnSync("zsh", ["-f", "-c", `${seq}\nprint -r -- "after=\${DIAG_PW-unset}"`], { cwd: ROOT, encoding: "utf8", input: `${RO_PW}\n`, timeout: 60_000,
        env: { PATH: process.env.PATH ?? "", HOME: tmp } as unknown as NodeJS.ProcessEnv });
      check("owner zsh sequence: DIAG_PW does not survive the block", /after=unset/.test(zi.stdout), zi.stdout.slice(-200));
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
