/**
 * scripts/rls-acceptance.ts  (RLS-1)
 *
 * THE ADVERSARIAL TENANT-ISOLATION SUITE.
 *
 * This proves the DATABASE security boundary, not application middleware. Every
 * assertion below is issued as the runtime role `fm_app` over a plain SQL
 * connection with no application code in the path at all — so a passing run says
 * something the route tests cannot: that a buggy query which forgets its tenant
 * filter still cannot return another user's financial data.
 *
 * ── WHY IT BUILDS ITS OWN DATABASE ───────────────────────────────────────────
 * It starts a throwaway Postgres container, applies the committed migration
 * history with `prisma migrate deploy` exactly as production will, and only then
 * runs. It never touches the dev database, preview or production. The database
 * is named `fintracker_rls_<pid>` so lib/db/live-guard.ts classifies it NON_LIVE.
 *
 * ── WHY PSQL AND NOT PRISMA ──────────────────────────────────────────────────
 * The boundary under test is PostgreSQL's. Driving it through the ORM would
 * prove the ORM's where-clauses as much as the policies. psql also lets a single
 * session run several transactions in order, which is how the SET LOCAL
 * lifetime cases (commit, rollback, missing) are proven.
 *
 *   npx tsx scripts/rls-acceptance.ts            # full run
 *   npx tsx scripts/rls-acceptance.ts --keep     # leave the container up
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes }             from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir }                  from "node:os";
import { join }                    from "node:path";

const KEEP  = process.argv.includes("--keep");
/**
 * When RLS_TARGET_URL is set the suite runs against THAT database instead of
 * building one. CI already has a throwaway Postgres service with the migration
 * history applied, and starting a second container inside the job would be
 * wasteful and slower. The URL must be a clone — lib/db/live-guard.ts's naming
 * rule is the check, and it is enforced below before a single statement runs.
 */
const TARGET_URL = process.env.RLS_TARGET_URL ?? null;
const IMAGE = "postgres:16-alpine";
const DB    = `fintracker_rls_${process.pid}`;
const OWNER = "fmowner";
const OWNER_PW = randomBytes(18).toString("hex");
const APP_PW   = randomBytes(18).toString("hex");

let container: string | null = null;
let workdir:   string | null = null;

function sh(cmd: string, args: string[], opts: { input?: string } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input: opts.input });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function teardown() {
  if (container && !KEEP) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  if (workdir   && !KEEP) { try { rmSync(workdir, { recursive: true, force: true }); } catch {} }
}
process.on("exit", teardown);
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { teardown(); process.exit(130); });

