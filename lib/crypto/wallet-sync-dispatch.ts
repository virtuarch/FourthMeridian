/**
 * lib/crypto/wallet-sync-dispatch.ts
 *
 * W-M1d — WHICH ADAPTER SERVES THIS WALLET, AND HOW FAR DOES IT GO?
 *
 * One registry, keyed by `FinancialAccount.walletChain`, mapping a chain to the
 * adapter that syncs it and to what that adapter can honestly claim. Routes call
 * `syncWalletByChain`; nothing above this file names a chain or an adapter.
 *
 * ── Why a registry rather than three `if` branches at each call site ─────────
 * Because there are FOUR call sites (wallet create, wallet re-add, wallet
 * restore, manual sync) and they had already drifted: three of them ran
 * `if (chain === BTC_CHAIN)` twice — once for the sync and once for the wealth
 * history — and the sync route rejected everything else with a message naming
 * Bitcoin. Adding two chains that way means eight new branches and four new
 * chances for a route to forget one. A registry makes "which chains can sync"
 * a single fact and makes forgetting structurally impossible.
 *
 * ── SUPPORT IS A CLAIM, AND IT IS GRADED ────────────────────────────────────
 * `WalletChainSupport` is the honest answer to "what does this system know about
 * this chain", and the three levels are genuinely different promises:
 *
 *   HISTORY_SUPPORTED           balance, movement ledger, reconciliation, and a
 *                               licensed historical quantity. Today: BTC ONLY.
 *   CURRENT_POSITION_SUPPORTED  a canonical CURRENT position, valued at the
 *                               dated close. No movement ledger, so no history
 *                               and no net-worth participation. ETH, SOL.
 *   UNSUPPORTED                 custody may be RECORDED, but nothing can read
 *                               the chain. MATIC, AVAX, DOT, ADA, XRP, OTHER.
 *
 * A chain is promoted to HISTORY_SUPPORTED only when historical acquisition and
 * reconstruction are PROVEN — never because an adapter exists. Recording custody
 * and being able to value it are different capabilities, and the wallet route
 * deliberately accepts more chains than this registry serves: a user may record
 * a Cardano wallet, and this system will honestly say it cannot read it rather
 * than pretend it holds nothing.
 *
 * ── The dispatcher does NOT unify the adapters' internals ───────────────────
 * Each adapter keeps its own result shape, its own staged failures, and its own
 * provider semantics — that is the point of an adapter. What is unified is the
 * OUTCOME a route needs: did it work, what should the caller be told, and may
 * this chain's history be regenerated. Chain-specific detail rides along in
 * `raw` for logging, never for branching.
 */

import { syncBtcWallet, BTC_CHAIN } from "@/lib/crypto/btc-sync";
import { syncEthWallet, ETH_CHAIN } from "@/lib/crypto/eth-sync";
import { syncSolWallet, SOL_CHAIN } from "@/lib/crypto/sol-sync";
import { recordWalletSyncRefusal } from "@/lib/accounts/wallet-connection";

/** How far this system can go on a given chain. See the header. */
export type WalletChainSupport =
  | "HISTORY_SUPPORTED"
  | "CURRENT_POSITION_SUPPORTED"
  | "UNSUPPORTED";

/**
 * W-M2a — THE GENERIC, CHAIN-AGNOSTIC REASON A WALLET SYNC DID NOT COMPLETE.
 *
 * Recorded on `Connection.errorCode`, which is what the Connections surface
 * derives its state from. Each code names a DIFFERENT response, which is the
 * only reason they are separate: configure something, correct an address, wait
 * and retry, or look at why a read succeeded and a write did not.
 *
 * Deliberately not per-chain. "This deployment cannot reach the chain" is the
 * same operational fact for Solana, Ethereum and every network after them; the
 * chain is already on the account. A per-chain code set would multiply with the
 * chain list and teach the UI to branch on chains rather than on states.
 */
