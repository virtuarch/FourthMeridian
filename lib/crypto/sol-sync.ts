/**
 * lib/crypto/sol-sync.ts
 *
 * W-M1c — native Solana wallet sync: orchestration + persistence.
 *
 * Reads a self-custodied SOL FinancialAccount (walletChain="SOL"), fetches the
 * owner account's finalized native balance in lamports, normalises to whole SOL,
 * and records it as ONE canonical OBSERVED `PositionObservation` through the SAME
 * writer Bitcoin and Ethereum use (`captureWalletPosition`). There is no
 * Solana-shaped observation, no Solana-shaped valuation, and no Solana branch
 * anywhere above this file: the chain disappears at
 * `captureWalletPosition({ asset: SOL_ASSET, … })`.
 *
 * ── SOL ONLY. THE WALLET IS NOT THE PORTFOLIO ────────────────────────────────
 * `getBalance` reports the OWNER account's own lamports. SPL token balances live
 * in separate token accounts derived from (owner, mint) and are absent from this
 * figure — deliberately, for W-M1c. That makes the position recorded here a
 * complete answer to "how much SOL does this wallet hold" and NOT an answer to
 * "what is in this wallet". No surface may present it as the latter, and none
 * does: a position is a position, and the absence of a token position is the
 * absence of evidence about that token, not a claim that it is zero.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT WRITE ────────────────────────────────────
 * `FinancialAccount.balance` and `FinancialAccount.nativeBalance` are NOT
 * written, and that is the single most important line in this file.
 *
 * Bitcoin writes both, for historical reasons W6 exists to unwind: `balance` is
 * quantity × an undated sync-time spot quote, and it is what `SpaceSnapshot`
 * composes net worth from. Reproducing that for Solana would create a THIRD
 * asset whose value authority is a scalar column rather than the dated position
 * spine — building, in a new place, exactly the thing the next slice is meant to
 * remove. So SOL is valued the way every brokerage position is valued: the
 * canonical quantity observation times the dated archive close, through
 * `getCurrentPositions`.
 *
 * ── THE BOUNDARY THIS CREATES, STATED RATHER THAN SMUGGLED ───────────────────
 * The consequence is real and must not be discovered later. Until the wallet
 * net-worth convergence lands:
 *
 *   · HOLDINGS, EXPORT and the AI context see a Solana wallet's position
 *     correctly, valued at the dated close, because they read the spine;
 *   · NET WORTH does not. `SpaceSnapshot` composes its digital-asset component
 *     from `FinancialAccount.balance`, which for these wallets stays 0.
 *
 * Net worth therefore reads 0 for a wallet that demonstrably holds SOL, and
 * the schema gives nowhere to say "withheld" instead: `SpaceSnapshot.crypto` is
 * NOT NULL DEFAULT 0, so the column cannot express unknown (the same limitation
 * `cryptoValuationStatus` was created to work around for historical rows). This
 * slice does NOT fabricate a way around that. It refuses to smuggle an undated
 * spot value through `balance` to make a number appear, because a number that
 * appears by that route is the defect, not the fix.
 *
 * The alternative — writing `balance` — would make net worth "right" today and
 * make the convergence harder tomorrow, on a value with no dated provenance. The
 * boundary is documented here, in the sync result (`netWorthParticipation`), and
 * in the tests, so it is visible from every direction until W6 closes it.
 *
 * ── LEDGER: NOT APPLICABLE, NOT RECONCILED ───────────────────────────────────
 * This adapter imports no transactions, so there is no movement ledger to
 * reconcile the balance against. It reports `ledgerNotApplicable()`, NOT a
 * reconciliation, and NOT `NO_MOVEMENTS` (which would file a balance-only chain
 * as a broken Bitcoin wallet). A successful balance acquisition still reaches
 * "synced", because for a balance-only chain a complete sync genuinely is a
 * balance — the lifecycle and the historical carry licence read the same state
 * and correctly reach different conclusions from it.
 *
 * ── Failure policy (inherited from btc-sync, for the same reasons) ───────────
 *   - NEVER hide, soft-delete, or flip the account to "error". A failed sync
 *     leaves the row as it was, so a new wallet stays visible and "pending".
 *   - Record an honest, staged SyncIssue (WALLET_SYNC_FAILED, provider WALLET).
 *   - `syncSolWallet` never throws; it returns a result object.
 *   - A provider failure NEVER writes a position. An unreachable RPC and an
 *     empty wallet are opposite facts and must never produce the same row.
 *
 * Out of scope (W-M1c): SPL token accounts, transaction import, stake accounts
 * and rent reclamation, program/instruction decoding, associated-token-account
 * enumeration, and any cluster other than mainnet-beta.
 */

