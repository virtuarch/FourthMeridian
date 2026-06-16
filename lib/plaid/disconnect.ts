/**
 * lib/plaid/disconnect.ts
 *
 * Extracted from app/api/accounts/[id]/route.ts (DELETE handler) — no
 * behavior change, just a named seam. When a FinancialAccount is removed,
 * the caller soft-deletes its AccountConnection row(s) first, then calls
 * this for each PlaidItem those connections pointed at. If zero non-deleted
 * AccountConnections remain on that PlaidItem, it's orphaned: revoke it at
 * Plaid (itemRemove) and mark it REVOKED in our DB so it stops syncing.
 *
 * This is intentionally Plaid-specific today (calls plaidClient.itemRemove
 * directly). It exists as a single named function so a future provider-
 * agnostic dispatcher (e.g. disconnectProviderConnectionIfOrphaned, keyed by
 * a provider enum) has one obvious call site to swap in, instead of inline
 * logic duplicated across every route that can delete an account.
 */

import { db } from "@/lib/db";
import { plaidClient } from "@/lib/plaid/client";
import { decrypt } from "@/lib/plaid/encryption";

export async function disconnectPlaidItemIfOrphaned(plaidItemDbId: string): Promise<void> {
  // Count remaining non-deleted connections on this PlaidItem
  const remaining = await db.accountConnection.count({
    where: {
      plaidItemDbId,
      deletedAt: null,
    },
  });

  if (remaining !== 0) return;

  const item = await db.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) return;

  try {
    const accessToken = decrypt(item.encryptedToken);
    await plaidClient.itemRemove({ access_token: accessToken });
  } catch (plaidErr) {
    console.error("[disconnectPlaidItemIfOrphaned] Plaid itemRemove failed:", plaidErr);
  }

  await db.plaidItem.update({
    where: { id: plaidItemDbId },
    data:  { status: "REVOKED" },
  });
}
