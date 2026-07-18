/**
 * lib/snapshots/regenerate-history.ts
 *
 * A9 — wealth-regeneration binding (DB orchestration). For a bounded
 * {spaceId, fromDate, toDate} window it re-derives each estimated historical
 * SpaceSnapshot row so its investment component comes from the canonical A8
 * historical valuation instead of being held flat at today's value, then upserts
 * the improved rows into the SAME cache the Wealth read model / chart / compare
 * already read (zero new schema).
 *
 * It is a SIBLING of backfill.ts, not a replacement: it imports backfill-core's
 * walk-backs and computeSnapshotFields UNCHANGED (read-only), reuses
 * classifyAccounts for per-day historical-FX aggregation, and delegates every
 * honesty decision (frozen-row safety, flip, no-fabrication, monotone) to the
 * pure regenerate-history.core. It does NOT touch backfill.ts, regenerate.ts,
 * the read path, or any UI.
 *
 * Gated behind WEALTH_REGENERATION_ENABLED: absent ⇒ zero writes (dry-run still
 * computes the plan). Best-effort/non-fatal per day — an A8 valuation failure
 * for one date leaves that date's existing row untouched, never fails the run.
 *
 * 2026-07-14 fix: the per-account floor used to be FinancialAccount.createdAt/
 * SpaceAccountLink.createdAt (stamped at connect = today), so a freshly
 * connected cash/debt account was permanently excluded from every historical
 * day this ever computed — including on a LATER re-run after its transactions
 * had finished syncing, since connect-date never changes. It now floors at
 * the account's earliest real Transaction (parity with backfill.ts, including
 * the SHARED-space secondary link-floor), so a re-run genuinely picks up days
 * it previously couldn't once evidence exists — see jobs/sync-banks.ts, which
 * now calls regenerateWealthHistoryForAccounts on every daily sync so this
 * self-heals without a manual re-run.
 */

import { db } from "@/lib/db";
import { ShareStatus, SpaceType, type Prisma, type PrismaClient } from "@prisma/client";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { getInvestmentValueForWindow } from "@/lib/investments/valuation";
import type { InvestmentValuationView } from "@/lib/investments/valuation-core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import {
  reconstructDailyCashBalances,
  reconstructDailyLiabilityBalances,
  isHeldFlatBalanceAccount,
  isReconstructableCard,
  computeAccountFloors,
  truncDateUTC,
  maxDate,
  addDaysUTC,
  isoDate,
  fromISO,
  type CashAccountBalance,
} from "@/lib/snapshots/backfill-core";
import { regenerateDay, type DayRegenInput, type DayRegenResult } from "@/lib/snapshots/regenerate-history.core";
import { backfillBtcPrices, readBtcUsdWindow } from "@/lib/crypto/btc-price";
import { backfillHeldInstrumentPrices } from "@/lib/investments/holding-price-backfill";

type Client = PrismaClient | Prisma.TransactionClient;

/** Kill switch — absent/false ⇒ no SpaceSnapshot writes from regeneration at all. */
export function wealthRegenerationEnabled(): boolean {
  return process.env.WEALTH_REGENERATION_ENABLED === "true";
}

