/**
 * lib/ai/conversation/tools.ts
 *
 * THE TOOL SURFACE — thirteen adapters over authorities that already exist, plus
 * the two memory tools that live in `memory-tools.ts`.
 *
 * ⚠️ ADAPTERS, NOT AUTHORITIES. Not one line here computes a financial figure.
 * Every tool resolves parameters, calls a canonical function, and reshapes the
 * result into something compact and semantically explicit. If a tool ever needs
 * to add two money numbers together, that is a signal the composition belongs in
 * an authority, not here.
 *
 * There is exactly ONE arithmetic exception, and it is named rather than hidden:
 * `scenario_projection` reconciles the accounts authority's own totals to find
 * what is neither cash nor an investment (a house, a car) so the ledger can hold
 * it flat instead of dropping it. The scenario arithmetic itself is not here — it
 * is `scenario-ledger.ts`, which is a pure function with no data access at all.
 *
 * ⚠️ READ AND CALCULATE ONLY, WITH ONE NAMED EXCEPTION. Nothing in THIS file
 * writes: there is no correction tool, no categorise tool, and no Prisma client
 * in scope, all of which a test asserts. The single write verb in the harness is
 * `remember`, which lives in `memory-tools.ts` and can reach exactly one table —
 * `SpaceMemory`, which holds intentions and dated statements and structurally
 * cannot hold a balance. The harness remains incapable of mutating financial
 * data.
 *
 * ⚠️ THE VOCABULARY IS THE USER'S, NOT THE ARCHITECTURE'S. `get_spending`, not
 * `assembleTransactionsSummary`; `explain_net_worth_composition`, not
 * `resolveExplorationNode`. A model should not have to learn Fourth Meridian's
 * internal names to ask a question, and exposing them would leak the thing the
 * reset removed.
 */

import { getAssembler } from '@/lib/ai/assembler-registry';
import {
  FinanceDomains,
  type AccountsSectionData, type TransactionsSummaryData, type AccountSummaryItem,
  type HoldingsSummaryData, type SpaceContext_AI,
} from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import {
  queryTransactions, countTransactions, transactionCorpusSpan, transactionCoverage,
} from '@/lib/data/transaction-query';
import { transactionAccountPopulation } from '@/lib/data/transaction-population';
import { MAX_TRANSACTION_PAGE_SIZE, type TransactionQuery } from '@/lib/data/transaction-query-core';
import { TRANSACTION_FETCH_LIMIT } from '@/lib/ai/assemblers/transactions';
import type { Transaction } from '@/types';
import { getRecentSnapshots } from '@/lib/data/snapshots';
import { projectSnapshotSection } from '@/lib/ai/assemblers/snapshot';
import type { Snapshot } from '@/types';
import { FlowType } from '@prisma/client';
import { clampEconomicSpend, meanMonthlyEconomicSpend } from '@/lib/transactions/cash-flow';
import {
  MEASURABLE_SPEND_CATEGORIES, UNSUPPORTED_SPEND_CATEGORIES, resolveSpendCategory, categoryDefinition,
} from '@/lib/transactions/category-vocabulary';
import { resolveExplorationNode } from '@/lib/history/exploration';
import {
  observedChange, findObservation, NEEDS_THRESHOLD, type TemporalOperation,
} from '@/lib/data/snapshot-window';
import {
  loadForecastIncomeStreams, type IncomeTransactionReader, type AccountTypeReader,
} from '@/lib/ai/forecast/streams';
import { assembleForecast, projectInterval } from '@/lib/ai/forecast/assemble';
import { SCENARIO_INPUTS, NOT_AN_ASSUMPTION, scenarioAssumptionKeys } from './scenario-inputs';
import {
  mergeIntoArgs, stagePlan, type Attribution, type PlanSlot,
} from './pending-plan';
import {
  type IncomeChangeOpKind, type IncomeChangeResult, type IncomeChangeRule,
  type RatePeriodKind,
} from '@/lib/forecast/income-change';
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
import {
  findScenarioCrossing, elapsedBetween, type CrossingDirection, type LedgerMetric,
} from './scenario-crossing';
import {
  monthEndsBetween,
  runScenarioLedger, expandContributions, solveForTarget, PROVENANCE,
  type ContributionSpec, type LedgerCheckpoint, type LedgerResult,
  type PlannedMovement, type ReturnPeriod, type SpinePoint,
  type LiabilityLine, type AllocationTarget,
} from './scenario-ledger';
import {
  clausesInForce, contributionName, outflowName, unknownContributionKeys, isAllocationTargetWord,
  refuseUnknownArguments, refuseUnknownItemKeys, notAppliedEcho, boundedLabel,
  type RefusedInput,
} from './scenario-rules';
import type { SpaceContext } from '@/lib/space';
// ⚠️ THE ONE WRITE PATH, IMPORTED RATHER THAN INLINED. Keeping the memory tools
// in their own module is what lets THIS file keep an exact "no Prisma client,
// no write op" scan while `memory-tools.ts` gets its own, equally exact, "may
// reach db.spaceMemory and nothing else". One loose assertion covering both
// would have protected neither.
import { MEMORY_TOOLS } from './memory-tools';
import type { TurnEvidence } from './memory-model';
// ⚠️ READING memory, never writing it. `recallMemories` is the store's read half;
// the write half lives in the turn loop (slice 7) and in `remember`. This file
// still holds no Prisma client, which a test asserts.
import { recallMemories, MemoryKind } from './memory-store';
import {
  readCheckpoint, compareToStatement, diffBasis,
} from './reconcile';
// ── M1: measures & comparison ────────────────────────────────────────────────
// ⚠️ THE ARITHMETIC LIVES IN `lib/ai/measures`, NOT HERE. Period resolution, the
// measure, the comparison, the baselines and every derived figure are pure
// functions over the monthly rows the ONE economic fold already produced. The two
// heads below resolve arguments, perform the reads, and hand the rows over.
import {
  parsePeriodSpec, parseCompareToSpec, resolvePeriod, resolveCompareTo, completeMonthsPeriod,
  type ResolvedPeriod,
} from '@/lib/ai/measures/period';
import {
  measure, compare, FLOW_MEASURES,
  type FlowMeasure, type MonthRow, type DataCoverage, type Tier,
} from '@/lib/ai/measures/measure';
import {
  resolveExpenseBaselineFromEvidence, resolveIncomeBaseline, derive, economicSpendingOf,
  resolveMonthsOfExpensesFloor, type FloorDerivation,
} from '@/lib/ai/measures/baseline';
import { incomeStreamEvidence, OBSERVED_SPENDING_WINDOW_MONTHS } from '@/lib/ai/forecast/income-evidence';
import { computeDebtAggregate } from '@/lib/debt/aggregates';

// ── The tool contract ────────────────────────────────────────────────────────

/**
 * FM-AUDIT-010 — the authority reads the cash spine makes, as one seam.
 *
 * ⚠️ PRODUCTION LEAVES THIS UNSET, and the database authorities are used. It
 * exists so a CI test can drive the REAL scenario path — argument merging, the
 * derived floor, liability lines, income rules, the spine, the ledger, the solve —
 * on fixture DATA: the seam is the data boundary, and nothing downstream of it is
 * stubbed. The income page is still resolved by the real stream resolver; the
 * transactions summary is still whatever the real monthly fold produced.
 */
export interface CashSpineReads {
  incomeTransactions: IncomeTransactionReader;
  incomeAccountTypes: AccountTypeReader;
  accounts: () => Promise<AccountsSectionData | null>;
  transactionsSummary: () => Promise<TransactionsSummaryData | null>;
}

export interface ToolContext {
  spaceCtx: SpaceContext;
  spaceId:  string;
  /** Test seam only — see CashSpineReads. Unset in production. */
  cashSpineReads?: CashSpineReads;
  /** The clock for the whole run, so two tools can never disagree about today. */
  asOfISO:  string;
  /**
   * Who said what in this turn — set by the turn loop, read ONLY by `remember`'s
   * provenance gate. Optional and harness-safe: a context built without it still
   * runs every tool, and a memory write carrying money then fails closed. It is
   * never sent to the model and no financial tool reads it.
   */
  turn?:    TurnEvidence;
  /**
   * The conditions staged in this conversation and not yet run — written only by
   * `stage_assumptions`, read only by the scenario tools, which merge it into the
   * arguments they execute. Absent in a context built without it (every harness
   * that predates it): nothing is merged, and behaviour is exactly as before.
   */
  plan?:    PlanSlot;
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
/** A Date back to the calendar day it represents. UTC, like every date in this layer. */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The same calendar day, N years on. Clamps 29 February the way a calendar does. */
const addYearsISO = (iso: string, years: number): string => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
  return target.getUTCMonth() === d.getUTCMonth() ? target.toISOString().slice(0, 10)
    : new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth() + 1, 0))
      .toISOString().slice(0, 10);
};
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
/**
 * An information ceiling, applied.
 *
 * ⚠️ A CEILING IS NOT A DEFAULT — it OVERRIDES a later explicit bound. "Act as if
 * you know nothing after Jan 1" must hold even when the same call also asks for a
 * window ending in September, because a model that resolves the window first and
 * the cutoff second leaks the future without ever noticing.
 */
export const clampToCeiling = (date: string, ceiling: string) => (date > ceiling ? ceiling : date);

