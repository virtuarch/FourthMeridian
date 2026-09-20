/**
 * lib/transactions/debt-service.ts   (post-M1 D3)
 *
 * THE answer to "how much of what I paid toward debt actually REDUCED debt?"
 *
 * Pure: no DB, no React, no clock. It adds NO classifier — every fact below is
 * read from an authority that already exists:
 *
 *   · which rows are debt payments      → selectDebtPaymentCashLegs
 *   · which account is a liability      → LiquidityContext.tierOf
 *   · which rows are costs / refunds    → flow-predicates (isCostFlow / isRefund)
 *   · which inflow is borrowed money    → classifyLiquidity reason DEBT_PROCEEDS
 *   · how refunds net against spend     → clampEconomicSpend
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * The economic net (`income − spending`) counts a purchase made ON A CARD as
 * spending the day it happened — correctly; that is what the economic axis is
 * for. The card payment that later settles that purchase is a DEBT_PAYMENT cash
 * leg. `economic net − debt payments` therefore subtracts the same consumption
 * TWICE: once as the purchase, once as its settlement. A household that earns
 * 10,000, puts 6,000 of spending on a card and pays the card in full has a
 * 4,000 surplus; the old subtraction reported −2,000 and graded the deficit
 * `DEBT_DRIVEN`.
 *
 * ── The identity ────────────────────────────────────────────────────────────
 *
 * Split spending by WHERE it was charged. Spending charged to a liquid account
 * drained cash when it happened. Spending charged to a liability did not — it
 * raised what is owed, and cash leaves later, inside a debt payment. So on a
 * cash basis, with respect to liabilities:
 *
 *     cash net = income − spending(liquid) − payments + borrowed cash
 *              = economic net + newChargesOnLiabilities + debtProceeds − payments
 *              = economic net − (payments − newChargesOnLiabilities − debtProceeds)
 *
 * The bracket is the NET PAYDOWN: the part of the cash sent to liabilities that
 * did not merely settle charges the economic net already counted, and was not
 * itself funded by new borrowing. It is, by the same identity, the flow-side
 * reconstruction of how far what is owed FELL over the window on the
 * liabilities the ledger can see. When it is negative the window was a net
 * BORROWING one (charges and advances outran payments).
 *
 * This is deterministic from the window's own rows. It does not need to know
 * WHICH purchases a given payment settled: a full-payer's payments settle last
 * month's statement while this month's charges accrue, and in steady state the
 * two cancel; where they do not, the difference is a real change in the balance
 * owed, which is exactly what the figure claims and no more.
 *
 * ── What each case resolves to ──────────────────────────────────────────────
 *
 *   · Settlement of purchases already in spending — payments ≈ new charges ⇒
 *     net paydown ≈ 0 ⇒ no deficit is manufactured.
 *   · Principal reduction of pre-existing / revolving debt — payments exceed new
 *     charges ⇒ net paydown > 0: a real use of cash that is NOT consumption.
 *   · Interest and fees charged to a liability — they are COST flows, already in
 *     spending, and they sit in `newChargesOnLiabilities`, so the payment that
 *     covers them is not counted against the household a second time.
 *   · Loan / mortgage payments — principal is in spending nowhere, so it lands
 *     whole in net paydown; any interest row the lender posted nets out as above.
 *     A liability that is NOT connected contributes no charges at all, so its
 *     payments stay whole too — correct, because its purchases never entered
 *     spending either and there is nothing to double count.
 *   · Financing (charges outrun payments), cash advances, loan proceeds — new
 *     borrowing. It offsets payments (refinancing a card with a loan is not a
 *     paydown), and any excess is disclosed as `netNewBorrowing`. It NEVER
 *     improves the after-paydown net: borrowed money is not a surplus.
 *   · Balance transfers — liability → liability, no liquid leg: not a payment,
 *     not a charge, not proceeds. Nothing here moves.
 *
 * ⚠️ Evidence is POSITIVE (the v2.6-DEBT-1 rule). A charge offsets payments only
 * when its own account is a known liability; proceeds only when the liquidity
 * authority names them DEBT_PROCEEDS on a liquid account. An account of unknown
 * tier offsets nothing — the figure then errs toward reporting a paydown, never
 * toward hiding one.
 *
 * ── Four quantities share the words "debt payment"; this is ONE of them ─────
 *
 *   1. OBSERVED flow — counted cash legs (`payments` here; `debtPaymentTotal`,
 *      `measure_flows(cardAndDebtPayments)`). History. Not an obligation.
 *   2. Σ stated minimums NOW — lib/debt/aggregates.ts. A contractual floor.
 *   3. The payoff planner's CHOSEN payment — lib/debt/payoff.ts. A user budget.
 *   4. L1's PROJECTED minimums — lib/ai/conversation/scenario-ledger.ts. A forecast.
 *   Nothing in this module may be substituted for 2–4, or they for it.
 */

