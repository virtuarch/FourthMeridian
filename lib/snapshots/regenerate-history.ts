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
 */

import { db } from "@/lib/db";
import { ShareStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { getInvestmentValueAsOf } from "@/lib/investments/valuation";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import {
  reconstructDailyCashBalances,
  reconstructDailyLiabilityBalances,
  truncDateUTC,
  maxDate,
  isoDate,
  fromISO,
  type CashAccountBalance,
} from "@/lib/snapshots/backfill-core";
import { regenerateDay, type DayRegenInput, type DayRegenResult } from "@/lib/snapshots/regenerate-history.core";
import { backfillBtcPrices, readBtcUsdAsOf } from "@/lib/crypto/btc-price";

type Client = PrismaClient | Prisma.TransactionClient;

/** Kill switch — absent/false ⇒ no SpaceSnapshot writes from regeneration at all. */
export function wealthRegenerationEnabled(): boolean {
  return process.env.WEALTH_REGENERATION_ENABLED === "true";
}

/**
 * Parity copy of backfill.ts#isReconstructableCard (private there, and importing
 * it would pull backfill's `server-only` chain into a plain script). Kept
 * identical so the as-of card walk here matches the backfill walk exactly.
 */
function isReconstructableCard(a: { type: string; debtSubtype: string | null; creditLimit: number | null }): boolean {
  if (a.type !== "debt") return false;
  if (a.debtSubtype === "credit_card") return true;
  if (a.debtSubtype === null && a.creditLimit != null) return true;
  return false;
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
}

export interface WealthHistoryDiff {
  date:         string;
  action:       DayRegenResult["action"];
  tier:         CompletenessTier;
  stocksBefore: number | null; // existing row's investment component (null when no row)
  stocksAfter:  number | null; // regenerated investment component (null when skipped)
}

export interface RegenerateWealthHistoryResult {
  spaceId:            string;
  fromDate:           string;
  toDate:             string;
  considered:         number; // days evaluated
  written:            number; // rows upserted (0 on dry-run / flag off)
  skippedFrozen:      number; // observed rows left untouched
  skippedUnsupported: number; // no A8 evidence — flat estimate preserved, not fabricated
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
  const applyWrites = !args.dryRun && wealthRegenerationEnabled();

  const zero: RegenerateWealthHistoryResult = {
    spaceId, fromDate, toDate, considered: 0, written: 0, skippedFrozen: 0, skippedUnsupported: 0, applied: applyWrites, diffs: [],
  };

  // Space reporting currency (for the per-day conversion context, historical FX).
  const space = await client.space.findUnique({ where: { id: spaceId }, select: { reportingCurrency: true } });
  if (!space) return zero;

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
  const floorByAccount = new Map<string, Date>(
    linkRows.map((l) => [l.financialAccount.id, maxDate(truncDateUTC(l.financialAccount.createdAt), truncDateUTC(l.createdAt))]),
  );

  const today = todayUTC(now);
  // Walk anchor is today's current balances; walk back only as far as fromDate.
  const effectiveStart = maxDate(fromISO(fromDate), truncDateUTC([...floorByAccount.values()].reduce((m, d) => (d < m ? d : m), today)));
  if (effectiveStart.getTime() >= today.getTime()) return zero;

  // Cash + revolving-card transaction deltas over (effectiveStart, today].
  const cashAccounts: CashAccountBalance[] = accounts.filter((a) => a.type === "checking" || a.type === "savings").map((a) => ({ id: a.id, balance: a.balance }));
  const cardAccounts: CashAccountBalance[] = accounts.filter(isReconstructableCard).map((a) => ({ id: a.id, balance: a.balance }));

  const [cashDeltas, cardDeltas] = await Promise.all([
    buildDeltas(client, cashAccounts.map((a) => a.id), effectiveStart, today, false),
    buildDeltas(client, cardAccounts.map((a) => a.id), effectiveStart, today, true),
  ]);
  const dailyCash = reconstructDailyCashBalances(cashAccounts, cashDeltas, today, effectiveStart);
  const dailyCard = reconstructDailyLiabilityBalances(cardAccounts, cardDeltas, today, effectiveStart);

  // Existing rows in the window — for the frozen-row flag + before/after diffs.
  const existing = await client.spaceSnapshot.findMany({
    where:  { spaceId, date: { gte: fromISO(fromDate), lte: fromISO(toDate) } },
    select: { date: true, isEstimated: true, stocks: true },
  });
  const existingByDate = new Map(existing.map((r) => [isoDate(r.date), r]));

  // One conversion context over every candidate day (each day converts at its own rate).
  const candidateDates = [...dailyCash.keys()].filter((d) => d >= fromDate && d <= toDate).sort();
  const ctx = await buildSpaceConversionContext(space, { currencies: accounts.map((a) => a.currency ?? null), dates: candidateDates });

  const result: RegenerateWealthHistoryResult = { ...zero };
  const writes: Array<{ date: Date; isEstimated: boolean; fields: NonNullable<DayRegenResult["fields"]> }> = [];

  for (const dISO of candidateDates) {
    const d = fromISO(dISO);
    const cashMap = dailyCash.get(dISO)!;
    const cardMap = dailyCard.get(dISO);

    // Day-accounts: cash/card walked back, everything else flat (backfill parity),
    // excluding accounts that did not exist / were not linked yet on day d.
    const dayAccounts = accounts
      .filter((a) => floorByAccount.get(a.id)!.getTime() <= d.getTime())
      .map((a) => {
        if (cashMap.has(a.id)) return { type: a.type, balance: cashMap.get(a.id)!, currency: a.currency };
        if (cardMap?.has(a.id)) return { type: a.type, balance: cardMap.get(a.id)!, currency: a.currency };
        return { type: a.type, balance: a.balance, currency: a.currency };
      });
    if (dayAccounts.length === 0) continue;

    const c = classifyAccounts(dayAccounts, ctx, dISO);

    // A8 canonical historical investment valuation for the day (best-effort).
    let investmentValue = c.totalInvestments;
    let investmentTier: CompletenessTier = "incomplete";
    let hasInvestmentEvidence = false;
    try {
      const view = await getInvestmentValueAsOf({ spaceId, asOf: dISO, client });
      hasInvestmentEvidence = view.components.length > 0;
      if (hasInvestmentEvidence) {
        investmentValue = view.valuedSubtotal;
        investmentTier = view.completeness.tier;
      }
    } catch (err) {
      console.warn(`[wealth-regen] ${spaceId} ${dISO}: A8 valuation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Part-A — historical crypto valuation for the day: Σ (constant native
    // quantity × BTC price as-of the day), converted to the reporting currency.
    // Computed from the FULL crypto-account list (not the floored day set) so the
    // constant-quantity estimate spans the window. No BTC price reaching the day
    // ⇒ no evidence ⇒ the flat value is preserved (never fabricated).
    let digitalAssetValue = c.totalDigitalAssets;
    let hasDigitalAssetEvidence = false;
    if (cryptoAccounts.length > 0) {
      const btcUsd = await readBtcUsdAsOf(dISO);
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
      cashCardTier: "derived",
    };

    const res = regenerateDay(input);
    result.considered++;
    if (res.action === "skip-frozen") result.skippedFrozen++;
    else if (res.action === "skip-unsupported") result.skippedUnsupported++;

    result.diffs.push({
      date: dISO, action: res.action, tier: res.tier,
      stocksBefore: prior ? prior.stocks : null,
      stocksAfter: res.fields ? res.fields.stocks : null,
    });

    if (res.action === "write" && res.fields) {
      writes.push({ date: d, isEstimated: res.isEstimated, fields: res.fields });
    }
  }

  if (applyWrites) {
    for (const w of writes) {
      const data = { ...w.fields, isEstimated: w.isEstimated, reportingCurrency: space.reportingCurrency };
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
 * accountId → (isoDate → Σ signed amount posted that day) over (from, today].
 * `excludePending` matches the card walk (posted-only) vs the cash walk.
 */
async function buildDeltas(client: Client, ids: string[], from: Date, today: Date, excludePending: boolean): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (ids.length === 0) return out;
  const grouped = await client.transaction.groupBy({
    by: ["financialAccountId", "date"],
    where: { financialAccountId: { in: ids }, deletedAt: null, ...(excludePending ? { pending: false } : {}), date: { gt: from, lte: today } },
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
