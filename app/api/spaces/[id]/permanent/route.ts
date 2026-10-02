/**
 * DELETE /api/spaces/[id]/permanent
 *
 * Permanently and irreversibly deletes a Space. This is the ONLY route
 * in the codebase that calls db.space.delete() — every other "delete"
 * action (the DELETE handler on /api/spaces/[id]) only sets deletedAt
 * and moves the space to trash.
 *
 * Guards:
 *   - OWNER only.
 *   - Only allowed if the space is already trashed (deletedAt IS NOT
 *     NULL) — must go through trash first, exactly like the manual-asset
 *     permanent-delete route at app/api/accounts/manual/[id]/permanent.
 *   - PERSONAL spaces can never reach this state (already blocked from
 *     being trashed in the first place) but are rejected here too as
 *     defense in depth.
 *   - Blocked if the space owns any FinancialAccount rows
 *     (ownerSpaceId = this space). FinancialAccount.ownerSpaceId
 *     is onDelete: SetNull, so without this guard a permanent delete would
 *     silently orphan those accounts (ownerless "ghost" rows that still
 *     hold real balances/transactions but belong to nothing). The caller
 *     must reassign or remove those accounts first.
 *
 * What actually cascades on delete (via existing schema-level onDelete:
 * Cascade — no manual cleanup needed here): SpaceMember, SpaceInvite,
 * AiAgent, AiAdvice, Account (legacy), WorkspaceAccountShare, SpaceGoal
 * (+ its GoalContribution/GoalCheckIn rows), SpaceDashboardSection,
 * SpaceSnapshot. AuditLog.spaceId is onDelete: SetNull, so the audit
 * trail (including the entry this route writes) survives the delete with
 * spaceId cleared.
 *
 * ── RLS SLICE B — TWO OPERATIONS fm_app STRUCTURALLY CANNOT PERFORM ──────────
 * This route is CONVERTED IN PART, and the two statements left on the
 * deployment-wide client are named here rather than left to be noticed.
 *
 *   1. `space.delete`. fm_app is GRANTED delete on `Space` but has NO DELETE
 *      POLICY on it (§11 of prisma/migrations/…_rls_roles_and_policies — sel,
 *      ins and upd only). Row-level security defaults to deny, so as the tenant
 *      this statement would match zero rows and Prisma would raise P2025 on a
 *      Space that plainly exists. Soft-delete is an UPDATE and converts fine;
 *      this is the one real delete in the codebase and it needs an
 *      `fm_app_del ON "Space" … USING (id IN (SELECT fm_visible_space_ids()))`
 *      policy — a migration, and therefore an owner decision, not something to
 *      be worked around from a route.
 *
 *   2. The `ownerSpaceId` orphan guard. It must count EVERY FinancialAccount the
 *      Space owns, including any the caller cannot see; fm_app's
 *      `FinancialAccount` SELECT policy is `ownerUserId = me OR
 *      fm_account_visible(id)`, so as the tenant it would count only the
 *      caller's subset and could report 0 for a Space that owns accounts —
 *      turning a safety guard into a silent orphan-maker. A cross-tenant count
 *      is not a question about the caller's rows.
 *
 * ⚠️ NEITHER IS ROUTED TO systemDb. app/api/spaces/ is not in that client's
 * confinement list (scripts/audit-db-authority.ts), and it should not be: an
 * ordinary HTTP handler acquiring a deployment-wide authority is the escape this
 * programme exists to close. They stay visibly on `db` until the policy lands.
 *
 * ── RLS-T2 — THE ORDERING HAZARD DOES NOT REACH THIS ROUTE, AND WHY ──────────
 * `AccountConnection.fm_app_upd` is `fm_account_visible("financialAccountId")`,
 * true only while an ACTIVE link exists in a visible Space — so a tenant teardown
 * that revokes links BEFORE closing connections destroys the visibility the next
 * statement needs and writes zero rows while raising nothing (cases 60-61 of
 * scripts/rls-app-acceptance.ts prove both directions). This route is EXEMPT from
 * that hazard for a structural reason, not a lucky one, and it is worth stating
 * because the exemption is what a future converter will need:
 *
 *   THIS HANDLER ISSUES NO LINK OR CONNECTION STATEMENT AT ALL. Its only teardown
 *   is `space.delete`, and everything listed above as "what actually cascades"
 *   is performed by Postgres's own referential-integrity triggers from the
 *   schema's `onDelete: Cascade`. Referential integrity BYPASSES row security
 *   entirely — case 63 of rls-app-acceptance measures exactly this ("the account
 *   DELETE takes the co-owner's link anyway … no capability was needed"). A
 *   cascade therefore has no ordering to get wrong and no policy to be refused by.
 *
 * So when the `fm_app_del ON "Space"` policy named above lands and the delete
 * converts, the cascade does NOT become a sequence of tenant statements and does
 * NOT acquire the links-before-connections problem. The only question that
 * conversion raises is whether the actor may delete the Space row itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceRole } from "@/lib/session";
import { SpaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withTenantDb } from "@/lib/db/tenant-context";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  // RLS slice B — an ACTIVE OWNER's own trashed Space, read as that owner.
  const space = await withTenantDb(user.id, (tx) => tx.space.findUnique({ where: { id } }));
  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (space.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your Personal Space" }, { status: 400 });
  }
  if (!space.deletedAt) {
    return NextResponse.json(
      { error: "Move Space to trash before permanently deleting it" },
      { status: 400 }
    );
  }

  // ⚠️ DELIBERATELY NOT withTenantDb — exception 2 in the file header. This must
  // count what the SPACE owns, not what the CALLER can see.
  const ownedAccountCount = await db.financialAccount.count({
    where: { ownerSpaceId: id },
  });
  if (ownedAccountCount > 0) {
    return NextResponse.json(
      {
        error: `This Space owns ${ownedAccountCount} account${ownedAccountCount === 1 ? "" : "s"}. Reassign or remove ${ownedAccountCount === 1 ? "it" : "them"} before permanently deleting the Space.`,
        ownedAccountCount,
      },
      { status: 400 }
    );
  }

  // Audit log first — AuditLog.spaceId is SetNull on delete, so this
  // entry survives the cascade below with spaceId cleared but the name
  // preserved in metadata.
  // RLS slice B — the audit row is this route's own write and runs as the user.
  // It stays its OWN transaction, deliberately: it must be committed BEFORE the
  // delete (the comment above is the reason), and the delete cannot join it.
  await withTenantDb(user.id, (tx) => tx.auditLog.create({
    data: {
      userId:      user.id,
      spaceId: id,
      action:      AuditAction.SPACE_PERMANENT_DELETE,
      metadata:    { name: space.name, type: space.type, category: space.category },
      ipAddress:   getClientIp(req),
    },
  }));

  // ⚠️ DELIBERATELY NOT withTenantDb — exception 1 in the file header. fm_app has
  // no DELETE policy on `Space`, so as the tenant this would match nothing.
  await db.space.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/permanent");
