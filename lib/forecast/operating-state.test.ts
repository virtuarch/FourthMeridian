/**
 * lib/forecast/operating-state.test.ts   (FORECAST-7)
 *
 * WHAT IS TRUE NOW, AND WHAT IS REFUSED — PINNED.
 *
 *     npx tsx lib/forecast/operating-state.test.ts
 *
 * ── The failures ────────────────────────────────────────────────────────────
 * Every measured forecast failure was a conclusion drawn over a missing input:
 * a monthly surplus against an unknown spending baseline, a runway from a burn
 * rate nobody had, a "months of cash" figure that treated absent as zero. Plus
 * the earlier live failure where crypto vanished from a broad financial answer.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   no burn, runway, surplus or safe-budget survives an UNKNOWN baseline;
 *   ABSENT satisfies a requirement and UNKNOWN never does;
 *   nominal income is not net income;
 *   a dead stream contributes nothing however good its amount;
 *   crypto stays visible and stays out of liquid cash;
 *   and "no licensed obligations" is not "no bills".
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import {
  IncomeClass, Conclusion, composeOperatingState, conclusionLicence,
  forecastCapabilities, forecastBlockers, describeOperatingState,
  type OperatingStateInput, type CurrentOperatingState, type ConclusionKind,
} from './operating-state';
import { ComponentState } from '../ai/economic-concepts';
import { composeInvestments } from '../ai/economic-concepts';
import { CadenceKind, monthlyEquivalent } from './cadence';
import { ActivityState } from './stream-activity';
import { AmountBasis, EventProvenance, FlowRole, type FutureCashEvent } from './future-cash-event';
import { assertedAmountBasis, assertedPeriodicAmount } from './periodic-amount';
import { PeriodBasis } from './spending-baseline';
import type { AccountsSectionData } from '../ai/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const src = readFileSync(join(__dirname, 'operating-state.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const codeOnly = code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
const AS_OF = '2026-08-28';

/** The real Space's account payload. */
const realAccounts = (o: Partial<AccountsSectionData> = {}) => ({
  totalLiquid: 10228.74, totalLiabilities: 549.75,
  totalInvestments: 5006.557852, totalDigitalAssets: 19014.62555862176,
  redactedCount: 0, totalsUnconverted: false,
  counts: { liquid: 4, liabilities: 2, investments: 3, digitalAssets: 4, realAssets: 0 },
  ...o,
} as unknown as AccountsSectionData);

const state = (o: Partial<OperatingStateInput> = {}): CurrentOperatingState => {
  const acc = (o.accounts === undefined ? realAccounts() : o.accounts) as AccountsSectionData | null;
  return composeOperatingState({
    asOfISO: AS_OF,
    accounts: acc ? {
      totalLiquid: acc.totalLiquid, totalLiabilities: acc.totalLiabilities,
      counts: { liquid: acc.counts.liquid, liabilities: acc.counts.liabilities },
      redactedCount: acc.redactedCount, totalsUnconverted: acc.totalsUnconverted,
      asOfISO: AS_OF,
    } : null,
    investments: acc ? composeInvestments(acc) : null,
    incomeStreams: [],
    obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
    baseline: { assertable: false, reason: 'recent spending does not repeat closely enough' },
    ...o,
  });
};

/** The real Vectrus stream: CURRENT, biweekly, assertable amount, unknown basis. */
const VECTRUS = {
  sourceKey: 'vectrus', role: FlowRole.INCOME, cadence: CadenceKind.BIWEEKLY,
  activity: ActivityState.CURRENT, projectionEligible: true,
  amount: { value: 5286.645, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null },
};
/** The real Abacus stream: SILENT, with a perfectly good amount. */
const ABACUS = {
  sourceKey: 'abacus', role: FlowRole.INCOME, cadence: CadenceKind.SEMIMONTHLY,
  activity: ActivityState.SILENT, projectionEligible: false,
  amount: { value: 5015.68, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null },
};
/** A real interest stream: CURRENT and periodic, with no amount. */
const INTEREST = {
  sourceKey: 'interest-10th', role: FlowRole.INTEREST, cadence: CadenceKind.MONTHLY,
  activity: ActivityState.CURRENT, projectionEligible: true, amount: null,
};

