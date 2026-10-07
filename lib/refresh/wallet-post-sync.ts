/**
 * lib/refresh/wallet-post-sync.ts  (P1 REFRESH ALL)
 *
 * WHAT HAPPENS AFTER A WALLET ADAPTER RUNS — extracted verbatim from
 * app/api/accounts/[id]/sync/route.ts so the customer's Refresh All and the
 * single-wallet route finish a sync the same way: today's snapshots for every
 * account the run re-valued or re-quoted, then the wealth HISTORY for this
 * account only, over the canonical planned window, and only on a chain that has
 * a movement ledger. Best-effort and non-fatal at every step, exactly as before.
 *
 * Authority is unchanged and still named rather than inherited: the snapshot
 * scope ranges over every holder of a re-quoted asset and the regenerators write
 * co-owners' rows, which is why they run on their own (fm_system) authority.
 */

import {
  chainSupportsHistory, outcomeRevalued, type WalletSyncOutcome,
} from "@/lib/crypto/wallet-sync-dispatch";
import { snapshotAccountsForOutcome } from "@/lib/crypto/wallet-snapshot-scope";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { regenerateWealthHistoryForAccounts } from "@/lib/snapshots/regenerate-history";
import { resolveHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window";
import { redactedErrorForLog } from "@/lib/plaid/errors";

export async function finalizeWalletSync(args: {
  accountId: string;
  chain: string | null;
  outcome: WalletSyncOutcome;
  syncStartedAt: Date;
  logPrefix: string;
}): Promise<void> {
  const { accountId, chain, outcome, syncStartedAt, logPrefix } = args;
  const snapshotAccounts = await snapshotAccountsForOutcome(outcome).catch(() => (outcomeRevalued(outcome) ? [accountId] : []));
  if (snapshotAccounts.length > 0) {
    try {
      await regenerateSnapshotsForAccounts(snapshotAccounts);
    } catch (snapshotErr) {
      console.warn(`${logPrefix} snapshot regen failed (non-fatal):`, redactedErrorForLog(snapshotErr));
    }
  }
  if (outcomeRevalued(outcome) && chainSupportsHistory(chain)) {
    try {
      const plan = await resolveHistoricalWorkWindow({
        financialAccountIds: [accountId],
        changedSince:        syncStartedAt,
        positionHistoryImpactedFromISO: outcome.historyRefresh?.impactedFromISO,
      });
      console.log(`${logPrefix} historical window ${plan.fromDate}..${plan.toDate} (${plan.mode}) — ${plan.reasons.join("; ")}`);
      await regenerateWealthHistoryForAccounts([accountId], { fromDate: plan.fromDate, toDate: plan.toDate });
    } catch (wealthErr) {
      console.warn(`${logPrefix} wealth-history regen failed (non-fatal):`, redactedErrorForLog(wealthErr));
    }
  }
}
