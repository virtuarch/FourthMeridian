/**
 * lib/reasoning/measure/parity.test.ts
 *
 * V26-REASONING Slice 3 — PARITY, NOT NOVELTY.
 *
 * ⚠️ THE ACCEPTANCE FOR THIS SLICE IS THAT NOTHING CHANGED. Every measure is a
 * thin adapter over an authority this repository already ships and already
 * trusts, so each one is evaluated against the real production fixture and
 * asserted equal to what that authority produces today. A divergence is either
 * a bug in the adapter or a bug just discovered in the original — investigated,
 * never papered over.
 *
 * The fixture is the one the forecast corpus uses:
 *
 *     liquid cash    $10,228.74
 *     debt owed         $549.75
 *     investments     $5,006.56 traditional + $19,014.63 digital
 *     net worth      $33,700.17
 *     payroll         $5,286.645 biweekly, NET
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { FinanceDomains, type AccountsSectionData } from '@/lib/ai/types';
import { computeAssessment } from '@/lib/ai/intelligence';
import { assembleForecast } from '@/lib/ai/forecast/assemble';
import {
  realSpaceCtx, STREAMS, HORIZON, AS_OF,
} from '@/lib/ai/conformance/forecast-scenarios';
import {
  MeasureId, NOW, at, Standing, FigureUnit, FLAT,
  type Measure, type MeasureIdName,
} from './types';
import {
  evaluate, composeNetWorth, persistenceFallback, type MeasureContext,
} from './evaluate';
import { buildFigureTable } from '../figures/table';
import { buildTypedPromptSuffix } from '../answer/for-request';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown, detail?: string) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    detail ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name: string, actual: number, expected: number, tol = 0.005) =>
  check(name, Math.abs(actual - expected) < tol, `expected ~${expected}, got ${actual}`);

const valueOf = (m: Measure): number | null =>
  m.resolution.kind === 'VALUE' ? m.resolution.value : null;
const standingOf = (m: Measure) =>
  m.resolution.kind === 'VALUE' ? m.resolution.standing : 'UNRESOLVED';
const reasonsOf = (m: Measure) =>
  m.resolution.kind === 'UNRESOLVED' ? m.resolution.reasons : [];

// ── The fixture, and the authorities it produces ────────────────────────────

const ctx = realSpaceCtx();
const assessment = computeAssessment(ctx);
const forecast = assembleForecast({
  ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
  question: 'What will my cash look like over the next 3 months?',
});
const acc = ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
const C: MeasureContext = { ctx, assessment, forecast, currency: 'USD' };
const FUTURE = at(HORIZON.toISO);

// ═══════════════════════════════════════════════════════════════════════════
// A. PARITY AT NOW — every measure equals the authority that owns it
// ═══════════════════════════════════════════════════════════════════════════

eq('A1 liquid_cash@NOW is the accounts payload\'s own total',
  valueOf(evaluate(MeasureId.LIQUID_CASH, NOW, C)), acc.totalLiquid);
eq('A2 debt_balance@NOW likewise',
  valueOf(evaluate(MeasureId.DEBT_BALANCE, NOW, C)), acc.totalLiabilities);
eq('A3 investments_value@NOW likewise',
  valueOf(evaluate(MeasureId.INVESTMENTS_VALUE, NOW, C)), acc.totalInvestments);
eq('A4 digital_assets_value@NOW likewise',
  valueOf(evaluate(MeasureId.DIGITAL_ASSETS_VALUE, NOW, C)), acc.totalDigitalAssets);

// ⚠️ THE PAYLOAD'S OWN `netWorth`, NOT A SUM OF THE COMPONENTS. The accounts
// authority already decided what participates and how currency was converted;
// re-adding the parts here would be a second opinion about a number it already
// publishes — and this repository has a whole memory of what happens when two
// chains compute the same current value (W-M3a: withheld rendered as $0.00).
eq('A5 net_worth@NOW is the payload\'s figure, not a re-sum of the legs',
  valueOf(evaluate(MeasureId.NET_WORTH, NOW, C)), acc.netWorth);

eq('A6 monthly_spending@NOW is the assessment\'s figure',
  valueOf(evaluate(MeasureId.MONTHLY_SPENDING, NOW, C)),
  assessment.cashFlow.estimatedMonthlyExpenses);
eq('A7 monthly_income@NOW likewise',
  valueOf(evaluate(MeasureId.MONTHLY_INCOME, NOW, C)),
  assessment.cashFlow.impliedMonthlyIncome);
eq('A8 runway_months@NOW is the liquidity section\'s coverage',
  valueOf(evaluate(MeasureId.RUNWAY_MONTHS, NOW, C)),
  assessment.liquidity.coverageMonths);

check('A9 every present measure carries MEASURED or OBSERVED_CONTINUATION, never weaker',
  ([MeasureId.LIQUID_CASH, MeasureId.DEBT_BALANCE, MeasureId.NET_WORTH,
    MeasureId.MONTHLY_SPENDING, MeasureId.MONTHLY_INCOME] as MeasureIdName[])
    .map((id) => evaluate(id, NOW, C))
    .every((m) => m.resolution.kind !== 'VALUE'
      || m.resolution.standing === Standing.MEASURED
      || m.resolution.standing === Standing.OBSERVED_CONTINUATION));

// ═══════════════════════════════════════════════════════════════════════════
// B. A VALUE OR REASONS — never both, never neither
// ═══════════════════════════════════════════════════════════════════════════

const ALL: MeasureIdName[] = Object.values(MeasureId);
check('B1 every measure at NOW resolves to exactly one arm of the union',
  ALL.map((id) => evaluate(id, NOW, C)).every((m) =>
    (m.resolution.kind === 'VALUE' && Number.isFinite(m.resolution.value))
    || (m.resolution.kind === 'UNRESOLVED' && m.resolution.reasons.length > 0)));
check('B2 and every measure at a DATE does too',
  ALL.map((id) => evaluate(id, FUTURE, C)).every((m) =>
    (m.resolution.kind === 'VALUE' && Number.isFinite(m.resolution.value))
    || (m.resolution.kind === 'UNRESOLVED' && m.resolution.reasons.length > 0)));
check('B3 every refusal names what is missing, not merely that something is',
  ALL.flatMap((id) => [evaluate(id, NOW, C), evaluate(id, FUTURE, C)])
    .flatMap(reasonsOf).every((r) => r.detail.length > 20));

// ⚠️ AN EMPTY CONTEXT MUST REFUSE, NOT RETURN ZERO. This is the defect this
// repository has recorded more than any other — W6's `nativeBalance ?? 0`,
// W-M3a's NOT-NULL-DEFAULT-0 column, "unknown is not zero".
const EMPTY: MeasureContext = { currency: 'USD' };
check('B4 an empty context refuses every measure and returns no zeroes',
  ALL.map((id) => evaluate(id, NOW, EMPTY)).every((m) => m.resolution.kind === 'UNRESOLVED'));

// ═══════════════════════════════════════════════════════════════════════════
// C. THE FUTURE — the licensed path first, and a weaker one never overlays it
// ═══════════════════════════════════════════════════════════════════════════

const cashFuture = evaluate(MeasureId.LIQUID_CASH, FUTURE, C);
const fc = 'refused' in forecast.forecast ? null : forecast.forecast;

check('C1 liquid_cash@DATE is the forecast\'s own closing figure when it licensed one',
  fc === null || fc.fullCashPath.closing === null
  || valueOf(cashFuture) === fc.fullCashPath.closing,
  `${valueOf(cashFuture)} vs ${fc?.fullCashPath.closing}`);

// ⚠️ PROJECTION-3'S RULE, VERBATIM: "a licensed answer is never overlaid by a
// weaker one", and its inverse. The projection is read ONLY where the licensed
// path refused.
check('C2 the projection is consulted only where the licensed path REFUSED', (() => {
  const src = readFileSync(join(process.cwd(), 'lib/reasoning/measure/evaluate.ts'), 'utf8');
  const body = src.slice(src.indexOf('function cashAtDate'), src.indexOf('function standingOfStatus'));
  return body.indexOf('fullCashPath') < body.indexOf('f.projection');
})());

// ⚠️ RATES ARE NOT PROJECTED. "Monthly spending in December" is either the same
// observed rate — in which case saying it is ABOUT December implies evidence
// about December — or a user assumption, which arrives as a scenario delta.
eq('C3 a rate at a future date keeps its value and loses MEASURED standing',
  [valueOf(evaluate(MeasureId.MONTHLY_SPENDING, FUTURE, C)),
    standingOf(evaluate(MeasureId.MONTHLY_SPENDING, FUTURE, C))],
  [assessment.cashFlow.estimatedMonthlyExpenses, Standing.OBSERVED_CONTINUATION]);

// ═══════════════════════════════════════════════════════════════════════════
// D. THE ONE SYSTEM FALLBACK — and the two constraints that keep it honest
// ═══════════════════════════════════════════════════════════════════════════

const debtFuture = evaluate(MeasureId.DEBT_BALANCE, FUTURE, C);
eq('D1 debt_balance@DATE holds today\'s MEASURED balance flat',
  valueOf(debtFuture), acc.totalLiabilities);
eq('D2 and says so by carrying ASSUMPTION_DEPENDENT, never MEASURED',
  standingOf(debtFuture), Standing.ASSUMPTION_DEPENDENT);
eq('D3 and names where the value came from', debtFuture.dependsOn, ['debt_balance@NOW']);

// ⚠️ NEVER FOR THE SUBJECT OF THE QUESTION. Asked "what will my debt be in
// December?", holding debt flat and answering $549.75 would answer a DIFFERENT
// QUESTION IN THE VOICE OF AN ANSWER — the shape of the defect PROJECTION-3
// closed, inverted.
const askedAboutDebt: MeasureContext = { ...C, subject: MeasureId.DEBT_BALANCE };
check('D4 the fallback is refused for the leg the question is ABOUT',
  evaluate(MeasureId.DEBT_BALANCE, FUTURE, askedAboutDebt).resolution.kind === 'UNRESOLVED');
check('D5 and the refusal explains that no due dates exist to run a schedule on',
  reasonsOf(evaluate(MeasureId.DEBT_BALANCE, FUTURE, askedAboutDebt))
    .some((r) => /due date/i.test(r.detail)));

// ⚠️ IT MAY ONLY HOLD A CURRENTLY-MEASURED VALUE CONSTANT. It may NEVER
// ORIGINATE ONE. If today's value is itself unresolved there is no fallback.
eq('D6 there is no fallback without a MEASURED present value',
  persistenceFallback(MeasureId.DEBT_BALANCE, EMPTY, [{ code: 'NO_EVIDENCE', detail: 'x' }]), null);

check('D7 the fallback names itself in the user\'s language',
  /holding today's debt balance flat because/.test(
    persistenceFallback(MeasureId.DEBT_BALANCE, C, [{ code: 'NO_EVIDENCE', detail: 'nothing licenses it' }])
      ?.statedAs ?? ''));

// ⚠️ THE SET IS CLOSED — ONE FALLBACK FORM. A library of guesses is what this
// constraint exists to prevent, so the module is pinned to one producer.
check('D8 there is exactly ONE fallback producer in the module', (() => {
  const src = readFileSync(join(process.cwd(), 'lib/reasoning/measure/evaluate.ts'), 'utf8');
  return (src.match(/export function persistenceFallback/g) ?? []).length === 1
    && (src.match(/statedAs: `holding today's/g) ?? []).length === 1;
})());

// ═══════════════════════════════════════════════════════════════════════════
// E. net_worth@FUTURE — it does NOT refuse wholesale
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE BRIEF SAYS THIS OUTRIGHT: "I do NOT want: 'I cannot project your
// year-end net worth because future Bitcoin prices are unknown.'"

const nwFuture = composeNetWorth(C, FUTURE);
check('E1 net_worth@FUTURE resolves even though no authority projects crypto',
  nwFuture.resolution.kind === 'VALUE', JSON.stringify(nwFuture.resolution));

// FLAT is the base case, so the composition is the future cash plus today's
// other classes minus today's debt.
const expectedNw = (valueOf(cashFuture) ?? 0)
  + (acc.totalInvestments ?? 0) + (acc.totalDigitalAssets ?? 0)
  + (acc.totalRealAssets ?? 0) - (acc.totalLiabilities ?? 0);
near('E2 and it composes the legs the accounts payload publishes',
  valueOf(nwFuture) ?? NaN, expectedNw, 0.01);

eq('E3 its standing is the WEAKEST of its legs, never the strongest',
  standingOf(nwFuture), Standing.ASSUMPTION_DEPENDENT);

check('E4 and dependsOn names every leg it used', (() => {
  const d = nwFuture.dependsOn.join(' ');
  return /liquid_cash/.test(d) && /debt_balance@NOW/.test(d)
    && /investments_value/.test(d) && /digital_assets_value/.test(d);
})(), nwFuture.dependsOn.join(' '));

// ⚠️ BUT IT DOES REFUSE WHEN THE FALLBACK CANNOT APPLY. With no accounts, no leg
// has a MEASURED present to hold flat, so there is nothing to compose.
check('E5 with nothing measured today, the composition refuses',
  composeNetWorth(EMPTY, FUTURE).resolution.kind === 'UNRESOLVED');

// ⚠️ AND THE SUBJECT IS NEVER PAPERED OVER. Asked about debt at a date, the
// net-worth composition may not quietly hold debt flat to reach a number.
check('E6 the composition refuses rather than fall back on the SUBJECT leg',
  composeNetWorth({ ...C, subject: MeasureId.DEBT_BALANCE }, FUTURE)
    .resolution.kind === 'UNRESOLVED');

// ⚠️ REJECTED: a `completeness` axis. It is derivable, and a parallel enum is
// how a codebase gets from three vocabularies to forty-two.
check('E7 no completeness vocabulary was invented', (() => {
  const src = readFileSync(join(process.cwd(), 'lib/reasoning/measure/types.ts'), 'utf8');
  return !/COMPLETE|CONDITIONAL|PARTIAL/.test(src);
})());

// ═══════════════════════════════════════════════════════════════════════════
// F. INVESTMENTS FORWARD — deliberately poor, and honest about it
// ═══════════════════════════════════════════════════════════════════════════

eq('F1 FLAT is the base case and holds today\'s value',
  valueOf(evaluate(MeasureId.DIGITAL_ASSETS_VALUE, FUTURE, { ...C, returnBasis: FLAT })),
  acc.totalDigitalAssets);
eq('F2 and carries ASSUMPTION_DEPENDENT — flat is an assumption, not a measurement',
  standingOf(evaluate(MeasureId.DIGITAL_ASSETS_VALUE, FUTURE, { ...C, returnBasis: FLAT })),
  Standing.ASSUMPTION_DEPENDENT);

const band = evaluate(MeasureId.DIGITAL_ASSETS_VALUE, FUTURE,
  { ...C, returnBasis: { kind: 'SCENARIO_BAND', pct: 10, statedAs: 'what if Bitcoin goes up 10%' } });
near('F3 a scenario band applies the user\'s own percentage',
  valueOf(band) ?? NaN, (acc.totalDigitalAssets ?? 0) * 1.1, 0.01);
eq('F4 and is HYPOTHETICAL — a counterfactual is never a claim about their money',
  standingOf(band), Standing.HYPOTHETICAL);

// ⚠️ THERE IS NO `DERIVED_FROM_HISTORY` AND IT MUST NOT BE ADDED. No trustworthy
// producer exists: BTC prices only from 2025-08-03, ETH a rolling 365 days, and
// investment QUANTITIES back-projected where no event replay exists.
check('F5 no history-derived return basis exists', (() => {
  const src = readFileSync(join(process.cwd(), 'lib/reasoning/measure/types.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return !/DERIVED_FROM_HISTORY/.test(code);
})());

// ═══════════════════════════════════════════════════════════════════════════
// G. THE SECURITY CONSTRAINT ON BLOCKED_BY_PERMISSION
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ A PER-ACCOUNT REFUSAL SAYING "blocked by permission" DISCLOSES THAT A
// HIDDEN ACCOUNT EXISTS. `accounts.ts` already reasons about exactly this for
// KnowledgeGaps: BALANCE_ONLY accounts are excluded because surfacing gaps for
// them would implicitly reveal that they are debt accounts.

check('G1 no BLOCKED_BY_PERMISSION detail names an account', (() => {
  const src = readFileSync(join(process.cwd(), 'lib/reasoning/measure/evaluate.ts'), 'utf8');
  const uses = [...src.matchAll(/BLOCKED_BY_PERMISSION[\s\S]{0,300}?\}/g)].map((m) => m[0]);
  return uses.length > 0
    && uses.every((u) => /some positions|some accounts/.test(u)
      && !/\$\{[^}]*name|\$\{[^}]*label|accountId/.test(u));
})());

// ═══════════════════════════════════════════════════════════════════════════
// H. NO NEW ARITHMETIC, AND NO SECOND DATABASE
// ═══════════════════════════════════════════════════════════════════════════

const EVAL_SRC = readFileSync(join(process.cwd(), 'lib/reasoning/measure/evaluate.ts'), 'utf8');
const evalCode = EVAL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('H1 the measure layer reaches no database and no clock',
  !/lib\/db|prisma|Date\.now\(\)|new Date\(\)/.test(evalCode));
check('H2 and no language model',
  !/generateChat|generateStructured|openai/i.test(evalCode));

// ⚠️ THE ONLY ARITHMETIC IS THE COMPOSITION AND THE SCENARIO BAND. Everything
// else is a field read. Division and multiplication are counted, because a
// second average or a second rate conversion in here is a second opinion about
// a number an authority already published.
// Two multiplications exist and both are named: the savings-rate percentage and
// the scenario band. Anything else here would be a second opinion about a number
// an authority already published.
// Six, and every one is accounted for below. The count is deliberately brittle:
// a seventh multiplication appearing here is a second opinion about a number an
// authority already published, and it should have to be justified in a diff.
eq('H3 there are exactly six multiplications in the whole layer',
  (evalCode.match(/\*(?!\/)/g) ?? []).length, 6);
check('H3a and every one of them is named: the savings rate, the scenario band, '
  + 'the two sign applications the composition is FOR, and the two that turn a '
  + 'published max/min RATIO into a coefficient of variation',
  /\(\(inc - exp\) \/ inc\) \* 100/.test(evalCode)
  && /value \* \(1 \+ basis\.pct \/ 100\)/.test(evalCode)
  && (evalCode.match(/leg\.sign \*/g) ?? []).length === 2
  && (evalCode.match(/\*\* 2/g) ?? []).length === 1
  && /Math\.sqrt\(variance\) \/ mean/.test(evalCode));

