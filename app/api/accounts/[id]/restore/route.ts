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
 *
 * ── RLS-C-S7 — RESTORE IS DISCONNECT RUN BACKWARDS, INCLUDING THE AUTHORITY ───
 * `db.spaceAccountLink.updateMany({ financialAccountId, status: REVOKED })`
 * reactivated EVERY revoked link in EVERY Space, which is the shipped meaning:
 * the account comes back wherever it used to be, including a co-owner's Space.
 * Under `fm_app` that would reactivate only the links the restoring user can see,
 * leaving a co-owner holding a REVOKED link to a live, syncing account — their net
 * worth would silently never hear about it again, and `updateMany` would report a
 * smaller count rather than an error. Identical blast radius to the disconnect, so
 * identical authority: ONE narrow capability on `fm_system`
 * (lib/accounts/links-everywhere.ts), reached only with an id a tenant phase has
 * proved, with the shortfall asserted. See docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md.
 *
 * ⚠️ AND THE PHASES RUN IN THE OPPOSITE ORDER TO THE DISCONNECT'S.
 * `AccountConnection.fm_app_upd` is `fm_account_visible("financialAccountId")`,
 * true only while an ACTIVE link exists in a visible Space. So the links must be
 * reactivated FIRST or the connection un-delete matches nothing — silently. The
 * disconnect needs exactly the reverse (connections first, links last). Getting
 * either one backwards writes zero rows and raises nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { DuplicateDetectionSource } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import {
  providerIdentityOf,
  findActiveAccountByIdentity,
  resolveAccountByFingerprint,
  mergeArchivedDuplicateIntoCanonical,
} from "@/lib/accounts/reconcile";
import { reactivateAccountLinksEverywhere } from "@/lib/accounts/links-everywhere";
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
    // THE PROOF, on the tenant role. It is the gate in front of the
    // deployment-wide reactivation below, so it has to be a read the policy
    // constrains. A soft-deleted account has no ACTIVE link, so only
    // `FinancialAccount.fm_app_sel`'s `ownerUserId = me` arm can see it here —
    // which is exactly the authorization this route requires anyway.
    const fa = await withTenantDb(user.id, (tx) => tx.financialAccount.findUnique({
      where:  { id },
      select: {
        id: true, name: true, type: true, ownerUserId: true, deletedAt: true,
        plaidAccountId: true, walletAddress: true,
        institutionId: true, institution: true, mask: true, officialName: true, plaidName: true,
      },
    }));

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
    // RLS-ACC-S5 — the lookup's client is now required and leading, and this
    // one is a TENANT phase: ownership of `fa` was just proved on the tenant
    // role above, so the active duplicate this is looking for is the caller's
    // own account. Under fm_app a provider identity held by ANOTHER owner is no
    // longer found — which turns a fold that could only ever end in
    // ReparentingRefusedError/CROSS_OWNER (a 500 on a legitimate restore) into
    // an ordinary restore. Short phase, no provider call inside it.
    const identity = providerIdentityOf(fa);
    let canonical: { id: string } | null = identity
      ? await withTenantDb(user.id, (tx) => findActiveAccountByIdentity(tx, identity, fa.id))
      : null;
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
      // ⚠️ RLS-ACC-S5 — ONE OF THE TWO CALL SITES THAT STILL RELY ON THE
      // MODULE DEFAULT, AND THE ONLY REASON IS A POLICY. Everything else in this
      // route runs on `fm_app`; this resolution and the merge below cannot,
      // because folding an archived sibling ends in a
      // `DuplicateAccountCandidate` INSERT whose fm_app policy is
      // `fm_account_visible("accountAId") AND fm_account_visible("accountBId")`
      // — false for an archived loser BY CONSTRUCTION, so the whole fold aborts
      // on 42501 (measured on a live role; acceptance cases 86-87).
      //
      // Passing `db` here EXPLICITLY would be the honest shape, and it is
      // refused for a second, independent reason: it would put this route back
      // on the migration principal, growing the authority ratchet and falsifying
      // lib/accounts/links-everywhere.test.ts's pin that S7 took it off. There is
      // no authority this route may hold that can complete the fold. The default
      // therefore stays until `DuplicateAccountCandidate` gains RLS-D1's owner
      // arm, and reconcile.ts's header records exactly which line that is.
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
      // ⚠️ RLS-ACC-S5 — THE SECOND SITE, SAME SINGLE REASON. See the note on
      // the fingerprint fallback above: the fold's last statement is a
      // `DuplicateAccountCandidate` INSERT that `fm_app` cannot make about an
      // archived loser, and naming `db` here would regress this route onto the
      // migration principal. This is the one operation in this route that does
      // not run on the tenant role, it is deliberate, and it is measured.
      await mergeArchivedDuplicateIntoCanonical(fa.id, canonical.id, mergeSource);

      await withTenantDb(user.id, (tx) => tx.auditLog.create({
        data: {
          userId:    user.id,
          action:    AuditAction.ACCOUNT_RESTORE,
          metadata:  { accountId: fa.id, name: fa.name, accountType: fa.type, reconciledIntoAccountId: canonical.id },
          ipAddress: getClientIp(req),
        },
      }));

      return NextResponse.json({ ok: true, accountId: canonical.id });
    }

    // ── Restore, in the order the policies force ────────────────────────────
    // KD-4 Phase 3 kept these three writes in ONE transaction, and the split
    // below costs that: a failure between the two phases leaves ACTIVE links
    // pointing at a still-archived account. It is LOUD (it propagates and the
    // route 500s) and the whole restore is IDEMPOTENT, so a retry converges. The
    // alternative was to move the account and connection writes to `fm_system`
    // too, which would make the capability the entire operation.
    //
    // 1. D3 Stage B4 — reactivate the revoked links, in EVERY Space. FIRST,
    //    because it is what makes the connections visible in step 2. Deployment-
    //    wide, with the shortfall asserted — see the header.
    const reactivation = await reactivateAccountLinksEverywhere([id]);
    assertEveryObservedRowWasWritten(
      { table: "SpaceAccountLink", operation: "update", scope: "1 authorized account id" },
      reactivation.observedLinkCount,
      reactivation.changedLinkCount,
    );

    await withTenantDb(user.id, async (tx) => {
      // 2. Restore FinancialAccount
      await tx.financialAccount.update({
        where: { id },
        data:  { deletedAt: null },
      });
      // 3. Restore AccountConnection rows. Observed first, in this same phase,
      //    so a policy refusal cannot pass as "there were none to restore".
      const archived = await tx.accountConnection.findMany({
        where:  { financialAccountId: id, deletedAt: { not: null } },
        select: { id: true },
      });
      const restored = await tx.accountConnection.updateMany({
        where: { financialAccountId: id, deletedAt: { not: null } },
        data:  { deletedAt: null },
      });
      assertEveryObservedRowWasWritten(
        { table: "AccountConnection", operation: "update", scope: "1 authorized account id" },
        archived.length,
        restored.count,
      );
    });

    // ── Regenerate SpaceSnapshot for every space this account is now active
    //    in again. Shares were just reactivated above, so the existing
    //    ACTIVE-share lookup inside regenerateSnapshotsForAccounts() finds the
    //    right space(s). Best-effort/non-fatal — see
    //    docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md.
    try {
      await regenerateSnapshotsForAccounts([id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/:id/restore] snapshot regen failed for account ${id} (non-fatal):`, snapshotErr);
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    await withTenantDb(user.id, (tx) => tx.auditLog.create({
      data: {
        userId:    user.id,
        action:    AuditAction.ACCOUNT_RESTORE,
        metadata:  { accountId: id, name: fa.name, accountType: fa.type },
        ipAddress: getClientIp(req),
      },
    }));

    return NextResponse.json({ ok: true, accountId: id });
  } catch (err) {
    console.error("[POST /api/accounts/:id/restore]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}, "POST /api/accounts/[id]/restore");
