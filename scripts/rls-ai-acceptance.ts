/**
 * scripts/rls-ai-acceptance.ts  (RLS-AI-S3)
 *
 * THE AI SURFACE, ADVERSARIALLY, AS REAL fm_app.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/rls-ai-acceptance.ts
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY ────────────────────────────────────────
 * `scripts/rls-acceptance.ts` proves the policies in SQL; `rls-app-acceptance.ts`
 * proves that converted services go through them. Neither can prove the thing that
 * makes the AI surface different: **it turns empty result sets into declarative
 * English and hands them to a model.** Every table it reads is granted to `fm_app`,
 * so no AI read can fail loudly — RLS has exactly one failure mode here, the silent
 * empty set, and the modules that render it exist precisely to prevent false
 * absence. So the assertions below are not "Alice cannot see Bob's rows" alone.
 * They are:
 *
 *     an empty-but-VISIBLE Space still says "none"
 *     an empty-and-INACCESSIBLE Space says INDETERMINATE
 *
 * ⚠️ A FAKE CLIENT CANNOT PROVE A POLICY, so every case here runs the real modules
 * against a real `fm_app` connection on a throwaway Postgres carrying the committed
 * migration history.
 *
 * ⚠️ AND A FIXTURE THAT YIELDS AN EMPTY SET MAKES A TEST PASS FOR THE WRONG REASON
 * — shipped once in this programme. So every INDETERMINATE case is paired with a
 * case proving the SAME Space is non-empty for the identity that owns it. Without
 * that pair, "Alice got no transactions for space_b" is satisfied by a Space with
 * no transactions, and the suite would read clean over a deleted mechanism.
 *
 * The harness (`scripts/lib/rls-harness.ts`) is imported READ-ONLY and not edited;
 * the extra fixtures this suite needs are seeded by this suite, in this file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  prepareHarness, teardownHarness, psql, makeRecorder, APP_FIXTURES,
} from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

/**
 * What the shared harness does not have, because no other suite needs it.
 *
 * ⚠️ `space_empty` IS THE OTHER HALF OF THE PAIR. A Space Alice genuinely belongs
 * to, with no accounts, no transactions, no snapshots and no memory. It is the only
 * fixture that can distinguish the fix from the bug: without it, "Alice is told
 * INDETERMINATE for space_b" could be satisfied by a system that says INDETERMINATE
 * for everything, which is a different bug wearing the fix's clothes.
 *
 * `space_lonely` is Bob's equivalent, so neither side of the pair is special-cased.
 */
const AI_FIXTURES = `
insert into "Space" (id,name,type,"updatedAt") values
  ('space_empty','Alice Empty','PERSONAL',now()),
  ('space_lonely','Bob Empty','PERSONAL',now());

insert into "SpaceMember" (id,"spaceId","userId",role,status) values
  ('m_ae','space_empty','alice','OWNER','ACTIVE'),
  ('m_bl','space_lonely','bob','OWNER','ACTIVE');

-- Snapshot history for space_a only, so the envelope has something to report and
-- "no snapshots" is a real distinction rather than the only possible answer.
insert into "SpaceSnapshot" (id,"spaceId",date,"netWorth","totalAssets",debt,cash,savings,"cashOnHand","netLiquid")
  values ('snap_a1','space_a',current_date - 1,100,130,30,40,20,40,30),
         ('snap_a2','space_a',current_date,110,140,30,45,20,45,35);

insert into "AiAgent" (id,"spaceId",name,"updatedAt") values
  ('agent_a','space_a','Alice Agent',now()),
  ('agent_e','space_empty','Empty Agent',now());

-- ⚠️ A PAYLOAD THE FAIL-CLOSED READER ACCEPTS. The shared harness's SpaceMemory
-- rows carry an empty payload, which readMemory correctly refuses — so they land
-- in the unreadable bucket and recall reports NOTHING STATED. That would have made
-- "Alice sees her own and not Bob's" pass over two empty lists, which is the
-- vacuous pass this programme has shipped once. These two are legacy-V1 GOAL
-- shapes: readable, and distinguishable by subject.
insert into "SpaceMemory" (id,"spaceId","ownerUserId",kind,subject,payload,"statedAs",status)
  values
  ('mem_alice_goal','space_s','alice','INTENTION','alice-goal',
   '{"targetMetric":"netWorth","targetAmount":1000000,"byDate":"2030-01-01"}'::jsonb,
   'a goal of Alice''s','ACTIVE'),
  ('mem_bob_goal','space_s','bob','INTENTION','bob-goal',
   '{"targetMetric":"liquid","targetAmount":50000,"byDate":"2029-01-01"}'::jsonb,
   'a goal of Bob''s','ACTIVE');

-- ⚠️ RLS-AI-S10 — A PUBLIC SPACE ALICE IS NOT A MEMBER OF. This is the fixture
-- that falsified the old Space probe: fm_app_sel ON "Space" ORs in
-- "isPublic" = true, so Alice IS returned this row, while every Space-granular
-- child policy reads fm_visible_space_ids() and does not contain it. The old
-- oracle therefore said PROVEN_EMPTY about evidence Alice cannot read. It is a
-- real product shape, not a contrivance: RLS-C-S3 recorded that the Spaces
-- launcher hands PUBLIC Spaces the viewer has NOT joined to a net-worth reader.
insert into "Space" (id,name,type,"isPublic","updatedAt") values
  ('space_pub','Bob Public','PERSONAL',true,now());
insert into "SpaceMember" (id,"spaceId","userId",role,status) values
  ('m_pub','space_pub','bob','OWNER','ACTIVE'),
  -- ⚠️ AND A REVOKED MEMBERSHIP, which the old probe also got wrong: Alice's own
  -- row matches the SpaceMember policy's userId arm, but fm_visible_space_ids()
  -- requires status ACTIVE. The probe's status: "ACTIVE" filter is what makes
  -- these two agree. REMOVED, not REVOKED: SpaceMemberStatus is ACTIVE | REMOVED | LEFT.
  ('m_rev','space_pub','alice','VIEWER','REMOVED');
insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt") values
  ('acct_pub','Bob Public Checking','checking','TestBank','USER','bob',now());
insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
  ('l_pub','space_pub','acct_pub','HOME','ACTIVE','FULL',now());
insert into "Transaction" (id,"financialAccountId",date,"economicDate",merchant,category,amount,"updatedAt") values
  ('tx_pub_1','acct_pub',current_date,current_date,'Public Rent','Other',-77,now());

-- ⚠️ RLS-AI-S8 — AN UNDATED TRANSACTION, IN A SPACE OF ITS OWN SO THE COUNT IS
-- UNAMBIGUOUS. Transaction.economicDate is nullable and the
-- audit-economic-date-persistence audit is RED on the live corpus, so rows that
-- exist and cannot be placed in time are a production state. Before S8 the census
-- reported count over ALL rows beside a range measured over the DATED ones, and
-- a ledger of entirely undated rows fell through to "none recorded in this Space".
insert into "Space" (id,name,type,"updatedAt") values
  ('space_undated','Alice Undated','PERSONAL',now()),
  ('space_mixed','Alice Mixed','PERSONAL',now());
insert into "SpaceMember" (id,"spaceId","userId",role,status) values
  ('m_un','space_undated','alice','OWNER','ACTIVE'),
  ('m_mx','space_mixed','alice','OWNER','ACTIVE');
insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt") values
  ('acct_undated','Alice Undated Checking','checking','TestBank','USER','alice',now()),
  ('acct_mixed','Alice Mixed Checking','checking','TestBank','USER','alice',now());
insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt") values
  ('l_un','space_undated','acct_undated','HOME','ACTIVE','FULL',now()),
  ('l_mx','space_mixed','acct_mixed','HOME','ACTIVE','FULL',now());
insert into "Transaction" (id,"financialAccountId",date,"economicDate",merchant,category,amount,"updatedAt") values
  ('tx_un_1','acct_undated',current_date,null,'Undated A','Other',-11,now()),
  ('tx_un_2','acct_undated',current_date,null,'Undated B','Other',-12,now()),
  ('tx_mx_dated','acct_mixed',current_date,current_date,'Dated','Other',-20,now()),
  ('tx_mx_undated','acct_mixed',current_date,null,'Undated','Other',-30,now());
`;