export type WalletSyncErrorCode =
  /** No provider endpoint is configured for this chain on this deployment. */
  | "PROVIDER_NOT_CONFIGURED"
  /** The stored address is not well-formed for its chain. Permanent until edited. */
  | "INVALID_WALLET_ADDRESS"
  /** The chain could not be read this run — transport, rate limit, bad response. */
  | "BALANCE_UNAVAILABLE"
  /** The balance was read but the canonical position could not be recorded. */
  | "POSITION_CAPTURE_UNAVAILABLE"
  /** No adapter serves this chain. */
  | "CHAIN_UNSUPPORTED"
  /** An adapter threw despite its never-throw contract. */
  | "ADAPTER_ERROR";

/**
 * Map an adapter's own failure stage onto the generic code. Pure, so the mapping
 * is testable without a database and cannot drift from what is recorded.
 *
 * An unrecognised stage yields BALANCE_UNAVAILABLE rather than nothing: a
 * refusal whose stage this function has not learned yet is still a refusal, and
 * defaulting to "no code" would put the connection straight back into the
 * silence that made a terminal failure look like progress.
 */
export function walletSyncErrorCode(stage: string | undefined): WalletSyncErrorCode {
  switch (stage) {
    case "config":            return "PROVIDER_NOT_CONFIGURED";
    case "address":           return "INVALID_WALLET_ADDRESS";
    case "capture":           return "POSITION_CAPTURE_UNAVAILABLE";
    case "unsupported-chain": return "CHAIN_UNSUPPORTED";
    case "adapter-error":     return "ADAPTER_ERROR";
    default:                  return "BALANCE_UNAVAILABLE";
  }
}

/** The unified outcome a ROUTE needs. Adapters keep their own richer results. */
export interface WalletSyncOutcome {
  accountId: string;
  chain:     string;
  support:   WalletChainSupport;
  ok:        boolean;
  syncStatus?: "synced" | "pending";
  /** Which step failed, in the adapter's own vocabulary. */
  stage?:    string;
  /** Operator/user-facing explanation. Always present on failure. */
  reason?:   string;
  /**
   * Does this chain's asset contribute to NET WORTH today?
   *
   * BTC does, through the legacy `FinancialAccount.balance` column. ETH and SOL
   * deliberately do not: their adapters write no balance column, so their value
   * lives only on the dated position spine until the wallet net-worth
   * convergence lands. Surfaced here so a route never has to infer it.
   */
  netWorthParticipation: "LEGACY_BALANCE_COLUMN" | "WITHHELD_PENDING_CONVERGENCE" | "NONE";
  /** W-M2a — the generic code recorded on the Connection. Present on failure. */
  errorCode?: WalletSyncErrorCode;
  /** The adapter's own result, for logging. NEVER branched on by a caller. */
  raw?: unknown;
}

interface ChainAdapter {
  support: WalletChainSupport;
  netWorthParticipation: WalletSyncOutcome["netWorthParticipation"];
  sync(accountId: string): Promise<{
    ok: boolean; syncStatus?: "synced" | "pending"; stage?: string; reason?: string;
  }>;
}

/**
 * THE registry. A chain absent from this map is UNSUPPORTED by sync — which is a
 * stated outcome, not a fall-through.
 */
const ADAPTERS: Readonly<Record<string, ChainAdapter>> = {
  [BTC_CHAIN]: {
    // The only chain with a movement ledger, a reconciliation and a licensed
    // historical carry. Also the only one still writing the legacy balance
    // column that net worth composes from.
    support: "HISTORY_SUPPORTED",
    netWorthParticipation: "LEGACY_BALANCE_COLUMN",
    sync: (id) => syncBtcWallet(id),
  },
  [ETH_CHAIN]: {
    support: "CURRENT_POSITION_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    sync: (id) => syncEthWallet(id),
  },
  [SOL_CHAIN]: {
    support: "CURRENT_POSITION_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    sync: (id) => syncSolWallet(id),
  },
};

/** Every chain this system can actually read, sorted. Display and diagnostics. */
export const SYNCABLE_CHAINS: readonly string[] = Object.keys(ADAPTERS).sort();

