/**
 * lib/connections/space-data.ts  (PCS-2)
 *
 * THE canonical server-side data contract behind the Connections management
 * surface (`/dashboard/connections` + its `GET /api/sync/status` poller).
 *
 * WHY THIS EXISTS — before PCS-2 the Connections page assembled its view from
 * three independent reads glued together in the page component:
 *   1. db.plaidItem.findMany  → buildSyncStatus            (Plaid connection state)
 *   2. loadWalletSyncConnections                           (wallet connection state + accounts)
 *   3. getAccounts({ spaceId }) → group by institution     (account NAMES)
 *
 * (3) was the problem this module removes. getAccounts() is a heavyweight
 * SPACE-VISIBILITY PORTFOLIO read — it joins SpaceAccountLink → FinancialAccount,
 * pulls balances / credit limits / debtProfile, runs visibility redaction
 * (grantsAccountDetail / sanitizeForBalanceOnly), estimates minimum payments, and
 * resolves the reconnect badge — of which the Connections page kept only
 * { id, name, type }, re-grouped by the INSTITUTION STRING. That coupling was
 * wrong on three axes:
 *
 *   • Portfolio consumer: Connections is a provider-MANAGEMENT surface, not a
 *     money view. It must never depend on balances/valuations/visibility tiers.
 *   • Ownership mismatch: a connection is USER-owned (PlaidItem.userId /
 *     Connection.userId); getAccounts is SPACE-visibility scoped. A shared-Space
 *     member sees other members' accounts via getAccounts — accounts that are
 *     NOT their connection. The institution-string match papered over this.
 *   • Fragile join key: grouping accounts by institution display name is exactly
 *     the anti-pattern lib/investments/connection-import-accounts.ts abandoned
 *     ("by STABLE id (never by institution display name)").
 *
 * THE CONTRACT — one loader, one envelope. Accounts are resolved PER CONNECTION
 * by stable id for BOTH providers (Plaid via AccountConnection.plaidItemDbId,
 * wallet via AccountConnection.connectionId), gated to the owning user. No
 * portfolio read, no institution-string grouping, no visibility redaction — the
 * accounts a user's own connection brought in are theirs to see by definition.
 *
 * STATE DERIVATION is NOT re-implemented here: connection state comes verbatim
 * from lib/sync/status.ts (buildSyncStatus / buildWalletSyncStatus /
 * deriveConnectionState), the single authority the Accounts perspective
 * (app/api/spaces/[id]/accounts/detail) and this surface both consume. The Ops
 * `getConnectionHealth` DTO (lib/connections/health.ts) is a DELIBERATELY
 * SEPARATE bounded context — admin-only, aggregate, no-PII, staleness-aware
 * (STALE/DEGRADED) — and is intentionally NOT merged in here.
 *
 * POSITION / HOLDING COUNTS are intentionally OUT OF CONTRACT. Position counts
 * (countCurrentPositionsByAccount) are valuation-derived portfolio data; reading
 * them here would re-make Connections a portfolio consumer, the exact thing PCS-2
 * removes. Account COUNT is free (accountsByConnectionId[id].length) and carries
 * no money.
 */

import type { ReadClient } from "@/lib/db/tenant-context";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import { PlaidItemStatus, ConnectionStatus } from "@prisma/client";
import { getIngestionDeferrals } from "@/lib/platform/refresh/projections";
import {
  buildSyncStatus,
  finalizeSyncStatus,
  type SyncStatus,
  type SyncConnection,
} from "@/lib/sync/status";
import { loadWalletSyncConnections } from "@/lib/sync/wallet-connections";
import { AuditAction } from "@/lib/audit-actions";
import {
  deriveConnectionIntelligence,
  sourceHealthForConnection,
  type ConnectionIntelligenceStatus,
} from "@/lib/connections/intelligence";
import type { SourceHealthInput } from "@/lib/connections/space-data-health.core";
import { loadRefreshPolicies, type RefreshPolicies } from "@/lib/platform/refresh-policy";
import type { AccountLite } from "@/components/connections/ConnectionCard";
import { loadWalletHistoryMetadata, walletActivityStart } from "@/lib/crypto/wallet-history-metadata";
// CRYPTO-FRESHNESS-1 — "does this chain STORE a value?" is registry policy, asked
// here rather than re-decided, so a valuation clock is only claimed where one exists.
import { usesLegacyColumnForCurrentValue } from "@/lib/crypto/wallet-sync-dispatch";

