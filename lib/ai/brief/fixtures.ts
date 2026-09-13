/**
 * lib/ai/brief/fixtures.ts
 *
 * THE DAILY BRIEF GOLDEN SCENARIOS — pure evidence packages, and what a good
 * Brief over each must and must not say.
 *
 * ⚠️ PACKAGES, NOT DATABASES. Each scenario is the deterministic package code
 * would hand the model, so the same fixture drives the unit tests (with canned
 * narrations) and the live goldens (with the real model) without a single read.
 * The figures are internally consistent — net worth is liquid + investments −
 * debt — because a fixture whose numbers contradict each other tests the model's
 * tolerance for bad evidence, not its judgment.
 *
 * ⚠️ THE EXPECTATIONS ARE DELIBERATELY FEW. A golden that demands a sentence
 * tests prose; these test what a Brief must never do — invent urgency, call a
 * debt payment spending, narrate a window that was not measured, name a market,
 * speak another user's goal — plus the one thing each scenario exists to surface.
 */

import type { BriefPackage } from './types';

export interface BriefScenario {
  id:    string;
  title: string;
  pkg:   BriefPackage;
  expect: {
    /** The value `quiet` must take, when the scenario decides it. */
    quiet?: boolean;
    /** At least one must match the delivered text. */
    mentionsAny?: RegExp[];
    /** None may match the delivered text. */
    forbids?: RegExp[];
    /** A quiet day's ceiling: at most this many observations, none NOTABLE. */
    quietCeiling?: number;
  };
}

/** Checked on every scenario's delivered text. */
export const GLOBAL_FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'urgency', pattern: /\b(urgent|urgently|immediately|alarming|act now|asap|right away|crisis|emergency)\b/i },
  { name: 'market causality', pattern: /\bmarkets?\b|\bsell-?off\b|\brally\b/i },
  { name: 'markdown', pattern: /\*\*|^#|^\s*[-*] /m },
  { name: 'internal vocabulary',
    pattern: /\b(SAFE|HEALTHY|RELIABLE|UNRELIABLE|INSUFFICIENT_DATA|NO_DEBT|HIGHLY_CONCENTRATED|NOTABLE|CONTEXT|DEBT_PAYMENT|VERY_STALE|recentChanges|recentActivity|currentState|dataQuality|d1|w1|m1)\b/ },
];

export function basePackage(): BriefPackage {
  return {
    identity: { briefDay: '2026-09-13', asOf: '2026-09-13', currency: 'USD', basis: 'CURRENT' },
    freshness: {
      band: 'LIVE', basis: 'INGESTION',
      oldestBalanceObservedAt: '2026-09-13T06:04:11.000Z', oldestBalanceAgeDays: 0.3,
      staleAccounts: 0, unknownFreshnessAccounts: 0, needsReauth: false,
    },
    currentState: {
      basis: 'CURRENT_ACCOUNTS',
      netWorth: 128450.22, liquid: 18920.40, debt: 3210.55,
      investments: { traditional: 84300.10, digital: 28440.27, combined: 112740.37 },
    },
    recentChanges: {
      d1: { from: '2026-09-12', to: '2026-09-13',
        netWorth: { abs: 212.35, pct: 0.2 }, liquid: { abs: -48.12, pct: -0.3 },
        investments: { abs: 240.10, pct: 0.3 }, digitalAssets: { abs: 20.37, pct: 0.1 },
        debt: { abs: 0, pct: 0 } },
      w1: { from: '2026-09-06', to: '2026-09-13',
        netWorth: { abs: 640.18, pct: 0.5 }, liquid: { abs: 310.44, pct: 1.7 },
        investments: { abs: 402.90, pct: 0.5 }, digitalAssets: { abs: -73.16, pct: -0.3 },
        debt: { abs: 0, pct: 0 } },
      m1: { from: '2026-08-13', to: '2026-09-13',
        netWorth: { abs: 2140.66, pct: 1.7 }, liquid: { abs: 1180.25, pct: 6.7 },
        investments: { abs: 1204.50, pct: 1.4 }, digitalAssets: { abs: -244.09, pct: -0.9 },
        debt: { abs: 0, pct: 0 } },
    },
    recentActivity: {
      from: '2026-09-07', to: '2026-09-13', days: 7, complete: true, transactionsInWindow: 23,
      top: [
        { date: '2026-09-10', amount: -142.18, flow: 'SPENDING', merchant: 'Whole Foods Market', category: 'Groceries' },
        { date: '2026-09-08', amount: -86.40, flow: 'SPENDING', merchant: 'Shell', category: 'Transportation' },
        { date: '2026-09-11', amount: -64.99, flow: 'SPENDING', merchant: 'Amazon', category: 'Shopping' },
        { date: '2026-09-12', amount: -38.25, flow: 'SPENDING', merchant: 'Chipotle', category: 'Dining' },
        { date: '2026-09-09', amount: -15.00, flow: 'SPENDING', merchant: 'Spotify', category: 'Entertainment' },
      ],
    },
    behavior: {
      window: { from: '2026-06-15', to: '2026-09-13', days: 90 },
      monthlyIncome: 9620.00, monthlyExpenses: 6240.35, monthlyDebtPayments: 1850.10,
      cashFlowReliability: 'RELIABLE', incomeConfidence: 'HIGH', deficitCause: 'NOT_APPLICABLE',
      liquidity: { classification: 'SAFE', coverageMonths: 3.0 },
      debt: { classification: 'HEALTHY', aprCompleteness: 'FULL' },
    },
    dataQuality: {
      historyDays: 412, transactionHistory: 'HIGH', knowledgeGaps: [], ungraded: [],
      unvaluedPositions: 0, totalsEstimated: false, totalsUnconverted: false,
    },
  };
}

