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
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { PlaidItemStatus } from "@prisma/client";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";

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
    const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    await plaidClient.itemRemove({ access_token: accessToken });
  } catch (plaidErr) {
    console.error("[disconnectPlaidItemIfOrphaned] Plaid itemRemove failed:", redactedErrorForLog(plaidErr));
  }

  // CH-2 — revoke through the chokepoint: writes status REVOKED (unchanged) and
  // records a durable transition row only when the item wasn't already REVOKED.
  // errorCode is left untouched (omitted) — a revoke shouldn't clear a prior
  // error, matching the previous inline update's behavior.
  await setPlaidItemHealth(plaidItemDbId, { status: PlaidItemStatus.REVOKED });
}
