/**
 * lib/forecast/periodic-amount.test.ts   (FORECAST-5)
 *
 * WHAT THE CURRENT REGIME SUPPORTS — PINNED.
 *
 *     npx tsx lib/forecast/periodic-amount.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * FORECAST-3 measured the real payroll and declined to name an amount, because
 * every naive answer is wrong differently: the mean ($5,108) averages in a
 * superseded regime, the median ($5,306) is right by luck on a series holding
 * $923.50 and $6,275.07, and the latest is one payment from being anything.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   old regimes are never averaged into the current one;
 *   the latest observation does not win;
 *   a supplemental payment is caught by the SCHEDULE, not by being small;
 *   one outlier does not destroy a strong regime;
 *   every excluded observation carries an explicit reason;
 *   amount and activity are orthogonal — Abacus has a good number and is dead;
 *   and a derived nominal amount never becomes NET.
 */

import { execSync } from 'child_process';
import { provenanceCovers } from './slice-provenance';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import {
  REGIME, ExclusionReason, deriveCurrentPeriodicAmount, assertedPeriodicAmount,
  assertedAmountBasis, exclusionSummary, periodicCashEvents,
  type AmountObservation, type PeriodicAmount,
} from './periodic-amount';
import {
  deriveCadence, isCadence, monthlyEquivalent, annualFactor, CadenceKind, type Cadence,
} from './cadence';
import { resolveStreamActivity, ActivityState } from './stream-activity';
import {
  AmountBasis, EventProvenance, FlowRole, netCashContribution, composeFutureCash,
} from './future-cash-event';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const src = readFileSync(join(__dirname, 'periodic-amount.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const AS_OF = '2026-08-27';

// ── Real streams, verbatim (date, amount) from the live ledger ──────────────
const VECTRUS: [string, number][] = [
  ['2025-12-19', 2306.42], ['2026-01-01', 5942.85], ['2026-01-16', 5928.65], ['2026-01-30', 6031.10],
  ['2026-02-13', 5810.21], ['2026-02-27', 5589.23], ['2026-03-13', 5276.89], ['2026-03-14', 923.50],
  ['2026-03-27', 5354.91], ['2026-04-10', 5315.90], ['2026-04-24', 5315.90], ['2026-05-08', 5267.10],
  ['2026-05-22', 5267.13], ['2026-06-05', 5286.64], ['2026-06-18', 6275.07], ['2026-07-02', 5286.65],
  ['2026-07-17', 5286.63], ['2026-07-31', 5286.40], ['2026-08-14', 5306.12],
];
const ABACUS: [string, number][] = [
  ['2024-07-25', 5466.38], ['2024-08-09', 4081.11], ['2024-08-23', 4081.13], ['2024-09-10', 4081.13],
  ['2024-09-25', 4081.12], ['2024-10-10', 4081.13], ['2024-10-25', 4081.12], ['2024-11-08', 4081.13],
  ['2024-11-23', 4081.12], ['2024-12-10', 4081.13], ['2024-12-24', 4388.93], ['2025-01-10', 4388.93],
  ['2025-01-24', 4388.94], ['2025-02-08', 10668.74], ['2025-02-25', 4388.94], ['2025-03-08', 4388.93],
  ['2025-03-25', 4388.94], ['2025-04-10', 4395.06], ['2025-04-25', 4487.38], ['2025-05-09', 4487.39],
  ['2025-05-23', 4487.39], ['2025-06-10', 4022.94], ['2025-06-25', 3868.14], ['2025-07-10', 4487.39],
  ['2025-07-25', 5872.63], ['2025-08-08', 4487.39], ['2025-08-23', 4487.38], ['2025-09-10', 4487.39],
  ['2025-09-25', 4487.39], ['2025-10-10', 5544.00], ['2025-10-24', 5015.68], ['2025-11-08', 5015.68],
  ['2025-11-25', 5015.68], ['2025-12-10', 4702.93], ['2025-12-24', 5066.37],
];
/** Real mid-month interest: genuinely varies with balance, 0.01–0.10. */
const INTEREST: [string, number][] = [
  ['2025-10-16', 0.05], ['2025-11-18', 0.05], ['2025-12-15', 0.04], ['2026-01-16', 0.03],
  ['2026-02-17', 0.03], ['2026-03-16', 0.03], ['2026-04-15', 0.01], ['2026-05-15', 0.01],
  ['2026-06-15', 0.01], ['2026-07-15', 0.02], ['2026-08-17', 0.02],
];

const obs = (rows: [string, number][], currency = 'USD'): AmountObservation[] =>
  rows.map(([dateISO, value]) => ({ dateISO, value, currency }));
const cadOf = (rows: [string, number][]): Cadence => {
  const c = deriveCadence(rows.map((r) => r[0]), 's');
  if (!isCadence(c)) throw new Error('cadence'); return c;
};
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const median = (x: number[]) => { const s = [...x].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const vecCad = cadOf(VECTRUS), abaCad = cadOf(ABACUS), intCad = cadOf(INTEREST);
const vec = deriveCurrentPeriodicAmount(obs(VECTRUS), vecCad);
const aba = deriveCurrentPeriodicAmount(obs(ABACUS), abaCad);
const interest = deriveCurrentPeriodicAmount(obs(INTEREST), intCad);

const vecAct = resolveStreamActivity({ cadence: vecCad, settlements: VECTRUS.map((r) => r[0]),
  observedThroughISO: '2026-08-25', asOfISO: AS_OF });
const abaAct = resolveStreamActivity({ cadence: abaCad, settlements: ABACUS.map((r) => r[0]),
  observedThroughISO: '2026-08-25', asOfISO: AS_OF });

/** A synthetic biweekly stream from a list of amounts, newest last. */
function stream(amounts: number[], endISO = '2026-08-14'): [string, number][] {
  const t0 = Date.parse(`${endISO}T00:00:00Z`);
  return amounts.map((v, i) => [
    new Date(t0 - (amounts.length - 1 - i) * 14 * 86_400_000).toISOString().slice(0, 10), v,
  ]);
}
/** A fixed biweekly schedule, so short synthetic series exercise the AMOUNT
 *  authority without also needing enough dates to derive a cadence. */
const biweeklyAt = (endISO = '2026-08-14'): Cadence => ({
  kind: CadenceKind.BIWEEKLY, anchorISO: endISO, provenance: 'DERIVED',
});
const derive = (amounts: number[]) =>
  deriveCurrentPeriodicAmount(obs(stream(amounts)), biweeklyAt());

// ═══════════════════════════════════════════════════════════════════════════
// A. THE REAL PAYROLL
// ═══════════════════════════════════════════════════════════════════════════

check('A1 the real payroll yields an assertable current amount', vec.assertable, JSON.stringify(vec).slice(0, 200));
if (vec.assertable) {
  eq('A2 the amount is the recent level, not the history', vec.value, (5286.64 + 5286.65) / 2);
  eq('A3 the regime starts after the step down', vec.regimeStartISO, '2026-03-27');
  eq('A4 on ten observations', vec.observationCount, 10);
  check('A5 within a tight spread', vec.spread < 0.02, String(vec.spread));
  eq('A6 provenance is DERIVED', vec.provenance, EventProvenance.DERIVED);
}

// The four candidate answers must be semantically distinct.
const vecVals = VECTRUS.map((r) => r[1]);
eq('A7 all-history mean is $5,108.28', Number(mean(vecVals).toFixed(2)), 5108.28);
eq('A8 all-history median is $5,306.12', median(vecVals), 5306.12);
eq('A9 the latest observation is $5,306.12', vecVals[vecVals.length - 1], 5306.12);
check('A10 the derived amount differs from ALL THREE naive answers',
  vec.assertable && vec.value !== Number(mean(vecVals).toFixed(2))
  && vec.value !== median(vecVals) && vec.value !== vecVals[vecVals.length - 1],
  vec.assertable ? String(vec.value) : 'unknown');

// ═══════════════════════════════════════════════════════════════════════════
// B. The three problems, kept apart
// ═══════════════════════════════════════════════════════════════════════════

const verdictFor = (a: PeriodicAmount, dateISO: string) => a.verdicts.find((v) => v.dateISO === dateISO);

eq('B1 the superseded ~$5,950 regime is OUTSIDE_REGIME, not outliers',
  ['2026-01-01', '2026-01-16', '2026-01-30', '2026-02-13', '2026-02-27']
    .map((d) => verdictFor(vec, d)!.excludedBecause),
  Array(5).fill(ExclusionReason.OUTSIDE_REGIME));
eq('B2 the $6,275.07 supplemental is an OUTLIER inside the regime',
  verdictFor(vec, '2026-06-18')!.excludedBecause, ExclusionReason.OUTLIER);
eq('B3 the $923.50 off-cycle payment is caught by SLOT CONTENTION',
  verdictFor(vec, '2026-03-14')!.excludedBecause, ExclusionReason.SLOT_CONTESTED);
eq('B4 and so is the payment it shares the occurrence with — neither is guessed at',
  verdictFor(vec, '2026-03-13')!.excludedBecause, ExclusionReason.SLOT_CONTESTED);
eq('B5 they share one scheduled occurrence',
  [verdictFor(vec, '2026-03-13')!.slotISO, verdictFor(vec, '2026-03-14')!.slotISO],
  ['2026-03-13', '2026-03-13']);
check('B6 contention is detected from the SCHEDULE, never from magnitude — no amount comparison decides it',
  !/value <|value >|Math\.min|Math\.max\(.*value/.test(
    code.slice(code.indexOf('SLOT_CONTESTED'), code.indexOf('const eligible'))));
eq('B7 the $2,306.42 opening payment is OUTSIDE_REGIME — no PARTIAL claim is made',
  verdictFor(vec, '2025-12-19')!.excludedBecause, ExclusionReason.OUTSIDE_REGIME);
check('B8 there is no PARTIAL category at all — it cannot be proven from this data',
  !/PARTIAL/.test(code));
eq('B9 every observation has a verdict — nothing is silently dropped',
  vec.verdicts.length, VECTRUS.length);
check('B10 and every excluded one carries a reason',
  vec.verdicts.every((v) => v.included || v.excludedBecause !== null));
eq('B11 the exclusion summary is inspectable',
  exclusionSummary(vec),
  { included: 10, OUTSIDE_REGIME: 6, SLOT_CONTESTED: 2, OUTLIER: 1 });

// ═══════════════════════════════════════════════════════════════════════════
// C. Old regimes are never averaged in
// ═══════════════════════════════════════════════════════════════════════════

const twoRegimes = derive([5950, 5940, 5960, 5955, 5290, 5285, 5295, 5288]);
check('C1 a two-regime series resolves to the RECENT level', twoRegimes.assertable);
if (twoRegimes.assertable) {
  check('C2 near the new level, nowhere near the blend', Math.abs(twoRegimes.value - 5290) < 20,
    String(twoRegimes.value));
  eq('C3 on four observations', twoRegimes.observationCount, 4);
  check('C4 the old regime is excluded FOR REGIME REASON',
    twoRegimes.verdicts.slice(0, 4).every((v) => v.excludedBecause === ExclusionReason.OUTSIDE_REGIME));
  check('C5 the blended mean is a different number entirely',
    Math.abs(twoRegimes.value - mean([5950, 5940, 5960, 5955, 5290, 5285, 5295, 5288])) > 300);
}
check('C6 the walk runs backward from the newest observation',
  /for \(let i = eligible\.length - 1; i >= 0; i--\)/.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// D. The latest observation does not win
// ═══════════════════════════════════════════════════════════════════════════

const latestSpike = derive([5290, 5285, 5295, 5288, 5292, 9000]);
check('D1 a stable regime with one unusual LATEST payment withholds rather than chasing it',
  !latestSpike.assertable
  || (latestSpike.assertable && Math.abs(latestSpike.value - 5290) < 30),
  JSON.stringify(latestSpike).slice(0, 260));
check('D2 the spike never becomes the amount',
  !latestSpike.assertable || latestSpike.value !== 9000);
const twoNew = derive([5290, 5285, 5295, 5288, 9000, 9010]);
eq('D3 two observations at a new level are not yet a licensed regime', twoNew.assertable, false);
check('D4 and it says the level changed too recently',
  !twoNew.assertable && /changed too recently/.test(twoNew.reason), (twoNew as {reason:string}).reason);

// ═══════════════════════════════════════════════════════════════════════════
// E. Thresholds and minimum evidence
// ═══════════════════════════════════════════════════════════════════════════

eq('E1 the band is 5%', REGIME.BAND, 0.05);
eq('E2 three observations minimum', REGIME.MIN_OBSERVATIONS, 3);
eq('E3 two consecutive departures end a regime', REGIME.BREAK_RUN, 2);
eq('E4 one observation is never enough', derive([5290]).assertable, false);
eq('E5 two are never enough', derive([5290, 5288]).assertable, false);
eq('E6 three stable observations suffice', derive([5290, 5288, 5292]).assertable, true);
check('E7 the band sits in a PLATEAU, not on an edge — 1%..12% give the same real answer',
  vec.assertable && vec.value === (5286.64 + 5286.65) / 2,
  'the measured within-regime spread is 1.29% and the regime step is 12.5%');
check('E8 the threshold was not widened to rescue a second stream — high volatility stays UNKNOWN',
  !derive([5000, 5600, 4700, 5400, 4900, 5500, 4800]).assertable);

// ═══════════════════════════════════════════════════════════════════════════
// F. Outliers
// ═══════════════════════════════════════════════════════════════════════════

const oneOutlier = derive([5290, 5285, 9000, 5295, 5288, 5292]);
check('F1 a single mid-regime outlier does NOT destroy the regime', oneOutlier.assertable);
if (oneOutlier.assertable) {
  eq('F2 it is excluded as an OUTLIER', oneOutlier.verdicts.find((v) => v.value === 9000)!.excludedBecause,
    ExclusionReason.OUTLIER);
  eq('F3 the regime keeps the other five', oneOutlier.observationCount, 5);
}
const manyOutliers = derive([5290, 9000, 5285, 9100, 5295, 8900, 5288]);
eq('F4 outliers outnumbering the band is variation, not a level', manyOutliers.assertable, false);
eq('F5 an old outlier is attributed to the old regime, not to this one',
  vec.verdicts.filter((v) => v.excludedBecause === ExclusionReason.OUTLIER).length, 1);

// ═══════════════════════════════════════════════════════════════════════════
// G. Amount and activity are ORTHOGONAL
// ═══════════════════════════════════════════════════════════════════════════

check('G1 the dead payroll HAS a derivable current amount', aba.assertable, JSON.stringify(aba).slice(0, 200));
if (aba.assertable) {
  eq('G2 at $5,015.68 from 2025-10-24', [aba.value, aba.regimeStartISO], [5015.68, '2025-10-24']);
  eq('G3 on four observations', aba.observationCount, 4);
}
eq('G4 and the stream is nevertheless SILENT', abaAct.state, ActivityState.SILENT);
eq('G5 so it generates ZERO future events despite a clean amount',
  periodicCashEvents(abaAct, abaCad, aba, AS_OF, '2026-12-31', FlowRole.INCOME), []);
// Scoped to the DERIVATION function's body. The module imports a type for the
// composition seam at the bottom; the derivation itself must never see it.
const deriveBody = code.slice(
  code.indexOf('export function deriveCurrentPeriodicAmount'),
  code.indexOf('export function assertedPeriodicAmount'));
check('G6 the derivation never consults activity',
  !/StreamActivity|mayGenerate|activity/i.test(deriveBody),
  deriveBody.match(/.{0,40}activity.{0,20}/i)?.[0]);

// ═══════════════════════════════════════════════════════════════════════════
// H. Basis stays orthogonal too
// ═══════════════════════════════════════════════════════════════════════════

const vecEvents = periodicCashEvents(vecAct, vecCad, vec, AS_OF, '2026-12-31', FlowRole.INCOME);
check('H1 the live payroll produces dated events with amounts', vecEvents.length === 9
  && vecEvents.every((e) => e.amount !== null), String(vecEvents.length));
eq('H2 every amount carries UNKNOWN basis — never NET',
  [...new Set(vecEvents.map((e) => e.amount!.basis))], [AmountBasis.UNKNOWN]);
check('H3 so none of it is assertable spendable cash',
  vecEvents.every((e) => !netCashContribution(e).assertable));
eq('H4 and composition withholds a net figure',
  composeFutureCash(vecEvents).assertableNet, null);
// ⚠️ H5/H6 RESTATED BY FORECAST-9A, INTENT INTACT. They read "never mentions
// NET or GROSS" and "basis is set once", which held while UNKNOWN was the only
// basis this module could produce. `assertedAmountBasis` now names both values
// in its parameter type — that is the point of it — so the pin moves from
// MENTIONING to ASSIGNING. The claim being protected is unchanged and now
// stronger: nothing here decides that an amount is net.
check('H5 the module ASSIGNS no NET or GROSS basis — it only carries a caller\'s',
  !/basis: AmountBasis\.(NET|GROSS)/.test(code));
check('H6 every basis it writes of its own is UNKNOWN, on both amount paths',
  (code.match(/basis: AmountBasis\.UNKNOWN/g) ?? []).length === 2);
eq('H7 the stated nominal total is still visible',
  composeFutureCash(vecEvents).nominalInflow, ((5286.64 + 5286.65) / 2) * 9);

// ═══════════════════════════════════════════════════════════════════════════
// I. Monthly equivalent
// ═══════════════════════════════════════════════════════════════════════════

if (vec.assertable) {
  eq('I1 biweekly monthly equivalent uses 26/12, via FORECAST-1',
    monthlyEquivalent(vec.value, CadenceKind.BIWEEKLY), vec.value * 26 / 12);
  eq('I2 which is $11,454.40 nominal',
    Number(monthlyEquivalent(vec.value, CadenceKind.BIWEEKLY).toFixed(2)), 11454.40);
  check('I3 and is NOT what "twice a month" would give',
    monthlyEquivalent(vec.value, CadenceKind.BIWEEKLY) !== vec.value * 2);
  eq('I4 the module does not compute monthly equivalence itself', /monthlyEquivalent/.test(code), false);
}
eq('I5 annual factor still comes from the cadence', annualFactor(CadenceKind.BIWEEKLY), 26);

// ═══════════════════════════════════════════════════════════════════════════
// J. Currency
// ═══════════════════════════════════════════════════════════════════════════

const mixed = deriveCurrentPeriodicAmount(
  [...obs(stream([5290, 5285, 5295]).slice(0, 2)), { dateISO: '2026-08-14', value: 5292, currency: 'EUR' }],
  biweeklyAt());
eq('J1 a mixed-currency stream is UNKNOWN', mixed.assertable, false);
check('J2 and says a regime must be single-currency',
  !mixed.assertable && /single currency/.test(mixed.reason), (mixed as {reason:string}).reason);
check('J3 no conversion is attempted',
  !/convertMoney|fxRate|FxRate|exchangeRate|\* *rate/i.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// K. User assertion
// ═══════════════════════════════════════════════════════════════════════════

const userSays = assertedPeriodicAmount(5250, 'USD', AS_OF, vec);
eq('K1 an assertion is assertable with USER_ASSERTED provenance',
  [userSays.assertable, userSays.provenance], [true, EventProvenance.USER_ASSERTED]);
eq('K2 at the stated value', userSays.value, 5250);
check('K3 it does NOT rewrite the derived evidence', userSays.verdicts.length === VECTRUS.length);
check('K4 and the reason names both figures',
  /user stated/.test(userSays.reason) && /5286\.64/.test(userSays.reason), userSays.reason);
eq('K5 derived and asserted are distinguishable by provenance alone',
  vec.assertable && vec.provenance !== userSays.provenance, true);
check('K6 an assertion is never persisted', !/\.create\(|\.upsert\(|\.update\(/i.test(code));
eq('K7 an asserted amount still carries UNKNOWN basis through the seam',
  periodicCashEvents(vecAct, vecCad, userSays, AS_OF, '2026-09-30', FlowRole.INCOME)[0].amount!.basis,
  AmountBasis.UNKNOWN);

// ═══════════════════════════════════════════════════════════════════════════
// L. Interest — periodic, and no periodic amount
// ═══════════════════════════════════════════════════════════════════════════

eq('L1 a real interest stream has no stable amount', interest.assertable, false);
check('L2 because interest tracks a balance — it genuinely varies 0.01–0.05 here',
  Math.max(...INTEREST.map((r) => r[1])) / Math.min(...INTEREST.map((r) => r[1])) >= 5);
eq('L3 its events still get dates, with no amount', (() => {
  const act = resolveStreamActivity({ cadence: intCad, settlements: INTEREST.map((r) => r[0]),
    observedThroughISO: '2026-08-17', asOfISO: AS_OF });
  const evs = periodicCashEvents(act, intCad, interest, AS_OF, '2026-11-30', FlowRole.INTEREST);
  return [evs.length > 0, evs.every((e) => e.amount === null), evs[0].role];
})(), [true, true, FlowRole.INTEREST]);

// ═══════════════════════════════════════════════════════════════════════════
// M. Substrate discipline
// ═══════════════════════════════════════════════════════════════════════════

check('M1 no database', !/from ['"]@?\/?lib\/db|prisma/i.test(code));
check('M2 no clock', !/Date\.now\(\)|new Date\(\)/.test(code));
eq('M3 imports only the three prior FORECAST modules — nothing else',
  [...new Set((src.match(/from '\.\/[a-z-]+'/g) ?? []))].sort().join(','),
  ["from './cadence'", "from './future-cash-event'", "from './stream-activity'"].join(','));
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
check('M4 FORECAST-5 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/periodic-amount" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
// baseline to the WORKING TREE, which turns "FORECAST-5 touched none of its
// dependencies" — a true and checkable claim about one commit — into "no later
// slice may touch them either", which FORECAST-5 has no standing to assert. Three
// gates of this exact shape had already failed for that reason (FORECAST-6 L5,
// FORECAST-7 J6, FORECAST-8 J10/J11), each time for a legitimate later edit. The
// files and the claim are unchanged; only the second ref is.
// Now DATA, not a git call: the claim is recorded in ./slice-provenance and
// verified against the commit itself by scripts/audit-forecast-slice-provenance.ts
// (REQUIRED), so this suite no longer needs repository ancestry to run.
check('M5 FORECAST-5 did not touch FORECAST-1/2/3/4',
  provenanceCovers('FORECAST-5', ['lib/forecast/cadence.ts', 'lib/forecast/stream-activity.ts',
    'lib/forecast/future-cash-event.ts', 'lib/forecast/obligation.ts']));
check('M6 no anomaly-detection generalisation leaked in',
  !/anomal|zscore|zScore|stddev|standardDeviation/i.test(code));
check('M7 the result is never a naked scalar',
  !/export function derive\w*: number/.test(code) && /assertable: true/.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// N. Regression corpus A–M
// ═══════════════════════════════════════════════════════════════════════════

eq('N-A stable biweekly is ASSERTABLE', derive([5290, 5285, 5295, 5288]).assertable, true);
check('N-B regime A → regime B yields B only', twoRegimes.assertable
  && Math.abs((twoRegimes as {value:number}).value - 5290) < 20);
eq('N-C one old outlier: current regime survives', oneOutlier.assertable, true);
check('N-D one latest outlier does not redefine the regime',
  !latestSpike.assertable || (latestSpike as {value:number}).value !== 9000);
eq('N-E two observations only → UNKNOWN', derive([5290, 5288]).assertable, false);
eq('N-F irregular freelance income → UNKNOWN',
  deriveCurrentPeriodicAmount(obs([['2025-05-04', 45], ['2025-07-17', 151], ['2026-06-01', 18]]),
    biweeklyAt('2026-06-01')).assertable, false);
eq('N-G same cadence, high volatility → UNKNOWN',
  derive([5000, 5600, 4700, 5400, 4900, 5500, 4800]).assertable, false);
eq('N-H semimonthly payroll → ASSERTABLE historical amount', aba.assertable, true);
eq('N-I stale Abacus: amount assertable, activity SILENT, zero events',
  [aba.assertable, abaAct.state, periodicCashEvents(abaAct, abaCad, aba, AS_OF, '2026-12-31', FlowRole.INCOME).length],
  [true, ActivityState.SILENT, 0]);
eq('N-J current Vectrus: dates + nominal amounts + UNKNOWN basis',
  [vecEvents.length, vecEvents[0].amount!.value, vecEvents[0].amount!.basis],
  [9, (5286.64 + 5286.65) / 2, AmountBasis.UNKNOWN]);
eq('N-K user assertion is distinctly represented', userSays.provenance, EventProvenance.USER_ASSERTED);
eq('N-L currency mismatch → no averaging', mixed.assertable, false);
eq('N-M interest keeps its role and gets no amount', interest.assertable, false);

// ═══════════════════════════════════════════════════════════════════════════
// P. BASIS IS ASSERTED, NEVER DERIVED (FORECAST-9A)
// ═══════════════════════════════════════════════════════════════════════════
//
// FORECAST-8 measured an inversion: "assume my paycheck is net" could unlock
// net-dependent conclusions and "my paycheck IS take-home" could not, because
// no authority had anywhere to put the second sentence. This is that door. The
// invariant it must not break is the one this module was built on — a settled
// historical deposit says nothing about a future payment's basis.

eq('P1 a DERIVED amount has UNKNOWN basis', vec.assertable && vec.basis, AmountBasis.UNKNOWN);
eq('P2 and no basis provenance, because nobody established one',
  vec.assertable && vec.basisProvenance, null);
eq('P3 the Abacus derivation likewise', [aba.assertable && aba.basis, aba.assertable && aba.basisProvenance],
  [AmountBasis.UNKNOWN, null]);
eq('P4 asserting an AMOUNT does not assert a BASIS',
  [userSays.basis, userSays.basisProvenance], [AmountBasis.UNKNOWN, null]);

const takeHome = assertedAmountBasis(userSays, AmountBasis.NET, AS_OF);
eq('P5 asserting the basis establishes NET', takeHome.basis, AmountBasis.NET);
eq('P6 with USER_ASSERTED basis provenance', takeHome.basisProvenance, EventProvenance.USER_ASSERTED);
eq('P7 the amount and its provenance are untouched',
  [takeHome.value, takeHome.provenance], [userSays.value, userSays.provenance]);
check('P8 and the derived evidence still travels', takeHome.verdicts.length === userSays.verdicts.length);
check('P9 the reason records the second assertion', /take-home \(net of deductions\)/.test(takeHome.reason),
  takeHome.reason);

// §9's mixed case — the user confirms a figure they did not restate.
const confirmed = vec.assertable ? assertedAmountBasis(vec, AmountBasis.NET, AS_OF) : null;
eq('P10 a DERIVED amount can carry a USER_ASSERTED basis',
  confirmed && [confirmed.provenance, confirmed.basisProvenance],
  [EventProvenance.DERIVED, EventProvenance.USER_ASSERTED]);
eq('P11 without restating the number', confirmed?.value, vec.assertable ? vec.value : null);
check('P12 which is why basis provenance is a separate field — one value could not say this',
  confirmed !== null && confirmed.provenance !== confirmed.basisProvenance);

const grossed = assertedAmountBasis(userSays, AmountBasis.GROSS, AS_OF);
eq('P13 GROSS is assertable too, and stays GROSS', grossed.basis, AmountBasis.GROSS);
check('P14 UNKNOWN is not in the assertion signature — "I do not know" establishes nothing',
  /basis: typeof AmountBasis\.NET \| typeof AmountBasis\.GROSS,/.test(src));
check('P15 nothing DERIVES a basis — assertedAmountBasis is its only producer',
  (code.match(/basisProvenance: EventProvenance\.\w+/g) ?? [])
    .every((m) => m === 'basisProvenance: EventProvenance.USER_ASSERTED')
  && (code.match(/basis: AmountBasis\.(NET|GROSS)/g) ?? []).length === 0);
check('P16 the invariant holds: a basis has a provenance exactly when it is established',
  [vec, aba, userSays, takeHome, grossed, confirmed].every((a) =>
    a === null || !a.assertable
    || ((a.basis === AmountBasis.UNKNOWN) === (a.basisProvenance === null))));

// EVENT / STATE PARITY — the defect was the same fact arriving as two answers.
const netEvents = periodicCashEvents(vecAct, vecCad, takeHome, AS_OF, '2026-09-30', FlowRole.INCOME);
eq('P17 an asserted NET amount reaches the event layer as NET', netEvents[0].amount!.basis, AmountBasis.NET);
check('P18 so FORECAST-3 licenses it as spendable cash', netCashContribution(netEvents[0]).assertable);
eq('P19 while a DERIVED amount still reaches it as UNKNOWN',
  periodicCashEvents(vecAct, vecCad, vec, AS_OF, '2026-09-30', FlowRole.INCOME)[0].amount!.basis,
  AmountBasis.UNKNOWN);
eq('P20 and a GROSS assertion is still not spendable', netCashContribution(
  periodicCashEvents(vecAct, vecCad, grossed, AS_OF, '2026-09-30', FlowRole.INCOME)[0]).assertable, false);
check('P21 the activity licence still outranks everything — a NET amount on a dead stream is no events',
  periodicCashEvents(abaAct, abaCad, assertedAmountBasis(
    aba.assertable ? aba : takeHome, AmountBasis.NET, AS_OF), AS_OF, '2026-12-31', FlowRole.INCOME)
    .length === 0);

// ═══════════════════════════════════════════════════════════════════════════
// Q. MUTATION — break the no-automatic-NET invariant on purpose
// ═══════════════════════════════════════════════════════════════════════════

const MUTANT = join(__dirname, '__periodic_mutant__.ts');
const cleanup = () => { if (existsSync(MUTANT)) unlinkSync(MUTANT); };
process.on('exit', cleanup);
let seq = 0;
async function mutate(
  name: string, find: string, replace: string,
  assertion: (m: typeof import('./periodic-amount')) => boolean,
): Promise<void> {
  if (!src.includes(find)) { check(`${name} [anchor]`, false, `anchor not found: ${find}`); return; }
  writeFileSync(MUTANT, src.replace(find, replace), 'utf8');
  try {
    const m = await import(`./__periodic_mutant__?v=${++seq}`) as typeof import('./periodic-amount');
    let survived: boolean;
    try { survived = assertion(m); } catch { survived = false; }
    check(name, !survived, 'the mutant passed — the test does not actually pin this');
  } finally { cleanup(); }
}

async function mutations(): Promise<void> {
  // Derived payroll silently becomes take-home pay.
  await mutate('Q1 a derived amount promoted to NET is caught',
    `    basis: AmountBasis.UNKNOWN, basisProvenance: null,
    regimeStartISO, observationCount: included.length, spread, verdicts,`,
    `    basis: AmountBasis.NET, basisProvenance: EventProvenance.DERIVED,
    regimeStartISO, observationCount: included.length, spread, verdicts,`,
    (m) => {
      const d = m.deriveCurrentPeriodicAmount(obs(VECTRUS), vecCad);
      return d.assertable && d.basis === AmountBasis.UNKNOWN && d.basisProvenance === null;
    });

  // The composition seam flattens an established basis again — the FORECAST-8
  // defect exactly: NET on the event, UNKNOWN in the state, or the reverse.
  await mutate('Q2 the event seam discarding an asserted basis is caught',
    '        basis: amount.basis,',
    '        basis: AmountBasis.UNKNOWN,',
    (m) => m.periodicCashEvents(vecAct, vecCad,
      m.assertedAmountBasis(m.assertedPeriodicAmount(5250, 'USD', AS_OF), AmountBasis.NET, AS_OF),
      AS_OF, '2026-09-30', FlowRole.INCOME)[0].amount!.basis === AmountBasis.NET);

  // An amount assertion quietly granting a basis it was never given.
  await mutate('Q3 an amount assertion granting itself a basis is caught',
    `    basis: AmountBasis.UNKNOWN, basisProvenance: null,
    regimeStartISO: asOfISO,`,
    `    basis: AmountBasis.NET, basisProvenance: EventProvenance.USER_ASSERTED,
    regimeStartISO: asOfISO,`,
    (m) => m.assertedPeriodicAmount(5250, 'USD', AS_OF).basis === AmountBasis.UNKNOWN);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void mutations();

