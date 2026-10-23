/**
 * lib/crypto/evm-native.ts
 *
 * W-M3 — ONE EVM native-balance adapter, configured per network.
 *
 * Ethereum, BNB Smart Chain, Polygon PoS and Avalanche C-Chain expose a native
 * balance through the SAME protocol: `eth_getBalance(address, block)`, an
 * 0x-prefixed wei quantity, 18 decimals, and 20-byte hex addresses. That is not
 * a coincidence to be exploited — it is the actual shape of the protocol, and it
 * is why four copy-pasted adapters would be four places for the same bug.
 *
 * So the CHAIN-SPECIFIC part is reduced to configuration — an
 * `EvmNetworkConfig` naming the chain token, its canonical asset, its provider
 * network and its finality policy — and the ORCHESTRATION is written once.
 *
 * ── WHAT IS *NOT* GENERALISED, AND WHY ──────────────────────────────────────
 * Nothing about MEANING. This layer emits a quantity and a refusal, exactly as
 * the single-chain version did. It resolves no financial semantics, writes no
 * balance column, and claims no capability: a network having an entry here says
 * a request is possible, never that the chain has earned anything. Capability is
 * still granted one chain at a time in the sync registry, on evidence.
 *
 * Nor is it generalised beyond these four. A fifth EVM network is a config
 * entry; a NON-EVM chain is a different adapter, because its protocol genuinely
 * differs. Bitcoin and Solana are untouched by this file and must stay that way
 * — provider uniformity is not a reason to rewrite a working acquisition path.
 *
 * ── WEI STAYS AN INTEGER ────────────────────────────────────────────────────
 * Parsing, validation and the sign check all happen on a BigInt; the single
 * conversion to a whole-unit float is at the canonical quantity boundary, where
 * `PositionObservation.quantity` requires one. Shared with `eth-rpc.ts`, which
 * holds those primitives — they were always EVM-generic rather than
 * Ethereum-specific, and are simply used by name now.
 *
 * ── FAILURE IS NEVER A ZERO ─────────────────────────────────────────────────
 * A disabled network answers 403, a throttled one 429, a missing endpoint
 * nothing at all. None of those is a balance. Every path returns before the
 * capture call, records a staged SyncIssue, and leaves the account exactly as it
 * was — the same contract the single-chain adapters carry.
 */

import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { SyncIssueKind, type Prisma } from "@prisma/client";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";
import { captureWalletPosition } from "@/lib/crypto/wallet-position-capture";
import type { CryptoAsset } from "@/lib/investments/crypto-instrument";
import type { NativeAsset } from "@/lib/crypto/native-asset";
import { ledgerNotApplicable, type LedgerReconciliation } from "@/lib/crypto/ledger-completeness.core";
import { alchemyRpcUrl, redactProviderSecrets, type AlchemyNetwork } from "@/lib/crypto/alchemy";
import {
  parseEthBalanceWei, weiToEth, isEthAddressShape, normalizeEthAddress,
  EthRpcError, type FetchFn, type EthSyncStage,
} from "@/lib/crypto/eth-rpc";

/** Everything that differs between one EVM network and another. */
export interface EvmNetworkConfig {
  /** `FinancialAccount.walletChain` token. A CHAIN identifier, never a ticker. */
  chain:   string;
  /** The canonical native asset — identity, decimals and display symbol. */
  asset:   NativeAsset;
  /** Alchemy network slug for this chain. */
  network: AlchemyNetwork;
  /**
   * Env var holding an explicit endpoint override for THIS network, when one
   * exists. Absent ⇒ the shared provider credential is the only route.
   */
  urlEnvVar?: string;
  /**
   * Block tag the balance is read at. `latest` everywhere today: EVM chains
   * expose no cheap finalized-balance primitive comparable to Solana's
   * commitment, and a re-orged balance self-corrects on the next sync because
   * this is a POINT observation, not a ledger. Stated as configuration so a
   * chain that needs `finalized` can say so without a code change.
   */
  blockTag: "latest" | "finalized" | "safe";
}

/** The result shape the chain dispatcher consumes. Mirrors the SOL adapter's. */
export interface EvmWalletSyncResult {
  accountId: string;
  ok: boolean;
  chain?: string;
  syncStatus?: "synced" | "pending";
  /** Observed native quantity in whole units. */
  quantity?: number;
  /** The exact wire value in wei, decimal-stringified — the lossless fact. */
  weiBalance?: string;
  positionCaptured?: boolean;
  netWorthParticipation?: "WITHHELD_PENDING_CONVERGENCE";
  /** Always NOT_APPLICABLE — a balance-only chain has no movement ledger. */
  ledger?: LedgerReconciliation;
  stage?: "load" | EthSyncStage;
  reason?: string;
}

