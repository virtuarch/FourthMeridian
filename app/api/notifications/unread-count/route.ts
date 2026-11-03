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
import { runWithoutSessionTouch } from "@/lib/auth/presence-scope";
import { unreadNotificationCount } from "@/lib/notifications/read";

export async function GET() {
  // PB-10 F3 — a BACKGROUND poll (the bell's interval), not session use: the
  // normal guard runs in full, only the lastActiveAt touch is skipped, so an
  // idle open tab no longer extends the SEC-010 idle deadline. Server-decided
  // allowlist (lib/auth/presence-scope.ts), never a client opt-out.
  const [user, err] = await runWithoutSessionTouch(() => requireUser());
  if (err) return err;

  const count = await unreadNotificationCount(user.id);
  return NextResponse.json({ count });
}
