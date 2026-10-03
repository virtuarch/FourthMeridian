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

/**
 * ⚠️ THE SECOND HALF OF THE PRINCIPAL CHECK, AND THE ONE THAT WAS MISSING.
 *
 * `assertTenantPrincipal()` above interrogates a URL with psql. That proves the
 * CREDENTIAL is constrained. It says nothing whatever about which client
 * `lib/db` actually bound — and those came apart in practice:
 *
 *   A probe added a STATIC import of a production module. That module imports
 *   `@/lib/db`, which binds its clients at module-evaluation time — BEFORE
 *   prepareHarness() had set DATABASE_URL_APP. `tenantDb` silently fell back to
 *   the legacy client, Prisma connected to the throwaway as its SUPERUSER
 *   OWNER, and every refusal became a success and every blinded read became
 *   "found". The probe reported NO DEFECTS AT ALL.
 *
 *   And this file printed "[rls] tenant principal verified: fm_app" during that
 *   run, because it had asked the URL, not the binding.
 *
 * So: ask the binding. This must be called AFTER prepareHarness() and it must
 * dynamically import `@/lib/db` (a static import here would reintroduce the
 * exact ordering bug it exists to catch). It checks both halves — that a
 * distinct fm_app client was constructed at all, and that a query issued
 * THROUGH it authenticates as fm_app.
 */
