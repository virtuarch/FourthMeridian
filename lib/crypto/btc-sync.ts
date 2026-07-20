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
import {
  alignWalletProviderSpine,
  touchWalletConnectionStatus,
  clearWalletConnectionError,
  markWalletAccountConnectionSynced,
} from "@/lib/accounts/wallet-connection";
import {
  fetchConfirmedSatsForAddresses,
  fetchBtcUsdPrice,
  fetchAddressTxsRaw,
  fetchAddressStatsBatch,
  normalizeBtcAddressTxs,
  satsToBtc,
  computeUsdBalance,
  type FetchFn,
  type RawBtcTx,
  type NormalizedBtcMovement,
  type BtcFlowType,
  type AddrStat,
} from "@/lib/crypto/btc-explorer";
import {
  parseExtendedKey,
  deriveAddressAt,
  isExtendedKey,
} from "@/lib/crypto/btc-address-derivation";
import {
  readDiscoveryCursor,
  planXpubStep,
  applyXpubStep,
  type AddrRef,
} from "@/lib/crypto/btc-discovery-core";
import { captureWalletPosition } from "@/lib/crypto/wallet-position-capture";
import { BTC_ASSET } from "@/lib/investments/crypto-instrument";

/** The only chain this v1 sync supports. */
export const BTC_CHAIN = "BTC";

export interface BtcWalletSyncResult {
  accountId: string;
  ok: boolean;
  /** On success — the row's new persisted state ("pending" while an xpub is still
   *  discovering across runs; "synced" once discovery completes). */
  syncStatus?: "synced" | "pending";
  nativeBalance?: number;
  balanceUsd?: number;
  priceUsd?: number;
  /** On failure: which step failed and why (also recorded as a SyncIssue). */
  stage?: "load" | "discovery" | "balance" | "price";
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
  /** Override the xpub batch address-stats lookup (offline tests). */
  batchStatsFetcher?: (addresses: string[]) => Promise<Map<string, AddrStat>>;
  /** xpub discovery: consecutive-unused gap limit (default env BTC_XPUB_GAP_LIMIT or 20). */
  gapLimit?: number;
  /** xpub discovery: max NEW indices scanned PER BRANCH PER RUN (behemoth bound;
   *  default env BTC_XPUB_STEP or 50). Bounds work + request count per sync. */
  stepPerBranch?: number;
}

