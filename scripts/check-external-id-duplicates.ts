/**
 * scripts/check-external-id-duplicates.ts
 *
 * V26-PRE (B4) — PRE-MIGRATION duplicate check. READ-ONLY.
 *
 * Migration 20260727_v26pre_b4_btc_identity_backstop adds the active-row
 * unique index on ("financialAccountId", "externalTransactionId") WHERE
 * externalTransactionId IS NOT NULL AND deletedAt IS NULL. That CREATE fails
 * (cleanly, transactionally) if the target database already holds active-row
 * duplicates — e.g. from a historical manual-sync/cron race on a BTC wallet,
 * the exact class the index exists to prevent.
 *
 * Run this against the TARGET database BEFORE `prisma migrate deploy`:
 *
 *     npx tsx scripts/check-external-id-duplicates.ts
 *
 * Exit codes: 0 = clean (deploy safely) · 1 = duplicates found (listed below;
 * resolve by soft-deleting the redundant rows — tombstones are excluded from
 * the index — then re-run) · 2 = query failure.
 *
 * READ-ONLY: this script never writes. Resolution is a deliberate human act.
 */

import { db } from "@/lib/db";

async function main(): Promise<void> {
  const dupes = await db.transaction.groupBy({
    by:     ["financialAccountId", "externalTransactionId"],
    where:  { externalTransactionId: { not: null }, deletedAt: null },
    _count: { _all: true },
    having: { externalTransactionId: { _count: { gt: 1 } } },
  });

  if (dupes.length === 0) {
    console.log("check-external-id-duplicates: CLEAN — no active-row (account, externalTransactionId) duplicates. Safe to deploy the B4 index migration.");
    return;
  }

  console.error(`check-external-id-duplicates: ${dupes.length} duplicated (account, externalTransactionId) group(s) found — the B4 index migration WILL FAIL until these are resolved:\n`);
  for (const d of dupes) {
    const rows = await db.transaction.findMany({
      where:  { financialAccountId: d.financialAccountId, externalTransactionId: d.externalTransactionId, deletedAt: null },
      select: { id: true, date: true, amount: true, merchant: true, pending: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    console.error(`  account ${d.financialAccountId} · externalTransactionId ${d.externalTransactionId} — ${d._count._all} active rows:`);
    for (const r of rows) {
      console.error(`    ${r.id}  ${r.date.toISOString().slice(0, 10)}  ${r.amount}  ${r.pending ? "PENDING" : "posted"}  ${r.merchant}  (created ${r.createdAt.toISOString()})`);
    }
  }
  console.error("\nResolve by soft-deleting the redundant row(s) (set deletedAt — tombstones are excluded from the index), keeping the earliest-created row, then re-run this check.");
  process.exit(1);
}

main().catch((e) => { console.error("check-external-id-duplicates: query failed:", e); process.exit(2); });