export async function assertTenantClientBound(): Promise<void> {
  const { activeDbRoles, tenantDb } = await import("@/lib/db");
  const roles = activeDbRoles();
  if (!roles.app) {
    throw new Error(
      `REFUSING TO RUN — lib/db did NOT bind a distinct fm_app client (activeDbRoles().app === false).\n` +
      `  Something imported "@/lib/db" before prepareHarness() set DATABASE_URL_APP, so tenantDb is the\n` +
      `  fallback client and every case below would run as the table OWNER while still printing PASS.\n` +
      `  Look for a STATIC import of a production module at the top of this suite; make it dynamic.`,
    );
  }
  const rows = await (tenantDb as unknown as {
    $queryRawUnsafe: (q: string) => Promise<Array<{ who: string; su: boolean; brls: boolean }>>;
  }).$queryRawUnsafe(
    `select current_user as who, r.rolsuper as su, r.rolbypassrls as brls
       from pg_roles r where r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r || r.who !== "fm_app" || r.su || r.brls) {
    throw new Error(
      `REFUSING TO RUN — the BOUND tenant client authenticates as "${r?.who}" ` +
      `(superuser=${r?.su}, bypassrls=${r?.brls}), not as an unprivileged fm_app.`,
    );
  }
  console.log(`[rls] tenant CLIENT verified: lib/db bound a real fm_app client, and a query through it agrees.`);
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
  ('acct_shared','Joint','checking','TestBank','USER','alice',now()),
  -- Owned by Alice and deliberately NOT linked into the shared Space, so a
  -- transfer counterparty can exist that a co-member must not be able to see.
  ('acct_alice_private','Alice Savings','savings','TestBank','USER','alice',now());

-- ⚠️ TIER VARIETY IS LOAD-BEARING. Every link used to be FULL, which made it
-- impossible to tell "RLS admitted this row" from "the application tier
-- admitted this row". fm_account_visible() ignores visibilityLevel entirely by
-- design — RLS is TENANCY ONLY — so a BALANCE_ONLY link is the only fixture
-- that can prove the tier is still the application's job.
insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
  ('l_a','space_a','acct_alice','HOME','ACTIVE','FULL',now()),
  ('l_b','space_b','acct_bob','HOME','ACTIVE','FULL',now()),
  ('l_sh','space_s','acct_shared','HOME','ACTIVE','FULL',now()),
  ('l_sh2','space_a','acct_shared','SHARED','ACTIVE','FULL',now()),
  ('l_ap','space_a','acct_alice_private','HOME','ACTIVE','FULL',now()),
  -- Bob sees the joint account in the SHARED Space at a REDUCED tier. RLS must
  -- still admit the row; the application must still redact it.
  ('l_sh_bal','space_b','acct_shared','SHARED','ACTIVE','BALANCE_ONLY',now()),
  -- A revoked link must stay excluded even though the Space is visible.
  ('l_rev','space_b','acct_alice','SHARED','REVOKED','FULL',now());

-- ⚠️ economicDate IS NOT OPTIONAL FOR THESE FIXTURES. Every transaction list
-- read orders on it (nulls last) and transactionCorpusSpan filters it to
-- NOT NULL. With it absent, a list-read test would pass
-- over an EMPTY SET and report success — a vacuous pass is worse than a
-- failure, because it is indistinguishable from working.
insert into "Transaction" (id,"financialAccountId",date,"economicDate",merchant,category,amount,"updatedAt") values
  ('tx_alice_1','acct_alice',current_date,current_date,'Coffee','Dining',-10,now()),
  ('tx_alice_2','acct_alice',current_date,current_date,'Books','Shopping',-20,now()),
  ('tx_bob_1','acct_bob',current_date,current_date,'Rent','Other',-50,now()),
  ('tx_shared_1','acct_shared',current_date,current_date,'Groceries','Groceries',-30,now()),
  ('tx_alice_priv','acct_alice_private',current_date,current_date,'Transfer out','Transfer',-100,now());

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

-- Operational rows for the activity timeline. The orphan is the important one:
-- most SyncIssue rows have no derivable tenant at all, and fm_app must not see
-- them even though it may see the two that are account-scoped.
-- ⚠️ lastOccurredAt IS SET ON THESE ROWS AND ON NO NEW ONE. It is the column
-- RLS-16 deliberately left OUT of the tenant role's six, and the scheduled
-- wallet sweep groups by it, so both halves of that case need a non-null clock
-- to read: an empty set would make "fm_app cannot read it" and "fm_system can
-- group by it" look fine for the wrong reason. Adding a FOURTH SyncIssue row
-- would instead have changed what Alice sees and silently relaxed RLS-16's
-- visibility pin, which is the opposite of a regression test.
insert into "SyncIssue" (id,kind,"financialAccountId","plaidTransactionId",resolved,"lastOccurredAt","updatedAt") values
  ('si_alice','BALANCE_TX_MISMATCH','acct_alice','ptx1',false,now(),now()),
  ('si_bob','BALANCE_TX_MISMATCH','acct_bob','ptx2',false,now(),now()),
  ('si_orphan','BALANCE_TX_MISMATCH',null,'ptx3',false,null,now());

-- ── BetaAccessRequest — PRE-TENANT BY CONSTRUCTION ───────────────────────────
-- There is no User row for any of these subjects, so no tenant predicate can
-- exist and no fixture here belongs to Alice or Bob. The four shapes are each
-- load-bearing:
--
--   bar_live        APPROVED + outstanding token — the ONE row a redemption may
--                   consume, and the one validateInvite must resolve. Its hash
--                   is replaced at runtime with hashResetToken(a real token).
--   bar_pending     a waitlist entry nobody decided. ⚠️ ITS EXISTENCE IS THE
--                   ANTI-ENUMERATION TEST'S DENOMINATOR: "the public role cannot
--                   find waitlisted@example.test" is vacuous over an empty
--                   table, and that is the exact bug RLS-14 found once already.
--   bar_notoken     APPROVED but with NO outstanding token — satisfies the
--                   application's status: APPROVED compare-and-swap and is
--                   HIDDEN by the fm_auth policy. The only fixture that can
--                   reproduce the silent refusal the redemption guard exists for.
--   bar_redeemed    already consumed — the ordinary lost-race zero.
insert into "BetaAccessRequest" (id,email,status,"inviteTokenHash","inviteExpiresAt","invitedAt","redeemedAt","redeemedUserId") values
  ('bar_live',    'invitee@example.test',    'APPROVED','hash_placeholder_live', now() + interval '7 days', now(), null, null),
  -- A SECOND live invite, so the WITH CHECK half can be tested against a row the
  -- USING half admits. Destroying a token without consuming the invite must
  -- RAISE, and that is unprovable once the only live invite has been redeemed.
  ('bar_live2',   'invitee2@example.test',   'APPROVED','hash_live2',            now() + interval '7 days', now(), null, null),
  ('bar_pending', 'waitlisted@example.test', 'PENDING', null,                    null,                      null, null, null),
  ('bar_notoken', 'revoked@example.test',    'APPROVED',null,                    now() + interval '7 days', now(), null, null),
  ('bar_redeemed','already@example.test',    'REDEEMED',null,                    null,                      now(), now(), 'some_prior_user');

-- ── RLS-C-S10 — THE SHAPES S7 AND S8 LEFT UNPROVABLE ─────────────────────────
-- Everything below exists so a claim one of those two slices made about what a
-- ROLE CAN OBSERVE has a real denominator. None of it is read by cases 1–54, and
-- none of it changes a figure any of them assert — the two rules that governed
-- the choices are the same ones the SyncIssue note above records:
--
--   * NOTHING HERE ADDS A ROW TO A TABLE AN EARLIER CASE COUNTS. In particular
--     no "Transaction" row appears here, because cases 4 and 13 pin Alice at 4
--     and Bob at 2 and a fixture that moved those numbers would relax the
--     backstop rather than extend it. The three transactions case 66 needs are
--     seeded INSIDE that case, after every earlier case has run.
--   * NO "SpaceMember" ROW IS ADDED. Case 34 inserts "m_removed" for
--     (space_b, alice) with "on conflict do nothing"; a REMOVED membership
--     seeded here would make that insert a silent no-op and its UPDATE would
--     then target a row that does not exist.

-- ── S7 — THE ORDERING DENOMINATOR ────────────────────────────────────────────
-- "AccountConnection" had ZERO rows, which made S7's ordering claim unprovable
-- in the only way that matters: with an empty table the WRONG order and the
-- RIGHT order both report "{count: 0}" and raise nothing, so a test over it
-- would pass whichever way round the writes went. "fm_app_upd" here is
-- "fm_account_visible("financialAccountId")", true only while an ACTIVE link
-- exists in a Space the actor is an ACTIVE member of — so these two rows are
-- what lets case 60 watch visibility be destroyed BEFORE the write that needed
-- it.
insert into "AccountConnection" (id,"financialAccountId","connectedByUserId","plaidItemDbId","syncStatus","updatedAt") values
  ('ac_shared','acct_shared','alice','pi_alice','pending',now()),
  ('ac_alice','acct_alice','alice','pi_alice','pending',now());

-- The RESTORE shape, which is the disconnect's mirror and needs the opposite
-- order: an account ALREADY soft-deleted, its link ALREADY revoked, its
-- connection ALREADY soft-deleted. Deliberately a SEPARATE account, so the
-- restore case cannot disturb the disconnect case's fixtures or be disturbed by
-- them — the two run opposite ways over the same policy.
insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","deletedAt","updatedAt") values
  ('acct_restore','Alice Archived','checking','TestBank','USER','alice',now(),now());
insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","revokedAt","revokedByUserId","updatedAt") values
  ('l_restore','space_a','acct_restore','HOME','REVOKED','FULL',now(),'alice',now());
insert into "AccountConnection" (id,"financialAccountId","connectedByUserId","plaidItemDbId","syncStatus","deletedAt","updatedAt") values
  ('ac_restore','acct_restore','alice','pi_alice','pending',now(),now());

-- ── S8 — AN INVESTMENT ACCOUNT ALICE OWNS AND CANNOT REACH ───────────────────
-- ⚠️ THE POINT IS THE ASYMMETRY BETWEEN TWO POLICIES. "FinancialAccount.fm_app_sel"
-- has an ""ownerUserId" = current_fm_user_id()" arm, so Alice can always see this
-- account itself. "AccountConnection.fm_app_sel" has NO such arm — it is
-- "fm_account_visible("financialAccountId")" alone — and this account's only
-- ACTIVE link is in space_b, which Alice is not a member of. So the connection
-- drops out while the account does not, which is exactly the shape
-- "getImportableAccountsForConnection" resolves through (case 70). Ownership is
-- not reach.
insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt") values
  ('acct_alice_inv','Alice Brokerage','investment','TestBank','USER','alice',now());
insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
  ('l_inv_b','space_b','acct_alice_inv','SHARED','ACTIVE','FULL',now());
insert into "AccountConnection" (id,"financialAccountId","connectedByUserId","plaidItemDbId","syncStatus","updatedAt") values
  ('ac_alice_inv','acct_alice_inv','alice','pi_alice','pending',now());

-- ── S8 — THE IMPORT BATCHES ──────────────────────────────────────────────────
-- Four batches on THREE different shapes, one per property, deliberately not
-- shared: "ib_m" is rolled back twice (once by Bob, observing nothing, once by
-- Alice against a concurrent delete) and "ib_n" must still have live rows when
-- its un-supersession is measured. One batch serving both would make the second
-- case depend on the first case's failure mode.
insert into "Instrument" (id,"tickerSymbol",name,"assetClass","updatedAt") values
  ('inst_x','XYZ','XYZ Corp','EQUITY',now());

insert into "ImportBatch" (id,"financialAccountId",source,kind,status,"updatedAt") values
  ('ib_bob','acct_bob',  'CSV','INVESTMENT_HISTORY','COMPLETED',now()),
  ('ib_k',  'acct_alice','CSV','TRANSACTIONS',      'COMPLETED',now()),
  ('ib_m',  'acct_alice','CSV','INVESTMENT_HISTORY','COMPLETED',now()),
  ('ib_n',  'acct_alice','CSV','INVESTMENT_HISTORY','COMPLETED',now());

insert into "InvestmentEvent" (id,"financialAccountId","instrumentId",type,date,source,"importBatchId","updatedAt") values
  ('ie_m1','acct_alice','inst_x','BUY',current_date,       'csv:test','ib_m',now()),
  ('ie_m2','acct_alice','inst_x','BUY',current_date - 1,   'csv:test','ib_m',now()),
  ('ie_n1','acct_alice','inst_x','BUY',current_date - 2,   'csv:test','ib_n',now());

-- "po_n_open" is the USER_ASSERTED opening the import outranked, and it is NOT a
-- member of the batch — that is the whole point. Its "supersededById" points at a
-- row the batch owns, so rolling the batch back must RETURN it. A silent failure
-- here leaves a user's own stated opening permanently outranked by evidence that
-- no longer exists, and reports "0 pointers cleared".
insert into "PositionObservation" (id,"financialAccountId","instrumentId",date,quantity,origin,source,"importBatchId","supersededById") values
  ('po_n_batch','acct_alice','inst_x',current_date - 2,10,'IMPORTED',     'csv:test','ib_n',null),
  ('po_n_open', 'acct_alice','inst_x',current_date - 3, 5,'USER_ASSERTED','user',    null,  'po_n_batch');

-- ── S8 — THE HOLDINGS RECONCILIATION'S THREE LEGS ────────────────────────────
-- Case 71 needs all three legs of "syncCurrentHoldings" to have real work: one
-- row to UPDATE, two to DELETE as stale, and one to INSERT. Without the stale
-- pair the rollback assertion would be vacuous — there would be nothing for the
-- failed insert to have to undo.
insert into "Holding" (id,"financialAccountId",symbol,name,quantity,price,value,"updatedAt") values
  ('h_aaa','acct_alice','AAA','Alpha',1,10,10,now()),
  ('h_bbb','acct_alice','BBB','Beta', 2,20,40,now()),
  ('h_ccc','acct_alice','CCC','Gamma',3,30,90,now());
`;
