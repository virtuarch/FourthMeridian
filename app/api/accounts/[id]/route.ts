/**
 * app/api/accounts/[id]/route.ts
 *
 * DELETE — soft-deletes an account (sets deletedAt). Row preserved for history.
 *          If the account was linked via Plaid and it was the last account on
 *          that PlaidItem, calls plaidClient.itemRemove() to revoke access and
 *          marks the PlaidItem as REVOKED.
 *
 * PATCH  — updates mutable fields: creditLimit (manual entry).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { plaidClient } from "@/lib/plaid/client";
import { decrypt } from "@/lib/plaid/encryption";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  try {
    const body = await req.json();
    // Only allow updating creditLimit for now
    const { creditLimit } = body;
    // Allow null (clears limit back to charge-card mode) or a positive number
    if (
      creditLimit !== undefined &&
      creditLimit !== null &&
      (typeof creditLimit !== "number" || creditLimit <= 0)
    ) {
      return NextResponse.json({ error: "Invalid creditLimit" }, { status: 400 });
    }

    const account = await db.account.findUnique({ where: { id } });
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.account.update as any)({
      where: { id },
      data: { ...(creditLimit !== undefined && { creditLimit }) },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /api/accounts/:id]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  // Auth guard — user must own this account's workspace
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Fetch account with its PlaidItem so we can revoke if needed
    const account = await db.account.findUnique({
      where: { id },
      include: { plaidItem: true },
    });

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Verify the account belongs to the session user's workspace
    const membership = await db.workspaceMember.findFirst({
      where: {
        userId: session.user.id,
        workspaceId: account.workspaceId,
      },
    });
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── 1. Soft-delete the account ────────────────────────────────────────────
    await db.account.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // ── 2. If this was a Plaid account, check whether we should revoke ────────
    if (account.plaidItemDbId && account.plaidItem) {
      const remaining = await db.account.count({
        where: {
          plaidItemDbId: account.plaidItemDbId,
          deletedAt: null,              // only non-deleted accounts
        },
      });

      if (remaining === 0) {
        // Last account on this PlaidItem — revoke with Plaid and mark REVOKED
        try {
          const accessToken = decrypt(account.plaidItem.encryptedToken);
          await plaidClient.itemRemove({ access_token: accessToken });
        } catch (plaidErr) {
          // Log but don't fail the request — the account is already soft-deleted.
          // Plaid will also expire unused tokens eventually.
          console.error("[DELETE /api/accounts/:id] Plaid itemRemove failed:", plaidErr);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db.plaidItem.update as any)({
          where: { id: account.plaidItemDbId },
          data: { status: "REVOKED" },
        });
      }
    }

    // ── 3. Audit log ──────────────────────────────────────────────────────────
    await db.auditLog.create({
      data: {
        userId:      session.user.id,
        workspaceId: account.workspaceId,
        action:      "ACCOUNT_REMOVE",
        metadata:    { accountName: account.name, accountType: account.type },
        ipAddress:   (req as NextRequest).headers?.get("x-forwarded-for") ?? "unknown",
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/accounts/:id]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
