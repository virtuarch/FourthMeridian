/**
 * lib/snapshots/backfill.ts
 *
 * D2.x Slice 4 — historical SpaceSnapshot backfill (DB orchestration).
 *
 * Reconstructs up to 30 days of daily snapshots for a GENUINELY NEW Space
 * immediately after its first-run transaction history has synced. Cash is
 * walked backward from today's real balances using raw signed transaction
 * amounts (see backfill-core.ts); investments/crypto/manual assets/loans are
 * held flat at today's value; the whole series is aggregated through the same
 * classifyAccounts() the live snapshot uses, so it stays internally consistent.
 *
 * Account set: queried directly from ACTIVE SpaceAccountLink (not via
 * lib/data/accounts.getAccounts) so this module stays free of the `server-only`
 * import chain and can run from a plain `tsx` script. Parity is preserved:
 * getAccountsWithVisibility returns the real balance + type for every ACTIVE,
 * non-deleted link regardless of visibility level (visibility only redacts
 * names/metadata, which snapshots never use), so the {id,type,balance} set —
 * and therefore every classifyAccounts total — is identical.
 *
 * Invariants (all preserved here):
 *  - New-Space gate: runs only when the Space has ≤ 1 existing snapshot.
 *  - Never overwrites — create-if-absent via createMany({ skipDuplicates: true })
 *    on the @@unique([spaceId, date]) key. Idempotent; re-runs are no-ops.
 *  - Excludes today (the authoritative LIVE row written by regenerateSpaceSnapshot).
 *  - Floors reconstruction at each account's FinancialAccount.createdAt /
 *    SpaceAccountLink.createdAt so it never asserts an account existed earlier.
 *  - regenerateSpaceSnapshot is untouched. No FlowType. No SyncJob/queue.
 */

import { db } from "@/lib/db";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { ShareStatus } from "@prisma/client";
import {
  reconstructDailyCashBalances,
  reconstructDailyLiabilityBalances,
  computeSnapshotFields,
  truncDateUTC,
  addDaysUTC,
  maxDate,
  isoDate,
  fromISO,
  type CashAccountBalance,
} from "@/lib/snapshots/backfill-core";

/**
 * D2.x Slice 4B — is this debt account a reconstructable revolving credit card?
 *
 * Plaid import never writes debtSubtype (exchangeToken.ts), so Plaid cards have
 * debtSubtype = null. We therefore accept an explicit credit_card OR a
 * null-subtype debt account that carries a creditLimit (the only stored
 * revolving-credit signal). Any account with an explicit NON-card subtype
 * (line_of_credit, heloc, mortgage, auto_loan, student_loan, personal_loan, …)
 * is excluded and stays flat.
 *
 * Known caveat: a Plaid line_of_credit / HELOC also has a null subtype + a
 * limit, so it would be included here — those are revolving and transaction-
 * driven, so the walk is still directionally correct, but to strictly exclude
 * one, set its FinancialAccount.debtSubtype to a non-"credit_card" value.
 * Installment loans (no limit) are naturally excluded. Never touches non-debt.
 */
function isReconstructableCard(a: {
  type:        string;
  debtSubtype: string | null;
  creditLimit: number | null;
}): boolean {
  if (a.type !== "debt") return false;
  if (a.debtSubtype === "credit_card") return true;
  if (a.debtSubtype === null && a.creditLimit != null) return true;
  return false;
}

const BACKFILL_DAYS = 30;

function todayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Backfills historical snapshots for one Space. Returns the number of rows
 * written (0 when gated out / nothing to reconstruct). Safe to call anywhere;
 * callers wrap it best-effort.
 *
 * Options (all additive; defaults preserve the exact app-runtime behavior — the
 * app path passes no options, so this stays byte-for-byte unchanged):
 *  - ignoreNewSpaceGate: skip the ≤1-snapshot new-Space gate (the manual
 *    --force-missing-estimated-all / --dev-seed-target-spaces-30d runners set
 *    this). Existing rows are STILL never overwritten — only missing past dates
 *    are written.
 *  - ignoreFloors: DEV-SEED ONLY. Collapse account/link createdAt floors so the
 *    full 30-day window reconstructs even for recently-created accounts. Never
 *    set on the app path.
 *  - dryRun: compute the rows but do NOT write; return how many rows WOULD be
 *    inserted. Used by the runners' dry-run preview.
 *
 * The reconstruction algorithm (cash walk, non-cash flat, classifyAccounts,
 * exclude-today, never-overwrite) is identical regardless of options.
 */
