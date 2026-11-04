/**
 * scripts/test-b10-rollback-rehearsal.ts  (B10.6 — Production-like upgrade + app-rollback rehearsal)
 *
 * Proves, on a THROWAWAY Postgres with SYNTHETIC data only, that the B10
 * upgrade path and the app-rollback path behave as the release plan claims
 * (docs/plans/PRE-BETA-READINESS-AND-RELEASE-PLAN-2026-11-01.md, B10.2 /
 * B10.2a / B10.4). It never reads a configured database, a dump or a backup:
 * the schema comes from the committed migrations of each tree and every row
 * is generated here.
 *
 *   1. Fresh postgres (same major as CI) ← B9's migrations, applied by B9's own
 *      Prisma CLI from a worktree of origin/main (--b9-tree).
 *   2. Synthetic seed: users, a Space, accounts, snapshots, incidents (+
 *      occurrences), sessions, audit rows; bulk rows so lock/duration figures
 *      mean something (--scale).
 *   3. B9-code smoke (scripts/test-b10-rehearsal-b9-probe.ts `pre`, run INSIDE
 *      the B9 tree with its own node_modules + generated client).
 *   4. Preflight: tree − ledger = exactly the five B10 migrations, ledger −
 *      tree = ∅. Lock inventory: each migration replayed in ONE transaction on
 *      a template clone, with pg_locks read before COMMIT (every lock taken is
 *      still held there) and its in-transaction duration.
 *   5. The guarded path on the real database: db-guard --mode=migrate-deploy,
 *      then `prisma migrate deploy` (develop), while a sampler records blocked
 *      lock requests and a B9-shaped incident writer measures its latency.
 *      Per-migration durations come from _prisma_migrations.
 *   6. B10-code smoke (scripts/test-b10-rehearsal-b10-probe.ts `smoke`).
 *   7. APP ROLLBACK: B9 code against the B10 schema (test-b10-rehearsal-b9-probe.ts `rollback`,
 *      preceded by test-b10-rehearsal-b10-probe.ts `totp-claim`), plus owner-side truth checks.
 *   8. Data-effects inventory: what B10 wrote that persists after the rollback.
 *   9. `docker rm -f -v`.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/test-b10-rollback-rehearsal.ts \
 *     --b9-tree=<worktree of origin/main with its own npm ci + prisma generate> \
 *     [--scale=1] [--evidence=<file.json>] [--keep]
 *
 * Heavy: run it under the shared heavy-job lock. Exit 0 only when every check passes.
 *
 * Named `test-*.ts` (with its two probes) like the other live-database dev harnesses:
 * it is not a unit test (scripts/run-tests.ts never runs it) and, writing incidents
 * and presence only into its own throwaway database, it sits outside the runtime
 * source scans that exclude that convention.
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import { IMAGE, psql } from "./lib/rls-harness";
import { REHEARSAL_CONTAINER_PREFIX, REHEARSAL_DB_PREFIX } from "./lib/b10-rehearsal-guard";

const ROOT = process.cwd();
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const KEEP = process.argv.includes("--keep");
const SCALE = Math.max(0.01, Number(arg("scale") ?? "1"));
const EVIDENCE = arg("evidence");
const B9_TREE = arg("b9-tree") ? path.resolve(arg("b9-tree")!) : "";

/** The B10 migrations, in the order Prisma applies them (B10.2). */
export const B10_MIGRATIONS = [
  "20261103120000_pb1_s2_incident_lifecycle_schema",
  "20261103130000_pb10_session_presence",
  "20261103140000_db010_auditlog_append_only",
  "20261103150000_fin_a2_balance_observed",
  "20261103160000_fin_e_restricted_cash",
] as const;