import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { SyncIssueKind, type Prisma } from "@prisma/client";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";
import { captureWalletPosition } from "@/lib/crypto/wallet-position-capture";
import { SOL_ASSET } from "@/lib/investments/crypto-instrument";
import { SOL_NATIVE } from "@/lib/crypto/native-asset";
import { ledgerNotApplicable, type LedgerReconciliation } from "@/lib/crypto/ledger-completeness.core";
import {
  fetchSolLamports,
  lamportsToSol,
  isSolAddressShape,
  normalizeSolAddress,
  solRpcUrl,
  SolRpcError,
  type FetchFn,
  type SolSyncStage,
} from "@/lib/crypto/sol-rpc";

/** The chain token this adapter serves — the shared descriptor's, not a literal. */
export const SOL_CHAIN = SOL_NATIVE.chain;

export interface SolWalletSyncResult {
  accountId: string;
  ok: boolean;
  /** On success: "synced". A balance-only chain needs no discovery phase. */
  syncStatus?: "synced" | "pending";
  /** Observed native quantity in whole SOL. */
  quantity?: number;
  /**
   * The exact wire value in LAMPORTS, decimal-stringified — the lossless fact.
   * A string rather than a number because a large u64 does not survive one
   * (see sol-rpc's header); the whole point of the parse is not to undo it here.
   */
  lamportBalance?: string;
  /** Did the canonical spine actually record the position? */
  positionCaptured?: boolean;
  /**
   * W-M1b — whether this asset contributes to NET WORTH. Always "WITHHELD" in
   * this wave: the position is canonical and the holdings surfaces see it, but
   * net worth composes from `FinancialAccount.balance`, which this adapter
   * deliberately does not write. Surfaced rather than silently implied.
   */
  netWorthParticipation?: "WITHHELD_PENDING_CONVERGENCE";
  /** Always NOT_APPLICABLE here — a balance-only chain has no ledger. */
  ledger?: LedgerReconciliation;
  /** On failure: which step failed and why (also recorded as a SyncIssue). */
  stage?: "load" | SolSyncStage;
  reason?: string;
}

export interface SolSyncDeps {
  /** Injected fetch (offline tests / alternate transport). */
  fetchImpl?: FetchFn;
  /** Override the balance fetch entirely — returns lamports for an address. */
  balanceFetcher?: (address: string) => Promise<bigint>;
  /**
   * Override the RPC endpoint. `null` forces the DARK path (unconfigured), which
   * is how the "no provider is honest, not zero" behaviour is tested.
   */
  rpcUrl?: string | null;
}

/** Best-effort SyncIssue writer — never throws (mirrors btc-sync's). */
async function recordSolSyncIssue(
  financialAccountId: string,
  stage: SolSyncStage | "capture",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await recordSyncIssue({
      // One public kind for every wallet operation; the chain and stage
      // distinguish the failure mode inside the detail envelope, exactly as the
      // BTC adapter does. No taxonomy change is needed to add a chain.
      kind:               SyncIssueKind.WALLET_SYNC_FAILED,
      provider:           "WALLET",
      financialAccountId,
      detail:             { chain: SOL_CHAIN, stage, message, ...(extra ?? {}) } as Prisma.InputJsonValue,
    });
  } catch (e) {
    console.warn(`[sol-sync] SyncIssue write failed for ${financialAccountId} (non-fatal):`, e);
  }
}

/**
 * Sync one native Solana wallet.
 *
 * Never throws. On any failure the account is left exactly as it was and an
 * honest SyncIssue is recorded.
 */
