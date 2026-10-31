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
 *   2. the wallet's Connection is DEGRADED (errorCode set) and has been since
 *      the outage's FIRST observed failure — the latest
 *      WALLET_CONNECTION_STATUS_CHANGED → DEGRADED audit row
 *      (lib/connections/health-transitions.ts, the existing health history) —
 *      at least WALLET_SYNC_SUSTAINED_HOURS (24 h) ago.
 *   So at least two failed attempts, 24 h apart, with no success between them
 *   (a success clears errorCode and writes HEALTHY, which ends the outage). At
 *   the default 6-hourly wallet cadence that is ≥ 4 missed sync windows.
 *   Measured from the first FAILURE, not from the last success, so a pause in
 *   attempts (a Cost Freeze, a deactivated owner) can never turn the first
 *   failure after it into a notice. No audit row ⇒ no evidence of an outage
 *   start ⇒ no notice (conservative).
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
import { AuditAction } from "@/lib/audit-actions";
import { createNotification } from "@/lib/notifications/create";
import { retireOpenNotification } from "@/lib/notifications/resolve";
import { isSustainedWalletFailure, walletAttentionState, walletNetworkLabel } from "@/lib/notifications/wallet-attention";

export { WALLET_SYNC_SUSTAINED_HOURS, walletAttentionState, isSustainedWalletFailure } from "@/lib/notifications/wallet-attention";

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
  /** When the Connection's current outage began (latest → DEGRADED transition), or null. */
  degradedSince(userId: string, connectionId: string): Promise<Date | null>;
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
  async degradedSince(userId, connectionId) {
    // Wallet transitions are rare (one row per HEALTHY↔DEGRADED flip); the
    // user's latest few cover every wallet they hold. Newest first.
    const rows = await systemDb.auditLog.findMany({
      where: { userId, action: AuditAction.WALLET_CONNECTION_STATUS_CHANGED },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { createdAt: true, metadata: true },
    });
    for (const r of rows) {
      const meta = (r.metadata ?? {}) as { connectionId?: unknown; to?: unknown };
      if (meta.connectionId !== connectionId) continue;
      return meta.to === "DEGRADED" ? r.createdAt : null; // the latest transition decides
    }
    return null;
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
  | "NOT_SUSTAINED"   // failing, but not for long enough (or no outage start on record)
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

    const state = walletAttentionState(account.connection?.errorCode ?? outcome.errorCode);
    if (!state || !account.connection) return "NOT_NOTIFIABLE";
    const since = await reads.degradedSince(userId, account.connection.id);
    if (!isSustainedWalletFailure(since, (deps.now ?? (() => new Date()))())) return "NOT_SUSTAINED";
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