type Check = { id: string; claim: string; ok: boolean; detail: string; side: string };
const checks: Check[] = [];
const check = (side: string, id: string, claim: string, ok: boolean, detail: unknown = "") => {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  checks.push({ side, id, claim, ok, detail: d.slice(0, 600) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${claim}${ok ? "" : `  -> ${d.slice(0, 300)}`}`);
};
/** Not B9-compat claims: things the rehearsal observed that the release plan should know (printed loudly, kept in the evidence). */
const findings: { id: string; what: string; detail: string }[] = [];
const finding = (id: string, what: string, detail: unknown) => {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  findings.push({ id, what, detail: d });
  console.log(`  FINDING  ${id}  ${what}  -> ${d}`);
};
const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), image: IMAGE, scale: SCALE, synthetic: true };

let container: string | null = null;
const sh = (cmd: string, args: string[], opts: Parameters<typeof spawnSync>[2] = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim(), status: r.status };
};
const sql = (url: string, text: string) => { const r = psql(url, text); if (!r.ok) throw new Error(`SQL failed: ${r.err.slice(0, 800)}`); return r.out; };
const ms = (t0: bigint) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const migrationDirs = (tree: string) => readdirSync(path.join(tree, "prisma", "migrations"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(tree, "prisma", "migrations", d.name, "migration.sql"))).map((d) => d.name).sort();

// ── the database ──────────────────────────────────────────────────────────────
function startPostgres(): { ownerUrl: string; base: string; dbName: string } {
  if (!sh("docker", ["info", "--format", "{{.ServerVersion}}"]).ok) throw new Error("Docker is not available — this rehearsal builds its own throwaway Postgres and never falls back to a configured database.");
  const dbName = `${REHEARSAL_DB_PREFIX}${process.pid}`;
  const pw = randomBytes(18).toString("hex");
  container = `${REHEARSAL_CONTAINER_PREFIX}${process.pid}-${Date.now().toString(36)}`;
  const run = sh("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_USER=fmowner", "-e", `POSTGRES_PASSWORD=${pw}`,
    "-e", `POSTGRES_DB=${dbName}`, "-p", "127.0.0.1::5432", IMAGE, "-c", "log_lock_waits=on", "-c", "deadlock_timeout=100ms"]);
  if (!run.ok) throw new Error(`could not start ${IMAGE}: ${run.err || run.out}`);
  const deadline = Date.now() + 90_000;
  while (!sh("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "fmowner", "-d", dbName]).ok) {
    if (Date.now() > deadline) throw new Error("throwaway Postgres did not become ready within 90s");
    spawnSync("sleep", ["1"]);
  }
  const port = /^127\.0\.0\.1:(\d+)$/.exec(sh("docker", ["port", container, "5432/tcp"]).out.split("\n")[0])?.[1];
  if (!port) throw new Error("unexpected docker port mapping");
  const base = `postgresql://fmowner:${pw}@127.0.0.1:${port}`;
  return { ownerUrl: `${base}/${dbName}`, base, dbName };
}
function teardown(): void {
  if (container && !KEEP) spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
  if (container && KEEP) console.log(`--keep: container ${container} left running (remove with docker rm -f -v)`);
  container = null;
}
const withRole = (url: string, role: string, password: string) => { const u = new URL(url); u.username = role; u.password = password; return u.toString(); };

// ── probes ────────────────────────────────────────────────────────────────────
type ProbeResult = { side: string; phase: string; checks: Omit<Check, "side">[]; out: Record<string, unknown> };
const B9_PROBE_DEST = () => path.join(B9_TREE, "scripts", ".b10reh-b9-probe.ts");
/** The guard the B9 probe imports as ./lib/b10-rehearsal-guard (B9 has no such file; removed afterwards). */
const B9_GUARD_DEST = () => path.join(B9_TREE, "scripts", "lib", "b10-rehearsal-guard.ts");

function runProbe(side: "B9" | "B10", phase: string, env: Record<string, string>): ProbeResult {
  const tree = side === "B9" ? B9_TREE : ROOT;
  const file = side === "B9" ? "scripts/.b10reh-b9-probe.ts" : "scripts/test-b10-rehearsal-b10-probe.ts";
  const t0 = process.hrtime.bigint();
  const r = sh(path.join(tree, "node_modules", ".bin", "tsx"), ["--require", "./scripts/lib/server-only-preload.cjs", file, phase],
    { cwd: tree, timeout: 300_000, env: env as unknown as NodeJS.ProcessEnv });
  const line = r.out.split("\n").reverse().find((l) => l.startsWith("@@B10REH "));
  const took = ms(t0);
  if (!line) {
    console.error(r.out.slice(-3000), r.err.slice(-3000));
    check(side, `${side}-${phase}`, `${side} probe '${phase}' produced a result`, false, `exit ${r.status}; ${r.err.slice(-300)}`);
    return { side, phase, checks: [], out: {} };
  }
  const res = JSON.parse(line.slice(9)) as ProbeResult;
  for (const c of res.checks) { checks.push({ ...c, side }); console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.id}  [${side} code] ${c.claim}${c.ok ? "" : `  -> ${c.detail.slice(0, 300)}`}`); }
  console.log(`  (${side} probe '${phase}' ${took} ms)`);
  return res;
}

// ── synthetic seed ────────────────────────────────────────────────────────────
function seedSql(F: Record<string, string>, pwHash: string): string {
  const n = (x: number) => Math.max(1, Math.round(x * SCALE));
  const N = { users: n(2000), sessions: n(20000), accounts: n(5000), spaces: n(1000), snapDays: 50, issues: n(100000), audit: n(100000) };
  evidence.seedVolumes = { ...N, snapshots: N.spaces * N.snapDays, occurrences: N.issues * 2 };
  return `
  insert into "User" (id,email,name,username,"passwordHash","emailVerifiedAt",role,"updatedAt") values
    ('${F.u1}','rehearsal-user-1@example.test','Rehearsal One','${F.u1Name}','${pwHash}',now(),'USER',now()),
    ('${F.u2}','rehearsal-user-2@example.test','Rehearsal Two','${F.u2Name}','${pwHash}',now(),'USER',now()),
    ('${F.operator}','rehearsal-operator@example.test','Rehearsal Operator',null,null,now(),'SYSTEM_ADMIN',now());
  insert into "Space" (id,name,type,"updatedAt") values ('${F.space1}','Rehearsal Space','PERSONAL',now());
  insert into "SpaceMember" (id,"spaceId","userId",role) values ('${F.space1}_m','${F.space1}','${F.u1}','OWNER');
  insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","createdByUserId",balance,currency,"providerSubtype","updatedAt") values
    ('${F.faChecking}','Synthetic checking','checking','Synthetic Bank','USER','${F.u1}','${F.u1}',1000,'USD','checking',now()),
    ('${F.faHsa}','Synthetic HSA','savings','Synthetic Bank','USER','${F.u1}','${F.u1}',500,'USD','hsa',now());
  insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"updatedAt") values
    ('${F.faChecking}_l','${F.space1}','${F.faChecking}','HOME','ACTIVE',now()),
    ('${F.faHsa}_l','${F.space1}','${F.faHsa}','HOME','ACTIVE',now());
  -- FIN-E parity Spaces (B10 phase; no transactions, so every day's true balances are today's)
  insert into "Space" (id,name,type,"updatedAt") values ('${F.spaceHsa}','Parity HSA Space','PERSONAL',now()), ('${F.spacePlain}','Parity Plain Space','PERSONAL',now());
  insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","createdByUserId",balance,currency,"providerSubtype","updatedAt") values
    ('${F.spaceHsa}_c','Parity checking','checking','Synthetic Bank','USER','${F.u1}','${F.u1}',1000,'USD','checking',now()),
    ('${F.spaceHsa}_h','Parity HSA','savings','Synthetic Bank','USER','${F.u1}','${F.u1}',${F.parityHsaBalance},'USD','hsa',now()),
    ('${F.spacePlain}_c','Parity plain checking','checking','Synthetic Bank','USER','${F.u1}','${F.u1}',700,'USD','checking',now()),
    ('${F.spacePlain}_s','Parity plain savings','savings','Synthetic Bank','USER','${F.u1}','${F.u1}',300,'USD','savings',now());
  insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"updatedAt") values
    ('${F.spaceHsa}_lc','${F.spaceHsa}','${F.spaceHsa}_c','HOME','ACTIVE',now()), ('${F.spaceHsa}_lh','${F.spaceHsa}','${F.spaceHsa}_h','HOME','ACTIVE',now()),
    ('${F.spacePlain}_lc','${F.spacePlain}','${F.spacePlain}_c','HOME','ACTIVE',now()), ('${F.spacePlain}_ls','${F.spacePlain}','${F.spacePlain}_s','HOME','ACTIVE',now());
  insert into "SpaceSnapshot" (id,"spaceId",date,cash,savings,"netWorth","totalAssets") values
    ('${F.space1}_s1','${F.space1}', current_date - 3, 1000, 500, 1500, 1500);

  -- bulk (synthetic; volumes scale with --scale) --
  insert into "User" (id,email,"updatedAt") select 'bulk_u_'||g, 'bulk-'||g||'@example.test', now() from generate_series(1,${N.users}) g;
  insert into "UserSession" (id,"userId","sessionToken","lastActiveAt","createdAt")
    select 'bulk_us_'||g, 'bulk_u_'||(1 + g % ${N.users}), 'bulk-tok-'||g, now() - (g % 30) * interval '1 day', now() - (g % 60) * interval '1 day' from generate_series(1,${N.sessions}) g;
  insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId",balance,currency,"updatedAt")
    select 'bulk_fa_'||g, 'Bulk '||g, 'checking', 'Synthetic Bank', 'USER', 'bulk_u_'||(1 + g % ${N.users}), (g % 997) + 0.5, 'USD', now() from generate_series(1,${N.accounts}) g;
  insert into "Space" (id,name,type,"updatedAt") select 'bulk_sp_'||g, 'Bulk '||g, 'PERSONAL', now() from generate_series(1,${N.spaces}) g;
  insert into "SpaceSnapshot" (id,"spaceId",date,cash,"netWorth","totalAssets")
    select 'bulk_ss_'||s||'_'||d, 'bulk_sp_'||s, current_date - 10 - d, 100 + d, 100 + d, 100 + d from generate_series(1,${N.spaces}) s, generate_series(1,${N.snapDays}) d;
  insert into "SyncIssue" (id,provider,"plaidItemId",kind,detail,resolved,"createdAt","updatedAt","firstOccurredAt","lastOccurredAt","resolvedAt","resolutionKind")
    select 'bulk_si_'||g, 'PLAID', 'bulk-item-'||(g % 5000), 'TRANSACTION_PERSISTENCE_FAILED', '{"stage":"transaction-persist","cursorBlocking":true}'::jsonb, true,
           now() - interval '20 days', now() - interval '10 days', now() - interval '20 days', now() - interval '12 days', now() - interval '10 days', 'AUTOMATIC_RECOVERY'
      from generate_series(1,${N.issues}) g;
  insert into "SyncIssueOccurrence" (id,"syncIssueId","observedAt",detail)
    select 'bulk_so_'||g||'_'||k, 'bulk_si_'||g, now() - interval '15 days', '{}'::jsonb from generate_series(1,${N.issues}) g, generate_series(1,2) k;
  insert into "AuditLog" (id,"userId",action,"createdAt") select 'bulk_al_'||g, 'bulk_u_'||(1 + g % ${N.users}), 'SPACE_VIEWED', now() - (g % 300) * interval '1 day' from generate_series(1,${N.audit}) g;
  ${agedAuditSql("pre")}
  analyze;`;
}
/** Aged rows the two retention paths must reach: 3 beta-intake (90d+) and 3 product events (13m+), plus one aged NON-product row that must survive. */
function agedAuditSql(tag: string): string {
  return `
  insert into "AuditLog" (id,action,"ipAddress","userAgent",metadata,"createdAt")
    select 'aged_beta_${tag}_'||g, 'BETA_ACCESS_REQUESTED', '192.0.2.'||g, 'Mozilla/5.0 (synthetic)', '{"source":"synthetic"}'::jsonb, now() - interval '100 days' from generate_series(1,3) g;
  insert into "AuditLog" (id,action,"createdAt") select 'aged_pe_${tag}_'||g, 'SPACE_VIEWED', now() - interval '14 months' from generate_series(1,3) g;
  insert into "AuditLog" (id,action,"createdAt") values ('aged_keep_${tag}', 'LOGIN', now() - interval '14 months');`;
}

// ── lock inventory (template clone, one transaction per migration) ────────────
type LockRow = { migration: string; ms: number; locks: Record<string, string[]> };
function lockInventory(base: string, dbName: string): LockRow[] {
  const clone = `${dbName}_locks`;
  sql(`${base}/postgres`, `create database ${clone} template ${dbName};`);
  const url = `${base}/${clone}`;
  const rows: LockRow[] = [];
  try {
    for (const m of B10_MIGRATIONS) {
      const body = readFileSync(path.join(ROOT, "prisma", "migrations", m, "migration.sql"), "utf8");
      const wrapped = `begin;
        create temp table _b10reh_t0 as select clock_timestamp() as t;
        ${body}
        ;
        select '@@LOCK|' || coalesce(c.relname, l.locktype || ':' || coalesce(l.classid::regclass::text, '?')) || '|' || l.mode
          from pg_locks l left join pg_class c on c.oid = l.relation
         where l.pid = pg_backend_pid() and l.granted and l.locktype in ('relation', 'object')
           and (l.locktype <> 'relation' or c.relnamespace = 'public'::regnamespace);
        select '@@MS|' || round((extract(epoch from clock_timestamp() - t) * 1000)::numeric, 1) from _b10reh_t0;
        commit;`;
      const outText = sql(url, wrapped);
      const locks: Record<string, string[]> = {};
      for (const l of outText.split("\n").filter((x) => x.startsWith("@@LOCK|"))) {
        const [, rel, mode] = l.split("|");
        const modes = (locks[rel] ??= []);
        if (!modes.includes(mode)) modes.push(mode);
      }
      const took = Number(outText.split("\n").find((x) => x.startsWith("@@MS|"))?.slice(5) ?? "NaN");
      rows.push({ migration: m, ms: took, locks });
    }
  } finally {
    psql(`${base}/postgres`, `drop database if exists ${clone};`);
  }
  return rows;
}

// ── concurrent sampler + B9-shaped writer during the real deploy ──────────────
function startBackground(url: string, script: string) {
  const p = spawn("psql", ["-X", "-q", "-A", "-t", "--no-psqlrc", url], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  p.stdout.on("data", (d) => { buf += String(d); });
  p.stderr.on("data", (d) => { buf += String(d); });
  p.stdin.write(script);
  return { stop: async () => { p.kill("SIGINT"); await new Promise((r) => setTimeout(r, 300)); p.kill("SIGKILL"); return buf; } };
}

async function main(): Promise<number> {
  console.log("\n=== B10 UPGRADE + APP-ROLLBACK REHEARSAL — THROWAWAY POSTGRES, SYNTHETIC DATA ===\n");
  if (!B9_TREE) throw new Error("--b9-tree=<worktree of origin/main> is required (with its own npm ci + prisma generate).");
  for (const need of ["node_modules/.bin/tsx", "node_modules/.bin/prisma", "node_modules/.prisma/client", "scripts/lib/server-only-preload.cjs"]) {
    if (!existsSync(path.join(B9_TREE, need))) throw new Error(`--b9-tree is missing ${need}: run npm ci + prisma generate there (under the heavy lock).`);
  }
  const b9Head = sh("git", ["-C", B9_TREE, "rev-parse", "--short", "HEAD"]).out;
  const b10Head = sh("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).out;
  evidence.trees = { b9: b9Head, b10: b10Head };
  const b9Dirs = migrationDirs(B9_TREE), b10Dirs = migrationDirs(ROOT);
  const delta = b10Dirs.filter((d) => !b9Dirs.includes(d));
  check("orchestrator", "M0", "develop's migrations − B9's = exactly the five B10 migrations, in order; B9's ⊆ develop's",
    JSON.stringify(delta) === JSON.stringify(B10_MIGRATIONS) && b9Dirs.every((d) => b10Dirs.includes(d)), { delta });

  const pg = startPostgres();
  const owner = pg.ownerUrl;

  // 1. B9 schema from B9's migrations, by B9's Prisma
  let t0 = process.hrtime.bigint();
  const m9 = sh(path.join(B9_TREE, "node_modules", ".bin", "prisma"), ["migrate", "deploy"],
    { cwd: B9_TREE, env: { ...process.env, DATABASE_URL: `${owner}?schema=public`, DIRECT_URL: `${owner}?schema=public` } });
  if (!m9.ok) throw new Error(`B9 prisma migrate deploy failed: ${m9.err.slice(-1500)}`);
  const ledger9 = Number(sql(owner, `select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null;`));
  check("orchestrator", "M1", `B9 schema built from B9's ${b9Dirs.length} migrations by B9's Prisma`, ledger9 === b9Dirs.length, { ledger9, ms: ms(t0) });

  const pw = { app: randomBytes(18).toString("hex"), auth: randomBytes(18).toString("hex"), system: randomBytes(18).toString("hex") };
  sql(owner, `alter role fm_app login password '${pw.app}'; alter role fm_auth login password '${pw.auth}'; alter role fm_system login password '${pw.system}';`);

  // 2. synthetic seed
  const id = (t: string) => `c${(t + randomBytes(12).toString("hex")).replace(/[^a-z0-9]/g, "").slice(0, 24).padEnd(24, "0")}`;
  const totpSecretBytes = randomBytes(20);
  const { base32Encode } = await import("@/lib/totp");
  const F: Record<string, string> = {
    u1: id("ua"), u2: id("ub"), operator: id("op"), u1Name: "rehearsal_one", u2Name: "rehearsal_two", password: `rh-${randomBytes(8).toString("hex")}`,
    space1: id("sp"), faChecking: id("fc"), faHsa: id("fh"), spaceHsa: id("ph"), spacePlain: id("pp"), parityHsaBalance: "400",
    item0: "rh-item-0", itemA: "rh-item-a", itemB: "rh-item-b", itemC: "rh-item-c", itemE: "rh-item-e",
    agedBetaCount: "3", agedProductCount: "3", unobservedStoredBalance: "250", expectedCashB10: "1000",
    totpSecret: base32Encode(totpSecretBytes),
    newSnapshotDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
  };
  t0 = process.hrtime.bigint();
  sql(owner, seedSql(F, await bcrypt.hash(F.password, 4)));
  console.log(`[seed] synthetic seed written in ${ms(t0)} ms: ${JSON.stringify(evidence.seedVolumes)}`);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    DATABASE_URL: `${owner}?schema=public`, DIRECT_URL: `${owner}?schema=public`,
    DATABASE_URL_APP: withRole(owner, "fm_app", pw.app), DATABASE_URL_AUTH: withRole(owner, "fm_auth", pw.auth), DATABASE_URL_SYSTEM: withRole(owner, "fm_system", pw.system),
    FM_RLS_STRICT: "true", ENCRYPTION_KEY: randomBytes(32).toString("hex"), NEXTAUTH_SECRET: randomBytes(24).toString("hex"),
    B10REH_FIX: JSON.stringify(F),
    B10REH_ORCHESTRATED: container ?? "",
  };
  let state: Record<string, unknown> = {};
  const merge = (r: ProbeResult) => { state = { ...state, ...r.out }; };

  // 3. B9-code smoke on the B9 schema
  if (existsSync(B9_GUARD_DEST())) throw new Error("the B9 tree already has scripts/lib/b10-rehearsal-guard.ts — refusing to overwrite it");
  copyFileSync(path.join(ROOT, "scripts", "test-b10-rehearsal-b9-probe.ts"), B9_PROBE_DEST());
  copyFileSync(path.join(ROOT, "scripts", "lib", "b10-rehearsal-guard.ts"), B9_GUARD_DEST());
  try {
    console.log("\n[3] B9 code on the B9 schema");
    merge(runProbe("B9", "pre", { ...env, B10REH_STATE: JSON.stringify(state) }));

    // 4. preflight + lock inventory
    console.log("\n[4] Preflight and lock inventory");
    const ledger = sql(owner, `select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by 1;`).split("\n").filter(Boolean);
    const treeMinusLedger = b10Dirs.filter((d) => !ledger.includes(d)), ledgerMinusTree = ledger.filter((d) => !b10Dirs.includes(d));
    check("orchestrator", "M2", "preflight: tree − ledger = exactly the five; ledger − tree = ∅",
      JSON.stringify(treeMinusLedger) === JSON.stringify(B10_MIGRATIONS) && ledgerMinusTree.length === 0, { treeMinusLedger, ledgerMinusTree });
    const inv = lockInventory(pg.base, pg.dbName);
    evidence.lockInventory = inv;
    for (const r of inv) console.log(`    ${r.migration}: ${r.ms} ms in-transaction; ${Object.entries(r.locks).map(([k, v]) => `${k}=${v.join("+")}`).join(", ")}`);

    // 5. the guarded run on the real database
    console.log("\n[5] Guarded migration run (db-guard --mode=migrate-deploy, then prisma migrate deploy)");
    const guard = sh(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/db-guard.ts", "--mode=migrate-deploy"],
      { cwd: ROOT, env: { PATH: env.PATH, HOME: env.HOME, DATABASE_URL: env.DATABASE_URL, DIRECT_URL: env.DIRECT_URL } as unknown as NodeJS.ProcessEnv });
    check("orchestrator", "M3", "db-guard --mode=migrate-deploy passes against the throwaway target", guard.ok, (guard.err || guard.out).slice(-300));
    const iD = (state.incidents as Record<string, string> | undefined)?.iD ?? "none";
    const sampler = startBackground(owner, `select '@@W|' || to_char(clock_timestamp(),'HH24:MI:SS.MS') || '|' || coalesce(c.relname,'-') || '|' || l.mode || '|' || coalesce(left(regexp_replace(a.query,'\\s+',' ','g'),50),'')
        from pg_locks l join pg_stat_activity a on a.pid = l.pid left join pg_class c on c.oid = l.relation where not l.granted;
      \\watch 0.02\n`);
    const writer = startBackground(owner, `\\timing on\nupdate "SyncIssue" set "lastOccurredAt" = now() where id = '${iD}';\n\\watch 0.02\n`);
    await new Promise((r) => setTimeout(r, 1500));
    t0 = process.hrtime.bigint();
    const m10 = sh(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: env.DATABASE_URL, DIRECT_URL: env.DIRECT_URL } });
    const deployMs = ms(t0);
    await new Promise((r) => setTimeout(r, 1000));
    const samples = await sampler.stop(), writes = await writer.stop();
    check("orchestrator", "M4", "prisma migrate deploy (develop) applies the five migrations", m10.ok, m10.ok ? `${deployMs} ms` : m10.err.slice(-600));
    if (!m10.ok) throw new Error("B10 migrations failed — stopping");
    const perMigration = sql(owner, `select migration_name || '|' || round((extract(epoch from finished_at - started_at) * 1000)::numeric, 1)
        from _prisma_migrations where migration_name in (${B10_MIGRATIONS.map((m) => `'${m}'`).join(",")}) order by 1;`)
      .split("\n").filter(Boolean).map((l) => { const [m, v] = l.split("|"); return { migration: m, ms: Number(v) }; });
    const waits = samples.split("\n").filter((l) => l.startsWith("@@W|")).map((l) => l.split("|"));
    const blockedRel = [...new Set(waits.map((w) => `${w[2]}:${w[3]}`))];
    const latencies = writes.split("\n").map((l) => /^Time: ([\d.]+) ms/.exec(l)?.[1]).filter(Boolean).map(Number);
    evidence.deploy = {
      totalMs: deployMs, perMigration,
      blockedSamples: waits.length, blockedRequests: blockedRel,
      concurrentIncidentWriter: { statements: latencies.length, maxMs: latencies.length ? Math.max(...latencies) : null, p50Ms: latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null },
    };
    console.log(`    deploy ${deployMs} ms; per migration ${JSON.stringify(perMigration)}`);
    console.log(`    blocked-lock samples: ${waits.length} ${JSON.stringify(blockedRel)}; B9-shaped incident writer: ${JSON.stringify((evidence.deploy as Record<string, unknown>).concurrentIncidentWriter)}`);
    check("orchestrator", "M5", "the concurrent B9-shaped incident writer kept completing through the deploy (it waits, it does not fail)",
      latencies.length > 0 && !/ERROR:/.test(writes), writes.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 3).join(" / "));

    // post-migration catalog
    const cat = sql(owner, `select
        (select count(*) from pg_constraint where conrelid = '"SyncIssue"'::regclass and contype = 'c' and conname in (
          'SyncIssue_lifecycleState_check','SyncIssue_openedBy_check','SyncIssue_causeStatus_check','SyncIssue_recoveryEvidenceCount_check',
          'SyncIssue_resolutionReasonCode_format_check','SyncIssue_causeCode_format_check','SyncIssue_lifecycleState_resolved_check',
          'SyncIssue_resolved_state_reason_check','SyncIssue_acknowledged_all_or_none_check','SyncIssue_cause_code_check',
          'SyncIssue_cause_confirmed_check','SyncIssue_resolutionEvidence_size_check'))
      || '|' || (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where tablename = 'AuditLog' and 'fm_system' = any(roles))
      || '|' || (select count(*) from "FinancialAccount" where not "balanceObserved")
      || '|' || (select count(*) from "SpaceSnapshot" where "restrictedCash" is not null)
      || '|' || (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'SyncIssueKind' and e.enumlabel = 'BALANCE_UNOBSERVED')
      || '|' || (select count(*) from "UserSession" where "lastPresenceAt" is not null or "lastInteractionAt" is not null)
      || '|' || (select count(*) from "SyncIssue" where "lifecycleState" is not null);`).split("|");
    check("orchestrator", "C1", "PB-1: the 12 SyncIssue CHECKs exist and validated against every existing (B9-written) row", cat[0] === "12", cat[0]);
    check("orchestrator", "C2", "DB-010: fm_system has the four per-command AuditLog policies, fm_system_all dropped",
      cat[1] === "fm_system_ins:INSERT,fm_system_minimise:UPDATE,fm_system_retain:DELETE,fm_system_sel:SELECT", cat[1]);
    check("orchestrator", "C3", "FIN-A2: every existing account reads balanceObserved = true (default); enum value present", cat[2] === "0" && cat[4] === "1", { unobserved: cat[2], enum: cat[4] });
    check("orchestrator", "C4", "FIN-E: every existing snapshot reads restrictedCash NULL", cat[3] === "0", cat[3]);
    check("orchestrator", "C5", "PB-10 / PB-1: new columns NULL on every existing row (no backfill)", cat[5] === "0" && cat[6] === "0", { presence: cat[5], lifecycle: cat[6] });

    // 6. B10-code smoke
    console.log("\n[6] B10 code on the B10 schema");
    merge(runProbe("B10", "smoke", { ...env, B10REH_STATE: JSON.stringify(state), B10REH_B9_SESSION: String(state.b9PreSessionToken ?? "") }));
    const incidents: Record<string, string> = { ...(state.incidents as Record<string, string>), ...(state.iE ? { iE: String(state.iE) } : {}) };
    state.incidents = incidents;
    // Owner-side record of every resolved row, so the rollback can be checked for resolved=false rewrites (dropped at the end; never seen by the app roles).
    const resolvedBefore = Number(sql(owner, `create table _b10reh_resolved_before as select id from "SyncIssue" where resolved; select count(*) from _b10reh_resolved_before;`).split("\n").pop());

    // 7. APP ROLLBACK — B9 code, B10 schema kept
    console.log("\n[7] APP ROLLBACK: B9 code against the B10 schema");
    sql(owner, `${agedAuditSql("rb")}
      insert into "SyncIssue" (id,provider,"plaidItemId",kind,detail,resolved,"createdAt","updatedAt","firstOccurredAt","lastOccurredAt","resolvedAt","resolutionKind","lifecycleState","resolutionReasonCode","resolvedById")
        values ('aged_op_resolved','PLAID','rh-item-aged','TRANSACTION_PERSISTENCE_FAILED','{"stage":"transaction-persist","cursorBlocking":true}'::jsonb, true,
                now() - interval '120 days', now() - interval '100 days', now() - interval '120 days', now() - interval '110 days', now() - interval '100 days',
                'OPERATOR_RESOLVED','RESOLVED','OPERATOR_FIXED','${F.operator}');
      insert into "SyncIssueEvent" (id,"incidentId",type,"actorKind","actorId","auditId","fromState","toState","actionCode",at)
        values ('aged_op_event','aged_op_resolved','STATE_CHANGED','OPERATOR','${F.operator}','aged_op_audit','ACTIVE','RESOLVED','RESOLVE', now() - interval '100 days');`);
    merge(runProbe("B10", "totp-claim", { ...env, B10REH_STATE: JSON.stringify(state) }));
    merge(runProbe("B9", "rollback", { ...env, B10REH_STATE: JSON.stringify(state) }));

    // owner-side truth after the rollback
    console.log("\n[7b] Owner-side truth after the rollback");
    const q = (s: string) => sql(owner, s);
    check("orchestrator", "V1", "PB-1: every OPEN row still has lifecycleState NULL after B10 + B9 writes",
      q(`select count(*) from "SyncIssue" where not resolved and "lifecycleState" is not null;`) === "0");
    const [reopened, retained] = q(`select (select count(*) from _b10reh_resolved_before b join "SyncIssue" s using (id) where not s.resolved) || '|' ||
                                          (select count(*) from _b10reh_resolved_before b join "SyncIssue" s using (id));`).split("|").map(Number);
    q(`drop table _b10reh_resolved_before;`);
    check("orchestrator", "V2", "no resolved=false rewrite: every row resolved before the rollback is still resolved (or was retention-deleted)",
      reopened === 0 && retained > 0, { resolvedBefore, stillPresent: retained, reopened });
    const a = q(`select resolved || '|' || coalesce("lifecycleState",'NULL') || '|' || "resolutionKind" || '|' || ("acknowledgedAt" is not null) || '|' || ("acknowledgedAuditId" is not null)
                 from "SyncIssue" where id = '${incidents.iA}';`);
    check("orchestrator", "V3", "B9 auto-resolve of the acknowledged row: resolved=true, lifecycleState NULL, AUTOMATIC_RECOVERY, ack fields kept",
      a === "true|NULL|AUTOMATIC_RECOVERY|true|true", a);
    const b = q(`select resolved || '|' || "lifecycleState" || '|' || "resolutionKind" from "SyncIssue" where id = '${incidents.iB}';`);
    check("orchestrator", "V4", "the B10 operator-resolved row is unchanged by B9 (true|RESOLVED|OPERATOR_RESOLVED)", b === "true|RESOLVED|OPERATOR_RESOLVED", b);
    const fa = q(`select string_agg("balanceObserved"::text, ',') from "FinancialAccount" where id in ('${state.b9PreAccount}','${state.b9RollbackAccount}');`);
    check("orchestrator", "V5", "FIN-A2 default: accounts B9 inserted (before and after the migration) read balanceObserved = true", fa === "true,true", fa);
    const snaps = q(`select to_char(date,'YYYY-MM-DD') || '|' || coalesce("restrictedCash"::text,'NULL') || '|' || cash from "SpaceSnapshot" where "spaceId" = '${F.space1}' order by date;`).split("\n");
    const newRow = snaps.find((s) => s.startsWith(F.newSnapshotDate));
    check("orchestrator", "V6", "FIN-E default: a snapshot row B9 INSERTED reads restrictedCash NULL", !!newRow && newRow.split("|")[1] === "NULL", newRow ?? "missing");
    const sess = q(`select count(*) from "UserSession" where id in (select id from "UserSession" where "sessionToken" in ('${state.b9PreSessionToken}','${state.b9RollbackSessionToken}')) and "lastPresenceAt" is null;`);
    check("orchestrator", "V7", "PB-10: sessions B9 created read lastPresenceAt NULL", sess === "2", sess);
    const audit = q(`select (select count(*) from "AuditLog" where id like 'aged_beta_rb_%' and "ipAddress" is null and "userAgent" is null) || '|' ||
                            (select count(*) from "AuditLog" where id like 'aged_pe_rb_%') || '|' || (select count(*) from "AuditLog" where id = 'aged_keep_rb');`);
    check("orchestrator", "V8", "DB-010 + B9 retention: 3/3 aged beta rows minimised, 3/3 aged product events deleted, aged LOGIN row kept", audit === "3|0|1", audit);
    const agedIssue = q(`select (select count(*) from "SyncIssue" where id = 'aged_op_resolved') || '|' || (select count(*) from "SyncIssueArchive" where "incidentId" = 'aged_op_resolved') || '|' || (select count(*) from "SyncIssueEvent" where "incidentId" = 'aged_op_resolved');`);
    evidence.agedResolvedIncidentUnderB9Retention = agedIssue;

    // 8. data-effects inventory
    console.log("\n[8] Data-effects inventory (B10-written rows after the B10 run and the B9 rollback)");
    const inventory = Object.fromEntries(q(`select k || '=' || v from (values
        ('SyncIssue resolved by an operator (OPERATOR_RESOLVED, lifecycleState RESOLVED)', (select count(*) from "SyncIssue" where "resolutionKind" = 'OPERATOR_RESOLVED' and id <> 'aged_op_resolved')::text),
        ('SyncIssue acknowledged (acknowledged* set; open or later auto-resolved)', (select count(*) from "SyncIssue" where "acknowledgedAt" is not null)::text),
        ('SyncIssue opened by B10 (openedBy set)', (select count(*) from "SyncIssue" where "openedBy" is not null)::text),
        ('SyncIssueEvent rows', (select count(*) from "SyncIssueEvent")::text),
        ('SyncIssueEvent rows whose incident no longer exists', (select count(*) from "SyncIssueEvent" e where not exists (select 1 from "SyncIssue" s where s.id = e."incidentId"))::text),
        ('SyncIssueArchive rows', (select count(*) from "SyncIssueArchive")::text),
        ('AuditLog SYNC_INCIDENT_ACKNOWLEDGED / RESOLVED', (select count(*) from "AuditLog" where action in ('SYNC_INCIDENT_ACKNOWLEDGED','SYNC_INCIDENT_RESOLVED'))::text),
        ('UserSession with presence written', (select count(*) from "UserSession" where "lastPresenceAt" is not null)::text),
        ('RateLimit TOTP step-claim rows', (select count(*) from "RateLimit" where key like 'user:totp-login-step:%')::text),
        ('FinancialAccount balanceObserved = false', (select count(*) from "FinancialAccount" where not "balanceObserved")::text),
        ('SpaceSnapshot restrictedCash non-NULL', (select count(*) from "SpaceSnapshot" where "restrictedCash" is not null)::text),
        ('SyncIssueKind BALANCE_UNOBSERVED enum value', (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'SyncIssueKind' and e.enumlabel = 'BALANCE_UNOBSERVED')::text)
      ) x(k, v);`).split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf("="); return [l.slice(0, i), Number(l.slice(i + 1))]; }));
    evidence.dataEffects = inventory;
    evidence.space1Snapshots = snaps;
    evidence.b10Snapshot = state.b10Snapshot;
    evidence.finEParity = state.finEParity;
    for (const [k, v] of Object.entries(inventory)) console.log(`    ${k}: ${v}`);
    console.log(`    aged operator-resolved incident under B9 retention (row|archive|events): ${agedIssue}`);
    console.log(`    rehearsal Space snapshots (date|restrictedCash|cash): ${snaps.join("  ")}`);

    // findings (not B9-compat claims)
    const b10s = state.b10Snapshot as { restrictedCash?: number | null; savings?: number } | null;
    if (b10s && b10s.restrictedCash === 0) {
      finding("F1", "FIN-E: the LIVE snapshot writer (regenerateSpaceSnapshot) wrote restrictedCash = 0 although the Space links an HSA savings account; the HSA is counted as liquid savings",
        { restrictedCash: b10s.restrictedCash, savings: b10s.savings, hsaBalance: 500, cause: "readSpaceAccountsForSnapshot does not select providerSubtype (backfill and regenerate-history do)" });
    }
    if (agedIssue === "0|0|1") {
      finding("F2", "Rollback window: B9 data retention bare-deletes resolved incidents older than 90 days WITHOUT a SyncIssueArchive row (B10 archives first), and their SyncIssueEvent rows are left orphaned (no FK)",
        { "row|archive|events": agedIssue });
    }
    const todayRow = snaps[snaps.length - 1];
    if (todayRow && todayRow.split("|")[1] !== "NULL") {
      finding("F3", "Rollback window: B9's upsert of a row B10 wrote keeps B10's restrictedCash while rewriting cash (B9 never writes the column), so that row's restrictedCash is stale until B10 rewrites it",
        { b10: b10s, afterB9: todayRow });
    }
    evidence.findings = findings;
  } finally {
    rmSync(B9_PROBE_DEST(), { force: true });
    rmSync(B9_GUARD_DEST(), { force: true });
  }
  return 0;
}

main()
  .then(() => 0)
  .catch((e) => { check("orchestrator", "FATAL", "rehearsal ran to completion", false, e instanceof Error ? e.message : String(e)); return 1; })
  .then((fatal) => {
    teardown();
    const failed = checks.filter((c) => !c.ok);
    evidence.checks = checks;
    if (EVIDENCE) writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    console.log(`\n=== B10 REHEARSAL: ${checks.length - failed.length}/${checks.length} checks passed ===`);
    if (findings.length) {
      console.log(`\n!!! FINDINGS (${findings.length}; not B9-compat failures — for the release plan):`);
      for (const f of findings) console.log(`  ${f.id}  ${f.what}\n      ${f.detail}`);
    }
    if (failed.length) {
      console.log("\n!!! FAILURES (a failed B9-compat check is a B10 RELEASE BLOCKER):");
      for (const f of failed) console.log(`  ${f.side} ${f.id}  ${f.claim}\n      ${f.detail}`);
    }
    process.exit(failed.length || fatal ? 1 : 0);
  });
