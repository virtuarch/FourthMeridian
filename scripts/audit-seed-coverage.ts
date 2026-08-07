/**
 * scripts/audit-seed-coverage.ts
 *
 * v2.6-SEED-1 — WHICH ARCHITECTURAL STATES does this corpus actually contain?
 * READ-ONLY: writes nothing, ever.
 *
 * ── Why this is not "do the audits pass" ────────────────────────────────────
 *
 * The REQUIRED gate passes on a freshly seeded database. That is necessary and
 * almost meaningless on its own: an invariant over a corpus that cannot express
 * its failure mode passes VACUOUSLY. This arc has hit that twice — `audit-event-
 * identity` cannot catch a stale projection on a corpus that never tombstoned a
 * row, and `audit-snapshot-window-claims` cannot catch a row-count-as-days on a
 * corpus whose snapshots are daily and contiguous.
 *
 * So a seed's value is not the invariants it satisfies. It is the STATES it
 * produces — the edge cases that make an invariant capable of failing.
 *
 * This measures those states directly. It is the acceptance contract for any
 * reseed: **every state present before must still be present after**, whatever
 * the Spaces are called. Coverage is preserved; names are not.
 *
 * ⚠️ Run it against a SCRATCH database, never the working one. `prisma/seed.ts`
 * performs an UNSCOPED `deleteMany()` on every table — including
 * `prisma.user.deleteMany()` — so reseeding a database that holds a real account
 * destroys it. See §"THE WIPE" in the reseed report.
 *
 * Tier: INFORMATIONAL — it describes a corpus. The number of states is a fact
 * about a database, not a property of the code.
 *
 * Run: npx tsx --env-file=<scratch>.env scripts/audit-seed-coverage.ts
 */

import { db } from "@/lib/db";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

interface Cover { group: string; state: string; n: number; why: string }
const rows: Cover[] = [];
const add = (group: string, state: string, n: number, why: string) => rows.push({ group, state, n, why });

