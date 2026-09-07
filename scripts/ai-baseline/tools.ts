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
import { MAX_TRANSACTION_PAGE_SIZE, type TransactionQuery } from '@/lib/data/transaction-query-core';
import { TRANSACTION_FETCH_LIMIT } from '@/lib/ai/assemblers/transactions';
import type { Transaction } from '@/types';
import { getRecentSnapshots } from '@/lib/data/snapshots';
import { projectSnapshotSection } from '@/lib/ai/assemblers/snapshot';
import type { Snapshot } from '@/types';
import { FlowType } from '@prisma/client';
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
/** The bound `lib/history/exploration` uses. Enough for all-time on this corpus. */
const SNAPSHOT_READ_ROWS = 1100;
/** Ceiling on a DAILY series, so one call cannot return a year of rows by accident. */
const MAX_DAILY_POINTS = 200;
/**
 * Read a bounded window to EXHAUSTION through the canonical keyset cursor.
 *
 * ⚠️ RANKING NEEDS THE WHOLE POPULATION, NOT A PAGE. `sort: 'largest'` used to rank
 * the newest 100 matching rows and present the winner as "your biggest" — on a
 * 173-row month that silently answered from 58% of the data. Raising 100 to some
 * other number would only move the cliff to 201 or 501; the fix is to page until
 * the seam says `hasMore: false`, which is the mechanism the read authority
 * already provides.
 *
 * ⚠️ THE CEILING IS THE REPOSITORY'S OWN, AND IT FAILS LOUDLY. `TRANSACTION_FETCH_LIMIT`
 * is the same 5,000-row guard the transactions assembler applies to the same
 * population, so a ranking and the summary beside it can never disagree about what
 * "all of them" covered. Hitting it returns `complete: false`, which the caller
 * turns into a stated caveat — it is never absorbed.
 *
 * Terminates on three conditions: the seam reports no more, the ceiling is reached,
 * or a page fails to advance the cursor (a defensive stop, never expected).
 */
/**
 * The read, injectable.
 *
 * ⚠️ INJECTED ONLY SO TERMINATION CAN BE TESTED WITHOUT A DATABASE — the same
 * idiom `lib/ai/forecast/streams.ts` uses for its own bounded read. The three
 * ways this loop can end (exhausted, ceiling, non-advancing cursor) are exactly
 * the parts worth a test, and two of them cannot be reached with real data.
 */
export type TransactionPager = typeof queryTransactions;

