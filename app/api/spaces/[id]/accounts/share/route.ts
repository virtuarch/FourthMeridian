/**
 * POST   /api/spaces/[id]/accounts/share
 *   Share a FinancialAccount into this space.
 *   Body: { financialAccountId: string, visibilityLevel: "BALANCE_ONLY" | "FULL" }
 *
 * DELETE /api/spaces/[id]/accounts/share
 *   Revoke an active share.
 *   Body: { financialAccountId: string }
 *
 * Security:
 *  - Caller must be an ACTIVE member of the space.
 *  - The FinancialAccount must be owned by the caller (ownerUserId).
 *  - Only the user who added the share (addedByUserId) can revoke it, or an OWNER/ADMIN.
 */

import { NextRequest, NextResponse }                    from "next/server";
import { db }                                           from "@/lib/db";
import { ShareStatus, VisibilityLevel }                 from "@prisma/client";
import { requireSpaceAction } from "@/lib/spaces/authorize";
import { can } from "@/lib/spaces/policy";
import { withApiHandler, getClientIp } from "@/lib/api";
import { dualWriteSpaceAccountLink } from "@/lib/accounts/space-account-link";
import { emitDomainEvent, dispatchDomainEvent } from "@/lib/events/emit";
import { storedActivityAccountName } from "@/lib/activity/account-name-privacy";
import type { DomainEvent } from "@/lib/events/types";

