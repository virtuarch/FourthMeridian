/**
 * lib/notifications/wallet-attention.ts
 *
 * The typed WALLET STATE a WALLET_SYNC_FAILED notice carries, the copy each
 * state renders, and the sustained-failure rule — pure (no I/O), so the
 * registry render and the producer (lib/crypto/wallet-sync-notifications.ts)
 * share one definition. The wallet twin of connection-attention.ts.
 *
 *   Connection.errorCode                         state
 *   INVALID_WALLET_ADDRESS, INVALID_XPUB      →  "needs-attention"  (the user must fix the address)
 *   PROVIDER_NOT_CONFIGURED, CHAIN_UNSUPPORTED →  none — platform-side, never notified
 *   anything else (BALANCE_UNAVAILABLE,        →  "temporary"        (provider unreachable / rate
 *   RATE_LIMITED, DISCOVERY_FAILED, …)                                limited; we keep retrying)
 *
 * Unknown or missing state renders the "temporary" copy. No state ever says
 * "disconnected": a wallet sync failure never disconnects the wallet.
 */

/** How long a wallet must have been failing (since its first failure) before it notifies. */
export const WALLET_SYNC_SUSTAINED_HOURS = 24;

export const WALLET_ATTENTION_STATES = ["temporary", "needs-attention"] as const;
export type WalletAttentionState = (typeof WALLET_ATTENTION_STATES)[number];

/** The user must fix these: the stored address / key is not valid for the chain. */
const NEEDS_ATTENTION_CODES: ReadonlySet<string> = new Set(["INVALID_WALLET_ADDRESS", "INVALID_XPUB"]);
/** Platform-side: not the user's problem and nothing they can do. Never notified. */
const PLATFORM_SIDE_CODES: ReadonlySet<string> = new Set(["PROVIDER_NOT_CONFIGURED", "CHAIN_UNSUPPORTED"]);

/** The Connection errorCode (or the outcome's own code) → the state a notice may claim; null = never notify. */
export function walletAttentionState(errorCode: string | null | undefined): WalletAttentionState | null {
  if (!errorCode) return null;
  if (PLATFORM_SIDE_CODES.has(errorCode)) return null;
  if (NEEDS_ATTENTION_CODES.has(errorCode)) return "needs-attention";
  return "temporary";
}

/** Narrow untrusted render data; anything unrecognised is the conservative "temporary". */
export function parseWalletAttentionState(value: unknown): WalletAttentionState {
  return value === "needs-attention" ? "needs-attention" : "temporary";
}

/** Chain key → how the notice names the network. */
const NETWORK_LABEL: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB Chain", AVAX: "Avalanche",
};
export function walletNetworkLabel(chain: string | null | undefined): string {
  const key = chain?.trim().toUpperCase() ?? "";
  return NETWORK_LABEL[key] ?? (key || "its network");
}

/** The copy each state renders (the registry render calls this). `wallet` / `network` are already non-empty. */
export function walletAttentionCopy(state: unknown, wallet: string, network: string): { title: string; body: string; actionLabel: string } {
  if (parseWalletAttentionState(state) === "needs-attention") {
    return {
      title: `${wallet} needs attention`,
      body: `We can't sync ${wallet} because its address isn't valid for ${network}. Check the address, or remove the wallet and add it again with the correct one.`,
      actionLabel: "Review wallet",
    };
  }
  return {
    title: `We haven't been able to update ${wallet}`,
    body: `We haven't been able to read ${wallet} from ${network} for more than a day, so its balance may be out of date. The wallet is still connected and we'll keep retrying automatically.`,
    actionLabel: "View wallet",
  };
}

/** True when the outage that started at `degradedSince` has lasted the sustained threshold. */
export function isSustainedWalletFailure(degradedSince: Date | null, now: Date): boolean {
  return degradedSince !== null && now.getTime() - degradedSince.getTime() >= WALLET_SYNC_SUSTAINED_HOURS * 3_600_000;
}
