/**
 * lib/forecast/projection.test.ts   (PROJECTION-1)
 *
 * THE EVIDENCE-BASED PATH — PINNED.
 *
 *     npx tsx lib/forecast/projection.test.ts
 *
 * ── What this slice changed, and what it must not have ─────────────────────
 * A licensed forecast refused on the real Space for two reasons that were about
 * evidence GRADE rather than absence: F6's baseline is UNKNOWN (measured — this
 * user's spending has no regime at any granularity), and every projected payroll
 * occurrence lacked a gross/net basis. Both refusals stand. What is added is a
 * weaker, separately-labelled path, and the whole risk of it is that the weaker
 * path quietly becomes the strong one. So the assertions below are mostly about
 * what the projection still REFUSES.
 *
 * ── The debt finding, pinned as an exclusion ───────────────────────────────
 * Measured before this was implemented: DEBT_PAYMENT since 2026-06-01 totals
 * $55,710 against $16,920 of SPENDING. Investigated rather than assumed —
 * every payment appears TWICE (a debit on `CHASE COLLEGE`, a credit on the card,
 * same date and amount), so the economic total is roughly half; and the cards
 * carry $16,854 of the period's $17,012 of spending while checking carries $157,
 * so the purchases behind those settlements are ALREADY in the spending
 * population. Counting both would double-count every card purchase. The excess
 * over card spending was balance paydown, and the balances are now $11.09 and
 * -$86.19 — nothing remains to pay down, so extrapolating it would project an
 * outflow against a debt that no longer exists. Hence: the projection's spending
 * term is the shared `expenseTotal` population, which excludes DEBT_PAYMENT, and
 * `S6` below pins that the projection adds no debt term of its own.
 */

import {
  deriveObservedSpendingRate, monthLabel, WINDOW_MONTHS,
} from './observed-spending';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectCash, projectCashInterval, type ProjectionSpending } from './projection';
import {
  AmountBasis, EventProvenance, FlowRole, observedCashContribution,
  type FutureCashEvent,
} from './future-cash-event';
import { ConclusionStatus, AssumptionOrigin } from './policy';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const near = (name: string, a: number | null | undefined, b: number, tol = 0.01) =>
  check(name, a != null && Math.abs(a - b) < tol, `expected ~${b}, got ${a}`);

// Thirteen real complete months from the live Space, oldest first.
const MONTHS = [
  ['2025-07', 7911.08], ['2025-08', 6090.17], ['2025-09', 5937.27], ['2025-10', 8323.38],
  ['2025-11', 6861.01], ['2025-12', 4647.42], ['2026-01', 5323.67], ['2026-02', 7351.89],
  ['2026-03', 3788.11], ['2026-04', 4088.32], ['2026-05', 14060.81], ['2026-06', 8698.14],
  ['2026-07', 2290.03], ['2026-08', 6023.33],
].map(([month, expenseTotal]) => ({ month: month as string, expenseTotal: expenseTotal as number }));

// ── S. the observed spending window ─────────────────────────────────────────
{
  const r = deriveObservedSpendingRate(MONTHS);
  check('S1 the window is the canonical three months', WINDOW_MONTHS === 3);
  check('S1b and it is the MOST RECENT three, never the most stable',
    r.assertable && r.months.join(',') === '2026-06,2026-07,2026-08', JSON.stringify(r));
  if (r.assertable) {
    near('S2 the rate is their mean', r.monthlyRate, (8698.14 + 2290.03 + 6023.33) / 3);
    near('S3 dispersion is stated, not smoothed', r.dispersionRatio, 8698.14 / 2290.03);
    check('S4 it carries OBSERVED_CONTINUATION, never SYSTEM_POLICY',
      r.origin === AssumptionOrigin.OBSERVED_CONTINUATION);
    // ⚠️ F6 OWNS THE WORD "NORMAL" AND WITHHELD IT FOR THIS USER. A projection
    // input that borrowed it would assert exactly what F6 measured to be false.
    // S5/S5b went with `describeObservedSpending` (V26-REASONING Slice 0); they
    // policed a dead renderer's wording. The rule itself is structural and is
    // kept: the rate carries OBSERVED_CONTINUATION (S4), never a normality
    // claim, and it carries the window it was derived from as a field.
    check('S5 the rate names the window it came from, and claims no normality',
      r.monthCount === 3 && r.months.length === 3 && !/normal/i.test(JSON.stringify(r)),
      JSON.stringify(r));
  }
  // Window selection must not be opportunistic: a longer history is available and
  // is not used, and the two windows genuinely disagree.
  const all = deriveObservedSpendingRate(MONTHS, 14);
  check('S1c a longer window would give a different answer, and is not chosen',
    all.assertable && r.assertable && Math.abs(all.monthlyRate - r.monthlyRate) > 500,
    all.assertable && r.assertable ? `${all.monthlyRate} vs ${r.monthlyRate}` : '');
  check('S7 no complete month is a refusal, not a zero',
    deriveObservedSpendingRate([]).assertable === false);
  const one = deriveObservedSpendingRate([MONTHS[0]!]);
  check('S8 a single month has no dispersion to report',
    one.assertable && one.dispersionRatio === null);
  check('S9 months are labelled unambiguously', monthLabel('2026-07') === 'July 2026');
}