// ─── POST ─────────────────────────────────────────────────────────────────────

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: spaceId } = await params;

  // Any ACTIVE member (any role) may share an account into the space.
  const [auth, err] = await requireSpaceAction(spaceId, "account:share");
  if (err) return err;
  const userId = auth.user.id;

  const body = await req.json() as {
    financialAccountId: string;
    visibilityLevel?:   string;
  };

  const { financialAccountId, visibilityLevel = "FULL" } = body;

  if (!financialAccountId) {
    return NextResponse.json({ error: "financialAccountId is required" }, { status: 400 });
  }

  // Validate visibility level
  const allowedLevels: string[] = [VisibilityLevel.BALANCE_ONLY, VisibilityLevel.FULL];
  if (!allowedLevels.includes(visibilityLevel)) {
    return NextResponse.json({ error: "Invalid visibilityLevel" }, { status: 400 });
  }

  // Verify the caller owns this FinancialAccount. type + debtSubtype are
  // selected for the P1-3 display-safe activity name below.
  const fa = await db.financialAccount.findUnique({
    where: { id: financialAccountId },
    select: { ownerUserId: true, deletedAt: true, name: true, type: true, debtSubtype: true },
  });

  if (!fa || fa.deletedAt) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "You do not own this account" }, { status: 403 });
  }

  // EV-1 Slice 2 — AccountShared. The AuditLog row is persisted inside the
  // transaction (KD-4: it commits together with the SAL write); the snapshot
  // handler runs post-commit via dispatchDomainEvent (best-effort, non-fatal).
  //
  // P1-3 — the persisted `accountName` is display-safe: for a non-FULL share it
  // is a generic typed label, never the real account name, so the activity feed
  // (and any other AuditLog consumer) can never surface a BALANCE_ONLY account's
  // real name to Space members.
  const event: DomainEvent = {
    type:        "AccountShared",
    spaceId,
    actorUserId: userId,
    ipAddress:   getClientIp(req),
    payload:     {
      financialAccountId,
      accountName: storedActivityAccountName(
        visibilityLevel as VisibilityLevel,
        fa.name,
        { type: fa.type, debtSubtype: fa.debtSubtype },
      ),
      visibilityLevel,
    },
  };

  // KD-4 Phase 3 — the share write (SAL upsert) and its audit row commit
  // together. Snapshot regen below stays OUTSIDE.
  // D3 Stage B3 — SpaceAccountLink is the sole write target.
  // Upsert the link — if one exists (even REVOKED), re-activate it.
  await db.$transaction(async (tx) => {
    await dualWriteSpaceAccountLink({
      spaceId,
      financialAccountId,
      client: tx,
      create: {
        addedByUserId:   userId,
        visibilityLevel: visibilityLevel as VisibilityLevel,
        status:          ShareStatus.ACTIVE,
      },
      update: {
        addedByUserId:   userId,
        visibilityLevel: visibilityLevel as VisibilityLevel,
        status:          ShareStatus.ACTIVE,
        revokedAt:       null,
        revokedByUserId: null,
      },
    });

    await emitDomainEvent(event, { tx });
  });

  // Post-commit: regenerate SpaceSnapshot now that this space has a new active
  // share (see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md).
  // Best-effort/non-fatal — dispatchDomainEvent isolates handler failures.
  await dispatchDomainEvent(event);

  return NextResponse.json({ ok: true }, { status: 201 });
}, "POST /api/spaces/[id]/accounts/share");

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: spaceId } = await params;

  // Door: any ACTIVE member (any role) may reach the account-share surface —
  // NOT "account:revoke", which is ADMIN-min and would wrongly block an
  // adder who is only a MEMBER. The OWNER/ADMIN privilege is applied in the
  // residual below via can("account:revoke", …).
  const [auth, err] = await requireSpaceAction(spaceId, "account:share");
  if (err) return err;
  const userId = auth.user.id;

  const body = await req.json() as { financialAccountId: string };
  const { financialAccountId } = body;

  if (!financialAccountId) {
    return NextResponse.json({ error: "financialAccountId is required" }, { status: 400 });
  }

  // D3 Stage B1/B3 — authorization and revoke write on SpaceAccountLink.
  // POST (above) also writes SpaceAccountLink exclusively as of Stage B3.
  const link = await db.spaceAccountLink.findUnique({
    where: { spaceId_financialAccountId: { spaceId, financialAccountId } },
    select: {
      status:          true,
      addedByUserId:   true,
      visibilityLevel: true,
      // type + debtSubtype for the P1-3 display-safe activity name below.
      financialAccount: { select: { name: true, type: true, debtSubtype: true } },
    },
  });

  if (!link || link.status !== ShareStatus.ACTIVE) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  // Residual: the adder may revoke their own share; otherwise OWNER/ADMIN
  // (can("account:revoke", …)) may revoke anyone's. Semantics preserved
  // exactly from the previous inline ["OWNER","ADMIN"].includes(role) check.
  const isPrivileged = can("account:revoke", auth.membership);
  if (link.addedByUserId !== userId && !isPrivileged) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const revokedAt = new Date();

  // EV-1 Slice 2 — AccountShareRevoked. AuditLog row persisted in-tx (KD-4);
  // snapshot handler runs post-commit via dispatchDomainEvent (best-effort).
  //
  // P1-3 — the persisted `accountName` is display-safe (generic typed label for
  // a non-FULL link's revoke), and `visibilityLevel` is now carried so the
  // activity renderer can fail closed on this row too.
  const event: DomainEvent = {
    type:        "AccountShareRevoked",
    spaceId,
    actorUserId: userId,
    ipAddress:   getClientIp(req),
    payload:     {
      financialAccountId,
      accountName: link.financialAccount
        ? storedActivityAccountName(
            link.visibilityLevel,
            link.financialAccount.name,
            { type: link.financialAccount.type, debtSubtype: link.financialAccount.debtSubtype },
          )
        : null,
      visibilityLevel: link.visibilityLevel,
    },
  };

  // KD-4 Phase 3 — the revoke write and its audit row commit together.
  // Snapshot regen below stays OUTSIDE.
  await db.$transaction(async (tx) => {
    await tx.spaceAccountLink.update({
      where: { spaceId_financialAccountId: { spaceId, financialAccountId } },
      data: {
        status:          ShareStatus.REVOKED,
        revokedAt,
        revokedByUserId: userId,
      },
    });

    await emitDomainEvent(event, { tx });
  });

  // Post-commit: regenerate SpaceSnapshot now that this space lost an active
  // share (see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md).
  // Best-effort/non-fatal — dispatchDomainEvent isolates handler failures.
  await dispatchDomainEvent(event);

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/accounts/share");
