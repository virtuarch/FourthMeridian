/**
 * POST /api/notifications/read-all  (OPS-3 S2)
 *
 * Mark ALL of the caller's active (non-archived, non-expired) notifications
 * read — the panel's one bulk action (frozen S2 scope). Scoped to the
 * caller's own rows by construction.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { markAllNotificationsRead } from "@/lib/notifications/read";

export async function POST() {
  const [user, err] = await requireUser();
  if (err) return err;

  const updated = await markAllNotificationsRead(user.id);
  return NextResponse.json({ updated });
}
