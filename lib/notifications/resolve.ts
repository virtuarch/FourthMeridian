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
    updateMany(args: {
      where: { userId: string; dedupeKey: string; archivedAt: null };
      data: { dedupeKey: null; archivedAt: Date };
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
    return res.count;
  } catch (err) {
    console.warn("[retireOpenNotification] retirement failed (non-fatal):", err);
    return 0;
  }
}
