/**
 * lib/ai/conversation/tools/spending.ts
 *
 * Spending summary: `get_spending`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { FinanceDomains, type TransactionsSummaryData } from '@/lib/ai/types';
import { clampEconomicSpend, meanMonthlyEconomicSpend } from '@/lib/transactions/cash-flow';
import { categoryDefinition } from '@/lib/transactions/category-vocabulary';
import type { ToolDefinition } from './types';
import { obj, str } from './shared/schema';
import { clampToCeiling, daysAgoISO } from './shared/values';
import { absentIn, assemble } from './shared/reads';

// ── 2. Spending / cash flow ──────────────────────────────────────────────────

export const getSpending: ToolDefinition = {
  name: 'get_spending',
  description:
    'WHAT the money went on over a window up to ~26 months: category and merchant ' +
    'rollups, month-by-month, largest expense, recurring merchants, with transfers and ' +
    'card payments kept separate from spending. This is the evidence behind a window. ' +
    'For HOW MUCH per month, MORE OR LESS than another period, runway, surplus or ' +
    '"N months of expenses", use measure_flows / get_baselines — they compute the ' +
    'figure and the comparison; never divide this tool\'s totals yourself. What a spending ' +
    'CUT or change would do ("cut Dining 20%", "spend less on Other") is not measured here: ' +
    'it is scenario_projection\'s `spendingChanges` (or stage_assumptions) — never apply a ' +
    'percentage to these totals in prose. Default window is the last 90 days.',
  parameters: obj({
    from: str('YYYY-MM-DD inclusive. Omit for the 90 days before `to`.'),
    to:   str('YYYY-MM-DD inclusive. Omit for today.'),
    asOf: str('Information ceiling: pretend today is this date. Nothing after it is read.'),
  }),
  async run(a, ctx) {
    const ceiling = (a.asOf as string) || ctx.asOfISO;
    const to   = clampToCeiling((a.to as string) || ceiling, ceiling);
    const from = (a.from as string) || daysAgoISO(to, 89);
    const t = await assemble<TransactionsSummaryData>(
      FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
      { transactionWindow: { startDate: from, endDate: to, label: `${from}..${to}` } });
    if (!t) {
      return absentIn(ctx, `no transactions between ${from} and ${to}`,
        `transactions between ${from} and ${to}`);
    }

    // FM-AUDIT-007 — spending here is the SAME economic figure get_baselines and
    // the cash projection use: charges LESS the refunds and reversals dated in the
    // same month, floored at 0 (`clampEconomicSpend`). The gross (what was charged)
    // travels beside it, named, never as the headline.
    const months = t.monthlyBreakdown.map((m) => ({
      month: m.month, income: m.incomeTotal,
      spending: clampEconomicSpend(m.expenseTotal, m.refundTotal),
      spendingCharged: m.expenseTotal, refundsAndReversals: m.refundTotal,
      cardAndDebtPayments: m.debtPaymentTotal, transfers: m.transferTotal,
      transactionCount: m.transactionCount, partialMonth: m.partial ?? false,
    }));
    // Whole months only. A partial month is a fraction of a month's spending and
    // averaging it in understates every month beside it. The monthly figure is
    // `meanMonthlyEconomicSpend` — THE one monthly-spending mean (NET-BASELINE-1),
    // not arithmetic in this adapter.
    const wholeMonths = t.monthlyBreakdown.filter((m) => !(m.partial ?? false));
    const econ = wholeMonths.length >= 2
      ? meanMonthlyEconomicSpend(wholeMonths.map((m) => ({ month: m.month, expenseTotal: m.expenseTotal, refundTotal: m.refundTotal })))
      : null;
    const pick = (cmp: (a: number, b: number) => boolean) => econ
      ? econ.months.reduce((best, x) => (cmp(x.net, best.net) ? x : best), econ.months[0]) : null;
    const low = pick((a, b) => a < b), high = pick((a, b) => a > b);
    const monthly = econ ? {
      completeMonths: econ.months.length,
      perCompleteMonth: econ.net,
      ...(econ.material ? { chargedPerCompleteMonth: econ.gross, refundEffect: econ.refundEffect } : {}),
      lowest:  { month: low!.month,  spending: low!.net },
      highest: { month: high!.month, spending: high!.net },
      basis:
        'Economic spending per WHOLE calendar month in this window — what the months COST: charges '
        + 'less the refunds and reversals dated in the same month, the same figure get_baselines '
        + 'measures; card and debt payments and movements between your own accounts are NOT in it. '
        + 'Use these rather than dividing a window total. '
        + 'This is what was spent, not a core or recurring commitment: a month containing a one-off '
        + 'purchase is in the mean, and a debt payoff is not spending at all. Say which month a figure '
        + 'came from when the spread matters.',
    } : null;

    // Spending LINES only, from the canonical ledger (FM-AUDIT-004); a provider-
    // bucket line carries what it actually contains (Dining holds groceries).
    const spendingLines = t.byCategory
      .filter((c) => categoryDefinition(c.category)?.role === 'SPENDING' && (c.total > 0 || (c.refundTotal ?? 0) > 0))
      .map((c) => {
        const def = categoryDefinition(c.category)!;
        return { ...c, ...(def.observability === 'DERIVED' ? { contains: def.meaning } : {}) };
      });

    return {
      window: { from: t.startDate, to: t.endDate, days: t.windowDays,
        transactionCount: t.transactionCount, truncated: t.truncated },
      totals: {
        income: t.incomeTotal,
        spending: clampEconomicSpend(t.expenseTotal, t.refundTotal),
        spendingCharged: t.expenseTotal, refundsAndReversals: t.refundTotal,
        netCashFlow: t.netCashFlow,
        // Named apart on purpose: on a Space where cards are paid in full these
        // are transfers to a card, not debt burden, and the purchases they settle
        // are already inside `spending`.
        cardAndDebtPayments: t.debtPaymentTotal,
        transfersBetweenOwnAccounts: t.transferTotal,
      },
      // `total` is what the line was CHARGED; `netTotal` (present when refunds or
      // reversals hit it) is what it COST. Lines reconcile: Σ total = spendingCharged.
      byCategory: spendingLines,
      byMonth: months,
      // ⚠️ THE MONTHLY FIGURE, COMPUTED OVER WHOLE MONTHS — because dividing a
      // window total by its length is where "how long would my cash last"
      // quietly goes wrong. On this Space ordinary spending ran $2,290 in one
      // month and $14,142 in another; a mean alone describes neither, and a
      // window that opens or closes mid-month puts a fraction of a month's
      // spending against a whole one. Nothing here is a burn rate, a target or
      // a recommendation — it is the spread the months actually have.
      ...(monthly ? { monthlySpending: monthly } : {}),
      largestExpense: t.largestExpense,
      topMerchants: t.merchants
        ? { shown: t.merchants.items.slice(0, 12), ofTotalMerchants: t.merchants.totalCount }
        : undefined,
      recurring: t.recurringCandidates?.slice(0, 12),
      uncategorisedCount: t.unclassifiedCount,
    };
  },
};
