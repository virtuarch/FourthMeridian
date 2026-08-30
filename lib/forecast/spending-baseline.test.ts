/**
 * lib/forecast/spending-baseline.test.ts   (FORECAST-6)
 *
 * WHAT ORDINARY SPENDING LOOKS LIKE NOW — PINNED.
 *
 *     npx tsx lib/forecast/spending-baseline.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * Asked what the user normally spends, the system averaged three materially
 * different months and projected the result. The average held a debt payoff, a
 * holiday and a round of gifts, and described no month the user had lived.
 *
 * ── The finding ─────────────────────────────────────────────────────────────
 * On the real Space the honest answer is UNKNOWN. Discretionary spending runs
 * $1,943–$16,144 per 28 days; the most recent complete period has no neighbour
 * close enough to join it. A number appears only if the band is widened until
 * "the same level" spans a threefold range, or by discarding a third of the
 * evidence. Both manufacture an answer.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   structural exclusion happens BEFORE statistics;
 *   a trailing average is never the baseline;
 *   old and new regimes are never blended;
 *   the latest period does not win;
 *   category is NOT an exception authority — travel is this user's largest;
 *   every excluded period carries an explicit reason;
 *   and obligations are counted somewhere else.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BASELINE, SpendExclusion, PeriodBasis, isOrdinaryConsumption,
  deriveSpendingBaseline, assertedSpendingBaseline, monthlyRate,
  periodSummary, describeSpendingBaseline,
  type SpendObservation, type SpendingBaseline,
} from './spending-baseline';
import { EventProvenance } from './future-cash-event';
import { COST_FLOWS, SERIALIZED_SPENDING_FLOWS } from '../transactions/flow-predicates';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const src = readFileSync(join(__dirname, 'spending-baseline.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** Code with comments AND string literals removed. The rendering DISCLOSES that
 *  obligations are separate; a scan for the word finds the disclosure and calls
 *  it the offence. */
const codeOnly = code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
const AS_OF = '2026-08-27';
const D = BASELINE.PERIOD_DAYS;

const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Build periods of spending from totals, newest last, each spread over four
 * transactions.
 *
 * ⚠️ A BOUNDARY PERIOD is prepended automatically. The oldest window always
 * begins before the first observation, so the authority reports it
 * PARTIAL_PERIOD and never uses it — a real property, not a fixture quirk.
 * Without the pad, `periods([a, b, c])` would offer only two usable windows.
 */
function periods(totals: number[], flowType = 'SPENDING'): SpendObservation[] {
  const padded = [totals[0], ...totals];
  const out: SpendObservation[] = [];
  padded.forEach((total, idx) => {
    const back = (padded.length - 1 - idx) * D;
    for (let k = 0; k < 4; k++) {
      out.push({ dateISO: shift(AS_OF, -(back + 2 + k * 5)), amount: -total / 4, currency: 'USD', flowType });
    }
  });
  return out;
}
const derive = (totals: number[], exceptions?: Parameters<typeof deriveSpendingBaseline>[2]) =>
  deriveSpendingBaseline(periods(totals), AS_OF, exceptions);
const amountOf = (b: SpendingBaseline) => (b.assertable ? b.amount : null);

// ═══════════════════════════════════════════════════════════════════════════
// A. Economic population — structural, before any statistics
// ═══════════════════════════════════════════════════════════════════════════

eq('A1 SPENDING is ordinary consumption', isOrdinaryConsumption('SPENDING'), true);
eq('A2 FEE is too', isOrdinaryConsumption('FEE'), true);
eq('A3 a TRANSFER is not', isOrdinaryConsumption('TRANSFER'), false);
eq('A4 a DEBT_PAYMENT is not', isOrdinaryConsumption('DEBT_PAYMENT'), false);
eq('A5 a REFUND is not', isOrdinaryConsumption('REFUND'), false);
eq('A6 an INVESTMENT flow is not', isOrdinaryConsumption('INVESTMENT'), false);
eq('A7 an unclassified row is not', isOrdinaryConsumption(null), false);
check('A8 the population is the CANONICAL set, not a local list',
  /SERIALIZED_SPENDING_FLOWS\.has\(flowType\)/.test(code)
  && /from '\.\.\/transactions\/flow-predicates'/.test(src));
