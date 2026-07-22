/**
 * lib/connections/health-transitions.ts
 *
 * CH-2 — durable connection status-transition history.
 *
 * `PlaidItem.status`/`errorCode` and `Connection.status`/`errorCode` are
 * live-only columns: every write overwrites the previous value, so a
 * healthy→broken or broken→healthy flip leaves no durable trace. This module is
 * the single chokepoint that both (a) writes those live columns — unchanged
 * behavior — and (b) appends an append-only `AuditLog` transition row, but
 * ONLY when the effective health state actually changed (a no-op write that
 * re-affirms the same state must NOT produce a duplicate row).
 *
 * The audit write is best-effort / non-throwing: a history-write failure must
 * never fail a sync (the same posture `touchWalletConnectionStatus` already
 * has). Direction lives in `{ from, to }` metadata rather than one action per
 * direction, mirroring the `LOGIN_FAILED` + `reason` grammar.
 *
 * Two AuditActions:
 *   • PLAID_ITEM_STATUS_CHANGED       — `PlaidItem` (authoritative for Plaid).
 *   • WALLET_CONNECTION_STATUS_CHANGED — non-PLAID `Connection` rows (WALLET).
 *
 * The compared "state" differs by provider (this is exactly why the two live in
 * one place): for Plaid it is the raw `(status, errorCode)` tuple; for wallets
 * it is the DERIVED health — `errorCode present` vs absent — because a transient
 * wallet failure sets `errorCode` WITHOUT flipping `status` to ERROR (that enum
 * means "unrecoverable"; an explorer hiccup is recoverable). See
 * lib/accounts/wallet-connection.ts.
 *
 * Metadata shape is kept precise enough for the later Platform Ops widget
 * (Wave 2⑦) to render "NEEDS_REAUTH since Jul 11, 06:04 (2.3 days)" by reading
 * the latest transition row per broken connection — no schema change:
 *   { provider, plaidItemId | connectionId, from, to, errorCode }
 */

import { db } from "@/lib/db";
import { PlaidItemStatus, ConnectionStatus, type Prisma } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";

// Derived wallet-health tokens used for a Connection's `{ from, to }` (wallets
// don't flip `status`, so the transition is expressed over derived health).
const WALLET_HEALTHY = "HEALTHY";
const WALLET_DEGRADED = "DEGRADED";

/**
 * Write a PlaidItem's live health columns and, only when the effective
 * `(status, errorCode)` actually changed, append a PLAID_ITEM_STATUS_CHANGED
 * transition row. `errorCode` may be omitted to leave that column untouched
 * (e.g. the REVOKE path, which shouldn't clear a prior error). `extra` carries
 * any co-written columns the call site was already updating in the same write
 * (cursor / lastSyncedAt / syncIncompleteAt), so this stays a single UPDATE.
 *
 * Live-column write behaves exactly as the inline `db.plaidItem.update` it
 * replaces; only the audit append is added. Non-throwing on the audit side.
 */
export async function setPlaidItemHealth(
  itemId: string,
  health: { status: PlaidItemStatus; errorCode?: string | null },
  extra?: Prisma.PlaidItemUpdateInput,
  /**
   * PRE-V26-PLAID-CLOSE — optional injected Prisma client (defaults to the real
   * `db`). Additive; all 13 existing callers are unchanged. Needed because this
   * function performs the FINAL cursor/lastSyncedAt write of a transaction sync,
   * so it must be able to ride the same injected client as the sync loop rather
   * than reaching past the seam to the real database.
   */
  client: Pick<typeof db, "plaidItem" | "auditLog"> = db,
): Promise<void> {
  const prior = await client.plaidItem.findUnique({
    where:  { id: itemId },
    select: { userId: true, status: true, errorCode: true },
  });
  if (!prior) return; // item vanished — nothing to update or record.

  const data: Prisma.PlaidItemUpdateInput = { ...(extra ?? {}), status: health.status };
  if (health.errorCode !== undefined) data.errorCode = health.errorCode;
  await client.plaidItem.update({ where: { id: itemId }, data });

  const resultingErrorCode =
    health.errorCode !== undefined ? health.errorCode : (prior.errorCode ?? null);
  const errorCodeChanged =
    health.errorCode !== undefined && (prior.errorCode ?? null) !== (health.errorCode ?? null);
  const changed = prior.status !== health.status || errorCodeChanged;
  if (!changed) return;

  try {
    await client.auditLog.create({
      data: {
        userId:   prior.userId,
        action:   AuditAction.PLAID_ITEM_STATUS_CHANGED,
        metadata: {
          provider:    "PLAID",
          plaidItemId: itemId,
          from:        prior.status,
          to:          health.status,
          errorCode:   resultingErrorCode,
        },
      },
    });
  } catch (e) {
    console.warn(`[health-transitions] PlaidItem transition audit failed for ${itemId} (non-fatal):`, e);
  }
}

/**
 * Write a wallet `Connection`'s live health columns and, only when the DERIVED
 * health (errorCode present vs absent) actually changed, append a
 * WALLET_CONNECTION_STATUS_CHANGED transition row.
 *
 * Reproduces the two existing wallet write bodies exactly:
 *   • ok:true                       → status ACTIVE, errorCode null, lastSyncedAt now
 *     (the `touchWalletConnectionStatus` success body)
 *   • ok:false                      → errorCode only (status untouched — recoverable)
 *     (the `touchWalletConnectionStatus` failure body)
 *   • ok:true,  markSynced:false    → status ACTIVE, errorCode null, NO lastSyncedAt
 *     (the `clearWalletConnectionError` body — clears a stale error mid-discovery
 *      without marking the wallet "ready")
 * `markSynced` defaults to `ok`. Fully best-effort / non-throwing.
 */
export async function setWalletConnectionHealth(
  connectionId: string,
  next: { ok: boolean; errorCode?: string | null; markSynced?: boolean },
): Promise<void> {
  const markSynced = next.markSynced ?? next.ok;
  try {
    const prior = await db.connection.findUnique({
      where:  { id: connectionId },
      select: { userId: true, provider: true, errorCode: true },
    });

    await db.connection.update({
      where: { id: connectionId },
      data: next.ok
        ? { status: ConnectionStatus.ACTIVE, errorCode: null, ...(markSynced ? { lastSyncedAt: new Date() } : {}) }
        : { errorCode: next.errorCode ?? "SYNC_FAILED" },
    });

    if (!prior) return; // connection vanished — write already attempted above.

    const priorHealthy = prior.errorCode == null;
    const nextHealthy  = next.ok;
    if (priorHealthy === nextHealthy) return; // derived state unchanged — no row.

    await db.auditLog.create({
      data: {
        userId:   prior.userId,
        action:   AuditAction.WALLET_CONNECTION_STATUS_CHANGED,
        metadata: {
          provider:     prior.provider,
          connectionId,
          from:         priorHealthy ? WALLET_HEALTHY : WALLET_DEGRADED,
          to:           nextHealthy ? WALLET_HEALTHY : WALLET_DEGRADED,
          errorCode:    nextHealthy ? null : (next.errorCode ?? "SYNC_FAILED"),
        },
      },
    });
  } catch (e) {
    console.warn(`[health-transitions] wallet Connection transition failed for ${connectionId} (non-fatal):`, e);
  }
}
