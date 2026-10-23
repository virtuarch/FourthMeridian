/**
 * lib/data/accounts-asof.core.ts
 *
 * A5-S2 — PURE as-of balance resolution. No DB, no Prisma, no `new Date()`
 * inside the tested function (today + asOf are passed in), so this unit-tests
 * without `prisma generate`, exactly like lib/snapshots/backfill-core.ts (whose
 * walk-backs it reuses unmodified).
 *
 * Given each account's current balance and its per-(account,day) signed
 * transaction deltas, resolve every account's balance to a single historical
 * `asOf` date and stamp each with { method, tier } so the caller (a lens
 * binding) can build an honest Completeness envelope without re-deriving trust:
 *
 *   cash (checking/savings)  → reconstructDailyCashBalances walk-back  → derived
 *   revolving credit card    → reconstructDailyLiabilityBalances walk  → derived
 *   everything else          → held flat at the current balance        → estimated
 *   before the account's floor (created / linked)                      → incomplete
 *   asOf on/after today (the present)                                   → observed
 *
 * The tier vocabulary is the A5-S1 canon (CompletenessTier); the walk-back math
 * is backfill-core's, imported as-is. This module owns neither — it composes them.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import {
  reconstructDailyCashBalances,
  reconstructDailyLiabilityBalances,
  isReconstructableCard,
  addDaysUTC,
  truncDateUTC,
  isoDate,
  type CashAccountBalance,
} from "@/lib/snapshots/backfill-core";

/** How an as-of balance was arrived at — the mechanism behind its tier. */
export type AsOfMethod =
  | "observed"        // asOf is the present: the current provider/user balance
  | "cash-walkback"   // checking/savings walked back through transactions
  | "card-walkback"   // revolving card owed walked back through transactions
  | "held-flat"       // non-cash held at today's value (no history to walk)
  | "before-coverage"; // asOf predates the account's created/linked floor

/** One account's balance resolved to a single as-of date. */
export interface ResolvedAsOfBalance {
  balance: number;
  method:  AsOfMethod;
  tier:    CompletenessTier;
}

/** Minimal per-account input the resolver needs — no names, no institutions. */
export interface AsOfAccountInput {
  id:          string;
  type:        string;         // checking | savings | debt | investment | crypto | other | …
  balance:     number;         // current balance = end-of-day(today)
  debtSubtype: string | null;  // gates revolving-card reconstruction (see isReconstructableCard)
  creditLimit: number | null;  // the only stored revolving-credit signal on null-subtype debt
  /** Earliest defensible date (YYYY-MM-DD): max(account.createdAt, link.createdAt). */
  floorISO:    string;
}

/**
 * Resolve every account's balance to `asOf`, returning id → { balance, method,
 * tier }. Deterministic: identical inputs (including `today` and `asOf`) yield
 * an identical Map. Never mutates its inputs.
 *
 * `cashDeltas` / `cardDeltas` are accountId → (isoDate → Σ signed amount posted
 * that day), the same shape backfill.ts builds and the walk-backs consume —
 * only cash-account ids appear in `cashDeltas`, only card ids in `cardDeltas`.
 */
export function resolveAccountsAsOf(
  accounts:   AsOfAccountInput[],
  cashDeltas: Map<string, Map<string, number>>,
  cardDeltas: Map<string, Map<string, number>>,
  today:      Date,
  asOf:       Date,
): Map<string, ResolvedAsOfBalance> {
  const t0      = truncDateUTC(today);
  const asOfDay = truncDateUTC(asOf);
  const asOfISO = isoDate(asOfDay);

  // The present (or future) is answered by the current, provider-observed
  // balance — there is nothing to walk back. Short-circuit before touching the
  // walk-backs (which never reconstruct today itself).
  const isPresent = asOfDay.getTime() >= t0.getTime();

  const cashAccounts: CashAccountBalance[] = accounts
    .filter((a) => a.type === "checking" || a.type === "savings")
    .map((a) => ({ id: a.id, balance: a.balance }));
  const cardAccounts: CashAccountBalance[] = accounts
    .filter(isReconstructableCard)
    .map((a) => ({ id: a.id, balance: a.balance }));

  // Walk only as far back as asOf (the walks hold flat below an account's
  // earliest transaction, exactly as the backfill does). Skipped entirely when
  // asOf is the present.
  const dailyCash = isPresent
    ? new Map<string, Map<string, number>>()
    : reconstructDailyCashBalances(cashAccounts, cashDeltas, t0, asOfDay);
  const dailyCard = isPresent
    ? new Map<string, Map<string, number>>()
    : reconstructDailyLiabilityBalances(cardAccounts, cardDeltas, t0, asOfDay);

  const cashDay = dailyCash.get(asOfISO); // accountId → walked balance, or undefined
  const cardDay = dailyCard.get(asOfISO);
  const cashIds = new Set(cashAccounts.map((a) => a.id));
  const cardIds = new Set(cardAccounts.map((a) => a.id));

  const out = new Map<string, ResolvedAsOfBalance>();
  for (const a of accounts) {
    out.set(a.id, resolveOne(a, {
      isPresent, dayISO: asOfISO, cashDay, cardDay, cashIds, cardIds,
    }));
  }
  return out;
}

