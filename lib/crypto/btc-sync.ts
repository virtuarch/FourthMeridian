/**
 * lib/crypto/btc-sync.ts
 *
 * BTC wallet balance sync v1 — orchestration + persistence.
 *
 * Reads a self-custodied BTC FinancialAccount (walletChain="BTC"), fetches its
 * confirmed on-chain balance and a BTC→USD spot price (lib/crypto/btc-explorer.ts),
 * and writes:
 *   - nativeBalance : balance in BTC
 *   - balance       : USD value at the spot price
 *   - currency      : "USD"
 *   - syncStatus    : "pending" → "synced"
 *   - lastUpdated   : now
 *
 * Failure policy (per the wallet-connector visibility investigation, 2026-07-09):
 *   - NEVER hide or soft-delete the account, NEVER touch its SpaceAccountLink,
 *     NEVER flip it to "error". A failed sync leaves the row exactly as it was
 *     (a new wallet stays visible and "pending"), so visibility is preserved.
 *   - Record an honest, staged SyncIssue (reusing the existing model + the
 *     generic UPSERT_ERROR kind; provider="WALLET") — best-effort, never throws.
 *   - syncBtcWallet() itself never throws; it returns a result object.
 *
 * Out of scope (v1): xpub, transaction import, wallet history, other chains,
 * dashboard filtering, SpaceAccountLink behavior, schema changes.
 */

import { db } from "@/lib/db";
import {
  SyncIssueKind,
  TransactionCategory,
  FlowType,
  FlowDirection,
  SettlementState,
  FlowClassificationReason,
  ProviderType,
  type Prisma,
} from "@prisma/client";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";
import {
  fetchConfirmedSats,
  fetchBtcUsdPrice,
  fetchAddressTxsRaw,
  normalizeBtcAddressTxs,
  satsToBtc,
  computeUsdBalance,
  type FetchFn,
  type RawBtcTx,
  type NormalizedBtcMovement,
  type BtcFlowType,
} from "@/lib/crypto/btc-explorer";

/** The only chain this v1 sync supports. */
export const BTC_CHAIN = "BTC";

export interface BtcWalletSyncResult {
  accountId: string;
  ok: boolean;
  /** Set only on success — the row's new persisted state. */
  syncStatus?: "synced";
  nativeBalance?: number;
  balanceUsd?: number;
  priceUsd?: number;
  /** On failure: which step failed and why (also recorded as a SyncIssue). */
  stage?: "load" | "balance" | "price";
  reason?: string;
}

export interface BtcSyncDeps {
  /** Injected fetch (offline tests / alternate transport). */
  fetchImpl?: FetchFn;
  /** Override the balance fetch — returns confirmed satoshis for an address. */
  balanceFetcher?: (address: string) => Promise<number>;
  /** Override the price fetch — returns BTC→USD. */
  priceFetcher?: () => Promise<number>;
  /** Override the confirmed-transactions fetch (offline tests). */
  txFetcher?: (address: string) => Promise<RawBtcTx[]>;
}