eq('A9 which is exactly {SPENDING, FEE}', [...SERIALIZED_SPENDING_FLOWS].sort(), ['FEE', 'SPENDING']);
check('A10 INTEREST is deliberately NOT included — it would double-count debt service',
  COST_FLOWS.has('INTEREST') && !SERIALIZED_SPENDING_FLOWS.has('INTEREST')
  && /double|twice/i.test(src));
check('A11 no merchant or category heuristic exists anywhere',
  !/merchant|category/i.test(code));

// A debt payoff cannot reach the statistics at all.
const withPayoff = deriveSpendingBaseline([
  ...periods([4000, 4100, 3900, 4050]),
  { dateISO: shift(AS_OF, -3), amount: -7500, currency: 'USD', flowType: 'DEBT_PAYMENT' },
], AS_OF);
eq('A12 a $7,500 payoff does not enter the baseline', amountOf(withPayoff), amountOf(derive([4000, 4100, 3900, 4050])));
check('A13 structural exclusion runs BEFORE the walk',
  code.indexOf('isOrdinaryConsumption') < code.indexOf('const included: number[]'));

// ═══════════════════════════════════════════════════════════════════════════
// B. A trailing average is never the baseline
// ═══════════════════════════════════════════════════════════════════════════

// The measured live failure: three materially different periods.
const volatile3 = derive([4000, 12000, 4200]);
const naive3 = (4000 + 12000 + 4200) / 3;
check('B1 three volatile periods do NOT yield their average',
  !volatile3.assertable || amountOf(volatile3) !== naive3,
  `naive=${naive3}, got ${amountOf(volatile3)}`);
eq('B2 they yield UNKNOWN', volatile3.assertable, false);
check('B3 no mean is computed anywhere in the module',
  !/reduce\(\(a, ?b\) => a \+ b\) *\/|\/ *\w+\.length/.test(code));
check('B4 the level is a MEDIAN of included periods only',
  /const amount = median\(included\);/.test(code));

// A fixture where the three candidate answers are three different numbers, so
// the distinction is behavioural and not merely a source scan:
//   median of included   4000
//   mean of last three   4333.33
//   latest period        5000
const discriminating = derive([4000, 4000, 4000, 5000]);
check('B5 the answer is the MEDIAN, not the trailing mean, not the latest',
  discriminating.assertable && (discriminating as {amount:number}).amount === 4000,
  JSON.stringify(amountOf(discriminating)));
check('B6 all four periods are in the regime — none was dropped to get there',
  discriminating.assertable && (discriminating as {observationCount:number}).observationCount === 4);
check('B7 and the three candidate answers really are far apart on this fixture', (() => {
  const totals = discriminating.periods.filter((p) => p.included).map((p) => p.total);
  const trailingMean = totals.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const latest = totals[0];
  const derived = amountOf(discriminating)!;
  return Math.abs(trailingMean - derived) > 300 && Math.abs(latest - derived) > 900;
})());

// ═══════════════════════════════════════════════════════════════════════════
// C. Regime detection
// ═══════════════════════════════════════════════════════════════════════════

const stable = derive([4000, 4100, 3900, 4050]);
check('C1 a stable level is ASSERTABLE', stable.assertable, JSON.stringify(stable).slice(0, 200));
if (stable.assertable) {
  check('C2 near the level', Math.abs(stable.amount - 4025) < 100, String(stable.amount));
  eq('C3 on four periods', stable.observationCount, 4);
  eq('C4 basis is stated, never assumed', stable.periodBasis, PeriodBasis.PER_28_DAYS);
  eq('C5 provenance is DERIVED', stable.provenance, EventProvenance.DERIVED);
}

