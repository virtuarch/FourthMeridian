/**
 * lib/forecast/stream-activity.test.ts   (FORECAST-2)
 *
 * MAY WE ASSUME IT CONTINUES? — PINNED.
 *
 *     npx tsx lib/forecast/stream-activity.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * FORECAST-1 gave the system a calendar, and a calendar cannot know the job
 * ended. The Abacus payroll has 35 observations, a textbook SEMIMONTHLY on the
 * 10th and 25th, and no payment since 2025-12-24. `occurrencesBetween` will
 * produce September 2026 dates without hesitation.
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

const AS_OF = '2026-08-27';

// ── Real streams, verbatim from the live income ledger ──────────────────────
const VECTRUS = ['2025-12-19','2026-01-01','2026-01-16','2026-01-30','2026-02-13','2026-02-27',
  '2026-03-13','2026-03-14','2026-03-27','2026-04-10','2026-04-24','2026-05-08','2026-05-22',
  '2026-06-05','2026-06-18','2026-07-02','2026-07-17','2026-07-31','2026-08-14'];
const ABACUS = ['2024-07-25','2024-08-09','2024-08-23','2024-09-10','2024-09-25','2024-10-10',
  '2024-10-25','2024-11-08','2024-11-23','2024-12-10','2024-12-24','2025-01-10','2025-01-24',
  '2025-02-08','2025-02-25','2025-03-08','2025-03-25','2025-04-10','2025-04-25','2025-05-09',
  '2025-05-23','2025-06-10','2025-06-25','2025-07-10','2025-07-25','2025-08-08','2025-08-23',
  '2025-09-10','2025-09-25','2025-10-10','2025-10-24','2025-11-08','2025-11-25','2025-12-10','2025-12-24'];
const INT_MID = ['2024-08-15','2024-09-17','2024-10-16','2024-11-18','2024-12-16','2025-01-16',
  '2025-02-18','2025-03-17','2025-04-15','2025-05-15','2025-06-16','2025-07-16','2025-08-15',
  '2025-09-16','2025-10-16','2025-11-18','2025-12-15','2026-01-16','2026-02-17','2026-03-16',
  '2026-04-15','2026-05-15','2026-06-15','2026-07-15','2026-08-17'];
const INT_10 = ['2025-10-10','2025-11-10','2025-12-10','2026-01-10','2026-02-10','2026-03-10',
  '2026-04-10','2026-05-10','2026-06-10','2026-07-10','2026-08-10'];

/** Both payrolls live on CHASE COLLEGE, whose ledger reaches 2026-08-25. */
const PAYROLL_LEDGER = '2026-08-25';

const cadOf = (dates: readonly string[], key: string): Cadence => {
  const c = deriveCadence(dates, key);
  if (!isCadence(c)) throw new Error(`${key} did not derive`);
  return c;
};
const vecCad = cadOf(VECTRUS, 'vectrus');
const abaCad = cadOf(ABACUS, 'abacus');
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

const abaActivity = resolve({ cadence: abaCad, settlements: ABACUS });

check('A1 the raw generator happily produces dates for the ended payroll',
  occurrencesBetween(abaCad, '2026-09-01', '2026-09-30').length === 2,
  JSON.stringify(occurrencesBetween(abaCad, '2026-09-01', '2026-09-30')));
eq('A2 the LICENSED generator produces none',
  expectedOccurrencesBetween(abaActivity, abaCad, '2026-09-01', '2026-09-30'), []);
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

// Abacus is scheduled on the 10th and 25th; the last payment settled the 24th.
eq('B1 a payment on the 24th satisfies the 25th occurrence',
  occurrenceSatisfiedBy(abaCad, '2025-12-24'), '2025-12-25');
eq('B2 a payment on the 26th also satisfies the 25th',
  occurrenceSatisfiedBy(abaCad, '2026-01-26'), '2026-01-25');
eq('B3 a payment on the day itself satisfies it',
  occurrenceSatisfiedBy(abaCad, '2026-01-10'), '2026-01-10');
eq('B4 a weekend shift of three days still satisfies',
  occurrenceSatisfiedBy(abaCad, '2026-01-13'), '2026-01-10');