export async function syncSolWallet(
  accountId: string,
  deps: SolSyncDeps = {},
): Promise<SolWalletSyncResult> {
  const account = await db.financialAccount.findUnique({
    where:  { id: accountId },
    select: { id: true, ownerUserId: true, walletChain: true, walletAddress: true, deletedAt: true },
  });

  // WRONG-CHAIN GUARD. This adapter serves Solana mainnet-beta and refuses
  // everything else — including Bitcoin and Ethereum, whose syncs it must
  // never shadow. Address formats happen to be disjoint across the three, but
  // the guard is the chain token, not a shape heuristic.
  if (!account || account.deletedAt || account.walletChain !== SOL_CHAIN || !account.walletAddress) {
    return { accountId, ok: false, stage: "load", reason: "not a syncable SOL wallet" };
  }

  const address = normalizeSolAddress(account.walletAddress);
  if (!isSolAddressShape(address)) {
    const reason = "This does not look like a Solana address (expected base58 that decodes to 32 bytes).";
    await recordSolSyncIssue(accountId, "address", reason);
    return { accountId, ok: false, stage: "address", reason };
  }

  // The DARK path, checked before any network work: a deployment with no RPC
  // endpoint cannot read Solana, and saying so is the honest outcome. It is
  // NOT a zero balance, and it must not be recorded as one.
  const rpcUrl = deps.rpcUrl !== undefined ? deps.rpcUrl : solRpcUrl();
  if (!deps.balanceFetcher && !rpcUrl) {
    const reason = "No Solana RPC endpoint is configured on this deployment, so this wallet's balance cannot be read.";
    await recordSolSyncIssue(accountId, "config", reason);
    return { accountId, ok: false, stage: "config", reason };
  }

  // 1) Native balance, in LAMPORTS. Integer end to end — the raw response text
  //    is read so JSON.parse never sees the u64 (see sol-rpc's header).
  let lamports: bigint;
  try {
    lamports = deps.balanceFetcher
      ? await deps.balanceFetcher(address)
      : await fetchSolLamports(address, { fetchImpl: deps.fetchImpl, rpcUrl });
  } catch (err) {
    const stage: SolSyncStage = err instanceof SolRpcError ? err.stage : "balance";
    const reason = err instanceof Error ? err.message : String(err);
    await recordSolSyncIssue(accountId, stage, reason);
    return { accountId, ok: false, stage, reason };
  }

  if (lamports < BigInt("0")) {
    const reason = `incoherent native balance from provider (lamports=${lamports})`;
    await recordSolSyncIssue(accountId, "balance", reason);
    return { accountId, ok: false, stage: "balance", reason };
  }

  // 2) Normalise ONCE, at the boundary the canonical domain requires a number.
  const quantity = lamportsToSol(lamports);
  if (!Number.isFinite(quantity) || quantity < 0) {
    const reason = `native balance did not normalise to a usable quantity (lamports=${lamports})`;
    await recordSolSyncIssue(accountId, "balance", reason);
    return { accountId, ok: false, stage: "balance", reason };
  }

  // 3) THE CANONICAL WRITE — the same writer, the same shape, the same gate as
  //    Bitcoin. A zero balance writes an explicit `quantity: 0` closure row
  //    rather than vanishing, which is the wallet closure doctrine already in
  //    place. Identity resolves through SOL_ASSET's assetKey; nothing here
  //    touches an Instrument or a ticker.
  let positionCaptured = false;
  try {
    const capture = await captureWalletPosition({
      financialAccountId: accountId,
      asset:              SOL_ASSET,
      quantity,
      date:               new Date(),
    });
    positionCaptured = capture.written;
  } catch (e) {
    const reason = `position capture failed: ${e instanceof Error ? e.message : String(e)}`;
    await recordSolSyncIssue(accountId, "capture", reason);
    return { accountId, ok: false, stage: "balance", reason };
  }

  // The observation gate is off on this deployment. The balance was read, but it
  // could not be recorded ANYWHERE — this adapter writes no balance columns by
  // design, so an uncaptured position leaves the wallet contributing nothing at
  // all. Claiming "synced" would present that silence as a completed sync.
  if (!positionCaptured) {
    const reason =
      "The balance was read, but canonical position capture is disabled on this deployment " +
      "(INVESTMENT_OBSERVATIONS_ENABLED), so there is nowhere to record it.";
    await recordSolSyncIssue(accountId, "capture", reason, { quantity, lamportBalance: lamports.toString() });
    return {
      accountId, ok: false, stage: "balance", reason,
      quantity, lamportBalance: lamports.toString(), positionCaptured: false,
    };
  }

  // 4) Lifecycle. NO balance columns are written — see the header. `lastUpdated`
  //    records when this row was last touched by a successful sync, which is what
  //    freshness surfaces read.
  await db.financialAccount.update({
    where: { id: accountId },
    data:  { syncStatus: "synced", lastUpdated: new Date() },
  });

  // 5) Provider spine (best-effort, non-fatal) — the same alignment BTC performs.
  if (account.ownerUserId) {
    await alignWalletProviderSpine({
      userId:             account.ownerUserId,
      financialAccountId: accountId,
      address,
      chain:              SOL_CHAIN,
      markSynced:         true,
    });
  }

  return {
    accountId,
    ok:                    true,
    syncStatus:            "synced",
    quantity,
    lamportBalance:         lamports.toString(),
    positionCaptured:      true,
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    // Explicitly NOT a reconciliation. See ledgerNotApplicable's doc.
    ledger:                ledgerNotApplicable(quantity),
  };
}

export interface SyncAllSolWalletsResult {
  total: number;
  succeeded: number;
  failed: number;
  /** Accounts that synced OK this run. */
  syncedAccountIds: string[];
}

/**
 * Sync every active native SOL wallet. One wallet's failure never blocks the
 * rest — each is wrapped by `syncSolWallet`'s own never-throw contract.
 *
 * Deliberately NOT wired to a cron in this slice: W-M1d owns activation, and a
 * scheduled job that nothing can trigger by hand first is a job whose first real
 * run is in production.
 */
export async function syncAllSolWallets(deps: SolSyncDeps = {}): Promise<SyncAllSolWalletsResult> {
  const wallets = await db.financialAccount.findMany({
    where:  { walletChain: SOL_CHAIN, deletedAt: null },
    select: { id: true },
  });

  let succeeded = 0;
  let failed = 0;
  const syncedAccountIds: string[] = [];
  for (const w of wallets) {
    const r = await syncSolWallet(w.id, deps);
    if (r.ok) { succeeded++; syncedAccountIds.push(w.id); }
    else failed++;
  }

  return { total: wallets.length, succeeded, failed, syncedAccountIds };
}
