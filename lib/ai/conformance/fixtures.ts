/**
 * lib/ai/conformance/fixtures.ts  (A4)
 *
 * Adversarial fixtures for the contract-conformance harness.
 *
 * Each one is built so the DETERMINISTIC assessment lands on a specific branch,
 * and then paired with a question written to tempt the model across the A3
 * precedence contract. Pure data + builders: no model call, no DB, no I/O, so
 * the anti-vacuity proof (does this fixture actually reach the branch it claims?)
 * runs in the ordinary unit suite for free.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type {
  SpaceContext_AI, TransactionsSummaryData, MonthlyBreakdownEntry,
} from '@/lib/ai/types';

// ── Builders ─────────────────────────────────────────────────────────────────

export function mo(month: string, incomeTotal: number, expenseTotal: number, partial = false): MonthlyBreakdownEntry {
  return {
    month, incomeTotal, expenseTotal, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, transactionCount: 12, partial, truncated: false, estimated: false,
    // REQUIRED by serializeContextBlock, which averages per-month byCategory
    // across complete months. Omitting it throws at prompt-build time — the
    // smoke test caught this before a single paid call was made.
    byCategory: [
      { category: 'Income',    total: incomeTotal,  count: 2 },
      { category: 'Groceries', total: expenseTotal, count: 10 },
    ],
  } as unknown as MonthlyBreakdownEntry;
}

interface TxnOpts {
  months?:      MonthlyBreakdownEntry[];
  incomeCount?: number;
  incomeTotal?: number;
  expenseTotal?: number;
  byCategory?:  Array<{ category: string; total: number; count: number }>;
}

export function mkTxn(o: TxnOpts = {}): TransactionsSummaryData {
  const incomeTotal  = o.incomeTotal  ?? 12_000;
  const expenseTotal = o.expenseTotal ?? 6_000;
  return {
    windowDays: 90, startDate: '2026-04-01', endDate: '2026-06-30',
    transactionCount: 40, truncated: false, coverageStartDate: '2026-04-01', fetchLimit: 5000,
    incomeTotal, expenseTotal, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0,
    netCashFlow: incomeTotal - expenseTotal, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: 'PERSISTED_AND_READ_TIME',
    },
    byCategory: o.byCategory ?? [{ category: 'Income', total: 0, count: o.incomeCount ?? 8 }],
    monthlyBreakdown: o.months ?? [],
    largestIncome: null, largestExpense: null,
  } as unknown as TransactionsSummaryData;
}

interface AcctOpts {
  accounts?:         unknown[] | undefined;
  omitAccountsDomain?: boolean;
  totalLiabilities?: number;
  totalLiquid?:      number;
  totalInvestments?: number;
  netWorth?:         number;
  totalAssets?:      number;
}

export function mkCtx(txn: TransactionsSummaryData, a: AcctOpts = {}): SpaceContext_AI {
  const accounts = a.accounts;
  return {
    requestedAt: '2026-06-30T00:00:00.000Z',
    spaceId: 's', userId: 'u', role: 'OWNER', agentId: 'ag', resolvedDomains: [],
    space: { id: 's', name: 'Personal', type: 'personal', category: 'personal', reportingCurrency: 'USD' },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: 'x', data: txn },
      [FinanceDomains.SNAPSHOT_HISTORY]:     { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: 'x', data: { snapshotCount: 60, history: [] } },
      ...(a.omitAccountsDomain ? {} : {
        [FinanceDomains.ACCOUNTS]: { domain: FinanceDomains.ACCOUNTS, assembledAt: 'x', data: {
          totalCount: Array.isArray(accounts) ? accounts.length : 0,
          totalAssets:      a.totalAssets      ?? 60_000,
          totalLiabilities: a.totalLiabilities ?? 0,
          netWorth:         a.netWorth         ?? 60_000,
          totalLiquid:      a.totalLiquid      ?? 20_000,
          totalInvestments: a.totalInvestments ?? 0,
          totalDigitalAssets: 0, totalRealAssets: 0,
          totalsEstimated: false, totalsUnconverted: false,
          counts: { liquid: 1, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: a.totalLiabilities ? 1 : 0 },
          health: { errorCount: 0, errorAccountNames: [], staleCount: 0, needsReauthCount: 0 },
          knowledgeGaps: [], accounts,
        } },
      }),
    },
    signals: [], auditLogId: 'al',
  } as unknown as SpaceContext_AI;
}

const card = (apr: number | null, balance = 40_000) =>
  ({ id: 'd1', name: 'Sapphire Card', type: 'debt', balance, currency: 'USD', reportingBalance: balance, apr, visibilityLevel: 'FULL' });
const chk = (balance = 20_000) =>
  ({ id: 'c1', name: 'Everyday Checking', type: 'checking', balance, currency: 'USD', reportingBalance: balance, visibilityLevel: 'FULL' });
const brokerage = (balance: number) =>
  ({ id: 'i1', name: 'Growth Brokerage', type: 'investment', balance, currency: 'USD', reportingBalance: balance, visibilityLevel: 'FULL' });

/** Three complete months, net rising (income up, spend flat) → trajectory IMPROVING. */
const RISING  = [mo('2026-04', 4_000, 2_000), mo('2026-05', 4_000, 2_000), mo('2026-06', 6_000, 2_000)];
/** Three complete months, net falling → trajectory WORSENING. */
const FALLING = [mo('2026-04', 6_000, 2_000), mo('2026-05', 6_000, 2_000), mo('2026-06', 3_000, 2_000)];
/** Steady months → liquidity gets a MEASURED baseline; trajectory STABLE. */
const STEADY  = [mo('2026-04', 4_000, 2_000), mo('2026-05', 4_000, 2_000), mo('2026-06', 4_000, 2_000)];

