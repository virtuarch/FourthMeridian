/**
 * lib/accounts/disconnect.ts  (CONN-4A)
 *
 * THE single connection-disconnect primitive (Model A — stop syncing, preserve
 * history). Extracted from DELETE /api/accounts/[id] so the account-level remove
 * AND the connection-level disconnect share ONE engine — no duplicated logic.
 *
 * It is NON-DESTRUCTIVE and reversible:
 *   - soft-delete the FinancialAccount(s) (deletedAt) — history preserved
 *   - soft-delete their AccountConnection(s)
 *   - revoke their ACTIVE SpaceAccountLinks (status=REVOKED) — revoke-don't-delete
 *   - regenerate TODAY's SpaceSnapshot per affected space (best-effort)
 *   - disconnectPlaidItemIfOrphaned per item (orphan-gated itemRemove + REVOKED)
 *
 * It does NOT hard-delete any row, does NOT touch historical snapshots (deferred),
 * and does NOT authorize — every caller authorizes first (the account route via an
 * ACTIVE SpaceAccountLink it added; the connection route via connection ownership).
 * Reconnect (exchange-token) revives the same rows via identity/fingerprint — no
 * duplicate accounts.
 */

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";

export interface DisconnectAccountsResult {
  disconnectedAccountIds: string[];
  affectedSpaceIds:       string[];
  plaidItemDbIds:         string[];
}

/**
 * Soft-disconnect the given FinancialAccounts together. Idempotent-safe: accounts
 * already soft-deleted are skipped by the `deletedAt: null` filters.
 *
 * @param financialAccountIds  accounts to disconnect (caller has authorized these)
 * @param actorUserId          the user performing the disconnect (for SAL.revokedByUserId)
 */
export async function disconnectAccounts(
  financialAccountIds: string[],
  actorUserId: string,
): Promise<DisconnectAccountsResult> {
  if (financialAccountIds.length === 0) {
    return { disconnectedAccountIds: [], affectedSpaceIds: [], plaidItemDbIds: [] };
  }
  const now = new Date();

  // Plaid items to consider for orphan-revocation — captured from LIVE connections
  // BEFORE the soft-delete (after which the orphan-gate sees zero live links).
  const conns = await db.accountConnection.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, deletedAt: null, plaidItemDbId: { not: null } },
    select: { plaidItemDbId: true },
  });
  const plaidItemDbIds = [...new Set(conns.map((c) => c.plaidItemDbId).filter((v): v is string => !!v))];

  // KD-4 — soft-delete + connection close + SAL revoke commit atomically; the
  // affected-space capture (a read of ACTIVE links) runs inside the tx before the
  // revoke, observing pre-revocation state. Snapshot regen + Plaid disconnect stay
  // OUTSIDE the transaction (KD-4: external calls never inside a tx).
  const activeLinks = await db.$transaction(async (tx) => {
    await tx.financialAccount.updateMany({
      where: { id: { in: financialAccountIds }, deletedAt: null },
      data:  { deletedAt: now },
    });
    await tx.accountConnection.updateMany({
      where: { financialAccountId: { in: financialAccountIds }, deletedAt: null },
      data:  { deletedAt: now },
    });
    const links = await tx.spaceAccountLink.findMany({
      where:  { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
      select: { spaceId: true },
    });
    await tx.spaceAccountLink.updateMany({
      where: { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
      data:  { status: ShareStatus.REVOKED, revokedAt: now, revokedByUserId: actorUserId },
    });
    return links;
  });

  const affectedSpaceIds = [...new Set(activeLinks.map((l) => l.spaceId))];

  // Today's row only — historical correction is deferred (CONN-4 doctrine).
  for (const spaceId of affectedSpaceIds) {
    try {
      await regenerateSpaceSnapshot(spaceId);
    } catch (e) {
      console.warn(`[disconnectAccounts] snapshot regen failed for space ${spaceId} (non-fatal):`, e);
    }
  }

  // Revoke provider access when the item is now fully orphaned (best-effort).
  for (const plaidItemDbId of plaidItemDbIds) {
    await disconnectPlaidItemIfOrphaned(plaidItemDbId);
  }

  return { disconnectedAccountIds: financialAccountIds, affectedSpaceIds, plaidItemDbIds };
}
