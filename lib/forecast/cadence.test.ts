/**
 * lib/forecast/cadence.test.ts   (FORECAST-1)
 *
 * WHEN MONEY ARRIVES — PINNED.
 *
 *     npx tsx lib/forecast/cadence.test.ts
 *
 * ── The failures ────────────────────────────────────────────────────────────
 * Two, both measured live against the real Space:
 *
 *   1. "I get paid $5,250 biweekly" → the model INVENTED future pay dates. No
 *      pay date was derivable from anything in the prompt, so it produced
 *      plausible ones.
 *   2. The same answer treated biweekly as two cheques a month: $10,500/month
 *      against the true $11,375. A 7.7% understatement that reads like rounding.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   BIWEEKLY and SEMIMONTHLY are DIFFERENT (26 ≠ 24) and never collapse;
 *   the arithmetic is a property of the KIND, not a recalled fact;
 *   occurrences are GENERATED from an anchor, never invented;
 *   a cadence carries no amount;
 *   below threshold the answer is UNKNOWN, and UNKNOWN licenses nothing;
 *   one stream is (account, source) — two employers never merge.
 *
 * The real-data block at the end runs the ACTUAL date lists from the live
 * Space's income ledger. Those are the cases the authority exists for.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CadenceKind, CadenceProvenance, DERIVATION,
  annualFactor, monthlyFactor, monthlyEquivalent,
  occurrencesBetween, nextOccurrences, missedSinceAnchor,
  deriveCadence, isCadence, describeCadence,
  type Cadence, type CadenceResult,
} from './cadence';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const cadence = (o: Partial<Cadence> & Pick<Cadence, 'kind' | 'anchorISO'>): Cadence => ({
  provenance: CadenceProvenance.DERIVED, ...o,
});

/** Generate `n` dates every `step` days from `startISO` — a synthetic clean series. */
function every(startISO: string, step: number, n: number): string[] {
  const out: string[] = []; let t = Date.parse(`${startISO}T00:00:00.000Z`);
  for (let i = 0; i < n; i++) { out.push(new Date(t).toISOString().slice(0, 10)); t += step * 86_400_000; }
  return out;
}
/** Semimonthly-shaped dates: `days` of each month, `months` months from y/m. */
function twiceMonthly(y: number, m: number, days: number[], months: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < months; i++) {
    const yy = y + Math.floor((m - 1 + i) / 12), mm = ((m - 1 + i) % 12) + 1;
    for (const d of days) out.push(`${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. The kinds do not collapse
// ═══════════════════════════════════════════════════════════════════════════

eq('A1 WEEKLY is 52/year',      annualFactor(CadenceKind.WEEKLY), 52);
eq('A2 BIWEEKLY is 26/year',    annualFactor(CadenceKind.BIWEEKLY), 26);
eq('A3 SEMIMONTHLY is 24/year', annualFactor(CadenceKind.SEMIMONTHLY), 24);
eq('A4 MONTHLY is 12/year',     annualFactor(CadenceKind.MONTHLY), 12);

// THE pin. Biweekly is not "twice a month"; if these two ever compare equal the
// authority has collapsed back into the failure it was built to close.
check('A5 BIWEEKLY monthlyFactor !== SEMIMONTHLY monthlyFactor',
  monthlyFactor(CadenceKind.BIWEEKLY) !== monthlyFactor(CadenceKind.SEMIMONTHLY),
  `${monthlyFactor(CadenceKind.BIWEEKLY)} vs ${monthlyFactor(CadenceKind.SEMIMONTHLY)}`);
check('A6 BIWEEKLY monthlyFactor is 26/12, not 2',
  Math.abs(monthlyFactor(CadenceKind.BIWEEKLY) - 26 / 12) < 1e-12
  && monthlyFactor(CadenceKind.BIWEEKLY) !== 2);
eq('A7 SEMIMONTHLY monthlyFactor is exactly 2', monthlyFactor(CadenceKind.SEMIMONTHLY), 2);
check('A8 all four annual factors are distinct',
  new Set(Object.values(CadenceKind).map(annualFactor)).size === 4);

// ═══════════════════════════════════════════════════════════════════════════
// B. The measured arithmetic failure
// ═══════════════════════════════════════════════════════════════════════════

// The live answer said $10,500/month. The correct figure is $11,375.
eq('B1 $5,250 biweekly is $11,375/month', monthlyEquivalent(5250, CadenceKind.BIWEEKLY), 11375);
eq('B2 the WRONG answer ($10,500) is what SEMIMONTHLY would give',
  monthlyEquivalent(5250, CadenceKind.SEMIMONTHLY), 10500);
check('B3 the two differ by the measured 7.7%',
  Math.abs((11375 - 10500) / 11375 - 0.0769) < 0.001);
eq('B4 $5,250 biweekly is $136,500/year', monthlyEquivalent(5250, CadenceKind.BIWEEKLY) * 12, 136500);

// Precision follows the money authority's D-4 rule: full f64 through the
// computation, display rounding at the edge only. Rounding here would be a
// second, competing money convention.
eq('B5 the measured case is exact — 5250 x 26 / 12', monthlyEquivalent(5250, CadenceKind.BIWEEKLY), 11375);
eq('B6 full precision is carried, not rounded mid-computation',
  monthlyEquivalent(5306.12, CadenceKind.BIWEEKLY), 5306.12 * 26 / 12);
eq('B7 weekly keeps its repeating third', monthlyEquivalent(1000, CadenceKind.WEEKLY), 1000 * 52 / 12);
eq('B8 monthly is identity', monthlyEquivalent(4395.06, CadenceKind.MONTHLY), 4395.06);
// The two evaluation orders genuinely disagree for a minority of inputs, which
// is why ONE of them is canonical and every caller routes through the function
// rather than multiplying by monthlyFactor itself.
check('B10 multiplying by monthlyFactor is NOT interchangeable',
  [999.99, 5306.12, 1234.56].some((a) =>
    Object.values(CadenceKind).some((k) => a * annualFactor(k) / 12 !== a * monthlyFactor(k))));
check('B11 monthlyEquivalent uses the canonical order for every kind and amount',
  [5250, 999.99, 5306.12, 0.07].every((a) =>
    Object.values(CadenceKind).every((k) => monthlyEquivalent(a, k) === a * annualFactor(k) / 12)));

// ═══════════════════════════════════════════════════════════════════════════
// C. Amount is not part of cadence
// ═══════════════════════════════════════════════════════════════════════════

const src = readFileSync(join(__dirname, 'cadence.ts'), 'utf8');
const typeBlock = src.slice(src.indexOf('export interface Cadence {'), src.indexOf('/** A stream whose'));
check('C1 the Cadence type carries no amount field',
  !/\b(amount|typicalAmount|value|median)\b\s*[?:]/.test(typeBlock), typeBlock.slice(0, 200));
check('C2 deriveCadence takes dates only — no amounts in its signature',
  /export function deriveCadence\(\s*dates: readonly string\[\], sourceKey\?: string,?\s*\)/.test(src));
check('C3 monthlyEquivalent takes the amount from the CALLER',
  /export function monthlyEquivalent\(amount: number, kind: CadenceKindName\)/.test(src));
// D-4: display rounding at the edge only. Day counts and percentages round
// freely; MONEY does not.
check('C4 monthlyEquivalent does not round — D-4, full precision through the computation',
  /export function monthlyEquivalent\(amount: number, kind: CadenceKindName\): number \{\n  return amount \* annualFactor\(kind\) \/ 12;\n\}/.test(src),
  src.slice(src.indexOf('export function monthlyEquivalent'), src.indexOf('export function monthlyEquivalent') + 160));

// ═══════════════════════════════════════════════════════════════════════════
// D. Occurrences are generated, not invented
// ═══════════════════════════════════════════════════════════════════════════

const bw = cadence({ kind: CadenceKind.BIWEEKLY, anchorISO: '2026-08-14' });

eq('D1 next four biweekly dates from the anchor',
  nextOccurrences(bw, '2026-08-27', 4),
  ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09']);
eq('D2 every generated date is exactly 14 days apart',
  [...new Set(nextOccurrences(bw, '2026-08-27', 8).map((d, i, a) =>
    i === 0 ? 14 : (Date.parse(d) - Date.parse(a[i - 1])) / 86_400_000))],
  [14]);

// The measured question: "project 3 months". Three months of biweekly pay is
// six or seven cheques depending on where the window falls — never "six,
// because two a month". Both are correct answers to different windows; the
// point is that the code counts them rather than the model assuming.
eq('D3 "the next three months" from 2026-08-27 is SEVEN cheques, not six',
  occurrencesBetween(bw, '2026-08-27', '2026-11-27').length, 7);
eq('D4 the same three-month span shifted two weeks is SIX — placement decides',
  occurrencesBetween(bw, '2026-09-01', '2026-11-30').length, 6);

check('D5 generation is deterministic',
  JSON.stringify(occurrencesBetween(bw, '2026-01-01', '2026-12-31'))
  === JSON.stringify(occurrencesBetween(bw, '2026-01-01', '2026-12-31')));
eq('D6 a full year of biweekly pay is 26 occurrences',
  occurrencesBetween(cadence({ kind: CadenceKind.BIWEEKLY, anchorISO: '2026-01-02' }),
    '2026-01-01', '2026-12-31').length, 26);
eq('D7 a full year of weekly pay is 52',
  occurrencesBetween(cadence({ kind: CadenceKind.WEEKLY, anchorISO: '2026-01-02' }),
    '2026-01-01', '2026-12-31').length, 52);
eq('D8 a full year of semimonthly pay is 24',
  occurrencesBetween(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2026-01-15', daysOfMonth: [15, 30] }),
    '2026-01-01', '2026-12-31').length, 24);
eq('D9 a full year of monthly pay is 12',
  occurrencesBetween(cadence({ kind: CadenceKind.MONTHLY, anchorISO: '2026-01-10', daysOfMonth: [10] }),
    '2026-01-01', '2026-12-31').length, 12);

// An anchor is the LAST confirmed payment, so windows routinely start before it.
eq('D10 a window entirely before the anchor still generates',
  occurrencesBetween(bw, '2026-06-01', '2026-06-30'),
  ['2026-06-05', '2026-06-19']);
eq('D11 a window starting mid-cycle skips no occurrence',
  occurrencesBetween(bw, '2026-08-15', '2026-08-31'), ['2026-08-28']);
eq('D12 an inverted window yields nothing', occurrencesBetween(bw, '2026-09-01', '2026-08-01'), []);
eq('D13 a single-day window on a pay date includes it',
  occurrencesBetween(bw, '2026-08-28', '2026-08-28'), ['2026-08-28']);
eq('D14 nextOccurrences is STRICTLY after', nextOccurrences(bw, '2026-08-28', 1), ['2026-09-11']);
eq('D15 count 0 yields nothing', nextOccurrences(bw, '2026-08-27', 0), []);

// Calendar clamping is the calendar's rule, not an approximation.
const eom = cadence({ kind: CadenceKind.MONTHLY, anchorISO: '2026-01-31', daysOfMonth: [31] });
eq('D16 the 31st clamps to February 28 in a common year',
  occurrencesBetween(eom, '2026-02-01', '2026-02-28'), ['2026-02-28']);
eq('D17 the 31st clamps to February 29 in a leap year',
  occurrencesBetween(eom, '2028-02-01', '2028-02-29'), ['2028-02-29']);
eq('D18 the 31st clamps to 30 in April', occurrencesBetween(eom, '2026-04-01', '2026-04-30'), ['2026-04-30']);
eq('D19 semimonthly emits both days ascending',
  occurrencesBetween(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2026-03-25', daysOfMonth: [10, 25] }),
    '2026-03-01', '2026-04-30'),
  ['2026-03-10', '2026-03-25', '2026-04-10', '2026-04-25']);
eq('D20 biweekly crosses a year boundary intact',
  occurrencesBetween(bw, '2026-12-25', '2027-01-10'), ['2027-01-01']);

// ═══════════════════════════════════════════════════════════════════════════
// E. Derivation is conservative — UNKNOWN is a real answer
// ═══════════════════════════════════════════════════════════════════════════

const unknownIs = (name: string, r: CadenceResult, needle: string) =>
  check(name, !isCadence(r) && r.reason.includes(needle),
    isCadence(r) ? `resolved to ${r.kind}` : r.reason);

unknownIs('E1 one observation is UNKNOWN', deriveCadence(['2026-05-04']), 'observation');
unknownIs('E2 two observations are UNKNOWN', deriveCadence(['2026-05-04', '2026-05-18']), 'observation');
unknownIs('E3 five observations are below threshold',
  deriveCadence(every('2026-01-02', 14, 5)), 'observation');
check('E4 six observations clear the threshold',
  isCadence(deriveCadence(every('2026-01-02', 14, 6))));
eq('E5 MIN_OBSERVATIONS is the documented gate', DERIVATION.MIN_OBSERVATIONS, 6);

unknownIs('E6 random spacing is UNKNOWN',
  deriveCadence(['2026-01-03', '2026-01-19', '2026-02-02', '2026-03-11', '2026-03-14', '2026-06-30', '2026-07-02']),
  '');
unknownIs('E7 a 45-day rhythm matches no supported kind',
  deriveCadence(every('2026-01-01', 45, 8)), 'no supported cadence');
unknownIs('E8 a 3-day rhythm matches no supported kind',
  deriveCadence(every('2026-01-01', 3, 8)), 'no supported cadence');
unknownIs('E9 quarterly is not a supported kind',
  deriveCadence(['2025-01-15','2025-04-15','2025-07-15','2025-10-15','2026-01-15','2026-04-15','2026-07-15']),
  'no supported cadence');

// Half-clean series: a real one that degrades must not be forced into a kind.
unknownIs('E10 a series with too many irregular gaps stays UNKNOWN',
  deriveCadence(['2026-01-02','2026-01-16','2026-02-20','2026-03-06','2026-04-30','2026-05-14','2026-08-01','2026-09-15']),
  '');
check('E11 UNKNOWN never carries an anchor', (() => {
  const r = deriveCadence(['2026-05-04']);
  return !isCadence(r) && !('anchorISO' in r);
})());
check('E12 UNKNOWN always states WHY',
  !isCadence(deriveCadence(['2026-05-04']))
  && (deriveCadence(['2026-05-04']) as { reason: string }).reason.length > 20);
eq('E13 MIN_REGULARITY is documented and strict', DERIVATION.MIN_REGULARITY, 0.7);

// The ambiguous band: neither concentrated enough for semimonthly nor spread
// enough for biweekly. Guessing here is the 8.3% error, so the answer is UNKNOWN.
unknownIs('E14 the biweekly/semimonthly ambiguous band refuses to guess',
  deriveCadence(['2026-01-05','2026-01-20','2026-02-04','2026-02-19','2026-03-06','2026-03-21','2026-04-06','2026-04-22']),
  'ambiguous');

// ═══════════════════════════════════════════════════════════════════════════
// F. The discriminator is day-of-month spread, not gap length
// ═══════════════════════════════════════════════════════════════════════════

// Both of these sit at ~14–15 day medians. The gap CANNOT separate them.
const derivedBiweekly   = deriveCadence(every('2025-12-19', 14, 18));
const derivedSemimonthly = deriveCadence(twiceMonthly(2024, 7, [10, 25], 18));

check('F1 a 14-day series with drifting days-of-month is BIWEEKLY',
  isCadence(derivedBiweekly) && derivedBiweekly.kind === CadenceKind.BIWEEKLY,
  JSON.stringify(derivedBiweekly));
check('F2 a two-day-of-month series is SEMIMONTHLY',
  isCadence(derivedSemimonthly) && derivedSemimonthly.kind === CadenceKind.SEMIMONTHLY,
  JSON.stringify(derivedSemimonthly));
check('F3 their median gaps are within 1 day of each other — the gap cannot decide',
  isCadence(derivedBiweekly) && isCadence(derivedSemimonthly)
  && Math.abs(derivedBiweekly.evidence!.medianGapDays - derivedSemimonthly.evidence!.medianGapDays) <= 1,
  `${(derivedBiweekly as Cadence).evidence?.medianGapDays} vs ${(derivedSemimonthly as Cadence).evidence?.medianGapDays}`);
check('F4 their day-of-month spreads are far apart — the spread decides',
  isCadence(derivedBiweekly) && isCadence(derivedSemimonthly)
  && derivedBiweekly.evidence!.distinctDaysOfMonth > derivedSemimonthly.evidence!.distinctDaysOfMonth * 2);
eq('F5 SEMIMONTHLY carries its two pay days',
  isCadence(derivedSemimonthly) ? derivedSemimonthly.daysOfMonth : null, [10, 25]);
check('F6 BIWEEKLY carries no days-of-month — it has none',
  isCadence(derivedBiweekly) && derivedBiweekly.daysOfMonth === undefined);

// ═══════════════════════════════════════════════════════════════════════════
// G. Provenance and stream identity
// ═══════════════════════════════════════════════════════════════════════════

eq('G1 derivation is DERIVED',
  isCadence(derivedBiweekly) ? derivedBiweekly.provenance : null, CadenceProvenance.DERIVED);
check('G2 a derived cadence always carries its evidence',
  isCadence(derivedBiweekly) && derivedBiweekly.evidence !== undefined);
check('G3 USER_ASSERTED exists and needs no evidence', (() => {
  const c = cadence({ kind: CadenceKind.BIWEEKLY, anchorISO: '2026-08-14', provenance: CadenceProvenance.USER_ASSERTED });
  return c.evidence === undefined && annualFactor(c.kind) === 26;
})());
eq('G4 exactly two provenances — the existing vocabulary, not a new one',
  Object.keys(CadenceProvenance).sort(), ['DERIVED', 'USER_ASSERTED']);
eq('G5 sourceKey travels onto the result',
  isCadence(deriveCadence(every('2026-01-02', 14, 8), 'acct-1::payroll'))
    ? (deriveCadence(every('2026-01-02', 14, 8), 'acct-1::payroll') as Cadence).sourceKey : null,
  'acct-1::payroll');
check('G6 sourceKey travels onto UNKNOWN too',
  (deriveCadence(['2026-05-04'], 'acct-1::uber') as { sourceKey?: string }).sourceKey === 'acct-1::uber');

// Two employers must never become one cadence. Interleaving two clean monthly
// series produces noise, which is exactly what merging them looks like.
const employerA = twiceMonthly(2026, 1, [15], 8).map((d) => d);
const employerB = twiceMonthly(2026, 1, [17], 8).map((d) => d);
check('G7 each employer alone derives MONTHLY',
  isCadence(deriveCadence(employerA)) && isCadence(deriveCadence(employerB)));
unknownIs('G8 merging two sources destroys the pattern — proof the split is load-bearing',
  deriveCadence([...employerA, ...employerB].sort()), '');

// ═══════════════════════════════════════════════════════════════════════════
// H. Anchoring and the silence signal
// ═══════════════════════════════════════════════════════════════════════════

const dates = every('2026-01-02', 14, 10);
const anchored = deriveCadence(dates);
eq('H1 the anchor is the LAST confirmed occurrence, never a fitted phase',
  isCadence(anchored) ? anchored.anchorISO : null, dates[dates.length - 1]);
check('H2 the anchor is a date that actually occurred',
  isCadence(anchored) && dates.includes(anchored.anchorISO));

eq('H3 no silence at the anchor', missedSinceAnchor(bw, '2026-08-14'), 0);
eq('H4 one missed occurrence after 14 days of silence', missedSinceAnchor(bw, '2026-08-28'), 1);
// The real case: the Abacus payroll's schedule is clean and the job ended.
eq('H5 a stopped stream reports its silence, in occurrences',
  missedSinceAnchor(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2025-12-24', daysOfMonth: [10, 25] }),
    '2026-08-27'), 17);
check('H6 silence does NOT stop generation — cadence answers WHEN, not WHETHER',
  nextOccurrences(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2025-12-24', daysOfMonth: [10, 25] }),
    '2026-08-27', 1).length === 1);

// ═══════════════════════════════════════════════════════════════════════════
// I. Rendering states the arithmetic; it never asks for it
// ═══════════════════════════════════════════════════════════════════════════

const renderedBw = describeCadence(bw, '2026-08-27').join('\n');
check('I1 the rendering states the annual factor', /26 per year/.test(renderedBw), renderedBw);
check('I2 the rendering states the monthly factor as 26/12', /26\/12/.test(renderedBw));
check('I3 the rendering lists generated dates', /2026-08-28/.test(renderedBw));
check('I4 the rendering forbids recomputing them', /do not compute or adjust/i.test(renderedBw));
check('I5 the rendering never claims the income is still active',
  /does not establish[\s\S]*still active/i.test(renderedBw));
check('I6 the rendering carries no amount', !/\$/.test(renderedBw), renderedBw);

const renderedUnknown = describeCadence(deriveCadence(['2026-05-04']), '2026-08-27').join('\n');
check('I7 UNKNOWN renders as UNKNOWN', /UNKNOWN/.test(renderedUnknown));
check('I8 UNKNOWN forbids stating pay dates or monthly equivalence',
  /No pay dates or monthly equivalence may be stated/.test(renderedUnknown), renderedUnknown);
check('I9 UNKNOWN renders no dates at all', !/\d{4}-\d{2}-\d{2}/.test(renderedUnknown), renderedUnknown);

const renderedStale = describeCadence(
  cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2025-12-24', daysOfMonth: [10, 25] }), '2026-08-27').join('\n');
check('I10 a silent stream renders its silence', /17 scheduled occurrence/.test(renderedStale), renderedStale);

// ═══════════════════════════════════════════════════════════════════════════
// J. Structure — this slice stays a substrate
// ═══════════════════════════════════════════════════════════════════════════

check('J1 the module reaches no database', !/from ['"]@?\/?lib\/db|prisma/i.test(src));
check('J2 the module reads no clock — every date is a parameter',
  !/Date\.now\(\)|new Date\(\)/.test(src), src.match(/Date\.now\(\)|new Date\(\)/)?.[0]);
check('J3 the module imports nothing at all — it is pure arithmetic',
  !/^import /m.test(src));
// ⚠️ RESTATED BY FORECAST-10, WHICH IS THE SLICE THAT WIRES THESE. The check
// read "no consumer outside lib/forecast", and through FORECAST-9 that was both
// true and the point: a substrate with no production reader could not change an
// answer. FORECAST-10 gives it exactly one reader, so the claim worth keeping is
// not "nothing consumes this" but "only the sanctioned adapter does" — no
// assembler, prompt, route or component reaches past `lib/ai/forecast/` into the
// authorities. That is the protection the original was really providing, and it
// is now pinned directly.
const ALLOWED_CONSUMER_ROOTS = ['lib/forecast/', 'lib/ai/forecast/'];
check('J4 FORECAST-1 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/cadence" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
check('J5 no future-event persistence was added',
  !/prisma|\.create\(|\.upsert\(|migration/i.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// K. THE REAL SPACE — the actual income ledger
// ═══════════════════════════════════════════════════════════════════════════

// Verbatim date lists from the live Space's canonical INCOME rows, keyed by
// (account, canonical source). These are the cases the authority exists for.

const VECTRUS = ['2025-12-19','2026-01-01','2026-01-16','2026-01-30','2026-02-13','2026-02-27',
  '2026-03-13','2026-03-14','2026-03-27','2026-04-10','2026-04-24','2026-05-08','2026-05-22',
  '2026-06-05','2026-06-18','2026-07-02','2026-07-17','2026-07-31','2026-08-14'];
const ABACUS = ['2024-07-25','2024-08-09','2024-08-23','2024-09-10','2024-09-25','2024-10-10',
  '2024-10-25','2024-11-08','2024-11-23','2024-12-10','2024-12-24','2025-01-10','2025-01-24',
  '2025-02-08','2025-02-25','2025-03-08','2025-03-25','2025-04-10','2025-04-25','2025-05-09',
  '2025-05-23','2025-06-10','2025-06-25','2025-07-10','2025-07-25','2025-08-08','2025-08-23',
  '2025-09-10','2025-09-25','2025-10-10','2025-10-24','2025-11-08','2025-11-25','2025-12-10','2025-12-24'];
const INTEREST_MID = ['2024-08-15','2024-09-17','2024-10-16','2024-11-18','2024-12-16','2025-01-16',
  '2025-02-18','2025-03-17','2025-04-15','2025-05-15','2025-06-16','2025-07-16','2025-08-15',
  '2025-09-16','2025-10-16','2025-11-18','2025-12-15','2026-01-16','2026-02-17','2026-03-16',
  '2026-04-15','2026-05-15','2026-06-15','2026-07-15','2026-08-17'];
const INTEREST_EOM = ['2025-09-30','2025-10-31','2025-11-30','2025-12-31','2026-01-31','2026-02-28',
  '2026-03-31','2026-04-30','2026-05-31','2026-06-30','2026-07-31'];
// Sporadic off-cycle payments from the same employer as ABACUS, with a 154-day hole.
const ABACUS_ADHOC = ['2024-08-09','2024-08-23','2024-09-19','2025-02-20','2025-03-20','2025-04-17'];
// Crypto reward drops — 28 observations, no rhythm at all.
const BTC_REWARDS = ['2023-03-18','2023-03-23','2023-03-24','2023-03-25','2023-04-01','2023-04-15',
  '2023-04-26','2023-05-05','2023-05-15','2023-05-17','2023-05-21','2023-05-24','2023-05-27',
  '2023-06-02','2023-06-06','2023-06-21','2023-06-30','2023-07-06','2023-07-28','2023-08-12',
  '2023-08-18','2023-08-25','2023-09-02','2023-09-07','2023-09-14','2023-09-23','2023-09-26'];

const vec = deriveCadence(VECTRUS, 'vectrus');
const aba = deriveCadence(ABACUS, 'abacus');

check('K1 the real payroll derives BIWEEKLY',
  isCadence(vec) && vec.kind === CadenceKind.BIWEEKLY, JSON.stringify(vec));
eq('K2 its anchor is the last real payment', isCadence(vec) ? vec.anchorISO : null, '2026-08-14');
eq('K3 the next pay date is generated, not invented',
  isCadence(vec) ? nextOccurrences(vec, '2026-08-27', 1) : null, ['2026-08-28']);
eq('K4 its median $5,306.12 cheque is $11,496.59/month at full precision',
  isCadence(vec) ? monthlyEquivalent(5306.12, vec.kind) : null, 5306.12 * 26 / 12);
check('K5 the one off-cycle payment is REPORTED, not hidden',
  isCadence(vec) && vec.evidence!.irregularGaps.length === 1 && vec.evidence!.irregularGaps[0] === 1,
  JSON.stringify(isCadence(vec) ? vec.evidence : null));
check('K6 it still resolves at 94% regularity despite that gap',
  isCadence(vec) && vec.evidence!.regularity >= 0.9);

check('K7 the previous employer derives SEMIMONTHLY — a different kind',
  isCadence(aba) && aba.kind === CadenceKind.SEMIMONTHLY, JSON.stringify(aba));
eq('K8 on the 10th and 25th', isCadence(aba) ? aba.daysOfMonth : null, [10, 25]);
check('K9 the two employers get DIFFERENT kinds from near-identical gaps',
  isCadence(vec) && isCadence(aba) && vec.kind !== aba.kind
  && Math.abs(vec.evidence!.medianGapDays - aba.evidence!.medianGapDays) <= 1);
eq('K10 and therefore different annual factors',
  [isCadence(vec) ? annualFactor(vec.kind) : 0, isCadence(aba) ? annualFactor(aba.kind) : 0], [26, 24]);
check('K11 the ended job reports 17 silent occurrences, not a clean future',
  isCadence(aba) && missedSinceAnchor(aba, '2026-08-27') === 17);

const mid = deriveCadence(INTEREST_MID), eomR = deriveCadence(INTEREST_EOM);
check('K12 mid-month interest derives MONTHLY across business-day shifts',
  isCadence(mid) && mid.kind === CadenceKind.MONTHLY, JSON.stringify(mid));
eq('K13 on the modal day, not the last shifted one',
  isCadence(mid) ? [mid.daysOfMonth, mid.anchorISO] : null, [[15], '2026-08-17']);
check('K14 month-end interest derives MONTHLY on the 31st',
  isCadence(eomR) && eomR.kind === CadenceKind.MONTHLY
  && JSON.stringify(eomR.daysOfMonth) === '[31]', JSON.stringify(eomR));
eq('K15 and clamps correctly through a short month',
  isCadence(eomR) ? occurrencesBetween(eomR, '2026-08-27', '2026-11-30') : null,
  ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);

unknownIs('K16 sporadic employer payments stay UNKNOWN despite meeting the count',
  deriveCadence(ABACUS_ADHOC, 'abacus-adhoc'), '');
unknownIs('K17 28 crypto reward drops stay UNKNOWN — volume is not rhythm',
  deriveCadence(BTC_REWARDS, 'btc-rewards'), '');
check('K18 the two interest streams are separate cadences, and merging them is noise',
  isCadence(mid) && isCadence(eomR) && !isCadence(deriveCadence([...INTEREST_MID, ...INTEREST_EOM].sort())));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