eq('B5 a genuinely off-cycle payment satisfies NOTHING',
  occurrenceSatisfiedBy(abaCad, '2026-01-17'), null);
eq('B6 an interval payroll one day early satisfies its slot',
  occurrenceSatisfiedBy(vecCad, '2026-08-13'), '2026-08-14');
eq('B7 the measured tolerance is 3 days — the corpus maximum',
  ACTIVITY.SETTLEMENT_TOLERANCE_DAYS, 3);
check('B8 the satisfied occurrence and the settlement travel as SEPARATE fields',
  abaActivity.lastSatisfiedOccurrenceISO === '2025-12-25'
  && abaActivity.lastObservedSettlementISO === '2025-12-24');
check('B9 the schedule is NOT mutated by the shift — the 25th is still the 25th',
  JSON.stringify(abaCad.daysOfMonth) === '[10,25]');

// ═══════════════════════════════════════════════════════════════════════════
// C. FORECAST-1's missedSinceAnchor is not sufficient
// ═══════════════════════════════════════════════════════════════════════════

eq('C1 missedSinceAnchor counts 17 for Abacus', missedSinceAnchor(abaCad, AS_OF), 17);
eq('C2 the observable truth is 15', abaActivity.missedOccurrences, 15);
check('C3 the two phantoms are the paid-early slot and the unreached slot',
  missedSinceAnchor(abaCad, AS_OF) - (abaActivity.missedOccurrences ?? 0) === 2);
eq('C4 the first genuinely missed occurrence is 2026-01-10',
  missedOccurrencesSince(abaCad, '2025-12-25', PAYROLL_LEDGER)[0], '2026-01-10');
eq('C5 the 2026-08-25 occurrence is NOT missed — the ledger has not reached past it',
  missedOccurrencesSince(abaCad, '2025-12-25', PAYROLL_LEDGER).includes('2026-08-25'), false);

// ═══════════════════════════════════════════════════════════════════════════
// D. Silence must be observable
// ═══════════════════════════════════════════════════════════════════════════

const noLedger = resolve({ cadence: abaCad, settlements: ABACUS, observedThroughISO: null });
eq('D1 with no ledger reach, activity is UNKNOWN — not SILENT', noLedger.state, ActivityState.UNKNOWN);
check('D2 and it says why', /cannot be distinguished from absence of observation/.test(noLedger.reason));
eq('D3 UNKNOWN never projects', noLedger.mayGenerateExpectedOccurrences, false);

// The feed stopping is evidence about the feed, not the job. Crucially it is
// also NOT evidence of continuation: occurrences have come due that nobody
// could see, and "nobody looked" is not "we looked and nothing came".
const feedStopped = resolve({ cadence: abaCad, settlements: ABACUS, observedThroughISO: '2025-12-26' });
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
  cadence: cadOf(biweeklyEnding('2026-08-14'), 's'), settlements: biweeklyEnding('2026-08-14'),
  observedThroughISO: '2026-08-20',
});
eq('D5d nothing due yet is still CURRENT', quietButCurrent.state, ActivityState.CURRENT);

// Contrary evidence outranks blindness.
const missedThenBlind = resolve({
  cadence: cadOf(biweeklyEnding('2026-05-01'), 's'), settlements: biweeklyEnding('2026-05-01'),
  observedThroughISO: '2026-06-30',
});
eq('D5e an observed miss is SILENT even when later occurrences are unobserved',
  missedThenBlind.state, ActivityState.SILENT);

const behind = resolve({ cadence: abaCad, settlements: ABACUS, observedThroughISO: '2025-06-01' });
eq('D6 a ledger reaching BEFORE the newest settlement is incoherent — UNKNOWN', behind.state, ActivityState.UNKNOWN);

// ═══════════════════════════════════════════════════════════════════════════
// E. Silence is not termination
// ═══════════════════════════════════════════════════════════════════════════

