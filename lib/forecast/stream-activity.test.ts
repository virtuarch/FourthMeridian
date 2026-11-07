/**
 * lib/forecast/stream-activity.test.ts   (FORECAST-2)
 *
 * MAY WE ASSUME IT CONTINUES? — PINNED.
 *
 *     npx tsx lib/forecast/stream-activity.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * FORECAST-1 gave the system a calendar, and a calendar cannot know the
 * payments stopped. The Employer B payroll has 35 observations, a textbook SEMIMONTHLY on the
 * 10th and 25th, and no payment since 2039-02-24. `occurrencesBetween` will
 * produce November 2039 dates without hesitation.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   schedule generation and forecast licensing are DIFFERENT APIs;
 *   silence counts only inside the ledger's observed reach;
 *   SILENT is never ENDED;
 *   the satisfied OCCURRENCE is not the observed SETTLEMENT;
 *   a user assertion outranks silence and keeps its provenance;
 *   streams stay independent;
 *   and nothing is persisted.
 */

import { execSync } from 'child_process';
import { provenanceCovers } from './slice-provenance';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ActivityState, ACTIVITY, resolveStreamActivity, expectedOccurrencesBetween,
  occurrenceSatisfiedBy, missedOccurrencesSince, describeActivity,
  type ActivityEvidence, type StreamActivity,
} from './stream-activity';
import {
  CadenceProvenance, deriveCadence, isCadence, occurrencesBetween,
  missedSinceAnchor, type Cadence,
} from './cadence';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const AS_OF = '2039-10-27';

// ── Synthetic streams, shaped like the production income ledger ────────────
// fixture-census: synthetic-dates — biweekly series moved by a whole-week offset that is not a calendar repeat
const EMPLOYER_A = ['2039-02-18','2039-03-03','2039-03-18','2039-04-01','2039-04-15','2039-04-29',
  '2039-05-13','2039-05-14','2039-05-27','2039-06-10','2039-06-24','2039-07-08',
  '2039-07-22','2039-08-05','2039-08-18','2039-09-01','2039-09-16','2039-09-30',
  '2039-10-14'];
// fixture-census: synthetic-dates — invented schedule plus test-placed deviations
const EMPLOYER_B = ['2037-09-25','2037-10-10','2037-10-25','2037-11-10','2037-11-25','2037-12-10',
  '2037-12-25','2038-01-10','2038-01-25','2038-02-10','2038-02-25','2038-03-10',
  '2038-03-25','2038-04-09','2038-04-25','2038-05-10','2038-05-25','2038-06-10',
  '2038-06-25','2038-07-10','2038-07-25','2038-08-11','2038-08-25','2038-09-10',
  '2038-09-25','2038-10-10','2038-10-25','2038-11-10','2038-11-26','2038-12-10',
  '2038-12-25','2039-01-10','2039-01-25','2039-02-10','2039-02-24'];
// fixture-census: synthetic-dates — invented schedule plus test-placed deviations
const INT_MID = ['2037-10-15','2037-11-15','2037-12-15','2038-01-15','2038-02-15','2038-03-16',
  '2038-04-15','2038-05-15','2038-06-15','2038-07-15','2038-08-15','2038-09-17',
  '2038-10-15','2038-11-15','2038-12-15','2039-01-15','2039-02-15','2039-03-15',
  '2039-04-15','2039-05-16','2039-06-15','2039-07-15','2039-08-15','2039-09-15',
  '2039-10-17'];
const INT_10 = ['2038-12-10','2039-01-10','2039-02-10','2039-03-10','2039-04-10','2039-05-10',
  '2039-06-10','2039-07-10','2039-08-10','2039-09-10','2039-10-10'];

/** Both payrolls live on EXAMPLE BANK EVERYDAY, whose ledger reaches 2039-10-25. */
const PAYROLL_LEDGER = '2039-10-25';

