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
import { disconnectAccounts } from "@/lib/accounts/disconnect";

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
    // Fetch the account for the existence check + audit metadata (name/type).
    // The Plaid-item orphan revocation is handled inside disconnectAccounts.
    const fa = await db.financialAccount.findUnique({
      where:  { id },
      select: { id: true, name: true, type: true },
    });

    if (!fa) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // D3 Stage A — authorization read on SpaceAccountLink.
    const userLink = await db.spaceAccountLink.findFirst({
      where: {
        financialAccountId: id,
        addedByUserId:      user.id,
        status:             ShareStatus.ACTIVE,
      },
      select: { spaceId: true },
    });
    if (!userLink) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Soft-disconnect via the ONE shared primitive (CONN-4A) — soft-delete
    //    the account + its connections, revoke ACTIVE SALs, regenerate today's
    //    snapshot per affected space, and revoke the Plaid item when orphaned.
    //    Same behavior as before; now shared with the connection-level route.
    await disconnectAccounts([id], user.id);

    // ── Audit log ──────────────────────────────────────────────────────────────
    await db.auditLog.create({
      data: {
        userId:      user.id,
        spaceId: userLink.spaceId,
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
