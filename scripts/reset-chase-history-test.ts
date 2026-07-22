/**
 * scripts/reset-chase-history-test.ts
 *
 * DEV / ADMIN ONLY — do not expose to production UI.
 *
 * Hard-resets a PlaidItem so the Expand History flow can be tested from a
 * clean state. Designed for the Chase history test case but accepts any
 * PlaidItem ID.
 *
 * What it does, in order:
 *   1. Loads the PlaidItem and its live AccountConnections.
 *   2. Prints BEFORE counts (item status, connections, transactions per account).
 *   3. Decrypts the access token (using lib/plaid/encryption.ts).
 *   4. Calls Plaid /item/remove (best-effort; failure is warned but does not
 *      abort — the token may already be invalid from a prior attempt).
 *   5. Soft-deletes all AccountConnection rows for this item (deletedAt = now).
 *   6. Sets PlaidItem.status = REVOKED so it stops syncing.
 *   7. If --delete-transactions: hard-deletes Transaction rows for each
 *      FinancialAccount that was connected through this item.
 *   8. Prints AFTER counts.
 *
 * What it NEVER does:
 *   - Deletes FinancialAccount rows (they are always preserved).
 *   - Deletes SpaceAccountLink, DebtProfile, or Holding rows.
 *   - Deletes AccountConnection rows (soft-delete only: deletedAt).
 *   - Runs in production (no API route, no UI exposure).
 *
 * Rollback:
 *   AccountConnection.deletedAt can be cleared back to null to restore
 *   connections (no data is destroyed — soft-delete only).
 *   PlaidItem.status = REVOKED can be reset to ACTIVE in the DB, but the
 *   underlying Plaid /item/remove call is not reversible — the access token
 *   is invalidated at Plaid's end. The user will need to relink via Plaid
 *   Link regardless of our own status field.
 *   Deleted transactions (--delete-transactions) are hard-deleted and
 *   cannot be recovered; they will be re-imported on next Plaid sync.
 *
 * Usage:
 *   npx tsx scripts/reset-chase-history-test.ts \
 *     --plaid-item-id=<id> \
 *     --confirm=RESET_CHASE_HISTORY_TEST \
 *     [--delete-transactions]
 *
 * Flags:
 *   --plaid-item-id=<id>                 Required. The PlaidItem.id to reset.
 *   --confirm=RESET_CHASE_HISTORY_TEST   Required. Must match exactly.
 *   --delete-transactions                Optional. Hard-deletes Transaction
 *                                        rows for accounts on this item so
 *                                        the import can be verified from zero.
 *
 * Example:
 *   npx tsx scripts/reset-chase-history-test.ts \
 *     --plaid-item-id=clxxxxxxxx \
 *     --confirm=RESET_CHASE_HISTORY_TEST \
 *     --delete-transactions
 */

import { db }                    from "@/lib/db";
import { plaidClient }            from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { PlaidItemStatus }        from "@prisma/client";

// ── CLI arg parsing ────────────────────────────────────────────────────────────

const REQUIRED_CONFIRM = "RESET_CHASE_HISTORY_TEST";

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

const rawPlaidItemId     = getArg("plaid-item-id");
const rawConfirm         = getArg("confirm");
const deleteTransactions = process.argv.includes("--delete-transactions");

