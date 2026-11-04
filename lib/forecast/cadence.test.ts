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
 * The ledger-shaped block at the end runs SYNTHETIC date lists shaped like the
 * production income ledger's streams. Those are the cases the authority exists for.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CadenceKind, CadenceProvenance, DERIVATION,
  annualFactor, monthlyFactor, monthlyEquivalent,
  occurrencesBetween, nextOccurrences, missedSinceAnchor,
  deriveCadence, isCadence,
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
  monthlyEquivalent(4946.78, CadenceKind.BIWEEKLY), 4946.78 * 26 / 12);
eq('B7 weekly keeps its repeating third', monthlyEquivalent(1000, CadenceKind.WEEKLY), 1000 * 52 / 12);
eq('B8 monthly is identity', monthlyEquivalent(4047.36, CadenceKind.MONTHLY), 4047.36);
// The two evaluation orders genuinely disagree for a minority of inputs, which
// is why ONE of them is canonical and every caller routes through the function
// rather than multiplying by monthlyFactor itself.
check('B10 multiplying by monthlyFactor is NOT interchangeable',
  [999.99, 4946.78, 1234.56].some((a) =>
    Object.values(CadenceKind).some((k) => a * annualFactor(k) / 12 !== a * monthlyFactor(k))));
check('B11 monthlyEquivalent uses the canonical order for every kind and amount',
  [5250, 999.99, 4946.78, 0.07].every((a) =>
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

const bw = cadence({ kind: CadenceKind.BIWEEKLY, anchorISO: '2036-11-14' });

eq('D1 next four biweekly dates from the anchor',
  nextOccurrences(bw, '2036-11-27', 4),
  ['2036-11-28', '2036-12-12', '2036-12-26', '2037-01-09']);
eq('D2 every generated date is exactly 14 days apart',
  [...new Set(nextOccurrences(bw, '2036-11-27', 8).map((d, i, a) =>
    i === 0 ? 14 : (Date.parse(d) - Date.parse(a[i - 1])) / 86_400_000))],
  [14]);

// The measured question: "project 3 months". Three months of biweekly pay is
// six or seven cheques depending on where the window falls — never "six,
// because two a month". Both are correct answers to different windows; the
// point is that the code counts them rather than the model assuming.
eq('D3 "the next three months" from 2036-11-27 is SEVEN cheques, not six',
  occurrencesBetween(bw, '2036-11-27', '2037-02-27').length, 7);
eq('D4 the same three-month span shifted two weeks is SIX — placement decides',
  occurrencesBetween(bw, '2036-12-01', '2037-02-28').length, 6);

check('D5 generation is deterministic',
  JSON.stringify(occurrencesBetween(bw, '2036-01-01', '2036-12-31'))
  === JSON.stringify(occurrencesBetween(bw, '2036-01-01', '2036-12-31')));
eq('D6 a full year of biweekly pay is 26 occurrences',
  occurrencesBetween(cadence({ kind: CadenceKind.BIWEEKLY, anchorISO: '2037-01-02' }),
    '2037-01-01', '2037-12-31').length, 26);
eq('D7 a full year of weekly pay is 52',
  occurrencesBetween(cadence({ kind: CadenceKind.WEEKLY, anchorISO: '2037-01-02' }),
    '2037-01-01', '2037-12-31').length, 52);
eq('D8 a full year of semimonthly pay is 24',
  occurrencesBetween(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2037-01-15', daysOfMonth: [15, 30] }),
    '2037-01-01', '2037-12-31').length, 24);
eq('D9 a full year of monthly pay is 12',
  occurrencesBetween(cadence({ kind: CadenceKind.MONTHLY, anchorISO: '2037-01-10', daysOfMonth: [10] }),
    '2037-01-01', '2037-12-31').length, 12);

// An anchor is the LAST confirmed payment, so windows routinely start before it.
eq('D10 a window entirely before the anchor still generates',
  occurrencesBetween(bw, '2036-06-01', '2036-06-30'),
  ['2036-06-13', '2036-06-27']);
eq('D11 a window starting mid-cycle skips no occurrence',
  occurrencesBetween(bw, '2036-11-15', '2036-11-30'), ['2036-11-28']);
eq('D12 an inverted window yields nothing', occurrencesBetween(bw, '2036-12-01', '2036-11-01'), []);
eq('D13 a single-day window on a pay date includes it',
  occurrencesBetween(bw, '2036-11-28', '2036-11-28'), ['2036-11-28']);
eq('D14 nextOccurrences is STRICTLY after', nextOccurrences(bw, '2036-11-28', 1), ['2036-12-12']);
eq('D15 count 0 yields nothing', nextOccurrences(bw, '2036-11-27', 0), []);

// Calendar clamping is the calendar's rule, not an approximation.
const eom = cadence({ kind: CadenceKind.MONTHLY, anchorISO: '2037-01-31', daysOfMonth: [31] });
eq('D16 the 31st clamps to February 28 in a common year',
  occurrencesBetween(eom, '2037-02-01', '2037-02-28'), ['2037-02-28']);
eq('D17 the 31st clamps to February 29 in a leap year',
  occurrencesBetween(eom, '2028-02-01', '2028-02-29'), ['2028-02-29']);
eq('D18 the 31st clamps to 30 in April', occurrencesBetween(eom, '2037-04-01', '2037-04-30'), ['2037-04-30']);
eq('D19 semimonthly emits both days ascending',
  occurrencesBetween(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2037-03-25', daysOfMonth: [10, 25] }),
    '2037-03-01', '2037-04-30'),
  ['2037-03-10', '2037-03-25', '2037-04-10', '2037-04-25']);
eq('D20 biweekly crosses a year boundary intact',
  occurrencesBetween(bw, '2036-12-28', '2037-01-11'), ['2037-01-09']);

// ═══════════════════════════════════════════════════════════════════════════
// E. Derivation is conservative — UNKNOWN is a real answer
// ═══════════════════════════════════════════════════════════════════════════

const unknownIs = (name: string, r: CadenceResult, needle: string) =>
  check(name, !isCadence(r) && r.reason.includes(needle),
    isCadence(r) ? `resolved to ${r.kind}` : r.reason);

unknownIs('E1 one observation is UNKNOWN', deriveCadence(['2037-06-08']), 'observation');
unknownIs('E2 two observations are UNKNOWN', deriveCadence(['2037-06-08', '2037-06-22']), 'observation');
unknownIs('E3 five observations are below threshold',
  deriveCadence(every('2037-01-02', 14, 5)), 'observation');
check('E4 six observations clear the threshold',
  isCadence(deriveCadence(every('2037-01-02', 14, 6))));
eq('E5 MIN_OBSERVATIONS is the documented gate', DERIVATION.MIN_OBSERVATIONS, 6);

unknownIs('E6 random spacing is UNKNOWN',
  deriveCadence(['2033-02-11', '2033-02-14', '2033-03-29', '2033-05-02', '2033-05-21', '2033-08-30', '2033-09-08']),
  '');
unknownIs('E7 a 45-day rhythm matches no supported kind',
  deriveCadence(every('2037-01-01', 45, 8)), 'no supported cadence');
unknownIs('E8 a 3-day rhythm matches no supported kind',
  deriveCadence(every('2037-01-01', 3, 8)), 'no supported cadence');
unknownIs('E9 quarterly is not a supported kind',
  deriveCadence(['2033-02-10','2033-05-10','2033-08-10','2033-11-10','2034-02-10','2034-05-10','2034-08-10']),
  'no supported cadence');

// Half-clean series: one that degrades must not be forced into a kind.
unknownIs('E10 a series with too many irregular gaps stays UNKNOWN',
  deriveCadence(['2037-01-09','2037-01-23','2037-03-06','2037-03-20','2037-05-22','2037-06-05','2037-08-14','2037-09-25']),
  '');
check('E11 UNKNOWN never carries an anchor', (() => {
  const r = deriveCadence(['2037-06-08']);
  return !isCadence(r) && !('anchorISO' in r);
})());
check('E12 UNKNOWN always states WHY',
  !isCadence(deriveCadence(['2037-06-08']))
  && (deriveCadence(['2037-06-08']) as { reason: string }).reason.length > 20);
eq('E13 MIN_REGULARITY is documented and strict', DERIVATION.MIN_REGULARITY, 0.7);

// The ambiguous band: neither concentrated enough for semimonthly nor spread
// enough for biweekly. Guessing here is the 8.3% error, so the answer is UNKNOWN.
unknownIs('E14 the biweekly/semimonthly ambiguous band refuses to guess',
  deriveCadence(['2037-01-07','2037-01-22','2037-02-06','2037-02-20','2037-03-08','2037-03-23','2037-04-07','2037-04-21']),
  'ambiguous');

// ═══════════════════════════════════════════════════════════════════════════
// F. The discriminator is day-of-month spread, not gap length
// ═══════════════════════════════════════════════════════════════════════════

// Both of these sit at ~14–15 day medians. The gap CANNOT separate them.
const derivedBiweekly   = deriveCadence(every('2036-03-21', 14, 18));
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
  const c = cadence({ kind: CadenceKind.BIWEEKLY, anchorISO: '2036-11-14', provenance: CadenceProvenance.USER_ASSERTED });
  return c.evidence === undefined && annualFactor(c.kind) === 26;
})());
eq('G4 exactly two provenances — the existing vocabulary, not a new one',
  Object.keys(CadenceProvenance).sort(), ['DERIVED', 'USER_ASSERTED']);
