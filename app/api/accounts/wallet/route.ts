/**
 * POST /api/accounts/wallet
 *
 * Manually adds a self-custodied crypto wallet to the user's space.
 * Balance starts at 0 — the sync job will populate it on next run.
 *
 * Creates:
 *   FinancialAccount   — canonical account row (ownerType=USER, no plaidAccountId)
 *   AccountConnection  — manual/wallet connection (no plaidItemDbId)
 *   WorkspaceAccountShare — makes the account visible in the active space
 *
 * Body: {
 *   name:          string   // display name, e.g. "Ledger BTC"
 *   walletAddress: string   // public wallet address
 *   walletChain:   string   // "BTC" | "ETH" | "SOL" | "MATIC" | etc.
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, DuplicateDetectionSource } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { AuditAction } from "@/lib/audit-actions";
import { mergeArchivedDuplicateIntoCanonical } from "@/lib/accounts/reconcile";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { dualWriteSpaceAccountLink, ensureHomeLink } from "@/lib/accounts/space-account-link";

const SUPPORTED_CHAINS = ["BTC", "ETH", "SOL", "MATIC", "AVAX", "DOT", "ADA", "XRP", "OTHER"];

export async function POST(req: NextRequest) {
  const [, err] = await requireUser();
  if (err) return err;

  const { name, walletAddress, walletChain } = await req.json();

  if (!name?.trim())          return NextResponse.json({ error: "Wallet name is required." },    { status: 400 });
  if (!walletAddress?.trim()) return NextResponse.json({ error: "Wallet address is required." }, { status: 400 });
  if (!walletChain?.trim())   return NextResponse.json({ error: "Chain is required." },          { status: 400 });

  const chain = walletChain.toUpperCase();
  if (!SUPPORTED_CHAINS.includes(chain)) {
    return NextResponse.json({ error: `Unsupported chain. Use: ${SUPPORTED_CHAINS.join(", ")}` }, { status: 400 });
  }

  const { spaceId, userId } = await getSpaceContext();

  // ── Automatic duplicate reconciliation ────────────────────────────────────
  // Same provider-identity check as Plaid reconnect: never create a second
  // visible row for a wallet address that already has one, and never show
  // the user a conflict — just reuse/reactivate the existing account.
  const activeFa = await db.financialAccount.findFirst({
    where: { ownerUserId: userId, walletAddress: walletAddress.trim(), deletedAt: null },
    select: { id: true },
  });

  if (activeFa) {
    // Already exists and active — re-share into this space if needed and
    // return success silently. No 409, no "already connected" message.
    await db.workspaceAccountShare.upsert({
      // WorkspaceAccountShare keeps its own pre-Phase-1 field/key names.
      where:  { workspaceId_financialAccountId: { workspaceId: spaceId, financialAccountId: activeFa.id } },
      update: { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
      create: {
        workspaceId: spaceId,
        financialAccountId: activeFa.id,
        addedByUserId:      userId,
        visibilityLevel:    VisibilityLevel.FULL,
        status:             ShareStatus.ACTIVE,
      },
    });

    // walletAddress has no DB-level unique constraint, so an archived row
    // for this same address can exist alongside the active one (e.g. a
    // previous soft-delete that never got cleaned up). Before this fix,
    // that archived row was left permanently orphaned — nothing ever found
    // or merged it, since this branch returned immediately. Fold it into
    // the active row now, the same way the restore routes do.
    const archivedDup = await db.financialAccount.findFirst({
      where: { ownerUserId: userId, walletAddress: walletAddress.trim(), deletedAt: { not: null } },
      select: { id: true },
    });
    if (archivedDup) {
      await mergeArchivedDuplicateIntoCanonical(
        archivedDup.id,
        activeFa.id,
        DuplicateDetectionSource.PROVIDER_IDENTITY_MATCH,
        spaceId
      );
    }

    return NextResponse.json({ success: true, accountId: activeFa.id }, { status: 200 });
  }

  // No active match — but a previously soft-deleted wallet with this address
  // would otherwise fall through to create() below and become a genuine
  // second row (walletAddress has no DB-level unique constraint). Reactivate
  // it instead of creating a duplicate.
  const archivedFa = await db.financialAccount.findFirst({
    where: { ownerUserId: userId, walletAddress: walletAddress.trim(), deletedAt: { not: null } },
    select: { id: true },
  });

  if (archivedFa) {
    await db.financialAccount.update({
      where: { id: archivedFa.id },
      data:  { deletedAt: null, syncStatus: "pending" },
    });
    await db.accountConnection.updateMany({
      where: { financialAccountId: archivedFa.id, deletedAt: { not: null } },
      data:  { deletedAt: null },
    });
    await db.workspaceAccountShare.upsert({
      // WorkspaceAccountShare keeps its own pre-Phase-1 field/key names.
      where:  { workspaceId_financialAccountId: { workspaceId: spaceId, financialAccountId: archivedFa.id } },
      update: { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
      create: {
        workspaceId: spaceId,
        financialAccountId: archivedFa.id,
        addedByUserId:      userId,
        visibilityLevel:    VisibilityLevel.FULL,
        status:             ShareStatus.ACTIVE,
      },
    });

    // D3 Step 3 — mirror onto SpaceAccountLink (best-effort, non-fatal).
    // No creatorUserId passed: archivedFa is selected as {id: true} only, so
    // dualWriteSpaceAccountLink resolves the creator itself.
    await dualWriteSpaceAccountLink({
      spaceId,
      financialAccountId: archivedFa.id,
      create: {
        addedByUserId:   userId,
        visibilityLevel: VisibilityLevel.FULL,
        status:          ShareStatus.ACTIVE,
      },
      update: {
        status:          ShareStatus.ACTIVE,
        revokedAt:       null,
        revokedByUserId: null,
      },
    });

    // Regenerate SpaceSnapshot now that the share is active again — see
    // docs/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md. Best-effort/non-fatal.
    try {
      await regenerateSnapshotsForAccounts([archivedFa.id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/wallet] snapshot regen failed for account ${archivedFa.id} (non-fatal):`, snapshotErr);
    }

    await db.auditLog.create({
      data: {
        userId,
        spaceId,
        action:   AuditAction.ACCOUNT_RESTORE,
        metadata: { name: name.trim(), chain, address: walletAddress.trim() },
      },
    });
    return NextResponse.json({ success: true, accountId: archivedFa.id }, { status: 200 });
  }

  // ── Create new FinancialAccount ────────────────────────────────────────────
  const fa = await db.financialAccount.create({
    data: {
      ownerType:     AccountOwnerType.USER,
      ownerUserId:   userId,
      createdByUserId: userId, // D11 — human-accountable creator
      name:          name.trim(),
      type:          AccountType.crypto,
      institution:   "Self-custodied",
      balance:       0,
      currency:      "USD",
      walletAddress: walletAddress.trim(),
      walletChain:   chain,
      nativeBalance: 0,
      syncStatus:    "pending",
    },
  });

  // ── Create AccountConnection (manual, no PlaidItem) ────────────────────────
  await db.accountConnection.create({
    data: {
      financialAccountId: fa.id,
      connectedByUserId:  userId,
      syncStatus:         "pending",
      isCanonical:        true,
    },
  });

  // ── Create WorkspaceAccountShare ───────────────────────────────────────────
  await db.workspaceAccountShare.create({
    data: {
      // WorkspaceAccountShare keeps its own pre-Phase-1 field name.
      workspaceId: spaceId,
      financialAccountId: fa.id,
      addedByUserId:      userId,
      visibilityLevel:    VisibilityLevel.FULL,
      status:             ShareStatus.ACTIVE,
    },
  });

  // D3 Step 3 — mirror onto SpaceAccountLink (best-effort, non-fatal).
  await dualWriteSpaceAccountLink({
    spaceId,
    financialAccountId: fa.id,
    creatorUserId:       fa.createdByUserId ?? fa.ownerUserId,
    create: {
      addedByUserId:   userId,
      visibilityLevel: VisibilityLevel.FULL,
      status:          ShareStatus.ACTIVE,
    },
    update: {
      status:          ShareStatus.ACTIVE,
      revokedAt:       null,
      revokedByUserId: null,
    },
  });
  // Rule 4 — spaceId here is getSpaceContext()'s active space, which may not
  // be the creator's personal space. This is a brand-new account, so ensure
  // it still ends up with exactly one HOME link.
  await ensureHomeLink({ financialAccountId: fa.id, creatorUserId: userId, excludeSpaceId: spaceId });

  await db.auditLog.create({
    data: {
      userId,
      spaceId,
      action:   "WALLET_ADD",
      metadata: { name: fa.name, chain, address: walletAddress.trim() },
    },
  });

  return NextResponse.json({ success: true, accountId: fa.id }, { status: 201 });
}
