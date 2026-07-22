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
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Database cleanup is CONNECTION-scoped, not account-scoped. It closes this
 * item's AccountConnections, then soft-deletes and unlinks only the accounts left
 * with NO remaining live connection.
 *
 * This differs from disconnectAccounts() (CONN-4A) on purpose. That primitive is
 * account-scoped — correct for "delete these accounts", wrong for "remove this
 * connection". Relinking an institution reuses the SAME FinancialAccount rows
 * (the reconciler matches on provider identity), so updating by financialAccountId
 * also closes a SIBLING item's connections to those accounts. On 2026-07-23 that
 * turned "remove the dead Amex" into "sever the working one too": all three Amex
 * items ended with zero live accounts.
 *
 * It does NOT regenerate today's SpaceSnapshot, which the primitive does: that
 * call sits behind the same "server-only" import wall described at STEP 2. Today's
 * row may therefore still include the removed accounts' value until the next sync
 * or the daily cron rewrites it. The accounts themselves disappear from the app
 * immediately, because that reads through the soft-delete.
 *
 * Soft-delete, not erasure: transactions and history rows remain. That is enough
 * to stop syncing and re-link the institution cleanly. To erase the underlying
 * data, use the app's consent-gated "Delete data" flow, which is the authority
 * for that and records the consent it requires.
 *
 * Idempotent: account ids are gathered from ALL AccountConnection rows for the
 * item, including already-soft-deleted ones, and REVOKED items still match — so
 * re-running finishes a partially-completed removal.
 */

