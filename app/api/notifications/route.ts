/**
 * GET /api/notifications  (OPS-3 S2)
 *
 * The Notification Center's list read: the caller's OWN active notifications
 * (non-archived, non-expired), newest first, fixed cap of 50 (the
 * security-history precedent — no pagination in S2), plus the unread count so
 * opening the panel refreshes the badge in the same round trip.
 *
 * Reads `Notification` only, through lib/notifications/read.ts — never
 * AuditLog, never a derivation (frozen doctrine). Safe fields only: the
 * NotificationListItem DTO (title/body/href/icon/priority/read/createdAt);
 * raw metadata is never returned to the panel.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import {
  listNotifications,
  unreadNotificationCount,
} from "@/lib/notifications/read";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const [notifications, unreadCount] = await Promise.all([
    listNotifications(user.id),
    unreadNotificationCount(user.id),
  ]);

  return NextResponse.json({ notifications, unreadCount });
}