/**
 * The canonical Connections view model. `status` is the provider-agnostic
 * SyncStatus (Plaid + wallet connections, building flag). `accountsByConnectionId`
 * is the per-connection account inventory (NAMES/TYPES only) keyed by
 * SyncConnection.id — the SAME id space for every provider, so a card looks up
 * its accounts with `accountsByConnectionId[connection.id]` regardless of
 * provider. Account count is `accountsByConnectionId[id]?.length ?? 0`.
 */
export interface ConnectionsSpaceData {
  status: SyncStatus;
  accountsByConnectionId: Record<string, AccountLite[]>;
  /**
   * CONN-2A — per-connection financial-intelligence status (derived, never
   * persisted): whether derived intelligence (wealth timeline / snapshots) is
   * built vs still rebuilding after transactions landed. Keyed by
   * SyncConnection.id, same id space as accountsByConnectionId.
   */
  intelligenceByConnectionId: Record<string, ConnectionIntelligenceStatus>;
}

/**
 * The poller's view (GET /api/sync/status): sync status + the intelligence map,
 * so the card can advance importing → RECONSTRUCTING → ready LIVE. The
 * reconstruction transition happens AFTER syncIncompleteAt clears, so the poll
 * must carry intelligence or the card would freeze at "ready" while intelligence
 * is still building.
 */
export interface ConnectionsSyncView {
  status: SyncStatus;
  intelligenceByConnectionId: Record<string, ConnectionIntelligenceStatus>;
}

/** The PlaidItem fields buildSyncStatus + the account join need. */
const PLAID_ITEM_SELECT = {
  id:                 true,
  institutionName:    true,
  status:             true,
  syncIncompleteAt:   true, // derivation only — buildSyncStatus never forwards it
  syncLockedAt:       true, // OPS-2D-4A — deferral evidence; never forwarded either
  syncImportedCount:  true, // live "N imported" progress while state = importing
  historyBuildStartedAt: true, // A9 rebuild phase — keeps state = importing
  historyBuildTotalDays: true,
  historyBuildDoneDays:  true,
  lastSyncedAt:       true,
  errorCode:          true,
  investmentsConsent: true, // → client-safe `investments` capability only
  createdAt:          true, // CONN-2D — authorization/connected time (timeline)
} as const;

/**
 * A row from the per-connection account join, before name resolution. Declared
 * so groupConnectionAccounts (below) stays a PURE, DB-free function that unit
 * tests can exercise without Prisma.
 */
export interface ConnectionAccountRow {
  connectionId: string;
  account: {
    id:           string;
    name:         string;
    displayName:  string | null;
    officialName: string | null;
    plaidName:    string | null;
    type:         string;
  };
}

/**
 * PURE. Groups connection→account rows into the by-connection-id inventory,
 * resolving each display name in the canonical order
 * (displayName ?? officialName ?? plaidName ?? name — the exact order
 * lib/data/accounts.ts and connection-import-accounts.ts use) and de-duplicating
 * accounts that appear under the same connection more than once.
 */
export function groupConnectionAccounts(
  rows: ConnectionAccountRow[],
): Record<string, AccountLite[]> {
  const out: Record<string, AccountLite[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const { connectionId, account } of rows) {
    (seen[connectionId] ??= new Set());
    if (seen[connectionId].has(account.id)) continue;
    seen[connectionId].add(account.id);
    (out[connectionId] ??= []).push({
      id:   account.id,
      // v2.6-TRUTH-10 — the ONE identity authority.
      name: accountDisplayName(account),
      type: account.type,
    });
  }
  return out;
}

/**
 * Plaid accounts for the given PlaidItem ids, keyed by connection id
 * (= PlaidItem.id). Joins AccountConnection.plaidItemDbId → PlaidItem, gated to
 * the owning user, active (deletedAt: null) links to active FinancialAccounts.
 * By STABLE id — never institution name.
 */
