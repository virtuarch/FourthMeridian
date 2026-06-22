/**
 * app/api/accounts/[id]/restore/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * POST — restores a soft-deleted FinancialAccount, regardless of source
 *        (Plaid or manual). Companion to the generic DELETE in
 *        app/api/accounts/[id]/route.ts. The manual-only restore at
 *        app/api/accounts/manual/[id]/restore/route.ts is unchanged and
 *        keeps serving the Archived Assets UI for manually-entered assets;
 *        this route fills the equivalent gap for everything else
 *        (Plaid-linked accounts in particular).
 *
 * Actions:
 *   1. Verify caller owns the account (ownerUserId) and it is currently
 *      soft-deleted (deletedAt set).
 *   2. Check whether another ACTIVE account already exists with the same
 *      provider identity (plaidAccountId / walletAddress). If so, this is a
 *      duplicate — fold this account's history into the active one (see
 *      lib/accounts/reconcile.ts) and return success pointing at the
 *      active account instead of restoring a second visible row. No
 *      conflict is ever shown to the user. If no exact identity match is
 *      found (Plaid can reissue plaidAccountId for the same real-world
 *      account), fall back to a conservative fingerprint match
 *      (institutionId + mask + type + officialName/plaidName) before
 *      assuming this account is genuinely unique.
 *   3. Otherwise, restore normally:
 *      - FinancialAccount: deletedAt → null.
 *      - AccountConnection rows: deletedAt → null.
 *      - WorkspaceAccountShare rows: status → ACTIVE, revokedAt → null,
 *        revokedByUserId → null.
 *   4. Audit log.
 *
 * Does NOT re-establish a revoked PlaidItem at the provider — if the
 * PlaidItem itself was revoked (status REVOKED, itemRemove() already called),
 * the underlying Plaid credential is gone and the user must relink via Plaid
 * Link. app/api/plaid/exchange-token/route.ts now clears FinancialAccount/
 * AccountConnection deletedAt automatically when relinking the same
 * plaidAccountId, so that path and this route both lead to the same restored
 * state — this route just covers the case where only the account-level
 * removal happened and the user wants it back without relinking.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { ShareStatus, DuplicateDetectionSource } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import {
  providerIdentityOf,
  findActiveAccountByIdentity,
  resolveAccountByFingerprint,
  mergeArchivedDuplicateIntoCanonical,
} from "@/lib/accounts/reconcile";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  try {
    const fa = await db.financialAccount.findUnique({
      where:  { id },
      select: {
        id: true, name: true, type: true, ownerUserId: true, deletedAt: true,
        plaidAccountId: true, walletAddress: true,
        institutionId: true, institution: true, mask: true, officialName: true, plaidName: true,
      },
    });

    if (!fa) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    if (!fa.deletedAt) {
      return NextResponse.json({ error: "Account is not deleted." }, { status: 400 });
    }
    // Verify ownership: caller must own this account (same check PATCH uses)
    if (fa.ownerUserId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Automatic duplicate reconciliation ──────────────────────────────────
    // If an active account already exists for the same provider identity,
    // this restore would create a visible duplicate. Silently fold this
    // account's history into the active one instead — no conflict shown.
    const identity = providerIdentityOf(fa);
    let canonical: { id: string } | null = identity ? await findActiveAccountByIdentity(identity, fa.id) : null;
    // Tracks which match found `canonical`, so the merge below is tagged with
    // the right DuplicateDetectionSource. Default reflects the identity-match
    // branch above; overwritten if the fingerprint fallback is the one that
    // actually finds a match.
    let mergeSource: DuplicateDetectionSource = DuplicateDetectionSource.PROVIDER_IDENTITY_MATCH;

    // No exact identity match — Plaid can reissue plaidAccountId for the
    // same real-world account, so an active row (or other archived
    // siblings) may already exist under different plaidAccountId values.
    // Fall back to a fingerprint match before assuming this account is
    // genuinely unique. Only act here when an active row is found — that's
    // the case this restore would otherwise duplicate. (Other archived
    // siblings, if any, get consolidated the next time the account is
    // reconnected via Plaid — see app/api/plaid/exchange-token/route.ts.)
    if (!canonical) {
      const resolution = await resolveAccountByFingerprint(
        {
          ownerUserId:   fa.ownerUserId,
          institutionId: fa.institutionId,
          institution:   fa.institution,
          mask:          fa.mask,
          officialName:  fa.officialName,
          plaidName:     fa.plaidName,
          name:          fa.name,
          type:          fa.type,
        },
        fa.id
      );
      if (resolution?.matchedActive) {
        canonical = resolution.canonical;
        mergeSource = DuplicateDetectionSource.FINGERPRINT_MATCH;
      }
    }

    if (canonical) {
      await mergeArchivedDuplicateIntoCanonical(fa.id, canonical.id, mergeSource);

      await db.auditLog.create({
        data: {
          userId:    user.id,
          action:    AuditAction.ACCOUNT_RESTORE,
          metadata:  { accountId: fa.id, name: fa.name, accountType: fa.type, reconciledIntoAccountId: canonical.id },
          ipAddress: getClientIp(req),
        },
      });

      return NextResponse.json({ ok: true, accountId: canonical.id });
    }

    // ── Restore in parallel ─────────────────────────────────────────────────
    await Promise.all([
      // 1. Restore FinancialAccount
      db.financialAccount.update({
        where: { id },
        data:  { deletedAt: null },
      }),
      // 2. Restore AccountConnection rows
      db.accountConnection.updateMany({
        where: { financialAccountId: id, deletedAt: { not: null } },
        data:  { deletedAt: null },
      }),
      // 3. Reactivate WorkspaceAccountShare rows that were revoked
      db.workspaceAccountShare.updateMany({
        where: { financialAccountId: id, status: ShareStatus.REVOKED },
        data:  { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
      }),
    ]);

    // ── Regenerate SpaceSnapshot for every space this account is now active
    //    in again. Shares were just reactivated above, so the existing
    //    ACTIVE-share lookup inside regenerateSnapshotsForAccounts() finds the
    //    right space(s). Best-effort/non-fatal — see
    //    docs/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md.
    try {
      await regenerateSnapshotsForAccounts([id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/:id/restore] snapshot regen failed for account ${id} (non-fatal):`, snapshotErr);
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    await db.auditLog.create({
      data: {
        userId:    user.id,
        action:    AuditAction.ACCOUNT_RESTORE,
        metadata:  { accountId: id, name: fa.name, accountType: fa.type },
        ipAddress: getClientIp(req),
      },
    });

    return NextResponse.json({ ok: true, accountId: id });
  } catch (err) {
    console.error("[POST /api/accounts/:id/restore]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}, "POST /api/accounts/[id]/restore");
