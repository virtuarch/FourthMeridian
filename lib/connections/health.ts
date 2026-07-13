/**
 * lib/connections/health.ts  (Wave 2 S7 / CH-1)
 *
 * The query module behind the Platform Ops `ops_connection_health` widget.
 * NORMALIZES both provider-connection tables into one row shape so the widget
 * never knows there are two, and derives a single `healthState` server-side.
 *
 * DEDUPE THE PLAID DUAL-WRITE: every Plaid bank exists in BOTH `PlaidItem` and a
 * mirror `Connection(provider=PLAID)` row (exchangeToken.ts). A blind union
 * would double-count every bank. So Plaid comes ONLY from `PlaidItem` (its
 * authoritative, richer state), and `Connection` contributes ONLY non-Plaid
 * providers.
 *
 * NON-PLAID SCOPE: we take WALLET / EXCHANGE / BROKERAGE from `Connection` —
 * i.e. real external, syncing providers. MANUAL and CSV are deliberately
 * EXCLUDED: they have no external provider, never sync, and carry no
 * lastSyncedAt, so surfacing them would emit permanent false-STALE noise —
 * against the honest-signal principle. (The plan says "provider != PLAID"; its
 * own intent names only the syncing providers, which is what this filters to.)
 *
 * DERIVED HEALTH: wallet failures set `errorCode` WITHOUT flipping `status`
 * (a transient explorer error is recoverable), so raw status alone is not the
 * signal. Precedence: REVOKED/ERROR/NEEDS_REAUTH (from status) → DEGRADED
 * (errorCode present) → STALE (lastSyncedAt beyond a provider window) → HEALTHY.
 *
 * "BROKEN SINCE": joined from the durable transition log (CH-2 audit actions
 * PLAID_ITEM_STATUS_CHANGED / WALLET_CONNECTION_STATUS_CHANGED) — the most
 * recent transition per connection, used only when it landed in a broken state.
 * Nullable: degrades gracefully if no transition row exists.
 *
 * NO PII: rows carry institution/provider/status/errorCode/timestamps only — no
 * userId, no email — matching PO1's aggregate-only posture.
 */

import { db } from "@/lib/db";
import { ProviderType } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";

export type HealthState = "HEALTHY" | "STALE" | "DEGRADED" | "NEEDS_REAUTH" | "ERROR" | "REVOKED";

export interface ConnectionHealthRow {
  source:       string;         // "PLAID" | "WALLET" | "EXCHANGE" | "BROKERAGE"
  id:           string;
  label:        string;         // institution name (Plaid) / derived wallet label
  status:       string;         // raw provider status
  errorCode:    string | null;
  healthState:  HealthState;
  lastSyncedAt: string | null;  // ISO
  since:        string | null;  // ISO — when it entered its current broken state
}

export interface ConnectionHealthResult {
  total:     number;
  counts:    Record<HealthState, number>;
  unhealthy: ConnectionHealthRow[]; // worst-first, capped
}

const HOUR_MS = 60 * 60 * 1000;
// Plaid: >48h is stale given the daily-to-6-hourly sync cron.
const PLAID_STALE_MS = 48 * HOUR_MS;
// Wallet: 2× the 6-hourly crypto cadence Wave 1④ shipped = 12h.
const WALLET_STALE_MS = 12 * HOUR_MS;
const DEFAULT_CAP = 20;

/** Worst-first ordering: higher = more severe. HEALTHY never appears in the list. */
const SEVERITY: Record<HealthState, number> = {
  ERROR: 5, REVOKED: 4, NEEDS_REAUTH: 3, DEGRADED: 2, STALE: 1, HEALTHY: 0,
};

/**
 * Pure health derivation (exported for unit testing). Precedence matters:
 * terminal/actionable statuses first, then the wallet DEGRADED case (errorCode
 * set without a status flip — the reason raw status alone is insufficient), then
 * staleness, then HEALTHY.
 */
export function deriveConnectionHealthState(
  status: string,
  errorCode: string | null,
  lastSyncedAt: Date | null,
  staleMs: number,
  now: number = Date.now(),
): HealthState {
  if (status === "REVOKED")      return "REVOKED";
  if (status === "ERROR")        return "ERROR";
  if (status === "NEEDS_REAUTH") return "NEEDS_REAUTH";
  if (errorCode != null)         return "DEGRADED";
  if (lastSyncedAt == null || now - lastSyncedAt.getTime() > staleMs) return "STALE";
  return "HEALTHY";
}

