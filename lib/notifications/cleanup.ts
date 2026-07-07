/**
 * lib/notifications/cleanup.ts  (OPS-3 S6)
 *
 * The notification retention job — the frozen §2 lifecycle's aging leg:
 *
 *   1. AUTO-ARCHIVE — READ rows older than their type's autoArchiveDays
 *      (readAt < cutoff, not yet archived). UNREAD rows are never auto-
 *      archived: CRITICAL items stay un-missable until the user acts (F9).
 *   2. DELETE — rows ARCHIVED longer than their type's deleteDays.
 *      NotificationDelivery rows ride the FK cascade — no separate sweep.
 *   3. REAP — rows whose expiresAt has passed, regardless of read state.
 *      They are already invisible everywhere (the S2 visibility predicate);
 *      this reclaims the storage and any dedupe keys they hold.
 *
 * Retention is PER-TYPE from the registry (F1) — types are grouped by their
 * retention pair so uniform policies cost one statement per phase, not one
 * per type. Rows whose type has LEFT the registry age out under
 * DEFAULT_RETENTION so cleanup is total (nothing orphans forever).
 *
 * IDEMPOTENT by construction: every operation is a WHERE-guarded
 * updateMany/deleteMany against absolute cutoffs; a second run in the same
 * instant matches zero rows.
 *
 * SCHEDULING (frozen F7 — verified at S6 entry): NO dispatcher exists (PF1
 * not landed) and the cron budget is spoken for, so this function consumes
 * NO cron slot — it is invoked at the tail of the existing daily
 * process-deletions cron handler (bounded best-effort, the house idiom).
 * When the PF1 dispatcher lands, this function registers there unchanged.
 * Deliberately NOT here: digests (dispatcher-gated), retries (OPS-4),
 * schedulers, queues.
 */

import { db } from "@/lib/db";
import {
  DEFAULT_RETENTION,
  NOTIFICATION_REGISTRY,
  NOTIFICATION_TYPE_IDS,
} from "@/lib/notifications/registry";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Exactly the two operations cleanup performs (injection seam for tests). */
export interface NotificationCleanupClient {
  notification: {
    updateMany(args: {
      where: {
        type: { in: string[] } | { notIn: string[] };
        archivedAt: null;
        readAt: { lt: Date };
      };
      data: { archivedAt: Date };
    }): Promise<{ count: number }>;
    deleteMany(args: {
      where:
        | { type: { in: string[] } | { notIn: string[] }; archivedAt: { lt: Date } }
        | { expiresAt: { lte: Date } };
    }): Promise<{ count: number }>;
  };
}

export interface NotificationCleanupResult {
  /** Read rows auto-archived this run. */
  archived: number;
  /** Archived rows deleted past retention this run. */
  deleted: number;
  /** Expired rows reaped this run. */
  reaped: number;
}

interface RetentionGroup {
  autoArchiveDays: number;
  deleteDays: number;
  types: string[];
}

/** Registry types grouped by retention pair (uniform policy = one statement). */
function retentionGroups(): RetentionGroup[] {
  const groups = new Map<string, RetentionGroup>();
  for (const id of NOTIFICATION_TYPE_IDS) {
    const { autoArchiveDays, deleteDays } = NOTIFICATION_REGISTRY[id].retention;
    const key = `${autoArchiveDays}:${deleteDays}`;
    const g = groups.get(key) ?? { autoArchiveDays, deleteDays, types: [] };
    g.types.push(id);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Run one retention pass. Best-effort per phase: a failure in one phase is
 * recorded and the remaining phases still run (a cron tail must never abort
 * its host job — the caller additionally try/catches the whole call).
 */
export async function cleanupNotifications(
  ctx?: { client?: NotificationCleanupClient; now?: Date },
): Promise<NotificationCleanupResult> {
  const client = ctx?.client ?? (db as unknown as NotificationCleanupClient);
  const now = ctx?.now ?? new Date();
  const result: NotificationCleanupResult = { archived: 0, deleted: 0, reaped: 0 };

  // Phases 1+2 per retention group, plus the deregistered-type fallback.
  const groups: (RetentionGroup & { filter: { in: string[] } | { notIn: string[] } })[] = [
    ...retentionGroups().map((g) => ({ ...g, filter: { in: g.types } })),
    // Types no longer in the registry age out under the defaults.
    { ...DEFAULT_RETENTION, types: [], filter: { notIn: [...NOTIFICATION_TYPE_IDS] } },
  ];

  for (const g of groups) {
    try {
      const archived = await client.notification.updateMany({
        where: {
          type: g.filter,
          archivedAt: null,
          readAt: { lt: new Date(now.getTime() - g.autoArchiveDays * DAY_MS) },
        },
        data: { archivedAt: now },
      });
      result.archived += archived.count;
    } catch (err) {
      console.warn("[cleanupNotifications] archive phase failed (non-fatal):", err);
    }
    try {
      const deleted = await client.notification.deleteMany({
        where: {
          type: g.filter,
          archivedAt: { lt: new Date(now.getTime() - g.deleteDays * DAY_MS) },
        },
      });
      result.deleted += deleted.count;
    } catch (err) {
      console.warn("[cleanupNotifications] delete phase failed (non-fatal):", err);
    }
  }

  // Phase 3 — reap expired rows (already invisible; reclaim storage + keys).
  try {
    const reaped = await client.notification.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    result.reaped = reaped.count;
  } catch (err) {
    console.warn("[cleanupNotifications] reap phase failed (non-fatal):", err);
  }

  return result;
}
