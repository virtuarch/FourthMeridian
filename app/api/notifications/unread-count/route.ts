/**
 * GET /api/notifications/unread-count  (OPS-3 S2)
 *
 * Lightweight unread-badge read: count of the caller's unread, non-archived,
 * non-expired notifications. Polled by the bell (fetch-on-navigation + slow
 * interval — frozen S2: no server push). One indexed count over
 * `Notification` only ([userId, readAt]).
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { unreadNotificationCount } from "@/lib/notifications/read";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const count = await unreadNotificationCount(user.id);
  return NextResponse.json({ count });
}
