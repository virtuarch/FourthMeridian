/**
 * lib/assets/secured-debt-scrub.ts   (Mortgage F9 — S2 D1)
 *
 * ManualAssetProfile.securedDebtAccountIds holds debt FinancialAccount ids with
 * no FK (a Postgres array cannot carry one). When a debt account is PERMANENTLY
 * deleted, its id must leave every property's link list — across users, since a
 * co-member's property may have linked a shared mortgage — in the SAME
 * transaction as the delete, so no row ever names an account that is gone.
 *
 * Called by every FinancialAccount hard-delete path that can remove a debt:
 *   · lib/account-deletion/purge.ts       (user-account deletion, step 5b)
 *   · scripts/purge-plaid-connection.ts   (operator Plaid-connection purge)
 * (app/api/accounts/manual/[id]/permanent deletes only type=other manual assets,
 * whose own profile cascades with them; it can never delete a linked debt.)
 *
 * The caller's client must be able to see every profile (the purge / operator
 * client, not a tenant one). It writes ONLY securedDebtAccountIds — never an
 * acquisition or purchase column (lib/snapshots/regenerate-history.membership
 * guard). NULL arrays never match `hasSome` and are left as they are (NULL reads
 * as "no links" everywhere — normalizeSecuredDebtIds).
 */

export interface SecuredDebtScrubClient {
  manualAssetProfile: {
    findMany(args: {
      where:  { securedDebtAccountIds: { hasSome: string[] } };
      select: { id: true; securedDebtAccountIds: true };
    }): Promise<{ id: string; securedDebtAccountIds: string[] | null }[]>;
    update(args: { where: { id: string }; data: { securedDebtAccountIds: string[] } }): Promise<unknown>;
  };
}

/** Remove `deletedAccountIds` from every profile's link list. Returns rows changed. */
export async function scrubSecuredDebtLinks(tx: SecuredDebtScrubClient, deletedAccountIds: readonly string[]): Promise<number> {
  const gone = [...new Set(deletedAccountIds)];
  if (gone.length === 0) return 0;
  const goneSet = new Set(gone);
  const rows = await tx.manualAssetProfile.findMany({
    where:  { securedDebtAccountIds: { hasSome: gone } },
    select: { id: true, securedDebtAccountIds: true },
  });
  let changed = 0;
  for (const r of rows) {
    const current = r.securedDebtAccountIds ?? [];
    const kept = current.filter((id) => !goneSet.has(id));
    if (kept.length === current.length) continue;
    await tx.manualAssetProfile.update({ where: { id: r.id }, data: { securedDebtAccountIds: kept } });
    changed++;
  }
  return changed;
}