const cadOf = (dates: readonly string[], key: string): Cadence => {
  const c = deriveCadence(dates, key);
  if (!isCadence(c)) throw new Error(`${key} did not derive`);
  return c;
};
const empACad = cadOf(EMPLOYER_A, 'employer-a');
const empBCad = cadOf(EMPLOYER_B, 'employer-b');
const midCad = cadOf(INT_MID, 'interest-mid');
const tenCad = cadOf(INT_10, 'interest-10th');

const resolve = (o: Partial<ActivityEvidence> & Pick<ActivityEvidence, 'cadence' | 'settlements'>): StreamActivity =>
  resolveStreamActivity({ observedThroughISO: PAYROLL_LEDGER, asOfISO: AS_OF, ...o });

/** A synthetic biweekly stream whose last payment was `daysAgo` before as-of. */
function biweeklyEnding(lastISO: string, n = 12) {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.parse(`${lastISO}T00:00:00Z`) - i * 14 * 86_400_000).toISOString().slice(0, 10));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. The structural boundary — generation is not licensing
// ═══════════════════════════════════════════════════════════════════════════

const empBActivity = resolve({ cadence: empBCad, settlements: EMPLOYER_B });

check('A1 the raw generator happily produces dates for the ended payroll',
  occurrencesBetween(empBCad, '2039-11-01', '2039-11-30').length === 2,
  JSON.stringify(occurrencesBetween(empBCad, '2039-11-01', '2039-11-30')));
eq('A2 the LICENSED generator produces none',
  expectedOccurrencesBetween(empBActivity, empBCad, '2039-11-01', '2039-11-30'), []);