export interface EvmSyncDeps {
  fetchImpl?: FetchFn;
  /** Override the balance fetch entirely — returns wei for an address. */
  balanceFetcher?: (address: string) => Promise<bigint>;
  /** Override the endpoint. `null` forces the DARK path (unconfigured). */
  rpcUrl?: string | null;
}

/**
 * The endpoint serving this network, or null when unconfigured.
 *
 * A per-network override wins, then the shared Alchemy credential. There is
 * deliberately NOT one API key per chain: Alchemy serves every EVM network here
 * from a single credential, and inventing four variables would be four things to
 * rotate for no gain. A network the vendor has not enabled on the app answers
 * 403 at request time — a stated refusal, which is what we want, rather than a
 * configuration surface pretending to know.
 *
 * THE RETURNED URL MAY EMBED A CREDENTIAL. Never log it; log the stage.
 */
export function evmRpcUrl(config: EvmNetworkConfig): string | null {
  const override = config.urlEnvVar ? process.env[config.urlEnvVar]?.trim() : undefined;
  if (override) return override.replace(/\/+$/, "");
  return alchemyRpcUrl(config.network);
}

const DEFAULT_TIMEOUT_MS = 10_000;
function timeoutMs(): number {
  const n = Number(process.env.EVM_SYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * The native balance of one address on one EVM network, in WEI.
 *
 * Throws `EthRpcError` on every failure path — unconfigured, malformed address,
 * transport, non-2xx, JSON-RPC error member, unparseable quantity — so that no
 * failure can be mistaken for a zero balance. A 403 from a network the vendor
 * has not enabled arrives as a non-2xx and is refused like any other.
 */
export async function fetchEvmNativeWei(
  address: string,
  config: EvmNetworkConfig,
  deps: EvmSyncDeps = {},
): Promise<bigint> {
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : evmRpcUrl(config);
  if (!url) {
    throw new EthRpcError("config",
      `no ${config.chain} RPC endpoint is configured on this deployment`);
  }
  if (!isEthAddressShape(address)) {
    throw new EthRpcError("address", `not a well-formed EVM address: ${address}`);
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let res: Response;
  try {
    res = await doFetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getBalance",
        params: [normalizeEthAddress(address), config.blockTag],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new EthRpcError("balance",
      redactProviderSecrets(`network error: ${e instanceof Error ? e.message : String(e)}`));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // A network the provider has not enabled for this app answers here. It is a
    // refusal about CONFIGURATION, and it is emphatically not a balance of zero.
    throw new EthRpcError("balance", `HTTP ${res.status} from the ${config.chain} RPC endpoint`);
  }

  let body: unknown;
  try { body = await res.json(); }
  catch { throw new EthRpcError("balance", "unparseable JSON-RPC response"); }

  return parseEthBalanceWei(body);
}

/** Best-effort SyncIssue writer — never throws. */
async function recordEvmSyncIssue(
  financialAccountId: string, chain: string,
  stage: EthSyncStage | "capture", message: string, extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await recordSyncIssue({
      kind:               SyncIssueKind.WALLET_SYNC_FAILED,
      provider:           "WALLET",
      financialAccountId,
      detail:             { chain, stage, message: redactProviderSecrets(message), ...(extra ?? {}) } as Prisma.InputJsonValue,
    });
  } catch (e) {
    console.warn(`[evm-sync] SyncIssue write failed for ${financialAccountId} (non-fatal):`, e);
  }
}

/**
 * Sync one EVM wallet's native balance onto the canonical position spine.
 *
 * Never throws. Writes NO `FinancialAccount.balance` and NO `nativeBalance`:
 * the value lives on the dated position spine, and net-worth participation
 * stays explicitly withheld until the wallet net-worth convergence lands. A
 * consumer that needs the historical figure reads dated positions × dated
 * closes (the bridge in lib/snapshots/regenerate-history.ts).
 */
export async function syncEvmWallet(
  accountId: string,
  config: EvmNetworkConfig,
  deps: EvmSyncDeps = {},
): Promise<EvmWalletSyncResult> {
  const account = await db.financialAccount.findUnique({
    where:  { id: accountId },
    select: { id: true, ownerUserId: true, walletChain: true, walletAddress: true, deletedAt: true },
  });

  // WRONG-CHAIN GUARD — this config serves exactly one network.
  if (!account || account.deletedAt || account.walletChain !== config.chain || !account.walletAddress) {
    return { accountId, ok: false, chain: config.chain, stage: "load",
             reason: `not a syncable ${config.chain} wallet` };
  }

  const address = normalizeEthAddress(account.walletAddress);
  if (!isEthAddressShape(address)) {
    const reason = "This does not look like an EVM address (expected 0x followed by 40 hex characters).";
    await recordEvmSyncIssue(accountId, config.chain, "address", reason);
    return { accountId, ok: false, chain: config.chain, stage: "address", reason };
  }

  // The DARK path, before any network work.
  const rpcUrl = deps.rpcUrl !== undefined ? deps.rpcUrl : evmRpcUrl(config);
  if (!deps.balanceFetcher && !rpcUrl) {
    const reason = `No ${config.chain} RPC endpoint is configured on this deployment, so this wallet's balance cannot be read.`;
    await recordEvmSyncIssue(accountId, config.chain, "config", reason);
    return { accountId, ok: false, chain: config.chain, stage: "config", reason };
  }

  let wei: bigint;
  try {
    wei = deps.balanceFetcher
      ? await deps.balanceFetcher(address)
      : await fetchEvmNativeWei(address, config, { fetchImpl: deps.fetchImpl, rpcUrl });
  } catch (err) {
    const stage: EthSyncStage = err instanceof EthRpcError ? err.stage : "balance";
    const reason = redactProviderSecrets(err instanceof Error ? err.message : String(err));
    await recordEvmSyncIssue(accountId, config.chain, stage, reason);
    return { accountId, ok: false, chain: config.chain, stage, reason };
  }

  if (wei < BigInt("0")) {
    const reason = `incoherent native balance from provider (wei=${wei})`;
    await recordEvmSyncIssue(accountId, config.chain, "balance", reason);
    return { accountId, ok: false, chain: config.chain, stage: "balance", reason };
  }

  // Normalise ONCE, at the canonical boundary.
  const quantity = weiToEth(wei);
  if (!Number.isFinite(quantity) || quantity < 0) {
    const reason = `native balance did not normalise to a usable quantity (wei=${wei})`;
    await recordEvmSyncIssue(accountId, config.chain, "balance", reason);
    return { accountId, ok: false, chain: config.chain, stage: "balance", reason };
  }

  // THE CANONICAL WRITE — the same writer every chain uses. Identity resolves
  // through the configured asset's assetKey; a zero balance writes an explicit
  // `quantity: 0` closure row rather than vanishing.
  let positionCaptured = false;
  try {
    const capture = await captureWalletPosition({
      financialAccountId: accountId,
      asset:              config.asset as CryptoAsset,
      quantity,
      date:               new Date(),
    });
    positionCaptured = capture.written;
  } catch (e) {
    const reason = `position capture failed: ${e instanceof Error ? e.message : String(e)}`;
    await recordEvmSyncIssue(accountId, config.chain, "capture", reason);
    return { accountId, ok: false, chain: config.chain, stage: "balance", reason };
  }

  if (!positionCaptured) {
    const reason =
      "The balance was read, but canonical position capture is disabled on this deployment " +
      "(INVESTMENT_OBSERVATIONS_ENABLED), so there is nowhere to record it.";
    await recordEvmSyncIssue(accountId, config.chain, "capture", reason, { quantity, weiBalance: wei.toString() });
    return { accountId, ok: false, chain: config.chain, stage: "balance", reason,
             quantity, weiBalance: wei.toString(), positionCaptured: false };
  }

  // Lifecycle only. NO balance columns — see the header.
  await db.financialAccount.update({
    where: { id: accountId },
    data:  { syncStatus: "synced", lastUpdated: new Date() },
  });

  if (account.ownerUserId) {
    await alignWalletProviderSpine({
      userId: account.ownerUserId, financialAccountId: accountId,
      address, chain: config.chain, markSynced: true,
    });
  }

  return {
    accountId, ok: true, chain: config.chain, syncStatus: "synced",
    quantity, weiBalance: wei.toString(), positionCaptured: true,
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    ledger: ledgerNotApplicable(quantity),
  };
}
