/**
 * scripts/rls-foreground-acceptance.ts  (RLS-PREP-C)
 *
 * THE CONVERTED FOREGROUND FINANCIAL PATHS, ATTACKED ON A REAL fm_app ROLE.
 *
 * RLS-PREP-C moved the authenticated foreground financial operations that still
 * executed as the migration principal onto the tenant role: transaction
 * correction, CSV import (preview and commit), wallet add, the FICO write, the
 * Investments workspace read, the Connections page and its poller, the Plaid
 * routes' own item lookups, and the wealth-timeline amendment. A conversion is
 * only worth what an attack on it shows, so this suite does not ask whether
 * those paths WORK — the unit suites and the product do that. It asks the three
 * questions a conversion can get wrong while still working:
 *
 *   1. CROSS-TENANT.  Can Bob read or write Alice's rows through the SAME
 *      functions and statements the converted routes now execute?
 *   2. SILENT REFUSAL. When the policy refuses a converted WRITE, does the
 *      caller get an error — or a calm zero that reads as success?
 *   3. THE BINDING.   Is the authority these ran under really fm_app? The
 *      deployed-authority report (RLS-PREP-B) is exercised here against real
 *      roles, and against an impostor, because a verifier nobody has pointed at
 *      a real database is itself only a claim.
 *
 * ⚠️ WHY SERVICE FUNCTIONS AND STATEMENTS, NOT HTTP. A Next route handler cannot
 * be invoked from a script: `headers()` needs the request store. So each case
 * runs what the route runs — the same library function, or the identical
 * statement on the same kind of client — inside the same `withTenantDb` phase,
 * as an adversary. The route-shaped half (does the route actually CALL these on
 * a tenant client, and import no owner client) is pinned by the source scans at
 * the end and by scripts/audit-db-authority.ts. The deployed half is the
 * acceptance plan in docs/operations/rls-preview-cutover.md.
 *
 *   npm run rls:accept:foreground
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  prepareHarness, assertTenantClientBound, teardownHarness, psql, makeRecorder, APP_FIXTURES,
} from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

/** Extra rows the converted paths need that the shared fixtures do not carry. */
const EXTRA_FIXTURES = `
insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","walletAddress","walletChain","deletedAt","updatedAt") values
  ('wallet_alice_archived','Alice Ledger','crypto','Self-custodied','USER','alice','bc1qalicearchived','BTC',now(),now());

insert into "ImportMappingProfile" (id,"spaceId",name,source,mapping,"createdByUserId","updatedAt") values
  ('prof_alice','space_a','Alice bank','CSV','{"date":"Date"}'::jsonb,'alice',now());

insert into "Merchant" (id,"canonicalKey","displayName","updatedAt") values
  ('m_coffee','coffee','Coffee',now());
update "Transaction" set "merchantId" = 'm_coffee' where id = 'tx_alice_1';
`;

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ");
/** A refusal that RAISED: a policy violation, or Prisma's "no row matched" on a keyed write. */
const raisedRefusal = (m: string) => /row-level security|P2025|No record was found|Record to update not found|required but not found/i.test(m);

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: errText(e) }; }
}

