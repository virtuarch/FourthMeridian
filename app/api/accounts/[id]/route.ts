/**
 * app/api/accounts/[id]/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * DELETE — soft-deletes the FinancialAccount (sets deletedAt) and revokes all
 *          active WorkspaceAccountShare rows for the account.
 *          If the account was linked via Plaid and its AccountConnection was the
 *          last non-deleted connection on that PlaidItem, disconnects the item
 *          (see lib/plaid/disconnect.ts) and marks the PlaidItem as REVOKED.
 *          Row preserved for history. See ./restore/route.ts to undo this.
 *
 * PATCH  — updates mutable fields: creditLimit, debtSubtype, interestRate,
 *          minimumPayment (manual entry), and displayName (user-editable
 *          rename — never touches plaidName/officialName, which stay frozen
 *          at whatever Plaid returned at import time).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";
import { dualWriteFromShares } from "@/lib/accounts/space-account-link";

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  try {
    const body = await req.json();
    const { creditLimit, debtSubtype, interestRate, minimumPayment, displayName } = body as {
      creditLimit?:    number | null;
      debtSubtype?:    string | null;
      interestRate?:   number | null;
      minimumPayment?: number | null;
      displayName?:    string | null;
    };

    // Validate creditLimit
    if (creditLimit !== undefined && creditLimit !== null &&
        (typeof creditLimit !== "number" || creditLimit <= 0)) {
      return NextResponse.json({ error: "Invalid creditLimit" }, { status: 400 });
    }
    // Validate interestRate (0–100 as a percentage)
    if (interestRate !== undefined && interestRate !== null &&
        (typeof interestRate !== "number" || interestRate < 0 || interestRate > 100)) {
      return NextResponse.json({ error: "Invalid interestRate — must be 0–100" }, { status: 400 });
    }
    // Validate minimumPayment
    if (minimumPayment !== undefined && minimumPayment !== null &&
        (typeof minimumPayment !== "number" || minimumPayment < 0)) {
      return NextResponse.json({ error: "Invalid minimumPayment" }, { status: 400 });
    }
    // Validate displayName — empty string means "clear the override" (fall back
    // to officialName/plaidName), so normalize "" to null rather than rejecting it.
    let normalizedDisplayName = displayName;
    if (typeof displayName === "string") {
      const trimmed = displayName.trim();
      if (trimmed.length > 120) {
        return NextResponse.json({ error: "Display name must be 120 characters or fewer" }, { status: 400 });
      }
      normalizedDisplayName = trimmed.length > 0 ? trimmed : null;
    }

    const fa = await db.financialAccount.findUnique({ where: { id } });
    if (!fa) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    // Verify ownership: caller must own this account (ownerUserId)
    if (fa.ownerUserId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await db.financialAccount.update({
      where: { id },
      data: {
        ...(creditLimit    !== undefined && { creditLimit }),
        ...(debtSubtype    !== undefined && { debtSubtype }),
        ...(interestRate   !== undefined && { interestRate }),
        ...(minimumPayment !== undefined && { minimumPayment }),
        ...(displayName    !== undefined && { displayName: normalizedDisplayName }),
      },
    });

    if (displayName !== undefined) {
      await db.auditLog.create({
        data: {
          userId:    user.id,
          action:    AuditAction.ACCOUNT_RENAMED,
          metadata:  { accountId: id, displayName: normalizedDisplayName },
          ipAddress: getClientIp(req),
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /api/accounts/:id]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}, "PATCH /api/accounts/[id]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  try {
    // Fetch FinancialAccount with its connections so we can revoke Plaid if needed
    const fa = await db.financialAccount.findUnique({
      where:   { id },
      include: {
        connections: {
          where: { deletedAt: null },
          include: { plaidItem: true },
        },
        workspaceShares: {
          where: { status: ShareStatus.ACTIVE },
        },
      },
    });

    if (!fa) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Verify the session user has an active share for this account (owns it or added it)
    const userShare = fa.workspaceShares.find(
      (s) => s.addedByUserId === user.id
    );
    if (!userShare) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date();

    // ── 1. Soft-delete the FinancialAccount ───────────────────────────────────
    await db.financialAccount.update({
      where: { id },
      data:  { deletedAt: now },
    });

    // ── 2. Soft-delete all AccountConnections ─────────────────────────────────
    await db.accountConnection.updateMany({
      where: { financialAccountId: id, deletedAt: null },
      data:  { deletedAt: now },
    });

    // ── 3. Revoke all active WorkspaceAccountShare rows ───────────────────────
    await db.workspaceAccountShare.updateMany({
      where: { financialAccountId: id, status: ShareStatus.ACTIVE },
      data:  { status: ShareStatus.REVOKED, revokedAt: now, revokedByUserId: user.id },
    });

    // ── 3a. D3 Step 3 — mirror the revocation onto SpaceAccountLink, using the
    //       pre-revocation share rows captured above (best-effort/non-fatal,
    //       handled inside dualWriteFromShares itself).
    await dualWriteFromShares(
      fa.workspaceShares.map((s) => ({
        workspaceId:        s.workspaceId,
        financialAccountId: s.financialAccountId,
        addedByUserId:      s.addedByUserId,
        visibilityLevel:    s.visibilityLevel,
        status:             ShareStatus.REVOKED,
        revokedAt:          now,
        revokedByUserId:    user.id,
      })),
      fa.createdByUserId ?? fa.ownerUserId
    );

    // ── 3b. Regenerate SpaceSnapshot for every space this account was active
    //       in — captured from fa.workspaceShares *before* the revocation
    //       above, since regenerateSnapshotsForAccounts() (used elsewhere)
    //       looks up ACTIVE shares and would find none here. Best-effort/
    //       non-fatal: a snapshot regen failure must never block the archive
    //       itself. See docs/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md.
    const affectedSpaceIds = [...new Set(fa.workspaceShares.map((s) => s.workspaceId))];
    for (const spaceId of affectedSpaceIds) {
      try {
        await regenerateSpaceSnapshot(spaceId);
      } catch (snapshotErr) {
        console.warn(`[DELETE /api/accounts/:id] snapshot regen failed for space ${spaceId} (non-fatal):`, snapshotErr);
      }
    }

    // ── 4. If this was a Plaid account, check whether we should revoke the item ──
    //    (see lib/plaid/disconnect.ts — extracted seam for future provider-agnostic
    //    disconnect dispatch; same count-then-itemRemove logic as before.)
    const plaidItemDbIds = fa.connections
      .filter((c) => c.plaidItemDbId)
      .map((c) => c.plaidItemDbId!);

    for (const plaidItemDbId of plaidItemDbIds) {
      await disconnectPlaidItemIfOrphaned(plaidItemDbId);
    }

    // ── 5. Audit log ──────────────────────────────────────────────────────────
    await db.auditLog.create({
      data: {
        userId:      user.id,
        spaceId: userShare.workspaceId, // WorkspaceAccountShare keeps its own pre-Phase-1 field name
        action:      "ACCOUNT_REMOVE",
        metadata:    { accountName: fa.name, accountType: fa.type },
        ipAddress:   getClientIp(req),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/accounts/:id]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}, "DELETE /api/accounts/[id]");