import { db } from "@/lib/db";
import { PlaidItemStatus, ShareStatus } from "@prisma/client";
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

  // Fail fast on a half-loaded environment. Exporting only the database vars is
  // the easy mistake: PLAID_ENV then falls back to its "sandbox" default and the
  // credentials are absent, so every itemRemove fails against the wrong
  // environment with an opaque error. Cheaper to refuse than to explain.
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.error("\n  ✗ PLAID_CLIENT_ID / PLAID_SECRET are not set — itemRemove cannot succeed.");
    console.error("    Load the app env FIRST, then override the database target:");
    console.error("      set -a && . ./.env.local && set +a");
    console.error("      export DATABASE_URL='<prod>' DIRECT_URL='<prod>' ENCRYPTION_KEY='<prod>'\n");
    process.exit(1);
  }
  if (PLAID_ENV !== "production") {
    console.error(`\n  ⚠  PLAID_ENV is "${PLAID_ENV}", not "production".`);
    console.error("     An Item created in production cannot be removed from another environment.");
    console.error("     Re-run with the production Plaid credentials, or pass --allow-env-mismatch");
    console.error("     if you genuinely mean to act on a non-production Item.\n");
    if (!process.argv.includes("--allow-env-mismatch")) process.exit(1);
  }

  const items = await db.plaidItem.findMany({
    where: itemRef
      ? { OR: [{ id: itemRef }, { externalItemId: itemRef }] }
      : { institutionName: { contains: institution!, mode: "insensitive" } },
    select: {
      id: true, userId: true, externalItemId: true, institutionName: true, status: true,
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
      console.log(`    → would revoke at Plaid, soft-delete its accounts, revoke their`);
      console.log(`      Space links, and mark the item REVOKED\n`);
      continue;
    }

    // STEP 1 — Plaid first. If this fails we stop and change NOTHING, so the
    // operation stays retryable instead of silently stranding a billing Item.
    try {
      const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
      await plaidClient.itemRemove({ access_token: accessToken });
      console.log(`    ✓ revoked at Plaid`);
    } catch (e: unknown) {
      const data = (e as {
        response?: { status?: number; data?: { error_code?: string; error_message?: string } };
      })?.response;
      const code = data?.data?.error_code;
      if (code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN") {
        console.log(`    ✓ already gone from Plaid (${code})`);
      } else {
        // Surface everything we have. A bare "(unknown)" sent a real debugging
        // session down the wrong path: the actual cause was a missing credential,
        // which Plaid reports as an HTTP 400 with no error_code at all.
        const detail =
          data?.data?.error_message ??
          (e instanceof Error ? e.message : String(e));
        console.error(`    ✗ Plaid itemRemove FAILED — database left UNTOUCHED.`);
        console.error(`      env ${PLAID_ENV} · http ${data?.status ?? "?"} · code ${code ?? "none"}`);
        console.error(`      ${detail}`);
        console.error(`      Fix the cause and re-run; the item is still removable because its`);
        console.error(`      token is intact. Do NOT wipe this database before it succeeds.\n`);
        continue;
      }
    }

    // STEP 2 — mirror disconnectAccounts() (CONN-4A), the primitive
    // DELETE /api/accounts/[id] uses: soft-delete the FinancialAccounts, close
    // their AccountConnections, revoke ACTIVE SpaceAccountLinks — in ONE
    // transaction, exactly as it does. Closing only the connections (this
    // script's first version) left the accounts and Space links live, so the
    // institution kept rendering in the app after a "successful" removal.
    //
    // Duplicated rather than imported, deliberately and reluctantly: that module
    // reaches lib/email/send.ts through snapshots/regenerate → data/accounts →
    // space → auth, and that file imports "server-only", which is a Next
    // build-time alias with no package behind it — so tsx cannot load this
    // script at all if it imports the primitive. Keep the transaction below in
    // step with lib/accounts/disconnect.ts if that one changes.
    //
    // Account ids come from ALL AccountConnection rows for this item, including
    // already-soft-deleted ones, so a half-finished removal can be completed by
    // re-running this script.
    const allConns = await db.accountConnection.findMany({
      where:  { plaidItemDbId: item.id },
      select: { financialAccountId: true },
    });
    const faIds = [...new Set(allConns.map((c) => c.financialAccountId))];

    if (faIds.length > 0) {
      const now = new Date();
      const links = await db.$transaction(async (tx) => {
        // Close ONLY this item's connections — scoped by plaidItemDbId, never by
        // financialAccountId. Relinking an institution reuses the SAME
        // FinancialAccount rows (the reconciler matches on provider identity), so
        // an account-scoped update also closes a SIBLING item's live connections
        // to those accounts. That is how removing a dead Amex severed the working
        // one on 2026-07-23, leaving every Amex item with zero live accounts.
        await tx.accountConnection.updateMany({
          where: { plaidItemDbId: item.id, deletedAt: null },
          data:  { deletedAt: now },
        });

        // An account is only orphaned if NOTHING else still connects it. Anything
        // still reachable through another item belongs to that item and must be
        // left completely alone.
        const stillConnected = await tx.accountConnection.findMany({
          where:  { financialAccountId: { in: faIds }, deletedAt: null },
          select: { financialAccountId: true },
        });
        const keep = new Set(stillConnected.map((c) => c.financialAccountId));
        const orphaned = faIds.filter((id) => !keep.has(id));
        if (orphaned.length === 0) return { active: [], orphaned };

        await tx.financialAccount.updateMany({
          where: { id: { in: orphaned }, deletedAt: null },
          data:  { deletedAt: now },
        });
        const active = await tx.spaceAccountLink.findMany({
          where:  { financialAccountId: { in: orphaned }, status: ShareStatus.ACTIVE },
          select: { spaceId: true },
        });
        await tx.spaceAccountLink.updateMany({
          where: { financialAccountId: { in: orphaned }, status: ShareStatus.ACTIVE },
          data:  { status: ShareStatus.REVOKED, revokedAt: now, revokedByUserId: item.userId },
        });
        return { active, orphaned };
      });
      const spaceCount = new Set(links.active.map((l) => l.spaceId)).size;
      const shared = faIds.length - links.orphaned.length;
      console.log(
        `    \u2713 closed this item's connections; soft-deleted ${links.orphaned.length} orphaned account(s)` +
        (shared > 0 ? `, left ${shared} still connected elsewhere` : "") +
        `, revoked links in ${spaceCount} space(s)`,
      );
    }
    await setPlaidItemHealth(item.id, { status: PlaidItemStatus.REVOKED });
    console.log(`    ✓ marked REVOKED\n`);
  }

  if (!apply) console.log("  Re-run with --apply to perform the removal.\n");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
