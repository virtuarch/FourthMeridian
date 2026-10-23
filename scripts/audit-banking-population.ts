/**
 * scripts/audit-banking-population.ts
 *
 * v2.6-POP-1 — the banking population, PROVEN AGAINST A DATABASE. READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/audit-banking-population.ts
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The banking population is stated twice: once as a row-level predicate
 * (`isBankingPopulation`, lib/transactions/flow-predicates.ts) and once as a
 * Prisma fragment (`BANKING_POPULATION`, lib/data/banking-population.ts). They
 * must denote the same set.
 *
 * `lib/data/transactions.population.test.ts` claimed to pin them "in lockstep".
 * It did not. It exhaustively tested the PREDICATE over every FlowType including
 * null, then ASSERTED IN PROSE that the fragment agrees:
 *
 *     "the exact meaning of the Prisma fragment `flowType: { not: INVESTMENT }`
 *      (scalar `not` returns null rows too)"
 *
 * and never executed the fragment against a null row. That sentence is false —
 * a Prisma scalar `not` over a NULLABLE column DROPS NULLs — so the two
 * definitions disagreed on exactly the rows that matter most: the ones no
 * classifier has decided yet.
 *
 * A prose claim is not a lockstep test. This audit runs the REAL query against a
 * REAL corpus and compares its result set, row for row, with the predicate.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────
 *
 *   INV-P1  For every FlowType value AND null, membership decided by the SQL
 *           fragment equals membership decided by `isBankingPopulation`.
 *           Compared per-value over real counts, so a value absent from the
 *           corpus is REPORTED as untested rather than silently passing.
 *
 *   INV-P2  Set equality by ID, not just by count: the ids the canonical read
 *           returns are exactly the ids the predicate admits, within one Space.
 *           A count match can hide two compensating errors; an id match cannot.
 *
 *   INV-P3  The unclassified population is REACHABLE. A row the write path
 *           persisted with null flow columns must be visible to the banking
 *           reads, because that is the contract the sync's own create path
 *           documents (lib/plaid/syncTransactions.ts — "degrade-to-null is
 *           honest: a fresh row with null semantics lands in the
 *           never-classified backlog and needs-classification surfaces").
 *           If the read boundary hides it, the honesty valve is a black hole:
 *           the row persists, the sync reports success, and the surface built to
 *           catch it cannot see it.
 *
 * Corpus-independent: every assertion is a relationship between two definitions,
 * not a count. It holds on an empty corpus, a seeded one, and production.
 */

import { db } from "@/lib/db";
import { FlowType, ShareStatus } from "@prisma/client";

import { BANKING_POPULATION, bankingTransactionWhere } from "@/lib/data/banking-population";
import { isBankingRow } from "@/lib/transactions/flow-predicates";
import { type FlowAuthorityName } from "@/lib/transactions/flow-authority";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

const breaches: string[] = [];
function invariant(held: boolean, statement: string): boolean {
  if (!held) breaches.push(statement);
  return held;
}

/** Every flow value a row can carry, including "not yet classified". */
const ALL_FLOWS: (FlowType | null)[] = [...(Object.values(FlowType) as FlowType[]), null];

