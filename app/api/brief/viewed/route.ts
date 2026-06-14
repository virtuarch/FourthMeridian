/**
 * POST /api/brief/viewed
 *
 * Sets user.lastBriefViewedAt = now().
 * Called by the client after the brief renders.
 */

import { NextResponse } from "next/server";
import { db }           from "@/lib/db";
import { requireUser }  from "@/lib/session";

export async function POST() {
  const [user, err] = await requireUser();
  if (err) return err;

  await db.user.update({
    where: { id: user.id },
    data:  { lastBriefViewedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
