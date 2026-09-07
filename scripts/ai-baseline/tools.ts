/**
 * scripts/ai-baseline/tools.ts
 *
 * THE TOOL SURFACE — ten adapters over authorities that already exist.
 *
 * ⚠️ ADAPTERS, NOT AUTHORITIES. Not one line here computes a financial figure.
 * Every tool resolves parameters, calls a canonical function, and reshapes the
 * result into something compact and semantically explicit. If a tool ever needs
 * to add two money numbers together, that is a signal the composition belongs in
 * an authority, not here.
 *
 * ⚠️ READ AND CALCULATE ONLY. No tool writes anything. There is no correction
 * tool, no categorise tool, no memory tool — the harness must be incapable of
 * mutating financial data, and a test asserts the shape of every schema.
 *
 * ⚠️ THE VOCABULARY IS THE USER'S, NOT THE ARCHITECTURE'S. `get_spending`, not
 * `assembleTransactionsSummary`; `explain_net_worth_change`, not
 * `resolveExplorationNode`. A model should not have to learn Fourth Meridian's
 * internal names to ask a question, and exposing them would leak the thing the
 * reset removed.
 */

import { getAssembler } from '@/lib/ai/assembler-registry';
import {
  FinanceDomains,
  type AccountsSectionData, type TransactionsSummaryData,
  type HoldingsSummaryData, type SpaceContext_AI,
} from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import { queryTransactions } from '@/lib/data/transaction-query';
import { getRecentSnapshots } from '@/lib/data/snapshots';
import { resolveExplorationNode } from '@/lib/history/exploration';
import { loadForecastIncomeStreams } from '@/lib/ai/forecast/streams';
import { assembleForecast } from '@/lib/ai/forecast/assemble';
import { resolvePayDates, PayDateAsk } from '@/lib/ai/forecast/pay-dates';
// ⚠️ NOTHING HERE IMPORTS lib/forecast/** DIRECTLY, AND A GUARD ENFORCES IT.
// FORECAST-6/8/9 each carry a "consumed only through the sanctioned adapter"
// test, and this harness is production code to those tests. `assembleForecast`
// re-exports the vocabulary its own callers need, which is the seam working as
// designed — the first draft reached past it for `explainForecast` and three
// suites failed, correctly.
import {
  AssumptionOrigin, PeriodBasis, StatementMode,
  type AssembledForecast, type ForecastHorizon, type UserStatement,
} from './forecast-vocabulary';
import { applyInvestmentScenario, type ScenarioComponent } from './scenario';
import type { SpaceContext } from '@/lib/space';

// ── The tool contract ────────────────────────────────────────────────────────

export interface ToolContext {
  spaceCtx: SpaceContext;
  spaceId:  string;
  /** The clock for the whole run, so two tools can never disagree about today. */
  asOfISO:  string;
}

