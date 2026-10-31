/**
 * lib/crypto/wallet-sync-notifications.ts  (owner-approved 2026-10-31)
 *
 * The WALLET_SYNC_FAILED producer and its retirement — the wallet twin of
 * lib/plaid/sync-notifications.ts. syncWalletByChain (wallet-sync-dispatch.ts)
 * calls evaluateWalletSyncAttention once with every outcome it returns, for
 * every trigger (scheduled sweep, manual sync, Refresh All, wallet create).
 *
 * WHEN IT NOTIFIES — a SUSTAINED failure only, never one transient blip:
 *   1. this attempt FAILED (outcome.ok === false), and
 *   2. it belongs to an UNBROKEN RUN OF FAILED SYNC ATTEMPTS whose first failed
 *      attempt started at least WALLET_SYNC_SUSTAINED_HOURS (24 h) ago.
 *   The run is read from the per-attempt ledger every wallet sync already
 *   writes (RefreshExecution: sourceKind WALLET, sourceRef = the account,
 *   overallStatus per attempt — runFullRefresh in syncWalletByChain), through
 *   the DF-2 execution-query seam (listWalletAttemptOutcomes, last 7 days): the
 *   first FAILED attempt after the latest SUCCEEDED / PARTIAL one. (FAILED =
 *   no provider stage succeeded; an ok:false run whose import stage succeeded
 *   reads PARTIAL and resets the run — the conservative direction.) ANY successful
 *   attempt resets the run — including one that leaves a Connection code
 *   behind (BTC NO_USED_ADDRESSES: the xpub reads fine, nothing is used yet).
 *   So "degraded for a week, then one timeout" is NOT sustained: the run is one
 *   failure long. (Review fix 2026-10-31: the Connection's DEGRADED-since time
 *   was the wrong clock — a DEGRADED period can be made of SUCCESSFUL syncs.)
 *   SKIPPED attempts and attempts still RUNNING are neither failure nor
 *   success. Measured from the first FAILURE, never from the last success, so
 *   a pause in attempts (Cost Freeze, a deactivated owner) cannot turn the
 *   first failure after it into a notice. At least two failed attempts, 24 h
 *   apart (≥ 4 sync windows at the default 6-hourly cadence). No ledger row ⇒
 *   no evidence ⇒ no notice (conservative). Rows live 60 days
 *   (jobs/data-retention.ts), far beyond the 24 h this needs.
 *
 * WHAT IT CLAIMS — real states only (lib/notifications/wallet-attention.ts):
 *   "temporary"        the provider could not be read (timeout, rate limit,
 *                      provider error, discovery failure). The copy says we keep
 *                      retrying and the wallet is still connected — never
 *                      "disconnected".
 *   "needs-attention"  the stored address / extended key is not valid for its
 *                      chain: retrying cannot fix it, the user must.
 *   (none)             platform-side codes (PROVIDER_NOT_CONFIGURED,
 *                      CHAIN_UNSUPPORTED) are OUR problem, not the user's, and
 *                      surface to operators through Platform Ops — no notice.
 *
 * SUPPRESSED:
 *   - a wallet the user removed (FinancialAccount.deletedAt set, re-read at
 *     notify time — a sync can finish after the removal), or with no owner;
 *   - under the global Cost Freeze. Every freeze / plan gate runs BEFORE
 *     syncWalletByChain, so a freeze SKIP never reaches here at all and is never
 *     a failure; the freeze is re-read here only so a sync that started just
 *     before a freeze landed cannot notify after it (an unreadable flag counts
 *     as frozen — readGlobalCostFreeze fails closed).
 *
 * DEDUPE + RELEASE: suppress-while-open on "WALLET_SYNC_FAILED:account:
 * {financialAccountId}:open" — one notice per wallet per outage, however many
 * sweeps observe it. A successful sync with a clean Connection retires the key
 * (retireOpenNotification), so the NEXT outage notifies again.
 *
 * CHANNELS (registry): IN_APP by default; the email leg is opt-in through the
 * FINANCIAL email preference and, like SYNC_FAILED (owner ruling O-7), follows
 * only that preference — FINANCIAL in-app off does not drop an opted-in email.
 *
 * Best-effort and NON-THROWING: a wallet sync never fails over its notice.
 */

import { systemDb } from "@/lib/db";
import { createNotification } from "@/lib/notifications/create";
import { retireOpenNotification } from "@/lib/notifications/resolve";
import { failureRunStartFrom, isSustainedWalletFailure, walletAttentionStateFor, walletNetworkLabel } from "@/lib/notifications/wallet-attention";

/** How far back the attempt ledger is read (a longer run still reads as at least this old). */
const WALLET_ATTEMPT_LOOKBACK_DAYS = 7;
/** At most this many attempts are read; a truncated window can only UNDER-state a run's age. */
const WALLET_ATTEMPT_LOOKBACK_ROWS = 200;

export { WALLET_SYNC_SUSTAINED_HOURS, walletAttentionState, walletAttentionStateFor, isSustainedWalletFailure, failureRunStartFrom } from "@/lib/notifications/wallet-attention";

// ── Reads (injected in tests; systemDb in production) ────────────────────────