// Old regime → new regime: never blended.
const shifted = derive([8000, 8200, 7900, 4000, 4100, 3950]);
check('C6 a regime change resolves to the RECENT level', shifted.assertable);
if (shifted.assertable) {
  check('C7 near 4,000, nowhere near the blend', Math.abs(shifted.amount - 4000) < 200, String(shifted.amount));
  eq('C8 on three periods', shifted.observationCount, 3);
  check('C9 the old regime is excluded FOR REGIME REASON',
    shifted.periods.slice(3, 6).every((p) => p.excludedBecause === SpendExclusion.OUTSIDE_CURRENT_REGIME),
    JSON.stringify(shifted.periods.map((p) => p.excludedBecause)));
  check('C10 the blend of both regimes is a different number',
    Math.abs(shifted.amount - (8000 + 8200 + 7900 + 4000 + 4100 + 3950) / 6) > 1500);
}

// Latest does not win.
const spike = derive([4000, 4100, 3900, 4050, 9000]);
check('D1 one latest high period does not become the baseline',
  !spike.assertable || amountOf(spike) !== 9000, String(amountOf(spike)));
check('D2 it is either withheld or the prior level is kept',
  !spike.assertable || Math.abs((spike as {amount:number}).amount - 4025) < 200,
  JSON.stringify(spike).slice(0, 220));
const sustained = derive([4000, 4100, 3900, 6800, 7000, 6900]);
check('D3 a SUSTAINED shift does become the current regime', sustained.assertable);
if (sustained.assertable) {
  check('D4 at the new level', Math.abs(sustained.amount - 6900) < 200, String(sustained.amount));
  eq('D5 with a regime start', sustained.regimeStartISO, sustained.periods[2].fromISO);
}

// ═══════════════════════════════════════════════════════════════════════════
// E. Thresholds and evidence
// ═══════════════════════════════════════════════════════════════════════════

eq('E1 the period is 28 days', BASELINE.PERIOD_DAYS, 28);
eq('E2 the band is 25%', BASELINE.BAND, 0.25);
eq('E3 three periods minimum', BASELINE.MIN_PERIODS, 3);
eq('E4 one period is never a regime', derive([4000]).assertable, false);
eq('E5 two are never enough', derive([4000, 4050]).assertable, false);
eq('E6 three stable periods suffice', derive([4000, 4050, 3980]).assertable, true);
eq('E7 genuinely volatile history is UNKNOWN',
  derive([2000, 9000, 3000, 12000, 4000, 1500]).assertable, false);
check('E8 outliers may not exceed a third of the regime',
  BASELINE.MAX_OUTLIER_SHARE === 1 / 3
  && !derive([4000, 9000, 4100, 9500, 3900, 8800, 4050]).assertable);
check('E9 and the refusal names the manufacturing risk', (() => {
  const b = derive([4000, 9000, 4100, 9500, 3900, 8800, 4050]);
  return !b.assertable && /manufacture a level/.test(b.reason);
})());

// ═══════════════════════════════════════════════════════════════════════════
// F. Exception authority — what may be called exceptional
// ═══════════════════════════════════════════════════════════════════════════

const travelPeriods = [4000, 4100, 12000, 3900, 4050];
const noEvidence = derive(travelPeriods);
check('F1 a big travel period is NOT silently erased', (() => {
  const p = noEvidence.periods.find((x) => Math.abs(x.total - 12000) < 1);
  return p !== undefined && p.excludedBecause !== SpendExclusion.USER_ASSERTED_EXCEPTION;
})());
check('F2 without evidence it is an OUTLIER or a regime break — never "exceptional by category"', (() => {
  const p = noEvidence.periods.find((x) => Math.abs(x.total - 12000) < 1)!;
  return p.excludedBecause === SpendExclusion.STATISTICAL_OUTLIER
    || p.excludedBecause === SpendExclusion.OUTSIDE_CURRENT_REGIME;
})());
check('F3 there is NO travel, gift or holiday rule — measured, travel is this user\'s largest category',
  !/travel|gift|holiday|vacation/i.test(code) && /LARGEST CATEGORY/i.test(src));

