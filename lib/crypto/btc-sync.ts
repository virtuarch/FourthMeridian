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
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
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
import { BTC_NATIVE, ledgerEpsilonFor } from "@/lib/crypto/native-asset";
import { reconcileWalletLedger, type LedgerReconciliation } from "@/lib/crypto/ledger-completeness.core";
import { economicDateFor } from "@/lib/transactions/economic-date-write";
// v2.6-OWN-1 — the on-chain ledger names itself as the author of its flow facts.
import { foreignFlowOwnershipFields } from "@/lib/transactions/flow-authority";

/**
 * The only chain this v1 sync supports.
 *
 * W-M0 — sourced from the shared native-asset descriptor rather than declared
 * here, so this adapter's chain token, the currency it stamps on movement rows,
 * the symbol its ledger predicate selects and the canonical Instrument ticker
 * are all ONE string. They were four independent literals; four literals that
 * must agree are a drift waiting to happen.
 */
export const BTC_CHAIN = BTC_NATIVE.chain;

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
  stage?: "load" | "discovery" | "balance" | "price" | "transactions" | "capture";
  reason?: string;
  /**
   * V26-S3-LEDGER — does the imported movement ledger account for the observed
   * balance? A wallet is not history-ready until this is true, and the caller
   * can see it rather than having to re-derive it.
   */
  ledgerComplete?: boolean;
  ledgerResidual?: number | null;
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
  stage: "discovery" | "balance" | "price" | "transactions" | "capture",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  // OPS-2D-5A-2 — through the canonical facade. This was the last direct
  // `db.syncIssue.create` in the product tree, which meant BTC failures never
  // converged: every retry of the same stalled wallet inserted a fresh row.
  //
  // Scope is the FINANCIAL ACCOUNT, which for a wallet is the wallet — there is
  // no plaidItemId here, and without an explicit scope the identity builder
  // would have keyed every wallet on the platform to one episode per stage.
  // `stage` (discovery / balance / price) already distinguishes the three
  // failure modes, so it carries identity without any taxonomy change.
  await recordSyncIssue({
    // OPS-2D-5B-1 — one public kind for all three wallet operations; the
    // discovery/balance/price distinction lives in the operation key.
    kind:               SyncIssueKind.WALLET_SYNC_FAILED,
    provider:           "WALLET",
    financialAccountId,
    detail:             { chain: BTC_CHAIN, stage, message, ...(extra ?? {}) } as Prisma.InputJsonValue,
  });
}

/**
 * P2-6 (completed at W5) — the wallet's position write is SPINE-ONLY. The
 * balance is recorded as a canonical OBSERVED `PositionObservation` (via the
 * ONE canonical BTC Instrument), quantity-only: valuation happens at read time
 * through the canonical dated price series (getCurrentPositions /
 * historical-crypto-valuation), never from a stored undated figure. A zero
 * balance writes a `quantity:0` closure row. Gated behind
 * INVESTMENT_OBSERVATIONS_ENABLED (inside captureWalletPosition) and
 * best-effort/non-fatal.
 *
 * W5 executed the dual-write's own DELETION CONDITION: the legacy `Holding`
 * mirror (`writeBtcHolding`) was removed once the census showed zero remaining
 * production `Holding` readers (the AI assembler, the data export and the
 * account read all consume getCurrentPositions; the crypto-only bridge is
 * deleted). scripts/audit-crypto-holding-tombstone.ts keeps the count at zero
 * — do not reintroduce a wallet `Holding` write to satisfy a new reader; new
 * readers consume the spine.
 *
 * ── W6d — WHY THIS IS NO LONGER UNCONDITIONALLY NON-FATAL ───────────────────
 * "Best-effort" was defensible for exactly as long as `FinancialAccount.balance`
 * was Bitcoin's CURRENT-value authority: a swallowed capture failure cost the
 * spine a row, and every account surface still read a real number from the
 * column. W6d moves that authority onto the spine, and the same swallowed
 * failure then costs the wallet its value — the row would be written with a
 * balance nothing canonical reads, the spine would hold no observation for
 * today, and the account would resolve NO_OBSERVATION. A wallet that silently
 * loses its worth because a non-fatal warning was logged is precisely the
 * two-chains-of-custody defect this program exists to close.
 *
 * So the severity FOLLOWS the authority, read from the ONE registry that owns
 * it, rather than being a second place where a chain's participation is decided:
 *
 *   legacy column still authoritative → warn, continue (today's behaviour,
 *                                       byte-identical)
 *   spine is authoritative            → REFUSE the sync at stage "capture"
 *
 * This is what Solana already does (sol-sync.ts step 3), and refusing is the
 * honest outcome: `lastUpdated` is not advanced, so the wallet AGES into STALE
 * and then VERY_STALE instead of claiming a confirmation it never got.
 *
 * The registry is reached by DYNAMIC import on purpose. `wallet-sync-dispatch`
 * imports `syncBtcWallet` from this module to build its adapter table, so a
 * static import here would close a module cycle at evaluation time; the lazy
 * import resolves at call time, when both modules are already initialised.
 * (Same reason and same shape as lib/snapshots/space-accounts.ts's lazy import
 * of the wallet-value authority.)
 *
 * @returns null on success; a refusal reason when the caller must abort.
 */
