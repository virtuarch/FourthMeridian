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
import { projectCash, type ProjectionSpending } from './projection';
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

console.log(failures === 0
  ? `\nPROJECTION-1: ${passes} checks passed.`
  : `\nPROJECTION-1: ${failures} FAILURE(S) (${passes} passed).`);
process.exit(failures === 0 ? 0 : 1);