// With user evidence, it is excluded WITH provenance.
const marked = derive(travelPeriods, [{ fromISO: shift(AS_OF, -2 * D - 10), toISO: shift(AS_OF, -2 * D + 5), note: 'that trip was one-time' }]);
check('F4 a user-asserted exception excludes the period', (() => {
  const p = marked.periods.find((x) => Math.abs(x.total - 12000) < 1);
  return p?.excludedBecause === SpendExclusion.USER_ASSERTED_EXCEPTION;
})(), JSON.stringify(marked.periods.map((p) => [p.total, p.excludedBecause])));
check('F5 and the remaining periods can then form a regime', marked.assertable);
eq('F6 every excluded period carries an explicit reason',
  noEvidence.periods.every((p) => p.included || p.excludedBecause !== null), true);
check('F7 exclusion reasons are a closed, named set',
  Object.keys(SpendExclusion).length === 5
  && ['STRUCTURAL_NON_CONSUMPTION', 'USER_ASSERTED_EXCEPTION', 'STATISTICAL_OUTLIER',
      'OUTSIDE_CURRENT_REGIME', 'PARTIAL_PERIOD'].every((k) => k in SpendExclusion));
check('F8 the summary is inspectable', typeof periodSummary(stable).included === 'number');

// ═══════════════════════════════════════════════════════════════════════════
// G. Partial periods
// ═══════════════════════════════════════════════════════════════════════════

