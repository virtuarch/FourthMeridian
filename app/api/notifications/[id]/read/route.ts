/**
 * POST /api/notifications/[id]/read  (OPS-3 S2)
 *
 * Mark ONE of the caller's notifications read. The mutation is scoped
 * `userId = caller` inside the WHERE (lib/notifications/read.ts), so a
 * foreign or unknown id updates zero rows — no existence probe, no 404
 * oracle; the response just reports how many rows transitioned.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { markNotificationRead } from "@/lib/notifications/read";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id } = await params;
  const updated = await markNotificationRead(user.id, id);
  return NextResponse.json({ updated });
}