async function main(): Promise<void> {
  console.log("\n=== RLS FOREGROUND-PATH ADVERSARIAL SUITE ===\n");

  const h = prepareHarness("rlsfg");
  await assertTenantClientBound();
  const seed = psql(h.ownerUrl, APP_FIXTURES + EXTRA_FIXTURES);
  if (!seed.ok) throw new Error(`fixture seed failed: ${seed.err}`);
  console.log("[rls] Alice / Bob fixtures seeded.\n");

  /** Owner-side truth, for asserting that a refused write left the row alone. */
  const truth = (sql: string) => psql(h.ownerUrl, sql).out.trim();

  // Imported ONLY now — lib/db.ts binds its clients at module load.
  const dbMod = await import("@/lib/db");
  const { withTenantDb } = await import("@/lib/db/tenant-context");
  const as = <T,>(userId: string, fn: Parameters<typeof withTenantDb<T>>[1]) => withTenantDb(userId, fn);

  // ════════════════════════════════════════════════════════════════════════
  // B. THE DEPLOYED-AUTHORITY REPORT, AGAINST REAL ROLES
  // ════════════════════════════════════════════════════════════════════════
  const authority = await import("@/lib/platform/db-authority");
  const live = await authority.getDbAuthorityReport("alice");
  check(1, "[authority] on three real roles the deployed-authority report is OK — each connection asked through itself",
    live.ok && live.strict && live.roles.every((r) => r.bound && r.verdict?.ok)
    && live.roles.map((r) => r.verdict?.actual).join() === "fm_app,fm_auth,fm_system",
    JSON.stringify(live));
  check(2, "[authority] the tenant channel binds inside a transaction and leaves NO residue on the pooled connections after it",
    live.tenantChannel.boundInsideTransaction === true && live.tenantChannel.residueObserved === 0
    && live.tenantChannel.residueSamples >= 8, JSON.stringify(live.tenantChannel));
  check(3, "[authority] the report reads the installed posture as fm_app: every RLS table is forced and policies exist",
    (live.rls.policies ?? 0) > 100 && live.rls.rlsEnabled === live.rls.rlsForced && (live.rls.rlsEnabled ?? 0) >= 50,
    JSON.stringify(live.rls));

  // The impostor: DATABASE_URL_APP "is" fm_app by name, and the client behind it
  // is the OWNER. This is the state strict mode's boot check cannot see.
  const impostor = await authority.buildDbAuthorityReport({
    env: process.env,
    clients: { ...dbMod.configuredRoleClients(), DATABASE_URL_APP: dbMod.db },
    probeUserId: "alice",
    readIdentityInsideTenantTransaction: (u) => withTenantDb(u, async (tx) => {
      const r = await tx.$queryRaw<Array<{ v: string | null }>>`SELECT nullif(current_setting('app.user_id', true), '') AS v`;
      return r[0]?.v ?? null;
    }),
  });
  const impostorApp = impostor.roles.find((r) => r.variable === "DATABASE_URL_APP");
  check(4, "[authority] an fm_app slot actually bound to the OWNER is reported NOT OK — though the URL and strict config are clean",
    !impostor.ok && impostor.configProblems.length === 0
    && impostorApp?.verdict?.actual !== "fm_app" && (impostorApp?.problems.length ?? 0) >= 2,
    JSON.stringify(impostorApp));

  const serialised = JSON.stringify([live, impostor]);
  const secrets = [h.appUrl, h.authUrl, h.systemUrl, h.ownerUrl].flatMap((u) => { const x = new URL(u); return [x.password, u]; });
  check(5, "[authority] neither report contains a password, a connection string or a host",
    secrets.every((s) => !serialised.includes(s)) && !/postgres(ql)?:\/\//.test(serialised) && !serialised.includes("127.0.0.1"),
    "a secret or a URL appeared in the report");

  console.log("\n--- example deployed-authority report (sanitised by construction) ---");
  console.log(JSON.stringify(live, null, 2));
  console.log("--- end example ---\n");

  // ════════════════════════════════════════════════════════════════════════
  // C1. TRANSACTION CORRECTION  (POST /api/transactions/[id]/correct)
  // ════════════════════════════════════════════════════════════════════════
  const corrections = await import("@/lib/transactions/merchant-corrections");
  const { transactionDetailWhere } = await import("@/lib/transactions/detail-query");
  const ROW_SELECT = {
    id: true, merchant: true, description: true, category: true, amount: true, merchantId: true,
    categorySource: true, merchantEntityId: true, pfcPrimary: true, pfcDetailed: true,
    pfcConfidenceLevel: true, flowAuthority: true,
  } as const;
  const ACCT = { accountType: "checking", debtSubtype: null };

  // The route's row load, as Bob, naming Alice's transaction and HER Space.
  const bobLoad = await as("bob", (tx) => tx.transaction.findFirst({ where: transactionDetailWhere("tx_alice_1", "space_a"), select: { id: true } }));
  check(6, "[correct] Bob's row load for Alice's transaction — in HER Space id — finds nothing (the route answers 404)",
    bobLoad === null, JSON.stringify(bobLoad));

  // Bob has the row's contents from elsewhere and skips the load. Every write must RAISE.
  const aliceRow = await as("alice", (tx) => tx.transaction.findUniqueOrThrow({ where: { id: "tx_alice_1" }, select: ROW_SELECT }));
  const before = truth(`select category||'|'||coalesce("categorySource"::text,'-') from "Transaction" where id='tx_alice_1'`);

  const bobOverride = await attempt(() => as("bob", (tx) => corrections.applyTransactionOverride(tx, aliceRow, ACCT, "Travel")));
  check(7, "[correct] Bob's OVERRIDE of Alice's row RAISES — a refused write is an error, never a calm zero",
    !bobOverride.ok && raisedRefusal(bobOverride.error), bobOverride.ok ? "it returned" : bobOverride.error.slice(0, 160));

  const bobRule = await attempt(() => as("bob", (tx) => corrections.applyCategoryRuleCorrection(tx, aliceRow, ACCT, "bob", "Travel")));
  const bobRules = truth(`select count(*) from "MerchantRule" where "ownerUserId"='bob'`);
  check(8, "[correct] Bob's CATEGORY RULE against Alice's row RAISES, and the rule it minted first is ROLLED BACK with it (one phase, all six seams)",
    !bobRule.ok && raisedRefusal(bobRule.error) && bobRules === "0",
    `${bobRule.ok ? "it returned" : bobRule.error.slice(0, 120)} · bob rules=${bobRules}`);

  const bobMerchant = await attempt(() => as("bob", (tx) =>
    corrections.applyMerchantIdentityCorrection(tx, aliceRow, { kind: "select", merchantId: "m_coffee" })));
  check(9, "[correct] Bob's MERCHANT correction of Alice's row RAISES",
    !bobMerchant.ok && raisedRefusal(bobMerchant.error), bobMerchant.ok ? "it returned" : bobMerchant.error.slice(0, 160));

  const after = truth(`select category||'|'||coalesce("categorySource"::text,'-') from "Transaction" where id='tx_alice_1'`);
  check(10, "[correct] after three refused corrections Alice's row is byte-for-byte what it was",
    before === after, `before=${before} after=${after}`);

  const aliceOverride = await attempt(() => as("alice", (tx) => corrections.applyTransactionOverride(tx, aliceRow, ACCT, "Travel")));
  const aliceAfter = truth(`select category||'|'||"categorySource" from "Transaction" where id='tx_alice_1'`);
  check(11, "[correct] the LEGITIMATE correction still lands on the tenant role — so 6–10 are refusals, not a broken path",
    aliceOverride.ok && aliceAfter === "Travel|USER_OVERRIDE", `${aliceOverride.ok ? "" : aliceOverride.error} row=${aliceAfter}`);

  // ════════════════════════════════════════════════════════════════════════
  // C2. CSV IMPORT  (POST /api/accounts/[id]/import and …/preview)
  // ════════════════════════════════════════════════════════════════════════
  const csv = await import("@/lib/imports/csv");
  const today = new Date(truth(`select current_date::text`) + "T00:00:00.000Z");

  // Alice's row tx_alice_2 is (acct_alice, today, -20, "Books"). An honest
  // classifier says MATCH. Bob, naming her account, must learn nothing.
  const aliceClass = await as("alice", (tx) => csv.resolveFingerprintOutcome("acct_alice", today, -20, "Books", null, null, tx));
  const bobClass   = await as("bob",   (tx) => csv.resolveFingerprintOutcome("acct_alice", today, -20, "Books", null, null, tx));
  check(12, "[import] the duplicate-detection read is tenant-blind: Alice gets MATCH, Bob naming her account gets CREATE — no existence oracle",
    aliceClass.outcome === "MATCH" && bobClass.outcome === "CREATE", `alice=${aliceClass.outcome} bob=${bobClass.outcome}`);

  const bobBatch = await attempt(() => as("bob", (tx) => tx.importBatch.create({
    data: { financialAccountId: "acct_alice", createdByUserId: "bob", source: "CSV", status: "PROCESSING", rowCount: 1 },
  })));
  check(13, "[import] Bob cannot open an ImportBatch on Alice's account — the INSERT RAISES",
    !bobBatch.ok && /row-level security/i.test(bobBatch.error), bobBatch.ok ? "it was created" : bobBatch.error.slice(0, 160));

  const bobRow = await attempt(() => as("bob", (tx) => tx.transaction.create({
    data: { financialAccountId: "acct_alice", date: today, merchant: "Planted", category: "Other", amount: -1, pending: false },
    select: { id: true },
  })));
  const planted = truth(`select count(*) from "Transaction" where merchant='Planted'`);
  check(14, "[import] Bob cannot import a row INTO Alice's account — the create RAISES and nothing is written",
    !bobRow.ok && /row-level security/i.test(bobRow.error) && planted === "0", `${bobRow.ok ? "created" : ""} planted=${planted}`);

  const bobUpdate = await attempt(() => as("bob", (tx) => tx.transaction.update({ where: { id: "tx_alice_2" }, data: { amount: -999 } })));
  const aliceAmount = truth(`select amount from "Transaction" where id='tx_alice_2'`);
  check(15, "[import] update-on-match against Alice's row RAISES for Bob (the route counts it FAILED, never imported) and her amount is intact",
    !bobUpdate.ok && raisedRefusal(bobUpdate.error) && Number(aliceAmount) === -20, `${bobUpdate.ok ? "updated" : ""} amount=${aliceAmount}`);

  const bobProfileRead = await as("bob", (tx) => tx.importMappingProfile.findMany({ where: { spaceId: "space_a" }, select: { id: true } }));
  const bobProfileBump = await attempt(() => as("bob", (tx) => tx.importMappingProfile.update({ where: { id: "prof_alice" }, data: { useCount: { increment: 1 } } })));
  check(16, "[import] Bob cannot read or bump a saved mapping profile of Alice's Space",
    bobProfileRead.length === 0 && !bobProfileBump.ok && raisedRefusal(bobProfileBump.error),
    `read=${bobProfileRead.length} ${bobProfileBump.ok ? "bumped" : ""}`);

  const aliceBatch = await attempt(() => as("alice", async (tx) => {
    const batch = await tx.importBatch.create({
      data: { financialAccountId: "acct_alice", createdByUserId: "alice", source: "CSV", status: "PROCESSING", rowCount: 1 },
      select: { id: true },
    });
    const row = await tx.transaction.create({
      data: { financialAccountId: "acct_alice", date: today, merchant: "Imported", category: "Other", amount: -3, pending: false, importBatchId: batch.id },
      select: { id: true },
    });
    await tx.importBatch.update({ where: { id: batch.id }, data: { importedCount: 1, status: "COMPLETED", completedAt: new Date() } });
    return row.id;
  }));
  check(17, "[import] Alice's own import (batch → row → finalise) runs end to end on the tenant role",
    aliceBatch.ok, aliceBatch.ok ? "" : aliceBatch.error.slice(0, 200));

  // ════════════════════════════════════════════════════════════════════════
  // C3. WALLET ADD  (POST /api/accounts/wallet)
  // ════════════════════════════════════════════════════════════════════════
  const { dualWriteSpaceAccountLink } = await import("@/lib/accounts/space-account-link");
  const { persistAccountSpine } = await import("@/lib/accounts/persist-account-spine");

  const bobFindsAlice = await as("bob", (tx) => tx.financialAccount.findFirst({
    where: { ownerUserId: "alice", walletAddress: "bc1qalicearchived" }, select: { id: true },
  }));
  check(18, "[wallet] Bob's lookup for Alice's wallet address — with HER id in the where clause — finds nothing",
    bobFindsAlice === null, JSON.stringify(bobFindsAlice));

  const bobForAlice = await attempt(() => as("bob", (tx) => tx.financialAccount.create({
    data: { ownerType: "USER", ownerUserId: "alice", name: "Planted wallet", type: "crypto", institution: "Self-custodied",
            balance: 0, currency: "USD", walletAddress: "bc1qplanted", walletChain: "BTC" },
  })));
  check(19, "[wallet] Bob cannot create a wallet OWNED BY Alice — the INSERT RAISES",
    !bobForAlice.ok && /row-level security/i.test(bobForAlice.error), bobForAlice.ok ? "created" : bobForAlice.error.slice(0, 160));

  const bobReactivates = await attempt(() => as("bob", (tx) => tx.financialAccount.update({
    where: { id: "wallet_alice_archived" }, data: { deletedAt: null, syncStatus: "pending" },
  })));
  const stillArchived = truth(`select ("deletedAt" is not null)::text from "FinancialAccount" where id='wallet_alice_archived'`);
  check(20, "[wallet] Bob cannot REACTIVATE Alice's archived wallet — the update RAISES and it stays archived",
    !bobReactivates.ok && raisedRefusal(bobReactivates.error) && stillArchived === "true",
    `${bobReactivates.ok ? "reactivated" : ""} archived=${stillArchived}`);

  // A forged active-Space cookie: Bob links HIS OWN account into Alice's Space.
  const linkArgs = (spaceId: string, financialAccountId: string, userId: string) => ({
    spaceId, financialAccountId,
    create: { addedByUserId: userId, visibilityLevel: "FULL" as const, status: "ACTIVE" as const },
    update: { status: "ACTIVE" as const, revokedAt: null, revokedByUserId: null },
  });
  const bobPlantsLink = await attempt(() => as("bob", (tx) => dualWriteSpaceAccountLink(tx, linkArgs("space_a", "acct_bob", "bob"))));
  const plantedLinks = truth(`select count(*) from "SpaceAccountLink" where "spaceId"='space_a' and "financialAccountId"='acct_bob'`);
  check(21, "[wallet] Bob cannot plant a link into ALICE'S Space (the forged-active-Space case) — it RAISES and no link exists",
    !bobPlantsLink.ok && plantedLinks === "0", `${bobPlantsLink.ok ? "linked" : bobPlantsLink.error.slice(0, 100)} links=${plantedLinks}`);

  const bobOwnWallet = await attempt(() => as("bob", async (tx) => {
    const fa = await tx.financialAccount.create({
      data: { ownerType: "USER", ownerUserId: "bob", createdByUserId: "bob", name: "Bob Ledger", type: "crypto",
              institution: "Self-custodied", balance: 0, currency: "USD", walletAddress: "bc1qbob", walletChain: "BTC",
              nativeBalance: 0, syncStatus: "pending" },
    });
    await persistAccountSpine({
      financialAccountId: fa.id, spaceId: "space_b", addedByUserId: "bob", creatorUserId: "bob",
      connection: { connectedByUserId: "bob", syncStatus: "pending" }, client: tx,
    });
    return fa.id;
  }));
  const bobSpine = bobOwnWallet.ok
    ? truth(`select (select count(*) from "AccountConnection" where "financialAccountId"='${bobOwnWallet.value}')||'|'||
                    (select count(*) from "SpaceAccountLink" where "financialAccountId"='${bobOwnWallet.value}' and "spaceId"='space_b' and status='ACTIVE')`)
    : "";
  check(22, "[wallet] Bob's OWN wallet (account + connection + link) commits in ONE tenant phase",
    bobOwnWallet.ok && bobSpine === "1|1", bobOwnWallet.ok ? `spine=${bobSpine}` : bobOwnWallet.error.slice(0, 200));

  // ════════════════════════════════════════════════════════════════════════
  // C4. FICO  (PATCH /api/credit/update-fico)
  // ════════════════════════════════════════════════════════════════════════
  const bobFico = await attempt(() => as("bob", (tx) => tx.creditScore.create({ data: { userId: "alice", score: 300, source: "manual" } })));
  const aliceFico = await attempt(() => as("alice", (tx) => tx.creditScore.create({ data: { userId: "alice", score: 780, source: "manual" } })));
  const scores = truth(`select string_agg(score::text, ',' order by score) from "CreditScore" where "userId"='alice'`);
  check(23, "[fico] Bob cannot record a score FOR Alice (RAISES); Alice's own write lands; only hers exists",
    !bobFico.ok && /row-level security/i.test(bobFico.error) && aliceFico.ok && scores === "780",
    `${bobFico.ok ? "bob wrote" : ""} scores=${scores}`);

  // ════════════════════════════════════════════════════════════════════════
  // C5. CONNECTIONS PAGE + /api/sync/status
  // ════════════════════════════════════════════════════════════════════════
  const connections = await import("@/lib/connections/space-data");
  const aliceConn = await as("alice", (tx) => connections.loadConnectionsSpaceData(tx, "alice"));
  // The attack this conversion exists for: the loader's ONLY boundary used to be
  // the `userId` argument. Bob's session, Alice's id.
  const bobAsAlice = await as("bob", (tx) => connections.loadConnectionsSpaceData(tx, "alice"));
  const bobPoll    = await as("bob", (tx) => connections.loadConnectionsSyncStatus(tx, "alice"));
  check(24, "[connections] Alice sees her connection; the SAME loader run in Bob's session with ALICE'S userId returns none of hers",
    aliceConn.status.connections.some((c) => c.id === "pi_alice")
    && bobAsAlice.status.connections.length === 0 && Object.keys(bobAsAlice.accountsByConnectionId).length === 0
    && bobPoll.status.connections.length === 0,
    `alice=${aliceConn.status.connections.map((c) => c.id).join()} bobAsAlice=${bobAsAlice.status.connections.length}`);

  // ════════════════════════════════════════════════════════════════════════
  // C6. PLAID ROUTES' OWN LOOKUPS  (sync / refresh / resume-sync / link-token / investments-enable)
  // ════════════════════════════════════════════════════════════════════════
  const bobItem = await as("bob", (tx) => tx.plaidItem.findFirst({
    where: { id: "pi_alice", userId: "alice", status: "ACTIVE" }, select: { id: true, encryptedToken: true },
  }));
  check(25, "[plaid] Bob's item lookup naming Alice's item AND her userId finds nothing — her encrypted token is not readable",
    bobItem === null, bobItem ? "returned a row" : "");

  const bobRearm = await attempt(() => as("bob", (tx) => tx.plaidItem.update({ where: { id: "pi_alice" }, data: { syncIncompleteAt: new Date() } })));
  const aliceMarker = truth(`select ("syncIncompleteAt" is null)::text from "PlaidItem" where id='pi_alice'`);
  check(26, "[plaid] resume-sync's marker write against Alice's item RAISES for Bob (not a silent zero) and her marker is untouched",
    !bobRearm.ok && raisedRefusal(bobRearm.error) && aliceMarker === "true", `${bobRearm.ok ? "updated" : ""} markerNull=${aliceMarker}`);

  const bobConnCred = await as("bob", (tx) => tx.connection.findFirst({ where: { userId: "alice" }, select: { credential: true } }));
  check(27, "[plaid] link-token's Connection credential lookup for Alice returns nothing to Bob", bobConnCred === null);

  // ════════════════════════════════════════════════════════════════════════
  // C7. WEALTH AMENDMENT  (POST /api/spaces/[id]/wealth/amend)
  // ════════════════════════════════════════════════════════════════════════
  const amend = await import("@/lib/snapshots/snapshot-amendment");
  let engineTouched = false;
  const engineSpy = new Proxy({}, { get: () => { engineTouched = true; return () => { throw new Error("engine reached"); }; } }) as never;
  const window = truth(`select (current_date - 3)::text||'|'||(current_date - 1)::text`).split("|");
  const amendReq = (userId: string, spaceId: string, accountId: string) => ({
    spaceId, financialAccountId: accountId, kind: "ACCOUNT_ADDED_RETROACTIVE" as const,
    fromDate: window[0], toDate: window[1], requestedByUserId: userId,
    tenant: <T,>(fn: Parameters<typeof withTenantDb<T>>[1]) => withTenantDb(userId, fn),
  });

  const bobAmend = await attempt(() => amend.applyAmendment({ ...amendReq("bob", "space_a", "acct_alice"), engine: engineSpy }));
  const bobPreview = await attempt(() => amend.previewAmendment({ ...amendReq("bob", "space_a", "acct_alice"), engine: engineSpy }));
  const amendRows = truth(`select count(*) from "SnapshotAmendment" where "spaceId"='space_a'`);
  check(28, "[amend] Bob amending ALICE'S Space fails at the tenant gate as 'not found', authors NO amendment row, and the fm_system engine is NEVER reached",
    !bobAmend.ok && /not found/i.test(bobAmend.error) && !bobPreview.ok && /not found/i.test(bobPreview.error)
    && amendRows === "0" && !engineTouched,
    `apply=${bobAmend.ok ? "ran" : bobAmend.error.slice(0, 60)} rows=${amendRows} engineTouched=${engineTouched}`);

  // Bob IS a member of the SHARED Space — the gate must refuse on the product
  // rule, still before the engine.
  const bobShared = await attempt(() => amend.applyAmendment({ ...amendReq("bob", "space_s", "acct_shared"), engine: engineSpy }));
  check(29, "[amend] in a Space Bob CAN see, the product rule (PERSONAL only) still refuses before the engine",
    !bobShared.ok && /SharedSpaceAmendmentError|shared/i.test(bobShared.error) && !engineTouched, bobShared.ok ? "ran" : bobShared.error.slice(0, 120));

  // The legitimate path, END TO END, with the REAL engine on fm_system and the
  // amendment's own records written as Alice.
  const aliceAmend = await attempt(() => amend.applyAmendment(amendReq("alice", "space_a", "acct_alice")));
  const amendState = truth(`select coalesce((select status::text||'|'||("auditLogId" is not null)::text from "SnapshotAmendment" where "spaceId"='space_a' limit 1),'none')`);
  const amendAudit = truth(`select count(*) from "AuditLog" where action='SNAPSHOT_AMENDMENT_APPLIED' and "userId"='alice' and "spaceId"='space_a'`);
  check(30, "[amend] Alice's own amendment completes: gate + PENDING as fm_app, regeneration as fm_system, breakdown + audit + APPLIED as fm_app",
    aliceAmend.ok && amendState === "APPLIED|true" && amendAudit === "1",
    `${aliceAmend.ok ? "" : aliceAmend.error.slice(0, 200)} state=${amendState} audit=${amendAudit}`);

  // ════════════════════════════════════════════════════════════════════════
  // C8. INVESTMENTS WORKSPACE  (GET /api/spaces/[id]/investments/space-data)
  // ════════════════════════════════════════════════════════════════════════
  // Give Alice one observed position, then read her Space as each of them.
  const posSeed = psql(h.ownerUrl, `
    insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","updatedAt")
      values ('acct_alice_brk','Alice Brokerage 2','investment','TestBroker','USER','alice',now());
    insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"visibilityLevel","updatedAt")
      values ('l_abrk','space_a','acct_alice_brk','HOME','ACTIVE','FULL',now());
    insert into "Instrument" (id,"tickerSymbol",name,currency,"assetClass","updatedAt")
      values ('inst_fg','FGTEST','FG Test','USD','EQUITY',now());
    insert into "PositionObservation" (id,"financialAccountId","instrumentId",date,origin,source,quantity,currency)
      values ('po_fg','acct_alice_brk','inst_fg',current_date,'OBSERVED','plaid',10,'USD');`);
  if (!posSeed.ok) throw new Error(`position fixture failed: ${posSeed.err}`);
  const inv = await import("@/lib/investments/space-data");
  const aliceInv = await attempt(() => as("alice", (tx) => inv.loadInvestmentsSpaceData({ spaceId: "space_a" }, { client: tx })));
  const bobInv   = await attempt(() => as("bob",   (tx) => inv.loadInvestmentsSpaceData({ spaceId: "space_a" }, { client: tx })));
  const rowsOf = (r: typeof aliceInv) => (r.ok ? JSON.stringify(r.value).includes("FGTEST") : false);
  check(31, "[investments] the workspace loader on the tenant role shows Alice her position and shows Bob — naming HER Space — none of it",
    aliceInv.ok && bobInv.ok && rowsOf(aliceInv) && !rowsOf(bobInv),
    `alice=${aliceInv.ok ? rowsOf(aliceInv) : aliceInv.error.slice(0, 160)} bob=${bobInv.ok ? rowsOf(bobInv) : bobInv.error.slice(0, 160)}`);

  // ════════════════════════════════════════════════════════════════════════
  // THE SILENT ZERO, DEMONSTRATED — and why no converted write can produce it
  // ════════════════════════════════════════════════════════════════════════
  const silent = await as("bob", (tx) => tx.transaction.updateMany({ where: { id: "tx_alice_2" }, data: { amount: -1 } }));
  check(32, "[silent-zero] the hazard is real: an updateMany against a hidden row returns { count: 0 } with NO error",
    silent.count === 0, `count=${silent.count}`);

  const ROOT = process.cwd();
  const code = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /** Routes whose every DIRECT statement is now a tenant phase. */
  const CONVERTED_ROUTES = [
    "app/api/transactions/[id]/correct/route.ts",
    "app/api/accounts/wallet/route.ts",
    "app/api/credit/update-fico/route.ts",
    "app/api/accounts/[id]/import/route.ts",
    "app/api/accounts/[id]/import/preview/route.ts",
    "app/api/accounts/[id]/import/investments/preview/route.ts",
    "app/api/accounts/[id]/import/investments/route.ts",
    "app/api/investments/opening-position/route.ts",
    "app/api/spaces/[id]/investments/space-data/route.ts",
    "app/api/spaces/[id]/wealth/amend/route.ts",
    "app/(shell)/dashboard/connections/page.tsx",
    "app/api/sync/status/route.ts",
    "app/api/plaid/sync/route.ts",
    "app/api/plaid/refresh/route.ts",
    "app/api/plaid/resume-sync/route.ts",
    "app/api/plaid/link-token/route.ts",
    "app/api/plaid/investments/enable/route.ts",
  ];
  const stillOwner = CONVERTED_ROUTES.filter((f) => /from\s*["']@\/lib\/db["']/.test(code(f)));
  const noPhase = CONVERTED_ROUTES.filter((f) => !/withTenantDb\(/.test(code(f)));
  check(33, `[source] none of the ${CONVERTED_ROUTES.length} converted routes imports a client from @/lib/db, and every one opens a tenant phase`,
    stillOwner.length === 0 && noPhase.length === 0, `owner import: ${stillOwner.join(", ")} · no phase: ${noPhase.join(", ")}`);

  // A converted WRITE must be a keyed create/update that raises when refused.
  // The single sanctioned updateMany is the wallet reactivation's, which follows
  // a keyed update of the same account in the same phase (see the route).
  const bulk = CONVERTED_ROUTES.flatMap((f) =>
    [...code(f).matchAll(/\btx\.(\w+)\.(updateMany|deleteMany)\(/g)].map((m) => `${f}:${m[1]}.${m[2]}`));
  check(34, "[source] the converted routes issue NO count-returning bulk write on a tenant client, except the one that follows a keyed update of the same account",
    bulk.length === 1 && bulk[0] === "app/api/accounts/wallet/route.ts:accountConnection.updateMany"
    && /tx\.financialAccount\.update\(\{\s*where: \{ id: archivedFa\.id \}[\s\S]{0,200}tx\.accountConnection\.updateMany/.test(code("app/api/accounts/wallet/route.ts")),
    bulk.join(" | "));

  /** Library seams whose `?? db` / `= db` default made a foreground caller an owner without saying so. */
  const NO_DEFAULT = [
    "lib/connections/space-data.ts", "lib/investments/space-data.ts", "lib/snapshots/snapshot-amendment.ts",
    "lib/imports/csv.ts", "lib/transactions/fingerprint.ts", "lib/sync/wallet-connections.ts",
    "lib/investments/investment-import-commit.ts", "lib/investments/opening-position.ts", "lib/platform/refresh-policy.ts",
    "lib/investments/instrument-resolver-import.ts",
  ];
  const defaulted = NO_DEFAULT.filter((f) => /\?\?\s*db\b|=\s*db\s*[,)\n]|from\s*["']@\/lib\/db["']\s*;?\s*$/m.test(code(f).replace(/import \{ systemDb \} from "@\/lib\/db";/, "")));
  check(35, `[source] the ${NO_DEFAULT.length} library seams behind those routes no longer import or default to the migration principal`,
    defaulted.length === 0, defaulted.join(", "));

  // ════════════════════════════════════════════════════════════════════════
  // C9. THE INVESTMENT-IMPORT WRITER AND THE OPENING-POSITION ASSERTION
  //     (POST /api/accounts/[id]/import/investments, POST /api/investments/opening-position)
  //
  // The last two foreground financial writers that ran as the table owner. They
  // now hold no client: the money runs in tenant phases, and the incident
  // recorder (fm_system, by recordSyncIssue's own default) is reachable only
  // after a tenant phase has admitted the account and ended.
  // ════════════════════════════════════════════════════════════════════════
  process.env.INVESTMENT_IMPORTS_ENABLED = "true";
  process.env.INVESTMENT_RECONSTRUCTION_ENABLED = "true";
  const opening = await import("@/lib/investments/opening-position");
  const commit = await import("@/lib/investments/investment-import-commit");
  const { recordSyncIssue } = await import("@/lib/plaid/syncIssues");
  const { runInvestmentImportPipelineFromCsv } = await import("@/lib/imports/investments/pipeline");
  const BRK = "acct_alice_brk";
  const dupSeed = psql(h.ownerUrl, `
    insert into "Instrument"(id,"tickerSymbol",name,currency,"assetClass","updatedAt")
      values ('inst_dup1','DUPX','Dup One','USD','EQUITY',now()), ('inst_dup2','DUPX','Dup Two','USD','EQUITY',now());`);
  if (!dupSeed.ok) throw new Error(`ambiguous-instrument fixture failed: ${dupSeed.err}`);
  const authorityFor = (who: string) => ({
    tenant: <T,>(fn: Parameters<typeof withTenantDb<T>>[1], opts?: { timeout?: number }) => withTenantDb(who, fn, opts),
    recordIssue: (issue: Parameters<typeof recordSyncIssue>[0]) => recordSyncIssue(issue),
  });
  const issuesFor = () => truth(`select count(*) from "SyncIssue" where "financialAccountId"='${BRK}'`);
  const eventsFor = (extra = "") => truth(`select count(*) from "InvestmentEvent" where "financialAccountId"='${BRK}' ${extra}`);

  // ── opening position ──
  const bobOpening = await attempt(() => opening.assertOpeningPosition({
    financialAccountId: BRK, instrument: { instrumentId: "inst_fg" }, date: "2026-01-02", quantity: 99, userId: "bob", ...authorityFor("bob"),
  }));
  // The ambiguous identity is the path that LEADS to telemetry — Bob must not get there.
  const bobOpeningDup = await attempt(() => opening.assertOpeningPosition({
    financialAccountId: BRK, instrument: { symbol: "DUPX", currency: "USD" }, date: "2026-01-02", quantity: 99, userId: "bob", ...authorityFor("bob"),
  }));
  check(36, "[opening] Bob asserting a position on ALICE'S account RAISES at the tenant boundary — no event, no observation, and the fm_system recorder is never reached even on the path that leads to it",
    !bobOpening.ok && !bobOpeningDup.ok && /not visible to the acting user/.test(bobOpening.error) && /not visible to the acting user/.test(bobOpeningDup.error)
    && eventsFor() === "0" && issuesFor() === "0"
    && truth(`select count(*) from "PositionObservation" where "financialAccountId"='${BRK}' and origin='USER_ASSERTED'`) === "0",
    `bob=${bobOpening.ok ? "WROTE" : bobOpening.error.slice(0, 120)} events=${eventsFor()} issues=${issuesFor()}`);

  const aliceOpening = await attempt(() => opening.assertOpeningPosition({
    financialAccountId: BRK, instrument: { symbol: "MINTED", currency: "USD", name: "Minted By A Tenant" }, date: "2026-03-01", quantity: 4, costBasis: 100, userId: "alice", ...authorityFor("alice"),
  }));
  const aliceReassert = aliceOpening.ok && aliceOpening.value.instrumentId
    ? await attempt(() => opening.assertOpeningPosition({
        financialAccountId: BRK, instrument: { instrumentId: aliceOpening.value.instrumentId! }, date: "2026-03-05", quantity: 6, userId: "alice", ...authorityFor("alice"),
      }))
    : aliceOpening;
  const liveOpenings = truth(`select count(*) filter (where "supersededById" is null)||'/'||count(*) from "InvestmentEvent" where "financialAccountId"='${BRK}' and type='OPENING_BALANCE' and source='user'`);
  check(37, "[opening] Alice's own assertion completes ENTIRELY as fm_app: the instrument is minted by the tenant role, the pair is written, a re-assertion supersedes the first, and repair runs in a tenant phase",
    aliceOpening.ok && aliceOpening.value.status === "ok" && aliceOpening.value.instrumentCreated === true && aliceOpening.value.repair?.status === "ok"
    && aliceReassert.ok && aliceReassert.value.status === "ok" && aliceReassert.value.supersededEventIds?.length === 1 && aliceReassert.value.supersededObservationIds?.length === 1
    && liveOpenings === "1/2" && truth(`select count(*) from "Instrument" where "tickerSymbol"='MINTED'`) === "1",
    `${aliceOpening.ok ? JSON.stringify(aliceOpening.value) : aliceOpening.error.slice(0, 200)} | ${aliceReassert.ok ? "" : aliceReassert.error.slice(0, 200)} live=${liveOpenings}`);

  const aliceDup = await attempt(() => opening.assertOpeningPosition({
    financialAccountId: BRK, instrument: { symbol: "DUPX", currency: "USD" }, date: "2026-03-01", quantity: 1, userId: "alice", ...authorityFor("alice"),
  }));
  const aliceWritesIssue = await attempt(() => as("alice", (tx) => (tx as unknown as { syncIssue: { create: (a: unknown) => Promise<unknown> } }).syncIssue.create({
    data: { kind: "INSTRUMENT_IDENTITY_CONFLICT", financialAccountId: BRK } })));
  check(38, "[opening] an ambiguous identity is a conflict with ZERO financial writes, and its incident IS recorded — by fm_system, on a table the tenant role still cannot write",
    aliceDup.ok && aliceDup.value.status === "conflict" && eventsFor() === "2"
    && truth(`select count(*) from "SyncIssue" where "financialAccountId"='${BRK}' and kind='INSTRUMENT_IDENTITY_CONFLICT'`) === "1"
    && !aliceWritesIssue.ok && /permission denied|row-level security/i.test(aliceWritesIssue.error),
    `dup=${aliceDup.ok ? aliceDup.value.status : aliceDup.error.slice(0, 160)} issues=${issuesFor()} tenantWrite=${aliceWritesIssue.ok ? "ALLOWED" : aliceWritesIssue.error.slice(0, 80)}`);

  // ── import commit ──
  const csvOf = (lines: string[]) => ["Trade Date,Action,Symbol,Description,Quantity,Price,Amount,Currency,Reference", ...lines].join("\n");
  const commitAs = (who: string, lines: string[], decisions: Record<string, { outcome: "force-create" }> = {}) => {
    const pipeline = runInvestmentImportPipelineFromCsv(csvOf(lines), { profileKey: "csv:generic" });
    return attempt(() => commit.commitInvestmentImport({
      financialAccountId: BRK, userId: who, profileKey: "csv:generic", profileVersion: pipeline.resolvedColumnMapping.profileVersion,
      source: "CSV", originalFilename: "fg.csv", resolvedColumnMapping: {}, rows: pipeline.rows, userDecisions: decisions, ...authorityFor(who),
    }));
  };
  const issuesBeforeBob = issuesFor();
  const bobCommit = await commitAs("bob", ["2026-02-01,Buy,DUPX,Dup,1,10.00,-10.00,USD,BOB-1", "2026-02-02,Buy,FGTEST,FG Test,1,10.00,-10.00,USD,BOB-2"]);
  check(39, "[import] Bob committing a file into ALICE'S account RAISES on the batch INSERT — no batch, no event, no instrument, and no incident, though the file's first row is the one that leads to telemetry",
    !bobCommit.ok && raisedRefusal(bobCommit.error)
    && truth(`select count(*) from "ImportBatch" where "financialAccountId"='${BRK}'`) === "0"
    && eventsFor(`and "externalEventId" like 'BOB-%'`) === "0" && issuesFor() === issuesBeforeBob,
    `bob=${bobCommit.ok ? "WROTE" : bobCommit.error.slice(0, 160)}`);

  const conflictsFor = () => Number(truth(`select count(*) from "SyncIssue" where "financialAccountId"='${BRK}' and kind='INSTRUMENT_IDENTITY_CONFLICT'`));
  const conflictsBeforeAlice = conflictsFor();
  // MINTED's live opening is dated 2026-03-05; an imported buy on 2026-02-10 covers it.
  const aliceCommit = await commitAs("alice", [
    "2026-02-10,Buy,MINTED,Minted,2,10.00,-20.00,USD,AL-1",
    "2026-02-11,Buy,DUPX,Dup,1,10.00,-10.00,USD,AL-2",
    "2026-02-12,Buy,FRESH,Fresh Co,1,10.00,-10.00,USD,AL-3",
    "2026-02-13,Dividend,FGTEST,FG Test,,,5.00,USD,AL-4",
  ]);
  const batchRow = truth(`select status||'|'||"importedCount"||'|'||"skippedCount"||'|'||"createdByUserId" from "ImportBatch" where "financialAccountId"='${BRK}'`);
  check(40, "[import] Alice's own import completes as fm_app end to end: batch, events with provenance, a freshly minted instrument, supersession of her covered opening, finalize and repair — and the ambiguous row is skipped with its incident recorded by fm_system",
    aliceCommit.ok && aliceCommit.value.status === "ok"
    && aliceCommit.value.counts?.create === 3 && aliceCommit.value.counts?.skip === 1 && aliceCommit.value.supersededAssertions === 1
    && aliceCommit.value.repair?.status === "ok" && batchRow === "COMPLETED_WITH_ERRORS|3|1|alice"
    && eventsFor(`and "importBatchId" is not null and "createdByUserId"='alice'`) === "3"
    && truth(`select count(*) from "Instrument" where "tickerSymbol"='FRESH'`) === "1"
    && truth(`select count(*) from "InvestmentEvent" where "financialAccountId"='${BRK}' and type='OPENING_BALANCE' and "supersededById" is null`) === "0"
    && conflictsFor() === conflictsBeforeAlice + 1,
    `${aliceCommit.ok ? JSON.stringify({ c: aliceCommit.value.counts, s: aliceCommit.value.supersededAssertions, r: aliceCommit.value.repair }) : aliceCommit.error.slice(0, 300)} batch=${batchRow} conflicts=${truth(`select count(*) from "SyncIssue" where "financialAccountId"='${BRK}' and kind='INSTRUMENT_IDENTITY_CONFLICT'`)} liveOpenings=${truth(`select count(*) from "InvestmentEvent" where "financialAccountId"='${BRK}' and type='OPENING_BALANCE' and "supersededById" is null`)} imported=${eventsFor(`and "importBatchId" is not null and "createdByUserId"='alice'`)}`);

  // PER-ROW FAILURE SEMANTICS, on real transactions. Row 2 is forced to collide
  // with the [source, externalEventId] unique key, so its phase raises.
  const partial = await commitAs("alice", [
    "2026-02-20,Buy,FRESH,Fresh Co,1,10.00,-10.00,USD,AL-5",
    "2026-02-10,Buy,MINTED,Minted,2,10.00,-20.00,USD,AL-1",
    "2026-02-21,Buy,FRESH,Fresh Co,1,10.00,-10.00,USD,AL-6",
  ], { "AL-1": { outcome: "force-create" } });
  const partialBatch = truth(`select status||'|'||"importedCount" from "ImportBatch" where "financialAccountId"='${BRK}' order by "createdAt" desc limit 1`);
  check(41, "[import] per-row failure semantics are preserved under tenant transactions: a row that raises stops the import, the rows before it STAY written, the rows after it are not, and the batch is left PROCESSING for rollback to find",
    !partial.ok && /Unique constraint|P2002/i.test(partial.error)
    && eventsFor(`and "externalEventId"='AL-5'`) === "1" && eventsFor(`and "externalEventId"='AL-6'`) === "0"
    && eventsFor(`and "externalEventId"='AL-1'`) === "1" && partialBatch === "PROCESSING|0",
    `partial=${partial.ok ? "COMPLETED" : partial.error.slice(0, 140)} batch=${partialBatch}`);

  const WRITERS = ["lib/investments/investment-import-commit.ts", "lib/investments/opening-position.ts", "lib/investments/instrument-resolver-import.ts"];
  const holdsClient = WRITERS.filter((f) => /from\s*["']@\/lib\/db["']/.test(code(f)) || /import\s*\{[^}]*\brecordSyncIssue\b[^}]*\}\s*from/.test(code(f).replace(/import type[^;]*;/g, "")) || /\bPrismaClient\b/.test(code(f)));
  const telemetryInsidePhase = WRITERS.filter((f) => /tenant\([^]*?recordIssue\(/.test(
    // any recordIssue( lexically inside a `tenant(async (tx) => { … })` body
    (code(f).match(/await tenant(?:<[^>]*>)?\(async \(tx\) => \{[\s\S]*?\n  \}\)/g) ?? []).join("\n")));
  check(42, "[source] the two writers and the resolver hold NO database client, import no incident recorder, and never call recordIssue inside a tenant phase body",
    holdsClient.length === 0 && telemetryInsidePhase.length === 0, `holdsClient=[${holdsClient.join(",")}] inside=[${telemetryInsidePhase.join(",")}]`);

  // ════════════════════════════════════════════════════════════════════════
  // S. SESSION ACTIVITY BOOKKEEPING ON fm_auth  (RLS-PREVIEW-13)
  // ════════════════════════════════════════════════════════════════════════
  // Preview, Stage 13: a fire-and-forget `updateMany` (BEGIN/UPDATE/COMMIT) on
  // fm_auth was suspended with its instance between UPDATE and COMMIT. It held
  // the UserSession row lock as "idle in transaction"; every later touch queued
  // behind it holding a pool slot; the revocation read starved; every signed-in
  // request 503'd. Here that open transaction is reproduced on the real fm_auth
  // role, and the replacement is attacked with it.
  {
    const { touchSessionActivity } = await import("@/lib/auth/session-activity");
    const { factsFromRow, judgeSession, SESSION_ROW_SELECT } = await import("@/lib/auth/session-proof");
    const { resolveRevocation, invalidateSession } = await import("@/lib/session-cache");
    const auth = dbMod.authDb;

    const LIVE_TOK = "rlsfg_alice_session_live_0001";
    const REV_TOK  = "rlsfg_alice_session_revoked_01";
    const seeded = psql(h.ownerUrl, `
      insert into "UserSession" (id,"userId","sessionToken","lastActiveAt") values
        ('us_alice_live','alice','${LIVE_TOK}', (now() at time zone 'utc') - interval '10 minutes'),
        ('us_alice_rev', 'alice','${REV_TOK}',  (now() at time zone 'utc') - interval '10 minutes');`);
    if (!seeded.ok) throw new Error(`session fixture seed failed: ${seeded.err}`);
    const stale = (id: string) => psql(h.ownerUrl,
      `update "UserSession" set "lastActiveAt" = (now() at time zone 'utc') - interval '10 minutes' where id='${id}'`);
    const ageS = (id: string) => Number(truth(
      `select extract(epoch from (now() at time zone 'utc') - "lastActiveAt")::int from "UserSession" where id='${id}'`));
    const stuckAuth = () => Number(truth(
      `select count(*) from pg_stat_activity where usename='fm_auth' and state like 'idle in transaction%'`));
    const validate = async (tok: string) => {
      invalidateSession(tok);
      const outcome = await resolveRevocation(tok, async () => factsFromRow(
        await auth.userSession.findFirst({ where: { sessionToken: tok }, select: SESSION_ROW_SELECT }),
        async () => false,
      ));
      return judgeSession({ userId: "alice", sessionToken: tok }, outcome);
    };
    const timed = async <T,>(fn: () => PromiseLike<T>) => { const t0 = Date.now(); const v = await fn(); return { v, ms: Date.now() - t0 }; };

    // 43 — validation is untouched, and a validated stale session is recorded once.
    const v43 = await validate(LIVE_TOK);
    const t43 = await timed(() => touchSessionActivity(auth, LIVE_TOK, "alice"));
    check(43, "[session] validation still authenticates a live session on fm_auth, and a stale session's activity is written exactly once, to now",
      v43.kind === "authenticated" && t43.v === 1 && ageS("us_alice_live") <= 5,
      `verdict=${v43.kind} rows=${t43.v} age=${ageS("us_alice_live")}s`);

    // 44 — throttle, and identity: a fresh row is not rewritten; another user's id matches nothing.
    const again = await touchSessionActivity(auth, LIVE_TOK, "alice");
    stale("us_alice_live");
    const wrongOwner = await touchSessionActivity(auth, LIVE_TOK, "bob");
    check(44, "[session] a row touched within the granularity is not rewritten, and a token presented with another user's id writes nothing",
      again === 0 && wrongOwner === 0 && ageS("us_alice_live") >= 590, `again=${again} wrongOwner=${wrongOwner} age=${ageS("us_alice_live")}s`);

    // 45/46 — THE INCIDENT. An fm_auth transaction runs the OLD write and never
    // commits (a suspended instance), holding the row lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = auth.$transaction(async (tx) => {
      await tx.userSession.updateMany({ where: { sessionToken: LIVE_TOK, userId: "alice" }, data: { lastActiveAt: new Date() } });
      await gate;
    }, { timeout: 60_000, maxWait: 10_000 });
    await new Promise((r) => setTimeout(r, 400));
    // The holder's uncommitted write is invisible to everyone else: for them the row is still stale.
    const heldBy = stuckAuth();

    const legacy = auth.userSession.updateMany({ where: { sessionToken: LIVE_TOK, userId: "alice" }, data: { lastActiveAt: new Date() } });
    const legacyRace = await Promise.race([legacy.then(() => "finished"), new Promise((r) => setTimeout(() => r("blocked"), 1500))]);
    const t45 = await timed(() => touchSessionActivity(auth, LIVE_TOK, "alice"));
    const burst = await timed(() => Promise.all(Array.from({ length: 20 }, () => touchSessionActivity(auth, LIVE_TOK, "alice"))));
    const v45 = await timed(() => validate(LIVE_TOK));
    check(45, "[session] REPRODUCED: with an fm_auth transaction left open on the row, the OLD updateMany queues behind it",
      heldBy >= 1 && legacyRace === "blocked", `openTx=${heldBy} legacy=${legacyRace}`);
    check(46, "[session] against that same held lock the NEW touch skips at once (0 rows, no wait), a burst of 20 does too, and validation still answers",
      t45.v === 0 && t45.ms < 1000 && burst.v.every((x) => x === 0) && burst.ms < 2000 && v45.v.kind === "authenticated" && v45.ms < 2000,
      `touch=${t45.v}/${t45.ms}ms burst=${burst.v.join("")}/${burst.ms}ms validate=${v45.v.kind}/${v45.ms}ms`);
    release();
    await holder; await legacy;

    // 47 — the hot row under concurrency, with nothing held: no queue, one write.
    stale("us_alice_live");
    const herd = await timed(() => Promise.all(Array.from({ length: 40 }, () => touchSessionActivity(auth, LIVE_TOK, "alice"))));
    const written = herd.v.reduce((a, b) => a + b, 0);
    await new Promise((r) => setTimeout(r, 200));
    check(47, "[session] 40 concurrent touches of one session write the row ONCE, finish promptly, and leave NO fm_auth session idle in transaction",
      written === 1 && herd.ms < 3000 && stuckAuth() === 0, `written=${written} in ${herd.ms}ms idleInTx=${stuckAuth()}`);

    // 48 — revocation semantics are unchanged, and a revoked session is never touched.
    psql(h.ownerUrl, `update "UserSession" set "revokedAt" = now() where id='us_alice_rev'`);
    const v48 = await validate(REV_TOK);
    const revTouch = await touchSessionActivity(auth, REV_TOK, "alice");
    check(48, "[session] a revoked session is still REFUSED by validation, and its activity is never written",
      v48.kind === "refused" && revTouch === 0 && ageS("us_alice_rev") >= 590, `verdict=${v48.kind} rows=${revTouch}`);

    // 49 — the fm_auth pool recovers fully once the holder is gone.
    const after = await timed(() => validate(LIVE_TOK));
    check(49, "[session] after the open transaction ends the fm_auth pool serves validation promptly and no fm_auth transaction remains open",
      after.v.kind === "authenticated" && after.ms < 1000 && stuckAuth() === 0, `verdict=${after.v.kind} ${after.ms}ms idleInTx=${stuckAuth()}`);
  }

  for (const c of [dbMod.tenantDb, dbMod.authDb, dbMod.systemDb, dbMod.db]) {
    await (c as { $disconnect: () => Promise<void> }).$disconnect();
  }

  const failures = report("FOREGROUND-PATH ADVERSARIAL");
  if (failures) process.exit(1);
  console.log("\nThe converted foreground paths refuse another tenant loudly, and run as the role they claim.\n");
}

main()
  .catch((e) => {
    console.error(`\n[rls] SUITE ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => teardownHarness(KEEP));
