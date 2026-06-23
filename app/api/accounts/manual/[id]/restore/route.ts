/**
 * POST /api/accounts/manual/[id]/restore
 *
 * Restores a soft-deleted manually-entered asset account.
 *
 * Actions:
 *   1. Verify caller owns the account and it is currently soft-deleted
 *   2. Verify type === 'other' && syncStatus === 'manual'
 *   3. Restore FinancialAccount: deletedAt → null
 *   4. Restore AccountConnection rows: deletedAt → null
 *   5. Reactivate all WorkspaceAccountShare rows: status → ACTIVE, revokedAt → null
 *   6. Audit log
 *
 * Returns: { ok: true, accountId }
 */

import { NextRequest, NextResponse }   from "next/server";
import { db }                          from "@/lib/db";
import { requireUser }                 from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";
import { DuplicateDetectionSource }    from "@prisma/client";
import { providerIdentityOf, findActiveAccountByIdentity, mergeArchivedDuplicateIntoCanonical } from "@/lib/accounts/reconcile";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { dualWriteFromShares } from "@/lib/accounts/space-account-link";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  // ── Fetch + validate ──────────────────────────────────────────────────────
  const fa = await db.financialAccount.findUnique({
    where:  { id },
    select: {
      id: true, name: true, ownerUserId: true, type: true, syncStatus: true, deletedAt: true,
      plaidAccountId: true, walletAddress: true,
    },
  });

  if (!fa) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!fa.deletedAt) {
    return NextResponse.json({ error: "Account is not archived." }, { status: 400 });
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (fa.type !== "other" || fa.syncStatus !== "manual") {
    return NextResponse.json({ error: "Only manually-entered asset accounts can be restored." }, { status: 400 });
  }

  // ── Automatic duplicate reconciliation ────────────────────────────────────
  // Manual assets normally have no provider identity, so this is a no-op for
  // them — kept for consistency with the generic restore route in case a
  // record ever does carry one.
  const identity  = providerIdentityOf(fa);
  const canonical = identity ? await findActiveAccountByIdentity(identity, fa.id) : null;

  if (canonical) {
    // Only reachable via providerIdentityOf/findActiveAccountByIdentity in
    // this route (no fingerprint fallback here — see comment above), so the
    // source is always a provider-identity match.
    await mergeArchivedDuplicateIntoCanonical(fa.id, canonical.id, DuplicateDetectionSource.PROVIDER_IDENTITY_MATCH);

    await db.auditLog.create({
      data: {
        userId,
        action:    "MANUAL_ASSET_RESTORE",
        metadata:  { accountId: fa.id, name: fa.name, reconciledIntoAccountId: canonical.id },
        ipAddress: getClientIp(req),
      },
    });

    return NextResponse.json({ ok: true, accountId: canonical.id });
  }

  // ── Restore in parallel ───────────────────────────────────────────────────
  await Promise.all([
    // 1. Restore FinancialAccount
    db.financialAccount.update({
      where: { id },
      data:  { deletedAt: null },
    }),
    // 2. Restore AccountConnection rows
    db.accountConnection.updateMany({
      where: { financialAccountId: id },
      data:  { deletedAt: null },
    }),
    // 3. Reactivate all WorkspaceAccountShare rows that were revoked
    db.workspaceAccountShare.updateMany({
      where: { financialAccountId: id, status: "REVOKED" },
      data:  {
        status:          "ACTIVE",
        revokedAt:       null,
        revokedByUserId: null,
      },
    }),
  ]);

  // ── D3 Step 3 — mirror the reactivated shares onto SpaceAccountLink.
  //    Run sequentially after the Promise.all above resolves (no
  //    transaction join — see docs/D3_STEP3_DUAL_WRITE_REVIEW.md Rule 6).
  //    Best-effort/non-fatal.
  try {
    const shares = await db.workspaceAccountShare.findMany({ where: { financialAccountId: id } });
    await dualWriteFromShares(shares);
  } catch (linkErr) {
    console.warn(`[POST /api/accounts/manual/:id/restore] SpaceAccountLink dual-write failed for account ${id} (non-fatal):`, linkErr);
  }

  // ── Regenerate SpaceSnapshot for every space this account is now active in
  //    again. Shares were just reactivated above, so the existing ACTIVE-
  //    share lookup inside regenerateSnapshotsForAccounts() finds the right
  //    space(s). Best-effort/non-fatal — see
  //    docs/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md.
  try {
    await regenerateSnapshotsForAccounts([id]);
  } catch (snapshotErr) {
    console.warn(`[POST /api/accounts/manual/:id/restore] snapshot regen failed for account ${id} (non-fatal):`, snapshotErr);
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_RESTORE",
      metadata:  { accountId: id, name: fa.name },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, accountId: id });
}, "POST /api/accounts/manual/[id]/restore");