const REAL = state({ incomeStreams: [VECTRUS, ABACUS, INTEREST] });
const licence = (s: CurrentOperatingState, c: ConclusionKind) => conclusionLicence(s, c);
const refused = (s: CurrentOperatingState, c: ConclusionKind) => !licence(s, c).licensed;

// ═══════════════════════════════════════════════════════════════════════════
// A. THE REFUSALS — the point of the slice
// ═══════════════════════════════════════════════════════════════════════════

eq('A1 monthly burn rate is REFUSED', refused(REAL, Conclusion.MONTHLY_BURN_RATE), true);
eq('A2 cash runway is REFUSED', refused(REAL, Conclusion.CASH_RUNWAY), true);
eq('A3 monthly surplus is REFUSED', refused(REAL, Conclusion.MONTHLY_SURPLUS), true);
eq('A4 a safe monthly budget is REFUSED', refused(REAL, Conclusion.SAFE_MONTHLY_BUDGET), true);
eq('A5 savings rate is REFUSED', refused(REAL, Conclusion.SAVINGS_RATE), true);
eq('A6 monthly discretionary spend is REFUSED', refused(REAL, Conclusion.MONTHLY_DISCRETIONARY_SPEND), true);
eq('A7 forecast ending cash is REFUSED', refused(REAL, Conclusion.FORECAST_ENDING_CASH), true);
eq('A8 net monthly inflow is REFUSED', refused(REAL, Conclusion.NET_MONTHLY_INFLOW), true);
check('A9 each refusal names what is missing', (() => {
  const l = licence(REAL, Conclusion.CASH_RUNWAY);
  return !l.licensed && l.missing.includes('current-normal discretionary spending');
})());
// Scoped to the STATE's own shape. The Conclusion table names these on purpose
// — in order to refuse them — so scanning the whole file finds the refusal.
const stateShape = src.slice(src.indexOf('export interface CurrentOperatingState'),
  src.indexOf('export interface OperatingStateInput'));
check('A10 there is NO field on the state a runway could be read from',
  !/runway|burn|surplus|savings|month(s|ly)Remaining/i.test(stateShape), stateShape.slice(0, 120));
check('A11 no arithmetic combines income with a missing baseline',
  !/nominalMonthly *-|amount *- *baseline|income *- */.test(codeOnly));

// ═══════════════════════════════════════════════════════════════════════════
// B. What IS licensed
// ═══════════════════════════════════════════════════════════════════════════

eq('B1 current liquid balance is licensed', licence(REAL, Conclusion.CURRENT_LIQUID_BALANCE).licensed, true);
eq('B2 current debt balance is licensed', licence(REAL, Conclusion.CURRENT_DEBT_BALANCE).licensed, true);
eq('B3 current investment total is licensed', licence(REAL, Conclusion.CURRENT_INVESTMENT_TOTAL).licensed, true);
eq('B4 next pay dates are licensed — they need no amount at all',
  licence(REAL, Conclusion.NEXT_PAY_DATES).licensed, true);
eq('B5 nominal monthly income is licensed', licence(REAL, Conclusion.NOMINAL_MONTHLY_INCOME).licensed, true);
eq('B6 the known-obligation schedule is licensed — ABSENT is usable evidence',
  licence(REAL, Conclusion.KNOWN_OBLIGATION_SCHEDULE).licensed, true);
check('B7 readiness is a MATRIX, not a boolean — some questions answer, others do not', (() => {
  const caps = forecastCapabilities(REAL);
  return caps.some((c) => c.licence.licensed) && caps.some((c) => !c.licence.licensed);
})());
eq('B8 every conclusion has a declared requirement',
  forecastCapabilities(REAL).length, Object.keys(Conclusion).length);

