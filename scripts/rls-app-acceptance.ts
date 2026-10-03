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
  prepareHarness, assertTenantClientBound, teardownHarness, psql, deniedByGrant, deniedByRls,
  makeRecorder, APP_FIXTURES,
} from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

async function main(): Promise<void> {
  console.log("\n=== RLS APPLICATION ADVERSARIAL SUITE ===\n");

  const h = prepareHarness("rlsapp");
  // RLS-HARNESS-1 — the URL was checked above; this checks the BINDING.
  await assertTenantClientBound();
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


  // ══════════════════════════════════════════════════════════════════════════
  // RLS-C-S10 — THE CASES S7 AND S8 DEFERRED, AGAINST REAL PRINCIPALS
  //
  // S7 and S8 both shipped implementations whose correctness rests on a claim
  // about WHAT A ROLE CAN OBSERVE: that a co-owner's link is invisible to the
  // actor, that a connection stops being writable the moment its last visible
  // link is revoked, that a batch's rows drop out of both the observation and
  // the write when a merge relocates them. Every one of those claims was backed
  // only by a unit test with a FAKE CLIENT, and a fake client cannot in
  // principle say anything about a policy — it answers whatever it was written
  // to answer. Local development has no role URLs provisioned, so `withTenantDb`
  // falls back to the legacy client there and the properties are unobservable;
  // this harness is the only place they exist.
  //
  // ⚠️ AND THE FIRST CASE IS THE DENOMINATOR FOR THE REST. Almost everything
  // below is an ABSENCE claim, and an absence over an empty set passes for the
  // wrong reason — a bug an earlier slice in this programme actually shipped. So
  // case 55 proves Alice genuinely sees FEWER rows than exist before anything
  // asks what she cannot do, and case 64 does the same for the import block.
  // ══════════════════════════════════════════════════════════════════════════

  /** One tenant statement batch under a named identity, exactly as the role sees it. */
  const asTenant = (userId: string, sql: string) =>
    psql(h.appUrl, `begin; set local app.user_id='${userId}';\n${sql}\ncommit;`, false);
  /**
   * ⚠️ `psql -q` SUPPRESSES COMMAND TAGS, so "UPDATE 2" never reaches stdout and
   * an affected-row count cannot be read off it. Wrapping the statement in a CTE
   * and counting its RETURNING rows is the only way to observe the count, and it
   * is also the honest one: RETURNING is itself filtered by the SELECT policy, so
   * a row the write touched but the role cannot see would not be counted here —
   * which is precisely the hazard under test.
   */
  const counting = (statement: string) => `with c as (${statement} returning 1) select count(*) from c;`;
  const lines = (r: { out: string }) => r.out.trim().split("\n").map((s) => s.trim());

  /**
   * Put the link / connection / soft-delete fixtures back exactly as seeded.
   * Cases 57, 58, 60, 61 and 71 each destroy visibility deliberately, and the
   * NEXT case's premise is that visibility exists — so the reset is surgical and
   * BY ID. A blanket `set status='ACTIVE' where "financialAccountId"=…` would
   * also resurrect `l_rev`, the deliberately-revoked link case 31 pins.
   */
  const restoreFixtures = () => {
    const r = psql(h.ownerUrl, `
      update "SpaceAccountLink" set status='ACTIVE', "revokedAt"=null, "revokedByUserId"=null
        where id in ('l_a','l_b','l_sh','l_sh2','l_sh_bal','l_ap','l_inv_b');
      update "SpaceAccountLink" set status='REVOKED' where id in ('l_rev','l_restore');
      update "AccountConnection" set "deletedAt"=null where id in ('ac_shared','ac_alice','ac_alice_inv');
      update "AccountConnection" set "deletedAt"=now() where id='ac_restore';
      update "FinancialAccount" set "deletedAt"=null
        where id in ('acct_alice','acct_bob','acct_shared','acct_alice_private','acct_alice_inv');
      update "FinancialAccount" set "deletedAt"=now() where id='acct_restore';`);
    // A failed reset would make the NEXT case's premise false while its
    // assertion still read as a legitimate verdict. Refuse instead.
    if (!r.ok) throw new Error(`fixture restore failed: ${r.err.split("\n")[0]}`);

    // ⚠️ AND `r.ok` IS NOT ENOUGH, WHICH IS THE DEFECT THE COMMENT ABOVE
    // DESCRIBES AND DID NOT CATCH.
    //
    // An UPDATE that matches ZERO rows succeeds. psql reports ok. So when case
    // 63 HARD-DELETES `acct_shared` — deliberately, to prove ON DELETE CASCADE
    // is not RLS-filtered — every later `set "deletedAt"=null where id in (…,
    // 'acct_shared', …)` restored nothing and said so in no way at all. The next
    // case's premise was quietly false while its assertion still printed a
    // verdict. That is the same shape as a refused UPDATE read as contention:
    // the absence of an error standing in for the presence of a result.
    //
    // So the reset now asserts the fixtures it CLAIMS to restore are actually
    // there, by id, and names the missing ones. A case that destroys a row
    // permanently must seed its own replacement or run last — it may not leave
    // the suite reporting on rows that do not exist.
    const present = psql(h.ownerUrl, `
      select string_agg(id, ',' order by id) from "FinancialAccount"
       where id in ('acct_alice','acct_bob','acct_shared','acct_alice_private','acct_alice_inv','acct_restore');`);
    if (!present.ok) throw new Error(`fixture verification failed: ${present.err.split("\n")[0]}`);
    const have = new Set(present.out.trim().split(",").filter(Boolean));
    const want = ["acct_alice","acct_bob","acct_shared","acct_alice_private","acct_alice_inv","acct_restore"];
    const gone = want.filter((id) => !have.has(id));
    if (gone.length) {
      throw new Error(
        `fixture restore is a NO-OP for ${gone.length} account(s) that no longer exist: ${gone.join(", ")}.\n` +
        `  restoreFixtures() cannot resurrect a hard-deleted row, and every case after this point that\n` +
        `  assumes one would assert over an empty set and PASS. Seed a replacement in the destroying\n` +
        `  case, or move it last.`,
      );
    }
  };

  // ── [role] S7-A — THE PREMISE, AND WITHOUT IT NOTHING BELOW MEANS ANYTHING ──
  // `acct_shared` carries THREE ACTIVE links: Alice's two (space_s, space_a) and
  // a co-owner's in space_b, which she is not a member of. If that third link
  // were ever visible to her — or ever stopped existing — every case below would
  // go green while proving nothing, because "the write landed on fewer rows than
  // exist" would have no rows left to miss.
  //
  // Asserted RELATIONALLY (visible < total) rather than as "2", so a future
  // fixture that adds a fourth Space cannot weaken it into a tautology; the one
  // hard-coded fact is the IDENTITY of the hidden row, which is the thing the
  // rest of the block is about.
  const sharedAll = psql(h.ownerUrl,
    `select coalesce(string_agg(id,',' order by id),'') from "SpaceAccountLink"
      where "financialAccountId"='acct_shared' and status='ACTIVE';`).out.trim();
  const sharedAlice = asTenant("alice",
    `select coalesce(string_agg(id,',' order by id),'') from "SpaceAccountLink"
      where "financialAccountId"='acct_shared' and status='ACTIVE';`);
  const allIds = sharedAll ? sharedAll.split(",") : [];
  const aliceIds = sharedAlice.out.trim() ? sharedAlice.out.trim().split(",") : [];
  const hiddenIds = allIds.filter((id) => !aliceIds.includes(id));
  check(55, "[role] THE PREMISE: acct_shared's ACTIVE links outnumber the ones Alice's role admits, and the co-owner's link is the one missing",
    allIds.length >= 3 && aliceIds.length < allIds.length && hiddenIds.includes("l_sh_bal"),
    `total=[${sharedAll}] aliceSees=[${sharedAlice.out.trim()}] hidden=[${hiddenIds.join(",")}]`);

  // ── [role] S7-D — THE AFFECTED-SPACE CAPTURE IS WIDER THAN THE ACTOR ───────
  // The capture is not bookkeeping: each Space in it gets its snapshot
  // regenerated, which is what makes a co-owner's net worth stop counting an
  // account that no longer syncs. Run on the actor's authority it would omit
  // space_b, and the co-owner's Space would narrate a balance for a dead account
  // for ever — with no error anywhere.
  const sysSpaces = psql(h.systemUrl,
    `select coalesce(string_agg(distinct "spaceId",',' order by "spaceId"),'') from "SpaceAccountLink"
      where "financialAccountId"='acct_shared' and status='ACTIVE';`).out.trim();
  const aliceSpaces = asTenant("alice",
    `select coalesce(string_agg(distinct "spaceId",',' order by "spaceId"),'') from "SpaceAccountLink"
      where "financialAccountId"='acct_shared' and status='ACTIVE';`).out.trim();
  check(56, "[role] the affected-Space capture on fm_system is a STRICT SUPERSET of the actor's and includes space_b — the Space whose snapshot must regenerate",
    sysSpaces === "space_a,space_b,space_s"
    && !aliceSpaces.split(",").includes("space_b")
    && aliceSpaces.split(",").every((s) => sysSpaces.split(",").includes(s)),
    `system=[${sysSpaces}] alice=[${aliceSpaces}]`);

  // ── [role] S7-B — THE SILENT PARTIAL, REPRODUCED ──────────────────────────
  // THE CENTREPIECE OF S7, and until now a claim rather than an observation. The
  // naive conversion of `disconnect.ts` issues exactly this statement on the
  // tenant role. It does not fail. It does not warn. It revokes two links of
  // three and returns a plausible number — and a zero at least looks like
  // nothing happened, where 1-of-2 looks exactly like success.
  const silentPartial = asTenant("alice", counting(
    `update "SpaceAccountLink" set status='REVOKED', "revokedAt"=now(), "revokedByUserId"='alice'
      where "financialAccountId"='acct_shared' and status='ACTIVE'`));
  const coOwnerAfter = psql(h.ownerUrl, `select status from "SpaceAccountLink" where id='l_sh_bal';`).out.trim();
  check(57, "[role] the tenant role's blanket revoke writes 2 links of 3, RAISES NOTHING, and leaves the co-owner's link ACTIVE — the silent partial is real",
    silentPartial.ok && silentPartial.out.trim() === String(aliceIds.length) && coOwnerAfter === "ACTIVE",
    `wrote=${silentPartial.out.trim()} expected=${aliceIds.length} coOwnerLink=${coOwnerAfter} err=${silentPartial.err.split("\n")[0] || "(none)"}`);

  // ── [role] S7-C — THE CAPABILITY, AND WHY IT IS THE ONLY HONEST AUTHORITY ──
  restoreFixtures();
  const wholeRevoke = psql(h.systemUrl, counting(
    `update "SpaceAccountLink" set status='REVOKED', "revokedAt"=now(), "revokedByUserId"='alice'
      where "financialAccountId"='acct_shared' and status='ACTIVE'`), false);
  const revokedRows = psql(h.ownerUrl,
    `select coalesce(string_agg(id || ':' || status || ':' || coalesce("revokedByUserId",'(null)'), ',' order by id),'(none)')
       from "SpaceAccountLink" where "financialAccountId"='acct_shared';`).out.trim();
  check(58, "[role] the SAME statement on fm_system writes every link in every Space and records the ACTOR as revoker — the blast radius is the operation's, the authorization is not",
    wholeRevoke.ok && wholeRevoke.out.trim() === String(allIds.length)
    && revokedRows === "l_sh:REVOKED:alice,l_sh2:REVOKED:alice,l_sh_bal:REVOKED:alice",
    `wrote=${wholeRevoke.out.trim()} expected=${allIds.length} rows=${revokedRows}`);

  // ── [role] S7-E — AUTHORIZATION IS NOT REDUNDANT WITH THE POLICY ───────────
  // `disconnectAccounts` re-proves ownership with `ownerUserId: actorUserId` ON
  // TOP of the policy, and the second half here is why that is not belt-and-
  // braces: `FinancialAccount.fm_app_sel` has an `OR fm_account_visible(id)` arm,
  // so Bob's role ADMITS the joint account he merely co-sees. Drop the
  // `ownerUserId` narrowing and a co-viewer could hand `acct_shared` to the
  // deployment-wide revoke.
  restoreFixtures();
  const bobOwns = asTenant("bob",
    `select coalesce(string_agg(id,','),'(none)') from "FinancialAccount" where id='acct_shared' and "ownerUserId"='bob';`);
  const bobSees = asTenant("bob",
    `select coalesce(string_agg(id,','),'(none)') from "FinancialAccount" where id='acct_shared';`);
  check(59, "[role] Bob's role SEES the joint account but owns none of it — the ownership narrowing in front of the capability is load-bearing, not redundant",
    bobOwns.out.trim() === "(none)" && bobSees.out.trim() === "acct_shared",
    `owned=${bobOwns.out.trim()} visible=${bobSees.out.trim()}`);

  // ── [role] S7-F — THE DISCONNECT'S ORDER, NARROWED BY THE OWNER ARM ───────
  //
  // ⚠️ RESTATED AT RLS-D1. WHAT THIS CASE USED TO ASSERT WAS A CONSEQUENCE OF A
  // DEFECT, NOT AN INVARIANT. It ran both orders as ALICE — the account's OWNER —
  // and asserted that links-before-connections closed ZERO connections. That held
  // only because the thirteen subtree policies said `fm_account_visible(...)` and
  // NOTHING ELSE, so archiving an account took its own owner's access with it.
  // `20261003000000_rls_account_subtree_owner_arm` adds the `ownerUserId` arm the
  // subtree's own root already had, and the owner now reaches her account's
  // connections whether a link exists or not: the old assertion's `0` became `1`.
  //
  // THE ORDERING HAZARD IS NARROWED, NOT ELIMINATED, and the restated case proves
  // exactly that — it is strictly stronger than the one it replaces, because it
  // pins the hazard AND its new boundary instead of one uniform outcome:
  //
  //   * A NON-OWNER CO-MEMBER acting on a shared account still has only
  //     `fm_account_visible` to stand on, and that arm is untouched. Bob co-sees
  //     `acct_shared` (ALICE's) through space_s and space_b. Revoking the links he
  //     can see leaves the account with one ACTIVE link in space_a he cannot see,
  //     so his very next statement is blinded: 0 rows, no error, a connection left
  //     open on an account the product has already soft-deleted. That is the
  //     failure mode `b42e8e0` ordered the phases against, and this is its FIFTH
  //     appearance in the programme. It is why the shipped order must stay.
  //   * THE SAME TWO STATEMENTS IN THE SAME ORDER AS THE OWNER DO NOT FAIL. The
  //     contrast is the point: the outcome now depends on the PRINCIPAL, and a
  //     reader of the source-scan ordering pins must not conclude the hazard is
  //     gone because their own dogfooding never reproduced it.
  //
  // ⚠️ THE NON-OWNER'S LINK COUNT IS A DENOMINATOR, NOT A LITERAL. `2` here is
  // "the ACTIVE links Bob's role admits", asserted to be NON-ZERO and FEWER than
  // exist — a `where` that matched nothing would also report 0 connections closed
  // and would read exactly like the refusal under test.
  restoreFixtures();
  const sharedActiveAll = psql(h.ownerUrl,
    `select coalesce(string_agg(id,',' order by id),'') from "SpaceAccountLink"
      where "financialAccountId"='acct_shared' and status='ACTIVE';`).out.trim();
  const sharedActiveBob = asTenant("bob",
    `select coalesce(string_agg(id,',' order by id),'') from "SpaceAccountLink"
      where "financialAccountId"='acct_shared' and status='ACTIVE';`).out.trim();
  const allActive = sharedActiveAll ? sharedActiveAll.split(",") : [];
  const bobActive = sharedActiveBob ? sharedActiveBob.split(",") : [];

  // (1) THE NON-OWNER, WRONG ORDER — the hazard, reproduced.
  const wrongOrder = psql(h.appUrl, `begin; set local app.user_id='bob';
    ${counting(`update "SpaceAccountLink" set status='REVOKED', "revokedAt"=now(), "revokedByUserId"='bob'
                 where "financialAccountId"='acct_shared' and status='ACTIVE'`)}
    ${counting(`update "AccountConnection" set "deletedAt"=now()
                 where "financialAccountId"='acct_shared' and "deletedAt" is null`)}
    commit;`, false);
  const sharedConnAfter = psql(h.ownerUrl,
    `select coalesce("deletedAt"::text,'(still open)') from "AccountConnection" where id='ac_shared';`).out.trim();

  // (2) THE NON-OWNER, SHIPPED ORDER — the identical statements, and it works.
  restoreFixtures();
  const rightOrder = psql(h.appUrl, `begin; set local app.user_id='bob';
    ${counting(`update "AccountConnection" set "deletedAt"=now()
                 where "financialAccountId"='acct_shared' and "deletedAt" is null`)}
    ${counting(`update "SpaceAccountLink" set status='REVOKED', "revokedAt"=now(), "revokedByUserId"='bob'
                 where "financialAccountId"='acct_shared' and status='ACTIVE'`)}
    commit;`, false);
  const sharedConnRight = psql(h.ownerUrl,
    `select coalesce("deletedAt"::text,'(still open)') from "AccountConnection" where id='ac_shared';`).out.trim();

  // (3) THE OWNER, WRONG ORDER — immune, and that is the new invariant.
  restoreFixtures();
  const ownerWrongOrder = psql(h.appUrl, `begin; set local app.user_id='alice';
    ${counting(`update "SpaceAccountLink" set status='REVOKED', "revokedAt"=now(), "revokedByUserId"='alice'
                 where "financialAccountId"='acct_shared' and status='ACTIVE'`)}
    ${counting(`update "AccountConnection" set "deletedAt"=now()
                 where "financialAccountId"='acct_shared' and "deletedAt" is null`)}
    commit;`, false);
  const sharedConnOwner = psql(h.ownerUrl,
    `select coalesce("deletedAt"::text,'(still open)') from "AccountConnection" where id='ac_shared';`).out.trim();

  const wrongLines = lines(wrongOrder), rightLines = lines(rightOrder), ownerLines = lines(ownerWrongOrder);
  check(60, "[role] links-before-connections STILL closes ZERO connections and raises NOTHING for a NON-OWNER co-member, while the OWNER passes the identical wrong order — the hazard is narrowed to the visibility arm, not removed",
    // the denominator: Bob's role admits some of acct_shared's ACTIVE links, and fewer than exist
    bobActive.length > 0 && bobActive.length < allActive.length
    && wrongOrder.ok && wrongLines[0] === String(bobActive.length) && wrongLines[1] === "0" && sharedConnAfter === "(still open)"
    && rightOrder.ok && rightLines[0] === "1" && rightLines[1] === String(bobActive.length) && sharedConnRight !== "(still open)"
    && ownerWrongOrder.ok && ownerLines[0] === String(aliceIds.length) && ownerLines[1] === "1" && sharedConnOwner !== "(still open)",
    `bobSees=[${sharedActiveBob}] of [${sharedActiveAll}] · bobWrong=[${wrongLines.join("|")}] conn=${sharedConnAfter}` +
    ` · bobRight=[${rightLines.join("|")}] conn=${sharedConnRight} · ownerWrong=[${ownerLines.join("|")}] conn=${sharedConnOwner}`);

  // ── [role] S7-G — AND THE RESTORE RUNS THE OTHER WAY, FOR THE SAME REASON ──
  //
  // ⚠️ RESTATED AT RLS-D1, FOR THE SAME REASON AS 60 AND IN THE SAME DIRECTION.
  // This case ran the restore as ALICE, who OWNS `acct_restore`, and asserted she
  // observed 0 and wrote 0 before the links came back. With the owner arm she
  // observes 1 and writes 1 — the old assertion's whole premise was the defect.
  //
  // The mirror image is still real and still the reason the two orders are
  // OPPOSITE rather than conventional: on the way back the links are what CONFER
  // the visibility, so a non-owner must have them reactivated FIRST. And the
  // un-delete attempted before that is the quietest failure in the slice — 0
  // observed, 0 written, no deficit, so not even the shortfall guard can fire,
  // and an account comes back with its connection permanently archived.
  //
  // THE CONTRAST IS SHARPER HERE THAN IN 60, because both principals issue the
  // IDENTICAL STATEMENT AGAINST THE IDENTICAL DATABASE STATE — links still
  // revoked, connection still soft-deleted — and get different answers. Nothing
  // about the statement, the account or the moment differs. Only who is asking.
  //
  // ⚠️ `l_restore_b` IS SEEDED HERE AND DELETED AT THE END. `acct_restore` is
  // reachable from space_a alone, which Bob is not a member of, so without a
  // REVOKED link of his own his `0 observed` would be the vacuity trap rather
  // than the hazard — indistinguishable from "this account does not exist".
  // Seeding it REVOKED (the post-archival shape) is what makes the links-first
  // leg below able to hand him the visibility the write needs.
  restoreFixtures();
  const seedRestoreB = psql(h.ownerUrl,
    `insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","revokedAt","revokedByUserId","updatedAt")
       values ('l_restore_b','space_b','acct_restore','SHARED','REVOKED','FULL',now(),'alice',now());`);
  if (!seedRestoreB.ok) throw new Error(`case 61 seed failed: ${seedRestoreB.err.split("\n")[0]}`);
  // The denominator: how many of this account's links a links-first phase has to
  // reactivate, counted from the owner connection before anybody is asked.
  const restoreRevoked = psql(h.ownerUrl,
    `select count(*) from "SpaceAccountLink" where "financialAccountId"='acct_restore' and status='REVOKED';`).out.trim();

  // (1) THE NON-OWNER, CONNECTION-FIRST — blind, silent, and not even short.
  const wrongRestore = psql(h.appUrl, `begin; set local app.user_id='bob';
    select count(*) from "AccountConnection" where "financialAccountId"='acct_restore' and "deletedAt" is not null;
    ${counting(`update "AccountConnection" set "deletedAt"=null
                 where "financialAccountId"='acct_restore' and "deletedAt" is not null`)}
    commit;`, false);
  const restoreConnMid = psql(h.ownerUrl,
    `select coalesce("deletedAt"::text,'(restored)') from "AccountConnection" where id='ac_restore';`).out.trim();

  // (2) THE OWNER, SAME STATEMENT, SAME STATE — observes it and writes it.
  const ownerRestore = psql(h.appUrl, `begin; set local app.user_id='alice';
    select count(*) from "AccountConnection" where "financialAccountId"='acct_restore' and "deletedAt" is not null;
    ${counting(`update "AccountConnection" set "deletedAt"=null
                 where "financialAccountId"='acct_restore' and "deletedAt" is not null`)}
    commit;`, false);
  const restoreConnOwner = psql(h.ownerUrl,
    `select coalesce("deletedAt"::text,'(restored)') from "AccountConnection" where id='ac_restore';`).out.trim();

  // (3) RE-ARCHIVE, THEN THE SHIPPED ORDER FOR THE NON-OWNER: links first.
  psql(h.ownerUrl, `update "AccountConnection" set "deletedAt"=now() where id='ac_restore';`);
  const reactivateLinks = psql(h.systemUrl, counting(
    `update "SpaceAccountLink" set status='ACTIVE', "revokedAt"=null, "revokedByUserId"=null
      where "financialAccountId"='acct_restore' and status='REVOKED'`), false);
  const rightRestore = psql(h.appUrl, `begin; set local app.user_id='bob';
    ${counting(`update "AccountConnection" set "deletedAt"=null
                 where "financialAccountId"='acct_restore' and "deletedAt" is not null`)}
    commit;`, false);
  const restoreConnEnd = psql(h.ownerUrl,
    `select coalesce("deletedAt"::text,'(restored)') from "AccountConnection" where id='ac_restore';`).out.trim();
  const wr = lines(wrongRestore), owr = lines(ownerRestore);
  check(61, "[role] un-deleting the connection BEFORE reactivating the links observes 0 and writes 0 for a NON-OWNER — so even the shortfall guard cannot fire; the OWNER's identical statement against the identical state writes 1, and links-first gives the non-owner the same 1",
    Number(restoreRevoked) >= 2
    && wrongRestore.ok && wr[0] === "0" && wr[1] === "0" && restoreConnMid !== "(restored)"
    && ownerRestore.ok && owr[0] === "1" && owr[1] === "1" && restoreConnOwner === "(restored)"
    && reactivateLinks.ok && reactivateLinks.out.trim() === restoreRevoked
    && rightRestore.ok && rightRestore.out.trim() === "1" && restoreConnEnd === "(restored)",
    `revokedLinks=${restoreRevoked} · bobConnFirst=[${wr.join("|")}] conn=${restoreConnMid}` +
    ` · ownerConnFirst=[${owr.join("|")}] conn=${restoreConnOwner}` +
    ` · reactivated=${reactivateLinks.out.trim()} bobLinksFirst=${rightRestore.out.trim()} end=${restoreConnEnd}`);
  // Seeded here, removed here: `restoreFixtures()` restores BY ID and knows
  // nothing about this row, so leaving it ACTIVE would silently hand Bob
  // `acct_restore`'s whole subtree in every case after this one.
  psql(h.ownerUrl, `delete from "SpaceAccountLink" where id='l_restore_b';`);

  // ── [channel] S7-I — AND THIS HALF FAILS LOUD, WHICH IS WHY IT IS fm_system ─
  // Phase 3 regenerates a snapshot per affected Space, and the list includes
  // Spaces the actor is not in. `SpaceSnapshot`'s tenant INSERT policy is
  // `"spaceId" IN (SELECT fm_visible_space_ids())`, so the write for space_b is
  // refused by WITH CHECK and RAISES — the one place in this slice where the
  // wrong authority would have been noisy rather than silent. That asymmetry is
  // the whole reason `regenerate.ts` defaults to `systemDb` instead of being
  // "fixed" by narrowing the Space list to the actor's.
  let snapWrite = "no error";
  try {
    await tenant.withTenantDb("alice", (tx) => tx.spaceSnapshot.upsert({
      where:  { spaceId_date: { spaceId: "space_b", date: new Date(today) } },
      update: { netWorth: 1 },
      create: { spaceId: "space_b", date: new Date(today), netWorth: 1 },
    }));
  } catch (e) { snapWrite = e instanceof Error ? e.message : String(e); }
  const snapRows = psql(h.ownerUrl, `select count(*) from "SpaceSnapshot" where "spaceId"='space_b';`).out.trim();
  check(62, "[channel] a snapshot for a co-owner's Space is REFUSED LOUDLY on the tenant role — the half of the disconnect that cannot be silent",
    /row-level security/i.test(snapWrite) && snapRows === "0",
    `err=${snapWrite.split("\n")[0]} rows=${snapRows}`);

  // ── [role] S7-H — THE PERMANENT DELETE NEEDS NO CAPABILITY ────────────────
  // The claim S7 made without proving it: the permanent-delete route stayed
  // entirely on the tenant role, because the links it must remove go with the
  // account through the FK's ON DELETE CASCADE — and referential actions are
  // performed by the system, NOT filtered by the policy that hid the row from
  // the deleting role. So the statement the role can only half-perform is
  // followed by one that finishes the job completely.
  //
  // ⚠️ THIS CASE USED TO DESTROY acct_shared, AND ORDERING WAS THE MITIGATION.
  // Its own comment read "it is last in the S7 block for that reason, and
  // nothing after it refers to that account" — true when written, and cases
  // 73-80 then landed after it. Worse, `restoreFixtures()` could not undo it:
  // its `set "deletedAt"=null where id in (…)` matched ZERO rows, psql reported
  // ok, and every later premise about acct_shared was quietly false. (That hole
  // is now closed separately — restoreFixtures verifies presence and refuses.)
  //
  // "Nothing after it refers to X" is a claim about a file that grows. So the
  // case now seeds and destroys its OWN account, and the ordering constraint
  // disappears rather than being re-documented.
  restoreFixtures();
  const seedCascade = psql(h.ownerUrl, `
    insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt")
      values ('acct_cascade','Cascade Probe','checking','TestBank','USER','alice',now());
    insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt")
      values ('l_casc_a','space_a','acct_cascade','HOME','ACTIVE','FULL',now()),
             ('l_casc_s','space_s','acct_cascade','SHARED','ACTIVE','FULL',now()),
             ('l_casc_b','space_b','acct_cascade','SHARED','ACTIVE','BALANCE_ONLY',now());`);
  if (!seedCascade.ok) throw new Error(`case 63 seed failed: ${seedCascade.err.split("\n")[0]}`);

  // The denominator: three links exist, and alice can see exactly two of them —
  // `l_casc_b` is in space_b, which she is not a member of. Without this the
  // "2" below could mean "the policy worked" or "only two were ever seeded".
  const cascSeeded = psql(h.ownerUrl,
    `select count(*) from "SpaceAccountLink" where "financialAccountId"='acct_cascade';`).out.trim();
  const delLinks = asTenant("alice", counting(`delete from "SpaceAccountLink" where "financialAccountId"='acct_cascade'`));
  const survivingLink = psql(h.ownerUrl,
    `select coalesce(string_agg(id,',' order by id),'(none)') from "SpaceAccountLink" where "financialAccountId"='acct_cascade';`).out.trim();
  const delAccount = asTenant("alice", counting(`delete from "FinancialAccount" where id='acct_cascade'`));
  const afterCascade = psql(h.ownerUrl,
    `select coalesce(string_agg(id,',' order by id),'(none)') from "SpaceAccountLink" where "financialAccountId"='acct_cascade';`).out.trim();
  check(63, "[role] the tenant DELETE leaves the co-owner's link behind, and the account DELETE takes it anyway — ON DELETE CASCADE is not filtered by RLS, so no capability was needed",
    cascSeeded === "3"
    && delLinks.ok && delLinks.out.trim() === "2" && survivingLink === "l_casc_b"
    && delAccount.ok && delAccount.out.trim() === "1" && afterCascade === "(none)",
    `seeded=${cascSeeded} links=${delLinks.out.trim()} survivor=${survivingLink} account=${delAccount.out.trim()} after=${afterCascade}`);

  // ══ S8 — THE INVESTMENTS AND IMPORTS SPINE ═════════════════════════════════

  // ── [role] S8 — THE DENOMINATOR FOR EVERY ABSENCE BELOW ───────────────────
  // Cases 65, 67 and 70 are absence claims on the import spine; case 66's whole
  // point is a row that is PRESENT and unreachable. Over an empty fixture set all
  // four pass and none of them means anything, so the population is asserted from
  // the owner connection first — including the un-supersession pointer, which is
  // the single most destructive silent failure S8 found.
  const s8Census = psql(h.ownerUrl, `
    select (select count(*) from "ImportBatch" where id='ib_bob')::text || '|' ||
           (select count(*) from "InvestmentEvent" where "importBatchId"='ib_m' and "deletedAt" is null)::text || '|' ||
           (select count(*) from "InvestmentEvent" where "importBatchId"='ib_n' and "deletedAt" is null)::text || '|' ||
           (select count(*) from "PositionObservation" where "importBatchId"='ib_n' and "deletedAt" is null)::text || '|' ||
           (select coalesce("supersededById",'(null)') from "PositionObservation" where id='po_n_open') || '|' ||
           (select count(*) from "AccountConnection" where "financialAccountId"='acct_alice_inv')::text;`).out.trim();
  // ⚠️ THE LAST FIELD'S PROSE WAS CORRECTED AT RLS-D1 AND ITS ASSERTION WAS NOT.
  // It used to read "an unreachable investment connection", which stopped being
  // true of the owner when the subtree gained its `ownerUserId` arm. The census
  // only ever counted that the row EXISTS — which is what case 70 needs of it —
  // so the figure is untouched and only the sentence describing it moved.
  check(64, "[role] the import fixtures EXIST: Bob's batch, two live events, a USER_ASSERTED opening genuinely superseded, and an investment connection linked ONLY into a Space Alice is not a member of",
    s8Census === "1|2|1|1|po_n_batch|1", s8Census);

  // ── [channel] S8-J — THE ROUTE'S 404 IS THE DATABASE'S ANSWER ─────────────
  // The rollback route's phase 1 is `findUnique` by batch id plus a membership
  // check. Under the tenant role the lookup ITSELF returns nothing for another
  // tenant's batch (`ImportBatch.fm_app_sel` is
  // `fm_account_visible("financialAccountId")`), so the 404 no longer depends on
  // the check that follows it being correct. Paired with the positive read, so
  // "null" cannot be the harness failing to find anything at all.
  const bobBatchAsAlice = await tenant.withTenantDb("alice", (tx) => tx.importBatch.findUnique({ where: { id: "ib_bob" } }));
  const bobBatchAsBob   = await tenant.withTenantDb("bob",   (tx) => tx.importBatch.findUnique({ where: { id: "ib_bob" } }));
  check(65, "[channel] Bob's import batch is NULL to Alice's tenant client and present to his own — the route's 404 comes from the policy, not from the check after it",
    bobBatchAsAlice === null && bobBatchAsBob?.id === "ib_bob",
    `alice=${JSON.stringify(bobBatchAsAlice)} bob=${bobBatchAsBob?.id}`);

  // ── [channel] S8-K — THE RESIDUAL S8 RECORDED, MADE CONCRETE ──────────────
  // The rollback's Transaction soft-delete is keyed on `importBatchId` ONLY,
  // never `financialAccountId`, because a merge re-points a transaction's account
  // without touching its batch. The POLICY, however, is keyed on exactly the
  // column the statement does not mention. So a relocated row is absent from the
  // observation AND from the write, the two agree, no shortfall exists to raise,
  // and the batch is reported fully rolled back with a live row still in it.
  //
  // THE GUARD IS WORKING CORRECTLY HERE. That is the finding: comparing a write
  // to what the same authority observed cannot detect a row that authority never
  // saw, and S8 named the reconciliation as a follow-up rather than assuming it
  // away. This case is what makes that residual a measured fact.
  //
  // ⚠️ THE THREE ROWS ARE SEEDED HERE, NOT IN APP_FIXTURES. Cases 4 and 13 pin
  // Alice's unfiltered transaction count at 4 and Bob's at 2; seeding them with
  // the rest would have moved those numbers and silently relaxed the backstop.
  const kSeed = psql(h.ownerUrl, `
    insert into "Transaction" (id,"financialAccountId",date,"economicDate",merchant,category,amount,"importBatchId","updatedAt") values
      ('tx_k1','acct_alice',current_date,current_date,'Import A','Other',-1,'ib_k',now()),
      ('tx_k2','acct_alice',current_date,current_date,'Import B','Other',-2,'ib_k',now()),
      ('tx_k3','acct_bob',  current_date,current_date,'Import C','Other',-3,'ib_k',now());`);
  if (!kSeed.ok) throw new Error(`case 66 fixture failed: ${kSeed.err.split("\n")[0]}`);
  const residual = await tenant.withTenantDb("alice", async (tx) => {
    const eligible = await tx.transaction.count({ where: { importBatchId: "ib_k", deletedAt: null } });
    const soft = await tx.transaction.updateMany({ where: { importBatchId: "ib_k", deletedAt: null }, data: { deletedAt: new Date() } });
    let raised: string | null = null;
    try {
      cas.assertEveryObservedRowWasWritten(
        { table: "Transaction", operation: "update", scope: "one import batch's live rows" },
        eligible, soft.count);
    } catch (e) { raised = e instanceof Error ? e.name : String(e); }
    return { eligible, written: soft.count, raised };
  });
  const kState = psql(h.ownerUrl,
    `select count(*)::text || '|' || count(*) filter (where "deletedAt" is null)::text || '|' ||
            coalesce(string_agg(id,',' order by id) filter (where "deletedAt" is null),'(none)')
       from "Transaction" where "importBatchId"='ib_k';`).out.trim();
  check(66, "[channel] a merge-relocated row is invisible to BOTH the observation and the write, so the counts agree, NOTHING is raised, and the batch keeps a live row — the residual is real",
    residual.eligible === 2 && residual.written === 2 && residual.raised === null && kState === "3|1|tx_k3",
    `observed=${residual.eligible} written=${residual.written} raised=${residual.raised ?? "(nothing)"} batch=${kState}`);

  // ── [service] S8-L — THE GUARD MUST NOT FIRE ON INVISIBILITY ALONE ────────
  // Bob rolling back Alice's batch observes zero eligible rows and writes zero,
  // and that is CORRECT and must stay silent: nothing was eligible, so there is
  // no deficit. Without this half, case 68 would be satisfied by a guard that
  // raised whenever a tenant could not see something — which would turn every
  // ordinary no-op into an incident. The real service function, on the real role.
  const rb = await import("@/lib/investments/investment-import-rollback");
  let bobRollsAlice: Awaited<ReturnType<typeof rb.rollbackInvestmentBatchRows>> | string;
  try {
    bobRollsAlice = await tenant.withTenantDb("bob", (tx) => rb.rollbackInvestmentBatchRows(tx, "ib_m", new Date()));
  } catch (e) { bobRollsAlice = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
  const mUntouched = psql(h.ownerUrl,
    `select count(*) from "InvestmentEvent" where "importBatchId"='ib_m' and "deletedAt" is null;`).out.trim();
  check(67, "[service] rollbackInvestmentBatchRows under a tenant who cannot see the batch observes 0, writes 0 and stays SILENT — the guard does not fire on invisibility alone",
    typeof bobRollsAlice !== "string" && bobRollsAlice.eventsDeleted === 0
    && bobRollsAlice.observationsDeleted === 0 && bobRollsAlice.pointersCleared === 0
    && mUntouched === "2",
    `result=${JSON.stringify(bobRollsAlice)} liveEvents=${mUntouched}`);

  // ── [service] S8-M — AND IT MUST FIRE ON A REAL SHORTFALL ─────────────────
  // The counterpart, and the reason the observation is the guard rather than an
  // optimisation: a row observed as eligible that the write does not reach. The
  // concurrent delete is committed by a SECOND connection between the observation
  // and the statement — which READ COMMITTED lets the statement see — so the
  // shortfall is produced the way production would produce it, on a real fm_app
  // transaction rather than by a fake client returning a smaller number.
  //
  // The hook wraps ONLY the timing. Every statement still goes to the real tenant
  // transaction, through the real policies.
  let concurrentDeleteLanded = false;
  let partialErr: unknown = null;
  try {
    await tenant.withTenantDb("alice", async (tx) => {
      const hooked = {
        investmentEvent: {
          findMany:   (a: never) => tx.investmentEvent.findMany(a),
          count:      (a: never) => tx.investmentEvent.count(a),
          updateMany: async (a: never) => {
            if (!concurrentDeleteLanded) {
              concurrentDeleteLanded = true;
              const gone = psql(h.ownerUrl, `delete from "InvestmentEvent" where id='ie_m2';`);
              if (!gone.ok) throw new Error(`out-of-band delete failed: ${gone.err.split("\n")[0]}`);
            }
            return tx.investmentEvent.updateMany(a);
          },
        },
        positionObservation: {
          findMany:   (a: never) => tx.positionObservation.findMany(a),
          count:      (a: never) => tx.positionObservation.count(a),
          updateMany: (a: never) => tx.positionObservation.updateMany(a),
        },
      };
      return rb.rollbackInvestmentBatchRows(hooked as never, "ib_m", new Date());
    }, { timeout: 30_000 });
  } catch (e) { partialErr = e; }
  const mAfterPartial = psql(h.ownerUrl,
    `select count(*) filter (where "deletedAt" is null)::text from "InvestmentEvent" where "importBatchId"='ib_m';`).out.trim();
  const partial = partialErr instanceof cas.PartialBulkWriteError ? partialErr : null;
  check(68, "[service] a row deleted between the observation and the write raises PartialBulkWriteError (observed 2, written 1) on a REAL fm_app transaction, and the phase rolls back",
    concurrentDeleteLanded && partial !== null && partial.observed === 2 && partial.written === 1
    && partial.table === "InvestmentEvent" && mAfterPartial === "1",
    `concurrentDeleteLanded=${concurrentDeleteLanded} err=${partialErr instanceof Error ? partialErr.name : String(partialErr)} observed=${partial?.observed} written=${partial?.written} liveAfter=${mAfterPartial}`);

  // ── [service] S8-N — THE UN-SUPERSESSION, WHICH FAILS WORST OF THE FOUR ───
  // A refused un-supersession leaves a user's own stated opening permanently
  // outranked by imported evidence that no longer exists, and reports "0 pointers
  // cleared" — which reads as "none needed it". So the positive path is pinned on
  // the real role: the opening comes back, and the count the user is shown is the
  // number of rows that actually moved.
  let nResult: Awaited<ReturnType<typeof rb.rollbackInvestmentBatchRows>> | string;
  try {
    nResult = await tenant.withTenantDb("alice", (tx) => rb.rollbackInvestmentBatchRows(tx, "ib_n", new Date()));
  } catch (e) { nResult = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
  const openingAfter = psql(h.ownerUrl,
    `select coalesce("supersededById",'(null)') || '|' || coalesce("deletedAt"::text,'(live)')
       from "PositionObservation" where id='po_n_open';`).out.trim();
  check(69, "[service] rolling back the batch RETURNS the USER_ASSERTED opening it had outranked — pointer cleared, row still live, and the reported count is the one that moved",
    typeof nResult !== "string" && nResult.pointersCleared === 1
    && nResult.eventsDeleted === 1 && nResult.observationsDeleted === 1
    && openingAfter === "(null)|(live)",
    `result=${JSON.stringify(nResult)} opening=${openingAfter}`);

  // ── [service] S8-O — OWNERSHIP IS REACH INTO ONE'S OWN SUBTREE, AND ONLY IT ─
  //
  // ⚠️ RESTATED AT RLS-D1, AND THIS ONE INVERTS. Its title was "ownership is not
  // reach", and that was never an invariant — it was the defect, stated as a
  // property. `acct_alice_inv` is ALICE's investment account whose only ACTIVE
  // link is in space_b; her role could see the ACCOUNT (because
  // `FinancialAccount.fm_app_sel` always had an `ownerUserId` arm) and NONE of its
  // contents, so the import picker offered her nothing for her own brokerage. The
  // owner arm makes the subtree agree with its own root, and the claim reverses.
  //
  // IT MUST NOT INVERT INTO A HOLE, which is what the second half is for. The new
  // invariant is TWO-SIDED and the case asserts both halves against the SAME ROW
  // at the SAME MOMENT:
  //
  //   ALICE DOES   reach `ac_alice_inv` and the account's subtree with NO ACTIVE
  //                link anywhere — the archival shape, which is every merge loser.
  //   BOB STILL    DOES NOT. He is not the owner, so once the link he co-saw is
  //                revoked his only arm is `fm_account_visible`, which is
  //                untouched by the migration and now false.
  //
  // ⚠️ AND THE DENOMINATOR IS MEASURED, NOT ASSUMED. Bob's `null` after the revoke
  // is worthless unless he could reach the row BEFORE it — otherwise "the policy
  // refused him" and "the harness is looking at nothing" are the same observation.
  // So both principals are read with `l_inv_b` ACTIVE first, and both find it.
  const imports = await import("@/lib/investments/connection-import-accounts");
  const reachConn = (u: string) => tenant.withTenantDb(u, (tx) =>
    tx.accountConnection.findUnique({ where: { id: "ac_alice_inv" }, select: { id: true } }));

  // (1) THE DENOMINATOR — linked into space_b, BOTH principals reach the row.
  restoreFixtures();
  const linkedAlice = await reachConn("alice");
  const linkedBob   = await reachConn("bob");

  // (2) ARCHIVE THE SHAPE — revoke the account's ONLY ACTIVE link, exactly as
  //     `revokeAccountLinksEverywhere` does. Nobody reaches it by visibility now.
  const revokeInv = psql(h.ownerUrl,
    `update "SpaceAccountLink" set status='REVOKED', "revokedAt"=now(), "revokedByUserId"='alice' where id='l_inv_b';`);
  if (!revokeInv.ok) throw new Error(`case 70 could not archive l_inv_b: ${revokeInv.err.split("\n")[0]}`);
  const archivedAlice = await reachConn("alice");
  const archivedBob   = await reachConn("bob");

  // (3) THE SUBTREE PROPER, not just `AccountConnection` — a Holding under the
  //     same account, seeded here and removed below. This is the generalisation:
  //     the arm was applied to thirteen tables, not to the one this case reads.
  const seedInvHolding = psql(h.ownerUrl,
    `insert into "Holding" (id,"financialAccountId",symbol,name,quantity,price,value,"updatedAt")
       values ('h_inv_probe','acct_alice_inv','ZZZ','Zed',1,1,1,now());`);
  if (!seedInvHolding.ok) throw new Error(`case 70 seed failed: ${seedInvHolding.err.split("\n")[0]}`);
  const invHoldAlice = asTenant("alice", `select count(*) from "Holding" where "financialAccountId"='acct_alice_inv';`).out.trim();
  const invHoldBob   = asTenant("bob",   `select count(*) from "Holding" where "financialAccountId"='acct_alice_inv';`).out.trim();
  psql(h.ownerUrl, `delete from "Holding" where id='h_inv_probe';`);

  // (4) AND THROUGH THE REAL SERVICE. `getImportableAccountsForConnection` has no
  //     membership check of its own — it filters on the `userId` it is handed —
  //     so Bob's leg deliberately passes ALICE's id: the refusal has to come from
  //     the database, not from a parameter he controls.
  const viaTenant = await tenant.withTenantDb("alice", (tx) =>
    imports.getImportableAccountsForConnection(tx, { connectionId: "pi_alice", userId: "alice" }));
  const viaBob = await tenant.withTenantDb("bob", (tx) =>
    imports.getImportableAccountsForConnection(tx, { connectionId: "pi_alice", userId: "alice" }));
  const viaOwner = await imports.getImportableAccountsForConnection(
    dbMod.db as never, { connectionId: "pi_alice", userId: "alice" });
  const ownsItAnyway = await tenant.withTenantDb("alice", (tx) =>
    tx.financialAccount.findUnique({ where: { id: "acct_alice_inv" }, select: { id: true } }));
  restoreFixtures();

  check(70, "[service] an investment account Alice OWNS with NO ACTIVE link anywhere is reachable BY HER through the real import picker and its whole subtree, and is reachable by Bob only while the link he co-saw is ACTIVE — the owner arm widened to the owner and to nobody else",
    // the denominator: with the link ACTIVE both principals find the row
    linkedAlice?.id === "ac_alice_inv" && linkedBob?.id === "ac_alice_inv"
    // archived: the owner keeps it, the co-member loses it
    && archivedAlice?.id === "ac_alice_inv" && archivedBob === null
    // and the same split holds on another of the thirteen subtree tables
    && invHoldAlice === "1" && invHoldBob === "0"
    // through the real service, with the owner connection as the population
    && viaTenant.length === 1 && viaTenant[0].id === "acct_alice_inv"
    && viaBob.length === 0
    && viaOwner.length === 1 && viaOwner[0].id === "acct_alice_inv"
    && ownsItAnyway?.id === "acct_alice_inv",
    `linked alice=${linkedAlice?.id ?? "null"} bob=${linkedBob?.id ?? "null"}` +
    ` · archived alice=${archivedAlice?.id ?? "null"} bob=${archivedBob === null ? "null" : archivedBob.id}` +
    ` · subtreeHoldings alice=${invHoldAlice} bob=${invHoldBob}` +
    ` · picker tenant=${JSON.stringify(viaTenant.map((a) => a.id))} bob=${JSON.stringify(viaBob.map((a) => a.id))}` +
    ` owner=${JSON.stringify(viaOwner.map((a) => a.id))} accountRow=${ownsItAnyway?.id}`);

  // ── [channel] S8-P — ATOMICITY, ON A REAL TRANSACTION RATHER THAN A JOURNAL ─
  // `syncCurrentHoldings` is a three-legged reconciliation — delete stale, update
  // in place, insert new — whose atomicity S8 records as LOAD-BEARING: two of
  // three applied is a projection that states positions the account does not
  // hold. `lib/investments/atomicity-under-phase.test.ts` proves the branch with a
  // fake client; this proves the OUTCOME against Postgres.
  //
  // The failure is produced by the policy itself, which is the sharpest form
  // available: a second connection revokes the account's visible links between
  // the UPDATE leg and the INSERT leg, so `fm_account_visible` turns false and
  // WITH CHECK refuses the insert. Under READ COMMITTED the statement
  // re-evaluates the predicate and sees the revocation, exactly as a concurrent
  // disconnect would cause it.
  //
  // ⚠️ RESTATED AT RLS-D1 — THE FORCING MECHANISM WAS THE DEFECT, THE PROPERTY
  // WAS NOT. This case revoked `l_a` mid-write while running as ALICE, who OWNS
  // `acct_alice`. The owner arm admits the row regardless of links, so there is
  // no refusal left to force that way: the run now COMPLETES and all three legs
  // apply. Nothing about atomicity changed — only the one lever this case used
  // to pull. Relaxing it to "it did not throw" would have deleted the property.
  //
  // So the refusal is now forced by a principal who GENUINELY CANNOT PASS THE
  // PREDICATE: BOB, on `acct_shared`, which ALICE owns and he merely co-sees
  // through space_s and space_b. Revoking those links leaves one ACTIVE link in
  // space_a that he is not a member of, and he owns nothing — both arms false,
  // WITH CHECK refuses, and all three legs must come back.
  //
  // BOTH PRINCIPALS RUN, and the owner leg is not decoration: it is the positive
  // control that proves the hooked client, the payload and the three legs are all
  // REAL — a refusal case alone cannot tell "the write was refused" from "there
  // was no write to refuse". Owner: 3 legs applied. Non-owner: 3 legs undone.
  //
  // ⚠️ A DUPLICATE-SYMBOL PAYLOAD CANNOT PRODUCE THIS. `planHoldingSync` dedupes
  // on symbol by design (`conflicts`, "keep first"), and `@@unique([financialAccountId,
  // symbol])` is keyed on the same column the policy is, so no row the policy hides
  // can collide with one it admits. The forcing mechanism had to be the policy.
  restoreFixtures();
  const sch = await import("@/lib/investments/sync-current-holdings");
  const security = (id: string, ticker: string) => ({
    security_id: id, ticker_symbol: ticker, name: `${ticker} Inc`, type: "equity",
    close_price: 10, iso_currency_code: "USD",
  });
  /**
   * One run of the three-legged reconciliation under `userId`, with the account's
   * links revoked out of band between the UPDATE leg and the INSERT leg.
   * AAA changes (update leg) · BBB and CCC are absent (delete leg) · NEW is added
   * (insert leg, the one whose admission the principal decides).
   */
  const syncUnderRevoke = async (userId: string, accountId: string, revokeSql: string) => {
    let revoked = false;
    let err = "no error";
    try {
      await tenant.withTenantDb(userId, async (tx) => {
        const hooked = {
          holding: {
            findMany:   (a: never) => tx.holding.findMany(a),
            deleteMany: (a: never) => tx.holding.deleteMany(a),
            update:     (a: never) => tx.holding.update(a),
            createMany: async (a: never) => {
              if (!revoked) {
                revoked = true;
                const r = psql(h.ownerUrl, revokeSql);
                if (!r.ok) throw new Error(`out-of-band revoke failed: ${r.err.split("\n")[0]}`);
              }
              return tx.holding.createMany(a);
            },
          },
        };
        return sch.syncCurrentHoldings(hooked as never, {
          financialAccountId: accountId,
          plaidHoldings: [
            { account_id: "ext", security_id: "s_aaa", quantity: 9, institution_price: 10, institution_value: 90, iso_currency_code: "USD" },
            { account_id: "ext", security_id: "s_new", quantity: 4, institution_price: 5,  institution_value: 20, iso_currency_code: "USD" },
          ] as never,
          securitiesById: { s_aaa: security("s_aaa", "AAA"), s_new: security("s_new", "NEW") } as never,
          accountCurrency: "USD",
          payloadComplete: true,
        });
      }, { timeout: 30_000 });
    } catch (e) { err = e instanceof Error ? e.message : String(e); }
    return { revoked, err };
  };
  const holdingsOf = (accountId: string) => psql(h.ownerUrl,
    `select coalesce(string_agg(symbol || ':' || quantity::text, ',' order by symbol),'(none)')
       from "Holding" where "financialAccountId"='${accountId}';`).out.trim();

  // (1) THE OWNER — the same mid-write revoke, and the arm carries her through.
  const ownerSync = await syncUnderRevoke("alice", "acct_alice", `update "SpaceAccountLink" set status='REVOKED' where id='l_a';`);
  const ownerHoldings = holdingsOf("acct_alice");
  psql(h.ownerUrl, `update "SpaceAccountLink" set status='ACTIVE', "revokedAt"=null, "revokedByUserId"=null where id='l_a';`);

  // (2) THE NON-OWNER — seeded here, removed below, on ALICE's joint account.
  //     Three live rows so every leg has real work: without the stale pair the
  //     rollback claim would be vacuous, with nothing for the refusal to undo.
  restoreFixtures();
  const seedShared = psql(h.ownerUrl,
    `insert into "Holding" (id,"financialAccountId",symbol,name,quantity,price,value,"updatedAt") values
       ('h_s_aaa','acct_shared','AAA','Alpha',1,10,10,now()),
       ('h_s_bbb','acct_shared','BBB','Beta', 2,20,40,now()),
       ('h_s_ccc','acct_shared','CCC','Gamma',3,30,90,now());`);
  if (!seedShared.ok) throw new Error(`case 71 seed failed: ${seedShared.err.split("\n")[0]}`);
  // The denominator, read as BOB: the plan is computed from what HIS role sees,
  // so a blinded pre-read would make a no-op look like a rollback.
  const bobSeesHoldings = asTenant("bob", `select count(*) from "Holding" where "financialAccountId"='acct_shared';`).out.trim();
  const nonOwnerSync = await syncUnderRevoke("bob", "acct_shared",
    `update "SpaceAccountLink" set status='REVOKED' where "financialAccountId"='acct_shared' and status='ACTIVE';`);
  const nonOwnerHoldings = holdingsOf("acct_shared");
  psql(h.ownerUrl, `delete from "Holding" where "financialAccountId"='acct_shared';`);
  restoreFixtures();

  check(71, "[channel] a reconciliation whose INSERT leg is refused mid-write rolls back its DELETE and UPDATE legs too — all three legs or none; the refusal is forced by a NON-OWNER, because the OWNER's identical run is now admitted and applies all three",
    // the owner leg: no refusal, and all three legs landed
    ownerSync.revoked && ownerSync.err === "no error" && ownerHoldings === "AAA:9,NEW:4"
    // the denominator for the non-owner leg: Bob's role genuinely sees all three
    && bobSeesHoldings === "3"
    // the non-owner leg: refused by the policy, and NOTHING moved
    && nonOwnerSync.revoked && /row-level security/i.test(nonOwnerSync.err)
    && nonOwnerHoldings === "AAA:1,BBB:2,CCC:3",
    `owner revoked=${ownerSync.revoked} err=${ownerSync.err.split("\n")[0]} holdings=${ownerHoldings}` +
    ` · nonOwner sawRows=${bobSeesHoldings} revoked=${nonOwnerSync.revoked}` +
    ` err=${nonOwnerSync.err.split("\n").find((l) => /row-level security/i.test(l))?.trim() ?? nonOwnerSync.err.split("\n")[0]}` +
    ` holdings=${nonOwnerHoldings}`);

  // ── [channel] S8 — THE IDLE-IN-TRANSACTION PROBE, AND WHAT IT DOES NOT PROVE ─
  // The owner asked for a real-role version of the provider-boundary pin: run a
  // spine operation against a STUB provider and, while the call is in flight,
  // assert `pg_stat_activity` shows no fm_app backend idle in transaction.
  //
  // THAT CASE IS NOT WRITABLE HONESTLY HERE, and it is not written. Neither
  // provider entry point has an injectable seam — `syncInvestmentsForItem`
  // references the module-level `plaidClient` directly and
  // `ingestInvestmentEvents` reaches it through a dynamic `import()` — so
  // stubbing one would mean either adding a seam to production code to satisfy a
  // test, or adding module-mocking machinery this harness does not have. Both are
  // the "force it" the brief forbids. `lib/investments/transaction-boundary.test.ts`
  // remains the pin for that property.
  //
  // WHAT IS HONEST, AND IS LANDED, IS THE PROBE ITSELF — with its denominator,
  // which is the part a future provider-stub case would otherwise be unable to
  // establish. A probe that reads 0 because it cannot see fm_app backends at all
  // would approve anything; this one is shown reading a HELD phase first.
  let heldDuringPhase = "unread";
  const idleProbe = `select count(*) from pg_stat_activity
                      where state='idle in transaction' and usename='fm_app';`;
  await tenant.withTenantDb("alice", async (tx) => {
    await tx.transaction.count();
    heldDuringPhase = psql(h.ownerUrl, idleProbe).out.trim();
  }, { timeout: 30_000 });
  const idleAfterPhase = psql(h.ownerUrl, idleProbe).out.trim();
  check(72, "[channel] the idle-in-transaction probe SEES a held tenant phase (>=1) and reads 0 once it commits — the denominator a provider-boundary case would need",
    Number(heldDuringPhase) >= 1 && idleAfterPhase === "0",
    `duringHeldPhase=${heldDuringPhase} afterCommit=${idleAfterPhase}`);


  // ══════════════════════════════════════════════════════════════════════════
  // RLS-ACC-FK — ACCOUNT-FK RE-PARENTING, ON A REAL fm_app ROLE
  //
  // THE GATING SLICE FOR THE OWNER-ARM POLICY CHANGE. Case 74 proves the
  // database PERMITS a cross-owner re-parenting today, which is why the refusal
  // has to be the application's; cases 75–77 prove the application now refuses
  // it; case 78 is the denominator that stops 75–77 passing over a helper that
  // refuses everything; case 79 covers the UNSCOPED-SOURCE class, where the
  // destination is fine and the row was located by a tenant-wide unique key.
  //
  // ⚠️ THE ROLES ARE SWAPPED RELATIVE TO THE INVESTIGATION, DELIBERATELY. There
  // is no `carol` in this repo and adding a SpaceMember row is forbidden — case
  // 34 inserts `m_removed` for (space_b, alice) with `on conflict do nothing`,
  // and a membership seeded for a new user would not help anyway. The existing
  // fixtures already carry the exact shape with the parts recast:
  //
  //     BOB plays the attacker.  ACTIVE OWNER of space_b, owns acct_bob.
  //     ALICE plays the victim.  Owns `acct_victim` (seeded below), linked into
  //                              space_b at BALANCE_ONLY via `l_victim_b`.
  //
  // So `fm_account_visible('acct_victim')` is TRUE for Bob, the Transaction
  // UPDATE policy is that function on BOTH arms, and the move is a legal write.
  // ══════════════════════════════════════════════════════════════════════════

  // Visibility must exist before any of this means anything: cases 60/61/63/71
  // each destroy some of it on purpose.
  restoreFixtures();

  /**
   * ⚠️ THE VICTIM ACCOUNT IS SEEDED HERE, NOT REUSED FROM APP_FIXTURES, AND THE
   * REASON IS A REAL ONE THIS BLOCK HIT ON ITS FIRST RUN.
   *
   * The natural choice is `acct_shared` — Alice's account, BALANCE_ONLY-linked
   * into Bob's Space via `l_sh_bal`, exactly the investigated shape. But CASE 63
   * HARD-DELETES IT (`delete from "FinancialAccount" where id='acct_shared'`, to
   * prove ON DELETE CASCADE is not filtered by RLS), so by the time this block
   * runs the row is gone and every insert against it fails the FK. Measured on
   * the first run of this block, not reasoned about.
   *
   * ⚠️ AND `restoreFixtures()` CANNOT BRING IT BACK — WORSE, IT DOES NOT SAY SO.
   * Its `update "FinancialAccount" set "deletedAt"=null where id in (…,
   * 'acct_shared', …)` matches ZERO rows for a deleted account, `psql` reports
   * ok, and the next case's premise is quietly false. That is reported as a
   * finding, not worked around silently: an idempotent-looking reset that
   * matches nothing is the same defect class as a refused UPDATE reported as
   * contention.
   *
   * So this block owns its own fixtures end to end: one account, two links (one
   * at each tier, in each Space), six transactions. It depends on NOTHING an
   * earlier case destroys, and the whole set is deleted at the end — the
   * FinancialAccount delete cascades its links and its transactions.
   *
   * Six rows rather than one because cases 4 and 13 pin Alice's unfiltered
   * transaction count at 4 and Bob's at 2; seeding into APP_FIXTURES would have
   * moved those numbers and relaxed the backstop. Case 66 set that precedent.
   */
  const fkSeed = psql(h.ownerUrl, `
    insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt") values
      ('acct_victim','Alice Joint (FK)','checking','TestBank','USER','alice',now());
    insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
      ('l_victim_a','space_a','acct_victim','HOME','ACTIVE','FULL',now()),
      -- THE ONE THAT MATTERS: Bob reaches Alice's account at the REDUCED tier.
      ('l_victim_b','space_b','acct_victim','SHARED','ACTIVE','BALANCE_ONLY',now());
    insert into "Transaction" (id,"financialAccountId",date,"economicDate",merchant,category,amount,"plaidTransactionId","updatedAt") values
      ('fk_v1','acct_victim',current_date,current_date,'Victim 1','Other',-11,null,now()),
      ('fk_v2','acct_victim',current_date,current_date,'Victim 2','Other',-12,null,now()),
      ('fk_v3','acct_victim',current_date,current_date,'Victim 3','Other',-13,null,now()),
      ('fk_v4','acct_victim',current_date,current_date,'Victim 4','Other',-14,null,now()),
      ('fk_v5','acct_victim',current_date,current_date,'Victim 5','Other',-15,'ptx_redeliver',now()),
      ('fk_v6','acct_victim',current_date,current_date,'Victim 6','Other',-16,null,now());`);
  if (!fkSeed.ok) throw new Error(`RLS-ACC-FK fixture failed: ${fkSeed.err.split("\n")[0]}`);

  const VICTIM_ROWS = "'fk_v1','fk_v2','fk_v3','fk_v4','fk_v5','fk_v6'";
  /** Put the six victim rows back on `acct_victim`, by id. */
  const restoreVictimRows = () => {
    const r = psql(h.ownerUrl,
      `update "Transaction" set "financialAccountId"='acct_victim' where id in (${VICTIM_ROWS});`);
    if (!r.ok) throw new Error(`victim-row restore failed: ${r.err.split("\n")[0]}`);
  };
  /** How many of the six are on a given account, read on the OWNER connection. */
  const victimRowsOn = (acct: string) => psql(h.ownerUrl,
    `select count(*) from "Transaction" where id in (${VICTIM_ROWS}) and "financialAccountId"='${acct}';`).out.trim();

  const reparent = await import("@/lib/accounts/account-reparenting");
  const rec = await import("@/lib/accounts/reconcile");
  const dupSource = (await import("@prisma/client")).DuplicateDetectionSource;

  /** Run the real merge and report the refusal's IDENTITY, not just that it threw. */
  const foldAttempt = async (loser: string, winner: string) => {
    try {
      await rec.mergeArchivedDuplicateIntoCanonical(loser, winner, dupSource.FINGERPRINT_MATCH, null);
      return { refused: false, name: "(no throw)", reason: "(none)" };
    } catch (e) {
      return {
        refused: true,
        name: e instanceof Error ? e.name : String(e),
        reason: e instanceof reparent.ReparentingRefusedError ? e.reason : "(not a reparenting refusal)",
      };
    }
  };

  // ── 73 [role] THE PREMISE — BALANCE_ONLY IS NOT A READ BARRIER AT ALL ─────
  // Asserted RELATIONALLY (`seen === total && total >= 6`) rather than as "6",
  // so a future fixture that adds a seventh row cannot turn this into a
  // tautology, and an accidental DELETE cannot turn it into a vacuous pass.
  {
    const totalRows = psql(h.ownerUrl,
      `select count(*) from "Transaction" where "financialAccountId"='acct_victim';`).out.trim();
    const bobSees = asTenant("bob",
      `select count(*) from "Transaction" where "financialAccountId"='acct_victim';`).out.trim();
    const owner = psql(h.ownerUrl,
      `select coalesce("ownerUserId",'(null)') from "FinancialAccount" where id='acct_victim';`).out.trim();
    const tier = psql(h.ownerUrl,
      `select "visibilityLevel"::text from "SpaceAccountLink" where id='l_victim_b';`).out.trim();
    check(73, "[role] THE PREMISE: Bob's role reads EVERY one of acct_victim's transaction rows although his only link is BALANCE_ONLY, and the account is ALICE's",
      Number(totalRows) >= 6 && bobSees === totalRows && owner === "alice" && tier === "BALANCE_ONLY",
      `total=${totalRows} bobSees=${bobSees} owner=${owner} tier=${tier}`);
  }

  // ── 74 [role] THE DEFECT, ON A REAL ROLE ──────────────────────────────────
  // ⚠️ THE ASSERTION IS `6`, NOT "non-zero", AND NOT "> 0". A `where` that
  // matched nothing reports 0 and READS AS A REFUSAL; the inverse mistake — an
  // attack that reports success because the count was never compared to the
  // population — is the one this suite exists to prevent. The count is compared
  // to what case 73 just proved exists.
  {
    const before = victimRowsOn("acct_victim");
    const moved = asTenant("bob", counting(
      `update "Transaction" set "financialAccountId"='acct_bob' where "financialAccountId"='acct_victim'`));
    const after = victimRowsOn("acct_bob");
    check(74, "[role] THE DEFECT: Bob's fm_app role re-points ALL SIX of Alice's transactions onto his own account — USING and WITH CHECK both pass, nothing is raised, and this is why the refusal cannot live in policy",
      moved.ok && lines(moved)[0] === before && before === "6" && after === "6",
      `population=${before} affected=${moved.out.trim() || moved.err.split("\n")[0]} nowOnBob=${after}`);
    restoreVictimRows();
  }

  // ── 75 [service] THE SOURCE, AT BALANCE_ONLY — REFUSED BEFORE ANY WRITE ───
  // ⚠️ The merge executes on the MIGRATION PRINCIPAL (its client conversion is a
  // later, gated slice), and that is exactly what makes this case meaningful
  // rather than weaker: BYPASSRLS cannot turn two owners into one, so the
  // refusal here is the APPLICATION's. Case 74 has just proved the policy would
  // have allowed it.
  let refusal75 = { refused: false, name: "", reason: "" };
  {
    refusal75 = await foldAttempt("acct_victim", "acct_bob");
    const still = victimRowsOn("acct_victim");
    check(75, "[service] a cross-owner fold with Alice's BALANCE_ONLY-shared account as the SOURCE is refused, and the POST-STATE proves nothing moved",
      refusal75.refused && refusal75.reason === "CROSS_OWNER" && still === "6",
      `${refusal75.name}/${refusal75.reason} stillOnShared=${still}`);
  }

  // ── 76 [service] THE DESTINATION / INVERSE DIRECTION ──────────────────────
  // THIS CASE MUST BE GREEN BEFORE THE OWNER ARM LANDS. The proposed policy
  // change makes the destination-side variant the one that succeeds, taking the
  // victim's own access to 0.
  {
    const bobBefore = psql(h.ownerUrl,
      `select count(*) from "Transaction" where "financialAccountId"='acct_bob';`).out.trim();
    const inverse = await foldAttempt("acct_bob", "acct_victim");
    const bobAfter = psql(h.ownerUrl,
      `select count(*) from "Transaction" where "financialAccountId"='acct_bob';`).out.trim();
    check(76, "[service] pushing Bob's OWN rows ONTO Alice's account is refused too — the destination half is not a weaker case than the source half",
      inverse.refused && inverse.reason === "CROSS_OWNER" && bobAfter === bobBefore && Number(bobBefore) >= 1,
      `${inverse.name}/${inverse.reason} bob=${bobBefore}->${bobAfter}`);
  }

  // ── 77 [service] THE SAME FOLD AT FULL — THE ANSWER MUST NOT DIFFER ───────
  // ⚠️ THIS IS THE OUT-OF-BOUNDS CHECK. If FULL and BALANCE_ONLY ever reach
  // different verdicts, the guard has learned `visibilityLevel` — which belongs
  // to lib/account-privacy.ts and must never migrate into either RLS or an
  // ownership check. The tier is flipped on the SAME link between the SAME two
  // accounts, so nothing but the tier differs between this case and 75.
  {
    const up = psql(h.ownerUrl, `update "SpaceAccountLink" set "visibilityLevel"='FULL' where id='l_victim_b';`);
    if (!up.ok) throw new Error(`tier flip failed: ${up.err.split("\n")[0]}`);
    const atFull = await foldAttempt("acct_victim", "acct_bob");
    const still = victimRowsOn("acct_victim");
    const tier = psql(h.ownerUrl, `select "visibilityLevel"::text from "SpaceAccountLink" where id='l_victim_b';`).out.trim();
    check(77, "[service] the IDENTICAL fold at FULL is refused IDENTICALLY (same error, same reason, same post-state) — the guard never learned the tier",
      tier === "FULL" && atFull.refused
        && atFull.name === refusal75.name && atFull.reason === refusal75.reason && still === "6",
      `tier=${tier} full=${atFull.name}/${atFull.reason} balanceOnly=${refusal75.name}/${refusal75.reason} stillOnShared=${still}`);
    const back = psql(h.ownerUrl, `update "SpaceAccountLink" set "visibilityLevel"='BALANCE_ONLY' where id='l_victim_b';`);
    if (!back.ok) throw new Error(`tier restore failed: ${back.err.split("\n")[0]}`);
  }

  // ── 78 [service] THE NON-VACUITY DENOMINATOR ──────────────────────────────
  // ⚠️ WITHOUT THIS, 75–77 PASS OVER A HELPER THAT REFUSES EVERYTHING. A
  // legitimate same-owner archived fold must still succeed and its rows must be
  // PROVEN moved — the product behaviour the merge exists for.
  {
    const seed = psql(h.ownerUrl, `
      insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","deletedAt","updatedAt") values
        ('acct_fold','Alice Checking (old)','checking','TestBank','USER','alice',now(),now());
      insert into "Transaction" (id,"financialAccountId",date,"economicDate",merchant,category,amount,"updatedAt") values
        ('fk_f1','acct_fold',current_date,current_date,'Legit 1','Other',-21,now()),
        ('fk_f2','acct_fold',current_date,current_date,'Legit 2','Other',-22,now());`);
    if (!seed.ok) throw new Error(`case 78 fixture failed: ${seed.err.split("\n")[0]}`);

    const legit = await foldAttempt("acct_fold", "acct_alice");
    const onLoser  = psql(h.ownerUrl, `select count(*) from "Transaction" where "financialAccountId"='acct_fold';`).out.trim();
    const onWinner = psql(h.ownerUrl, `select count(*) from "Transaction" where id in ('fk_f1','fk_f2') and "financialAccountId"='acct_alice';`).out.trim();
    const audit    = psql(h.ownerUrl, `select count(*) from "DuplicateAccountCandidate" where "accountAId"='acct_alice' and "accountBId"='acct_fold';`).out.trim();
    check(78, "[service] the LEGITIMATE same-owner archived fold still SUCCEEDS: both rows proven moved off the loser, the audit row written — so 75–77 are not refusing everything",
      !legit.refused && onLoser === "0" && onWinner === "2" && audit === "1",
      `refused=${legit.refused}(${legit.name}) loser=${onLoser} winner=${onWinner} auditRow=${audit}`);

    // Cascades its transactions and its audit row with it.
    psql(h.ownerUrl, `delete from "FinancialAccount" where id='acct_fold';`);
  }

  // ── 79 [service] THE UNSCOPED-SOURCE CLASS ────────────────────────────────
  // The two worst sites in the inventory locate an EXISTING row by a TENANT-WIDE
  // `@unique` key — `plaidTransactionId`, `[source, externalEventId]` — which
  // names a ROW WITHOUT NAMING AN ACCOUNT, and then write it with the current
  // sync's account. Here the read is performed on a REAL fm_app transaction, in
  // the exact select shape the code now uses, and the guard is the real one.
  //
  // ⚠️ WHAT THIS DOES AND DOES NOT CLAIM: it proves the READ resolves a foreign
  // row under the role, that the FK is now readable from it, and that the guard
  // refuses the move and leaves the row where it is. It does NOT execute the
  // Plaid loop, which needs a provider; that the loop CALLS this guard — and
  // reads the observed account off the resolved row rather than a constant — is
  // pinned by lib/accounts/account-reparenting.test.ts and the REQUIRED audit.
  {
    const probe = await tenant.withTenantDb("bob", async (tx) => {
      const row = await tx.transaction.findUnique({
        where:  { plaidTransactionId: "ptx_redeliver" },
        select: { id: true, financialAccountId: true },
      });
      if (!row) return { resolved: false, refused: false, name: "(row invisible)", belongsTo: "" };
      try {
        reparent.assertAccountFkUnchanged(
          { table: "Transaction", fkField: "financialAccountId", operation: "update" },
          row.id, row.financialAccountId, "acct_bob");
        return { resolved: true, refused: false, name: "(no throw)", belongsTo: row.financialAccountId };
      } catch (e) {
        return { resolved: true, refused: true, name: e instanceof Error ? e.name : String(e), belongsTo: row.financialAccountId };
      }
    });
    const still = psql(h.ownerUrl,
      `select "financialAccountId" from "Transaction" where id='fk_v5';`).out.trim();
    check(79, "[service] a re-delivered plaidTransactionId resolves ANOTHER owner's row under Bob's role, the account is now readable from that select, and the move is REFUSED rather than performed",
      probe.resolved && probe.refused && probe.name === "UnintendedReparentingError"
        && probe.belongsTo === "acct_victim" && still === "acct_victim",
      `resolved=${probe.resolved} refused=${probe.refused}(${probe.name}) rowAccount=${probe.belongsTo} postState=${still}`);
  }

  // The six victim rows go away with the block that seeded them.
  psql(h.ownerUrl, `delete from "Transaction" where id in ('fk_v1','fk_v2','fk_v3','fk_v4','fk_v5');`);
  restoreVictimRows();

  // ── 80 [source] THE AUDIT'S OWN DENOMINATOR ───────────────────────────────
  // An audit that prints "0 problems" cannot be distinguished from one that
  // scanned nothing, and this programme has shipped exactly that. So the
  // REQUIRED audit is executed here and its two numbers are read off its own
  // output: N capable sites over M scanned files, both > 0, every site
  // classified, exit code 0.
  {
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync("npx", ["tsx", "scripts/audit-account-reparenting.ts"], { encoding: "utf8", cwd: process.cwd() });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const m = /\[source\]\s+(\d+)\s+capable site\(s\) found over\s+(\d+)\s+scanned file\(s\)/.exec(out);
    const sites = m ? Number(m[1]) : 0;
    const scanned = m ? Number(m[2]) : 0;
    // The per-site classification block the audit prints at the end. Its line
    // count is NOT the site count (two statements of one shape share a key), so
    // it is asserted as non-empty rather than compared — a number that looks
    // like a denominator but is not one is worse than no number.
    const classifiedLines = (out.match(/^ {4}[A-Z_]+ +\S+ +line\(s\)/gm) ?? []).length;
    const anyUnclassified = /UNCLASSIFIED/.test(out);
    check(80, "[source] the re-parenting audit prints BOTH numbers, finds a non-empty site population over a non-empty file set, classifies every site, and exits 0",
      run.status === 0 && m !== null && sites > 0 && scanned > 500 && classifiedLines > 0 && !anyUnclassified,
      m ? `sites=${sites} files=${scanned} classificationLines=${classifiedLines} unclassified=${anyUnclassified} exit=${run.status}`
        : `could not read the "[source] N capable site(s) found over M scanned file(s)" line; exit=${run.status}\n${out.split("\n").slice(-8).join("\n")}`);
  }


  // ══════════════════════════════════════════════════════════════════════════
  // PROVIDER-IDENTITY — THE COLLISION THAT FED THE FK BOUNDARY, AT ITS SOURCE
  //
  // Cases 73–80 above prove the FK boundary REFUSES a re-parenting once it is
  // asked for. This block is about the thing that ASKS. `dualWriteProvider-
  // AccountIdentity` used to catch a uniqueness collision, `console.warn` it,
  // and return as though it had written the row — so the identity mapping could
  // end up absent or pointing at another account, and `syncTransactions.ts`
  // resolves a transaction's destination through
  // `(provider, externalAccountId)`, a key that names a ROW WITHOUT NAMING AN
  // ACCOUNT. Case 79 is the downstream symptom; this is the upstream cause.
  //
  // THE TWO BOUNDARIES ARE DELIBERATELY BOTH KEPT. Nothing below weakens 73–80:
  // the FK guard still has to hold for every other way a foreign row can be
  // resolved (a re-delivered `plaidTransactionId`, a reused external event id),
  // and this boundary still has to hold because a contested identity is wrong
  // even when no transaction ever arrives to expose it.
  //
  // ⚠️ THE HELPER TAKES NO CLIENT, SO IT RUNS ON `db` — the migration principal
  // in this harness. That is stated rather than hidden, and it is what makes
  // case 83 meaningful rather than weaker: BYPASSRLS cannot turn two holders
  // into one, so the refusal there is the APPLICATION's. The claims that ARE
  // about authority — what a tenant principal can see of a foreign identity row
  // — are made on the real `fm_app` role in cases 81 and 84.
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pid = await import("@/lib/accounts/provider-identity");
    const PLAID = (await import("@prisma/client")).ProviderType.PLAID;

    // Own fixtures, end to end, deleted at the end of the block. `acct_shared`
    // is unusable (case 63 hard-deletes it) and APP_FIXTURES counts are pinned
    // by cases 4 and 13, so nothing here is grafted onto them.
    //
    // THE SHAPE: `ext_contested` is held by BOTH Alice's and Bob's account. On
    // a migrated database that is not an error — migration 20260627180853 (D2
    // Step 1D) replaced @@unique([provider, externalAccountId]) with the
    // account-scoped triple so two owners can interpret one public wallet
    // address — which is exactly why the old catch's comment ("a collision
    // would mean some OTHER FinancialAccount already holds this") describes a
    // constraint that no longer exists.
    // ⚠️ THE FIXTURE IS SHAPED SO NO CASE CAN DEPEND ON WHICH ROW `findFirst`
    // RETURNS. The helper's first statement is
    // `findFirst({ financialAccountId, provider })` with NO `orderBy`, so
    // physical row order decides which sibling it picks, and a case whose
    // verdict flips with that order is a coin toss wearing an assertion.
    //
    //   `acct_pid_replay`  BOTH its addresses are Alice's alone → whichever row
    //                      is picked, repointing it onto its sibling's address
    //                      collides and the reread can only find Alice. SAME.
    //   `acct_pid_alice`   BOTH its addresses are ALSO held by Bob → whichever
    //                      row is picked, the collision's address has a foreign
    //                      holder. DIFFERENT, every time.
    const pidSeed = psql(h.ownerUrl, `
      insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt") values
        ('acct_pid_replay','Alice PID (replay)','checking','TestBank','USER','alice',now()),
        ('acct_pid_alice','Alice PID','checking','TestBank','USER','alice',now()),
        ('acct_pid_bob','Bob PID','checking','TestBank','USER','bob',now());
      insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
        ('l_pid_r','space_a','acct_pid_replay','HOME','ACTIVE','FULL',now()),
        ('l_pid_a','space_a','acct_pid_alice','HOME','ACTIVE','FULL',now()),
        ('l_pid_b','space_b','acct_pid_bob','HOME','ACTIVE','FULL',now());
      insert into "ProviderAccountIdentity" (id,"financialAccountId",provider,"externalAccountId","createdAt") values
        ('pid_replay_1','acct_pid_replay','PLAID','ext_replay_a',now()),
        ('pid_replay_2','acct_pid_replay','PLAID','ext_replay_b',now()),
        ('pid_alice_1','acct_pid_alice','PLAID','ext_contested',now()),
        ('pid_alice_2','acct_pid_alice','PLAID','ext_second',now()),
        ('pid_bob_1','acct_pid_bob','PLAID','ext_contested',now()),
        ('pid_bob_2','acct_pid_bob','PLAID','ext_second',now()),
        ('pid_bob_own','acct_pid_bob','PLAID','ext_bob_only',now());`);
    if (!pidSeed.ok) throw new Error(`PROVIDER-IDENTITY fixture failed: ${pidSeed.err.split("\n")[0]}`);

    const PID_ACCOUNTS = `'acct_pid_replay','acct_pid_alice','acct_pid_bob'`;
    /** Every identity row as `id=externalAccountId@account`, owner-side, ordered. */
    const identityState = () => psql(h.ownerUrl,
      `select coalesce(string_agg(id || '=' || "externalAccountId" || '@' || "financialAccountId", ',' order by id),'')
         from "ProviderAccountIdentity" where "financialAccountId" in (${PID_ACCOUNTS});`).out.trim();

    // ── 81 [role] THE PREMISE: A FOREIGN IDENTITY ROW IS INVISIBLE, AND THE
    //    ZERO IS NOT A BROKEN WHERE ─────────────────────────────────────────
    // ⚠️ THE VACUITY TRAP, HEAD ON. "Bob reads 0 rows for ext_contested" is
    // also what a misspelled column, a missing grant or an empty table would
    // report. So the SAME statement, under the SAME role, is first shown
    // returning Bob's OWN row — and the owner connection supplies the
    // population the zero is a zero OF.
    {
      const ownerHolders = psql(h.ownerUrl,
        `select count(*) from "ProviderAccountIdentity" where provider='PLAID' and "externalAccountId"='ext_contested';`).out.trim();
      const bobSeesContested = asTenant("bob",
        `select count(*) from "ProviderAccountIdentity" where provider='PLAID' and "externalAccountId"='ext_contested';`);
      const bobSeesOwn = asTenant("bob",
        `select count(*) from "ProviderAccountIdentity" where provider='PLAID' and "externalAccountId"='ext_bob_only';`);
      const aliceSeesContested = asTenant("alice",
        `select count(*) from "ProviderAccountIdentity" where provider='PLAID' and "externalAccountId"='ext_contested';`);
      check(81, "[role] TWO accounts hold the SAME PLAID identity and the database raises nothing; each tenant's role sees only its OWN holder — so a reread of the conflicting key under a tenant client is BLIND to the other half",
        ownerHolders === "2"
          && bobSeesOwn.ok && bobSeesOwn.out.trim() === "1"
          && bobSeesContested.ok && bobSeesContested.out.trim() === "1"
          && aliceSeesContested.ok && aliceSeesContested.out.trim() === "1",
        `ownerHolders=${ownerHolders} bobOwnRow=${bobSeesOwn.out.trim() || bobSeesOwn.err.split("\n")[0]} ` +
        `bobOfContested=${bobSeesContested.out.trim() || bobSeesContested.err.split("\n")[0]} ` +
        `aliceOfContested=${aliceSeesContested.out.trim() || aliceSeesContested.err.split("\n")[0]}`);
    }

    // ── 82 [service] A REPLAY IS A SUCCESS ──────────────────────────────────
    // The collision is produced for real: this account carries two identity
    // rows (the xpub shape), so repointing the row `findFirst` returns onto the
    // address its SIBLING already holds collides on the account-scoped triple.
    // Which row `findFirst` returns is READ FIRST rather than guessed, so the
    // case is deterministic instead of depending on physical row order — and
    // the read is also the non-vacuity guard: the target is asserted DIFFERENT
    // from the picked row's own address, so "nothing was thrown" can never be a
    // silent no-op passing for a classified replay.
    //
    // ⚠️ THE COLLISION IS RAISED ONLY THROUGH THE HELPER, NOT REPRODUCED BESIDE
    // IT. A hand-written `providerAccountIdentity.update()` here would be a
    // re-parenting-CAPABLE site in this file and the REQUIRED audit
    // (scripts/audit-account-reparenting.ts) correctly refuses to classify it —
    // measured, not predicted. The driver's own `meta.target` is read instead
    // off the `cause` of the error the shipped code actually classified, in
    // case 83, which is the stronger measurement anyway.
    {
      const before = identityState();
      const first = await dbMod.db.providerAccountIdentity.findFirst({
        where: { financialAccountId: "acct_pid_replay", provider: PLAID },
      });
      const sibling = first?.externalAccountId === "ext_replay_a" ? "ext_replay_b" : "ext_replay_a";

      let replayThrew = "(none)";
      try {
        await pid.dualWriteProviderAccountIdentity("acct_pid_replay", PLAID, sibling);
      } catch (e) {
        replayThrew = e instanceof Error ? `${e.name}: ${e.message.slice(0, 90)}` : String(e);
      }
      const after = identityState();

      check(82, "[service] a collision with THIS ACCOUNT'S OWN mapping is an idempotent replay — the write genuinely collides (the target is proven different from the row it repoints), nothing is thrown, and the POST-STATE proves not one identity row moved",
        first !== null && first.externalAccountId !== sibling
          && replayThrew === "(none)"
          && after === before && before.split(",").length === 7,
        `threw=${replayThrew} pickedRow=${first?.externalAccountId} repointedTo=${sibling} ` +
        `rows=${before.split(",").length} before=[${before}] after=[${after}]`);
    }

    // ── 83 [service] A CONTESTED IDENTITY IS REFUSED, AND NOTHING IS ADOPTED ─
    // THE CASE THE OLD CATCH SWALLOWED. The write collides on Alice's own
    // triple, the reread finds Bob's account also holding `ext_contested`, and
    // PLAID identity is exclusive — so the verdict is DIFFERENT_ACCOUNT.
    //
    // ⚠️ THE ASSERTION IS THE POST-STATE, NOT THE THROW. "It threw" is satisfied
    // by a function that throws at everything; what has to be true is that no
    // alternate destination was selected, no `financialAccountId` moved, and the
    // four identity rows are byte-for-byte where they were. The `before` string
    // is the denominator — four rows, named, with their accounts.
    {
      const before = identityState();
      const bobRowsBefore = psql(h.ownerUrl,
        `select count(*) from "ProviderAccountIdentity" where "financialAccountId"='acct_pid_bob';`).out.trim();

      // Either address works: Bob holds BOTH of them, so whichever row
      // `findFirst` picks, the address it collides on has a foreign holder.
      const current = await dbMod.db.providerAccountIdentity.findFirst({
        where: { financialAccountId: "acct_pid_alice", provider: PLAID },
      });
      const contestedTarget = current?.externalAccountId === "ext_contested" ? "ext_second" : "ext_contested";

      let name = "(no throw)", verdict = "(none)", count = -1, leaked = true;
      let realTarget = "(no cause)", causeIsCollision = false, causeScoped = false;
      try {
        await pid.dualWriteProviderAccountIdentity("acct_pid_alice", PLAID, contestedTarget);
      } catch (e) {
        name = e instanceof Error ? e.name : String(e);
        if (e instanceof pid.ProviderIdentityConflictError) {
          verdict = e.verdict;
          count = e.conflictingAccountCount;
          // The message travels into logs. It may not carry the provider's
          // identifier, and it may not name the other tenant's account.
          leaked = e.message.includes("ext_contested") || e.message.includes("acct_pid_bob");

          // ⚠️ THE PARSER, CHECKED AGAINST THE DRIVER RATHER THAN AGAINST A
          // STRING SOMEONE WROTE. The preserved `cause` is the real P2002, and
          // `causeMetaTarget` in the detail below is whatever this Prisma and
          // this Postgres actually produced — a measurement, not a prediction.
          // Proving the key parsed as ACCOUNT-SCOPED is what shows the verdict
          // came from the exclusive-provider rule and not from a constraint
          // misread as global.
          const cause = (e as { cause?: unknown }).cause;
          realTarget = JSON.stringify((cause as { meta?: { target?: unknown } })?.meta?.target ?? null);
          causeIsCollision = pid.isUniqueCollision(cause);
          causeScoped = pid.conflictKeyIsAccountScoped(cause);
        }
      }
      const after = identityState();
      const bobRowsAfter = psql(h.ownerUrl,
        `select count(*) from "ProviderAccountIdentity" where "financialAccountId"='acct_pid_bob';`).out.trim();

      check(83, "[service] the identity write REFUSES a provider identity another FinancialAccount already holds — typed verdict DIFFERENT_ACCOUNT reached from a correctly-parsed ACCOUNT-SCOPED key, no alternate destination adopted, every identity row and every FK exactly where it was, and nothing about the other tenant in the message",
        current !== null && current.externalAccountId !== contestedTarget
          && name === "ProviderIdentityConflictError" && verdict === "DIFFERENT_ACCOUNT" && count === 1
          && causeIsCollision && causeScoped
          && !leaked && after === before && before.split(",").length === 7
          && bobRowsAfter === bobRowsBefore && bobRowsBefore === "3",
        `threw=${name}/${verdict} holders=${count} leakedIdentifier=${leaked} picked=${current?.externalAccountId} target=${contestedTarget} ` +
        `causeMetaTarget=${realTarget} causeIsCollision=${causeIsCollision} causeAccountScoped=${causeScoped} ` +
        `rows=${before.split(",").length} before=[${before}] after=[${after}] bobRows=${bobRowsBefore}->${bobRowsAfter}`);
    }

    // ── 84 [role] THE SAME CLASSIFIER, THE SAME KEY, A BLIND AUTHORITY —
    //    AND IT DEGRADES TO A REFUSAL, NOT TO SILENCE ───────────────────────
    // THE CASE THE WHOLE FAIL-CLOSED RULE EXISTS FOR, and the only one here
    // that is genuinely about a policy. The reread is issued verbatim — the
    // same `findMany`, the same key, the same single selected column — once on
    // the principal the helper uses today and once through `withTenantDb` as
    // Bob, which is the principal it will use after the client conversion. The
    // rows that come back are fed to the REAL exported classifier.
    //
    // ⚠️ WHAT IS SIMULATED AND WHAT IS NOT: the policy is real, the rows are
    // real, the classifier is the shipped one. The only substitution is the
    // CLIENT, because `dualWriteProviderAccountIdentity` does not accept one
    // yet — that conversion is a separate slice.
    {
      const readBoth = async (externalAccountId: string) => {
        const key = { provider: PLAID, externalAccountId };
        const privileged = await dbMod.db.providerAccountIdentity.findMany({
          where: key, select: { financialAccountId: true },
        });
        // ALICE is the blinded principal, because ALICE's account is the one
        // doing the writing. Asking as Bob would answer a different question.
        const blinded = await tenant.withTenantDb("alice", async (tx) =>
          tx.providerAccountIdentity.findMany({ where: key, select: { financialAccountId: true } }));
        return { privileged, blinded };
      };
      const asking = (rows: Array<{ financialAccountId: string }>, accountScopedKey: boolean) =>
        pid.classifyProviderIdentityConflictRows({
          rows, financialAccountId: "acct_pid_alice", provider: PLAID, accountScopedKey,
        }).verdict as string;

      // ── HALF ONE: THE GLOBAL-KEY COLLISION, WHICH IS THE ONE THAT FAILS
      //    CLOSED. `ext_bob_only` is Bob's alone, so under a global unique
      //    Alice's write would collide with a row HER OWN ROLE CANNOT SEE and
      //    the reread comes back EMPTY. Read as "nothing found, therefore no
      //    conflict", that is a silent corruption with an RLS policy for an
      //    alibi. The shipped classifier calls it INDETERMINATE and refuses.
      const onlyBobs = await readBoth("ext_bob_only");
      const globalPriv  = asking(onlyBobs.privileged, false);
      const globalBlind = asking(onlyBobs.blinded,    false);

      // ── HALF TWO: THE MEASURED LIMIT, PINNED RATHER THAN ASSERTED AWAY.
      //    `ext_contested` is held by Alice AND Bob. The collision is on
      //    Alice's OWN account-scoped key, so her reread legitimately finds her
      //    own row and the verdict is SAME_ACCOUNT — while the privileged read
      //    of the IDENTICAL key sees the foreign holder and says
      //    DIFFERENT_ACCOUNT.
      //
      //    ⚠️ THIS ONE IS NOT FIXABLE AT THIS BOUNDARY AND IS NOT PRETENDED
      //    AWAY. Seeing a holder RLS hides needs an escalated read, which is
      //    precisely the confused-deputy path this classifier exists without.
      //    What protects PLAID in practice is a constraint RLS does not filter
      //    — `FinancialAccount.plaidAccountId @unique` — not anything here. The
      //    pin exists so that the day this verdict changes, it changes VISIBLY.
      const contested = await readBoth("ext_contested");
      const scopedPriv  = asking(contested.privileged, true);
      const scopedBlind = asking(contested.blinded,    true);

      check(84, "[role] a conflicting key held only by ANOTHER tenant reads EMPTY under the writer's own role, and the shipped classifier degrades that to INDETERMINATE — a refusal, never 'no conflict, carry on'; the account-scoped collision's documented LIMIT (blind SAME_ACCOUNT vs privileged DIFFERENT_ACCOUNT) is pinned beside it",
        onlyBobs.privileged.length === 1 && onlyBobs.blinded.length === 0
          && globalPriv === "DIFFERENT_ACCOUNT" && globalBlind === "INDETERMINATE"
          && contested.privileged.length === 2 && contested.blinded.length === 1
          && scopedPriv === "DIFFERENT_ACCOUNT" && scopedBlind === "SAME_ACCOUNT",
        `globalKey: rows ${onlyBobs.privileged.length}->${onlyBobs.blinded.length} verdict ${globalPriv}->${globalBlind} | ` +
        `accountScopedKey: rows ${contested.privileged.length}->${contested.blinded.length} verdict ${scopedPriv}->${scopedBlind}`);
    }

    // ── 85 [service] THE OTHER THING THE CATCH WAS SWALLOWING ───────────────
    // Not the collision — EVERYTHING ELSE. A failure that is neither an
    // authority refusal nor a uniqueness collision used to produce one warn
    // line and a successful-looking return. Here a real foreign-key violation
    // is raised by a real database and has to reach the caller UNCHANGED: not
    // wrapped as a conflict, not wrapped as an authority refusal.
    //
    // Paired with the live authority refusal, so the two predicates are shown
    // DISJOINT on real driver output rather than on hand-written strings: the
    // identity insert on an account with no visible link is refused with 42501
    // under `fm_app`, and that refusal must read as an authority failure and
    // NOT as a collision.
    {
      let unknownName = "(no throw)", unknownIsConflict = true, unknownIsAuthority = true;
      try {
        await pid.dualWriteProviderAccountIdentity("acct_does_not_exist_at_all", PLAID, "ext_orphan");
      } catch (e) {
        unknownName = e instanceof Error ? e.name : String(e);
        unknownIsConflict  = e instanceof pid.ProviderIdentityConflictError;
        unknownIsAuthority = e instanceof pid.ProviderIdentityAuthorityRefusedError;
      }
      const orphanRows = psql(h.ownerUrl,
        `select count(*) from "ProviderAccountIdentity" where "externalAccountId"='ext_orphan';`).out.trim();

      // A real 42501 from a real role, captured through the tenant client.
      let refusalIsAuthority = false, refusalIsCollision = true, refusalSeen = "(none)";
      try {
        await tenant.withTenantDb("bob", async (tx) =>
          tx.providerAccountIdentity.create({
            data: { financialAccountId: "acct_pid_alice", provider: PLAID, externalAccountId: "ext_refused" },
          }));
      } catch (e) {
        refusalSeen = e instanceof Error ? e.name : String(e);
        refusalIsAuthority = pid.isAuthorityRefusal(e);
        refusalIsCollision = pid.isUniqueCollision(e);
      }

      check(85, "[service] an UNKNOWN database failure escapes the identity helper unchanged — neither relabelled as a conflict nor as an authority refusal, and no row written — while a REAL 42501 from a real role is still classified as an authority refusal and still not as a collision",
        unknownName !== "(no throw)" && !unknownIsConflict && !unknownIsAuthority && orphanRows === "0"
          && refusalIsAuthority && !refusalIsCollision,
        `unknown=${unknownName} asConflict=${unknownIsConflict} asAuthority=${unknownIsAuthority} rowsWritten=${orphanRows} | ` +
        `refusal=${refusalSeen} isAuthority=${refusalIsAuthority} isCollision=${refusalIsCollision}`);
    }

    // The block's fixtures go away with the accounts that own them — the
    // FinancialAccount delete cascades its links and its identity rows.
    psql(h.ownerUrl, `delete from "FinancialAccount" where id in (${PID_ACCOUNTS});`);
  }

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
