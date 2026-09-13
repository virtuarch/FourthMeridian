/**
 * scripts/ai-baseline/tools.ts
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
  type AccountsSectionData, type TransactionsSummaryData,
  type HoldingsSummaryData, type SpaceContext_AI,
} from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import {
  queryTransactions, countTransactions, transactionCorpusSpan, transactionCoverage,
} from '@/lib/data/transaction-query';
import { MAX_TRANSACTION_PAGE_SIZE, type TransactionQuery } from '@/lib/data/transaction-query-core';
import { TRANSACTION_FETCH_LIMIT } from '@/lib/ai/assemblers/transactions';
import type { Transaction } from '@/types';
import { getRecentSnapshots } from '@/lib/data/snapshots';
import { projectSnapshotSection } from '@/lib/ai/assemblers/snapshot';
import type { Snapshot } from '@/types';
import { FlowType } from '@prisma/client';
import { resolveExplorationNode } from '@/lib/history/exploration';
import { observedChange } from '@/lib/data/snapshot-window';
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
import {
  runScenarioLedger, expandContributions, solveForTarget, PROVENANCE,
  type ContributionSpec, type LedgerResult, type PlannedMovement,
  type ReturnPeriod, type SpinePoint,
} from './scenario-ledger';
import type { SpaceContext } from '@/lib/space';
// ⚠️ THE ONE WRITE PATH, IMPORTED RATHER THAN INLINED. Keeping the memory tools
// in their own module is what lets THIS file keep an exact "no Prisma client,
// no write op" scan while `memory-tools.ts` gets its own, equally exact, "may
// reach db.spaceMemory and nothing else". One loose assertion covering both
// would have protected neither.
import { MEMORY_TOOLS } from './memory-tools';
// ⚠️ READING memory, never writing it. `recallMemories` is the store's read half;
// the write half lives in the turn loop (slice 7) and in `remember`. This file
// still holds no Prisma client, which a test asserts.
import { recallMemories, MemoryKind } from './memory-store';
import {
  readCheckpoint, compareToStatement, diffBasis,
} from './reconcile';

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
 * Every calendar month-end strictly after `fromISO` and not after `toISO`, plus
 * `toISO` itself when it is not already one.
 *
 * ⚠️ THE LAST ENTRY IS ALWAYS THE HORIZON, which is what makes the final
 * checkpoint and the standalone endpoint the same number rather than nearly.
 */
export function monthEndsBetween(fromISO: string, toISO: string): string[] {
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
    'Deterministic spending and cash-flow totals over any window up to ~26 months: ' +
    'category and merchant rollups, month-by-month, largest expense, transfers and ' +
    'card payments kept separate from spending. Default window is the last 90 days.',
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
    'as null WITH a reason; read `coverage` before describing older history as fact.',
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
  opts: { asOf: string; assumedMonthlySpending?: number },
): Promise<CashSpine | { unavailable: string; asOf: string }> {
  const asOf = opts.asOf;
  const retrospective = asOf < ctx.asOfISO;

  const [streams, accounts, transactions] = await Promise.all([
    loadForecastIncomeStreams(ctx.spaceId, asOf),
    assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
    // ⚠️ THE ONE LINE THAT MADE THIS TOOL WORK. PROJECTION-1 derives its spending
    // rate from `reliableMonths(transactionsDomain)`; with only the accounts
    // domain in scope it sees zero months, cannot assert a rate, and returns
    // `closing: null` — always, for every horizon. Measured before the fix:
    // null / null. After: $38,243.50 to end-2026 and $128,827.54 to end-2027.
    // Both models papered over the null by doing the arithmetic in prose, and
    // one of them was $745.86 out.
    assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
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
        horizon: { fromISO: asOf, toISO: end, origin: AssumptionOrigin.USER_REQUESTED,
          statedAs: `through ${end}` } as unknown as ForecastHorizon,
      }),
  };
}

