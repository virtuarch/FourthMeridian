/**
 * lib/snapshots/regenerate.ts
 *
 * Regenerates today's SpaceSnapshot row for a space from current
 * FinancialAccount balances.
 *
 * Root cause this fixes: the Cash History / Banking History / Net Worth
 * charts (lib/data/snapshots.ts: getRecentSnapshots) read exclusively from
 * SpaceSnapshot. Before this file existed, the
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
import {
  readSpaceAccountsForSnapshot,
  type SnapshotAccountsClient,
} from "@/lib/snapshots/space-accounts";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { ShareStatus, PlaidInvestmentsConsent, type Prisma } from "@prisma/client";

function todayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * PS-1 — narrow injection seam for regenerateSpaceSnapshot, following the house
 * pattern (lib/plaid/sync-lock.ts#PlaidItemSyncLockClient). Defaults to the
 * shared Prisma client, so production behaviour is unchanged and every existing
 * caller keeps its current two-argument signature.
 *
 * It exists so the background-authority test can EXECUTE this function against
 * an in-memory fake rather than source-scan it. That distinction is the whole
 * lesson of PS-1: CONN-3's own test asserted the snapshot call appeared in the
 * webhook's source text, which it did — while throwing on every real
 * invocation. Wiring assertions cannot catch a runtime dependency failure.
 *
 * It extends SnapshotAccountsClient so ONE injected object covers every query
 * on the path. A seam that some queries honour and others bypass is worse than
 * none: it reads as isolated while silently hitting the real database.
 */
export interface SpaceSnapshotClient extends SnapshotAccountsClient {
  financialAccount: {
    findMany(args: {
      where:  Prisma.FinancialAccountWhereInput;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
  space: {
    findUnique(args: {
      where:  Prisma.SpaceWhereUniqueInput;
      select: { reportingCurrency: true };
    }): Promise<{ reportingCurrency: string } | null>;
  };
  spaceSnapshot: {
    upsert(args: Prisma.SpaceSnapshotUpsertArgs): Promise<unknown>;
  };
}

/**
 * Recomputes and upserts today's SpaceSnapshot row for one space from its
 * current FinancialAccount balances.
 *
 * PS-1 — the account read is the SYSTEM authority
 * (lib/snapshots/space-accounts.ts), not the viewer-scoped
 * getAccounts()/getSpaceContext() path this used to borrow. That borrowing is
 * what made this function throw "Not authenticated — no active session" on
 * every Plaid-webhook and cron invocation while silently succeeding on request
 * paths. The new read returns the same rows with the same values in the same
 * order (see that module's header for the field-level identity argument), so
 * this computation is unchanged — it simply no longer depends on a session
 * that background execution has no reason to possess.
 */
export async function regenerateSpaceSnapshot(
  spaceId: string,
  date: Date = todayUTC(),
  client: SpaceSnapshotClient = db,
): Promise<void> {
  const accounts = await readSpaceAccountsForSnapshot(spaceId, client);

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
        await client.financialAccount.findMany({
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

  // REG-1 (2026-07-15) — the former "Part-B2" cash/debt evidence gate was REMOVED.
  // It excluded any checking/savings/debt account with zero non-deleted
  // Transaction rows from TODAY's live snapshot, which silently dropped a real
  // balance-bearing account's cash from cash → totalAssets → netWorth (the
  // ~$9k regression: a low-activity savings account, a manual cash account, or an
  // account whose transactions were soft-deleted during a re-sync). Today's
  // snapshot must reconcile with the live KPI (renderNetWorth), which counts every
  // balance-bearing account — so the live writer no longer applies any transaction-
  // evidence filter. The legitimate "no vertical jump at connect" concern is a
  // HISTORICAL-lead-in concern, and is now handled honestly downstream: the
  // historical writers (backfill.ts / regenerate-history.ts) hold such an account
  // FLAT at its current balance across the window as an estimate
  // (isHeldFlatBalanceAccount, REG-2), producing a continuous chart instead of a
  // gap-then-jump. accountTier / classifyAccounts remain the sole inclusion +
  // aggregation authority. Part-B (investment-consent suppression above) is
  // unaffected: those accounts have NO fetched holdings, so there is genuinely no
  // value to include, unlike a cash account that carries a real balance.

  // MC1 Phase 3 Slice 3 — THE SNAPSHOT FLIP (plan seams #1, F-2). The context
  // target and the reportingCurrency stamp below both come from the same
  // Space read, atomically: they can never disagree. For every all-USD Space
  // this is numerically identical to the Phase 2 identity behavior
  // (equivalence gates); non-USD rows now convert for real at the latest
  // close, degrading per D-3 (native + estimated) when a rate is missing.
  const space = await client.space.findUnique({
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

  await client.spaceSnapshot.upsert({
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

  // PS-1 containment — SEQUENTIAL, not Promise.all.
  //
  // Until PS-1 this loop never actually ran to completion in background
  // execution: regenerateSpaceSnapshot threw inside its account read before
  // doing any snapshot work. Fixing that authority bug REACTIVATES real work
  // here — on the webhook and cron paths, and in jobs/sync-banks.ts once per
  // PlaidItem. Fanning that reactivated load out concurrently would add
  // simultaneous connection demand at exactly the moments production is
  // already tightest.
  //
  // Nothing is waiting on this: it runs after the response (webhook `after()`)
  // or inside a cron, so serial costs latency nobody observes and saves
  // concurrency that is genuinely scarce. Per-space results are independent —
  // each upserts its own (spaceId, date) row — so ordering changes no output.
  //
  // This is containment of the load PS-1 reactivates, NOT a capacity fix.
  // Pool sizing, connection limits and the wider concurrency picture are PS-2;
  // no other fan-out site was touched.
  //
  // ERROR SEMANTICS ARE PRESERVED EXACTLY. Promise.all starts every element and
  // rejects with the FIRST rejection — a failure on one space does not stop the
  // others from completing. A bare `for … await` would instead abandon every
  // remaining space at the first throw, which is a real behaviour change: fewer
  // spaces would be regenerated than before. So each space is attempted
  // independently and the first error is re-thrown after the loop, giving
  // callers the same "all attempted, first error propagates" contract with none
  // of the concurrency.
  let firstError: unknown;
  let failed = false;
  for (const id of spaceIds) {
    try {
      await regenerateSpaceSnapshot(id);
    } catch (e) {
      if (!failed) { firstError = e; failed = true; }
    }
  }
  if (failed) throw firstError;

  return spaceIds;
}
