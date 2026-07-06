/**
 * scripts/audit-flow-desync.ts
 *
 * Desync Remediation — permanent VALIDATION COMMAND / repeatable audit.
 *
 * READ-ONLY. Proves the standing corpus invariant:
 *   "There are zero FlowType/Category desynchronizations."
 *
 * Scope (deliberately narrow): only the three TransactionCategory values that
 * map to a flowType UNCONDITIONALLY in lib/transactions/flow-classifier.ts —
 * Transfer→TRANSFER, Payment→DEBT_PAYMENT, Fee→FEE. These are the only clean
 * single-value predicates; Income/Interest/Dividend/spend categories are sign-
 * or account-context-dependent by design and are intentionally NOT checked here
 * (checking them would flag correct rows). See
 *   docs/initiatives/desync/DESYNC_REMEDIATION_2026-07-06.md §1.1.
 *
 * A NULL flowType on any of these categories is also a failure (an incompletely
 * classified deterministic row) — `IS DISTINCT FROM` catches it.
 *
 * Run:
 *   npx tsx scripts/audit-flow-desync.ts        # or: npm run audit:flow-desync
 *
 * Exit code: 0 when every predicate counts 0 (corpus certified); 1 otherwise
 * (with a per-category, non-PII breakdown of the offending rows). Safe to wire
 * into CI or a release gate — it performs no writes.
 */

import { db } from "@/lib/db";

interface Offender {
  category: string;
  flowType: string | null;
  count: bigint;
}

/** The unconditional category→flowType contract enforced by classifyFlow(). */
const DETERMINISTIC = [
  { category: "Transfer", flowType: "TRANSFER" },
  { category: "Payment", flowType: "DEBT_PAYMENT" },
  { category: "Fee", flowType: "FEE" },
] as const;

async function main(): Promise<void> {
  console.log("\n[AUDIT] FlowType/Category desynchronization — READ-ONLY\n");

  // One grouped sweep over the three deterministic predicates. IS DISTINCT FROM
  // treats NULL flowType as a mismatch (incompletely classified row).
  const rows = await db.$queryRaw<Offender[]>`
    SELECT "category"::text AS category, "flowType"::text AS "flowType", count(*) AS count
    FROM "Transaction"
    WHERE ("category" = 'Transfer' AND "flowType" IS DISTINCT FROM 'TRANSFER')
       OR ("category" = 'Payment'  AND "flowType" IS DISTINCT FROM 'DEBT_PAYMENT')
       OR ("category" = 'Fee'      AND "flowType" IS DISTINCT FROM 'FEE')
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

  let failed = false;

  for (const { category, flowType } of DETERMINISTIC) {
    const bad = rows
      .filter((r) => r.category === category)
      .reduce((n, r) => n + Number(r.count), 0);
    if (bad === 0) {
      console.log(`  ✓ ${category.padEnd(9)} → ${flowType.padEnd(13)} : 0 desynced`);
    } else {
      failed = true;
      console.log(`  ✗ ${category.padEnd(9)} → ${flowType.padEnd(13)} : ${bad} DESYNCED`);
      for (const r of rows.filter((x) => x.category === category)) {
        console.log(`        stored flowType=${r.flowType ?? "NULL"}  count=${Number(r.count)}`);
      }
    }
  }

  if (failed) {
    console.error(
      "\n[AUDIT] FAILED — the transaction corpus is NOT certified.\n" +
      "Deterministic-category rows disagree with the classifier. Remediation runbook:\n" +
      "  docs/initiatives/desync/DESYNC_REMEDIATION_2026-07-06.md §6 (clear classifierVersion → backfill-flowtype --apply).\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n[AUDIT] PASSED — zero FlowType/Category desynchronizations. Corpus certified. ✓\n");
}

main()
  .catch((err) => {
    console.error("audit-flow-desync failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
