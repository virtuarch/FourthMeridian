/**
 * POST /api/accounts/[id]/sync
 *
 * Manual BTC wallet balance re-sync (BTC wallet sync v1). `id` is a
 * FinancialAccount.id. Owner-only: the account must belong to the caller.
 *
 * Refreshes confirmed balance + USD value via lib/crypto/btc-sync.ts, then
 * regenerates the space snapshot on success so Overview / Wealth / Liquidity
 * totals pick up the new balance. On explorer/price failure the account is
 * left visible and "pending" and an honest result is returned (502).
 *
 * Scope: BTC only. No xpub, no transaction import, no other chains, no schema
 * or SpaceAccountLink changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { syncBtcWallet, BTC_CHAIN } from "@/lib/crypto/btc-sync";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  const account = await db.financialAccount.findUnique({
    where: { id },
    select: { id: true, ownerUserId: true, walletChain: true, deletedAt: true },
  });

  // Owner-only, and no existence disclosure for accounts the user doesn't own.
  if (!account || account.ownerUserId !== user.id || account.deletedAt) {
    return NextResponse.json({ error: "Wallet not found." }, { status: 404 });
  }
  if (account.walletChain !== BTC_CHAIN) {
    return NextResponse.json({ error: "Only BTC wallet sync is supported." }, { status: 400 });
  }

  const result = await syncBtcWallet(id);

  if (result.ok) {
    // Best-effort/non-fatal — same pattern as every other account-mutation path.
    try {
      await regenerateSnapshotsForAccounts([id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/${id}/sync] snapshot regen failed (non-fatal):`, snapshotErr);
    }
  }

  // Account remains visible and "pending" on failure — report the outcome
  // honestly rather than pretending success.
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
