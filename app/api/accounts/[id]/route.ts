/**
 * app/api/accounts/[id]/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * DELETE — soft-deletes the FinancialAccount (sets deletedAt) and revokes all
 *          active WorkspaceAccountShare rows for the account.
 *          If the account was linked via Plaid and its AccountConnection was the
 *          last non-deleted connection on that PlaidItem, calls
 *          plaidClient.itemRemove() and marks the PlaidItem as REVOKED.
 *          Row preserved for history.
 *
 * PATCH  — updates mutable fields: creditLimit, debtSubtype, interestRate,
 *          minimumPayment (manual entry), and displayName (user-editable
 *          rename — never touches plaidName/officialName, which stay frozen
 *          at whatever Plaid returned at import time).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { plaidClient } from "@/lib/plaid/client";
import { decrypt } from "@/lib/plaid/encryption";
import { ShareStatus } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

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

    // ── 4. If this was a Plaid account, check whether we should revoke the item ──
    const plaidConnections = fa.connections.filter((c) => c.plaidItemDbId);

    for (const conn of plaidConnections) {
      // Count remaining non-deleted connections on this PlaidItem
      const remaining = await db.accountConnection.count({
        where: {
          plaidItemDbId: conn.plaidItemDbId,
          deletedAt:     null,
        },
      });

      if (remaining === 0 && conn.plaidItem) {
        try {
          const accessToken = decrypt(conn.plaidItem.encryptedToken);
          await plaidClient.itemRemove({ access_token: accessToken });
        } catch (plaidErr) {
          console.error("[DELETE /api/accounts/:id] Plaid itemRemove failed:", plaidErr);
        }

        await db.plaidItem.update({
          where: { id: conn.plaidItemDbId! },
          data:  { status: "REVOKED" },
        });
      }
    }

    // ── 5. Audit log ──────────────────────────────────────────────────────────
    await db.auditLog.create({
      data: {
        userId:      user.id,
        workspaceId: userShare.workspaceId,
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