const withOld = deriveSpendingBaseline([
  ...periods([4000, 4100, 3900]),
  { dateISO: shift(AS_OF, -3 * D - 5), amount: -900, currency: 'USD', flowType: 'SPENDING' },
], AS_OF);
check('G1 the oldest window — which begins before the first observation — is PARTIAL_PERIOD', (() => {
  const partials = withOld.periods.filter((x) => x.excludedBecause === SpendExclusion.PARTIAL_PERIOD);
  return partials.length === 1 && partials[0] === withOld.periods[withOld.periods.length - 1];
})(), JSON.stringify(withOld.periods.map((p) => [p.total, p.excludedBecause])));
check('G2 and never scaled up to look whole',
  !/\* *\(?\s*PERIOD_DAYS *\/|prorat|annualiz/i.test(code));
check('G3 fixed windows put the incomplete stretch at the OLD end — the newest period is whole by construction',
  withOld.periods[0].included === true);
check('G4 a partial period does not participate in the level',
  amountOf(withOld) === amountOf(derive([4000, 4100, 3900])));
// Ledger lag: unreported days are not quiet days.
const lagged = deriveSpendingBaseline(periods([4000, 4100, 3900]), AS_OF, [], shift(AS_OF, -10));
check('G5 periods are measured from the LEDGER\'S reach when it lags the as-of date',
  lagged.periods[0].toISO === shift(AS_OF, -10), lagged.periods[0].toISO);
check('G6 which the module explains',
  /has not yet[\s\S]{0,12}reported are not quiet days/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// H. User assertions
// ═══════════════════════════════════════════════════════════════════════════

const said = assertedSpendingBaseline(4000, 'USD', PeriodBasis.MONTHLY, AS_OF, stable);
eq('H1 a stated baseline is assertable with USER_ASSERTED provenance',
  [said.assertable, said.provenance, said.amount], [true, EventProvenance.USER_ASSERTED, 4000]);
eq('H2 with the stated basis, not a guessed one', said.periodBasis, PeriodBasis.MONTHLY);
check('H3 the derived evidence survives underneath', said.periods.length === stable.periods.length);
check('H4 and the reason names both figures', /user stated/.test(said.reason) && /ledger shows/.test(said.reason),
  said.reason);
check('H5 "I spend a lot" cannot enter — the API requires a number',
  /export function assertedSpendingBaseline\(\s*amount: number,/.test(src));
check('H6 nothing is persisted', !/\.create\(|\.upsert\(|\.update\(/i.test(code));
check('H7 an assertion does not rewrite transaction classification',
  !/flowType *=|classif/i.test(code.replace(/isOrdinaryConsumption[\s\S]{0,120}/, '')));

// ═══════════════════════════════════════════════════════════════════════════
// I. Units
// ═══════════════════════════════════════════════════════════════════════════

if (stable.assertable) {
  eq('I1 a 28-day level converts to a monthly RATE by the mean Gregorian month',
    monthlyRate(stable), stable.amount / 28 * (365.2425 / 12));
  check('I2 which is NOT the same number as the 28-day figure', monthlyRate(stable) !== stable.amount);
}
eq('I3 an asserted monthly figure is already monthly', monthlyRate(said), 4000);
check('I4 the rendering states the unit', /per 28 days/.test(describeSpendingBaseline(stable).join(' ')));

// ═══════════════════════════════════════════════════════════════════════════
// J. Obligations stay separate
// ═══════════════════════════════════════════════════════════════════════════

// The prose explains the separation on purpose; the CODE must not know.
check('J1 the module CODE knows nothing about obligations', !/obligation/i.test(codeOnly),
  codeOnly.match(/.{0,50}obligation.{0,20}/i)?.[0]);
check('J2 debt service cannot enter the population — it is not consumption',
  !isOrdinaryConsumption('DEBT_PAYMENT'));
// A rent-sized SPENDING row is ordinary consumption here and an obligation there;
// the two authorities see different populations and cannot double-count.
const rentLike = deriveSpendingBaseline([
  ...periods([4000, 4100, 3900]),
  ...[0, 1, 2].map((i) => ({ dateISO: shift(AS_OF, -(i * D + 1)), amount: -2400,
    currency: 'USD', flowType: 'SPENDING' })),
], AS_OF);
check('J3 a recurring large SPENDING row raises the baseline without becoming an obligation',
  rentLike.assertable && (rentLike as {amount:number}).amount > 6000,
  JSON.stringify(amountOf(rentLike)));
check('J4 and nothing here claims it is committed', !/commit|contract|due/i.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// K. "Recurring" is not the authority
// ═══════════════════════════════════════════════════════════════════════════

check('K1 RecurringCandidate is not imported', !/RecurringCandidate|lib\/ai/.test(src));
check('K2 no frequency or count threshold licenses anything',
  !/occurrences|frequency|seenCount|>= *\d+ *(?:&&|\))/.test(code));
check('K3 transaction counts are carried as DIAGNOSTICS only', (() => {
  const walk = code.slice(code.indexOf('const included: number[]'), code.indexOf('const amount = median'));
  return !/transactionCount/.test(walk);
})());

// ═══════════════════════════════════════════════════════════════════════════
// L. Substrate discipline
// ═══════════════════════════════════════════════════════════════════════════

check('L1 no database', !/from ['"]@?\/?lib\/db|prisma/i.test(code));
check('L2 no clock — asOf is required', !/Date\.now\(\)|new Date\(\)[^.]/.test(code));
check('L3 no FutureCashEvent is manufactured for a baseline',
  !/FutureCashEvent|cadenceDerivedEvents/.test(code));
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
 * reaches for. A test and a conformance fixture build inputs for the authority
 * on purpose — `lib/ai/conformance/forecast-scenarios.ts` constructs the real
 * Space's streams so the language model can be measured against them — and
 * counting those as consumers would make the gate fail for the act of testing
 * the thing it protects.
 */
const isProductionFile = (f: string) =>
  !f.endsWith('.test.ts')
  && !f.startsWith('lib/ai/conformance/')
  // FORECAST-12: the operator conformance harnesses build the authority's own
  // inputs so the language model can be measured against them. They ship no
  // behaviour and are registered OPERATIONAL, never as gates.
  && !/^scripts\/check-forecast-/.test(f);
check('L4 FORECAST-6 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/spending-baseline" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
// baseline to the WORKING TREE, which quietly turns "FORECAST-6 touched none of
// its dependencies" into "no future slice may touch them either" — a claim
// FORECAST-6 has no standing to make. FORECAST-9A edits periodic-amount.ts by
// design, to give a user-asserted income basis somewhere to land, and tripped
// it. The same form is still present in four sibling suites and will trip the
// next slice that edits one of their dependencies.
check('L5 FORECAST-6 did not touch FORECAST-1..5',
  execSync('git diff --name-only 0506c67 5ca025a -- lib/forecast/cadence.ts lib/forecast/stream-activity.ts lib/forecast/future-cash-event.ts lib/forecast/obligation.ts lib/forecast/periodic-amount.ts',
    { encoding: 'utf8' }).trim() === '');
check('L6 nor flow-predicates',
  execSync('git diff --name-only 0506c67 5ca025a -- lib/transactions/flow-predicates.ts', { encoding: 'utf8' }).trim() === '');
check('L7 no category decomposition was built', !/byCategory|categoryBaseline/.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// M. THE REAL SPACE
// ═══════════════════════════════════════════════════════════════════════════

/** Real 28-day consumption totals from Chris' Space, newest first. */
const REAL = [5681.07, 1943.35, 3916.40, 16144.42, 6190.66, 3501.67, 4869.51,
  6510.52, 4191.70, 7220.08, 3974.98, 8840.99, 4828.34, 5181.37];
const real = derive([...REAL].reverse());

eq('M1 the real Space yields UNKNOWN', real.assertable, false);
check('M2 because recent spending does not repeat closely enough',
  !real.assertable && /does not repeat closely enough/.test(real.reason), (real as {reason:string}).reason);
check('M3 the range is 8.3x — this is a finding, not a tuning problem',
  Math.max(...REAL) / Math.min(...REAL) > 8);
check('M4 and no naive average is offered in its place',
  !describeSpendingBaseline(real).join(' ').match(/\d{4}/),
  describeSpendingBaseline(real).join(' '));
check('M5 the refusal forbids stating a figure',
  /No baseline spending figure may be stated/.test(describeSpendingBaseline(real).join('\n')));
// The naive answers, for contrast — and they disagree with each other by 24%.
check('M6 the naive 3-month and 6-month averages differ materially from each other',
  Math.abs(8349.66 - 6712.88) / 6712.88 > 0.2);

// ═══════════════════════════════════════════════════════════════════════════
// N. Regression corpus A–O
// ═══════════════════════════════════════════════════════════════════════════

eq('N-A three volatile periods → no simple average', volatile3.assertable, false);
eq('N-B a debt payoff is structurally excluded', amountOf(withPayoff), amountOf(derive([4000, 4100, 3900, 4050])));
check('N-C a travel period marked one-time is excluded WITH provenance',
  marked.periods.find((p) => Math.abs(p.total - 12000) < 1)?.excludedBecause
  === SpendExclusion.USER_ASSERTED_EXCEPTION);
check('N-D the same period without evidence is not silently erased',
  noEvidence.periods.find((p) => Math.abs(p.total - 12000) < 1)?.excludedBecause
  !== SpendExclusion.USER_ASSERTED_EXCEPTION);
check('N-E gifts marked one-time behave the same way', derive([4000, 11000, 4100, 3900],
  [{ fromISO: shift(AS_OF, -3 * D + 1), toISO: shift(AS_OF, -2 * D), note: 'gifts' }]).assertable);
eq('N-F a stable regime is ASSERTABLE', stable.assertable, true);
check('N-G historical 8k → recent 4k uses the recent regime only',
  shifted.assertable && Math.abs((shifted as {amount:number}).amount - 4000) < 200);
check('N-H a latest 9k spike does not win', !spike.assertable || amountOf(spike) !== 9000);
check('N-I a sustained 7k shift becomes the new regime',
  sustained.assertable && Math.abs((sustained as {amount:number}).amount - 6900) < 200);
check('N-J a partial period is not treated as whole',
  withOld.periods.some((p) => p.excludedBecause === SpendExclusion.PARTIAL_PERIOD));
eq('N-K transfers are excluded structurally', isOrdinaryConsumption('TRANSFER'), false);
eq('N-L investment flows are excluded structurally', isOrdinaryConsumption('INVESTMENT'), false);
eq('N-M volatile discretionary history → UNKNOWN', real.assertable, false);
eq('N-N a user-asserted baseline is representable', said.provenance, EventProvenance.USER_ASSERTED);
check('N-O obligations and baseline do not double-count',
  !isOrdinaryConsumption('DEBT_PAYMENT') && !/obligation/i.test(codeOnly));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
