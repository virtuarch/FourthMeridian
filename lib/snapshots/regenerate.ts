/**
 * lib/snapshots/regenerate.ts
 *
 * Regenerates today's SpaceSnapshot row for a space from current
 * FinancialAccount balances.
 *
 * Root cause this fixes: the Cash History / Banking History / Net Worth
 * charts (lib/data/snapshots.ts: getRecentSnapshots, getPortfolioHistory)
 * read exclusively from SpaceSnapshot. Before this file existed, the
 * only code path that ever wrote a SpaceSnapshot row was prisma/seed.ts
 * — there was no production writer, so real (non-seeded) spaces had no
 * rows and the charts rendered blank regardless of how fresh balances or
 * transactions were.
 *
 * Call this after any balance-changing operation. It's wired into
 * lib/plaid/refresh.ts today (manual Refresh button, and — unchanged at
 * call sites — the future cron/webhook that reuse the same function).
 *
 * Idempotent: upserts on the [spaceId, date] unique constraint, so
 * calling it multiple times in one day updates that day's row instead of
 * creating duplicates.
 *
 * totalAssets/netWorth = stocks + crypto + cash + savings + realAssets
 * (± debt). realAssets (AccountType.other — manual/real assets: property,
 * vehicles, equipment) is included here even though the SpaceSnapshot
 * schema field comments predate this and only mention stocks/crypto/cash/
 * savings. Without it, this formula silently diverged from
 * classifyAccounts() (lib/account-classifier.ts), the single source of
 * truth every live dashboard total uses, so a Space's /dashboard/spaces
 * card could never reflect manual assets no matter how often this
 * function ran. netLiquid intentionally still excludes realAssets —
 * manual assets aren't liquid.
 */

import { db } from "@/lib/db";
import { getAccounts } from "@/lib/data/accounts";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { ShareStatus, PlaidInvestmentsConsent } from "@prisma/client";

function todayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Recomputes and upserts today's SpaceSnapshot row for one space
 * from its current FinancialAccount balances (via getAccounts, the same
 * live data source the dashboard's "Banking" card already renders from).
 */
export async function regenerateSpaceSnapshot(
  spaceId: string,
  date: Date = todayUTC(),
): Promise<void> {
  const accounts = await getAccounts({ spaceId });

  // Part-B — exclude investment accounts still pending Investments consent
  // (CONSENT_REQUIRED): holdings were never fetched, so there is no real
  // per-holding value or history for them. Baking today's account-level balance
  // into the net-worth snapshot injects a misleading vertical JUMP with no
  // historical lead-up (the "net worth jumps at connect" bug). The account's
  // balance still shows on its card + EnableInvestmentsButton prompts the user;
  // once consent is granted the full pipeline reconstructs real history and the
  // account enters the trend smoothly. Suppress-until-consent (chosen over a
  // distinct "today dot", which needs new chart code) — honestly omits the
  // account until we have real data, rather than fabricating a jump.
  let eligible = accounts;
  if (accounts.length > 0) {
    const gated = new Set(
      (
        await db.financialAccount.findMany({
          where: {
            id:          { in: accounts.map((a) => a.id) },
            type:        "investment",
            connections: { some: { plaidItem: { investmentsConsent: PlaidInvestmentsConsent.CONSENT_REQUIRED } } },
          },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    if (gated.size > 0) {
      eligible = accounts.filter((a) => !gated.has(a.id));
      console.log(`[snapshot] space ${spaceId}: excluding ${gated.size} consent-pending investment account(s) from the snapshot (no fabricated jump).`);
    }
  }

  // Part-B2 — the same "no fabricated jump" principle, applied to cash/debt.
  // backfill.ts (and A9's regenerate-history.ts, once fixed) floor an account's
  // reconstructable history at its EARLIEST real Transaction — an account with
  // zero transactions synced so far has a floor of "today" and is therefore
  // excluded from every historical day. If the live writer includes that same
  // account's current balance right away, the Space's total shows a vertical
  // jump the very first time the chart renders (today's dot appears with no
  // history behind it) — reported 2026-07-14 as an unexplained ~$10k jump.
  // Mirrors Part-B: suppress-until-evidence, not a fabricated flat lead-in.
  // Self-resolving — the very next transaction sync (same connect pipeline, or
  // the next daily cron) gives the account ≥1 transaction and this stops
  // applying on its own; nothing to reverse manually. Scoped to checking/
  // savings/debt only — investment/crypto/real-asset accounts are legitimately
  // valued from holdings/manual entry, not transactions, so "zero Transaction
  // rows" is normal for them and must not suppress them here.
  if (eligible.length > 0) {
    const cashDebtIds = eligible
      .filter((a) => a.type === "checking" || a.type === "savings" || a.type === "debt")
      .map((a) => a.id);
    if (cashDebtIds.length > 0) {
      const withTx = await db.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: cashDebtIds }, deletedAt: null },
      });
      const hasTx = new Set(withTx.map((g) => g.financialAccountId).filter((id): id is string => id !== null));
      const noEvidence = new Set(cashDebtIds.filter((id) => !hasTx.has(id)));
      if (noEvidence.size > 0) {
        eligible = eligible.filter((a) => !noEvidence.has(a.id));
        console.log(`[snapshot] space ${spaceId}: excluding ${noEvidence.size} cash/debt account(s) with no synced transactions yet from the snapshot (no fabricated jump).`);
      }
    }
  }

  // MC1 Phase 3 Slice 3 — THE SNAPSHOT FLIP (plan seams #1, F-2). The context
  // target and the reportingCurrency stamp below both come from the same
  // Space read, atomically: they can never disagree. For every all-USD Space
  // this is numerically identical to the Phase 2 identity behavior
  // (equivalence gates); non-USD rows now convert for real at the latest
  // close, degrading per D-3 (native + estimated) when a rate is missing.
  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  if (!space) return; // space vanished mid-call — nothing to snapshot

  const ctx = await buildSpaceConversionContext(space, {
    currencies: eligible.map((a) => a.currency ?? null),
    dates:      [yesterdayUTCISO()],
  });
  const c = classifyAccounts(eligible, ctx);

  const stocks     = c.totalInvestments;
  const crypto     = c.totalDigitalAssets;
  const total      = stocks + crypto;
  const cash       = c.totalChecking;
  const savings    = c.totalSavings;
  const debt       = c.totalLiabilities;
  const realAssets = c.totalRealAssets;

  const totalAssets = total + cash + savings + realAssets;
  const netWorth    = totalAssets - debt;
  const netLiquid   = cash + savings - debt;
  // No "expense buffer" setting exists yet (schema comment: max(cash -
  // expense_buffer, 0)) — until one is added, cashOnHand is plain checking
  // cash rather than an invented buffer amount.
  const cashOnHand  = Math.max(cash, 0);

  // MC1 Phase 3 Slice 3 (F-2) — the stamp IS the context target: both come
  // from the same Space read above, in the same edit, so they can never
  // disagree. Existing rows keep their stamps (forward-only, plan D-4); only
  // today's upserted row carries the current value. SpaceSnapshot.isEstimated
  // keeps its D2.x reconstruction meaning — currency estimation is NOT
  // written to snapshots (approved D-7; Phase 4 open item).
  const reportingCurrency = space.reportingCurrency;

  await db.spaceSnapshot.upsert({
    where: { spaceId_date: { spaceId, date } },
    create: {
      spaceId, date,
      stocks, crypto, total, cash, savings, debt,
      netWorth, totalAssets, netLiquid, cashOnHand,
      reportingCurrency,
    },
    update: {
      stocks, crypto, total, cash, savings, debt,
      netWorth, totalAssets, netLiquid, cashOnHand,
      reportingCurrency,
    },
  });
}

/**
 * Regenerates snapshots for every space that links any of the given
 * FinancialAccount ids via an ACTIVE SpaceAccountLink. Used by the
 * Plaid refresh pipeline so refreshing one item keeps every space it's
 * shared into up to date — not just a single "current" space.
 *
 * D3 Step 4A read cutover: this used to query WorkspaceAccountShare.
 * SpaceAccountLink is kept in sync with it by the D3 Step 3 dual-write
 * (lib/accounts/space-account-link.ts) at every mutation site, so this
 * read returns the same space ids either way. WorkspaceAccountShare
 * remains the write system of record — see
 * docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md for the cutover plan and rollback.
 *
 * @returns the distinct space ids that were regenerated.
 */
export async function regenerateSnapshotsForAccounts(
  financialAccountIds: string[],
): Promise<string[]> {
  if (financialAccountIds.length === 0) return [];

  const links = await db.spaceAccountLink.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
    select: { spaceId: true },
  });

  const spaceIds = [...new Set(links.map((l) => l.spaceId))];
  await Promise.all(spaceIds.map((id) => regenerateSpaceSnapshot(id)));
  return spaceIds;
}