// ── 8. Cash projection ───────────────────────────────────────────────────────

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
    'Deterministic cash projection to a future date, with month-end checkpoints. The ' +
    'headline answer is `projection` — an evidence-based estimate built from observed ' +
    'payroll cadence and observed spending continuing as they are. ' +
    '`assumedMonthlySpending` is the only assumption it can apply; a dated one-off amount ' +
    'arriving or leaving is not part of this projection. `establishment` says how firmly ' +
    'each input is pinned down; it is provenance, not a competing answer.',
  parameters: obj({
    to: str('YYYY-MM-DD horizon end. Required.'),
    assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here. '
      + 'It is the only user assumption this tool can apply. A one-off amount on a date — '
      + 'a bonus, an inheritance, a purchase, a sale — is not part of this projection.'),
    checkpoints: { type: 'string', enum: ['monthly', 'none'],
      description: 'monthly = a balance at each month-end between now and the horizon. '
        + 'Default monthly for horizons over ~45 days.' },
    asOf: str('Project FROM this date using only evidence available then. Omit for today. '
      + 'Use for "what would you have predicted back in January?".'),
  }, ['to']),
  async run(a, ctx) {
    const toISO = String(a.to);
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

    // ── Month-end checkpoints ────────────────────────────────────────────────
    //
    // ⚠️ EACH CHECKPOINT IS AN INDEPENDENT RUN FROM THE SAME `asOf`, never a
    // balance carried forward from the previous one. Compounding checkpoint on
    // checkpoint would accumulate rounding and — worse — would let a series drift
    // away from the endpoint the same authority produces for the same horizon.
    // Because every point is `projectCash(asOf → thatMonthEnd)`, the last
    // checkpoint IS the endpoint by construction, and a test pins it.
    const horizonDays = Math.round(
      (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
    const wantCheckpoints = (a.checkpoints as string) === 'monthly'
      || ((a.checkpoints as string) !== 'none' && horizonDays > 45);

    let checkpoints: unknown[] | undefined;
    if (wantCheckpoints) {
      const ends = monthEndsBetween(asOf, toISO);
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
      horizon: { asOf, to: toISO, days: horizonDays },
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

// ── 11. Scenario projection and goal seek ────────────────────────────────────

/**
 * Every 31 December strictly after `fromISO` and not after `toISO`, plus the
 * horizon itself. The yearly analogue of `monthEndsBetween`, and it keeps the
 * same property: the last entry IS the horizon.
 */
export function yearEndsBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const firstYear = Number(fromISO.slice(0, 4));
  const lastYear  = Number(toISO.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    const iso = `${y}-12-31`;
    if (iso > fromISO && iso <= toISO) out.push(iso);
  }
  if (out[out.length - 1] !== toISO && toISO > fromISO) out.push(toISO);
  return out;
}

/** A ceiling on how many independent projection runs one question can trigger. */
const MAX_SCENARIO_CHECKPOINTS = 80;
/** Days per month, for turning an observed daily spending rate into a monthly one. */
const DAYS_PER_MONTH = 365 / 12;

/** What a caller may vary without restating the whole scenario. */
interface ScenarioOverrides {
  returns?:            ReturnPeriod[];
  extraContributions?: PlannedMovement[];
  /** Rebuilds the cash spine at a different spending level. */
  monthlySpending?:    number;
}

interface ScenarioSetup {
  asOf: string; toISO: string; granularity: string;
  dates: string[]; clamped: boolean;
  accounts: AccountsSectionData;
  returns: ReturnPeriod[];
  contributions: PlannedMovement[];
  outflows: PlannedMovement[];
  rejected: { input: string; reason: string }[];
  /** The spending level the base run used, and where it came from. */
  monthlySpending: { amount: number | null; source: 'USER_STATED' | 'OBSERVED' | 'NONE' };
  run: (o?: ScenarioOverrides) => LedgerResult;
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
async function prepareScenario(
  a: Record<string, unknown>, ctx: ToolContext, toISO: string,
): Promise<ScenarioSetup | { unavailable: string; reason?: unknown }> {
  const spine = await buildCashSpine(ctx, {
    asOf: ctx.asOfISO,
    ...(typeof a.assumedMonthlySpending === 'number'
      ? { assumedMonthlySpending: a.assumedMonthlySpending }
      : {}),
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
  // The spine's own opening balance — checking plus savings. Named `liquid`
  // below for the same reason nothing in the result is named `cash`.
  const openingLiquid = endpoint.projection?.openingCash
    ?? ('refused' in endpoint.forecast ? null : endpoint.forecast.openingCash.amount);
  if (openingLiquid === null) {
    return { unavailable: 'no opening cash balance could be established, so nothing can be '
      + 'projected from it',
      reason: endpoint.projection?.missing?.join('; ') ?? endpoint.unavailable };
  }

  const horizonDays = Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
  const granularity = (a.granularity as string) === 'monthly' ? 'monthly'
    : (a.granularity as string) === 'yearly' ? 'yearly'
    : horizonDays > 550 ? 'yearly' : 'monthly';
  let dates = granularity === 'yearly'
    ? yearEndsBetween(asOf, toISO) : monthEndsBetween(asOf, toISO);
  const clamped = dates.length > MAX_SCENARIO_CHECKPOINTS;
  // Keep the HORIZON when trimming — a table that stops short of the date the
  // question named has not answered it.
  if (clamped) dates = [...dates.slice(0, MAX_SCENARIO_CHECKPOINTS - 1), toISO];

  // ── The stated assumptions, normalised ─────────────────────────────────────
  const rejected: { input: string; reason: string }[] = [];

  const flatPct = typeof a.annualReturnPct === 'number' ? a.annualReturnPct : 0;
  const statedReturns = (a.returns as { from: string; to: string; annualPct: number }[]) ?? [];
  // ⚠️ ONE SOURCE OF RETURNS, NOT TWO BLENDED. Per-period rates are the whole
  // truth when given; a flat rate filling their gaps would apply a number the
  // user only meant for the years they named.
  const returns: ReturnPeriod[] = statedReturns.length > 0
    ? statedReturns.map((r) => ({ fromISO: String(r.from), toISO: String(r.to),
        annualPct: Number(r.annualPct) }))
    : flatPct === 0 ? []
    : [{ fromISO: asOf, toISO, annualPct: flatPct }];

  const contribSpecs: ContributionSpec[] = [];
  for (const c of (a.contributions as Record<string, unknown>[]) ?? []) {
    const label  = c.label === undefined ? undefined : String(c.label);
    // How much: a dollar amount, or a share of the balance. The ledger refuses
    // both and neither; this only passes through what was said.
    const size = {
      ...(c.amount !== undefined ? { amount: Number(c.amount) } : {}),
      ...(c.fractionOfLiquid !== undefined
        ? { fractionOfLiquid: Number(c.fractionOfLiquid) } : {}),
    };
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
    const label  = String(o.label ?? 'one-off');
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
  const opening = { asOfISO: asOf, liquid: openingLiquid, investments: composition.combined,
    debt: accounts.totalLiabilities ?? 0, otherAssets };

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

  const observedDaily = endpoint.observedSpending?.dailyRate ?? null;
  const monthlySpending: ScenarioSetup['monthlySpending'] =
    typeof a.assumedMonthlySpending === 'number'
      ? { amount: a.assumedMonthlySpending, source: 'USER_STATED' }
      : observedDaily !== null
        ? { amount: round2(observedDaily * DAYS_PER_MONTH), source: 'OBSERVED' }
        : { amount: null, source: 'NONE' };

  return {
    asOf, toISO, granularity, dates, clamped, accounts, returns,
    contributions: expanded.movements, outflows, rejected, monthlySpending,
    run: (o: ScenarioOverrides = {}) => {
      const useContribs = o.extraContributions
        ? [...expanded.movements, ...o.extraContributions] : expanded.movements;
      // ⚠️ SHARE-BASED CONTRIBUTIONS NEED THE PROJECTION ON THEIR OWN DATE. "Half
      // my liquidity every June" falls nowhere near a year end, and half of a
      // balance the ledger cannot see is not something to guess at. Those dates
      // are evaluated too and marked as not being rows in the table.
      const shareDates = useContribs
        .filter((m) => m.fractionOfLiquid !== undefined).map((m) => m.date).sort();
      return runScenarioLedger({
        opening,
        spine: spineFor(shareDates, o.monthlySpending),
        contributions: useContribs,
        outflows,
        returns: o.returns ?? returns,
      });
    },
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
function scenarioAssumptions(
  setup: ScenarioSetup, ledger: LedgerResult, returns: ReturnPeriod[],
) {
  const kind = (k: 'CONTRIBUTION' | 'OUTFLOW') => ledger.movements.filter((m) => m.kind === k);
  return {
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
      ...(kind('CONTRIBUTION').length === 0
        ? { note: 'No contributions were in force. Do not describe this result as including '
            + 'any.' } : {}),
    },
    outflows: { count: kind('OUTFLOW').length, settled: kind('OUTFLOW').slice(0, 12),
      provenance: PROVENANCE.USER_ASSUMED },
    spending: { source: setup.monthlySpending.source, monthly: setup.monthlySpending.amount,
      ...(setup.monthlySpending.source === 'OBSERVED'
        ? { note: 'from the same observed rate project_cash uses' } : {}) },
  };
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
    horizon: { to: setup.toISO, granularity: setup.granularity, checkpoints: setup.dates.length,
      ...(setup.clamped ? { clampedTo: MAX_SCENARIO_CHECKPOINTS } : {}) },
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
    checkpoints: ledger.checkpoints,
    movements: ledger.movements,
    rejected: [...setup.rejected, ...ledger.rejected],
    warnings,
    basis: ledger.basis,
    // ⚠️ SAID ONCE, PLAINLY, WHERE THE MODEL WILL READ IT. Every earlier
    // version of this answer was composed in prose, and the assumption that a
    // stated return was a forecast is the failure that follows.
    qualification:
      'The cash line is an evidence-based projection; the returns and contributions are '
      + 'the user\'s own assumptions and nothing here predicts a market. Present the '
      + 'result as "if these assumptions hold", and never as an expectation.',
  };
}

/** The scenario arguments both tools accept, so the model states them once, one way. */
const SCENARIO_INPUTS = {
  granularity: { type: 'string', enum: ['yearly', 'monthly'],
    description: 'yearly = 31 December of each year. Default yearly beyond ~18 months.' },
  annualReturnPct: num('One flat annual return for the whole horizon, e.g. 8. Only if the '
    + 'user stated it. Ignored when `returns` is given. Default 0.'),
  returns: { type: 'array', description: 'Per-period returns, when the user gave different '
    + 'rates for different years. Periods must not overlap.',
    items: obj({ from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD, inclusive'),
      annualPct: num('e.g. 50 for "50% in 2028"') }, ['from', 'to', 'annualPct']) },
  contributions: { type: 'array',
    description: 'Money moved from cash into investments. WHEN: give either `onDate` for a '
      + 'one-off or `from` + `cadence` for a schedule. HOW MUCH: give either `amount` in '
      + 'dollars or `fractionOfLiquid` for a share of the balance — exactly one of the two.',
    items: obj({
      amount:  num('A dollar amount. Positive moves cash into investments; negative takes '
        + 'it back out. Do NOT put a fraction here.'),
      fractionOfLiquid: num('A share of the projected cash on each date: 0.5 for "half my '
        + 'liquidity", 1 for "everything". Use this whenever the user said a proportion — '
        + 'the dollar amount differs at every date and only the projection knows it.'),
      onDate:  str('YYYY-MM-DD for a single contribution.'),
      from:    str('YYYY-MM-DD first occurrence of a repeating contribution.'),
      to:      str('YYYY-MM-DD last occurrence. Omit to continue to the horizon.'),
      cadence: { type: 'string', enum: ['monthly', 'yearly'] },
      label:   str('The user\'s own words, e.g. "half my liquidity".'),
    }) },
  outflows: { type: 'array',
    description: 'One-off cash leaving entirely — a car, a trip, a tax bill. Use a NEGATIVE '
      + 'amount for a one-off inflow such as a bonus.',
    items: obj({ onDate: str('YYYY-MM-DD'), amount: num('Positive = cash out.'),
      label: str('What it is.') }, ['onDate', 'amount']) },
  assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here — '
    + 'it changes the cash spine exactly as it does in project_cash.'),
};

const scenarioProjection: ToolDefinition = {
  name: 'scenario_projection',
  // ⚠️ IT LED WITH "NET WORTH" AND EXEMPLIFIED ONLY INVESTING, so a question
  // about CASH this year did not look like this tool's job — the one-off
  // capability was four words between two sentences about investment returns.
  // What changed is the framing and the examples, not the arithmetic: this says
  // what the ledger has always done.
  description:
    'Deterministic projection when something specific happens that the observed pattern ' +
    'does not contain: a dated one-off amount arriving or leaving — a bonus, an ' +
    'inheritance, a car, a tax bill, proceeds from a sale — money moved into investments, ' +
    'and an annual return. Cash comes from the same deterministic projection as ' +
    'project_cash; this adds only what the user said, and reports cash, investments, debt ' +
    'and net worth at every checkpoint. Do NOT do this arithmetic yourself. The default ' +
    'return is 0%: never supply a rate the user did not state.',
  parameters: obj({ to: str('YYYY-MM-DD horizon end. Required.'), ...SCENARIO_INPUTS }, ['to']),
  async run(a, ctx) {
    const setup = await prepareScenario(a, ctx, String(a.to));
    if ('unavailable' in setup) return setup;
    return presentScenario(setup, setup.run(), setup.returns);
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
    'Solve for the one number that reaches a target: the annual return needed, the monthly ' +
    'contribution needed, or the monthly spending cut needed. Use it for "how could I reach ' +
    '$1M by 2030?" — do NOT estimate a required return or a required saving rate yourself. ' +
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
    measure: { type: 'string', enum: ['netWorth', 'liquid', 'investments'],
      description: 'What the target is a target FOR. Default netWorth.' },
    ...SCENARIO_INPUTS,
  }, ['target', 'by', 'solveFor']),
  async run(a, ctx) {
    const toISO  = String(a.by);
    const target = Number(a.target);
    const solveFor = String(a.solveFor);
    const measure = ['liquid', 'investments'].includes(String(a.measure))
      ? String(a.measure) as 'liquid' | 'investments' : 'netWorth';
    if (!Number.isFinite(target)) return { unavailable: 'the target is not a number' };
    if (!(solveFor in SOLVABLE)) {
      return { unavailable: `cannot solve for "${solveFor}"`,
        canSolveFor: Object.keys(SOLVABLE) };
    }

    const setup = await prepareScenario(a, ctx, toISO);
    if ('unavailable' in setup) return setup;

    /** The horizon value of whichever line the target is about. */
    const valueOf = (l: LedgerResult): number | null => {
      const last = l.checkpoints[l.checkpoints.length - 1];
      if (!last) return null;
      const line = measure === 'liquid' ? last.liquid
        : measure === 'investments' ? last.investments : last.netWorth;
      return line?.amount ?? null;
    };

    // A monthly schedule of a solved dollar amount, on the same month-ends the
    // projection already knows how to produce.
    const monthly = (amount: number, label: string): PlannedMovement[] =>
      monthEndsBetween(setup.asOf, toISO).map((date) => ({ date, amount, label }));

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
      hi = Math.max(Math.abs(target), 1_000);
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
    const solved = solveForTarget({ solveFor, evaluate, target, lo, hi, precision });

    const head = {
      asOf: setup.asOf, target, by: toISO, measure, solveFor, unit,
      // ⚠️ ON EVERY PATH, INCLUDING THE REFUSAL. See `scenarioAssumptions`.
      assumptionsInForce: scenarioAssumptions(setup, baseLedger, setup.returns),
      baseline: { reached: baseline,
        gap: baseline === null ? null : round2(target - baseline),
        meaning: 'where the stated assumptions land WITHOUT the solved variable' },
      searchRange: { from: lo, to: hi, unit, iterations: solved.iterations,
        note: solveFor === SOLVABLE.monthlySpendingCut
          ? `the upper bound is the whole ${setup.monthlySpending.source.toLowerCase()} `
            + 'monthly spending level — nobody can cut more than they spend'
          : 'a value outside this range is reported as out of range, never clamped' },
    };

    if (!solved.feasible) {
      return { ...head, feasible: false, reason: solved.reason,
        bestReached: solved.bestReached, bestAt: solved.bestAt,
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
      reachedAtSolution: solved.reached,
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
          + 'reconcile against. Ask for a projection first; it will be recorded automatically.' };
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

export const TOOLS: readonly ToolDefinition[] = [
  getFinancialSnapshot, getSpending, getTransactions, getIncome, getInvestments,
  getNetWorthHistory, explainNetWorthComposition, projectCash, getPayDates, investmentScenario,
  scenarioProjection, scenarioGoalSeek, reconcileProjection,
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