async function main(): Promise<void> {
  console.log(`\n[AUDIT] seed coverage — WHICH architectural states exist here?`);

  // ── Space / membership shapes ─────────────────────────────────────────────
  const spaces = await db.space.findMany({
    where: { archivedAt: null, deletedAt: null },
    select: { id: true, category: true, type: true, _count: { select: { members: true, accountLinks: true } } },
  });
  add("SPACE", "personal Space", spaces.filter((s) => s.type === "PERSONAL").length, "the single-owner path");
  add("SPACE", "shared Space (2+ members)", spaces.filter((s) => s._count.members >= 2).length, "membership gating, per-viewer visibility");
  add("SPACE", "Space with 3+ members", spaces.filter((s) => s._count.members >= 3).length, "role fan-out incl. VIEWER");
  add("SPACE", "Space with NO accounts", spaces.filter((s) => s._count.accountLinks === 0).length, "empty-state / day-zero rendering");

  const roles = await db.spaceMember.groupBy({ by: ["role"], _count: { _all: true } });
  for (const r of roles) add("ROLE", `${r.role} membership`, r._count._all, "role-gated reads and writes");

  // ── Account / visibility shapes ───────────────────────────────────────────
  const links = await db.spaceAccountLink.groupBy({ by: ["visibilityLevel"], _count: { _all: true } });
  for (const l of links) add("VISIBILITY", `${l.visibilityLevel} link`, l._count._all, "KD-15/KD-19 redaction paths");

  const types = await db.financialAccount.groupBy({ by: ["type"], where: { deletedAt: null }, _count: { _all: true } });
  for (const t of types) add("ACCOUNT", `type=${t.type}`, t._count._all, "classifier / liquidity tiering");

  const shared = await db.financialAccount.count({
    where: { deletedAt: null, spaceAccountLinks: { some: {} } },
  });
  const multiSpace = (await db.spaceAccountLink.groupBy({ by: ["financialAccountId"], _count: { _all: true } }))
    .filter((g) => g._count._all > 1).length;
  add("ACCOUNT", "account linked to 2+ Spaces", multiSpace, "cross-Space dedup (Brief 'accounts tracked')");
  add("ACCOUNT", "accounts linked at all", shared, "baseline");

  const currencies = await db.financialAccount.groupBy({ by: ["currency"], where: { deletedAt: null }, _count: { _all: true } });
  add("FX", "distinct account currencies", currencies.length, "multi-currency conversion + fxMiss disclosure");

  // ── Transaction semantics ─────────────────────────────────────────────────
  const flows = await db.transaction.groupBy({ by: ["flowType"], where: { deletedAt: null }, _count: { _all: true } });
  for (const f of flows) add("FLOW", `flowType=${f.flowType ?? "NULL (unclassified)"}`, f._count._all,
    f.flowType === null ? "the never-classified backlog v2.6-POP-1 keeps visible" : "banking population + fold semantics");

  const authorities = await db.transaction.groupBy({ by: ["flowAuthority"], where: { deletedAt: null }, _count: { _all: true } });
  for (const a of authorities) add("OWNERSHIP", `flowAuthority=${a.flowAuthority ?? "NULL (unowned)"}`, a._count._all, "v2.6-OWN-1 ownership stamp");

  add("CHRONOLOGY", "economicDate ≠ posting date",
    await db.transaction.count({ where: { deletedAt: null, NOT: { economicDate: { equals: db.transaction.fields.date } } } })
      .catch(async () => (await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "Transaction" WHERE "deletedAt" IS NULL AND "economicDate" <> "date"`))[0].n as unknown as number),
    "the L8-B economic-chronology cutover");

  add("LIFECYCLE", "pending rows", await db.transaction.count({ where: { deletedAt: null, pending: true } }), "pending/posted supersession");
  add("LIFECYCLE", "tombstoned (soft-deleted) rows", await db.transaction.count({ where: { NOT: { deletedAt: null } } }),
    "⚠️ the state audit-event-identity needs to catch a stale projection");

  // ── Event identity (L8) ───────────────────────────────────────────────────
  add("EVENT", "TransactionEvents", await db.transactionEvent.count(), "the L8 event spine");
  add("EVENT", "observations", await db.transactionObservation.count(), "provider observation log");
  const multiObs = (await db.transactionObservation.groupBy({ by: ["eventId"], _count: { _all: true } }))
    .filter((g) => g._count._all > 1).length;
  add("EVENT", "events with 2+ observations", multiObs, "⚠️ pending→posted as ONE event (the whole point of L8)");
  const lifecycles = await db.transactionEvent.groupBy({ by: ["lifecycle"], _count: { _all: true } });
  for (const l of lifecycles) add("EVENT", `lifecycle=${l.lifecycle}`, l._count._all, "projection states");

  // ── Transfers / debt ──────────────────────────────────────────────────────
  add("TRANSFER", "rows with a resolved counterparty",
    await db.transaction.count({ where: { deletedAt: null, NOT: { counterpartyAccountId: null } } }),
    "the transfer resolution authority's persisted verdict");
  add("DEBT", "DEBT_PAYMENT rows", await db.transaction.count({ where: { deletedAt: null, flowType: "DEBT_PAYMENT" } }),
    "cash-leg selection + attestation");

  // ── Snapshots ─────────────────────────────────────────────────────────────
  add("SNAPSHOT", "snapshot rows", await db.spaceSnapshot.count(), "history/window authorities");
  add("SNAPSHOT", "Spaces with 30+ snapshots",
    (await db.spaceSnapshot.groupBy({ by: ["spaceId"], _count: { _all: true } })).filter((g) => g._count._all >= 30).length,
    "a canonical PAST_MONTH window can resolve");
  add("SNAPSHOT", "estimated snapshots", await db.spaceSnapshot.count({ where: { isEstimated: true } }), "FX-estimated disclosure");

  // ── Goals / holdings ──────────────────────────────────────────────────────
  const goalTypes = await db.spaceGoal.groupBy({ by: ["goalType"], _count: { _all: true } });
  for (const g of goalTypes) add("GOAL", `goalType=${g.goalType}`, g._count._all, "goal alignment engine");
  add("HOLDING", "holdings", await db.holding.count(), "investments valuation");

  // ── Report ────────────────────────────────────────────────────────────────
  bar("COVERAGE");
  let empty = 0;
  let group = "";
  for (const r of rows) {
    if (r.group !== group) { group = r.group; console.log(`\n  ── ${group}`); }
    const mark = r.n > 0 ? "✓" : "✗ ABSENT";
    if (r.n === 0) empty++;
    console.log(`     ${mark.padEnd(9)} ${String(r.n).padStart(5)}  ${r.state}`);
    if (r.n === 0) console.log(`                        ↳ unexercised: ${r.why}`);
  }

  bar("VERDICT");
  console.log(`  states measured : ${rows.length}`);
  console.log(`  states PRESENT  : ${rows.length - empty}`);
  console.log(`  states ABSENT   : ${empty}`);
  console.log(
    `\n  A reseed must preserve every PRESENT state. Names may change; coverage\n` +
    `  may not shrink. The ABSENT rows are pre-existing gaps — a reseed is the\n` +
    `  cheapest moment to close them, and closing them is what would let the\n` +
    `  vacuously-passing invariants actually bite.\n`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