// ── results ───────────────────────────────────────────────────────────────────
type Result = { n: number; name: string; ok: boolean; detail: string };
const results: Result[] = [];
function check(n: number, name: string, ok: boolean, detail = "") {
  results.push({ n, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(n).padStart(2)}. ${name}${ok ? "" : `  -> ${detail}`}`);
}

// ── container ────────────────────────────────────────────────────────────────
function startPostgres(): { base: string; port: string } {
  if (!sh("docker", ["info", "--format", "{{.ServerVersion}}"]).ok) {
    throw new Error("Docker is not available — this suite builds its own throwaway Postgres and will not fall back to any configured database.");
  }
  container = `fm-rls-${process.pid}-${Date.now().toString(36)}`;
  const run = sh("docker", [
    "run", "-d", "--rm", "--name", container,
    "-e", `POSTGRES_USER=${OWNER}`,
    "-e", `POSTGRES_PASSWORD=${OWNER_PW}`,
    "-e", `POSTGRES_DB=${DB}`,
    "-p", "127.0.0.1::5432",
    IMAGE,
  ]);
  if (!run.ok) throw new Error(`could not start ${IMAGE}: ${run.err || run.out}`);

  const deadline = Date.now() + 90_000;
  while (!sh("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", OWNER, "-d", DB]).ok) {
    if (Date.now() > deadline) throw new Error("throwaway Postgres did not become ready within 90s");
    spawnSync("sleep", ["1"]);
  }
  const mapped = sh("docker", ["port", container, "5432/tcp"]).out.split("\n")[0];
  const port = /^127\.0\.0\.1:(\d+)$/.exec(mapped)?.[1];
  if (!port) throw new Error(`unexpected port mapping "${mapped}"`);
  return { base: `postgresql://${OWNER}:${OWNER_PW}@127.0.0.1:${port}/${DB}`, port };
}

// ── psql helpers ─────────────────────────────────────────────────────────────
/** Run SQL as a given role. Returns rows as raw tab-separated lines. */
function psql(url: string, sql: string, stopOnError = true) {
  const args = ["-X", "-q", "-A", "-t", "--no-psqlrc"];
  if (stopOnError) args.push("-v", "ON_ERROR_STOP=1");
  args.push(url);
  const r = spawnSync("psql", args, { encoding: "utf8", input: sql });
  const err = (r.stderr ?? "").trim();
  // psql exits 0 on a statement error unless ON_ERROR_STOP is set, and these
  // cases deliberately run without it (a denial is the expected outcome, and we
  // still want the statements that follow). So success is judged on stderr, not
  // on the exit code — otherwise a refusal reads as a pass.
  return { ok: r.status === 0 && !/\bERROR:/.test(err), out: (r.stdout ?? "").trim(), err };
}
/** True when the statement was refused by a row-level security policy. */
const deniedByRls   = (r: { err: string }) => /row-level security policy/i.test(r.err);
/** True when the role has no privilege on the relation at all. */
const deniedByGrant = (r: { err: string }) => /permission denied/i.test(r.err);
/** Scalar query as fm_app with an identity, inside ONE transaction. */
function asApp(appUrl: string, userId: string | null, sql: string) {
  const setLocal = userId === null ? "" : `SET LOCAL app.user_id = '${userId}';\n`;
  return psql(appUrl, `BEGIN;\n${setLocal}${sql}\nCOMMIT;`, false);
}

async function main(): Promise<void> {
  console.log("\n=== RLS ACCEPTANCE SUITE ===\n");

  let base: string;
  if (TARGET_URL) {
    const name = TARGET_URL.split("/").pop()?.split("?")[0] ?? "";
    if (!/^fintracker_[a-z0-9_]+$/.test(name)) {
      throw new Error(`RLS_TARGET_URL names "${name}", which is not a recognised clone. This suite writes fixtures and will not run against a database it cannot prove is disposable.`);
    }
    base = TARGET_URL.split("?")[0];
    console.log(`[rls] using the provided throwaway database: ${name}`);
    console.log("[rls] assuming the migration history is already applied (CI applies it as its own step).");
  } else {
    base = startPostgres().base;
    console.log(`[rls] throwaway database: ${DB} in container ${container}`);
    console.log("[rls] applying committed migration history (prisma migrate deploy)...");
    const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: `${base}?schema=public`, DIRECT_URL: `${base}?schema=public` },
    });
    if (migrate.status !== 0) {
      console.error(migrate.stdout, migrate.stderr);
      throw new Error("prisma migrate deploy failed against the throwaway database");
    }
    console.log("[rls] migration history applied.");
  }

  // 2. give fm_app a throwaway password (the migration deliberately creates the
  //    roles WITHOUT one; secrets never live in source control)
  const pw = psql(base, `ALTER ROLE fm_app LOGIN PASSWORD '${APP_PW}';`);
  if (!pw.ok) throw new Error(`could not set the throwaway fm_app password: ${pw.err}`);
  const appUrl = base.replace(`${OWNER}:${OWNER_PW}`, `fm_app:${APP_PW}`);

  // 3. fixtures, written as the OWNER so RLS does not interfere with setup
  console.log("[rls] seeding Alice / Bob fixtures...");
  // Idempotent: the suite may run against a clone that already carries them.
  psql(base, FIXTURE_CLEANUP, false);
  const seed = psql(base, FIXTURES);
  if (!seed.ok) throw new Error(`fixture seed failed: ${seed.err}`);

  console.log("\n[rls] adversarial cases (all issued as fm_app over plain SQL):\n");

  // ── role posture ───────────────────────────────────────────────────────────
  const bypass = psql(base, `select rolbypassrls from pg_roles where rolname='fm_app';`).out;
  check(15, "fm_app does NOT have BYPASSRLS", bypass === "f", `rolbypassrls=${bypass}`);

  const owns = psql(base, `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                           where n.nspname='public' and c.relkind='r' and pg_get_userbyid(c.relowner)='fm_app';`).out;
  check(16, "fm_app owns NO protected tables", owns === "0", `owns ${owns}`);

  const noRls = psql(base, `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                            where n.nspname='public' and c.relkind='r' and c.relrowsecurity
                              and not c.relforcerowsecurity;`).out;
  check(17, "every RLS-enabled table also has FORCE", noRls === "0", `${noRls} enabled-but-not-forced`);

  // ── reads ──────────────────────────────────────────────────────────────────
  const r1 = asApp(appUrl, "alice", `select count(*) from "Transaction" where "financialAccountId"='acct_alice';`);
  check(1, "Alice reads her own transaction — allowed", r1.ok && r1.out.includes("2"), r1.out || r1.err);

  const r2 = asApp(appUrl, "alice", `select count(*) from "Transaction" where "financialAccountId"='acct_bob';`);
  check(2, "Alice reads Bob's transaction — invisible", r2.ok && r2.out.includes("0"), r2.out || r2.err);

  // THE PRIMARY ACCEPTANCE PROPERTY
  // 3 = her own two, plus the one on the jointly-linked account. Bob's is NOT
  // among them, which is the whole point. The corpus has 4 transactions.
  const r3 = asApp(appUrl, "alice", `select count(*) from "Transaction";`);
  const r3bob = asApp(appUrl, "alice", `select count(*) from "Transaction" where id='tx_bob_1';`);
  check(3, "PRIMARY: Alice SELECTs Transaction with NO tenant predicate — Bob's row is still unreachable",
        r3.ok && r3.out.trim() === "3" && r3bob.out.trim() === "0",
        `visible=${r3.out || r3.err} (expected 3 of 4), bob-visible=${r3bob.out}`);

  const r4 = asApp(appUrl, "alice", `select count(*) from "Transaction" where id='tx_bob_1';`);
  check(4, "Alice supplies Bob's known transaction id — no existence oracle",
        r4.ok && r4.out.includes("0"), r4.out || r4.err);

  // ── writes ─────────────────────────────────────────────────────────────────
  const r5 = asApp(appUrl, "alice",
    `insert into "Transaction" (id,"financialAccountId",date,merchant,category,amount,"updatedAt")
     values ('tx_evil_1','acct_bob',current_date,'Evil','Other',-1,now());`);
  check(5, "Alice INSERTs a transaction into Bob's account — denied by WITH CHECK",
        deniedByRls(r5), r5.err.split("\n")[0] || "insert unexpectedly succeeded");

  const r6 = asApp(appUrl, "alice",
    `update "Transaction" set "financialAccountId"='acct_bob' where id='tx_alice_1';`);
  check(6, "Alice repoints her own row at Bob's account — denied by WITH CHECK on the post-image",
        deniedByRls(r6), r6.err.split("\n")[0] || "update unexpectedly succeeded");

  const r7 = asApp(appUrl, "alice", `update "Transaction" set amount=-999 where id='tx_bob_1';`);
  const r7rows = asApp(appUrl, "bob", `select amount::int from "Transaction" where id='tx_bob_1';`).out;
  check(7, "Alice UPDATEs Bob's row — zero rows affected, Bob's data unchanged",
        r7.ok && r7rows === "-50", `bob amount now ${r7rows}`);

  const r8 = asApp(appUrl, "alice", `delete from "Transaction" where id='tx_bob_1';`);
  const r8rows = asApp(appUrl, "bob", `select count(*) from "Transaction" where id='tx_bob_1';`).out;
  check(8, "Alice DELETEs Bob's row — zero rows affected, row survives",
        r8.ok && r8rows === "1", `rows remaining ${r8rows}`);

  // ── user-private inside a SHARED space ─────────────────────────────────────
  const r9 = asApp(appUrl, "bob", `select count(*) from "SpaceMemory";`);
  check(9, "Bob cannot read Alice's SpaceMemory in the SHARED space (ownerUserId, not just spaceId)",
        r9.ok && r9.out.includes("0"), r9.out || r9.err);

  const r10 = asApp(appUrl, "bob", `select count(*) from "PlaidItem";`);
  check(10, "Bob cannot read Alice's user-private records (PlaidItem)",
        r10.ok && r10.out.includes("0"), r10.out || r10.err);

  // ── shared space + many-to-many ────────────────────────────────────────────
  const r11 = asApp(appUrl, "bob", `select count(*) from "Transaction" where "financialAccountId"='acct_shared';`);
  check(11, "Shared Space: Bob (VIEWER of S) sees the shared account's transactions",
        r11.ok && r11.out.includes("1"), r11.out || r11.err);

  const r11b = asApp(appUrl, "alice", `select count(*) from "Transaction" where "financialAccountId"='acct_shared';`);
  check(18, "Many-to-many: the same shared account is visible to Alice too",
        r11b.ok && r11b.out.includes("1"), r11b.out || r11b.err);

  psql(base, `update "SpaceMember" set status='REMOVED' where "userId"='bob' and "spaceId"='space_s';`);
  const r11c = asApp(appUrl, "bob", `select count(*) from "Transaction" where "financialAccountId"='acct_shared';`);
  check(19, "A REMOVED member immediately loses visibility (status='ACTIVE' is load-bearing)",
        r11c.ok && r11c.out.includes("0"), r11c.out || r11c.err);
  psql(base, `update "SpaceMember" set status='ACTIVE' where "userId"='bob' and "spaceId"='space_s';`);

  // ── global reference data ──────────────────────────────────────────────────
  const r12 = asApp(appUrl, "alice", `select count(*) from "FxRate";`);
  check(12, "Global reference data stays readable (FxRate)", r12.ok && r12.out.includes("1"), r12.out || r12.err);

  // ── revoked operational tables ─────────────────────────────────────────────
  const r13 = asApp(appUrl, "alice", `select count(*) from "AiInvocation";`);
  check(20, "fm_app has NO access to the revoked operational family (AiInvocation)",
        deniedByGrant(r13), r13.err.split("\n")[0] || "unexpectedly readable");

  // ── identity lifetime ──────────────────────────────────────────────────────
  const commitClear = psql(appUrl,
    `BEGIN; SET LOCAL app.user_id='alice'; COMMIT;
     SELECT coalesce(nullif(current_setting('app.user_id', true),''),'<unset>');`, false);
  check(21, "SET LOCAL identity is cleared after COMMIT (same session)",
        commitClear.ok && commitClear.out.trim() === "<unset>",
        `value after commit: "${commitClear.out.trim()}"`);

  const rollbackClear = psql(appUrl,
    `BEGIN; SET LOCAL app.user_id='alice'; ROLLBACK;
     SELECT coalesce(nullif(current_setting('app.user_id', true),''),'<unset>');`, false);
  check(22, "SET LOCAL identity is cleared after ROLLBACK — a failed transaction leaves no residue",
        rollbackClear.ok && rollbackClear.out.trim() === "<unset>",
        `value after rollback: "${rollbackClear.out.trim()}"`);

  // the reuse case: same physical session, two identities in sequence
  const reuse = psql(appUrl,
    `BEGIN; SET LOCAL app.user_id='alice'; SELECT count(*) FROM "Transaction"; COMMIT;
     BEGIN; SET LOCAL app.user_id='bob';   SELECT count(*) FROM "Transaction"; COMMIT;`, false);
  const counts = reuse.out.split("\n").map((s) => s.trim()).filter(Boolean);
  check(23, "A recycled session cannot inherit the previous identity (alice=3, bob=2, neither sees all 4)",
        reuse.ok && counts[0] === "3" && counts[1] === "2", `counts=${JSON.stringify(counts)}`);

  // FAIL CLOSED
  const noIdentity = psql(appUrl, `SELECT count(*) FROM "Transaction";`, false);
  check(24, "Missing app.user_id FAILS CLOSED — zero rows, never all rows",
        noIdentity.ok && noIdentity.out.trim() === "0", `got: ${noIdentity.out || noIdentity.err}`);

  // ── the users/search oracle, at the database ───────────────────────────────
  const oracle = asApp(appUrl, "alice", `select count(*) from "SpaceMember" where "spaceId"='space_b';`);
  check(26, "users/search roster oracle is closed at the DB (Alice cannot enumerate Bob's Space)",
        oracle.ok && oracle.out.includes("0"), oracle.out || oracle.err);

  // ── cross-space writes on a Space-scoped table ─────────────────────────────
  const xIns = asApp(appUrl, "alice",
    `insert into "SpaceSnapshot" (id,"spaceId",date) values ('snap_evil','space_b',current_date);`);
  check(25, "Cross-Space INSERT on a spaceId-keyed table — denied",
        deniedByRls(xIns), xIns.err.split("\n")[0] || "insert unexpectedly succeeded");

  // ── direct SQL, no application code ────────────────────────────────────────
  check(14, "Owner/migration role still works (fixtures were written by it)", seed.ok, seed.err);
  const direct = asApp(appUrl, "alice", `select count(*) from "FinancialAccount";`);
  check(13, "Direct SQL as fm_app respects RLS (Alice sees her own + shared, not Bob's)",
        direct.ok && direct.out.includes("2"), `expected 2, got ${direct.out || direct.err}`);

  // ── the production mechanism, not just the SQL one ─────────────────────────
  // Everything above drove psql. This drives PRISMA through withTenantDb()'s
  // exact shape, over a pool deliberately SMALLER than the concurrency, so
  // every request is forced to reuse a connection another identity just used.
  // That is the condition under which a session-scoped GUC would leak.
  await concurrencyProof(appUrl);

  // ── report ─────────────────────────────────────────────────────────────────
  // ── backup completeness, and the failure mode it guards ───────────────────
  backupProof(base, appUrl);

  if (TARGET_URL) psql(base, FIXTURE_CLEANUP, false);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  ${f.n}. ${f.name}\n     ${f.detail}`);
    process.exit(1);
  }
  console.log("\nTenant isolation is enforced by PostgreSQL, not by application predicates.\n");
}

/**
 * Cases 28-29 — the backup path under RLS.
 *
 * This is the half of the design that is easy to get wrong silently. pg_dump is
 * an ordinary client, so policies apply to it. A dump taken by a role without
 * BYPASSRLS does not announce itself as partial — it is a well-formed .sql file
 * containing a fraction of the rows, and the old "> 100 bytes" check passes it.
 *
 * So we prove BOTH directions: fm_backup produces a complete dump, and fm_app
 * demonstrably does not.
 */
function backupProof(ownerUrl: string, appUrl: string): void {
  const live = Number(psql(ownerUrl, `select count(*) from "Transaction";`).out);
  const dir  = mkdtempSync(join(tmpdir(), "fm-rls-dump-"));
  workdir = dir;

  const countCopyRows = (file: string, table: string): number => {
    const dump = readFileSync(file, "utf8");
    const start = dump.indexOf(`COPY public."${table}" `);
    if (start === -1) return 0;
    const from = dump.indexOf("\n", dump.indexOf("FROM stdin;", start)) + 1;
    const end  = dump.indexOf("\n\\.", from);
    return end <= from ? 0 : dump.slice(from, end).split("\n").length;
  };

  // fm_backup carries BYPASSRLS precisely so this is complete.
  const bkPw = randomBytes(18).toString("hex");
  psql(ownerUrl, `ALTER ROLE fm_backup LOGIN PASSWORD '${bkPw}';`);
  const bkUrl = ownerUrl.replace(/\/\/[^@]+@/, `//fm_backup:${bkPw}@`);
  const good = join(dir, "fm_backup.sql");
  const g = sh("pg_dump", ["--no-owner", "--no-privileges", "-f", good, bkUrl]);
  const goodRows = g.ok ? countCopyRows(good, "Transaction") : -1;
  check(28, "A dump taken as fm_backup is COMPLETE (row-for-row with the live table)",
        g.ok && goodRows === live, `live=${live}, in dump=${goodRows}${g.ok ? "" : ` (pg_dump failed: ${g.err.split("\n")[0]})`}`);

  // …and the same dump taken as the runtime role is NOT. Either pg_dump refuses
  // outright, or --enable-row-security hands back a quietly truncated file.
  const bad = join(dir, "fm_app.sql");
  const b = sh("pg_dump", ["--no-owner", "--no-privileges", "--enable-row-security", "-f", bad, appUrl]);
  const badRows = b.ok ? countCopyRows(bad, "Transaction") : -1;
  check(29, "A dump taken as fm_app is REFUSED or silently partial — never complete",
        !b.ok || badRows < live,
        `live=${live}, in dump=${badRows} — a complete dump by the runtime role would mean RLS is not binding it`);
}