/** Staleness windows (exported so tests and callers share the same constants). */
export const PLAID_STALE_MS_EXPORT = PLAID_STALE_MS;
export const WALLET_STALE_MS_EXPORT = WALLET_STALE_MS;

/** Derive a non-PII wallet/exchange label from its opaque external id. */
function connectionLabel(provider: string, externalConnectionId: string | null): string {
  const base = provider === "WALLET" ? "Wallet" : provider.charAt(0) + provider.slice(1).toLowerCase();
  if (!externalConnectionId) return base;
  const tail = externalConnectionId.slice(-6);
  return `${base} …${tail}`;
}

/**
 * Build the map of connection id → "broken since" ISO from the transition log.
 * For each id we look at its MOST RECENT transition; if that transition landed
 * in a broken state, its timestamp is when the current breakage began. A most-
 * recent transition back to healthy ⇒ not broken ⇒ no `since`.
 */
async function loadBrokenSince(): Promise<Map<string, string>> {
  const rows = await db.auditLog.findMany({
    where:   { action: { in: [AuditAction.PLAID_ITEM_STATUS_CHANGED, AuditAction.WALLET_CONNECTION_STATUS_CHANGED] } },
    orderBy: { createdAt: "desc" },
    take:    1000, // low-frequency events; 1000 covers a long window comfortably
    select:  { action: true, createdAt: true, metadata: true },
  });

  const since = new Map<string, string>();
  const seen  = new Set<string>();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as { plaidItemId?: string; connectionId?: string; to?: string };
    const id = meta.plaidItemId ?? meta.connectionId;
    if (!id || seen.has(id)) continue; // only the most recent transition per id
    seen.add(id);

    const to = meta.to;
    const broken =
      r.action === AuditAction.PLAID_ITEM_STATUS_CHANGED ? to !== "ACTIVE" : to === "DEGRADED";
    if (broken) since.set(id, r.createdAt.toISOString());
  }
  return since;
}

/**
 * Normalized connection-health snapshot across all providers. `cap` bounds the
 * returned non-healthy list (default 20); `counts` and `total` are unbounded.
 */
export async function getConnectionHealth(cap: number = DEFAULT_CAP): Promise<ConnectionHealthResult> {
  const now = Date.now();

  const [plaidItems, connections, brokenSince] = await Promise.all([
    db.plaidItem.findMany({
      select: { id: true, institutionName: true, status: true, errorCode: true, lastSyncedAt: true },
    }),
    db.connection.findMany({
      where:  { provider: { notIn: [ProviderType.PLAID, ProviderType.MANUAL, ProviderType.CSV] } },
      select: { id: true, provider: true, externalConnectionId: true, status: true, errorCode: true, lastSyncedAt: true },
    }),
    loadBrokenSince(),
  ]);

  const rows: ConnectionHealthRow[] = [];

  for (const it of plaidItems) {
    const healthState = deriveConnectionHealthState(it.status, it.errorCode, it.lastSyncedAt, PLAID_STALE_MS, now);
    rows.push({
      source:       "PLAID",
      id:           it.id,
      label:        it.institutionName,
      status:       it.status,
      errorCode:    it.errorCode,
      healthState,
      lastSyncedAt: it.lastSyncedAt?.toISOString() ?? null,
      since:        brokenSince.get(it.id) ?? null,
    });
  }

  for (const c of connections) {
    const healthState = deriveConnectionHealthState(c.status, c.errorCode, c.lastSyncedAt, WALLET_STALE_MS, now);
    rows.push({
      source:       c.provider,
      id:           c.id,
      label:        connectionLabel(c.provider, c.externalConnectionId),
      status:       c.status,
      errorCode:    c.errorCode,
      healthState,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      since:        brokenSince.get(c.id) ?? null,
    });
  }

  const counts: Record<HealthState, number> = {
    HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0,
  };
  for (const r of rows) counts[r.healthState]++;

  const unhealthy = rows
    .filter((r) => r.healthState !== "HEALTHY")
    .sort((a, b) => {
      const sev = SEVERITY[b.healthState] - SEVERITY[a.healthState];
      if (sev !== 0) return sev;
      // Same severity: longest-broken first (oldest `since`), nulls last.
      const ta = a.since ? Date.parse(a.since) : Infinity;
      const tb = b.since ? Date.parse(b.since) : Infinity;
      return ta - tb;
    })
    .slice(0, cap);

  return { total: rows.length, counts, unhealthy };
}
