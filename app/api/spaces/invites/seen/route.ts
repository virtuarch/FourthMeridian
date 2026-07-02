import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

/** POST /api/spaces/invites/seen
 *  Stamps seenAt on every unseen PENDING invite for the current user.
 *  Called automatically when the user opens the Invites tab.
 *  After this the sidebar badge count drops to 0.
 */
export async function POST() {
  const [user, err] = await requireUser();
  if (err) return err;

  await db.spaceInvite.updateMany({
    where: { invitedUserId: user.id, status: "PENDING", seenAt: null },
    data:  { seenAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