/** Best-effort SyncIssue writer — never throws (mirrors lib/plaid/syncIssues.ts). */
async function recordWalletSyncIssue(
  financialAccountId: string,
  stage: "balance" | "price",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.syncIssue.create({
      data: {
        provider: "WALLET",
        financialAccountId,
        kind: SyncIssueKind.UPSERT_ERROR,
        detail: { chain: BTC_CHAIN, stage, message, ...(extra ?? {}) } as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    console.error(`[btc-sync] failed to record SyncIssue for ${financialAccountId} (non-fatal):`, e);
  }
}

/** Canonical asset identity for the wallet's native BTC position. */
const BTC_SYMBOL = "BTC";
const BTC_ASSET_NAME = "Bitcoin";

/**
 * Wallet Provider v2 — persist/refresh the wallet's native BTC Holding.
 *
 * Upserts on the existing (financialAccountId, symbol) unique key — no schema
 * change. `value` mirrors the account's USD balance EXACTLY (same balanceUsd),
 * so nothing that sums account balances double-counts, and net worth (which
 * reads FinancialAccount.balance by type, not Holdings, this slice) is
 * unchanged. Going forward Holding is the authoritative balance source; the
 * FinancialAccount.balance/nativeBalance columns remain transitional
 * compatibility fields (see prisma/schema.prisma).
 *
 * Best-effort/non-fatal: the balance write is what net worth reads this slice,
 * so a Holding failure is logged and swallowed rather than failing the sync.
 */
async function writeBtcHolding(
  financialAccountId: string,
  amounts: { nativeBalance: number; priceUsd: number; balanceUsd: number },
): Promise<void> {
  try {
    await db.holding.upsert({
      where: { financialAccountId_symbol: { financialAccountId, symbol: BTC_SYMBOL } },
      create: {
        financialAccountId,
        symbol:   BTC_SYMBOL,
        name:     BTC_ASSET_NAME,
        quantity: amounts.nativeBalance,
        price:    amounts.priceUsd,
        value:    amounts.balanceUsd,
        currency: "USD",
        isCash:   false,
      },
      update: {
        quantity: amounts.nativeBalance,
        price:    amounts.priceUsd,
        value:    amounts.balanceUsd,
        currency: "USD",
      },
    });
  } catch (e) {
    console.warn(`[btc-sync] BTC Holding upsert failed for account ${financialAccountId} (non-fatal):`, e);
  }
}

// ── Wallet Provider v3 — BTC transactions → normal Transaction rows ───────────

const FLOW_TO_CATEGORY: Record<BtcFlowType, TransactionCategory> = {
  INCOME:   TransactionCategory.Income,
  SPENDING: TransactionCategory.Other,
  FEE:      TransactionCategory.Fee,
  TRANSFER: TransactionCategory.Transfer,
};

type OwnAddressMap = Map<string, string>; // external address -> the user's own FinancialAccount id

/**
 * Resolve which of the given counterparty addresses belong to the user's OWN
 * other wallets, via ProviderAccountIdentity(WALLET). Used to reclassify a
 * movement as an INTERNAL transfer (engine-level counterparty resolution — the
 * adapter only knows addresses).
 */
async function resolveOwnWalletAddresses(
  ownerUserId: string,
  excludeAccountId: string,
  addresses: string[],
): Promise<OwnAddressMap> {
  const unique = [...new Set(addresses)];
  if (unique.length === 0) return new Map();
  const rows = await db.providerAccountIdentity.findMany({
    where: {
      provider:          ProviderType.WALLET,
      externalAccountId: { in: unique },
      financialAccount:  { ownerUserId, deletedAt: null, id: { not: excludeAccountId } },
    },
    select: { externalAccountId: true, financialAccountId: true },
  });
  return new Map(rows.map((r) => [r.externalAccountId, r.financialAccountId]));
}

/** Map one normalized movement to a Transaction createMany row (with INTERNAL resolution). */
function buildTransactionRow(
  financialAccountId: string,
  m: NormalizedBtcMovement,
  ownByAddress: OwnAddressMap,
): Prisma.TransactionCreateManyInput {
  let flowType:      FlowType      = m.flowType as FlowType;
  let flowDirection: FlowDirection = m.flowDirection as FlowDirection;
  let category                     = FLOW_TO_CATEGORY[m.flowType];
  let merchant                     = m.merchantLabel;
  let counterpartyAccountId: string | undefined;
  let classificationReason: FlowClassificationReason | undefined =
    m.flowType === "INCOME"   ? FlowClassificationReason.SIGN_DEFAULT_INFLOW   :
    m.flowType === "SPENDING" ? FlowClassificationReason.SIGN_DEFAULT_SPENDING : undefined;

  // A principal movement whose EVERY external counterparty is one of the user's
  // own wallets is an INTERNAL transfer (matches the existing internal-transfer
  // model — never counted as income/spend in Cash Flow).
  if (m.role === "PRINCIPAL" && m.counterpartyAddresses.length > 0) {
    const owned = m.counterpartyAddresses.map((a) => ownByAddress.get(a)).filter((x): x is string => !!x);
    if (owned.length === m.counterpartyAddresses.length) {
      flowType              = FlowType.TRANSFER;
      flowDirection         = FlowDirection.INTERNAL;
      category              = TransactionCategory.Transfer;
      merchant              = "Wallet transfer";
      counterpartyAccountId = owned[0];
      classificationReason  = undefined;
    }
  }

  return {
    financialAccountId,
    date:                  m.occurredAt,
    merchant,
    description:           m.description,
    category,
    amount:                m.amountBtc,   // native BTC; inflow +, outflow/fee −
    currency:              "BTC",
    pending:               m.settlement === "PENDING",
    externalTransactionId: m.externalId,
    flowType,
    flowDirection,
    settlementState:       m.settlement === "POSTED" ? SettlementState.POSTED : SettlementState.PENDING,
    ...(counterpartyAccountId ? { counterpartyAccountId } : {}),
    ...(classificationReason  ? { classificationReason }  : {}),
  };
}

/**
 * Import an address's confirmed BTC transactions as ordinary Transaction rows.
 * Idempotent (dedupes on externalTransactionId) and best-effort/non-fatal — a
 * transaction-import failure never fails the balance/holding sync. No BTC-specific
 * table: these are normal Transaction rows, indistinguishable from any provider's.
 */
async function importBtcTransactions(
  account: { id: string; ownerUserId: string | null; walletAddress: string },
  deps: BtcSyncDeps,
): Promise<void> {
  try {
    const rawTxs = deps.txFetcher
      ? await deps.txFetcher(account.walletAddress)
      : await fetchAddressTxsRaw(account.walletAddress, deps.fetchImpl);

    const movements = normalizeBtcAddressTxs(rawTxs, account.walletAddress);
    if (movements.length === 0) return;

    // Engine-level counterparty resolution → INTERNAL transfers.
    const ownByAddress = account.ownerUserId
      ? await resolveOwnWalletAddresses(
          account.ownerUserId, account.id, movements.flatMap((m) => m.counterpartyAddresses))
      : new Map<string, string>();

    // Idempotency: skip movements already imported for this account. The
    // externalTransactionId (txid / txid:fee) is the dedupe key — a re-sync is a
    // no-op. No DB unique needed (see the schema note on externalTransactionId).
    const ids = movements.map((m) => m.externalId);
    const existing = await db.transaction.findMany({
      where:  { financialAccountId: account.id, externalTransactionId: { in: ids }, deletedAt: null },
      select: { externalTransactionId: true },
    });
    const seen = new Set(existing.map((e) => e.externalTransactionId));
    const fresh = movements.filter((m) => !seen.has(m.externalId));
    if (fresh.length === 0) return;

    await db.transaction.createMany({
      data: fresh.map((m) => buildTransactionRow(account.id, m, ownByAddress)),
    });
  } catch (e) {
    console.warn(`[btc-sync] transaction import failed for account ${account.id} (non-fatal):`, e);
  }
}

/**
 * Sync one BTC wallet account. Never throws. On any external failure the
 * account row is left untouched (visible, still "pending") and a SyncIssue is
 * recorded.
 */
export async function syncBtcWallet(
  accountId: string,
  deps: BtcSyncDeps = {},
): Promise<BtcWalletSyncResult> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId },
    select: { id: true, ownerUserId: true, walletChain: true, walletAddress: true, deletedAt: true },
  });

  // Guard: only an active, addressed BTC wallet is syncable here.
  if (!account || account.deletedAt || account.walletChain !== BTC_CHAIN || !account.walletAddress) {
    return { accountId, ok: false, stage: "load", reason: "not a syncable BTC wallet" };
  }

  const address = account.walletAddress;
  const balanceFetcher = deps.balanceFetcher ?? ((a: string) => fetchConfirmedSats(a, deps.fetchImpl));
  const priceFetcher = deps.priceFetcher ?? (() => fetchBtcUsdPrice(deps.fetchImpl));

  // 1) Confirmed on-chain balance.
  let sats: number;
  try {
    sats = await balanceFetcher(address);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordWalletSyncIssue(accountId, "balance", reason, { address });
    return { accountId, ok: false, stage: "balance", reason };
  }

  // 2) BTC→USD spot price.
  let priceUsd: number;
  try {
    priceUsd = await priceFetcher();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordWalletSyncIssue(accountId, "price", reason);
    // A price fetch only ever fails at the price stage.
    return { accountId, ok: false, stage: "price", reason };
  }

  // 3) Persist. Only balance/native/currency/sync fields — no link, no
  //    deletedAt, no transaction, no holding, nothing that changes visibility.
  const nativeBalance = satsToBtc(sats);
  const balanceUsd = computeUsdBalance(nativeBalance, priceUsd);
  await db.financialAccount.update({
    where: { id: accountId },
    data: {
      nativeBalance,
      balance: balanceUsd,
      currency: "USD",
      syncStatus: "synced",
      lastUpdated: new Date(),
    },
  });

  // Wallet Provider v2 — represent the balance as a first-class BTC Holding
  // (the wallet is an account that CONTAINS holdings). Mirrors balanceUsd, so
  // no double-count; best-effort/non-fatal.
  await writeBtcHolding(accountId, { nativeBalance, priceUsd, balanceUsd });

  // Wallet Provider v3 — import confirmed BTC transactions as normal Transaction
  // rows (idempotent, best-effort). The wallet now emits Connection → identity →
  // account → Holding → Transaction, like every other provider.
  await importBtcTransactions(
    { id: accountId, ownerUserId: account.ownerUserId, walletAddress: address },
    deps,
  );

  // Wallet Provider v1.5 — record this sync on the wallet's Connection spine
  // (ensures/links Connection → identity → AccountConnection, and stamps
  // lastSyncedAt). Best-effort/non-fatal and also serves as the lazy backfill
  // for wallets created before v1.5. Does not alter the balance write above.
  if (account.ownerUserId) {
    await alignWalletProviderSpine({
      userId:             account.ownerUserId,
      financialAccountId: accountId,
      address,
      chain:              BTC_CHAIN,
      markSynced:         true,
    });
  }

  return { accountId, ok: true, syncStatus: "synced", nativeBalance, balanceUsd, priceUsd };
}

export interface SyncAllBtcWalletsResult {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Sync every active BTC wallet. The BTC→USD price is fetched once and shared
 * across accounts (they all value at the same spot). One wallet's failure never
 * blocks the rest — each is wrapped by syncBtcWallet's own never-throw contract.
 */
export async function syncAllBtcWallets(deps: BtcSyncDeps = {}): Promise<SyncAllBtcWalletsResult> {
  const wallets = await db.financialAccount.findMany({
    where: { walletChain: BTC_CHAIN, deletedAt: null },
    select: { id: true },
  });

  // Memoize the price fetch for the batch (unless the caller injected one).
  let priceOnce: Promise<number> | null = null;
  const sharedPriceFetcher =
    deps.priceFetcher ??
    (() => (priceOnce ??= fetchBtcUsdPrice(deps.fetchImpl)));

  let succeeded = 0;
  let failed = 0;
  for (const w of wallets) {
    const r = await syncBtcWallet(w.id, { ...deps, priceFetcher: sharedPriceFetcher });
    if (r.ok) succeeded++;
    else failed++;
  }

  return { total: wallets.length, succeeded, failed };
}
