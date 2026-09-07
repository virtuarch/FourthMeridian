/**
 * lib/forecast/engine.test.ts   (FORECAST-9)
 *
 * THE CASH PATH — PINNED.
 *
 *     npx tsx lib/forecast/engine.test.ts
 *
 * ── The four measured failures, regressed directly ──────────────────────────
 *   #3/#4  biweekly income counted as two checks a month  → section C
 *   #5/#6  three unlike months averaged into "normal"     → section H
 *   #7     a $10,000 scenario nobody asked for            → section I
 *   #8     $15,500 gross offered as spendable cash        → section G
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   the engine has no parameter through which history could arrive;
 *   an unknown spending level refuses and is never zero;
 *   income arrives as events and is never multiplied by a month count;
 *   crypto is not opening cash and investments are never liquidated;
 *   a supposed figure and an asserted fact produce the same arithmetic and
 *   different status;
 *   and negative cash stays negative.
 *
 * Section M runs 16 REAL SOURCE MUTATIONS.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { ComponentState, composeInvestments } from '../ai/economic-concepts';
import { CadenceKind, occurrencesBetween, type Cadence, CadenceProvenance } from './cadence';
import { ActivityState, resolveStreamActivity } from './stream-activity';
import {
  AmountBasis, EventProvenance, FlowRole, cadenceDerivedEvents, netCashContribution,
  type FutureCashEvent,
} from './future-cash-event';
import { PeriodBasis, MEAN_MONTH_DAYS } from './spending-baseline';
import { assertedAmountBasis, assertedPeriodicAmount } from './periodic-amount';
import {
  composeOperatingState, type CurrentOperatingState, type IncomeStreamInput,
} from './operating-state';
import {
  AssumptionDimension, AssumptionOrigin, AssumptionStance, ConclusionStatus,
  HORIZON_DEPENDENCY, type ForecastPolicy, type PolicyAssumption,
} from './policy';
import {
  SpendingSource, forecastCash, explainForecast, type CashForecast,
} from './engine';
import type { AccountsSectionData } from '../ai/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name: string, actual: number | null, expected: number, tol = 0.005) =>
  check(name, actual !== null && Math.abs(actual - expected) < tol,
    `expected ~${expected}, got ${actual}`);

const SRC = join(__dirname, 'engine.ts');
const src = readFileSync(SRC, 'utf8');
function stripLiterals(t: string): string {
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i += 1;
      while (i < t.length && t[i] !== q) { if (t[i] === '\\') i += 1; i += 1; }
      i += 1; out += "''";
    } else if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i += 1; }
    else if (c === '/' && t[i + 1] === '*') {
      i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1; i += 2;
    } else { out += c; i += 1; }
  }
  return out;
}
const codeOnly = stripLiterals(src);

// ── The real Space ──────────────────────────────────────────────────────────

const AS_OF = '2026-08-28';
/** 94 days, and deliberately NOT a whole number of months. */
const HORIZON = { fromISO: AS_OF, toISO: '2026-11-30',
  origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'through the end of November' };

const realAccounts = () => ({
  totalLiquid: 10228.74, totalLiabilities: 549.75,
  totalInvestments: 5006.557852, totalDigitalAssets: 19014.62555862176,
  redactedCount: 0, totalsUnconverted: false,
  counts: { liquid: 4, liabilities: 2, investments: 3, digitalAssets: 4, realAssets: 0 },
} as unknown as AccountsSectionData);

const DERIVED_AMOUNT = { value: 5286.645, currency: 'USD', provenance: EventProvenance.DERIVED,
  basis: AmountBasis.UNKNOWN, basisProvenance: null };
const VECTRUS: IncomeStreamInput = { sourceKey: 'vectrus', role: FlowRole.INCOME,
  cadence: CadenceKind.BIWEEKLY, activity: ActivityState.CURRENT, projectionEligible: true,
  amount: DERIVED_AMOUNT };
const ABACUS: IncomeStreamInput = { sourceKey: 'abacus', role: FlowRole.INCOME,
  cadence: CadenceKind.SEMIMONTHLY, activity: ActivityState.SILENT, projectionEligible: false,
  amount: { value: 5015.68, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null } };
const INTEREST: IncomeStreamInput = { sourceKey: 'interest-10th', role: FlowRole.INTEREST,
  cadence: CadenceKind.MONTHLY, activity: ActivityState.CURRENT, projectionEligible: true, amount: null };

const netFactAmount = assertedAmountBasis(
  assertedPeriodicAmount(5286.645, 'USD', AS_OF), AmountBasis.NET, AS_OF);
/** The same stream after the user asserts the basis. Events and state must agree. */
const NET_VECTRUS: IncomeStreamInput = { sourceKey: 'vectrus', role: FlowRole.INCOME,
  cadence: CadenceKind.BIWEEKLY, activity: ActivityState.CURRENT, projectionEligible: true,
  amount: { value: netFactAmount.value, currency: netFactAmount.currency,
    provenance: netFactAmount.provenance, basis: netFactAmount.basis,
    basisProvenance: netFactAmount.basisProvenance } };

const state = (o: {
  streams?: IncomeStreamInput[];
  baseline?: { assertable: boolean; amount?: number; periodBasis?: typeof PeriodBasis[keyof typeof PeriodBasis];
    provenance?: string; currency?: string; reason: string };
  accounts?: boolean;
} = {}): CurrentOperatingState => {
  const acc = realAccounts();
  return composeOperatingState({
    asOfISO: AS_OF,
    accounts: o.accounts === false ? null : {
      totalLiquid: acc.totalLiquid, totalLiabilities: acc.totalLiabilities,
      counts: { liquid: acc.counts.liquid, liabilities: acc.counts.liabilities },
      redactedCount: 0, totalsUnconverted: false, asOfISO: AS_OF,
    },
    investments: composeInvestments(acc),
    incomeStreams: o.streams ?? [VECTRUS, ABACUS, INTEREST],
    obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
    baseline: (o.baseline ?? { assertable: false,
      reason: 'recent spending does not repeat closely enough' }) as never,
  });
};

