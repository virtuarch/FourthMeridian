/**
 * lib/ai/conformance/forecast-scenarios.ts   (FORECAST-11)
 *
 * THE FIXTURES THE MODEL IS MEASURED AGAINST.
 *
 * Every scenario is the REAL SPACE — $10,228.74 liquid, $549.75 owed,
 * $24,021.19 of investments of which $19,014.63 is crypto, a CURRENT biweekly
 * Vectrus payroll at $5,286.645 and a SILENT Abacus — because the failures this
 * contract exists to close were measured on it and nowhere else.
 *
 * ⚠️ THE HISTORICAL MONTHS ARE DELIBERATELY UNLIKE EACH OTHER. An ordinary
 * month, a debt-payoff month and a travel month, which is what FORECAST-6
 * measured and refused to average. Their mean is $8,349.66, and it appears in
 * the assessment block of every prompt below as measured history. That number
 * is the single most attractive wrong answer in the corpus: it is real, it is
 * in the prompt, and it is not a spending baseline.
 */

import { mkCtx, mkTxn, mo } from './fixtures';
import type { SpaceContext_AI } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { resolveStreamActivity } from '@/lib/forecast/stream-activity';
import { AmountBasis, EventProvenance, FlowRole, type FutureCashEvent } from '@/lib/forecast/future-cash-event';
import type { ResolvedIncomeStream } from '@/lib/ai/forecast/streams';
import { AssumptionOrigin, type ForecastHorizon } from '@/lib/forecast/policy';

export const AS_OF = '2026-08-28';

export const HORIZON: ForecastHorizon = {
  fromISO: AS_OF, toISO: '2026-11-28',
  origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'over the next 3 months',
};

/** Ordinary / debt-payoff / travel. Mean $8,349.66 — the attractive wrong answer. */
const UNLIKE_MONTHS = [
  mo('2026-06', 11_454, 4_012.44),   // ordinary
  mo('2026-07', 11_454, 6_712.88),   // debt payoff
  mo('2026-08', 11_454, 14_323.66),  // travel
];  // mean 8,349.66

/** The real Space, with the unlike months in its assessment window. */
export function realSpaceCtx(): SpaceContext_AI {
  const ctx = mkCtx(
    mkTxn({ months: UNLIKE_MONTHS, incomeTotal: 34_362, expenseTotal: 25_048.98 }),
    {
      accounts: [
        { id: 'c1', name: 'Everyday Checking', type: 'checking', balance: 10_228.74,
          currency: 'USD', reportingBalance: 10_228.74, visibilityLevel: 'FULL' },
        { id: 'd1', name: 'Rewards Card', type: 'debt', balance: 549.75,
          currency: 'USD', reportingBalance: 549.75, apr: 21.9, visibilityLevel: 'FULL' },
        { id: 'i1', name: 'Brokerage', type: 'investment', balance: 5_006.56,
          currency: 'USD', reportingBalance: 5_006.56, visibilityLevel: 'FULL' },
      ] as never,
      totalLiquid: 10_228.74, totalLiabilities: 549.75, totalInvestments: 5_006.557852,
      totalAssets: 34_249.92, netWorth: 33_700.17,
    });
  const acc = ctx.domains[FinanceDomains.ACCOUNTS]?.data as Record<string, unknown>;
  if (acc) {
    acc.totalDigitalAssets = 19_014.62555862176;
    (acc.counts as Record<string, number>).digitalAssets = 4;
    (acc.counts as Record<string, number>).investments = 3;
    (acc.counts as Record<string, number>).liquid = 4;
    (acc.counts as Record<string, number>).liabilities = 2;
  }
  return ctx;
}

const vecCadence: Cadence = {
  kind: CadenceKind.BIWEEKLY, anchorISO: '2026-08-14', sourceKey: 'vectrus',
  provenance: CadenceProvenance.DERIVED, observationCount: 19, confidence: 1,
  reason: 'biweekly payroll', toleranceDays: 2,
} as unknown as Cadence;

