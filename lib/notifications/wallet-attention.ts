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

/** How long an unbroken run of failed sync attempts must have lasted (from its first failed attempt) before it notifies. */
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

/**
 * The state one FAILED attempt may claim, from this attempt's own code and the
 * Connection's (where an adapter's specific diagnosis — BTC INVALID_XPUB — is
 * kept). Platform-side on either ⇒ no notice; needs-attention on either ⇒
 * needs-attention; any other code ⇒ temporary; no code at all ⇒ no notice.
 */
export function walletAttentionStateFor(attemptCode: string | null | undefined, connectionCode: string | null | undefined): WalletAttentionState | null {
  const codes = [attemptCode, connectionCode].filter((c): c is string => typeof c === "string" && c.length > 0);
  if (codes.length === 0) return null;
  if (codes.some((c) => walletAttentionState(c) === null)) return null;
  if (codes.some((c) => walletAttentionState(c) === "needs-attention")) return "needs-attention";
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

/**
 * The start of the CURRENT unbroken run of FAILED attempts, from attempt rows
 * NEWEST FIRST: walk back until the first successful attempt (SUCCEEDED /
 * PARTIAL — any attempt whose provider read worked, even one that left a
 * Connection code); the oldest FAILED attempt seen before it starts the run.
 * SKIPPED / RUNNING rows are neither and are passed over. Null = no failure.
 */
export function failureRunStartFrom(rowsNewestFirst: ReadonlyArray<{ startedAt: Date; overallStatus: string }>): Date | null {
  let start: Date | null = null;
  for (const r of rowsNewestFirst) {
    if (r.overallStatus === "SUCCEEDED" || r.overallStatus === "PARTIAL") break;
    if (r.overallStatus === "FAILED") start = r.startedAt;
  }
  return start;
}

/** True when the unbroken run of failed attempts that began at `runStart` has lasted the sustained threshold. */
export function isSustainedWalletFailure(runStart: Date | null, now: Date): boolean {
  return runStart !== null && now.getTime() - runStart.getTime() >= WALLET_SYNC_SUSTAINED_HOURS * 3_600_000;
}