/** How far this system can go on `chain`. Unknown/absent ⇒ UNSUPPORTED. */
export function walletChainSupport(chain: string | null | undefined): WalletChainSupport {
  if (!chain) return "UNSUPPORTED";
  return ADAPTERS[chain.trim().toUpperCase()]?.support ?? "UNSUPPORTED";
}

/** Can this chain be synced at all? */
export function isSyncableChain(chain: string | null | undefined): boolean {
  return walletChainSupport(chain) !== "UNSUPPORTED";
}

/**
 * May this chain's WEALTH HISTORY be regenerated after a sync?
 *
 * Only HISTORY_SUPPORTED chains. This is not a performance guard: regeneration
 * derives a historical quantity, and for a chain with no movement ledger there
 * is nothing to derive one FROM. Running it would either refuse every day (noise)
 * or, worse, invite someone to "fix" the refusal by painting today's quantity
 * backwards — which is the one thing this engine must never do.
 */
export function chainSupportsHistory(chain: string | null | undefined): boolean {
  return walletChainSupport(chain) === "HISTORY_SUPPORTED";
}

/**
 * Sync one wallet through its chain's adapter.
 *
 * Never throws: every adapter already carries a never-throw contract, and an
 * unexpected throw is caught here so one chain's defect cannot break a route
 * that serves three.
 *
 * An UNSUPPORTED chain is refused with a reason naming the chain and what IS
 * supported — never a generic failure, and never a silent success that would
 * leave the account looking synced while nothing was read.
 */
export async function syncWalletByChain(
  accountId: string,
  chain: string | null | undefined,
): Promise<WalletSyncOutcome> {
  const key = chain?.trim().toUpperCase() ?? "";
  const adapter = ADAPTERS[key];

  if (!adapter) {
    await recordWalletSyncRefusal({ financialAccountId: accountId, errorCode: "CHAIN_UNSUPPORTED" });
    return {
      accountId,
      chain: key || "(none)",
      support: "UNSUPPORTED",
      ok: false,
      stage: "unsupported-chain",
      errorCode: "CHAIN_UNSUPPORTED",
      reason:
        `Fourth Meridian cannot read ${key || "this"} wallets yet. ` +
        `Balance sync is available for ${SYNCABLE_CHAINS.join(", ")}. ` +
        "The wallet stays recorded and visible; only its balance is unavailable.",
      netWorthParticipation: "NONE",
    };
  }

  try {
    const result = await adapter.sync(accountId);
    // W-M2a — A REFUSAL MUST REACH THE CONNECTION, NOT ONLY THE INCIDENT LOG.
    //
    // Every adapter already records a SyncIssue. None of them (outside BTC's
    // xpub branch) told `Connection.errorCode`, which is the field the
    // Connections surface actually derives state from — so a terminal refusal
    // left the connection saying nothing, and "nothing" was read as "still
    // working". Recorded HERE so every chain gets it from one place, and
    // conditionally so an adapter's own more specific diagnosis always wins.
    const errorCode = result.ok ? undefined : walletSyncErrorCode(result.stage);
    if (errorCode) await recordWalletSyncRefusal({ financialAccountId: accountId, errorCode });
    return {
      accountId,
      chain: key,
      support: adapter.support,
      ok: result.ok,
      syncStatus: result.syncStatus,
      stage: result.stage,
      reason: result.reason,
      errorCode,
      // A FAILED sync contributes nothing to net worth whatever the chain
      // normally does — reporting the chain's usual participation on a run that
      // wrote nothing would overstate what the row now contains.
      netWorthParticipation: result.ok ? adapter.netWorthParticipation : "NONE",
      raw: result,
    };
  } catch (e) {
    // Defensive: every adapter promises not to throw. If one does, the route
    // must still answer honestly rather than 500.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[wallet-sync] ${key} adapter threw for ${accountId} (contract violation):`, reason);
    await recordWalletSyncRefusal({ financialAccountId: accountId, errorCode: "ADAPTER_ERROR" });
    return {
      accountId, chain: key, support: adapter.support, ok: false,
      stage: "adapter-error", reason, errorCode: "ADAPTER_ERROR",
      netWorthParticipation: "NONE",
    };
  }
}
