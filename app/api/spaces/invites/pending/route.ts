import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

/** GET /api/spaces/invites/pending
 *  Returns the count of UNSEEN pending invites for the current user.
 *  seenAt IS NULL = user hasn't opened the Invites tab yet.
 *  Used by the Sidebar badge — goes to 0 once they view the tab.
 */
export async function GET() {
  const t0 = Date.now();
  const [user, authErr] = await requireUser();
  console.log(`[api/spaces/invites/pending] requireUser: ${Date.now() - t0}ms`);
  if (authErr) return NextResponse.json({ count: 0 });

  const t1 = Date.now();
  const count = await db.spaceInvite.count({
    where: { invitedUserId: user.id, status: "PENDING", seenAt: null },
  });
  console.log(`[api/spaces/invites/pending] count query: ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);

  return NextResponse.json({ count });
}
