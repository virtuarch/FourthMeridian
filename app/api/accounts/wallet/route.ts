/**
 * POST /api/accounts/wallet
 *
 * Manually adds a self-custodied crypto wallet to the user's workspace.
 * Balance starts at 0 — the sync job will populate it on next run.
 *
 * Creates:
 *   FinancialAccount   — canonical account row (ownerType=USER, no plaidAccountId)
 *   AccountConnection  — manual/wallet connection (no plaidItemDbId)
 *   WorkspaceAccountShare — makes the account visible in the active workspace
 *
 * Body: {
 *   name:          string   // display name, e.g. "Ledger BTC"
 *   walletAddress: string   // public wallet address
 *   walletChain:   string   // "BTC" | "ETH" | "SOL" | "MATIC" | etc.
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { AccountType, AccountOwnerType, ShareStatus, VisibilityLevel } from "@prisma/client";
import { requireUser } from "@/lib/session";

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

  const { workspaceId, userId } = await getWorkspaceContext();

  // Prevent duplicate wallet address across all FinancialAccounts owned by this user
  const existingFa = await db.financialAccount.findFirst({
    where: { ownerUserId: userId, walletAddress: walletAddress.trim(), deletedAt: null },
    select: { id: true },
  });
  if (existingFa) {
    // Check if it is already shared into this workspace
    const existingShare = await db.workspaceAccountShare.findFirst({
      where: { workspaceId, financialAccountId: existingFa.id, status: ShareStatus.ACTIVE },
    });
    if (existingShare) {
      return NextResponse.json({ error: "That wallet address is already connected." }, { status: 409 });
    }
    // Wallet exists but not in this workspace — re-share it rather than duplicating
    await db.workspaceAccountShare.upsert({
      where:  { workspaceId_financialAccountId: { workspaceId, financialAccountId: existingFa.id } },
      update: { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
      create: {
        workspaceId,
        financialAccountId: existingFa.id,
        addedByUserId:      userId,
        visibilityLevel:    VisibilityLevel.FULL,
        status:             ShareStatus.ACTIVE,
      },
    });
    return NextResponse.json({ success: true, accountId: existingFa.id }, { status: 200 });
  }

  // ── Create new FinancialAccount ────────────────────────────────────────────
  const fa = await db.financialAccount.create({
    data: {
      ownerType:     AccountOwnerType.USER,
      ownerUserId:   userId,
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
      workspaceId,
      financialAccountId: fa.id,
      addedByUserId:      userId,
      visibilityLevel:    VisibilityLevel.FULL,
      status:             ShareStatus.ACTIVE,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      workspaceId,
      action:   "WALLET_ADD",
      metadata: { name: fa.name, chain, address: walletAddress.trim() },
    },
  });

  return NextResponse.json({ success: true, accountId: fa.id }, { status: 201 });
}
