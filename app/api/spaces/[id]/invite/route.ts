/**
 * POST /api/spaces/[id]/invite
 * Invite a user by username. Caller must be an ACTIVE OWNER or ADMIN.
 * Body: { username: string, role?: SpaceMemberRole }
 *
 * ── RLS SLICE B — ONE READ CANNOT BE THE TENANT'S, AND IT IS THE POINT OF THE
 *    ROUTE ─────────────────────────────────────────────────────────────────
 * Resolving a USERNAME to a user is a question about somebody else by
 * definition. fm_app's `User` SELECT policy is `id = current_fm_user_id()`, so
 * as the tenant that lookup returns nothing and EVERY invite would answer "No
 * user found with that username". It stays on the deployment-wide client, named
 * here — the same shape as the cross-user uniqueness probes kept in RLS-11. The
 * caller learns only what the 404/409 answers already told them.
 *
 * Everything else — the Space type guard, the membership probe, the pending-
 * invite probe, the upsert and the audit row — runs as the caller.
 *
 * ⚠️ AND THE `invitedUser` INCLUDE HAD TO GO WITH IT. It was a REQUIRED relation
 * on the upsert's result, and Prisma raises "Inconsistent query result" rather
 * than returning null when a policy hides one. The response is composed from
 * `targetUser`, which this handler already holds and which selects the SAME
 * three display fields the include did — so the 201 body is unchanged.
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { env }                                    from "@/lib/env";
import { requireSpaceRole }                   from "@/lib/session";
import { parseInviteRoleInput }                   from "@/lib/spaces/invite-role";
import { SpaceMemberRole, SpaceMemberStatus, SpaceType } from "@prisma/client";
import { getClientIp }                            from "@/lib/api";
import { withTenantDb }                           from "@/lib/db/tenant-context";
import { emitDomainEvent, dispatchDomainEvent }   from "@/lib/events/emit";
import type { DomainEvent }                       from "@/lib/events/types";
import { sendEmail }                              from "@/lib/email/send";
import { buildInviteUrl }                         from "@/lib/email/invite-url";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces both ACTIVE status and ADMIN min-role.
  // REMOVED or LEFT OWNER/ADMIN users cannot send invites.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
  if (err) return err;
  const { user } = auth;

  // Personal Spaces are strictly single-user — their sole member is the OWNER.
  // Every "which personal space is mine?" lookup in the app resolves by
  // membership (lib/space.ts, space-account-link, brief, sidebar, and — most
  // dangerously — account-deletion purge), so a second member (even a VIEWER)
  // could make a personal Space resolve as someone else's context or be
  // cross-user-deleted. Reject the invite outright rather than clamp the role.
  // SHARED spaces are unaffected.
  const space = await withTenantDb(user.id, (tx) => tx.space.findUnique({
    where: { id: spaceId }, select: { type: true },
  }));
  if (space?.type === SpaceType.PERSONAL) {
    return NextResponse.json({ error: "Personal Spaces can't have additional members." }, { status: 400 });
  }

  const body = await req.json();
  const { username } = body as { username: string; role?: unknown };

  if (!username?.trim()) {
    return NextResponse.json({ error: "Username is required" }, { status: 400 });
  }

  // W1-D3 — the role is allowlist-validated (ADMIN/MEMBER/VIEWER; absent →
  // MEMBER, the pre-existing default). This replaces the old `role as never`
  // cast, which persisted ANY SpaceMemberRole value — including OWNER, letting
  // an ADMIN mint a second OWNER through invite-then-accept. OWNER is never
  // invitable; ownership transfer is a separate (future) flow.
  const parsedRole = parseInviteRoleInput((body as { role?: unknown }).role);
  if (!parsedRole.ok) {
    return NextResponse.json({ error: parsedRole.error }, { status: 400 });
  }
  const role = parsedRole.role;

  // Look up target user by username.
  // ⚠️ DELIBERATELY NOT withTenantDb — see the header: this is the one read in
  // the route that is about somebody other than the caller.
  const targetUser = await db.user.findUnique({
    where:  { username: username.trim().replace(/^@/, "") },
    select: { id: true, name: true, username: true, email: true },
  });
  if (!targetUser) {
    return NextResponse.json({ error: "No user found with that username" }, { status: 404 });
  }

  // Can't invite yourself
  if (targetUser.id === user.id) {
    return NextResponse.json({ error: "You're already in this Space" }, { status: 400 });
  }

  // RLS slice B — both probes and the upsert are about rows in THIS Space, which
  // the ACTIVE ADMIN guard has already made visible to fm_app. One short
  // transaction each: the 409s sit between them, and `sendEmail` — a network
  // call — sits after.
  //
  // Already an ACTIVE member? (H1 fix: REMOVED/LEFT rows don't count)
  const existing = await withTenantDb(user.id, (tx) => tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: targetUser.id } },
  }));
  if (existing?.status === SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "User is already a member" }, { status: 409 });
  }

  // Already has a pending invite?
  const existingInvite = await withTenantDb(user.id, (tx) => tx.spaceInvite.findUnique({
    where: { spaceId_invitedUserId: { spaceId, invitedUserId: targetUser.id } },
  }));
  if (existingInvite?.status === "PENDING") {
    return NextResponse.json({ error: "An invite is already pending for this user" }, { status: 409 });
  }

  // Upsert invite (re-invite if previously declined/rescinded).
  // Admissible on both arms: INSERT's WITH CHECK and UPDATE's USING/WITH CHECK
  // are each satisfied by `spaceId IN fm_visible_space_ids()`.
  const invited = await withTenantDb(user.id, (tx) => tx.spaceInvite.upsert({
    where: { spaceId_invitedUserId: { spaceId, invitedUserId: targetUser.id } },
    create: {
      spaceId,
      invitedById:   user.id,
      invitedUserId: targetUser.id,
      role,          // validated InvitableSpaceRole — never OWNER (W1-D3)
      status:        "PENDING",
    },
    update: {
      invitedById: user.id,
      role,        // validated InvitableSpaceRole — never OWNER (W1-D3)
      status:      "PENDING",
      createdAt:   new Date(),
      seenAt:      null,  // reset so the New badge and sidebar count fire again
    },
    include: {
      // `invitedUser` deliberately absent — see the header. `space` stays: it is
      // this Space, which the caller is an ACTIVE member of.
      space: { select: { name: true } },
    },
  }));

  // The exact shape the include produced, from the row this handler already has.
  const invite = {
    ...invited,
    invitedUser: { id: targetUser.id, name: targetUser.name, username: targetUser.username },
  };

  // ── Invitation notification email (OPS-1 S3) ──────────────────────────────
  // Notify the (existing-account) invitee. NON-THROWING: a delivery failure is
  // logged and recorded in the event, but never fails invite creation. The
  // email carries NO token — acceptance stays identity-gated in-app; the CTA is
  // a trusted-base pointer to /dashboard/spaces (built from env, not the Host).
  const inviterName = user.username ? `@${user.username}` : "A Fourth Meridian member";
  const spaceName   = invite.space?.name ?? "a Space";
  const emailResult = await sendEmail("space-invite", targetUser.email, {
    spaceName,
    inviterName,
    role,
    inviteUrl: buildInviteUrl(env.NEXT_PUBLIC_APP_URL),
  });
  if (emailResult.status === "error") {
    console.error("[spaces/invite] invitation email failed to send:", emailResult.error);
  }

  // Timeline T-1 — MemberInvited (audit-only, no handler). Net-new
  // Timeline-visible row. `invitedEmail` carries a safe display handle
  // (name or @username), never a real email, because the activity consumer
  // currently reads meta.invitedEmail (key rename is deferred debt).
  // `emailStatus` (S3) records the notification outcome on this same event.
  const event: DomainEvent = {
    type:        "MemberInvited",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload: {
      invitedUserId: targetUser.id,
      role,
      invitedEmail:  targetUser.name ?? `@${targetUser.username}`,
      emailStatus:   emailResult.status,
    },
  };

  // ⚠️ PERSIST AS THE CALLER, DISPATCH OUTSIDE. The AuditLog row is the caller's
  // (its INSERT policy is permissive, see §18). The handler is NOT: this event's
  // registered handler writes the INVITEE a Notification, and
  // `Notification.fm_app_ins` is `userId = current_fm_user_id()` — as the inviter
  // the tenant role structurally cannot write it, which is a second reason the
  // dispatch phase must never be inside this boundary.
  await withTenantDb(user.id, (tx) => emitDomainEvent(tx, event));
  await dispatchDomainEvent(event);

  return NextResponse.json(invite, { status: 201 });
}
