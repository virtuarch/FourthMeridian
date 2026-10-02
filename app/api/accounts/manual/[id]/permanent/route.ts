/**
 * DELETE /api/accounts/manual/[id]/permanent
 *
 * Permanently and irreversibly hard-deletes a soft-deleted manually-entered
 * asset account and all its associated rows.
 *
 * Only allowed on accounts that are already soft-deleted (deletedAt != null).
 * Plaid-synced accounts are explicitly rejected.
 *
 * Deletion order (FK-safe):
 *   1. WorkspaceAccountShare rows
 *   2. AccountConnection rows
 *   3. FinancialAccount
 *
 * Returns: { ok: true, accountId }
 *
 * Authorization: requireFreshUser() — see lib/session.ts on why a sensitive
 * action must not trust the CACHED revocation check. This delete is
 * IRREVERSIBLE: a hard delete of the FinancialAccount plus its links and
 * connections, with no soft-delete left to undo. RLS Slice 2 — it used
 * requireUser(), making it the only irreversible-delete route in app/api that
 * did; its peers (user/delete, user/deactivate, imports/[id]/rollback) all
 * re-check the session against the live UserSession row first. The ownerUserId
 * comparison below is unchanged — a fresher session, the same authority.
 *
 * ── RLS-C-S7 — THE WHOLE ROUTE RUNS AS THE CALLER, AND NEEDS NO CAPABILITY ────
 * This is the one lifecycle write on these paths that is deployment-wide in its
 * effect and still needs no `fm_system` opening, because the DATABASE already
 * guarantees the part a tenant client cannot reach:
 * `SpaceAccountLink.financialAccountId` is `onDelete: Cascade`, so hard-deleting
 * the FinancialAccount removes EVERY link to it, in every Space, whether or not
 * this caller could see them. Referential actions are performed by the system and
 * are not filtered by a policy. A foreign-key cascade is a stronger guarantee than
 * a correctly-written `WHERE`, which is the whole argument of this programme, so
 * the right move here is to lean on it rather than to widen an authority.
 *
 * ⚠️ THE DELETE ORDER CHANGED, AND IT HAD TO. `dualDeleteSpaceAccountLinks` ran
 * FIRST, and under `fm_app` that destroys `fm_account_visible()` for this
 * account — so the AccountConnection `deleteMany` on the next line would have
 * matched nothing and said nothing. FK-safety is unaffected (links and
 * connections are siblings, both children of FinancialAccount), so the
 * connections now go first.
 *
 * The account row itself is protected: `FinancialAccount.fm_app_del` is
 * `ownerUserId = current_fm_user_id()`, and Prisma's `delete` (not `deleteMany`)
 * raises P2025 on zero rows, so a non-owner reaching this is loud, not quiet.
 */

import { NextRequest, NextResponse }   from "next/server";
import { withTenantDb }                from "@/lib/db/tenant-context";
import { requireFreshUser }            from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";
import { dualDeleteSpaceAccountLinks } from "@/lib/accounts/space-account-link";

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireFreshUser();
  if (err) return err;
  const userId = user.id;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  // ── Fetch + validate ──────────────────────────────────────────────────────
  const fa = await withTenantDb(userId, (tx) => tx.financialAccount.findUnique({
    where:  { id },
    select: { id: true, ownerUserId: true, type: true, syncStatus: true, deletedAt: true, name: true },
  }));

  if (!fa) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!fa.deletedAt) {
    return NextResponse.json(
      { error: "Account must be archived before it can be permanently deleted." },
      { status: 400 }
    );
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (fa.type !== "other" || fa.syncStatus !== "manual") {
    return NextResponse.json(
      { error: "Only manually-entered asset accounts can be permanently deleted." },
      { status: 400 }
    );
  }

  // ── Audit log BEFORE deletion (so we still have the name) ─────────────────
  await withTenantDb(userId, (tx) => tx.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_PERMANENT_DELETE",
      metadata:  { accountId: id, name: fa.name },
      ipAddress: getClientIp(req),
    },
  }));

  // ── Hard delete in FK-safe order ──────────────────────────────────────────
  // D3 Stage B4 — SpaceAccountLink is the sole target; WorkspaceAccountShare
  // write retired here.
  // KD-4 Phase 3 — the three deletes commit atomically. The audit row above is
  // written before deletion (to retain the name) and stays OUTSIDE.
  // RLS-C-S7 — connections BEFORE links (see the header: deleting the links
  // first makes the connections invisible), and the FinancialAccount delete's FK
  // cascade is what guarantees any link this caller could not see goes too.
  await withTenantDb(userId, async (tx) => {
    await tx.accountConnection.deleteMany({ where: { financialAccountId: id } });
    await dualDeleteSpaceAccountLinks(tx, id);
    await tx.financialAccount.delete({ where: { id } });
  });

  return NextResponse.json({ ok: true, accountId: id });
}, "DELETE /api/accounts/manual/[id]/permanent");
