/**
 * scripts/rls-app-acceptance.ts  (RLS-8)
 *
 * THE APPLICATION-LEVEL ADVERSARIAL SUITE.
 *
 * scripts/rls-acceptance.ts proves the DATABASE boundary by issuing SQL as
 * fm_app. This proves something different and strictly harder: that the
 * APPLICATION actually goes through that boundary. Every case below runs real
 * modules — lib/db.ts wiring its role clients from the environment,
 * lib/db/tenant-context.ts opening the transaction, and the converted service
 * functions themselves — against a throwaway database carrying the committed
 * migration history.
 *
 * The distinction matters because the two suites fail in opposite directions.
 * The SQL suite would stay green if the application never used fm_app at all.
 * This one goes red the moment a service reaches the database through any
 * authority but the one it was supposed to.
 *
 * ⚠️ CLAIM ONLY WHAT IS PROVEN. Cases are labelled by what they exercise:
 * [channel] the tenant transaction primitive, [service] a real service
 * function, [role] a role's grant surface. A [channel] pass is not evidence
 * that a route adopted it.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/rls-app-acceptance.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  prepareHarness, teardownHarness, psql, deniedByGrant, deniedByRls,
  makeRecorder, APP_FIXTURES,
} from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

async function main(): Promise<void> {
  console.log("\n=== RLS APPLICATION ADVERSARIAL SUITE ===\n");

  const h = prepareHarness("rlsapp");
  const seed = psql(h.ownerUrl, APP_FIXTURES);
  if (!seed.ok) throw new Error(`fixture seed failed: ${seed.err}`);
  console.log("[rls] Alice / Bob fixtures seeded (separate Spaces, one SHARED, private rows inside it).\n");

  // Imported ONLY now: lib/db.ts binds its clients at module load from the
  // environment prepareHarness() just set. A static import would have captured
  // the ambient DATABASE_URL and tested the wrong principal.
  const dbMod  = await import("@/lib/db");
  const tenant = await import("@/lib/db/tenant-context");
  const strict = await import("@/lib/db/strict-mode");

  // ── [role] the wiring the application actually got ────────────────────────
  const roles = dbMod.activeDbRoles();
  check(1, "[role] the application wired a DISTINCT client for every role (no silent fallback to postgres)",
    roles.app && roles.auth && roles.system, JSON.stringify(roles));

  const verdicts = await strict.verifyDbAuthorities(dbMod.configuredRoleClients());
  const bad = verdicts.filter((v) => !v.ok);
  check(2, "[role] every role connection IS the principal it claims, is not a superuser, has no BYPASSRLS, owns nothing",
    verdicts.length === 3 && bad.length === 0,
    bad.map((v) => `${v.variable}: ${v.problems.join("; ")}`).join(" | "));

  check(3, "[role] strict mode is ON, so a missing role URL could not have degraded to postgres",
    strict.strictRlsEnabled() && strict.strictConfigProblems().length === 0,
    JSON.stringify(strict.strictConfigProblems()));

  // ── [channel] the tenant transaction primitive, via the REAL module ───────
  const aliceTx = await tenant.withTenantDb("alice", async (tx) =>
    tx.transaction.count());
  const bobTx = await tenant.withTenantDb("bob", async (tx) =>
    tx.transaction.count());
  check(4, "[channel] withTenantDb scopes an UNFILTERED count to the caller (alice 4, bob 2, corpus 5)",
    aliceTx === 4 && bobTx === 2, `alice=${aliceTx} bob=${bobTx}`);

  // THE BACKSTOP: no application WHERE clause at all.
  const aliceSeesBob = await tenant.withTenantDb("alice", async (tx) =>
    tx.transaction.findUnique({ where: { id: "tx_bob_1" } }));
  check(5, "[channel] a query with NO tenant predicate, by Bob's known id, returns NOTHING for Alice",
    aliceSeesBob === null, `got ${JSON.stringify(aliceSeesBob)}`);

  const aliceWriteBob = await tenant.withTenantDb("alice", async (tx) =>
    tx.transaction.updateMany({ where: { id: "tx_bob_1" }, data: { amount: -999 } }));
  const bobAmount = await tenant.withTenantDb("bob", async (tx) =>
    tx.transaction.findUnique({ where: { id: "tx_bob_1" }, select: { amount: true } }));
  check(6, "[channel] Alice's UPDATE of Bob's transaction affects zero rows and leaves his data intact",
    aliceWriteBob.count === 0 && bobAmount?.amount === -50,
    `affected=${aliceWriteBob.count} bobAmount=${bobAmount?.amount}`);

  let crossInsert = "no error";
  try {
    await tenant.withTenantDb("alice", async (tx) =>
      tx.transaction.create({
        data: {
          id: "tx_evil", financialAccountId: "acct_bob", date: new Date(),
          merchant: "Evil", category: "Other", amount: -1, updatedAt: new Date(),
        },
      }));
  } catch (e) { crossInsert = e instanceof Error ? e.message : String(e); }
  check(7, "[channel] Alice INSERTing into Bob's account is refused by WITH CHECK",
    /row-level security/i.test(crossInsert), crossInsert.split("\n")[0]);

  // ── [channel] fail-closed identity ────────────────────────────────────────
  let emptyId = "no error";
  try { await tenant.withTenantDb("", async () => null); }
  catch (e) { emptyId = e instanceof Error ? e.name : String(e); }
  check(8, "[channel] an EMPTY identity is refused before the transaction opens",
    emptyId === "TenantIdentityError", emptyId);

  // A syntactically valid but unknown identity must see nothing — not everything.
  const ghost = await tenant.withTenantDb("no-such-user-" + Date.now(), async (tx) =>
    tx.transaction.count());
  check(9, "[channel] an UNKNOWN identity fails closed — zero rows, never the whole corpus",
    ghost === 0, `saw ${ghost}`);

  // A hostile value must not alter the predicate: set_config binds it.
  const injected = await tenant.withTenantDb("alice' OR '1'='1", async (tx) =>
    tx.transaction.count());
  check(10, "[channel] a MALFORMED/injection-shaped identity binds as a value and sees nothing",
    injected === 0, `saw ${injected}`);

  // ── [channel] identity lifetime on a pooled connection ────────────────────
  const leaked = await (dbMod.tenantDb as { $queryRawUnsafe: (s: string) => Promise<Array<{ v: string | null }>> })
    .$queryRawUnsafe(`SELECT nullif(current_setting('app.user_id', true), '') AS v`);
  check(11, "[channel] no identity survives OUTSIDE a transaction on the shared pool",
    leaked[0]?.v == null, `leaked ${leaked[0]?.v}`);

  let rolledBack = "none";
  try {
    await tenant.withTenantDb("alice", async (tx) => {
      await tx.transaction.count();
      throw new Error("deliberate rollback");
    });
  } catch { /* expected */ }
  const afterRollback = await (dbMod.tenantDb as { $queryRawUnsafe: (s: string) => Promise<Array<{ v: string | null }>> })
    .$queryRawUnsafe(`SELECT nullif(current_setting('app.user_id', true), '') AS v`);
  rolledBack = String(afterRollback[0]?.v);
  check(12, "[channel] a FAILED transaction leaves no identity residue on the recycled connection",
    afterRollback[0]?.v == null, `residue ${rolledBack}`);

  // Interleaved, on a pool deliberately smaller than the concurrency.
  const interleaved = await Promise.all(
    Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? "alice" : "bob"))
      .map(async (u) => ({ u, n: await tenant.withTenantDb(u, (tx) => tx.transaction.count()) })),
  );
  const wrong = interleaved.filter((r) => r.n !== (r.u === "alice" ? 4 : 2));
  check(13, "[channel] 30 interleaved Alice/Bob operations never cross-contaminate",
    wrong.length === 0, `${wrong.length} wrong: ${JSON.stringify(wrong.slice(0, 4))}`);

  // ── [role] the other two authorities stay in their lanes ──────────────────
  const authReach = psql(h.authUrl, `select count(*) from "Transaction";`, false);
  check(14, "[role] fm_auth cannot read tenant financial rows at all (denied by GRANT)",
    deniedByGrant(authReach), authReach.err.split("\n")[0] || `returned ${authReach.out}`);

  const authMemory = psql(h.authUrl, `select count(*) from "SpaceMemory";`, false);
  check(15, "[role] fm_auth cannot read converted tenant content (SpaceMemory)",
    deniedByGrant(authMemory), authMemory.err.split("\n")[0] || `returned ${authMemory.out}`);

  // fm_system IS allowed cross-tenant reach — that is its purpose. What must be
  // true is that it reaches it through a POLICY, not through BYPASSRLS, so the
  // grant is enumerable in pg_policies rather than hidden in a role attribute.
  const sysBypass = psql(h.ownerUrl, `select rolbypassrls from pg_roles where rolname='fm_system';`).out.trim();
  const sysSees = psql(h.systemUrl, `select count(*) from "Transaction";`, false);
  check(16, "[role] fm_system reaches all tenants by POLICY, never by BYPASSRLS",
    sysBypass === "f" && sysSees.ok && sysSees.out.trim() === "5",
    `bypassrls=${sysBypass} sees=${sysSees.out || sysSees.err.split("\n")[0]}`);

  // ── [service] REAL service functions, including a FORGED application scope ──
  // This is the case the whole programme exists for. memory-store takes a
  // MemoryScope {spaceId, ownerUserId} from the caller. Suppose that scope is
  // wrong — a bug, a stale value, or an attacker who found a way to influence
  // it. The application predicate would happily ask for Bob's rows. RLS is the
  // thing that has to refuse, because by then nothing else will.
  const store = await import("@/lib/ai/conversation/memory-store");
  const today = new Date().toISOString().slice(0, 10);

  const aliceOwn = await tenant.withTenantDb("alice", (tx) =>
    store.listOwnMemories(tx, { spaceId: "space_s", ownerUserId: "alice" }, today));
  check(18, "[service] listOwnMemories returns Alice's own memory in the SHARED Space",
    aliceOwn.length === 1 && aliceOwn[0].id === "mem_alice",
    JSON.stringify(aliceOwn.map((m) => m.id)));

  const bobOwn = await tenant.withTenantDb("bob", (tx) =>
    store.listOwnMemories(tx, { spaceId: "space_s", ownerUserId: "bob" }, today));
  check(19, "[service] Bob sees only his own memory in the same SHARED Space",
    bobOwn.length === 1 && bobOwn[0].id === "mem_bob",
    JSON.stringify(bobOwn.map((m) => m.id)));

  // THE BACKSTOP. Alice's identity, Bob's scope. The service asks for his rows.
  const forgedRead = await tenant.withTenantDb("alice", (tx) =>
    store.listOwnMemories(tx, { spaceId: "space_s", ownerUserId: "bob" }, today));
  check(20, "[service] a FORGED scope naming Bob returns NOTHING under Alice's identity — RLS is the backstop",
    forgedRead.length === 0, `leaked ${JSON.stringify(forgedRead.map((m) => m.id))}`);

  // …and the same forgery as a WRITE.
  const forgedErase = await tenant.withTenantDb("alice", (tx) =>
    store.deleteMemoryChain(tx, { spaceId: "space_s", ownerUserId: "bob" }, "mem_bob"));
  const bobStillThere = psql(h.ownerUrl, `select count(*) from "SpaceMemory" where id='mem_bob';`).out.trim();
  check(21, "[service] a FORGED scope cannot ERASE Bob's memory — the row survives",
    forgedErase.ok === false && bobStillThere === "1",
    `result=${JSON.stringify(forgedErase)} rowsLeft=${bobStillThere}`);

  // ── [service] RLS-13 — authority follows the EXECUTION PHASE ──────────────
  // lib/recovery-codes.ts serves three authorities from one module: a
  // pre-identity verification, a user regenerating their own codes, and an
  // operator regenerating someone else's. The client is a parameter precisely
  // so each caller states which it is; these cases prove the boundaries hold.
  const rc = await import("@/lib/recovery-codes");

  const ownCodes = await tenant.withTenantDb("alice", (tx) =>
    rc.generateRecoveryCodes(tx, "alice", false));
  const aliceHas = psql(h.ownerUrl, `select count(*) from "RecoveryCode" where "userId"='alice';`).out.trim();
  check(22, "[service] POST-identity: a user regenerating their OWN codes succeeds under the tenant role",
    ownCodes.length === 10 && aliceHas === "10", `codes=${ownCodes.length} rows=${aliceHas}`);

  // The whole point of the split: fm_app's RecoveryCode policy is
  // `userId = current_fm_user_id()`, so the tenant role CANNOT touch another
  // user's codes. The refusal is the feature, not an obstacle.
  let crossCodes = "no error";
  try {
    await tenant.withTenantDb("alice", (tx) => rc.generateRecoveryCodes(tx, "bob", false));
  } catch (e) { crossCodes = e instanceof Error ? e.message : String(e); }
  const bobHas = psql(h.ownerUrl, `select count(*) from "RecoveryCode" where "userId"='bob';`).out.trim();
  check(23, "[service] Alice CANNOT mint recovery codes for Bob through the tenant role",
    bobHas === "0", `bobRows=${bobHas} err=${crossCodes.split("\n")[0]}`);

  // …and the operator path, which legitimately acts on another user, can.
  const sysCount = await rc.countRemainingCodes(dbMod.systemDb, "alice");
  check(24, "[service] the OPERATOR authority can read another user's remaining-code count",
    sysCount === 10, `count=${sysCount}`);

  // ── [service] RLS-13 — the uniqueness capability ──────────────────────────
  // A deployment-wide question the tenant role structurally cannot answer:
  // fm_app's User policy is `id = current_fm_user_id()`, so under it every name
  // reads as free. The capability answers correctly and returns only a boolean.
  psql(h.ownerUrl, `update "User" set username='takenname' where id='bob';`);
  const avail = await import("@/lib/users/availability");

  check(25, "[service] a username held by ANOTHER user reads as taken (fm_app alone could not tell)",
    (await avail.isUsernameAvailable("takenname")) === false);
  check(26, "[service] a free username reads as available",
    (await avail.isUsernameAvailable("nobody-has-this")) === true);
  check(27, "[service] a user renaming to their OWN current name is not blocked by themselves",
    (await avail.isUsernameAvailable("takenname", "bob")) === true);
  check(28, "[service] email availability answers across users too",
    (await avail.isEmailAvailable("bob@example.test")) === false
    && (await avail.isEmailAvailable("free@example.test")) === true);

  // The narrowing itself: booleans only. If this ever returns a row it has
  // become the directory escape hatch it was built to prevent.
  const availSrc = readFileSync(join(process.cwd(), "lib/users/availability.ts"), "utf8");
  check(29, "[service] the capability returns ONLY booleans — no row, no id, no column",
    /Promise<boolean>/.test(availSrc) && !/select\s*:/.test(availSrc) && /\.count\(/.test(availSrc));

  // ── [role] RLS IS TENANCY ONLY — the tier stays the application's job ─────
  // Bob reaches the joint account through a BALANCE_ONLY link. fm_account_visible()
  // ignores visibilityLevel entirely, BY DESIGN: the owner decision is that RLS
  // answers "is this row in a Space I belong to" and nothing else. So the row
  // must be ADMITTED by the database and REDACTED by lib/account-privacy.
  //
  // If this ever starts returning null, RLS has quietly taken on a job it does
  // not model — and the tier would then be enforced in two places that can
  // disagree, which is worse than enforcing it in one.
  const tierRow = await tenant.withTenantDb("bob", (tx) =>
    tx.financialAccount.findUnique({ where: { id: "acct_shared" }, select: { id: true } }));
  check(30, "[role] a BALANCE_ONLY link still ADMITS the row at the database — the tier is not RLS's job",
    tierRow?.id === "acct_shared", `got ${JSON.stringify(tierRow)}`);

  // …and a REVOKED link excludes it even though the Space itself is visible.
  const revoked = await tenant.withTenantDb("bob", (tx) =>
    tx.financialAccount.findUnique({ where: { id: "acct_alice" }, select: { id: true } }));
  check(31, "[role] a REVOKED link excludes the account even though Bob can see that Space",
    revoked === null, `got ${JSON.stringify(revoked)}`);

  // The many-to-many fact, asserted rather than assumed: one account, two
  // Spaces, two members, both legitimately see it.
  const joint = psql(h.ownerUrl,
    `select count(*) from "SpaceAccountLink" where "financialAccountId"='acct_shared' and status='ACTIVE';`).out.trim();
  const aliceJoint = await tenant.withTenantDb("alice", (tx) =>
    tx.financialAccount.count({ where: { id: "acct_shared" } }));
  const bobJoint = await tenant.withTenantDb("bob", (tx) =>
    tx.financialAccount.count({ where: { id: "acct_shared" } }));
  check(32, "[role] MANY-TO-MANY preserved: one account, 3 ACTIVE links, visible to BOTH members",
    joint === "3" && aliceJoint === 1 && bobJoint === 1,
    `links=${joint} alice=${aliceJoint} bob=${bobJoint}`);

  // ── [role] RLS-15 — MEMBERSHIP ESCALATION ─────────────────────────────────
  // The hole these cases exist for shipped in the first policy migration and
  // was found by probing, not by review: the SpaceMember INSERT arm read
  // `OR "userId" = current_fm_user_id()`, which sounds like "your own row" and
  // actually means "any row naming you, in any Space". Alice self-joined Bob's
  // Space and her visible transaction count went 4 -> 5.
  //
  // The application never offered that route, so no product test could have
  // caught it. These are the regression pins.
  const selfJoin = psql(h.appUrl,
    `begin; set local app.user_id='alice';
     insert into "SpaceMember" (id,"spaceId","userId",role,status)
       values ('evil_join','space_b','alice','OWNER','ACTIVE');
     commit;`, false);
  const aliceAfter = await tenant.withTenantDb("alice", (tx) => tx.transaction.count());
  check(33, "[role] Alice CANNOT insert herself into Bob's Space (membership escalation refused)",
    deniedByRls(selfJoin) && aliceAfter === 4,
    `insert=${selfJoin.err.split("\n")[0] || "SUCCEEDED"} aliceSees=${aliceAfter}`);

  // Revocation must stay revocation: a REMOVED member cannot re-ACTIVATE
  // themselves without an invitation.
  psql(h.ownerUrl, `insert into "SpaceMember" (id,"spaceId","userId",role,status)
                    values ('m_removed','space_b','alice','VIEWER','REMOVED')
                    on conflict do nothing;`);
  const reactivate = psql(h.appUrl,
    `begin; set local app.user_id='alice';
     update "SpaceMember" set status='ACTIVE' where id='m_removed';
     commit;`, false);
  const stillRemoved = psql(h.ownerUrl, `select status from "SpaceMember" where id='m_removed';`).out.trim();
  check(34, "[role] a REMOVED member cannot re-ACTIVATE themselves without an invitation",
    stillRemoved === "REMOVED", `status is now ${stillRemoved}`);

  // …but WITH a pending invitation the same update is admitted, because that
  // is the flow the permissive arm existed to serve.
  const invited = psql(h.ownerUrl,
    `insert into "SpaceInvite" (id,"spaceId","invitedById","invitedUserId",role,status)
     values ('inv1','space_b','bob','alice','VIEWER','PENDING');`, false);
  if (!invited.ok) throw new Error(`invite fixture failed: ${invited.err.split("\n")[0]}`);
  const accept = psql(h.appUrl,
    `begin; set local app.user_id='alice';
     update "SpaceMember" set status='ACTIVE' where id='m_removed';
     commit;`, false);
  const afterAccept = psql(h.ownerUrl, `select status from "SpaceMember" where id='m_removed';`).out.trim();
  check(35, "[role] WITH a pending invitation, accepting it IS admitted (the flow still works)",
    accept.ok && afterAccept === "ACTIVE", `status=${afterAccept} err=${accept.err.split("\n")[0]}`);
  psql(h.ownerUrl, `delete from "SpaceMember" where id='m_removed'; delete from "SpaceInvite" where id='inv1';`);

  // The platform Spaces have ZERO members by design, so "unclaimed" would
  // describe them perfectly without the platformArea guard.
  psql(h.ownerUrl, `insert into "Space" (id,name,type,"platformArea","updatedAt")
                    values ('space_plat','Platform Ops','SHARED','PLATFORM_OPS',now())
                    on conflict do nothing;`);
  const claimPlatform = psql(h.appUrl,
    `begin; set local app.user_id='alice';
     insert into "SpaceMember" (id,"spaceId","userId",role,status)
       values ('evil_plat','space_plat','alice','OWNER','ACTIVE');
     commit;`, false);
  check(36, "[role] a member-less PLATFORM Space cannot be claimed by an ordinary user",
    deniedByRls(claimPlatform), claimPlatform.err.split("\n")[0] || "SUCCEEDED — platform escalation");

  // ── [role] RLS-16 — SHAPE, NOT CONTENT ───────────────────────────────────
  // The activity timeline needs to say "a sync problem happened on this
  // account". SyncIssue is operator forensics whose `detail` column carries
  // other people's merchant strings and amounts, so the grant is COLUMN-LEVEL:
  // the route's six fields, and nothing else. That turns "the route does not
  // read detail" from a convention into a constraint.
  const seeAlice = psql(h.appUrl,
    `begin; set local app.user_id='alice'; select coalesce(string_agg(id,',' order by id),'(none)') from "SyncIssue"; commit;`, false);
  const seeBob = psql(h.appUrl,
    `begin; set local app.user_id='bob'; select coalesce(string_agg(id,',' order by id),'(none)') from "SyncIssue"; commit;`, false);
  check(37, "[role] a sync issue is visible only to the tenant whose account it is (orphans to NEITHER)",
    seeAlice.out.trim() === "si_alice" && seeBob.out.trim() === "si_bob",
    `alice=${seeAlice.out.trim()} bob=${seeBob.out.trim()}`);

  const detailRead = psql(h.appUrl,
    `begin; set local app.user_id='alice'; select detail from "SyncIssue" where id='si_alice'; commit;`, false);
  check(38, "[role] the tenant role CANNOT read SyncIssue.detail — the column was never granted",
    deniedByGrant(detailRead), detailRead.err.split("\n")[0] || "ALLOWED — forensic content is reachable");

  const issueWrite = psql(h.appUrl,
    `begin; set local app.user_id='alice'; update "SyncIssue" set resolved=true where id='si_alice'; commit;`, false);
  check(39, "[role] the tenant role cannot WRITE the operational ledger (the split-authority seam holds)",
    deniedByGrant(issueWrite), issueWrite.err.split("\n")[0] || "ALLOWED — tenant wrote an operator ledger");

  // ── [role] the owner is not in the tenant path ────────────────────────────
  check(17, "[role] the tenant client is NOT the migration principal",
    dbMod.tenantDb !== dbMod.db, "tenantDb fell back to the shared client");

  await (dbMod.tenantDb as { $disconnect: () => Promise<void> }).$disconnect();
  await (dbMod.authDb as { $disconnect: () => Promise<void> }).$disconnect();
  await (dbMod.systemDb as { $disconnect: () => Promise<void> }).$disconnect();

  const failures = report("APPLICATION ADVERSARIAL");
  if (failures) process.exit(1);
  console.log("\nThe application reaches the database through the authority it was supposed to.\n");
}

main()
  .catch((e) => {
    console.error(`\n[rls] SUITE ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => teardownHarness(KEEP));
