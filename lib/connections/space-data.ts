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

import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
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
  type ConnectionIntelligenceStatus,
} from "@/lib/connections/intelligence";
import type { AccountLite } from "@/components/connections/ConnectionCard";

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
  lastSyncedAt:       true,
  errorCode:          true,
  investmentsConsent: true, // → client-safe `investments` capability only
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
      name: account.displayName ?? account.officialName ?? account.plaidName ?? account.name,
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
  userId: string,
  itemIds: string[],
): Promise<Record<string, AccountLite[]>> {
  if (itemIds.length === 0) return {};
  const links = await db.accountConnection.findMany({
    where: {
      plaidItemDbId:    { in: itemIds },
      plaidItem:        { userId }, // ownership gate — the user's own connection only
      deletedAt:        null,
      financialAccount: { deletedAt: null },
    },
    select: {
      plaidItemDbId:    true,
      financialAccount: {
        select: { id: true, name: true, displayName: true, officialName: true, plaidName: true, type: true },
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
 * Wallets have no PLAID_HISTORY_SYNCED anchor (reconstruction runs inline before
 * Connection.lastSyncedAt is set), so a ready wallet uses lastSyncedAt as the
 * reconstruction proxy. PCS-2-safe: status/dates only, no balances/valuations.
 */
async function loadConnectionIntelligence(
  userId: string,
  connections: SyncConnection[],
  accountsByConnectionId: Record<string, AccountLite[]>,
): Promise<Record<string, ConnectionIntelligenceStatus>> {
  const now = new Date();

  // 1. Latest reconstruction anchor per connection — the initial PLAID_HISTORY_SYNCED
  //    (keyed by metadata.plaidItemId) OR a manual CONNECTION_INTELLIGENCE_REBUILT
  //    (keyed by metadata.connectionId; CONN-2B). Both mean "a reconstruction
  //    completed"; the latest of either is the connection's reconstruction time.
  //    Rows are few per user; the (userId, createdAt) index serves this.
  const historyRows = await db.auditLog.findMany({
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
  const floors = allAccountIds.length
    ? await db.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: allAccountIds }, deletedAt: null },
        _min:  { date: true },
      })
    : [];
  const earliestByAccount = new Map<string, Date>();
  for (const f of floors) {
    if (f.financialAccountId && f._min.date) earliestByAccount.set(f.financialAccountId, f._min.date);
  }

  const out: Record<string, ConnectionIntelligenceStatus> = {};
  for (const c of connections) {
    // Connection availability = the earliest transaction across its accounts.
    let earliest: Date | null = null;
    for (const a of accountsByConnectionId[c.id] ?? []) {
      const e = earliestByAccount.get(a.id);
      if (e && (!earliest || e < earliest)) earliest = e;
    }
    const historySyncedAt =
      (anchorByConn.get(c.id) ?? null) ??
      // Wallet fallback: reconstruction runs inline before Connection.lastSyncedAt
      // is set, so a ready wallet with no explicit anchor uses lastSyncedAt.
      (c.provider === "WALLET" && c.state === "ready" && c.lastSyncedAt
        ? new Date(c.lastSyncedAt)
        : null);

    out[c.id] = deriveConnectionIntelligence(
      { provider: c.provider, state: c.state, historySyncedAt, earliestTxDate: earliest },
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
export async function loadConnectionsSyncStatus(userId: string): Promise<ConnectionsSyncView> {
  const { status, intelligenceByConnectionId } = await loadConnectionsSpaceData(userId);
  return { status, intelligenceByConnectionId };
}

/**
 * THE canonical Connections loader: sync status + per-connection account
 * inventory, no portfolio read. Plaid and wallet accounts are unified into one
 * `accountsByConnectionId` map (both keyed by SyncConnection.id).
 */
export async function loadConnectionsSpaceData(userId: string): Promise<ConnectionsSpaceData> {
  const [items, wallet] = await Promise.all([
    db.plaidItem.findMany({
      where:   { userId, status: { not: PlaidItemStatus.REVOKED } },
      select:  PLAID_ITEM_SELECT,
      orderBy: { createdAt: "asc" },
    }),
    loadWalletSyncConnections(userId),
  ]);

  const status = finalizeSyncStatus([...buildSyncStatus(items).connections, ...wallet.connections]);

  // Plaid accounts by stable connection id; wallet accounts already come keyed
  // by connection id from loadWalletSyncConnections. One id space, one map.
  const plaidAccounts = await loadPlaidConnectionAccounts(userId, items.map((i) => i.id));
  const accountsByConnectionId = { ...plaidAccounts, ...wallet.accountsByConnectionId };

  const intelligenceByConnectionId = await loadConnectionIntelligence(
    userId,
    status.connections,
    accountsByConnectionId,
  );

  return { status, accountsByConnectionId, intelligenceByConnectionId };
}
