/**
 * lib/plaid/exchange-collision.ts  (IDEMP-008)
 *
 * The record for ONE Plaid account that hit a uniqueness collision while the
 * exchange persisted it. A genuine persistence failure (not a policy outcome),
 * kept out of exchangeToken.ts so that module's "an admission decision never
 * records a sync issue" pin keeps meaning what it says. Never throws.
 */
import { SyncIssueKind } from "@prisma/client";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";

export async function recordExchangeAccountCollision(plaidItemId: string, plaidAccountId: string): Promise<void> {
  await recordSyncIssue({
    kind: SyncIssueKind.UPSERT_ERROR,
    plaidItemId,
    plaidAccountId,
    detail: { stage: "exchange-account-persist", code: "P2002" },
  });
}