// ⚠️ EVERY AUTHORITY REACHES THIS LAYER THROUGH THE SANCTIONED ADAPTER. Three
// tests pin that door: engine.test.ts N1, policy.test.ts J9, spending-baseline
// L4. A new consumer is exactly what they were written for.
check('H4 nothing imports lib/forecast directly',
  !/from '@\/lib\/forecast\//.test(EVAL_SRC));

// ═══════════════════════════════════════════════════════════════════════════
// I. THE OBLIGATION DISCLOSURE — the honest half of "connect it"
// ═══════════════════════════════════════════════════════════════════════════

const ASSEMBLE_SRC = readFileSync(join(process.cwd(), 'lib/ai/forecast/assemble.ts'), 'utf8');
check('I1 activeButUndatedCount is counted, not hard-coded',
  /activeButUndatedCount: activeUndatedObligations\(acc\)/.test(ASSEMBLE_SRC)
  && !/activeButUndatedCount: 0/.test(ASSEMBLE_SRC));

// ⚠️ AND IT CHANGES NO PROJECTED NUMBER. `licensedEvents` is still empty,
// because no authority can invent a due date that was never captured.
check('I2 and licences no new obligation event',
  /licensedEvents: \[\], evaluated: true/.test(ASSEMBLE_SRC));

// ⚠️ `obligation.ts` STAYS UNWIRED. It is unreachable DELIBERATELY: across every
// Space, five debt accounts carry stated minimums and APRs and NOT ONE carries a
// due date. Connecting it would be a no-op with a false air of capability.
check('I3 obligation.ts is still consumed by no PRODUCTION file', (() => {
  const { execSync } = require('child_process') as typeof import('child_process');
  const hits = execSync('grep -rl "forecast/obligation" lib app components scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  // Its own module names itself; every other reference must be a test. A
  // production consumer appearing here means somebody wired an authority that
  // has no evidence to run on.
  return hits.every((f: string) =>
    f.endsWith('.test.ts') || f === 'lib/forecast/obligation.ts');
})(), (() => {
  const { execSync } = require('child_process') as typeof import('child_process');
  return execSync('grep -rl "forecast/obligation" lib app components scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim();
})());

// ⚠️ BALANCE_ONLY ROWS ARE NOT COUNTED, and that is a privacy decision rather
// than an oversight: they carry no debt metadata at all, and counting them would
// disclose that a hidden account is a debt account.
check('I4 the count reads resolved debt fields, so invisible rows cannot be counted',
  /r\.amountOwed/.test(ASSEMBLE_SRC) && /r\.minimumPayment/.test(ASSEMBLE_SRC)
  && /r\.dueDay === null/.test(ASSEMBLE_SRC));

// ═══════════════════════════════════════════════════════════════════════════
// J. THE DOUBLE-COUNT JOIN, AND THE OBLIGATION COUNTER'S BEHAVIOUR
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE PLAN ASKED FOR "ONE SHARED AUTHORITY, NOT TWO COMMENTS", ON THE READING
// THAT `projection.ts:29-38` AND `spending-baseline.ts:66-71` DOCUMENT THE SAME
// RULE TWICE. The repository says otherwise, and the difference matters:
// spending-baseline exports `isOrdinaryConsumption`, which IS the shared
// authority and already has one implementation; projection.ts's comment is a
// different statement — a measured finding about why it projects no debt
// paydown at all ("every payment appears TWICE … the cards carry $16,854 of the
// period's $17,012 of spending"). There is nothing to merge. What was missing is
// the rule at the JOIN, where three ledgers actually meet, and that is stated in
// `composeNetWorth` and pinned here.

check('J1 the composition states the double-count rule at the join',
  /THREE LEDGERS MEET HERE/.test(EVAL_SRC)
  && /isOrdinaryConsumption/.test(EVAL_SRC));

// The rule holds STRUCTURALLY, not by inspection: debt forward is a persistence
// fallback, so it contributes nothing that moves with spending.
eq('J2 debt forward is today\'s balance exactly, so it cannot move with spending',
  valueOf(evaluate(MeasureId.DEBT_BALANCE, FUTURE, C)),
  valueOf(evaluate(MeasureId.DEBT_BALANCE, NOW, C)));

// ⚠️ AND THE COUNTER ACTUALLY COUNTS. The fixture's single debt account carries
// an APR and no minimum, so the real-fixture count is legitimately 0 — which
// would let a still-hard-coded 0 pass unnoticed. A row shaped like the census's
// five (owed, a stated minimum, no dueDay) must produce a non-zero count.
check('J3 an owed account with a minimum and no dueDay is counted', (() => {
  const ctx2 = realSpaceCtx();
  const a2 = ctx2.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
  const rows = a2.accounts as unknown as Record<string, unknown>[];
  const card = rows.find((r) => r.type === 'debt');
  if (!card) return false;
  card.amountOwed = 549.75; card.minimumPayment = 35; card.dueDay = null;
  const f2 = assembleForecast({
    ctx: ctx2, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: 'x',
  });
  return f2.state.knownObligations.activeButUndatedCount === 1;
})());

check('J4 and a dated account is NOT counted', (() => {
  const ctx3 = realSpaceCtx();
  const a3 = ctx3.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
  const rows = a3.accounts as unknown as Record<string, unknown>[];
  const card = rows.find((r) => r.type === 'debt');
  if (!card) return false;
  card.amountOwed = 549.75; card.minimumPayment = 35; card.dueDay = 14;
  const f3 = assembleForecast({
    ctx: ctx3, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: 'x',
  });
  return f3.state.knownObligations.activeButUndatedCount === 0;
})());

// ═══════════════════════════════════════════════════════════════════════════
// K. DISPERSION — the guard against "stop refusing" becoming "always estimate"
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ EVERYTHING ELSE IN THIS PROGRAMME WORKS TO STOP THE ASSISTANT REFUSING
// USEFUL ANSWERS. Nothing else stops that degrading into a confident point
// estimate over a 6.1x spread. `spending-baseline.ts` records what this Space
// actually looks like: months from $2,290.03 to $14,060.81, NO CURRENT REGIME.

const spend = evaluate(MeasureId.MONTHLY_SPENDING, NOW, C);
check('K1 monthly_spending carries how much it actually moves',
  spend.dispersion !== undefined, JSON.stringify(spend.dispersion));
check('K2 and the spread is the real one, not a smoothed one',
  (spend.dispersion?.max ?? 0) / (spend.dispersion?.min ?? 1) > 2,
  JSON.stringify(spend.dispersion));
check('K3 with the sample size, so a two-month spread is not read as a regime',
  (spend.dispersion?.sampleN ?? 0) >= 2);
// ⚠️ NOT A CONFIDENCE INTERVAL AND NOT A FORECAST BAND. `range` is reserved for
// SCENARIOS — two answers to two questions — and dispersion is a statement about
// the past. Conflating them would let "we are not sure" become a band the
// product has no authority to state.
check('K4 dispersion is not silently promoted into a range',
  spend.range === undefined);

// ═══════════════════════════════════════════════════════════════════════════
// L. THE SYSTEM FALLBACK'S DISCLOSURE SURVIVES TO THE NARRATOR
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ INVARIANT 4 FAILED HERE AND IT FAILED SILENTLY. `persistenceFallback` built
// the sentence — "holding today's debt balance flat because no due dates are
// recorded…" — and every call site discarded it. `composeNetWorth` pushed the
// strings into a local array and then spread `{ range: undefined }`, a NO-OP,
// beneath a comment claiming the fallbacks were "named here so narration can say
// them"; `debtAtDate` took `fb.value` and dropped `fb.statedAs`. So a $45,451.83
// answer rested on an assumption nobody had made, the user could not see, and
// the system had already written down. The one place this codebase asserted its
// own principle in a comment and contradicted it on the line beneath.

const debtFwd = evaluate(MeasureId.DEBT_BALANCE, FUTURE, C);
check('L1 the leg that used a fallback carries its own disclosure',
  (debtFwd.systemAssumptions ?? []).some((a) => /holding today's debt balance flat/.test(a)),
  JSON.stringify(debtFwd.systemAssumptions));

// ⚠️ AND THE COMPOSITION INHERITS IT. This is the path the fallback actually
// takes: `debtAtDate` applies it INTERNALLY and returns a VALUE, so the
// composition's own fallback branch never runs for that leg. Without the
// inheritance the composed figure carried no disclosure at all.
check('L2 the composition inherits its legs\' disclosures',
  (nwFuture.systemAssumptions ?? []).some((a) => /holding today's debt balance flat/.test(a)),
  JSON.stringify(nwFuture.systemAssumptions));

check('L3 no fallback used in a calculation disappears', (() => {
  // Every leg that resolved via the fallback must be named. Debt is the one that
  // does on this fixture; the assertion is that the COUNT matches, so a second
  // silent fallback cannot be added without this failing.
  const usedFallback = nwFuture.dependsOn.filter((d) => d.endsWith('@NOW')).length;
  return (nwFuture.systemAssumptions ?? []).length >= usedFallback;
})(), `${JSON.stringify(nwFuture.dependsOn.filter((d) => d.endsWith('@NOW')))} vs `
  + `${JSON.stringify(nwFuture.systemAssumptions)}`);

// ── It reaches the narrator, and it is attributed to US ────────────────────
const withFallback = buildTypedPromptSuffix({
  forecast, ctx, assessment, messages: [{ role: 'user', content: 'net worth in December?' }],
  measures: [nwFuture], framing: ['assume I spend $5,000/month'],
});
check('L4 the disclosure reaches the prompt the narrator reads',
  /holding today's debt balance flat/.test(withFallback.suffix),
  withFallback.suffix.split('\n').filter((l) => /net worth on|ASSUMED/.test(l)).join(' // '));

// ⚠️ AND IT IS NOT ATTRIBUTED TO THE USER. `table.ts` used to set
// `basis: args.framing?.[0]` — the first item of an unrelated list — so a figure
// resting on a SYSTEM fallback about DEBT was rendered as
// `- the user said: "assume I spend $5,000/month"`. Telling somebody they
// assumed something they did not is worse than disclosing nothing.
check('L5 an unrelated user assumption cannot become a system fallback\'s basis', (() => {
  const t = buildFigureTable({
    forecast, ctx, assessment, measures: [nwFuture],
    framing: ['assume I spend $5,000/month'],
    messages: [{ role: 'user', content: 'net worth in December?' }],
  });
  const nwFig = t.figures.find((f) => /net worth on/.test(f.label));
  return !!nwFig && nwFig.basis === undefined;
})());

check('L6 the two authorities render as different sentences',
  /WE ASSUMED/.test(withFallback.suffix)
  && !/the user said: "holding today/.test(withFallback.suffix));

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
