import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";

/** POST /api/spaces/invites/seen
 *  Stamps seenAt on every unseen PENDING invite for the current user.
 *  Called automatically when the user opens the Invites tab.
 *  After this the sidebar badge count drops to 0.
 */
export async function POST() {
  const [user, err] = await requireUser();
  if (err) return err;

  // RLS slice B — the invitee acting on their own invitations. Both arms of
  // `SpaceInvite.fm_app_upd` (USING and WITH CHECK) carry
  // `invitedUserId = current_fm_user_id()`, so a non-member stamping their own
  // seenAt is admissible and nothing else is.
  await withTenantDb(user.id, (tx) => tx.spaceInvite.updateMany({
    where: { invitedUserId: user.id, status: "PENDING", seenAt: null },
    data:  { seenAt: new Date() },
  }));

  return NextResponse.json({ ok: true });
}
