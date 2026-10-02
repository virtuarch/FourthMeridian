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
 *
 * ── RLS-C-S7 — SAME SHAPE AS app/api/accounts/[id]/restore ────────────────────
 * The link reactivation is deployment-wide (it reaches a co-owner's Space), so it
 * runs through the ONE narrow `fm_system` capability in
 * lib/accounts/links-everywhere.ts, with the shortfall asserted, after a tenant
 * phase has proved ownership. And the ORDER is forced: links first, because
 * `AccountConnection.fm_app_upd` is `fm_account_visible("financialAccountId")`
 * and that is false while the links are still REVOKED. See that route's header
 * and docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md for the full reasoning.
 */

import { NextRequest, NextResponse }   from "next/server";
import { withTenantDb }                from "@/lib/db/tenant-context";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { requireUser }                 from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";
import { DuplicateDetectionSource } from "@prisma/client";
import { providerIdentityOf, findActiveAccountByIdentity, mergeArchivedDuplicateIntoCanonical } from "@/lib/accounts/reconcile";
import { reactivateAccountLinksEverywhere } from "@/lib/accounts/links-everywhere";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";

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
  // THE PROOF, on the tenant role — the gate in front of the deployment-wide
  // reactivation below. A soft-deleted account has no ACTIVE link, so only
  // `FinancialAccount.fm_app_sel`'s `ownerUserId = me` arm reaches it here.
  const fa = await withTenantDb(userId, (tx) => tx.financialAccount.findUnique({
    where:  { id },
    select: {
      id: true, name: true, ownerUserId: true, type: true, syncStatus: true, deletedAt: true,
      plaidAccountId: true, walletAddress: true,
    },
  }));

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

    await withTenantDb(userId, (tx) => tx.auditLog.create({
      data: {
        userId,
        action:    "MANUAL_ASSET_RESTORE",
        metadata:  { accountId: fa.id, name: fa.name, reconciledIntoAccountId: canonical.id },
        ipAddress: getClientIp(req),
      },
    }));

    return NextResponse.json({ ok: true, accountId: canonical.id });
  }

  // ── Restore, in the order the policies force ───────────────────────────────
  // KD-4 Phase 3 kept these three writes in ONE transaction, and the split below
  // costs that; the failure is LOUD and the restore is IDEMPOTENT, so a retry
  // converges. See app/api/accounts/[id]/restore/route.ts for the full note.
  //
  // 1. D3 Stage B4 — reactivate the revoked links, in EVERY Space. FIRST,
  //    because it is what makes the connections visible in step 2.
  const reactivation = await reactivateAccountLinksEverywhere([id]);
  assertEveryObservedRowWasWritten(
    { table: "SpaceAccountLink", operation: "update", scope: "1 authorized account id" },
    reactivation.observedLinkCount,
    reactivation.changedLinkCount,
  );

  await withTenantDb(userId, async (tx) => {
    // 2. Restore FinancialAccount
    await tx.financialAccount.update({
      where: { id },
      data:  { deletedAt: null },
    });
    // 3. Restore AccountConnection rows. Observed first, in this same phase, so a
    //    policy refusal cannot pass as "there were none to restore". The original
    //    statement had NO deletedAt filter, so the observation matches it: every
    //    connection row this account has, archived or not.
    const existing = await tx.accountConnection.findMany({
      where:  { financialAccountId: id },
      select: { id: true },
    });
    const restored = await tx.accountConnection.updateMany({
      where: { financialAccountId: id },
      data:  { deletedAt: null },
    });
    assertEveryObservedRowWasWritten(
      { table: "AccountConnection", operation: "update", scope: "1 authorized account id" },
      existing.length,
      restored.count,
    );
  });

  // ── Regenerate SpaceSnapshot for every space this account is now active in
  //    again. Shares were just reactivated above, so the existing ACTIVE-
  //    share lookup inside regenerateSnapshotsForAccounts() finds the right
  //    space(s). Best-effort/non-fatal — see
  //    docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md.
  try {
    await regenerateSnapshotsForAccounts([id]);
  } catch (snapshotErr) {
    console.warn(`[POST /api/accounts/manual/:id/restore] snapshot regen failed for account ${id} (non-fatal):`, snapshotErr);
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  await withTenantDb(userId, (tx) => tx.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_RESTORE",
      metadata:  { accountId: id, name: fa.name },
      ipAddress: getClientIp(req),
    },
  }));

  return NextResponse.json({ ok: true, accountId: id });
}, "POST /api/accounts/manual/[id]/restore");
