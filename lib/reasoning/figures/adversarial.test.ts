/**
 * lib/reasoning/figures/adversarial.test.ts
 *
 * V26-REASONING BLOCKER PASS — THE ATTACKS, AND THE PROPERTIES.
 *
 * ⚠️ EVERY CASE IN SECTION A IS A DEFECT THAT SHIPPED. None of them was found by
 * reading; all of them were found by executing the parser against sentences a
 * person would actually type. They are kept here as the regression floor: if one
 * of these ever passes again, a number the user never wrote has become licensed.
 *
 * Sections B–H are the property sweep the post-implementation audit asked for —
 * sign, magnitude boundaries, commas and decimals, rate versus stock, premise
 * versus measure, equal values at different addresses, and emptiness.
 */

import {
  FigureKind, FigureUnit, FigureHorizon, FigureRole, Standing,
  statedAsRendersUnit, renderFigure,
  type FigureTable, type LicensedFigure, type FigureUnitName,
} from './types';
import { scaleOf, trailingScale } from './magnitude';
import { premiseFigures } from './premise';
import { verifyAnswer, valueOf } from '../verify/verify';
import type { Answer, Claim } from '../answer/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const fig = (o: Partial<LicensedFigure> & { fid: string; value: number }): LicensedFigure => ({
  kind: FigureKind.MEASURE, unit: FigureUnit.CURRENCY, currency: 'USD',
  label: 'a figure', horizon: FigureHorizon.CURRENT, standing: Standing.MEASURED,
  role: FigureRole.CASH, ...o,
});
const table = (figures: LicensedFigure[], withheld: FigureTable['withheld'] = []): FigureTable =>
  ({ figures, withheld });
const claim = (fid: string, statedAs: string, frame: 'FACT' | 'ASSUMPTION' = 'FACT'): Claim =>
  ({ fid, statedAs, frame });
const answer = (claims: Claim[], prose: string, withheld: string | null = null): Answer =>
  ({ claims, prose, withheld });

const premise1 = (text: string) => premiseFigures([{ role: 'user', content: text }])[0];

// ═══════════════════════════════════════════════════════════════════════════
// A. THE MAGNITUDE BOUNDARY — letters that begin the next word are not suffixes
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `([kKmM])?` WITH NO RIGHT-HAND BOUNDARY READ THE `m` OF THE FOLLOWING WORD.
// "I spend $5,000 monthly" minted a licensed PREMISE of $5,000,000,000 — and,
// because the `m` had already been eaten, the rate window opened at "onthly."
// and the figure was ALSO downgraded from CURRENCY_PER_MONTH to CURRENCY. A
// million-fold corruption and the loss of the only axis that structurally holds,
// in one of the most ordinary sentences a person can type.
//
// The rule is positional, not lexical: there is no `monthly` exception and no
// `mortgage` exception. A letter scales a number only when NO LETTER FOLLOWS IT.

const MAGNITUDE: [string, number, FigureUnitName][] = [
  // The two that shipped broken.
  ['I spend $5,000 monthly.',        5_000,      FigureUnit.CURRENCY_PER_MONTH],
  ['I pay $1,200 mortgage',          1_200,      FigureUnit.CURRENCY],
  // The suffix forms that must still scale.
  ['assume I spend $6K/month',       6_000,      FigureUnit.CURRENCY_PER_MONTH],
  ['assume $7.5k per month',         7_500,      FigureUnit.CURRENCY_PER_MONTH],
  ['I got $2m',                      2_000_000,  FigureUnit.CURRENCY],
  ['I have $50 million',             50_000_000, FigureUnit.CURRENCY],
  ['I got $2 million',               2_000_000,  FigureUnit.CURRENCY],
  ['assume I spend $4,250 a month',  4_250,      FigureUnit.CURRENCY_PER_MONTH],
  // Words beginning with a suffix letter, in every position that could bite.
  ['I spend $900 max',               900,        FigureUnit.CURRENCY],
  ['I keep $3,000 minimum',          3_000,      FigureUnit.CURRENCY],
  ['I paid $250 maintenance',        250,        FigureUnit.CURRENCY],
  ['I owe $75 monthly on it',        75,         FigureUnit.CURRENCY_PER_MONTH],
  ['I put $400 kids savings',        400,        FigureUnit.CURRENCY],
  ['I get $80 kickback',             80,         FigureUnit.CURRENCY],
  ['I saved $1,000 more',            1_000,      FigureUnit.CURRENCY],
  // Word magnitudes, and a rate on top of one.
  ['I have $1.5 billion',            1_500_000_000, FigureUnit.CURRENCY],
  ['I earn $2 thousand a month',     2_000,      FigureUnit.CURRENCY_PER_MONTH],
  ['I earn $12,000 annually',        12_000,     FigureUnit.CURRENCY_PER_YEAR],
];
for (const [text, value, unit] of MAGNITUDE) {
  const p = premise1(text);
  eq(`A ${JSON.stringify(text)}`, [p?.value, p?.unit], [value, unit]);
}

