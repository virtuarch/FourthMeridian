import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";

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
  // RLS slice B — the invitee is NOT a member of the inviting Space, so this is
  // served by the `invitedUserId = current_fm_user_id()` arm of
  // `SpaceInvite.fm_app_sel` (§13 of the RLS migration, which exists precisely
  // so an invitation is visible to the one person who must act on it). The
  // application predicate is unchanged; the policy now says the same thing.
  const count = await withTenantDb(user.id, (tx) => tx.spaceInvite.count({
    where: { invitedUserId: user.id, status: "PENDING", seenAt: null },
  }));
  console.log(`[api/spaces/invites/pending] count query: ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);

  return NextResponse.json({ count });
}