async function writeBtcObservation(
  financialAccountId: string,
  nativeBalance: number,
  date: Date,
): Promise<string | null> {
  const { writesLegacyBalanceColumn } = await import("@/lib/crypto/wallet-sync-dispatch");
  // The column is Bitcoin's current-value authority ⇒ the spine is a mirror, and
  // losing the mirror is not a reason to refuse a balance we did read.
  const spineIsCurrentAuthority = !writesLegacyBalanceColumn(BTC_CHAIN);

  let written = false;
  try {
    ({ written } = await captureWalletPosition({ financialAccountId, asset: BTC_ASSET, quantity: nativeBalance, date }));
  } catch (e) {
    const reason = `position capture failed: ${e instanceof Error ? e.message : String(e)}`;
    if (!spineIsCurrentAuthority) {
      console.warn(`[btc-sync] BTC PositionObservation write failed for account ${financialAccountId} (non-fatal):`, e);
      return null;
    }
    await recordWalletSyncIssue(financialAccountId, "capture", reason, { nativeBalance });
    return reason;
  }

  // `written: false` is NOT an error — it is INVESTMENT_OBSERVATIONS_ENABLED
  // being off on this deployment. It is nevertheless fatal once the spine is the
  // authority: the balance was read and there is nowhere canonical to record it,
  // so reporting "synced" would present that silence as a completed sync.
  if (!written && spineIsCurrentAuthority) {
    const reason =
      "The balance was read, but canonical position capture is disabled on this deployment " +
      "(INVESTMENT_OBSERVATIONS_ENABLED), so there is nowhere to record it.";
    await recordWalletSyncIssue(financialAccountId, "capture", reason, { nativeBalance });
    return reason;
  }

  return null;
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
 *
 * v2.6-OWN-1 — that distinctness is now a VALUE, not an absence: every row this
 * builder produces is stamped `flowAuthority = CRYPTO_LEDGER`. "classifierVersion
 * IS NULL" previously meant two different things — this authority, and the
 * never-classified seed backlog — and the two are now separable by construction.
 * `classifierVersion` stays null, which remains a true statement about the row.
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
    // L8-A — on-chain rows carry no authorization, so the economic date IS the
    // occurrence date. Routed through the one write authority anyway, so a
    // future chain that DOES attest an earlier time needs no change here.
    economicDate:          economicDateFor({ postingDate: m.occurredAt, authorizedAt: null }),
    merchant,
    description:           m.description,
    category,
    amount:                m.amountBtc,   // native BTC; inflow +, outflow/fee −
    currency:              BTC_NATIVE.symbol,
    pending:               m.settlement === "PENDING",
    externalTransactionId: m.externalId,
    flowType,
    flowDirection,
    // v2.6-OWN-1 — this authority names itself. `classifierVersion` stays absent
    // (null), so the two facts agree: the classifier did not write this row, and
    // the ledger that did is named.
    ...foreignFlowOwnershipFields("CRYPTO_LEDGER"),
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
 * V26-PRE (B4) — pure identity filter for the import step (exported for tests).
 * A movement is fresh only when NO row — active OR tombstoned — already claims
 * its externalId for this account: tombstone wins, a re-sync never resurrects
 * a deliberate deletion as a new active row.
 */
export function filterFreshMovements<T extends { externalId: string }>(
  movements: T[],
  existingExternalIds: Iterable<string | null>,
): T[] {
  const seen = new Set<string>();
  for (const id of existingExternalIds) if (id !== null) seen.add(id);
  return movements.filter((m) => !seen.has(m.externalId));
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
    // no-op.
    //
    // V26-PRE (B4) — two identity defenses this path previously lacked (the
    // Plaid path has both; this one had neither):
    //
    //   TOMBSTONE WINS — the dedupe read now INCLUDES soft-deleted rows. An
    //   on-chain tx never vanishes upstream, so a tombstoned BTC row reflects a
    //   deliberate user / import-rollback decision; the old `deletedAt: null`
    //   filter made the very next sync re-create the same externalTransactionId
    //   as a NEW ACTIVE row, defeating the tombstone and violating the identity
    //   doctrine's replay invariant ("must not create an additional active row").
    //
    //   RACE BACKSTOP — nothing locks a wallet sync, and the manual sync route
    //   and the daily cron can run concurrently: both used to read `existing`,
    //   then both createMany the same movements → duplicated financial rows
    //   with no constraint to stop them. The DB now carries an active-row
    //   unique index on (financialAccountId, externalTransactionId) WHERE
    //   deletedAt IS NULL (migration 20260727_v26pre_b4_btc_identity_backstop),
    //   and `skipDuplicates: true` (ON CONFLICT DO NOTHING) makes the losing
    //   writer's overlap silently no-op instead of duplicating or failing the
    //   whole batch.
    const ids = movements.map((m) => m.externalId);
    const existing = await db.transaction.findMany({
      where:  { financialAccountId: account.id, externalTransactionId: { in: ids } },
      select: { externalTransactionId: true },
    });
    const fresh = filterFreshMovements(movements, existing.map((e) => e.externalTransactionId));
    if (fresh.length === 0) return;

    await db.transaction.createMany({
      data: fresh.map((m) => buildTransactionRow(account.id, m, ownByAddress)),
      skipDuplicates: true,
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
 * balance is SUMMED across every discovered address into ONE position (the
 * account balance + ONE spine observation — W5: no legacy Holding row), and
 * transactions from every address are aggregated (deduped by txid) into ONE
 * history. Single-address wallets behave exactly as before, resolved through the
 * same identity path. On any external failure the account is left untouched
 * (visible, "pending") and a SyncIssue is recorded.
 */
/**
 * V26-S3-LEDGER — reconcile this wallet's STORED movement ledger against a
 * freshly observed balance, through the canonical authority.
 *
 * The predicates are the binding's documented responsibility and are exactly the
 * ones the regenerator applies (regenerate-history.ts): this account only,
 * native-denominated, POSTED, not deleted. Keeping them identical is the point —
 * two reconciliations that disagreed about what counts would be worse than none.
 */
async function reconcileWalletLedgerForAccount(
  accountId: string,
  observedBalance: number,
): Promise<LedgerReconciliation> {
  const rows = await db.transaction.findMany({
    where: {
      financialAccountId: accountId,
      // W-M0 — the SAME string this adapter stamps on the rows it writes, and
      // the same one the historical predicates select by. Not a coincidence to
      // be maintained; one descriptor read from three places.
      currency:           BTC_NATIVE.symbol,
      deletedAt:          null,
      settlementState:    SettlementState.POSTED,
    },
    select: { amount: true },
  });
  return reconcileWalletLedger({
    observedBalance,
    movements: rows.map((r) => r.amount),
    // One satoshi — the value this reconciliation always used, now stated as a
    // property of the asset instead of a constant that happened to be Bitcoin's.
    epsilon:   ledgerEpsilonFor(BTC_NATIVE),
  });
}

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
  // V26-S1-BTC — retained so the transaction import can select addresses by
  // DEMONSTRATED ACTIVITY rather than by position. See the import call below.
  let statsByAddress: Map<string, AddrStat> | null = null;
  try {
    if (deps.balanceFetcher) {
      sats = (await Promise.all(addresses.map(deps.balanceFetcher))).reduce((s, x) => s + x, 0);
    } else if (isXpub) {
      const stats = deps.batchStatsFetcher ? await deps.batchStatsFetcher(addresses) : await fetchAddressStatsBatch(addresses, deps.fetchImpl);
      statsByAddress = stats;
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
  // REVIEW-3 (BTC money contract, point 1) — the native quantity is the
  // canonical stored fact; everything USD below is DERIVED from it. Assert its
  // coherence before anything derives from it: a provider returning garbage
  // must fail the sync, not write a fabricated quantity and valuation.
  if (!Number.isFinite(nativeBalance) || nativeBalance < 0) {
    const reason = `incoherent native balance from provider (sats=${sats})`;
    await recordWalletSyncIssue(accountId, "balance", reason);
    return { accountId, ok: false, stage: "balance", reason };
  }
  const balanceUsd = computeUsdBalance(nativeBalance, priceUsd);

  // v2 — one summed BTC position (W5: FA balance + spine observation; the
  //    legacy Holding mirror is retired). v3 — transactions aggregated across addresses,
  //    BOUNDED to the first N addresses per run so a behemoth wallet never issues
  //    hundreds of tx requests; history fills in across runs (idempotent dedupe).
  // V26-S1-BTC — IMPORT TRANSACTIONS FOR EVERY ADDRESS THAT HAS ANY.
  //
  // This was `addresses.slice(0, BTC_TX_ADDR_CAP || 25)`, commented "history
  // fills in across runs (idempotent dedupe)". It does not: `slice(0, 25)` is
  // deterministic, so it selects the SAME first 25 addresses on every run and
  // addresses 26+ never have their transactions imported — while their balances
  // ARE counted, because the balance step above walks the whole set. The result
  // is a wallet whose balance is complete and whose ledger structurally cannot
  // be, which is precisely what reconcileWalletLedger now refuses.
  //
  // The correct bound is not a count, it is EVIDENCE: only an address with
  // on-chain activity has transactions to fetch, and discovery already told us
  // which those are (AddrStat.txCount, from the same batch call that produced
  // the balance). For the live wallet that is 1 address out of 41 — fewer
  // requests than the cap it replaces, and complete.
  //
  // Without stats (single-address wallets, or an injected balanceFetcher) every
  // known address is asked, which for those shapes is a set of one or two.
  const txAddresses = statsByAddress
    ? addresses.filter((a) => (statsByAddress.get(a)?.txCount ?? 0) > 0)
    : addresses;
  await importBtcTransactions({ id: accountId, ownerUserId: account.ownerUserId, addresses: txAddresses }, deps);

  // V26-S3-LEDGER — A WALLET IS NOT HISTORY-READY UNTIL ITS LEDGER RECONCILES.
  //
  // Balance and ledger are gathered by different means: the balance walks every
  // discovered address in one batch call, the ledger paginates each active
  // address. They can therefore disagree, and until now nothing at sync time
  // asked whether they did. `syncStatus` flipped to "synced" on discovery alone,
  // so a wallet whose import was short — the live one, 25 of 28 confirmed
  // transactions — reported itself fully synced while its history was missing
  // 8.4% of the coin.
  //
  // Regeneration already refuses such a wallet (S1), but it refuses SILENTLY
  // from the wallet's point of view: the account looked healthy and the history
  // simply never appeared. The verdict belongs here too, at the moment the
  // evidence is gathered, on the SAME authority the regenerator uses — never a
  // second reconciliation rule.
  //
  // The reconciliation runs BEFORE the balance is persisted, so the row is
  // written ONCE with both facts at the same instant. Writing "synced" first and
  // correcting it afterwards would leave a window — however short — in which the
  // account claims a completeness we already knew it did not have.
  //
  // This gate is identical for a first connection and a resync because there is
  // exactly ONE sync path (`syncBtcWallet`); the connect route, the manual sync
  // route and the cron all call it. A newly connected wallet therefore cannot
  // reach "synced" — and the history regeneration the connect route runs
  // immediately afterwards cannot license its quantity — until the ledger
  // accounts for the balance.
  // W5 — spine-only position write (the legacy Holding dual-write is retired;
  // see writeBtcObservation's doc).
  //
  // W6d — this runs BEFORE the row is updated, and its refusal aborts before
  // ANY column is written. That ordering is the point: once the spine carries
  // the current value, a run that writes `balance` while failing to write the
  // observation would leave the two stores disagreeing about the same instant,
  // with the authoritative one empty. Refusing leaves the row exactly as the
  // previous successful sync left it — the failure policy this file has always
  // had — and lets freshness age it honestly.
  const captureRefusal = await writeBtcObservation(accountId, nativeBalance, new Date());
  if (captureRefusal !== null) {
    return { accountId, ok: false, stage: "capture", reason: captureRefusal };
  }

  const ledger = await reconcileWalletLedgerForAccount(accountId, nativeBalance);

  // ── THE BTC MONEY CONTRACT (REVIEW-3, row 30/33 — read before touching) ─────
  //
  //  1. NATIVE QUANTITY IS CANONICAL. `nativeBalance` (BTC, from confirmed
  //     on-chain sats) is the stored financial FACT for this wallet. It is the
  //     value the ledger reconciliation checks, the quantity the observation
  //     spine records, and the only number here with provenance.
  //  1a. W6d — THE USD COLUMN IS NO LONGER A READ AUTHORITY. It is still
  //     written (below), and deliberately: `nativeBalance` is what
  //     regenerate-history reads to decide whether a wallet ever held anything
  //     material, and the pair is the last-resort fallback for a wallet with no
  //     spine evidence at all. But no canonical CURRENT read composes value from
  //     it once the registry stops naming BTC LEGACY_BALANCE_COLUMN — the
  //     account card, the detail route, the Space mount payload and today's
  //     snapshot all resolve through `loadWalletCurrentValues`, which prices the
  //     OBSERVED position written above at the canonical dated close.
  //     Measured on the live wallet, that moved the figure by +$108.86 on
  //     0.24060252 BTC: an undated 78,426.98 spot against the canonical
  //     78,879.42 close. The column is a WRITE for compatibility; treating it as
  //     truth is the defect.
  //  2. THE USD FIGURE IS VALUATION-DERIVED PRESENTATION, NOT FX TRUTH.
  //     `balance`/`currency:"USD"` is quantity × an UNDATED mempool.space spot
  //     quote fetched in this same run (`priceUsd`), deliberately BYPASSING
  //     convertMoney: BTC is an asset with a fiat valuation, not a cash
  //     currency, so this is a price×quantity valuation, not a currency
  //     conversion (docs/systems/money-and-fx.md). Nothing downstream may
  //     treat this column as a dated FX fact — historical crypto valuation
  //     re-values from `nativeBalance` × the dated price archive
  //     (historical-crypto-valuation.core.ts), never from this column.
  //  3. VALUATION INSTANT / SOURCE — DOCUMENTED LIMIT. The quote's own
  //     timestamp is not supplied by the spot endpoint and FinancialAccount has
  //     NO column for a valuation source or instant; `lastUpdated` (written
  //     below, same run as the price fetch) is the closest recorded instant,
  //     and `balanceLastUpdatedAt` is deliberately NOT reused — it is typed as
  //     the INSTITUTION's balance clock (D4) and freshness surfaces consume it
  //     with that meaning. Adding a provenance column is schema work owned by
  //     the "crypto valuation spine completion" workstream, NOT this program —
  //     do not smuggle the instant into a column that means something else.
  await db.financialAccount.update({
    where: { id: accountId },
    data: {
      nativeBalance, balance: balanceUsd, currency: "USD",
      // "pending" is the honest status when the ledger is short: the balance is
      // real, the history is still incomplete, and the next run continues the
      // pagination.
      syncStatus: discoveryComplete && ledger.complete ? "synced" : "pending",
      lastUpdated: new Date(),
    },
  });

  if (!ledger.complete) {
    await recordWalletSyncIssue(accountId, "transactions", ledger.reason, {
      movementCount: ledger.movementCount,
      movementTotal: ledger.movementTotal,
      observedBalance: nativeBalance,
      residual: ledger.residual,
    });
  }

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
    // V26-S3-LEDGER — "synced" now requires BOTH halves: discovery finished AND
    // the movement ledger accounts for the balance. Reporting "synced" on a
    // ledger we know is short is the dishonesty this gate removes, and it is the
    // status the connect route's history regeneration runs against.
    syncStatus:   discoveryComplete && ledger.complete ? "synced" : "pending",
    nativeBalance, balanceUsd, priceUsd,
    ledgerComplete: ledger.complete,
    ledgerResidual: ledger.residual,
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