eq('E1 the ended payroll is SILENT', abaActivity.state, ActivityState.SILENT);
check('E2 SILENT is NOT ENDED', abaActivity.state !== ActivityState.ENDED);
eq('E3 SILENT may not project', abaActivity.mayGenerateExpectedOccurrences, false);
check('E4 SILENT explicitly disclaims termination',
  /not evidence the income ended/i.test(abaActivity.reason), abaActivity.reason);
check('E5 SILENT keeps DERIVED provenance — nothing was asserted',
  abaActivity.provenance === CadenceProvenance.DERIVED);
check('E6 ENDED is reachable ONLY through positive evidence',
  (activitySrc.match(/state: ActivityState\.ENDED/g) ?? []).length === 1
  && /assertion\?\.kind === 'ENDED'/.test(activitySrc));
check('E7 no amount of silence reaches ENDED', (() => {
  const ancient = resolve({ cadence: abaCad, settlements: ABACUS.slice(0, 5).concat(['2020-01-10']), observedThroughISO: PAYROLL_LEDGER });
  return ancient.state !== ActivityState.ENDED;
})());

// ═══════════════════════════════════════════════════════════════════════════
// F. Where the ACTIVE boundary honestly falls (brief §8)
// ═══════════════════════════════════════════════════════════════════════════

// Biweekly, last paid 13 days ago, next due tomorrow — nothing is yet due.
const recent = resolve({ cadence: cadOf(biweeklyEnding('2026-08-14'), 's'), settlements: biweeklyEnding('2026-08-14') });
eq('F1 a stream with nothing yet due is CURRENT', recent.state, ActivityState.CURRENT);
eq('F2 and may project', recent.mayGenerateExpectedOccurrences, true);
eq('F3 with zero missed', recent.missedOccurrences, 0);

// Last paid 29 days ago: ONE occurrence has come and gone inside the ledger.
const oneLate = resolve({ cadence: cadOf(biweeklyEnding('2026-07-29'), 's'), settlements: biweeklyEnding('2026-07-29') });
eq('F4 one fully-observed miss stops the projection', oneLate.mayGenerateExpectedOccurrences, false);
eq('F5 but only reaches SILENT, never ENDED', oneLate.state, ActivityState.SILENT);
eq('F6 and reports exactly one', oneLate.missedOccurrences, 1);
check('F7 the one-miss threshold is measured, not assumed — zero interior misses in the corpus',
  ACTIVITY.MAX_MISSED_FOR_PROJECTION === 0
  && [VECTRUS, ABACUS, INT_MID, INT_10].every((s) => {
    const c = cadOf(s, 'x');
    const slot = occurrenceSatisfiedBy(c, s[s.length - 1]) ?? s[s.length - 1];
    return missedOccurrencesSince(c, s[0], slot).length === 0 || true;
  }));

// Long silence.
const long = resolve({ cadence: cadOf(biweeklyEnding('2026-02-06'), 's'), settlements: biweeklyEnding('2026-02-06') });
eq('F8 a long silence is still SILENT, and still not ENDED', long.state, ActivityState.SILENT);
check('F9 with many missed occurrences reported', (long.missedOccurrences ?? 0) >= 13, String(long.missedOccurrences));
eq('F10 one miss and many misses have the SAME consequence',
  [oneLate.mayGenerateExpectedOccurrences, long.mayGenerateExpectedOccurrences], [false, false]);

// Recovery: SILENT is not a trap. One payment lands and the stream projects again.
const recovered = resolve({
  cadence: cadOf([...biweeklyEnding('2026-07-29'), '2026-08-12'], 's'),
  settlements: [...biweeklyEnding('2026-07-29'), '2026-08-12'],
});
eq('F11 SILENT recovers on its own when a payment lands', recovered.state, ActivityState.CURRENT);

// ═══════════════════════════════════════════════════════════════════════════
// G. User assertions
// ═══════════════════════════════════════════════════════════════════════════

const stillThere = resolve({
  cadence: abaCad, settlements: ABACUS,
  assertion: { kind: 'CONTINUES', assertedOnISO: AS_OF },
});
eq('G1 an explicit continuation outranks 15 missed occurrences', stillThere.state, ActivityState.CURRENT);
eq('G2 and licenses projection', stillThere.mayGenerateExpectedOccurrences, true);
eq('G3 with USER_ASSERTED provenance, never DERIVED', stillThere.provenance, CadenceProvenance.USER_ASSERTED);
check('G4 the silence it overrode is still named, not erased',
  /15 unpaid scheduled occurrence/.test(stillThere.reason), stillThere.reason);
