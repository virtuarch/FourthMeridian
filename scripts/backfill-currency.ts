/**
 * scripts/backfill-currency.ts
 *
 * MC1 Phase 0 Slice 3 — one-time historical currency-provenance backfill.
 * See docs/initiatives/mc1/MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md §3.3 / §7.
 *
 * Stamps Transaction.currency and Holding.currency on pre-Phase-0 rows by
 * DERIVING from provenance already stored in the database: the parent
 * FinancialAccount's currency (FinancialAccount.currency). No currency is
 * ever manufactured:
 *   - no conversion, no rate inference, no hardcoded "USD";
 *   - a row whose parent cannot supply a currency stays NULL — that IS its
 *     provenance ("denomination never recorded").
 *
 * Soft-deleted (tombstoned) rows are included: provenance describes stored
 * financial facts, and tombstones remain facts.
 *
 * Idempotent by construction: selection is `currency IS NULL`, and each
 * UPDATE re-guards on `"currency" IS NULL`, so a second --apply run finds
 * (and writes) 0 rows. Safe to run while syncs are live — Slice 2 writers
 * stamp their own rows at write time.
 *
 * Writes use a parameterized RAW UPDATE that deliberately does NOT bump
 * @updatedAt (same rule as scripts/backfill-flowtype.ts): a provenance stamp
 * must not make historical rows look freshly modified. Nothing else on the
 * row is touched. SpaceSnapshot.reportingCurrency is NOT handled here — its
 * NOT NULL DEFAULT 'USD' already covered every historical row at migration
 * time (plan §3.1).
 *
 * Run:
 *   npx tsx scripts/backfill-currency.ts                 # dry-run (default): report only, no writes
 *   npx tsx scripts/backfill-currency.ts --apply         # write stamps
 *   npx tsx scripts/backfill-currency.ts [--batch=N] [--limit=N]
 */

import { db } from "@/lib/db";

const argv = process.argv.slice(2);

function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const APPLY = argv.includes("--apply");
const BATCH = intFlag("--batch", 500);
const LIMIT = intFlag("--limit", Number.POSITIVE_INFINITY);

interface TableReport {
  table:        string;
  total:        number; // all rows in the table
  alreadySet:   number; // currency NOT NULL before this run (writer-stamped or prior run)
  examined:     number; // currency IS NULL rows scanned this run
  updated:      number; // stamped this run (--apply) / would be stamped (dry-run)
  unresolved:   number; // no parent account currency derivable — left NULL on purpose
  byCurrency:   Record<string, number>; // distribution of derived stamps (non-PII)
}

function newReport(table: string): TableReport {
  return { table, total: 0, alreadySet: 0, examined: 0, updated: 0, unresolved: 0, byCurrency: {} };
}

/**
 * Shared engine for both tables. `model` abstracts the two Prisma delegates,
 * which expose identical shapes for everything this script needs: id-keyset
 * pagination over `currency IS NULL` rows with both parent relations selected.
 */
async function backfillTable(
  rep: TableReport,
  counts: { total: number; alreadySet: number },
  fetchBatch: (lastId: string, take: number) => Promise<Array<{
    id: string;
    financialAccount: { currency: string } | null;
  }>>,
  applyStamp: (id: string, currency: string) => Promise<number>,
): Promise<void> {
  rep.total      = counts.total;
  rep.alreadySet = counts.alreadySet;

  let lastId = "";
  while (rep.examined < LIMIT) {
    const take = Math.min(BATCH, LIMIT - rep.examined);
    const rows = await fetchBatch(lastId, take);
    if (rows.length === 0) break;

    for (const r of rows) {
      // Derivation rule (plan §3.3): parent FinancialAccount.currency. The
      // column is NOT NULL in the schema, so a present parent always resolves;
      // "unresolved" means the row has no surviving parent to derive from.
      const derived = r.financialAccount?.currency ?? null;

      if (derived === null) {
        rep.unresolved++;
      } else {
        if (APPLY) {
          rep.updated += await applyStamp(r.id, derived);
        } else {
          rep.updated++; // dry-run: would update
        }
        rep.byCurrency[derived] = (rep.byCurrency[derived] ?? 0) + 1;
      }

      lastId = r.id;
      rep.examined++;
    }

    if (rows.length < take) break;
  }
}

function printReport(rep: TableReport): void {
  const dist = Object.entries(rep.byCurrency)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`${rep.table}`);
  console.log(`  total rows:                 ${rep.total}`);
  console.log(`  already stamped (skipped):  ${rep.alreadySet}`);
  console.log(`  examined (currency NULL):   ${rep.examined}${rep.examined >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`  ${APPLY ? "updated:                   " : "would update (dry-run):    "} ${rep.updated}${dist ? `   {${dist}}` : ""}`);
  console.log(`  unresolved (left NULL):     ${rep.unresolved}`);
}

async function main(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] MC1 currency backfill — WRITING currency stamps" : "[DRY RUN] MC1 currency backfill — READ-ONLY, no writes"}`);
  console.log(`Derivation: financialAccount.currency ?? account.currency ?? leave NULL (never manufactured)`);
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  // ── Transaction ────────────────────────────────────────────────────────────
  const tx = newReport("Transaction");
  await backfillTable(
    tx,
    {
      total:      await db.transaction.count(),
      alreadySet: await db.transaction.count({ where: { NOT: { currency: null } } }),
    },
    (lastId, take) =>
      db.transaction.findMany({
        where:   lastId ? { AND: [{ currency: null }, { id: { gt: lastId } }] } : { currency: null },
        orderBy: { id: "asc" },
        take,
        select: {
          id:               true,
          financialAccount: { select: { currency: true } },
        },
      }),
    // Raw UPDATE: stamps ONLY currency, preserves updatedAt and every other
    // column; the `IS NULL` re-guard makes each write idempotent even under
    // concurrent syncs. Returns affected-row count (0 or 1).
    (id, currency) =>
      db.$executeRaw`UPDATE "Transaction" SET "currency" = ${currency} WHERE "id" = ${id} AND "currency" IS NULL`,
  );
  printReport(tx);

  // ── Holding ────────────────────────────────────────────────────────────────
  const h = newReport("Holding");
  await backfillTable(
    h,
    {
      total:      await db.holding.count(),
      alreadySet: await db.holding.count({ where: { NOT: { currency: null } } }),
    },
    (lastId, take) =>
      db.holding.findMany({
        where:   lastId ? { AND: [{ currency: null }, { id: { gt: lastId } }] } : { currency: null },
        orderBy: { id: "asc" },
        take,
        select: {
          id:               true,
          financialAccount: { select: { currency: true } },
        },
      }),
    (id, currency) =>
      db.$executeRaw`UPDATE "Holding" SET "currency" = ${currency} WHERE "id" = ${id} AND "currency" IS NULL`,
  );
  console.log("");
  printReport(h);

  console.log("");
  if (APPLY) {
    console.log(`Applied — Transactions updated: ${tx.updated}, Holdings updated: ${h.updated}, unresolved left NULL: ${tx.unresolved + h.unresolved}.`);
    console.log("Re-run --apply to verify 0 remain (idempotence check).");
  } else {
    console.log("Dry run only — no writes. Re-run with --apply to write.");
  }
}

main()
  .catch((err) => {
    console.error("backfill-currency failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