/**
 * Case 17 — pooled identity cannot bleed between tenants.
 *
 * connection_limit=1 means every one of these interleaved requests is served by
 * the SAME physical server connection, one after another. If the identity were
 * set at session scope instead of transaction scope, a request would inherit
 * its predecessor's tenant and the counts would be wrong in a way no
 * application test would catch.
 */
async function concurrencyProof(appUrl: string): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const url = `${appUrl}?connection_limit=1`;
  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });

  // withTenantDb()'s shape, inlined so this script stays runnable without the
  // Next.js "server-only" module graph.
  const asTenant = async (userId: string) =>
    client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "Transaction"`;
      return Number(rows[0].n);
    });

  try {
    const EXPECT: Record<string, number> = { alice: 3, bob: 2 };
    const plan = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "alice" : "bob"));
    const got = await Promise.all(plan.map((u) => asTenant(u)));
    const bad = got.map((n, i) => ({ u: plan[i], n })).filter((r) => r.n !== EXPECT[r.u]);
    check(17, "Concurrent Alice/Bob on a pool of ONE never cross-contaminate (40 interleaved requests)",
          bad.length === 0, `${bad.length} wrong: ${JSON.stringify(bad.slice(0, 4))}`);

    // And the identity must be gone the moment the transaction ends.
    const leaked = await client.$queryRaw<Array<{ v: string | null }>>`
      SELECT nullif(current_setting('app.user_id', true), '') AS v`;
    check(27, "No identity survives outside a transaction on a pooled connection",
          leaked[0]?.v == null, `leaked value: ${leaked[0]?.v}`);
  } finally {
    await client.$disconnect();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures. Written as the owner. Deliberately minimal: two tenants, one shared
// Space exercising the many-to-many account case, and one user-private row.
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURE_CLEANUP = `
delete from "SpaceMemory"       where id = 'mem_a';
delete from "Transaction"       where id like 'tx_alice%' or id like 'tx_bob%' or id like 'tx_shared%' or id = 'tx_evil_1';
delete from "SpaceSnapshot"     where id = 'snap_evil';
delete from "SpaceAccountLink"  where id in ('l_a','l_b','l_sh','l_sh2');
delete from "PlaidItem"         where id = 'pi_a';
delete from "FinancialAccount"  where id in ('acct_alice','acct_bob','acct_shared');
delete from "SpaceMember"       where id in ('m_a','m_b','m_sa','m_sb');
delete from "Space"             where id in ('space_a','space_b','space_s');
delete from "User"              where id in ('alice','bob');
delete from "FxRate"            where id = 'fx1';
delete from "AiInvocation"      where id = 'ai1';
`;

const FIXTURES = `
insert into "User" (id,email,name,"updatedAt") values
  ('alice','alice@example.test','Alice',now()),
  ('bob','bob@example.test','Bob',now());