async function loadPlaidConnectionAccounts(
  client: ReadClient,
  userId: string,
  itemIds: string[],
): Promise<Record<string, AccountLite[]>> {
  if (itemIds.length === 0) return {};
  const links = await client.accountConnection.findMany({
    where: {
      plaidItemDbId:    { in: itemIds },
      plaidItem:        { userId }, // ownership gate — the user's own connection only
      deletedAt:        null,
      financialAccount: { deletedAt: null },
    },
    select: {
      plaidItemDbId:    true,
      financialAccount: {
        select: { id: true, type: true, ...ACCOUNT_NAME_SELECT },
      },
    },
  });

  const rows: ConnectionAccountRow[] = [];
  for (const l of links) {
    const fa = l.financialAccount;
    if (!fa || !l.plaidItemDbId) continue;
    rows.push({ connectionId: l.plaidItemDbId, account: fa });
  }
  return groupConnectionAccounts(rows);
}

/**
 * CONN-2A — per-connection intelligence status, derived from existing truth ONLY
 * (no new authority, nothing persisted):
 *   - PLAID_HISTORY_SYNCED AuditLog anchor → reconstruction-complete + timestamp
 *   - MIN(non-deleted Transaction.date) across the connection's accounts → available history
 *   - SyncConnection.state → acquisition status
 * CRYPTO-FRESHNESS-1 — WALLETS NO LONGER PROXY ANYTHING. This used to say that a
 * ready wallet "uses lastSyncedAt as the reconstruction proxy", and that proxy
 * is precisely how a BTC refresh whose transaction import had ABORTED came to
 * render "Transactions: Updated today" and "Financial profile: Built today" on
 * 2026-10-01. `Connection.lastSyncedAt` means "the balance was read" for a
 * wallet, and it is now used for exactly that and nothing else. Transaction and
 * reconstruction freshness come from their OWN success clocks
 * (`Connection.transactionsSyncedAt` / `historyRebuiltAt`), and the current
 * position comes from the spine. An absent clock renders as silence.
 * PCS-2-safe: status/dates only, no balances/valuations.
 */
