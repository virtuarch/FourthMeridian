/**
 * POST /api/accounts/[id]/sync
 *
 * Manual self-custody wallet balance re-sync. `id` is a FinancialAccount.id.
 * Owner-only: the account must belong to the caller.
 *
 * W-M1d — DISPATCHED BY CHAIN. This route used to name Bitcoin and reject
 * everything else ("Only BTC wallet sync is supported"), which made adding a
 * chain a route edit. It now asks the ONE registry
 * (lib/crypto/wallet-sync-dispatch.ts) which adapter serves the account's chain,
 * and what that chain can honestly claim. The route itself names no chain.
 *
 * Refreshes the wallet's balance through its adapter, then regenerates the space
 * snapshot on success so Overview / Wealth / Liquidity pick up the change. On
 * provider failure the account is left visible and "pending" and an honest
 * result is returned (502).
 *
 * WEALTH HISTORY is regenerated only for a HISTORY_SUPPORTED chain — today BTC
 * alone. A chain with no movement ledger has no historical quantity to derive,
 * and regenerating it would refuse every day.
 *
 * NET WORTH: BTC still contributes through the legacy `FinancialAccount.balance`
 * column. ETH and SOL do not — their adapters write no balance column, so their
 * value lives only on the dated position spine until the wallet net-worth
 * convergence lands. The outcome states which applies rather than leaving the
 * caller to infer it.
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
import {
  syncWalletByChain, isSyncableChain, chainSupportsHistory, SYNCABLE_CHAINS,
} from "@/lib/crypto/wallet-sync-dispatch";
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
  // UNSUPPORTED CHAINS STAY EXPLICITLY UNSUPPORTED. Account creation accepts a
  // wider set of chain labels than this system can read, deliberately: recording
  // custody and being able to read the chain are different capabilities. A
  // wallet on an unreadable chain is refused HERE, by name, rather than being
  // handed to an adapter that does not exist — or worse, quietly reporting a
  // successful sync of nothing.
  if (!isSyncableChain(account.walletChain)) {
    return NextResponse.json({
      error: `Balance sync is not available for ${account.walletChain ?? "this"} wallets yet. ` +
             `Supported: ${SYNCABLE_CHAINS.join(", ")}.`,
    }, { status: 400 });
  }

  // V26-ORCH-1 — stamped BEFORE the sync so rows it writes fall at/after it,
  // which is what lets the planner MEASURE what changed instead of guessing.
  const syncStartedAt = new Date();
  // PLATFORM OPS OBSERVABILITY — the owner pressed Sync: a MANUAL execution in
  // the refresh ledger, so the run, its duration and its verdict are inspectable.
  const result = await syncWalletByChain(id, account.walletChain, { trigger: "MANUAL" });

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
    //
    // W-M1d — HISTORY_SUPPORTED CHAINS ONLY. A balance-only chain has no
    // movement ledger, so there is no historical quantity to derive and every
    // day would refuse. Skipping is the honest outcome; the current position is
    // already on the canonical spine either way.
    // W6f — THE GATE WAS DEAD. This asked `feedsLegacyWealthHistory`, which W6c
    // emptied for every chain when Bitcoin's historical authority moved onto the
    // spine — so from that commit until this one, pressing Sync regenerated no
    // history at all. The comment above already described the intent correctly:
    // HISTORY_SUPPORTED chains only. It now asks that question instead of the
    // storage question that used to answer it by coincidence.
    if (chainSupportsHistory(account.walletChain)) try {
      const plan = await resolveHistoricalWorkWindow({
        financialAccountIds: [id],
        changedSince:        syncStartedAt,
        // The reconstruction's own measured boundary, when it changed stored history.
        positionHistoryImpactedFromISO: result.historyRefresh?.impactedFromISO,
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
