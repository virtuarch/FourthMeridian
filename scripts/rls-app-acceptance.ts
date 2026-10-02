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

  // ── [service] RLS-C-S6a — A REFUSED WRITE IS NOT A LOST RACE ──────────────
  // Case 6 above proved the REFUSAL: Alice's UPDATE of Bob's row affects zero
  // rows, silently. These two prove that the guard tells that zero apart from
  // the identical zero a real compare-and-swap produces, against the real
  // policy rather than a fake. Without the guard, both of these return `false`
  // and the product calls both of them "somebody else got there first".
  const cas = await import("@/lib/db/conditional-write");

  let casRefusal: unknown = null;
  await tenant.withTenantDb("alice", async (tx) => {
    const w = await tx.transaction.updateMany({ where: { id: "tx_bob_1", merchant: "Rent" }, data: { category: "Other" } });
    try {
      await cas.resolveConditionalWrite(
        w.count,
        { table: "Transaction", rowId: "tx_bob_1", operation: "update" },
        () => tx.transaction.count({ where: { id: "tx_bob_1" } }),
      );
    } catch (e) { casRefusal = e; }
  });
  check(40, "[service] a POLICY-REFUSED compare-and-swap raises IndeterminateWriteError instead of reporting contention",
    casRefusal instanceof cas.IndeterminateWriteError,
    casRefusal === null ? "returned a business verdict — the refusal is still silent" : String(casRefusal).split("\n")[0]);

  // The control, and the half that keeps the guard honest: Alice's OWN row with
  // a CAS condition that cannot match. Visible, so this is genuine contention
  // and must stay an ordinary `false` — a guard that raised here would convert
  // every lost race in the system into an incident.
  const casContention = await tenant.withTenantDb("alice", async (tx) => {
    const w = await tx.transaction.updateMany({ where: { id: "tx_alice_1", merchant: "NotCoffee" }, data: { category: "Other" } });
    return cas.resolveConditionalWrite(
      w.count,
      { table: "Transaction", rowId: "tx_alice_1", operation: "update" },
      () => tx.transaction.count({ where: { id: "tx_alice_1" } }),
    );
  });
  check(41, "[service] a GENUINE stale-condition CAS on a VISIBLE row still returns ordinary contention",
    casContention === false, `got ${JSON.stringify(casContention)}`);

  // ── RLS-C-S6 — THE DENIED-TABLE SEAMS ─────────────────────────────────────
  // BetaAccessRequest is the one table in the family migration …000100 §4 revoked
  // wholesale that a PUBLIC, UNAUTHENTICATED request must touch: the waitlist
  // intake and the single-use invite redemption. It is PRE-TENANT by
  // construction — the subject has no User row — so NOT ONE property below is
  // carried by a tenant predicate. Each is a column GRANT or a WITH CHECK.

  // The fixtures the whole block rests on. ⚠️ ASSERTED, NOT ASSUMED: three cases
  // below are ABSENCE claims ("the public role cannot find this"), and an absent
  // fixture makes every one of them pass for the wrong reason. RLS-14 shipped
  // exactly that bug once.
  const barSeeded = psql(h.ownerUrl,
    `select string_agg(id || ':' || status, ',' order by id) from "BetaAccessRequest";`).out.trim();
  check(42, "[role] the five pre-tenant invite shapes are seeded, so the denials below cannot pass over an empty table",
    barSeeded === "bar_live:APPROVED,bar_live2:APPROVED,bar_notoken:APPROVED,bar_pending:PENDING,bar_redeemed:REDEEMED",
    barSeeded);

  const appBeta = psql(h.appUrl,
    `begin; set local app.user_id='alice'; select count(*) from "BetaAccessRequest"; commit;`, false);
  check(43, "[role] the TENANT role cannot read the waitlist at all — there is no identity in this table to bind a policy to",
    deniedByGrant(appBeta), appBeta.err.split("\n")[0] || `returned ${appBeta.out}`);

  // ANTI-ENUMERATION, and the mechanism matters: `email` is not GRANTED, so the
  // question is refused by Postgres before any policy is consulted. A policy
  // could not have carried this — a stranger probing addresses must learn
  // nothing, and `… WHERE email = $1` would be admitted by any USING clause that
  // admits the row at all.
  const emailRead  = psql(h.authUrl, `select email from "BetaAccessRequest" where id='bar_live';`, false);
  const emailProbe = psql(h.authUrl, `select id from "BetaAccessRequest" where email='waitlisted@example.test';`, false);
  check(44, "[role] the pre-identity role can neither READ nor FILTER ON an address — the waitlist is not enumerable",
    deniedByGrant(emailRead) && deniedByGrant(emailProbe),
    `read=${emailRead.err.split("\n")[0] || emailRead.out} probe=${emailProbe.err.split("\n")[0] || emailProbe.out}`);

  // …and what it CAN see is two identity-free columns of the invite LIFECYCLE.
  // The WAITLIST is outside the policy: a PENDING request is invisible even by
  // id, so the public surface cannot see who is queued. (REDEEMED is inside it
  // of necessity — the SELECT policy is applied to the post-update row too, so a
  // policy narrower than the redemption's destination makes the redemption
  // impossible. See migration …000600.)
  const authVisible = psql(h.authUrl,
    `select coalesce(string_agg(id,',' order by id),'(none)') from "BetaAccessRequest";`, false);
  check(45, "[role] the pre-identity role sees the invite LIFECYCLE and never the WAITLIST — bar_pending is invisible even by id",
    authVisible.ok && authVisible.out.trim() === "bar_live,bar_live2,bar_notoken,bar_redeemed",
    authVisible.err.split("\n")[0] || `saw ${authVisible.out.trim()}`);

  // THE SELF-ISSUED INVITE. `fm_app_insert … WITH CHECK (true)` authorised an
  // anonymous INSERT of an APPROVED row with an attacker-chosen token hash — a
  // valid invite, minted by whoever can reach the public intake. The route only
  // ever writes email and note, so no product test could have found it; the
  // POLICY allowed it. This is the RLS-15 shape, and these are its pins.
  const authSelfApprove = psql(h.authUrl,
    `insert into "BetaAccessRequest" (id,email,status,"inviteTokenHash","inviteExpiresAt")
     values ('bar_evil','evil@example.test','APPROVED','hash_evil', now() + interval '7 days');`, false);
  const appSelfApprove = psql(h.appUrl,
    `begin; set local app.user_id='alice';
     insert into "BetaAccessRequest" (id,email,status,"inviteTokenHash","inviteExpiresAt")
     values ('bar_evil2','evil2@example.test','APPROVED','hash_evil2', now() + interval '7 days');
     commit;`, false);
  const plainIntake = psql(h.authUrl,
    `insert into "BetaAccessRequest" (id,email) values ('bar_intake','newcomer@example.test');`, false);
  const evilRows = psql(h.ownerUrl,
    `select count(*) from "BetaAccessRequest" where id in ('bar_evil','bar_evil2');`).out.trim();
  check(46, "[role] NEITHER public role can mint itself an APPROVED request with its own invite token, while a plain intake still succeeds",
    deniedByRls(authSelfApprove) && deniedByRls(appSelfApprove) && plainIntake.ok && evilRows === "0",
    `auth=${authSelfApprove.err.split("\n")[0] || "SUCCEEDED — self-issued invite"} app=${appSelfApprove.err.split("\n")[0] || "SUCCEEDED — self-issued invite"} intake=${plainIntake.err.split("\n")[0] || "ok"} rows=${evilRows}`);

  // ── [service] the invite-validation CAPABILITY ────────────────────────────
  // Neither public role is granted this read, so it is not a grant at all: a raw
  // token in, a closed {valid, email, requestId} out, over systemDb. The token
  // IS the authorisation — a 32-byte secret only the addressee was emailed — so
  // possession proves the right to learn that one address and no other.
  const tokenMod = await import("@/lib/password-reset-token");
  const RAW_INVITE = "raw-invite-token-for-the-acceptance-suite";
  const setHash = psql(h.ownerUrl,
    `update "BetaAccessRequest" set "inviteTokenHash"='${tokenMod.hashResetToken(RAW_INVITE)}' where id='bar_live';`);
  if (!setHash.ok) throw new Error(`invite hash fixture failed: ${setHash.err}`);
  const reg = await import("@/lib/registration-policy");

  const goodInvite = await reg.validateInvite(RAW_INVITE);
  const wrongInvite = await reg.validateInvite("not-the-token");
  check(47, "[service] validateInvite resolves a live invite to its BOUND email, and a wrong token to nothing",
    goodInvite.valid && goodInvite.email === "invitee@example.test" && goodInvite.requestId === "bar_live"
    && wrongInvite.valid === false && wrongInvite.email === null,
    `good=${JSON.stringify(goodInvite)} wrong=${JSON.stringify(wrongInvite)}`);

  // The narrowing itself — the reason a deployment-wide authority is acceptable
  // here. If this module ever gains an address-keyed lookup or a list read it has
  // become the waitlist directory the column grants exist to prevent.
  const regSrc = readFileSync(join(process.cwd(), "lib/registration-policy.ts"), "utf8");
  check(48, "[service] the capability's ONLY key is the invite-token hash — it cannot be asked about an address, or for a list",
    /inviteTokenHash:\s*hashResetToken\(/.test(regSrc)
    && !/betaAccessRequest\.(findMany|count|aggregate|groupBy)/.test(regSrc)
    && !/where:\s*\{\s*email/.test(regSrc));

  // ── THE SILENT REFUSAL, REPRODUCED ────────────────────────────────────────
  // `bar_notoken` is APPROVED — so the application's `status: APPROVED`
  // compare-and-swap matches it — and HIDDEN by the fm_auth policy, which admits
  // only an invite with an outstanding token. This is the one configuration that
  // produces the defect: a role holding UPDATE whose policy filters the row. A
  // missing GRANT would have raised; a policy filter returns `{count: 0}` with
  // no error and no log, and the register route used to discard that count and
  // create the account anyway — leaving `inviteTokenHash` non-null and the
  // single-use invite reusable for ever.
  let rawRefusal: { count: number } | string;
  try {
    rawRefusal = await dbMod.authDb.$transaction(async (tx) =>
      tx.betaAccessRequest.updateMany({
        where: { id: "bar_notoken", status: "APPROVED" },
        data:  { status: "REDEEMED", redeemedAt: new Date(), redeemedUserId: "alice", inviteTokenHash: null },
      }));
  } catch (e) { rawRefusal = e instanceof Error ? e.message : String(e); }
  const notokenAfterRaw = psql(h.ownerUrl, `select status from "BetaAccessRequest" where id='bar_notoken';`).out.trim();
  check(49, "[role] a POLICY-HIDDEN redemption returns count 0 and RAISES NOTHING — the silent refusal is real, not hypothetical",
    typeof rawRefusal !== "string" && rawRefusal.count === 0 && notokenAfterRaw === "APPROVED",
    `result=${JSON.stringify(rawRefusal)} status=${notokenAfterRaw}`);

  // …AND THE PROPERTY THAT MATTERS: the authority refuses to proceed. Both a
  // policy refusal (bar_notoken) and an ordinary lost race (bar_redeemed, already
  // consumed) raise, because a single-use invite redeemed by somebody else is
  // exactly as fatal as one the database refused. There is no third state and no
  // visibility probe — the invite is consumed or the registration does not happen.
  const attempts: unknown[] = [];
  for (const id of ["bar_notoken", "bar_redeemed"]) {
    try {
      await dbMod.authDb.$transaction(async (tx) =>
        reg.redeemBetaInvite(tx, { requestId: id, redeemedUserId: "alice" }));
      attempts.push(null);
    } catch (e) { attempts.push(e); }
  }
  const untouched = psql(h.ownerUrl,
    `select status || '|' || coalesce("redeemedUserId",'(null)') from "BetaAccessRequest" where id='bar_notoken';`).out.trim();
  check(50, "[service] redeemBetaInvite RAISES on a refused AND on a raced redemption — no account can be minted against an unconsumed invite",
    attempts.every((a) => a instanceof reg.InviteNotConsumedError) && untouched === "APPROVED|(null)",
    `attempts=${attempts.map((a) => (a === null ? "SILENT NO-OP" : (a as Error).name)).join(",")} row=${untouched}`);

  // The positive case, under the role that actually serves registration. Without
  // this the two above would be satisfied by a redemption that never works.
  let redeemed = "ok";
  try {
    await dbMod.authDb.$transaction(async (tx) =>
      reg.redeemBetaInvite(tx, { requestId: "bar_live", redeemedUserId: "alice" }));
  } catch (e) { redeemed = e instanceof Error ? e.message : String(e); }
  const liveAfter = psql(h.ownerUrl,
    `select status || '|' || coalesce("inviteTokenHash",'(null)') || '|' || coalesce("redeemedUserId",'(null)')
       from "BetaAccessRequest" where id='bar_live';`).out.trim();
  check(51, "[service] the redemption SUCCEEDS under the pre-identity role: consumed, token destroyed, redeemer recorded",
    redeemed === "ok" && liveAfter === "REDEEMED|(null)|alice",
    `err=${redeemed.split("\n")[0]} row=${liveAfter}`);

  // Redemption is ONE-WAY at the database. Clearing a live invite's token WITHOUT
  // consuming it violates WITH CHECK and raises; un-redeeming a consumed one is
  // outside USING and matches nothing. A public role cannot resurrect an invite
  // it just destroyed, however the application is edited.
  const stealToken = psql(h.authUrl,
    `update "BetaAccessRequest" set "inviteTokenHash"=null where id='bar_live2';`, false);
  const unredeem = psql(h.authUrl,
    `update "BetaAccessRequest" set status='APPROVED' where id='bar_live';`, false);
  const oneWay = psql(h.ownerUrl,
    `select (select status from "BetaAccessRequest" where id='bar_live') || '|' ||
            (select coalesce("inviteTokenHash",'(null)') from "BetaAccessRequest" where id='bar_live2');`).out.trim();
  check(52, "[role] redemption is ONE-WAY: a token cannot be destroyed without consuming the invite, and a consumed invite cannot be re-approved",
    deniedByRls(stealToken) && oneWay === "REDEEMED|hash_live2",
    `steal=${stealToken.err.split("\n")[0] || "SUCCEEDED"} unredeem=${unredeem.err.split("\n")[0] || "no error"} row=${oneWay}`);

  // ── THE INTAKE FITS INSIDE INSERT-ONLY ────────────────────────────────────
  // The waitlist route used `upsert` by email with an EMPTY update — the same
  // intent said a more expensive way, and one that needs SELECT (to detect the
  // conflict) and UPDATE (to resolve it) on a table whose only public privilege
  // is INSERT. Both halves are asserted: the old shape is IMPOSSIBLE for the
  // public role, and the conflict-ignoring insert that replaced it works and
  // changes nothing. Note the conflicting row is bar_pending, which this role
  // cannot SEE — proof that a repeat submission involves no read at all, which
  // is the strongest form of the non-enumeration promise the route makes.
  let oldShape = "no error";
  try {
    await dbMod.authDb.betaAccessRequest.upsert({
      where: { email: "waitlisted@example.test" }, update: {},
      create: { email: "waitlisted@example.test" },
    });
  } catch (e) { oldShape = e instanceof Error ? e.message : String(e); }
  let newShape = "ok";
  try {
    await dbMod.authDb.betaAccessRequest.createMany({
      data: [{ email: "waitlisted@example.test", note: "resubmitted" }], skipDuplicates: true,
    });
  } catch (e) { newShape = e instanceof Error ? e.message : String(e); }
  const pendingRow = psql(h.ownerUrl,
    `select status || '|' || coalesce(note,'(null)') from "BetaAccessRequest" where id='bar_pending';`).out.trim();
  check(54, "[service] a REPEAT waitlist submission fits inside INSERT-only — the upsert it replaced is refused, and the existing request is untouched",
    /permission denied/i.test(oldShape) && newShape === "ok" && pendingRow === "PENDING|(null)",
    `upsert=${oldShape.split("\n")[0]} insert=${newShape.split("\n")[0]} row=${pendingRow}`);

  // ── [role] RLS-16's COLUMN GRANT DID NOT WIDEN ────────────────────────────
  // The scheduled wallet sweep groups SyncIssue by `lastOccurredAt`, which RLS-16
  // deliberately left out of the tenant role's six columns. Its only caller is
  // jobs/sync-crypto.ts and it enumerates every wallet in the deployment, so it
  // moved to fm_system. This asserts the decision: the forensic clock is STILL
  // unreachable from fm_app, and the authority that legitimately needs it has it.
  const lastOccRead = psql(h.appUrl,
    `begin; set local app.user_id='alice'; select "lastOccurredAt" from "SyncIssue" where id='si_alice'; commit;`, false);
  const sysGroup = psql(h.systemUrl,
    `select count(*) from (select "financialAccountId", max("lastOccurredAt") m from "SyncIssue"
       group by "financialAccountId") q where q.m is not null;`, false);
  check(53, "[role] SyncIssue.lastOccurredAt is STILL ungranted to fm_app — the sweep moved to fm_system rather than widening the forensic grant",
    deniedByGrant(lastOccRead) && sysGroup.ok && sysGroup.out.trim() === "2",
    `app=${lastOccRead.err.split("\n")[0] || `ALLOWED — read ${lastOccRead.out}`} system=${sysGroup.err.split("\n")[0] || sysGroup.out.trim()}`);

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
