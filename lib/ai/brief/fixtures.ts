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
 * ⚠️ VERDICTS AND EVIDENCE ARE DERIVED, NOT TYPED IN. Every scenario is graded by
 * the engine's own ladders (`gradeDebtRate`, `gradeLiquidityCoverage`,
 * `computeDebtBurden`) and its claim evidence is built by `claimEvidence` from a
 * fixture source list — so a golden cannot hand the model a classification whose
 * reason contradicts its figures, or a stale source attached to a claim it does
 * not feed. A scenario states FACTS (what is owed, at what rate, which source is
 * behind); the contract is computed from them.
 *
 * ⚠️ EVERY EXPECTATION HERE IS MODEL-SAMPLED. They are run by
 * scripts/ai-baseline/daily-brief.check.ts against the real model and reported as
 * rates. What is DETERMINISTIC about the same contract — the reason a
 * classification carries, which sources a claim lists, which observation code
 * drops — is asserted in package.test.ts, claim-evidence.test.ts and
 * generate.test.ts, never here.
 *
 * ⚠️ THE EXPECTATIONS ARE DELIBERATELY FEW. A golden that demands a sentence
 * tests prose; these test what a Brief must never do — invent urgency, call a
 * debt payment spending, narrate a window that was not measured, name a market,
 * speak another user's goal — plus the one thing each scenario exists to surface.
 */

import {
  computeDebtBurden, gradeDebtRate, gradeLiquidityCoverage, liquidityReason, ungradedDebtReason,
} from '@/lib/ai/intelligence/annotations/classification-reason';
import type { DataSourceView, SpaceDataHealth } from '@/lib/connections/space-data-health.core';
import { claimEvidence, claimsReachedBy } from './claim-evidence';
import type { BriefPackage, ObservationKind } from './types';

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
    /** None may match the HEADLINE (the prompt keeps connections and freshness out of it). */
    headlineForbids?: RegExp[];
    /**
     * Claim-scoped freshness, both directions. An observation of one of
     * `mustNotQualifyKinds` must NOT call its figures out of date (its claim's
     * sources are current, whatever is stale elsewhere); one of `mustQualifyKinds`
     * MUST (its claim rests on a source that is behind). Judged per observation.
     */
    mustNotQualifyKinds?: ObservationKind[];
    mustQualifyKinds?: ObservationKind[];
  };
}

/** Wording that qualifies a figure as possibly out of date, or names a connection problem. */
export const QUALIFIES_AS_STALE =
  /out of date|outdated|\bstale\b|not (been |yet )?(updated|refreshed|synced)|hasn['’]t (been )?(updated|refreshed|synced)|last (updated|refreshed|synced)|may not reflect|might not reflect|reconnect|re-?authori|needs? (to be )?(re)?connect|as of (aug|sep|\d)|older data|behind/i;

/** Checked on every scenario's delivered text. */
export const GLOBAL_FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'urgency', pattern: /\b(urgent|urgently|immediately|alarming|act now|asap|right away|crisis|emergency)\b/i },
  { name: 'market causality', pattern: /\bmarkets?\b|\bsell-?off\b|\brally\b/i },
  { name: 'markdown', pattern: /\*\*|^#|^\s*[-*] /m },
  { name: 'internal vocabulary',
    pattern: /\b(SAFE|HEALTHY|CRITICAL|WARNING|EXCELLENT|IMPROVING|RELIABLE|UNRELIABLE|INSUFFICIENT_DATA|NO_DEBT|HIGHLY_CONCENTRATED|NOTABLE|CONTEXT|DEBT_PAYMENT|VERY_STALE|LIABILITY|LIQUID|RATE_ON_OWED_BALANCE|WEIGHTED_APR_\w+|COVERAGE_\w+|recentChanges|recentActivity|currentState|dataQuality|claimEvidence|reasonCode|reasonMetrics|debtRate|debtBurden|d1|w1|m1)\b/ },
];

// ── Derivation: a scenario states facts, the contract is computed ────────────

/** What a scenario says about its debt: the blended rate (null = an APR is missing) and how many accounts. */
export interface DebtFacts { aprPct: number | null; accounts: number }
const DEFAULT_DEBT: DebtFacts = { aprPct: 11.9, accounts: 1 };