// ⚠️ NO LETTER MAY BE CONSUMED FROM A FOLLOWING WORD — as a property, over the
// whole alphabet, rather than as the two words that happened to be found.
check('A-prop no word-initial letter is ever eaten as a magnitude', (() => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (const c of alphabet) {
    const word = `${c}oremipsum`;
    const p = premise1(`I spend $1,234 ${word}`);
    if (!p || p.value !== 1_234) return false;
  }
  return true;
})());

// ⚠️ AND THE SAME GRAMMAR GOVERNS EVERY PARSER. Four separate patterns carried
// this hole; a fifth written next year gets the boundary from one place.
eq('A-shared scaleOf reads the letter form',  scaleOf('k', undefined), 1_000);
eq('A-shared scaleOf reads the word form',    scaleOf(undefined, 'million'), 1_000_000);
eq('A-shared scaleOf defaults to 1',          scaleOf(undefined, undefined), 1);
eq('A-shared trailingScale ignores a word that merely starts with m',
  trailingScale(' monthly'), 1);
eq('A-shared trailingScale reads a lone m',   trailingScale('m'), 1_000_000);

// The verifier's own claim parser had the identical hole, in both directions.
eq('A-verify valueOf("$5,000 monthly")',  valueOf('$5,000 monthly'), 5_000);
eq('A-verify valueOf("$1,200 mortgage")', valueOf('$1,200 mortgage'), 1_200);
eq('A-verify valueOf("$50 million")',     valueOf('$50 million'), 50_000_000);
eq('A-verify valueOf("$6K")',             valueOf('$6K'), 6_000);
eq('A-verify valueOf("$2m")',             valueOf('$2m'), 2_000_000);

// ⚠️ AND THE SWEEP MUST TOKENISE WHAT THE MODEL ACTUALLY WRITES. With the greedy
// suffix, correct prose "You spend $5,000.00 monthly." tokenised as
// `$5,000.00 m`, matched nothing, and DISCARDED A GOOD ANSWER on every sentence
// containing the word "monthly".
const RATE = table([fig({ fid: 'f01', value: 5_000, unit: FigureUnit.CURRENCY_PER_MONTH,
  role: FigureRole.RATE })]);