// ── O. the observed-settled cash gate ───────────────────────────────────────
const ev = (o: { value: number; basis: string; observedSettled?: boolean }): FutureCashEvent => ({
  id: 'e1', timing: { kind: 'EXACT', dateISO: '2026-09-11' },
  timingProvenance: EventProvenance.DERIVED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: o.value, currency: 'USD', basis: o.basis as never,
    provenance: EventProvenance.DERIVED, observedSettled: o.observedSettled },
} as FutureCashEvent);
{
  check('O1 an UNKNOWN amount observed settling is cash',
    observedCashContribution(ev({ value: 5286.64, basis: AmountBasis.UNKNOWN, observedSettled: true })).assertable);
  check('O2 the same amount NOT observed settling is not',
    !observedCashContribution(ev({ value: 5286.64, basis: AmountBasis.UNKNOWN })).assertable);
  // ⚠️ THE BONUS CASE, WHICH THIS SLICE MUST NOT TOUCH. A stated future gross
  // amount is not cash however it is marked; nothing observed it arriving.
  check('O3 a GROSS amount is refused even when marked observed',
    !observedCashContribution(ev({ value: 15500, basis: AmountBasis.GROSS, observedSettled: true })).assertable);
}

// ── P. the projection ───────────────────────────────────────────────────────
const OPENING = 16976.35;
const payroll = (dateISO: string): FutureCashEvent => ({
  id: `pay@${dateISO}`, timing: { kind: 'EXACT', dateISO },
  timingProvenance: EventProvenance.DERIVED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 5286.64, currency: 'USD', basis: AmountBasis.UNKNOWN,
    provenance: EventProvenance.DERIVED, observedSettled: true },
} as FutureCashEvent);
const EVENTS = ['2026-09-11', '2026-09-25', '2026-10-09'].map(payroll);
const rate = deriveObservedSpendingRate(MONTHS);
const observed: ProjectionSpending = { kind: 'OBSERVED', rate: rate as never };
const base = { openingCash: OPENING, events: EVENTS, fromISO: '2026-08-31', toISO: '2026-12-31',
  currency: 'USD' };
{
  const p = projectCash({ ...base, spending: observed });
  check('P1 it carries the EVIDENCE_BASED_PROJECTION standing, never FACTUALLY_LICENSED',
    p.status === ConclusionStatus.EVIDENCE_BASED_PROJECTION, p.status);
  const days = 122, monthly = rate.assertable ? rate.monthlyRate : 0;
  near('P2 closing is opening + observed inflows - accrued spending',
    p.closing, OPENING + 3 * 5286.64 - (monthly / (365 / 12)) * days);
  check('P3 every component states its derivation',
    p.components.length > 0 && p.components.every((c) => c.derivation.length > 10));
  check('P3b and the spending component names its months',
    p.components.some((c) => /July 2026|August 2026/.test(c.derivation)));
  check('P4 a range accompanies but never replaces the central figure',
    p.range !== null && p.closing !== null && p.range.low < p.closing && p.range.high > p.closing);
  // ⚠️ S6 — the debt finding, as a property. The projection introduces no debt
  // term: its only outflows are dated licensed obligations and the spending
  // population, which already excludes DEBT_PAYMENT.
  check('S6 no debt-payment term is invented',
    !p.components.some((c) => /debt|payoff|paydown/i.test(c.label)),
    p.components.map((c) => c.label).join(','));

  const noOpening = projectCash({ ...base, openingCash: null, spending: observed });
  check('P5 no opening cash is a REFUSAL, never a zero start',
    noOpening.status === ConclusionStatus.REFUSED && noOpening.closing === null
    && noOpening.missing.includes('current cash balance'));
  const noSpend = projectCash({ ...base, spending: null });
  check('P6 no spending evidence is a refusal too', noSpend.status === ConclusionStatus.REFUSED);

  // Events the projection cannot use are reported with the authority's reason,
  // not silently dropped.
  const withGross = projectCash({ ...base, spending: observed, events: [
    ...EVENTS,
    { ...payroll('2026-10-15'), id: 'bonus',
      amount: { value: 15500, currency: 'USD', basis: AmountBasis.GROSS,
        provenance: EventProvenance.USER_ASSERTED } } as FutureCashEvent,
  ] });
  check('P7 a GROSS bonus is excluded and named', withGross.excluded.some((e) => e.id === 'bonus'));
  near('P7b and contributes nothing to the projected figure',
    withGross.closing, p.closing ?? 0);
}

