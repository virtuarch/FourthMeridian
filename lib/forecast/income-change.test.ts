/**
 * lib/forecast/income-change.test.ts   (I1)
 *
 * A DATED RAISE, AND THE EVIDENCE IT LEFT — PINNED.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/forecast/income-change.test.ts
 *
 * ── What this test is for ───────────────────────────────────────────────────
 * Everything here is arithmetic over dates that a reader will believe on sight,
 * which is precisely why it needs pinning rather than reviewing. Four classes of
 * failure are cheap to introduce and expensive to notice:
 *
 *   1. A UNIT that reads correctly and divides by the wrong number. "$15,000 a
 *      month" on a biweekly stream is $6,923.08 a cheque, not $15,000 — and the
 *      wrong answer is a perfectly well-typed number, 2.17× too large, that
 *      survives every review because it is the figure the sentence contains.
 *   2. A BOUNDARY off by one occurrence. `from` is inclusive everywhere here,
 *      and for STOP it is the first date NOT paid. Both readings are defensible
 *      in prose and only one of them is the contract, so the exact boundary date
 *      is asserted on both sides for every op that has one.
 *   3. A REACH that is wider than the sentence. An unqualified "my income goes
 *      up 10%" is a pay rise; it does not raise what a bank pays in interest,
 *      and it does not reach a stream that is not projected at all.
 *   4. EVIDENCE that outlives the thing it evidences. `ran` is computed from a
 *      diff of the arrays, so this file spends a whole section trying to make a
 *      rule that changed nothing report that it did — by labelling it, by naming
 *      it after its own conclusion, by putting it beside a rule that did run.
 *      None of it may work.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   every rate conversion goes through the cadence's own annual factor;
 *   `from` is INCLUSIVE, and for STOP it is the first date not paid;
 *   an unqualified rule reaches EARNED income only;
 *   an unreachable rule reports `ran: false` WITH a reason, never silence;
 *   `ran` ≡ `occurrencesChanged > 0`, in every case in this file;
 *   a one-off and an outflow are unreachable by every rule;
 *   a rule that cannot be represented is refused WHOLE, and emits no execution;
 *   a GROSS rate executes perfectly and REMOVES money from the projection —
 *     and a rule is not answerable for money that was unspendable before it;
 *   the input array and its objects are never mutated.
 *
 * ⚠️ THE FIXTURE IS SYNTHETIC AND HAND-COMPUTED. Unlike cadence.test.ts and
 * periodic-amount.test.ts, which end in the real ledger, nothing here touches a
 * live figure: the whole point is that every expected total is a number a reader
 * can verify in their head (27 × 1000, 180000 ÷ 26), so a disagreement between
 * this file and the module is never resolvable by trusting the module.
 */

import {
  IncomeChangeOp, RatePeriod, applyIncomeChanges, invalidIncomeChange,
  perOccurrence, startedSourceKey,
  type IncomeChangeExecution, type IncomeChangeResult, type IncomeChangeRule,
  type IncomeStreamRef, type RatePeriodKind,
} from './income-change';
import {
  AmountBasis, EventProvenance, FlowRole, observedCashContribution,
  type FutureCashEvent,
} from './future-cash-event';
import { CadenceKind, perOccurrenceFromAnnual, perOccurrenceFromMonthly } from './cadence';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
/** Money comparisons that survive f64. NEVER used where an exact figure is the point. */
const near = (name: string, actual: number, expected: number, tol = 1e-9) =>
  check(name, Math.abs(actual - expected) <= tol, `expected ≈${expected}, got ${actual}`);
const has = (name: string, haystack: string | undefined, needle: string) =>
  check(name, typeof haystack === 'string' && haystack.includes(needle),
    `"${needle}" not in ${JSON.stringify(haystack)}`);

// ── The fixture ─────────────────────────────────────────────────────────────

const HORIZON = { fromISO: '2027-01-01', toISO: '2027-12-31' };

/**
 * Dates every `step` days, inclusive.
 *
 * ⚠️ DELIBERATELY NOT `occurrencesBetween`. The module uses that function for
 * START, so generating the fixture with it would let one bug cancel another — a
 * schedule wrong in the same way in both places agrees with itself and passes.
 * Fourteen days added in UTC is the whole of what BIWEEKLY means, and it is
 * spelled out here.
 */