function todayUTC(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export interface RegenerateWealthHistoryArgs {
  spaceId:  string;
  fromDate: string; // YYYY-MM-DD inclusive
  toDate:   string; // YYYY-MM-DD inclusive (should be ≤ yesterday; today's live row is frozen)
  dryRun?:  boolean;
  now?:     Date;
  client?:  Client;
  /**
   * 2026-07-14 (Phase 2 — amendment system) — when true, this run is an
   * EXPLICIT, consent-gated SnapshotAmendment, not the automatic pipeline. It
   * (a) exempts every day from the frozen + membership-changed guards (the core
   * bypass), and (b) bypasses the WEALTH_REGENERATION_ENABLED kill switch —
   * that env flag gates the AUTOMATIC pipeline; a deliberately-consented
   * amendment is gated by consent, recorded on the SnapshotAmendment row, not by
   * an operational switch. Callers must be the amendment layer
   * (lib/snapshots/snapshot-amendment.ts). Defaults false (undefined) → nothing
   * about the automatic path changes.
   */
  isAmendment?: boolean;
  /**
   * The SnapshotAmendment.id to stamp on every row this run rewrites (only used
   * with isAmendment). Lets a row point back at the amendment that revised it.
   */
  amendedByAmendmentId?: string;
}

export interface WealthHistoryDiff {
  date:          string;
  action:        DayRegenResult["action"];
  tier:          CompletenessTier;
  stocksBefore:  number | null; // existing row's investment component (null when no row)
  stocksAfter:   number | null; // regenerated investment component (null when skipped)
  cryptoBefore:  number | null; // existing row's digital-asset component (null when no row)
  cryptoAfter:   number | null; // regenerated digital-asset component (null when skipped)
  // 2026-07-15 — cash/savings/debt/netWorth before/after, so a caller can see the
  // cash-walk-back + floor fix take effect too, not just the A8 investment
  // override. Previously silent here — a full 30-day cash/debt regeneration
  // could run and this diff would never show it, which read as "nothing
  // changed" even when it had.
  cashBefore:    number | null;
  cashAfter:     number | null;
  savingsBefore: number | null;
  savingsAfter:  number | null;
  debtBefore:    number | null;
  debtAfter:     number | null;
  netWorthBefore: number | null;
  netWorthAfter:  number | null;
}

export interface RegenerateWealthHistoryResult {
  spaceId:            string;
  fromDate:           string;
  toDate:             string;
  considered:         number; // days evaluated
  written:            number; // rows upserted (0 on dry-run / flag off)
  skippedFrozen:      number; // observed rows left untouched
  skippedUnsupported: number; // no A8 evidence — flat estimate preserved, not fabricated
  // 2026-07-15 — days left untouched because an account was removed from the
  // Space after that date. See regenerate-history.core.ts's
  // "MEMBERSHIP CHANGED" guard and
  // docs/initiatives/wealth-timeline/WEALTH_TIMELINE_AMENDMENT_SYSTEM_PROPOSAL.md §9.
  skippedMembershipChanged: number;
  applied:            boolean; // whether writes actually happened
  diffs:              WealthHistoryDiff[];
}

/**
 * Regenerate the estimated Wealth history of one Space over a bounded window.
 * Deterministic and idempotent: identical facts ⇒ identical rows.
 */
export async function regenerateWealthHistory(args: RegenerateWealthHistoryArgs): Promise<RegenerateWealthHistoryResult> {
  const client = args.client ?? db;
  const now = args.now ?? new Date();
  const { spaceId, fromDate, toDate } = args;
  // Automatic runs are gated by the WEALTH_REGENERATION_ENABLED kill switch; an
  // explicit consent-gated amendment is gated by consent instead (see args.isAmendment).
  const applyWrites = !args.dryRun && (wealthRegenerationEnabled() || args.isAmendment === true);

  const zero: RegenerateWealthHistoryResult = {
    spaceId, fromDate, toDate, considered: 0, written: 0, skippedFrozen: 0, skippedUnsupported: 0, skippedMembershipChanged: 0, applied: applyWrites, diffs: [],
  };

  // Space reporting currency (for the per-day conversion context, historical FX)
  // + type (SHARED vs PERSONAL — used by the account-floor secondary bound below).
  const space = await client.space.findUnique({ where: { id: spaceId }, select: { reportingCurrency: true, type: true } });
  if (!space) return zero;
  const isSharedSpace = space.type === SpaceType.SHARED;
  const today = todayUTC(now);

  // Account set + floors — the SAME ACTIVE, non-deleted link set backfill uses.
  const linkRows = await client.spaceAccountLink.findMany({
    where:  { spaceId, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
    select: {
      createdAt: true,
      financialAccount: { select: { id: true, type: true, balance: true, currency: true, createdAt: true, debtSubtype: true, creditLimit: true, nativeBalance: true } },
    },
  });
  if (linkRows.length === 0) return zero;

  const accounts = linkRows.map((l) => ({
    id: l.financialAccount.id,
    type: l.financialAccount.type as string,
    balance: l.financialAccount.balance,
    currency: l.financialAccount.currency,
    debtSubtype: l.financialAccount.debtSubtype,
    creditLimit: l.financialAccount.creditLimit,
    nativeBalance: l.financialAccount.nativeBalance, // BTC quantity for crypto accounts
  }));

  // Part-A — crypto accounts get an honest per-day valuation: today's on-chain
  // quantity (nativeBalance, held CONSTANT — the block explorer in use is
  // current-balance-only, so historical per-day balance isn't derivable) × that
  // day's CoinGecko BTC price. Backfill the window's BTC prices once (best-effort,
  // dark without COINGECKO_API_KEY). Independent of the per-account floor: the
  // constant-quantity assumption spans the whole window (a labeled estimate).
  const cryptoAccounts = accounts.filter((a) => a.type === "crypto" && a.nativeBalance != null);
  if (cryptoAccounts.length > 0) {
    try {
      const r = await backfillBtcPrices(fromDate, toDate);
      console.log(`[wealth-regen] ${spaceId}: BTC price backfill — ${r.inserted} row(s)${r.configured ? "" : " (no COINGECKO_API_KEY — crypto stays flat)"}`);
    } catch (e) {
      console.warn(`[wealth-regen] ${spaceId}: BTC price backfill failed (non-fatal):`, e instanceof Error ? e.message : e);
    }
  }
  // Schwab-class fix — investment accounts with holdings but NO reconstructable
  // event history (provider returned current positions, zero investment events,
  // and no Transaction rows) get the SAME constant-quantity treatment as crypto:
  // today's holdings valued at each day's historical price. Resolve today's held
  // instruments and force-backfill their prices over the window (their earliest
  // ACTIVITY is today, so the normal window resolves to null — forceWindow
  // fetches the historical span anyway). Best-effort/dark without a price vendor.
  const investmentAccounts = accounts.filter((a) => a.type === "investment");
  let heldInstrumentIds: string[] = [];
  if (investmentAccounts.length > 0) {
    heldInstrumentIds = [
      ...new Set(
        (
          await client.positionObservation.findMany({
            where:    { financialAccountId: { in: investmentAccounts.map((a) => a.id) }, quantity: { gt: 0 }, supersededById: null, deletedAt: null },
            select:   { instrumentId: true },
            distinct: ["instrumentId"],
          })
        ).map((r) => r.instrumentId),
      ),
    ];
    if (heldInstrumentIds.length > 0) {
      try {
        const r = await backfillHeldInstrumentPrices(heldInstrumentIds, fromDate, toDate, (line) => console.log(`[wealth-regen] ${spaceId}: ${line}`));
        console.log(`[wealth-regen] ${spaceId}: equity price backfill — planned ${r.planned}, stored ${r.inserted} row(s)`);
      } catch (e) {
        console.warn(`[wealth-regen] ${spaceId}: equity price backfill failed (non-fatal):`, e instanceof Error ? e.message : e);
      }
    }
  }
  // Anything to value historically beyond cash/card → reconstruct the FULL window
  // even when account floors collapse to today (a fresh connect).
  const hasHoldings = heldInstrumentIds.length > 0 || cryptoAccounts.length > 0;

  // Account-level floor: earliest real (non-deleted) Transaction — same fix as
  // backfill.ts's header comment describes. This used to be
  // FinancialAccount.createdAt/SpaceAccountLink.createdAt, which are stamped at
  // connect (today) and so permanently collapsed the reconstructable window to
  // zero for that account on every re-run, no matter how much later regeneration
  // runs or how many transactions have since synced in. Using the earliest
  // transaction instead means a re-run AFTER transactions finish syncing (the
  // very next connect-pipeline pass, or the daily cron) can pick up days it
  // previously couldn't — the whole point of re-running this at all.
  const allAccountIds = accounts.map((a) => a.id);
  const earliestTxByAccount = new Map<string, Date>();
  if (allAccountIds.length > 0) {
    const grouped = await client.transaction.groupBy({
      by:    ["financialAccountId"],
      where: { financialAccountId: { in: allAccountIds }, deletedAt: null },
      _min:  { date: true },
    });
    for (const g of grouped) {
      if (g.financialAccountId && g._min.date) earliestTxByAccount.set(g.financialAccountId, truncDateUTC(g._min.date));
    }
  }
  // REG-2 — balance-bearing cash/savings/debt accounts with NO reconstructable
  // transaction history are HELD FLAT at their current balance across the window
  // (an honest estimate) rather than floored to today and dropped from every
  // historical day. Symmetric with the live writer (regenerate.ts), which after
  // REG-1 includes every balance-bearing account. Single predicate authority in
  // backfill-core (shared with backfill.ts).
  const heldFlatIds = new Set(
    accounts.filter((a) => isHeldFlatBalanceAccount(a, earliestTxByAccount.has(a.id))).map((a) => a.id),
  );
  const hasFlatHeld = heldFlatIds.size > 0;

  // Per-account reconstruction floors — SINGLE authority in backfill-core
  // (HIST-2A), shared byte-for-byte with backfill.ts so M2 and M3 can never drift
  // on "from when can this account be reconstructed". (M3 never sets ignoreFloors.)
  const floorByAccount = computeAccountFloors(
    linkRows.map((l) => ({ id: l.financialAccount.id, linkCreatedAt: l.createdAt })),
    earliestTxByAccount, heldFlatIds, isSharedSpace, today,
  );

  // Walk anchor is today's current balances; walk back only as far as fromDate.
  // With holdings to value OR a held-flat balance account, span the full window;
  // the constant-quantity valuation (investment + crypto) and the held-flat cash
  // estimate do not depend on the walk-back cash/card floors.
  const cashFloorStart = maxDate(fromISO(fromDate), truncDateUTC([...floorByAccount.values()].reduce((m, d) => (d < m ? d : m), today)));
  const effectiveStart = (hasHoldings || hasFlatHeld) ? fromISO(fromDate) : cashFloorStart;
  if (effectiveStart.getTime() >= today.getTime()) return zero;

  // Cash + revolving-card transaction deltas over (effectiveStart, today].
  const cashAccounts: CashAccountBalance[] = accounts.filter((a) => a.type === "checking" || a.type === "savings").map((a) => ({ id: a.id, balance: a.balance }));
  const cardAccounts: CashAccountBalance[] = accounts.filter(isReconstructableCard).map((a) => ({ id: a.id, balance: a.balance }));

  // SAME-BASIS INVARIANT — BOTH walks are posted-only. buildDeltas is
  // unconditionally posted-only (no pending-inclusive variant, by construction),
  // matching the FinancialAccount.balance anchor the walk-back reverses. `balance`
  // is the only balance the snapshot system treats as truth and never carries
  // pending, so reversing a pending row would mix bases and inject a phantom into
  // every day before the pending date. See backfill.ts / accounts-asof.ts.
  const [cashDeltas, cardDeltas] = await Promise.all([
    buildDeltas(client, cashAccounts.map((a) => a.id), effectiveStart, today),
    buildDeltas(client, cardAccounts.map((a) => a.id), effectiveStart, today),
  ]);
  const dailyCash = reconstructDailyCashBalances(cashAccounts, cashDeltas, today, effectiveStart);
  const dailyCard = reconstructDailyLiabilityBalances(cardAccounts, cardDeltas, today, effectiveStart);

  // 2026-07-15 — dates any account was REVOKED from this Space (§9 fix). Used
  // to gate automatic regen: a day whose date precedes a revocation may still
  // have had that account as a genuine member, and this function only ever
  // queries CURRENTLY active links (linkRows above) — writing over such a day
  // would silently drop that account's real historical contribution. Cheap,
  // one query, independent of the ACTIVE-only linkRows query above.
  const revokedDates = (
    await client.spaceAccountLink.findMany({
      where:  { spaceId, status: ShareStatus.REVOKED, revokedAt: { not: null } },
      select: { revokedAt: true },
    })
  ).map((r) => truncDateUTC(r.revokedAt!));

  // Existing rows in the window — for the frozen-row flag + before/after diffs.
  const existing = await client.spaceSnapshot.findMany({
    where:  { spaceId, date: { gte: fromISO(fromDate), lte: fromISO(toDate) } },
    select: { date: true, isEstimated: true, stocks: true, crypto: true, cash: true, savings: true, debt: true, netWorth: true },
  });
  const existingByDate = new Map(existing.map((r) => [isoDate(r.date), r]));

  // Candidate days: the cash-reconstruction days, PLUS — when there are holdings
  // to value — every day in the window (so a holdings-only Space with no cash
  // still gets a full historical series). Today is excluded (its live row is frozen).
  const todayISO = isoDate(today);
  const dayList = new Set<string>([...dailyCash.keys()]);
  if (hasHoldings || hasFlatHeld) {
    for (let d = new Date(effectiveStart); isoDate(d) < todayISO; d = addDaysUTC(d, 1)) {
      dayList.add(isoDate(d));
    }
  }
  // One conversion context over every candidate day (each day converts at its own rate).
  const candidateDates = [...dayList].filter((d) => d >= fromDate && d <= toDate && d < todayISO).sort();
  const ctx = await buildSpaceConversionContext(space, { currencies: accounts.map((a) => a.currency ?? null), dates: candidateDates });

  // HIST-1C — value the whole window's investments in ONE position/price/FX read
  // (getInvestmentValueForWindow) instead of an N×date getInvestmentValueAsOf call
  // per day. Each date's view is byte-identical to the former per-day call; this
  // changes only execution strategy. Best-effort: a failed batch leaves the
  // window's investment component flat, exactly the non-fatal contract the former
  // per-day try/catch gave (a per-date A8 failure was only ever a systemic read
  // error that would have hit every day alike). excludeDigitalAssetAccounts — the
  // valuedSubtotal becomes each day's totalInvestments; crypto is valued separately
  // into totalDigitalAssets below, so it must NOT also count here or BTC is
  // double-counted (the historical net-worth cliff). Mirrors the live writer.
  let investmentByDate = new Map<string, InvestmentValuationView>();
  try {
    investmentByDate = await getInvestmentValueForWindow({
      spaceId,
      dates: candidateDates,
      client,
      holdConstantBeforeEarliest: true,
      excludeDigitalAssetAccounts: true,
    });
  } catch (err) {
    console.warn(`[wealth-regen] ${spaceId}: batch A8 valuation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // HIST-2C — resolve BTC/USD for the whole window in ONE archive read (built
  // AFTER backfillBtcPrices above, so freshly-fetched closes are included), then
  // answer each day from memory. Byte-identical to the former per-day
  // readBtcUsdAsOf; only the D point reads collapse to one range read. Only built
  // when there is crypto to value (else an all-null resolver, never queried).
  const btcAt =
    cryptoAccounts.length > 0
      ? await readBtcUsdWindow(fromDate, toDate)
      : (_dISO: string): number | null => null;

  const result: RegenerateWealthHistoryResult = { ...zero };
  const writes: Array<{ date: Date; isEstimated: boolean; fields: NonNullable<DayRegenResult["fields"]> }> = [];

  for (const dISO of candidateDates) {
    const d = fromISO(dISO);
    const cashMap = dailyCash.get(dISO) ?? new Map<string, number>(); // empty when the Space has no cash
    const cardMap = dailyCard.get(dISO);

    // Day-accounts: cash/card walked back, everything else flat (backfill parity),
    // excluding accounts that did not exist / were not linked yet on day d. REG-2:
    // a held-flat balance account (no walk-back deltas) flows through the flat
    // fallback below; note its presence so the day's cash/card tier degrades to
    // "estimated" (a held-flat balance is a weaker estimate than a walk-back).
    let dayHasHeldFlat = false;
    const dayAccounts = accounts
      .filter((a) => floorByAccount.get(a.id)!.getTime() <= d.getTime())
      .map((a) => {
        if (heldFlatIds.has(a.id)) dayHasHeldFlat = true;
        if (cashMap.has(a.id)) return { type: a.type, balance: cashMap.get(a.id)!, currency: a.currency };
        if (cardMap?.has(a.id)) return { type: a.type, balance: cardMap.get(a.id)!, currency: a.currency };
        return { type: a.type, balance: a.balance, currency: a.currency };
      });
    // Skip a day only when there is nothing at all to value — but a holdings-only
    // Space (investment/crypto floored to today, so dayAccounts is empty) or a
    // held-flat balance account is still valued below, so don't skip it.
    if (dayAccounts.length === 0 && !hasHoldings && !hasFlatHeld) continue;

    const c = classifyAccounts(dayAccounts, ctx, dISO);

    // A8 canonical historical investment valuation for the day, from the batch
    // window valued once above (HIST-1C). holdConstantBeforeEarliest: a holdings-
    // only investment account (no A4 event history) is valued at today's quantity
    // held constant × the day's price. The view is byte-identical to the former
    // per-day getInvestmentValueAsOf; a missing entry (empty batch on failure)
    // leaves the flat value, preserving the prior non-fatal behavior.
    let investmentValue = c.totalInvestments;
    let investmentTier: CompletenessTier = "incomplete";
    let hasInvestmentEvidence = false;
    const view = investmentByDate.get(dISO);
    if (view) {
      hasInvestmentEvidence = view.components.length > 0;
      if (hasInvestmentEvidence) {
        investmentValue = view.valuedSubtotal;
        investmentTier = view.completeness.tier;
      }
    }

    // Part-A — historical crypto valuation for the day: Σ (constant native
    // quantity × BTC price as-of the day), converted to the reporting currency.
    // Computed from the FULL crypto-account list (not the floored day set) so the
    // constant-quantity estimate spans the window. No BTC price reaching the day
    // ⇒ no evidence ⇒ the flat value is preserved (never fabricated).
    let digitalAssetValue = c.totalDigitalAssets;
    let hasDigitalAssetEvidence = false;
    if (cryptoAccounts.length > 0) {
      const btcUsd = btcAt(dISO); // HIST-2C — from the one-shot window read above
      if (btcUsd != null) {
        // Value each crypto account at its constant native quantity × the day's
        // BTC price (USD), then let classifyAccounts do the FX to the reporting
        // currency — the SAME conversion path every other total uses (no second
        // FX interpretation opened in this binding).
        const cryptoDay = cryptoAccounts.map((a) => ({ type: "crypto", balance: (a.nativeBalance ?? 0) * btcUsd, currency: "USD" }));
        digitalAssetValue = classifyAccounts(cryptoDay, ctx, dISO).totalDigitalAssets;
        hasDigitalAssetEvidence = true;
      }
    }

    const prior = existingByDate.get(dISO);
    const input: DayRegenInput = {
      date: dISO,
      existingIsEstimated: prior ? prior.isEstimated : null,
      base: {
        totalInvestments:   c.totalInvestments,
        totalDigitalAssets: c.totalDigitalAssets,
        totalChecking:      c.totalChecking,
        totalSavings:       c.totalSavings,
        totalLiabilities:   c.totalLiabilities,
        totalRealAssets:    c.totalRealAssets,
      },
      investmentValue,
      investmentTier,
      hasInvestmentEvidence,
      digitalAssetValue,
      digitalAssetTier: "estimated", // constant-quantity assumption × real price
      hasDigitalAssetEvidence,
      // REG-2 — a held-flat balance account (current balance carried backward, no
      // transaction reconstruction) makes the day's cash/card component an
      // "estimated" (not "derived") value, so the row is honestly labeled a weaker
      // estimate. Still isEstimated=true either way; never presented as observed.
      cashCardTier: dayHasHeldFlat ? "estimated" : "derived",
      // 2026-07-15 §9 fix — any account revoked strictly after this day was
      // plausibly still a member of the Space as of this day; the `accounts`
      // array above only reflects CURRENTLY active links, so writing this day
      // would silently drop that account's real contribution.
      membershipChangedSince: revokedDates.some((r) => r.getTime() > d.getTime()),
      // Phase 2 — an explicit amendment bypasses the frozen + membership guards.
      isAmendment: args.isAmendment === true,
    };

    const res = regenerateDay(input);
    result.considered++;
    if (res.action === "skip-frozen") result.skippedFrozen++;
    else if (res.action === "skip-unsupported") result.skippedUnsupported++;
    else if (res.action === "skip-membership-changed") result.skippedMembershipChanged++;

    result.diffs.push({
      date: dISO, action: res.action, tier: res.tier,
      stocksBefore: prior ? prior.stocks : null,
      stocksAfter: res.fields ? res.fields.stocks : null,
      cryptoBefore: prior ? prior.crypto : null,
      cryptoAfter: res.fields ? res.fields.crypto : null,
      cashBefore: prior ? prior.cash : null,
      cashAfter: res.fields ? res.fields.cash : null,
      savingsBefore: prior ? prior.savings : null,
      savingsAfter: res.fields ? res.fields.savings : null,
      debtBefore: prior ? prior.debt : null,
      debtAfter: res.fields ? res.fields.debt : null,
      netWorthBefore: prior ? prior.netWorth : null,
      netWorthAfter: res.fields ? res.fields.netWorth : null,
    });

    if (res.action === "write" && res.fields) {
      writes.push({ date: d, isEstimated: res.isEstimated, fields: res.fields });
    }
  }

  if (applyWrites) {
    for (const w of writes) {
      const data = {
        ...w.fields,
        isEstimated: w.isEstimated,
        reportingCurrency: space.reportingCurrency,
        // Phase 2 — stamp the amendment that revised this row (amendment runs only).
        ...(args.isAmendment && args.amendedByAmendmentId ? { amendedByAmendmentId: args.amendedByAmendmentId } : {}),
      };
      await client.spaceSnapshot.upsert({
        where:  { spaceId_date: { spaceId, date: w.date } },
        create: { spaceId, date: w.date, ...data },
        update: data,
      });
    }
    result.written = writes.length;
  }

  return result;
}

/**
 * accountId → (isoDate → Σ signed POSTED amount that day) over (from, today].
 * POSTED-ONLY unconditionally for BOTH cash and card walks: the walk-back reverses
 * a posted `FinancialAccount.balance` anchor, so its deltas must be posted too
 * (same-basis invariant). There is deliberately no pending-inclusive parameter —
 * a pending-inclusive reconstruction is always a bug (the boundary phantom), so it
 * is made structurally impossible rather than left as a per-call-site choice.
 */
async function buildDeltas(client: Client, ids: string[], from: Date, today: Date): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (ids.length === 0) return out;
  const grouped = await client.transaction.groupBy({
    by: ["financialAccountId", "date"],
    where: { financialAccountId: { in: ids }, deletedAt: null, pending: false, date: { gt: from, lte: today } },
    _sum: { amount: true },
  });
  for (const g of grouped) {
    if (!g.financialAccountId) continue;
    const m = out.get(g.financialAccountId) ?? new Map<string, number>();
    m.set(isoDate(g.date), g._sum.amount ?? 0);
    out.set(g.financialAccountId, m);
  }
  return out;
}

/**
 * The default 30-day wealth-regen window: [yesterday − 30, yesterday]. Yesterday
 * is the upper bound because today's live row is frozen (regenerateSpaceSnapshot
 * owns it); 30 days matches the snapshot-backfill window. Shared by every trigger
 * (the connect pipeline, the BTC wallet sync) so they regenerate the same span.
 */
export function recentWealthWindow(now: Date = new Date()): { fromDate: string; toDate: string } {
  const y = new Date(now); y.setUTCHours(0, 0, 0, 0); y.setUTCDate(y.getUTCDate() - 1); // yesterday
  const f = new Date(y); f.setUTCDate(f.getUTCDate() - 30);
  return { fromDate: f.toISOString().slice(0, 10), toDate: y.toISOString().slice(0, 10) };
}

/**
 * Trigger-ready fan-out: regenerate every Space that ACTIVE-links any of the
 * given accounts, over the window. Mirrors regenerateSnapshotsForAccounts;
 * exported for a future integration commit to call after price backfill /
 * reconstruction repair / investment sync. Best-effort per space.
 */
export async function regenerateWealthHistoryForAccounts(
  financialAccountIds: string[],
  window: { fromDate: string; toDate: string; now?: Date },
): Promise<string[]> {
  if (financialAccountIds.length === 0) return [];
  const links = await db.spaceAccountLink.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
    select: { spaceId: true },
  });
  const spaceIds = [...new Set(links.map((l) => l.spaceId))];
  for (const spaceId of spaceIds) {
    try {
      await regenerateWealthHistory({ spaceId, fromDate: window.fromDate, toDate: window.toDate, now: window.now });
    } catch (err) {
      console.warn(`[wealth-regen] space ${spaceId} regeneration failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }
  return spaceIds;
}
