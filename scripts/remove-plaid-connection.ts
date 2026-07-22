/**
 * scripts/remove-plaid-connection.ts
 *
 * Cleanly remove ONE Plaid connection — revoke it at Plaid, then close it out in
 * our database — so the institution can be re-linked from scratch.
 *
 *   npx tsx scripts/remove-plaid-connection.ts --institution "American Express"
 *   npx tsx scripts/remove-plaid-connection.ts --institution "American Express" --apply
 *   npx tsx scripts/remove-plaid-connection.ts --item <PlaidItem.id | Plaid item_id> --apply
 *
 * Requires DATABASE_URL / DIRECT_URL, ENCRYPTION_KEY and the Plaid credentials
 * for the environment the Item lives in. Dry run by default.
 *
 * ── Ordering, and why it is the opposite of the app's ────────────────────────
 * lib/plaid/disconnect.ts catches an itemRemove() failure, logs it, and marks the
 * item REVOKED anyway. That is what stranded seven live Items on 2026-07-22: the
 * row is excluded from every ACTIVE-scoped query (so nothing ever retries) while
 * the Item keeps existing at Plaid, keeps emitting webhooks, and keeps billing a
 * monthly subscription — and a later wipe destroys the only access_token that
 * could have removed it.
 *
 * So this script REVOKES AT PLAID FIRST and only touches the database if that
 * call actually succeeded. A Plaid failure aborts with the DB untouched, which
 * leaves the operation retryable — the property the app's path gives away.
 * ITEM_NOT_FOUND / INVALID_ACCESS_TOKEN count as success: the Item is already
 * gone from Plaid, which is the end state we want.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It does not delete FinancialAccounts, transactions, or history. It soft-deletes
 * the AccountConnection rows and marks the PlaidItem REVOKED — enough to stop
 * syncing and to re-link the institution cleanly. To erase the underlying data,
 * use the app's consent-gated "Delete data" flow, which is the authority for
 * that and records the consent the flow requires.
 */

import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { plaidClient, PLAID_ENV } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply       = process.argv.includes("--apply");
  const institution = arg("institution");
  const itemRef     = arg("item");

  if (!institution && !itemRef) {
    console.error('Usage: tsx scripts/remove-plaid-connection.ts --institution "American Express" [--apply]');
    console.error('   or: tsx scripts/remove-plaid-connection.ts --item <PlaidItem.id | Plaid item_id> [--apply]');
    process.exit(1);
  }

  const items = await db.plaidItem.findMany({
    where: itemRef
      ? { OR: [{ id: itemRef }, { externalItemId: itemRef }] }
      : { institutionName: { contains: institution!, mode: "insensitive" },
          status: { not: PlaidItemStatus.REVOKED } },
    select: {
      id: true, externalItemId: true, institutionName: true, status: true,
      encryptedToken: true, createdAt: true,
    },
  });

  if (items.length === 0) {
    console.log(`\n  No matching PlaidItem found. Nothing to do.\n`);
    return;
  }

  console.log(`\n  Plaid env : ${PLAID_ENV}`);
  console.log(`  Mode      : ${apply ? "APPLY" : "DRY RUN (no changes)"}`);
  console.log(`  Matched   : ${items.length} item(s)\n`);

  for (const item of items) {
    const conns = await db.accountConnection.count({
      where: { plaidItemDbId: item.id, deletedAt: null },
    });
    console.log(`  ${item.institutionName}`);
    console.log(`    PlaidItem.id   ${item.id}`);
    console.log(`    Plaid item_id  ${item.externalItemId}`);
    console.log(`    status         ${item.status}`);
    console.log(`    connected      ${item.createdAt.toISOString().slice(0, 10)}`);
    console.log(`    live accounts  ${conns}`);

    if (!apply) {
      console.log(`    → would revoke at Plaid, soft-delete ${conns} connection(s), mark REVOKED\n`);
      continue;
    }

    // STEP 1 — Plaid first. If this fails we stop and change NOTHING, so the
    // operation stays retryable instead of silently stranding a billing Item.
    try {
      const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
      await plaidClient.itemRemove({ access_token: accessToken });
      console.log(`    ✓ revoked at Plaid`);
    } catch (e: unknown) {
      const code = (e as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
      if (code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN") {
        console.log(`    ✓ already gone from Plaid (${code})`);
      } else {
        console.error(`    ✗ Plaid itemRemove FAILED (${code ?? "unknown"}) — database left UNTOUCHED.`);
        console.error(`      Fix the cause and re-run; the item is still removable because its`);
        console.error(`      token is intact. Do NOT wipe this database before it succeeds.\n`);
        continue;
      }
    }

    // STEP 2 — only now close it out on our side.
    const softDeleted = await db.accountConnection.updateMany({
      where: { plaidItemDbId: item.id, deletedAt: null },
      data:  { deletedAt: new Date() },
    });
    await setPlaidItemHealth(item.id, { status: PlaidItemStatus.REVOKED });
    console.log(`    ✓ soft-deleted ${softDeleted.count} connection(s), marked REVOKED\n`);
  }

  if (!apply) console.log("  Re-run with --apply to perform the removal.\n");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