insert into "Space" (id,name,type,"updatedAt") values
  ('space_a','Alice Space','PERSONAL',now()),
  ('space_b','Bob Space','PERSONAL',now()),
  ('space_s','Shared','SHARED',now());

insert into "SpaceMember" (id,"spaceId","userId",role,status) values
  ('m_a','space_a','alice','OWNER','ACTIVE'),
  ('m_b','space_b','bob','OWNER','ACTIVE'),
  ('m_sa','space_s','alice','OWNER','ACTIVE'),
  ('m_sb','space_s','bob','VIEWER','ACTIVE');

insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt") values
  ('acct_alice','Alice Checking','checking','TestBank','USER','alice',now()),
  ('acct_bob','Bob Checking','checking','TestBank','USER','bob',now()),
  ('acct_shared','Joint','checking','TestBank','USER','alice',now());

insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
  ('l_a','space_a','acct_alice','HOME','ACTIVE','FULL',now()),
  ('l_b','space_b','acct_bob','HOME','ACTIVE','FULL',now()),
  ('l_sh','space_s','acct_shared','HOME','ACTIVE','FULL',now()),
  ('l_sh2','space_a','acct_shared','SHARED','ACTIVE','FULL',now());

insert into "Transaction" (id,"financialAccountId",date,merchant,category,amount,"updatedAt") values
  ('tx_alice_1','acct_alice',current_date,'Coffee','Dining',-10,now()),
  ('tx_alice_2','acct_alice',current_date,'Books','Shopping',-20,now()),
  ('tx_bob_1','acct_bob',current_date,'Rent','Other',-50,now()),
  ('tx_shared_1','acct_shared',current_date,'Groceries','Groceries',-30,now());

insert into "SpaceMemory" (id,"spaceId","ownerUserId",kind,subject,payload,"statedAs")
  values ('mem_a','space_s','alice','INTENTION','alice private goal','{}'::jsonb,'a private intention');

insert into "PlaidItem" (id,"userId","externalItemId","institutionId","institutionName","encryptedToken",status,"updatedAt")
  values ('pi_a','alice','ext_a','ins_1','TestBank','cipher','ACTIVE',now());

insert into "FxRate" (id,date,base,quote,rate,source) values ('fx1',current_date,'USD','EUR',0.9,'test');

insert into "AiInvocation" (id,provider,model,"promptTokens","completionTokens","latencyMs",environment)
  values ('ai1','openai','gpt',1,1,1,'test');
`;

main().catch((e) => {
  console.error(`\n[rls] SUITE ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