/** Everything the per-account precedence needs for ONE day. */
interface DayContext {
  isPresent: boolean;
  dayISO:    string;
  cashDay:   Map<string, number> | undefined;
  cardDay:   Map<string, number> | undefined;
  cashIds:   Set<string>;
  cardIds:   Set<string>;
}

/**
 * THE precedence, in one place, for one account on one day:
 *
 *   1. the present            → the observed balance
 *   2. before the floor       → a gap, never a fabricated value
 *   3. cash / card            → the licensed walk-back
 *   4. everything else        → held flat, and SAID so
 *
 * Extracted so the single-date and windowed resolvers cannot drift apart. Two
 * copies of this ladder would be two answers to the same question.
 */
function resolveOne(a: AsOfAccountInput, ctx: DayContext): ResolvedAsOfBalance {
  if (ctx.isPresent) return { balance: a.balance, method: "observed", tier: "observed" };
  // Before the account existed / was linked: a gap, never a fabricated value.
  // Contributes 0 and flips the consuming Perspective to `incomplete`.
  if (ctx.dayISO < a.floorISO) return { balance: 0, method: "before-coverage", tier: "incomplete" };
  if (ctx.cashIds.has(a.id)) {
    return { balance: ctx.cashDay?.get(a.id) ?? a.balance, method: "cash-walkback", tier: "derived" };
  }
  if (ctx.cardIds.has(a.id)) {
    return { balance: ctx.cardDay?.get(a.id) ?? a.balance, method: "card-walkback", tier: "derived" };
  }
  // Non-cash (investments, crypto, manual assets, installment loans): no
  // history to walk, so held flat at today's value and marked estimated.
  return { balance: a.balance, method: "held-flat", tier: "estimated" };
}

/**
 * v2.6-C — the SAME resolution, over a WINDOW: isoDate → (accountId → resolved).
 *
 * The walk-backs already produce every day between `from` and today in a single
 * reverse pass, so a window costs exactly what one as-of date costs. Calling
 * `resolveAccountsAsOf` once per day would re-walk the whole history N times to
 * read one row out of each pass.
 *
 * Every day goes through `resolveOne`, so a windowed series and a single as-of
 * read of the same date are the same number BY CONSTRUCTION — not by a test that
 * remembers to check.
 *
 * `deltas` must be POSTED-ONLY, same as the single-date path: the anchor is the
 * posted `FinancialAccount.balance`, and reversing an unsettled row would mix
 * bases and inject a phantom.
 */
export function resolveAccountsOverWindow(
  accounts:   AsOfAccountInput[],
  cashDeltas: Map<string, Map<string, number>>,
  cardDeltas: Map<string, Map<string, number>>,
  today:      Date,
  from:       Date,
  to:         Date,
): Map<string, Map<string, ResolvedAsOfBalance>> {
  const t0      = truncDateUTC(today);
  const fromDay = truncDateUTC(from);
  const toDay   = truncDateUTC(to);

  const cashAccounts: CashAccountBalance[] = accounts
    .filter((a) => a.type === "checking" || a.type === "savings")
    .map((a) => ({ id: a.id, balance: a.balance }));
  const cardAccounts: CashAccountBalance[] = accounts
    .filter(isReconstructableCard)
    .map((a) => ({ id: a.id, balance: a.balance }));

  // ONE reverse pass each, covering the whole window.
  const pastWindow = fromDay.getTime() < t0.getTime();
  const dailyCash = pastWindow
    ? reconstructDailyCashBalances(cashAccounts, cashDeltas, t0, fromDay)
    : new Map<string, Map<string, number>>();
  const dailyCard = pastWindow
    ? reconstructDailyLiabilityBalances(cardAccounts, cardDeltas, t0, fromDay)
    : new Map<string, Map<string, number>>();

  const cashIds = new Set(cashAccounts.map((a) => a.id));
  const cardIds = new Set(cardAccounts.map((a) => a.id));

  const out = new Map<string, Map<string, ResolvedAsOfBalance>>();
  for (let d = fromDay; d.getTime() <= toDay.getTime(); d = addDaysUTC(d, 1)) {
    const dayISO = isoDate(d);
    const ctx: DayContext = {
      isPresent: d.getTime() >= t0.getTime(),
      dayISO,
      cashDay: dailyCash.get(dayISO),
      cardDay: dailyCard.get(dayISO),
      cashIds, cardIds,
    };
    const perAccount = new Map<string, ResolvedAsOfBalance>();
    for (const a of accounts) perAccount.set(a.id, resolveOne(a, ctx));
    out.set(dayISO, perAccount);
  }
  return out;
}