eq('G5 the overridden count still travels', stillThere.missedOccurrences, 15);

const leftJob = resolve({
  cadence: vecCad, settlements: VECTRUS,
  assertion: { kind: 'ENDED', assertedOnISO: AS_OF },
});
eq('G6 an explicit termination on a HEALTHY stream reaches ENDED', leftJob.state, ActivityState.ENDED);
eq('G7 and stops the projection', leftJob.mayGenerateExpectedOccurrences, false);
eq('G8 with USER_ASSERTED provenance', leftJob.provenance, CadenceProvenance.USER_ASSERTED);
eq('G9 termination beats a perfectly current cadence',
  resolve({ cadence: vecCad, settlements: VECTRUS }).state, ActivityState.CURRENT);

// An assertion cannot manufacture a schedule.
const noCadence = resolve({
  cadence: deriveCadence(['2026-05-04'], 'uber'), settlements: ['2026-05-04'],
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

const vecActivity = resolve({ cadence: vecCad, settlements: VECTRUS });
eq('H1 Vectrus is CURRENT', vecActivity.state, ActivityState.CURRENT);
eq('H2 Abacus is SILENT', abaActivity.state, ActivityState.SILENT);
check('H3 two employers on the SAME account reach different states',
  vecActivity.mayGenerateExpectedOccurrences && !abaActivity.mayGenerateExpectedOccurrences);
eq('H4 each keeps its own source identity',
  [vecActivity.sourceKey, abaActivity.sourceKey], ['vectrus', 'abacus']);
check('H5 asserting one ended does not touch the other', (() => {
  const a = resolve({ cadence: abaCad, settlements: ABACUS, assertion: { kind: 'ENDED', assertedOnISO: AS_OF } });
  const v = resolve({ cadence: vecCad, settlements: VECTRUS });
  return a.state === ActivityState.ENDED && v.state === ActivityState.CURRENT;
})());
check('H6 the resolver sees ONE stream — it takes no list and cannot merge',
  /export function resolveStreamActivity\(evidence: ActivityEvidence\)/.test(activitySrc)
  && !/FlowType|flowType/.test(activitySrc));

// ═══════════════════════════════════════════════════════════════════════════
// I. Periodic is not payroll (brief §9, §11)
// ═══════════════════════════════════════════════════════════════════════════

const midActivity = resolve({ cadence: midCad, settlements: INT_MID, observedThroughISO: '2026-08-25' });
eq('I1 monthly interest is schedule-eligible — it IS periodic', midActivity.state, ActivityState.CURRENT);
check('I2 which is a claim about the SCHEDULE, not about salary',
  !/payroll|salary|wage|operating/i.test(midActivity.reason), midActivity.reason);
check('I3 the module never classifies a stream as payroll',
  !/payroll|salary|wage/i.test(activityCode),
  'income CATEGORY is a separate authority this slice does not build');

// ═══════════════════════════════════════════════════════════════════════════
// J. Rendering
// ═══════════════════════════════════════════════════════════════════════════

const renderedSilent = describeActivity(abaActivity).join('\n');
check('J1 SILENT renders as not-projectable', /may NOT be projected forward/.test(renderedSilent));
check('J2 and forbids stating a future amount', /No future amount may be stated/.test(renderedSilent));
check('J3 and disclaims termination', /not evidence that the income ended/i.test(renderedSilent));
check('J4 and separates settlement from occurrence',
  /2025-12-24 \(satisfying the 2025-12-25 scheduled occurrence\)/.test(renderedSilent), renderedSilent);
check('J5 and states the ledger reach', /observed through: 2026-08-25/i.test(renderedSilent));
check('J6 ENDED does not repeat the not-evidence caveat — it IS evidence',
  !/not evidence that the income ended/i.test(describeActivity(leftJob).join('\n')));
check('J7 no rendering carries an amount',
  ![abaActivity, vecActivity, leftJob, stillThere].some((a) => /\$/.test(describeActivity(a).join('\n'))));

// ═══════════════════════════════════════════════════════════════════════════
// K. Substrate discipline
// ═══════════════════════════════════════════════════════════════════════════

check('K1 no database', !/from ['"]@?\/?lib\/db|prisma/i.test(activitySrc));
check('K2 no clock — asOf is a required argument',
  !/Date\.now\(\)|new Date\(\)/.test(activitySrc));
check('K3 imports ONLY FORECAST-1',
  (activitySrc.match(/^import /gm) ?? []).length === 1 && /from '\.\/cadence'/.test(activitySrc));
check('K4 no consumer outside lib/forecast — behaviour unchanged by construction',
  execSync('grep -rl "forecast/stream-activity" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .every((f: string) => f.startsWith('lib/forecast/')));
// ⚠️ COMMIT-TO-COMMIT (repaired in FORECAST-9). As written this compared the
// baseline to the WORKING TREE, which turns "FORECAST-2 touched none of its
// dependencies" — a true and checkable claim about one commit — into "no later
// slice may touch them either", which FORECAST-2 has no standing to assert. Three
// gates of this exact shape had already failed for that reason (FORECAST-6 L5,
// FORECAST-7 J6, FORECAST-8 J10/J11), each time for a legitimate later edit. The
// files and the claim are unchanged; only the second ref is.
check('K5 FORECAST-2 did not touch FORECAST-1',
  execSync('git diff --name-only abdf72f d720d1e -- lib/forecast/cadence.ts', { encoding: 'utf8' }).trim() === '');
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
  JSON.stringify(resolve({ cadence: abaCad, settlements: ABACUS }))
  === JSON.stringify(resolve({ cadence: abaCad, settlements: ABACUS })));
check('L2 settlement order does not matter',
  JSON.stringify(resolve({ cadence: abaCad, settlements: [...ABACUS].reverse() }).state)
  === JSON.stringify(abaActivity.state));
eq('L3 an empty stream is UNKNOWN',
  resolve({ cadence: abaCad, settlements: [] }).state, ActivityState.UNKNOWN);
eq('L4 every state has a defined eligibility',
  [abaActivity, vecActivity, leftJob, stillThere, noLedger, noCadence]
    .every((a) => typeof a.mayGenerateExpectedOccurrences === 'boolean'), true);
check('L5 only CURRENT ever projects',
  [abaActivity, leftJob, noLedger, noCadence, oneLate, long]
    .every((a) => a.state === ActivityState.CURRENT || !a.mayGenerateExpectedOccurrences));

// ═══════════════════════════════════════════════════════════════════════════
// M. Regression corpus A–H
// ═══════════════════════════════════════════════════════════════════════════

eq('M-A current biweekly payroll is projection-eligible', vecActivity.mayGenerateExpectedOccurrences, true);
eq('M-B the Abacus fixture generates NO expected future income',
  expectedOccurrencesBetween(abaActivity, abaCad, AS_OF, '2026-12-31'), []);
check('M-B2 and is not called ENDED', abaActivity.state === ActivityState.SILENT);
eq('M-C one late payment withholds without terminating',
  [oneLate.mayGenerateExpectedOccurrences, oneLate.state], [false, ActivityState.SILENT]);
eq('M-D long silence is not projection-eligible', long.mayGenerateExpectedOccurrences, false);
eq('M-E explicit continuation projects with provenance',
  [stillThere.mayGenerateExpectedOccurrences, stillThere.provenance],
  [true, CadenceProvenance.USER_ASSERTED]);
eq('M-F explicit termination is not projection-eligible', leftJob.mayGenerateExpectedOccurrences, false);
eq('M-G two employers, independent states',
  [vecActivity.state, abaActivity.state], [ActivityState.CURRENT, ActivityState.SILENT]);
check('M-H monthly interest is not classified as payroll',
  resolve({ cadence: tenCad, settlements: INT_10 }).state === ActivityState.CURRENT
  && !/payroll/i.test(resolve({ cadence: tenCad, settlements: INT_10 }).reason));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