export async function readWindowToExhaustion(
  spaceId: string, query: Omit<TransactionQuery, 'cursor' | 'limit'>,
  read: TransactionPager = queryTransactions,
): Promise<{ rows: Transaction[]; complete: boolean; pages: number }> {
  const rows: Transaction[] = [];
  let cursor: TransactionQuery['cursor'];
  let pages = 0;

  for (;;) {
    const page = await read({
      spaceId, query: { ...query, limit: MAX_TRANSACTION_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    pages++;
    rows.push(...page.rows);
    if (!page.hasMore || !page.nextCursor) return { rows, complete: true, pages };
    if (page.rows.length === 0) return { rows, complete: true, pages };
    if (rows.length >= TRANSACTION_FETCH_LIMIT) return { rows, complete: false, pages };
    const advanced = !cursor
      || cursor.lastId !== page.nextCursor.lastId
      || cursor.lastDate !== page.nextCursor.lastDate;
    if (!advanced) return { rows, complete: false, pages };
    cursor = page.nextCursor;
  }
}
const daysAgoISO = (asOf: string, n: number) =>
  new Date(Date.parse(`${asOf}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Every calendar month-end strictly after `fromISO` and not after `toISO`, plus
 * `toISO` itself when it is not already one.
 *
 * ⚠️ THE LAST ENTRY IS ALWAYS THE HORIZON, which is what makes the final
 * checkpoint and the standalone endpoint the same number rather than nearly.
 */
function monthEndsBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const from = new Date(`${fromISO}T00:00:00.000Z`);
  const to   = new Date(`${toISO}T00:00:00.000Z`);
  const cur  = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  while (cur <= to) {
    const iso = cur.toISOString().slice(0, 10);
    if (iso > fromISO) out.push(iso);
    cur.setUTCMonth(cur.getUTCMonth() + 2, 0);
  }
  if (out[out.length - 1] !== toISO && toISO > fromISO) out.push(toISO);
  return out;
}

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

/**
 * The user's vocabulary for "what kind of money movement", mapped onto the
 * canonical `FlowType` population.
 *
 * ⚠️ THE MODEL PICKS; THIS ONLY HONOURS. No keyword matching happens anywhere —
 * the parameter is an enum on the schema and the model chooses it from the
 * question. Ranking "largest" over every flow is what made "my biggest purchase
 * last month" answer with a payroll deposit.
 */
const FLOW_SETS: Record<string, FlowType[] | null> = {
  spending:      [FlowType.SPENDING, FlowType.FEE, FlowType.INTEREST],
  income:        [FlowType.INCOME],
  transfers:     [FlowType.TRANSFER],
  card_payments: [FlowType.DEBT_PAYMENT],
  refunds:       [FlowType.REFUND],
  all:           null,
};

const getTransactions: ToolDefinition = {
  name: 'get_transactions',
  description:
    'Individual transactions, filtered and ranked. Set `flow` to say what KIND of movement ' +
    'you mean — "spending" for purchases, "income" for deposits, "transfers" for movements ' +
    'between the user\'s own accounts, "card_payments" for paying a card off. Use ' +
    'flow:"spending" with sort:"largest" for "my biggest purchase".',
  parameters: obj({
    from:     str('YYYY-MM-DD inclusive.'),
    to:       str('YYYY-MM-DD inclusive.'),
    flow:     { type: 'string', enum: Object.keys(FLOW_SETS),
                description: 'Default "all". Choose the one the question means.' },
    category: str('One presentation category, e.g. Dining, Shopping, Travel, Other.'),
    text:     str('Case-insensitive substring over merchant and description.'),
    sort:     { type: 'string', enum: ['newest', 'oldest', 'largest'],
                description: 'Default newest. "largest" ranks by amount WITHIN the chosen flow.' },
    limit:    num('1–50. Default 15.'),
  }),
  async run(a, ctx) {
    const limit = Math.min(Math.max(Number(a.limit ?? 15), 1), 50);
    const wantLargest = String(a.sort ?? 'newest') === 'largest';
    const flowKey = String(a.flow ?? 'all');
    const flowTypes = FLOW_SETS[flowKey] ?? null;

    const filters: Omit<TransactionQuery, 'cursor' | 'limit'> = {
      sort: 'oldest' === String(a.sort) ? 'oldest' : 'newest',
      ...(flowTypes ? { flowTypes } : {}),
      ...(a.from ? { dateFrom: String(a.from) } : {}),
      ...(a.to   ? { dateTo:   String(a.to)   } : {}),
      ...(a.text ? { text:     String(a.text) } : {}),
      ...(a.category ? { categories: [String(a.category)] as never } : {}),
    };

    // ⚠️ TWO READ SHAPES, FOR TWO DIFFERENT QUESTIONS. "Show me the latest 15" is a
    // page and the seam already orders it. "Which was the largest" is a question
    // about the whole window, and answering it from a page is how a payroll deposit
    // became somebody's biggest purchase.
    const { rows: population, complete, pages } = wantLargest
      ? await readWindowToExhaustion(ctx.spaceId, filters)
      : await (async () => {
          const page = await queryTransactions({ spaceId: ctx.spaceId, query: { ...filters, limit } });
          return { rows: page.rows, complete: !page.hasMore, pages: 1 };
        })();

    const rows = wantLargest
      ? [...population].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, limit)
      : population;

    return {
      asOf: ctx.asOfISO,
      window: { from: a.from ?? null, to: a.to ?? null },
      flow: flowKey,
      rows: rows.map((r) => ({
        date: r.date, merchant: r.merchantDisplayName ?? r.merchant,
        description: r.description, amount: r.amount,
        category: r.category, pending: r.pending,
      })),
      shown: rows.length,
      ...(wantLargest ? {
        rankedOver: population.length,
        rankingIsComplete: complete,
        pagesRead: pages,
        ...(complete ? {} : { rankingCaveat:
          `Ranked over ${population.length} rows — the ${TRANSACTION_FETCH_LIMIT}-row read `
          + 'ceiling was reached, so this is the largest of what was read, not necessarily '
          + 'of the whole window. Narrow the date range to rank it completely.' }),
      } : { moreAvailable: !complete }),
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
      // ⚠️ EVERY RESULT NAMES ITS INSTANT. Two of these tools carried none, and
      // a current-position figure was composed with a future cash figure and
      // presented as one answer.
      asOf: ctx.asOfISO,
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
    'Net worth and its components (cash, investments, digital assets, debt) over time. ' +
    'Ask for `granularity: "monthly"` to get one point per calendar month — that is the ' +
    'right shape for a month-by-month table and is the default for ranges over ~3 months. ' +
    'A point whose net worth could not be established is returned as null WITH a reason; ' +
    'read `coverage` before describing older history as fact.',
  parameters: obj({
    from: str('YYYY-MM-DD. Omit for the last 90 days.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
    granularity: { type: 'string', enum: ['monthly', 'daily'],
      description: 'monthly = the last observation in each calendar month. Default '
        + 'monthly for ranges over 92 days, daily otherwise.' },
    maxPoints: num('Daily granularity only: downsample evenly to at most this many points.'),
  }),
  async run(a, ctx) {
    const to   = (a.to as string) || ctx.asOfISO;
    const from = (a.from as string) || daysAgoISO(to, 89);

    // ⚠️ THROUGH THE ASSEMBLER'S OWN PROJECTION, NOT THE RAW ROWS. The canonical
    // snapshot read carries `aggregateAuthorisation` — for 407 of this Space's 770
    // points it says `netWorth.assertable: false` with
    // `HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE` — and `projectSnapshotSection` is
    // the pure, tested function that turns that into nulls plus a reason. Reading
    // `r.netWorth` / `r.totalCrypto` directly (which this tool used to do) took the
    // depth and threw away the refusal, so a stale figure carried on a contaminated
    // row was reported as a fact and the model told the user he had negative net
    // worth in early 2025.
    const rows = await getRecentSnapshots({ rows: SNAPSHOT_READ_ROWS }, { spaceId: ctx.spaceId });
    const section = projectSnapshotSection(rows as Snapshot[], 'full');
    if (!section) return { unavailable: 'no usable snapshot history for this Space' };

    const inRange = section.history.filter((p) => p.date >= from && p.date <= to);
    if (inRange.length === 0) {
      return { unavailable: `no snapshots between ${from} and ${to}`,
        earliestAvailable: section.oldestDate, latestAvailable: section.newestDate };
    }

    const spanDays = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    const granularity = (a.granularity as string) === 'daily' ? 'daily'
      : (a.granularity as string) === 'monthly' ? 'monthly'
      : spanDays > 92 ? 'monthly' : 'daily';

    // ⚠️ MONTH-END MEANS THE LAST OBSERVATION IN THE MONTH, not every Nth day. The
    // previous even downsample (`i % step`) never landed on a month boundary, so a
    // month-by-month question could only be answered by re-querying each month —
    // which is exactly what happened: 33 tool calls and 145,550 prompt tokens to
    // recover twelve rows that were already in the first payload.
    let picked = inRange;
    let clamped = false;
    if (granularity === 'monthly') {
      const byMonth = new Map<string, (typeof inRange)[number]>();
      for (const p of inRange) byMonth.set(p.date.slice(0, 7), p); // ordered ⇒ last wins
      picked = [...byMonth.values()];
    } else if (a.maxPoints !== undefined) {
      const cap = Math.min(Math.max(Number(a.maxPoints), 2), MAX_DAILY_POINTS);
      clamped = Number(a.maxPoints) > cap;
      const step = Math.max(1, Math.ceil(inRange.length / cap));
      picked = inRange.filter((_, i) => i % step === 0 || i === inRange.length - 1);
    }

    const pt = (p: (typeof inRange)[number]) => ({
      date: p.date,
      // Null means EXPLICITLY UNKNOWN and always travels with its reason.
      netWorth: p.netWorth, totalAssets: p.totalAssets,
      cash: p.liquid, investments: p.investments, digitalAssets: p.digitalAssets,
      debt: p.liabilities,
      ...(p.digitalAssetsUnavailableReason
        ? { unassertableBecause: p.digitalAssetsUnavailableReason } : {}),
    });

    const unassertable = picked.filter((p) => p.netWorth === null);
    const firstAssertable = inRange.find((p) => p.netWorth !== null)?.date ?? null;

    return {
      window: { from, to, granularity },
      // ⚠️ COVERAGE IS EVIDENCE, NOT A CAVEAT. It is the difference between "your
      // net worth was −$6,837" and "net worth cannot be established before
      // September 2025 because crypto could not be valued".
      coverage: {
        pointsReturned: picked.length,
        pointsUnassertable: unassertable.length,
        firstAssertableDate: firstAssertable,
        reason: unassertable.length > 0
          ? (unassertable[0] as { digitalAssetsUnavailableReason?: string })
              .digitalAssetsUnavailableReason ?? 'component unassertable'
          : null,
        note: unassertable.length > 0
          ? 'Points with netWorth null are NOT zero and NOT measured — the underlying '
            + 'component could not be valued for that date. Do not state them as amounts, '
            + 'and do not treat a series containing them as a complete trend.'
          : null,
        historyAvailableFrom: section.oldestDate,
        historyAvailableTo:   section.newestDate,
        ...(clamped ? { maxPointsClamped: MAX_DAILY_POINTS } : {}),
      },
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
    'Deterministic cash projection to a future date, with month-end checkpoints. The ' +
    'headline answer is `projection` — an evidence-based estimate built from observed ' +
    'payroll cadence and observed spending. `establishment` says how firmly each input is ' +
    'pinned down; it is provenance, not a competing answer. Pass ' +
    '`assumedMonthlySpending` when the user states a spending level.',
  parameters: obj({
    to: str('YYYY-MM-DD horizon end. Required.'),
    assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here.'),
    statedAs: str('The user\'s own words for that assumption, e.g. "assume I spend 6k".'),
    checkpoints: { type: 'string', enum: ['monthly', 'none'],
      description: 'monthly = a balance at each month-end between now and the horizon. '
        + 'Default monthly for horizons over ~45 days.' },
  }, ['to']),
  async run(a, ctx) {
    const toISO = String(a.to);
    const [streams, accounts, transactions] = await Promise.all([
      loadForecastIncomeStreams(ctx.spaceId, ctx.asOfISO),
      assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
      // ⚠️ THE ONE LINE THAT MADE THIS TOOL WORK. PROJECTION-1 derives its spending
      // rate from `reliableMonths(transactionsDomain)`; with only the accounts
      // domain in scope it sees zero months, cannot assert a rate, and returns
      // `closing: null` — always, for every horizon. Measured before the fix:
      // null / null. After: $38,243.50 to end-2026 and $128,827.54 to end-2027.
      // Both models papered over the null by doing the arithmetic in prose, and
      // one of them was $745.86 out.
      assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx),
    ]);

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

    const forecastCtx = {
      space: { name: '', reportingCurrency: 'USD' },
      domains: {
        [FinanceDomains.ACCOUNTS]: { data: accounts },
        [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: transactions },
      },
    } as unknown as SpaceContext_AI;

    const runTo = (end: string) => assembleForecast({
      ctx: forecastCtx, streams, asOfISO: ctx.asOfISO, statements,
      horizon: { fromISO: ctx.asOfISO, toISO: end, origin: AssumptionOrigin.USER_REQUESTED,
        statedAs: `through ${end}` } as unknown as ForecastHorizon,
    });

    const f = runTo(toISO);
    const licensed = 'refused' in f.forecast ? null : f.forecast.fullCashPath;
    const userAssumed = f.appliedFacts.length > 0;

    // ── Month-end checkpoints ────────────────────────────────────────────────
    //
    // ⚠️ EACH CHECKPOINT IS AN INDEPENDENT RUN FROM THE SAME `asOf`, never a
    // balance carried forward from the previous one. Compounding checkpoint on
    // checkpoint would accumulate rounding and — worse — would let a series drift
    // away from the endpoint the same authority produces for the same horizon.
    // Because every point is `projectCash(asOf → thatMonthEnd)`, the last
    // checkpoint IS the endpoint by construction, and a test pins it.
    const horizonDays = Math.round(
      (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${ctx.asOfISO}T00:00:00Z`)) / 86_400_000);
    const wantCheckpoints = (a.checkpoints as string) === 'monthly'
      || ((a.checkpoints as string) !== 'none' && horizonDays > 45);

    let checkpoints: unknown[] | undefined;
    if (wantCheckpoints) {
      const ends = monthEndsBetween(ctx.asOfISO, toISO);
      let prevClosing: number | null = f.projection ? (f.projection.openingCash ?? null) : null;
      checkpoints = ends.map((end) => {
        const run = runTo(end);
        const closing = run.projection?.closing ?? null;
        const delta = closing !== null && prevClosing !== null ? round2(closing - prevClosing) : null;
        prevClosing = closing;
        return { monthEnd: end, closingCash: closing === null ? null : round2(closing),
          changeInMonth: delta };
      });
    }

    return {
      horizon: { asOf: ctx.asOfISO, to: toISO, days: horizonDays },
      openingCash: f.projection?.openingCash
        ?? ('refused' in f.forecast ? null : f.forecast.openingCash.amount),

      // ⚠️ THE ANSWER. Product decision (2026-09-07): for an ordinary conversational
      // projection the evidence-based estimate IS the answer when it is available.
      // The strict path's refusal qualifies it; it does not suppress it, and the two
      // are deliberately not presented as competing candidates.
      projection: f.projection && f.projection.closing !== null ? {
        endingCash: round2(f.projection.closing),
        kind: 'EVIDENCE_BASED_ESTIMATE',
        checkpoints,
        basis: {
          openingCash: f.projection.openingCash,
          spending: userAssumed
            ? { source: 'USER_STATED', statedAs: f.appliedFacts }
            : f.observedSpending
              ? { source: 'OBSERVED', dailyRate: f.observedSpending.dailyRate,
                  monthsAveraged: (f.observedSpending as { months?: string[] }).months ?? null }
              : { source: 'NONE' },
          incomeEventsCounted: f.events.length,
          components: f.projection.components,
          assumptions: f.projection.assumptions,
          excluded: f.projection.excluded,
          range: f.projection.range,
        },
        qualification:
          'An evidence-based estimate, not a guaranteed forecast: future payroll is '
          + 'inferred from the observed deposit cadence, and investments and debt are held '
          + 'flat. Say so once; do not restate the strict-path refusal as a second answer.',
      } : null,

      // ⚠️ PROVENANCE, NOT A RIVAL ANSWER. Kept because its `missing` list is the
      // honest account of what is not established — a NET/GROSS basis per income
      // event, a current-normal spending level. Useful for describing confidence.
      establishment: {
        status: licensed?.status ?? 'UNAVAILABLE',
        strictEndingCash: licensed?.closing ?? null,
        notEstablished: licensed?.status === 'REFUSED' ? licensed.missing : [],
        meaning: 'What a strictly-licensed forecast would still need. It qualifies the '
          + 'estimate above and must not be offered as an alternative figure.',
      },

      unavailableReason: f.projection && f.projection.closing !== null ? null
        : (f.projection?.missing?.join('; ') ?? f.unavailable ?? 'no projection could be built'),
      appliedUserFacts: f.appliedFacts,
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
    'the arithmetic effect on net worth AS OF TODAY. This is arithmetic over a ' +
    'hypothesis, not a prediction — never call it to guess what a market will do, and ' +
    'never add its result to a future projection without saying they are different dates.',
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
    const result = applyInvestmentScenario({ components, moves, currentNetWorth: acc.netWorth });
    return {
      // ⚠️ A CURRENT-INSTANT SCENARIO, SAID OUT LOUD. Without this the result was a
      // bare net-worth number with no date on it, and it was glued to a February
      // cash projection and presented as one figure.
      effectiveAt: ctx.asOfISO,
      appliesTo: 'the position as it stands today — this does NOT move forward in time',
      doNotComposeWith:
        'a projected future cash balance, unless you state that the two refer to '
        + 'different instants',
      ...result,
    };
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
