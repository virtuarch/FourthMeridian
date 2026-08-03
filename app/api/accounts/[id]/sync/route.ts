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
 *
 * CH-3 — per-user rate limit (6 / hour). NOT a Plaid-style per-item cooldown:
 * the risk this mitigates is a shared-IP explorer ban (every wallet sync leaves
 * Fourth Meridian's single server IP), not metered per-item cost — so a
 * generous per-user cap is the right shape, not a strict per-item one.
 * SYSTEM_ADMIN exempt, matching the house call-site idiom.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { limitByUser } from "@/lib/rate-limit";
import { syncBtcWallet, BTC_CHAIN } from "@/lib/crypto/btc-sync";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { regenerateWealthHistoryForAccounts } from "@/lib/snapshots/regenerate-history";
import { resolveHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  if (user.role !== "SYSTEM_ADMIN") {
    const limited = await limitByUser(user.id, "wallet-resync", { limit: 6, windowSec: 3600 });
    if (limited) return limited;
  }

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

  // V26-ORCH-1 — stamped BEFORE the sync so rows it writes fall at/after it,
  // which is what lets the planner MEASURE what changed instead of guessing.
  const syncStartedAt = new Date();
  const result = await syncBtcWallet(id);

  if (result.ok) {
    // Best-effort/non-fatal — same pattern as every other account-mutation path.
    try {
      await regenerateSnapshotsForAccounts([id]);
    } catch (snapshotErr) {
      console.warn(`[POST /api/accounts/${id}/sync] snapshot regen failed (non-fatal):`, snapshotErr);
    }
    // Part-2 — also regenerate the wealth HISTORY so the per-day valuation runs
    // for a real account sync, not just today's flat row. Best-effort/non-fatal;
    // gated on WEALTH_REGENERATION_ENABLED.
    //
    // V26-ORCH-1 — this used a FIXED 30-DAY window, silently narrower than the
    // Plaid item path's, so the same account got different history depending on
    // which trigger touched it. It now uses the canonical planner.
    //
    // SCOPE: planned for THIS account only, so syncing one account never
    // rebuilds unrelated accounts' floors. The regeneration itself is
    // Space-grained — SpaceSnapshot rows are shared — and the regenerator
    // already re-clamps per account, so a Space-level rebuild cannot invent days
    // an account did not have. The planned window and its reasons are logged so
    // that widening is attributable to this account's evidence.
    try {
      const plan = await resolveHistoricalWorkWindow({
        financialAccountIds: [id],
        changedSince:        syncStartedAt,
      });
      console.log(
        `[POST /api/accounts/${id}/sync] historical window ${plan.fromDate}..${plan.toDate} ` +
        `(${plan.mode}) — ${plan.reasons.join("; ")}`,
      );
      await regenerateWealthHistoryForAccounts([id], { fromDate: plan.fromDate, toDate: plan.toDate });
    } catch (wealthErr) {
      console.warn(`[POST /api/accounts/${id}/sync] wealth-history regen failed (non-fatal):`, wealthErr);
    }
  }

  // Account remains visible and "pending" on failure — report the outcome
  // honestly rather than pretending success.
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