/** A SpaceContext shaped exactly as resolveSpaceContext returns one. */
function spaceCtx(userId: string, spaceId: string) {
  return {
    userId, spaceId, role: "OWNER",
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: spaceId, name: spaceId, type: "PERSONAL", category: "PERSONAL",
             isPublic: false, reportingCurrency: "USD" },
  } as never;
}

async function main(): Promise<void> {
  console.log("\n=== RLS AI-SURFACE ADVERSARIAL SUITE ===\n");

  const h = prepareHarness("rlsai");
  for (const [label, sql] of [["shared", APP_FIXTURES], ["ai", AI_FIXTURES]] as const) {
    const r = psql(h.ownerUrl, sql);
    if (!r.ok) throw new Error(`${label} fixture seed failed: ${r.err}`);
  }
  console.log("[rls-ai] fixtures seeded: Alice/Bob, a SHARED Space, and an EMPTY-BUT-VISIBLE Space each.\n");

  // Dynamic, and only now: lib/db.ts binds its role clients at module load from
  // the environment prepareHarness() just set.
  const dbMod   = await import("@/lib/db");
  const tenant  = await import("@/lib/db/tenant-context");
  const strict  = await import("@/lib/db/strict-mode");
  const absence = await import("@/lib/ai/absence");
  const envelope = await import("@/lib/ai/coverage-envelope");
  const txq     = await import("@/lib/data/transaction-query");
  const phaseMod = await import("@/lib/ai/tenant-phase");
  await import("@/lib/ai/assemblers");
  const tools   = await import("@/lib/ai/conversation/tools");

  // ── [role] the rig is genuinely unprivileged ───────────────────────────────
  const roles = dbMod.activeDbRoles();
  check(1, "[role] a DISTINCT fm_app client is wired — no silent fallback to the owner",
    roles.app && roles.system, JSON.stringify(roles));
  const verdicts = await strict.verifyDbAuthorities(dbMod.configuredRoleClients());
  check(2, "[role] every role connection IS its principal, no superuser, no BYPASSRLS, owns nothing",
    verdicts.every((v) => v.ok),
    verdicts.filter((v) => !v.ok).map((v) => `${v.variable}: ${v.problems.join("; ")}`).join(" | "));

  // ── [absence] THE CORPUS SPAN — THE PAIR ───────────────────────────────────
  const spanAliceOwn   = await tenant.withTenantDb("alice", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_a" }));
  const spanAliceEmpty = await tenant.withTenantDb("alice", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_empty" }));
  const spanAliceOnBob = await tenant.withTenantDb("alice", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_b" }));
  const spanBobOwn     = await tenant.withTenantDb("bob", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_b" }));

  check(3, "[absence] PRESENT — Alice's own Space returns real bounds and no absence verdict",
    spanAliceOwn.from !== null && spanAliceOwn.to !== null && spanAliceOwn.absence === null,
    JSON.stringify(spanAliceOwn));
  check(4, "[absence] PROVEN_EMPTY — an empty Space Alice BELONGS TO is established as empty",
    spanAliceEmpty.absence === "PROVEN_EMPTY"
      && spanAliceEmpty.unavailableReason === "no dated transactions are available for this Space",
    JSON.stringify(spanAliceEmpty));
  check(5, "[absence] INDETERMINATE — Bob's Space is NOT reported as empty to Alice",
    spanAliceOnBob.absence === "INDETERMINATE",
    JSON.stringify(spanAliceOnBob));
  check(6, "[absence] …and the two refusals are byte-DIFFERENT (RLS-C-S3 measured them identical)",
    spanAliceOnBob.unavailableReason !== spanAliceEmpty.unavailableReason
      && !(spanAliceOnBob.unavailableReason ?? "").includes("are available for this Space"),
    `${spanAliceOnBob.unavailableReason}`);
  check(7, "[absence] NOT VACUOUS — space_b really does hold transactions, for Bob",
    spanBobOwn.from !== null && spanBobOwn.absence === null,
    JSON.stringify(spanBobOwn));

  // ── [absence] THE ORACLE ITSELF, UNDER THE REAL POLICY ─────────────────────
  const oracleOwn = await tenant.withTenantDb("alice", (tx) =>
    absence.adjudicateAbsence(tx, "space_empty"));
  const oracleForeign = await tenant.withTenantDb("alice", (tx) =>
    absence.adjudicateAbsence(tx, "space_b"));
  const oracleGuessed = await tenant.withTenantDb("alice", (tx) =>
    absence.adjudicateAbsence(tx, "space_does_not_exist"));
  const oracleOwner = await absence.adjudicateAbsence(
    dbMod.db as never, "space_b");
  check(8, "[absence] the oracle, as fm_app, separates own-Space from foreign Space",
    oracleOwn === "PROVEN_EMPTY" && oracleForeign === "INDETERMINATE",
    `${oracleOwn} / ${oracleForeign}`);
  check(9, "[absence] a GUESSED Space id is INDETERMINATE, never PROVEN_EMPTY",
    oracleGuessed === "INDETERMINATE", String(oracleGuessed));
  check(10, "[absence] on the MIGRATION PRINCIPAL the verdict is PROVEN_EMPTY — today's behaviour is preserved",
    oracleOwner === "PROVEN_EMPTY", String(oracleOwner));

  // ── [envelope] THE PROLOGUE — THE SENTENCE A MODEL READS ───────────────────
  const envOwn = await tenant.withTenantDb("alice", (tx) =>
    envelope.loadCoverageEnvelope(tx, "space_a"));
  const envEmpty = await tenant.withTenantDb("alice", (tx) =>
    envelope.loadCoverageEnvelope(tx, "space_empty"));
  const envForeign = await tenant.withTenantDb("alice", (tx) =>
    envelope.loadCoverageEnvelope(tx, "space_b"));
  const envBobOwn = await tenant.withTenantDb("bob", (tx) =>
    envelope.loadCoverageEnvelope(tx, "space_b"));

  const say = (e: Awaited<ReturnType<typeof envelope.loadCoverageEnvelope>>) =>
    envelope.describeCoverageEnvelope(e, null).join("\n");

  check(11, "[envelope] Alice's own Space reports AVAILABLE transactions and snapshots",
    envOwn.transactions.availability === "AVAILABLE"
      && envOwn.snapshots.availability === "AVAILABLE"
      && envOwn.unavailability === null,
    JSON.stringify(envOwn.transactions));
  check(12, "[envelope] an empty-but-VISIBLE Space still says \"none recorded\"",
    envEmpty.transactions.availability === "NONE"
      && envEmpty.unavailability === null
      && /Transactions: none recorded in this Space/.test(say(envEmpty)),
    say(envEmpty));
  check(13, "[envelope] an INACCESSIBLE Space is UNKNOWN/SPACE_NOT_OBSERVABLE, never NONE",
    envForeign.transactions.availability === "UNKNOWN"
      && envForeign.unavailability === "SPACE_NOT_OBSERVABLE",
    JSON.stringify({ a: envForeign.transactions.availability, u: envForeign.unavailability }));
  check(14, "[envelope] …and never turns unavailable evidence into \"none recorded\"",
    !/none recorded/.test(say(envForeign)) && !/no transactions/i.test(say(envForeign)),
    say(envForeign));
  check(15, "[envelope] …it STATES the non-establishment and forbids the absence answer",
    /COULD NOT BE ESTABLISHED/.test(say(envForeign))
      && /do not describe any record as empty/.test(say(envForeign)),
    say(envForeign));
  check(16, "[envelope] …and advertises no date range it could not read",
    !/\d{4}/.test(say(envForeign)), say(envForeign));
  check(17, "[envelope] NOT VACUOUS — space_b's census is AVAILABLE for Bob",
    envBobOwn.transactions.availability === "AVAILABLE", JSON.stringify(envBobOwn.transactions));
  check(18, "[envelope] Alice's context cannot observe Bob's accounts even by count",
    envForeign.accounts.cash === 0 && envForeign.accounts.debt === 0
      && envForeign.transactions.span.count === 0,
    JSON.stringify(envForeign.accounts));

  // ── [channel] guessed ids, with NO application predicate at all ────────────
  const guessedAccount = await tenant.withTenantDb("alice", (tx) =>
    tx.financialAccount.findUnique({ where: { id: "acct_bob" } }));
  const guessedTxn = await tenant.withTenantDb("alice", (tx) =>
    tx.transaction.findUnique({ where: { id: "tx_bob_1" } }));
  const guessedBrief = await tenant.withTenantDb("alice", (tx) =>
    tx.dailyBrief.findUnique({ where: { id: "brief_bob" } }));
  const guessedMemory = await tenant.withTenantDb("alice", (tx) =>
    tx.spaceMemory.findUnique({ where: { id: "mem_bob" } }));
  check(19, "[channel] Alice cannot obtain Bob's ACCOUNT by guessed id",
    guessedAccount === null, JSON.stringify(guessedAccount));
  check(20, "[channel] Alice cannot obtain Bob's TRANSACTION by guessed id",
    guessedTxn === null, JSON.stringify(guessedTxn));
  check(21, "[channel] Alice cannot obtain Bob's DAILY BRIEF by guessed id — in a Space they SHARE",
    guessedBrief === null, JSON.stringify(guessedBrief));
  check(22, "[channel] Alice cannot obtain Bob's MEMORY by guessed id — in a Space they SHARE",
    guessedMemory === null, JSON.stringify(guessedMemory));

  const ownBrief = await tenant.withTenantDb("bob", (tx) =>
    tx.dailyBrief.findUnique({ where: { id: "brief_bob" } }));
  const ownMemory = await tenant.withTenantDb("bob", (tx) =>
    tx.spaceMemory.findUnique({ where: { id: "mem_bob" } }));
  check(23, "[channel] NOT VACUOUS — those rows exist and Bob reads both",
    ownBrief !== null && ownMemory !== null,
    `brief=${ownBrief !== null} memory=${ownMemory !== null}`);

  // ── [tool] THE MEMORY TOOL — AN INSTRUCTION TO ASSERT ABSENCE ──────────────
  const recall = tools.findTool("recall");
  if (!recall) throw new Error("the `recall` tool is not registered — the suite cannot run");

  /** ⚠️ ONE `tx` FOR BOTH CLIENTS. See lib/ai/absence.ts. */
  const runRecall = (userId: string, spaceId: string, args: Record<string, unknown> = {}) =>
    tenant.withTenantDb(userId, (tx) => recall.run(args, {
      spaceCtx: spaceCtx(userId, spaceId), spaceId,
      memoryClient: tx, readClient: tx, asOfISO: new Date().toISOString().slice(0, 10),
    } as never)) as Promise<Record<string, unknown>>;

  const recallAliceShared = await runRecall("alice", "space_s");
  const recallAliceOnBob  = await runRecall("alice", "space_b");
  const recallBobOwn      = await runRecall("bob", "space_b");

  const statedOf = (r: Record<string, unknown>) =>
    (r.stated as Array<{ subject: string }> | undefined) ?? [];
  check(24, "[tool] `recall` returns Alice's OWN memory in a shared Space and not Bob's",
    statedOf(recallAliceShared).some((x) => x.subject === "alice-goal")
      && !statedOf(recallAliceShared).some((x) => x.subject === "bob-goal"),
    JSON.stringify(statedOf(recallAliceShared).map((x) => x.subject)));
  const recallBobShared = await runRecall("bob", "space_s");
  check(24.5, "[tool] NOT VACUOUS — Bob reads HIS row in the same shared Space",
    statedOf(recallBobShared).some((x) => x.subject === "bob-goal")
      && !statedOf(recallBobShared).some((x) => x.subject === "alice-goal"),
    JSON.stringify(statedOf(recallBobShared).map((x) => x.subject)));
  check(25, "[tool] an EMPTY-BUT-OWNED memory store still says \"Say so plainly\"",
    statedOf(recallBobOwn).length === 0
      && /Say so plainly/.test(String(recallBobOwn.meaning))
      && recallBobOwn.evidenceState === "PROVEN_EMPTY",
    String(recallBobOwn.meaning).slice(0, 120));
  check(26, "[tool] a FOREIGN Space never produces the instruction to assert absence",
    statedOf(recallAliceOnBob).length === 0
      && !/Say so plainly/.test(String(recallAliceOnBob.meaning))
      && recallAliceOnBob.evidenceState === "INDETERMINATE",
    String(recallAliceOnBob.meaning).slice(0, 160));
  check(27, "[tool] …and it states the non-establishment instead",
    /could NOT be established/.test(String(recallAliceOnBob.meaning)),
    String(recallAliceOnBob.meaning).slice(0, 160));

  // ── [identity] A MODEL ARGUMENT CANNOT SELECT AN IDENTITY ──────────────────
  //
  // ⚠️ TWO HALVES. The SCHEMA half: no tool declares a user- or space-identity
  // parameter, so a model has nowhere to put one. The RUNTIME half: supplying one
  // anyway changes nothing, because the scope is read off the context.
  const identityKeys = /^(userId|user_id|ownerUserId|spaceId|space_id|identity|asUser|onBehalfOf)$/i;
  const offenders: string[] = [];
  for (const t of tools.TOOLS) {
    const props = ((t.parameters as { properties?: Record<string, unknown> }).properties) ?? {};
    for (const k of Object.keys(props)) if (identityKeys.test(k)) offenders.push(`${t.name}.${k}`);
  }
  check(28, "[identity] not one of the 20 tool schemas declares a user or Space identity parameter",
    offenders.length === 0, offenders.join(", "));

  const smuggled = await runRecall("alice", "space_s",
    { spaceId: "space_b", userId: "bob", ownerUserId: "bob" });
  check(29, "[identity] smuggled userId/spaceId arguments change NOTHING — the scope is the context's",
    JSON.stringify(statedOf(smuggled).map((x) => x.subject))
      === JSON.stringify(statedOf(recallAliceShared).map((x) => x.subject)),
    JSON.stringify(statedOf(smuggled).map((x) => x.subject)));

  const asBob = await tenant.withTenantDb("bob", async (tx) =>
    tenant.currentTenantIdentity(tx));
  const asAlice = await tenant.withTenantDb("alice", async (tx) =>
    tenant.currentTenantIdentity(tx));
  check(30, "[channel] the bound identity is the one passed, and it changes between phases",
    asBob === "bob" && asAlice === "alice", `${asBob} / ${asAlice}`);

  // ⚠️ POOL IDENTITY MUST NOT SURVIVE A PHASE. SET LOCAL is discarded at COMMIT
  // and at ROLLBACK; on the Transaction Pooler a leaked GUC is a cross-tenant read.
  const residue = await (dbMod.tenantDb as unknown as {
    $queryRawUnsafe: (q: string) => Promise<Array<{ v: string | null }>>;
  }).$queryRawUnsafe(`SELECT nullif(current_setting('app.user_id', true),'') AS v`);
  check(31, "[channel] no identity residue on the pooled connection between phases",
    (residue[0]?.v ?? null) === null, JSON.stringify(residue));

  let afterRollback: string | null = "never ran";
  try {
    await tenant.withTenantDb("alice", async (tx) => {
      await tx.space.findFirst({ where: { id: "space_a" } });
      throw new Error("deliberate");
    });
  } catch { /* expected */ }
  afterRollback = (await (dbMod.tenantDb as unknown as {
    $queryRawUnsafe: (q: string) => Promise<Array<{ v: string | null }>>;
  }).$queryRawUnsafe(`SELECT nullif(current_setting('app.user_id', true),'') AS v`))[0]?.v ?? null;
  check(32, "[channel] a FAILED phase leaves no identity residue either",
    afterRollback === null, String(afterRollback));

  // ── [phase] ONE TOOL CALL IS ONE TRANSACTION, AND IT ENDS ──────────────────
  const runner = phaseMod.aiPhaseRunner("alice");
  const inPhase = await runner.run("get_financial_snapshot", async (tx) =>
    tenant.currentTenantIdentity(tx));
  check(33, "[phase] the phase runner binds the authenticated identity",
    inPhase === "alice", String(inPhase));
  check(34, "[phase] the default budget is Prisma's 5 s, and only two paths are raised",
    phaseMod.phaseBudgetFor("get_financial_snapshot") === 5_000
      && phaseMod.phaseBudgetFor("reconcile_projection") === 26_000
      && phaseMod.phaseBudgetFor("project_cash") === 6_000,
    JSON.stringify({ d: phaseMod.phaseBudgetFor("get_financial_snapshot"),
                     r: phaseMod.phaseBudgetFor("reconcile_projection"),
                     p: phaseMod.phaseBudgetFor("project_cash") }));

  let nested = "no error";
  try {
    // A phase client has no `$transaction` in the TYPE; this proves the runtime
    // agrees, so a tool cannot widen its own authority at run time either.
    await runner.run("x", async (tx) =>
      (tx as unknown as { $transaction?: unknown }).$transaction === undefined
        ? "absent" : "PRESENT");
    nested = await runner.run("x", async (tx) =>
      (tx as unknown as { $transaction?: unknown }).$transaction === undefined
        ? "absent" : "PRESENT");
  } catch (e) { nested = e instanceof Error ? e.message : String(e); }
  check(35, "[phase] a tool inside a phase cannot open a transaction of its own",
    nested === "absent", nested);

  // ── [source] NO TRANSACTION SPANS A MODEL CALL ─────────────────────────────
  //
  // ⚠️ THE NEEDLE IS ESCAPED AND THE SCAN IS PROVEN TO GO RED. A previous scan in
  // this programme used `\b${name}\s*\(` with name = "$transaction"; `$` is
  // end-of-string, it matched nothing, and it reported clean over zero call sites.
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const TURN = read("lib/ai/conversation/turn.ts");

  /** The provider call. If this moves, the scan below must be rewritten, loudly. */
  const PROVIDER = /generateWithTools\s*\(/g;
  const providerCalls = TURN.match(PROVIDER)?.length ?? 0;
  check(36, "[source] the provider call is still exactly one site in the turn loop",
    providerCalls === 1, `${providerCalls} sites`);

  /**
   * The scan: the provider call must not be lexically inside a phase/transaction
   * block. Measured by bracket depth from the nearest opener rather than by
   * proximity, so a reformat cannot silently satisfy it.
   */
  const spansModelCall = (src: string): boolean => {
    const open = /(?:withTenantDb|runAiPhase|phase\.run|\$transaction)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = open.exec(src)) !== null) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") { depth--; if (depth === 0) break; }
      }
      const body = src.slice(m.index, i);
      if (/generateWithTools\s*\(/.test(body)) return true;
    }
    return false;
  };
  check(37, "[source] no tenant transaction lexically encloses the provider call",
    !spansModelCall(TURN));
  check(38, "[source] …and that scan goes RED when violated",
    spansModelCall("await withTenantDb(uid, async (tx) => { const o = await generateWithTools({}); });"),
    "the scan matched nothing — it would have reported clean over a real violation");

  const ABSENCE_SRC = read("lib/ai/absence.ts");
  const WIDER = /adjudicate(?:Absence|MemoryAbsence)\(\s*db\b/;
  check(39, "[source] the oracle is never handed the module-level `db` on the AI path",
    [ABSENCE_SRC, read("lib/ai/conversation/tools.ts"), read("lib/data/transaction-query.ts"),
     read("lib/ai/coverage-envelope.ts"), read("lib/ai/conversation/memory-tools.ts")]
      .every((s) => !WIDER.test(s))
      && WIDER.test("await adjudicateAbsence(db, spaceId)"));

  // ── [cost] THE PROBE IS A FAILURE-PATH COST, MEASURED ──────────────────────
  //
  // ⚠️ MEASURED AT THE ORACLE, NOT ESTIMATED, AND NOT AT THE DRIVER. `lib/db.ts`
  // does not enable Prisma's `query` event and is not ours to configure, so the
  // probe counts its own queries (`absenceProbesIssued`). The TRANSACTION count is
  // taken from Postgres itself, which is the other half of the claim: one phase is
  // one transaction.
  // ⚠️ AND NOT `pg_stat_database.xact_commit`, WHICH WAS TRIED FIRST AND MEASURED A
  // DELTA OF ZERO. PostgreSQL 16 caches the statistics snapshot
  // (`stats_fetch_consistency`), so a counter is exactly the kind of measurement
  // that reads clean while proving nothing. The transaction assertion below uses
  // `txid_current()` instead, which the transaction itself assigns.

  absence.resetAbsenceProbeCount();
  await tenant.withTenantDb("alice", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_a" }));
  const probesOnSuccess = absence.absenceProbesIssued();

  absence.resetAbsenceProbeCount();
  await tenant.withTenantDb("alice", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_empty" }));
  const probesOnEmpty = absence.absenceProbesIssued();

  absence.resetAbsenceProbeCount();
  await tenant.withTenantDb("alice", async (tx) => {
    await txq.transactionCorpusSpan(tx, { spaceId: "space_empty" });
    await txq.transactionCorpusSpan(tx, { spaceId: "space_empty" });
    await txq.transactionCorpusSpan(tx, { spaceId: "space_empty" });
    await envelope.loadCoverageEnvelope(tx, "space_empty");
  });
  const probesOnFourEmpties = absence.absenceProbesIssued();

  absence.resetAbsenceProbeCount();
  await tenant.withTenantDb("alice", async (tx) => {
    await envelope.loadCoverageEnvelope(tx, "space_a");
    await txq.transactionCorpusSpan(tx, { spaceId: "space_a" });
  });
  const probesOnFullPrologue = absence.absenceProbesIssued();

  console.log(`\n[cost] absence probes — success path=${probesOnSuccess} · one empty read=${probesOnEmpty}`
    + ` · FOUR empty reads in one phase=${probesOnFourEmpties} · prologue pair on a populated Space=${probesOnFullPrologue}`);

  check(40, "[cost] the absence probe adds ZERO queries on the success path",
    probesOnSuccess === 0 && probesOnFullPrologue === 0,
    `success=${probesOnSuccess} prologue=${probesOnFullPrologue}`);
  check(41, "[cost] one empty read costs exactly ONE probe",
    probesOnEmpty === 1, String(probesOnEmpty));
  check(42, "[cost] FOUR empty reads in one phase still cost ONE probe, not four",
    probesOnFourEmpties === 1, String(probesOnFourEmpties));

  // ── [phase] ONE PHASE IS ONE TRANSACTION — MEASURED AT THE SERVER ──────────
  //
  // ⚠️ THE TRANSACTION ID, NOT A STATISTICS COUNTER. The first attempt read
  // `pg_stat_database.xact_commit` and measured a delta of ZERO — PostgreSQL 16
  // caches the statistics snapshot (`stats_fetch_consistency`), so a counter is
  // exactly the kind of measurement that reads clean while proving nothing.
  // `txid_current()` is assigned by the transaction itself: distinct ids mean
  // distinct transactions, and an identical id across two reads means one.
  const xid = async (tx: { $queryRawUnsafe: (q: string) => Promise<Array<{ t: bigint }>> }) =>
    String((await tx.$queryRawUnsafe(`SELECT txid_current() AS t`))[0]?.t);

  const perPhase: string[] = [];
  for (let i = 0; i < 5; i++) {
    perPhase.push(await runner.run("get_financial_snapshot", (tx) => xid(tx as never)));
  }
  const withinOnePhase = await runner.run("get_financial_snapshot", async (tx) => {
    const a = await xid(tx as never);
    await (tx as never as { space: { findFirst: (a: unknown) => Promise<unknown> } })
      .space.findFirst({ where: { id: "space_a" }, select: { id: true } });
    const b = await xid(tx as never);
    return [a, b] as const;
  });

  console.log(`[phase] five phases → transaction ids ${perPhase.join(", ")}`);
  check(43, "[phase] five tool phases are FIVE distinct server transactions",
    new Set(perPhase).size === 5, perPhase.join(","));
  check(44, "[phase] …and two reads inside ONE phase share one transaction",
    withinOnePhase[0] === withinOnePhase[1], withinOnePhase.join(" vs "));
  check(45, "[phase] a tool phase does not reuse an earlier phase's transaction",
    !perPhase.includes(withinOnePhase[0]), withinOnePhase[0]);


  // ── [absence] THE TWO ARMS OF `Space` THAT ARE NOT MEMBERSHIP (RLS-AI-S10) ──
  //
  // ⚠️ THESE THREE CASES ARE THE REASON THE ORACLE CHANGED, AND THE THEOREM AUDIT
  // (lib/ai/evidence-authorities.test.ts) IS WHAT FOUND THEM. The probe used to
  // read `Space`; that policy ORs in `"isPublic" = true` and a platform-grant arm,
  // neither of which puts the Space in `fm_visible_space_ids()`, which is what
  // every child policy reads. So a non-member of a PUBLIC Space, and a member
  // whose membership was REVOKED, were both told PROVEN_EMPTY about evidence they
  // could not read — the exact false absence this whole contract exists to forbid.
  const oraclePublicNonMember = await tenant.withTenantDb("alice", (tx) =>
    absence.adjudicateAbsence(tx, "space_pub"));
  const oraclePublicOwner = await tenant.withTenantDb("bob", (tx) =>
    absence.adjudicateAbsence(tx, "space_pub"));
  const spanAliceOnPublic = await tenant.withTenantDb("alice", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_pub" }));
  const spanBobOnPublic = await tenant.withTenantDb("bob", (tx) =>
    txq.transactionCorpusSpan(tx, { spaceId: "space_pub" }));
  const spaceRowVisibleToAlice = await tenant.withTenantDb("alice", (tx) =>
    tx.space.findFirst({ where: { id: "space_pub" }, select: { id: true } }));

  check(46, "[absence] the `Space` ROW of a PUBLIC Space IS returned to a non-member — the premise",
    spaceRowVisibleToAlice !== null,
    "if this is null the isPublic arm is gone and cases 47-48 prove nothing");
  check(47, "[absence] …yet a PUBLIC Space Alice is NOT a member of is INDETERMINATE, never PROVEN_EMPTY",
    oraclePublicNonMember === "INDETERMINATE" && spanAliceOnPublic.absence === "INDETERMINATE",
    `oracle=${oraclePublicNonMember} span=${spanAliceOnPublic.absence}`);
  check(48, "[absence] NOT VACUOUS — the same Space is PROVEN/PRESENT for its own ACTIVE member",
    oraclePublicOwner === "PROVEN_EMPTY" && spanBobOnPublic.from !== null
      && spanBobOnPublic.absence === null,
    `oracle=${oraclePublicOwner} span=${JSON.stringify(spanBobOnPublic)}`);
  check(49, "[absence] a REMOVED membership is INDETERMINATE — the probe filters status ACTIVE",
    oraclePublicNonMember === "INDETERMINATE",
    "alice is a REMOVED member of space_pub; fm_visible_space_ids() requires ACTIVE");
  const oracleOwnerPublic = await absence.adjudicateAbsence(dbMod.db as never, "space_pub");
  check(50, "[absence] …and the MIGRATION PRINCIPAL still answers PROVEN_EMPTY — behaviour preserved",
    oracleOwnerPublic === "PROVEN_EMPTY", String(oracleOwnerPublic));

  // ── [envelope] UNDATED-BUT-EXISTING ROWS ARE NOT "NONE RECORDED" ────────────
  const envUndated = await tenant.withTenantDb("alice", (tx) =>
    envelope.loadCoverageEnvelope(tx, "space_undated"));
  const envMixed = await tenant.withTenantDb("alice", (tx) =>
    envelope.loadCoverageEnvelope(tx, "space_mixed"));

  check(51, "[envelope] rows that EXIST but carry no economic date are AVAILABLE, not NONE",
    envUndated.transactions.availability === "AVAILABLE"
      && envUndated.transactions.span.undatedCount === 2
      && envUndated.transactions.span.count === 0
      && envUndated.unavailability === null,
    JSON.stringify(envUndated.transactions));
  // ⚠️ THE ASSERTION IS ON THE CLAIM, NOT ON THE WORDS, AND THE FIRST DRAFT GOT
  // THAT WRONG: it forbade the substring "no transactions", which the
  // PROHIBITION itself contains ("Do not say the Space has no transactions"). A
  // presence-of-word marker cannot tell a citation from a denial — the recorded
  // erratum from the GPT-5.1 causal-evidence 2x2 (bb2f6ec), reproduced here in a
  // test rather than in a transcript.
  check(52, "[envelope] …and the model is NEVER told that Space has no transactions",
    !/none recorded/.test(say(envUndated))
      && /EXIST \(2 records\)/.test(say(envUndated))
      && /Do not say the Space has no transactions/.test(say(envUndated)),
    say(envUndated));
  check(53, "[envelope] a MIXED Space's count is the RANGE's own denominator, not the row total",
    envMixed.transactions.span.count === 1 && envMixed.transactions.span.undatedCount === 1
      && envMixed.transactions.span.fromISO !== null,
    JSON.stringify(envMixed.transactions.span));
  check(54, "[envelope] …and the undatable remainder is stated BESIDE the range, never inside it",
    /\(1 records\)/.test(say(envMixed)) && /PLUS 1 further record/.test(say(envMixed)),
    say(envMixed));

  // ⚠️ THE PROHIBITION MUST TRAVEL ON THE OBJECT, BECAUSE THE RENDERER IS NOT ON
  // THE LIVE PATH. `describeCoverageEnvelope` has no production caller: the shipped
  // A2 orientation serializes the ENVELOPE as JSON into the prompt. Every careful
  // sentence this module owns was therefore being tested on a code path the product
  // does not use — so the sentence is now a DERIVED field of the envelope itself.
  check(55, "[envelope] the SERIALIZED envelope carries the prohibition, not just the renderer",
    typeof envForeign.meaning === "string"
      && /COULD NOT BE ESTABLISHED/.test(envForeign.meaning)
      && /do not describe any record as empty/.test(envForeign.meaning)
      && JSON.stringify(envForeign).includes("COULD NOT BE ESTABLISHED"),
    String(envForeign.meaning).slice(0, 140));
  check(56, "[envelope] …the undated case too, and an ORDINARY envelope carries no notice at all",
    typeof envUndated.meaning === "string" && /carry no economic date/.test(envUndated.meaning)
      && envOwn.meaning === undefined,
    `${String(envUndated.meaning).slice(0, 100)} | own=${String(envOwn.meaning)}`);

  // ── [assembler] EVERY FINANCIAL ASSEMBLER IN A PHASE SHARES ONE AUTHORITY ───
  //
  // ⚠️ THE CLAIM IS THE WHOLE SLICE, SO IT IS MEASURED AT THE SERVER AND NOT READ
  // OFF THE SOURCE. `assembleFullContext` runs the four domains; a counting proxy
  // records every delegate read and `txid_current()` says which transaction each
  // one was in. One id across the lot is the sentence "all financial evidence for
  // this tenant phase was read under the authenticated caller's tenant authority".
  const evidenceMod = await import("@/lib/ai/conversation/evidence");

  /** Count delegate reads AND the transaction each happens in. */
  const instrument = (tx: object) => {
    let reads = 0;
    const proxy = new Proxy(tx, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof prop !== "string" || prop.startsWith("$") || typeof v !== "object" || v === null) {
          return typeof v === "function" ? v.bind(target) : v;
        }
        return new Proxy(v as object, {
          get(d, m, r) {
            const fn = Reflect.get(d, m, r);
            if (typeof fn !== "function") return fn;
            if (typeof m === "string" && /^(findMany|findFirst|findUnique|aggregate|groupBy|count)$/.test(m)) {
              return (...a: unknown[]) => { reads++; return (fn as (...x: unknown[]) => unknown).apply(d, a); };
            }
            return (fn as (...x: unknown[]) => unknown).bind(d);
          },
        });
      },
    });
    return { proxy: proxy as never, reads: () => reads };
  };

  const runner2 = phaseMod.aiPhaseRunner("alice");

  /**
   * A `PhasedRead` that is PRODUCTION'S OWN SHAPE — one short phase per part —
   * instrumented to record, per part, which server transaction it ran in and how
   * many delegate reads it made.
   *
   * ⚠️ THE FIRST VERSION OF THIS MEASURED THE WHOLE PROLOGUE IN ONE TRANSACTION
   * AND COMPARED IT TO A PER-DOMAIN BUDGET — 34 reads against a basis of 24 — so
   * it failed for the right reason and the wrong one at once. The prologue is NOT
   * one transaction (that shape measured 5,906 ms against the 5 s default and was
   * abandoned); the budget is per DOMAIN. Measuring the thing the budget is about
   * is the whole difference between a derivation and a number.
   */
  // ⚠️ THE TYPE IS IMPORTED, NOT NAMESPACED OFF THE DYNAMIC IMPORT. `phaseMod` is
  // a VALUE (the awaited module), so `phaseMod.PhasedRead` is not a type and tsc
  // said so — while tsx ran the file happily. A script that executes but does not
  // typecheck is a gate that drifts from the code it gates.
  const perPart = new Map<string, { xid: string; reads: number }>();
  const measuredRead = <T,>(part: string, fn: (c: never) => Promise<T>): Promise<T> =>
    runner2.run(phaseMod.prologuePhase(part), async (tx) => {
      const inst = instrument(tx as object);
      const id = await xid(tx as never);
      try { return await fn(inst.proxy); }
      finally { perPart.set(part, { xid: id, reads: inst.reads() }); }
    });

  const aliceCtxOwn = await evidenceMod.assembleFullContext(
    measuredRead as never, spaceCtx("alice", "space_a"), "agent_a");
  const alicePack = await evidenceMod.buildEvidence(
    measuredRead as never, phaseMod.phasedMemoryRead(runner2), "A2", aliceCtxOwn,
    spaceCtx("alice", "space_a"));

  const parts = [...perPart.entries()];
  const totalReads = parts.reduce((n, [, v]) => n + v.reads, 0);
  let heaviestPart = "none", heaviestReads = 0;
  for (const [k, v] of parts) if (v.reads > heaviestReads) { heaviestPart = k; heaviestReads = v.reads; }
  console.log(`[phase] prologue — ${parts.length} parts, ${totalReads} delegate reads total, `
    + `heaviest "${heaviestPart}" at ${heaviestReads}; transaction ids `
    + `${parts.map(([k, v]) => `${k}=${v.xid}`).join(" ")}`);

  check(57, "[phase] each prologue part is its OWN short transaction, and they are DISTINCT",
    parts.length >= 4 && new Set(parts.map(([, v]) => v.xid)).size === parts.length,
    parts.map(([k, v]) => `${k}=${v.xid}`).join(" "));
  check(58, "[phase] every financial assembler resolved through the PROPAGATED authority",
    totalReads > 10 && aliceCtxOwn.resolvedDomains.length >= 2
      && parts.some(([k]) => k === "accounts") && parts.some(([k]) => k === "coverage_census"),
    `${totalReads} reads via the propagated runner · domains=${aliceCtxOwn.resolvedDomains.join(",")}`
      + ` · parts=${parts.map(([k]) => k).join(",")}`);
  check(59, "[phase] …and the HEAVIEST single part fits the budget's DERIVED query basis",
    heaviestReads <= phaseMod.PROLOGUE_DOMAIN_QUERY_BASIS,
    `heaviest part "${heaviestPart}" made ${heaviestReads} reads; basis is `
      + `${phaseMod.PROLOGUE_DOMAIN_QUERY_BASIS}`);
  check(59.5, "[phase] a measured prologue produced a real orientation, not an empty one",
    /FINANCIAL ORIENTATION/.test(String(alicePack.body))
      && !/evidenceUnreadable/.test(String(alicePack.body)),
    String(alicePack.body).slice(0, 140));

  // ── [channel] ALICE CANNOT OBSERVE BOB'S SPACE THROUGH THE REAL ASSEMBLERS ──
  const aliceOnBobCtx = await evidenceMod.assembleFullContext(
    phaseMod.phasedReads(runner2), spaceCtx("alice", "space_b"), "agent_a");
  const bobOwnCtx = await evidenceMod.assembleFullContext(
    phaseMod.phasedReads(phaseMod.aiPhaseRunner("bob")), spaceCtx("bob", "space_b"), "agent_a");
  const serialized = JSON.stringify(aliceOnBobCtx.domains);
  check(60, "[channel] Alice's assembled context for Bob's Space carries NONE of Bob's figures",
    !serialized.includes("Bob Checking") && !serialized.includes("Rent")
      && !/\b-?50\b/.test(serialized),
    serialized.slice(0, 220));
  check(61, "[channel] NOT VACUOUS — the SAME assembler gives Bob his own account for that Space",
    JSON.stringify(bobOwnCtx.domains).includes("Bob Checking"),
    JSON.stringify(bobOwnCtx.domains).slice(0, 200));

  // ── [evidence] AN ASSEMBLER EXCEPTION IS NOT EMPTY EVIDENCE ─────────────────
  //
  // ⚠️ A FAILURE AND AN EMPTY SPACE MUST NOT PRODUCE THE SAME PROMPT. The
  // exception is injected by handing the assemblers a client whose ONE delegate
  // throws, which is the realistic shape (a dropped connection, a P2028, a
  // revoked grant) and not a stub of the assembler itself.
  const exploding = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      if (prop.startsWith("$")) return () => { throw new Error("injected authority failure"); };
      return new Proxy({}, { get: () => () => Promise.reject(new Error("injected authority failure")) });
    },
  }) as never;
  const brokenCtx = await evidenceMod.assembleFullContext(
    phaseMod.onClient(exploding), spaceCtx("alice", "space_a"), "agent_a");
  check(62, "[evidence] every failed assembler is NAMED, not silently absent",
    (brokenCtx.unreadableDomains ?? []).length === 4
      && Object.keys(brokenCtx.domains).length === 0,
    JSON.stringify(brokenCtx.unreadableDomains));

  const brokenPack = await evidenceMod.buildEvidence(
    phaseMod.onClient(exploding), (fn) => fn(exploding), "A2", brokenCtx,
    spaceCtx("alice", "space_a"));
  const brokenBody = String(brokenPack.body);
  check(63, "[evidence] the ORIENTATION states the failure and FORBIDS the absence answer",
    /evidenceUnreadable/.test(brokenBody)
      && /"evidenceState": "INDETERMINATE"/.test(brokenBody)
      && /NOT because the Space has none/.test(brokenBody),
    brokenBody.slice(0, 200));
  check(64, "[evidence] …and it NEVER says the Space is empty, zero or has none",
    !/none recorded/.test(brokenBody) && !/no transactions/i.test(brokenBody),
    brokenBody.slice(0, 200));

  check(64.5, "[evidence] a failed MEMORY read is a NAMED domain, not a thrown turn",
    (brokenPack.body ?? '').includes('"memory"')
      && /"domains": \[\s*"accounts",\s*"holdings_summary",\s*"memory"/.test(brokenBody),
    brokenBody.slice(brokenBody.indexOf('evidenceUnreadable'), brokenBody.indexOf('evidenceUnreadable') + 220));

  const healthyPack = await evidenceMod.buildEvidence(
    phaseMod.phasedReads(runner2), phaseMod.phasedMemoryRead(runner2), "A2",
    await evidenceMod.assembleFullContext(
      phaseMod.phasedReads(runner2), spaceCtx("alice", "space_a"), "agent_a"),
    spaceCtx("alice", "space_a"));
  check(65, "[evidence] NOT VACUOUS — a HEALTHY prologue carries no unreadable block at all",
    !/evidenceUnreadable/.test(String(healthyPack.body))
      && /FINANCIAL ORIENTATION/.test(String(healthyPack.body)),
    String(healthyPack.body).slice(0, 120));

  // ── [source] THE FLIP IS ARMED, AND NOTHING SPANS THE MODEL CALL ────────────
  const ROUTE = read("app/api/ai/chat/route.ts");
  check(66, "[source] the product chat route hands the turn an AUTHENTICATED phase runner",
    /aiPhaseRunner\(user\.id\)/.test(ROUTE) && /\n\s+phase,/.test(ROUTE),
    "the flip is not wired");
  check(67, "[source] …and the identity comes from the session, never from the request",
    !/aiPhaseRunner\(\s*(?:parsed|body|req|asked|history)/.test(ROUTE));
  const ENGINE = read("lib/ai/conversation/engine.ts");
  check(68, "[source] no tenant transaction lexically encloses the provider call in the ENGINE either",
    !spansModelCall(ENGINE) && !spansModelCall(read("lib/ai/conversation/tools.ts")));
  check(69, "[source] the global interactive-transaction timeout is NOT raised anywhere",
    ![read("lib/db.ts"), read("lib/db/tenant-context.ts")]
      .some((src) => /transactionOptions/.test(src)),
    "a raised global default is what makes a whole-turn transaction shippable by accident");

  const failed = report("RLS AI-SURFACE ADVERSARIAL SUITE");
  teardownHarness(KEEP);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("\n[rls-ai] FATAL:", e);
  teardownHarness(KEEP);
  process.exit(1);
});
