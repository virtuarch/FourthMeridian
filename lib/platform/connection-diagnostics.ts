/**
 * lib/platform/connection-diagnostics.ts  (CONN-2F)
 *
 * Operator-facing per-connection DIAGNOSTICS for Platform HQ / Customer Success.
 * Purpose: when a beta user says "my financial picture is wrong", an operator can
 * see WHICH layer is behind — acquisition (L1), intelligence build (L2), or
 * current freshness (L3) — without touching customer financial data.
 *
 * BOUNDARY (binding): operational METADATA only — status, health, counts,
 * timestamps, institution label, and the owner's email (the support identifier).
 * NO balances, NO transaction amounts, NO SpaceSnapshot value columns (only its
 * `date` is read, as a FRESHNESS signal). This is NOT a new financial authority —
 * it reuses the same pure derivations the customer surface uses:
 * deriveConnectionState / deriveConnectionIntelligence / deriveConnectionHealthState.
 *
 * The freshness field (latest snapshot date) is explicitly labeled as freshness,
 * NOT rebuilt intelligence — CONN-3 owns the freshness pipeline; here we only
 * report the most recent snapshot's recency so an operator can see staleness.
 */

import { db } from "@/lib/db";
import { ProviderType, ShareStatus, PlaidItemStatus, ConnectionStatus } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { deriveConnectionState, deriveWalletConnectionState } from "@/lib/sync/status";
import { deriveConnectionIntelligence, formatAvailableHistory } from "@/lib/connections/intelligence";
import {
  deriveConnectionHealthState,
  PLAID_STALE_MS_EXPORT,
  WALLET_STALE_MS_EXPORT,
  type HealthState,
} from "@/lib/connections/health";

export interface ConnectionDiagnostic {
  id:          string;   // the operator handle (already used by resync/reauth)
  owner:       string;   // owner email — the support identifier (grant-gated)
  source:      string;   // institution / wallet label
  provider:    "PLAID" | "WALLET";
  status:      string;   // raw provider status (ACTIVE/NEEDS_REAUTH/ERROR)
  healthState: HealthState;
  acquisition: {
    lastAcquiredAt:        string | null;
    transactionCount:      number;
    latestTransactionDate: string | null;
    syncStatus:            "IMPORTING" | "READY" | "ACTION_REQUIRED";
    errorCode:             string | null;
  };
  intelligence: {
    lastBuiltAt:      string | null;
    status:           "READY" | "REBUILDING" | "NOT_READY";
    accountsCovered:  number;
    availableHistory: string; // formatted "~N" / "No historical data yet"
  };
  freshness: {
    latestSnapshotDate: string | null; // FRESHNESS (snapshot recency), NOT rebuilt intelligence
  };
}

const DEFAULT_CAP = 50;

function walletLabel(externalConnectionId: string | null): string {
  if (!externalConnectionId) return "Self-custody wallet";
  return `Self-custody wallet …${externalConnectionId.slice(-6)}`;
}