const src = (label: string, kind: DataSourceView['kind'], feeds: NonNullable<DataSourceView['feeds']>,
  over: Partial<DataSourceView> = {}): DataSourceView => ({
  kind, label, state: 'CURRENT', lastUpdatedAt: '2026-09-13T06:04:11.000Z', accountCount: feeds.length,
  needsAttention: false, actionable: true, feeds, ...over,
});

/** The sources behind the fixture Space: one bank for cash and the card, one brokerage, one wallet. */
export function fixtureSources(over: { bank?: Partial<DataSourceView>; brokerage?: Partial<DataSourceView>; wallet?: Partial<DataSourceView> } = {}): SpaceDataHealth {
  const sources = [
    src('Chase', 'BANK', ['liquid', 'liabilities', 'bankingRows'], over.bank),
    src('Charles Schwab', 'BANK', ['investments'], over.brokerage),
    src('Ledger Wallet', 'WALLET', ['digitalAssets'], over.wallet),
  ];
  return { sources, groups: [], attention: sources.filter((x) => x.needsAttention).length };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const p1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Grade a CURRENT package from its own figures, exactly as `projectBriefPackage`
 * would from an assessment: liquidity, the debt RATE with its reason, the debt
 * burden, and the claim evidence for the given sources.
 */
export function deriveContract(p: BriefPackage, debt: DebtFacts = DEFAULT_DEBT, health: SpaceDataHealth = fixtureSources()): void {
  const b = p.behavior;
  if (b && p.identity.basis === 'CURRENT') {
    const liquid = p.currentState.liquid ?? 0;
    const months = b.monthlyExpenses && b.monthlyExpenses > 0 ? r2(liquid / b.monthlyExpenses) : null;
    const graded = months === null ? { classification: 'UNKNOWN' as const, reasonCode: 'NO_EXPENSE_BASELINE' as const }
      : gradeLiquidityCoverage(months);
    const lr = liquidityReason({ reasonCode: graded.reasonCode, coverageMonths: months, liquid,
      monthlyExpenses: b.monthlyExpenses, monthlyExpensesBasis: months === null ? null : (b.monthlyExpensesBasis ?? 'MEASURED'),
      liquidAccounts: 2 });
    b.liquidity = { classification: graded.classification, scope: lr.scope, reasonCode: lr.reasonCode,
      reasonMetrics: lr.reasonMetrics, confidence: months === null ? 'LOW' : 'HIGH',
      evidencePopulation: lr.evidencePopulation, coverageMonths: months === null ? null : p1(months) };

    const owed = p.currentState.debt ?? 0;
    const population = { debtAccounts: debt.accounts, debtAccountsWithApr: debt.aprPct === null ? 0 : debt.accounts };
    const rate = owed === 0 ? { classification: 'NO_DEBT' as const, reason: ungradedDebtReason('NO_LIABILITIES', population) }
      : debt.aprPct === null ? { classification: 'INSUFFICIENT_DATA' as const, reason: ungradedDebtReason('APR_UNKNOWN', population) }
      : gradeDebtRate({ weightedAprPct: debt.aprPct, ratedOwed: owed,
          liabilitiesChangeAbs: p.recentChanges.m1?.debt?.abs ?? null, ...population });
    b.debtRate = { classification: rate.classification, scope: rate.reason.scope, reasonCode: rate.reason.reasonCode,
      reasonMetrics: rate.reason.reasonMetrics, confidence: rate.classification === 'INSUFFICIENT_DATA' ? 'LOW' : 'HIGH',
      evidencePopulation: rate.reason.evidencePopulation,
      aprCompleteness: owed > 0 && debt.aprPct === null ? 'NONE' : 'FULL' };
    // As package.ts: the burden rides only with a flagged rate.
    if (owed > 0 && (rate.classification === 'WARNING' || rate.classification === 'CRITICAL')) {
      const interest = debt.aprPct === null ? null : r2(owed * debt.aprPct / 100 / 12);
      const burden = computeDebtBurden({ ratedOwed: debt.aprPct === null ? 0 : owed, monthlyInterestIfCarried: interest,
        totalLiabilities: owed, monthlyIncome: b.monthlyIncome, monthlyExpenses: b.monthlyExpenses, liquid });
      b.debtBurden = {
        ratedOwed: burden.ratedOwed, monthlyInterestIfCarried: burden.monthlyInterestIfCarried,
        interestOfMonthlyIncomePct: burden.interestOfMonthlyIncomePct,
        interestOfMonthlyExpensesPct: burden.interestOfMonthlyExpensesPct,
        owedOfLiquidPct: burden.owedOfLiquidPct,
        comparedWith: { monthlyIncome: burden.monthlyIncome, monthlyExpenses: burden.monthlyExpenses, liquid: burden.liquid },
      };
    } else delete b.debtBurden;
  }
  if (p.identity.basis === 'CURRENT') {
    const evidence = claimEvidence({ health, asOf: p.identity.asOf, bankingPopulationKnown: true });
    if (evidence) {
      p.claimEvidence = evidence;
      const stale = health.sources.filter((x) => x.needsAttention)
        .map((x) => ({ label: x.label, state: x.state, lastUpdated: x.lastUpdatedAt?.slice(0, 10) ?? null,
          affects: claimsReachedBy(x, { asOf: p.identity.asOf, bankingPopulationKnown: true }) }));
      if (p.freshness) {
        if (stale.length > 0) { p.freshness.staleSources = stale; p.freshness.connectionsNeedingAttention = stale.length; }
        else delete p.freshness.staleSources;
      }
    }
  }
}

export function basePackage(): BriefPackage {
  const pkg = ungradedBase();
  deriveContract(pkg);
  return pkg;
}

function ungradedBase(): BriefPackage {
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
        { date: '2026-09-10', amount: -142.18, flow: 'SPENDING', merchant: 'Whole Foods Market', category: 'Groceries', account: 'LIQUID' },
        { date: '2026-09-08', amount: -86.40, flow: 'SPENDING', merchant: 'Shell', category: 'Transportation', account: 'LIQUID' },
        { date: '2026-09-11', amount: -64.99, flow: 'SPENDING', merchant: 'Amazon', category: 'Shopping', account: 'LIQUID' },
        { date: '2026-09-12', amount: -38.25, flow: 'SPENDING', merchant: 'Chipotle', category: 'Dining', account: 'LIQUID' },
        { date: '2026-09-09', amount: -15.00, flow: 'SPENDING', merchant: 'Spotify', category: 'Entertainment', account: 'LIQUID' },
      ],
    },
    behavior: {
      window: { from: '2026-06-15', to: '2026-09-13', days: 90 },
      monthlyIncome: 9620.00, monthlyExpenses: 6240.35, monthlyDebtPayments: 1850.10,
      cashFlowReliability: 'RELIABLE', incomeConfidence: 'HIGH', deficitCause: 'NOT_APPLICABLE',
      // liquidity / debtRate / debtBurden are derived from the figures above (deriveContract).
    },
    dataQuality: {
      historyDays: 412, transactionHistory: 'HIGH', knowledgeGaps: [], ungraded: [],
      unvaluedPositions: 0, totalsEstimated: false, totalsUnconverted: false,
    },
  };
}

