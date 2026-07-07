/**
 * lib/notifications/read.ts  (OPS-3 S2)
 *
 * The Notification Center's isolated query layer — every read/read-state
 * mutation the S2 surface performs, in one module. Reads `Notification` ONLY:
 * never AuditLog, never a derivation (frozen doctrine — notifications are
 * created at the moment of the fact by lib/notifications/create.ts; this
 * module only lists what exists).
 *
 * VISIBILITY PREDICATE (frozen §2 lifecycle): every user-facing query
 * excludes archived rows (archivedAt set) and expired rows (expiresAt in the
 * past). Expired = hidden everywhere immediately; reaping is the S6 cleanup
 * job's business, not a read-path concern.
 *
 * READ SEMANTICS (frozen S2): opening the panel does NOT mark anything read —
 * per-item mark-read and explicit mark-all-read only, so CRITICAL items stay
 * un-missable. All mutations are scoped `userId = caller` in the WHERE, never
 * by row id alone.
 *
 * CLIENT TYPING: same seam as lib/notifications/create.ts — a narrow
 * interface over the three Prisma operations this module uses, with the
 * shared client cast once and an injection point for the house no-live-DB
 * unit tests. Structurally sound against the generated client.
 */

import { db } from "@/lib/db";
import { getNotificationDefinition } from "@/lib/notifications/registry";

// ── Narrow read-client contract (injection seam for pure tests) ──────────────

/** The row shape the list query selects. */
export interface NotificationRowSelect {
  id: string;
  spaceId: string | null;
  category: string;
  type: string;
  priority: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/** Prisma-shaped where for the active-feed predicate (structural subset). */
export interface ActiveNotificationWhere {
  userId: string;
  archivedAt: null;
  OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
  readAt?: null;
}

export interface NotificationReadClient {
  notification: {
    findMany(args: {
      where: ActiveNotificationWhere;
      orderBy: { createdAt: "desc" };
      take: number;
      select: {
        id: true;
        spaceId: true;
        category: true;
        type: true;
        priority: true;
        title: true;
        body: true;
        href: true;
        readAt: true;
        createdAt: true;
      };
    }): Promise<NotificationRowSelect[]>;
    count(args: { where: ActiveNotificationWhere }): Promise<number>;
    updateMany(args: {
      where: ActiveNotificationWhere & { id?: string };
      data: { readAt: Date };
    }): Promise<{ count: number }>;
  };
}

function client(ctx?: { client?: NotificationReadClient }): NotificationReadClient {
  return ctx?.client ?? (db as unknown as NotificationReadClient);
}

/** The one visibility predicate (non-archived, non-expired), single-sited. */
function activeWhere(userId: string, now: Date): ActiveNotificationWhere {
  return {
    userId,
    archivedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

// ── DTO ───────────────────────────────────────────────────────────────────────

/** Serialisable list item for the panel (no Date instances — house DTO rule). */
export interface NotificationListItem {
  id: string;
  spaceId: string | null;
  category: string;
  type: string;
  priority: string;
  title: string;
  body: string | null;
  href: string | null;
  /** Registry icon key for the type; "bell" when the type has left the registry. */
  icon: string;
  read: boolean;
  createdAt: string; // ISO
}

/** Fixed cap, the security-history precedent — no pagination in S2. */
export const NOTIFICATION_LIST_LIMIT = 50;

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Newest-first active notifications for the caller. */
export async function listNotifications(
  userId: string,
  ctx?: { client?: NotificationReadClient; now?: Date },
): Promise<NotificationListItem[]> {
  const rows = await client(ctx).notification.findMany({
    where: activeWhere(userId, ctx?.now ?? new Date()),
    orderBy: { createdAt: "desc" },
    take: NOTIFICATION_LIST_LIMIT,
    select: {
      id: true,
      spaceId: true,
      category: true,
      type: true,
      priority: true,
      title: true,
      body: true,
      href: true,
      readAt: true,
      createdAt: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    spaceId: r.spaceId,
    category: r.category,
    type: r.type,
    priority: r.priority,
    title: r.title,
    body: r.body,
    href: r.href,
    icon: getNotificationDefinition(r.type)?.icon ?? "bell",
    read: r.readAt !== null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Unread badge count: unread ∧ non-archived ∧ non-expired. */
export async function unreadNotificationCount(
  userId: string,
  ctx?: { client?: NotificationReadClient; now?: Date },
): Promise<number> {
  return client(ctx).notification.count({
    where: { ...activeWhere(userId, ctx?.now ?? new Date()), readAt: null },
  });
}

// ── Read-state mutations ──────────────────────────────────────────────────────

/**
 * Mark ONE notification read. updateMany with the caller's userId in the
 * WHERE (never id alone) — a cross-user id probe updates zero rows.
 * Returns the number of rows transitioned (0 when already read/foreign).
 */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
  ctx?: { client?: NotificationReadClient; now?: Date },
): Promise<number> {
  const now = ctx?.now ?? new Date();
  const res = await client(ctx).notification.updateMany({
    where: { ...activeWhere(userId, now), id: notificationId, readAt: null },
    data: { readAt: now },
  });
  return res.count;
}

/** Mark ALL of the caller's active notifications read. Returns rows transitioned. */
export async function markAllNotificationsRead(
  userId: string,
  ctx?: { client?: NotificationReadClient; now?: Date },
): Promise<number> {
  const now = ctx?.now ?? new Date();
  const res = await client(ctx).notification.updateMany({
    where: { ...activeWhere(userId, now), readAt: null },
    data: { readAt: now },
  });
  return res.count;
}
