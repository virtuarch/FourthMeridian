/**
 * lib/reasoning/answer-boundary.test.ts
 *
 * V26-REASONING Slice 1 — THE BOUNDARY'S STRUCTURAL INVARIANTS, GATED.
 *
 * ⚠️ THIS IS THE GATE; `scripts/check-answer-boundary.ts` IS THE MEASUREMENT.
 * The plan asked for the boundary to be a REQUIRED-tier audit, and the harness
 * that exercises it end to end calls a paid stochastic model — which this
 * repository has three times decided must never be a CI gate ("a paid
 * stochastic model in CI buys flakiness with money"). Both are honoured by
 * splitting them: everything that can be asserted without a model call is
 * asserted here, in the suite that actually runs on every change, and the model
 * measurement stays an OPERATIONAL tool.
 *
 * What is gated here is the whole safety argument:
 *
 *   - a figure with no address cannot be claimed;
 *   - a rate cannot be claimed as a stock;
 *   - a value cannot be claimed at a value it does not have;
 *   - a figure in the prose that no claim accounts for is a finding;
 *   - the table, the fallback and the verifier round in ONE place;
 *   - the typed path bypasses the three prose guards, deliberately;
 *   - the flag is registered.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  FigureKind, FigureUnit, FigureHorizon, FigureRole, Standing,
  statedAsRendersUnit, renderFigure,
  type FigureTable, type LicensedFigure,
} from './figures/types';
import { premiseFigures } from './figures/premise';
import { verifyAnswer, valueOf } from './verify/verify';
import { deterministicFallback } from './answer/generate';
import { renderFigureTable } from './render';
import { resolveAnswerMode } from './answer/for-request';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const fig = (o: Partial<LicensedFigure> & { fid: string; value: number }): LicensedFigure => ({
  kind: FigureKind.MEASURE, unit: FigureUnit.CURRENCY, currency: 'USD',
  label: 'a figure', horizon: FigureHorizon.CURRENT, standing: Standing.MEASURED,
  role: FigureRole.CASH, ...o,
});
const table = (figures: LicensedFigure[]): FigureTable => ({ figures, withheld: [] });

// ═══════════════════════════════════════════════════════════════════════════
// A. IDENTITY — a number with no address cannot be written
// ═══════════════════════════════════════════════════════════════════════════

const T = table([
  fig({ fid: 'f01', value: 10228.74, label: 'current liquid cash' }),
  fig({ fid: 'p01', value: 5000, kind: FigureKind.PREMISE,
    unit: FigureUnit.CURRENCY_PER_MONTH, role: FigureRole.RATE,
    standing: Standing.ASSUMPTION_DEPENDENT, basis: 'assume I spend $5,000/month' }),
  fig({ fid: 'f02', value: 4.2, unit: FigureUnit.MONTHS, currency: undefined,
    label: 'months of coverage' }),
]);

check('A1 a claim citing an unknown address is a finding',
  verifyAnswer({ claims: [{ fid: 'f99', statedAs: '$1.00' }], prose: 'It is $1.00.' }, T)
    .failures.some((f) => f.kind === 'UNKNOWN_FID'));

check('A2 a figure in the prose that no claim accounts for is a finding',
  verifyAnswer({ claims: [], prose: 'You will have $30,000 left.' }, T)
    .failures.some((f) => f.kind === 'UNCLAIMED_FIGURE'));

check('A3 a claim at a value the figure does not have is a finding',
  verifyAnswer({ claims: [{ fid: 'f01', statedAs: '$10,228.75' }], prose: 'You have $10,228.75.' }, T)
    .failures.some((f) => f.kind === 'VALUE_MISMATCH'));

check('A4 a correctly addressed figure verifies',
  verifyAnswer({ claims: [{ fid: 'f01', statedAs: '$10,228.74' }],
    prose: 'You have $10,228.74 in liquid cash.' }, T).ok);

// ⚠️ THE PRODUCT THE MODEL WANTS TO WRITE. $5,000 x 3 is the failure family this
// whole slice exists to close, and it closes because 15000 is not in the table.
check('A5 an arithmetic product of licensed figures has no address',
  verifyAnswer({ claims: [], prose: 'That totals $15,000 over three months.' }, T)
    .failures.some((f) => f.kind === 'UNCLAIMED_FIGURE'));

// ═══════════════════════════════════════════════════════════════════════════
// B. THE PREMISE LEAK — the axis the plan is on trial for
// ═══════════════════════════════════════════════════════════════════════════

check('B1 a monthly rate may be restated as a rate',
  verifyAnswer({ claims: [{ fid: 'p01', statedAs: '$5,000/month' }],
    prose: 'At $5,000/month, that changes things.' }, T).ok);

check('B2 the same rate may NOT be claimed as a bare stock',
  verifyAnswer({ claims: [{ fid: 'p01', statedAs: '$5,000' }],
    prose: 'Your projected savings will be $5,000.' }, T)
    .failures.some((f) => f.kind === 'UNIT_NOT_RENDERED'));

check('B3 and writing it as a stock without claiming it is caught by the sweep',
  verifyAnswer({ claims: [], prose: 'Your ending debt will be $5,000.' }, T)
    .failures.some((f) => f.kind === 'UNCLAIMED_FIGURE'));

// ⚠️ AND THE OTHER DIRECTION, WHICH MATTERS JUST AS MUCH. A boundary that simply
// suppressed the number would pass B2 and B3 and be a worse product: the user's
// own premise must remain sayable back to them.
check('B4 a stock may NOT be dressed as a rate either',
  verifyAnswer({ claims: [{ fid: 'f01', statedAs: '$10,228.74/month' }],
    prose: 'You have $10,228.74/month.' }, T)
    .failures.some((f) => f.kind === 'UNIT_NOT_RENDERED'));

check('B5 the several spellings of a monthly rate all render the unit',
  ['$5,000/month', '$5,000 a month', '$5,000 per month', '$5,000 monthly']
    .every((s) => statedAsRendersUnit(s, FigureUnit.CURRENCY_PER_MONTH)));
check('B6 and none of them satisfies CURRENCY',
  ['$5,000/month', '$5,000 a month', '$5,000 per month', '$5,000 monthly']
    .every((s) => !statedAsRendersUnit(s, FigureUnit.CURRENCY)));

// ═══════════════════════════════════════════════════════════════════════════
// C. PREMISE EXTRACTION — the user's numbers get addresses and dimensions
// ═══════════════════════════════════════════════════════════════════════════

const P = premiseFigures([
  { role: 'user', content: 'Assume I spend $5,000/month.' },
  { role: 'assistant', content: 'Your projection is $34,035.64.' },
  { role: 'user', content: 'I also have $50,000 saved and a 7% return.' },
]);

eq('C1 every premise is a PREMISE', [...new Set(P.map((p) => p.kind))], ['PREMISE']);
check('C2 a rate is captured as a rate',
  P.some((p) => p.value === 5000 && p.unit === FigureUnit.CURRENCY_PER_MONTH));
check('C3 a bare amount stays a stock',
  P.some((p) => p.value === 50000 && p.unit === FigureUnit.CURRENCY));
check('C4 a percentage is captured as a percentage',
  P.some((p) => p.value === 7 && p.unit === FigureUnit.PERCENT));

// ⚠️ THE ASSISTANT'S OWN NUMBERS ARE NEVER PREMISES. PARITY-3 measured a
// net-worth follow-up rebuilding on a figure the assistant had itself invented,
// five times out of five, in BOTH entry modes. A number the model produced last
// turn is not evidence that it may produce it again.
check('C5 an assistant turn mints no premise',
  !P.some((p) => p.value === 34035.64), JSON.stringify(P.map((p) => p.value)));

check('C6 every premise carries the user\'s own words as its basis',
  P.every((p) => typeof p.basis === 'string' && p.basis.length > 0));
check('C7 no premise claims to be MEASURED',
  P.every((p) => p.standing === Standing.ASSUMPTION_DEPENDENT));

// ⚠️ THE DECIMAL POINT IS PART OF THE NUMBER. `statements.ts` records a measured
// failure where a character class stopped dead at the decimal in "$5,286.645",
// so a truthful assertion silently became no assertion. The same mistake is
// available here.
check('C8 a figure with a decimal is captured whole',
  premiseFigures([{ role: 'user', content: 'My paycheck is $5,286.645 take-home.' }])
    .some((p) => p.value === 5286.645));

// ═══════════════════════════════════════════════════════════════════════════
// D. ONE ROUNDING EDGE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ FOUND BY MEASUREMENT, AND IT WAS THIS BOUNDARY CONTRADICTING ITSELF. The
// table printed "$37,006.52" via toLocaleString for 7 x $5,286.645 = 37006.515,
// and the verifier accepted only "$37,006.51" via toFixed, because f64 holds
// that value as 37006.51499… So the model was SHOWN a number and REJECTED for
// writing it back, in two of seven cases. `renderFigure` is now the single edge.

const HALF_CENT = fig({ fid: 'f03', value: 5286.645 * 7, label: 'seven paychecks' });
const H = table([HALF_CENT]);
check('D1 the verifier accepts the exact string the table printed',
  verifyAnswer({ claims: [{ fid: 'f03', statedAs: renderFigure(HALF_CENT.value, HALF_CENT.unit, 'USD') }],
    prose: `They total ${renderFigure(HALF_CENT.value, HALF_CENT.unit, 'USD')}.` }, H).ok,
  renderFigure(HALF_CENT.value, HALF_CENT.unit, 'USD'));
check('D2 the rendered table and the deterministic fallback agree with it',
  renderFigureTable(H).includes(renderFigure(HALF_CENT.value, HALF_CENT.unit, 'USD'))
  && deterministicFallback(H).includes(renderFigure(HALF_CENT.value, HALF_CENT.unit, 'USD')));
check('D3 there is exactly ONE toFixed-and-print edge in the reasoning layer',
  ['lib/reasoning/render.ts', 'lib/reasoning/answer/generate.ts', 'lib/reasoning/verify/verify.ts']
    .every((f) => !/toLocaleString/.test(read(f))),
  'a second formatter is a second opinion about the half-cent');

// ═══════════════════════════════════════════════════════════════════════════
// E. STRUCTURE — no fifth guard, no prose reader, no escape hatch
// ═══════════════════════════════════════════════════════════════════════════

const VERIFY_SRC = read('lib/reasoning/verify/verify.ts');
const codeOnly = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('E1 the verifier reads no claim vocabulary and no hedge vocabulary',
  !/hedge|cashClaim|CASH_CLAIM|endingClaim|historical/i.test(codeOnly(VERIFY_SRC)),
  'the whole point is that the model says what it meant rather than being read');

// ⚠️ THE HOLE THAT ALREADY EXISTS ONCE. `output-validator.ts` reconciles against
// `collectSourceValues(systemPrompt, userMessages)` — any number anywhere in the
// conversation — and the audit recorded the consequence: "a user who types
// 'I have $50,000 saved' mints a licence the model can then assert as fact."
check('E2 there is no "any number the user typed" escape',
  !/userMessages|collectSourceValues|systemPrompt/.test(codeOnly(VERIFY_SRC)));

check('E3 the verifier reaches no database, no clock and no model',
  !/lib\/db|prisma|Date\.now\(\)|generateChat|openai/i.test(codeOnly(VERIFY_SRC)));

check('E4 no regex literal in the reasoning layer carries a non-ASCII letter',
  (() => {
    // ⚠️ MEASURED IN THIS VERY SLICE, TWICE. `numerical-guard.ts` carries a stray
    // CJK character inside its hedge vocabulary, and two regexes written here
    // acquired a Cyrillic look-alike before this check existed. A homoglyph in a
    // character class is invisible in review and silently never matches.
    // ⚠️ COMMENTS ARE STRIPPED FIRST, and the check needed that within an hour
    // of being written: a `// ⚠️ …"$5K/month"…` line contains two slashes and a
    // naive scanner reads the span between them as a regex literal. The
    // codebase's own structural tests all strip comments before scanning source,
    // for exactly this reason.
    const files = ['figures/types.ts', 'figures/premise.ts', 'verify/verify.ts', 'render.ts'];
    return files.every((f) => {
      const src = codeOnly(read(`lib/reasoning/${f}`));
      const literals = src.match(/\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g) ?? [];
      return literals.every((l) => [...l].every((ch) => ch.charCodeAt(0) < 128));
    });
  })());

// ═══════════════════════════════════════════════════════════════════════════
// F. THE FLAG, AND THE DELIBERATE BYPASS
// ═══════════════════════════════════════════════════════════════════════════

eq('F1 unset is prose — a new boundary never arrives silently on',
  resolveAnswerMode(undefined), 'prose');
eq('F2 and only the exact word turns it on', resolveAnswerMode('TYPED'), 'typed');
eq('F3 anything else is prose', resolveAnswerMode('yes'), 'prose');

check('F4 the flag is registered in lib/env.ts and .env.example',
  /AI_ANSWER_MODE:\s*process\.env\.AI_ANSWER_MODE/.test(read('lib/env.ts'))
  && /^AI_ANSWER_MODE=$/m.test(read('.env.example')));

// ⚠️ THE BYPASS IS THE DESIGN, NOT AN OVERSIGHT. All three prose guards exist to
// reconstruct from English what the model meant. Under `typed` the model says
// what it meant, so running them would not add a fourth opinion — it would add
// three chances to redact a licensed sentence, which is exactly the failure the
// Slice 0 baseline measured (three `repair`-only conformance failures, all of
// them the guard deleting a sentence that was licensed).
const ROUTE = read('app/api/ai/chat/route.ts');
check('F5 the typed path returns before the three prose guards run', (() => {
  // ⚠️ MEASURED FROM THE BRANCH, NOT FROM THE FILE. A first version of this
  // check used `indexOf` over the whole source and failed, because every one of
  // these names appears in the IMPORT BLOCK at the top — which is above the
  // branch and says nothing about execution order.
  //
  // The branch moved in Slice 5: `answerThisTurn` owns the whole typed path
  // (flags, planner seam, table, verifier, repair) because inlining it took the
  // route past the 700-line ceiling `route-authority.aiarch` enforces. What must
  // still be true is unchanged — a typed answer RETURNS before any prose guard
  // runs, and a prose answer still meets all three.
  const i = ROUTE.indexOf('if (typed) {');
  if (i < 0) return false;
  const after = ROUTE.slice(i);
  const branchEnd = after.indexOf('\n    }\n');
  const branch = after.slice(0, branchEnd);
  const rest = after.slice(branchEnd);
  return branch.includes('return NextResponse.json(')
    && !branch.includes('detectAssessmentContradiction(')
    && !branch.includes('guardForecastAnswer(')
    && !branch.includes('applyEnforcement(')
    && rest.includes('detectAssessmentContradiction(')
    && rest.includes('guardForecastAnswer(')
    && rest.includes('applyEnforcement(')
    // …and the typed path is REACHED before the prose call, not merely defined.
    && ROUTE.indexOf('await answerThisTurn(') < ROUTE.indexOf('await generateChatReply(systemPrompt');
})());

check('F6 and prose mode still runs all three',
  /detectAssessmentContradiction/.test(ROUTE) && /guardForecastAnswer\(/.test(ROUTE)
  && /applyEnforcement\(/.test(ROUTE));

// ═══════════════════════════════════════════════════════════════════════════
// G. THE FALLBACK IS NEVER EMPTY AND NEVER A PREMISE
// ═══════════════════════════════════════════════════════════════════════════

check('G1 the fallback states the measures', deterministicFallback(T).includes('$10,228.74'));
// ⚠️ QUOTING THE USER'S OWN NUMBER BACK IN A FALLBACK IS THE ONE SENTENCE MOST
// LIKELY TO READ AS A FINDING, and a fallback has no narration to frame it.
check('G2 and never the user\'s premises', !deterministicFallback(T).includes('5,000'));
check('G3 an empty table still produces an answer',
  deterministicFallback({ figures: [], withheld: [] }).length > 0);
check('G4 a withholding is spoken with its reason',
  deterministicFallback({ figures: [], withheld: [
    { subject: 'months of coverage', code: 'INSUFFICIENT_EVIDENCE',
      detail: 'no complete month of spending is available to average' }] })
    .includes('no complete month of spending'));

// ⚠️ AGGREGATE-ONLY, AND IT IS A SECURITY CONSTRAINT. A per-account refusal
// reading "blocked by permission" discloses that a hidden account exists —
// `accounts.ts` already reasons about exactly this for KnowledgeGaps.
check('G5 BLOCKED_BY_PERMISSION may never name a subject',
  (() => {
    const { refusalMayNameSubject } = require('./refusal') as
      { refusalMayNameSubject: (c: string) => boolean };
    return refusalMayNameSubject('BLOCKED_BY_PERMISSION') === false
      && refusalMayNameSubject('NO_EVIDENCE') === true;
  })());

// ═══════════════════════════════════════════════════════════════════════════
// H. `valueOf` — one number per rendering
// ═══════════════════════════════════════════════════════════════════════════

eq('H1 a single figure parses', valueOf('$10,228.74'), 10228.74);
// ⚠️ "$5,000 x 3 = $15,000" MUST NOT VERIFY AGAINST ITS FIRST NUMBER.
eq('H2 a rendering carrying two numbers parses to nothing', valueOf('$5,000 x 3 = $15,000'), null);
eq('H3 markdown emphasis is presentation', valueOf('**$4.20**'), 4.2);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