for (const spelling of ['$5,000.00 monthly', '$5,000.00/month', '$5,000.00 a month',
  '$5,000.00 per month', '$5,000.00 each month']) {
  check(`A-sweep ${JSON.stringify(spelling)} verifies against its own prose`,
    verifyAnswer(answer([claim('f01', spelling)], `You spend ${spelling}.`), RATE).ok);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. SIGN — an overdraft is not a surplus
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `sameValue` ACCEPTED `q(parsed) === q(Math.abs(f.value))`. A licensed
// figure of −$4,000 verified against prose reading "$4,000.00" — a projected
// overdraft narrated as a surplus, the worst output this product can produce.
// It was not even a convenience: `renderFigure` emitted the malformed
// `$-4,000.00`, the sweep rejected the natural `-$4,000.00`, and so the ONLY
// renderings that verified were the malformed one and the WRONG one.

eq('B1 a negative renders with the sign outside the symbol',
  renderFigure(-4_000, FigureUnit.CURRENCY, 'USD'), '-$4,000.00');
eq('B2 a positive is unchanged',
  renderFigure(4_000, FigureUnit.CURRENCY, 'USD'), '$4,000.00');

const NEG = table([fig({ fid: 'f01', value: -4_000 })]);
const POS = table([fig({ fid: 'f01', value: 4_000 })]);
const signCase = (t: FigureTable, stated: string) =>
  verifyAnswer(answer([claim('f01', stated)], `You will have ${stated}.`), t);

check('B3 licensed -4000 PASSES on "-$4,000.00"', signCase(NEG, '-$4,000.00').ok);
check('B4 licensed -4000 FAILS on "$4,000.00"',
  signCase(NEG, '$4,000.00').failures.some((f) => f.kind === 'VALUE_MISMATCH'));
check('B5 licensed +4000 PASSES on "$4,000.00"', signCase(POS, '$4,000.00').ok);
check('B6 licensed +4000 FAILS on "-$4,000.00"',
  signCase(POS, '-$4,000.00').failures.some((f) => f.kind === 'VALUE_MISMATCH'));

// Negative rates and percentages are real: a monthly net and a savings rate can
// both be below zero, and both are exactly the figures a person must not misread.
const NEG_RATE = table([fig({ fid: 'f01', value: -1_250, unit: FigureUnit.CURRENCY_PER_MONTH,
  role: FigureRole.RATE })]);
check('B7 a negative RATE passes signed and fails unsigned',
  verifyAnswer(answer([claim('f01', '-$1,250.00/month')], 'You are -$1,250.00/month.'), NEG_RATE).ok
  && !verifyAnswer(answer([claim('f01', '$1,250.00/month')], 'You are $1,250.00/month.'), NEG_RATE).ok);
const NEG_PCT = table([fig({ fid: 'f01', value: -12.5, unit: FigureUnit.PERCENT, currency: undefined })]);
check('B8 a negative PERCENT passes signed and fails unsigned',
  verifyAnswer(answer([claim('f01', '-12.5%')], 'Your rate is -12.5%.'), NEG_PCT).ok
  && !verifyAnswer(answer([claim('f01', '12.5%')], 'Your rate is 12.5%.'), NEG_PCT).ok);

// ⚠️ NO ABSOLUTE-VALUE EQUIVALENCE ANYWHERE. The clause is gone, not relocated.
check('B9 the verifier contains no Math.abs equivalence', (() => {
  const { readFileSync } = require('fs') as typeof import('fs');
  const src = readFileSync(`${process.cwd()}/lib/reasoning/verify/verify.ts`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return !/Math\.abs/.test(src);
})());

// ═══════════════════════════════════════════════════════════════════════════
// C. PREMISE IS NOT MEASURE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `verifyAnswer` NEVER READ `kind`. Prose "You have $50,000.00 saved." citing
// the user's own supposition verified clean — the audit sentence `premise.ts`
// quotes as the hole it closes, open for stocks the whole time. The unit axis
// cannot reach it: a supposed $50,000 and a measured $50,000 render identically.

const SAVED = table([fig({ fid: 'p01', value: 50_000, kind: FigureKind.PREMISE,
  standing: Standing.ASSUMPTION_DEPENDENT, role: FigureRole.STATED_NOT_CASH,
  label: 'your own words: "Assume I have $50,000 saved."' })]);

check('C1 a PREMISE asserted as FACT is rejected',
  verifyAnswer(answer([claim('p01', '$50,000.00', 'FACT')],
    'You have $50,000.00 saved.'), SAVED)
    .failures.some((f) => f.kind === 'PREMISE_AS_FACT'));

// ⚠️ AND LEGITIMATE PREMISE USE STILL WORKS. A boundary that forbade premises
// entirely would pass C1 and be a worse product: the user's own number must
// remain quotable back to them.
for (const prose of [
  'Assuming $50,000.00, you would be in good shape.',
  'If we use your $50,000.00 assumption, the picture changes.',
  'Under that scenario — $50,000.00 — the answer differs.',
]) {
  check(`C2 ${JSON.stringify(prose.slice(0, 34))}… is allowed as an ASSUMPTION`,
    verifyAnswer(answer([claim('p01', '$50,000.00', 'ASSUMPTION')], prose), SAVED).ok);
}

// A MEASURE may be framed either way — a measured figure inside a scenario
// sentence is ordinary and correct.
const MEASURED = table([fig({ fid: 'f01', value: 50_000 })]);
check('C3 a MEASURE may be stated as FACT',
  verifyAnswer(answer([claim('f01', '$50,000.00', 'FACT')], 'You have $50,000.00.'), MEASURED).ok);
check('C4 and a MEASURE may also be used inside an assumption',
  verifyAnswer(answer([claim('f01', '$50,000.00', 'ASSUMPTION')],
    'Assuming your $50,000.00 holds, …'), MEASURED).ok);

// ⚠️ SAME NUMBER, TWO ADDRESSES, DIFFERENT AUTHORITY. The whole point of the
// axis: value equality is not identity.
const BOTH = table([
  fig({ fid: 'f01', value: 50_000, label: 'measured savings' }),
  fig({ fid: 'p01', value: 50_000, kind: FigureKind.PREMISE, role: FigureRole.STATED_NOT_CASH,
    standing: Standing.ASSUMPTION_DEPENDENT, label: 'your own words' }),
]);
check('C5 the same value is assertable at one address and not the other',
  verifyAnswer(answer([claim('f01', '$50,000.00', 'FACT')], 'You have $50,000.00.'), BOTH).ok
  && !verifyAnswer(answer([claim('p01', '$50,000.00', 'FACT')], 'You have $50,000.00.'), BOTH).ok);

// ⚠️ NOT SOLVED WITH A PHRASE LIST. If it were, the fix would be a regex over
// prose — which is the thing this whole layer exists to stop doing.
check('C6 the premise rule reads no prose and lists no English phrases', (() => {
  const { readFileSync } = require('fs') as typeof import('fs');
  const src = readFileSync(`${process.cwd()}/lib/reasoning/verify/verify.ts`, 'utf8');
  const rule = src.slice(src.indexOf('PREMISE_AS_FACT'), src.indexOf('statedAsRendersUnit(c.statedAs'));
  return !/answer\.prose/.test(rule) && !/assum(?:e|ing)['"]/i.test(rule);
})());

// ═══════════════════════════════════════════════════════════════════════════
// D. ANTI-VACUITY — silence is not an escape
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `{ claims: [], prose: "You are on track and can comfortably afford it." }`
// VERIFIED CLEAN. No figure token for the sweep to catch, no claim for the
// identity check to check. `provider.ts` asserted `strict: true` made this
// "unrepresentable at the provider" — it does not; `strict` forbids missing and
// extra properties, not empty arrays.

const RICH = table(
  [fig({ fid: 'f01', value: 10_228.74 })],
  [{ subject: 'months of coverage', code: 'INSUFFICIENT_EVIDENCE',
    detail: 'no complete month of spending is available to average' }],
);

check('D1 a confident conclusion with no claims is VACUOUS',
  verifyAnswer(answer([], 'You are on track and can comfortably afford it.'), RICH)
    .failures.some((f) => f.kind === 'VACUOUS'));

// ⚠️ AND NOT EVERY GOOD ANSWER HAS A FIGURE. A refusal is a legitimate answer,
// so the rule is not "state a number" — it is "if you state none, name the
// withholding you are speaking to", checked by identity like everything else.
check('D2 a refusal citing a real withheld subject is allowed',
  verifyAnswer(answer([], "I can't give you months of coverage — no complete month "
    + 'of spending is available to average.', 'months of coverage'), RICH).ok);

check('D3 citing a withholding that does not exist is still VACUOUS',
  verifyAnswer(answer([], 'I cannot say.', 'something I made up'), RICH)
    .failures.some((f) => f.kind === 'VACUOUS'));

// With nothing licensed at all there is nothing to state and nothing to withhold.
check('D4 an empty table permits an answer with no claims',
  verifyAnswer(answer([], 'I do not have your data assembled yet.'), table([])).ok);

check('D5 stating a figure needs no withheld subject',
  verifyAnswer(answer([claim('f01', '$10,228.74')], 'You have $10,228.74.'), RICH).ok);

// ⚠️ NO SENTIMENT CLASSIFIER. The rule is structural; it never reads the prose.
check('D6 the anti-vacuity rule inspects claims and the table, never the prose', (() => {
  const { readFileSync } = require('fs') as typeof import('fs');
  const src = readFileSync(`${process.cwd()}/lib/reasoning/verify/verify.ts`, 'utf8');
  const rule = src.slice(src.indexOf('Anti-vacuity'), src.indexOf('The sweep: no other escape'));
  return !/answer\.prose/.test(rule);
})());

// ═══════════════════════════════════════════════════════════════════════════
// E. COMMAS, DECIMALS, AND MULTIPLE NUMBERS
// ═══════════════════════════════════════════════════════════════════════════

eq('E1 commas are separators, not digits', valueOf('$1,234,567.89'), 1_234_567.89);
eq('E2 a bare decimal parses',             valueOf('4.2'), 4.2);
eq('E3 markdown is presentation',          valueOf('**$4.20**'), 4.2);
// ⚠️ "$5,000 x 3 = $15,000" MUST NOT VERIFY AGAINST ITS FIRST NUMBER.
eq('E4 two numbers in one rendering parse to nothing', valueOf('$5,000 x 3 = $15,000'), null);
eq('E5 no number parses to nothing', valueOf('several thousand'), null);

// The half-cent the whole rounding edge exists for.
const HALF = fig({ fid: 'f01', value: 5_286.645 * 7 });
check('E6 the canonical rendering of a half-cent verifies',
  verifyAnswer(answer([claim('f01', renderFigure(HALF.value, HALF.unit, 'USD'))],
    `They total ${renderFigure(HALF.value, HALF.unit, 'USD')}.`), table([HALF])).ok);

// ═══════════════════════════════════════════════════════════════════════════
// F. UNITS — rate, stock, months, percent
// ═══════════════════════════════════════════════════════════════════════════

check('F1 every monthly spelling renders the rate unit',
  ['$5,000/month', '$5,000 a month', '$5,000 per month', '$5,000 monthly', '$5,000 each month']
    .every((s) => statedAsRendersUnit(s, FigureUnit.CURRENCY_PER_MONTH)));
check('F2 and none of them satisfies CURRENCY',
  ['$5,000/month', '$5,000 a month', '$5,000 monthly']
    .every((s) => !statedAsRendersUnit(s, FigureUnit.CURRENCY)));
check('F3 a stock may not be dressed as a rate',
  !statedAsRendersUnit('$10,228.74/month', FigureUnit.CURRENCY));
check('F4 months and percent each require their own marker',
  statedAsRendersUnit('4.2 months', FigureUnit.MONTHS)
  && !statedAsRendersUnit('4.2', FigureUnit.MONTHS)
  && statedAsRendersUnit('12.5%', FigureUnit.PERCENT)
  && !statedAsRendersUnit('12.5', FigureUnit.PERCENT));
// ⚠️ A YEARLY RATE IS NOT A MONTHLY ONE. Twelve times the difference.
check('F5 per-year and per-month are not interchangeable',
  statedAsRendersUnit('$60,000/year', FigureUnit.CURRENCY_PER_YEAR)
  && !statedAsRendersUnit('$60,000/year', FigureUnit.CURRENCY_PER_MONTH)
  && !statedAsRendersUnit('$5,000/month', FigureUnit.CURRENCY_PER_YEAR));

// ═══════════════════════════════════════════════════════════════════════════
// G. EQUAL VALUES AT DIFFERENT ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════
//
// Two figures may legitimately hold the same number. The sweep matches on
// rendering, so one claim covers both occurrences — what must NOT happen is a
// claim verifying against a figure whose UNIT or SIGN differs.

const TWINS = table([
  fig({ fid: 'f01', value: 5_000, label: 'a stock' }),
  fig({ fid: 'f02', value: 5_000, unit: FigureUnit.CURRENCY_PER_MONTH,
    role: FigureRole.RATE, label: 'a rate' }),
]);
check('G1 the stock address accepts the stock rendering',
  verifyAnswer(answer([claim('f01', '$5,000.00')], 'You have $5,000.00.'), TWINS).ok);
check('G2 the rate address accepts the rate rendering',
  verifyAnswer(answer([claim('f02', '$5,000.00/month')], 'You spend $5,000.00/month.'), TWINS).ok);
check('G3 the rate address REJECTS the stock rendering, though the values match',
  verifyAnswer(answer([claim('f02', '$5,000.00')], 'You have $5,000.00.'), TWINS)
    .failures.some((f) => f.kind === 'UNIT_NOT_RENDERED'));
check('G4 a figure repeated in prose needs only its one claim',
  verifyAnswer(answer([claim('f01', '$5,000.00')],
    'You have $5,000.00 — and $5,000.00 is enough.'), TWINS).ok);

// ═══════════════════════════════════════════════════════════════════════════
// H. IDENTITY — an address that does not exist licenses nothing
// ═══════════════════════════════════════════════════════════════════════════

check('H1 an unknown fid is a finding',
  verifyAnswer(answer([claim('f99', '$1.00')], 'It is $1.00.'), TWINS)
    .failures.some((f) => f.kind === 'UNKNOWN_FID'));
check('H2 an arithmetic product of two licensed figures has no address',
  verifyAnswer(answer([], 'That totals $10,000.00 over two months.'), TWINS)
    .failures.some((f) => f.kind === 'UNCLAIMED_FIGURE'));
check('H3 a value that does not match its address is a finding',
  verifyAnswer(answer([claim('f01', '$5,000.01')], 'You have $5,000.01.'), TWINS)
    .failures.some((f) => f.kind === 'VALUE_MISMATCH'));

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