import { classifyLiquidity, type LiquidityContext, type LiquidityTx } from "@/lib/transactions/liquidity";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import { isCostFlow, isRefund } from "@/lib/transactions/flow-predicates";
import { clampEconomicSpend } from "@/lib/transactions/cash-flow";

/** What the cash sent toward liabilities in a window actually did. All ≥ 0. */
export interface DebtService {
  /** Σ|amount| over the debt-payment authority's counted CASH legs. */
  payments: number;
  /**
   * Cost flows (SPENDING + FEE + INTEREST) charged to liability-tier accounts,
   * net of refunds to those accounts, clamped ≥ 0. A SUBSET of economic
   * spending — the part a debt payment settles rather than adds to.
   */
  newChargesOnLiabilities: number;
  /** Borrowed money that arrived as cash (advance / loan funded to a liquid account). */
  debtProceeds: number;
  /**
   * max(0, payments − newChargesOnLiabilities − debtProceeds): cash that reduced
   * what is owed. The ONLY part of `payments` that may be subtracted from the
   * economic net without counting consumption twice.
   */
  netPaydown: number;
  /** max(0, newChargesOnLiabilities + debtProceeds − payments): what is owed grew by this, from flows. */
  netNewBorrowing: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Decompose a window's debt service from ANY row set (both legs, the whole
 * banking population — selection is this module's job, not the caller's).
 *
 * `magnitude` converts and absolutes a row (the caller owns the money context,
 * so this stays pure); returning `null` EXCLUDES the row — the caller's rule for
 * unconvertible or non-economic rows applies here exactly as it does to the
 * totals this sits beside.
 */
export function computeDebtService<T extends LiquidityTx>(
  rows: readonly T[],
  ctx: LiquidityContext,
  magnitude: (row: T) => number | null,
): DebtService {
  const counted = new Set<T>(selectDebtPaymentCashLegs(rows, ctx).counted);

  let payments = 0;
  let charges  = 0;
  let refunds  = 0;
  let proceeds = 0;

  for (const r of rows) {
    const m = magnitude(r);
    if (m === null) continue;
    const mag = Math.abs(m);

    if (counted.has(r)) { payments += mag; continue; }

    const ownTier = ctx.tierOf(r.financialAccountId ?? r.accountId ?? null);
    const ft = r.flowType ?? null;

    if (ownTier === "liability") {
      // Same membership as DayFacts.creditCardSpending (cash-flow-projection.ts):
      // a cost flow whose own account is a liability.
      if (isCostFlow(ft)) charges += mag;
      else if (isRefund(ft)) refunds += mag;
      continue;
    }

    if (ownTier === "liquid" && classifyLiquidity(r, ctx).reason === "DEBT_PROCEEDS") {
      proceeds += mag;
    }
  }

  const newCharges = clampEconomicSpend(charges, refunds);
  const net = payments - newCharges - proceeds;
  return {
    payments:                round2(payments),
    newChargesOnLiabilities: round2(newCharges),
    debtProceeds:            round2(proceeds),
    netPaydown:              round2(Math.max(0, net)),
    netNewBorrowing:         round2(Math.max(0, -net)),
  };
}

/**
 * The economic net after the cash that genuinely went to reducing debt.
 *
 * ≤ the economic net, always: new borrowing is never credited as surplus, so a
 * household whose spending exceeds its income still reads as exactly that
 * however the gap was financed.
 */
export function netAfterDebtPaydown(economicNet: number, service: DebtService): number {
  return economicNet - service.netPaydown;
}