async function loadConnectionIntelligence(
  client: ReadClient,
  userId: string,
  connections: SyncConnection[],
  accountsByConnectionId: Record<string, AccountLite[]>,
  connectedAtByConnId: Map<string, Date>,
  /** Raw provider fields per connection id, for sourceHealthForConnection. */
  rawByConnId: Map<string, Pick<SourceHealthInput, "plaid" | "wallet">>,
  /** CRYPTO-FRESHNESS-1 — per-facet success clocks (wallet connections). */
  facetClocksByConnId: Map<string, { transactionsSyncedAt: Date | null; historyRebuiltAt: Date | null }>,
  /** Resolved once per page load — the same policies the Brief's data health uses. */
  policies: RefreshPolicies,
): Promise<Record<string, ConnectionIntelligenceStatus>> {
  const now = new Date();

  // 1. Latest reconstruction anchor per connection — the initial PLAID_HISTORY_SYNCED
  //    (keyed by metadata.plaidItemId) OR a manual CONNECTION_INTELLIGENCE_REBUILT
  //    (keyed by metadata.connectionId; CONN-2B). Both mean "a reconstruction
  //    completed"; the latest of either is the connection's reconstruction time.
  //    Rows are few per user; the (userId, createdAt) index serves this.
  const historyRows = await client.auditLog.findMany({
    where: {
      userId,
      action: { in: [AuditAction.PLAID_HISTORY_SYNCED, AuditAction.CONNECTION_INTELLIGENCE_REBUILT] },
    },
    select:  { createdAt: true, metadata: true },
    orderBy: { createdAt: "desc" },
  });
  const anchorByConn = new Map<string, Date>();
  for (const row of historyRows) {
    const meta = row.metadata as { plaidItemId?: string; connectionId?: string } | null;
    const id = meta?.connectionId ?? meta?.plaidItemId; // rebuilt → connectionId; history-synced → plaidItemId
    if (id && !anchorByConn.has(id)) anchorByConn.set(id, row.createdAt); // desc → first is latest
  }

  // 2. Earliest transaction date per account (the same MIN(non-deleted date)
  //    definition the wealth-regen floor + accounts route use).
  const allAccountIds = Object.values(accountsByConnectionId).flat().map((a) => a.id);

  // UI-C1 — the chain each account denominates, so the history-metadata
  // authority can ask the capability question per account.
  const walletChainByAccount = new Map<string, string | null>(
    allAccountIds.length
      ? (await client.financialAccount.findMany({
          where:  { id: { in: allAccountIds } },
          select: { id: true, walletChain: true },
        })).map((a) => [a.id, a.walletChain])
      : [],
  );
  const floors = allAccountIds.length
    ? await client.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: allAccountIds }, deletedAt: null },
        _min:  { date: true },
      })
    : [];
  const earliestByAccount = new Map<string, Date>();
  for (const f of floors) {
    if (f.financialAccountId && f._min.date) earliestByAccount.set(f.financialAccountId, f._min.date);
  }

  // 3. CONN-3 balance freshness — FinancialAccount.lastUpdated (the accountsGet
  //    balance-verified stamp). TIMESTAMP ONLY: `balance` is never selected here,
  //    so the PCS-2 no-portfolio-read boundary holds (freshness metadata, no money).
  const balanceRows = allAccountIds.length
    ? await client.financialAccount.findMany({
        where:  { id: { in: allAccountIds } },
        select: { id: true, lastUpdated: true },
      })
    : [];
  const balanceVerifiedByAccount = new Map<string, Date>();
  for (const b of balanceRows) balanceVerifiedByAccount.set(b.id, b.lastUpdated);

  // UI-C1 — a WALLET's history span is its persisted COVERAGE LICENCE, never its
  // transaction count. Bitcoin writes movements to `Transaction` and so had a
  // figure by accident; Solana and Ethereum write none, and reported "No
  // historical data yet" while holding four and nine years of proven quantity
  // coverage. One authority, asked the same way for every chain.
  const walletAccounts = Object.values(accountsByConnectionId).flat()
    .map((a) => ({ id: a.id, walletChain: walletChainByAccount.get(a.id) ?? null }))
    .filter((a) => a.walletChain !== null);
  const historyMeta = await loadWalletHistoryMetadata(walletAccounts, { client });

  // CRYPTO-FRESHNESS-1 — CURRENT-POSITION FRESHNESS, from the spine.
  //
  // `PositionObservation` is the authoritative record that a quantity was
  // OBSERVED, and it advances whether or not that quantity could be priced. No
  // connection surface read it before, which is why the incident's card said
  // "Balances: Updated on Sep 21" while the spine already carried a 2026-10-01
  // observation written minutes earlier. Timestamp only — no quantity, no value,
  // so the PCS-2 no-portfolio-read boundary holds.
  const positionRows = allAccountIds.length
    ? await client.positionObservation.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: allAccountIds }, supersededById: null, deletedAt: null },
        _max:  { date: true },
      })
    : [];
  const positionObservedByAccount = new Map<string, Date>();
  for (const r of positionRows) {
    if (r.financialAccountId && r._max.date) positionObservedByAccount.set(r.financialAccountId, r._max.date);
  }

  const out: Record<string, ConnectionIntelligenceStatus> = {};
  for (const c of connections) {
    // Connection availability = the earliest transaction across its accounts;
    // balance freshness = the OLDEST balance update across them (Slice 4.1).
    let earliest: Date | null = null;
    let balancesUpdated: Date | null = null;
    const accountsUpdated: (Date | null)[] = [];
    for (const a of accountsByConnectionId[c.id] ?? []) {
      // UI-C2 — the ACTIVITY bound, not the proof floor. The licence may reach
      // back through a proven-zero interval (Ethereum's runs 1,289 days before
      // the wallet was first funded); "you have history since 2017" is a
      // different sentence from "we can prove you held zero since 2017", and
      // only the second one is true there. The coverage still outranks the
      // transaction ledger — the ledger only correlates on chains that write
      // movements — it is simply asked for the right bound.
      const licensed = walletActivityStart(historyMeta.get(a.id));
      const e = licensed ?? earliestByAccount.get(a.id);
      if (e && (!earliest || e < earliest)) earliest = e;
      const b = balanceVerifiedByAccount.get(a.id) ?? null;
      accountsUpdated.push(b);
      // The OLDEST, never the newest: one fresh account must not make a source
      // with a stale one look current. The same rule the Daily Brief applies.
      if (b && (!balancesUpdated || b < balancesUpdated)) balancesUpdated = b;
    }
    const facets = facetClocksByConnId.get(c.id);
    // CRYPTO-FRESHNESS-1 — THE FALLBACK IS GONE.
    //
    // This read `(anchor) ?? (WALLET && ready && lastSyncedAt)`, so any ready
    // wallet reported "Financial profile: Built <balance sync time>" whether or
    // not a reconstruction had ever run — and on the incident run, where the
    // reconstruction was skipped entirely because `outcomeRevalued` was false,
    // it still said "Built today".
    //
    // A wallet now uses its OWN reconstruction clock, written only when
    // `refreshWalletHistory` actually refreshed. Null stays null: "we have never
    // successfully rebuilt this" is a fact, and silence is how it is told.
    const historySyncedAt =
      (anchorByConn.get(c.id) ?? null) ??
      (c.provider === "WALLET" ? facets?.historyRebuiltAt ?? null : null);

    // TRANSACTION HISTORY — its own authority per provider.
    //   PLAID  the item sync IS the transaction sync, so `lastSyncedAt` is not a
    //          proxy here; it is the same fact under a different name.
    //   WALLET `transactionsSyncedAt`, advanced only by a COMPLETED import.
    const transactionsSyncedAt = c.provider === "PLAID"
      ? (c.lastSyncedAt ? new Date(c.lastSyncedAt) : null)
      : (facets?.transactionsSyncedAt ?? null);

    // CURRENT POSITION — the newest observation on the spine. The one clock that
    // was correct and current throughout the incident, and the one the card had
    // no reader for at all.
    let positionObservedAt: Date | null = null;
    for (const a of accountsByConnectionId[c.id] ?? []) {
      const p = positionObservedByAccount.get(a.id) ?? null;
      if (p && (!positionObservedAt || p > positionObservedAt)) positionObservedAt = p;
    }

    // VALUATION — for a wallet whose adapter STORES a value, `lastUpdated` is
    // that value's instant (btc-sync advances it only on a priced run, by
    // design). For a read-time-valued chain there is no such clock, and claiming
    // one would be inventing it.
    const chains = (accountsByConnectionId[c.id] ?? [])
      .map((a) => walletChainByAccount.get(a.id) ?? null)
      .filter((ch): ch is string => ch !== null);
    const valuationIsReadTime = c.provider === "WALLET" && chains.length > 0
      && chains.every((ch) => !usesLegacyColumnForCurrentValue(ch));

    out[c.id] = deriveConnectionIntelligence(
      {
        provider: c.provider,
        state:    c.state,
        historySyncedAt,
        earliestTxDate: earliest,
        connectedAt:    connectedAtByConnId.get(c.id) ?? null,
        lastSyncedAt:   c.lastSyncedAt ? new Date(c.lastSyncedAt) : null,
        balancesUpdatedAt: balancesUpdated,
        positionObservedAt,
        transactionsSyncedAt,
        // The same column the Balances row reads, named for what it means on a
        // wallet: the instant the stored USD figure was computed.
        valuationUpdatedAt: valuationIsReadTime ? null : balancesUpdated,
        valuationIsReadTime,
        sourceHealth: sourceHealthForConnection({ provider: c.provider, accountsUpdated, ...rawByConnId.get(c.id),
          policy: c.provider === "PLAID" ? policies.BANK : policies.WALLET }, now),
      },
      now,
    );
  }
  return out;
}

