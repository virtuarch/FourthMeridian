/**
 * POST /api/accounts/wallet
 *
 * Manually adds a self-custodied crypto wallet to the user's workspace.
 * Balance starts at 0 — the sync job will populate it on next run.
 *
 * Body: {
 *   name:          string   // display name, e.g. "Ledger BTC"
 *   walletAddress: string   // public wallet address
 *   walletChain:   string   // "BTC" | "ETH" | "SOL" | "MATIC" | etc.
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { AccountType } from "@prisma/client";

const SUPPORTED_CHAINS = ["BTC", "ETH", "SOL", "MATIC", "AVAX", "DOT", "ADA", "XRP", "OTHER"];

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, walletAddress, walletChain } = await req.json();

  if (!name?.trim())          return NextResponse.json({ error: "Wallet name is required." },    { status: 400 });
  if (!walletAddress?.trim()) return NextResponse.json({ error: "Wallet address is required." }, { status: 400 });
  if (!walletChain?.trim())   return NextResponse.json({ error: "Chain is required." },          { status: 400 });

  const chain = walletChain.toUpperCase();
  if (!SUPPORTED_CHAINS.includes(chain)) {
    return NextResponse.json({ error: `Unsupported chain. Use: ${SUPPORTED_CHAINS.join(", ")}` }, { status: 400 });
  }

  // Prevent duplicate wallet address in this workspace
  const { workspaceId, userId } = await getWorkspaceContext();

  const existing = await db.account.findFirst({
    where: { workspaceId, walletAddress: walletAddress.trim() },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: "That wallet address is already connected." }, { status: 409 });
  }

  const account = await db.account.create({
    data: {
      workspaceId,
      ownerId:       userId,
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

  await db.auditLog.create({
    data: {
      userId,
      workspaceId,
      action:   "WALLET_ADD",
      metadata: { name: account.name, chain, address: walletAddress.trim() },
    },
  });

  return NextResponse.json({ success: true, accountId: account.id }, { status: 201 });
}
