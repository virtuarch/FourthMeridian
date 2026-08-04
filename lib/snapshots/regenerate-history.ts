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
import { ShareStatus, SettlementState, SpaceType, type Prisma, type PrismaClient } from "@prisma/client";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
// V26-S2-OWNERSHIP — regeneration composes NOTHING of its own any more. It asks
// the canonical historical-holdings query, which is the same query a drill-down
// will ask, so the chart point and its explanation cannot diverge.
import { historicalHoldingsForWindow } from "@/lib/investments/historical-holdings";
import type { HistoricalHoldingsSet } from "@/lib/investments/historical-holdings.core";
import { ownershipTier } from "@/lib/investments/historical-holdings.core";
import { worstTier, isCompletenessTier } from "@/lib/perspective-engine/completeness";
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
import {
  classifyRegeneration,
  REGENERATION_DISPOSITIONS,
  type RegenerationDisposition,
} from "@/lib/snapshots/regeneration-candidates.core";
import { resolveBtcInstrumentId, readBtcUsdWindow } from "@/lib/crypto/btc-price";
import { licenseConstantQuantityCarry } from "@/lib/crypto/quantity-carry.core";
import { reconcileWalletLedger } from "@/lib/crypto/ledger-completeness.core";
import { valueCryptoDay, type CryptoDayValuation } from "@/lib/crypto/historical-crypto-valuation.core";
import { toStoredCryptoValuationStatus } from "@/lib/snapshots/crypto-valuation-status.core";
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
  /**
   * Optional progress reporter for long rebuilds. Called with (daysDone,
   * daysTotal) as the per-day loop advances, THROTTLED to ~20 calls across the
   * whole run — a callback that writes to the database must not fire 730 times.
   *
   * `daysTotal` is known before the loop starts (the candidate-day set is fixed
   * up front), which is what makes an honest determinate progress bar possible
   * here — unlike the transaction import, where the provider never reveals a
   * total. Purely observational: it can neither change nor fail the rebuild.
   */
  onProgress?: (daysDone: number, daysTotal: number) => void | Promise<void>;
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
  /**
   * V26-CRYPTO-STATUS-1 — rows whose crypto verdict was recorded WITHOUT
   * rewriting the row: a single-column update marking the stored crypto figure
   * unassertable. Counted separately from `written` because no financial scalar
   * changed.
   */
  cryptoStatusStamped: number;
  /**
   * V26-PRICE-5 — every evaluated day by disposition. `written` counts only
   * UPDATED days; UNCHANGED days are evaluated and deliberately left alone, so
   * `considered` and `written` no longer imply one another.
   */
  dispositions:       Record<RegenerationDisposition, number>;
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
    spaceId, fromDate, toDate, considered: 0, written: 0, skippedFrozen: 0, skippedUnsupported: 0, skippedMembershipChanged: 0, cryptoStatusStamped: 0,
    dispositions: Object.fromEntries(REGENERATION_DISPOSITIONS.map((d) => [d, 0])) as Record<RegenerationDisposition, number>,
    applied: applyWrites, diffs: [],
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
      financialAccount: { select: { id: true, name: true, type: true, balance: true, currency: true, createdAt: true, debtSubtype: true, creditLimit: true, nativeBalance: true, lastUpdated: true } },
    },
  });
  if (linkRows.length === 0) return zero;

  const accounts = linkRows.map((l) => ({
    id: l.financialAccount.id,
    name: l.financialAccount.name,
    type: l.financialAccount.type as string,
    balance: l.financialAccount.balance,
    currency: l.financialAccount.currency,
    debtSubtype: l.financialAccount.debtSubtype,
    creditLimit: l.financialAccount.creditLimit,
    nativeBalance: l.financialAccount.nativeBalance, // BTC quantity for crypto accounts
    lastUpdated: l.financialAccount.lastUpdated,     // when nativeBalance was observed
  }));

  // Part-A — crypto accounts get an honest per-day valuation: today's on-chain
  // quantity (nativeBalance, held CONSTANT — the block explorer in use is
  // current-balance-only, so historical per-day balance isn't derivable) × that
  // day's CoinGecko BTC price. Backfill the window's BTC prices once (best-effort,
  // dark without COINGECKO_API_KEY). Independent of the per-account floor: the
  // constant-quantity assumption spans the whole window (a labeled estimate).
  const cryptoAccounts = accounts.filter((a) => a.type === "crypto" && a.nativeBalance != null);

  // V26-CRYPTO-QTY-1 — THE CONSTANT-QUANTITY CARRY IS NOW LICENSED, NOT ASSUMED.
  //
  // Carrying `nativeBalance` to a historical date claims the wallet held that
  // amount then. That claim is only true across an interval containing no
  // quantity-changing transaction, and nothing used to check. Load, ONCE:
  //
  //   anchor  — the date `nativeBalance` was observed (the account's last sync).
  //   events  — the dates of quantity-changing wallet transactions.
  //
  // FILTERING PREDICATES (the binding's documented responsibility; the pure
  // decision in quantity-carry.core.ts deliberately takes dates only):
  //   · scoped to THIS wallet — another account's movements are not this
  //     wallet's quantity, so they must never block it;
  //   · currency = "BTC" — the native-amount column. A fiat row carries no BTC
  //     quantity and is not a quantity event (never infer quantity from fiat);
  //   · deletedAt IS NULL and settlementState = POSTED — pending/unconfirmed and
  //     deleted rows are not settled quantity changes;
  //   · every remaining row counts, whatever its sign or flowType. btc-sync
  //     writes `amount` as a SIGNED native BTC delta (inflow +, outflow/fee −),
  //     so inflows, outflows, fees and internal transfers all change THIS
  //     wallet's balance and all must block. Internal transfers are not
  //     double-counted: each leg is a row on its own account and only ever
  //     blocks the account it belongs to.
  const cryptoQuantityEventsByAccount = new Map<string, string[]>();
  const cryptoAnchorByAccount = new Map<string, string>();
  // V26-S1-BTC — the same rows, summed, answer a question the dates alone cannot:
  // does this ledger account for the wallet's own balance? See below.
  const cryptoLedgerCompleteByAccount = new Map<string, boolean>();
  if (cryptoAccounts.length > 0) {
    for (const a of cryptoAccounts) {
      // No sync timestamp ⇒ the quantity has no observation date to be carried
      // FROM. Left unset, which the guard reports as NO_ANCHOR and refuses —
      // never coerced to "now", which would silently license the whole window.
      if (a.lastUpdated) cryptoAnchorByAccount.set(a.id, isoDate(a.lastUpdated));
    }
    const evRows = await client.transaction.findMany({
      where: {
        financialAccountId: { in: cryptoAccounts.map((a) => a.id) },
        currency:           "BTC",
        deletedAt:          null,
        settlementState:    SettlementState.POSTED,
      },
      // V26-S1-BTC — `amount` joins the select: it is the SIGNED NATIVE delta the
      // reconciliation sums. The same predicates already scope these rows to this
      // wallet's settled native movements, which is exactly the ledger the
      // reconciliation needs, so no second read is introduced.
      select: { financialAccountId: true, date: true, amount: true },
    });
    const movementsByAccount = new Map<string, number[]>();
    for (const r of evRows) {
      if (!r.financialAccountId) continue; // unattached row — not this wallet's activity
      const list = cryptoQuantityEventsByAccount.get(r.financialAccountId) ?? [];
      list.push(isoDate(r.date));
      cryptoQuantityEventsByAccount.set(r.financialAccountId, list);
      const amounts = movementsByAccount.get(r.financialAccountId) ?? [];
      amounts.push(r.amount);
      movementsByAccount.set(r.financialAccountId, amounts);
    }

    // V26-S1-BTC — LEDGER COMPLETENESS IS CHECKED, NOT ASSUMED.
    //
    // `licenseConstantQuantityCarry` decides by searching the event dates above
    // for one that blocks the interval. That search is only meaningful if the
    // list is complete, and it demonstrably was not: an unpaginated explorer
    // fetch imported 25 of the wallet's 28 confirmed transactions, so the list
    // began mid-history and "no event blocks this interval" was an artefact of
    // the missing rows rather than a fact about the wallet.
    //
    // The chain makes this checkable for free — Σ signed movements must equal the
    // observed balance — so we check it, per account, every run. A wallet whose
    // ledger cannot explain its own balance licenses NOTHING historical; its
    // current observed balance is untouched.
    for (const a of cryptoAccounts) {
      const recon = reconcileWalletLedger({
        observedBalance: a.nativeBalance ?? null,
        movements:       movementsByAccount.get(a.id) ?? [],
      });
      cryptoLedgerCompleteByAccount.set(a.id, recon.complete);
      if (!recon.complete) {
        console.warn(`[wealth-regen] ${spaceId}: wallet ${a.id} ledger INCOMPLETE — ${recon.reason}`);
      }
    }
  }

  /**
   * May EVERY crypto account's constant quantity be carried to this date?
   *
   * All-or-nothing on purpose: valuing the licensed accounts while silently
   * dropping a refused one would understate crypto and present the remainder as
   * the whole — the precise dishonesty this slice exists to remove.
   */
  const cryptoQuantityLicensed = (dISO: string): boolean =>
    cryptoAccounts.every((a) =>
      licenseConstantQuantityCarry({
        targetISO:      dISO,
        anchorISO:      cryptoAnchorByAccount.get(a.id) ?? null,
        eventDatesISO:  cryptoQuantityEventsByAccount.get(a.id) ?? [],
        ledgerComplete: cryptoLedgerCompleteByAccount.get(a.id) ?? false,
      }).licensed);

  // V26-PRICE-5 — a DRY RUN MUST NOT ACQUIRE. `dryRun` previously suppressed
  // only the snapshot upserts, so a "read-only" impact report still made live
  // provider calls and wrote price rows. Valuation reads stored evidence only;
  // acquisition is a separate, effectful phase and is skipped entirely here.
  if (cryptoAccounts.length > 0 && !args.dryRun) {
    try {
      // V26-PRICE-PROVIDER-UNIFICATION — crypto prices are acquired through the
      // SAME path as equities (coverage → acquisition plan → capability routing
      // → archive). This replaced a bespoke backfillBtcPrices that called
      // CoinGecko directly and wrote to the archive itself. Nothing here is
      // crypto-specific except resolving WHICH instrument to price.
      const btcInstrumentId = await resolveBtcInstrumentId();
      const r = await backfillHeldInstrumentPrices([btcInstrumentId], fromDate, toDate,
        (line) => console.log(`[wealth-regen] ${spaceId}: ${line}`));
      console.log(`[wealth-regen] ${spaceId}: crypto price backfill — planned ${r.planned}, ${r.inserted} row(s)`);
    } catch (e) {
      console.warn(`[wealth-regen] ${spaceId}: crypto price backfill failed (non-fatal):`, e instanceof Error ? e.message : e);
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
  // Same guard: no acquisition on a dry run. See the crypto branch above.
  if (investmentAccounts.length > 0 && !args.dryRun) {
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
    select: { date: true, isEstimated: true, stocks: true, crypto: true, cash: true, savings: true, debt: true, netWorth: true, cryptoValuationStatus: true },
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
  // Progress denominators, fixed before the day loop starts — this is exactly
  // why a determinate bar is honest for the rebuild and dishonest for the import.
  const progressTotal = candidateDates.length;
  const progressStep  = Math.max(1, Math.floor(progressTotal / 20));
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
  // V26-S2-OWNERSHIP — ONE call resolves both halves.
  //
  // This was two steps that had to be kept in agreement by hand: value the
  // window, then resolve ownership per INSTRUMENT and filter. Instrument-scoped
  // ownership let one account's evidence license another's — measured live, the
  // LLC account's cash read as KNOWN OWNED back to 2025-08-27 on the strength of
  // Robinhood's derived cash rows. And the denominator it produced counted every
  // component the valuation considered, including the ones it had just refused.
  //
  // `historicalHoldingsForWindow` composes the same valuation engine with
  // per-(account, instrument) ownership and returns the HELD set. Failure is
  // non-fatal and CONSERVATIVE exactly as before: an empty map leaves every day
  // with its flat estimate and routes it into the no-fabrication guard rather
  // than valuing it on evidence we could not confirm.
  let holdingsByDate = new Map<string, HistoricalHoldingsSet>();
  try {
    holdingsByDate = await historicalHoldingsForWindow({
      spaceId,
      dates: candidateDates,
      client,
      holdConstantBeforeEarliest: true,
      excludeDigitalAssetAccounts: true,
      // V26-S3-DETAIL — the ceiling is DERIVED from the account set's evidence,
      // not pinned to this window's end. Pinning it here made the same holding
      // on the same date resolve differently for a rebuild and for a
      // drill-down; see resolveEvidenceCeiling.
    });
  } catch (err) {
    console.warn(`[wealth-regen] ${spaceId}: historical holdings resolution failed (non-fatal, conservative): ${err instanceof Error ? err.message : err}`);
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
  const writes: Array<{
    date: Date;
    isEstimated: boolean;
    fields: NonNullable<DayRegenResult["fields"]>;
    completenessTier: DayRegenResult["tier"];
    contributingComponentCount: number | null;
    totalComponentCount: number | null;
    cryptoValuationStatus: DayRegenResult["cryptoValuationStatus"];
  }> = [];

  /**
   * V26-CRYPTO-STATUS-1 — days that are NOT rewritten but whose crypto verdict
   * must still be recorded. Applied as single-column updates (see below).
   */
  const metadataOnlyStamps: Array<{ date: Date; status: NonNullable<DayRegenResult["cryptoValuationStatus"]> }> = [];

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
    let ownershipIneligible = false;
    // V26-INVESTMENTS-HISTORY — composition of the day's investment valuation,
    // persisted alongside the tier so a stored row can distinguish "estimated
    // but complete" from "estimated and mostly unknown". Null unless a real A8
    // valuation produced the day's `investmentValue`; null means NOT RECORDED.
    let contributingComponentCount: number | null = null;
    let totalComponentCount: number | null = null;
    const holdings = holdingsByDate.get(dISO);
    if (holdings) {
      // V26-S2-OWNERSHIP — the HELD set is the answer to every question here.
      //
      // `held` is what ownership licenses on THIS date, resolved per (account,
      // instrument) from dated evidence alone. Nothing about today's portfolio
      // reaches it: a quantity projected backwards onto a date ownership does
      // not license is EXCLUDED, so the projection can supply a number for a
      // licensed date but can never put a holding into the set.
      //
      // NOT a zero-valued portfolio when nothing is held: zero is a claim, and
      // the truth is "we cannot say". Falling through with
      // hasInvestmentEvidence=false routes the day into the existing
      // NO-FABRICATION guard, which preserves the stored estimate.
      hasInvestmentEvidence = holdings.heldCount > 0;
      // Components existed and ownership refused every one — skip, never write
      // a zero-valued portfolio. See the OWNERSHIP PREHISTORY guard in
      // regenerate-history.core.ts.
      ownershipIneligible = (holdings.held.length + holdings.excluded.length) > 0 && holdings.heldCount === 0;
      if (hasInvestmentEvidence) {
        investmentValue = holdings.valuedSubtotal;
        // Inferred ownership is carried forward, never silently absorbed. The
        // valuation tier is the worst among HELD components only — a component
        // ownership refused must not degrade a day it is not part of.
        investmentTier = worstTier([
          ...holdings.held.map((h) => h.tier),
          ownershipTier(holdings.ownershipConfidence),
        ]);
        // V26-S2-OWNERSHIP — THE DENOMINATOR IS WHAT EXISTED, NOT WHAT EXISTS.
        //
        // This was `totalCount = every component the valuation considered`,
        // which with the backward quantity projection is every pair the account
        // has EVER observed — including the ones ownership had just refused.
        // Measured live on 2026-01-01: `12 of 19`, where 6 of the 19 were
        // positions the engine itself declared unowned on that date. It now
        // reads `12 of 13`: twelve valued, of thirteen actually held.
        //
        // Both counts come from the SAME set that produced `investmentValue`
        // above, so a label can never describe a different portfolio from the
        // number beside it.
        contributingComponentCount = holdings.valuedCount;
        totalComponentCount = holdings.heldCount;
      }
    }

    // Part-A — historical crypto valuation for the day: Σ (constant native
    // quantity × BTC price as-of the day), converted to the reporting currency.
    // Computed from the FULL crypto-account list (not the floored day set) so the
    // constant-quantity estimate spans the window. No BTC price reaching the day
    // ⇒ no evidence ⇒ the flat value is preserved (never fabricated).
    let digitalAssetValue = c.totalDigitalAssets;
    let hasDigitalAssetEvidence = false;
    let cryptoDayValuation: CryptoDayValuation | null = null;
    if (cryptoAccounts.length > 0) {
      const btcUsd = btcAt(dISO); // HIST-2C — from the one-shot window read above
      // V26-CRYPTO-QTY-1 — BOTH are required, and they are independent evidence:
      // a price reaching the day says nothing about what was held, and a licensed
      // quantity says nothing about what it was worth. Either one missing leaves
      // the day's crypto UNVALUED (never a carried fiat balance — see the flat
      // guard in regenerate-history.core.ts).
      // V26-S3-DETAIL — through the SHARED crypto day valuation, so the total
      // this snapshot stores and the per-position breakdown a drill-down shows
      // come from one call and cannot describe different portfolios.
      cryptoDayValuation = valueCryptoDay({
        accounts: cryptoAccounts.map((a) => ({
          financialAccountId: a.id, name: a.name, nativeBalance: a.nativeBalance, symbol: "BTC",
        })),
        unitPrice:        btcUsd,
        quantityLicensed: cryptoQuantityLicensed(dISO),
      });
      if (cryptoDayValuation.licensed) {
        // classifyAccounts still does the FX to the reporting currency — the SAME
        // conversion path every other total uses (no second FX interpretation).
        const cryptoDay = cryptoDayValuation.positions.map((p) => ({ type: "crypto", balance: p.nativeValue, currency: "USD" }));
        digitalAssetValue = classifyAccounts(cryptoDay, ctx, dISO).totalDigitalAssets;
        hasDigitalAssetEvidence = true;
      }
    }

    // V26-S2-OWNERSHIP — THE COUNTS MUST DESCRIBE THE PORTFOLIO THEY LABEL.
    //
    // These counts reach the user as "N of M positions valued" on the Investments
    // chart, whose value is investments PLUS crypto. The counts were investments
    // only, so a portfolio of one Bitcoin wallet and nothing else reported "no
    // composition recorded" while the chart happily plotted its value — and the
    // motivating case ("in 2023 I held only Bitcoin, it should read 1 of 1") was
    // not expressible at all, because crypto was never counted.
    //
    // Crypto positions are counted the way the crypto path already decides them:
    // a wallet with a material balance is a position that existed; it is VALUED
    // only when a price reached the day AND the constant-quantity carry was
    // licensed (which, since S1, also requires its movement ledger to reconcile).
    // The all-or-nothing shape of that decision is the crypto path's, not a new
    // rule invented here.
    //
    // Guarded on `hasInvestmentEvidence || cryptoPositions > 0` so a Space with
    // neither still records null — NOT RECORDED, never a fabricated zero.
    const cryptoPositions = cryptoDayValuation?.positionCount ?? 0;
    if (cryptoPositions > 0) {
      totalComponentCount = (totalComponentCount ?? 0) + cryptoPositions;
      contributingComponentCount =
        (contributingComponentCount ?? 0) + (hasDigitalAssetEvidence ? cryptoPositions : 0);
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
      ownershipIneligible,
      contributingComponentCount,
      totalComponentCount,
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

    // Throttled progress. progressStep is derived from the total so the number of
    // callbacks stays ~constant regardless of window size, and the final day
    // always reports so the bar cannot finish short of 100%.
    if (args.onProgress && (result.considered % progressStep === 0 || result.considered === progressTotal)) {
      await args.onProgress(result.considered, progressTotal);
    }
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

    // V26-PRICE-5 — classify against what is STORED before queueing a write.
    // A day that recomputes identically is UNCHANGED and is deliberately NOT
    // rewritten: beyond saving writes, a regeneration that touches thousands of
    // rows to change none is indistinguishable in an audit trail from one that
    // changed them all. BLOCKED (frozen / membership) and SKIPPED (invalid or
    // absent evidence) never reach here — the core already refused them.
    const candidate = classifyRegeneration(res, prior ?? null);
    result.dispositions[candidate.disposition]++;
    if (candidate.disposition === "UPDATED" && res.fields) {
      // V26-INVESTMENTS-HISTORY — `res.tier` was already computed here and then
      // discarded at the upsert; it is the row-level worst-of(cash/card,
      // investment, crypto) the FLIP rule derives `isEstimated` from. Persisting
      // it makes `isEstimated` derivable rather than a second, lossier truth.
      writes.push({
        date: d,
        isEstimated: res.isEstimated,
        fields: res.fields,
        completenessTier: res.tier,
        contributingComponentCount: res.contributingComponentCount,
        totalComponentCount: res.totalComponentCount,
        cryptoValuationStatus: res.cryptoValuationStatus,
      });
    }

    // V26-CRYPTO-STATUS-1 — THE METADATA-ONLY STAMP.
    //
    // A day whose crypto cannot be valued is deliberately NOT rewritten: there
    // is no correct crypto number to write, and rewriting would either assert
    // one or zero it. But the verdict itself is real evidence, and leaving it
    // unrecorded forever means the stale stored figure keeps its authority.
    //
    // So this stamps the STATUS COLUMN ALONE. Not an upsert — an `update` naming
    // exactly one field, so no financial scalar can be touched even by accident,
    // and a row that does not exist is never created (creating one would require
    // inventing the very financial fields this refuses to assert).
    //
    // Guarded on `prior.isEstimated === true`: a frozen observation is never
    // written by any path, and its status stays null forever — which costs
    // nothing, because the read boundary resolves observation BEFORE status.
    // It applies to BOTH verdicts, for the same reason. A day that recomputes
    // identically is UNCHANGED and deliberately not rewritten — but its crypto
    // was still valued from evidence, and leaving that unrecorded would strand
    // a correct value as `legacy-unrecorded` forever. Stamping is what makes the
    // repair reach every day the regeneration actually classified.
    if (
      applyWrites &&
      res.cryptoValuationStatus !== null &&
      candidate.disposition !== "UPDATED" &&
      prior && prior.isEstimated === true &&
      prior.cryptoValuationStatus !== res.cryptoValuationStatus
    ) {
      metadataOnlyStamps.push({ date: d, status: res.cryptoValuationStatus });
    }
  }

  // Only UPDATED days are written. `writes` is already filtered to them.
  if (applyWrites) {
    for (const w of writes) {
      const data = {
        ...w.fields,
        isEstimated: w.isEstimated,
        // Guarded at the write boundary, exactly as A4 guards
        // PositionObservation.completeness: no stream may smuggle a second trust
        // vocabulary into the reserved String column.
        completenessTier: isCompletenessTier(w.completenessTier) ? w.completenessTier : null,
        contributingComponentCount: w.contributingComponentCount,
        totalComponentCount: w.totalComponentCount,
        // V26-CRYPTO-STATUS-1 — same reserved-String discipline as the tier
        // above. Null on a written row means "no material crypto to authorize",
        // never "unknown but assume fine": the read boundary resolves an
        // immaterial component to `none`, which IS assertable.
        cryptoValuationStatus: toStoredCryptoValuationStatus(w.cryptoValuationStatus),
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

    // Metadata-only stamps: ONE column, no financial scalar, existing rows only.
    for (const m of metadataOnlyStamps) {
      await client.spaceSnapshot.updateMany({
        where: { spaceId, date: m.date, isEstimated: true },
        data:  { cryptoValuationStatus: m.status },
      });
    }
    result.cryptoStatusStamped = metadataOnlyStamps.length;
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
 * CONN-2 — the MAXIMUM-available wealth window: from an account set's earliest
 * real transaction to yesterday. This is the "intelligence generation window"
 * (what Fourth Meridian chooses to BUILD) — deliberately NOT the arbitrary 30-day
 * default. Fourth Meridian must not discard available history: a new connection
 * with 2 years of transactions builds 2 years of intelligence.
 *
 * PURE (testable without a DB). It never fabricates history beyond real data:
 *   - no earliest transaction  → the 30-day recent window (nothing deeper exists)
 *   - earliest is on/after yesterday → recent window (no history before yesterday)
 *   - otherwise → [earliest, yesterday]
 * regenerateWealthHistory ADDITIONALLY clamps each account to its own earliest-tx
 * floor, so passing a wide window can never invent days an account didn't have.
 */
export function wealthWindowFromEarliest(
  earliest: Date | null,
  now: Date = new Date(),
): { fromDate: string; toDate: string } {
  const recent = recentWealthWindow(now);
  if (!earliest) return recent;
  const fromDate = earliest.toISOString().slice(0, 10);
  if (fromDate >= recent.toDate) return recent; // nothing before yesterday to build
  return { fromDate, toDate: recent.toDate };
}

/**
 * Resolve the max-available wealth window for an account set (reads only the
 * earliest non-deleted transaction date). THE shared window for both the initial
 * connect (backgroundHistorySync A9) and the manual recovery path, so they build
 * identical intelligence from the same L2 authority.
 */
export async function maxAvailableWealthWindow(
  financialAccountIds: string[],
  now: Date = new Date(),
): Promise<{ fromDate: string; toDate: string }> {
  if (financialAccountIds.length === 0) return recentWealthWindow(now);
  const floor = await db.transaction.aggregate({
    where: { financialAccountId: { in: financialAccountIds }, deletedAt: null },
    _min:  { date: true },
  });
  return wealthWindowFromEarliest(floor._min.date ?? null, now);
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
  /**
   * Forwarded to each space's rebuild. With more than one space the reported
   * numbers describe the space CURRENTLY rebuilding — they restart per space
   * rather than spanning the set. A cross-space denominator would have to
   * pre-compute every space's candidate days before starting, which is most of
   * the work itself; per-space is honest about what it is measuring, and the
   * common case (one PERSONAL space) is exact.
   */
  onProgress?: (daysDone: number, daysTotal: number) => void | Promise<void>,
): Promise<string[]> {
  if (financialAccountIds.length === 0) return [];
  const links = await db.spaceAccountLink.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
    select: { spaceId: true },
  });
  const spaceIds = [...new Set(links.map((l) => l.spaceId))];
  for (const spaceId of spaceIds) {
    try {
      await regenerateWealthHistory({ spaceId, fromDate: window.fromDate, toDate: window.toDate, now: window.now, onProgress });
    } catch (err) {
      console.warn(`[wealth-regen] space ${spaceId} regeneration failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }
  return spaceIds;
}
