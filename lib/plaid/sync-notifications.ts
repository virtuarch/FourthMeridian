/**
 * lib/plaid/sync-notifications.ts  (OPS-3 S5 Wave 3)
 *
 * The SYNC_FAILED producer pair — domain-owned helpers the Plaid health
 * seams call in one line each:
 *
 *   notifyItemSyncFailed(itemId)   — after a health-CLASSIFIED failure (the
 *     classifyPlaidErrorForHealth → PlaidItem status update idiom). Transient
 *     errors (classify → null) never notify, exactly as they never change
 *     item status. The payload's typed `connectionState` is read back from the
 *     PlaidItem.status the call site just wrote
 *     (lib/notifications/connection-attention.ts) — no call site passes it. Five call sites: the sync-banks cron, the interactive
 *     refresh/sync routes, refreshAllActiveItemsForUser, and the deferred
 *     background history sync. Dedupe (suppress-while-open, key
 *     "SYNC_FAILED:item:{id}:open") makes multi-site production idempotent —
 *     however many paths observe the same broken item, ONE notification is
 *     live.
 *
 *   retireItemSyncFailure(itemId)  — after the item PROVABLY works again
 *     (the status→ACTIVE writes: a completed transaction sync, a completed
 *     refresh, a Link relink/re-exchange). Releases the :open key and
 *     archives the stale "needs attention" row, so a FUTURE outage notifies
 *     again (frozen F3 retirement).
 *
 * Both are best-effort and non-throwing: sync/import/reconnect flows must
 * never fail over notification bookkeeping. Everything flows through the
 * chokepoint / resolve primitives — no direct Notification writes here.
 */

import { db } from "@/lib/db";
import { createNotification } from "@/lib/notifications/create";
import { refreshOpenNotification, retireOpenNotification } from "@/lib/notifications/resolve";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { connectionStateFromItemStatus } from "@/lib/notifications/connection-attention";

interface ItemOwnerRow {
  userId: string;
  institutionName: string | null;
  /** Read back by notifyItemSyncFailed only (the status the call site just wrote). */
  status?: string | null;
}

/** Minimal read this module needs (injection seam for tests). */
export interface PlaidItemReadClient {
  plaidItem: {
    findUnique(args: {
      where: { id: string };
      select: { userId: true; institutionName: true; status?: true };
    }): Promise<ItemOwnerRow | null>;
  };
  /**
   * Read on every failure notification, to tell a removal ON OUR SIDE from a
   * provider revocation / ordinary failure (removedByUser below). Optional so narrow test fakes stay valid;
   * a client without it never suppresses (the conservative path: notify).
   */
  accountConnection?: {
    count(args: { where: { plaidItemDbId: string; deletedAt: null | { not: null } } }): Promise<number>;
  };
}

/**
 * OWNER DECISION 2026-10-31 — a connection the user removed sends no
 * sync-failure notification of ANY kind (email or in-app, any state): not
 * "{Institution} is disconnected", and not "We couldn't sync {Institution}"
 * either. disconnectPlaidItemIfOrphaned soft-deletes the connections, then calls
 * itemRemove, then writes REVOKED — a sync failing inside that window writes
 * ERROR / NEEDS_REAUTH, so the check runs for every status.
 *
 * REVOKED has two live writers:
 *   - lib/plaid/disconnect.ts disconnectPlaidItemIfOrphaned — the removal on OUR
 *     side. It runs only once every AccountConnection on the item is
 *     soft-deleted (deletedAt set): the user's account removal
 *     (lib/accounts/disconnect.ts), plus the cleanup/self-heal/supersede paths
 *     that act on an already-orphaned item;
 *   - the Plaid webhook USER_PERMISSION_REVOKED / USER_ACCOUNT_REVOKED
 *     (lib/plaid/webhook-receiver.ts) — a PROVIDER-side revocation. It leaves the
 *     item's connections live, so it still notifies with the "disconnected" copy.
 *
 * The existing marker, so no migration: REVOKED with zero live connections and
 * at least one soft-deleted one. An item with no connection rows at all is NOT
 * treated as removed (no evidence), so it still notifies.
 */
export async function removedByUser(client: PlaidItemReadClient, plaidItemId: string): Promise<boolean> {
  if (!client.accountConnection) return false;
  try {
    const [live, removed] = await Promise.all([
      client.accountConnection.count({ where: { plaidItemDbId: plaidItemId, deletedAt: null } }),
      client.accountConnection.count({ where: { plaidItemDbId: plaidItemId, deletedAt: { not: null } } }),
    ]);
    return live === 0 && removed > 0;
  } catch (err) {
    // FAIL OPEN: an unreadable marker is no evidence of a removal, so the
    // notification still goes out (the conservative path).
    // Only the error CLASS is logged: a DB error message can echo query values.
    console.warn(`[notifyItemSyncFailed] removal check failed for item ${plaidItemId}; notifying (${err instanceof Error ? err.name : typeof err})`);
    return false;
  }
}

