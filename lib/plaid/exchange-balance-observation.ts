/**
 * lib/plaid/exchange-balance-observation.ts  (FIN-A2 — FM-AUDIT-023, new-row half)
 *
 * The incident record for an account that the token exchange CREATED without an
 * observed balance, and its closure when an observed balance later lands on it.
 * Kept out of exchangeToken.ts (the IDEMP-008 precedent, exchange-collision.ts)
 * so that module's "an admission decision never records a sync issue" pin keeps
 * meaning what it says. Both go through the ONE incident writer
 * (lib/plaid/syncIssues.ts → lib/platform/incidents/lifecycle.ts); neither
 * writes a SyncIssue row itself. Never throws.
 */
import { SyncIssueKind } from "@prisma/client";
import { recordSyncIssue, resolveBalanceUnobservedIssue } from "@/lib/plaid/syncIssues";

/** Raise BALANCE_UNOBSERVED for a new row whose provider balance was null. */
export async function recordExchangeBalanceUnobserved(
  financialAccountId: string,
  plaidAccountId: string,
  plaidItemDbId: string,
): Promise<void> {
  await recordSyncIssue({
    kind: SyncIssueKind.BALANCE_UNOBSERVED,
    // Scoped to the ACCOUNT (no plaidItemId): each unobserved account is its own
    // episode, closed by its own first observed balance.
    financialAccountId,
    plaidAccountId,
    detail: { stage: "exchange-balance-unobserved", plaidItemDbId },
  });
}

/** Close it after an observed balance was written onto an existing row. */
export async function resolveExchangeBalanceObserved(financialAccountId: string): Promise<void> {
  await resolveBalanceUnobservedIssue(financialAccountId);
}