// ── U. user override precedence ─────────────────────────────────────────────
{
  const user: ProjectionSpending = { kind: 'USER_ASSUMED', dailyRate: 5000 / (365 / 12),
    monthlyAmount: 5000, statedAs: 'supposed for this forecast: $5,000/month' };
  const p = projectCash({ ...base, spending: user });
  const o = projectCash({ ...base, spending: observed });
  // ⚠️ THE OVERRIDE REPLACES THE TERM; IT DOES NOT CANCEL THE ANSWER. The first
  // implementation suppressed the projection whenever the user set a spending
  // level, which answered "what if I spend $5,000?" with nothing at all.
  check('U1 a user rate still produces a projection', p.closing !== null);
  check('U2 and it differs from the observed one', p.closing !== o.closing);
  // ⚠️ THE LABEL MUST NAME THE SOURCE OF THE RATE. Both are PROJECTED — the
  // figure is future spending either way — so the distinction that matters is
  // whose rate produced it. The live UI caught the original labels calling a
  // projected total "observed income"/"observed spending", which renamed a
  // projection into a measurement.
  check('U3 the spending component names the ASSUMED rate, not an observed one',
    p.components.some((c) => /assumed rate/.test(c.label))
    && !p.components.some((c) => /observed rate/.test(c.label)),
    p.components.map((c) => c.label).join(' | '));
  check('U3b and the observed path names the observed rate',
    o.components.some((c) => /observed rate/.test(c.label)));
  // The income component is projected in BOTH paths and must say so.
  check('U3c neither path calls a projected total "observed income"',
    ![...p.components, ...o.components].some((c) => /^observed income/.test(c.label)),
    [...p.components, ...o.components].map((c) => c.label).join(' | '));
  check('U4 no observed-window range is offered for a supposed rate', p.range === null);
  check('U5 and the assumption is attributed to the user',
    p.assumptions.some((a) => /supposition|user/i.test(a)), p.assumptions.join(' | '));
}

