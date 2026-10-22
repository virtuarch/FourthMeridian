/**
 * lib/ai/conversation/tools/income.ts
 *
 * Income tools: `get_income` and `get_pay_dates`.
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
import { loadForecastIncomeStreams } from '@/lib/ai/forecast/streams';
import { resolvePayDates, PayDateAsk } from '@/lib/ai/forecast/pay-dates';
import { continuationOf } from '@/lib/ai/forecast/income-completeness';
import type { ToolDefinition } from './types';
import { obj, str } from './shared/schema';
import { clampToCeiling, daysAgoISO } from './shared/values';
import { assemble } from './shared/reads';

// ── 4. Income + payroll cadence ──────────────────────────────────────────────

export const getIncome: ToolDefinition = {
  name: 'get_income',
  description:
    'Income by month AND the derived payroll cadence per source (biweekly, ' +
    'semimonthly, monthly), with each source\'s typical amount and whether it is ' +
    'still active. Use this before concluding income rose or fell — a month can ' +
    'hold two or three biweekly paychecks.',
  parameters: obj({
    from: str('YYYY-MM-DD. Omit for the 12 months before `to`.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
    asOf: str('Information ceiling: pretend today is this date. Nothing after it is read.'),
  }),
  async run(a, ctx) {
    const ceiling = (a.asOf as string) || ctx.asOfISO;
    const to   = clampToCeiling((a.to as string) || ceiling, ceiling);
    const from = (a.from as string) || daysAgoISO(to, 364);
    const [t, streams] = await Promise.all([
      assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
        { transactionWindow: { startDate: from, endDate: to, label: `income ${from}..${to}` } }),
      // ⚠️ THE CEILING REACHES THE CADENCE AUTHORITY TOO, and this is the half that
      // matters. `loadForecastIncomeStreams(asOf)` reconstructs the income world as
      // it WAS: at 2026-01-01 the Abacus payroll is CURRENT and Vectrus does not
      // exist yet; at 2026-09-07 Vectrus is CURRENT and Abacus is SILENT. Passing
      // today's date here while windowing the totals to last year would describe an
      // old year with this year's employer.
      loadForecastIncomeStreams(ctx.readClient, ctx.spaceId, ceiling),
    ]);
    return {
      asOf: ceiling,
      window: { from, to },
      byMonth: (t?.monthlyBreakdown ?? []).map((m) => ({
        month: m.month, income: m.incomeTotal, partialMonth: m.partial ?? false,
      })),
      // The cadence half. This is the evidence that distinguishes a three-paycheck
      // month from a pay cut, and it comes from FORECAST-1/2, not from arithmetic here.
      sources: streams.map((s) => ({
        // ⚠️ THE KEY, NOT ONLY THE NAME (I1). `incomeChanges.source` documented
        // itself as taking a `sourceKey` "from get_pay_dates or get_income", and
        // this returned a label and no key — a documented affordance that did not
        // exist. Measured: the model fabricated `id:<an account id it saw
        // elsewhere>`, which was refused, and the salary replacement never ran.
        sourceKey: s.sourceKey,
        label: s.label,
        cadence: typeof s.cadence === 'object' && s.cadence && 'kind' in s.cadence
          ? (s.cadence as { kind: string }).kind : null,
        typicalAmount: s.amount?.assertable ? s.amount.value : null,
        currency: s.amount?.assertable ? s.amount.currency : null,
        activity: s.activity.state,
        stillPaying: s.projectionEligible,
        continuation: continuationOf(s),
        why: s.activity.reason,
        observationCount: s.observationCount,
        seriesTruncated: s.truncated,
      })),
      incomeSources: t?.incomeSources?.items,
    };
  },
};

// ── 9. Pay dates ─────────────────────────────────────────────────────────────

export const getPayDates: ToolDefinition = {
  name: 'get_pay_dates',
  description:
    'Upcoming expected pay dates per income source, generated from observed ' +
    'cadence. Only sources still licensed to continue produce dates.',
  parameters: obj({
    through: str('YYYY-MM-DD. Omit to get the next few occurrences.'),
    nextOnly: { type: 'boolean', description: 'True for just the next one.' },
  }),
  async run(a, ctx) {
    const streams = await loadForecastIncomeStreams(ctx.readClient, ctx.spaceId, ctx.asOfISO);
    const r = resolvePayDates(streams, ctx.asOfISO, {
      ask: a.nextOnly ? PayDateAsk.NEXT_ONE : PayDateAsk.UPCOMING,
      ...(a.through ? { stated: { toISO: String(a.through), statedAs: `through ${a.through}` } } : {}),
    });
    return { from: r.fromISO, to: r.toISO, sources: r.streams, none: r.empty };
  },
};
