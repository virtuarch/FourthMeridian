/**
 * jobs/plaid-removal-retry.ts  (BETA C4 — coordinator STUB; Workstream W2a fills it)
 *
 * Re-attempts Plaid /item/remove for every PlaidItem the product shows REVOKED
 * whose newest revocation marker is UNCONFIRMED (lib/platform/plaid/provider-cleanup.ts
 * folds the markers; lib/plaid/disconnect.ts is the ONE removal path and must be
 * reused — never a second itemRemove call site). Daily, fixed cadence.
 */
export interface PlaidRemovalRetryResult { attempted: number; confirmed: number; stillUnconfirmed: number; }
export async function retryPlaidRemovals(): Promise<PlaidRemovalRetryResult> {
  throw new Error("plaid-removal-retry: not implemented (BETA W2a)");
}