// ── Licensed Vectrus events, produced by FORECAST-1/2/3 — never by the engine ──

const vecCadence: Cadence = {
  kind: CadenceKind.BIWEEKLY, anchorISO: '2026-08-14', sourceKey: 'vectrus',
  provenance: CadenceProvenance.DERIVED, observationCount: 19, confidence: 1,
  reason: 'biweekly payroll', toleranceDays: 2,
} as unknown as Cadence;
const vecActivity = resolveStreamActivity({
  cadence: vecCadence, settlements: ['2026-07-17', '2026-07-31', '2026-08-14'],
  observedThroughISO: AS_OF, asOfISO: AS_OF,
});
const payEvents = (basis: typeof AmountBasis[keyof typeof AmountBasis],
  prov: typeof EventProvenance[keyof typeof EventProvenance] = EventProvenance.DERIVED) =>
  cadenceDerivedEvents(vecActivity, vecCadence, HORIZON.fromISO, HORIZON.toISO, FlowRole.INCOME,
    { value: 5286.645, currency: 'USD', basis, provenance: prov });
const PAY_UNKNOWN = payEvents(AmountBasis.UNKNOWN);
const PAY_NET = payEvents(AmountBasis.NET, EventProvenance.USER_ASSERTED);

// ── Assumptions ─────────────────────────────────────────────────────────────

const SPEND_4K: PolicyAssumption = { id: 'a1', dimension: AssumptionDimension.SPENDING_BASELINE,
  amount: 4000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY,
  origin: AssumptionOrigin.USER_REQUESTED, stance: AssumptionStance.SUPPOSED,
  statedAs: 'assume $4,000/month of normal spending' };
const VECTRUS_NET: PolicyAssumption = { id: 'a2', dimension: AssumptionDimension.INCOME_BASIS,
  sourceKey: 'vectrus', basis: AmountBasis.NET, origin: AssumptionOrigin.USER_REQUESTED,
  stance: AssumptionStance.SUPPOSED, statedAs: 'assume that paycheck is net for this forecast' };
const SPEND_10K: PolicyAssumption = { id: 'h1', dimension: AssumptionDimension.SPENDING_BASELINE,
  amount: 10000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY,
  origin: AssumptionOrigin.USER_REQUESTED, stance: AssumptionStance.COUNTERFACTUAL,
  statedAs: 'show me a scenario where I spend $10,000/month' };

const policy = (assumptions: PolicyAssumption[] = []): ForecastPolicy =>
  ({ horizon: HORIZON, assumptions });
const run = (s: CurrentOperatingState, e: readonly FutureCashEvent[], p: ForecastPolicy) => {
  const f = forecastCash(s, e, p);
  if ('refused' in f) throw new Error(f.reason);
  return f;
};

// ═══════════════════════════════════════════════════════════════════════════
// A. FACTS ONLY — the real Space refuses, and says exactly why
// ═══════════════════════════════════════════════════════════════════════════

const A = run(state(), PAY_UNKNOWN, policy());

eq('A1 the full cash path is REFUSED', A.fullCashPath.status, ConclusionStatus.REFUSED);
eq('A2 with no closing balance — not zero, not a partial sum', A.fullCashPath.closing, null);
check('A3 the refusal names the spending baseline',
  A.fullCashPath.missing.some((m) => /discretionary spending/.test(m)), JSON.stringify(A.fullCashPath.missing));
check('A4 and the income basis',
  A.fullCashPath.missing.some((m) => /net \(after-tax\) basis/.test(m)), JSON.stringify(A.fullCashPath.missing));
eq('A5 opening cash is still factual', A.openingCash.amount, 10228.74);
eq('A6 and is liquidity ONLY — not the $24,021.19 of investments', A.openingCash.state,
  ComponentState.ASSERTABLE);