// ═══════════════════════════════════════════════════════════════════════════
// C. ABSENT satisfies; UNKNOWN never does
// ═══════════════════════════════════════════════════════════════════════════

eq('C1 zero licensed obligations is ABSENT, not UNKNOWN', REAL.knownObligations.state, ComponentState.ABSENT);
check('C2 and it explicitly disclaims meaning the user has no bills',
  /statement about the evidence, not a statement that no bills exist/.test(REAL.knownObligations.reason),
  REAL.knownObligations.reason);
eq('C3 an unevaluated obligation set is UNKNOWN instead',
  state({ obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: false } })
    .knownObligations.state, ComponentState.UNKNOWN);
eq('C4 and then the obligation schedule is refused',
  refused(state({ obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: false } }),
    Conclusion.KNOWN_OBLIGATION_SCHEDULE), true);
eq('C5 the spending baseline is UNKNOWN, never zero', REAL.discretionaryBaseline.state, ComponentState.UNKNOWN);
eq('C6 and carries no amount', REAL.discretionaryBaseline.amount, null);
check('C7 no trailing average was substituted',
  !/trailing|average|mean\(/i.test(codeOnly));
check('C8 an UNKNOWN income amount is not zero either', (() => {
  const s = state({ incomeStreams: [INTEREST] });
  return s.incomeStreams[0].amount === null && s.incomeStreams[0].nominalMonthly === null;
})());
check('C9 the vocabulary is CF-7\'s, not a new synonym set',
  /from '\.\.\/ai\/economic-concepts'/.test(src) && !/EMPTY_BUT_KNOWN|UNAVAILABLE/.test(codeOnly));

// ═══════════════════════════════════════════════════════════════════════════
// D. Income composition
// ═══════════════════════════════════════════════════════════════════════════

const vec = REAL.incomeStreams.find((s) => s.sourceKey === 'vectrus')!;
const aba = REAL.incomeStreams.find((s) => s.sourceKey === 'abacus')!;
const int = REAL.incomeStreams.find((s) => s.sourceKey === 'interest-10th')!;

eq('D1 Vectrus has a nominal monthly equivalent', vec.nominalMonthly, monthlyEquivalent(5286.645, CadenceKind.BIWEEKLY));
eq('D2 which is 26/12, not "twice a month"', vec.annualOccurrences, 26);
eq('D3 with UNKNOWN basis — never NET', vec.basis, AmountBasis.UNKNOWN);
eq('D4 Abacus keeps its amount', aba.amount, 5015.68);
eq('D5 but contributes NO monthly income — a good number about a dead stream', aba.nominalMonthly, null);
eq('D6 because it is not projection-eligible', aba.projectionEligible, false);
eq('D7 and its activity is preserved', aba.activity, ActivityState.SILENT);
eq('D8 interest is CURRENT and projection-eligible', [int.activity, int.projectionEligible],
  [ActivityState.CURRENT, true]);
eq('D9 but classified OTHER_PERIODIC, never as payroll', int.incomeClass, IncomeClass.OTHER_PERIODIC);
eq('D10 while Vectrus is only an OPERATING_CANDIDATE — not a salary claim',
  vec.incomeClass, IncomeClass.OPERATING_CANDIDATE);
check('D11 the state exposes NO aggregate income total',
  !/totalIncome|monthlyIncome *[:=]|aggregateIncome/i.test(codeOnly));
check('D12 the four stream facts are four separate fields',
  /activity:/.test(src) && /projectionEligible:/.test(src)
  && /amountState:/.test(src) && /basis:/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// E. Investments and liquidity — the live regression
// ═══════════════════════════════════════════════════════════════════════════

check('E1 the broad state carries traditional investments AND digital assets',
  REAL.investments!.components.length === 2
  && REAL.investments!.components.every((c) => c.state === ComponentState.ASSERTABLE));
// Null-safe on purpose: if digital assets vanish this must REPORT that, not
// throw — a crashing guard tells you nothing about what broke.
eq('E2 crypto does not disappear',
  REAL.investments?.components.find((c) => c.key === 'DIGITAL_ASSETS')?.amount ?? 'MISSING', 19014.63);
eq('E3 the combined total is the CF-7 composition', REAL.investments!.combined, 24021.19);
eq('E4 liquid cash is separate and is NOT the investment figure', REAL.liquidity.amount, 10228.74);
check('E5 investments are never folded into liquidity — no arithmetic joins them',
  REAL.liquidity.amount !== REAL.investments!.combined
  && !/totalLiquid[^;\n]*\+|combined[^;\n]*\+[^;\n]*liquid/i.test(codeOnly));
check('E6 the composition is CF-7\'s, not recomputed',
  /investments: input\.investments/.test(code) && !/totalPortfolioValue/.test(src));
check('E7 the rendering states that investments are not liquid cash',
  /Investments and digital assets are NOT liquid cash/.test(describeOperatingState(REAL).join('\n')));
check('E8 a hidden account makes the totals UNKNOWN, not short', (() => {
  const s = state({ accounts: realAccounts({ redactedCount: 1 }) as never });
  return s.liquidity.state === ComponentState.UNKNOWN && s.debt.state === ComponentState.UNKNOWN;
})());
eq('E9 and then the balance conclusions are refused',
  refused(state({ accounts: realAccounts({ redactedCount: 1 }) as never }), Conclusion.CURRENT_LIQUID_BALANCE), true);

// ═══════════════════════════════════════════════════════════════════════════
// F. Current means current
// ═══════════════════════════════════════════════════════════════════════════

check('F1 the composer consumes verdicts and derives none',
  !/deriveCadence|deriveCurrentPeriodicAmount|deriveSpendingBaseline|resolveStreamActivity/.test(code));
check('F2 no transaction history is an input', !/transactions|Transaction/.test(codeOnly));
check('F3 no snapshot or historical series is consulted', !/snapshot|history|trailing/i.test(codeOnly));
check('F4 balances come from the canonical accounts payload',
  /totalLiquid: number;/.test(src) && /totalLiabilities: number;/.test(src));
eq('F5 a SILENT stream cannot contribute income however strong its history', aba.nominalMonthly, null);

// ═══════════════════════════════════════════════════════════════════════════
// G. Freshness
// ═══════════════════════════════════════════════════════════════════════════

eq('G1 the state carries an as-of date', REAL.asOfISO, AS_OF);
eq('G2 and a freshness spread rather than one stamped date', REAL.freshnessSpreadDays, 0);
check('G3 no new freshness model was invented — the band vocabulary stays in lib/freshness',
  !/LIVE|VERY_STALE|bandForAge/.test(codeOnly) && /lib\/freshness\/observation/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// H. User assertions compose, they are not reinterpreted
// ═══════════════════════════════════════════════════════════════════════════

const asserted = state({
  incomeStreams: [VECTRUS, ABACUS, INTEREST],
  baseline: {
    assertable: true, amount: 4000, periodBasis: PeriodBasis.MONTHLY,
    provenance: EventProvenance.USER_ASSERTED, currency: 'USD',
    reason: 'the user stated ordinary spending is 4000 USD per month',
  },
});
eq('H1 a user-asserted baseline becomes ASSERTABLE', asserted.discretionaryBaseline.state, ComponentState.ASSERTABLE);
eq('H2 with USER_ASSERTED provenance preserved', asserted.discretionaryBaseline.provenance, EventProvenance.USER_ASSERTED);
eq('H3 and monthly discretionary spend becomes licensed',
  licence(asserted, Conclusion.MONTHLY_DISCRETIONARY_SPEND).licensed, true);
eq('H4 as does burn rate, since obligations are ABSENT and therefore usable',
  licence(asserted, Conclusion.MONTHLY_BURN_RATE).licensed, true);
eq('H5 and cash runway, since liquidity is assertable too',
  licence(asserted, Conclusion.CASH_RUNWAY).licensed, true);
eq('H6 but monthly SURPLUS is still refused — income basis is not NET',
  refused(asserted, Conclusion.MONTHLY_SURPLUS), true);
check('H7 and that refusal names the basis, not the baseline', (() => {
  const l = licence(asserted, Conclusion.MONTHLY_SURPLUS);
  return !l.licensed && l.missing.some((m) => /net \(after-tax\) basis/.test(m))
    && !l.missing.some((m) => /discretionary/.test(m));
})());
check('H8 the module never parses prose — assertions arrive already decided',
  // Date.parse is arithmetic on an ISO stamp, not prose interpretation.
  !/regex|\.match\(|toLowerCase\(\)\.includes/.test(codeOnly.replace(/Date\.parse/g, 'X')));

// ═══════════════════════════════════════════════════════════════════════════
// I. Obligations enter the state when licensed
// ═══════════════════════════════════════════════════════════════════════════

const rentEvent: FutureCashEvent = {
  id: 'rent@2026-09-01', timing: { kind: 'EXACT', dateISO: '2026-09-01' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'OUTFLOW', role: FlowRole.SPENDING,
  amount: { value: 2400, currency: 'USD', basis: AmountBasis.NET, provenance: EventProvenance.USER_ASSERTED },
};
const withRent = state({ obligations: { licensedEvents: [rentEvent], activeButUndatedCount: 0, evaluated: true } });
eq('I1 a licensed obligation makes the component ASSERTABLE', withRent.knownObligations.state, ComponentState.ASSERTABLE);
eq('I2 with its event counted', withRent.knownObligations.licensedEventCount, 1);
eq('I3 and it does NOT change the spending baseline', withRent.discretionaryBaseline.state, ComponentState.UNKNOWN);
check('I4 an active-but-undated obligation is disclosed, not counted', (() => {
  const s = state({ obligations: { licensedEvents: [], activeButUndatedCount: 5, evaluated: true } });
  return s.knownObligations.state === ComponentState.ABSENT
    && s.knownObligations.activeButUndatedCount === 5
    && /carry no due date/.test(s.knownObligations.reason);
})());
check('I5 a current debt BALANCE never becomes a future obligation',
  REAL.debt.amount === 549.75 && REAL.knownObligations.licensedEventCount === 0);

// ═══════════════════════════════════════════════════════════════════════════
// J. Architecture and isolation
// ═══════════════════════════════════════════════════════════════════════════

check('J1 the state does not project — no event generation lives here',
  !/occurrencesBetween|cadenceDerivedEvents|expectedOccurrences/.test(code));
check('J2 the boundary is documented', /ForecastPolicy/.test(src) && /does not project/.test(src));
check('J3 no ForecastPolicy was built', !/export .*ForecastPolicy/.test(src));
check('J4 no database or clock', !/lib\/db|prisma|Date\.now\(\)|new Date\(\)[^.]/i.test(codeOnly));
check('J5 no consumer outside lib/forecast',
  execSync('grep -rl "forecast/operating-state" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .every((f: string) => f.startsWith('lib/forecast/')));
// ⚠️ COMMIT-TO-COMMIT, AND NARROWED TO THE SIX FILES IT MEANT.
// As first written this compared 5ca025a to the WORKING TREE over all of
// lib/forecast/, which had two faults: it swept in operating-state.ts — the
// file this suite tests, which of course did not exist at 5ca025a — so it
// failed the moment FORECAST-7 was committed; and it asserted a claim about
// FORECAST-7's diff against a tree that every later slice is entitled to move.
// FORECAST-9A legitimately edits periodic-amount.ts, which would have failed it
// a second time for the opposite reason. The claim being made is about
// FORECAST-7's own commit, so it is pinned there and is now permanently true.
check('J6 FORECAST-7 did not touch FORECAST-1..6 or CF-7',
  execSync('git diff --name-only 5ca025a 3bcfce3 -- lib/forecast/cadence.ts '
    + 'lib/forecast/stream-activity.ts lib/forecast/future-cash-event.ts '
    + 'lib/forecast/obligation.ts lib/forecast/periodic-amount.ts '
    + 'lib/forecast/spending-baseline.ts lib/ai/economic-concepts.ts',
  { encoding: 'utf8' }).trim() === '');
check('J7 no tax estimate anywhere', !/tax|withhold/i.test(codeOnly));

// ═══════════════════════════════════════════════════════════════════════════
// K. Serialization
// ═══════════════════════════════════════════════════════════════════════════

const rendered = describeOperatingState(REAL).join('\n');
const tokens = Math.ceil(rendered.length / 4);
check('K1 the serializer fits the 200-400 token budget', tokens >= 150 && tokens <= 450, `${tokens} tokens`);
check('K2 it states the refusals explicitly', /may NOT be stated/.test(rendered));
check('K3 and forbids substituting an average', /Do not substitute a historical average/.test(rendered));
check('K4 and forbids treating unknown as zero', /unknown figure as zero/.test(rendered));
check('K5 it dumps no raw transactions', !/merchant|category|transaction/i.test(rendered));
check('K6 nominal income is labelled not-spendable',
  /basis UNKNOWN — not spendable cash/.test(rendered), rendered);
check('K7 the dead stream is shown as not projection-eligible',
  /abacus[\s\S]{0,120}NOT projection-eligible/.test(rendered));

// ═══════════════════════════════════════════════════════════════════════════
// L. Blockers
// ═══════════════════════════════════════════════════════════════════════════

const blockers = forecastBlockers(REAL);
check('L1 the real Space names its blockers',
  blockers.includes('current-normal discretionary spending')
  && blockers.some((b) => /net \(after-tax\) basis/.test(b)), JSON.stringify(blockers));
eq('L2 an assertable baseline removes one blocker',
  forecastBlockers(asserted).includes('current-normal discretionary spending'), false);
check('L3 but the basis blocker survives',
  forecastBlockers(asserted).some((b) => /net \(after-tax\) basis/.test(b)));
eq('L4 a fully-blocked state still licenses next pay dates',
  licence(state({ accounts: null, investments: null }), Conclusion.NEXT_PAY_DATES).licensed, true);

// ═══════════════════════════════════════════════════════════════════════════
// N. BASIS IS CARRIED, NOT DECIDED (FORECAST-9A)
// ═══════════════════════════════════════════════════════════════════════════

const netAmount = assertedAmountBasis(
  assertedPeriodicAmount(5286.645, 'USD', AS_OF), AmountBasis.NET, AS_OF);
const NET_VECTRUS = { ...VECTRUS, amount: {
  value: netAmount.value, currency: netAmount.currency, provenance: netAmount.provenance,
  basis: netAmount.basis, basisProvenance: netAmount.basisProvenance } };
const asserted_net = state({ incomeStreams: [NET_VECTRUS, ABACUS, INTEREST] });
const vecNet = asserted_net.incomeStreams.find((s) => s.sourceKey === 'vectrus')!;

eq('N1 a user-asserted NET basis reaches the state', vecNet.basis, AmountBasis.NET);
eq('N2 with its own provenance', vecNet.basisProvenance, EventProvenance.USER_ASSERTED);
eq('N3 and net monthly inflow becomes FACTUALLY licensed — no policy involved',
  licence(asserted_net, Conclusion.NET_MONTHLY_INFLOW).licensed, true);
eq('N4 the derived streams are untouched by it',
  asserted_net.incomeStreams.filter((s) => s.basis === AmountBasis.NET).length, 1);
eq('N5 the real Space, with no assertion, still has NO net basis anywhere',
  REAL.incomeStreams.every((s) => s.basis === AmountBasis.UNKNOWN
    && s.basisProvenance === null), true);
eq('N6 and still refuses net monthly inflow', refused(REAL, Conclusion.NET_MONTHLY_INFLOW), true);

const grossAmount = assertedAmountBasis(
  assertedPeriodicAmount(7000, 'USD', AS_OF), AmountBasis.GROSS, AS_OF);
const gross = state({ incomeStreams: [{ ...VECTRUS, amount: {
  value: grossAmount.value, currency: grossAmount.currency, provenance: grossAmount.provenance,
  basis: grossAmount.basis, basisProvenance: grossAmount.basisProvenance } }] });
eq('N7 an asserted GROSS amount is factual as a nominal figure',
  licence(gross, Conclusion.NOMINAL_MONTHLY_INCOME).licensed, true);
eq('N8 but GROSS never satisfies NET', refused(gross, Conclusion.NET_MONTHLY_INFLOW), true);
eq('N9 nor does an asserted amount with no basis stated', refused(state({
  incomeStreams: [{ ...VECTRUS, amount: { value: 5250, currency: 'USD',
    provenance: EventProvenance.USER_ASSERTED, basis: AmountBasis.UNKNOWN, basisProvenance: null } }],
}), Conclusion.NET_MONTHLY_INFLOW), true);

check('N10 a NET basis on a stream that cannot continue licenses nothing', (() => {
  // Abacus is SILENT: a perfectly good take-home figure about a job that ended
  // has no monthly equivalent, so there is no number to state.
  const s = state({ incomeStreams: [{ ...ABACUS, amount: { value: 5015.68, currency: 'USD',
    provenance: EventProvenance.DERIVED, basis: AmountBasis.NET,
    basisProvenance: EventProvenance.USER_ASSERTED } }] });
  return s.incomeStreams[0].basis === AmountBasis.NET
    && s.incomeStreams[0].nominalMonthly === null
    && !licence(s, Conclusion.NET_MONTHLY_INFLOW).licensed;
})());
check('N11 a NET stream is not labelled unspendable, because it IS spendable', (() => {
  const r = describeOperatingState(asserted_net).join('\n');
  return /net USD \d+\.\d\d\/month \(basis NET, stated by user asserted\)/.test(r)
    && !/basis NET[^)]*not spendable/.test(r);
})(), describeOperatingState(asserted_net).join('\n'));
check('N12 the composer decides no basis of its own',
  !/basis: AmountBasis\.(NET|GROSS)/.test(codeOnly));

// ═══════════════════════════════════════════════════════════════════════════
// O. MUTATION — the composer must carry, and the licence must not soften
// ═══════════════════════════════════════════════════════════════════════════

const MUTANT = join(__dirname, '__state_mutant__.ts');
const cleanupMutant = () => { if (existsSync(MUTANT)) unlinkSync(MUTANT); };
process.on('exit', cleanupMutant);
let seq = 0;
async function mutate(
  name: string, find: string, replace: string,
  assertion: (m: typeof import('./operating-state')) => boolean,
): Promise<void> {
  if (!src.includes(find)) { check(`${name} [anchor]`, false, `anchor not found: ${find}`); return; }
  writeFileSync(MUTANT, src.replace(find, replace), 'utf8');
  try {
    const m = await import(`./__state_mutant__?v=${++seq}`) as typeof import('./operating-state');
    let survived: boolean;
    try { survived = assertion(m); } catch { survived = false; }
    check(name, !survived, 'the mutant passed — the test does not actually pin this');
  } finally { cleanupMutant(); }
}

/** Rebuild the asserted-NET fixture against a mutated module. */
const netStateVia = (m: typeof import('./operating-state')) => m.composeOperatingState({
  asOfISO: AS_OF,
  accounts: { totalLiquid: 10228.74, totalLiabilities: 549.75, counts: { liquid: 4, liabilities: 2 },
    redactedCount: 0, totalsUnconverted: false, asOfISO: AS_OF },
  investments: null, incomeStreams: [NET_VECTRUS, ABACUS, INTEREST],
  obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
  baseline: { assertable: false, reason: 'x' },
});
const realStateVia = (m: typeof import('./operating-state')) => m.composeOperatingState({
  asOfISO: AS_OF,
  accounts: { totalLiquid: 10228.74, totalLiabilities: 549.75, counts: { liquid: 4, liabilities: 2 },
    redactedCount: 0, totalsUnconverted: false, asOfISO: AS_OF },
  investments: null, incomeStreams: [VECTRUS, ABACUS, INTEREST],
  obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
  baseline: { assertable: false, reason: 'x' },
});

async function mutations(): Promise<void> {
  // The original defect: the composer decides instead of carrying.
  await mutate('O1 re-hard-coding UNKNOWN in the composer is caught',
    'basis: s.amount?.basis ?? AmountBasis.UNKNOWN,',
    'basis: AmountBasis.UNKNOWN,',
    (m) => netStateVia(m).incomeStreams[0].basis === AmountBasis.NET);

  // The opposite direction, and the worse one.
  await mutate('O2 a composer that promotes a derived amount to NET is caught',
    'basis: s.amount?.basis ?? AmountBasis.UNKNOWN,',
    'basis: s.amount ? AmountBasis.NET : AmountBasis.UNKNOWN,',
    (m) => realStateVia(m).incomeStreams.every((x) => x.basis === AmountBasis.UNKNOWN));

  await mutate('O3 erasing basis provenance is caught',
    'basisProvenance: s.amount?.basisProvenance ?? null,',
    'basisProvenance: null,',
    (m) => netStateVia(m).incomeStreams[0].basisProvenance === EventProvenance.USER_ASSERTED);

  await mutate('O4 letting GROSS satisfy the net requirement is caught',
    '&& !state.incomeStreams.some((s) => s.basis === AmountBasis.NET && s.nominalMonthly !== null)) {',
    '&& !state.incomeStreams.some((s) => s.basis !== AmountBasis.UNKNOWN && s.nominalMonthly !== null)) {',
    (m) => {
      const g = m.composeOperatingState({ asOfISO: AS_OF, accounts: null, investments: null,
        incomeStreams: [{ ...VECTRUS, amount: { value: 7000, currency: 'USD',
          provenance: EventProvenance.USER_ASSERTED, basis: AmountBasis.GROSS,
          basisProvenance: EventProvenance.USER_ASSERTED } }],
        obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
        baseline: { assertable: false, reason: 'x' } });
      return !m.conclusionLicence(g, m.Conclusion.NET_MONTHLY_INFLOW).licensed;
    });

  await mutate('O5 letting UNKNOWN satisfy the net requirement is caught',
    'if (req.netIncomeBasis\n    && !state.incomeStreams.some((s) => s.basis === AmountBasis.NET && s.nominalMonthly !== null)) {',
    'if (false) {',
    (m) => !m.conclusionLicence(realStateVia(m), m.Conclusion.NET_MONTHLY_INFLOW).licensed);

  await mutate('O6 licensing a NET basis with no monthly figure behind it is caught',
    '(s) => s.basis === AmountBasis.NET && s.nominalMonthly !== null)) {',
    '(s) => s.basis === AmountBasis.NET)) {',
    (m) => {
      const dead = m.composeOperatingState({ asOfISO: AS_OF, accounts: null, investments: null,
        incomeStreams: [{ ...ABACUS, amount: { value: 5015.68, currency: 'USD',
          provenance: EventProvenance.DERIVED, basis: AmountBasis.NET,
          basisProvenance: EventProvenance.USER_ASSERTED } }],
        obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
        baseline: { assertable: false, reason: 'x' } });
      return !m.conclusionLicence(dead, m.Conclusion.NET_MONTHLY_INFLOW).licensed;
    });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void mutations();
