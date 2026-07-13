/**
 * scripts/audit-pending-posted-desync.ts
 *
 * TI2-W3 GATE — permanent VALIDATION COMMAND / repeatable audit.
 *
 * READ-ONLY. Answers one question, corpus-wide, that gates whether the
 * pending↔posted disclosure dedup slice (TI2-W3 §4.1) is worth building:
 *
 *   "Do LIVE pending rows whose posted successor is ALSO live actually occur?"
 *
 * Background (why this should be ~0): the AI transactions assembler's money
 * totals are settled-only, so a pending row never enters incomeTotal/
 * expenseTotal/netCashFlow. When a pending transaction posts, Plaid sends the
 * pending row in removed[] and sync TOMBSTONES it (lib/plaid/syncTransactions.ts
 * :454–471), and every read filters deletedAt IS NULL — so in the normal
 * lifecycle the pending predecessor is not even fetched. The only residue is a
 * MISSED/DELAYED removed[]: a live pending row coexisting with its live posted
 * successor, inflating pendingDebitTotal/pendingDebitCount/transactionCount and
 * possibly firing a stale PENDING_DEBIT signal.
 *
 * The defect, precisely (matches RelationshipResolver.resolvePendingPosted's
 * PENDING_AWAITING_POST direction): a live pending row P (pending = true,
 * deletedAt IS NULL, plaidTransactionId set) for which a live posted row Q
 * (deletedAt IS NULL) has Q.pendingTransactionRef = P.plaidTransactionId.
 *
 * Run:
 *   npx tsx scripts/audit-pending-posted-desync.ts   # or: npm run audit:pending-posted
 *
 * Exit code: 0 when the count is 0 (defect does not occur; TI2-W3 stays closed);
 * 1 when the count is above 0 (the dedup pass in TI2-W3 §2 is warranted). No
 * writes — safe to wire into CI or a release gate.
 */

import { db } from "@/lib/db";

interface CountRow { n: bigint }

async function main(): Promise<void> {
  console.log("\n[AUDIT] Pending↔posted desync (live pending with a live posted successor) — READ-ONLY\n");

  // Count DISTINCT live pending rows that already have a live posted successor.
  const rows = await db.$queryRaw<CountRow[]>`
    SELECT count(DISTINCT p."id") AS n
    FROM "Transaction" p
    JOIN "Transaction" q
      ON q."pendingTransactionRef" = p."plaidTransactionId"
    WHERE p."pending" = true
      AND p."deletedAt" IS NULL
      AND p."plaidTransactionId" IS NOT NULL
      AND q."deletedAt" IS NULL
      AND q."pendingTransactionRef" IS NOT NULL
      AND q."id" <> p."id"
  `;
  const count = Number(rows[0]?.n ?? 0);

  // For context: total live pending rows in the corpus, so the count is readable
  // as a share rather than a bare number.
  const totalRows = await db.$queryRaw<CountRow[]>`
    SELECT count(*) AS n FROM "Transaction"
    WHERE "pending" = true AND "deletedAt" IS NULL
  `;
  const totalPending = Number(totalRows[0]?.n ?? 0);

  console.log(`  live pending rows (corpus)              : ${totalPending}`);
  console.log(`  …with a live posted successor (defect)  : ${count}`);

  if (count === 0) {
    console.log(
      "\n[AUDIT] PASSED — zero live pending rows have a live posted successor. " +
      "The write-path tombstone already prevents this defect; TI2-W3 stays closed. ✓\n",
    );
    return;
  }

  console.error(
    `\n[AUDIT] FOUND ${count} live pending row(s) with a live posted successor. ` +
    "The residue TI2-W3 §4.1 describes actually occurs — implement the in-memory " +
    "pending↔posted disclosure dedup (TI2-W3 §2).\n",
  );
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("audit-pending-posted-desync failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