eq('A7 the licensed pay dates are still exposed',
  A.events.map((e) => e.dateISO),
  ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20']);
eq('A8 with their nominal amounts visible', A.events[0].authoritativeAmount!.value, 5286.645);
eq('A9 but NO cash contribution, because the basis is unestablished', A.events[0].cashDelta, null);
check('A10 and FORECAST-3\'s own words say why',
  /whether it is gross or net was never established/.test(A.events[0].refusalReason ?? ''),
  A.events[0].refusalReason ?? '');
eq('A11 spending is UNRESOLVED, and carries no rate', [A.spending.source, A.spending.dailyRate],
  [SpendingSource.UNRESOLVED, null]);
eq('A12 the known-event path is refused too — the paychecks are not cash yet',
  A.knownEventPath.status, ConclusionStatus.REFUSED);
eq('A13 no assumptions were invented', A.accepted.length, 0);
eq('A14 and no counterfactual path is offered, because none was asked for',
  A.withoutAssumptions, null);

// The partial path IS available when the events themselves are licensed.
const A_NET_EVENTS = run(state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET, policy());
eq('A15 with NET events, the known-event path computes while spending is unknown',
  A_NET_EVENTS.knownEventPath.status, ConclusionStatus.FACTUALLY_LICENSED);
near('A16 opening cash plus seven paychecks', A_NET_EVENTS.knownEventPath.closing,
  10228.74 + 5286.645 * 7);
eq('A17 and the FULL path is still REFUSED — it is not the same question',
  A_NET_EVENTS.fullCashPath.status, ConclusionStatus.REFUSED);
check('A18 the known-event path is never called ending cash',
  /Known-event balance \(excludes ordinary spending\)/.test(explainForecast(A_NET_EVENTS).join('\n')));

check('A19 NET events over an UNKNOWN-basis state refuse — the two must agree', (() => {
  const f = run(state({ baseline: { assertable: true, amount: 4000,
    periodBasis: PeriodBasis.MONTHLY, provenance: EventProvenance.USER_ASSERTED,
    currency: 'USD', reason: 'stated' } }), PAY_NET, policy());
  return f.fullCashPath.status === ConclusionStatus.REFUSED
    && f.fullCashPath.missing.some((m) => /net \(after-tax\) basis/.test(m));
})());

// ═══════════════════════════════════════════════════════════════════════════
// B. SPENDING ASSUMPTION ONLY — still refused, on the other input
// ═══════════════════════════════════════════════════════════════════════════

const B = run(state(), PAY_UNKNOWN, policy([SPEND_4K]));
eq('B1 the full path is still REFUSED', B.fullCashPath.status, ConclusionStatus.REFUSED);
check('B2 and no longer for want of a spending baseline',
  !B.fullCashPath.missing.some((m) => /^current-normal discretionary spending$/.test(m)),
  JSON.stringify(B.fullCashPath.missing));
check('B3 but for the income basis',
  B.fullCashPath.missing.some((m) => /gross or net|net \(after-tax\)/.test(m)),
  JSON.stringify(B.fullCashPath.missing));
eq('B4 the assumed level is carried as a RATE', B.spending.source, SpendingSource.ASSUMED);
near('B5 at $4,000 per mean month, per day', B.spending.dailyRate, 4000 / MEAN_MONTH_DAYS);
eq('B6 and the authoritative baseline underneath is still UNKNOWN',
  state().discretionaryBaseline.state, ComponentState.UNKNOWN);

// ═══════════════════════════════════════════════════════════════════════════
// C. SPENDING + NET BASIS — the scenario cash path, and the BIWEEKLY regression
// ═══════════════════════════════════════════════════════════════════════════

const C = run(state(), PAY_UNKNOWN, policy([SPEND_4K, VECTRUS_NET]));
const CSTATE = state();

eq('C1 the scenario path computes', C.fullCashPath.status, ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('C2 over SEVEN licensed occurrences — not 2 x 3 months, and not 26/12 x 3',
  C.events.filter((e) => e.included).length, 7);
check('C3 which is what two-checks-a-month arithmetic would have got wrong',
  C.events.length !== 2 * 3 && C.events.length === 7);
near('C4 income total is 7 x 5286.645, at full precision',
  C.events.reduce((t, e) => t + (e.cashDelta ?? 0), 0), 37006.515);
near('C5 baseline consumption is 94 days x the daily rate',
  C.points.reduce((t, p) => t + (p.discretionarySpend ?? 0), 0), (4000 / MEAN_MONTH_DAYS) * 94);
near('C6 ending cash = opening + income - accrual', C.fullCashPath.closing,
  10228.74 + 5286.645 * 7 - (4000 / MEAN_MONTH_DAYS) * 94);
eq('C7 the dependencies are exactly the two assumptions the user made',
  [...C.fullCashPath.dependencies].sort(), ['a1', 'a2']);
check('C7b one sentence about the stream reaches all seven of its occurrences — '
  + 'no per-event enumeration',
  C.events.every((e) => e.assumedBasis === AmountBasis.NET && e.dependencies.includes('a2'))
  && C.events.length === 7);
check('C7a and NOT the horizon — a question boundary is not a supposition',
  !C.fullCashPath.dependencies.includes(HORIZON_DEPENDENCY));
eq('C8 and the authoritative path beside it is still REFUSED',
  C.withoutAssumptions!.status, ConclusionStatus.REFUSED);
eq('C9 with no number attached to it', C.withoutAssumptions!.closing, null);

// ⚠️ THE DIRECT REGRESSION for live failures #3/#4.
const monthsInHorizon = 94 / MEAN_MONTH_DAYS;
check('C10 two-checks-a-month would have produced a different, wrong income total',
  Math.abs(2 * Math.round(monthsInHorizon) * 5286.645 - 5286.645 * 7) > 1,
  `two-a-month=${2 * Math.round(monthsInHorizon)} vs licensed=7`);
check('C11 and monthlyEquivalent x months likewise',
  Math.abs((5286.645 * 26 / 12) * monthsInHorizon - 5286.645 * 7) > 1);
eq('C12 the engine performs NO cadence arithmetic of its own',
  /\b26\b|\/\s*12\b|BIWEEKLY|SEMIMONTHLY|occurrencesBetween|annualFactor|monthlyEquivalent/
    .test(codeOnly), false);
eq('C13 the dates are exactly FORECAST-1\'s, unmodified',
  C.events.map((e) => e.dateISO),
  occurrencesBetween(vecCadence, HORIZON.fromISO, HORIZON.toISO));

// ═══════════════════════════════════════════════════════════════════════════
// D. USER-ASSERTED FACTS — same arithmetic, different status
// ═══════════════════════════════════════════════════════════════════════════

const FACT_STATE = state({
  streams: [NET_VECTRUS, ABACUS, INTEREST],
  baseline: { assertable: true, amount: 4000, periodBasis: PeriodBasis.MONTHLY,
    provenance: EventProvenance.USER_ASSERTED, currency: 'USD',
    reason: 'the user stated ordinary spending is 4000 USD per month' },
});
const D = run(FACT_STATE, PAY_NET, policy());

eq('D1 with both facts asserted, the cash path is FACTUAL',
  D.fullCashPath.status, ConclusionStatus.FACTUALLY_LICENSED);
eq('D2 depending on NO assumptions', D.fullCashPath.dependencies, []);
eq('D2a the horizon is a top-level field, not a dependency', D.horizon.toISO, HORIZON.toISO);
eq('D3 the spending term is AUTHORITATIVE, not assumed', D.spending.source, SpendingSource.AUTHORITATIVE);
eq('D4 no assumption was accepted, because none was offered', D.accepted.length, 0);
near('D5 and the arithmetic is IDENTICAL to the scenario', D.fullCashPath.closing,
  C.fullCashPath.closing as number);
check('D6 which is the whole point: same number, different standing',
  D.fullCashPath.status !== C.fullCashPath.status
  && Math.abs((D.fullCashPath.closing as number) - (C.fullCashPath.closing as number)) < 0.005);
eq('D7 no counterfactual path is offered when nothing was supposed', D.withoutAssumptions, null);

// ═══════════════════════════════════════════════════════════════════════════
// E. OPENING CASH — liquidity only
// ═══════════════════════════════════════════════════════════════════════════

check('E1 the engine never reads investments', !/investments|digitalAssets|crypto/i.test(codeOnly));
eq('E2 opening cash is the liquid figure, not the $24,021.19 combined total',
  A.openingCash.amount, 10228.74);
check('E3 unknown liquidity refuses the path rather than substituting zero', (() => {
  const s = state({ accounts: false });
  const f = run(s, PAY_NET, policy([SPEND_4K]));
  return f.openingCash.amount === null
    && f.fullCashPath.status === ConclusionStatus.REFUSED
    && f.knownEventPath.status === ConclusionStatus.REFUSED
    && f.fullCashPath.closing === null;
})());
check('E4 the rendering says investments are not cash',
  /Investments and digital assets are NOT opening cash/.test(explainForecast(A).join('\n')));
check('E5 nor are they liquidated to cover a shortfall',
  /Investments are not liquidated/.test(explainForecast(C).join('\n')));

// ═══════════════════════════════════════════════════════════════════════════
// F. DOUBLE COUNTING, DEBT AND OBLIGATIONS
// ═══════════════════════════════════════════════════════════════════════════

const RENT: FutureCashEvent = {
  id: 'rent@2026-09-01', timing: { kind: 'EXACT', dateISO: '2026-09-01' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'OUTFLOW', role: FlowRole.SPENDING,
  amount: { value: 2400, currency: 'USD', basis: AmountBasis.NET,
    provenance: EventProvenance.USER_ASSERTED },
};
const F = run(FACT_STATE, [...PAY_NET, RENT], policy());
near('F1 a licensed obligation is an outflow exactly once', F.fullCashPath.closing as number,
  (D.fullCashPath.closing as number) - 2400);
eq('F2 it appears in outflows, never in discretionary spend',
  F.points.filter((p) => p.outflows > 0).length, 1);
check('F3 and the baseline accrual is unchanged by it',
  Math.abs(F.points.reduce((t, p) => t + (p.discretionarySpend ?? 0), 0)
    - D.points.reduce((t, p) => t + (p.discretionarySpend ?? 0), 0)) < 0.005);
check('F4 the $549.75 debt BALANCE is never an outflow',
  (D.fullCashPath.closing as number) > 10228.74 - 549.75
  && !/debt|liabilit/i.test(codeOnly.replace(/DEBT_PAYMENT/g, '')));
eq('F5 debt does not decline over the horizon — this is a cash forecast',
  /debtBalance|payoff|amortis|interestAccrual|minimumPayment/i.test(codeOnly), false);
check('F6 known outflows and baseline consumption are separately inspectable',
  F.points.every((p) => p.outflows >= 0 && (p.discretionarySpend === null || p.discretionarySpend >= 0))
  && /Known outflows:/.test(explainForecast(F).join('\n'))
  && /Baseline spending over the horizon:/.test(explainForecast(F).join('\n')));
check('F7 no fabricated discretionary events exist',
  F.events.every((e) => e.id === 'rent@2026-09-01' || e.id.startsWith('vectrus@')));

// ═══════════════════════════════════════════════════════════════════════════
// G. BONUS / VACATION — live failure #8
// ═══════════════════════════════════════════════════════════════════════════

const BONUS: FutureCashEvent = {
  id: 'bonus', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 15500, currency: 'USD', basis: AmountBasis.GROSS,
    provenance: EventProvenance.USER_ASSERTED },
};
const VACATION: FutureCashEvent = {
  id: 'vacation', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 1500, currency: 'USD', basis: AmountBasis.UNKNOWN,
    provenance: EventProvenance.USER_ASSERTED },
};
const G_FACTS = run(FACT_STATE, [...PAY_NET, BONUS, VACATION], policy());
eq('G1 with no assumptions the full path is REFUSED — $17,000 is not cash',
  G_FACTS.fullCashPath.status, ConclusionStatus.REFUSED);
eq('G2 the stated amounts are still visible',
  [G_FACTS.events.find((e) => e.id === 'bonus')!.authoritativeAmount!.value,
    G_FACTS.events.find((e) => e.id === 'vacation')!.authoritativeAmount!.value], [15500, 1500]);
check('G3 and each says why it is not counted', G_FACTS.events
  .filter((e) => ['bonus', 'vacation'].includes(e.id))
  .every((e) => e.cashDelta === null && (e.refusalReason ?? '').length > 0));
check('G4 GROSS and UNKNOWN refuse for DIFFERENT stated reasons',
  /GROSS amount/.test(G_FACTS.events.find((e) => e.id === 'bonus')!.refusalReason ?? '')
  && /never established/.test(G_FACTS.events.find((e) => e.id === 'vacation')!.refusalReason ?? ''));

const netBonus: PolicyAssumption = { id: 'g1', dimension: AssumptionDimension.EVENT_BASIS,
  eventId: 'bonus', basis: AmountBasis.NET, origin: AssumptionOrigin.USER_REQUESTED,
  stance: AssumptionStance.COUNTERFACTUAL, statedAs: 'assume both amounts are net for this scenario' };
const netVac: PolicyAssumption = { ...netBonus, id: 'g2', eventId: 'vacation',
  stance: AssumptionStance.SUPPOSED };
const G = run(FACT_STATE, [...PAY_NET, BONUS, VACATION], policy([netBonus, netVac]));

near('G5 under both assumptions the scenario adds $17,000', G.fullCashPath.closing as number,
  (D.fullCashPath.closing as number) + 17000);
eq('G6 and the result is HYPOTHETICAL, because one contradicts an established GROSS',
  G.fullCashPath.status, ConclusionStatus.HYPOTHETICAL);
check('G7 naming BOTH basis assumptions', ['g1', 'g2'].every((d) => G.fullCashPath.dependencies.includes(d)),
  JSON.stringify(G.fullCashPath.dependencies));
eq('G8 the underlying events are untouched',
  [BONUS.amount!.basis, VACATION.amount!.basis], [AmountBasis.GROSS, AmountBasis.UNKNOWN]);
eq('G9 FORECAST-3 still refuses them on the raw events',
  [netCashContribution(BONUS).assertable, netCashContribution(VACATION).assertable], [false, false]);
eq('G10 and the authoritative path beside it refuses', G.withoutAssumptions!.status,
  ConclusionStatus.REFUSED);
check('G11 no ratio, percentage or deduction estimate exists',
  !/percent|ratio|withhold|\btax\b/i.test(codeOnly));

// ═══════════════════════════════════════════════════════════════════════════
// H. HISTORICAL SPENDING — live failures #5/#6
// ═══════════════════════════════════════════════════════════════════════════
//
// Three unlike months: an ordinary one, a debt-payoff month and a travel month.
// FORECAST-6 refuses to call any of them normal. The engine must have no way to
// disagree, and the strongest form of that is having nowhere to put them.

check('H1 the engine has NO parameter through which a transaction could arrive',
  /export function forecastCash\(\s*state: CurrentOperatingState,\s*events: readonly FutureCashEvent\[\],\s*policy: ForecastPolicy,\s*\)/
    .test(src));
check('H2 and no history, average or trailing vocabulary anywhere',
  !/average|mean\b|median|trailing|history|historical|Transaction|Snapshot|Candidate/i
    .test(codeOnly.replace(/MEAN_MONTH_DAYS/g, 'X')));
check('H3 no database, ledger, model or clock',
  !/lib\/db|prisma|queryTransactions|Date\.now\(\)|Math\.random|toLocale/i.test(codeOnly));
eq('H4 an unknown baseline refuses; it does not become $8,349.66 or $6,712.88',
  [A.spending.amount, A.spending.dailyRate, A.fullCashPath.closing], [null, null, null]);
near('H5 an explicit $4,000 assumption uses exactly $4,000', B.spending.amount as number, 4000);
const importTargets = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
check('H6 every import is a forecast authority or CF-7\'s concept vocabulary',
  // `_time` / `_num` are the shared arithmetic extracted in V26-REASONING
  // Slice 0; the underscore prefix marks them as private to lib/forecast, which
  // is why the original `[a-z-]+` pattern did not admit them.
  importTargets.every((t) => /^\.\/_?[a-z-]+$/.test(t) || t === '../ai/economic-concepts'),
  importTargets.join(' | '));

// ═══════════════════════════════════════════════════════════════════════════
// I. THE $10,000 SCENARIO — live failure #7
// ═══════════════════════════════════════════════════════════════════════════

const I = run(state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET, policy([SPEND_10K]));
eq('I1 a counterfactual scenario is HYPOTHETICAL', I.fullCashPath.status, ConclusionStatus.HYPOTHETICAL);
eq('I2 naming the explicit scenario assumption', I.fullCashPath.dependencies.includes('h1'), true);
eq('I3 the OBSERVED baseline remains UNKNOWN',
  state().discretionaryBaseline.state, ComponentState.UNKNOWN);
near('I4 it consumes exactly $10,000/month as a rate',
  I.points.reduce((t, p) => t + (p.discretionarySpend ?? 0), 0), (10000 / MEAN_MONTH_DAYS) * 94);
check('I5 the rendering marks it hypothetical and quotes the request',
  /HYPOTHETICAL/.test(explainForecast(I).join('\n'))
  && /show me a scenario where I spend/.test(explainForecast(I).join('\n')));
check('I6 the engine holds no money literal of its own — it cannot invent $10,000',
  !/\b\d{3,}\b/.test(codeOnly));
eq('I7 with no such assumption the engine cannot produce that spending',
  A.spending.amount, null);

// ═══════════════════════════════════════════════════════════════════════════
// J. NEGATIVE CASH, POINTS AND DETERMINISM
// ═══════════════════════════════════════════════════════════════════════════

const BIG_SPEND: PolicyAssumption = { ...SPEND_10K, id: 'j1', amount: 20000,
  stance: AssumptionStance.SUPPOSED, statedAs: 'assume $20,000/month' };
const J = run(state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET, policy([BIG_SPEND]));
check('J1 a balance that crosses zero stays negative', (J.fullCashPath.closing as number) < 0,
  String(J.fullCashPath.closing));
check('J2 and is not clamped at any point',
  J.points.some((p) => (p.closingBalance ?? 0) < 0));
check('J3 the first negative date is reported to the day', J.firstNegativeDateISO !== null
  && /^\d{4}-\d{2}-\d{2}$/.test(J.firstNegativeDateISO), String(J.firstNegativeDateISO));
check('J4 and it is not called insolvency or bankruptcy',
  !/bankrupt|insolven|overdraft|default/i.test(explainForecast(J).join('\n')));
check('J5 no investment is sold and no credit is drawn',
  !/liquidat|sell|draw|borrow/i.test(codeOnly));

eq('J6 points are sparse — one per event date plus the horizon end',
  C.points.length, 8);
eq('J7 the first point is the horizon start', C.points[0].dateISO, HORIZON.fromISO);
eq('J8 the last is the horizon end', C.points.at(-1)!.dateISO, HORIZON.toISO);
eq('J9 elapsed days sum to the horizon', C.points.reduce((t, p) => t + p.elapsedDays, 0), 94);
check('J10 every point carries its own accrual and its own event ids',
  C.points.every((p) => p.discretionarySpend !== null && Array.isArray(p.eventIds)));
eq('J11 daily points were not generated', C.points.length < 94, true);

const D1 = run(FACT_STATE, PAY_NET, policy());
const D2 = run(FACT_STATE, PAY_NET, policy());
eq('J12 the same inputs produce byte-identical output', JSON.stringify(D1), JSON.stringify(D2));

// ═══════════════════════════════════════════════════════════════════════════
// K. DEPENDENCY MINIMALITY AND PROVENANCE
// ═══════════════════════════════════════════════════════════════════════════

eq('K1 the first point is opening cash itself — no accrual, nothing supposed',
  [C.points[0].openingBalance, C.points[0].elapsedDays, C.points[0].discretionarySpend],
  [10228.74, 0, 0]);
check('K2 the known-event path never depends on the spending assumption',
  !C.knownEventPath.dependencies.includes('a1'), JSON.stringify(C.knownEventPath.dependencies));
check('K3 an event depends only on the assumptions that changed IT',
  C.events.every((e) => !e.dependencies.includes('a1')));
check('K4 three provenances stay separate on one paycheck', (() => {
  const e = C.events[0];
  return e.timingProvenance === EventProvenance.DERIVED
    && e.authoritativeAmount!.provenance === EventProvenance.DERIVED
    && e.authoritativeAmount!.basis === AmountBasis.UNKNOWN
    && e.assumedBasis === AmountBasis.NET;
})(), JSON.stringify(C.events[0]));
check('K5 dependencies accumulate along the path, never retroactively',
  C.points.every((p, i) => i === 0
    || p.dependencies.length >= C.points[i - 1].dependencies.length));
eq('K6 the first point carries only the basis assumption its own paycheck used',
  C.points[0].dependencies, ['a2']);
check('K6a and the spending assumption joins only once time has elapsed',
  C.points[0].elapsedDays === 0 && !C.points[0].dependencies.includes('a1')
  && C.points[1].dependencies.includes('a1'), JSON.stringify(C.points.map((p) => p.dependencies)));

// ═══════════════════════════════════════════════════════════════════════════
// L. MONEY, ROUNDING AND SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const sixExact = 5286.645 * 7;
const sixRounded = Number((5286.645).toFixed(2)) * 7;
check('L1 the half-cent level is carried at full precision, per D-4',
  Math.abs((C.events.reduce((t, e) => t + (e.cashDelta ?? 0), 0)) - sixExact) < 1e-9);
check('L2 rounding each occurrence first would have drifted',
  Math.abs(sixRounded - sixExact) > 0.001, `${sixRounded} vs ${sixExact}`);
// ⚠️ THE EDGE MOVED, THE RULE DID NOT (V26-REASONING Slice 0). `money()` was
// one of four near-identical copies and now lives in `lib/forecast/_num.ts`. So
// the engine must round ZERO times of its own, and the shared edge must round
// exactly once — which is a stricter statement of the same D-4 doctrine than
// "exactly one toFixed in this file" ever was.
const numSrc = readFileSync(join(process.cwd(), 'lib/forecast/_num.ts'), 'utf8');
const stripped = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
eq('L3 the engine itself rounds nowhere',
  (stripped(src).match(/toFixed\(/g) ?? []).length, 0);
eq('L3b and the one shared rendering edge rounds exactly once',
  (stripped(numSrc).match(/toFixed\(/g) ?? []).length, 1);

const renders = {
  facts: explainForecast(A).join('\n'),
  spendOnly: explainForecast(B).join('\n'),
  scenario: explainForecast(C).join('\n'),
  asserted: explainForecast(D).join('\n'),
};
const tok = (s: string) => Math.ceil(s.length / 4);
for (const [n, t] of Object.entries(renders)) {
  check(`L4 ${n}: within the 250-500 token budget`, tok(t) >= 120 && tok(t) <= 500, `${tok(t)} tokens`);
  check(`L5 ${n}: the seven sections are present`,
    /Opening cash:/.test(t) && /Known inflows:/.test(t) && /Known outflows:/.test(t)
    && /Baseline spending over the horizon:/.test(t) && /Ending cash:/.test(t), t);
}
check('L5a the accrued spending total is stated even when the path is refused', (() => {
  // FORECAST-11: summing the points gave USD 0.00 here, and the model filled
  // the silence with arithmetic of its own.
  const r = explainForecast(run(state(), PAY_UNKNOWN, policy([SPEND_4K]))).join('\n');
  return /Baseline spending over the horizon: USD 12353\.\d\d total/.test(r)
    && !/over the horizon: USD 0\.00/.test(r);
})(), explainForecast(run(state(), PAY_UNKNOWN, policy([SPEND_4K]))).join('\n'));
check('L5b and a refusal states what a refusal forbids',
  /state no ending figure, build no month-by-month table/.test(
    explainForecast(run(state(), PAY_UNKNOWN, policy())).join('\n')));
check('L5c licensed dates with unlicensed amounts are NOT summed to zero', (() => {
  // FORECAST-11: "7 × (7 dates) totalling USD 0.00" was read by the model as
  // "you have no income", and it forecast the user into the red on that basis.
  const r = explainForecast(run(state(), PAY_UNKNOWN, policy([SPEND_4K]))).join('\n');
  return /NONE of which is counted as cash/.test(r)
    && /This is not zero income/.test(r)
    && !/Known inflows: 7 × \([^)]*\) totalling USD 0\.00/.test(r);
})(), explainForecast(run(state(), PAY_UNKNOWN, policy([SPEND_4K]))).join('\n'));
check('L6 the refused render states the refusal, never a number',
  /Ending cash: REFUSED — needs/.test(renders.facts) && !/Ending cash: USD/.test(renders.facts));
check('L7 the scenario render names its dependencies',
  /Ending cash: USD [\d,.]+ · ASSUMPTION_DEPENDENT \(needs /.test(renders.scenario), renders.scenario);
check('L8 and shows the authoritative answer beside it',
  /Ending cash WITHOUT the assumptions: REFUSED/.test(renders.scenario));
check('L9 the asserted render is factual with no assumptions section',
  /Ending cash: USD [\d,.]+ · FACTUALLY_LICENSED/.test(renders.asserted)
  && !/Assumptions:/.test(renders.asserted), renders.asserted);
check('L10 no raw transactions are dumped', !/merchant|category|transaction/i.test(renders.scenario));

console.log(`\n  TOKENS  facts=${tok(renders.facts)} spendOnly=${tok(renders.spendOnly)} `
  + `scenario=${tok(renders.scenario)} asserted=${tok(renders.asserted)}`);

// ═══════════════════════════════════════════════════════════════════════════
// N. ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ RESTATED BY FORECAST-10, WHICH IS THE SLICE THAT WIRES THESE. The check
// read "no consumer outside lib/forecast", and through FORECAST-9 that was both
// true and the point: a substrate with no production reader could not change an
// answer. FORECAST-10 gives it exactly one reader, so the claim worth keeping is
// not "nothing consumes this" but "only the sanctioned adapter does" — no
// assembler, prompt, route or component reaches past `lib/ai/forecast/` into the
// authorities. That is the protection the original was really providing, and it
// is now pinned directly.
const ALLOWED_CONSUMER_ROOTS = ['lib/forecast/', 'lib/ai/forecast/'];
/**
 * ⚠️ PRODUCTION FILES ONLY (FORECAST-11). The claim is about what PRODUCTION
 * reaches for; a test builds inputs for the authority on purpose, and counting
 * those as consumers would make the gate fail for the act of testing the thing
 * it protects.
 *
 * The two former exceptions — `lib/ai/conformance/` fixtures and the
 * `scripts/check-forecast-*` operator harnesses — were deleted in the AI
 * conversation reset, so the exclusions went with them.
 */
const isProductionFile = (f: string) => !f.endsWith('.test.ts');
check('N1 FORECAST-9 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/engine" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
check('N2 the engine duplicates no authority decision table',
  !/REQUIRES|conclusionLicence|licensingShadow|validatePolicy|contradicts|deriveCurrent/.test(codeOnly));
check('N3 it consumes FORECAST-7\'s licence rather than re-deriving one',
  /Conclusion\.FORECAST_ENDING_CASH/.test(src) && /applyPolicy\(/.test(src));
check('N4 and FORECAST-3\'s net contribution rather than reimplementing it',
  /netCashContribution\(/.test(src) && !/basis === AmountBasis\.GROSS/.test(codeOnly));
// Commit-to-commit, per the lesson this suite already records for N6.
check('N5 FORECAST-9 changed no FORECAST-1..8 production file it did not have to',
  execSync('git diff --name-only 6410d82 714d099 -- lib/forecast/cadence.ts lib/forecast/stream-activity.ts '
    + 'lib/forecast/future-cash-event.ts lib/forecast/obligation.ts lib/forecast/periodic-amount.ts '
    + 'lib/forecast/operating-state.ts', { encoding: 'utf8' }).trim() === '');
// ⚠️ COMMIT-TO-COMMIT (FORECAST-10). Against the working tree this said "no
// later slice may touch a prompt surface", which FORECAST-10 exists to do. The
// claim about FORECAST-9's own commit is exact and permanently true.
check('N6 FORECAST-9 touched no prompt, retrieval or UI surface',
  execSync('git diff --name-only 6410d82 714d099 -- lib/ai/ app/ components/ prisma/',
    { encoding: 'utf8' }).trim() === '');

// ═══════════════════════════════════════════════════════════════════════════
// M. MUTATION TESTING — 16 deliberate breaks
// ═══════════════════════════════════════════════════════════════════════════

const MUTANT = join(__dirname, '__engine_mutant__.ts');
const cleanup = () => { if (existsSync(MUTANT)) unlinkSync(MUTANT); };
process.on('exit', cleanup);
let seq = 0;
async function mutate(
  name: string, find: string, replace: string,
  assertion: (m: typeof import('./engine')) => boolean,
): Promise<void> {
  if (!src.includes(find)) { check(`${name} [anchor]`, false, `anchor not found: ${find}`); return; }
  writeFileSync(MUTANT, src.replace(find, replace), 'utf8');
  try {
    const m = await import(`./__engine_mutant__?v=${++seq}`) as typeof import('./engine');
    let survived: boolean;
    try { survived = assertion(m); } catch { survived = false; }
    check(name, !survived, 'the mutant passed — the test does not actually pin this');
  } finally { cleanup(); }
}
const via = (m: typeof import('./engine'), s: CurrentOperatingState,
  e: readonly FutureCashEvent[], p: ForecastPolicy) => {
  const f = m.forecastCash(s, e, p);
  if ('refused' in f) throw new Error(f.reason);
  return f as CashForecast;
};

async function mutations(): Promise<void> {
  await mutate('M1 an unknown spending level treated as zero is caught',
    `    source: SpendingSource.UNRESOLVED, amount: null, periodBasis: null,
    dailyRate: null, assumptionId: null, reason: authority.reason,`,
    `    source: SpendingSource.AUTHORITATIVE, amount: 0, periodBasis: PeriodBasis.MONTHLY,
    dailyRate: 0, assumptionId: null, reason: authority.reason,`,
    // ⚠️ ASSERTED ON THE SPENDING TERM, NOT THE PATH STATUS. FORECAST-7's
    // licence is a second, independent lock on the same door: with the baseline
    // UNKNOWN it refuses the path whatever this engine believes about the rate.
    // Pinning the status would therefore pass with the bug present. The claim
    // that matters is narrower and exact — unknown spending is not a rate of
    // zero, and it never acquires an amount.
    (m) => {
      const f = via(m, state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET, policy());
      return f.spending.source === m.SpendingSource.UNRESOLVED
        && f.spending.dailyRate === null && f.spending.amount === null
        && f.fullCashPath.closing === null;
    });

  await mutate('M2 an unknown income basis promoted to NET is caught',
    '  const view: FutureCashEvent = { ...r.event, amount };',
    '  const view: FutureCashEvent = { ...r.event, amount: { ...amount, basis: AmountBasis.NET } };',
    (m) => via(m, CSTATE, PAY_UNKNOWN, policy()).events[0].cashDelta === null);

  await mutate('M3 counting two paychecks a month is caught',
    '  const forecastEvents: ForecastEvent[] = inWindow.map((r) => {',
    '  const forecastEvents: ForecastEvent[] = inWindow.filter((_, i) => i % 2 === 0).map((r) => {',
    (m) => via(m, state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET, policy())
      .events.filter((e) => e.included).length === 7);

  await mutate('M4 regenerating pay dates independently is caught',
    "    return d !== null && d >= fromISO && d <= toISO;",
    "    return d !== null && d >= fromISO && d <= toISO && d.endsWith('1');",
    (m) => JSON.stringify(via(m, state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET,
      policy()).events.map((e) => e.dateISO))
      === JSON.stringify(occurrencesBetween(vecCadence, HORIZON.fromISO, HORIZON.toISO)));

  await mutate('M5 crypto added to opening cash is caught',
    '    state: liq.state, amount: liq.state === ComponentState.UNKNOWN ? null : liq.amount,',
    '    state: liq.state, amount: liq.state === ComponentState.UNKNOWN ? null '
    + ': (liq.amount ?? 0) + (state.investments?.combined ?? 0),',
    (m) => via(m, state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET, policy())
      .openingCash.amount === 10228.74);

  await mutate('M6 the debt balance subtracted as an outflow is caught',
    '  let balance = openingLicensed ? (openingCash.amount as number) : null;',
    '  let balance = openingLicensed ? (openingCash.amount as number) - (state.debt.amount ?? 0) : null;',
    (m) => Math.abs((via(m, FACT_STATE, PAY_NET, policy()).fullCashPath.closing as number)
      - (D.fullCashPath.closing as number)) < 0.005);

  await mutate('M7 a GROSS bonus counted as factual net cash is caught',
    '  const c = netCashContribution(view);\n  if (!c.assertable) return { delta: null, reason: c.reason };',
    '  const c = netCashContribution(view);\n  if (!c.assertable) return { delta: amount.value, reason: null };',
    (m) => via(m, FACT_STATE, [...PAY_NET, BONUS, VACATION], policy())
      .events.find((e) => e.id === 'bonus')!.cashDelta === null);

  await mutate('M8 erasing assumption dependencies is caught',
    '    ? { status: rank(fullDeps), closing: last?.closingBalance ?? null, dependencies: fullDeps, missing: [] }',
    '    ? { status: rank(fullDeps), closing: last?.closingBalance ?? null, dependencies: [], missing: [] }',
    (m) => via(m, CSTATE, PAY_UNKNOWN, policy([SPEND_4K, VECTRUS_NET]))
      .fullCashPath.dependencies.length > 0);

  await mutate('M9 a hypothetical result labelled factual is caught',
    "    dependencies.some((d) => counterfactual.has(d)) ? ConclusionStatus.HYPOTHETICAL",
    "    false ? ConclusionStatus.HYPOTHETICAL",
    (m) => via(m, state({ streams: [NET_VECTRUS, ABACUS, INTEREST] }), PAY_NET,
      policy([SPEND_10K])).fullCashPath.status === ConclusionStatus.HYPOTHETICAL);

  await mutate('M10 fabricating discretionary events is caught',
    '    const here = byDate.get(dateISO) ?? [];',
    '    const here = byDate.get(dateISO) ?? [];\n'
    + '    if (accrual) { outflowsFake = accrual; }',
    (m) => via(m, FACT_STATE, PAY_NET, policy()).points.every((p) => p.outflows === 0));

  await mutate('M11 clamping negative cash to zero is caught',
    '    const closing = opening !== null ? opening + inflows - outflows : null;',
    '    const closing = opening !== null ? Math.max(0, opening + inflows - outflows) : null;',
    (m) => (via(m, state(), PAY_NET, policy([BIG_SPEND])).fullCashPath.closing as number) < 0);

  await mutate('M12 counting a known obligation twice is caught',
    '      if (e.cashDelta >= 0) inflows += e.cashDelta; else outflows += -e.cashDelta;',
    '      if (e.cashDelta >= 0) inflows += e.cashDelta; else outflows += -e.cashDelta * 2;',
    (m) => Math.abs((via(m, FACT_STATE, [...PAY_NET, RENT], policy()).fullCashPath.closing as number)
      - ((D.fullCashPath.closing as number) - 2400)) < 0.005);

  await mutate('M13 importing a historical average is caught',
    'import { dailySpendRate, PeriodBasis, type PeriodBasisKind } from \'./spending-baseline\';',
    'import { dailySpendRate, PeriodBasis, deriveSpendingBaseline, type PeriodBasisKind } from \'./spending-baseline\';',
    () => !/deriveSpendingBaseline|deriveCurrentPeriodicAmount/.test(
      stripLiterals(readFileSync(MUTANT, 'utf8'))));

  await mutate('M14 including the SILENT Abacus stream is caught',
    '  const inWindow = res.events.filter((r) => {',
    '  const inWindow = [...res.events, ...res.events].filter((r) => {',
    (m) => via(m, FACT_STATE, PAY_NET, policy()).events.length === 6);

  await mutate('M15 a scenario assumption mutating the authoritative event is caught',
    '      authoritativeAmount: r.authorityAmount,',
    '      authoritativeAmount: effectiveEventAmount(r),',
    (m) => via(m, CSTATE, PAY_UNKNOWN, policy([SPEND_4K, VECTRUS_NET]))
      .events[0].authoritativeAmount!.basis === AmountBasis.UNKNOWN);

  const NO_AMOUNT: FutureCashEvent = { ...RENT, id: 'nil', amount: null };
  await mutate('M16 an event with amount:null treated as zero is caught',
    "    return { delta: null, reason: netCashContribution(r.event).assertable",
    "    return { delta: 0, reason: null } as never; return { delta: null, reason: netCashContribution(r.event).assertable",
    (m) => {
      const f = via(m, FACT_STATE, [...PAY_NET, NO_AMOUNT], policy());
      return f.fullCashPath.status === ConclusionStatus.REFUSED
        && f.events.find((e) => e.id === 'nil')!.cashDelta === null;
    });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void mutations();
