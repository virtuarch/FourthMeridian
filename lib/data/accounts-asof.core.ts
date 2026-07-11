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
 * Is this debt account a reconstructable revolving credit card? Parity copy of
 * lib/snapshots/backfill.ts#isReconstructableCard (which is private to that DB
 * orchestration module and cannot be imported without pulling `server-only`).
 * Kept deliberately identical so the as-of walk and the backfill walk agree on
 * exactly which debt accounts are transaction-driven:
 *   - explicit credit_card                     → yes
 *   - null subtype + a creditLimit (Plaid card) → yes
 *   - any explicit non-card subtype / no limit  → no (held flat)
 */
function isReconstructableCard(a: AsOfAccountInput): boolean {
  if (a.type !== "debt") return false;
  if (a.debtSubtype === "credit_card") return true;
  if (a.debtSubtype === null && a.creditLimit != null) return true;
  return false;
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
    if (isPresent) {
      out.set(a.id, { balance: a.balance, method: "observed", tier: "observed" });
      continue;
    }
    // Before the account existed / was linked: a gap, never a fabricated value.
    // Contributes 0 and flips the consuming Perspective to `incomplete`.
    if (asOfISO < a.floorISO) {
      out.set(a.id, { balance: 0, method: "before-coverage", tier: "incomplete" });
      continue;
    }
    if (cashIds.has(a.id)) {
      out.set(a.id, {
        balance: cashDay?.get(a.id) ?? a.balance,
        method:  "cash-walkback",
        tier:    "derived",
      });
      continue;
    }
    if (cardIds.has(a.id)) {
      out.set(a.id, {
        balance: cardDay?.get(a.id) ?? a.balance,
        method:  "card-walkback",
        tier:    "derived",
      });
      continue;
    }
    // Non-cash (investments, crypto, manual assets, installment loans): no
    // history to walk, so held flat at today's value and marked estimated.
    out.set(a.id, { balance: a.balance, method: "held-flat", tier: "estimated" });
  }
  return out;
}