function stepDays(startISO: string, step: number, untilISO: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${startISO}T00:00:00.000Z`);
  const end = Date.parse(`${untilISO}T00:00:00.000Z`);
  while (t <= end) { out.push(new Date(t).toISOString().slice(0, 10)); t += step * 86_400_000; }
  return out;
}
const monthlyOn = (day: number): string[] =>
  Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

/** 2027 is not a leap year: Jan 1 + 26 × 14 days = Dec 31, so 27 paydays land in it. */
const ACME_DATES = stepDays('2027-01-01', 14, '2027-12-31');
const ACME_PAY = 1000;
const ACME_TOTAL = 27 * ACME_PAY;                       // 27,000 — by hand.

const CLIENT_DATES = monthlyOn(15);
const CLIENT_PAY = 500;
const CLIENT_TOTAL = 12 * CLIENT_PAY;                   // 6,000 — by hand.

const ACME = 'acme@acct1', CLIENT = 'client@acct2', DORMANT = 'dormant@acct3', SAVINGS = 'savings@acct4';

/**
 * One derived payroll occurrence, in the shape `cadenceDerivedEvents` produces:
 * an EXACT date the cadence supplied, an amount whose gross/net question never
 * arose because the credit was observed settling, and DERIVED on both.
 */
const ev = (
  sourceKey: string, dateISO: string, value: number, over: Partial<FutureCashEvent> = {},
): FutureCashEvent => ({
  id: `${sourceKey}@${dateISO}`,
  timing: { kind: 'EXACT', dateISO },
  timingProvenance: EventProvenance.DERIVED,
  direction: 'INFLOW',
  role: FlowRole.INCOME,
  amount: {
    value, currency: 'USD', basis: AmountBasis.UNKNOWN,
    provenance: EventProvenance.DERIVED, observedSettled: true,
  },
  sourceKey,
  ...over,
});

/**
 * A single asserted bonus. ⚠️ NO `sourceKey` — that absence is the whole of what
 * makes it unreachable, and section 23 exists to prove it stays unreachable.
 */
const ONE_OFF: FutureCashEvent = {
  id: 'oneoff:bonus@2027-06-15',
  timing: { kind: 'EXACT', dateISO: '2027-06-15' },
  timingProvenance: EventProvenance.USER_ASSERTED,
  direction: 'INFLOW',
  role: FlowRole.INCOME,
  amount: { value: 2500, currency: 'USD', basis: AmountBasis.GROSS, provenance: EventProvenance.USER_ASSERTED },
};

/**
 * ⚠️ CONTRIVED ON PURPOSE. An OUTFLOW carrying the INCOME role and the SAME
 * `sourceKey` as the scaled stream, so the only thing keeping a rule off it is
 * `direction`. A natural rent row would pass section 24 for three reasons at
 * once and prove none of them.
 */
const OUTFLOW: FutureCashEvent = ev(ACME, '2027-05-07', 300,
  { direction: 'OUTFLOW', id: 'acme:clawback@2027-05-07' });

const DORMANT_DATES = monthlyOn(20);
const SAVINGS_DATES = monthlyOn(28);

const BASE_EVENTS: FutureCashEvent[] = [
  ...ACME_DATES.map((d) => ev(ACME, d, ACME_PAY)),
  ...CLIENT_DATES.map((d) => ev(CLIENT, d, CLIENT_PAY)),
  ...DORMANT_DATES.map((d) => ev(DORMANT, d, 100)),
  ...SAVINGS_DATES.map((d) => ev(SAVINGS, d, 40, { role: FlowRole.INTEREST })),
  ONE_OFF,
  OUTFLOW,
];
const BASE_SNAPSHOT = JSON.stringify(BASE_EVENTS);

const STREAMS: IncomeStreamRef[] = [
  { sourceKey: ACME,    label: 'Acme payroll',      role: FlowRole.INCOME,
    cadence: CadenceKind.BIWEEKLY, projectionEligible: true },
  { sourceKey: CLIENT,  label: 'Consulting client', role: FlowRole.INCOME,
    cadence: CadenceKind.MONTHLY,  projectionEligible: true },
  // Present and nameable, and NOT swept up by an unqualified rule — section 17.
  { sourceKey: DORMANT, label: 'Old stipend',       role: FlowRole.INCOME,
    cadence: CadenceKind.MONTHLY,  projectionEligible: false },
  // Projected, earning, and still not what "a raise" means — section 17b.
  { sourceKey: SAVINGS, label: 'Savings interest',  role: FlowRole.INTEREST,
    cadence: CadenceKind.MONTHLY,  projectionEligible: true },
];

/** Every execution this file produced, for the cross-cutting invariants at the end. */
const ALL_EXECUTIONS: IncomeChangeExecution[] = [];

function run(rules: IncomeChangeRule[], o: {
  events?: readonly FutureCashEvent[];
  streams?: readonly IncomeStreamRef[];
  horizon?: { fromISO: string; toISO: string };
} = {}): IncomeChangeResult {
  const res = applyIncomeChanges({
    events: o.events ?? BASE_EVENTS,
    streams: o.streams ?? STREAMS,
    rules,
    horizon: o.horizon ?? HORIZON,
    currency: 'USD',
  });
  ALL_EXECUTIONS.push(...res.executions);
  return res;
}

/** The dated inflows of one stream, by date, out of a result. */
const valuesOf = (res: IncomeChangeResult, sourceKey: string): Record<string, number> =>
  Object.fromEntries(res.events
    .filter((e) => e.sourceKey === sourceKey && e.direction === 'INFLOW' && e.timing.kind === 'EXACT')
    .map((e) => [(e.timing as { dateISO: string }).dateISO, e.amount?.value ?? NaN]));
const sumOf = (res: IncomeChangeResult, sourceKey: string): number =>
  Object.values(valuesOf(res, sourceKey)).reduce((a, b) => a + b, 0);
/** Everything the rules were not about, serialised — for byte-identity claims. */
const othersJSON = (res: IncomeChangeResult, ...exclude: string[]): string =>
  JSON.stringify(res.events.filter((e) => !e.sourceKey || !exclude.includes(e.sourceKey)));

const SCALE = IncomeChangeOp.SCALE, SET_RATE = IncomeChangeOp.SET_RATE;
const STOP = IncomeChangeOp.STOP, START = IncomeChangeOp.START;
const net = (amount: number, per: RatePeriodKind = RatePeriod.OCCURRENCE) =>
  ({ amount, per, currency: 'USD', basis: AmountBasis.NET });

// ═══════════════════════════════════════════════════════════════════════════
// 0. The fixture is what this file thinks it is
// ═══════════════════════════════════════════════════════════════════════════

eq('0.1 the biweekly stream has 27 paydays in 2027', ACME_DATES.length, 27);
eq('0.2 first and last', [ACME_DATES[0], ACME_DATES[26]], ['2027-01-01', '2027-12-31']);
eq('0.3 the monthly stream has 12', CLIENT_DATES.length, 12);
eq('0.4 nominal totals are round numbers by construction', [ACME_TOTAL, CLIENT_TOTAL], [27000, 6000]);

// ═══════════════════════════════════════════════════════════════════════════
// 1. SCALE +10% from the start of the horizon
// ═══════════════════════════════════════════════════════════════════════════

const r1 = run([{ id: 'r1', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 }]);
const x1 = r1.executions[0];

eq('1.1 one rule, one execution, nothing rejected', [r1.executions.length, r1.rejected.length], [1, 0]);
check('1.2 it ran', x1.ran === true, JSON.stringify(x1));
eq('1.3 every one of the 27 occurrences changed', x1.occurrencesChanged, 27);
eq('1.4 the changed window is the whole year',
  [x1.firstChangedISO, x1.lastChangedISO], ['2027-01-01', '2027-12-31']);
eq('1.5 nominalBefore is the hand-computed total', x1.nominalBefore, ACME_TOTAL);
near('1.6 nominalAfter is that total × 1.1', x1.nominalAfter, ACME_TOTAL * 1.1);
near('1.7 and 27 cheques of exactly 1,100 is what produced it', sumOf(r1, ACME), 27 * 1100);
check('1.8 every occurrence is 1,100, not just the sum',
  Object.values(valuesOf(r1, ACME)).every((v) => v === 1100),
  JSON.stringify(valuesOf(r1, ACME)));
eq('1.9 the stream is named, with its label', x1.matched, [{ sourceKey: ACME, label: 'Acme payroll' }]);
eq('1.10 and the scope says the user named it', x1.scope, 'NAMED');
check('1.11 a scaled occurrence is no longer purely DERIVED — the level is now supposed',
  r1.events.find((e) => e.id === `${ACME}@2027-03-12`)!.amount!.provenance === EventProvenance.HYPOTHETICAL);
check('1.12 but its basis and observedSettled are untouched — a tenth more of the same money',
  r1.events.find((e) => e.id === `${ACME}@2027-03-12`)!.amount!.basis === AmountBasis.UNKNOWN
  && r1.events.find((e) => e.id === `${ACME}@2027-03-12`)!.amount!.observedSettled === true);
check('1.13 a rule that ran carries no reason', x1.reason === undefined, x1.reason);

// ═══════════════════════════════════════════════════════════════════════════
// 2. SCALE starting LATER — `from` is INCLUSIVE
// ═══════════════════════════════════════════════════════════════════════════

// 2027-07-02 IS a payday. The two readings of "starting July 2nd" differ by one
// $1,000 cheque, and only one of them is the contract.
const r2 = run([{ id: 'r2', op: SCALE, sourceKey: ACME, fromISO: '2027-07-02', multiplier: 1.1 }]);
const v2 = valuesOf(r2, ACME);

eq('2.1 14 of the 27 occurrences fall on or after the boundary', r2.executions[0].occurrencesChanged, 14);
eq('2.2 THE BOUNDARY DATE ITSELF IS PAID AT THE NEW RATE', v2['2027-07-02'], 1100);
eq('2.3 the payday before it is untouched', v2['2027-06-18'], 1000);
eq('2.4 and so is the first of the year', v2['2027-01-01'], 1000);
eq('2.5 the changed window starts at the boundary',
  [r2.executions[0].firstChangedISO, r2.executions[0].lastChangedISO], ['2027-07-02', '2027-12-31']);
eq('2.6 nominalBefore counts ONLY the governed occurrences', r2.executions[0].nominalBefore, 14 * 1000);
check('2.7 the 13 untouched occurrences keep DERIVED provenance',
  r2.events.filter((e) => e.sourceKey === ACME && e.direction === 'INFLOW'
    && e.timing.kind === 'EXACT' && (e.timing as { dateISO: string }).dateISO < '2027-07-02')
    .every((e) => e.amount!.provenance === EventProvenance.DERIVED));

// ═══════════════════════════════════════════════════════════════════════════
// 3. SET_RATE stated PER MONTH onto a BIWEEKLY stream — the unit trap
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ THE MEASURED FAILURE CLASS. "$15,000 a month" is the figure in the
// sentence, so it is the figure a model writes onto the cheque. A biweekly
// stream pays 26 times a year, not 12: the right per-occurrence amount is
// 15000 × 12 ÷ 26 = 6,923.0769…, and $15,000 would overstate the year by 2.17×.
const r3 = run([{ id: 'r3', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { ...net(15000, RatePeriod.MONTH) } }]);
const v3 = valuesOf(r3, ACME);

near('3.1 each cheque is 15000 × 12 ÷ 26', v3['2027-01-01'], 180000 / 26, 1e-12);
check('3.2 AND IS NOT $15,000 — the figure the sentence contains',
  v3['2027-01-01'] !== 15000, String(v3['2027-01-01']));
check('3.3 nor 15000 ÷ 2, the other plausible wrong answer', v3['2027-01-01'] !== 7500);
eq('3.4 the conversion is the cadence authority\'s, not a local division',
  v3['2027-01-01'], perOccurrenceFromMonthly(15000, CadenceKind.BIWEEKLY));
eq('3.5 all 27 occurrences take it', r3.executions[0].occurrencesChanged, 27);
near('3.6 the governed year is 27 cheques of that, NOT 12 × 15,000',
  r3.executions[0].nominalAfter, 27 * (180000 / 26));
check('3.7 and that total is nowhere near $180,000',
  Math.abs(r3.executions[0].nominalAfter - 180000) > 1000, String(r3.executions[0].nominalAfter));

// The same trap the other way: a MONTHLY stream given a monthly rate passes
// through, so a bug that always divides by 26 shows up right here.
const r3b = run([{ id: 'r3b', op: SET_RATE, sourceKey: CLIENT, fromISO: '2027-01-01',
  rate: { ...net(15000, RatePeriod.MONTH) } }]);
eq('3.8 a MONTHLY stream given a monthly rate is paid exactly that',
  valuesOf(r3b, CLIENT)['2027-01-15'], 15000);

// ═══════════════════════════════════════════════════════════════════════════
// 4. SET_RATE stated PER YEAR onto a BIWEEKLY stream
// ═══════════════════════════════════════════════════════════════════════════

const r4 = run([{ id: 'r4', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { ...net(180000, RatePeriod.YEAR) } }]);
const v4 = valuesOf(r4, ACME);

near('4.1 $180k a year is 180000 ÷ 26 a cheque', v4['2027-01-01'], 6923.076923076923);
check('4.2 NOT 180000 ÷ 12 — that is a MONTH\'s worth on a fortnight\'s schedule',
  v4['2027-01-01'] !== 15000);
check('4.3 nor 180000 ÷ 24, the semimonthly factor', v4['2027-01-01'] !== 7500);
eq('4.4 the conversion is the cadence authority\'s',
  v4['2027-01-01'], perOccurrenceFromAnnual(180000, CadenceKind.BIWEEKLY));
// $180k/year and $15k/month are the same statement; they must produce the same cheque.
eq('4.5 an annual and a monthly statement of the same salary agree EXACTLY',
  v4['2027-01-01'], v3['2027-01-01']);
eq('4.6 perOccurrence delegates per period, and passes an occurrence figure through',
  [perOccurrence(180000, RatePeriod.YEAR, CadenceKind.BIWEEKLY),
    perOccurrence(15000, RatePeriod.MONTH, CadenceKind.BIWEEKLY),
    perOccurrence(6923, RatePeriod.OCCURRENCE, CadenceKind.BIWEEKLY)],
  [perOccurrenceFromAnnual(180000, CadenceKind.BIWEEKLY),
    perOccurrenceFromMonthly(15000, CadenceKind.BIWEEKLY), 6923]);

// ═══════════════════════════════════════════════════════════════════════════
// 5. SET_RATE stated PER OCCURRENCE — no conversion at all
// ═══════════════════════════════════════════════════════════════════════════

const r5 = run([{ id: 'r5', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { ...net(1234.56, RatePeriod.OCCURRENCE) } }]);
eq('5.1 a per-cheque figure is the cheque, to the cent', valuesOf(r5, ACME)['2027-01-01'], 1234.56);
near('5.2 on every occurrence', sumOf(r5, ACME), 27 * 1234.56);
check('5.3 a stated NET rate replaces the basis as well as the value',
  r5.events.find((e) => e.id === `${ACME}@2027-01-01`)!.amount!.basis === AmountBasis.NET);
check('5.4 and stamps the amount HYPOTHETICAL — a stated future level is nobody\'s observation',
  r5.events.find((e) => e.id === `${ACME}@2027-01-01`)!.amount!.provenance === EventProvenance.HYPOTHETICAL);
check('5.5 a rate that omits its currency inherits the call\'s',
  run([{ id: 'r5b', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
    rate: { amount: 900, per: RatePeriod.OCCURRENCE, basis: AmountBasis.NET } }])
    .events.find((e) => e.id === `${ACME}@2027-01-01`)!.amount!.currency === 'USD');

// ═══════════════════════════════════════════════════════════════════════════
// 6. STOP — `from` is the first date NOT paid
// ═══════════════════════════════════════════════════════════════════════════

const r6 = run([{ id: 'r6', op: STOP, sourceKey: ACME, fromISO: '2027-07-02' }]);
const v6 = valuesOf(r6, ACME);

eq('6.1 THE BOUNDARY DATE IS NOT PAID', v6['2027-07-02'], undefined);
eq('6.2 the payday before it IS still paid, at the old rate', v6['2027-06-18'], 1000);
eq('6.3 13 occurrences survive', Object.keys(v6).length, 13);
eq('6.4 and 14 were removed', r6.executions[0].occurrencesChanged, 14);
eq('6.5 the evidence names the occurrences that went, not the ones that stayed',
  [r6.executions[0].firstChangedISO, r6.executions[0].lastChangedISO], ['2027-07-02', '2027-12-31']);
eq('6.6 nominalBefore is what was removed; nominalAfter is nothing',
  [r6.executions[0].nominalBefore, r6.executions[0].nominalAfter], [14000, 0]);
eq('6.7 and the spendable side says the projection lost exactly that much',
  [r6.executions[0].spendableBefore, r6.executions[0].spendableAfter], [14000, 0]);
eq('6.8 the OUTFLOW sharing the sourceKey survives a STOP',
  r6.events.filter((e) => e.id === OUTFLOW.id).length, 1);

// A STOP dated between two paydays ends the stream from the next one.
const r6b = run([{ id: 'r6b', op: STOP, sourceKey: ACME, fromISO: '2027-07-01' }]);
const v6b = valuesOf(r6b, ACME);
eq('6.9 a STOP on a non-payday still keeps the payday before it', v6b['2027-06-18'], 1000);
eq('6.10 and still drops the one after', v6b['2027-07-02'], undefined);

// A bounded STOP is a gap, not an ending — the occurrences after `to` come back.
const r6c = run([{ id: 'r6c', op: STOP, sourceKey: ACME, fromISO: '2027-03-01', toISO: '2027-05-31' }]);
const v6c = valuesOf(r6c, ACME);
eq('6.11 a STOP with a `to` removes only that window', Object.keys(v6c).length, 27 - 6);
eq('6.12 and the stream resumes after it',
  [v6c['2027-02-26'], v6c['2027-03-12'], v6c['2027-06-04']], [1000, undefined, 1000]);

// ═══════════════════════════════════════════════════════════════════════════
// 7. START — a stream that did not exist
// ═══════════════════════════════════════════════════════════════════════════

const r7 = run([{ id: 'r7', op: START, sourceKey: null, fromISO: '2027-02-10',
  cadence: CadenceKind.MONTHLY, label: 'consulting', rate: { ...net(3000, RatePeriod.MONTH) } }]);
const NEW_KEY = startedSourceKey('r7');
const v7 = valuesOf(r7, NEW_KEY);

eq('7.1 eleven occurrences, February through December', Object.keys(v7).length, 11);
eq('7.2 MONTHLY TAKES ITS DAY-OF-MONTH FROM `from`, not from the 1st',
  Object.keys(v7).sort(),
  ['2027-02-10', '2027-03-10', '2027-04-10', '2027-05-10', '2027-06-10', '2027-07-10',
    '2027-08-10', '2027-09-10', '2027-10-10', '2027-11-10', '2027-12-10']);
eq('7.3 $3,000 a month on a monthly schedule is $3,000 a payment', v7['2027-02-10'], 3000);
eq('7.4 the execution counts what it minted', r7.executions[0].occurrencesChanged, 11);
eq('7.5 nothing existed before, and 11 × 3000 exists after',
  [r7.executions[0].nominalBefore, r7.executions[0].nominalAfter], [0, 33000]);
eq('7.6 the minted stream is named by the rule that made it',
  r7.executions[0].matched, [{ sourceKey: NEW_KEY, label: 'consulting' }]);
check('7.7 minted occurrences are HYPOTHETICAL in BOTH date and amount — nobody observed them',
  r7.events.filter((e) => e.sourceKey === NEW_KEY).every((e) =>
    e.timingProvenance === EventProvenance.HYPOTHETICAL
    && e.amount!.provenance === EventProvenance.HYPOTHETICAL));
check('7.8 every pre-existing event is byte-identical', othersJSON(r7, NEW_KEY) === BASE_SNAPSHOT);
check('7.9 the minted ids name the rule that is answerable for them',
  r7.events.filter((e) => e.sourceKey === NEW_KEY).every((e) => e.id.startsWith('i1:r7:')));

// The started stream joins the reachable set, so a LATER unqualified rule
// governs it — which is what "my income goes up 10%" means once a second income
// has been declared.
const r7b = run([
  { id: 'r7b-start', op: START, sourceKey: null, fromISO: '2027-02-10',
    cadence: CadenceKind.MONTHLY, label: 'consulting', rate: { ...net(3000, RatePeriod.MONTH) } },
  { id: 'r7b-raise', op: SCALE, sourceKey: null, fromISO: '2027-01-01', multiplier: 1.1 },
]);
eq('7.10 a later unqualified SCALE reaches acme, client AND the new stream',
  r7b.executions[1].occurrencesChanged, 27 + 12 + 11);
near('7.11 the new stream is scaled too',
  valuesOf(r7b, startedSourceKey('r7b-start'))['2027-02-10'], 3300);
check('7.12 and the SCALE names the START it overlaps',
  (r7b.executions[1].overlapsRules ?? []).includes('r7b-start'),
  JSON.stringify(r7b.executions[1].overlapsRules));
check('7.13 it does NOT reach the interest stream on the way past',
  sumOf(r7b, SAVINGS) === 12 * 40, String(sumOf(r7b, SAVINGS)));

// ═══════════════════════════════════════════════════════════════════════════
// 8. START with SEMIMONTHLY is REFUSED, by name
// ═══════════════════════════════════════════════════════════════════════════

const r8 = run([{ id: 'r8', op: START, sourceKey: null, fromISO: '2027-02-10',
  cadence: CadenceKind.SEMIMONTHLY, rate: { ...net(3000, RatePeriod.MONTH) } }]);

eq('8.1 nothing was applied and nothing was minted',
  [r8.rejected.length, r8.executions.length, JSON.stringify(r8.events) === BASE_SNAPSHOT],
  [1, 0, true]);
has('8.2 the refusal says a single start date cannot name two days',
  r8.rejected[0].reason, 'a single start date cannot say which two');
has('8.3 and says the count it would silently get wrong',
  r8.rejected[0].reason, '24 a year, not 26 and not 12');
has('8.4 and tells the caller what to do instead', r8.rejected[0].reason, 'MONTHLY or BIWEEKLY');
has('8.5 the refusal names the rule', r8.rejected[0].input, 'r8');
// The three that ARE startable, to prove the refusal is about SEMIMONTHLY only.
for (const kind of [CadenceKind.WEEKLY, CadenceKind.BIWEEKLY, CadenceKind.MONTHLY]) {
  check(`8.6 ${kind} is startable`, invalidIncomeChange({
    id: 'k', op: START, sourceKey: null, fromISO: '2027-02-10', cadence: kind,
    rate: { ...net(3000, RatePeriod.MONTH) },
  }) === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Two changes in chronological order COMPOSE
// ═══════════════════════════════════════════════════════════════════════════

const r9 = run([
  { id: 'r9-raise', op: SCALE, sourceKey: ACME, fromISO: '2027-03-01', multiplier: 1.1 },
  { id: 'r9-newjob', op: SET_RATE, sourceKey: ACME, fromISO: '2027-09-01',
    rate: { ...net(130000, RatePeriod.YEAR) } },
]);
const v9 = valuesOf(r9, ACME);

eq('9.1 both rules ran', r9.executions.map((x) => x.ran), [true, true]);
eq('9.2 January is untouched by either', v9['2027-01-01'], 1000);
eq('9.3 March through August carries the raise', v9['2027-03-12'], 1100);
eq('9.4 August, the last month before the replacement, still carries it', v9['2027-08-27'], 1100);
near('9.5 September onward is the STATED rate — a replacement, not a raise ON a raise',
  v9['2027-09-10'], 130000 / 26);
check('9.6 which is NOT the scaled figure multiplied again', v9['2027-09-10'] !== 1100 * (130000 / 26));
eq('9.7 the second rule governed 9 occurrences (Sep 10 .. Dec 31)',
  r9.executions[1].occurrencesChanged, 9);
near('9.8 and its nominalBefore is what the FIRST rule had already made them',
  r9.executions[1].nominalBefore, 9 * 1100);

// ═══════════════════════════════════════════════════════════════════════════
// 10. OVERLAPPING changes both run, and the later one names the earlier
// ═══════════════════════════════════════════════════════════════════════════

const r10 = run([
  { id: 'r10-a', op: SCALE, sourceKey: ACME, fromISO: '2027-03-01', multiplier: 1.1 },
  { id: 'r10-b', op: SCALE, sourceKey: ACME, fromISO: '2027-06-01', multiplier: 1.05 },
]);
const v10 = valuesOf(r10, ACME);

eq('10.1 both ran — overlap is a legitimate way to describe a changing year',
  r10.executions.map((x) => x.ran), [true, true]);
eq('10.2 March to May carries only the first', v10['2027-03-12'], 1100);
near('10.3 June onward carries both, in the order given', v10['2027-06-04'], 1000 * 1.1 * 1.05);
eq('10.4 THE LATER EXECUTION NAMES THE EARLIER', r10.executions[1].overlapsRules, ['r10-a']);
check('10.5 the earlier one names nothing — it could not have known',
  r10.executions[0].overlapsRules === undefined, JSON.stringify(r10.executions[0].overlapsRules));

// Two rules on DIFFERENT streams over the same dates do not overlap.
const r10c = run([
  { id: 'r10-c', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 },
  { id: 'r10-d', op: SCALE, sourceKey: CLIENT, fromISO: '2027-01-01', multiplier: 1.1 },
]);
check('10.6 same window, different streams — NOT an overlap',
  r10c.executions[1].overlapsRules === undefined, JSON.stringify(r10c.executions[1].overlapsRules));

// A window that ends before the next one begins is not an overlap either.
const r10e = run([
  { id: 'r10-e', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', toISO: '2027-05-31', multiplier: 1.1 },
  { id: 'r10-f', op: SCALE, sourceKey: ACME, fromISO: '2027-06-01', multiplier: 1.2 },
]);
check('10.7 adjacent, non-touching windows on one stream are not an overlap',
  r10e.executions[1].overlapsRules === undefined, JSON.stringify(r10e.executions[1].overlapsRules));
eq('10.8 and a bounded window stops where it said it would',
  [valuesOf(r10e, ACME)['2027-05-21'], valuesOf(r10e, ACME)['2027-06-04']], [1100, 1200]);

// ═══════════════════════════════════════════════════════════════════════════
// 11. A change entirely AFTER the horizon
// ═══════════════════════════════════════════════════════════════════════════

const r11 = run([{ id: 'r11', op: SCALE, sourceKey: ACME, fromISO: '2028-01-01', multiplier: 1.1 }]);
const x11 = r11.executions[0];

check('11.1 it did NOT run', x11.ran === false, JSON.stringify(x11));
eq('11.2 and changed nothing',
  [x11.occurrencesChanged, x11.firstChangedISO, x11.lastChangedISO], [0, null, null]);
has('11.3 the reason names the horizon end', x11.reason, '2027-12-31');
has('11.4 and says so in the terms a reader needs', x11.reason, 'after this projection ends');
has('11.5 and denies the conclusion outright', x11.reason, 'The result is the same as without it.');
check('11.6 THE EVENTS ARE BYTE-IDENTICAL TO THE INPUT', JSON.stringify(r11.events) === BASE_SNAPSHOT);

// ═══════════════════════════════════════════════════════════════════════════
// 12. The horizon ends before the change begins
// ═══════════════════════════════════════════════════════════════════════════

// The same rule against a shorter horizon: the rule is unremarkable and the
// horizon is what makes it unreachable. A reason naming only the rule's own date
// would be useless here.
const r12 = run([{ id: 'r12', op: SCALE, sourceKey: ACME, fromISO: '2027-09-01', multiplier: 1.1 }],
  { horizon: { fromISO: '2027-01-01', toISO: '2027-06-30' } });

check('12.1 it did NOT run', r12.executions[0].ran === false);
has('12.2 the reason names THIS horizon\'s end, not the rule\'s date',
  r12.executions[0].reason, 'after this projection ends (2027-06-30)');
check('12.3 events untouched', JSON.stringify(r12.events) === BASE_SNAPSHOT);
// ⚠️ Events outside the short horizon are still IN the array. This module does
// not trim to the horizon; it only refuses to REACH past it, and a caller that
// expects trimming here would silently lose half a year.
eq('12.4 the module does not silently trim events to the horizon',
  r12.events.length, BASE_EVENTS.length);

// ═══════════════════════════════════════════════════════════════════════════
// 13. The change is entirely in the PAST relative to the horizon
// ═══════════════════════════════════════════════════════════════════════════

const r13 = run([{ id: 'r13', op: SCALE, sourceKey: ACME,
  fromISO: '2026-01-01', toISO: '2026-06-30', multiplier: 1.1 }]);

check('13.1 it did NOT run', r13.executions[0].ran === false);
has('13.2 the reason names the window end and the horizon start', r13.executions[0].reason,
  'its window ends on 2026-06-30, before this projection begins (2027-01-01)');
check('13.3 events untouched', JSON.stringify(r13.events) === BASE_SNAPSHOT);

// A well-formed rule INSIDE the horizon that simply catches no payday.
const r13b = run([{ id: 'r13b', op: SCALE, sourceKey: CLIENT,
  fromISO: '2027-03-16', toISO: '2027-04-14', multiplier: 1.1 }]);
check('13.4 a window between two monthly paydays runs over nothing',
  r13b.executions[0].ran === false);
has('13.5 and says exactly that, with the window',
  r13b.executions[0].reason, 'no pay date falls in 2027-03-16..2027-04-14');

// ═══════════════════════════════════════════════════════════════════════════
// 14. A mid-month effective date
// ═══════════════════════════════════════════════════════════════════════════

// "From the middle of March" lands on no biweekly payday and exactly on the
// monthly one. The rule must take effect at the next occurrence of each — and
// `from` being inclusive is what decides the monthly stream's March.
const r14 = run([{ id: 'r14', op: SCALE, sourceKey: null, fromISO: '2027-03-15', multiplier: 1.1 }]);
const v14a = valuesOf(r14, ACME), v14c = valuesOf(r14, CLIENT);

eq('14.1 the biweekly payday before the date is untouched', v14a['2027-03-12'], 1000);
eq('14.2 the next one after it is raised', v14a['2027-03-26'], 1100);
eq('14.3 the monthly payday falls ON the date, so it IS raised', v14c['2027-03-15'], 550);
eq('14.4 February is not', v14c['2027-02-15'], 500);
eq('14.5 April is', v14c['2027-04-15'], 550);
eq('14.6 the first changed date is the earliest across BOTH streams',
  r14.executions[0].firstChangedISO, '2027-03-15');
eq('14.7 and the governed window is the rule\'s own, not a payday',
  r14.executions[0].governed, { fromISO: '2027-03-15', toISO: '2027-12-31' });

// ═══════════════════════════════════════════════════════════════════════════
// 15. Month length and the leap year
// ═══════════════════════════════════════════════════════════════════════════

// A monthly stream starting on the 31st is paid on the last day of every shorter
// month. 2028 is a leap year, so February is the 29th — clamping is the
// calendar's own rule, and getting it wrong here silently moves a whole payment.
const r15 = run([{ id: 'r15', op: START, sourceKey: null, fromISO: '2028-01-31',
  cadence: CadenceKind.MONTHLY, rate: { ...net(4000, RatePeriod.MONTH) } }],
{ events: [], streams: [], horizon: { fromISO: '2028-01-01', toISO: '2028-12-31' } });
const v15 = Object.keys(valuesOf(r15, startedSourceKey('r15'))).sort();

eq('15.1 twelve payments', v15.length, 12);
eq('15.2 FEBRUARY 2028 CLAMPS TO THE 29TH — a leap year', v15[1], '2028-02-29');
eq('15.3 and the 30-day months clamp to the 30th',
  [v15[3], v15[5], v15[8], v15[10]], ['2028-04-30', '2028-06-30', '2028-09-30', '2028-11-30']);
eq('15.4 the 31-day months are paid on the 31st',
  [v15[0], v15[2], v15[4], v15[11]], ['2028-01-31', '2028-03-31', '2028-05-31', '2028-12-31']);

// The same start one year earlier, in a common year.
const r15b = run([{ id: 'r15b', op: START, sourceKey: null, fromISO: '2027-01-31',
  cadence: CadenceKind.MONTHLY, rate: { ...net(4000, RatePeriod.MONTH) } }],
{ events: [], streams: [], horizon: HORIZON });
eq('15.5 in a common year the same rule clamps to the 28th',
  Object.keys(valuesOf(r15b, startedSourceKey('r15b'))).sort()[1], '2027-02-28');

// ═══════════════════════════════════════════════════════════════════════════
// 16. A source-specific change leaves every other stream ALONE
// ═══════════════════════════════════════════════════════════════════════════

const r16 = run([{ id: 'r16', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { ...net(200000, RatePeriod.YEAR) } }]);

check('16.1 EVERY event that is not acme is byte-identical to the input',
  othersJSON(r16, ACME) === JSON.stringify(BASE_EVENTS.filter((e) => e.sourceKey !== ACME)));
eq('16.2 including the consulting stream, to the cent', sumOf(r16, CLIENT), CLIENT_TOTAL);
eq('16.3 the execution names one stream only', r16.executions[0].matched.length, 1);
eq('16.4 the whole array is the same length — nothing added, nothing dropped',
  r16.events.length, BASE_EVENTS.length);

// ═══════════════════════════════════════════════════════════════════════════
// 17. An UNQUALIFIED SCALE reaches every eligible EARNED stream — and no other
// ═══════════════════════════════════════════════════════════════════════════

const r17 = run([{ id: 'r17', op: SCALE, sourceKey: null, fromISO: '2027-01-01', multiplier: 1.1 }]);
const x17 = r17.executions[0];

eq('17.1 both eligible earned streams, by name', x17.matched.map((m) => m.sourceKey), [ACME, CLIENT]);
eq('17.2 and the scope says so — a reader never has to infer the reach', x17.scope, 'EVERY_INCOME_STREAM');
eq('17.3 39 occurrences — 27 biweekly plus 12 monthly', x17.occurrencesChanged, 27 + 12);
eq('17.4 nominalBefore is both streams together', x17.nominalBefore, ACME_TOTAL + CLIENT_TOTAL);
near('17.5 nominalAfter is a tenth more', x17.nominalAfter, (ACME_TOTAL + CLIENT_TOTAL) * 1.1);
eq('17.6 acme is raised', valuesOf(r17, ACME)['2027-06-04'], 1100);
eq('17.7 client is raised', valuesOf(r17, CLIENT)['2027-06-15'], 550);
eq('17.8 THE INELIGIBLE STREAM IS NOT REACHED — "my income" is the income that continues',
  sumOf(r17, DORMANT), 12 * 100);
check('17.9 and its events are byte-identical',
  JSON.stringify(r17.events.filter((e) => e.sourceKey === DORMANT))
  === JSON.stringify(BASE_EVENTS.filter((e) => e.sourceKey === DORMANT)));

// ═══════════════════════════════════════════════════════════════════════════
// 17b. A PAY RISE DOES NOT RAISE THE BANK'S INTEREST
// ═══════════════════════════════════════════════════════════════════════════

// Measured on a real Space: an unqualified +10% reached five streams, three of
// which were interest. The savings stream here is projected and earning, and
// still not what the sentence was about.
eq('17b.1 the interest stream keeps every cent', sumOf(r17, SAVINGS), 12 * 40);
check('17b.2 and is byte-identical',
  JSON.stringify(r17.events.filter((e) => e.sourceKey === SAVINGS))
  === JSON.stringify(BASE_EVENTS.filter((e) => e.sourceKey === SAVINGS)));
check('17b.3 it is not excluded for being ineligible — it IS projection-eligible',
  STREAMS.find((s) => s.sourceKey === SAVINGS)!.projectionEligible === true);
eq('17b.4 the execution does not list it among the streams it reached',
  x17.matched.some((m) => m.sourceKey === SAVINGS), false);

// But a rule that NAMES it reaches it: "my interest income stops when I close
// that account" is a thing a user can mean, and has said.
const r17b = run([{ id: 'r17b', op: STOP, sourceKey: SAVINGS, fromISO: '2027-07-01' }]);
eq('17b.5 a NAMED rule reaches an interest stream — the user said which',
  [r17b.rejected.length, r17b.executions[0].occurrencesChanged], [0, 6]);
eq('17b.6 and leaves the earned streams alone',
  [sumOf(r17b, ACME), sumOf(r17b, CLIENT)], [ACME_TOTAL, CLIENT_TOTAL]);

// ═══════════════════════════════════════════════════════════════════════════
// 18. An UNQUALIFIED SET_RATE or STOP over more than one stream is REFUSED
// ═══════════════════════════════════════════════════════════════════════════

const r18 = run([
  { id: 'r18-rate', op: SET_RATE, sourceKey: null, fromISO: '2027-03-01',
    rate: { ...net(15000, RatePeriod.MONTH) } },
  { id: 'r18-stop', op: STOP, sourceKey: null, fromISO: '2027-07-01' },
]);

eq('18.1 both refused, neither executed', [r18.rejected.length, r18.executions.length], [2, 0]);
check('18.2 NOTHING WAS APPLIED — a refusal is not a partial application',
  JSON.stringify(r18.events) === BASE_SNAPSHOT);
has('18.3 the SET_RATE refusal NAMES the streams it could have meant',
  r18.rejected[0].reason, '"Acme payroll", "Consulting client"');
has('18.4 and says how many there are', r18.rejected[0].reason, 'this Space has 2 income streams');
has('18.5 and says the two readings are different results', r18.rejected[0].reason, 'different results');
has('18.6 and tells the caller to ask rather than guess',
  r18.rejected[0].reason, 'ask the user which income they mean');
has('18.7 the STOP refusal names the streams too', r18.rejected[1].reason, '"Acme payroll"');

// With exactly ONE eligible earned stream the same rule is unambiguous.
const ONE_STREAM: IncomeStreamRef[] = [STREAMS[0], STREAMS[2], STREAMS[3]];
const r18b = run([{ id: 'r18b', op: SET_RATE, sourceKey: null, fromISO: '2027-01-01',
  rate: { ...net(15000, RatePeriod.MONTH) } }], { streams: ONE_STREAM });
eq('18.8 one eligible earned stream leaves nothing to be ambiguous about — it RUNS',
  [r18b.rejected.length, r18b.executions[0].ran], [0, true]);
near('18.9 and converts against THAT stream\'s cadence', valuesOf(r18b, ACME)['2027-01-01'], 180000 / 26);
eq('18.10 an interest stream in the Space does not make it ambiguous',
  sumOf(r18b, SAVINGS), 12 * 40);

const r18c = run([{ id: 'r18c', op: STOP, sourceKey: null, fromISO: '2027-07-02' }],
  { streams: ONE_STREAM });
eq('18.11 an unqualified STOP with one earned stream runs', r18c.executions[0].occurrencesChanged, 14);

// An unqualified rule with NO eligible earned stream is refused, and says why.
const r18d = run([{ id: 'r18d', op: SCALE, sourceKey: null, fromISO: '2027-01-01', multiplier: 1.1 }],
  { streams: [STREAMS[2], STREAMS[3]] });
eq('18.12 no eligible earned stream ⇒ refused, not a silent no-op',
  [r18d.rejected.length, r18d.executions.length], [1, 0]);
has('18.13 and says there was nothing an unqualified change could reach',
  r18d.rejected[0].reason, 'no EARNED income stream in this Space is licensed to continue');
has('18.14 and points at the interest that is sitting right there, unreached',
  r18d.rejected[0].reason, 'Interest is not raised by a pay rise');

// ═══════════════════════════════════════════════════════════════════════════
// 19. An unknown `sourceKey` is refused, and the refusal LISTS what exists
// ═══════════════════════════════════════════════════════════════════════════

const r19 = run([{ id: 'r19', op: SCALE, sourceKey: 'salary@nowhere',
  fromISO: '2027-01-01', multiplier: 1.1 }]);

eq('19.1 refused, no execution', [r19.rejected.length, r19.executions.length], [1, 0]);
has('19.2 the refusal quotes the key that was asked for', r19.rejected[0].reason, '`salary@nowhere`');
has('19.3 and LISTS the acme key, with its label',
  r19.rejected[0].reason, `\`${ACME}\` ("Acme payroll")`);