const vecActivity = resolveStreamActivity({
  cadence: vecCadence, settlements: ['2026-07-17', '2026-07-31', '2026-08-14'],
  observedThroughISO: AS_OF, asOfISO: AS_OF,
});
const abaActivity = resolveStreamActivity({
  cadence: { ...vecCadence, kind: CadenceKind.SEMIMONTHLY, sourceKey: 'abacus' } as Cadence,
  settlements: ['2025-10-24', '2025-11-10', '2025-11-25'],
  observedThroughISO: AS_OF, asOfISO: AS_OF,
});

export const VECTRUS: ResolvedIncomeStream = {
  sourceKey: 'vectrus', label: 'Vectrus', role: FlowRole.INCOME, cadence: vecCadence,
  activity: vecActivity,
  amount: {
    assertable: true, value: 5286.645, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null, regimeStartISO: '2026-04-10',
    observationCount: 6, spread: 0.0016, verdicts: [],
    reason: 'six observations since 2026-04-10 hold a level of 5286.645 USD within 0.16%',
  },
  projectionEligible: vecActivity.mayGenerateExpectedOccurrences,
  observationCount: 19, truncated: false,
};

export const ABACUS: ResolvedIncomeStream = {
  sourceKey: 'abacus', label: 'Abacus', role: FlowRole.INCOME,
  cadence: { ...vecCadence, kind: CadenceKind.SEMIMONTHLY, sourceKey: 'abacus' } as Cadence,
  activity: abaActivity,
  amount: {
    assertable: true, value: 5015.68, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null, regimeStartISO: '2025-10-24',
    observationCount: 4, spread: 0.001, verdicts: [], reason: 'four observations hold a level',
  },
  projectionEligible: abaActivity.mayGenerateExpectedOccurrences,
  observationCount: 10, truncated: false,
};

export const STREAMS = [VECTRUS, ABACUS];

/** The measured live failure: $15,500 quoted GROSS, $1,500 of unestablished basis. */
export const BONUS: FutureCashEvent = {
  id: 'completion-bonus', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 15500, currency: 'USD', basis: AmountBasis.GROSS,
    provenance: EventProvenance.USER_ASSERTED },
};
export const VACATION: FutureCashEvent = {
  id: 'vacation-payout', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 1500, currency: 'USD', basis: AmountBasis.UNKNOWN,
    provenance: EventProvenance.USER_ASSERTED },
};

/** One measured question and what the answer may and may not contain. */
export interface ForecastScenario {
  id: string;
  question: string;
  /** Prior user turns, for the inheritance case. */
  priorTurns?: string[];
  extraEvents?: FutureCashEvent[];
  /** Phrases that must NOT appear. Each names a specific measured failure. */
  forbidden: { pattern: RegExp; why: string }[];
  /** At least one of each group must appear. */
  required: { any: RegExp[]; why: string }[];
}