// ── I. an interval of the projection ────────────────────────────────────────
//
// ⚠️ THE INVARIANT IS A DIFFERENCE OF TWO CUMULATIVE RUNS. "How much will I spend
// during 2027?" was two `projectCash` runs and a subtraction performed in prose.
// An interval is that subtraction, owned by the projection — so the property
// worth pinning is not a figure but that, for ANY future window, every component
// equals `cumulative(to) − cumulative(day before from)`, and the cash change
// equals the difference of the two closings.
{
  const ASOF = '2026-09-20';
  // Biweekly payroll for two and a half years, at the sub-cent level payroll
  // really settles at — the figure that makes rounded parts miss a rounded whole.
  const biweekly: FutureCashEvent[] = [];
  for (let t = Date.parse('2026-09-25T00:00:00Z'); t <= Date.parse('2028-12-31T00:00:00Z'); t += 14 * 86_400_000) {
    const e = payroll(new Date(t).toISOString().slice(0, 10));
    biweekly.push({ ...e, amount: { ...e.amount, value: 5286.645 } } as FutureCashEvent);
  }
  const rent = (dateISO: string): FutureCashEvent => ({
    ...payroll(dateISO), id: `rent@${dateISO}`, direction: 'OUTFLOW', role: FlowRole.DEBT_PAYMENT,
    amount: { value: 1850, currency: 'USD', basis: AmountBasis.NET,
      provenance: EventProvenance.DERIVED, observedSettled: true },
  } as unknown as FutureCashEvent);
  const events = [...biweekly, rent('2027-01-01'), rent('2027-12-31'), rent('2028-01-01')];
  const input = { openingCash: 13330.97, events, spending: observed, fromISO: ASOF,
    toISO: '2028-12-31', currency: 'USD' };
  const cum = (toISO: string) => projectCash({ ...input, toISO });
  const part = (p: ReturnType<typeof projectCash>, re: RegExp) =>
    p.components.find((c) => re.test(c.label))?.value ?? 0;

  const windows: [string, string][] = [
    ['2027-01-01', '2027-12-31'],   // a calendar year — the question that prompted this
    ['2026-09-21', '2026-12-31'],   // starts tomorrow
    ['2027-03-15', '2027-03-15'],   // one day
    ['2027-02-01', '2027-02-28'],   // a month
    ['2028-01-01', '2028-12-31'],   // a leap year, ending on the horizon
    ['2026-09-25', '2026-10-08'],   // opens ON a pay date, closes the day before the next
  ];
  let exact = true, detail = '';
  for (const [from, to] of windows) {
    const i = projectCashInterval(input, { fromISO: from, toISO: to });
    const before = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const a = cum(before), b = cum(to);
    const want = { income: part(b, /income/) - part(a, /income/),
      obligations: part(b, /obligations/) - part(a, /obligations/),
      spending: part(b, /spending/) - part(a, /spending/),
      cash: (b.closing as number) - (a.closing as number) };
    const got = { income: i.components.find((c) => /income/.test(c.label))?.value ?? 0,
      obligations: i.components.find((c) => /obligations/.test(c.label))?.value ?? 0,
      spending: i.components.find((c) => /spending/.test(c.label))?.value ?? 0,
      cash: i.cashChange as number };
    for (const k of ['income', 'obligations', 'spending', 'cash'] as const) {
      if (Math.abs(got[k] - want[k]) > 1e-6) { exact = false; detail += `${from}..${to} ${k}: ${got[k]} vs ${want[k]}; `; }
    }
    if (Math.abs((got.income - got.obligations - got.spending) - got.cash) > 1e-6) {
      exact = false; detail += `${from}..${to} parts do not sum to the change; `; }
    if (i.opening?.cash !== a.closing || i.closing?.cash !== b.closing) {
      exact = false; detail += `${from}..${to} endpoints are not the cumulative closings to the bit; `; }
  }
  check('I1 every component of an interval is the difference of two cumulative runs, and the '
    + 'parts sum to the cash change', exact, detail);

  const y27 = projectCashInterval(input, { fromISO: '2027-01-01', toISO: '2027-12-31' });
  check('I2 the window is stated: from, to, and an inclusive day count',
    y27.fromISO === '2027-01-01' && y27.toISO === '2027-12-31' && y27.days === 365 && y27.clamped === null);
  near('I3 interval spending is the daily rate over the window\'s own days, not a year of anything',
    part(y27 as never, /spending/), (rate.assertable ? rate.dailyRate : 0) * 365, 1e-6);
  check('I4 interval income is the DATED occurrences inside the window, both ends inclusive',
    y27.eventsCounted === events.filter((e) => e.timing.kind === 'EXACT'
      && e.timing.dateISO >= '2027-01-01' && e.timing.dateISO <= '2027-12-31').length
    && part(y27 as never, /obligations/) === 3700, `${y27.eventsCounted} events, obligations ${part(y27 as never, /obligations/)}`);
  check('I4b a leap year accrues 366 days',
    projectCashInterval(input, { fromISO: '2028-01-01', toISO: '2028-12-31' }).days === 366);

  // Adjacent windows tile the horizon: nothing counted twice, nothing dropped.
  const h1 = projectCashInterval(input, { fromISO: '2026-09-21', toISO: '2027-06-30' });
  const h2 = projectCashInterval(input, { fromISO: '2027-07-01', toISO: '2028-12-31' });
  const whole = cum('2028-12-31');
  near('I5 adjacent intervals tile the cumulative projection',
    (h1.cashChange as number) + (h2.cashChange as number), (whole.closing as number) - 13330.97, 1e-6);

  // ⚠️ THE PAST IS MEASURED, NOT PROJECTED.
  const past = projectCashInterval(input, { fromISO: '2026-01-01', toISO: '2026-06-30' });
  check('I6 an interval entirely in the past is REFUSED, with no figure of any kind',
    past.status === 'REFUSED' && past.cashChange === null && past.components.length === 0
    && past.opening === null && /not in the future/.test(past.refusal ?? ''), past.refusal ?? '');
  check('I6b so is one that ends today',
    projectCashInterval(input, { fromISO: '2026-09-01', toISO: ASOF }).status === 'REFUSED');
  check('I6c and a reversed one, and one past the horizon the events were generated for',
    projectCashInterval(input, { fromISO: '2027-06-01', toISO: '2027-05-01' }).status === 'REFUSED'
    && projectCashInterval(input, { fromISO: '2028-01-01', toISO: '2029-06-30' }).status === 'REFUSED');

  // A window that STARTS in the past is the projection itself, and says so.
  const straddle = projectCashInterval(input, { fromISO: '2026-01-01', toISO: '2026-12-31' });
  const toYearEnd = cum('2026-12-31');
  check('I7 a window starting before today is CLAMPED to the projection\'s start, and echoes why',
    straddle.status === 'PROJECTED' && straddle.fromISO === ASOF
    && straddle.clamped?.requestedFromISO === '2026-01-01' && /already happened/.test(straddle.clamped?.reason ?? '')
    && straddle.requested.fromISO === '2026-01-01');
  check('I7b and is then exactly the cumulative projection — same components, same closing',
    JSON.stringify(straddle.components) === JSON.stringify(toYearEnd.components)
    && straddle.closing?.cash === toYearEnd.closing && straddle.opening?.cash === 13330.97
    && straddle.days === 102);

  check('I8 no projection, no interval: a missing spending rate refuses rather than accruing zero',
    projectCashInterval({ ...input, spending: null }, { fromISO: '2027-01-01', toISO: '2027-12-31' }).status === 'REFUSED'
    && projectCashInterval({ ...input, openingCash: null }, { fromISO: '2027-01-01', toISO: '2027-12-31' }).status === 'REFUSED');

  const user: ProjectionSpending = { kind: 'USER_ASSUMED', dailyRate: 5000 / (365 / 12),
    monthlyAmount: 5000, statedAs: 'supposed for this forecast: 5,000/month' };
  const assumed = projectCashInterval({ ...input, spending: user }, { fromISO: '2027-01-01', toISO: '2027-12-31' });
  near('I9 a user-assumed rate flows through the same interval: 5,000 a month over 365 days',
    part(assumed as never, /assumed rate/), 5000 / (365 / 12) * 365, 1e-6);
  check('I9b and a GROSS event inside the window is excluded and named, exactly as in the cumulative run',
    projectCashInterval({ ...input, events: [...events, { ...ev({ value: 15500, basis: AmountBasis.GROSS }), id: 'bonus',
      timing: { kind: 'EXACT', dateISO: '2027-03-01' } } as FutureCashEvent] },
      { fromISO: '2027-01-01', toISO: '2027-12-31' }).excluded.some((e) => e.id === 'bonus'));

  // ⚠️ NO ANNUAL SPECIAL CASE, PINNED AS TEXT. The authority knows windows, not years.
  const src = readFileSync(join(__dirname, 'projection.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  check('I10 the projection has no annual-spending special case', !/annual|perYear|yearly|\b12\b\s*\*/i.test(src));
}

console.log(failures === 0
  ? `\nPROJECTION-1: ${passes} checks passed.`
  : `\nPROJECTION-1: ${failures} FAILURE(S) (${passes} passed).`);
process.exit(failures === 0 ? 0 : 1);