eq('G5 sourceKey travels onto the result',
  isCadence(deriveCadence(every('2037-01-02', 14, 8), 'acct-1::payroll'))
    ? (deriveCadence(every('2037-01-02', 14, 8), 'acct-1::payroll') as Cadence).sourceKey : null,
  'acct-1::payroll');
check('G6 sourceKey travels onto UNKNOWN too',
  (deriveCadence(['2037-06-08'], 'acct-1::uber') as { sourceKey?: string }).sourceKey === 'acct-1::uber');

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

const dates = every('2037-01-02', 14, 10);
const anchored = deriveCadence(dates);
eq('H1 the anchor is the LAST confirmed occurrence, never a fitted phase',
  isCadence(anchored) ? anchored.anchorISO : null, dates[dates.length - 1]);
check('H2 the anchor is a date that actually occurred',
  isCadence(anchored) && dates.includes(anchored.anchorISO));

eq('H3 no silence at the anchor', missedSinceAnchor(bw, '2036-11-14'), 0);
eq('H4 one missed occurrence after 14 days of silence', missedSinceAnchor(bw, '2036-11-28'), 1);
// The production-shaped case: the Employer B payroll's schedule is clean and the payments stopped.
eq('H5 a stopped stream reports its silence, in occurrences',
  missedSinceAnchor(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2036-03-10', daysOfMonth: [10, 25] }),
    '2036-11-27'), 17);