function scenario(
  id: string, title: string, mutate: (p: BriefPackage) => void, expect: BriefScenario['expect'],
  facts: { debt?: DebtFacts; health?: SpaceDataHealth } = {},
): BriefScenario {
  const pkg = ungradedBase();
  mutate(pkg);
  deriveContract(pkg, facts.debt, facts.health);
  return { id, title, pkg, expect };
}

export const BRIEF_SCENARIOS: BriefScenario[] = [
  // ⚠️ KNOWN FAILING, AND DELIBERATELY LEFT FAILING (0/5 before this contract, 0/10
  // after; 15-quiet-again was 0/5 before and shares the cause). `quiet` itself is
  // right 10/10 — what fails is
  // the CEILING: the model writes two CONTEXT observations, always the same two
  // ("cash buffer covers about three months", "debt is modest"), despite "a steady
  // cash buffer is not an observation by itself". The cause is structural, not
  // wording: STANDING classifications (liquidity, the debt rate) are in the package
  // every day, so they are narrated every day — the wallpaper defect relevance.ts
  // fixed for concentration. The deterministic cure is to extend those standing
  // facts to the classifications (shown when NEW or CHANGED, or when their balance
  // moved), and that needs a product decision this slice does not own: whether a
  // standing WARNING/CRITICAL cash buffer may go unsaid on day two. Trimming in
  // code instead would hide the attempt, which this harness counts on purpose.
  // The expectation stands as the target; it is not loosened to pass.
  scenario('01-quiet', 'quiet day — nothing meaningful changed', () => {}, { quiet: true, quietCeiling: 1 }),

  scenario('02-paycheck', 'paycheck arrived', (p) => {
    p.recentActivity!.top = [
      { date: '2026-09-12', amount: 4812.66, flow: 'INCOME', merchant: 'Acme Corp Payroll', category: 'Income', account: 'LIQUID' },
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
      { date: '2026-09-11', amount: -2480.00, flow: 'SPENDING', merchant: 'Delta Air Lines', category: 'Travel', account: 'LIQUID' },
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
      { date: '2026-09-12', amount: -3210.55, flow: 'DEBT_PAYMENT', merchant: 'Chase Card Payment', category: 'Payment', betweenOwnAccounts: true, account: 'LIQUID' },
      { date: '2026-09-12', amount: 3210.55, flow: 'DEBT_PAYMENT', merchant: 'Payment Thank You', category: 'Payment', betweenOwnAccounts: true, account: 'LIABILITY' },
      ...p.recentActivity!.top.slice(0, 3),
    ];
    p.recentChanges.d1 = { from: '2026-09-12', to: '2026-09-13',
      netWorth: { abs: 0, pct: 0 }, liquid: { abs: -3210.55, pct: -17.0 },
      investments: { abs: 0, pct: 0 }, digitalAssets: { abs: 0, pct: 0 },
      debt: { abs: -3210.55, pct: -100.0 } };
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
    // ⇒ derived: 11,820.40 ÷ 11,240.35 = 1.05 months, WARNING (below 3).
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
  }, {
    // ⚠️ CORRECTED EXPECTATION. This demanded that the Brief MENTION stale data —
    // written for the first Brief contract (0e1cf1e). Since Slice 4.1 (b025468)
    // the prompt says the opposite: the page shows freshness, so no observation
    // may only report it and the headline may not mention it at all. The golden
    // sampled 1/5 against an instruction it contradicted. It now asserts what the
    // prompt asks: a clean headline, and — the bank being what is behind — that a
    // cash, debt or spending observation, IF one is written, is qualified, while
    // an investment one is not.
    headlineForbids: [QUALIFIES_AS_STALE, /connection/i],
    mustQualifyKinds: ['CASH', 'DEBT', 'SPENDING'],
    mustNotQualifyKinds: ['INVESTMENTS'],
  }, { health: fixtureSources({ bank: { state: 'OUT_OF_DATE', needsAttention: true, lastUpdatedAt: '2026-09-01T06:02:00.000Z' } }) }),

  scenario('10-needs-reauth', 'a connection needs re-authentication', (p) => {
    p.freshness = { ...p.freshness!, band: 'RECENT', oldestBalanceAgeDays: 3.4,
      oldestBalanceObservedAt: '2026-09-09T22:10:00.000Z', needsReauth: true };
  }, {
    // ⚠️ CORRECTED EXPECTATION. `quiet: false` + "must mention reconnecting" also
    // predates Slice 4.1: a connection needing re-authorisation is the page's to
    // show, is not NOTABLE under the prompt's own definition, and may not appear in
    // the headline. Sampled 0/5 against the instruction. It now asserts the
    // prompt, and the claim scoping: the brokerage is what needs reconnecting, so
    // cash, debt and spending observations carry NO freshness caveat.
    headlineForbids: [QUALIFIES_AS_STALE, /connection|sign in|log in|relink/i],
    mustNotQualifyKinds: ['CASH', 'DEBT', 'SPENDING'],
  }, { health: fixtureSources({ brokerage: { state: 'NEEDS_RECONNECT', needsAttention: true, lastUpdatedAt: '2026-09-09T22:10:00.000Z' } }) }),

  scenario('11-apr-gaps', 'missing APR on two cards', (p) => {
    p.currentState.debt = 5412.80;
    p.currentState.netWorth = 126247.97;
    p.dataQuality.knowledgeGaps = [
      { account: 'Chase Sapphire', missing: 'APR' },
      { account: 'Amex Gold', missing: 'APR' },
    ];
    p.dataQuality.ungraded = [{ section: 'debt', reason: 'APR_MISSING' }];
  }, {}, { debt: { aprPct: null, accounts: 2 } }),

  scenario('12-no-debt', 'no debt at all', (p) => {
    p.currentState.debt = 0;
    p.currentState.netWorth = 131660.77;
    p.behavior!.monthlyDebtPayments = 0;
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
      // ⇒ derived: no expense baseline, so liquidity is UNKNOWN; the rate still grades.
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

  // ── The forensic case (investigation §12a) ────────────────────────────────
  // (Synthetic figures, the real case's shape.) $1,600 across two cards at a blended
  // 24.44%: the RATE is above the critical threshold and the cost is ~$33 a month if
  // carried, 0.3% of income. Real Briefs over the real case
  // said "debt remains in a critical zone", "the most severe tier, driven by how
  // you've been using and repaying it", "a tight debt situation". A high rate is
  // never hidden — it may be said — but a rate is not a situation.
  scenario('16-high-rate-small-balance', 'high APR on a small balance — a rate, not a debt crisis', (p) => {
    p.currentState.debt = 1600.00;
    p.currentState.netWorth = 130060.77;
  }, {
    // The high APR must NOT be hidden because the balance is small …
    mentionsAny: [/\brate\b|interest|APR/i],
    // … and must not be inflated into a verdict on the user's debt. No `quiet`
    // expectation: whether a 25% rate costing ~$25 a month "deserves attention
    // today" is the model's importance judgement, and it is not stable — sampled
    // NOTABLE 5/5, CONTEXT 5/5 and NOTABLE 5/5 across three package variants while
    // the FRAMING below held 15/15. What stops it being said every day is
    // relevance (a standing classification is not news), not this golden.
    forbids: [
      /most (severe|stressed|serious)|critical (zone|tier|level|territory|state)|severe tier|tight debt/i,
      /debt (situation|position|picture|health)[^.]{0,40}(critical|severe|serious|stressed)|(critical|severe|serious)[^.]{0,20}debt (situation|position|picture)/i,
      /how you(['’]ve| have) been (using|repaying|paying)|(using|use) and (repaying|repay)/i,
    ],
  }, { debt: { aprPct: 24.44, accounts: 2 } }),

  // The same rate where it costs real money: ~$782 a month if carried, 8.1% of
  // income and twice the liquid buffer. The rate AND the burden are the news.
  scenario('17-high-rate-large-balance', 'the same APR on a large balance — the burden is the news', (p) => {
    p.currentState.debt = 38400.00;
    p.currentState.netWorth = 93260.77;
  }, {
    quiet: false,
    mentionsAny: [/interest|rate|APR/i],
    forbids: [/how you(['’]ve| have) been (using|repaying|paying)|(using|use) and (repaying|repay)/i],
  }, { debt: { aprPct: 24.44, accounts: 2 } }),

  // ── Claim-scoped freshness, both directions ───────────────────────────────
  // The brokerage has been silent for four weeks and needs reconnecting. Card debt
  // rose this week through a purchase that posted ON the card. Real Briefs wrote
  // "this view could be out of date because Charles Schwab data is over a month
  // old" about exactly this kind of debt claim. The brokerage feeds investments,
  // priced positions and net worth — and nothing else.
  scenario('18-stale-brokerage-debt-claim', 'a stale brokerage must not qualify a debt claim', (p) => {
    p.freshness = { ...p.freshness!, band: 'VERY_STALE', oldestBalanceObservedAt: '2026-08-10T09:15:00.000Z',
      oldestBalanceAgeDays: 33.9, staleAccounts: 1, needsReauth: true };
    p.recentActivity!.top = [
      { date: '2026-09-11', amount: -2480.00, flow: 'SPENDING', merchant: 'Delta Air Lines', category: 'Travel', account: 'LIABILITY' },
      ...p.recentActivity!.top.slice(0, 4),
    ];
    p.recentChanges.w1 = { from: '2026-09-06', to: '2026-09-13',
      netWorth: { abs: -2242.72, pct: -1.7 }, liquid: { abs: 310.44, pct: 1.7 },
      investments: { abs: 0, pct: 0 }, digitalAssets: { abs: -73.16, pct: -0.3 },
      debt: { abs: 2480.00, pct: null, from: 730.55 } };
  }, {
    quiet: false,
    mentionsAny: [/debt|card|owe/i],
    mustNotQualifyKinds: ['DEBT', 'CASH', 'SPENDING'],
  }, { health: fixtureSources({ brokerage: { state: 'NEEDS_RECONNECT', needsAttention: true, lastUpdatedAt: '2026-08-10T09:15:00.000Z' } }) }),

  // The same stale brokerage, where it DOES matter: part of the traditional
  // investments figure is four weeks old, so a conclusion about a sharp investment
  // move must say so — and still say nothing of the kind about cash or debt.
  scenario('19-stale-brokerage-investment-claim', 'the same stale brokerage must qualify an investment claim', (p) => {
    p.freshness = { ...p.freshness!, band: 'VERY_STALE', oldestBalanceObservedAt: '2026-08-10T09:15:00.000Z',
      oldestBalanceAgeDays: 33.9, staleAccounts: 1, needsReauth: true };
    p.recentChanges.w1 = { from: '2026-09-06', to: '2026-09-13',
      netWorth: { abs: -9562.72, pct: -6.9 }, liquid: { abs: 310.44, pct: 1.7 },
      investments: { abs: -9800.00, pct: -10.4 }, digitalAssets: { abs: -73.16, pct: -0.3 },
      debt: { abs: 0, pct: 0 } };
  }, {
    // No `quiet` / `mentionsAny`: whether a weekly investment move is NOTABLE is the
    // model's importance judgement (sampled 1/5 NOTABLE here) and not what this
    // scenario is for. What it pins is the claim scoping, per observation.
    mustQualifyKinds: ['INVESTMENTS'],
    mustNotQualifyKinds: ['DEBT', 'CASH', 'SPENDING'],
  }, { health: fixtureSources({ brokerage: { state: 'NEEDS_RECONNECT', needsAttention: true, lastUpdatedAt: '2026-08-10T09:15:00.000Z' } }) }),

  // ── A type-attested debt payment (review B3) ──────────────────────────────
  // The debt-payment authority also admits a payment it cannot pair with a named
  // counterparty: ONE row, flow DEBT_PAYMENT, posted on the checking account, no
  // `betweenOwnAccounts`. "You paid $1,500 toward your card and what you owe fell"
  // is the most legitimate debt narrative there is, and the first guard dropped it
  // because the row posted on a LIQUID account. The harness counts a dropped
  // observation as a failure, so a pass here means code kept it.
  scenario('20-type-attested-debt-payment', 'a debt payment with no nameable counterparty explains the fall in debt', (p) => {
    p.currentState.debt = 1710.55;
    p.currentState.liquid = 17420.40;
    p.recentActivity!.top = [
      { date: '2026-09-10', amount: -1500.00, flow: 'DEBT_PAYMENT', merchant: 'Card Services Payment', category: 'Payment', account: 'LIQUID' },
      ...p.recentActivity!.top.slice(0, 4),
    ];
    p.recentChanges.w1 = { from: '2026-09-06', to: '2026-09-13',
      netWorth: { abs: 330.18, pct: 0.3 }, liquid: { abs: -1189.56, pct: -6.4 },
      investments: { abs: 402.90, pct: 0.5 }, digitalAssets: { abs: -73.16, pct: -0.3 },
      debt: { abs: -1500.00, pct: -46.7 } };
  }, {
    quiet: false,
    mentionsAny: [/pa(id|y(ing|ment))/i],
    forbids: [/\bspen(t|ding)\b[^.]{0,40}1,5|1,5[0-9.,]*K?[^.]{0,40}\bspen(t|ding)\b/i],
  }),
];
