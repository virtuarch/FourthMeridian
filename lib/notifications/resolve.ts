/**
 * lib/notifications/resolve.ts  (OPS-3 S5 Wave 3)
 *
 * The suppress-key RETIREMENT primitive — the other half of the frozen F3
 * dedupe contract: "keys carry an :open suffix retired when the condition
 * resolves, so a NEW outage notifies again."
 *
 * retireOpenNotification(userId, type, data):
 *   - computes the SAME dedupe key the chokepoint computed (registry template
 *     + fillDedupeTemplate — single-sourced, never hand-built), and
 *   - releases + archives the open holder in one updateMany:
 *       dedupeKey → null   (frees the unique slot: a recurrence re-notifies)
 *       archivedAt → now   (a resolved condition leaves the feed; read state
 *                           is preserved — timestamps compose, F9)
 *   - and (Comms Center A-2b) releases an ARCHIVED holder's key, archive time
 *     kept: the email anchor create.ts writes when in-app is off.
 *
 * Best-effort by contract: returns the number of rows retired (0 = nothing
 * open — the common case) and never throws into a sync/import flow.
 *
 * This module and create.ts are the ONLY writers of Notification rows/state
 * outside the user-facing read APIs (grep-enforced with the chokepoint rule).
 */

import { db } from "@/lib/db";
import { fillDedupeTemplate } from "@/lib/notifications/create";
import {
  getNotificationDefinition,
  type NotificationTypeId,
} from "@/lib/notifications/registry";
import type { NotificationRenderData } from "@/lib/notifications/types";

/** Exactly the one operation retirement performs (injection seam for tests). */
export interface NotificationResolveClient {
  notification: {
    updateMany(args:
      | {
          where: { userId: string; dedupeKey: string; archivedAt: null };
          data: { dedupeKey: null; archivedAt: Date };
        }
      | {
          where: { userId: string; dedupeKey: string; archivedAt: { not: null } };
          data: { dedupeKey: null };
        }): Promise<{ count: number }>;
  };
}

/**
 * Retire the open notification for a dedupe-keyed condition. No-op (0) when
 * the type has no dedupe key, the data can't fill the template, or nothing
 * is open.
 */
export async function retireOpenNotification(
  userId: string,
  type: NotificationTypeId,
  data: NotificationRenderData,
  ctx?: { client?: NotificationResolveClient; now?: Date },
): Promise<number> {
  const def = getNotificationDefinition(type);
  if (!def || def.dedupe === "none" || def.dedupeKeyTemplate === null) return 0;
  // A one-time condition (ACCOUNT_WELCOME) is never retired: its key is never
  // released. Retention (lib/notifications/cleanup.ts) still deletes the row once
  // archived for deleteDays — see the safety note in lib/notifications/welcome.ts.
  if (def.dedupeNeverReleases === true) return 0;

  let dedupeKey: string;
  try {
    dedupeKey = fillDedupeTemplate(def.dedupeKeyTemplate, userId, data);
  } catch {
    return 0; // missing placeholder — nothing addressable to retire
  }

  try {
    const client =
      ctx?.client ?? (db as unknown as NotificationResolveClient);
    const res = await client.notification.updateMany({
      where: { userId, dedupeKey, archivedAt: null },
      data: { dedupeKey: null, archivedAt: ctx?.now ?? new Date() },
    });
    // Comms Center A-2b: an ARCHIVED holder can still hold the key — the email
    // anchor written while the user's in-app channel was off (create.ts), or a
    // bell dismissed before in-app was turned off. Release it too (its archive
    // time is kept), so the NEXT outage notifies again. At most one row holds a
    // key ((userId, dedupeKey) is unique), so the two statements never overlap.
    const archived = await client.notification.updateMany({
      where: { userId, dedupeKey, archivedAt: { not: null } },
      data: { dedupeKey: null },
    });
    return res.count + archived.count;
  } catch (err) {
    console.warn("[retireOpenNotification] retirement failed (non-fatal):", err);
    return 0;
  }
}

/** The one operation an escalation performs (injection seam for tests). */
export interface NotificationRefreshClient {
  notification: {
    updateMany(args: {
      where: { userId: string; dedupeKey: string; archivedAt: null };
      data: { title: string; body: string | null; href: string | null; metadata: NotificationRenderData };
    }): Promise<{ count: number }>;
  };
}

/**
 * ESCALATE the open notice of a dedupe-keyed condition in place (review fix
 * 2026-10-31): re-render it from `data` and overwrite the OPEN (un-archived)
 * holder's title / body / href / metadata. The condition is the same (same
 * key), but what is true about it got worse — SYNC_FAILED "sign in again" →
 * "disconnected" when the Plaid webhook revokes an item whose reauth notice is
 * still open. Nothing is sent: the email leg ships only when a row is CREATED
 * (create.ts), so an escalation updates the bell and never emails twice. The
 * unread state is left as it is. An archived holder (an email anchor, or a
 * notice the user dismissed) is not touched — nothing visible would change.
 *
 * Best-effort: returns the rows updated (0 = nothing open) and never throws.
 */
export async function refreshOpenNotification(
  userId: string,
  type: NotificationTypeId,
  data: NotificationRenderData,
  ctx?: { client?: NotificationRefreshClient },
): Promise<number> {
  const def = getNotificationDefinition(type);
  if (!def || def.dedupe === "none" || def.dedupeKeyTemplate === null) return 0;
  let dedupeKey: string;
  try {
    dedupeKey = fillDedupeTemplate(def.dedupeKeyTemplate, userId, data);
  } catch {
    return 0;
  }
  try {
    const client = ctx?.client ?? (db as unknown as NotificationRefreshClient);
    const r = def.render(data);
    const res = await client.notification.updateMany({
      where: { userId, dedupeKey, archivedAt: null },
      data: { title: r.title, body: r.body ?? null, href: r.href ?? null, metadata: data },
    });
    return res.count;
  } catch (err) {
    console.warn("[refreshOpenNotification] escalation failed (non-fatal):", err);
    return 0;
  }
}