function itemClient(ctx?: { itemClient?: PlaidItemReadClient }): PlaidItemReadClient {
  return ctx?.itemClient ?? (db as unknown as PlaidItemReadClient);
}

/**
 * SYNC_COMPLETED bell notification, linked to the SAME AuditLog record the
 * Recent-Activity feed reads (auditLogId) so the two surfaces can never drift.
 * The AuditLog row is written by the pipeline (lib/plaid/backgroundHistorySync)
 * — this stays a thin chokepoint-only producer (the OPS-3 invariant that
 * notification helpers touch no audit/email/Notification writes directly).
 * suppress-while-open dedupe keeps repeated pipeline runs to one live notice.
 * Best-effort / non-throwing.
 */
export async function notifyItemSyncComplete(
  args: {
    userId:          string;
    plaidItemId:     string;
    institutionName: string | null;
    spaceId?:        string | null;
    auditLogId?:     string | null;
  },
  ctx?: { createFn?: typeof createNotification },
): Promise<void> {
  try {
    await (ctx?.createFn ?? createNotification)({
      type:   "SYNC_COMPLETED",
      userId: args.userId,
      ...(args.spaceId ? { spaceId: args.spaceId } : {}),
      ...(args.auditLogId ? { auditLogId: args.auditLogId } : {}),
      data:   { plaidItemId: args.plaidItemId, institutionName: args.institutionName ?? "" },
    });
  } catch (err) {
    console.warn(`[notifyItemSyncComplete] non-fatal failure for item ${args.plaidItemId}:`, redactedErrorForLog(err));
  }
}

/** Ping the item's owner that the connection needs attention. Best-effort. */
export async function notifyItemSyncFailed(
  plaidItemId: string,
  ctx?: {
    itemClient?: PlaidItemReadClient;
    createFn?: typeof createNotification;
    refreshFn?: typeof refreshOpenNotification;
  },
): Promise<void> {
  try {
    const item = await itemClient(ctx).plaidItem.findUnique({
      where: { id: plaidItemId },
      select: { userId: true, institutionName: true, status: true },
    });
    if (!item) return;

    const connectionState = connectionStateFromItemStatus(item.status);
    // Any state: lib/plaid/disconnect.ts soft-deletes the connections BEFORE
    // itemRemove and the REVOKED write, so a sync failing in that window reads
    // back ERROR / NEEDS_REAUTH — still a bank the user removed.
    if (await removedByUser(itemClient(ctx), plaidItemId)) {
      // Suppression record — the item id and state only (no PII). Dedupe/retire
      // unaffected: nothing is created, so there is no :open key to hold or release.
      console.log(`[notifyItemSyncFailed] suppressed for item ${plaidItemId} (${item.status ?? "unknown"}): removed by the user (every connection removed)`);
      return;
    }

    const data = {
      plaidItemId,
      institutionName: item.institutionName ?? "",
      // Derived from the status every call site writes BEFORE calling this
      // (setPlaidItemHealth). Only changes the copy — not when this fires,
      // the dedupe key, channels or preferences.
      connectionState,
    };
    const res = await (ctx?.createFn ?? createNotification)({ type: "SYNC_FAILED", userId: item.userId, data });

    // ESCALATION (review fix 2026-10-31). The shared open key collapses every
    // observation of one outage into ONE notice — so when the item escalates to
    // REVOKED (the Plaid webhook's USER_PERMISSION_REVOKED) while a "sign in
    // again" / "couldn't sync" notice is still open, the create above is
    // suppressed and the bell would keep the weaker, now-wrong copy. The open
    // notice is re-rendered in place to "disconnected". DECISION: no second
    // email. The email leg ships only when a row is CREATED (create.ts); an
    // escalation email would need a new delivery path, and the user already
    // has one email for this outage pointing at the same Connections page,
    // where the reconnect action is the same. Only ever upward: a REVOKED item
    // never leaves REVOKED (health-transitions.ts), so nothing downgrades it.
    // The removal rule above already returned for a connection the user removed.
    if (res?.status === "suppressed" && connectionState === "disconnected") {
      await (ctx?.refreshFn ?? refreshOpenNotification)(item.userId, "SYNC_FAILED", data);
    }
  } catch (err) {
    console.warn(`[notifyItemSyncFailed] non-fatal failure for item ${plaidItemId}:`, redactedErrorForLog(err));
  }
}

/** Retire the open SYNC_FAILED condition after the item works again. Best-effort. */
export async function retireItemSyncFailure(
  plaidItemId: string,
  ctx?: {
    itemClient?: PlaidItemReadClient;
    retireFn?: typeof retireOpenNotification;
  },
): Promise<void> {
  try {
    const item = await itemClient(ctx).plaidItem.findUnique({
      where: { id: plaidItemId },
      select: { userId: true, institutionName: true },
    });
    if (!item) return;

    await (ctx?.retireFn ?? retireOpenNotification)(item.userId, "SYNC_FAILED", {
      plaidItemId,
    });
  } catch (err) {
    console.warn(`[retireItemSyncFailure] non-fatal failure for item ${plaidItemId}:`, redactedErrorForLog(err));
  }
}