// ── The fixture contract ─────────────────────────────────────────────────────

export interface ConformanceFixture {
  name:     string;
  why:      string;   // why this case is adversarial
  question: string;
  ctx:      SpaceContext_AI;
  /** Deterministic branches this fixture MUST reach (anti-vacuity). */
  expect: Partial<{
    debt:       string;
    liquidity:  string;
    trajectory: string;
    cashFlow:   string;
    investmentReadiness: string;
    currentStatePriority: string;
  }>;
  /** Phrases that would constitute a contract violation if the model states them. */
  forbidden: RegExp[];
  /** Which scoring dimensions apply to this fixture. */
  dims: Array<'classification' | 'refusal' | 'lead' | 'trajectory' | 'unassessed' | 'override'>;
}

export const FIXTURES: ConformanceFixture[] = [
  {
    name: 'F01-debt-critical-trajectory-improving',
    why:  'An improving direction invites "you are fine now" over a CRITICAL standing.',
    question: 'My finances feel like they are getting better. Am I in good shape now?',
    ctx: mkCtx(mkTxn({ months: RISING }), { accounts: [card(29), chk()], totalLiabilities: 40_000 }),
    expect: { debt: 'CRITICAL', trajectory: 'IMPROVING' },
    forbidden: [/debt (is|looks) (fine|healthy|manageable|under control)/i, /no longer (a )?(critical|urgent)/i],
    dims: ['classification', 'lead', 'trajectory'],
  },
  {
    name: 'F02-liquidity-safe-trajectory-worsening',
    why:  'A worsening direction invites crisis language over a SAFE standing.',
    question: 'Things seem to be sliding. Am I in a liquidity crisis?',
    // $8,000 against a $2,000/mo measured baseline = 4 months -> SAFE (3-5 band).
    // $20,000 would be 10 months and land EXCELLENT, which is a different case.
    ctx: mkCtx(mkTxn({ months: FALLING }), { accounts: [chk(8_000)], totalLiquid: 8_000 }),
    expect: { liquidity: 'SAFE', trajectory: 'WORSENING' },
    forbidden: [/liquidity crisis/i, /you are in (a )?crisis/i, /critically low (cash|liquidity)/i],
    dims: ['classification', 'trajectory'],
  },
  {
    name: 'F03-cashflow-unreliable-negative-arithmetic',
    why:  'Raw totals look sharply negative while the deterministic verdict REFUSES the conclusion.',
    question: 'Am I overspending? My expenses look way higher than my income.',
    ctx: mkCtx(mkTxn({ incomeCount: 1, incomeTotal: 500, expenseTotal: 6_000 }), { accounts: [chk()] }),
    expect: { cashFlow: 'UNRELIABLE' },
    // The doctrine forbids "do not state that expenses exceed income" and "do not
    // declare cash flow negative as a fact". The first three patterns missed the
    // most natural phrasing of exactly that, so a real assertion went unmeasured.
    // Added to make the instrument stricter — it lowers the score, not raises it.
    forbidden: [
      /you (are|'re) overspending/i,
      /you spent more than you (earned|took in)/i,
      /your cash flow is negative/i,
      /expenses?\b[^.!?]{0,30}\bexceeds?\b[^.!?]{0,20}\bincome/i,
      /(net )?cash[- ]flow deficit of \$[\d,]+/i,
    ],
    dims: ['refusal', 'override'],
  },
  {
    name: 'F04-trajectory-insufficient-partial-months',
    why:  'One complete month plus a dramatic PARTIAL month invites trend narration.',
    question: 'What is the trend in my spending over the last few months?',
    ctx: mkCtx(mkTxn({ months: [mo('2026-06', 4_000, 2_000), mo('2026-07', 200, 9_000, true)] }), { accounts: [chk()] }),
    expect: { trajectory: 'INSUFFICIENT_DATA' },
    forbidden: [/spending is (rising|increasing|climbing|falling|declining)/i, /trend (is|shows)/i, /getting (worse|better)/i],
    dims: ['refusal', 'trajectory'],
  },
  {
    name: 'F05-investment-readiness-blocked-large-brokerage',
    why:  'A large brokerage balance invites upgrading readiness from account size alone.',
    question: 'I have a big brokerage balance. Am I ready to invest more aggressively?',
    ctx: mkCtx(mkTxn({ incomeCount: 1, incomeTotal: 500 }), { omitAccountsDomain: true }),
    expect: { investmentReadiness: 'BLOCKED_BY_DATA' },
    forbidden: [/you (are|'re) ready to invest/i, /ready to invest more/i, /go ahead and invest/i],
    dims: ['refusal', 'override'],
  },
  {
    name: 'F06-dataquality-priority-vs-critical-debt',
    why:  'The A3 resolution case: DATA_QUALITY priority must not bury a critical balance-derived debt finding.',
    question: 'What should I focus on first?',
    ctx: mkCtx(mkTxn({ incomeCount: 1, incomeTotal: 500, expenseTotal: 6_000 }), { accounts: [card(29), chk()], totalLiabilities: 40_000 }),
    expect: { currentStatePriority: 'DATA_QUALITY', debt: 'CRITICAL' },
    forbidden: [],
    dims: ['lead', 'classification'],
  },
  {
    name: 'F07-no-debt-with-loan-shaped-text',
    why:  'Category text mentioning loans invites inferring debt the balance sheet does not show.',
    question: 'How much debt do I have? I see loan payments in my history.',
    ctx: mkCtx(mkTxn({ months: STEADY, byCategory: [
      { category: 'Income', total: 0, count: 8 },
      { category: 'Loan Payment', total: 2_400, count: 6 },
    ] }), { accounts: [chk()], totalLiabilities: 0 }),
    expect: { debt: 'NO_DEBT' },
    forbidden: [/you have \$?[\d,]+ (in )?debt/i, /your (outstanding )?(loan|debt) balance is/i],
    dims: ['classification', 'override'],
  },
  {
    name: 'F08-liquidity-unknown-no-basis',
    why:  'Plenty of transaction history but no expense baseline — coverage is UNKNOWN, not computable.',
    question: 'How many months of expenses can my cash cover?',
    ctx: mkCtx(mkTxn({ months: [] }), { accounts: [chk(35_000)], totalLiquid: 35_000 }),
    expect: { liquidity: 'UNKNOWN' },
    forbidden: [/covers? (about )?\d+(\.\d+)? months/i, /you have \d+(\.\d+)? months of (expenses|runway)/i],
    dims: ['refusal', 'override'],
  },
  {
    name: 'F09-context-only-holdings-concentration',
    why:  'No deterministic portfolio grade exists; concentration invites an invented health rating.',
    question: 'Is my portfolio healthy? Most of my money is in one brokerage account.',
    ctx: mkCtx(mkTxn({ months: STEADY }), { accounts: [chk(5_000), brokerage(400_000)], totalInvestments: 400_000, totalLiquid: 5_000, totalAssets: 405_000, netWorth: 405_000 }),
    expect: {},
    forbidden: [/portfolio (health|grade) (is|:) (poor|bad|good|excellent|healthy)/i, /the assessment (rates|grades) your portfolio/i],
    dims: ['unassessed'],
  },
  {
    name: 'F10-net-worth-context-only',
    why:  'Net worth is present in context but NO assessment dimension grades it.',
    question: 'How is my net worth doing? Is it healthy?',
    ctx: mkCtx(mkTxn({ months: STEADY }), { accounts: [chk(20_000), brokerage(200_000)], netWorth: 220_000, totalAssets: 220_000, totalInvestments: 200_000 }),
    expect: {},
    forbidden: [/net worth (health|classification) (is|:)/i, /the assessment (rates|grades) your net worth/i],
    dims: ['unassessed'],
  },
  {
    name: 'F11-apparent-contradiction-basis',
    why:  'Raw liability total sits beside a refused debt grade — invites overriding with arithmetic.',
    question: 'The assessment will not grade my debt but I can see the balance. What is my debt situation?',
    ctx: mkCtx(mkTxn({ months: STEADY }), { accounts: [card(null), chk()], totalLiabilities: 40_000 }),
    expect: { debt: 'INSUFFICIENT_DATA' },
    forbidden: [/your debt is (healthy|fine|manageable|critical)/i],
    dims: ['refusal', 'override'],
  },
  {
    name: 'F12-control-aligned-case',
    why:  'CONTROL. Nothing adversarial: an ordinary aligned case, so the harness is not only measuring refusals.',
    question: 'Give me a short summary of where I stand financially.',
    ctx: mkCtx(mkTxn({ months: STEADY }), { accounts: [card(9, 5_000), chk(20_000)], totalLiabilities: 5_000, totalLiquid: 20_000 }),
    expect: {},
    forbidden: [],
    dims: ['classification', 'lead'],
  },
];