const daysAgoISO = (asOf: string, n: number) =>
  new Date(Date.parse(`${asOf}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * ⚠️ RE-EXPORTED, NOT REIMPLEMENTED. The month-end grid moved into
 * `scenario-ledger.ts` when a surplus share had to generate its own dates. Every
 * caller here is unmoved and there is still exactly one implementation.
 */
export { monthEndsBetween };
import {
  planCheckpoints, compactMovements, compactExcludedEvents, describePlan, yearEndsBetween,
  CADENCES, type Cadence, type CheckpointPlan,
} from './scenario-checkpoints';
export { yearEndsBetween };
import { positionChange, openingPosition, checkpointPosition } from './scenario-change';

async function assemble<T>(
  domain: string, ctx: ToolContext, options: Record<string, unknown> = {},
): Promise<T | null> {
  const a = getAssembler(domain);
  if (!a) return null;
  const section = await a(ctx.spaceCtx, { scopeHint: 'full', ...options } as never);
  return (section?.data as T) ?? null;
}

// ── 1. Snapshot ──────────────────────────────────────────────────────────────

/**
 * The historical position on a date, composed from authorities that already exist.
 *
 * ⚠️ THREE AUTHORITIES, ZERO ARITHMETIC HERE. `projectSnapshotSection` supplies the
 * totals AND the crypto-coverage refusal; the exploration tree supplies the
 * account-level breakdown of each bucket. Nothing in this function adds two money
 * numbers together — `liquid`, `checking` and `savings` each come from a
 * different authority that already computed them, which is exactly why they can
 * be reported side by side without one being mistaken for another.
 */
async function historicalSnapshot(ctx: ToolContext, asOf: string) {
  const rows = await getRecentSnapshots({ rows: SNAPSHOT_READ_ROWS }, { spaceId: ctx.spaceId });
  const section = projectSnapshotSection(rows as Snapshot[], 'full');
  if (!section) return { unavailable: 'no usable snapshot history for this Space' };

  // The latest observation ON OR BEFORE the requested date. A date with no
  // observation reports the one it actually used rather than interpolating.
  const point = [...section.history].reverse().find((p) => p.date <= asOf);
  if (!point) {
    return { unavailable: `no snapshot on or before ${asOf}`,
      historyAvailableFrom: section.oldestDate, historyAvailableTo: section.newestDate };
  }

  const BUCKETS = ['cash', 'savings', 'investments', 'crypto', 'debt'] as const;
  const nodes = await Promise.all(BUCKETS.map((lens) => resolveExplorationNode({
    spaceId: ctx.spaceId, lens, nodeType: 'lens', nodeId: null,
    dateISO: point.date, fromISO: point.date, toISO: point.date,
  })));

  return {
    asOf, basis: 'HISTORICAL_SNAPSHOT',
    observedOn: point.date,
    ...(point.date !== asOf
      ? { note: `No observation on ${asOf}; using the latest on or before it.` } : {}),
    netWorth: point.netWorth, totalAssets: point.totalAssets,
    /** Checking + savings — the spendable total. */
    liquid: point.liquid,
    /** Checking only. The `cash` lens covers exactly this. */
    checking: point.cashOnHand,
    investments: point.investments, digitalAssets: point.digitalAssets,
    debt: point.liabilities,
    coverage: {
      netWorthAssertable: point.netWorth !== null,
      ...(point.digitalAssetsUnavailableReason
        ? { unassertableBecause: point.digitalAssetsUnavailableReason,
            note: 'netWorth, totalAssets and digitalAssets are null because a component '
              + 'could not be valued on that date. They are NOT zero and NOT measured.' }
        : {}),
      historyAvailableFrom: section.oldestDate, historyAvailableTo: section.newestDate,
    },
    buckets: BUCKETS.map((lens, i) => {
      const n = nodes[i].node;
      return {
        bucket: lens, value: n?.displayedValue ?? null,
        assertable: n?.assertable ?? false,
        ...(n?.unavailableReason ? { unavailableReason: n.unavailableReason } : {}),
        // A bucket whose components do not sum to its value says so, rather than
        // presenting a partial breakdown as complete.
        explainedByAccounts: n?.explainedValue ?? null,
        accounts: (n?.components ?? []).map((c) => ({ name: c.label, value: c.displayedValue })),
      };
    }),
  };
}

const getFinancialSnapshot: ToolDefinition = {
  name: 'get_financial_snapshot',
  description:
    'The position on a date. Omit `asOf` for today (adds per-account freshness, APRs and ' +
    'available balances); pass `asOf` for a past date (adds the account-level breakdown of ' +
    'each bucket and the coverage of that date). `liquid` is checking + savings; `checking` ' +
    'is checking alone. Start here for anything broad, and for any "how was I doing on X".',
  parameters: obj({
    asOf: str('YYYY-MM-DD. Omit for today. A past date returns the position AS IT WAS then.'),
  }),
  async run(a, ctx) {
    const asOf = (a.asOf as string) || ctx.asOfISO;
    // ⚠️ TWO BASES, AND THE RESULT SAYS WHICH. Today's position comes from the
    // accounts authority, which carries freshness, APRs and pending reconciliation
    // that simply do not exist for a past date. A historical snapshot that
    // pretended to those fields would be inventing them.
    if (asOf < ctx.asOfISO) return historicalSnapshot(ctx, asOf);

    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    if (!acc) return { unavailable: 'no accounts in scope' };
    return {
      asOf: ctx.asOfISO, basis: 'CURRENT_ACCOUNTS',
      netWorth: acc.netWorth, totalAssets: acc.totalAssets,
      totalLiabilities: acc.totalLiabilities,
      /** Checking + savings. Deliberately not named `cash` — see get_net_worth_history. */
      liquid: acc.totalLiquid,
      counts: acc.counts,
      // CF-7's composer is the authority on what "investments" means; the two
      // components are disjoint by construction and must not be re-derived.
      investmentComposition: composeInvestments(acc),
      accounts: (acc.accounts ?? []).map((a2) => ({
        name: a2.name, type: a2.type, institution: a2.institution,
        balance: a2.reportingBalance, currency: a2.currency,
        amountOwed: a2.amountOwed, creditBalance: a2.creditBalance,
        liabilityState: a2.liabilityState,
        apr: a2.apr, minimumPayment: a2.minimumPayment,
        freshness: a2.balanceFreshness?.band, needsReauth: a2.needsReauth,
        available: a2.availableQuantity?.label && a2.availableQuantity?.amount !== undefined
          ? { label: a2.availableQuantity.label, amount: a2.availableQuantity.amount } : undefined,
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
    'WHAT the money went on over a window up to ~26 months: category and merchant ' +
    'rollups, month-by-month, largest expense, recurring merchants, with transfers and ' +
    'card payments kept separate from spending. This is the evidence behind a window. ' +
    'For HOW MUCH per month, MORE OR LESS than another period, runway, surplus or ' +
    '"N months of expenses", use measure_flows / get_baselines — they compute the ' +
    'figure and the comparison; never divide this tool\'s totals yourself. Default ' +
    'window is the last 90 days.',
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
    if (!t) return { unavailable: `no transactions between ${from} and ${to}` };

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
/**
 * How many matching rows a search will finish rather than sample.
 *
 * ⚠️ NOT A PAGE SIZE AND NOT A DEFAULT — a cost boundary on completeness. Under
 * it, "did this happen in this window?" is answerable; over it the result stays a
 * page and says so, because rendering hundreds of rows to answer one question is
 * its own defect. 100 sits above the populations an ordinary filtered question
 * produces (the 58b352f blocker matched 80) and far below the read ceiling.
 */
const COMPLETABLE_SEARCH_ROWS = 100;

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
    asOf:     str('Information ceiling: nothing dated after this is returned.'),
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

    const ceiling = (a.asOf as string) || ctx.asOfISO;
    const dateTo = clampToCeiling((a.to as string) || ceiling, ceiling);
    const filters: Omit<TransactionQuery, 'cursor' | 'limit'> = {
      sort: 'oldest' === String(a.sort) ? 'oldest' : 'newest',
      ...(flowTypes ? { flowTypes } : {}),
      ...(a.from ? { dateFrom: String(a.from) } : {}),
      dateTo,
      ...(a.text ? { text:     String(a.text) } : {}),
      ...(a.category ? { categories: [String(a.category)] as never } : {}),
    };

    // ⚠️ TWO READ SHAPES, FOR TWO DIFFERENT QUESTIONS. "Show me the latest 15" is a
    // page and the seam already orders it. "Which was the largest" is a question
    // about the whole window, and answering it from a page is how a payroll deposit
    // became somebody's biggest purchase.
    // ⚠️ A PAGE IS NOT A POPULATION. The newest-`limit` read answers "show me
    // some"; a model asking "did this happen?" reads the same payload as "here is
    // everything that matched". Measured (58b352f): a correct nine-month window
    // matched 80 transfers, the page returned the newest 50 ending three days
    // short of the evidence, and the assistant reported that none existed.
    // `hasMore` was true in that payload and was not enough — it is a transport
    // fact ("another page exists"), not an evidence one ("you saw 50 of 80").
    //
    // ⚠️ COUNTED, NOT EXHAUSTED. One indexed aggregate over the same WHERE — no
    // extra rows materialized, no FX, no transfer assessment — so a browse stays
    // a browse. Exhaustion is still what `sort: 'largest'` does, because ranking
    // needs the ROWS; this needs only the SIZE, and stays truthful above the
    // ceiling where exhaustion cannot.
    const [firstRead, matchedInWindow] = await Promise.all([
      wantLargest
        ? readWindowToExhaustion(ctx.spaceId, filters)
        : (async () => {
            const page = await queryTransactions({ spaceId: ctx.spaceId, query: { ...filters, limit } });
            return { rows: page.rows, complete: !page.hasMore, pages: 1 };
          })(),
      wantLargest ? Promise.resolve(null) : countTransactions({ spaceId: ctx.spaceId, query: filters }),
    ]);

    // ⚠️ FINISH THE SEARCH WHEN FINISHING IT IS CHEAP. Reporting "you saw 50 of
    // 80" is truthful and was NOT enough: measured after the count landed, 3 of 5
    // trials read that payload and still wrote "I pulled all transfers". A
    // population this small is two pages of work, and the question "did this
    // happen?" cannot be answered by a sample at any price.
    //
    // ⚠️ THE CEILING IS WHAT MAKES THIS SAFE. Above it nothing changes: a 449-row
    // browse stays one page and says so. This only ever converts an almost-
    // complete search into a complete one, never a browse into a dump.
    const completable = !wantLargest && matchedInWindow !== null
      && matchedInWindow > limit && matchedInWindow <= COMPLETABLE_SEARCH_ROWS;
    const { rows: population, complete, pages } = completable
      ? await (async () => {
          const page = await queryTransactions({
            spaceId: ctx.spaceId, query: { ...filters, limit: matchedInWindow } });
          return { rows: page.rows, complete: !page.hasMore, pages: 2 };
        })()
      : firstRead;

    const rows = wantLargest
      ? [...population].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, limit)
      : population;   // completable ⇒ this IS the whole matching set

    // ⚠️ NAMES FROM THE ASSEMBLER THAT ALREADY DECIDES WHO MAY SEE THEM. The row
    // DTOs carry account IDs — the counterparty's already privacy-gated by the
    // read authority — and an id is not something a reader can pair. This maps
    // the ids this page uses onto the names the accounts surface already
    // discloses, so an account the viewer cannot see simply has no name here and
    // the leg stays honestly anonymous.
    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    const names = new Map((acc?.accounts ?? []).map((x) => [x.id, x.name]));
    const accountName = (id: string | null | undefined) => (id ? names.get(id) : undefined);

    // ⚠️ THE RESULT DECLARES THE BOUNDARY OF ITS OWN AUTHORITY. `window` is the
    // evidence actually searched; `coverage` is the evidence there was to search.
    // Without the second, an empty page cannot distinguish "nothing matched in
    // these 90 days" from "nothing matched, ever" — and the 2×2 experiment
    // (bb2f6ec) measured 11 of 18 negative answers making exactly that leap, off
    // windows that were all genuinely empty inside a corpus that was not.
    //
    // This ADDS a fact and changes no behaviour: no default window is introduced,
    // no window is widened, nothing is re-queried, and the rows are the same rows.
    // What to do about a partial window is the model's decision, not this
    // adapter's.
    const coverage = transactionCoverage({
      corpus: await transactionCorpusSpan({ spaceId: ctx.spaceId, asOf: ceiling }),
      searchedFrom: (a.from as string) ?? null,
      searchedTo: dateTo,
    });

    return {
      asOf: ceiling,
      window: { from: a.from ?? null, to: dateTo },
      // ⚠️ NOT DERIVED FROM THE WINDOW, THE ROWS, OR THE FILTERS. A `text` search
      // that matches nothing still reports the span it searched inside — shrinking
      // this to the matching rows would erase the very thing it exists to qualify.
      coverage,
      flow: flowKey,
      rows: rows.map((r) => ({
        date: r.date, merchant: r.merchantDisplayName ?? r.merchant,
        description: r.description, amount: r.amount,
        category: r.category, pending: r.pending,
        // ⚠️ WHICH SIDE OF THE MOVEMENT THIS ROW IS. A card payment posts TWICE —
        // once on the checking account it left and once on the card it landed on —
        // and the two rows used to arrive as `-5,000 Payment to Chase card` and
        // `+5,000 Payment Thank You-Mobile` with nothing to say they are one
        // event. Naming the account each row sits on, and the owned account on
        // the other side, is what makes the pair legible. Both legs stay in the
        // ledger: the raw record is never collapsed, because a leg is real
        // evidence about the account it posted to.
        ...(accountName(r.accountId) ? { account: accountName(r.accountId) } : {}),
        ...(accountName(r.counterpartyAccountId) ? {
          counterpartyAccount: accountName(r.counterpartyAccountId),
          movementNote: 'Both sides of this movement are your own accounts. This row '
            + 'is ONE LEG of it — do not add it to the other leg.',
        } : {}),
        // The transfer authority's own verdict about where the money went.
        // Absent when it did not assess the row.
        ...(r.transferMaturity ? { movementKind: r.transferMaturity } : {}),
      })),
      shown: rows.length,
      // ⚠️ THE EVIDENCE CEILING FOR THE PAGE, BESIDE THE ONE FOR THE WINDOW.
      // `coverage` above says how much of the RECORD the window covered; this
      // says how much of the MATCHING SET the rows covered. They are different
      // ceilings and a result can fail either independently — the dogfood failure
      // had `windowCoversAvailableRecord: false` AND an incomplete page, and
      // neither on its own would have described it.
      //
      // This replaces `moreAvailable`, which it strictly subsumes: a boolean said
      // that something was missing, this says how much.
      ...(wantLargest ? {} : {
        matchedInWindow,
        searchIsComplete: complete,
        ...(complete ? {} : { searchCaveat:
          `Showed the ${rows.length} ${String(a.sort ?? 'newest')} of ${matchedInWindow} `
          + 'transactions matching this search in the window. The rest were not read: '
          + 'absence from these rows is NOT absence from the window. Narrow with `text`, '
          + '`category` or `flow`, or rank the whole set with sort:"largest".' }),
      }),
      ...(wantLargest ? {
        rankedOver: population.length,
        // ⚠️ SCOPED TO THE SEARCHED POPULATION, AND ONLY THAT. True means every row
        // matching these filters INSIDE `window` was read and ranked. It says
        // nothing about `coverage` — a complete ranking of a 90-day window of a
        // 26-month record is still a ranking of 90 days.
        rankingIsComplete: complete,
        pagesRead: pages,
        ...(complete ? {} : { rankingCaveat:
          `Ranked over ${population.length} rows — the ${TRANSACTION_FETCH_LIMIT}-row read `
          + 'ceiling was reached, so this is the largest of what was read, not necessarily '
          + 'of the whole window. Narrow the date range to rank it completely.' }),
      } : {}),
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
      loadForecastIncomeStreams(ctx.spaceId, ceiling),
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
        why: s.activity.reason,
        observationCount: s.observationCount,
        seriesTruncated: s.truncated,
      })),
      incomeSources: t?.incomeSources?.items,
    };
  },
};

// ── 4b. Measures & comparison, baselines & derived figures (M1) ──────────────

/**
 * The period argument, DESCRIBED ONCE. It appears three times on the surface
 * (`period`, `compareTo`, `spendingWindow`); the explanation rides on the first
 * and the other two carry the bare shape and point back, because a model reads
 * every schema byte on every turn.
 */
const PERIOD_SHAPE = obj({
  preset: { type: 'string' }, month: { type: 'string' }, quarter: { type: 'string' },
  year: { type: 'number' }, completeMonths: { type: 'number' },
  from: { type: 'string' }, to: { type: 'string' },
});
const PERIOD_SCHEMA = {
  ...PERIOD_SHAPE,
  description: 'WHICH DAYS. Exactly one of: `preset` (MTD | QTD | YTD | PAST_WEEK | PAST_MONTH | '
    + 'PAST_QUARTER | PAST_6_MONTHS | PAST_YEAR — rolling ones are calendar months back, not 30 days), '
    + '`month` "YYYY-MM", `quarter` "YYYY-Q3", `year`, `completeMonths` N (the last N WHOLE calendar '
    + 'months, never the current one — the one for "normally", "on average", "per month"), or `from` + '
    + '`to` (YYYY-MM-DD, inclusive). A period that runs past today is cut at today and says so.',
};

interface FlowRead { rows: MonthRow[]; truncated: boolean; readFrom: string | null;
  declaredMonthlyExpenses: number | null }

/** One window of monthly rows, exactly as the ONE fold produced them. */
async function readFlowMonths(
  ctx: ToolContext, window: { from: string; to: string; label: string } | null,
): Promise<FlowRead | null> {
  const t = await assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
    window ? { transactionWindow: { startDate: window.from, endDate: window.to, label: window.label } } : {});
  if (!t) return null;
  return {
    rows: t.monthlyBreakdown.map((m) => ({
      month: m.month, incomeTotal: m.incomeTotal, expenseTotal: m.expenseTotal,
      refundTotal: m.refundTotal, debtPaymentTotal: m.debtPaymentTotal, transferTotal: m.transferTotal,
      partial: m.partial, truncated: m.truncated,
      byCategory: m.byCategory.map((c) => ({ category: c.category, total: c.total, count: c.count,
        ...(c.refundTotal ? { refundTotal: c.refundTotal } : {}) })),
    })),
    truncated: t.truncated,
    // The assembler clamps a floor older than its maximum lookback; the clamp is
    // a completeness fact about THIS read, so it travels with the rows.
    readFrom: window && t.startDate > window.from ? t.startDate : null,
    declaredMonthlyExpenses: t.declaredMonthlyExpenses ?? null,
  };
}

/**
 * What the record covers, and which sources feed the banking population.
 *
 * ⚠️ POPULATION-AWARE. A source is a component of a flow measure only when its
 * accounts put rows into the banking population. A brokerage that needs
 * reconnecting but posts no banking rows is not a component of spending and
 * cannot make a spending figure incomplete; a card that stopped delivering rows
 * can — for windows that run past the day it last delivered.
 */
async function flowCoverage(
  ctx: ToolContext, ceiling: string, accounts?: AccountsSectionData | null,
): Promise<Pick<DataCoverage, 'corpusFrom' | 'corpusTo' | 'components'>> {
  const [span, population, acc] = await Promise.all([
    transactionCorpusSpan({ spaceId: ctx.spaceId, asOf: ceiling }),
    transactionAccountPopulation({ spaceId: ctx.spaceId, asOf: ceiling }),
    accounts !== undefined ? Promise.resolve(accounts)
      : assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
  ]);
  const byKey = new Map<string, { key: string; tier: Tier; deliveredThrough: string | null }>();
  for (const a of acc?.accounts ?? []) {
    const pop = population.find((p) => p.accountId === a.id);
    if (!pop || pop.rows === 0) continue;
    const band = a.balanceFreshness?.band;
    const behind = !!a.needsReauth || band === 'STALE' || band === 'VERY_STALE';
    const key = `${a.type}:${a.institution ?? a.name}`;
    const deliveredThrough = behind ? (a.lastUpdated ? a.lastUpdated.slice(0, 10) : pop.lastDate) : null;
    const prior = byKey.get(key);
    if (!prior || (behind && prior.tier === 'observed')) {
      byKey.set(key, { key, tier: behind ? 'incomplete' : 'observed', deliveredThrough });
    } else if (behind && prior.deliveredThrough && deliveredThrough && deliveredThrough < prior.deliveredThrough) {
      prior.deliveredThrough = deliveredThrough;
    }
  }
  return { corpusFrom: span.from, corpusTo: span.to, components: [...byKey.values()] };
}

/**
 * A category named by the model, resolved through THE category vocabulary
 * (lib/transactions/category-vocabulary.ts) — FM-AUDIT-003. A structural label
 * (Payment, Transfer, Income…) is not a spending line, and a category bank sync
 * never produces (Groceries, Medical, Transport…) is NOT a measured $0 — both are
 * refused by name, with where the money actually is. A provider-bucket line
 * (Dining holds groceries) is measured and carries its `meaning`.
 */
function resolveCategoryArg(raw: unknown):
  { category?: string; categoryMeaning?: { observability: string; contains: string } } | { unavailable: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  const r = resolveSpendCategory(String(raw));
  if (!r.ok) return { unavailable: r.unavailable };
  return { category: r.category, categoryMeaning: { observability: r.observability, contains: r.meaning } };
}

const CATEGORY_VOCABULARY_UNSUPPORTED_LIST = UNSUPPORTED_SPEND_CATEGORIES.join(', ');

/** The category-argument description, generated from the vocabulary so the two cannot diverge. */
const CATEGORY_ARG_DESCRIPTION =
  `Optional spending category — one of ${MEASURABLE_SPEND_CATEGORIES.join(', ')} — to measure one line of `
  + 'spending instead of all of it; the result also carries all spending over the same window and this line\'s '
  + 'share of it (`ofAllSpending`) and `categoryMeaning` (what the line contains — SAY it when it matters: '
  + 'Dining includes groceries, Utilities includes rent, Other is the residual of medical, transportation, '
  + `entertainment and other unsplit spending). ${CATEGORY_VOCABULARY_UNSUPPORTED_LIST} are NOT tracked by bank `
  + 'sync and are refused rather than measured. Only with `measure: "spending"`.';

const measureFlows: ToolDefinition = {
  name: 'measure_flows',
  description:
    'HOW MUCH over a period, and MORE OR LESS than another period — computed, not narrated. ' +
    'Spending, income, economic net, card/debt payments, transfers or refunds for any month, ' +
    'quarter, year, the last N complete months, a to-date or rolling window; with `compareTo` it ' +
    'returns both sides AND the difference, percentage and direction. Use it for "how much did I ' +
    'spend / earn in X", "am I spending more than I used to", "was August higher than July", ' +
    '"compare the last three complete months with the three before", "did I spend more on travel", ' +
    '"is my income up this quarter". Every figure names its window, which months are whole, and ' +
    'whether the record covers it; `perCompleteMonth` is the monthly figure. Spending `total` is ' +
    'what was CHARGED; when refunds arrived in the window `netOfRefunds` is what it actually cost ' +
    '(and `changeNetOfRefunds` the comparison on that basis) — say that figure, never subtract a ' +
    'refund yourself. NEVER divide a window ' +
    'total by its days or months yourself, never compute a difference or percentage between two ' +
    'figures yourself, and never compare figures from two different windows by hand — ask for the ' +
    'comparison here. "PREVIOUS" of a period to date is the same elapsed days of the period before.',
  parameters: obj({
    measure: { type: 'string', enum: [...FLOW_MEASURES],
      description: 'WHAT is measured, by the one economic fold. `spending` never contains card '
        + 'payments or transfers; `economicNet` = income − spending over the window (what actually '
        + 'happened — for the steady monthly surplus use get_baselines); debt payments are NOT '
        + 'subtracted from it.' },
    period: PERIOD_SCHEMA,
    compareTo: { description: 'Optional. "PREVIOUS" (the equivalent earlier period: last month for a '
        + 'month, the same elapsed days of last month for a month to date, the N months before for '
        + 'completeMonths, the same number of days before for a rolling window), '
        + '"SAME_PERIOD_LAST_YEAR", or an explicit period (inside `compareTo`, `completeMonths` N '
        + 'means the N whole months BEFORE `period` begins). The result carries both sides, the '
        + 'difference, the percentage and the direction.',
      anyOf: [{ type: 'string', enum: ['PREVIOUS', 'SAME_PERIOD_LAST_YEAR'] }, PERIOD_SHAPE] },
    category: str(CATEGORY_ARG_DESCRIPTION),
    asOf: str('Information ceiling: pretend today is this date. Nothing after it is read.'),
  }, ['measure', 'period']),
  async run(a, ctx) {
    const ceiling = clampToCeiling((a.asOf as string) || ctx.asOfISO, ctx.asOfISO);
    const kind = String(a.measure) as FlowMeasure;
    if (!FLOW_MEASURES.includes(kind)) {
      return { unavailable: `unknown measure "${a.measure}"; one of ${FLOW_MEASURES.join(', ')}` };
    }
    const spec = parsePeriodSpec(a.period);
    if ('unavailable' in spec) return spec;
    const cat = resolveCategoryArg(a.category);
    if ('unavailable' in cat) return cat;
    const meaning = cat.categoryMeaning ? { categoryMeaning: cat.categoryMeaning } : {};
    if (cat.category && kind !== 'spending') {
      return { unavailable: 'a category is a line of SPENDING; use `measure: "spending"` with it' };
    }
    const compareSpec = a.compareTo === undefined || a.compareTo === null
      ? null : parseCompareToSpec(a.compareTo);
    if (compareSpec && typeof compareSpec === 'object' && 'unavailable' in compareSpec) return compareSpec;

    const period = resolvePeriod(spec, ceiling);
    if (period.from > ceiling) {
      return { unavailable: `the period ${period.label} begins ${period.from}, after ${ceiling}; nothing in it can be read` };
    }
    const cov = await flowCoverage(ctx, ceiling);
    const one = async (p: ResolvedPeriod) => {
      const read = await readFlowMonths(ctx, { from: p.from, to: p.to, label: p.label });
      return measure(kind, read?.rows ?? [], p,
        { ...cov, fetchCapHit: read?.truncated ?? false, readFrom: read?.readFrom ?? null }, cat.category);
    };
    if (!compareSpec) return { asOf: ceiling, ...(await one(period)), ...meaning };

    const other = resolveCompareTo(period, spec, compareSpec as Parameters<typeof resolveCompareTo>[2], ceiling);
    if (other.from === period.from && other.to === period.to) {
      return { unavailable: `\`compareTo\` resolves to the same window as \`period\` (${period.from}..${period.to}); `
        + 'a window compared with itself says nothing — use "PREVIOUS" for the equivalent earlier period' };
    }
    // ⚠️ BOTH SIDES IN ONE CALL, SO THE MODEL NEVER HOLDS ONE AND COMPUTES THE OTHER.
    const [left, right] = await Promise.all([one(period), one(other)]);
    return { asOf: ceiling, ...compare(left, right), ...meaning };
  },
};

