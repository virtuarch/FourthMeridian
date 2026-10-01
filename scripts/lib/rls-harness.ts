/**
 * scripts/lib/rls-harness.ts  (RLS-8)
 *
 * The rig the APPLICATION-level adversarial suite runs on.
 *
 * scripts/rls-acceptance.ts proves the database boundary by issuing SQL as
 * fm_app. That is necessary and it is not sufficient: it proves the policies,
 * not that the application actually goes through them. This rig exists so the
 * same attacks can be run through REAL service functions — the ones the routes
 * call — with the role clients wired exactly as production wires them.
 *
 * ── WHY THE ENVIRONMENT IS SET BEFORE ANY IMPORT ─────────────────────────────
 * lib/db.ts builds its clients at MODULE LOAD from process.env. So the role
 * URLs have to exist before the first `import("@/lib/db")`, which is why every
 * service module here is reached through a dynamic import after prepare().
 * Importing lib/db at the top of this file would bind it to the ambient
 * DATABASE_URL and silently test the wrong principal.
 *
 * ── THE REFUSAL ──────────────────────────────────────────────────────────────
 * The first version of the SQL-level suite swapped credentials by pattern-
 * matching the URL. In CI that match silently failed and every case ran as the
 * superuser; the assertions were strong enough to go red, but a suite that can
 * quietly run as the owner is one weak assertion away from passing while
 * proving nothing. So this rig REFUSES TO START unless the tenant connection
 * authenticates as fm_app, is not a superuser, does not carry BYPASSRLS, and
 * owns no protected table.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const IMAGE = "postgres:16-alpine";
const OWNER = "fmowner";

export type Harness = {
  /** Owner connection — fixtures only, never an assertion subject. */
  ownerUrl: string;
  /** Role URLs, already exported into process.env for lib/db.ts to pick up. */
  appUrl: string;
  authUrl: string;
  systemUrl: string;
  containerName: string;
};

let container: string | null = null;

export function teardownHarness(keep = false): void {
  if (container && !keep) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  container = null;
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Run SQL. `stopOnError=false` when a refusal is the expected outcome. */
export function psql(url: string, sql: string, stopOnError = true) {
  const args = ["-X", "-q", "-A", "-t", "--no-psqlrc"];
  if (stopOnError) args.push("-v", "ON_ERROR_STOP=1");
  args.push(url);
  const r = spawnSync("psql", args, { encoding: "utf8", input: sql });
  const err = (r.stderr ?? "").trim();
  // psql exits 0 on a statement error without ON_ERROR_STOP, so success is
  // judged on stderr — otherwise a refusal would read as a pass.
  return { ok: r.status === 0 && !/\bERROR:/.test(err), out: (r.stdout ?? "").trim(), err };
}

export const deniedByRls = (r: { err: string }) => /row-level security policy/i.test(r.err);
export const deniedByGrant = (r: { err: string }) => /permission denied/i.test(r.err);

function withRole(url: string, role: string, password: string): string {
  const u = new URL(url);
  u.username = role;
  u.password = password;
  return u.toString();
}

/**
 * Build a throwaway database carrying the committed migration history, give the
 * three runtime roles throwaway passwords, and export the role URLs so
 * lib/db.ts will bind to them.
 */
export function prepareHarness(label: string): Harness {
  if (!sh("docker", ["info", "--format", "{{.ServerVersion}}"]).ok) {
    throw new Error("Docker is not available — this suite builds its own throwaway Postgres and will not fall back to any configured database.");
  }
  const db = `fintracker_${label}_${process.pid}`;
  const ownerPw = randomBytes(18).toString("hex");
  container = `fm-${label}-${process.pid}-${Date.now().toString(36)}`;

  const run = sh("docker", [
    "run", "-d", "--rm", "--name", container,
    "-e", `POSTGRES_USER=${OWNER}`, "-e", `POSTGRES_PASSWORD=${ownerPw}`, "-e", `POSTGRES_DB=${db}`,
    "-p", "127.0.0.1::5432", IMAGE,
  ]);
  if (!run.ok) throw new Error(`could not start ${IMAGE}: ${run.err || run.out}`);

  const deadline = Date.now() + 90_000;
  while (!sh("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", OWNER, "-d", db]).ok) {
    if (Date.now() > deadline) throw new Error("throwaway Postgres did not become ready within 90s");
    spawnSync("sleep", ["1"]);
  }
  const mapped = sh("docker", ["port", container, "5432/tcp"]).out.split("\n")[0];
  const port = /^127\.0\.0\.1:(\d+)$/.exec(mapped)?.[1];
  if (!port) throw new Error(`unexpected port mapping "${mapped}"`);

  const ownerUrl = `postgresql://${OWNER}:${ownerPw}@127.0.0.1:${port}/${db}`;

  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: `${ownerUrl}?schema=public`, DIRECT_URL: `${ownerUrl}?schema=public` },
  });
  if (migrate.status !== 0) {
    console.error(migrate.stdout, migrate.stderr);
    throw new Error("prisma migrate deploy failed against the throwaway database");
  }

  // The migration deliberately creates the roles WITHOUT passwords; secrets
  // never live in source control. Throwaway ones are minted here, per run.
  const pw = { app: randomBytes(18).toString("hex"), auth: randomBytes(18).toString("hex"), system: randomBytes(18).toString("hex") };
  const set = psql(ownerUrl,
    `ALTER ROLE fm_app    LOGIN PASSWORD '${pw.app}';
     ALTER ROLE fm_auth   LOGIN PASSWORD '${pw.auth}';
     ALTER ROLE fm_system LOGIN PASSWORD '${pw.system}';`);
  if (!set.ok) throw new Error(`could not set throwaway role passwords: ${set.err}`);

  const appUrl    = withRole(ownerUrl, "fm_app", pw.app);
  const authUrl   = withRole(ownerUrl, "fm_auth", pw.auth);
  const systemUrl = withRole(ownerUrl, "fm_system", pw.system);

  assertTenantPrincipal(appUrl);

  // Wire lib/db.ts. MUST happen before the first dynamic import of it.
  process.env.DATABASE_URL        = `${ownerUrl}?schema=public`;
  process.env.DIRECT_URL          = `${ownerUrl}?schema=public`;
  process.env.DATABASE_URL_APP    = appUrl;
  process.env.DATABASE_URL_AUTH   = authUrl;
  process.env.DATABASE_URL_SYSTEM = systemUrl;
  process.env.FM_RLS_STRICT       = "true";

  return { ownerUrl, appUrl, authUrl, systemUrl, containerName: container };
}