function bail(msg: string): never {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // ── Validate and narrow CLI args ─────────────────────────────────────────────
  // Validation lives in main() so TypeScript can narrow types via control flow.
  if (!rawPlaidItemId) {
    bail(
      "Missing required flag: --plaid-item-id=<id>\n\n" +
      "Usage:\n" +
      "  npx tsx scripts/reset-chase-history-test.ts \\\n" +
      "    --plaid-item-id=<id> \\\n" +
      "    --confirm=RESET_CHASE_HISTORY_TEST \\\n" +
      "    [--delete-transactions]",
    );
  }
  if (rawConfirm !== REQUIRED_CONFIRM) {
    bail(
      `Confirmation string missing or incorrect.\n\n` +
      `Pass exactly: --confirm=${REQUIRED_CONFIRM}\n\n` +
      `This guard prevents accidental resets. No writes have been made.`,
    );
  }

  // rawPlaidItemId is narrowed to string after the bail() above (never return).
  const plaidItemId: string = rawPlaidItemId;

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  DEV / ADMIN — Chase PlaidItem Hard Reset");
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── 1. Load PlaidItem ────────────────────────────────────────────────────────
  const item = await db.plaidItem.findUnique({
    where:  { id: plaidItemId },
    select: {
      id:              true,
      userId:          true,
      institutionId:   true,
      institutionName: true,
      status:          true,
      encryptedToken:  true,
      cursor:          true,
      createdAt:       true,
      connections: {
        select: {
          id:                 true,
          financialAccountId: true,
          deletedAt:          true,
          financialAccount: {
            select: {
              id:       true,
              name:     true,
              mask:     true,
              type:     true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });

  if (!item) {
    bail(`PlaidItem not found: ${plaidItemId}`);
  }

  const liveConnections   = item.connections.filter((c) => c.deletedAt === null);
  const softDeletedConns  = item.connections.filter((c) => c.deletedAt !== null);
  const allFinancialAcctIds = item.connections.map((c) => c.financialAccountId);

  // ── 2. BEFORE counts ─────────────────────────────────────────────────────────
  console.log("BEFORE");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`PlaidItem:          ${item.id}`);
  console.log(`Institution:        ${item.institutionName} (${item.institutionId})`);
  console.log(`Status:             ${item.status}`);
  console.log(`Cursor:             ${item.cursor ? "present" : "null (first sync not completed)"}`);
  console.log(`Owner userId:       ${item.userId}`);
  console.log(`Created at:         ${item.createdAt.toISOString()}`);
  console.log(`Connections (live): ${liveConnections.length}`);
  console.log(`Connections (soft-deleted): ${softDeletedConns.length}`);

  for (const conn of liveConnections) {
    const fa   = conn.financialAccount;
    const txns = await db.transaction.count({
      where: { financialAccountId: fa.id },
    });
    console.log(
      `  → AccountConnection ${conn.id} — FinancialAccount "${fa.name}" ` +
      `(mask:${fa.mask ?? "null"}, type:${fa.type}, ` +
      `${fa.deletedAt ? "FA soft-deleted" : "FA active"}) — ${txns} transaction(s)`,
    );
  }

  if (liveConnections.length === 0 && softDeletedConns.length === 0) {
    console.log("  (no AccountConnection rows found)");
  }

  if (deleteTransactions) {
    const totalTxns = await db.transaction.count({
      where: { financialAccountId: { in: allFinancialAcctIds } },
    });
    console.log(`\nTransactions (all accts, will be deleted): ${totalTxns}`);
  }

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("Plan:");
  console.log("  1. Decrypt access token");
  console.log("  2. Call Plaid /item/remove (best-effort)");
  console.log(`  3. Soft-delete ${liveConnections.length} live AccountConnection(s)`);
  console.log("  4. Set PlaidItem.status = REVOKED");
  if (deleteTransactions) {
    console.log(`  5. Hard-delete transactions for ${allFinancialAcctIds.length} FinancialAccount(s)`);
  }
  console.log("  FinancialAccount rows: NEVER deleted");
  console.log("──────────────────────────────────────────────────────────────\n");

  // ── 3. Decrypt access token ──────────────────────────────────────────────────
  console.log("Step 1/4+: Decrypting access token…");
  let accessToken: string;
  try {
    accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    console.log("  → decrypted OK.");
  } catch (decryptErr) {
    bail(`Failed to decrypt access token for PlaidItem ${plaidItemId}: ${decryptErr}`);
  }

  // ── 4. Plaid /item/remove (best-effort) ──────────────────────────────────────
  console.log("Step 2/4+: Calling Plaid /item/remove…");
  try {
    await plaidClient.itemRemove({ access_token: accessToken });
    console.log("  → Plaid itemRemove succeeded. Access token is now invalid at Plaid.");
  } catch (plaidErr) {
    const errMsg = plaidErr instanceof Error ? plaidErr.message : String(plaidErr);
    console.warn(
      `  ⚠  Plaid itemRemove failed (non-fatal — token may already be invalid or item already removed):\n` +
      `     ${errMsg}`,
    );
    console.warn("  Continuing — local DB state will still be updated.");
  }

  // ── 5. Soft-delete AccountConnections ────────────────────────────────────────
  console.log(`Step 3/4+: Soft-deleting ${liveConnections.length} live AccountConnection(s)…`);
  const { count: closedConns } = await db.accountConnection.updateMany({
    where: { plaidItemDbId: plaidItemId, deletedAt: null },
    data:  { deletedAt: new Date() },
  });
  console.log(`  → Soft-deleted ${closedConns} AccountConnection row(s) (deletedAt = now).`);

  // ── 6. Revoke PlaidItem ───────────────────────────────────────────────────────
  console.log("Step 4/4+: Setting PlaidItem.status = REVOKED…");
  await db.plaidItem.update({
    where: { id: plaidItemId },
    data:  { status: PlaidItemStatus.REVOKED },
  });
  console.log("  → PlaidItem.status = REVOKED.");

  // ── 7. Optionally delete transactions ────────────────────────────────────────
  let deletedTxns = 0;
  if (deleteTransactions) {
    console.log(
      `Step 5/5: Hard-deleting transactions for ${allFinancialAcctIds.length} FinancialAccount(s)…`,
    );
    console.log(`  Account IDs: ${allFinancialAcctIds.join(", ")}`);
    const { count } = await db.transaction.deleteMany({
      where: { financialAccountId: { in: allFinancialAcctIds } },
    });
    deletedTxns = count;
    console.log(`  → Deleted ${deletedTxns} transaction(s).`);
  }

  // ── 8. AFTER counts ──────────────────────────────────────────────────────────
  const afterItem        = await db.plaidItem.findUnique({
    where:  { id: plaidItemId },
    select: { status: true },
  });
  const afterLiveConns   = await db.accountConnection.count({
    where: { plaidItemDbId: plaidItemId, deletedAt: null },
  });
  const afterSoftConns   = await db.accountConnection.count({
    where: { plaidItemDbId: plaidItemId, deletedAt: { not: null } },
  });

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("AFTER");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`PlaidItem status:        ${afterItem?.status ?? "(not found)"}`);
  console.log(`Connections (live):      ${afterLiveConns}  ← should be 0`);
  console.log(`Connections (soft-del):  ${afterSoftConns}`);
  if (deleteTransactions) {
    console.log(`Transactions deleted:    ${deletedTxns}`);
    const remaining = await db.transaction.count({
      where: { financialAccountId: { in: allFinancialAcctIds } },
    });
    console.log(`Transactions remaining:  ${remaining}  ← should be 0`);
  }

  const faCount = await db.financialAccount.count({
    where: { id: { in: allFinancialAcctIds } },
  });
  console.log(`FinancialAccounts:       ${faCount} preserved (never deleted)`);
  console.log("──────────────────────────────────────────────────────────────");

  // Final status check
  const ok = afterItem?.status === PlaidItemStatus.REVOKED && afterLiveConns === 0;
  if (ok) {
    console.log("\n✅  Reset complete. PlaidItem is REVOKED with zero live connections.");
    console.log("    You can now run the Expand History flow fresh against this institution.");
  } else {
    console.warn("\n⚠  Reset may be incomplete. Review the AFTER counts above.");
  }

  if (deleteTransactions && deletedTxns > 0) {
    console.log(
      `\n    Transactions were hard-deleted — they cannot be recovered.\n` +
      `    Re-import by running Plaid Link and exchange-expanded-history-token.`,
    );
  }

  console.log("\n══════════════════════════════════════════════════════════════\n");
}

main()
  .catch((e) => {
    console.error("\n❌  Script failed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
