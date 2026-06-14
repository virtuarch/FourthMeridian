import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

/** GET /api/workspaces/invites/pending
 *  Returns the count of UNSEEN pending invites for the current user.
 *  seenAt IS NULL = user hasn't opened the Invites tab yet.
 *  Used by the Sidebar badge — goes to 0 once they view the tab.
 */
export async function GET() {
  const [user, authErr] = await requireUser();
  if (authErr) return NextResponse.json({ count: 0 });

  const count = await db.workspaceInvite.count({
    where: { invitedUserId: user.id, status: "PENDING", seenAt: null },
  });

  return NextResponse.json({ count });
}