/**
 * Provider-agnostic sync status + intelligence for the user's connections
 * (Plaid + wallet) — the poller read (GET /api/sync/status). Shares the same
 * assembly as loadConnectionsSpaceData so the poll and first render can never
 * derive state differently.
 */
export async function loadConnectionsSyncStatus(client: ReadClient, userId: string): Promise<ConnectionsSyncView> {
  const { status, intelligenceByConnectionId } = await loadConnectionsSpaceData(client, userId);
  return { status, intelligenceByConnectionId };
}

/**
 * THE canonical Connections loader: sync status + per-connection account
 * inventory, no portfolio read. Plaid and wallet accounts are unified into one
 * `accountsByConnectionId` map (both keyed by SyncConnection.id).
 *
 * ── RLS-PREP-C — THE AUTHORITY IS THE CALLER'S, REQUIRED AND LEADING ─────────
 * This module imported `db` and used it for every read, so the Connections page
 * and its poller (`/api/sync/status`) read PlaidItem, Connection,
 * AccountConnection, FinancialAccount, Transaction, PositionObservation and
 * AuditLog as the migration principal — and NEITHER CALLER imported `db`, so
 * neither appeared on the authority ratchet. A `userId` predicate in the `where`
 * clause was the entire boundary.
 *
 * Every one of those tables is expressible under the existing tenant policies
 * with the same predicate the code already wrote: PlaidItem / Connection /
 * AuditLog are `userId = me`; the account tables are owned-or-linked, and a
 * connection's accounts are its owner's. So the conversion changes which rows
 * CAN be returned, not which rows ARE returned for an honest caller.
 *
 * ⚠️ ONE READ STAYS ON fm_system, BY DESIGN: `getIngestionDeferrals`, which
 * reads the refresh ledger. `RefreshExecution` is REVOKED from fm_app, the
 * function is keyed by item ids this phase has just read as the caller, and it
 * returns a deferral verdict per id and nothing else. It is a capability in
 * lib/platform/, not a default this module falls into.
 */