function scenario(
  id: string, title: string, mutate: (p: BriefPackage) => void, expect: BriefScenario['expect'],
): BriefScenario {
  const pkg = basePackage();
  mutate(pkg);
  return { id, title, pkg, expect };
}

export const BRIEF_SCENARIOS: BriefScenario[] = [
  scenario('01-quiet', 'quiet day — nothing meaningful changed', () => {}, { quiet: true, quietCeiling: 1 }),

  scenario('02-paycheck', 'paycheck arrived', (p) => {
    p.recentActivity!.top = [
      { date: '2026-09-12', amount: 4812.66, flow: 'INCOME', merchant: 'Acme Corp Payroll', category: 'Income' },
      ...p.recentActivity!.top.slice(0, 4),
    ];
    p.recentChanges.d1 = { from: '2026-09-12', to: '2026-09-13',
      netWorth: { abs: 4976.89, pct: 4.0 }, liquid: { abs: 4764.54, pct: 33.7 },
      investments: { abs: 192.00, pct: 0.2 }, digitalAssets: { abs: 20.35, pct: 0.1 },
      debt: { abs: 0, pct: 0 } };
  }, {
    mentionsAny: [/paycheck|payroll|income|deposit|acme|pay\b/i],
    forbids: [/\bspen(t|ding)\b[^.]{0,30}4,8/i],
  }),

  scenario('03-large-expense', 'large one-off expense', (p) => {
    p.recentActivity!.top = [
      { date: '2026-09-11', amount: -2480.00, flow: 'SPENDING', merchant: 'Delta Air Lines', category: 'Travel' },
      ...p.recentActivity!.top.slice(0, 4),
    ];
    p.recentChanges.w1 = { from: '2026-09-06', to: '2026-09-13',
      netWorth: { abs: -1766.66, pct: -1.4 }, liquid: { abs: -2169.56, pct: -10.3 },
      investments: { abs: 402.90, pct: 0.5 }, digitalAssets: { abs: 0, pct: 0 },
      debt: { abs: 0, pct: 0 } };
  }, { quiet: false, mentionsAny: [/delta|flight|travel|air/i] }),

  scenario('04-card-payoff', 'card debt paid off', (p) => {
    p.currentState.debt = 0;
    p.currentState.netWorth = 128450.22;
    p.currentState.liquid = 15709.85;
    p.currentState.investments = { traditional: 84300.10, digital: 28440.27, combined: 112740.37 };
    p.recentActivity!.top = [
      { date: '2026-09-12', amount: -3210.55, flow: 'DEBT_PAYMENT', merchant: 'Chase Card Payment', category: 'Payment', betweenOwnAccounts: true },
      { date: '2026-09-12', amount: 3210.55, flow: 'DEBT_PAYMENT', merchant: 'Payment Thank You', category: 'Payment', betweenOwnAccounts: true },
      ...p.recentActivity!.top.slice(0, 3),
    ];
    p.recentChanges.d1 = { from: '2026-09-12', to: '2026-09-13',
      netWorth: { abs: 0, pct: 0 }, liquid: { abs: -3210.55, pct: -17.0 },
      investments: { abs: 0, pct: 0 }, digitalAssets: { abs: 0, pct: 0 },
      debt: { abs: -3210.55, pct: -100.0 } };
    p.behavior!.debt = { classification: 'NO_DEBT', aprCompleteness: 'FULL' };
  }, {
    quiet: false,
    mentionsAny: [/pa(id|y(ing|ment))[^.]{0,60}(card|debt|off|balance)|debt[^.]{0,40}(zero|paid|clear|gone|free)|no (remaining )?debt/i],
    forbids: [
      /\bspen(t|ding)\b[^.]{0,40}3,2|3,2[0-9.,]*K?[^.]{0,40}\bspen(t|ding)\b/i,
      /6,42[01]|\$6\.4K/i,
    ],
  }),

  scenario('05-crypto-down', 'crypto down about 15% on the week', (p) => {
    p.currentState.netWorth = 124829.82;
    p.currentState.investments = { traditional: 84300.10, digital: 24819.87, combined: 109119.97 };
    p.recentChanges.w1 = { from: '2026-09-06', to: '2026-09-13',
      netWorth: { abs: -3979.97, pct: -3.1 }, liquid: { abs: 310.44, pct: 1.7 },
      investments: { abs: -330.36, pct: -0.4 }, digitalAssets: { abs: -3960.05, pct: -15.0 },
      debt: { abs: 0, pct: 0 } };
    p.recentChanges.d1!.digitalAssets = { abs: -1480.22, pct: -5.6 };
  }, { quiet: false, mentionsAny: [/crypto|digital/i] }),

  scenario('06-concentrated', 'one holding is ~45% of investments', (p) => {
    p.currentState.concentration = {
      classification: 'HIGHLY_CONCENTRATED', topSymbol: 'NVDA', topWeightPct: 45.2,
      populationValue: 84300.10, populationIsComplete: true,
    };
  }, { mentionsAny: [/NVDA|concentrat/i] }),

  // From the first live real-data Brief: the weight was 99.6% of the DIGITAL
  // population only, and the model called the whole portfolio concentrated and
  // used that to explain net-worth swings. A share needs its denominator.
  scenario('06b-concentration-partial', 'one coin is ~100% of a partial population', (p) => {
    p.currentState.concentration = {
      classification: 'HIGHLY_CONCENTRATED', topSymbol: 'BTC', topWeightPct: 99.6,
      populationValue: 28440.27, populationIsComplete: false,
    };
  }, { forbids: [
    /(portfolio|all (of )?your investments|your investments) (is|are) (now )?(highly |very |heavily )?concentrated|most of your investments/i,
    /explains? (why|the)|helps explain|which is why|that is why/i,
  ] }),

  scenario('07-cash-down', 'liquid cash down materially over the month', (p) => {
    p.currentState.liquid = 11820.40;
    p.currentState.netWorth = 121350.22;
    p.recentChanges.m1 = { from: '2026-08-13', to: '2026-09-13',
      netWorth: { abs: -5195.50, pct: -4.1 }, liquid: { abs: -6400.00, pct: -35.1 },
      investments: { abs: 1204.50, pct: 1.4 }, digitalAssets: { abs: 0, pct: 0 },
      debt: { abs: 0, pct: 0 } };
    p.recentChanges.w1!.liquid = { abs: -1520.30, pct: -11.4 };
    p.behavior!.monthlyExpenses = 11240.35;
    p.behavior!.deficitCause = 'POSSIBLE_OVERSPENDING';
    p.behavior!.liquidity = { classification: 'WARNING', coverageMonths: 1.1 };
  }, { quiet: false, mentionsAny: [/cash|liquid|savings|checking/i] }),

  scenario('08-near-goal', 'within 5% of a net-worth goal', (p) => {
    p.currentState = {
      basis: 'CURRENT_ACCOUNTS', netWorth: 712300.00, liquid: 48920.40, debt: 3210.55,
      investments: { traditional: 610000.00, digital: 56590.15, combined: 666590.15 },
    };
    p.recentChanges.m1!.netWorth = { abs: 9820.50, pct: 1.4 };
    p.plans = {
      goals: [{ metric: 'netWorth', targetAmount: 750000, byDate: '2027-06-30',
        current: 712300.00, remaining: 37700.00, progressPct: 95.0 }],
      planned: [],
    };
  }, { mentionsAny: [/goal|750|95/i] }),

  scenario('09-stale', 'provider data is stale', (p) => {
    p.freshness = {
      band: 'STALE', basis: 'INGESTION',
      oldestBalanceObservedAt: '2026-09-01T06:02:00.000Z', oldestBalanceAgeDays: 12.3,
      staleAccounts: 3, unknownFreshnessAccounts: 0, needsReauth: false,
    };
    delete p.recentChanges.d1;
    p.recentActivity!.transactionsInWindow = 2;
    p.recentActivity!.top = p.recentActivity!.top.slice(3);
  }, { mentionsAny: [/stale|out of date|not (been )?(updated|refreshed)|last (updated|checked|refreshed|synced)|12 days|may not reflect|older|behind/i] }),

  scenario('10-needs-reauth', 'a connection needs re-authentication', (p) => {
    p.freshness = { ...p.freshness!, band: 'RECENT', oldestBalanceAgeDays: 3.4,
      oldestBalanceObservedAt: '2026-09-09T22:10:00.000Z', needsReauth: true };
  }, { quiet: false, mentionsAny: [/reconnect|re-?authori|reauth|sign in|log in|connection|relink|re-link/i] }),

  scenario('11-apr-gaps', 'missing APR on two cards', (p) => {
    p.currentState.debt = 5412.80;
    p.currentState.netWorth = 126247.97;
    p.dataQuality.knowledgeGaps = [
      { account: 'Chase Sapphire', missing: 'APR' },
      { account: 'Amex Gold', missing: 'APR' },
    ];
    p.dataQuality.ungraded = [{ section: 'debt', reason: 'APR_MISSING' }];
    p.behavior!.debt = { classification: 'INSUFFICIENT_DATA', aprCompleteness: 'NONE' };
  }, {}),

  scenario('12-no-debt', 'no debt at all', (p) => {
    p.currentState.debt = 0;
    p.currentState.netWorth = 131660.77;
    p.behavior!.monthlyDebtPayments = 0;
    p.behavior!.debt = { classification: 'NO_DEBT', aprCompleteness: 'FULL' };
  }, { forbids: [/paid (off|down)|pay(ing)? (off|down)|payoff|interest (rate|charges)/i] }),

  scenario('13-three-weeks', 'only ~3 weeks of history — the month window is refused', (p) => {
    delete p.recentChanges.m1;
    p.dataQuality.historyDays = 21;
    p.dataQuality.transactionHistory = 'LOW';
    p.dataQuality.ungraded = [{ section: 'cashFlow', reason: 'INSUFFICIENT_HISTORY' }];
    p.behavior = {
      window: { from: '2026-06-15', to: '2026-09-13', days: 90 },
      monthlyIncome: null, monthlyExpenses: null, monthlyDebtPayments: null,
      cashFlowReliability: 'UNRELIABLE', incomeConfidence: 'LOW', deficitCause: 'LOW_INCOME_SAMPLE',
      liquidity: { classification: 'UNKNOWN', coverageMonths: null },
      debt: { classification: 'HEALTHY', aprCompleteness: 'FULL' },
    };
  }, { forbids: [/\b(past|last|this|prior) month\b|\bover the month\b|\b30[- ]days?\b|month-over-month|since (mid-)?august|\bmonthly (average|income|spending)/i] }),

  scenario('14a-shared-owner-a', 'shared Space — owner A has a $1M goal', (p) => {
    p.plans = {
      goals: [{ metric: 'netWorth', targetAmount: 1000000, byDate: '2030-12-31',
        current: 128450.22, remaining: 871549.78, progressPct: 12.8 }],
      planned: [],
    };
  }, { forbids: [/kitchen|remodel|40,000|\$40K/i] }),

  scenario('14b-shared-owner-b', 'shared Space — owner B plans a kitchen remodel', (p) => {
    p.plans = { goals: [], planned: [{ label: 'Kitchen remodel', amount: 40000 }] };
  }, { forbids: [/1,000,000|\$1M\b|1 million|871,5|\$871/i] }),

  scenario('15-quiet-again', 'second consecutive quiet day', (p) => {
    p.recentChanges.d1 = { from: '2026-09-12', to: '2026-09-13',
      netWorth: { abs: -35.10, pct: 0 }, liquid: { abs: -12.40, pct: -0.1 },
      investments: { abs: -18.20, pct: 0 }, digitalAssets: { abs: -4.50, pct: 0 },
      debt: { abs: 0, pct: 0 } };
    p.recentActivity!.top = p.recentActivity!.top.slice(1);
    p.recentActivity!.transactionsInWindow = 17;
  }, { quiet: true, quietCeiling: 1 }),
];