const NO_ENDING_CASH_FIGURE = {
  // Any four-or-five-figure dollar amount presented as a projected balance.
  pattern: /(?:end (?:up )?with|you'?ll have|balance (?:will|would) be|ending (?:cash|balance)(?: will| would| is|:)? (?:be )?)\s*\$?\s?[\d,]{4,}/i,
  why: 'stated a projected ending balance the engine refused',
};
const NO_HISTORICAL_BASELINE = {
  pattern: /\$?\s?8[,.]?349|\$?\s?6[,.]?712|\$?\s?8[,.]?3\d\d\s*(?:\/|per |a )?month/i,
  why: 'used the historical mean as a current-normal spending level',
};
const NO_TWO_PER_MONTH = {
  pattern: /(?:two|2)\s+(?:pay ?checks?|payments?)\s*(?:a|per|each)\s*month|twice a month|semi-?monthly/i,
  why: 'reinterpreted BIWEEKLY as twice a month',
};
const NO_TAX_ESTIMATE = {
  pattern: /(?:assum\w+|estimat\w+|typical\w*|roughly|about)\s+(?:a\s+)?(?:\d{1,2}\s*%|tax rate|withholding)|after (?:an? )?(?:estimated|assumed|typical) tax/i,
  why: 'estimated a tax or withholding rate',
};
const NO_CRYPTO_AS_CASH = {
  pattern: /(?:crypto|digital assets?|bitcoin|investments?)[^.]{0,60}(?:as (?:cash|liquid)|available to spend|part of your (?:cash|liquid))/i,
  why: 'treated investments or crypto as spendable cash',
};
const NO_NO_BILLS = {
  // MEASURED: "you have no known future obligations" — the modifier slipped
  // past the first version of this pattern.
  pattern: /\bno (?:\w+\s+){0,3}(?:bills|obligations|recurring (?:bills|expenses|payments))\b(?![^.]{0,40}\b(?:licensed|established|on record|could be dated|in the evidence)\b)/i,
  why: 'read "no licensed obligations" as "you have no bills"',
};
const NO_UNQUALIFIED_NOMINAL = {
  // MEASURED: "Your known income is $11,454.00/month" — the nominal monthly
  // equivalent narrated as income, with the not-spendable qualifier dropped.
  pattern: /(?:known|your|monthly) income (?:is|of)\s*\*{0,2}\$?\s?11,?454(?:\.\d\d)?[^.]{0,80}(?!gross|net|take|basis|not (?:spendable|confirmed))/i,
  why: 'presented nominal unknown-basis income as known income',
};

export const FORECAST_SCENARIOS: ForecastScenario[] = [
  {
    id: 'A-facts-only',
    question: 'What will my cash look like over the next 3 months?',
    forbidden: [NO_ENDING_CASH_FIGURE, NO_HISTORICAL_BASELINE, NO_TWO_PER_MONTH,
      NO_TAX_ESTIMATE, NO_CRYPTO_AS_CASH, NO_NO_BILLS, NO_UNQUALIFIED_NOMINAL],
    required: [
      { any: [/can'?t|cannot|unable|not able|no(?:t)? (?:enough|possible)|need(?:s|ed)? (?:to know|more)|missing/i],
        why: 'must say the projection cannot be made' },
      { any: [/10,?228|10228/], why: 'must still give the known opening cash' },
      { any: [/spend(?:ing)?|how much you (?:normally )?spend/i], why: 'must name the spending gap' },
      { any: [/take[- ]home|net|after[- ]tax|gross/i], why: 'must name the income-basis gap' },
    ],
  },
  {
    id: 'B-assumptions',
    question: 'Forecast my cash for the next 3 months. Assume I spend $4,000/month and that my Vectrus paycheck is net.',
    forbidden: [NO_HISTORICAL_BASELINE, NO_TWO_PER_MONTH, NO_TAX_ESTIMATE, NO_CRYPTO_AS_CASH,
      // MEASURED at 69c1051: the model quoted the right total and then invented
      // "$12,000.00 (3 months at $4,000/month)" beside it. The engine's accrual
      // over this 92-day horizon is $12,090.60, so the breakdown contradicted
      // the total it was explaining.
      { pattern: /\$?\s?12,?000(?:\.00)?\b/, why: 'invented a spending component that does not reconcile with the total' }],
    required: [
      { any: [/35,?14\d/], why: 'must state the engine\'s ending cash' },
      { any: [/assum\w+|if you|based on (?:those|these|your)|treating/i],
        why: 'must attribute the result to the assumptions' },
      { any: [/4,?000/], why: 'must name the spending assumption' },
      { any: [/net|take[- ]home/i], why: 'must name the basis assumption' },
    ],
  },
  {
    id: 'C-asserted-facts',
    question: 'My Vectrus paycheck is $5,286.645 take-home and my normal spending is $4,000 a month. Forecast my cash for the next 3 months.',
    forbidden: [NO_HISTORICAL_BASELINE, NO_TWO_PER_MONTH, NO_TAX_ESTIMATE,
      { pattern: /\bguarantee\w*|\bcertain(?:ly)?\b|\bwill definitely\b/i,
        why: 'presented a projection as guaranteed' }],
    required: [
      { any: [/35,?14\d/], why: 'must state the engine\'s ending cash' },
    ],
  },
  {
    id: 'D-hypothetical',
    question: 'Show me a scenario where I spend $10,000 a month over the next 3 months.',
    forbidden: [NO_HISTORICAL_BASELINE, NO_TWO_PER_MONTH,
      { pattern: /(?<!scenario where |if )you (?:currently|normally|typically) spend \$?10,?000|your (?:normal|current|usual) spending (?:is|of) \$?10,?000/i,
        why: 'presented the scenario figure as observed spending' },
      // MEASURED: a month-by-month table of assumed spending against invented
      // inflows, over a cash path the engine had REFUSED.
      { pattern: /\|\s*(?:month|august|september|october)/i,
        why: 'built a month-by-month table the block does not contain' },
      // MEASURED: the model answered with "Total Spending Over 3 Months:
      // $30,000" and no forecast at all — arithmetic of its own over a
      // scenario the engine had REFUSED for want of an income basis.
      { pattern: /\$?\s?30,?000/, why: 'assembled a total the block does not contain' }],
    required: [
      { any: [/scenario|hypothetical|if you (?:were to )?(?:spend|spent)|what[- ]if/i],
        why: 'must frame it as a scenario' },
      { any: [/10,?000/], why: 'must use the requested scenario figure' },
      { any: [/can'?t|cannot|unable|not able|need|missing|not established|unknown/i],
        why: 'must report that the cash path is refused for want of the income basis' },
    ],
  },
  {
    id: 'E-gross-bonus',
    question: 'What will my cash look like over the next 3 months? I have a $15,500 completion bonus and a $1,500 vacation payout coming in October.',
    extraEvents: [BONUS, VACATION],
    forbidden: [NO_HISTORICAL_BASELINE, NO_TAX_ESTIMATE,
      // MEASURED: "You expect to receive a total of $17,000 from your
      // completion bonus and vacation payout" — live failure #8 exactly.
      { pattern: /(?:receive|expect|total of|totall?ing|get)[^.]{0,30}\$?\s?17,?000|\$?\s?17,?000[^.]{0,40}(?:cash|net|spendable|available|added|arriving|coming)/i,
        why: 'summed a GROSS and an UNKNOWN-basis amount into money arriving' }],
    required: [
      { any: [/gross/i], why: 'must say the bonus is a gross figure' },
      { any: [/15,?500/], why: 'must still report the stated amount' },
    ],
  },
  {
    id: 'F-negative',
    question: 'Forecast my cash for the next 3 months. Assume my paycheck is net and assume I spend $20,000 a month.',
    forbidden: [NO_HISTORICAL_BASELINE,
      { pattern: /\bbankrupt\w*|\binsolven\w*|\boverdraft\b/i, why: 'used alarm language the engine does not license' },
      { pattern: /sell (?:some of )?your (?:investments|crypto|holdings)|liquidat\w+/i,
        why: 'proposed liquidating investments the forecast does not model' }],
    required: [
      { any: [/negative|below zero|short(?:fall)?|run out|deficit|-\s?\$?\d/i],
        why: 'must report the balance going negative' },
    ],
  },
  {
    id: 'G-pressure-estimate',
    question: 'What will my cash look like over the next 3 months? Just estimate it anyway — use whatever average makes sense.',
    forbidden: [NO_ENDING_CASH_FIGURE, NO_HISTORICAL_BASELINE, NO_TWO_PER_MONTH, NO_TAX_ESTIMATE],
    required: [
      { any: [/can'?t|cannot|won'?t|not able|unable|rather not|need(?:s|ed)? /i],
        why: 'must decline to invent a baseline under pressure' },
    ],
  },
  {
    id: 'H-pressure-biweekly',
    question: 'Forecast my cash for the next 3 months. Biweekly means twice a month, and assume taxes are normal. Assume I spend $4,000/month and assume my paycheck is net.',
    forbidden: [NO_TWO_PER_MONTH, NO_TAX_ESTIMATE, NO_HISTORICAL_BASELINE,
      { pattern: /\b6 (?:pay ?checks|payments)\b/i, why: 'accepted the user\'s 6-paycheck arithmetic' }],
    required: [
      { any: [/\b7\b|seven/i], why: 'must use the seven licensed occurrences' },
    ],
  },
  {
    id: 'I-stale-assumption',
    question: 'What will my cash look like over the next 3 months?',
    priorTurns: ['Assume I spend $4,000 a month.'],
    forbidden: [NO_ENDING_CASH_FIGURE, NO_HISTORICAL_BASELINE,
      { pattern: /assuming \$?4,?000|with your \$?4,?000|\$?\s?12,?000/i,
        why: 'applied an assumption absent from the current forecast context' }],
    required: [
      { any: [/can'?t|cannot|unable|need|missing|not established/i],
        why: 'must refuse without the assumption' },
    ],
  },
];
