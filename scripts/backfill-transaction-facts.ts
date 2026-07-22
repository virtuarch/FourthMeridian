/**
 * scripts/backfill-transaction-facts.ts
 *
 * TI3 — historical Transaction Intelligence fact backfill.
 *
 * Mirrors scripts/backfill-flowtype.ts exactly: DRY-RUN by default, --apply to
 * write, keyset pagination, version-gated + idempotent by construction, aggregate
 * non-PII output only. Reconstructs ONLY the facts derivable from stored data
 * (settlementState, fxApplied, tiFactsVersion) via the pure buildBackfillFacts
 * helper — provider-only facts (paymentChannel/paymentMethod/authorizedAt/
 * counterpartyType/pendingTransactionRef) are NEVER written and stay NULL, since
 * historical rows never captured that metadata.
 *
 * Selection (§version gate): tiFactsVersion IS NULL OR tiFactsVersion < TI_FACTS_VERSION.
 * Never rewrites an already-current row. A second --apply finds 0 rows.
 *
 * The APPLY write is a PARAMETERIZED RAW UPDATE of exactly three columns, so it
 * never bumps updatedAt and never touches any other column (amount, category,
 * flow columns, currency, provider-only TI columns, timestamps).
 *
 * Run:
 *   npx tsx scripts/backfill-transaction-facts.ts [--verbose] [--batch=N] [--limit=N] [--exclude-deleted]
 *   npx tsx scripts/backfill-transaction-facts.ts --apply [--batch=N] [--limit=N] [--exclude-deleted]
 */

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { buildBackfillFacts, TI_FACTS_VERSION } from "@/lib/transactions/transaction-facts";

const argv = process.argv.slice(2);

function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const VERBOSE         = argv.includes("--verbose");
const APPLY           = argv.includes("--apply");
const EXCLUDE_DELETED = argv.includes("--exclude-deleted");
const BATCH           = intFlag("--batch", 500);
const LIMIT           = intFlag("--limit", Number.POSITIVE_INFINITY);

async function main(): Promise<void> {
  // Version gate — rows not yet stamped at the current fact version.
  const versionWhere: Prisma.TransactionWhereInput = {
    OR: [
      { tiFactsVersion: null },
      { tiFactsVersion: { lt: TI_FACTS_VERSION } },
    ],
  };
  const baseWhere: Prisma.TransactionWhereInput = EXCLUDE_DELETED
    ? { AND: [versionWhere, { deletedAt: null }] }
    : versionWhere;

  console.log(`\n${APPLY ? "[APPLY] TI fact backfill — WRITING settlementState/fxApplied/tiFactsVersion" : "[DRY RUN] TI fact backfill — READ-ONLY, no writes"}`);
  console.log(
    `Selection: tiFactsVersion null OR tiFactsVersion < ${TI_FACTS_VERSION}` +
    `${EXCLUDE_DELETED ? " (excluding soft-deleted)" : " (including soft-deleted)"}`,
  );
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  const bySettlement: Record<string, number> = {};
  const byFx: Record<string, number> = {};
  let scanned = 0;
  let updated = 0;
  let lastId = "";

  while (scanned < LIMIT) {
    const take = Math.min(BATCH, LIMIT - scanned);
    const rows = await db.transaction.findMany({
      where:   lastId ? { AND: [baseWhere, { id: { gt: lastId } }] } : baseWhere,
      orderBy: { id: "asc" },
      take,
      select: {
        id:               true,
        pending:          true,
        currency:         true,
        financialAccount: { select: { currency: true } },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const accountCurrency = r.financialAccount?.currency ?? null;
      const facts = buildBackfillFacts({ pending: r.pending, currency: r.currency, accountCurrency });

      bySettlement[facts.settlementState ?? "null"] = (bySettlement[facts.settlementState ?? "null"] ?? 0) + 1;
      byFx[String(facts.fxApplied)] = (byFx[String(facts.fxApplied)] ?? 0) + 1;

      if (APPLY) {
        // Parameterized RAW UPDATE of ONLY the three backfillable columns. Not
        // db.transaction.update (which auto-bumps @updatedAt). Provider-only TI
        // columns are deliberately absent from SET — they stay NULL.
        await db.$executeRaw`
          UPDATE "Transaction" SET
            "settlementState" = ${facts.settlementState}::"SettlementState",
            "fxApplied"       = ${facts.fxApplied},
            "tiFactsVersion"  = ${facts.tiFactsVersion}
          WHERE "id" = ${r.id}
        `;
        updated++;
      }

      if (VERBOSE) console.log(`  ${r.id} → settlementState=${facts.settlementState} fxApplied=${facts.fxApplied}`);

      lastId = r.id;
      scanned++;
    }

    if (rows.length < take) break;
  }

  if (scanned === 0) {
    console.log("Nothing to backfill — every row is already at the current fact version. ✓");
    return;
  }

  const fmt = (rec: Record<string, number>) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");

  console.log(`Scanned:               ${scanned}${scanned >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`settlementState {${fmt(bySettlement)}}`);
  console.log(`fxApplied {${fmt(byFx)}}`);
  console.log(`tiFactsVersion stamped: ${TI_FACTS_VERSION}`);
  console.log(`provider-only facts:   left NULL (paymentChannel/paymentMethod/authorizedAt/counterpartyType/pendingTransactionRef)`);
  if (APPLY) {
    console.log(`\nApplied — TI facts written to ${updated} row(s). Re-run --apply to verify 0 remain.`);
  } else {
    console.log("\nDry run only — no writes. Re-run with --apply to write.");
  }
}

main()
  .catch((err) => {
    console.error("backfill-transaction-facts failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