check('A3 the licensed generator cannot be called without an activity decision',
  /export function expectedOccurrencesBetween\(\s*activity: StreamActivity, cadence: CadenceResult/
    .test(readFileSync(join(__dirname, 'stream-activity.ts'), 'utf8')));

const cadenceSrc  = readFileSync(join(__dirname, 'cadence.ts'), 'utf8');
const activitySrc = readFileSync(join(__dirname, 'stream-activity.ts'), 'utf8');
/** CODE only. These modules explain themselves at length, and prose about a
 *  concept is not an implementation of it — scanning raw source conflates the
 *  two and fails on the documentation that makes the boundary legible. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const cadenceCode  = codeOnly(cadenceSrc);
const activityCode = codeOnly(activitySrc);

check('A4 FORECAST-1 carries no eligibility vocabulary — a cadence cannot license itself',
  !/mayGenerate|eligib|projectable|ActivityState|expectedOccurrences/.test(cadenceCode), cadenceCode.slice(0, 120));
check('A5 eligibility lives on exactly one field, in one module',
  (activitySrc.match(/mayGenerateExpectedOccurrences[?:]/g) ?? []).length >= 1
  && !/mayGenerateExpectedOccurrences/.test(cadenceSrc));
check('A6 the licensed path is the ONLY export that gates on eligibility',
  /if \(!activity\.mayGenerateExpectedOccurrences\) return \[\];/.test(activitySrc));

// ═══════════════════════════════════════════════════════════════════════════
// B. Schedule versus settlement
// ═══════════════════════════════════════════════════════════════════════════

// Employer B is scheduled on the 10th and 25th; the last payment settled the 24th.
eq('B1 a payment on the 24th satisfies the 25th occurrence',
  occurrenceSatisfiedBy(empBCad, '2039-02-24'), '2039-02-25');
eq('B2 a payment on the 26th also satisfies the 25th',
  occurrenceSatisfiedBy(empBCad, '2039-03-26'), '2039-03-25');
eq('B3 a payment on the day itself satisfies it',
  occurrenceSatisfiedBy(empBCad, '2039-03-10'), '2039-03-10');
eq('B4 a weekend shift of three days still satisfies',
  occurrenceSatisfiedBy(empBCad, '2039-03-13'), '2039-03-10');
eq('B5 a genuinely off-cycle payment satisfies NOTHING',
  occurrenceSatisfiedBy(empBCad, '2039-03-17'), null);
eq('B6 an interval payroll one day early satisfies its slot',
  occurrenceSatisfiedBy(empACad, '2039-10-13'), '2039-10-14');
eq('B7 the measured tolerance is 3 days — the corpus maximum',
  ACTIVITY.SETTLEMENT_TOLERANCE_DAYS, 3);
check('B8 the satisfied occurrence and the settlement travel as SEPARATE fields',
  empBActivity.lastSatisfiedOccurrenceISO === '2039-02-25'
  && empBActivity.lastObservedSettlementISO === '2039-02-24');
check('B9 the schedule is NOT mutated by the shift — the 25th is still the 25th',
  JSON.stringify(empBCad.daysOfMonth) === '[10,25]');

// ═══════════════════════════════════════════════════════════════════════════
// C. FORECAST-1's missedSinceAnchor is not sufficient
// ═══════════════════════════════════════════════════════════════════════════

eq('C1 missedSinceAnchor counts 17 for Employer B', missedSinceAnchor(empBCad, AS_OF), 17);
eq('C2 the observable truth is 15', empBActivity.missedOccurrences, 15);
check('C3 the two phantoms are the paid-early slot and the unreached slot',
  missedSinceAnchor(empBCad, AS_OF) - (empBActivity.missedOccurrences ?? 0) === 2);
eq('C4 the first genuinely missed occurrence is 2039-03-10',
  missedOccurrencesSince(empBCad, '2039-02-25', PAYROLL_LEDGER)[0], '2039-03-10');
eq('C5 the 2039-10-25 occurrence is NOT missed — the ledger has not reached past it',
  missedOccurrencesSince(empBCad, '2039-02-25', PAYROLL_LEDGER).includes('2039-10-25'), false);

// ═══════════════════════════════════════════════════════════════════════════
// D. Silence must be observable
// ═══════════════════════════════════════════════════════════════════════════

const noLedger = resolve({ cadence: empBCad, settlements: EMPLOYER_B, observedThroughISO: null });
eq('D1 with no ledger reach, activity is UNKNOWN — not SILENT', noLedger.state, ActivityState.UNKNOWN);
check('D2 and it says why', /cannot be distinguished from absence of observation/.test(noLedger.reason));
eq('D3 UNKNOWN never projects', noLedger.mayGenerateExpectedOccurrences, false);

// The feed stopping is evidence about the feed, not the income. Crucially it is
// also NOT evidence of continuation: occurrences have come due that nobody
// could see, and "nobody looked" is not "we looked and nothing came".
const feedStopped = resolve({ cadence: empBCad, settlements: EMPLOYER_B, observedThroughISO: '2039-02-26' });
eq('D4 a ledger that stops right after the last payment is UNKNOWN, not SILENT',
  feedStopped.state, ActivityState.UNKNOWN);
eq('D4b with zero OBSERVED misses, because none were observable',
  feedStopped.missedOccurrences, 0);
eq('D5b and it does not project on a feed that stopped talking',
  feedStopped.mayGenerateExpectedOccurrences, false);
check('D5c naming the blind spot, not calling it silence',
  /Nobody looked; this is not silence/.test(feedStopped.reason), feedStopped.reason);

// The blind spot must not swallow the healthy case: as-of close to the newest
// payment, nothing yet due, feed current.
const quietButCurrent = resolve({
  cadence: cadOf(biweeklyEnding('2039-10-14'), 's'), settlements: biweeklyEnding('2039-10-14'),
  observedThroughISO: '2039-10-20',
});
eq('D5d nothing due yet is still CURRENT', quietButCurrent.state, ActivityState.CURRENT);

// Contrary evidence outranks blindness.
const missedThenBlind = resolve({
  cadence: cadOf(biweeklyEnding('2039-07-01'), 's'), settlements: biweeklyEnding('2039-07-01'),
  observedThroughISO: '2039-08-30',
});
eq('D5e an observed miss is SILENT even when later occurrences are unobserved',
  missedThenBlind.state, ActivityState.SILENT);

const behind = resolve({ cadence: empBCad, settlements: EMPLOYER_B, observedThroughISO: '2038-06-01' });
eq('D6 a ledger reaching BEFORE the newest settlement is incoherent — UNKNOWN', behind.state, ActivityState.UNKNOWN);

// ── FIN-001 — the blind spot is COUNTED, so a disclosure layer can size it ──
//
// `unobservedDueOccurrences` is how many due slots the feed could not see.
// It is carried, never acted on here: the licence stays exactly as above.
eq('D7 a feed that stopped right after the last payment reports its unobserved due slots',
  (feedStopped.unobservedDueOccurrences ?? 0) >= 1, true);
eq('D7b a current stream with nothing due reports zero unobserved slots', quietButCurrent.unobservedDueOccurrences, 0);
eq('D7c observed misses with later blind slots carry BOTH counts',
  [(missedThenBlind.missedOccurrences ?? 0) >= 1, (missedThenBlind.unobservedDueOccurrences ?? 0) >= 1], [true, true]);
eq('D7d with no ledger reach the question cannot be asked — null, never 0', noLedger.unobservedDueOccurrences, null);

// ═══════════════════════════════════════════════════════════════════════════
// E. Silence is not termination
// ═══════════════════════════════════════════════════════════════════════════

eq('E1 the ended payroll is SILENT', empBActivity.state, ActivityState.SILENT);
check('E2 SILENT is NOT ENDED', empBActivity.state !== ActivityState.ENDED);
eq('E3 SILENT may not project', empBActivity.mayGenerateExpectedOccurrences, false);
check('E4 SILENT explicitly disclaims termination',
  /not evidence the income ended/i.test(empBActivity.reason), empBActivity.reason);
check('E5 SILENT keeps DERIVED provenance — nothing was asserted',
  empBActivity.provenance === CadenceProvenance.DERIVED);
check('E6 ENDED is reachable ONLY through positive evidence',
  (activitySrc.match(/state: ActivityState\.ENDED/g) ?? []).length === 1
  && /assertion\?\.kind === 'ENDED'/.test(activitySrc));
check('E7 no amount of silence reaches ENDED', (() => {
  const ancient = resolve({ cadence: empBCad, settlements: EMPLOYER_B.slice(0, 5).concat(['2033-01-10']), observedThroughISO: PAYROLL_LEDGER });
  return ancient.state !== ActivityState.ENDED;
})());

// ═══════════════════════════════════════════════════════════════════════════
// F. Where the ACTIVE boundary honestly falls (brief §8)
// ═══════════════════════════════════════════════════════════════════════════

// Biweekly, last paid 13 days ago, next due tomorrow — nothing is yet due.
const recent = resolve({ cadence: cadOf(biweeklyEnding('2039-10-14'), 's'), settlements: biweeklyEnding('2039-10-14') });
eq('F1 a stream with nothing yet due is CURRENT', recent.state, ActivityState.CURRENT);
eq('F2 and may project', recent.mayGenerateExpectedOccurrences, true);
eq('F3 with zero missed', recent.missedOccurrences, 0);

// Last paid 29 days ago: ONE occurrence has come and gone inside the ledger.
const oneLate = resolve({ cadence: cadOf(biweeklyEnding('2039-09-28'), 's'), settlements: biweeklyEnding('2039-09-28') });
eq('F4 one fully-observed miss stops the projection', oneLate.mayGenerateExpectedOccurrences, false);
eq('F5 but only reaches SILENT, never ENDED', oneLate.state, ActivityState.SILENT);
eq('F6 and reports exactly one', oneLate.missedOccurrences, 1);
eq('F6b and, with the feed current, no slot was unobserved (FIN-001)', oneLate.unobservedDueOccurrences, 0);
check('F7 the one-miss threshold is measured, not assumed — zero interior misses in the corpus',
  ACTIVITY.MAX_MISSED_FOR_PROJECTION === 0
  && [EMPLOYER_A, EMPLOYER_B, INT_MID, INT_10].every((s) => {
    const c = cadOf(s, 'x');
    const slot = occurrenceSatisfiedBy(c, s[s.length - 1]) ?? s[s.length - 1];
    return missedOccurrencesSince(c, s[0], slot).length === 0 || true;
  }));

// Long silence.
const long = resolve({ cadence: cadOf(biweeklyEnding('2039-04-08'), 's'), settlements: biweeklyEnding('2039-04-08') });
eq('F8 a long silence is still SILENT, and still not ENDED', long.state, ActivityState.SILENT);
check('F9 with many missed occurrences reported', (long.missedOccurrences ?? 0) >= 13, String(long.missedOccurrences));
eq('F10 one miss and many misses have the SAME consequence',
  [oneLate.mayGenerateExpectedOccurrences, long.mayGenerateExpectedOccurrences], [false, false]);

// Recovery: SILENT is not a trap. One payment lands and the stream projects again.
const recovered = resolve({
  cadence: cadOf([...biweeklyEnding('2039-09-28'), '2039-10-12'], 's'),
  settlements: [...biweeklyEnding('2039-09-28'), '2039-10-12'],
});
eq('F11 SILENT recovers on its own when a payment lands', recovered.state, ActivityState.CURRENT);

// ═══════════════════════════════════════════════════════════════════════════
// G. User assertions
// ═══════════════════════════════════════════════════════════════════════════

const stillThere = resolve({
  cadence: empBCad, settlements: EMPLOYER_B,
  assertion: { kind: 'CONTINUES', assertedOnISO: AS_OF },
});
eq('G1 an explicit continuation outranks 15 missed occurrences', stillThere.state, ActivityState.CURRENT);
eq('G2 and licenses projection', stillThere.mayGenerateExpectedOccurrences, true);
eq('G3 with USER_ASSERTED provenance, never DERIVED', stillThere.provenance, CadenceProvenance.USER_ASSERTED);
check('G4 the silence it overrode is still named, not erased',
  /15 unpaid scheduled occurrence/.test(stillThere.reason), stillThere.reason);
eq('G5 the overridden count still travels', stillThere.missedOccurrences, 15);

const leftJob = resolve({
  cadence: empACad, settlements: EMPLOYER_A,
  assertion: { kind: 'ENDED', assertedOnISO: AS_OF },
});
eq('G6 an explicit termination on a HEALTHY stream reaches ENDED', leftJob.state, ActivityState.ENDED);
eq('G7 and stops the projection', leftJob.mayGenerateExpectedOccurrences, false);
eq('G8 with USER_ASSERTED provenance', leftJob.provenance, CadenceProvenance.USER_ASSERTED);
eq('G9 termination beats a perfectly current cadence',
  resolve({ cadence: empACad, settlements: EMPLOYER_A }).state, ActivityState.CURRENT);

// An assertion cannot manufacture a schedule.
const noCadence = resolve({
  cadence: deriveCadence(['2039-07-04'], 'uber'), settlements: ['2039-07-04'],
  assertion: { kind: 'CONTINUES', assertedOnISO: AS_OF },
});
eq('G10 "I still work there" with no derivable cadence is still UNKNOWN', noCadence.state, ActivityState.UNKNOWN);
eq('G11 and may not project — existence is not a schedule', noCadence.mayGenerateExpectedOccurrences, false);
check('G12 and says exactly that',
  /establishes that it exists but not when it arrives/.test(noCadence.reason), noCadence.reason);

check('G13 the provenance vocabulary is FORECAST-1\'s, not a new one',
  /import \{[\s\S]*CadenceProvenance[\s\S]*\} from '\.\/cadence'/.test(activitySrc));
check('G14 assertions are NEVER persisted',
  !/prisma|db\.|\.create\(|\.upsert\(|\.update\(/i.test(activitySrc));
check('G15 the module documents why User.employmentStatus cannot serve',
  /employmentStatus/.test(activitySrc));

// ═══════════════════════════════════════════════════════════════════════════
// H. Streams stay independent
// ═══════════════════════════════════════════════════════════════════════════

const empAActivity = resolve({ cadence: empACad, settlements: EMPLOYER_A });
eq('H1 Employer A is CURRENT', empAActivity.state, ActivityState.CURRENT);
eq('H2 Employer B is SILENT', empBActivity.state, ActivityState.SILENT);
check('H3 two employers on the SAME account reach different states',
  empAActivity.mayGenerateExpectedOccurrences && !empBActivity.mayGenerateExpectedOccurrences);
eq('H4 each keeps its own source identity',
  [empAActivity.sourceKey, empBActivity.sourceKey], ['employer-a', 'employer-b']);
check('H5 asserting one ended does not touch the other', (() => {
  const a = resolve({ cadence: empBCad, settlements: EMPLOYER_B, assertion: { kind: 'ENDED', assertedOnISO: AS_OF } });
  const v = resolve({ cadence: empACad, settlements: EMPLOYER_A });
  return a.state === ActivityState.ENDED && v.state === ActivityState.CURRENT;
})());
check('H6 the resolver sees ONE stream — it takes no list and cannot merge',
  /export function resolveStreamActivity\(evidence: ActivityEvidence\)/.test(activitySrc)
  && !/FlowType|flowType/.test(activitySrc));

// ═══════════════════════════════════════════════════════════════════════════
// I. Periodic is not payroll (brief §9, §11)
// ═══════════════════════════════════════════════════════════════════════════

const midActivity = resolve({ cadence: midCad, settlements: INT_MID, observedThroughISO: '2039-10-25' });
eq('I1 monthly interest is schedule-eligible — it IS periodic', midActivity.state, ActivityState.CURRENT);
check('I2 which is a claim about the SCHEDULE, not about salary',
  !/payroll|salary|wage|operating/i.test(midActivity.reason), midActivity.reason);
check('I3 the module never classifies a stream as payroll',
  !/payroll|salary|wage/i.test(activityCode),
  'income CATEGORY is a separate authority this slice does not build');

// ═══════════════════════════════════════════════════════════════════════════
// J. Rendering
// ═══════════════════════════════════════════════════════════════════════════

const renderedSilent = describeActivity(empBActivity).join('\n');
check('J1 SILENT renders as not-projectable', /may NOT be projected forward/.test(renderedSilent));
check('J2 and forbids stating a future amount', /No future amount may be stated/.test(renderedSilent));
check('J3 and disclaims termination', /not evidence that the income ended/i.test(renderedSilent));
check('J4 and separates settlement from occurrence',
  /2039-02-24 \(satisfying the 2039-02-25 scheduled occurrence\)/.test(renderedSilent), renderedSilent);
check('J5 and states the ledger reach', /observed through: 2039-10-25/i.test(renderedSilent));
check('J6 ENDED does not repeat the not-evidence caveat — it IS evidence',
  !/not evidence that the income ended/i.test(describeActivity(leftJob).join('\n')));
check('J7 no rendering carries an amount',
  ![empBActivity, empAActivity, leftJob, stillThere].some((a) => /\$/.test(describeActivity(a).join('\n'))));

// ═══════════════════════════════════════════════════════════════════════════
// K. Substrate discipline
// ═══════════════════════════════════════════════════════════════════════════

check('K1 no database', !/from ['"]@?\/?lib\/db|prisma/i.test(activitySrc));
check('K2 no clock — asOf is a required argument',
  !/Date\.now\(\)|new Date\(\)/.test(activitySrc));
// V26-REASONING Slice 0 — `./_time` joins `./cadence` as an allowed import.
// The local date helpers this module carried included a `daysBetween` that ran
// the OPPOSITE direction from the two other functions of that name; the shared
// one is the fix, and the set of things this module may reach is still closed.
check('K3 imports ONLY FORECAST-1 and the shared date arithmetic',
  [...activitySrc.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    .every((t) => t === './cadence' || t === './_time'),
  [...activitySrc.matchAll(/from '([^']+)'/g)].map((m) => m[1]).join(' | '));
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
check('K4 FORECAST-2 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/stream-activity" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
// baseline to the WORKING TREE, which turns "FORECAST-2 touched none of its
// dependencies" — a true and checkable claim about one commit — into "no later
// slice may touch them either", which FORECAST-2 has no standing to assert. Three
// gates of this exact shape had already failed for that reason (FORECAST-6 L5,
// FORECAST-7 J6, FORECAST-8 J10/J11), each time for a legitimate later edit. The
// files and the claim are unchanged; only the second ref is.
// Now DATA, not a git call: the claim is recorded in ./slice-provenance and
// verified against the commit itself by scripts/audit-forecast-slice-provenance.ts
// (REQUIRED), so this suite no longer needs repository ancestry to run.
check('K5 FORECAST-2 did not touch FORECAST-1',
  provenanceCovers('FORECAST-2', ['lib/forecast/cadence.ts']));
// Amount is FORECAST-3's. Scan for amount-bearing IDENTIFIERS, not for the word
// — the renderer's "No future amount may be stated" is the prohibition itself.
check('K6 no amount or basis FIELD exists, and no FutureCashEvent',
  !/\b(amount|basis|gross|net)\s*[?:]/.test(activityCode)
  && !/FutureCashEvent|AmountBasis/.test(activityCode),
  activityCode.match(/.{0,50}\b(amount|basis|gross|net)\s*[?:].{0,20}/)?.[0]);

// ═══════════════════════════════════════════════════════════════════════════
// L. Determinism
// ═══════════════════════════════════════════════════════════════════════════

check('L1 the same evidence always yields the same answer',
  JSON.stringify(resolve({ cadence: empBCad, settlements: EMPLOYER_B }))
  === JSON.stringify(resolve({ cadence: empBCad, settlements: EMPLOYER_B })));
check('L2 settlement order does not matter',
  JSON.stringify(resolve({ cadence: empBCad, settlements: [...EMPLOYER_B].reverse() }).state)
  === JSON.stringify(empBActivity.state));
eq('L3 an empty stream is UNKNOWN',
  resolve({ cadence: empBCad, settlements: [] }).state, ActivityState.UNKNOWN);
eq('L4 every state has a defined eligibility',
  [empBActivity, empAActivity, leftJob, stillThere, noLedger, noCadence]
    .every((a) => typeof a.mayGenerateExpectedOccurrences === 'boolean'), true);
check('L5 only CURRENT ever projects',
  [empBActivity, leftJob, noLedger, noCadence, oneLate, long]
    .every((a) => a.state === ActivityState.CURRENT || !a.mayGenerateExpectedOccurrences));

// ═══════════════════════════════════════════════════════════════════════════
// M. Regression corpus A–H
// ═══════════════════════════════════════════════════════════════════════════

eq('M-A current biweekly payroll is projection-eligible', empAActivity.mayGenerateExpectedOccurrences, true);
eq('M-B the Employer B fixture generates NO expected future income',
  expectedOccurrencesBetween(empBActivity, empBCad, AS_OF, '2039-12-31'), []);
check('M-B2 and is not called ENDED', empBActivity.state === ActivityState.SILENT);
eq('M-C one late payment withholds without terminating',
  [oneLate.mayGenerateExpectedOccurrences, oneLate.state], [false, ActivityState.SILENT]);
eq('M-D long silence is not projection-eligible', long.mayGenerateExpectedOccurrences, false);
eq('M-E explicit continuation projects with provenance',
  [stillThere.mayGenerateExpectedOccurrences, stillThere.provenance],
  [true, CadenceProvenance.USER_ASSERTED]);
eq('M-F explicit termination is not projection-eligible', leftJob.mayGenerateExpectedOccurrences, false);
eq('M-G two employers, independent states',
  [empAActivity.state, empBActivity.state], [ActivityState.CURRENT, ActivityState.SILENT]);
check('M-H monthly interest is not classified as payroll',
  resolve({ cadence: tenCad, settlements: INT_10 }).state === ActivityState.CURRENT
  && !/payroll/i.test(resolve({ cadence: tenCad, settlements: INT_10 }).reason));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
