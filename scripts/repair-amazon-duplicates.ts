/**
 * scripts/repair-amazon-duplicates.ts  (DF-5)
 *
 * Controlled, auditable repair of the 6-Amazon-rows production incident: two
 * real Amex-Platinum purchases ($62.11 on 2026-07-19, $39.29 on 2026-07-21)
 * that a reconnect re-pull duplicated into six active rows (DF-1/DF-4).
 *
 * SAFETY (repair doctrine, TRANSACTION_IDENTITY_DOCTRINE.md §H):
 *  - DRY RUN is the DEFAULT; --apply is required to write.
 *  - Narrowly scoped to the two proven (date, amount) lineages + the exact raw
 *    descriptor — NOT a broad "Amazon" descriptor deletion.
 *  - SOFT-delete only (deletedAt) — preserves the duplicates as evidence; every
 *    read path filters deletedAt:null, so they vanish from lists/projections.
 *  - ABORTS if the observed state differs from the investigation (6 active, 2
 *    groups, 4 to retire). If already repaired (each group unique) it is a
 *    clean NO-OP. Idempotent: a second --apply changes nothing.
 *
 * Usage (against whichever DB the env points at — see the env note in the
 * completion report; prod requires the prod DATABASE_URL, which this session
 * does not hold):
 *   npx dotenv -e .env.local -- npx tsx scripts/repair-amazon-duplicates.ts            # dry run
 *   npx dotenv -e .env.local -- npx tsx scripts/repair-amazon-duplicates.ts --apply    # write
 */

import { PrismaClient } from "@prisma/client";
import {
  planDuplicateRepair,
  checkAmazonIncidentShape,
  AMAZON_INCIDENT,
  type RepairRow,
} from "@/lib/transactions/duplicate-repair";

const APPLY = process.argv.includes("--apply");
const db = new PrismaClient();

async function main(): Promise<number> {
  console.log(`repair-amazon-duplicates — ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // Query ONLY the two proven lineages (raw descriptor + each (date, amount)),
  // active rows only. This scoping is what keeps the repair narrow.
  const rows = await db.transaction.findMany({
    where: {
      deletedAt:   null,
      description: { contains: "AMAZON MARKETPLACE", mode: "insensitive" },
      OR: AMAZON_INCIDENT.purchases.map((p) => ({ date: new Date(p.date), amount: p.amount })),
    },
    select: { id: true, financialAccountId: true, date: true, amount: true, description: true, pending: true, createdAt: true },
    orderBy: [{ amount: "asc" }, { createdAt: "asc" }],
  });

  const repairRows: RepairRow[] = rows.map((r) => ({
    id: r.id,
    financialAccountId: r.financialAccountId ?? "(none)",
    date: r.date.toISOString().slice(0, 10),
    amount: r.amount,
    description: r.description,
    pending: r.pending,
    createdAt: r.createdAt.toISOString(),
  }));

  const plan = planDuplicateRepair(repairRows);
  const check = checkAmazonIncidentShape(plan);

  console.log(`Active rows matching the two proven Amazon lineages: ${plan.activeCount}`);
  console.log(`Distinct canonical lineages (groups): ${plan.groupCount} (with duplicates: ${plan.duplicateGroupCount})`);
  for (const g of plan.groups) {
    console.log(`  • ${g.date}  $${Math.abs(g.amount).toFixed(2)}  acct=${g.financialAccountId.slice(-8)}  rows=${g.rowCount}  keep=${g.keepId.slice(-6)}  retire=[${g.retireIds.map((i) => i.slice(-6)).join(", ") || "—"}]`);
  }
  console.log(`\nExpected active Amazon rows: ${AMAZON_INCIDENT.expected.activeCount}`);
  console.log(`Expected legitimate canonical lineages: ${AMAZON_INCIDENT.expected.groupCount}`);
  console.log(`Expected rows to repair: ${AMAZON_INCIDENT.expected.retireCount}`);
  console.log(`\nVerdict: ${check.verdict} — ${check.reason}\n`);

  if (check.verdict === "NOOP") {
    console.log("Nothing to repair. 0 changes.");
    return 0;
  }
  if (check.verdict === "ABORT") {
    console.error("ABORTING — state does not match the investigation. No changes.");
    return 1;
  }

  // verdict === REPAIR
  console.log(`Plan: soft-delete ${plan.retireIds.length} duplicate row(s) → ${plan.keepIds.length} active row(s) remain.`);
  console.log(`Rollback: UPDATE "Transaction" SET "deletedAt" = NULL WHERE id IN (${plan.retireIds.map((i) => `'${i}'`).join(", ")});\n`);

  if (!APPLY) {
    console.log("DRY RUN only — no writes. Review the plan, then re-run with --apply.");
    return 0;
  }

  const result = await db.$transaction(async (tx) => {
    const updated = await tx.transaction.updateMany({
      where: { id: { in: plan.retireIds }, deletedAt: null },
      data:  { deletedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        action:   "TRANSACTION_DUPLICATE_REPAIRED",
        metadata: {
          incident:  "amazon-6-rows",
          kept:      plan.keepIds,
          retired:   plan.retireIds,
          basis:     "DF-5 controlled repair (soft-delete); write-path fixed in DF-4",
        },
      },
    });
    return updated.count;
  });

  const remaining = await db.transaction.count({
    where: {
      deletedAt:   null,
      description: { contains: "AMAZON MARKETPLACE", mode: "insensitive" },
      OR: AMAZON_INCIDENT.purchases.map((p) => ({ date: new Date(p.date), amount: p.amount })),
    },
  });
  console.log(`Applied — soft-deleted ${result} duplicate row(s). Active Amazon rows now: ${remaining} (expected 2).`);
  console.log("Re-run with --apply to verify 0 further changes.");
  return remaining === AMAZON_INCIDENT.expected.groupCount ? 0 : 1;
}

main()
  .then(async (code) => { await db.$disconnect(); process.exit(code); })
  .catch(async (e) => { console.error("repair failed:", e); await db.$disconnect(); process.exit(1); });