has('19.4 and the client key', r19.rejected[0].reason, `\`${CLIENT}\``);
has('19.5 and the INELIGIBLE one too — it exists, it just does not continue',
  r19.rejected[0].reason, `\`${DORMANT}\``);
has('19.6 and the interest one — a named rule could legitimately want it',
  r19.rejected[0].reason, `\`${SAVINGS}\``);
has('19.7 and forbids the obvious next move', r19.rejected[0].reason, 'Do not guess.');
check('19.8 events untouched', JSON.stringify(r19.events) === BASE_SNAPSHOT);

// ═══════════════════════════════════════════════════════════════════════════
// 20. Every malformed rule is refused BY NAME, and none of them half-runs
// ═══════════════════════════════════════════════════════════════════════════

const BAD: [string, IncomeChangeRule, string][] = [
  ['20.1 a multiplier of 0',
    { id: 'b1', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 0 },
    'would make income negative or nil'],
  ['20.2 a negative multiplier',
    { id: 'b2', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: -1.1 },
    'to end an income use STOP'],
  ['20.3 a multiplier of exactly 1 — nothing to run, and nothing to claim',
    { id: 'b3', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1 },
    'changes nothing, so there is no change to run'],
  ['20.4 a SCALE with no multiplier at all',
    { id: 'b4', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01' },
    'SCALE needs a `multiplier`'],
  ['20.5 a stated rate of 0',
    { id: 'b5', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01', rate: { ...net(0) } },
    'must be greater than zero'],
  ['20.6 a negative stated rate',
    { id: 'b6', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01', rate: { ...net(-5000) } },
    'must be greater than zero'],
  ['20.7 an UNKNOWN basis — the 30-40% wedge is never guessed',
    { id: 'b7', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
      rate: { amount: 5000, per: RatePeriod.OCCURRENCE, currency: 'USD', basis: AmountBasis.UNKNOWN } },
    '`basis` must be NET or GROSS'],
  ['20.8 a rate with no `per` — a factor of twelve, decided by whoever wrote the default',
    { id: 'b8', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
      rate: { amount: 180000, currency: 'USD', basis: AmountBasis.NET } as never },
    '`per` must say what the amount is per'],
  ['20.9 `to` before `from`',
    { id: 'b9', op: SCALE, sourceKey: ACME, fromISO: '2027-06-01', toISO: '2027-05-01', multiplier: 1.1 },
    '`to` is before `from`.'],
  ['20.10 a malformed date',
    { id: 'b10', op: SCALE, sourceKey: ACME, fromISO: '2027-3-1', multiplier: 1.1 },
    '`from` must be a YYYY-MM-DD date.'],
  ['20.11 a malformed `to`',
    { id: 'b11', op: SCALE, sourceKey: ACME, fromISO: '2027-03-01', toISO: 'June', multiplier: 1.1 },
    '`to` must be a YYYY-MM-DD date.'],
  ['20.12 a SCALE carrying a rate — two answers to one question',
    { id: 'b12', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1, rate: { ...net(5000) } },
    'SCALE takes a `multiplier` only'],
  ['20.13 a STOP carrying an amount',
    { id: 'b13', op: STOP, sourceKey: ACME, fromISO: '2027-07-01', rate: { ...net(5000) } },
    'STOP takes only a date'],
  ['20.14 a STOP carrying a multiplier',
    { id: 'b14', op: STOP, sourceKey: ACME, fromISO: '2027-07-01', multiplier: 0.5 },
    'STOP takes only a date'],
  ['20.15 a START naming an existing stream',
    { id: 'b15', op: START, sourceKey: ACME, fromISO: '2027-02-01',
      cadence: CadenceKind.MONTHLY, rate: { ...net(3000, RatePeriod.MONTH) } },
    'START creates a stream, so it cannot name an existing one'],
  ['20.16 a START with no cadence',
    { id: 'b16', op: START, sourceKey: null, fromISO: '2027-02-01', rate: { ...net(3000, RatePeriod.MONTH) } },
    'START needs a `cadence`'],
  ['20.17 a SET_RATE restating the cadence',
    { id: 'b17', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
      cadence: CadenceKind.MONTHLY, rate: { ...net(5000) } },
    'it cannot restate the cadence'],
  ['20.18 a SET_RATE with a multiplier as well as a rate',
    { id: 'b18', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
      multiplier: 1.1, rate: { ...net(5000) } },
    'takes a rate, not a `multiplier`'],
  ['20.19 a SET_RATE with no rate at all',
    { id: 'b19', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01' },
    'needs a stated rate'],
  ['20.20 an operation this contract does not have',
    { id: 'b20', op: 'RAISE' as never, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 },
    'is not an operation this contract has'],
];

const r20 = run(BAD.map(([, rule]) => rule));
eq('20.0 every malformed rule is refused, and NONE of them produced an execution',
  [r20.rejected.length, r20.executions.length], [BAD.length, 0]);
check('20.0b and the events are byte-identical — a refusal never half-applies',
  JSON.stringify(r20.events) === BASE_SNAPSHOT);
BAD.forEach(([name, rule, needle], i) => {
  has(name, r20.rejected[i].reason, needle);
  has(`${name} — names its rule`, r20.rejected[i].input, rule.id);
  check(`${name} — invalidIncomeChange agrees standalone`,
    (invalidIncomeChange(rule) ?? '').includes(needle), String(invalidIncomeChange(rule)));
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. A rate needs a schedule to be a rate OF
// ═══════════════════════════════════════════════════════════════════════════

const NO_CADENCE: IncomeStreamRef[] = [
  { sourceKey: ACME, label: 'Acme payroll', role: FlowRole.INCOME, cadence: null, projectionEligible: true },
];
const r21 = run([{ id: 'r21', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { ...net(15000, RatePeriod.MONTH) } }], { streams: NO_CADENCE });

eq('21.1 refused, and no execution invented for it',
  [r21.rejected.length, r21.executions.length], [1, 0]);
has('21.2 the refusal names the stream', r21.rejected[0].reason, '"Acme payroll"');
has('21.3 and says what is missing', r21.rejected[0].reason, 'has no established pay schedule');
has('21.4 and that nothing was applied', r21.rejected[0].reason, 'Nothing was applied.');
check('21.5 the events really are untouched', JSON.stringify(r21.events) === BASE_SNAPSHOT);

// ⚠️ A SCALE does NOT need a cadence: a multiplier applies to whatever the dated
// occurrences already are, without ever asking what they are a rate of.
const r21b = run([{ id: 'r21b', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 }],
  { streams: NO_CADENCE });
eq('21.6 but a SCALE over the same stream runs — it converts nothing',
  [r21b.rejected.length, r21b.executions[0].occurrencesChanged], [0, 27]);
// Nor does a STOP: ending a stream needs no rate either.
const r21c = run([{ id: 'r21c', op: STOP, sourceKey: ACME, fromISO: '2027-07-02' }],
  { streams: NO_CADENCE });
eq('21.7 and so does a STOP', [r21c.rejected.length, r21c.executions[0].occurrencesChanged], [0, 14]);

// ═══════════════════════════════════════════════════════════════════════════
// 22. A rule that executes perfectly and LOWERS the projection
// ═══════════════════════════════════════════════════════════════════════════

const r22a = run([{ id: 'r22a', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 }]);
eq('22.1 a SCALE over observed-settled deposits keeps all of it spendable',
  [r22a.executions[0].spendableBefore, Math.round(r22a.executions[0].spendableAfter * 100) / 100],
  [27000, 29700]);
check('22.2 — because observedSettled survived the scaling',
  r22a.events.find((e) => e.id === `${ACME}@2027-01-01`)!.amount!.observedSettled === true);

const r22b = run([{ id: 'r22b', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { amount: 200000, per: RatePeriod.YEAR, currency: 'USD', basis: AmountBasis.GROSS } }]);
const x22b = r22b.executions[0];

check('22.3 THE GROSS RULE RAN — perfectly, on all 27 occurrences',
  x22b.ran === true && x22b.occurrencesChanged === 27, JSON.stringify(x22b));
near('22.4 and the nominal figure it produced is LARGER than before',
  x22b.nominalAfter, 27 * (200000 / 26));
check('22.5 nominalAfter > nominalBefore — on paper this is a very big raise',
  x22b.nominalAfter > x22b.nominalBefore, `${x22b.nominalAfter} vs ${x22b.nominalBefore}`);
eq('22.6 AND SPENDABLE GOES FROM $27,000 TO ZERO — the projection goes DOWN',
  [x22b.spendableBefore, x22b.spendableAfter], [27000, 0]);
check('22.7 the projection path really does refuse every one of those occurrences',
  r22b.events.filter((e) => e.sourceKey === ACME && e.direction === 'INFLOW')
    .every((e) => observedCashContribution(e).assertable === false));
{
  const refusal = observedCashContribution(r22b.events.find((e) => e.id === `${ACME}@2027-01-01`)!);
  has('22.8 and refuses them for being GROSS, not for want of a basis',
    refusal.assertable ? undefined : refusal.reason, 'is a GROSS amount');
}

// The same rule stated NET keeps the money in the projection. GROSS and NET
// differ ONLY in spendability — the dated arithmetic is identical.
const r22c = run([{ id: 'r22c', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01',
  rate: { ...net(200000, RatePeriod.YEAR) } }]);
check('22.9 the same rule stated NET counts as cash',
  r22c.executions[0].spendableAfter === r22c.executions[0].nominalAfter);
check('22.10 and produces the identical nominal figure',
  r22b.executions[0].nominalAfter === r22c.executions[0].nominalAfter);

// ⚠️ A RULE IS NOT ANSWERABLE FOR WHAT IT INHERITED. These occurrences were
// already unspendable before any rule touched them — an ordinary +10% must
// report that it took nothing away, not that it destroyed $27,000.
const ALREADY_GROSS = ACME_DATES.map((d) => ev(ACME, d, ACME_PAY, {
  amount: { value: ACME_PAY, currency: 'USD', basis: AmountBasis.GROSS,
    provenance: EventProvenance.USER_ASSERTED },
}));
const r22d = run([{ id: 'r22d', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 }],
  { events: ALREADY_GROSS });
eq('22.11 an ordinary raise over already-unspendable money reports 0 → 0, not a loss',
  [r22d.executions[0].spendableBefore, r22d.executions[0].spendableAfter], [0, 0]);
near('22.12 while the nominal side still moves', r22d.executions[0].nominalAfter, 27000 * 1.1);

// ═══════════════════════════════════════════════════════════════════════════
// 23. A one-off event is unreachable by EVERY rule
// ═══════════════════════════════════════════════════════════════════════════

const ONE_OFF_JSON = JSON.stringify(ONE_OFF);
for (const [name, rules] of [
  ['an unqualified SCALE', [{ id: 'c1', op: SCALE, sourceKey: null, fromISO: '2027-01-01', multiplier: 1.1 }]],
  ['an unqualified STOP (one earned stream)', [{ id: 'c2', op: STOP, sourceKey: null, fromISO: '2027-01-01' }]],
  ['a named SCALE that doubles', [{ id: 'c3', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 2 }]],
] as [string, IncomeChangeRule[]][]) {
  const res = run(rules, { streams: rules[0].op === STOP ? ONE_STREAM : STREAMS });
  check(`23.1 ${name} leaves the asserted bonus BYTE-IDENTICAL`,
    JSON.stringify(res.events.find((e) => e.id === ONE_OFF.id)) === ONE_OFF_JSON,
    JSON.stringify(res.events.find((e) => e.id === ONE_OFF.id)));
}
// The bonus is an INFLOW with the INCOME role on a date inside every window
// above: the ONLY thing making it unreachable is that it has no `sourceKey`.
check('23.2 and it really is an INFLOW/INCOME inside those windows',
  ONE_OFF.direction === 'INFLOW' && ONE_OFF.role === FlowRole.INCOME
  && ONE_OFF.sourceKey === undefined && ONE_OFF.timing.kind === 'EXACT');

// ═══════════════════════════════════════════════════════════════════════════
// 24. An OUTFLOW is unreachable, even carrying a governed stream's key
// ═══════════════════════════════════════════════════════════════════════════

const OUTFLOW_JSON = JSON.stringify(OUTFLOW);
for (const [name, rule] of [
  ['an unqualified SCALE', { id: 'd1', op: SCALE, sourceKey: null, fromISO: '2027-01-01', multiplier: 1.1 }],
  ['a named SET_RATE', { id: 'd2', op: SET_RATE, sourceKey: ACME, fromISO: '2027-01-01', rate: { ...net(9999) } }],
  ['a named STOP', { id: 'd3', op: STOP, sourceKey: ACME, fromISO: '2027-01-01' }],
] as [string, IncomeChangeRule][]) {
  const res = run([rule]);
  check(`24.1 ${name} leaves the OUTFLOW byte-identical, though it shares the sourceKey`,
    JSON.stringify(res.events.find((e) => e.id === OUTFLOW.id)) === OUTFLOW_JSON,
    JSON.stringify(res.events.find((e) => e.id === OUTFLOW.id)));
}
eq('24.2 an income rule never changes the number of OUTFLOW rows',
  run([{ id: 'd4', op: STOP, sourceKey: ACME, fromISO: '2027-01-01' }])
    .events.filter((e) => e.direction === 'OUTFLOW').length,
  BASE_EVENTS.filter((e) => e.direction === 'OUTFLOW').length);

// ═══════════════════════════════════════════════════════════════════════════
// 25. ⚠️ SUSPECTED DEFECT — a stream whose occurrences carry no amount
// ═══════════════════════════════════════════════════════════════════════════

// FORECAST-3's DEFAULT for a cadence-derived occurrence is `amount: null` — the
// date is known and the amount is not, which is the documented state of every
// stream with no periodic-amount regime. SCALE correctly skips those events (a
// tenth more of nothing is nothing), but the skip is invisible in the diff:
// `changed` stays 0 and the execution falls through to the generic reason.
//
// The rule then reports "no pay date falls in 2027-01-01..2027-12-31", which is
// FALSE — twenty-seven pay dates fall in it. The reader is handed a SCHEDULE
// explanation for an AMOUNT problem, and the two have different next steps: one
// is "there is nothing to do", the other is "ask the user what they earn". The
// correct reason names the amounts, not the dates.
const DATELESS = ACME_DATES.map((d) => ev(ACME, d, 0, { amount: null }));
const r25 = run([{ id: 'r25', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 }],
  { events: DATELESS });

check('25.1 it correctly declines to run — a multiplier on an unknown amount is nothing',
  r25.executions[0].ran === false, JSON.stringify(r25.executions[0]));
check('25.2 DEFECT: the reason claims no pay date falls in a window holding 27 of them',
  !(r25.executions[0].reason ?? '').includes('no pay date falls in'),
  `reason was: ${r25.executions[0].reason}`);
check('25.3 the events are at least left alone', JSON.stringify(r25.events) === JSON.stringify(DATELESS));

// ⚠️ THE SAME ROOT CAUSE, AND THE WORSE HALF OF IT. `firstChangedISO` and
// `lastChangedISO` are taken from the GOVERNED set, not the CHANGED set — for
// SCALE, `after` is every event the window reached, including the ones the
// multiplier skipped. So an execution can report `occurrencesChanged: 0` and a
// twelve-month range of changed dates in the same object, and the two fields
// contradict each other. Evidence derived from a diff must come from the diff.
eq('25.4 DEFECT: a rule that changed nothing names no changed dates',
  [r25.executions[0].firstChangedISO, r25.executions[0].lastChangedISO], [null, null]);

// The mixed case, where it is not merely a contradiction but a wrong date: only
// the LAST occurrence of the year carries an amount, so that date — and only
// that date — is what this rule changed.
const MOSTLY_DATELESS = ACME_DATES.map((d, i) =>
  ev(ACME, d, ACME_PAY, i === ACME_DATES.length - 1 ? {} : { amount: null }));
const r25b = run([{ id: 'r25b', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 }],
  { events: MOSTLY_DATELESS });
eq('25.5 one occurrence had an amount, so one occurrence changed',
  r25b.executions[0].occurrencesChanged, 1);
eq('25.6 DEFECT: the changed window must be that one date, not the whole year',
  [r25b.executions[0].firstChangedISO, r25b.executions[0].lastChangedISO],
  ['2027-12-31', '2027-12-31']);

// ⚠️ FIXED AFTER THIS FILE CAUGHT IT. `governed` was documented as clamped to the
// horizon and was not clamped at either end, so a rule that ran over the whole
// 2027 horizon reported a window reaching back to 2024. Section 28.11 caught the
// acute form — a rule starting AFTER the horizon reported `from > to`, a window
// the module's own validator refuses as input — and the repair made `governed`
// the INTERSECTION, null when there is none, with the rule's own dates kept
// separately on `requested`.
const r25c = run([{ id: 'r25c', op: SCALE, sourceKey: ACME, fromISO: '2024-06-01', multiplier: 1.1 }]);
eq('25.7 the rule ran over the whole 2027 horizon', r25c.executions[0].occurrencesChanged, 27);
eq('25.8 `governed` is the INTERSECTION — it does not reach back before the projection',
  r25c.executions[0].governed, { fromISO: '2027-01-01', toISO: '2027-12-31' });
eq('25.9 …and the rule\'s own window is kept, unclamped, beside it',
  r25c.executions[0].requested, { fromISO: '2024-06-01', toISO: null });

// ═══════════════════════════════════════════════════════════════════════════
// 26. METAMORPHIC — properties that hold whatever the numbers are
// ═══════════════════════════════════════════════════════════════════════════

// Removing the rule recovers the baseline exactly. The identity every other
// claim in this file is measured against.
const rNone = run([]);
check('26.1 no rules ⇒ the events come back deep-equal', JSON.stringify(rNone.events) === BASE_SNAPSHOT);
eq('26.2 and nothing is claimed about them', [rNone.executions.length, rNone.rejected.length], [0, 0]);

// Determinism. Same input twice, same output — no clock, no random, no Map
// iteration order leaking into a figure.
const RULES_D: IncomeChangeRule[] = [
  { id: 'd-a', op: SCALE, sourceKey: null, fromISO: '2027-03-01', multiplier: 1.1 },
  { id: 'd-b', op: SET_RATE, sourceKey: ACME, fromISO: '2027-09-01', rate: { ...net(140000, RatePeriod.YEAR) } },
  { id: 'd-c', op: START, sourceKey: null, fromISO: '2027-05-07',
    cadence: CadenceKind.BIWEEKLY, label: 'tutoring', rate: { ...net(400) } },
];
check('26.3 the same rules on the same input give an IDENTICAL result',
  JSON.stringify(run(RULES_D)) === JSON.stringify(run(RULES_D)));

// ×1.1 then ×(1/1.1) is the identity, to f64.
const rRound = run([
  { id: 'up', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 },
  { id: 'down', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1 / 1.1 },
]);
check('26.4 a raise and its exact reversal return every occurrence to where it was',
  Object.values(valuesOf(rRound, ACME)).every((v) => Math.abs(v - 1000) < 1e-9),
  JSON.stringify(valuesOf(rRound, ACME)['2027-01-01']));
near('26.5 and the governed total with it', sumOf(rRound, ACME), ACME_TOTAL);

// Monotonicity. A bigger raise over the same window is a bigger number — the one
// property no rounding or unit bug can accidentally satisfy in both directions.
const pct = (id: string, m: number) =>
  run([{ id, op: SCALE, sourceKey: ACME, fromISO: '2027-04-01', multiplier: m }]).executions[0];
const p10 = pct('p10', 1.10), p15 = pct('p15', 1.15);
check('26.6 +15% governs exactly the occurrences +10% did',
  p10.occurrencesChanged === p15.occurrencesChanged && p10.nominalBefore === p15.nominalBefore);
check('26.7 and produces a STRICTLY greater total',
  p15.nominalAfter > p10.nominalAfter, `${p15.nominalAfter} vs ${p10.nominalAfter}`);
check('26.8 while a cut produces a strictly smaller one', pct('p90', 0.9).nominalAfter < p10.nominalBefore);

// A rule outside the horizon is the identity on the events.
for (const [name, rule] of [
  ['after the end', { id: 'o1', op: SCALE, sourceKey: ACME, fromISO: '2029-01-01', multiplier: 1.5 }],
  ['before the start', { id: 'o2', op: SET_RATE, sourceKey: ACME, fromISO: '2024-01-01',
    toISO: '2024-12-31', rate: { ...net(999999) } }],
  ['a STOP after the end', { id: 'o3', op: STOP, sourceKey: ACME, fromISO: '2030-01-01' }],
  ['a START after the end', { id: 'o4', op: START, sourceKey: null, fromISO: '2029-06-01',
    cadence: CadenceKind.MONTHLY, rate: { ...net(50000, RatePeriod.MONTH) } }],
] as [string, IncomeChangeRule][]) {
  const res = run([rule]);
  check(`26.9 ${name}: the events are deep-equal to the input`,
    JSON.stringify(res.events) === BASE_SNAPSHOT);
  check(`26.9 ${name}: and it reports ran:false with a reason`,
    res.executions[0].ran === false && (res.executions[0].reason ?? '').length > 0,
    JSON.stringify(res.executions[0]));
}

// PURITY. The caller's array, and every object in it, is untouched — the module
// header claims "a function of values end to end", and this is that claim.
const CALLER_EVENTS: FutureCashEvent[] =
  BASE_EVENTS.map((e) => ({ ...e, amount: e.amount ? { ...e.amount } : null }));
const CALLER_SNAPSHOT = JSON.stringify(CALLER_EVENTS);
const CALLER_FIRST = CALLER_EVENTS[0];
const mutating = run([
  { id: 'm1', op: SCALE, sourceKey: null, fromISO: '2027-01-01', multiplier: 1.1 },
  { id: 'm2', op: STOP, sourceKey: CLIENT, fromISO: '2027-06-01' },
  { id: 'm3', op: START, sourceKey: null, fromISO: '2027-02-01',
    cadence: CadenceKind.WEEKLY, rate: { ...net(250) } },
], { events: CALLER_EVENTS });

check('26.10 THE CALLER\'S ARRAY IS UNCHANGED', JSON.stringify(CALLER_EVENTS) === CALLER_SNAPSHOT);
eq('26.11 including its length', CALLER_EVENTS.length, BASE_EVENTS.length);
eq('26.12 and the identity of the objects in it — no in-place amount was written',
  [CALLER_EVENTS[0] === CALLER_FIRST, CALLER_FIRST.amount!.value], [true, ACME_PAY]);
check('26.13 while the returned array really did change',
  JSON.stringify(mutating.events) !== CALLER_SNAPSHOT);

// ═══════════════════════════════════════════════════════════════════════════
// 27. THE EVIDENCE CANNOT BE FORGED
// ═══════════════════════════════════════════════════════════════════════════

// A rule id and a label are the caller's to choose. Neither is an input to the
// diff, so neither can make an unreachable rule report that it reached anything.
const FORGED = run([
  { id: 'INCOME-RAISED-10-PERCENT-APPLIED', op: SCALE, sourceKey: ACME,
    fromISO: '2029-01-01', multiplier: 1.1 },
  { id: 'raise', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 },
]);
const forged = FORGED.executions[0], real = FORGED.executions[1];

check('27.1 a rule named after its own conclusion still reports ran:false',
  forged.ran === false, JSON.stringify(forged));
eq('27.2 with nothing changed, no dates to point at, and no money moved',
  [forged.occurrencesChanged, forged.firstChangedISO, forged.lastChangedISO,
    forged.nominalAfter, forged.spendableAfter],
  [0, null, null, 0, 0]);
check('27.3 and it does NOT inherit the truth of the rule beside it that DID run',
  real.ran === true && forged.ran === false);
check('27.4 nor does the real rule pick up the forged one as an overlap',
  (real.overlapsRules ?? []).length === 0, JSON.stringify(real.overlapsRules));
eq('27.5 the id is echoed back unchanged — it NAMES the rule, it does not evidence it',
  forged.ruleId, 'INCOME-RAISED-10-PERCENT-APPLIED');

// A START labelled as though it were an existing salary still mints only what
// the schedule produces, and `matched` is empty when it mints nothing.
const FORGED_START = run([{ id: 'ALREADY-EARNING-THIS', op: START, sourceKey: null,
  fromISO: '2029-01-01', cadence: CadenceKind.MONTHLY, label: 'Acme payroll',
  rate: { ...net(500000, RatePeriod.YEAR) } }]);
check('27.6 a START outside the horizon matches NOTHING, whatever it calls itself',
  FORGED_START.executions[0].ran === false && FORGED_START.executions[0].matched.length === 0,
  JSON.stringify(FORGED_START.executions[0]));
check('27.7 and no $500k stream appears in the events',
  JSON.stringify(FORGED_START.events) === BASE_SNAPSHOT);

// A rejected rule leaves NO execution at all — there is nothing to read as a
// partial success, and the two counts cannot be reconciled into one.
const MIXED = run([
  { id: 'x-bad', op: SET_RATE, sourceKey: 'nope@nope', fromISO: '2027-01-01', rate: { ...net(5000) } },
  { id: 'x-good', op: SCALE, sourceKey: ACME, fromISO: '2027-01-01', multiplier: 1.1 },
]);
eq('27.8 two rules in, one execution and one rejection out',
  [MIXED.executions.length, MIXED.rejected.length], [1, 1]);
eq('27.9 and the execution belongs to the rule that was accepted',
  MIXED.executions.map((x) => x.ruleId), ['x-good']);

// ═══════════════════════════════════════════════════════════════════════════
// 28. The invariants, over EVERY execution this file produced
// ═══════════════════════════════════════════════════════════════════════════

const failing = (p: (x: IncomeChangeExecution) => boolean) =>
  JSON.stringify(ALL_EXECUTIONS.filter((x) => !p(x)).slice(0, 2));
const all = (name: string, p: (x: IncomeChangeExecution) => boolean) =>
  check(name, ALL_EXECUTIONS.every(p), failing(p));

check('28.0 this file actually produced executions to check over',
  ALL_EXECUTIONS.length > 40, String(ALL_EXECUTIONS.length));
all('28.1 `ran` ≡ `occurrencesChanged > 0`, without exception',
  (x) => x.ran === (x.occurrencesChanged > 0));
all('28.2 every ran:false execution carries a NON-EMPTY reason',
  (x) => x.ran || (typeof x.reason === 'string' && x.reason.length > 0));
all('28.3 no ran:true execution carries one — a reason is for absence only',
  (x) => !x.ran || x.reason === undefined);
all('28.4 changed dates exist exactly when the rule ran',
  (x) => x.ran === (x.firstChangedISO !== null && x.lastChangedISO !== null));
all('28.5 first ≤ last, always',
  (x) => x.firstChangedISO === null || x.lastChangedISO === null || x.firstChangedISO <= x.lastChangedISO);
all('28.6 every changed date lies inside the window the execution reports',
  (x) => x.firstChangedISO === null || x.governed === null
    || (x.firstChangedISO >= x.governed.fromISO && x.lastChangedISO! <= x.governed.toISO));
all('28.7 a rule that did not run moved no nominal figure',
  (x) => x.ran || (x.nominalBefore === 0 && x.nominalAfter === 0));
all('28.8 nothing that did not run claims spendable cash on either side',
  (x) => x.ran || (x.spendableBefore === 0 && x.spendableAfter === 0));
all('28.9 spendable never exceeds nominal — it is a subset of the same money',
  (x) => x.spendableBefore <= x.nominalBefore + 1e-9 && x.spendableAfter <= x.nominalAfter + 1e-9);
all('28.10 an overlap list, when present, is never empty and never names its own rule',
  (x) => x.overlapsRules === undefined
    || (x.overlapsRules.length > 0 && !x.overlapsRules.includes(x.ruleId)));
// ⚠️ NULL IS THE ANSWER FOR A RULE AND A PROJECTION THAT DO NOT MEET. An
// inverted pair is not a window; it is a clamp applied to a disjoint interval.
all('28.11 `governed` is either absent or correctly ordered — never inverted',
  (x) => x.governed === null || x.governed.fromISO <= x.governed.toISO);
all('28.11b a rule that covered nothing reports no covered window',
  (x) => x.governed !== null || x.occurrencesChanged === 0);
all('28.11c `requested` is always the rule\'s own window, and always well formed',
  (x) => typeof x.requested.fromISO === 'string'
    && (x.requested.toISO === null || x.requested.toISO >= x.requested.fromISO));
all('28.12 scope is one of the two values the contract has',
  (x) => x.scope === 'NAMED' || x.scope === 'EVERY_INCOME_STREAM');
all('28.13 an EVERY_INCOME_STREAM execution never reports more than one op-specific stream '
  + 'for SET_RATE or STOP — those were refused before they could',
  (x) => x.scope === 'NAMED' || x.op === IncomeChangeOp.SCALE || x.matched.length <= 1);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