/**
 * Refuse to run unless the tenant connection is genuinely unprivileged.
 * Every assertion in the suite is meaningless otherwise, and a suite that
 * claims everything while proving nothing is worse than no suite.
 */
export function assertTenantPrincipal(appUrl: string): void {
  // ⚠️ `boolean::text` renders 'true'/'false', NOT the 't'/'f' that psql prints
  // for a bare boolean column. Comparing the cast against 'f' made this check
  // refuse unconditionally — a guard that always fires is as useless as one
  // that never does, just louder. Normalise to a single explicit token.
  const row = psql(appUrl, `
    SELECT current_user || '|' ||
           (CASE WHEN r.rolsuper     THEN 'yes' ELSE 'no' END) || '|' ||
           (CASE WHEN r.rolbypassrls THEN 'yes' ELSE 'no' END) || '|' ||
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname='public' AND c.relkind='r' AND c.relowner = r.oid)::text
      FROM pg_roles r WHERE r.rolname = current_user;`);
  if (!row.ok) throw new Error(`could not interrogate the tenant connection: ${row.err}`);
  const [who, superuser, bypass, owned] = row.out.trim().split("|");
  const problems: string[] = [];
  if (who !== "fm_app")     problems.push(`authenticates as "${who}", not fm_app`);
  if (superuser !== "no")   problems.push("is a SUPERUSER");
  if (bypass !== "no")      problems.push("carries BYPASSRLS");
  if (owned !== "0")        problems.push(`OWNS ${owned} protected table(s)`);
  if (problems.length) {
    throw new Error(
      `REFUSING TO RUN — the tenant principal is not constrained: ${problems.join("; ")}.\n` +
      `  Every case below would be meaningless. This is the exact failure mode the SQL suite hit once already.`,
    );
  }
  console.log(`[rls] tenant principal verified: fm_app, not a superuser, no BYPASSRLS, owns nothing.`);
}

// ── assertions ────────────────────────────────────────────────────────────────
export type Case = { n: number; name: string; ok: boolean; detail: string };

export function makeRecorder() {
  const cases: Case[] = [];
  const check = (n: number, name: string, ok: boolean, detail = "") => {
    cases.push({ n, name, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(n).padStart(2)}. ${name}${ok ? "" : `  -> ${detail}`}`);
  };
  const report = (title: string): number => {
    const failed = cases.filter((c) => !c.ok);
    console.log(`\n=== ${title}: ${cases.length - failed.length}/${cases.length} passed ===`);
    if (failed.length) {
      console.log("\nFAILURES:");
      for (const f of failed) console.log(`  ${f.n}. ${f.name}\n     ${f.detail}`);
    }
    return failed.length;
  };
  return { check, report, cases };
}

/**
 * Alice and Bob, with the shapes that matter: separate Spaces, a SHARED Space
 * exercising the many-to-many account model, and a user-private row inside it.
 */
export const APP_FIXTURES = `
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

-- Private rows inside the SHARED Space: spaceId alone must NOT be enough.
insert into "SpaceMemory" (id,"spaceId","ownerUserId",kind,subject,payload,"statedAs",status)
  values
  ('mem_alice','space_s','alice','INTENTION','alice private goal','{}'::jsonb,'an intention of Alice''s','ACTIVE'),
  ('mem_bob','space_s','bob','INTENTION','bob private goal','{}'::jsonb,'an intention of Bob''s','ACTIVE');

insert into "DailyBrief" (id,"spaceId","ownerUserId","briefDay","updatedAt") values
  ('brief_alice','space_s','alice',current_date,now()),
  ('brief_bob','space_s','bob',current_date,now());

insert into "PlaidItem" (id,"userId","externalItemId","institutionId","institutionName","encryptedToken",status,"updatedAt")
  values ('pi_alice','alice','ext_a','ins_1','TestBank','cipher','ACTIVE',now()),
         ('pi_bob','bob','ext_b','ins_1','TestBank','cipher','ACTIVE',now());

insert into "FxRate" (id,date,base,quote,rate,source) values ('fx1',current_date,'USD','EUR',0.9,'test');
`;