check('H6 silence does NOT stop generation — cadence answers WHEN, not WHETHER',
  nextOccurrences(cadence({ kind: CadenceKind.SEMIMONTHLY, anchorISO: '2036-03-10', daysOfMonth: [10, 25] }),
    '2036-11-27', 1).length === 1);

// ═══════════════════════════════════════════════════════════════════════════
// I. Rendering — DELETED WITH `describeCadence` (V26-REASONING Slice 0)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ten checks on a prose renderer with no production caller. What they were
// really pinning is that a cadence's arithmetic is STATED rather than left to
// the model to recompute — and that survives, structurally, in `deriveCadence`'s
// own fields (`perYear`, `perMonth`, UNKNOWN as a kind rather than a hedge) and
// in sections A–H above, which assert on those fields directly.

// ═══════════════════════════════════════════════════════════════════════════
// J. Structure — this slice stays a substrate
// ═══════════════════════════════════════════════════════════════════════════

check('J1 the module reaches no database', !/from ['"]@?\/?lib\/db|prisma/i.test(src));
check('J2 the module reads no clock — every date is a parameter',
  !/Date\.now\(\)|new Date\(\)/.test(src), src.match(/Date\.now\(\)|new Date\(\)/)?.[0]);
// ⚠️ RESTATED BY V26-REASONING SLICE 0. This read "the module imports nothing
// at all", which was true and was the point — until `DAY_MS` and `median` were
// deduplicated out of seven and three private copies. The property worth
// pinning was never the import COUNT: it is that nothing arrives here but pure
// arithmetic over its own arguments. J1 and J2 already forbid the database and
// the clock; this now names the closed set of siblings it may reach.
check('J3 the module imports only pure sibling arithmetic',
  [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    .every((t) => t === './_time' || t === './_num'),
  [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).join(' | '));
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
check('J4 FORECAST-1 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/cadence" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
check('J5 no future-event persistence was added',
  !/prisma|\.create\(|\.upsert\(|migration/i.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// K. LEDGER-SHAPED STREAMS — synthetic income series
// ═══════════════════════════════════════════════════════════════════════════

// SYNTHETIC date lists, shaped like the production case's canonical INCOME rows
// keyed by (account, canonical source). Nominal schedules plus only the
// deviations the checks below need. These are the cases the authority exists for.

// Biweekly, 18 on-schedule payments plus one off-cycle payment a day after one of them.
// fixture-census: synthetic-dates — invented schedule plus test-placed deviations
const EMPLOYER_A = ['2036-03-21','2036-04-04','2036-04-18','2036-05-02','2036-05-16','2036-05-30',
  '2036-06-13','2036-06-27','2036-07-11','2036-07-25','2036-08-08','2036-08-09','2036-08-22',
  '2036-09-05','2036-09-19','2036-10-03','2036-10-17','2036-10-31','2036-11-14'];
// Semimonthly on the 10th and 25th, 35 payments, last one 2036-03-10.
const EMPLOYER_B = ['2034-10-10','2034-10-25','2034-11-10','2034-11-25','2034-12-10','2034-12-25',
  '2035-01-10','2035-01-25','2035-02-10','2035-02-25','2035-03-10','2035-03-25','2035-04-10',
  '2035-04-25','2035-05-10','2035-05-25','2035-06-10','2035-06-25','2035-07-10','2035-07-25',
  '2035-08-10','2035-08-25','2035-09-10','2035-09-25','2035-10-10','2035-10-25','2035-11-10',
  '2035-11-25','2035-12-10','2035-12-25','2036-01-10','2036-01-25','2036-02-10','2036-02-25','2036-03-10'];
// Monthly on the 15th, 25 payments; three posted late, including the last.
// fixture-census: synthetic-dates — invented schedule plus test-placed deviations
const INTEREST_MID = ['2034-11-15','2034-12-15','2035-01-15','2035-02-15','2035-03-15','2035-04-15',
  '2035-05-18','2035-06-15','2035-07-15','2035-08-15','2035-09-15','2035-10-15','2035-11-15',
  '2035-12-15','2036-01-16','2036-02-15','2036-03-15','2036-04-15','2036-05-15','2036-06-15',
  '2036-07-15','2036-08-15','2036-09-15','2036-10-15','2036-11-17'];
// Month-end, 11 payments, clamped through a leap February.
// fixture-census: synthetic-dates — invented schedule plus test-placed deviations
const INTEREST_EOM = ['2035-12-31','2036-01-31','2036-02-29','2036-03-31','2036-04-30','2036-05-31',
  '2036-06-30','2036-07-31','2036-08-31','2036-09-30','2036-10-31'];
// Sporadic off-cycle payments from the same employer as EMPLOYER_B, with a 160-day hole.
const EMPLOYER_B_ADHOC = ['2034-11-03','2034-11-13','2034-12-05','2035-05-14','2035-06-06','2035-07-17'];
// Crypto reward drops — 28 observations, no rhythm at all.
// fixture-census: synthetic-dates — invented schedule plus test-placed deviations
const BTC_REWARDS = ['2033-04-06','2033-04-10','2033-04-11','2033-04-20','2033-05-03','2033-05-05',
  '2033-05-16','2033-05-22','2033-05-25','2033-06-11','2033-06-16','2033-06-24','2033-06-25',
  '2033-07-07','2033-07-14','2033-08-02','2033-08-04','2033-08-14','2033-08-18','2033-09-02',
  '2033-09-08','2033-09-17','2033-09-20','2033-10-11','2033-10-16','2033-10-24','2033-11-07','2033-11-09'];

const empA = deriveCadence(EMPLOYER_A, 'employer-a');
const empB = deriveCadence(EMPLOYER_B, 'employer-b');

check('K1 the payroll derives BIWEEKLY',
  isCadence(empA) && empA.kind === CadenceKind.BIWEEKLY, JSON.stringify(empA));
eq('K2 its anchor is the last observed payment', isCadence(empA) ? empA.anchorISO : null, '2036-11-14');
eq('K3 the next pay date is generated, not invented',
  isCadence(empA) ? nextOccurrences(empA, '2036-11-27', 1) : null, ['2036-11-28']);
eq('K4 its median $4,946.78 cheque is $10,718.02/month at full precision',
  isCadence(empA) ? monthlyEquivalent(4946.78, empA.kind) : null, 4946.78 * 26 / 12);
check('K5 the one off-cycle payment is REPORTED, not hidden',
  isCadence(empA) && empA.evidence!.irregularGaps.length === 1 && empA.evidence!.irregularGaps[0] === 1,
  JSON.stringify(isCadence(empA) ? empA.evidence : null));
check('K6 it still resolves at 94% regularity despite that gap',
  isCadence(empA) && empA.evidence!.regularity >= 0.9);

check('K7 the previous employer derives SEMIMONTHLY — a different kind',
  isCadence(empB) && empB.kind === CadenceKind.SEMIMONTHLY, JSON.stringify(empB));
eq('K8 on the 10th and 25th', isCadence(empB) ? empB.daysOfMonth : null, [10, 25]);
check('K9 the two employers get DIFFERENT kinds from near-identical gaps',
  isCadence(empA) && isCadence(empB) && empA.kind !== empB.kind
  && Math.abs(empA.evidence!.medianGapDays - empB.evidence!.medianGapDays) <= 1);
eq('K10 and therefore different annual factors',
  [isCadence(empA) ? annualFactor(empA.kind) : 0, isCadence(empB) ? annualFactor(empB.kind) : 0], [26, 24]);
check('K11 the ended job reports 17 silent occurrences, not a clean future',
  isCadence(empB) && missedSinceAnchor(empB, '2036-11-27') === 17);

const mid = deriveCadence(INTEREST_MID), eomR = deriveCadence(INTEREST_EOM);
check('K12 mid-month interest derives MONTHLY across business-day shifts',
  isCadence(mid) && mid.kind === CadenceKind.MONTHLY, JSON.stringify(mid));
eq('K13 on the modal day, not the last shifted one',
  isCadence(mid) ? [mid.daysOfMonth, mid.anchorISO] : null, [[15], '2036-11-17']);
check('K14 month-end interest derives MONTHLY on the 31st',
  isCadence(eomR) && eomR.kind === CadenceKind.MONTHLY
  && JSON.stringify(eomR.daysOfMonth) === '[31]', JSON.stringify(eomR));
eq('K15 and clamps correctly through a short month',
  isCadence(eomR) ? occurrencesBetween(eomR, '2036-11-27', '2037-02-28') : null,
  ['2036-11-30', '2036-12-31', '2037-01-31', '2037-02-28']);

unknownIs('K16 sporadic employer payments stay UNKNOWN despite meeting the count',
  deriveCadence(EMPLOYER_B_ADHOC, 'employer-b-adhoc'), '');
unknownIs('K17 28 crypto reward drops stay UNKNOWN — volume is not rhythm',
  deriveCadence(BTC_REWARDS, 'btc-rewards'), '');
check('K18 the two interest streams are separate cadences, and merging them is noise',
  isCadence(mid) && isCadence(eomR) && !isCadence(deriveCadence([...INTEREST_MID, ...INTEREST_EOM].sort())));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