export async function backfillSpaceSnapshots(
  spaceId: string,
  opts?: { ignoreNewSpaceGate?: boolean; ignoreFloors?: boolean; dryRun?: boolean },
): Promise<number> {
  // Existing rows for this Space — used for the new-Space gate AND to skip any
  // date that already has a row (belt-and-suspenders with createMany's
  // skipDuplicates, and makes the dry-run count exact = missing dates only).
  const existingRows = await db.spaceSnapshot.findMany({
    where:  { spaceId },
    select: { date: true },
  });
  // New-Space gate — only today's LIVE row (or none) may exist. Bypassable.
  if (!opts?.ignoreNewSpaceGate && existingRows.length > 1) return 0;
  const existingDates = new Set(existingRows.map((r) => isoDate(r.date)));

  // Script-safe account set + floors in one query (mirrors getAccounts' ACTIVE,
  // non-deleted link set; real balance/type per link — see module header).
  const linkRows = await db.spaceAccountLink.findMany({
    where:  { spaceId, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
    select: {
      createdAt:        true,
      financialAccount: {
        select: {
          id: true, type: true, balance: true, createdAt: true,
          // MC1 Phase 3 Slice 3 — conversion input for the real space context.
          currency: true,
          // Slice 4B — used only to gate credit-card reconstruction.
          debtSubtype: true, creditLimit: true,
        },
      },
    },
  });
  if (linkRows.length === 0) return 0;

  const accounts = linkRows.map((l) => ({
    id:          l.financialAccount.id,
    type:        l.financialAccount.type as string,
    balance:     l.financialAccount.balance,
    currency:    l.financialAccount.currency, // MC1 P3 Slice 3 — conversion input
    debtSubtype: l.financialAccount.debtSubtype,
    creditLimit: l.financialAccount.creditLimit,
  }));

  const today = todayUTC();
  const windowStart = addDaysUTC(today, -BACKFILL_DAYS);

  // Floors — an account cannot appear in a day before it existed / was linked.
  // opts.ignoreFloors (dev-seed only) collapses every floor to the epoch so the
  // full 30-day window reconstructs even when accounts/links were created
  // recently (common in dev). Never set on the app path.
  const EPOCH = new Date(0);
  const floorByAccount = new Map<string, Date>(
    linkRows.map((l) => [
      l.financialAccount.id,
      opts?.ignoreFloors
        ? EPOCH
        : maxDate(truncDateUTC(l.financialAccount.createdAt), truncDateUTC(l.createdAt)),
    ]),
  );

  const minFloor = [...floorByAccount.values()].reduce((m, d) => (d.getTime() < m.getTime() ? d : m), today);
  const effectiveStart = maxDate(windowStart, minFloor);
  // Nothing before today to reconstruct (e.g. all accounts created today).
  if (effectiveStart.getTime() >= today.getTime()) return 0;

  // Cash delta sums per (account, day) within the window.
  const cashAccounts: CashAccountBalance[] = accounts
    .filter((a) => a.type === "checking" || a.type === "savings")
    .map((a) => ({ id: a.id, balance: a.balance }));
  const cashIds = cashAccounts.map((a) => a.id);

  const deltaByAccountDay = new Map<string, Map<string, number>>();
  if (cashIds.length > 0) {
    const grouped = await db.transaction.groupBy({
      by: ["financialAccountId", "date"],
      where: {
        financialAccountId: { in: cashIds },
        deletedAt: null,
        date: { gt: effectiveStart, lte: today },
      },
      _sum: { amount: true },
    });
    for (const g of grouped) {
      if (!g.financialAccountId) continue;
      const m = deltaByAccountDay.get(g.financialAccountId) ?? new Map<string, number>();
      m.set(isoDate(g.date), g._sum.amount ?? 0);
      deltaByAccountDay.set(g.financialAccountId, m);
    }
  }

  const dailyCash = reconstructDailyCashBalances(cashAccounts, deltaByAccountDay, today, effectiveStart);

  // ── D2.x Slice 4B — credit-card debt reconstruction ─────────────────────────
  // Revolving credit cards only (isReconstructableCard). Non-card debt (loans,
  // mortgages, HELOC/LOC with an explicit subtype) stays flat, as do
  // investments/crypto/manual assets. Pending transactions are EXCLUDED so the
  // window matches the posted `current` balance anchor. Liability walk ADDS
  // amounts (owed rises with purchases). Cash reconstruction above is untouched.
  const cardAccounts: CashAccountBalance[] = accounts
    .filter(isReconstructableCard)
    .map((a) => ({ id: a.id, balance: a.balance }));
  const cardIds = cardAccounts.map((a) => a.id);

  const deltaByCardDay = new Map<string, Map<string, number>>();
  if (cardIds.length > 0) {
    const grouped = await db.transaction.groupBy({
      by: ["financialAccountId", "date"],
      where: {
        financialAccountId: { in: cardIds },
        deletedAt: null,
        pending:   false, // Slice 4B — exclude pending to match posted balance
        date: { gt: effectiveStart, lte: today },
      },
      _sum: { amount: true },
    });
    for (const g of grouped) {
      if (!g.financialAccountId) continue;
      const m = deltaByCardDay.get(g.financialAccountId) ?? new Map<string, number>();
      m.set(isoDate(g.date), g._sum.amount ?? 0);
      deltaByCardDay.set(g.financialAccountId, m);
    }
  }

  const dailyCardDebt = reconstructDailyLiabilityBalances(cardAccounts, deltaByCardDay, today, effectiveStart);

  // Build one row per reconstructed day (today already excluded by the core).
  // reportingCurrency (MC1 Phase 3 Slice 3, F-2): reconstructed rows stamp the
  // Space's reporting currency — the SAME value the conversion context below
  // targets, read once, atomically. isEstimated keeps its D2.x reconstruction
  // meaning (approved D-7): currency estimation is not written to snapshots.
  const rows: Array<{
    spaceId: string; date: Date; isEstimated: true; reportingCurrency: string;
    stocks: number; crypto: number; total: number; cash: number; savings: number;
    debt: number; netWorth: number; totalAssets: number; netLiquid: number; cashOnHand: number;
  }> = [];

  // MC1 Phase 3 Slice 3 — THE BACKFILL FLIP (plan seams #2). One real space
  // context prefetched over EVERY reconstructed day, so each historical day
  // converts at ITS OWN day's rate (historical FX per day — finding §1.4).
  // Days beyond archive depth resolve as misses → native + estimated per D-3,
  // on rows that are already isEstimated by construction. All-USD Spaces take
  // the identity fast path throughout (numerically identical to Phase 2).
  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  if (!space) return 0; // space vanished mid-call — nothing to backfill

  const reconstructedDates = [...dailyCash.keys()].filter((dISO) => !existingDates.has(dISO));
  const ctx = await buildSpaceConversionContext(space, {
    currencies: accounts.map((a) => a.currency ?? null),
    dates:      reconstructedDates,
  });

  for (const [dISO, cashMap] of dailyCash) {
    // Never touch a date that already has a row (LIVE today, or any prior live
    // row when the gate is bypassed) — write only genuinely-missing dates.
    if (existingDates.has(dISO)) continue;
    const d = fromISO(dISO);
    const cardMap = dailyCardDebt.get(dISO);
    // Exclude accounts that did not yet exist / were not yet linked on day d.
    // Override cash balances (cashMap) and reconstructed card debt (cardMap);
    // everything else keeps its current (flat) balance.
    const dayAccounts = accounts
      .filter((a) => floorByAccount.get(a.id)!.getTime() <= d.getTime())
      .map((a) => {
        if (cashMap.has(a.id)) return { ...a, balance: cashMap.get(a.id)! };
        if (cardMap?.has(a.id)) return { ...a, balance: cardMap.get(a.id)! };
        return a;
      });
    if (dayAccounts.length === 0) continue;

    // Historical valuation: day d's balances convert at day d's rate.
    const c = classifyAccounts(dayAccounts, ctx, dISO);
    const fields = computeSnapshotFields(c);
    rows.push({ spaceId, date: d, isEstimated: true, reportingCurrency: space.reportingCurrency, ...fields });
  }

  if (rows.length === 0) return 0;

  // Dry run — report how many rows WOULD be inserted, write nothing.
  if (opts?.dryRun) return rows.length;

  const res = await db.spaceSnapshot.createMany({ data: rows, skipDuplicates: true });
  return res.count;
}