async function main(): Promise<void> {
  console.log("\n[AUDIT] Banking population — SQL fragment vs row-level predicate. READ-ONLY\n");

  // ── INV-P1 — per-value agreement, executed ────────────────────────────────
  bar("INV-P1 — the SQL fragment and the predicate agree, per flow value");
  console.log("  flowType         corpus   admitted by SQL   admitted by predicate");

  let untested = 0;
  for (const ft of ALL_FLOWS) {
    const label = ft ?? "(null)";
    // How many rows carry this value at all…
    const total = await db.transaction.count({ where: { flowType: ft } });
    // …and how many of THOSE the canonical fragment admits. Running the fragment
    // itself, not a restatement of it.
    const admitted = await db.transaction.count({
      where: { AND: [{ flowType: ft, flowAuthority: null }, BANKING_POPULATION] },
    });
    const totalUnowned = await db.transaction.count({ where: { flowType: ft, flowAuthority: null } });
    // v2.6-CRYPTO-1 — the predicate now takes the whole row. Membership is a
    // function of flowType AND authorship, so the per-VALUE comparison holds the
    // authority at a banking one; the crypto axis is asserted separately below.
    const predicateSays = isBankingRow({ flowType: ft, flowAuthority: null });
    // The fragment must admit ALL of them or NONE of them — membership is a
    // property of the value, never of the row.
    const sqlSays = admitted === totalUnowned ? true : admitted === 0 ? false : null;

    if (totalUnowned === 0) {
      untested++;
      console.log(`  ${label.padEnd(14)} ${String(total).padStart(7)}   ${"—".padStart(15)}   ${String(predicateSays).padEnd(6)}  (absent from corpus — UNTESTED)`);
      continue;
    }
    const agree = sqlSays === predicateSays;
    invariant(agree, `SQL and predicate agree for flowType=${label} (SQL=${sqlSays}, predicate=${predicateSays})`);
    console.log(
      `  ${label.padEnd(14)} ${String(total).padStart(7)}   ${String(sqlSays ?? `${admitted}/${total} SPLIT`).padStart(15)}   ${String(predicateSays).padEnd(6)}  ${agree ? "✓" : "✗ DISAGREE"}`,
    );
  }
  if (untested > 0) {
    console.log(`\n  ⚠ ${untested} flow value(s) absent from this corpus — reported, not asserted.`);
    console.log("    A seed that carries every value would make this exhaustive.");
  }

  // ── INV-P2 — set equality by id, inside a real Space ──────────────────────
  bar("INV-P2 — the canonical read returns exactly the ids the predicate admits");
  const spaces = await db.space.findMany({ select: { id: true, name: true } });
  let probed = 0;
  for (const s of spaces) {
    // Every row structurally visible to this Space, ignoring the flow population.
    const structural = await db.transaction.findMany({
      where: {
        deletedAt: null,
        financialAccount: {
          deletedAt: null,
          spaceAccountLinks: {
            some: { spaceId: s.id, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
          },
        },
      },
      select: { id: true, flowType: true, flowAuthority: true, transactionEventId: true, currentOfEvent: { select: { id: true } } },
    });
    if (structural.length === 0) continue;
    probed++;

    // What the PREDICATE admits — the event projection applies equally to both
    // sides, so this isolates the flow-population question and nothing else.
    const wantIds = new Set(
      structural
        .filter((r) => r.transactionEventId === null || r.currentOfEvent !== null)
        .filter((r) => isBankingRow({ flowType: r.flowType, flowAuthority: r.flowAuthority as FlowAuthorityName | null }))
        .map((r) => r.id),
    );
    // What the canonical READ actually returns.
    const got = await db.transaction.findMany({ where: bankingTransactionWhere(s.id), select: { id: true } });
    const gotIds = new Set(got.map((r) => r.id));

    const missing = [...wantIds].filter((id) => !gotIds.has(id));
    const extra = [...gotIds].filter((id) => !wantIds.has(id));
    const held = invariant(
      missing.length === 0 && extra.length === 0,
      `the canonical read for Space "${s.name}" returns exactly the predicate's set ` +
      `(${missing.length} hidden, ${extra.length} unexpected)`,
    );
    console.log(
      `  ${s.name.padEnd(26)} visible=${String(structural.length).padStart(5)}  ` +
      `predicate=${String(wantIds.size).padStart(5)}  read=${String(gotIds.size).padStart(5)}  ` +
      `${held ? "✓" : `✗ ${missing.length} HIDDEN, ${extra.length} unexpected`}`,
    );
    if (!held) {
      const byFlow = new Map<string, number>();
      for (const id of missing) {
        const r = structural.find((x) => x.id === id)!;
        const k = r.flowType ?? "(null)";
        byFlow.set(k, (byFlow.get(k) ?? 0) + 1);
      }
      for (const [k, n] of [...byFlow].sort((a, b) => b[1] - a[1])) {
        console.log(`        hidden by flowType=${k}: ${n}`);
      }
    }
  }
  if (probed === 0) console.log("  (no Space carries structurally visible rows — nothing to compare)");

  // ── INV-P3 — the unclassified population is reachable ─────────────────────
  bar("INV-P3 — a row with null flow columns is REACHABLE by the banking reads");
  const unclassifiedTotal = await db.transaction.count({ where: { flowType: null, deletedAt: null } });
  const unclassifiedAdmitted = await db.transaction.count({
    where: { AND: [{ flowType: null, deletedAt: null }, BANKING_POPULATION] },
  });
  console.log(`  unclassified rows (flowType IS NULL, live) : ${unclassifiedTotal}`);
  console.log(`  ...admitted by the banking population      : ${unclassifiedAdmitted}`);
  if (unclassifiedTotal === 0) {
    console.log("  ⚠ none in this corpus — INV-P3 is vacuous here.");
    console.log("    The seed carries a deliberate unclassified fixture precisely so this");
    console.log("    path stays under test; if that fixture is gone, restore it.");
  } else {
    console.log(
      `  ${invariant(unclassifiedAdmitted === unclassifiedTotal,
        "every unclassified row is admitted by the banking population — the write path's " +
        "documented degrade-to-null contract requires it to remain visible")
        ? "✓ every unclassified row remains visible" : "✗ unclassified rows are HIDDEN"}`,
    );
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  bar("VERDICT");
  if (breaches.length > 0) {
    console.error(`  ✗ ${breaches.length} invariant(s) breached:`);
    for (const b of breaches) console.error(`      · ${b}`);
    console.error(
      "\n[AUDIT] FAILED — the SQL fragment and the row-level predicate denote different sets.\n" +
      "These two must agree by construction: one is the population, the other is the\n" +
      "statement of the population. Fix the fragment (lib/data/banking-population.ts) or\n" +
      "the predicate (lib/transactions/flow-predicates.ts) — never the audit.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\n[AUDIT] PASSED — the query and the rule denote the same set. Nothing was written.\n");
}

main()
  .catch((err) => { console.error("audit-banking-population failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