/** Best-effort SyncIssue writer — never throws (mirrors lib/plaid/syncIssues.ts). */
async function recordWalletSyncIssue(
  financialAccountId: string,
  stage: "discovery" | "balance" | "price",
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

/**
 * P2-6 — TRANSITIONAL DUAL-WRITE. Alongside the legacy `Holding` above, record the
 * same balance as a canonical OBSERVED `PositionObservation` on the investment
 * spine (via the ONE canonical BTC Instrument), so `getCurrentPositions()` sees
 * crypto without a legacy Holding compatibility reader. Quantity-only: valued
 * through the canonical RAW_CLOSE price series, never a synthetic institution
 * anchor (see wallet-position-capture.ts). A zero balance writes a `quantity:0`
 * closure row. Gated behind INVESTMENT_OBSERVATIONS_ENABLED and best-effort/
 * non-fatal — the balance/Holding write above is what Wealth still reads this
 * slice, so a spine-write failure never fails the sync.
 *
 * DELETION CONDITION — this dual-write drops to a spine-only write (remove the
 * `writeBtcHolding` call) once EVERY current crypto `Holding` reader is cut over
 * to `getCurrentPositions()` (P2-4 AI holdings assembler, P2-5 data export +
 * ConnectionsCard) AND the Part 9 census shows zero remaining crypto Holding
 * readers. Kept dual only to protect those concurrently-migrating consumers from
 * timing; NOT indefinitely. Invariant covered by wallet-position-capture.test.ts.
 */
async function writeBtcObservation(
  financialAccountId: string,
  nativeBalance: number,
  date: Date,
): Promise<void> {
  try {
    await captureWalletPosition({ financialAccountId, asset: BTC_ASSET, quantity: nativeBalance, date });
  } catch (e) {
    console.warn(`[btc-sync] BTC PositionObservation write failed for account ${financialAccountId} (non-fatal):`, e);
  }
}

// ── Wallet Provider v3 — BTC transactions → normal Transaction rows ───────────

const FLOW_TO_CATEGORY: Record<BtcFlowType, TransactionCategory> = {
  INCOME:     TransactionCategory.Income,
  INVESTMENT: TransactionCategory.Sell,   // outbound BTC = asset disposal / conversion
  SPENDING:   TransactionCategory.Other,
  FEE:        TransactionCategory.Fee,
  TRANSFER:   TransactionCategory.Transfer,
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

/**
 * Map one normalized movement to a Transaction createMany row (with INTERNAL resolution).
 *
 * FLOW-CLASSIFIER-EXCEPTION (btc-sync). This is the ONE sanctioned path that
 * writes persisted flow classification (flowType / flowDirection / category /
 * classificationReason) WITHOUT lib/transactions/flow-classifier.ts, and so
 * writes NO classifierVersion (NULL = a distinct authority, not "stale"). It is
 * allowed because on-chain movements carry none of the banking evidence the
 * classifier's ladder needs — no PFC, no descriptor, no counterparty name — so
 * routing them through classifyFlow would pass `undefined` for nearly every
 * input and yield UNKNOWN. The rationale is stated at length in
 * flow-classifier.ts (§ OWNERSHIP, not merely staleness) and the exception is
 * made executable policy — not a comment anyone can quietly copy — by
 * lib/transactions/flow-classifier-authority.test.ts, which fails if this marker
 * is removed OR if any OTHER file starts hand-writing flowType off-classifier.
 */
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
    m.flowType === "INCOME"     ? FlowClassificationReason.SIGN_DEFAULT_INFLOW       :
    m.flowType === "INVESTMENT" ? FlowClassificationReason.CATEGORY_INVESTMENT_VALUE :
    m.flowType === "SPENDING"   ? FlowClassificationReason.SIGN_DEFAULT_SPENDING     : undefined;

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

/** Dedupe raw txs by txid — a tx touching several of a wallet's addresses
 *  appears once per address list. */
function dedupeRawTxsByTxid(txs: RawBtcTx[]): RawBtcTx[] {
  const seen = new Set<string>();
  return txs.filter((t) => (seen.has(t.txid) ? false : (seen.add(t.txid), true)));
}

/**
 * Import a wallet's confirmed BTC transactions (across ALL its addresses) as
 * ordinary Transaction rows. Raw txs are deduped by txid before normalization,
 * so a tx moving coins between two of the wallet's own addresses is ONE row set
 * with the net computed across the full address set. Idempotent (dedupes on
 * externalTransactionId) and best-effort/non-fatal. No BTC-specific table.
 */
async function importBtcTransactions(
  account: { id: string; ownerUserId: string | null; addresses: string[] },
  deps: BtcSyncDeps,
): Promise<void> {
  try {
    const fetchTxs = deps.txFetcher ?? ((a: string) => fetchAddressTxsRaw(a, deps.fetchImpl));
    const lists = await Promise.all(account.addresses.map(fetchTxs));
    const rawTxs = dedupeRawTxsByTxid(lists.flat());

    const movements = normalizeBtcAddressTxs(rawTxs, account.addresses);
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

// ── Wallet Provider v4 — xpub / multi-address foundation ─────────────────────

interface WalletConnectionRef { id: string; credential: string | null; cursor: string | null }

/** The wallet's Connection (credential = single address OR xpub descriptor;
 *  cursor = xpub discovery checkpoint JSON, see DiscoveryCursor). */
async function loadWalletConnection(financialAccountId: string): Promise<WalletConnectionRef | null> {
  const ac = await db.accountConnection.findFirst({
    where:  { financialAccountId, connectionId: { not: null }, deletedAt: null },
    select: { connection: { select: { id: true, credential: true, cursor: true } } },
  });
  return ac?.connection ?? null;
}

/**
 * Every REAL address of a wallet, resolved through ProviderAccountIdentity — the
 * canonical address table (single-address = one row, xpub = many). Defensive:
 * never returns an extended key even if one were somehow stored.
 */
async function getWalletAddresses(financialAccountId: string): Promise<string[]> {
  const rows = await db.providerAccountIdentity.findMany({
    where:  { provider: ProviderType.WALLET, financialAccountId },
    select: { externalAccountId: true },
  });
  return rows.map((r) => r.externalAccountId).filter((a) => !isExtendedKey(a));
}

/**
 * Idempotent per-address identity upsert — the MULTI-address write path, keyed
 * on the retained @@unique([provider, externalAccountId, financialAccountId]).
 * Deliberately NOT dualWriteProviderAccountIdentity (which is single-identity,
 * find-by-{provider, financialAccountId}, and would clobber sibling addresses).
 */
async function upsertDiscoveredAddress(params: {
  financialAccountId: string;
  connectionId: string | null;
  address: string;
  branch: number;
  index: number;
}): Promise<void> {
  const meta = { branch: params.branch, index: params.index } as Prisma.InputJsonValue;
  await db.providerAccountIdentity.upsert({
    where: {
      provider_externalAccountId_financialAccountId: {
        provider:           ProviderType.WALLET,
        externalAccountId:  params.address,
        financialAccountId: params.financialAccountId,
      },
    },
    create: {
      provider:           ProviderType.WALLET,
      externalAccountId:  params.address,
      financialAccountId: params.financialAccountId,
      connectionId:       params.connectionId,
      metadata:           meta,
    },
    update: { connectionId: params.connectionId, metadata: meta },
  });
}

// Discovery checkpoint (DiscoveryCursor) + the PURE plan/apply helpers live in
// lib/crypto/btc-discovery-core.ts (DB-free, so they're unit-tested offline).

function xpubGapLimit(deps: BtcSyncDeps): number {
  return deps.gapLimit && deps.gapLimit > 0 ? deps.gapLimit : (Number(process.env.BTC_XPUB_GAP_LIMIT) || 20);
}
/** Max NEW indices scanned per branch per run — bounds work for behemoth wallets. */
function xpubStepPerBranch(deps: BtcSyncDeps): number {
  return deps.stepPerBranch && deps.stepPerBranch > 0 ? deps.stepPerBranch : (Number(process.env.BTC_XPUB_STEP) || 50);
}

/**
 * Run ONE bounded discovery step for an xpub, resuming from the persisted
 * checkpoint (Connection.cursor). Composes the PURE plan/apply helpers with the
 * batch lookup + DB writes: persists the receive/0 anchor BEFORE any network so
 * a timeout/abort never wipes progress, batch-looks-up usage in one request per
 * chunk, upserts used addresses (idempotent — never duplicates across runs), and
 * persists the advanced checkpoint. Never does a one-shot full scan.
 */
async function discoverXpubStep(params: {
  financialAccountId: string;
  connectionId: string;
  xpub: string;
  cursorRaw: string | null;
  deps: BtcSyncDeps;
}): Promise<{ complete: boolean; usedCount: number }> {
  const parsed = parseExtendedKey(params.xpub);
  const gap = xpubGapLimit(params.deps);
  const step = xpubStepPerBranch(params.deps);
  const cursor = readDiscoveryCursor(params.cursorRaw);
  if (cursor.rDone && cursor.cDone) return { complete: true, usedCount: cursor.used };

  const deriveAt = (branch: number, index: number) => deriveAddressAt(parsed, branch, index);
  const upsert = (ref: AddrRef) =>
    upsertDiscoveredAddress({ financialAccountId: params.financialAccountId, connectionId: params.connectionId, address: ref.address, branch: ref.branch, index: ref.index });

  // Resumable anchor — persist receive/0 before any network so a failure keeps it.
  if (cursor.r === 0 && !cursor.rDone) await upsert({ address: deriveAt(0, 0), branch: 0, index: 0 });

  const plan = planXpubStep(deriveAt, cursor, step);
  const batch = params.deps.batchStatsFetcher
    ? await params.deps.batchStatsFetcher(plan.map((p) => p.address))
    : await fetchAddressStatsBatch(plan.map((p) => p.address), params.deps.fetchImpl);

  const { cursor: next, toPersist, complete } = applyXpubStep(cursor, plan, (a) => (batch.get(a)?.txCount ?? 0) > 0, gap);
  for (const ref of toPersist) await upsert(ref);

  try {
    await db.connection.update({ where: { id: params.connectionId }, data: { cursor: JSON.stringify(next) } });
  } catch (e) {
    console.warn(`[btc-sync] discovery cursor persist failed for ${params.connectionId} (non-fatal):`, e);
  }
  return { complete, usedCount: next.used };
}

/**
 * Sync one BTC wallet account — single-address OR xpub. Never throws.
 *
 * xpub: discovery runs first to populate ProviderAccountIdentity; the confirmed
 * balance is SUMMED across every discovered address into ONE Holding, and
 * transactions from every address are aggregated (deduped by txid) into ONE
 * history. Single-address wallets behave exactly as before, resolved through the
 * same identity path. On any external failure the account is left untouched
 * (visible, "pending") and a SyncIssue is recorded.
 */
export async function syncBtcWallet(
  accountId: string,
  deps: BtcSyncDeps = {},
): Promise<BtcWalletSyncResult> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId },
    select: { id: true, ownerUserId: true, walletChain: true, walletAddress: true, deletedAt: true },
  });

  // Guard: active BTC wallet (walletAddress holds a single address OR an xpub).
  if (!account || account.deletedAt || account.walletChain !== BTC_CHAIN || !account.walletAddress) {
    return { accountId, ok: false, stage: "load", reason: "not a syncable BTC wallet" };
  }

  const connection = await loadWalletConnection(accountId);
  const descriptor = connection?.credential ?? account.walletAddress;
  const isXpub = isExtendedKey(descriptor);

  // xpub: run ONE bounded, resumable discovery step (never a one-shot full scan).
  // The step persists the receive/0 anchor + used addresses + a checkpoint on
  // Connection.cursor, so a timeout/abort never wipes progress and the next
  // sync/Refresh resumes. A large wallet completes over SEVERAL runs.
  let discoveryComplete = !isXpub; // single-address wallets are trivially complete
  let usedCount = isXpub ? 0 : 1;  // non-xpub trivially "has" its one address
  if (isXpub && connection) {
    try {
      const step = await discoverXpubStep({ financialAccountId: accountId, connectionId: connection.id, xpub: descriptor, cursorRaw: connection.cursor, deps });
      discoveryComplete = step.complete;
      usedCount = step.usedCount;
    } catch (e) {
      // The CURRENT run failed. Classify: a malformed key is permanent (reject),
      // rate-limit/network is retryable. Either way set the error and stop — we do
      // NOT silently continue, so the card honestly reflects the failed run. Any
      // already-discovered addresses + checkpoint are preserved for the retry.
      const reason = e instanceof Error ? e.message : String(e);
      const malformed = /extended public key|malformed|watch-only requires/i.test(reason);
      const rateLimited = /rate limit/i.test(reason);
      const errorCode = malformed ? "INVALID_XPUB" : rateLimited ? "RATE_LIMITED" : "DISCOVERY_FAILED";
      await recordWalletSyncIssue(accountId, "discovery", reason, { xpub: true, rateLimited, malformed });
      await touchWalletConnectionStatus({ connectionId: connection.id, ok: false, errorCode });
      return {
        accountId, ok: false, stage: "discovery",
        reason: malformed
          ? "This doesn't look like a valid extended public key (xpub/ypub/zpub)."
          : rateLimited
            ? "The Bitcoin explorer is rate-limiting requests — press Refresh to try again shortly."
            : `Address discovery failed: ${reason}`,
      };
    }
  }

  // Resolve the address set through ProviderAccountIdentity (canonical). Fall
  // back to the stored single address for a pre-v1.5 wallet with no identity.
  let addresses = await getWalletAddresses(accountId);
  if (addresses.length === 0 && !isXpub) addresses = [account.walletAddress];
  if (addresses.length === 0) {
    return { accountId, ok: false, stage: "load", reason: "no addresses to sync" };
  }

  const priceFetcher = deps.priceFetcher ?? (() => fetchBtcUsdPrice(deps.fetchImpl));

  // 1) Confirmed balance across every KNOWN address — batch (one request per 50)
  //    for xpub, per-address for single-address. For a partially-discovered xpub
  //    this is a PARTIAL balance (completes as discovery advances).
  let sats: number;
  try {
    if (deps.balanceFetcher) {
      sats = (await Promise.all(addresses.map(deps.balanceFetcher))).reduce((s, x) => s + x, 0);
    } else if (isXpub) {
      const stats = deps.batchStatsFetcher ? await deps.batchStatsFetcher(addresses) : await fetchAddressStatsBatch(addresses, deps.fetchImpl);
      sats = addresses.reduce((s, a) => s + (stats.get(a)?.sats ?? 0), 0);
    } else {
      sats = await fetchConfirmedSatsForAddresses(addresses, deps.fetchImpl);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordWalletSyncIssue(accountId, "balance", reason, { addresses: addresses.length });
    return { accountId, ok: false, stage: "balance", reason };
  }

  // 2) BTC→USD spot price.
  let priceUsd: number;
  try {
    priceUsd = await priceFetcher();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordWalletSyncIssue(accountId, "price", reason);
    return { accountId, ok: false, stage: "price", reason };
  }

  // 3) Persist the aggregated balance (one account, one balance — no duplicates).
  //    Until an xpub's discovery completes, the account is "pending" (partial),
  //    not "synced" — honest status while more addresses are still being found.
  const nativeBalance = satsToBtc(sats);
  const balanceUsd = computeUsdBalance(nativeBalance, priceUsd);
  await db.financialAccount.update({
    where: { id: accountId },
    data: { nativeBalance, balance: balanceUsd, currency: "USD", syncStatus: discoveryComplete ? "synced" : "pending", lastUpdated: new Date() },
  });

  // v2 — one BTC Holding (summed). v3 — transactions aggregated across addresses,
  //    BOUNDED to the first N addresses per run so a behemoth wallet never issues
  //    hundreds of tx requests; history fills in across runs (idempotent dedupe).
  await writeBtcHolding(accountId, { nativeBalance, priceUsd, balanceUsd });
  // P2-6 — transitional dual-write onto the canonical spine (gated, non-fatal).
  await writeBtcObservation(accountId, nativeBalance, new Date());
  const txAddrCap = Number(process.env.BTC_TX_ADDR_CAP) || 25;
  await importBtcTransactions({ id: accountId, ownerUserId: account.ownerUserId, addresses: addresses.slice(0, txAddrCap) }, deps);

  // v1.5 spine — record the sync. For an xpub the Connection status reflects the
  // discovery lifecycle honestly:
  //   • complete + used addresses found → READY (clears any stale error).
  //   • complete + ZERO used addresses  → not an error: valid key, but likely the
  //     wrong address type. Flag NO_USED_ADDRESSES so the card shows guidance.
  //   • partial PROGRESS (not complete) → clear any stale error and stay
  //     "discovering"; the next Refresh resumes from the checkpoint. (This is the
  //     fix: a prior run's errorCode no longer outlives partial success.)
  // Single-address wallets: full align, as before.
  if (account.ownerUserId) {
    if (isXpub && connection) {
      if (discoveryComplete && usedCount === 0) {
        await recordWalletSyncIssue(accountId, "discovery", "valid extended key, but no used addresses were found", { xpub: true, noUsedAddresses: true });
        await touchWalletConnectionStatus({ connectionId: connection.id, ok: false, errorCode: "NO_USED_ADDRESSES" });
      } else if (discoveryComplete) {
        await touchWalletConnectionStatus({ connectionId: connection.id, ok: true });
        await markWalletAccountConnectionSynced({ financialAccountId: accountId });
      } else {
        await clearWalletConnectionError(connection.id);
      }
    } else {
      await alignWalletProviderSpine({
        userId:             account.ownerUserId,
        financialAccountId: accountId,
        address:            addresses[0],
        chain:              BTC_CHAIN,
        markSynced:         true,
      });
    }
  }

  return {
    accountId,
    ok:           true,
    syncStatus:   discoveryComplete ? "synced" : "pending",
    nativeBalance, balanceUsd, priceUsd,
  };
}

export interface SyncAllBtcWalletsResult {
  total: number;
  succeeded: number;
  failed: number;
  /**
   * The accounts that synced OK this run — the input the caller (the sync-crypto
   * cron body) feeds to wealth-history regen. Deliberately surfaced HERE rather
   * than running regen inside this function: the balance-sync layer stays free
   * of snapshot coupling (965e0bd's shape decision), and the cron body owns the
   * regen step the same way the wallet routes do.
   */
  syncedAccountIds: string[];
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
  const syncedAccountIds: string[] = [];
  for (const w of wallets) {
    const r = await syncBtcWallet(w.id, { ...deps, priceFetcher: sharedPriceFetcher });
    if (r.ok) { succeeded++; syncedAccountIds.push(w.id); }
    else failed++;
  }

  return { total: wallets.length, succeeded, failed, syncedAccountIds };
}