export interface ToolDefinition {
  name:        string;
  description: string;
  /** JSON Schema for the arguments. Kept small — a model reads these every turn. */
  parameters:  Record<string, unknown>;
  run:         (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

const round2 = (n: number) => Math.round(n * 100) / 100;
const daysAgoISO = (asOf: string, n: number) =>
  new Date(Date.parse(`${asOf}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function assemble<T>(
  domain: string, ctx: ToolContext, options: Record<string, unknown> = {},
): Promise<T | null> {
  const a = getAssembler(domain);
  if (!a) return null;
  const section = await a(ctx.spaceCtx, { scopeHint: 'full', ...options } as never);
  return (section?.data as T) ?? null;
}

// ── 1. Snapshot ──────────────────────────────────────────────────────────────

const getFinancialSnapshot: ToolDefinition = {
  name: 'get_financial_snapshot',
  description:
    'Current position: cash, net worth, assets, liabilities, per-account balances with ' +
    'freshness, and the canonical investment composition. Start here for anything broad.',
  parameters: obj({}),
  async run(_a, ctx) {
    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    if (!acc) return { unavailable: 'no accounts in scope' };
    return {
      asOf: ctx.asOfISO,
      netWorth: acc.netWorth, totalAssets: acc.totalAssets,
      totalLiabilities: acc.totalLiabilities, cash: acc.totalLiquid,
      counts: acc.counts,
      // CF-7's composer is the authority on what "investments" means; the two
      // components are disjoint by construction and must not be re-derived.
      investmentComposition: composeInvestments(acc),
      accounts: (acc.accounts ?? []).map((a) => ({
        name: a.name, type: a.type, institution: a.institution,
        balance: a.reportingBalance, currency: a.currency,
        amountOwed: a.amountOwed, creditBalance: a.creditBalance, liabilityState: a.liabilityState,
        apr: a.apr, minimumPayment: a.minimumPayment,
        freshness: a.balanceFreshness?.band, needsReauth: a.needsReauth,
        available: a.availableQuantity?.label && a.availableQuantity?.amount !== undefined
          ? { label: a.availableQuantity.label, amount: a.availableQuantity.amount } : undefined,
      })),
      missingDebtFields: acc.knowledgeGaps,
      totalsEstimated: acc.totalsEstimated,
    };
  },
};

// ── 2. Spending / cash flow ──────────────────────────────────────────────────

const getSpending: ToolDefinition = {
  name: 'get_spending',
  description:
    'Deterministic spending and cash-flow totals over any window up to ~26 months: ' +
    'category and merchant rollups, month-by-month, largest expense, transfers and ' +
    'card payments kept separate from spending. Default window is the last 90 days.',
  parameters: obj({
    from: str('YYYY-MM-DD inclusive. Omit for the last 90 days.'),
    to:   str('YYYY-MM-DD inclusive. Omit for today.'),
  }),
  async run(a, ctx) {
    const to   = (a.to   as string) || ctx.asOfISO;
    const from = (a.from as string) || daysAgoISO(to, 89);
    const t = await assemble<TransactionsSummaryData>(
      FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
      { transactionWindow: { startDate: from, endDate: to, label: `${from}..${to}` } });
    if (!t) return { unavailable: `no transactions between ${from} and ${to}` };
    return {
      window: { from: t.startDate, to: t.endDate, days: t.windowDays,
        transactionCount: t.transactionCount, truncated: t.truncated },
      totals: {
        income: t.incomeTotal, spending: t.expenseTotal, refunds: t.refundTotal,
        netCashFlow: t.netCashFlow,
        // Named apart on purpose: on a Space where cards are paid in full these
        // are transfers to a card, not debt burden, and the purchases they settle
        // are already inside `spending`.
        cardAndDebtPayments: t.debtPaymentTotal,
        transfersBetweenOwnAccounts: t.transferTotal,
      },
      byCategory: t.byCategory,
      byMonth: t.monthlyBreakdown.map((m) => ({
        month: m.month, income: m.incomeTotal, spending: m.expenseTotal,
        cardAndDebtPayments: m.debtPaymentTotal, transfers: m.transferTotal,
        transactionCount: m.transactionCount, partialMonth: m.partial ?? false,
      })),
      largestExpense: t.largestExpense,
      topMerchants: t.merchants
        ? { shown: t.merchants.items.slice(0, 12), ofTotalMerchants: t.merchants.totalCount }
        : undefined,
      recurring: t.recurringCandidates?.slice(0, 12),
      uncategorisedCount: t.unclassifiedCount,
    };
  },
};

// ── 3. Transactions ──────────────────────────────────────────────────────────

const getTransactions: ToolDefinition = {
  name: 'get_transactions',
  description:
    'Individual transactions, filtered and ranked. Use for "show me exactly", ' +
    '"what was my biggest purchase", or to check a specific merchant.',
  parameters: obj({
    from:     str('YYYY-MM-DD inclusive.'),
    to:       str('YYYY-MM-DD inclusive.'),
    category: str('One presentation category, e.g. Dining, Shopping, Travel, Other.'),
    text:     str('Case-insensitive substring over merchant and description.'),
    sort:     { type: 'string', enum: ['newest', 'oldest', 'largest'],
                description: 'Default newest. "largest" ranks by absolute amount.' },
    limit:    num('1–50. Default 15.'),
  }),
  async run(a, ctx) {
    const limit = Math.min(Math.max(Number(a.limit ?? 15), 1), 50);
    const wantLargest = String(a.sort ?? 'newest') === 'largest';
    // ⚠️ THE READ AUTHORITY SORTS BY DATE ONLY (newest|oldest). "Largest" is a
    // presentation ranking over a bounded page, so it is done here — over a
    // deliberately larger page — rather than by inventing a sort the keyset
    // cursor cannot express.
    const page = await queryTransactions({
      spaceId: ctx.spaceId,
      query: {
        sort: 'oldest' === String(a.sort) ? 'oldest' : 'newest',
        limit: wantLargest ? 100 : limit,
        ...(a.from ? { dateFrom: String(a.from) } : {}),
        ...(a.to   ? { dateTo:   String(a.to)   } : {}),
        ...(a.text ? { text:     String(a.text) } : {}),
        ...(a.category ? { categories: [String(a.category)] as never } : {}),
      },
    });
    const rows = wantLargest
      ? [...page.rows].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, limit)
      : page.rows;
    return {
      rows: rows.map((r) => ({
        date: r.date, merchant: r.merchantDisplayName ?? r.merchant,
        description: r.description, amount: r.amount,
        category: r.category, pending: r.pending,
      })),
      shown: rows.length,
      rankedOver: wantLargest ? page.rows.length : undefined,
      moreAvailable: page.hasMore,
    };
  },
};

// ── 4. Income + payroll cadence ──────────────────────────────────────────────

const getIncome: ToolDefinition = {
  name: 'get_income',
  description:
    'Income by month AND the derived payroll cadence per source (biweekly, ' +
    'semimonthly, monthly), with each source\'s typical amount and whether it is ' +
    'still active. Use this before concluding income rose or fell — a month can ' +
    'hold two or three biweekly paychecks.',
  parameters: obj({
    from: str('YYYY-MM-DD. Omit for the last 12 months.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
  }),
  async run(a, ctx) {
    const to   = (a.to as string) || ctx.asOfISO;
    const from = (a.from as string) || daysAgoISO(to, 364);
    const [t, streams] = await Promise.all([
      assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
        { transactionWindow: { startDate: from, endDate: to, label: `income ${from}..${to}` } }),
      loadForecastIncomeStreams(ctx.spaceId, ctx.asOfISO),
    ]);
    return {
      window: { from, to },
      byMonth: (t?.monthlyBreakdown ?? []).map((m) => ({
        month: m.month, income: m.incomeTotal, partialMonth: m.partial ?? false,
      })),
      // The cadence half. This is the evidence that distinguishes a three-paycheck
      // month from a pay cut, and it comes from FORECAST-1/2, not from arithmetic here.
      sources: streams.map((s) => ({
        label: s.label,
        cadence: typeof s.cadence === 'object' && s.cadence && 'kind' in s.cadence
          ? (s.cadence as { kind: string }).kind : null,
        typicalAmount: s.amount?.assertable ? s.amount.value : null,
        currency: s.amount?.assertable ? s.amount.currency : null,
        activity: s.activity.state,
        stillPaying: s.projectionEligible,
        why: s.activity.reason,
        observationCount: s.observationCount,
        seriesTruncated: s.truncated,
      })),
      incomeSources: t?.incomeSources?.items,
    };
  },
};

// ── 5. Investments ───────────────────────────────────────────────────────────

const getInvestments: ToolDefinition = {
  name: 'get_investments',
  description:
    'What the user is invested in. Returns the canonical composition (traditional ' +
    'investments vs digital assets, disjoint) AND the position-level detail, which ' +
    'is a SUBSET limited to positions that could be priced. Every concentration ' +
    'figure states the population it is a share of.',
  parameters: obj({}),
  async run(_a, ctx) {
    const [acc, hold] = await Promise.all([
      assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
      assemble<HoldingsSummaryData>(FinanceDomains.HOLDINGS_SUMMARY, ctx),
    ]);
    const composition = acc ? composeInvestments(acc) : null;
    return {
      // ⚠️ THE AUTHORITY ON WHAT THE INVESTMENTS ARE WORTH. Account-level,
      // components disjoint by construction. Do not add anything below to this.
      composition,
      investmentAccounts: (acc?.accounts ?? [])
        .filter((a) => a.type === 'investment' || a.type === 'crypto')
        .map((a) => ({ name: a.name, type: a.type, value: a.reportingBalance,
          currency: a.currency, needsReauth: a.needsReauth })),
      // ⚠️ A SUBSET, AND IT SAYS SO. Positions the valuation seam could price.
      positionDetail: hold ? {
        scopeWarning:
          'These figures cover only positions that could be priced. They are NOT ' +
          'the investment totals — use `composition` for those.',
        valuedPositionsTotal: hold.valuedPositionsTotal,
        valuedNonCashTotal:   hold.valuedNonCashTotal,
        uninvestedCashInBrokerage: hold.valuedCashTotal,
        valuationCompleteness: hold.valuationCompleteness,
        unpricedPositions: hold.unvaluedPositions,
        positions: hold.topPositions?.items,
        concentration: hold.concentration,
        limits: hold.dataLimits,
      } : { unavailable: 'no priced positions in scope' },
    };
  },
};

// ── 6. Net-worth history ─────────────────────────────────────────────────────

const getNetWorthHistory: ToolDefinition = {
  name: 'get_net_worth_history',
  description:
    'Daily net-worth history and its components (cash, investments, digital assets, ' +
    'debt). Use for "compared to last month", "a year ago", or before explaining a move.',
  parameters: obj({
    from: str('YYYY-MM-DD. Omit for the last 90 days.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
    maxPoints: num('Downsample evenly to at most this many points. Default 40.'),
  }),
  async run(a, ctx) {
    const to   = (a.to as string) || ctx.asOfISO;
    const from = (a.from as string) || daysAgoISO(to, 89);
    const rows = await getRecentSnapshots({ rows: 1100 }, { spaceId: ctx.spaceId });
    const inRange = rows
      .map((r) => ({ ...r, dateISO: String(r.date).slice(0, 10) }))
      .filter((r) => r.dateISO >= from && r.dateISO <= to);
    if (inRange.length === 0) return { unavailable: `no snapshots between ${from} and ${to}` };
    const cap = Math.min(Math.max(Number(a.maxPoints ?? 40), 2), 200);
    const step = Math.max(1, Math.ceil(inRange.length / cap));
    const picked = inRange.filter((_, i) => i % step === 0 || i === inRange.length - 1);
    const pt = (r: (typeof inRange)[number]) => ({
      date: r.dateISO, netWorth: r.netWorth,
      cash: round2((r.totalCash ?? 0) + (r.totalSavings ?? 0)),
      investments: r.totalInvestments, digitalAssets: r.totalCrypto, debt: r.totalDebt,
    });
    return {
      window: { from, to },
      pointsAvailable: inRange.length, pointsShown: picked.length,
      earliestAvailable: rows.length ? String(rows[0].date).slice(0, 10) : null,
      first: pt(inRange[0]), last: pt(inRange[inRange.length - 1]),
      series: picked.map(pt),
    };
  },
};

// ── 7. Net-worth explanation ─────────────────────────────────────────────────

const explainNetWorthChange: ToolDefinition = {
  name: 'explain_net_worth_change',
  description:
    'Break a net-worth figure into its components on a date, with each component\'s ' +
    'own value and whether it can be drilled into further. Call again with a ' +
    'component id to go deeper. Use for "why did my net worth drop/rise".',
  parameters: obj({
    date: str('YYYY-MM-DD to explain. Required.'),
    lens: { type: 'string',
      enum: ['net-worth', 'assets', 'liquid-net-worth', 'investments', 'crypto', 'cash', 'savings', 'debt'],
      description: 'Which total to break down. Default net-worth.' },
    componentId: str('A component id from a previous call, to drill one level deeper.'),
  }, ['date']),
  async run(a, ctx) {
    const dateISO = String(a.date);
    const lens = String(a.lens ?? 'net-worth');
    const nodeId = a.componentId ? String(a.componentId) : null;
    const res = await resolveExplorationNode({
      spaceId: ctx.spaceId, lens,
      nodeType: nodeId ? (nodeId.startsWith('account:') ? 'account'
        : nodeId.startsWith('holding:') ? 'holding' : 'bucket') : 'lens',
      nodeId, dateISO, fromISO: dateISO, toISO: dateISO,
    });
    if (res.error || !res.node) return { unavailable: res.error ?? 'node not resolved' };
    const n = res.node;
    return {
      date: dateISO, lens, label: n.label,
      value: n.displayedValue, currency: n.currency,
      explainedByComponents: n.explainedValue,
      unexplainedRemainder: n.unattributedObservedAmount,
      assertable: n.assertable, unavailableReason: n.unavailableReason,
      components: (n.components ?? []).map((c) => ({
        id: c.id, label: c.label, value: c.displayedValue,
        canDrillDeeper: c.drilldown?.available ?? false,
      })),
    };
  },
};

// ── 8. Cash projection ───────────────────────────────────────────────────────

const projectCash: ToolDefinition = {
  name: 'project_cash',
  description:
    'Deterministic cash projection to a future date. Returns BOTH paths and never ' +
    'picks one for you: the strictly-licensed path (which refuses unless every ' +
    'income basis is established) and the evidence-based projection (which uses ' +
    'observed spending). Optionally override the monthly spending assumption.',
  parameters: obj({
    to: str('YYYY-MM-DD horizon end. Required.'),
    assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here.'),
    statedAs: str('The user\'s own words for that assumption, e.g. "assume I spend 6k".'),
  }, ['to']),
  async run(a, ctx) {
    const toISO = String(a.to);
    const streams = await loadForecastIncomeStreams(ctx.spaceId, ctx.asOfISO);
    const accounts = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    const fakeCtx = {
      space: { name: '', reportingCurrency: 'USD' },
      domains: { [FinanceDomains.ACCOUNTS]: { data: accounts } },
    } as unknown as SpaceContext_AI;

    const statements: UserStatement[] = [];
    if (typeof a.assumedMonthlySpending === 'number') {
      statements.push({
        mode: StatementMode.ASSERTS_FACT,
        statedAs: String(a.statedAs ?? `assumed monthly spending ${a.assumedMonthlySpending}`),
        asOfISO: ctx.asOfISO,
        subject: { kind: 'SPENDING_LEVEL', amount: a.assumedMonthlySpending,
          currency: 'USD', periodBasis: PeriodBasis.MONTHLY },
      });
    }
    const horizon = { fromISO: ctx.asOfISO, toISO, origin: AssumptionOrigin.USER_REQUESTED,
      statedAs: `through ${toISO}` } as unknown as ForecastHorizon;

    const f = assembleForecast({ ctx: fakeCtx, streams, horizon, asOfISO: ctx.asOfISO, statements });
    const licensed = 'refused' in f.forecast ? null : f.forecast.fullCashPath;
    return {
      horizon: { from: ctx.asOfISO, to: toISO },
      openingCash: 'refused' in f.forecast ? null : f.forecast.openingCash.amount,
      // ⚠️ BOTH PATHS, ALWAYS. Which of these deserves product authority is an
      // open question the experiment exists to inform — the harness must not
      // quietly pick the one that reads better.
      strictlyLicensed: {
        status: licensed?.status ?? 'UNAVAILABLE',
        endingCash: licensed?.closing ?? null,
        refusedBecause: licensed?.status === 'REFUSED' ? licensed.missing : null,
      },
      evidenceBasedProjection: f.projection ? {
        endingCash: f.projection.closing,
        spendingBasis: f.observedSpending
          ? { kind: 'OBSERVED', dailyRate: f.observedSpending.dailyRate,
              monthsUsed: (f.observedSpending as { months?: string[] }).months ?? null }
          : { kind: 'USER_ASSUMED' },
      } : null,
      appliedUserFacts: f.appliedFacts,
      incomeEventsCounted: f.events.length,
      policyAssumptions: f.policy.assumptions.map((p) => ({
        origin: p.origin, stance: p.stance, statedAs: p.statedAs,
      })),
    };
  },
};

// ── 9. Pay dates ─────────────────────────────────────────────────────────────

const getPayDates: ToolDefinition = {
  name: 'get_pay_dates',
  description:
    'Upcoming expected pay dates per income source, generated from observed ' +
    'cadence. Only sources still licensed to continue produce dates.',
  parameters: obj({
    through: str('YYYY-MM-DD. Omit to get the next few occurrences.'),
    nextOnly: { type: 'boolean', description: 'True for just the next one.' },
  }),
  async run(a, ctx) {
    const streams = await loadForecastIncomeStreams(ctx.spaceId, ctx.asOfISO);
    const r = resolvePayDates(streams, ctx.asOfISO, {
      ask: a.nextOnly ? PayDateAsk.NEXT_ONE : PayDateAsk.UPCOMING,
      ...(a.through ? { stated: { toISO: String(a.through), statedAs: `through ${a.through}` } } : {}),
    });
    return { from: r.fromISO, to: r.toISO, sources: r.streams, none: r.empty };
  },
};

// ── 10. Investment scenario ──────────────────────────────────────────────────

const investmentScenario: ToolDefinition = {
  name: 'investment_scenario',
  description:
    'Apply a percentage the USER stated to a named investment component and report ' +
    'the arithmetic effect on net worth. This is arithmetic over a hypothesis, not ' +
    'a prediction — never call it to guess what a market will do.',
  parameters: obj({
    moves: { type: 'array', description: 'One entry per component to move.',
      items: obj({
        component: { type: 'string',
          enum: ['DIGITAL_ASSETS', 'TRADITIONAL_INVESTMENTS'],
          description: 'Which canonical component the stated move applies to.' },
        changePercent: num('The user\'s stated move, in percent. -30 for "down 30%".'),
      }, ['component', 'changePercent']) },
  }, ['moves']),
  async run(a, ctx) {
    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    if (!acc) return { unavailable: 'no accounts in scope' };
    const comp = composeInvestments(acc);
    const components: ScenarioComponent[] = (comp?.components ?? [])
      .filter((c) => c.state === 'ASSERTABLE' && c.amount !== null)
      .map((c) => ({ key: c.key, label: c.label, currentValue: c.amount as number }));
    const moves: Record<string, number> = {};
    for (const m of (a.moves as { component: string; changePercent: number }[]) ?? []) {
      moves[m.component] = m.changePercent / 100;
    }
    return applyInvestmentScenario({ components, moves, currentNetWorth: acc.netWorth });
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const TOOLS: readonly ToolDefinition[] = [
  getFinancialSnapshot, getSpending, getTransactions, getIncome, getInvestments,
  getNetWorthHistory, explainNetWorthChange, projectCash, getPayDates, investmentScenario,
];

/** OpenAI function-tool definitions for the tool-capable arms. */
export function openAiToolSchemas(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