export async function getConnectionDiagnostics(cap = DEFAULT_CAP): Promise<ConnectionDiagnostic[]> {
  const now = new Date();
  const nowMs = now.getTime();

  // 1. Connections across all owners (operator view) + owner email + account links.
  const [plaidItems, wallets] = await Promise.all([
    db.plaidItem.findMany({
      where:   { status: { not: PlaidItemStatus.REVOKED } },
      select:  {
        id: true, institutionName: true, status: true, errorCode: true,
        lastSyncedAt: true, syncIncompleteAt: true, createdAt: true,
        user: { select: { email: true } },
        connections: { where: { deletedAt: null }, select: { financialAccountId: true } },
      },
      orderBy: { createdAt: "desc" },
      take:    cap,
    }),
    db.connection.findMany({
      where:   { provider: ProviderType.WALLET, status: { not: ConnectionStatus.REVOKED } },
      select:  {
        id: true, externalConnectionId: true, status: true, errorCode: true,
        lastSyncedAt: true, createdAt: true,
        user: { select: { email: true } },
        accountConnections: { where: { deletedAt: null }, select: { financialAccountId: true } },
      },
      orderBy: { createdAt: "desc" },
      take:    cap,
    }),
  ]);

  // 2. fa ids per connection.
  const faByConn = new Map<string, string[]>();
  for (const p of plaidItems) faByConn.set(p.id, p.connections.map((c) => c.financialAccountId));
  for (const w of wallets)    faByConn.set(w.id, w.accountConnections.map((c) => c.financialAccountId));
  const uniqFa = [...new Set([...faByConn.values()].flat())];

  // 3. tx aggregates per account (count + earliest + latest) — counts/dates only.
  const txAgg = uniqFa.length
    ? await db.transaction.groupBy({
        by:     ["financialAccountId"],
        where:  { financialAccountId: { in: uniqFa }, deletedAt: null },
        _count: { _all: true },
        _min:   { date: true },
        _max:   { date: true },
      })
    : [];
  const txByAccount = new Map<string, { count: number; min: Date | null; max: Date | null }>();
  for (const t of txAgg) {
    if (t.financialAccountId) txByAccount.set(t.financialAccountId, { count: t._count._all, min: t._min.date, max: t._max.date });
  }

  // 4. reconstruction anchors (latest per connection).
  const anchorRows = await db.auditLog.findMany({
    where:   { action: { in: [AuditAction.PLAID_HISTORY_SYNCED, AuditAction.CONNECTION_INTELLIGENCE_REBUILT] } },
    select:  { createdAt: true, metadata: true },
    orderBy: { createdAt: "desc" },
    take:    2000,
  });
  const anchorByConn = new Map<string, Date>();
  for (const r of anchorRows) {
    const meta = r.metadata as { plaidItemId?: string; connectionId?: string } | null;
    const id = meta?.connectionId ?? meta?.plaidItemId;
    if (id && !anchorByConn.has(id)) anchorByConn.set(id, r.createdAt);
  }

  // 5. Freshness: fa → ACTIVE SpaceAccountLink → space; MAX(SpaceSnapshot.date) per
  //    space. Reads ONLY the snapshot date, never a value column.
  const links = uniqFa.length
    ? await db.spaceAccountLink.findMany({
        where:  { financialAccountId: { in: uniqFa }, status: ShareStatus.ACTIVE },
        select: { financialAccountId: true, spaceId: true },
      })
    : [];
  const spacesByFa = new Map<string, Set<string>>();
  const allSpaceIds = new Set<string>();
  for (const l of links) {
    let set = spacesByFa.get(l.financialAccountId);
    if (!set) { set = new Set(); spacesByFa.set(l.financialAccountId, set); }
    set.add(l.spaceId);
    allSpaceIds.add(l.spaceId);
  }
  const snapAgg = allSpaceIds.size
    ? await db.spaceSnapshot.groupBy({ by: ["spaceId"], where: { spaceId: { in: [...allSpaceIds] } }, _max: { date: true } })
    : [];
  const maxSnapBySpace = new Map<string, Date>();
  for (const s of snapAgg) if (s._max.date) maxSnapBySpace.set(s.spaceId, s._max.date);

  const txForConn = (faIds: string[]) => {
    let count = 0; let min: Date | null = null; let max: Date | null = null;
    for (const fa of faIds) {
      const t = txByAccount.get(fa);
      if (!t) continue;
      count += t.count;
      if (t.min && (!min || t.min < min)) min = t.min;
      if (t.max && (!max || t.max > max)) max = t.max;
    }
    return { count, min, max };
  };
  const latestSnapshot = (faIds: string[]): Date | null => {
    let max: Date | null = null;
    for (const fa of faIds) for (const sp of spacesByFa.get(fa) ?? []) {
      const d = maxSnapBySpace.get(sp);
      if (d && (!max || d > max)) max = d;
    }
    return max;
  };

  const out: ConnectionDiagnostic[] = [];

  for (const p of plaidItems) {
    const faIds = faByConn.get(p.id) ?? [];
    const tx = txForConn(faIds);
    const state = deriveConnectionState({ status: p.status, syncIncompleteAt: p.syncIncompleteAt }) ?? "error";
    const intel = deriveConnectionIntelligence(
      { provider: "PLAID", state, historySyncedAt: anchorByConn.get(p.id) ?? null, earliestTxDate: tx.min, connectedAt: p.createdAt, lastSyncedAt: p.lastSyncedAt },
      now,
    );
    out.push({
      id: p.id, owner: p.user?.email ?? "—", source: p.institutionName, provider: "PLAID",
      status: p.status,
      healthState: deriveConnectionHealthState(p.status, p.errorCode, p.lastSyncedAt, PLAID_STALE_MS_EXPORT, nowMs),
      acquisition: {
        lastAcquiredAt: p.lastSyncedAt?.toISOString() ?? null,
        transactionCount: tx.count,
        latestTransactionDate: tx.max ? tx.max.toISOString() : null,
        syncStatus: state === "importing" ? "IMPORTING" : state === "ready" ? "READY" : "ACTION_REQUIRED",
        errorCode: p.errorCode ?? null,
      },
      intelligence: {
        lastBuiltAt: intel.lastReconstructedAt,
        status: intel.intelligence,
        accountsCovered: faIds.length,
        availableHistory: formatAvailableHistory(intel.availableHistory),
      },
      freshness: { latestSnapshotDate: latestSnapshot(faIds)?.toISOString() ?? null },
    });
  }

  for (const w of wallets) {
    const faIds = faByConn.get(w.id) ?? [];
    const tx = txForConn(faIds);
    const state = deriveWalletConnectionState({ status: w.status, lastSyncedAt: w.lastSyncedAt, errorCode: w.errorCode }) ?? "error";
    const intel = deriveConnectionIntelligence(
      { provider: "WALLET", state, historySyncedAt: anchorByConn.get(w.id) ?? (state === "ready" ? w.lastSyncedAt : null), earliestTxDate: tx.min, connectedAt: w.createdAt, lastSyncedAt: w.lastSyncedAt },
      now,
    );
    out.push({
      id: w.id, owner: w.user?.email ?? "—", source: walletLabel(w.externalConnectionId), provider: "WALLET",
      status: w.status,
      healthState: deriveConnectionHealthState(w.status, w.errorCode, w.lastSyncedAt, WALLET_STALE_MS_EXPORT, nowMs),
      acquisition: {
        lastAcquiredAt: w.lastSyncedAt?.toISOString() ?? null,
        transactionCount: tx.count,
        latestTransactionDate: tx.max ? tx.max.toISOString() : null,
        syncStatus: state === "importing" ? "IMPORTING" : state === "ready" ? "READY" : "ACTION_REQUIRED",
        errorCode: w.errorCode ?? null,
      },
      intelligence: {
        lastBuiltAt: intel.lastReconstructedAt,
        status: intel.intelligence,
        accountsCovered: faIds.length,
        availableHistory: formatAvailableHistory(intel.availableHistory),
      },
      freshness: { latestSnapshotDate: latestSnapshot(faIds)?.toISOString() ?? null },
    });
  }

  // Worst health first so an operator sees problem connections at the top.
  const severity: Record<HealthState, number> = { ERROR: 5, REVOKED: 4, NEEDS_REAUTH: 3, DEGRADED: 2, STALE: 1, HEALTHY: 0 };
  out.sort((a, b) => severity[b.healthState] - severity[a.healthState]);
  return out;
}