export async function loadConnectionsSpaceData(client: ReadClient, userId: string): Promise<ConnectionsSpaceData> {
  const [items, wallet] = await Promise.all([
    client.plaidItem.findMany({
      where:   { userId, status: { not: PlaidItemStatus.REVOKED } },
      select:  PLAID_ITEM_SELECT,
      orderBy: { createdAt: "asc" },
    }),
    loadWalletSyncConnections(client, userId),
  ]);

  // OPS-2D-4A — resolve policy deferral from the refresh ledger before deriving
  // state. One query for the whole page; a missing entry means "not deferred".
  const deferrals = await getIngestionDeferrals(
    items.map((i) => ({ id: i.id, syncLockedAt: i.syncLockedAt ?? null })),
  );
  const status = finalizeSyncStatus([...buildSyncStatus(items, deferrals).connections, ...wallet.connections]);

  // Plaid accounts by stable connection id; wallet accounts already come keyed
  // by connection id from loadWalletSyncConnections. One id space, one map.
  const plaidAccounts = await loadPlaidConnectionAccounts(client, userId, items.map((i) => i.id));
  const accountsByConnectionId = { ...plaidAccounts, ...wallet.accountsByConnectionId };

  // Connected/authorization time per connection (CONN-2D timeline): Plaid item
  // createdAt (already selected) + wallet Connection.createdAt (a tiny id→date read).
  const walletCreatedRows = await client.connection.findMany({
    where:  { userId, status: { not: ConnectionStatus.REVOKED } },
    // status/errorCode/lastSyncedAt/cursor — the raw fields source health reads
    // (the cursor only as "is there one"; its value never leaves this function).
    // CRYPTO-FRESHNESS-1 — `transactionsSyncedAt` / `historyRebuiltAt` are the
    // per-facet SUCCESS clocks. They exist because this loader used to answer
    // three different questions with `lastSyncedAt`, which for a wallet means
    // only "the balance was read".
    select: { id: true, createdAt: true, status: true, errorCode: true, lastSyncedAt: true, cursor: true,
              transactionsSyncedAt: true, historyRebuiltAt: true },
  });
  const rawByConnId = new Map<string, Pick<SourceHealthInput, "plaid" | "wallet">>();
  for (const i of items) {
    rawByConnId.set(i.id, { plaid: { status: i.status, lastSyncedAt: i.lastSyncedAt,
      syncIncompleteAt: i.syncIncompleteAt, historyBuildStartedAt: i.historyBuildStartedAt } });
  }
  for (const w of walletCreatedRows) {
    rawByConnId.set(w.id, { wallet: { status: w.status, errorCode: w.errorCode, lastSyncedAt: w.lastSyncedAt, discoveryCursor: !!w.cursor } });
  }
  const connectedAtByConnId = new Map<string, Date>();
  for (const i of items) connectedAtByConnId.set(i.id, i.createdAt);
  for (const w of walletCreatedRows) connectedAtByConnId.set(w.id, w.createdAt);
  // CRYPTO-FRESHNESS-1 — per-facet success clocks, wallet connections only.
  const facetClocksByConnId = new Map<string, { transactionsSyncedAt: Date | null; historyRebuiltAt: Date | null }>();
  for (const w of walletCreatedRows) {
    facetClocksByConnId.set(w.id, { transactionsSyncedAt: w.transactionsSyncedAt, historyRebuiltAt: w.historyRebuiltAt });
  }

  const intelligenceByConnectionId = await loadConnectionIntelligence(
    client,
    userId,
    status.connections,
    accountsByConnectionId,
    connectedAtByConnId,
    rawByConnId,
    facetClocksByConnId,
    await loadRefreshPolicies(client),
  );

  return { status, accountsByConnectionId, intelligenceByConnectionId };
}
