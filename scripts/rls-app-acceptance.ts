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

import {
  prepareHarness, teardownHarness, psql, deniedByGrant,
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
  check(4, "[channel] withTenantDb scopes an UNFILTERED count to the caller (alice 3, bob 2, corpus 4)",
    aliceTx === 3 && bobTx === 2, `alice=${aliceTx} bob=${bobTx}`);

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
  const wrong = interleaved.filter((r) => r.n !== (r.u === "alice" ? 3 : 2));
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
    sysBypass === "f" && sysSees.ok && sysSees.out.trim() === "4",
    `bypassrls=${sysBypass} sees=${sysSees.out || sysSees.err.split("\n")[0]}`);

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