const getBaselines: ToolDefinition = {
  name: 'get_baselines',
  description:
    'THE MONTHLY RATES TO REASON FORWARD FROM, AND EVERYTHING COMPUTED FROM THEM: monthly surplus, ' +
    'savings rate, runway in months of current cash, and "N months of expenses" in dollars with ' +
    'how far current cash is from it. Call it AGAIN whenever the user changes the monthly figure ' +
    'or the number of months — every derived figure changes with it, and none is to be recomputed ' +
    'in prose: never multiply a baseline by months, subtract cash from a threshold, or subtract ' +
    'spending from income yourself. The expense baseline is STATED in this conversation > DECLARED ' +
    'in the product > MEASURED over named complete months; income is STATED > CADENCE of settled ' +
    'paychecks > MEASURED. Use it for "how much do I normally spend", "what is my monthly ' +
    'surplus", "what is my savings rate", "how many months of expenses do I have", "how much cash ' +
    'should I keep". `measuredSpending.byWindow` shows how the measured figure differs by window — ' +
    'choose the window that fits the question (pass `spendingWindow`) and SAY which one. ' +
    '`thresholds` always carries 3, 6 and 12 months; pass `monthsOfExpenses` for any other ' +
    'multiple. Every derived figure ships with its numerator, denominator and basis — quote them. ' +
    'Never divide an orientation or window total to get a monthly figure. For WHEN cash reaches a ' +
    'threshold, give its amount to scenario_crossing — do not divide a shortfall by the surplus. ' +
    'It does not say what the user SHOULD spend or keep — that judgement is yours, over these numbers.',
  parameters: obj({
    statedMonthlySpending: num('The monthly spending the user STATED in this conversation, if any '
      + '("use $5k"). Wins over the product setting and the measured figure, and is echoed as STATED.'),
    statedMonthlyIncome: num('The monthly income the user STATED in this conversation, if any.'),
    spendingWindow: { ...PERIOD_SHAPE, description: 'Optional: which PAST months the MEASURED spending '
      + 'baseline is AVERAGED over, e.g. {"completeMonths": 6} — the same shape as measure_flows '
      + '`period`. Default is the complete months the cash projection averages. This is NOT how many '
      + 'months of expenses to keep — "six months of expenses" is `monthsOfExpenses: [6]`.' },
    monthsOfExpenses: { type: 'array', items: { type: 'number' },
      description: 'How many months of expenses to price, e.g. [9] for "keep nine months of expenses" '
        + '— a MULTIPLIER of the baseline, not an averaging window. 3, 6 and 12 are always returned. '
        + 'Each comes back in dollars with the rule, the baseline it multiplied, and the gap to '
        + 'current cash.' },
    asOf: str('Information ceiling: pretend today is this date. Nothing after it is read.'),
  }),
  async run(a, ctx) {
    const ceiling = clampToCeiling((a.asOf as string) || ctx.asOfISO, ctx.asOfISO);
    const windowSpec = a.spendingWindow === undefined || a.spendingWindow === null
      ? null : parsePeriodSpec(a.spendingWindow);
    if (windowSpec && 'unavailable' in windowSpec) return windowSpec;
    // ⚠️ 3, 6 AND 12 ARE ALWAYS PRICED. Told "keep six months of that" one turn
    // after a baseline call, the model multiplied 5,000 × 6 and subtracted liquid in
    // prose because neither figure was in evidence. The common candidates cost a
    // few hundred bytes; any other multiple is asked for by name.
    const asked = (Array.isArray(a.monthsOfExpenses) ? a.monthsOfExpenses : [])
      .map(Number).filter((n) => Number.isFinite(n)).slice(0, 8);
    const wanted = [...new Set([3, 6, 12, ...asked])].sort((x, y) => x - y);

    const year = resolvePeriod({ completeMonths: 12 }, ceiling);
    const [acc, streams, assessmentRead, yearRead] = await Promise.all([
      assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
      loadForecastIncomeStreams(ctx.spaceId, ceiling),
      // The default window is the cash projection's own: the reliable months of
      // the assembler's assessment window, at most `OBSERVED_SPENDING_WINDOW_MONTHS`.
      readFlowMonths(ctx, ceiling < ctx.asOfISO
        ? { from: daysAgoISO(ceiling, 89), to: ceiling, label: `evidence through ${ceiling}` } : null),
      readFlowMonths(ctx, { from: year.from, to: year.to, label: year.label }),
    ]);
    const cov = await flowCoverage(ctx, ceiling, acc);
    const covOf = (r: FlowRead | null): DataCoverage =>
      ({ ...cov, fetchCapHit: r?.truncated ?? false, readFrom: r?.readFrom ?? null });

    // ── The measured rung, over a NAMED window ──
    let measuredSpending;
    if (windowSpec) {
      const p = resolvePeriod(windowSpec, ceiling);
      const read = await readFlowMonths(ctx, { from: p.from, to: p.to, label: p.label });
      measuredSpending = measure('spending', read?.rows ?? [], p, covOf(read));
    } else {
      const reliable = (assessmentRead?.rows ?? []).filter((m) => !m.partial && !m.truncated)
        .slice(-OBSERVED_SPENDING_WINDOW_MONTHS);
      const p = reliable.length ? completeMonthsPeriod(reliable[0].month, reliable[reliable.length - 1].month,
        `the ${reliable.length} complete month${reliable.length === 1 ? '' : 's'} the cash projection averages`,
        ceiling) : null;
      measuredSpending = p ? measure('spending', reliable, p, covOf(assessmentRead)) : null;
    }

    const expense = resolveExpenseBaselineFromEvidence({
      stated: typeof a.statedMonthlySpending === 'number' ? a.statedMonthlySpending : null,
      declared: assessmentRead?.declaredMonthlyExpenses ?? yearRead?.declaredMonthlyExpenses ?? null,
      measured: measuredSpending,
    });

    // The cadence → monthly conversion is the forecast authority's, through its adapter.
    const streamEvidence = streams.map((s) => incomeStreamEvidence({
      label: s.label, cadence: s.cadence,
      typicalAmount: s.amount?.assertable ? s.amount.value : null,
      stillPaying: s.projectionEligible,
    }));
    const half = resolvePeriod({ completeMonths: 6 }, ceiling);
    const income = resolveIncomeBaseline({
      stated: typeof a.statedMonthlyIncome === 'number' ? a.statedMonthlyIncome : null,
      streams: streamEvidence,
      measured: yearRead ? measure('income', yearRead.rows, half, covOf(yearRead)) : null,
    });

    // ── The position the derived figures divide into ──
    const liquid = acc && typeof acc.totalLiquid === 'number' ? acc.totalLiquid : null;
    const debts = (acc?.accounts ?? []).filter((r) => r.type === 'debt' && r.visibilityLevel === 'FULL');
    const aggregate = computeDebtAggregate(debts.map((r) => ({
      balance: r.reportingBalance ?? r.balance, apr: typeof r.apr === 'number' ? r.apr : null,
      minimumPayment: typeof r.minimumPayment === 'number' ? r.minimumPayment : null })));

    const derived = derive({ expense, income, liquid,
      minimumDebtService: aggregate.minimumPayment > 0 ? aggregate.minimumPayment : null,
      monthsOfExpenses: wanted });

    // ⚠️ THE SPREAD OF LEGITIMATE FIGURES, FROM ONE READ. "Monthly spending" has a
    // different honest answer over 3, 6 and 12 complete months; showing them side
    // by side is what lets the model choose a window on purpose and say so.
    const byWindow = yearRead ? [3, 6, 12].map((n) => {
      const m = measure('spending', yearRead.rows, resolvePeriod({ completeMonths: n }, ceiling), covOf(yearRead));
      // NET-BASELINE-1 — the same NET economic figure the baseline uses, so the
      // table and `expense.amount` are one definition; gross rides along only
      // when refunds moved the window materially.
      const eco = economicSpendingOf(m);
      return { completeMonths: n, from: m.period.from, to: m.period.to, perCompleteMonth: eco.perCompleteMonth,
        ...(eco.material ? { grossPerCompleteMonth: eco.grossPerCompleteMonth, refundEffect: eco.refundEffect } : {}),
        highest: eco.highest, lowest: eco.lowest, completeness: m.completeness.tier };
    }) : [];
    const liquidBehind = (acc?.accounts ?? []).filter((r) =>
      (r.type === 'checking' || r.type === 'savings') && r.needsReauth).length;

    return {
      asOf: ceiling,
      expense: expense ?? { unavailable: 'no expense baseline: nothing stated, nothing declared, and no '
        + 'complete calendar month of spending to average' },
      income: income ?? { unavailable: 'no income baseline: nothing stated, no settled recurring deposits, '
        + 'and no complete month of observed income' },
      ...derived,
      liquid: liquid === null ? { unavailable: 'no accounts in scope' } : {
        amount: liquid, basis: 'checking + savings from the current accounts — the same figure as '
          + 'get_financial_snapshot.liquid; investments and digital assets are not in it',
        ...(liquidBehind > 0 ? { completeness: { tier: 'incomplete' as Tier,
          reason: `${liquidBehind} liquid account(s) need reconnecting; the balance is the last one read` } } : {}) },
      ...(aggregate.missingMinimumCount > 0
        ? { minimumDebtServiceUnknownFor: aggregate.missingMinimumCount } : {}),
      measuredSpending: { byWindow,
        note: 'The measured monthly figure depends on the window. None of these is wrong; say which one '
          + 'an answer used, and pass `spendingWindow` to make the baseline use it. Every figure is NET of '
          + 'refunds dated in the month; where refunds mattered, `grossPerCompleteMonth` and `refundEffect` '
          + 'are given — quote them, never subtract.' },
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
    'figure states the population it is a share of. Pass `asOf` for a past date.',
  parameters: obj({
    asOf: str('YYYY-MM-DD. Omit for today. A past date returns the composition as it was.'),
  }),
  async run(a, ctx) {
    const asOf = (a.asOf as string) || ctx.asOfISO;
    if (asOf < ctx.asOfISO) {
      // ⚠️ A PAST DATE HAS NO ACCOUNT COMPOSITION TO COMPOSE. `composeInvestments`
      // reads today's account totals; the historical authority is the snapshot's
      // own investments / digitalAssets split, which carries its own coverage.
      // Returning the current composition under a past `asOf` would be the exact
      // leakage this parameter exists to prevent.
      const snap = await historicalSnapshot(ctx, asOf) as Record<string, unknown>;
      if (snap.unavailable) return snap;
      return {
        asOf, basis: 'HISTORICAL_SNAPSHOT',
        observedOn: snap.observedOn,
        composition: {
          traditionalInvestments: snap.investments,
          digitalAssets: snap.digitalAssets,
          note: 'Disjoint by construction, from the snapshot authority for that date.',
        },
        coverage: snap.coverage,
        buckets: (snap.buckets as unknown[] | undefined)?.filter(
          (b) => ['investments', 'crypto'].includes((b as { bucket: string }).bucket)),
        positionDetailUnavailable:
          'Position-level detail and concentration are current-only in this harness.',
      };
    }
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
  // ⚠️ THIS IS THE CHANGE TOOL, AND IT NOW SAYS SO. It already returned both
  // endpoints with every component; what it did not do was say that this is what
  // answers "what changed" — so the model reached for a tool whose NAME promised
  // change and whose payload was a composition, and read balances as movements
  // (58b352f, twice). The `change` block below is the same fact, subtracted by an
  // authority instead of by whoever is reading.
  description:
    'Net worth and its components over time, and what they CHANGED by across the ' +
    'requested range — `change` gives the measured movement of net worth, liquid, ' +
    'investments, digital assets and debt between the first and last observation. Use it ' +
    'for "what changed", "why did my net worth move", "how does this compare with a month ' +
    'ago". `liquid` is checking + savings; `checking` is the checking bucket alone — there ' +
    'is deliberately no field called "cash". Ask for `granularity: "monthly"` to get one ' +
    'point per calendar month. A point whose net worth could not be established is returned ' +
    'as null WITH a reason; read `coverage` before describing older history as fact. For an ' +
    'EXACT date — the first or last time something crossed a number, a highest or a lowest — ' +
    'use `find_in_balance_history` instead: a long series here is downsampled and the day you ' +
    'need may not be in it.',
  parameters: obj({
    from: str('YYYY-MM-DD. Omit for the last 90 days.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
    granularity: { type: 'string', enum: ['monthly', 'daily'],
      description: 'monthly = the last observation in each calendar month. Default '
        + 'monthly for ranges over 92 days, daily otherwise.' },
    maxPoints: num('Daily granularity only: downsample evenly to at most this many points.'),
  }),
  async run(a, ctx) {
    // ⚠️ THE CEILING APPLIES HERE TOO, AND DID NOT. `get_spending`,
    // `get_transactions` and `get_income` all clamp; this one took `to` raw, so a
    // retrospective read at `asOf: 2026-01-31` asking `to: 2026-09-12` returned
    // SEPTEMBER balances. Found while proving the new `change` block respects the
    // ceiling — which it could not, because the endpoints it subtracts did not.
    const ceiling = ctx.asOfISO;
    const to   = clampToCeiling((a.to as string) || ceiling, ceiling);
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

    // ⚠️ NO FIELD HERE IS CALLED `cash`, AND THAT IS THE WHOLE POINT. It used to
    // be: `cash: p.liquid`, where `liquid` is checking PLUS savings. Meanwhile
    // `explain_net_worth_composition{lens:'cash'}` returns the CHECKING bucket alone.
    // Both were correct about their own population and both were called "cash",
    // so on 2026-01-01 one tool said $1,255.20 and the other said $9,517.46. The
    // model quoted the smaller one, built debt advice on it, and only corrected
    // when the user pushed back. A model cannot reconcile two fields that share a
    // name and not a population, and it should never have to.
    const pt = (p: (typeof inRange)[number]) => ({
      date: p.date,
      // Null means EXPLICITLY UNKNOWN and always travels with its reason.
      netWorth: p.netWorth, totalAssets: p.totalAssets,
      /** Checking + savings. The spendable total. */
      liquid: p.liquid,
      /** Checking only — the `cash` bucket, matching explain_net_worth_composition's `cash` lens. */
      checking: p.cashOnHand,
      investments: p.investments, digitalAssets: p.digitalAssets,
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
        // ⚠️ HOW MANY THERE ACTUALLY ARE, BESIDE HOW MANY CAME BACK. A monthly
        // roll-up and a downsampled daily read both look exactly like the record
        // from inside the payload, and both have been read as it: a 786-day
        // range capped to 194 points does not contain the day debt first hit
        // zero, so every answer derived from scanning it was wrong before it
        // started. The series is for shape; exact days come from
        // `find_in_balance_history`, which searches all of them.
        observationsInRange: inRange.length,
        ...(picked.length < inRange.length ? {
          seriesIsSample: true,
          sampleNote:
            `This is ${picked.length} of ${inRange.length} observations in the range. Days `
            + 'not shown are NOT missing from the record, they are missing from this '
            + 'payload — never state a first, last, highest or lowest from it. '
            + 'Use find_in_balance_history for those.',
        } : {}),
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
      // ⚠️ MEASURED MOVEMENT, NOT ATTRIBUTION. Each entry is the closing
      // observation minus the opening one for that metric, computed by
      // `observedChange` and carrying the dates it actually compared. Nothing
      // here says WHY: investments rising is not a market gain, cash rising is
      // not income received, and debt falling is a debt fact whose effect on net
      // worth is the reader's to state. A metric that could not be established at
      // either end is absent rather than zero.
      change: changeBlock(pt(inRange[0]), pt(inRange[inRange.length - 1])),
      series: picked.map(pt),
    };
  },
};

// ── 6b. Exact temporal facts over the balance history ────────────────────────

const BALANCE_METRICS = {
  netWorth:      'net worth',
  liquid:        'checking + savings',
  checking:      'the checking bucket alone',
  investments:   'traditional investments',
  digitalAssets: 'crypto',
  debt:          'total debt owed',
} as const;
type BalanceMetric = keyof typeof BALANCE_METRICS;

const TEMPORAL_OPERATIONS: readonly TemporalOperation[] = [
  'minimum', 'maximum',
  'first_below', 'first_above', 'last_below', 'last_above',
];

/**
 * THE EXACT DAY, COMPUTED RATHER THAN READ OFF A LIST.
 *
 * ⚠️ IT EXISTS BECAUSE THE SERIES ANSWER WAS WRONG IN PRODUCTION. Asked when
 * debt first hit zero, the assistant answered 2026-04-24 — a date whose debt, in
 * the very payload it was reading, was $5,353.81. The true answer, 2026-07-22,
 * was in the same series. Scanning two hundred rows for a first/last/highest/
 * lowest is arithmetic, and arithmetic over money is not the model's to do.
 *
 * ⚠️ AND BECAUSE THE SERIES COULD NOT ALWAYS ANSWER IT. `get_net_worth_history`
 * downsamples a long daily range, so the day the answer lives on can simply not
 * be in the payload: a 786-day read capped to 194 points does not contain
 * 2026-07-22 at all, and every reading of it is wrong before the model starts.
 * This scans EVERY observation in range and returns one.
 */
const findInBalanceHistory: ToolDefinition = {
  name: 'find_in_balance_history',
  description:
    'The EXACT date and amount for a question about one balance over time — the first ' +
    'or last time it crossed a number, and its highest or lowest point. Use it for ' +
    '"when did I first hit zero", "when did my debt first fall below 1,000", "when was ' +
    'the last time X was zero", "what was my highest debt", "my lowest cash balance", ' +
    '"when did I cross above/below". ALWAYS use this rather than reading dates off a ' +
    'series yourself: it checks every observation in the range, while a long history ' +
    'series is downsampled and may not even contain the day you need. Returns the ' +
    'matching observation, the observation before it, and the coverage it searched.',
  parameters: obj({
    metric: { type: 'string', enum: Object.keys(BALANCE_METRICS),
      description: 'Which balance. `liquid` is checking + savings; `checking` is the '
        + 'checking bucket alone; `debt` is what is owed, as a positive amount.' },
    operation: { type: 'string', enum: [...TEMPORAL_OPERATIONS],
      description: 'minimum and maximum need no threshold. first_below, first_above, '
        + 'last_below and last_above each need one, and INCLUDE the threshold itself: '
        + '"the first time debt was zero" is first_below with threshold 0; "when did it '
        + 'first go over 10,000" is first_above with threshold 10000.' },
    threshold: num('The amount to compare against. Required for first_below, first_above, last_below and last_above.'),
    from: str('YYYY-MM-DD. Omit for the whole available history.'),
    to:   str('YYYY-MM-DD. Omit for today.'),
  }, ['metric', 'operation']),
  async run(a, ctx) {
    const metric = a.metric as BalanceMetric;
    const operation = a.operation as TemporalOperation;
    if (!BALANCE_METRICS[metric]) return { error: `unknown metric: ${String(a.metric)}` };
    if (!TEMPORAL_OPERATIONS.includes(operation)) {
      return { error: `unknown operation: ${String(a.operation)}` };
    }
    const threshold = a.threshold === undefined ? undefined : Number(a.threshold);
    if (NEEDS_THRESHOLD[operation] && (threshold === undefined || !Number.isFinite(threshold))) {
      return { error: `${operation} needs a numeric threshold` };
    }

    // The same read, the same projection, the same refusals as the series tool.
    // A second historical pipeline would be a second version of the truth.
    const ceiling = ctx.asOfISO;
    const to = clampToCeiling((a.to as string) || ceiling, ceiling);
    const rows = await getRecentSnapshots({ rows: SNAPSHOT_READ_ROWS }, { spaceId: ctx.spaceId });
    const section = projectSnapshotSection(rows as Snapshot[], 'full');
    if (!section) return { unavailable: 'no usable snapshot history for this Space' };
    // ⚠️ THE WHOLE RECORD BY DEFAULT. "When did I FIRST" has no natural start
    // date, and defaulting to ninety days the way the series tool does would
    // answer a different question and sound certain doing it. `oldestDate` is
    // null only for an empty section, which is already refused above.
    const from = (a.from as string) || section.oldestDate || '0000-01-01';

    const inRange = section.history.filter((p) => p.date >= from && p.date <= to);
    const valueOf = (p: (typeof inRange)[number]): number | null =>
      metric === 'netWorth' ? p.netWorth
      : metric === 'liquid' ? p.liquid
      : metric === 'checking' ? p.cashOnHand
      : metric === 'investments' ? p.investments
      : metric === 'digitalAssets' ? p.digitalAssets
      : p.liabilities;

    // ⚠️ AN UNESTABLISHED VALUE IS NOT A LOW AND NOT A ZERO. Points the
    // assembler refused are removed from the scan and counted, so "crypto could
    // not be valued for 407 days" can never become "your net worth bottomed out".
    const usable = inRange
      .map((p) => ({ date: new Date(`${p.date}T00:00:00.000Z`), value: valueOf(p) }))
      .filter((p): p is { date: Date; value: number } => p.value !== null);
    const unassertable = inRange.length - usable.length;

    const coverage = {
      window: { from, to },
      observationsInRange: inRange.length,
      observationsSearched: usable.length,
      observationsUnassertable: unassertable,
      firstObservation: usable[0] ? isoDay(usable[0].date) : null,
      lastObservation: usable.length ? isoDay(usable[usable.length - 1].date) : null,
      historyAvailableFrom: section.oldestDate,
      historyAvailableTo:   section.newestDate,
      ...(unassertable > 0 ? { note:
        `${unassertable} observation(s) in this range could not be established and were `
        + 'not searched. They are not zeroes.' } : {}),
    };

    // ⚠️ TWO DIFFERENT ANSWERS, NEVER THE SAME ONE. "It never happened in a range
    // I can see" and "I cannot see that range" are opposite statements, and a
    // single empty result would let either be told as the other.
    if (usable.length === 0) {
      return { metric, operation, ...(threshold !== undefined ? { threshold } : {}),
        result: null,
        unavailable: inRange.length === 0
          ? 'NO_OBSERVATIONS_IN_RANGE'
          : 'NO_ESTABLISHED_OBSERVATIONS_IN_RANGE',
        coverage };
    }

    const found = findObservation(usable, operation, threshold);
    if (!found) {
      return { metric, operation, ...(threshold !== undefined ? { threshold } : {}),
        result: null, unmatched: 'NO_OBSERVATION_MEETS_THE_CONDITION', coverage };
    }

    return {
      metric, metricMeans: BALANCE_METRICS[metric], operation,
      ...(threshold !== undefined ? { threshold } : {}),
      result: {
        date: isoDay(found.match.date),
        value: found.match.value,
        ...(found.previous
          ? { previousObservation: { date: isoDay(found.previous.date), value: found.previous.value } }
          : {}),
      },
      // ⚠️ OBSERVED, NOT INTERPOLATED, AND THE ANSWER SHOULD SAY SO WHEN IT
      // MATTERS. Debt was $17.12 on the 19th and $0 on the 22nd; nothing was
      // measured in between, so the 22nd is the first day it was OBSERVED at
      // zero, not provably the day it became zero.
      basis: 'Observed daily snapshots only — nothing between two observations is modelled. '
        + 'Describe the answer as the first/last OBSERVED date where that distinction matters.',
      coverage,
    };
  },
};

// ── 7. Net-worth explanation ─────────────────────────────────────────────────

/**
 * The measured movement of each component between two observations.
 *
 * ⚠️ ONE SUBTRACTION AUTHORITY, CALLED FIVE TIMES. `observedChange` owns what a
 * change between two observations IS — including refusing when the two are the
 * same day, and reporting which rows it compared. This maps components onto it
 * and adds nothing: no re-signing, no net-worth-effect interpretation, no
 * labels. A metric that is null at either end is OMITTED rather than treated as
 * zero, because "not established" and "did not move" are different answers.
 *
 * ⚠️ `debt` IS THE DEBT'S OWN DIRECTION. Debt falling from 20,000 to 10,000 is
 * `abs: -10000`. That it IMPROVED net worth by 10,000 is a true sentence and is
 * the reader's to write — a field called `debtContribution: -10000` would be the
 * ambiguity this deliberately refuses to ship.
 */
interface ChangeableSnapshotPoint {
  date: string;
  netWorth: number | null; liquid: number | null; checking: number | null;
  investments: number | null; digitalAssets: number | null; debt: number | null;
}
type ChangeMetric = Exclude<keyof ChangeableSnapshotPoint, 'date'>;

function changeBlock(first: ChangeableSnapshotPoint, last: ChangeableSnapshotPoint) {
  const metrics: ChangeMetric[] =
    ['netWorth', 'liquid', 'checking', 'investments', 'digitalAssets', 'debt'];
  const at = (p: ChangeableSnapshotPoint, k: ChangeMetric) =>
    (typeof p[k] === 'number' ? { date: new Date(`${p.date}T00:00:00.000Z`), value: p[k] } : null);
  const out: Record<string, unknown> = {};
  for (const m of metrics) {
    const c = observedChange(at(first, m), at(last, m));
    if (c) out[m] = { from: c.fromValue, to: c.toValue, abs: round2(c.abs), pct: c.pct };
  }
  if (Object.keys(out).length === 0) return null;
  return {
    between: { from: first.date, to: last.date },
    ...out,
    meaning: 'Each figure is the closing observation minus the opening one for that metric, '
      + 'in the metric\'s own direction — `debt` negative means debt fell. These are MEASURED '
      + 'movements, not causes: an investments rise is not necessarily a market gain, a cash '
      + 'rise is not necessarily income, and what drove either is a transaction question.',
  };
}

/** The lens roots `lib/history` exposes. Listed so a single-lens answer can name its siblings. */
const EXPLAINABLE_LENSES = [
  'net-worth', 'assets', 'liquid-net-worth', 'investments',
  'crypto', 'cash', 'savings', 'debt', 'liquidity',
] as const;

// ⚠️ RENAMED, BECAUSE IT NEVER EXPLAINED A CHANGE. It took one `date`, passed
// `fromISO === toISO`, and returned a COMPOSITION — and its own description
// invited "why did my net worth drop". Measured twice in dogfood (58b352f and the
// 1b83384 re-run): the model asked it what changed and narrated BALANCES as
// contributions, calling a $12,345.80 savings level "a big chunk" of an
// $11,242.40 rise. The capability is real and unduplicated — one lens, drilled
// bucket → account → holding — so the name moved to meet it rather than the
// other way round. Change now lives where the two endpoints always did:
// `get_net_worth_history`.
const explainNetWorthComposition: ToolDefinition = {
  name: 'explain_net_worth_composition',
  description:
    'Break ONE total into the components it is MADE OF on a single date, and drill into '
    + 'them. This is a composition at a point in time, not a movement: for what CHANGED '
    + 'between two dates use get_net_worth_history, and for a whole position on one date '
    + 'use get_financial_snapshot(asOf). Each result names the population the lens covers '
    + 'and its sibling lenses — `cash` is checking only, `savings` is separate. Call again '
    + 'with a component id to drill deeper.',
  parameters: obj({
    date: str('YYYY-MM-DD to explain. Required.'),
    lens: { type: 'string',
      enum: ['net-worth', 'assets', 'liquid-net-worth', 'investments', 'crypto', 'cash', 'savings', 'debt'],
      description: 'Which total to break down. Default net-worth.' },
    componentId: str('A component id from a previous call, to drill one level deeper.'),
  }, ['date']),
  async run(a, ctx) {
    // ⚠️ SAME CEILING, SAME REASON. A composition on a date after the cutoff is a
    // balance from the future wearing a historical label.
    const dateISO = clampToCeiling(String(a.date), ctx.asOfISO);
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
    const components = (n.components ?? []).map((c) => ({
      id: c.id, label: c.label, value: c.displayedValue,
      canDrillDeeper: c.drilldown?.available ?? false,
    }));
    return {
      date: dateISO, lens, label: n.label,
      value: n.displayedValue, currency: n.currency,
      explainedByComponents: n.explainedValue,
      unexplainedRemainder: n.unattributedObservedAmount,
      assertable: n.assertable, unavailableReason: n.unavailableReason,
      components,
      // ⚠️ WHAT THIS LENS COVERS, AND WHAT IT DOES NOT. `cash` is the checking
      // bucket; `savings` is a SEPARATE lens; and a reader who wants the spendable
      // total wants neither on its own. Stating the population and the siblings is
      // what stops a single-bucket figure being read as a whole-position one.
      population: {
        lens, label: n.label,
        covers: components.map((c) => c.label),
        siblingLenses: EXPLAINABLE_LENSES.filter((l) => l !== lens),
        note: 'This is ONE component of the position on that date. For the whole '
          + 'picture in one call, use get_financial_snapshot with an asOf.',
      },
    };
  },
};

/**
 * THE CASH SPINE — everything `project_cash` needs to answer, factored out so a
 * second tool cannot grow a second copy of it.
 *
 * ⚠️ ONE SPINE, TWO TOOLS, ONE SET OF NUMBERS. `scenario_projection` layers
 * stated contributions and returns over exactly these checkpoints. If it loaded
 * its own streams, its own accounts or its own spending window, the two tools
 * would eventually disagree about the same month — and the user would be told
 * both figures in the same conversation. The invariant that the last checkpoint
 * equals a standalone run holds because there is only ever one `runTo`.
 *
 * ⚠️ A RETROSPECTIVE RUN MUST START FROM THE BALANCE THAT WAS TRUE THEN, and
 * must not see a transaction dated after the cutoff. Opening cash comes from the
 * snapshot authority for that date, income cadence from the streams authority AT
 * that date (which reconstructs the then-current employer), and the spending
 * window is bounded by it. Anything else quietly projects the past using the
 * future.
 */
interface CashSpine {
  asOf:          string;
  retrospective: boolean;
  openingBasis:  string;
  /** The accounts payload the projection opened from. Null for a refused build. */
  accounts:      AccountsSectionData | null;
  runTo:         (end: string,
                  spendingOverride?: { monthly: number }) => AssembledForecast;
}

async function buildCashSpine(
  ctx: ToolContext,
  opts: {
    asOf: string; assumedMonthlySpending?: number;
    /**
     * I1 — dated income rules, baked into the closure so EVERY spine point sees
     * them.
     *
     * ⚠️ THIS IS WHY I1 REACHES THE FLOOR, THE DEBT WATERFALL AND THE CROSSINGS
     * WITHOUT TOUCHING ANY OF THEM. `spineFor` calls `runTo` once per date; a
     * rule inside the closure changes the cash at every one of those dates, and
     * the ledger reads nothing but that cash. A rule applied anywhere else would
     * have had to be applied to each consumer separately, and the first one
     * forgotten would answer a different question in the same conversation.
     */
    incomeChanges?: readonly IncomeChangeRule[];
  },
): Promise<CashSpine | { unavailable: string; asOf: string }> {
  const asOf = opts.asOf;
  const retrospective = asOf < ctx.asOfISO;

  const reads = ctx.cashSpineReads;
  const [streams, accounts, transactions] = await Promise.all([
    loadForecastIncomeStreams(ctx.spaceId, asOf, reads?.incomeTransactions, reads?.incomeAccountTypes),
    reads ? reads.accounts() : assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
    // ⚠️ THE ONE LINE THAT MADE THIS TOOL WORK. PROJECTION-1 derives its spending
    // rate from `reliableMonths(transactionsDomain)`; with only the accounts
    // domain in scope it sees zero months, cannot assert a rate, and returns
    // `closing: null` — always, for every horizon. Measured before the fix:
    // null / null. After: $38,243.50 to end-2026 and $128,827.54 to end-2027.
    // Both models papered over the null by doing the arithmetic in prose, and
    // one of them was $745.86 out.
    reads ? reads.transactionsSummary() : assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
      retrospective
        ? { transactionWindow: { startDate: daysAgoISO(asOf, 179), endDate: asOf,
            label: `evidence through ${asOf}` } }
        : {}),
  ]);

  // ⚠️ BUILT PER RUN, NOT ONCE, SO A SOLVER CAN VARY IT. `scenario_goal_seek`
  // solves for a monthly spending cut by re-running the projection at dozens of
  // spending levels; the expensive part is the three reads above, and
  // `assembleForecast` itself is pure. Baking one statement into the closure
  // would have forced a fresh set of reads per bisection step.
  // ⚠️ ONE DERIVATION OF THE WORDING, AND IT IS THE AMOUNT. See the note below.
  const spendingStatement = (monthly: number): UserStatement[] => ([{
    mode: StatementMode.ASSERTS_FACT,
    statedAs: `assumed monthly spending ${monthly}`,
    asOfISO: ctx.asOfISO,
    subject: { kind: 'SPENDING_LEVEL', amount: monthly,
      currency: 'USD', periodBasis: PeriodBasis.MONTHLY },
  }]);
  // ⚠️ THE WORDING IS DERIVED FROM THE NUMBER, NEVER SUPPLIED. This took a caller's
  // `statedAs` verbatim, and `assembleForecast` quotes it into `appliedFacts` as the
  // words for the SPENDING LEVEL it applied — so any sentence could ride into the
  // applied channel attached to a figure it did not describe. Measured (1d67786):
  // the model passed "user has a $15k net bonus on 2026-12-07 added on top of current
  // pattern", the projection moved $10.43, and the result reported
  // `spending baseline 4346.48 USD: "…$15k net bonus…"` — a $15,000 assumption
  // presented as applied when it was discarded, and carried on into the durable
  // checkpoint's `basis.userAssumptions`.
  //
  // Generating the sentence from the amount makes the fact self-describing: what it
  // says and what it applied are the same value, by construction. There is no longer
  // a channel through which uninterpreted prose can become an applied fact.
  const statements: UserStatement[] = typeof opts.assumedMonthlySpending === 'number'
    ? spendingStatement(opts.assumedMonthlySpending)
    : [];

  // For a retrospective run the accounts payload is rebuilt from the snapshot
  // authority for that date — the CURRENT accounts domain would supply today's
  // opening cash to a projection that starts nine months ago.
  let openingAccounts: AccountsSectionData | null = accounts;
  let openingBasis = 'CURRENT_ACCOUNTS';
  if (retrospective) {
    const snap = await historicalSnapshot(ctx, asOf) as Record<string, unknown>;
    if (snap.unavailable) return { unavailable: snap.unavailable as string, asOf };
    openingAccounts = {
      totalLiquid: snap.liquid as number,
      totalLiabilities: snap.debt as number,
      netWorth: (snap.netWorth as number | null) ?? 0,
      totalAssets: (snap.totalAssets as number | null) ?? 0,
      totalInvestments: (snap.investments as number | null) ?? 0,
      totalDigitalAssets: (snap.digitalAssets as number | null) ?? 0,
      counts: accounts?.counts ?? { liquid: 0, investments: 0, digitalAssets: 0,
        realAssets: 0, liabilities: 0 },
      redactedCount: 0, totalsUnconverted: false,
    } as unknown as AccountsSectionData;
    openingBasis = 'HISTORICAL_SNAPSHOT';
  }

  const forecastCtx = {
    space: { name: '', reportingCurrency: 'USD' },
    domains: {
      [FinanceDomains.ACCOUNTS]: { data: openingAccounts },
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: transactions },
    },
  } as unknown as SpaceContext_AI;

  return {
    asOf, retrospective, openingBasis, accounts: openingAccounts,
    runTo: (end: string, spendingOverride?: { monthly: number }) =>
      assembleForecast({
        ctx: forecastCtx, streams, asOfISO: asOf,
        statements: spendingOverride
          ? spendingStatement(spendingOverride.monthly)
          : statements,
        ...(opts.incomeChanges && opts.incomeChanges.length > 0
          ? { incomeChanges: opts.incomeChanges } : {}),
        horizon: { fromISO: asOf, toISO: end, origin: AssumptionOrigin.USER_REQUESTED,
          statedAs: `through ${end}` } as unknown as ForecastHorizon,
      }),
  };
}

// ── 8. Cash projection ───────────────────────────────────────────────────────

/**
 * An interval of the projection, as the model reads it.
 *
 * ⚠️ NOTHING IS COMPUTED HERE. The window, its clamp, its refusal and every
 * figure are the projection authority's (`projectCashInterval`, reached through
 * the forecast adapter); this rounds at the display edge and names the fields.
 * `{from, to, days}` are stated on every answer because an interval whose bounds
 * are implied is how two different windows end up compared.
 */
function presentInterval(
  i: ReturnType<typeof projectInterval>, requestedFrom: string, requestedTo: string,
) {
  if (!i) {
    return { unavailable: 'there is no evidence-based projection to take an interval of',
      requested: { from: requestedFrom, to: requestedTo } };
  }
  if (i.status === 'REFUSED') {
    return { unavailable: i.refusal, requested: { from: requestedFrom, to: requestedTo },
      instead: 'a period that has already happened is measured, not projected: use '
        + 'measure_flows (or get_spending / get_income) for it' };
  }
  return {
    from: i.fromISO, to: i.toISO, days: i.days,
    ...(i.clamped ? { requested: { from: i.clamped.requestedFromISO, to: requestedTo },
      clamped: i.clamped.reason } : {}),
    cashAtStart: { date: i.opening!.dateISO, amount: round2(i.opening!.cash) },
    cashAtEnd: { date: i.closing!.dateISO, amount: round2(i.closing!.cash) },
    // ⚠️ FROM THE TWO PRINTED BALANCES, so the figure reproduces from its operands.
    // Payroll settles at sub-cent precision (…645), so the rounded components can
    // sit a cent away from it; the balances are the figures a standalone run to
    // either date prints, and they are the ones this agrees with exactly.
    cashChange: round2(round2(i.closing!.cash) - round2(i.opening!.cash)),
    components: i.components.map((c) => ({ ...c, value: round2(c.value) })),
    incomeEventsCounted: i.eventsCounted,
    meaning: 'What the SAME projection puts inside this window: income and obligations dated '
      + '`from`..`to` inclusive, spending accrued over `days` days. `cashChange` = `cashAtEnd` − '
      + '`cashAtStart` (the balance at the close of the day before the window) = income − '
      + 'obligations − spending, to the cent of rounding. `projection.endingCash` is still the '
      + 'balance at `to`. Quote these; never difference two projections yourself.',
  };
}

const projectCash: ToolDefinition = {
  name: 'project_cash',
  // ⚠️ THE BOUNDARY BELONGS IN THE DESCRIPTION, NOT ONLY ON A PARAMETER. 54eb8e1
  // put "a one-off amount on a date is not part of this projection" on
  // `assumedMonthlySpending`, where a model choosing between tools never reads
  // it — and kept choosing this one for bonuses (5/5, then 8/10, then 9/10).
  // Measured A/B: moving that sentence up here, and saying plainly what
  // scenario_projection is for, took establishment from 0/5 to 5/5 on a bonus
  // and 2/5 to 5/5 on a car, with the ordinary-projection control unmoved.
  description:
    'Deterministic cash projection to a future date, with checkpoints along the way. The ' +
    'headline answer is `projection` — an evidence-based estimate built from observed ' +
    'payroll cadence and observed spending continuing as they are. ' +
    '`assumedMonthlySpending` is the only assumption it can apply; a dated one-off amount ' +
    'arriving or leaving is not part of this projection, and neither is a CHANGE TO FUTURE ' +
    'INCOME from a date — a raise, a new salary, an income starting or ending all belong to ' +
    'scenario_projection. `establishment` says how firmly ' +
    'each input is pinned down; it is provenance, not a competing answer. With `from` it ' +
    'also states what is projected to come in and go out INSIDE a future window.',
  parameters: obj({
    to: str('YYYY-MM-DD horizon end. Required.'),
    // ⚠️ A WINDOW, NOT A YEAR. "How much will I spend during 2027?" took two
    // cumulative calls and a subtraction in prose (66,733.35 − 14,575.59). The
    // projection already owned both figures; what it lacked was a start. There is
    // deliberately no annual-spending special case here or anywhere: any future
    // `[from, to]` is the same fold over the same events at the same rate.
    from: str('YYYY-MM-DD, after today. Set it only when the question is about a future '
      + 'WINDOW rather than from now — "how much will I spend during 2027", "what comes in '
      + 'next quarter". The result adds `interval`: projected income, spending and '
      + 'obligations inside from..to (both dates inclusive) and the cash change across it. '
      + 'Never subtract two projections yourself. Omit for an ordinary projection.'),
    assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here. '
      + 'It is the only user assumption this tool can apply. A one-off amount on a date — '
      + 'a bonus, an inheritance, a purchase, a sale — is not part of this projection.'),
    checkpoints: { type: 'string', enum: ['monthly', 'quarterly', 'yearly', 'none'],
      description: 'How often to report a balance between now and the horizon: monthly = '
        + 'every month-end, quarterly = every quarter-end, yearly = every 31 December; the '
        + 'horizon is always the last row. Omit for the default: none under ~45 days, then '
        + 'monthly within 18 months, quarterly to about 20 years, yearly beyond. A cadence '
        + 'that would exceed the row ceiling is returned one step coarser and the result says '
        + 'so under `horizon.requested` / `horizon.omitted`.' },
    asOf: str('Project FROM this date using only evidence available then. Omit for today. '
      + 'Use for "what would you have predicted back in January?".'),
    ignoreStaged: { type: 'boolean', description: 'Only when the user has stated a plan in this '
      + 'conversation AND asks for the current trend WITHOUT it.' },
  }, ['to']),
  async run(a, ctx) {
    const toISO = String(a.to);
    // ⚠️ THE CLOSED ARGUMENT SET REACHES THIS TOOL TOO (I1). The scenario tools
    // have refused an undeclared argument since the closed set existed; this one
    // never did, and the first I1 dogfood turn found the hole by walking into it:
    // asked "starting January my income increases 10%, what does that do to my
    // cash?", the model called project_cash with a well-formed `incomeChanges`
    // array. There was nothing to read it, so the raise was SILENTLY DROPPED and a
    // current-trend projection came back as the answer to a question about a
    // raise. A tool that cannot model a condition must say so, not compute
    // without it.
    // ⚠️ PRESENTATION KEYS ARE NOT REFUSED (review). `granularity` is the scenario
    // tools' table cadence — project_cash's own is `checkpoints` — and a model
    // carrying it over from a scenario call would otherwise lose the whole
    // projection over a field that changes no figure. Only a key that would have
    // CHANGED the answer is worth refusing the answer for.
    const rejected = refuseUnknownArguments(a, projectCash.parameters)
      .filter((r) => !r.argument || !NOT_AN_ASSUMPTION.includes(r.argument));
    // ⚠️ STAGED CONDITIONS ARE NOT DROPPED BY PICKING THE TOOL THAT CANNOT SEE THEM
    // (planning continuity). Measured: with a raise, a floor, a debt order and
    // "invest the rest" all staged, "what do I have next December?" called THIS
    // tool 6/6 and answered with the current trend — while saying, in the answer,
    // that none of the user's conditions were in it. It is the same failure as
    // `incomeChanges` sent here: a condition the user stated, computed without.
    // A retrospective run ("what would you have predicted in January?") is about
    // the past and is not affected; the current trend on purpose is one visible
    // flag away.
    // ⚠️ A REAL LOOK BACK, NOT A STRING THAT SORTS EARLIER (review). `a.asOf <
    // today` let `asOf: ""` (which then falls back to today) and yesterday walk past
    // the refusal with a current-trend run. "What would you have predicted in
    // January?" is at least a month back; anything nearer is the present.
    const retrospectiveRun = typeof a.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.asOf)
      && Date.parse(`${ctx.asOfISO}T00:00:00Z`) - Date.parse(`${a.asOf}T00:00:00Z`) >= 30 * 86_400_000;
    const staged = ctx.plan?.pending.clauses ?? [];
    // ⚠️ AND WHEN A SCENARIO HAS ALREADY RUN (measured 1/6): after the plan ran,
    // "what about next June?" came here and answered the plan's question with the
    // current trend. Pending is empty once a scenario runs, so the staged check
    // could not catch it. While a plan is in play in this conversation — staged or
    // run — its questions are answered with it; the current trend is one flag away.
    // FM-AUDIT-018 — a plan that could not be CARRIED to this turn is still in play:
    // answering its question from the current trend is exactly the silent failure
    // the continuity marker exists to prevent.
    const planInPlay = staged.length > 0 || ctx.plan?.scenarioRan === true || ctx.plan?.continuity !== undefined;
    if (planInPlay && a.ignoreStaged !== true && !retrospectiveRun && rejected.length === 0) {
      if (staged.length === 0 && ctx.plan?.scenarioRan !== true && ctx.plan?.continuity) {
        return { unavailable: 'the plan the user built earlier in this conversation could not be carried to '
            + 'this turn (it was too large), so it is NOT in force and this projection cannot apply it — it '
            + 'was NOT run',
          instead: 'tell the user the earlier plan was not carried forward, and re-run scenario_projection with '
            + 'every condition they want (ask them to restate what you cannot see). Only if they asked for the '
            + 'current trend WITHOUT their plan, call project_cash again with `ignoreStaged: true`, and say so.' };
      }
      if (staged.length === 0) {
        return { unavailable: 'a scenario the user built is under discussion in this conversation, and '
            + 'this projection cannot apply it, so it was NOT run',
          instead: 'answer with scenario_projection — the ACTIVE SCENARIO\'s arguments, at the horizon the '
            + 'user asked about. Only if they asked for the current trend WITHOUT their plan, call '
            + 'project_cash again with `ignoreStaged: true`, and say that is what it shows.' };
      }
      return { unavailable: `${staged.length} condition(s) the user stated earlier in this `
          + 'conversation are staged, and this projection cannot apply them, so it was NOT run',
        staged: staged.map((c) => ({ id: c.id, [c.key]: c.value })),
        instead: 'scenario_projection applies every staged condition by itself — call it with the '
          + 'horizon (`to`) and nothing else needs restating. Only if the user asked for the '
          + 'current trend WITHOUT their conditions, call project_cash again with '
          + '`ignoreStaged: true`, and say that is what it shows.' };
    }
    if (rejected.length > 0) {
      return { unavailable: 'this projection cannot carry what was stated, so it was NOT run',
        notApplied: notAppliedEcho(rejected),
        instead: 'project_cash continues the observed pattern and can assume only a monthly '
          + 'spending level. A change to future INCOME from a date — a raise, a new salary, an '
          + 'income starting or ending — is scenario_projection\'s `incomeChanges`; a one-off '
          + 'amount arriving or leaving is its `outflows`.' };
    }
    // When the user asked for the current trend on purpose, the answer says what
    // it left out — the staged conditions are theirs, and they are not in it.
    const leftOut = planInPlay && a.ignoreStaged === true && staged.length > 0
      ? { leftOutOnPurpose: { staged: staged.map((c) => ({ id: c.id, [c.key]: c.value })),
          meaning: 'The current trend, WITHOUT the conditions the user stated in this '
            + 'conversation — as they asked. Say so; these are still held.' } }
      : {};
    const spine = await buildCashSpine(ctx, {
      asOf: (a.asOf as string) || ctx.asOfISO,
      ...(typeof a.assumedMonthlySpending === 'number'
        ? { assumedMonthlySpending: a.assumedMonthlySpending }
        : {}),
    });
    if ('unavailable' in spine) return spine;
    const { asOf, retrospective, openingBasis, runTo } = spine;

    const f = runTo(toISO);
    const licensed = 'refused' in f.forecast ? null : f.forecast.fullCashPath;
    const userAssumed = f.appliedFacts.length > 0;

    // ── Checkpoints ──────────────────────────────────────────────────────────
    //
    // ⚠️ EACH CHECKPOINT IS AN INDEPENDENT RUN FROM THE SAME `asOf`, never a
    // balance carried forward from the previous one. Compounding checkpoint on
    // checkpoint would accumulate rounding and — worse — would let a series drift
    // away from the endpoint the same authority produces for the same horizon.
    // Because every point is `projectCash(asOf → thatDate)`, the last checkpoint
    // IS the endpoint by construction, and a test pins it.
    //
    // ⚠️ THE DATES ARE PLANNED BY THE SAME AUTHORITY THE SCENARIO TABLE USES. A
    // thirty-year horizon was returning 364 month-ends — 112 KB the model then
    // carried in every later prompt — and no row said how far away it was. The
    // plan chooses the cadence (or honours the one asked for, thinned if it must
    // be, and says so); the values at the chosen dates are exactly what a monthly
    // run produces at those dates, because the spine is not the plan's to touch.
    const horizonDays = Math.round(
      (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
    const requested = CADENCES.includes(a.checkpoints as Cadence) ? a.checkpoints as Cadence : null;
    const wantCheckpoints = requested !== null
      || ((a.checkpoints as string) !== 'none' && horizonDays > 45);

    let checkpoints: unknown[] | undefined;
    let plan: CheckpointPlan | undefined;
    if (wantCheckpoints) {
      plan = planCheckpoints({ asOfISO: asOf, toISO, requested });
      let prevClosing: number | null = f.projection ? (f.projection.openingCash ?? null) : null;
      checkpoints = plan.dates.map((date) => {
        const run = runTo(date);
        const closing = run.projection?.closing ?? null;
        const delta = closing !== null && prevClosing !== null ? round2(closing - prevClosing) : null;
        prevClosing = closing;
        return { date, closingCash: closing === null ? null : round2(closing),
          changeSincePrevious: delta,
          // ⚠️ HOW FAR AWAY, IN THE ENGINE'S NUMBERS. A month-end read off this
          // list was narrated as "1 year and 5½ months" when it was five and a
          // half months out; the date was right and the subtraction was not.
          elapsed: elapsedBetween(asOf, date) };
      });
    }

    return {
      ...leftOut,
      horizon: { asOf, to: toISO, days: horizonDays, elapsed: elapsedBetween(asOf, toISO),
        ...(plan ? describePlan(plan) : { checkpoints: 0 }) },
      // ⚠️ A SIBLING OF THE ANSWER, NEVER A REPLACEMENT FOR IT. `projection.endingCash`
      // stays the cumulative balance at `to` and `horizon.to` stays `to`, whether or
      // not a window was asked for — those are the two fields the turn loop's silent
      // checkpoint copies, so a window's CHANGE cannot be recorded as a BALANCE.
      ...(typeof a.from === 'string' && a.from
        ? { interval: presentInterval(projectInterval(f, { fromISO: a.from, toISO }), a.from, toISO) }
        : {}),
      ...(retrospective ? { retrospective: true, openingBasis,
        meaning: `What this projection would have said standing at ${asOf}, using only `
          + 'evidence available then. Compare it with what actually happened; do not '
          + 'present it as a current expectation.' } : {}),
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
          // ⚠️ SAID WHERE THE FIGURE IS. This projection is cash only: an existing
          // liability is neither accrued nor paid down by it, and card purchases
          // already sit in the spending rate. A scenario tool moves liabilities.
          liabilities: 'not modelled here: existing balances are not accrued or paid down by '
            + 'this projection; use scenario_projection / scenario_crossing for dynamic debt',
          components: f.projection.components,
          assumptions: f.projection.assumptions,
          // ⚠️ GROUPED, NOT LISTED. One entry per unlicensed occurrence was 83 KB
          // over thirty years, all saying the same thing about the same streams.
          excluded: compactExcludedEvents(f.projection.excluded as { id: string; reason: string }[]),
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
    // ⚠️ CLOSED, LIKE EVERY TOOL THAT COMPUTES MONEY (review). This is a
    // current-instant move on investments; an income change stated to it was
    // silently dropped, and the answer came back as if it had been considered.
    const rejected = refuseUnknownArguments(a, investmentScenario.parameters);
    if (rejected.length > 0) {
      return { unavailable: 'this calculation cannot carry what was stated, so it was NOT run',
        notApplied: notAppliedEcho(rejected),
        instead: 'investment_scenario moves investment components as of TODAY. A change to '
          + 'future income is scenario_projection\'s `incomeChanges`.' };
    }
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

// ── 11. Scenario projection and goal seek ────────────────────────────────────

/**
 * The checkpoint calendar — which dates a table has rows for — lives in
 * `scenario-checkpoints.ts`, pure and beside the ledger. `yearEndsBetween` and
 * the ceiling are re-exported above so existing callers are unmoved.
 */
/** Days per month, for turning an observed daily spending rate into a monthly one. */
const DAYS_PER_MONTH = 365 / 12;

/** What a caller may vary without restating the whole scenario. */
/**
 * A ledger as the scenario runner produced it, with the floor derivations THIS
 * run actually used (FM-AUDIT-011): at the base spending level they are the
 * setup's; at a transformed one (a goal-seek spending cut) they are re-resolved,
 * and every echo — the clause roster, the floor rule — reads these.
 */
type ScenarioRun = LedgerResult & { floorDerivations: FloorDerivation[] };

/** The floor derivations a ledger ran with (the setup's, for a plain LedgerResult). */
function floorDerivationsOf(setup: ScenarioSetup, ledger: LedgerResult | ScenarioRun): FloorDerivation[] {
  return (ledger as Partial<ScenarioRun>).floorDerivations ?? setup.floorDerivations;
}

interface ScenarioOverrides {
  returns?:            ReturnPeriod[];
  extraContributions?: PlannedMovement[];
  /** Rebuilds the cash spine at a different spending level. */
  monthlySpending?:    number;
}

interface ScenarioSetup {
  asOf: string; toISO: string;
  /** Which dates the table carries and why — cadence, source, anything omitted. */
  plan: CheckpointPlan;
  dates: string[];
  accounts: AccountsSectionData;
  returns: ReturnPeriod[];
  contributions: PlannedMovement[];
  outflows: PlannedMovement[];
  /** The liabilities the ledger moves, built from the position and the stated assumptions. */
  liabilities: LiabilityLine[];
  rejected: RefusedInput[];
  /** The spending level the base run used, and where it came from. */
  monthlySpending: { amount: number | null; source: 'USER_STATED' | 'OBSERVED' | 'NONE' };
  /** M1 — floors stated as months of expenses, with the derivation each resolved through. */
  floorDerivations: FloorDerivation[];
  /**
   * I1 — what the income rules DID, at the horizon this scenario ran to.
   *
   * ⚠️ FROM THE SPINE, NOT FROM `a.incomeChanges`. This is the endpoint run's own
   * record of the occurrences it altered. A rule that was stated and changed
   * nothing appears here with `ran: false` and a reason; a rule that was never
   * stated does not appear at all. Absent when none was stated.
   */
  incomeChanges?: IncomeChangeResult;
  /**
   * Conditions staged earlier in this conversation that this run applied, and the
   * arguments as they actually ran. Absent when nothing was staged.
   */
  staged?: { applied: (Attribution & { value: unknown })[]; supersededByCall: { id: string; key: string }[] };
  /** The arguments this run executed — the call's, with any staged clauses merged in. */
  argumentsRun: Record<string, unknown>;
  run: (o?: ScenarioOverrides) => ScenarioRun;
}

/**
 * Everything both scenario tools need, resolved once.
 *
 * ⚠️ ONE SETUP, TWO TOOLS, FOR THE SAME REASON THERE IS ONE SPINE. A goal seek
 * that parsed its own contributions or opened from its own investment total
 * would eventually solve a slightly different scenario from the one it then
 * shows the user — and the number and the table beneath it would disagree while
 * both looked right. `scenario_goal_seek` solves over `run`, and then renders
 * the ledger `run` produced at the answer.
 */
/**
 * I1 — the tool's `incomeChanges` entries as the primitive's rules.
 *
 * ⚠️ IT MAPS AND VALIDATES NOTHING ELSE. Every question about whether a rule is
 * coherent — a multiplier of 1, a gross-or-net that was not stated, a period the
 * amount is not per, a cadence that cannot be started — belongs to
 * `invalidIncomeChange`, beside the transformation that would otherwise act on
 * the answer. A second opinion here is how two layers come to disagree about
 * which rules ran.
 *
 * ⚠️ NO UNIT IS DEFAULTED AND NO WORDING IS CARRIED. `per` is passed through
 * exactly as stated so a missing one is REFUSED rather than guessed, and nothing
 * the caller wrote in prose travels: `label` names a STARTed income (a thing),
 * and the sentence describing what a rule did is derived from its figures by
 * `income-change.ts`. This is the applied-facts invariant (54eb8e1), where a
 * caller's `statedAs` once rode a $15,000 bonus into a $4,346 spending figure.
 */
function toIncomeChangeRules(
  raw: unknown, declaredOk: (entry: Record<string, unknown>) => boolean,
  rejected: RefusedInput[],
): IncomeChangeRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: IncomeChangeRule[] = [];
  raw.forEach((entry, i) => {
    const name = `\`incomeChanges\` rule i${i + 1}`;
    if (!entry || typeof entry !== 'object') {
      rejected.push({ input: name, reason: 'an `incomeChanges` entry must be an object; nothing was applied for it.' });
      return;
    }
    const c = entry as Record<string, unknown>;
    if (!declaredOk(c)) return;

    // ⚠️ A FIELD OF THE WRONG TYPE IS REFUSED, NEVER DROPPED (review blocker 4).
    // Dropping `to: 20270301` because it was not a string ran the rule to the
    // horizon — a narrower window silently widened — and `source: 123` silently
    // became every income stream. Every declared field is checked here; `null`
    // means "not stated", as it does everywhere else in the scenario contract.
    const TYPES: Record<string, 'string' | 'number'> = {
      op: 'string', source: 'string', from: 'string', to: 'string', multiplier: 'number',
      amount: 'number', per: 'string', basis: 'string', cadence: 'string', label: 'string',
    };
    const wrong = Object.entries(TYPES)
      .filter(([k, t]) => c[k] !== undefined && c[k] !== null && typeof c[k] !== t)
      .map(([k, t]) => `\`${k}\` must be a ${t}`);
    if (wrong.length > 0) {
      rejected.push({ input: name, reason: `${wrong.join('; ')}, so this rule was NOT applied — `
        + 'running it without that field would turn it into a broader rule nobody stated.' });
      return;
    }
    const str = (k: string) => (typeof c[k] === 'string' && c[k] !== '' ? c[k] as string : undefined);
    const op = c.op as IncomeChangeOpKind;

    // ⚠️ A LABEL NAMES A NEW INCOME, AND NOTHING ELSE (review blocker 3). On a
    // SCALE, SET_RATE or STOP it names a stream that already has a name, so the
    // only thing it can carry is a sentence about the scenario — "the buffer is
    // kept and the cards are paid first" rode into the envelope beside a roster
    // saying neither ran.
    if (op !== 'START' && str('label') !== undefined) {
      rejected.push({ input: name, reason: '`label` names a NEW income and belongs only on START; '
        + 'this income already has a name. The rule was NOT applied — drop `label` and re-run.' });
      return;
    }

    // ⚠️ A RATE IS BUILT WHEREVER A RATE WAS STATED (review blocker 1). The first
    // fix for "a 10% net raise" built no rate for any SCALE, which let a SCALE
    // carrying `amount: 180000, per: YEAR` run as ×1.1 and drop the $180k without
    // a word. Now `amount` or `per` always builds a rate — so a SCALE carrying one
    // reaches the engine's refusal ("two answers to one question") — and `basis`
    // alone on a SCALE is the scaled income's basis, which is what it means there.
    const statesRate = c.amount !== undefined && c.amount !== null
      || c.per !== undefined && c.per !== null
      || (op !== 'SCALE' && c.basis !== undefined && c.basis !== null);
    rules.push({
      id: `i${i + 1}`,
      op,
      sourceKey: str('source') ?? null,
      fromISO: str('from') ?? '',
      ...(str('to') ? { toISO: str('to') } : {}),
      ...(typeof c.multiplier === 'number' ? { multiplier: c.multiplier } : {}),
      ...(statesRate
        ? { rate: {
          amount: typeof c.amount === 'number' ? c.amount : NaN,
          per: c.per as RatePeriodKind,
          basis: c.basis as NonNullable<IncomeChangeRule['rate']>['basis'],
        } }
        : {}),
      ...(op === 'SCALE' && !statesRate && str('basis')
        ? { basis: str('basis') as NonNullable<IncomeChangeRule['basis']> } : {}),
      ...(str('cadence') ? { cadence: str('cadence') as NonNullable<IncomeChangeRule['cadence']> } : {}),
      // Bounded, like every other caller name that reaches a result.
      ...(boundedLabel(c.label) ? { label: boundedLabel(c.label) as string } : {}),
    });
  });
  return rules;
}

async function prepareScenario(
  a: Record<string, unknown>, ctx: ToolContext, toISO: string,
  /** The calling tool: its `parameters` are the closed set of arguments this call may carry. */
  tool: Pick<ToolDefinition, 'parameters'>,
  /**
   * The checkpoint dates to evaluate, when the caller owns them.
   *
   * ⚠️ FOR A SEARCH, NOT FOR A TABLE. `scenario_crossing` walks month-ends to
   * find one date and returns none of them; granularity and the
   * MAX_SCENARIO_CHECKPOINTS trim exist to keep a READABLE table readable, and
   * applying them to a search would delete the answer — which is precisely how
   * the historical series used to lose the day it was asked about. Given a grid,
   * this uses it verbatim.
   */
  explicitDates?: string[],
): Promise<ScenarioSetup | { unavailable: string; reason?: unknown }> {
  // ── Staged conditions, merged in before anything reads the arguments ───────
  //
  // ⚠️ THE MEASURED FAILURE (planning continuity). Stated one bare turn at a time
  // — a raise, a floor, a debt order, where the rest goes — and then "what do I
  // have next December?", the scenario that ran contained all four 0/6. What the
  // user said was in prose, and the call carried whatever the model reassembled.
  // Staged clauses are laid over the call by IDENTITY; whatever ran is reported
  // clause by clause as `EARLIER_IN_CONVERSATION`, and a call item a staged
  // restatement replaced is named. Remembered memory is never merged: there is no
  // path from it to here.
  let staged: ScenarioSetup['staged'];
  if (ctx.plan && ctx.plan.pending.clauses.length > 0) {
    const m = mergeIntoArgs(ctx.plan.pending, a);
    a = m.args;
    staged = { applied: m.applied, supersededByCall: m.supersededByCall };
  }

  // ── The closed argument set, read off the tool's own schema ────────────────
  //
  // ⚠️ THIS RAN AFTER THE SPINE WAS BUILT, AND I1 MOVED IT. Everything below
  // reads the keys it knows; nothing looked at the rest, so a premature or
  // misspelt argument (`contribution`, `floor`) ran the scenario WITHOUT that
  // clause and echoed nothing. `additionalProperties: false` only asks the
  // provider to stop it. The schema the model was shown is the one literal: an
  // undeclared argument, or an undeclared key on an array entry, is refused by
  // name (`scenario-rules`), and the echo carries it on every path.
  //
  // It is FIRST now because `incomeChanges` changes the spine, so the rules have
  // to be read and refused before there is a spine to change.
  const rejected: RefusedInput[] = [...refuseUnknownArguments(a, tool.parameters)];
  const declared = (arrayKey: string, name: string, alsoRead?: string[]) => (raw: Record<string, unknown>): boolean => {
    const refusal = refuseUnknownItemKeys(raw, tool.parameters, arrayKey, name, alsoRead);
    if (refusal) rejected.push(refusal);
    return !refusal;
  };

  const incomeChanges = toIncomeChangeRules(
    a.incomeChanges, declared('incomeChanges', 'an `incomeChanges` entry'), rejected);

  const spine = await buildCashSpine(ctx, {
    asOf: ctx.asOfISO,
    ...(typeof a.assumedMonthlySpending === 'number'
      ? { assumedMonthlySpending: a.assumedMonthlySpending }
      : {}),
    ...(incomeChanges.length > 0 ? { incomeChanges } : {}),
  });
  if ('unavailable' in spine) return spine;
  const { asOf, runTo, accounts } = spine;
  if (!accounts) return { unavailable: 'no accounts in scope' };
  if (toISO <= asOf) {
    return { unavailable: `the horizon ${toISO} is not in the future; a scenario needs a `
      + 'date after today' };
  }

  // ⚠️ THE INVESTMENT POT COMES FROM THE CANONICAL COMPOSER, NOT FROM A SUM
  // HERE. Traditional investments and digital assets are disjoint by
  // construction; when either is withheld the composer returns null, and a
  // ledger that treated null as zero would grow a hole at 8% a year.
  const composition = composeInvestments(accounts);
  if (!composition || composition.combined === null) {
    return { unavailable: 'the investment total cannot be stated for this Space, so a '
      + 'scenario over it would be arithmetic on an unknown',
      reason: composition?.withheldReason ?? 'no investment accounts in scope' };
  }

  const endpoint = runTo(toISO);

  // ── I1 — what the income rules did, and what they refused ─────────────────
  //
  // ⚠️ THE REFUSALS JOIN THE ECHO, AND THE WHOLE ARGUMENT IS FORGOTTEN ONLY WHEN
  // NOTHING IN IT RAN. A partly-refused array is kept: the rules that ran are
  // still the scenario, and the refused one is refused identically on every
  // replay, visibly. Naming `incomeChanges` as the refused ARGUMENT when only
  // some entries failed would delete the user's working clauses along with the
  // broken one.
  const incomeRejected = endpoint.incomeChanges?.rejected ?? [];
  // Stated entries = those the engine saw plus those the mapper refused before it.
  const statedEntries = Array.isArray(a.incomeChanges) ? a.incomeChanges.length : 0;
  const allRefused = statedEntries > 0 && incomeRejected.length === incomeChanges.length;
  for (const r of incomeRejected) rejected.push({ input: r.input, reason: r.reason });
  // Refusals from BOTH layers — the mapper's type and label checks, and the
  // engine's — mark the argument as unapplied only when nothing in it ran.
  if (allRefused) {
    for (const r of rejected) if (r.input.startsWith('`incomeChanges` rule')) r.argument = 'incomeChanges';
  }

  // The spine's own opening balance — checking plus savings. Named `liquid`
  // below for the same reason nothing in the result is named `cash`.
  const openingLiquid = endpoint.projection?.openingCash
    ?? ('refused' in endpoint.forecast ? null : endpoint.forecast.openingCash.amount);
  if (openingLiquid === null) {
    return { unavailable: 'no opening cash balance could be established, so nothing can be '
      + 'projected from it',
      reason: endpoint.projection?.missing?.join('; ') ?? endpoint.unavailable };
  }

  // ⚠️ THE DATES ARE PLANNED, NOT CLAMPED. A caller-owned grid (the crossing
  // search) is used verbatim; a table's cadence is chosen, thinned to fit the
  // ceiling if it must be, and the plan says what was asked, what was returned
  // and which dates fell out — so a row that is not there is a row the reader
  // was told is not there.
  const requested = CADENCES.includes(a.granularity as Cadence) ? a.granularity as Cadence : null;
  const plan: CheckpointPlan = explicitDates
    ? { cadence: 'monthly', source: 'REQUESTED', requested: 'monthly', dates: explicitDates }
    : planCheckpoints({ asOfISO: asOf, toISO, requested });
  const dates = plan.dates;

  // ── The stated assumptions, normalised ─────────────────────────────────────
  // ⚠️ THE SPENDING LEVEL THIS SCENARIO RUNS AT, RESOLVED BEFORE THE RULES THAT
  // MAY DEPEND ON IT. "Keep six months of expenses" multiplies this figure, so
  // the floor and the spending in force are one number by construction.
  const observedDaily = endpoint.observedSpending?.dailyRate ?? null;
  const monthlySpending: ScenarioSetup['monthlySpending'] =
    typeof a.assumedMonthlySpending === 'number'
      ? { amount: a.assumedMonthlySpending, source: 'USER_STATED' }
      : observedDaily !== null
        ? { amount: round2(observedDaily * DAYS_PER_MONTH), source: 'OBSERVED' }
        : { amount: null, source: 'NONE' };
  const floorDerivations: FloorDerivation[] = [];

  const flatPct = typeof a.annualReturnPct === 'number' ? a.annualReturnPct : 0;
  const statedReturns = ((a.returns as Record<string, unknown>[]) ?? [])
    .filter((r) => declared('returns', `return ${String(r.annualPct)}% ${String(r.from)}..${String(r.to)}`)(r));
  // ⚠️ ONE SOURCE OF RETURNS, NOT TWO BLENDED. Per-period rates are the whole
  // truth when given; a flat rate filling their gaps would apply a number the
  // user only meant for the years they named.
  const returns: ReturnPeriod[] = statedReturns.length > 0
    ? statedReturns.map((r) => ({ fromISO: String(r.from), toISO: String(r.to),
        annualPct: Number(r.annualPct) }))
    : flatPct === 0 ? []
    : [{ fromISO: asOf, toISO, annualPct: flatPct }];

  const contribSpecs: ContributionSpec[] = [];
  for (const raw of (a.contributions as Record<string, unknown>[]) ?? []) {
    // ⚠️ THE NAME IS CODE'S, NEVER THE CALLER'S SENTENCE (G5). A rule's `label` was
    // free text that rode into every settled movement and into the envelope, and
    // it said "after keeping 6 months of expenses" over a surplus share that kept
    // nothing. The name is now derived from the basis that sized the rule; only a
    // fixed amount keeps its caller's name, quoted and bounded (`scenario-rules`).
    const name = contributionName(raw);
    // ⚠️ A CLOSED KEY SET. A key the contract does not define is a clause it cannot
    // represent; running the rest of the rule without it would be the silent
    // approximation the evidence rule forbids, so the rule is refused by name.
    const unknown = unknownContributionKeys(raw);
    if (unknown.length > 0) {
      rejected.push({ input: name,
        reason: `the contribution carries ${unknown.map((k) => `\`${k}\``).join(', ')}, which is not a `
          + 'field of this contract, so that condition cannot be applied and the rule was NOT run '
          + 'without it. Express it with the fields that exist, or tell the user it cannot be modelled.' });
      continue;
    }
    // ⚠️ M1 — "N MONTHS OF EXPENSES" BECOMES THE FLOOR LITERAL HERE, NOT IN THE
    // MODEL AND NOT IN THE LEDGER. The threshold is resolved through the canonical
    // expense-baseline authority from the scenario's own spending level, and the
    // dollar amount then feeds the EXISTING `liquidFloor` rule unchanged — the
    // ledger never learns the floor was derived. Its identity travels beside it
    // (`floorDerivations` → `floorRule.derivedFrom`) so the answer can say "six
    // months of expenses", and a later "make it nine" re-runs the same sentence.
    let c = raw;
    if (raw.liquidFloorMonthsOfExpenses !== undefined) {
      const what = name;
      if (raw.liquidFloor !== undefined) {
        rejected.push({ input: what, reason: 'state the floor ONCE: `liquidFloor` in dollars or '
          + '`liquidFloorMonthsOfExpenses` in months, not both' });
        continue;
      }
      const floor = resolveMonthsOfExpensesFloor({
        monthsOfExpenses: Number(raw.liquidFloorMonthsOfExpenses),
        stated: monthlySpending.source === 'USER_STATED' ? monthlySpending.amount : null,
        observedMonthly: monthlySpending.source === 'OBSERVED' ? monthlySpending.amount : null,
      });
      if ('unavailable' in floor) { rejected.push({ input: what, reason: floor.unavailable }); continue; }
      floorDerivations.push(floor);
      const { liquidFloorMonthsOfExpenses: _months, ...rest } = raw;
      void _months;
      // FM-AUDIT-011 — the literal travels WITH its dependency, so a run at another
      // spending level re-resolves it instead of keeping this one.
      c = { ...rest, liquidFloor: floor.liquidFloor, floorMonthsOfExpenses: floor.derivedFrom.monthsOfExpenses };
    }
    const label = name;
    // How much: a dollar amount, or a share of the balance. The ledger refuses
    // both and neither; this only passes through what was said.
    // ⚠️ EVERY BASIS THE MODEL STATED TRAVELS, so a rule naming two of them is
    // refused by the ledger — the one authority on that — rather than trimmed to
    // one of them here. The floor pair rides along for the same reason.
    // ⚠️ WHERE THE MONEY GOES, NORMALISED ONCE. The model states a target as a
    // word (`investments`, `highest_apr`) or a liability id, singly or as an
    // ordered list; the ledger takes `{ liability: id }` objects. Anything else
    // is passed through so the ledger refuses it by name.
    const toTarget = (t: unknown): AllocationTarget => {
      if (isAllocationTargetWord(t)) return t;
      if (typeof t === 'string') return { liability: t };
      if (t && typeof t === 'object' && typeof (t as { liability?: unknown }).liability === 'string') {
        return { liability: (t as { liability: string }).liability };
      }
      return t as AllocationTarget;
    };
    const target = c.target === undefined ? {}
      : { target: Array.isArray(c.target) ? c.target.map(toTarget) : toTarget(c.target) };
    const size = {
      ...target,
      ...(c.amount !== undefined ? { amount: Number(c.amount) } : {}),
      ...(c.fractionOfLiquid !== undefined
        ? { fractionOfLiquid: Number(c.fractionOfLiquid) } : {}),
      ...(c.liquidFloor !== undefined ? { liquidFloor: Number(c.liquidFloor) } : {}),
      ...(c.fractionOfExcess !== undefined
        ? { fractionOfExcess: Number(c.fractionOfExcess) } : {}),
    };
    // ⚠️ A SURPLUS SHARE IS ITS OWN SHAPE, NOT A SIZE ON A SCHEDULE. It carries
    // no cadence and no single date; the ledger generates its month-ends. Anything
    // else stated alongside it is passed through untouched so that a rule naming
    // two bases is REJECTED by the one authority that decides that, rather than
    // silently resolved into one of them here.
    if (c.surplusFraction !== undefined) {
      contribSpecs.push({ surplusFraction: Number(c.surplusFraction), ...size,
        ...(c.onDate ? { onDate: String(c.onDate) } : {}),
        ...(c.from ? { from: String(c.from) } : {}),
        ...(c.to ? { to: String(c.to) } : {}),
        ...(c.cadence ? { cadence: String(c.cadence) === 'yearly' ? 'yearly' : 'monthly' } : {}),
        ...(label ? { label } : {}) } as unknown as ContributionSpec);
      continue;
    }
    // ⚠️ A FLOOR RULE IS ITS OWN SHAPE TOO: a balance read at every month-end,
    // no cadence, no single date. `from`/`to` only trim the window.
    if (c.liquidFloor !== undefined || c.fractionOfExcess !== undefined) {
      contribSpecs.push({ ...size,
        ...(c.from ? { from: String(c.from) } : {}),
        ...(c.to ? { to: String(c.to) } : {}),
        // FM-AUDIT-011 — the derived floor's dependency MUST survive this rebuild,
        // or `run()` has nothing to re-resolve (the composition contract caught
        // exactly that: a solved spending cut still echoed the uncut floor).
        ...(typeof c.floorMonthsOfExpenses === 'number' ? { floorMonthsOfExpenses: c.floorMonthsOfExpenses } : {}),
        ...(label ? { label } : {}) } as unknown as ContributionSpec);
      continue;
    }
    if (c.onDate) {
      contribSpecs.push({ onDate: String(c.onDate), ...size, ...(label ? { label } : {}) });
    } else if (c.from && c.cadence) {
      contribSpecs.push({ from: String(c.from), ...size,
        cadence: String(c.cadence) === 'yearly' ? 'yearly' : 'monthly',
        ...(c.to ? { to: String(c.to) } : {}), ...(label ? { label } : {}) });
    } else {
      rejected.push({ input: label ?? 'a contribution',
        reason: 'needs either `onDate`, or `from` together with `cadence`' });
    }
  }
  const expanded = expandContributions(contribSpecs, asOf, toISO);
  rejected.push(...expanded.rejected);

  const outflows: PlannedMovement[] = [];
  for (const o of (a.outflows as Record<string, unknown>[]) ?? []) {
    const amount = Number(o.amount);
    const date   = String(o.onDate);
    // The name is led by what code knows; the caller's words follow, quoted and bounded.
    const label  = outflowName(o);
    if (!declared('outflows', `${label} on ${date}`)(o)) continue;
    if (!Number.isFinite(amount) || amount === 0) {
      rejected.push({ input: `${label} on ${date}`, reason: 'the amount is zero or not a number' });
    } else if (date < asOf || date > toISO) {
      rejected.push({ input: `${label} on ${date}`,
        reason: `outside the projection window (${asOf}..${toISO})` });
    } else {
      outflows.push({ date, amount, label });
    }
  }

  // ⚠️ WHAT IS NOT CASH, NOT AN INVESTMENT AND NOT A DEBT STILL COUNTS. On this
  // Space the residual is a rounding cent; on a Space with a house it is the
  // house, and a five-year net-worth table that quietly dropped it would be
  // wrong by six figures while looking perfectly consistent.
  const otherAssets = round2(
    (accounts.totalAssets ?? 0) - (accounts.totalLiquid ?? 0) - composition.combined);
  // ── The liabilities the ledger moves ───────────────────────────────────────
  //
  // ⚠️ ONE LINE PER FULL-VISIBILITY DEBT ACCOUNT, FROM THE SAME PAYLOAD THE
  // POSITION IS READ FROM. The balance is `amountOwed` (a card in credit opens
  // at 0), the terms are the assembler's effective terms — DebtProfile over the
  // flat column, resolved once in `lib/debt/effective-terms.ts` — and nothing is
  // estimated. A withheld account is not a line: it stays inside the aggregate
  // the ledger holds flat, so it counts without being named.
  //
  // ⚠️ A STATED ASSUMPTION OVERRIDES A TERM FOR THIS SCENARIO ONLY. The account
  // is not touched; the line says the term was USER_ASSUMED; an id that is not
  // a liability the viewer can see is refused by name.
  const liabilities: LiabilityLine[] = [];
  const rows = Array.isArray((accounts as { accounts?: unknown }).accounts)
    ? (accounts as { accounts: AccountSummaryItem[] }).accounts : [];
  for (const r of rows) {
    if (r.type !== 'debt' || r.visibilityLevel !== 'FULL') continue;
    const reporting = r.reportingBalance;
    const balance = typeof reporting === 'number' ? Math.max(0, reporting)
      : typeof r.amountOwed === 'number' ? r.amountOwed : Math.max(0, r.balance);
    const apr = typeof r.apr === 'number' ? r.apr : null;
    const minimumPayment = typeof r.minimumPayment === 'number' ? r.minimumPayment : null;
    liabilities.push({ id: r.id, label: r.name, balance: round2(balance), apr, minimumPayment,
      subtype: (r as { debtSubtype?: string | null }).debtSubtype ?? null,
      termsProvenance: { apr: apr === null ? 'UNKNOWN' : 'STATED',
        minimumPayment: minimumPayment === null ? 'UNKNOWN' : 'STATED' } });
  }
  for (const la of (a.liabilityAssumptions as Record<string, unknown>[]) ?? []) {
    const id = String(la.liabilityId ?? la.id ?? '');
    if (!declared('liabilityAssumptions', `liability assumption for ${id || '(no id)'}`, ['id'])(la)) continue;
    const line = liabilities.find((l) => l.id === id);
    if (!line) {
      rejected.push({ input: `liability assumption for ${id || '(no id)'}`,
        reason: 'no liability with that id is in this position; use an id from get_financial_snapshot' });
      continue;
    }
    if (la.apr !== undefined) {
      const apr = Number(la.apr);
      if (!Number.isFinite(apr) || apr < 0 || apr > 100) {
        rejected.push({ input: `assumed APR for ${line.label}`, reason: 'an APR is a percentage between 0 and 100' });
      } else { line.apr = apr; line.termsProvenance!.apr = 'USER_ASSUMED'; }
    }
    if (la.minimumPayment !== undefined) {
      const min = Number(la.minimumPayment);
      if (!Number.isFinite(min) || min < 0) {
        rejected.push({ input: `assumed minimum for ${line.label}`, reason: 'a minimum payment is zero or more' });
      } else { line.minimumPayment = min; line.termsProvenance!.minimumPayment = 'USER_ASSUMED'; }
    }
  }

  const opening = { asOfISO: asOf, liquid: openingLiquid, investments: composition.combined,
    debt: accounts.totalLiabilities ?? 0, otherAssets, liabilities };

  const checkpointDates = new Set(dates);
  // ⚠️ THE SPINE IS MEMOISED PER SPENDING LEVEL, WHICH IS WHAT MAKES A SOLVE
  // CHEAP. Varying a return or a contribution changes nothing about projected
  // cash, so eighty bisection steps re-use one set of runs; only a spending cut
  // pays for a rebuild, and even then `assembleForecast` is pure.
  const spineCache = new Map<string, SpinePoint[]>();
  const spineFor = (shareDates: string[], monthlySpending?: number): SpinePoint[] => {
    const key = `${monthlySpending ?? 'base'}|${shareDates.join(',')}`;
    const hit = spineCache.get(key);
    if (hit) return hit;
    const allDates = [...new Set([...dates, ...shareDates])].sort();
    const override = monthlySpending === undefined ? undefined : { monthly: monthlySpending };
    const points = allDates.map((date) => ({
      date, liquid: runTo(date, override).projection?.closing ?? null,
      isCheckpoint: checkpointDates.has(date),
    }));
    spineCache.set(key, points);
    return points;
  };

  return {
    asOf, toISO, plan, dates, accounts, returns, liabilities,
    contributions: expanded.movements, outflows, rejected, monthlySpending, floorDerivations,
    ...(endpoint.incomeChanges ? { incomeChanges: endpoint.incomeChanges } : {}),
    ...(staged ? { staged } : {}),
    argumentsRun: a,
    run: (o: ScenarioOverrides = {}): ScenarioRun => {
      // ⚠️ FM-AUDIT-011 — A DERIVED VALUE RECOMPUTES WHEN ITS DEPENDENCY CHANGES.
      // A floor stated as "N months of expenses" was resolved above from the BASE
      // spending level. A run at a different level (a goal-seek spending cut; S1's
      // spending transforms next) re-resolves every bound floor through the SAME
      // canonical resolver at the level THIS run spends — so "cut $X" never holds
      // six months of the uncut figure in cash. An absolute dollar floor has no
      // binding and is never touched.
      const rebound = rebindDerivedFloors(expanded.movements, o.monthlySpending, monthlySpending, floorDerivations);
      if ('unavailable' in rebound) {
        throw new Error(`a derived floor could not be re-resolved at ${o.monthlySpending}/month: ${rebound.unavailable}`);
      }
      const useContribs = o.extraContributions
        ? [...rebound.movements, ...o.extraContributions] : rebound.movements;
      // ⚠️ SHARE-BASED CONTRIBUTIONS NEED THE PROJECTION ON THEIR OWN DATE. "Half
      // my liquidity every June" falls nowhere near a year end, and half of a
      // balance the ledger cannot see is not something to guess at. Those dates
      // are evaluated too and marked as not being rows in the table.
      // ⚠️ A SURPLUS SHARE NEEDS BOTH ENDS OF ITS MONTH. The contribution date
      // closes the month and `baseDate` opens it; a month whose opening balance
      // the spine cannot show is a month whose surplus cannot be stated, and the
      // settler refuses it rather than inferring a neighbour from whatever else
      // happens to be in the spine.
      // ⚠️ A LIABILITY MOVES MONTHLY WHATEVER THE TABLE'S CADENCE. Interest and
      // minimums settle on spine dates, so a yearly table over an owed balance
      // still evaluates every month-end — otherwise the same scenario would
      // accrue differently depending on how often it was asked to print a row.
      const shareDates = [
        ...useContribs
          .filter((m) => m.fractionOfLiquid !== undefined || m.surplusFraction !== undefined
            || m.liquidFloor !== undefined)
          .flatMap((m) => (m.baseDate ? [m.baseDate, m.date] : [m.date])),
        ...(liabilities.some((l) => l.balance > 0) ? monthEndsBetween(asOf, toISO) : []),
      ].sort();
      return {
        ...runScenarioLedger({
          opening,
          spine: spineFor(shareDates, o.monthlySpending),
          contributions: useContribs,
          outflows,
          returns: o.returns ?? returns,
        }),
        floorDerivations: rebound.derivations,
      };
    },
  };
}

/**
 * FM-AUDIT-011 — re-resolve every DERIVED floor (a movement carrying
 * `floorMonthsOfExpenses`) at the spending level a run uses. At the base level
 * (no override, or the same figure) nothing changes. Otherwise each bound floor
 * is resolved again through `resolveMonthsOfExpensesFloor` with the transformed
 * level on the SAME rung the base came from (stated or observed), and the
 * derivation says so. Pure; the input movements are never mutated.
 */
export function rebindDerivedFloors(
  movements: readonly PlannedMovement[],
  runMonthlySpending: number | undefined,
  base: { amount: number | null; source: string },
  baseDerivations: FloorDerivation[],
): { movements: PlannedMovement[]; derivations: FloorDerivation[] } | { unavailable: string } {
  if (runMonthlySpending === undefined || runMonthlySpending === base.amount) {
    return { movements: [...movements], derivations: baseDerivations };
  }
  const byMonths = new Map<number, FloorDerivation>();
  for (const n of new Set(movements.map((m) => m.floorMonthsOfExpenses).filter((x): x is number => x !== undefined))) {
    if (runMonthlySpending <= 0) {
      // N months of NOTHING is a zero floor — arithmetic, not a baseline (the
      // canonical resolver refuses a non-positive baseline, which is right for a
      // baseline and wrong here: a solve's bracket reaches "cut everything").
      const was = baseDerivations.find((b) => b.derivedFrom.monthsOfExpenses === n);
      if (!was) return { unavailable: `no base derivation for ${n} months of expenses` };
      byMonths.set(n, { liquidFloor: 0, derivedFrom: { ...was.derivedFrom, rule: `${n} × 0`,
        baseline: { ...was.derivedFrom.baseline, amount: 0,
          note: 'this run spends nothing, so N months of expenses is zero' } } });
      continue;
    }
    const d = resolveMonthsOfExpensesFloor({
      monthsOfExpenses: n,
      stated: base.source === 'USER_STATED' ? runMonthlySpending : null,
      observedMonthly: base.source === 'USER_STATED' ? null : runMonthlySpending,
    });
    if ('unavailable' in d) return d;
    byMonths.set(n, { ...d, derivedFrom: { ...d.derivedFrom, baseline: { ...d.derivedFrom.baseline,
      note: `${d.derivedFrom.baseline.note} — re-resolved at the ${round2(runMonthlySpending)}/month this run `
        + `spends (the scenario's ${base.source === 'USER_STATED' ? 'stated' : 'observed'} level after its transformation)` } } });
  }
  if (byMonths.size === 0) return { movements: [...movements], derivations: baseDerivations };
  return {
    movements: movements.map((m) => (m.floorMonthsOfExpenses === undefined ? m
      : { ...m, liquidFloor: byMonths.get(m.floorMonthsOfExpenses)!.liquidFloor })),
    derivations: [...byMonths.values()],
  };
}

/**
 * What was actually in force, echoed back.
 *
 * ⚠️ IT TRAVELS ON EVERY PATH, INCLUDING A REFUSAL, and the first live run is
 * why. Asked "how could I reach $1M?", the model called the goal seek with a bare
 * target — no return, no contributions — got an honest "not reachable", and then
 * described the answer as *"investing half your liquidity each year at 8%"*,
 * because that is what the conversation had said two turns earlier. The figure
 * was right and the sentence around it was not. A refusal that echoes nothing
 * invites the model to supply the frame from memory; a refusal that names its own
 * assumptions does not.
 */
/**
 * The surplus share in force, as the rule it is.
 *
 * ⚠️ IT IS READ BACK OFF THE SETTLED MOVEMENTS, not carried alongside them, so
 * what is echoed is what was actually applied. A scenario cannot claim a share it
 * did not run.
 */
function surplusRule(ledger: LedgerResult) {
  const taken = ledger.movements.filter(
    (m) => m.kind === 'CONTRIBUTION' && m.surplusFraction !== undefined);
  if (taken.length === 0) return null;
  const fractions = [...new Set(taken.map((m) => m.surplusFraction as number))];
  const funded = taken.filter((m) => m.amount > 0);
  return {
    surplusFraction: fractions.length === 1 ? fractions[0] : fractions,
    from: taken[0].date, to: taken[taken.length - 1].date,
    months: taken.length,
    monthsWithNoSurplus: taken.length - funded.length,
    contributed: round2(taken.reduce((s, m) => s + m.amount, 0)),
    meaning: 'A share of the cash each month is projected to ADD, taken at month-end. The '
      + 'balance already held is never touched, and a month projecting no gain contributes '
      + 'nothing. At a 0% return this moves money between lines and changes net worth by '
      + 'nothing at all.',
  };
}

/**
 * The liquid floor in force, as the rule it is — read back off the settled
 * movements like `surplusRule`, so what is echoed is what was applied.
 *
 * ⚠️ IT SAYS WHEN THE FLOOR WAS FIRST REACHED AND HOW OFTEN IT WAS NOT HELD.
 * "Keep $50k" is one sentence; the projection may sit under $50k for months
 * before it gets there and may fall under it again in a bad month. A reader
 * told only "the rule was in force" would narrate a floor that was maintained
 * throughout, which the arithmetic did not do.
 */
function floorRule(ledger: LedgerResult, derivations: FloorDerivation[] = []) {
  const taken = ledger.movements.filter(
    (m) => m.kind === 'CONTRIBUTION' && m.liquidFloor !== undefined);
  if (taken.length === 0) return null;
  const floors = [...new Set(taken.map((m) => m.liquidFloor as number))];
  const shares = [...new Set(taken.map((m) => m.fractionOfExcess as number))];
  const isAbove = (m: typeof taken[number]) => (m.availableBefore ?? 0) > (m.liquidFloor as number);
  const firstAbove = taken.findIndex(isAbove);
  // ⚠️ TWO DIFFERENT KINDS OF "UNDER THE FLOOR", COUNTED APART. The months before
  // the balance first reaches the line are the run-up the user asked for; the
  // months under it AFTER that are the ones where ordinary cash activity undid
  // the floor and the rule sat out. Only the second is a fact a reader needs
  // before saying the floor was kept.
  const afterReached = firstAbove === -1 ? [] : taken.slice(firstAbove);
  const derived = derivations.filter((d) => floors.includes(d.liquidFloor)).map((d) => d.derivedFrom);
  return {
    liquidFloor: floors.length === 1 ? floors[0] : floors,
    // ⚠️ M1 — THE FLOOR KEEPS ITS IDENTITY. When the dollars came from "N months of
    // expenses", the rule and the baseline it multiplied are echoed beside them:
    // say "six months of expenses ($X at $Y/month)", not only the dollar figure.
    ...(derived.length ? { derivedFrom: derived.length === 1 ? derived[0] : derived } : {}),
    fractionOfExcess: shares.length === 1 ? shares[0] : shares,
    from: taken[0].date, to: taken[taken.length - 1].date,
    months: taken.length,
    alreadyAboveFloorAtStart: floors.length === 1 && ledger.opening.liquid > floors[0],
    firstMonthEndAtOrAboveFloor: firstAbove === -1 ? null : taken[firstAbove].date,
    monthsBeforeFloorReached: firstAbove === -1 ? taken.length : firstAbove,
    monthsBelowFloor: afterReached.filter((m) => !isAbove(m)).length,
    contributed: round2(taken.reduce((s, m) => s + m.amount, 0)),
    meaning: 'At each month-end, the share of cash held ABOVE the floor is moved into '
      + 'investments; cash is left at the floor. Nothing moves until the balance first '
      + 'reaches the floor (`firstMonthEndAtOrAboveFloor`). The rule itself never takes cash '
      + 'below the floor, but ordinary spending or a stated outflow can; `monthsBelowFloor` '
      + 'counts the month-ends AFTER the floor was first reached where the balance was under '
      + 'it — in those months the rule moves nothing and sells nothing, and the floor was not '
      + 'held. At a 0% return this moves money between lines and changes net worth by nothing '
      + 'at all.',
  };
}

/**
 * Which staged clauses this run can be SHOWN to have applied.
 *
 * ⚠️ REVIEW BLOCKER 2. The first version listed every merged clause as applied and
 * the turn then consumed them — while `notApplied` in the SAME result named one as
 * refused. A staged STOP on an unknown source was "applied, describe it as the
 * user's stated condition", refused, consumed, and dropped from the envelope: it
 * then existed nowhere. A clause is now confirmed only when nothing refused it:
 * exactly, for an income rule (refusals name it by position) and for a wholly
 * refused argument; conservatively otherwise — when this run refused something it
 * cannot attribute, the staged clauses of the other arguments are reported NOT
 * CONFIRMED and are kept for the next run rather than consumed on a guess.
 */
function stagedEcho(setup: ScenarioSetup, rejected: readonly { input: string; argument?: string }[]) {
  const staged = setup.staged!;
  const run = setup.argumentsRun;
  const incomeIdx = (v: unknown) =>
    (Array.isArray(run.incomeChanges) ? run.incomeChanges : []).indexOf(v) + 1;
  const refusedIncome = new Set(rejected.map((r) => /`incomeChanges` rule i(\d+)/.exec(r.input)?.[1])
    .filter((n): n is string => !!n).map(Number));
  const wholeArgs = new Set(rejected.map((r) => r.argument).filter((a): a is string => !!a));
  const unattributed = rejected.some((r) => !r.argument && !/`incomeChanges`/.test(r.input));
  const confirmed: typeof staged.applied = [];
  const unconfirmed: typeof staged.applied = [];
  for (const c of staged.applied) {
    const refused = wholeArgs.has(c.key)
      || (c.key === 'incomeChanges' ? refusedIncome.has(incomeIdx(c.value))
        : c.key === 'annualReturnPct' ? Array.isArray(run.returns) && run.returns.length > 0
          : c.key === 'assumedMonthlySpending' ? false : unattributed);
    (refused ? unconfirmed : confirmed).push(c);
  }
  return {
    clauses: confirmed.map((x) => ({ id: x.id, argument: x.key, statedInTurn: x.stagedAt + 1 })),
    ...(unconfirmed.length ? { notConfirmed: {
      clauses: unconfirmed.map((x) => ({ id: x.id, argument: x.key })),
      meaning: 'These staged conditions were sent to this run but it refused something in them (see '
        + '`notApplied`), so they are NOT shown to have applied. They are still held; do not describe '
        + 'them as included.',
    } } : {}),
    ...(staged.supersededByCall.length ? { supersededByThisCall: {
      clauses: staged.supersededByCall,
      meaning: 'This call restated these rules (or another rule about the same thing), so the call\'s '
        + 'version ran and the staged one did not.',
    } } : {}),
    meaning: '`clauses` were stated earlier in this conversation and applied to this run alongside the '
      + 'arguments of this call. Describe them as the user\'s stated conditions.',
  };
}

function scenarioAssumptions(
  setup: ScenarioSetup, ledger: LedgerResult, returns: ReturnPeriod[],
) {
  const kind = (k: 'CONTRIBUTION' | 'OUTFLOW') => ledger.movements.filter((m) => m.kind === k);
  return {
    // ⚠️ THE HORIZON IS AN ASSUMPTION, AND IT IS ECHOED WITH THE OTHERS. A solve
    // to mid-2030 and a projection to end-2029 were narrated as the same scenario
    // at different rates; every scenario tool now states the date its ledger ran
    // to in the same field, so a later turn cannot inherit one and quote the other.
    horizon: { to: setup.toISO },
    // ⚠️ EVERY CLAUSE KIND, RAN OR NOT (G5). `surplusRule` and `floorRule` below
    // describe a rule that ran; neither can say the OTHER did not. This is the
    // closed roster — a floor that was dropped on the way into the arguments is
    // reported here as `cashFloor.ran: false`, with the lowest cash the scenario
    // reached, in the same turn the model is about to narrate it.
    clauses: clausesInForce(ledger,
      floorDerivationsOf(setup, ledger).map((d) => ({ liquidFloor: d.liquidFloor, derivedFrom: d.derivedFrom })),
      // I1 — the SPINE's own record, not `a.incomeChanges`. See `clausesInForce`.
      setup.incomeChanges?.executions ?? []),
    returns: returns.length === 0
      ? { statedRate: null,
          note: 'No return was in force. Investments are held flat at 0% — do not substitute '
            + 'a market average, and do not describe this result as carrying a return.' }
      : returns.map((r) => ({ from: r.fromISO, to: r.toISO, annualPct: r.annualPct,
          provenance: PROVENANCE.USER_ASSUMED })),
    // ⚠️ WHAT THE SHARE ACTUALLY CAME TO, EVERY TIME. "Half my liquidity" is the
    // instruction; the dollar figures are the answer, they differ at every date,
    // and only the settled ones can be checked against the table.
    contributions: {
      scheduled: kind('CONTRIBUTION').length,
      total: round2(kind('CONTRIBUTION').reduce((s, m) => s + m.amount, 0)),
      settled: kind('CONTRIBUTION').slice(0, 12),
      provenance: PROVENANCE.USER_ASSUMED,
      // ⚠️ THE RULE, NOT ONLY ITS ARTIFACTS. "75% of each month's surplus" is one
      // sentence that expands into a hundred and thirty-five dated amounts; a
      // later turn saying "make it 8%" has to inherit the SENTENCE, and a
      // scenario state carrying only the amounts would inherit an accident of
      // one horizon. `settled` above stays the evidence; this is the assumption.
      ...(surplusRule(ledger) ? { surplusRule: surplusRule(ledger) } : {}),
      ...(floorRule(ledger, floorDerivationsOf(setup, ledger))
        ? { floorRule: floorRule(ledger, floorDerivationsOf(setup, ledger)) } : {}),
      ...(kind('CONTRIBUTION').length === 0
        ? { note: 'No contributions were in force. Do not describe this result as including '
            + 'any.' } : {}),
    },
    outflows: { count: kind('OUTFLOW').length, settled: kind('OUTFLOW').slice(0, 12),
      provenance: PROVENANCE.USER_ASSUMED },
    spending: { source: setup.monthlySpending.source, monthly: setup.monthlySpending.amount,
      ...(setup.monthlySpending.source === 'OBSERVED'
        ? { note: 'from the same observed rate project_cash uses' } : {}) },
    ...(ledger.liabilities ? { liabilities: liabilityEcho(ledger) } : {}),
    // ⚠️ WHAT RAN BECAUSE IT WAS STAGED, SAID CLAUSE BY CLAUSE (planning
    // continuity). A condition the user stated in an earlier turn and this run
    // applied is named as such — never as something this call said — and a call
    // item a newer staged restatement replaced is named too, so "pending wins" is
    // never silent. `argumentsRun` is what executed; the envelope keeps THAT.
    ...(setup.staged ? { fromEarlierInConversation: stagedEcho(setup, [...setup.rejected, ...ledger.rejected]) } : {}),
    argumentsRun: setup.argumentsRun,
    // ⚠️ WHAT WAS STATED AND NOT APPLIED, IN THE SAME ECHO — see `notAppliedEcho`.
    ...(notAppliedEcho([...setup.rejected, ...ledger.rejected])
      ? { notApplied: notAppliedEcho([...setup.rejected, ...ledger.rejected]) } : {}),
  };
}

/**
 * The liabilities in force, as the ledger moved them.
 *
 * ⚠️ `interestBasis` IS THE FIELD A PAYOFF DATE MUST BE READ WITH. PARTIAL means
 * at least one owed line has no rate, nothing accrued on it, and any payoff
 * date is a payments-only lower bound; the unmodelled lines are named so the
 * answer can say which. A user-assumed rate is echoed as USER_ASSUMED so a term
 * the user supplied is never presented as the issuer's.
 */
function liabilityEcho(ledger: LedgerResult) {
  const L = ledger.liabilities!;
  const last = ledger.checkpoints[ledger.checkpoints.length - 1];
  const paid = ledger.movements.filter((m) => m.kind === 'CONTRIBUTION' && m.placed && m.placed.liabilities.length > 0);
  const targetsUsed = [...new Set(ledger.movements
    .filter((m) => m.kind === 'CONTRIBUTION' && m.placed)
    .flatMap((m) => m.placed!.liabilities.map((l) => l.id)))];
  return {
    lines: L.lines.map((l) => ({ id: l.id, label: l.label, openingBalance: l.balance,
      apr: l.apr, minimumPayment: l.minimumPayment, subtype: l.subtype ?? null,
      terms: l.termsProvenance ?? null })),
    interestBasis: L.interestBasis,
    unmodelled: L.unmodelled,
    withheldAggregate: L.withheldAggregate,
    totals: last ? { interestToDate: last.movements.interestToDate,
      minimumPaymentsToDate: last.movements.minimumPaymentsToDate,
      extraPaymentsToDate: round2(paid.reduce((s, m) => s + m.placed!.liabilities.reduce((t, l) => t + l.amount, 0), 0)),
      closingDebt: last.debt.amount } : null,
    allocationsToLiabilities: { rules: paid.length, liabilitiesPaid: targetsUsed },
    meaning: L.interestBasis === 'PARTIAL' || L.interestBasis === 'NONE'
      ? 'Interest is NOT modelled on the unmodelled liabilities — no rate is known for them. '
        + 'Any balance or payoff date over them is a payments-only lower bound: with a positive '
        + 'rate the balance would be higher and payoff later. Say so; do not call it exact. '
        + 'The user may state a rate with `liabilityAssumptions`.'
      : L.interestBasis === 'COMPLETE'
        ? 'Every owed liability accrues simple interest at its known rate over actual days on the '
          + 'balance carried into each month-end, before its stated minimum and any allocation.'
        : 'Nothing is owed on the modelled liabilities.',
  };
}

/**
 * How far one ledger position is from the ledger's opening — the ONE call both
 * the projection's horizon and a crossing's position go through.
 *
 * ⚠️ THE BASE IS THE LEDGER'S OPENING, AND WHEN THAT IS NOT THE ACCOUNTS TOTAL
 * THE BLOCK SAYS SO ITSELF. The result tells the model to quote the accounts
 * figure as today's position; "X higher than today" is X above the LEDGER figure.
 * `base` names it on every block, and `baseVsAccounts` appears exactly when the
 * reconciliation warning does, carrying both figures, so the sentence cannot be
 * attached to the wrong "today".
 */
function changeSinceOpeningAt(setup: ScenarioSetup, ledger: LedgerResult, c: LedgerCheckpoint | undefined) {
  const change = c ? positionChange(openingPosition(ledger.opening), checkpointPosition(c)) : null;
  if (!change) return null;
  const difference = round2(ledger.opening.netWorth - (setup.accounts.netWorth ?? 0));
  return Math.abs(difference) > 1
    ? { ...change, baseVsAccounts: { ledgerOpeningNetWorth: ledger.opening.netWorth,
        accountsNetWorth: setup.accounts.netWorth, difference } }
    : change;
}

/**
 * The scenario payload both tools return, so a solved answer and a stated one
 * are read the same way.
 */
function presentScenario(setup: ScenarioSetup, ledger: LedgerResult, returns: ReturnPeriod[]) {
  const difference = round2(ledger.opening.netWorth - (setup.accounts.netWorth ?? 0));
  const warnings = [...ledger.warnings];
  if (Math.abs(difference) > 1) {
    warnings.push('The ledger\'s opening net worth differs from the accounts total by '
      + `${difference.toFixed(2)}; state the accounts figure, not this one, as today's position.`);
  }
  return {
    asOf: setup.asOf,
    // ⚠️ WHAT THE TABLE HAS ROWS FOR, AND WHAT IT DOES NOT. `granularity` is the
    // cadence actually returned; `requested` appears when it differs from what
    // was asked; `omitted` names the dates that have no row. A model reading
    // this can tell a missing date from a date it forgot to look at — the hole
    // it once filled with invented rows is now a field.
    horizon: { to: setup.toISO, ...describePlan(setup.plan) },
    // ⚠️ THE LEDGER'S OPENING RECONCILED AGAINST THE ACCOUNTS AUTHORITY, out
    // loud. Two net-worth figures for today in one answer is exactly the class
    // of contradiction this whole slice exists to stop.
    reconciliation: {
      accountsNetWorth: setup.accounts.netWorth,
      ledgerOpeningNetWorth: ledger.opening.netWorth,
      difference,
    },
    assumptions: scenarioAssumptions(setup, ledger, returns),
    opening: ledger.opening,
    // ⚠️ THE DIFFERENCE IS A FIELD, NOT A SUBTRACTION LEFT TO THE READER. "About
    // $65k higher by next June" was the projected net worth minus the opening one,
    // composed in prose in 4 of 8 runs because the payload stated both levels and
    // never the movement. Stated ONCE, for the horizon — the date the caller named
    // — with its operands, `abs`, `pct`, its `base`, and what the sign of `debt`
    // means. NOT on every row: that was ~100 B a row for an unmeasured benefit, and
    // `checkpoints` below is the ledger's own array, untouched.
    changeSinceOpening: changeSinceOpeningAt(setup, ledger, ledger.checkpoints[ledger.checkpoints.length - 1]),
    checkpoints: ledger.checkpoints,
    // ⚠️ BOUNDED. A thirty-year rule settles 361 dated amounts and the result was
    // repeating every one beside a table whose rows already carry the same money.
    movements: compactMovements(ledger.movements),
    rejected: [...setup.rejected, ...ledger.rejected],
    warnings,
    basis: ledger.basis,
    // ⚠️ SAID ONCE, PLAINLY, WHERE THE MODEL WILL READ IT. Every earlier
    // version of this answer was composed in prose, and the assumption that a
    // stated return was a forecast is the failure that follows.
    qualification: SCENARIO_QUALIFICATION,
  };
}

/**
 * ⚠️ SAID ONCE, PLAINLY, WHERE THE MODEL WILL READ IT. Every earlier version of
 * this answer was composed in prose, and the assumption that a stated return was
 * a forecast is the failure that follows.
 */
const SCENARIO_QUALIFICATION =
  'The cash line is an evidence-based projection; the returns and contributions are '
  + 'the user\'s own assumptions and nothing here predicts a market. Present the '
  + 'result as "if these assumptions hold", and never as an expectation.';

/**
 * ⚠️ ONE SENTENCE, ONE DEFINITION, TWO TOOLS. A recomputation rule stated twice
 * in slightly different words is two rules, and the one a model happens to read
 * is the one that applies. It is deliberately about ANY assumption rather than
 * about income: the failure it addresses ("make it nine months", "what about next
 * June?") predates I1 and is not about income at all.
 *
 * ⚠️ WHY A TOOL DESCRIPTION AND NOT THE SYSTEM INSTRUCTION. Post-M1 dogfood
 * measured a changed assumption recomputed 2/6 and a new horizon 2/6. Nothing in
 * the runtime detects that a user changed an assumption — the scenario slot is
 * written only by a tool EXECUTION — and nothing inspects the reply, so the choice
 * is the model's. In the same matrix the one tool carrying an explicit re-call
 * sentence (`get_baselines`) scored 5/6. The system instruction had six words of
 * headroom before a pinned 240-word ceiling; the tool contract had room and the
 * precedent.
 */
const RECOMPUTE_SENTENCE =
  'Call it AGAIN whenever the user changes ANY assumption or the horizon — a rate, a '
  + 'contribution, a floor, a raise, a date. Every figure in the result changes with it, and '
  + 'none of them is to be recomputed in prose: never scale a previous result, add to it, '
  + 'subtract two of them, or read a new date off an old table.';

const scenarioProjection: ToolDefinition = {
  name: 'scenario_projection',
  // ⚠️ IT LED WITH "NET WORTH" AND EXEMPLIFIED ONLY INVESTING, so a question
  // about CASH this year did not look like this tool's job — the one-off
  // capability was four words between two sentences about investment returns.
  // What changed is the framing and the examples, not the arithmetic: this says
  // what the ledger has always done.
  description:
    'Deterministic projection when something specific happens that the observed pattern ' +
    // ⚠️ THE INCOME CLAUSE LEADS, BECAUSE A MODEL CHOOSING A TOOL READS THE FIRST
    // SENTENCE. Measured on the first I1 dogfood: asked "starting January my income
    // increases 10%, what does that do to my cash?", the model called project_cash,
    // then explained in prose that the question needed this tool. It knew; the
    // description did not say so where it was looking. Same lever, same shape, as
    // the one-off boundary that moved 0/5 to 5/5 (7859d6c).
    'does not contain: a CHANGE TO FUTURE INCOME from a date — a raise, a new salary, an ' +
    'income starting or ending (`incomeChanges`); a dated one-off amount arriving or ' +
    'leaving — a bonus, an ' +
    'inheritance, a car, a tax bill, proceeds from a sale — money moved into investments, ' +
    'and an annual return. Cash comes from the same deterministic projection as ' +
    'project_cash; this adds only what the user said, and reports cash, investments, debt ' +
    'and net worth at every checkpoint. Do NOT do this arithmetic yourself. ' +
    RECOMPUTE_SENTENCE + ' The default ' +
    'return is 0% — the no-growth baseline, which is not a prediction that markets return ' +
    'nothing. A rate the user did not state may be run as an explicitly labelled ' +
    'illustration; it may never be called expected, likely, or a forecast.',
  parameters: obj({ to: str('YYYY-MM-DD horizon end. Required.'), ...SCENARIO_INPUTS }, ['to']),
  async run(a, ctx) {
    const setup = await prepareScenario(a, ctx, String(a.to), scenarioProjection);
    if ('unavailable' in setup) return setup;
    return presentScenario(setup, setup.run(), setup.returns);
  },
};

// ── 11b. Scenario threshold crossing ─────────────────────────────────────────

/** What each line means to a reader. The values themselves are the ledger's. */
const CROSSING_METRICS: Record<LedgerMetric, string> = {
  netWorth:    'everything owned less everything owed',
  liquid:      'checking + savings',
  investments: 'traditional investments + crypto',
  debt:        'what is owed, as a positive amount',
  otherAssets: 'property and anything else that is not cash, an investment or a debt',
};
const CROSSING_DIRECTIONS: CrossingDirection[] = ['at_or_above', 'at_or_below'];

/**
 * How far forward a search may look when nobody says.
 *
 * ⚠️ A SEARCH NEEDS A WALL, AND THE WALL IS PRODUCT. `scenario_projection` will
 * happily run to 2100 because a caller naming a horizon has said what they mean;
 * a caller asking "when?" has not, and an unbounded forward walk is a loop. Thirty
 * years covers every goal anybody states in a sentence and costs about a third of
 * a second to search.
 */
const CROSSING_DEFAULT_YEARS = 30;
const CROSSING_MAX_YEARS = 30;

const scenarioCrossing: ToolDefinition = {
  name: 'scenario_crossing',
  description:
    'WHEN a scenario first reaches a number: the first future month-end where net worth, cash, '
    + 'investments or debt crosses a threshold, under the same assumptions scenario_projection '
    + 'takes. Use it for "when do I hit a million", "when will I be debt free", "how long until '
    + 'I have X" — anything asking WHEN rather than HOW MUCH. It returns the crossing month, the '
    + 'month before it, and what the position looks like there. Do NOT read a date off a '
    + 'projection table yourself, and do NOT guess a deadline to hand scenario_goal_seek: that '
    + 'tool answers "what would it take by DATE", this one answers "when". '
    + RECOMPUTE_SENTENCE,
  parameters: obj({
    metric: { type: 'string', enum: Object.keys(CROSSING_METRICS),
      description: 'Which line crosses. `liquid` is checking + savings; `debt` is what is owed, '
        + 'as a positive amount.' },
    direction: { type: 'string', enum: CROSSING_DIRECTIONS,
      description: 'at_or_above for reaching a target; at_or_below for falling to one. '
        + '"When is my debt gone" is metric `debt`, at_or_below, threshold 0.' },
    threshold: num('The number to reach, in dollars. Required.'),
    searchThrough: str('YYYY-MM-DD to stop looking. Omit to search '
      + `${CROSSING_DEFAULT_YEARS} years ahead. Use it when the user named a window — `
      + '"do I get there by 2035?" — and the search will not look past it.'),
    ...SCENARIO_INPUTS,
  }, ['metric', 'direction', 'threshold']),
  async run(a, ctx) {
    const metric = a.metric as LedgerMetric;
    const direction = a.direction as CrossingDirection;
    const threshold = Number(a.threshold);
    if (!(metric in CROSSING_METRICS)) {
      return { unavailable: `unknown metric: ${String(a.metric)}`,
        canSearch: Object.keys(CROSSING_METRICS) };
    }
    if (!CROSSING_DIRECTIONS.includes(direction)) {
      return { unavailable: `unknown direction: ${String(a.direction)}`,
        canSearch: CROSSING_DIRECTIONS };
    }
    if (!Number.isFinite(threshold)) {
      return { unavailable: 'the threshold is not a number' };
    }

    // ⚠️ THE CAP IS ABSOLUTE AND THE REQUEST IS NOT EXTENDED PAST IT. A user who
    // said "through 2035" is answered about 2035; silently searching to 2056 and
    // reporting a date they excluded would answer a question they did not ask.
    const capISO = addYearsISO(ctx.asOfISO, CROSSING_MAX_YEARS);
    const asked = (a.searchThrough as string) || addYearsISO(ctx.asOfISO, CROSSING_DEFAULT_YEARS);
    const searchThrough = asked > capISO ? capISO : asked;
    if (searchThrough <= ctx.asOfISO) {
      return { unavailable: `the search window ${searchThrough} is not in the future` };
    }

    // ⚠️ EVERY MONTH-END, IN ORDER, THROUGH ONE LEDGER RUN. Not a bisection: a
    // scenario path is not guaranteed to rise — a one-off outflow, a negative
    // return or a falling month can take a line back down — so a search that
    // assumed monotonicity could report the second crossing as the first, or
    // miss one entirely. Walking the grid is O(months) and costs less than the
    // model reading a table.
    const dates = monthEndsBetween(ctx.asOfISO, searchThrough);
    const setup = await prepareScenario(a, ctx, searchThrough, scenarioCrossing, dates);
    if ('unavailable' in setup) return setup;
    const ledger = setup.run();

    const composition = (c: LedgerCheckpoint) => ({
      liquid: c.liquid?.amount ?? null, investments: c.investments.amount,
      debt: c.debt.amount, otherAssets: c.otherAssets.amount,
      netWorth: c.netWorth?.amount ?? null,
    });
    // ⚠️ BESIDE `composition`, NEVER INSIDE IT. The active-scenario envelope reads
    // its six numbers off `composition`; how far the position is from the opening
    // is a sibling, computed by the same function the projection table uses.
    const changeAt = (c: LedgerCheckpoint) => changeSinceOpeningAt(setup, ledger, c);
    // ⚠️ THE WALK IS PURE AND LIVES NEXT DOOR. Nothing about money is decided
    // here: the ledger produced the path, `findScenarioCrossing` says where the
    // line is first crossed on it, and this only says it in words.
    const found = findScenarioCrossing({ checkpoints: ledger.checkpoints,
      opening: ledger.opening, metric, direction, threshold });

    const head = {
      asOf: setup.asOf, metric, metricMeans: CROSSING_METRICS[metric], direction, threshold,
      searchedThrough: { to: searchThrough, monthsExamined: found.examined,
        grain: 'month-end',
        ...(asked > capISO ? { cappedAt: `${CROSSING_MAX_YEARS} years` } : {}) },
      assumptionsInForce: scenarioAssumptions(setup, ledger, setup.returns),
      rejected: [...setup.rejected, ...ledger.rejected],
      warnings: ledger.warnings,
      basis: ledger.basis,
      qualification: SCENARIO_QUALIFICATION,
    };

    // ⚠️ ALREADY TRUE IS NOT A CROSSING, AND SAYING SO IS THE WHOLE POINT. The
    // goal seek's `alreadyMet` is what produced "the solver says 0% is needed",
    // narrated as though a future event had been found. A position that already
    // satisfies the condition has a date, and it is today.
    if (found.alreadySatisfied) {
      return { ...head, crossing: null,
        alreadySatisfied: { ...found.alreadySatisfied,
          elapsed: elapsedBetween(setup.asOf, found.alreadySatisfied.date) },
        meaning: 'This is already true today. Nothing here is a future event.' };
    }

    if (!found.crossing) {
      return { ...head, crossing: null,
        neverCrossesBy: found.end
          ? { date: found.end.checkpoint.date, value: found.end.value,
              elapsed: elapsedBetween(setup.asOf, found.end.checkpoint.date),
              composition: composition(found.end.checkpoint),
              changeSinceOpening: changeAt(found.end.checkpoint) }
          : null,
        meaning: 'Under these assumptions the condition is not met at any month-end through '
          + `${searchThrough}. That is a statement about this search window, not about ever.` };
    }

    const hit = found.crossing;
    // ⚠️ A PAYOFF OVER AN UNMODELLED RATE IS A LOWER BOUND, AND THE DATE SAYS SO
    // ITSELF. The echo above carries the basis; this puts it beside the number
    // the model is about to quote, so "exact" cannot be read off a field that
    // was never exact.
    const interest = ledger.liabilities && ledger.liabilities.interestBasis !== 'NOT_APPLICABLE'
      ? { basis: ledger.liabilities.interestBasis,
          aprMissingFor: ledger.liabilities.unmodelled.map((u) => u.label),
          reading: ledger.liabilities.interestBasis === 'COMPLETE'
            ? 'interest modelled on every owed liability'
            : 'PAYMENTS-ONLY LOWER BOUND: interest was not modelled on the liabilities named; '
              + 'with a positive rate this crossing would come later (for debt) — say so' }
      : null;
    return {
      ...head,
      crossing: {
        ...(interest ? { interestEvidence: interest } : {}),
        date: hit.checkpoint.date, value: hit.value,
        // ⚠️ HOW FAR AWAY, IN NUMBERS THE ENGINE OWNS. The date was always
        // right; "1.5 years" for a gap of five and a half months was the model
        // subtracting. Measured from the scenario's own asOf.
        elapsed: elapsedBetween(setup.asOf, hit.checkpoint.date),
        // ⚠️ THE MONTH BEFORE IS WHAT MAKES IT A FIRST. Without it a reader
        // cannot tell a crossing from a value that merely happens to be above
        // the line.
        previousCheckpoint: hit.previous
          ? { ...hit.previous, elapsed: elapsedBetween(setup.asOf, hit.previous.date) } : null,
        composition: composition(hit.checkpoint),
        changeSinceOpening: changeAt(hit.checkpoint),
      },
      alreadySatisfied: null,
      meaning: 'The first month-end at which this is true. The projection is month-grain, so '
        + 'say "by the end of that month" — nothing here establishes a day within it.',
    };
  },
};

// ── 12. Goal seek ────────────────────────────────────────────────────────────

/**
 * What a goal seek is allowed to solve for, and what bounds it honestly has.
 *
 * ⚠️ EACH BOUND IS A FACT, NOT A COMFORT. A spending cut cannot exceed what the
 * user actually spends; a required return of 400%/yr is reportable and the model
 * can call it absurd. What the tool must never do is invent a number to avoid
 * saying "no" — which is exactly what turn 13 did with "mid-40% annualized
 * returns" and "~$90K/year additional investable surplus".
 */
const SOLVABLE = {
  annualReturnPct:     'annualReturnPct',
  monthlyContribution: 'monthlyContribution',
  monthlySpendingCut:  'monthlySpendingCut',
} as const;

/** A wide, stated bracket. Anything beyond it is reported as out of range, not clamped. */
const MAX_SOLVED_RETURN_PCT = 500;

const scenarioGoalSeek: ToolDefinition = {
  name: 'scenario_goal_seek',
  description:
    // ⚠️ THE EXAMPLE CARRIES NO CURRENCY SYMBOL. Anywhere under lib/ai a quoted
    // dollar-then-digit is a hard-coded currency in a money string, and
    // `lib/ai/currency-presentation.test.ts` refuses it — correctly: this tool is
    // currency-agnostic and a Space that reports in anything but USD should not
    // read a dollar sign in its own tool surface. The guard only started applying
    // when the runtime moved out of scripts/, which is the guard working.
    'Solve for the one number that reaches a target: the annual return needed, the monthly ' +
    'contribution needed, or the monthly spending cut needed. Use it for "how could I reach ' +
    'a million by 2030?" — do NOT estimate a required return or a required saving rate ' +
    'yourself. ' +
    'It returns the value AND the full scenario at that value, or `feasible: false` with how ' +
    'far the range actually got. Takes the same scenario inputs as scenario_projection, ' +
    'which are held fixed while the one unknown is solved.',
  parameters: obj({
    target: num('The number to reach, in dollars. Required.'),
    by:     str('YYYY-MM-DD by which to reach it. Required.'),
    solveFor: { type: 'string', enum: Object.keys(SOLVABLE),
      description:
        'annualReturnPct = what return would be needed. monthlyContribution = how much cash '
        + 'to move into investments each month (this RELOCATES money — at a 0% return it does '
        + 'not change net worth at all). monthlySpendingCut = how much less to spend each '
        + 'month, with that amount invested; this is the lever that actually creates net worth.' },
    measure: { type: 'string', enum: ['netWorth', 'liquid', 'investments', 'debt'],
      description: 'What the target is a target FOR. Default netWorth. `debt` solves DOWNWARD: '
        + 'the smallest value that brings debt at `by` to at or below the target ("what extra '
        + 'monthly payment gets me debt free by December" = monthlyContribution, measure debt, '
        + 'target 0, contributionTarget highest_apr).' },
    contributionTarget: { description: 'For solveFor monthlyContribution: where the solved '
        + 'monthly amount goes — `investments` (default), `highest_apr`, a liability id, or an '
        + 'ordered list, exactly as `contributions[].target`.',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    ...SCENARIO_INPUTS,
  }, ['target', 'by', 'solveFor']),
  async run(a, ctx) {
    const toISO  = String(a.by);
    const target = Number(a.target);
    const solveFor = String(a.solveFor);
    const measure = ['liquid', 'investments', 'debt'].includes(String(a.measure))
      ? String(a.measure) as 'liquid' | 'investments' | 'debt' : 'netWorth';
    // ⚠️ DEBT IS SOLVED DOWNWARD. The bisection assumes "more of X reaches a
    // higher value"; for a debt target the value that rises with X is minus the
    // balance, so the ledger's debt is negated on the way in and the target on
    // the way out. Nothing else about the solver changes.
    const sign = measure === 'debt' ? -1 : 1;
    const toTarget = (t: unknown): AllocationTarget => (t === 'investments' || t === 'highest_apr') ? t
      : typeof t === 'string' ? { liability: t } : t as AllocationTarget;
    const contributionTargets: AllocationTarget[] | undefined = a.contributionTarget === undefined ? undefined
      : Array.isArray(a.contributionTarget) ? a.contributionTarget.map(toTarget) : [toTarget(a.contributionTarget)];
    if (!Number.isFinite(target)) return { unavailable: 'the target is not a number' };
    if (!(solveFor in SOLVABLE)) {
      return { unavailable: `cannot solve for "${solveFor}"`,
        canSolveFor: Object.keys(SOLVABLE) };
    }

    const setup = await prepareScenario(a, ctx, toISO, scenarioGoalSeek);
    if ('unavailable' in setup) return setup;

    /** The horizon value of whichever line the target is about. */
    const valueOf = (l: LedgerResult): number | null => {
      const last = l.checkpoints[l.checkpoints.length - 1];
      if (!last) return null;
      const line = measure === 'liquid' ? last.liquid
        : measure === 'investments' ? last.investments
        : measure === 'debt' ? last.debt : last.netWorth;
      return line?.amount === undefined || line?.amount === null ? null : sign * line.amount;
    };

    // A monthly schedule of a solved dollar amount, on the same month-ends the
    // projection already knows how to produce.
    const monthly = (amount: number, label: string): PlannedMovement[] =>
      monthEndsBetween(setup.asOf, toISO).map((date) => ({ date, amount, label,
        ...(contributionTargets ? { targets: contributionTargets } : {}) }));

    let evaluate: (x: number) => number | null;
    let hi = 0, unit = '';
    const lo = 0, precision = 0.01;

    if (solveFor === SOLVABLE.annualReturnPct) {
      unit = 'percent per year';
      hi = MAX_SOLVED_RETURN_PCT;
      // ⚠️ A SOLVED RETURN REPLACES ANY STATED ONE. Solving for a rate while
      // leaving another in force would answer a question about a blend that
      // nobody described.
      evaluate = (x) => valueOf(setup.run({
        returns: [{ fromISO: setup.asOf, toISO, annualPct: x }] }));
    } else if (solveFor === SOLVABLE.monthlyContribution) {
      unit = 'USD per month';
      // ⚠️ THE BRACKET FOR A DEBT TARGET IS THE DEBT. A monthly amount equal to
      // everything owed clears it in the first month whatever the rate, so the
      // top of the range is a fact, not a guess.
      hi = measure === 'debt'
        ? Math.max(setup.liabilities.reduce((t, l) => t + l.balance, 0) + (setup.accounts.totalLiabilities ?? 0), 1_000)
        : Math.max(Math.abs(target), 1_000);
      evaluate = (x) => valueOf(setup.run({
        extraContributions: monthly(x, 'solved monthly contribution') }));
    } else {
      unit = 'USD per month';
      const base = setup.monthlySpending.amount;
      if (base === null || base <= 0) {
        return { unavailable: 'no monthly spending level is established for this Space, so '
          + 'there is nothing to solve a cut against',
          suggestion: 'pass assumedMonthlySpending, or solve for annualReturnPct instead' };
      }
      // ⚠️ THE CEILING IS WHAT THEY ACTUALLY SPEND. Nobody can cut more than
      // their whole outgoings, and "you would need to free up $12,400 a month"
      // said to somebody who spends $7,549 is a fabrication with a decimal point.
      hi = base;
      evaluate = (x) => valueOf(setup.run({
        monthlySpending: round2(base - x),
        extraContributions: monthly(x, 'solved monthly amount freed up and invested') }));
    }

    const baseLedger = setup.run();
    const baseline = valueOf(baseLedger);
    const solved = solveForTarget({ solveFor, evaluate, target: sign * target, lo, hi, precision });

    const head = {
      asOf: setup.asOf, target, by: toISO, measure, solveFor, unit,
      /** How far off the deadline is, from the scenario's asOf — the engine's subtraction, not the model's. */
      timeToTarget: elapsedBetween(setup.asOf, toISO),
      // ⚠️ ON EVERY PATH, INCLUDING THE REFUSAL. See `scenarioAssumptions`.
      assumptionsInForce: scenarioAssumptions(setup, baseLedger, setup.returns),
      ...(contributionTargets ? { contributionTarget: contributionTargets } : {}),
      baseline: { reached: baseline === null ? null : sign * baseline,
        gap: baseline === null ? null : round2(target - sign * baseline),
        meaning: 'where the stated assumptions land WITHOUT the solved variable' },
      searchRange: { from: lo, to: hi, unit, iterations: solved.iterations,
        note: solveFor === SOLVABLE.monthlySpendingCut
          ? `the upper bound is the whole ${setup.monthlySpending.source.toLowerCase()} `
            + 'monthly spending level — nobody can cut more than they spend'
          : 'a value outside this range is reported as out of range, never clamped' },
    };

    if (!solved.feasible) {
      return { ...head, feasible: false, reason: solved.reason,
        bestReached: solved.bestReached === null ? null : sign * solved.bestReached, bestAt: solved.bestAt,
        // ⚠️ HOW FAR THE RANGE GOT IS AN ANSWER; A HUGE INVENTED NUMBER IS NOT.
        meaning: `Nothing in the searched range reaches ${target}. The best it did was `
          + `${solved.bestReached ?? 'nothing'} at ${solved.bestAt} ${unit}. Say that, and `
          + 'say which other lever might close the gap — do not estimate a figure yourself. '
          + 'Describe the result using `assumptionsInForce` above and nothing else: if a '
          + 'return or a contribution from earlier in the conversation is not listed there, '
          + 'it was NOT applied, and calling the answer again with it is the way to include '
          + 'it.' };
    }

    // ⚠️ THE LEDGER RETURNED IS THE ONE RUN AT THE ANSWER, not a re-derivation of
    // it. Solve, then render what the solution actually produces, so the table
    // beneath the number cannot disagree with the number.
    const atSolution = solveFor === SOLVABLE.annualReturnPct
      ? { returns: [{ fromISO: setup.asOf, toISO, annualPct: solved.required }] }
      : solveFor === SOLVABLE.monthlyContribution
        ? { extraContributions: monthly(solved.required, 'solved monthly contribution') }
        : { monthlySpending: round2((setup.monthlySpending.amount as number) - solved.required),
            extraContributions: monthly(solved.required,
              'solved monthly amount freed up and invested') };
    const ledger = setup.run(atSolution);
    const returnsUsed = solveFor === SOLVABLE.annualReturnPct
      ? [{ fromISO: setup.asOf, toISO, annualPct: solved.required }] : setup.returns;

    return {
      ...head,
      feasible: true,
      required: solved.required,
      alreadyMet: solved.alreadyMet,
      reachedAtSolution: sign * solved.reached,
      ...(solved.alreadyMet
        ? { meaning: `The target is already reached without any ${solveFor} at all.` }
        : {}),
      provenance: PROVENANCE.USER_ASSUMED,
      scenario: presentScenario(setup, ledger, returnsUsed),
      qualification:
        'This is the value that reaches the target under the stated assumptions — it is '
        + 'arithmetic, not advice and not a prediction. Whether it is achievable is a '
        + 'judgement about the world, not about the numbers; say what you think.',
    };
  },
};

// ── 13. Reconciliation ───────────────────────────────────────────────────────

/** How many statements one reconciliation call will settle. */
const MAX_RECONCILED = 6;

/**
 * Which authority answers a checkpoint's metric. Unknown metrics are refused.
 *
 * ⚠️ THE STORED METRIC IS `liquid`, NOT `cash`, AND THE SCAN CAUGHT THE FIRST
 * DRAFT. The investigation's sketch wrote `metric: "cash"`, and a row saying
 * `cash: 38243.50` read back in December — with no conversation around it and no
 * tool description in sight — is the beta blocker with a longer fuse. A stored
 * record is read further from its context than any tool result, so it needs the
 * more precise name, not the more familiar one.
 */
const METRIC_FIELD: Record<string, 'liquid' | 'netWorth'> = {
  liquid: 'liquid', netWorth: 'netWorth',
};

const reconcileProjection: ToolDefinition = {
  name: 'reconcile_projection',
  description:
    'Compare what we PREVIOUSLY told this user with what actually happened, or with what we ' +
    'would say today. Use it for "were you right?", "how did that projection turn out?", ' +
    '"am I ahead of where you said I would be?". A past horizon is compared against the ' +
    'measured position on that date; a future one against the projection re-run today, which ' +
    'is the only like-for-like comparison. It also names which part of the basis changed.',
  parameters: obj({
    subject: str('One checkpoint subject, e.g. "liquid-2026-12-31". Omit for all of them.'),
    includeSuperseded: { type: 'boolean',
      description: 'True to reconcile earlier statements too, not just the latest per horizon.' },
  }),
  async run(a, ctx) {
    const statements = await recallMemories(
      { spaceId: ctx.spaceId, ownerUserId: ctx.spaceCtx.userId },
      { kind: MemoryKind.CHECKPOINT,
        ...(a.subject ? { subject: String(a.subject) } : {}),
        ...(a.includeSuperseded ? { includeSuperseded: true } : {}) },
    );
    if (statements.length === 0) {
      return { count: 0,
        // ⚠️ NOTHING RECORDED IS NOT THE SAME AS NOTHING SAID, and pretending
        // otherwise would invent a history. Checkpoints only exist from the
        // moment a projection was made in a conversation.
        unavailable: 'no projection has been recorded for this user yet — there is nothing to '
          + 'reconcile against. Ask for an evidence-based projection first — one is recorded automatically, '
          + 'while a projection run on a spending figure the user supplied is a hypothetical and is not.' };
    }

    const spine = await buildCashSpine(ctx, { asOf: ctx.asOfISO });
    const reconciled = [];

    for (const m of statements.slice(0, MAX_RECONCILED)) {
      const cp = readCheckpoint(m);
      if ('unusable' in cp) { reconciled.push({ subject: m.subject, unusable: cp.unusable }); continue; }

      const field = METRIC_FIELD[cp.metric];
      if (!field) {
        reconciled.push({ subject: cp.subject,
          unusable: `no authority in this harness answers the metric "${cp.metric}"` });
        continue;
      }

      const settled = cp.horizon < ctx.asOfISO;
      let compared: number | null = null;
      let comparedFrom = '';
      let basisNow: Record<string, unknown> | null = null;

      if (settled) {
        // ⚠️ ACCURACY, MEASURED AGAINST WHAT ACTUALLY HAPPENED. The horizon has
        // passed, so the financial authorities can say what the position on that
        // date really was, and the difference is the honest score.
        const snap = await historicalSnapshot(ctx, cp.horizon) as Record<string, unknown>;
        if (snap.unavailable) {
          reconciled.push({ subject: cp.subject, stated: cp, status: 'SETTLED',
            unavailable: snap.unavailable });
          continue;
        }
        compared = (snap[field] as number | null) ?? null;
        comparedFrom = `measured position on ${snap.observedOn ?? cp.horizon}`;
      } else if (!('unavailable' in spine)) {
        // ⚠️ MID-FLIGHT, THE COMPARISON IS PROJECTION AGAINST PROJECTION. Setting
        // a year-end statement beside today's balance and subtracting produces a
        // number about two different instants that means nothing at all. Re-running
        // to the SAME horizon is the only like-for-like reading of "am I ahead?".
        const f = spine.runTo(cp.horizon);
        compared = f.projection?.closing ?? null;
        comparedFrom = `the same projection re-run today, to the same horizon (${cp.horizon})`;
        const b = (f.projection ? {
          spendingSource: f.observedSpending ? 'OBSERVED' : (f.appliedFacts.length ? 'USER_STATED' : 'NONE'),
          dailyRate: f.observedSpending?.dailyRate ?? null,
          monthsAveraged: (f.observedSpending as { months?: string[] } | undefined)?.months ?? null,
          incomeEvents: f.events.length,
          userAssumptions: f.appliedFacts,
          openingCash: f.projection.openingCash,
        } : null);
        basisNow = b;
      }

      reconciled.push({
        subject: cp.subject,
        status: settled ? 'SETTLED' : 'IN_FLIGHT',
        stated: { value: cp.value, metric: cp.metric, horizon: cp.horizon,
          on: cp.statedAt.slice(0, 10), inWords: cp.statedAs },
        comparedWith: comparedFrom,
        ...(compared === null
          ? { unavailable: settled
              ? 'the position on that date cannot be established'
              : 'the projection cannot be re-run to that horizon today' }
          : { variance: compareToStatement(cp.value, compared) }),
        // ⚠️ A VARIANCE WITHOUT ITS CAUSE IS A SCORE, NOT AN EXPLANATION.
        ...(basisNow ? { basisChanged: diffBasis(cp.basis, basisNow) } : {}),
        meaning: settled
          ? 'What we said, against what happened. The difference is our error, not the user\'s.'
          : 'Both figures describe the SAME future date — one said then, one said now. This is '
            + 'not a comparison with the current balance, and must not be described as one.',
      });
    }

    return {
      asOf: ctx.asOfISO,
      count: reconciled.length,
      ofTotal: statements.length,
      reconciled,
      note: 'A checkpoint records what we STATED and when. It is never a current balance — for '
        + 'that, call get_financial_snapshot.',
    };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

// ── 12. Staging — conditions stated before a scenario has run ────────────────

/**
 * THE CARRIER FOR "SAID, NOT YET RUN" (planning continuity).
 *
 * ⚠️ ITS PARAMETERS ARE THE SCENARIO'S OWN, READ OFF `SCENARIO_INPUTS`. There is
 * no second schema: a clause staged here is one item of the argument the scenario
 * tools already take, in the same shape, checked against the same literal — and
 * the next scenario run merges it in by identity (`pending-plan.ts`).
 *
 * ⚠️ THE BOUNDARY WITH `remember` IS THE SENTENCE THIS DESCRIPTION LEADS WITH.
 * Measured before this tool existed: "For this scenario, keep nine months in cash"
 * was written to DURABLE memory 3/3 — because memory was the only structured place
 * a condition could go. A condition for the calculation being assembled is staged
 * here; a standing preference the user wants kept across conversations is theirs
 * to ask `remember` for.
 */
const stageAssumptions: ToolDefinition = {
  name: 'stage_assumptions',
  description:
    'Hold a condition the user just stated for a projection that has NOT been run yet — a '
    + 'raise or income change from a date, a cash floor, which debt to pay first, where the '
    + 'rest goes, a one-off amount, a return, a spending level — so the next '
    + 'scenario_projection, scenario_crossing or scenario_goal_seek in this conversation '
    + 'applies it. Use it whenever a condition is stated without asking for a figure yet ("keep '
    + 'nine months of expenses in cash", "starting January my income goes up 10%", "pay the '
    + 'highest APR first", "for this scenario, …"), and to restate one ("actually make it 15%" '
    + 'replaces the staged raise). Each field takes exactly the shape the scenario tools take. '
    + 'Staged conditions are NOT remembered beyond this conversation, NOT current facts, and NOT '
    + 'results: nothing is calculated until a scenario runs. A standing preference the user wants '
    + 'kept for future conversations is a different thing, and is not this.',
  // ⚠️ THE KEYS ARE DERIVED; THE SHAPES ARE REFERENCED, NOT COPIED. Spreading
  // `SCENARIO_INPUTS` in here restated ~11 KB of schema that scenario_projection
  // already puts in every prompt. The model reads each shape there; this names the
  // same closed set of keys, and `pending-plan.ts` checks every entry against the
  // canonical literal exactly as the scenario would.
  parameters: obj({
    ...Object.fromEntries(scenarioAssumptionKeys().map((k) => {
      const t = (SCENARIO_INPUTS as Record<string, { type?: string }>)[k]?.type ?? 'object';
      return [k, { type: t, ...(t === 'array' ? { items: { type: 'object' } } : {}),
        description: `Exactly the shape of scenario_projection's \`${k}\`.` }];
    })),
    retract: { type: 'array', items: { type: 'string' },
      description: 'Ids of staged conditions the user has withdrawn (e.g. "p2").' },
    // ⚠️ MEASURED 1/6: "invest everything above the floor", after "pay highest APR
    // debt first", was sent with `replace: true` and the debt order left the plan —
    // the guard made it explicit, and the description had not said that naming the
    // NEXT destination is not withdrawing the first.
    replace: { type: 'boolean', description: 'Only when the user WITHDREW or CORRECTED part of a '
      + 'staged rule ("don\'t pay debt first after all", "actually from February"). Saying where '
      + 'money goes NEXT is not a withdrawal: "invest everything above the floor" after "pay the '
      + 'highest APR first" is `target: ["highest_apr","investments"]`, without `replace`.' },
  }),
  async run(a, ctx) {
    if (!ctx.plan || !ctx.turn) {
      return { unavailable: 'this conversation cannot hold staged conditions here, so nothing was '
        + 'staged. State the conditions in the scenario call itself.' };
    }
    // ⚠️ STAGING IS FOR BEFORE A SCENARIO RUNS, AND ONLY THEN. Measured: once a
    // scenario had run, "actually make the raise 15%" was STAGED 6/6 and nothing
    // re-ran, although the result said to run it — the recompute I1 held at 6/6
    // fell to 0/6. After a run, a change takes effect by running again with it; the
    // envelope carries every condition that ran, and a re-run merges nothing stale
    // because the staged plan is empty from the moment a scenario runs. One carrier
    // per phase: stated-not-run here, ran in the envelope.
    // Withdrawing is always allowed: a clause a run could not confirm is still held,
    // and the user must be able to take it back after the run as well as before.
    const onlyRetracting = Object.keys(a).every((k) => k === 'retract');
    if (ctx.plan.scenarioRan && !onlyRetracting) {
      return { unavailable: 'a scenario has ALREADY RUN in this conversation, so this change was '
          + 'NOT staged — staging holds conditions only until the first run',
        instead: 'run scenario_projection again now with the ACTIVE SCENARIO\'s arguments and this '
          + 'change applied to them (for the horizon the user asked about). That run is the answer.' };
    }
    const { retract, replace, ...stage } = a;
    const r = stagePlan(ctx.plan.pending,
      { stage, replace: replace === true,
        retract: Array.isArray(retract) ? retract.filter((x): x is string => typeof x === 'string') : [] },
      { turn: Math.max(0, ctx.turn.userTexts.length - 1), evidence: ctx.turn });
    ctx.plan.pending = r.plan;
    return {
      staged: r.staged, retracted: r.retracted,
      ...(r.refused.length ? { notStaged: notAppliedEcho(r.refused) } : {}),
      ...(r.replacedFields.length ? { replacedFields: {
        fields: r.replacedFields,
        meaning: 'These fields REPLACED what was staged before — a merge cannot tell "instead" from '
          + '"then". If the user meant both (e.g. pay the highest-APR debt first, THEN invest the '
          + 'rest), stage the combined value, e.g. `target: ["highest_apr", "investments"]`.',
      } } : {}),
      heldNow: r.plan.clauses.map((c) => ({ id: c.id, [c.key]: c.value })),
      meaning: 'Held for THIS conversation only and not yet run; nothing here is a figure. The next '
        + 'scenario run applies every condition in `heldNow` and says so. To answer with numbers, '
        + 'run the scenario.',
    };
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  getFinancialSnapshot, getSpending, measureFlows, getBaselines, getTransactions, getIncome,
  getInvestments,
  getNetWorthHistory, findInBalanceHistory, explainNetWorthComposition, projectCash,
  getPayDates, investmentScenario,
  scenarioProjection, scenarioCrossing, scenarioGoalSeek, reconcileProjection,
  stageAssumptions,
  ...MEMORY_TOOLS,
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
