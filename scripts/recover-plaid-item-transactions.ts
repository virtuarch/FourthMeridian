/**
 * scripts/recover-plaid-item-transactions.ts
 *
 * Targeted recovery for a single PlaidItem whose incremental cursor has advanced
 * past a transaction that was never stored (e.g. a pending→posted payroll where
 * the pending was removed and the posted insert was skipped). Resetting the
 * cursor makes Plaid replay the full available window (bounded by the item's
 * days_requested), so the missing transaction is re-delivered and inserted.
 *
 * SAFETY:
 *  - Scoped to ONE PlaidItem (`--item <id>`). Never touches other items.
 *  - Dry-run by default (prints state, writes nothing). `--apply` performs it.
 *  - Idempotent: syncTransactionsForItem upserts on plaidTransactionId with a
 *    fingerprint fallback, so a full replay updates existing rows in place and
 *    inserts only genuinely-missing ones — no duplicates.
 *  - Only mutates that item's `cursor` (set NULL) and re-runs the existing sync.
 *    No schema change, no data deletion.
 *
 * Run:
 *   npx tsx scripts/recover-plaid-item-transactions.ts --item <plaidItemId>          # dry run
 *   npx tsx scripts/recover-plaid-item-transactions.ts --item <plaidItemId> --apply  # reset + re-sync
 */

import { db } from "@/lib/db";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
}

async function main(): Promise<void> {
  const itemId = argValue("--item");
  if (!itemId) {
    console.error("Usage: npx tsx scripts/recover-plaid-item-transactions.ts --item <plaidItemId> [--apply]");
    process.exit(1);
  }

  const item = await db.plaidItem.findUnique({
    where:  { id: itemId },
    select: { id: true, institutionName: true, status: true, cursor: true, lastSyncedAt: true },
  });
  if (!item) {
    console.error(`PlaidItem ${itemId} not found.`);
    process.exit(1);
  }

  console.log(`Recover transactions — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  item:        ${item.id}`);
  console.log(`  institution: ${item.institutionName}`);
  console.log(`  status:      ${item.status}`);
  console.log(`  cursor:      ${item.cursor ? "set" : "null"}`);
  console.log(`  lastSynced:  ${item.lastSyncedAt ? item.lastSyncedAt.toISOString() : "—"}\n`);

  if (!APPLY) {
    console.log("  Dry run only — would set cursor=NULL and re-run syncTransactionsForItem (full replay,");
    console.log("  idempotent). Re-run with --apply to recover.");
    return;
  }

  console.log("  Resetting cursor to NULL and re-syncing (full window replay)…");
  await db.plaidItem.update({ where: { id: item.id }, data: { cursor: null } });

  const r = await syncTransactionsForItem(item.id);
  console.log("\n  Re-sync result:");
  console.log(`    added:                ${r.added}`);
  console.log(`    modified:             ${r.modified}`);
  console.log(`    removed(soft):        ${r.removed}`);
  console.log(`    created (new rows):   ${r.created}`);
  console.log(`    updatedByPlaidId:     ${r.updatedByPlaidId}`);
  console.log(`    updatedByFingerprint: ${r.updatedByFingerprint}`);
  console.log(`    skippedMissingAccount:${r.skippedMissingAccount}`);
  console.log(`\n  Done. 'created' > 0 means new rows landed (the recovered transaction should be among them).`);
  console.log("  If skippedMissingAccount > 0, an account_id failed to resolve — check ProviderAccountIdentity.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