export interface WalletAttentionAccount {
  ownerUserId: string | null;
  deletedAt: Date | null;
  name: string;
  displayName: string | null;
  walletChain: string | null;
  /** The live linked Connection, when there is one. */
  connection: { id: string; errorCode: string | null } | null;
}

export interface WalletAttentionReads {
  account(accountId: string): Promise<WalletAttentionAccount | null>;
  /**
   * When the current unbroken run of FAILED sync attempts began: the first
   * FAILED attempt after the latest successful (SUCCEEDED / PARTIAL) one, or
   * null when there is none on record.
   */
  failureRunStart(accountId: string, now: Date): Promise<Date | null>;
  /** The global Cost Freeze (true = frozen OR unreadable). */
  costFrozen(): Promise<boolean>;
}

const productionReads: WalletAttentionReads = {
  async account(accountId) {
    const fa = await systemDb.financialAccount.findUnique({
      where: { id: accountId },
      select: {
        ownerUserId: true, deletedAt: true, name: true, displayName: true, walletChain: true,
        connections: {
          where: { deletedAt: null, connectionId: { not: null } },
          take: 1,
          select: { connection: { select: { id: true, errorCode: true } } },
        },
      },
    });
    if (!fa) return null;
    return {
      ownerUserId: fa.ownerUserId, deletedAt: fa.deletedAt, name: fa.name, displayName: fa.displayName,
      walletChain: fa.walletChain, connection: fa.connections[0]?.connection ?? null,
    };
  },
  async failureRunStart(accountId, now) {
    // Through the DF-2 execution-query seam (read-boundary.test.ts): bounded rows,
    // the decision is ours. A run older than the window still reads as ≥ 7 days.
    const { listWalletAttemptOutcomes } = await import("@/lib/platform/refresh/execution-query");
    const rows = await listWalletAttemptOutcomes(accountId, {
      since: new Date(now.getTime() - WALLET_ATTEMPT_LOOKBACK_DAYS * 24 * 3_600_000),
      take: WALLET_ATTEMPT_LOOKBACK_ROWS,
    });
    return failureRunStartFrom(rows);
  },
  async costFrozen() {
    const { readGlobalCostFreeze } = await import("@/lib/platform/cost-freeze");
    return (await readGlobalCostFreeze()).frozen;
  },
};

export interface WalletSyncOutcomeLike {
  accountId: string;
  chain: string;
  ok: boolean;
  errorCode?: string;
}

export interface WalletAttentionDeps {
  reads?: WalletAttentionReads;
  create?: typeof createNotification;
  retire?: typeof retireOpenNotification;
  now?: () => Date;
}

export type WalletAttentionVerdict =
  | "NOTIFIED"        // the chokepoint was called (it may still suppress on the open key)
  | "RETIRED"         // a success released the open key
  | "NOT_SUSTAINED"   // failing, but the unbroken run of failed attempts is < 24 h old (or not on record)
  | "NOT_NOTIFIABLE"  // platform-side code / no error code recorded
  | "REMOVED"         // the user removed the wallet, or it has no owner
  | "COST_FROZEN"     // the global Cost Freeze is on (or unreadable)
  | "HEALTHY_NOOP"    // ok, but the Connection still carries a code (e.g. NO_USED_ADDRESSES): neither notify nor release
  | "ERROR";          // a read failed — logged, nothing sent

/** Evaluate one sync outcome. Never throws. */
export async function evaluateWalletSyncAttention(outcome: WalletSyncOutcomeLike, deps: WalletAttentionDeps = {}): Promise<WalletAttentionVerdict> {
  const reads = deps.reads ?? productionReads;
  try {
    const account = await reads.account(outcome.accountId);
    if (!account || !account.ownerUserId || account.deletedAt) return "REMOVED";
    const userId = account.ownerUserId;

    if (outcome.ok) {
      // Release only when the Connection is clean: an ok run can leave a code
      // (BTC NO_USED_ADDRESSES), which is not a recovery.
      if (account.connection?.errorCode) return "HEALTHY_NOOP";
      await (deps.retire ?? retireOpenNotification)(userId, "WALLET_SYNC_FAILED", { financialAccountId: outcome.accountId });
      return "RETIRED";
    }

    // This attempt's own code and the Connection's (an adapter's more specific
    // diagnosis, e.g. BTC INVALID_XPUB, is written there and never overwritten).
    const state = walletAttentionStateFor(outcome.errorCode, account.connection?.errorCode);
    if (!state) return "NOT_NOTIFIABLE";
    const now = (deps.now ?? (() => new Date()))();
    const since = await reads.failureRunStart(outcome.accountId, now);
    if (!isSustainedWalletFailure(since, now)) return "NOT_SUSTAINED";
    if (await reads.costFrozen()) return "COST_FROZEN";

    await (deps.create ?? createNotification)({
      type: "WALLET_SYNC_FAILED",
      userId,
      data: {
        financialAccountId: outcome.accountId,
        walletName: (account.displayName?.trim() || account.name || "").slice(0, 80),
        network: walletNetworkLabel(account.walletChain ?? outcome.chain),
        walletState: state,
      },
    });
    return "NOTIFIED";
  } catch (err) {
    // Only the error class: a DB error message can echo query values.
    console.warn(`[wallet-sync-notifications] evaluation failed for ${outcome.accountId} (non-fatal): ${err instanceof Error ? err.name : typeof err}`);
    return "ERROR";
  }
}
