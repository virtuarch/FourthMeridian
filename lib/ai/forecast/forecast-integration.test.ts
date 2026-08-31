/**
 * lib/ai/forecast/forecast-integration.test.ts   (FORECAST-10)
 *
 * THE FIRST PRODUCTION-FACING FORECAST SLICE — PINNED.
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs \
 *       lib/ai/forecast/forecast-integration.test.ts
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   a forecast question resolves the FORECAST concept, and a future-tense
 *   question about records does not;
 *   raw history is NOT_NEEDED for a forecast-only question and REQUIRED when
 *   the question also asks about the past;
 *   "I spend $4,000" reaches the baseline authority and "assume I spend $4,000"
 *   reaches the policy;
 *   a refused forecast still renders its licensed facts;
 *   and no non-forecast question grows a forecast section.
 *
 * Section M runs REAL SOURCE MUTATIONS across four production modules.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { Concepts, planRetrieval, NeedLevel } from '@/lib/ai/retrieval-plan';
import { suppressHistoricalSpending } from '@/lib/ai/prompts/system-prompt';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { resolveForecastHorizon } from './horizon';
import { extractForecastStatements } from './statements';
import { assembleForecast, forecastAsk, ForecastAsk } from './assemble';
import { resolveAssertedFacts } from './fact-continuity';
import { detectPayDateAsk, resolvePayDates, renderPayDates } from './pay-dates';
import {
  detectUnlicensedForecastArithmetic, redactUnlicensed, resolveForecastGuardMode,
} from './numerical-guard';
import type { CashForecast } from '@/lib/forecast/engine';
import { renderForecastSection } from './render';
import type { ResolvedIncomeStream } from './streams';
import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { resolveStreamActivity } from '@/lib/forecast/stream-activity';
import { AmountBasis, EventProvenance, FlowRole, type FutureCashEvent } from '@/lib/forecast/future-cash-event';
import { AssumptionOrigin, ConclusionStatus } from '@/lib/forecast/policy';
import { ComponentState } from '@/lib/ai/economic-concepts';
import { Conclusion } from '@/lib/forecast/operating-state';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name: string, actual: number | null | undefined, expected: number, tol = 0.01) =>
  check(name, actual != null && Math.abs(actual - expected) < tol, `expected ~${expected}, got ${actual}`);

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const AS_OF = '2026-08-28';
const NOW = new Date(`${AS_OF}T12:00:00.000Z`);
const tok = (s: string) => Math.ceil(s.length / 4);

// ── The real Space ──────────────────────────────────────────────────────────

const realAccounts = {
  totalLiquid: 10228.74, totalLiabilities: 549.75,
  totalInvestments: 5006.557852, totalDigitalAssets: 19014.62555862176,
  redactedCount: 0, totalsUnconverted: false,
  counts: { liquid: 4, liabilities: 2, investments: 3, digitalAssets: 4, realAssets: 0 },
} as unknown as AccountsSectionData;

const ctx = {
  space: { name: 'Personal', reportingCurrency: 'USD' },
  domains: { [FinanceDomains.ACCOUNTS]: { data: realAccounts } },
} as unknown as SpaceContext_AI;

const vecCadence: Cadence = {
  kind: CadenceKind.BIWEEKLY, anchorISO: '2026-08-14', sourceKey: 'vectrus',
  provenance: CadenceProvenance.DERIVED, observationCount: 19, confidence: 1,
  reason: 'biweekly payroll', toleranceDays: 2,
} as unknown as Cadence;
const vecActivity = resolveStreamActivity({
  cadence: vecCadence, settlements: ['2026-07-17', '2026-07-31', '2026-08-14'],
  observedThroughISO: AS_OF, asOfISO: AS_OF,
});
const abaActivity = resolveStreamActivity({
  cadence: { ...vecCadence, kind: CadenceKind.SEMIMONTHLY, sourceKey: 'abacus' } as Cadence,
  settlements: ['2025-10-24', '2025-11-10', '2025-11-25'],
  observedThroughISO: AS_OF, asOfISO: AS_OF,
});

const VECTRUS: ResolvedIncomeStream = {
  sourceKey: 'vectrus', label: 'Vectrus', role: FlowRole.INCOME, cadence: vecCadence,
  activity: vecActivity,
  amount: {
    assertable: true, value: 5286.645, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null, regimeStartISO: '2026-04-10',
    observationCount: 6, spread: 0.0016, verdicts: [], reason: 'six observations hold a level',
  },
  projectionEligible: vecActivity.mayGenerateExpectedOccurrences,
  // PROJECTION-1 — these settle into a checking account on the real Space.
  settledDepository: true,
  observationCount: 19, truncated: false,
};
const ABACUS: ResolvedIncomeStream = {
  sourceKey: 'abacus', label: 'Abacus', role: FlowRole.INCOME,
  cadence: { ...vecCadence, kind: CadenceKind.SEMIMONTHLY, sourceKey: 'abacus' } as Cadence,
  activity: abaActivity,
  amount: {
    assertable: true, value: 5015.68, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null, regimeStartISO: '2025-10-24',
    observationCount: 4, spread: 0.001, verdicts: [], reason: 'four observations',
  },
  projectionEligible: abaActivity.mayGenerateExpectedOccurrences,
  // PROJECTION-1 — these settle into a checking account on the real Space.
  settledDepository: true,
  observationCount: 10, truncated: false,
};
const STREAMS = [VECTRUS, ABACUS];

const envelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE },
  snapshots: { availability: EvidenceAvailability.AVAILABLE },
  accounts: { investments: 3, digitalAssets: 4 },
} as unknown as CoverageEnvelope;

const plan = (question: string, prior: string[] = []) => planRetrieval({
  messages: [...prior.map((c) => ({ role: 'user', content: c })), { role: 'user', content: question }],
  envelope, now: NOW,
});
const need = (q: string, d: string) => plan(q).domains.find((x) => x.domain === d)!.need;

const HORIZON = resolveForecastHorizon('over the next 3 months', AS_OF)!;
const build = (question: string) => assembleForecast({
  ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question,
});

// ═══════════════════════════════════════════════════════════════════════════
// A. CONCEPT RESOLUTION AND FALSE POSITIVES
// ═══════════════════════════════════════════════════════════════════════════

const FORECAST_Q = 'What will my cash look like over the next 3 months?';
check('A1 the canonical forecast question resolves FORECAST',
  plan(FORECAST_Q).concepts.includes(Concepts.FORECAST),
  JSON.stringify(plan(FORECAST_Q).concepts));
for (const q of ['Forecast my cash for the next 3 months.', 'Project my balance through December.',
  'How much cash will I have in 6 months?', 'How long will my cash last?',
  'Where will I be financially next year?', 'What is my runway?']) {
  check(`A2 "${q.slice(0, 34)}…" resolves FORECAST`,
    plan(q).concepts.includes(Concepts.FORECAST), JSON.stringify(plan(q).concepts));
}

// §25 — future-sounding language that is NOT a cash-path request.
for (const q of ['Show me my pending transactions.', 'What future transactions are there?',
  'Do I have an upcoming bill?', 'What happened after June?',
  'How are my long-term investments doing?']) {
  check(`A3 "${q.slice(0, 34)}…" does NOT resolve FORECAST`,
    !plan(q).concepts.includes(Concepts.FORECAST), JSON.stringify(plan(q).concepts));
}
// §17 — "next paycheck" is answerable without the engine, so it is not a
// full cash-path question. It is a REPORTED AMBIGUOUS CASE: it is genuinely
// predictive, and it is excluded because the capability that answers it is
// cheaper, not because it is not about the future.
check('A4 "when is my next paycheck" is not routed to full cash forecasting',
  !plan('When is my next paycheck?').concepts.includes(Concepts.FORECAST));

// §2 — historical vs predictive.
eq('A5 "what did I spend over the last 3 months" is SPENDING, not FORECAST',
  plan('What did I spend over the last 3 months?').concepts.includes(Concepts.FORECAST), false);
eq('A6 "what is my current cash" is not a forecast',
  plan("What's my current cash balance?").concepts.includes(Concepts.FORECAST), false);
check('A7 "use the last 3 months to forecast the next 3" is FORECAST',
  plan('Use the last 3 months to forecast the next 3 months.').concepts.includes(Concepts.FORECAST));

// ═══════════════════════════════════════════════════════════════════════════
// B. DOMAIN EXECUTION VS SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

eq('B1 a forecast-only question does NOT serialize transaction rollups',
  need(FORECAST_Q, FinanceDomains.TRANSACTIONS_SUMMARY), NeedLevel.NOT_NEEDED);
eq('B2 nor snapshot history',
  need(FORECAST_Q, FinanceDomains.SNAPSHOT_HISTORY), NeedLevel.NOT_NEEDED);
eq('B3 accounts are REQUIRED — the liquid total is opening cash',
  need(FORECAST_Q, FinanceDomains.ACCOUNTS), NeedLevel.REQUIRED);
check('B4 but the assembler dependency is preserved — NOT_NEEDED never means "do not assemble"',
  plan(FORECAST_Q).domains
    .filter((d) => d.need === NeedLevel.NOT_NEEDED && d.assessmentNeedsIt).length === 2,
  JSON.stringify(plan(FORECAST_Q).domains.map((d) => [d.domain, d.need, d.assessmentNeedsIt])));

// §22 — a question that asks for BOTH keeps the history.
const BOTH_Q = 'Compare what I spent over the last 3 months with what my cash could look like over the next 3 months.';
check('B5 a historical+forecast question resolves BOTH concepts',
  plan(BOTH_Q).concepts.includes(Concepts.FORECAST)
  && plan(BOTH_Q).concepts.includes(Concepts.SPENDING), JSON.stringify(plan(BOTH_Q).concepts));
eq('B6 and the transaction rollups come back REQUIRED',
  need(BOTH_Q, FinanceDomains.TRANSACTIONS_SUMMARY), NeedLevel.REQUIRED);

// ═══════════════════════════════════════════════════════════════════════════
// C. TEMPORAL — the forward horizon
// ═══════════════════════════════════════════════════════════════════════════

eq('C1 "over the next 3 months" resolves calendar dates',
  [HORIZON.fromISO, HORIZON.toISO], [AS_OF, '2026-11-28']);
eq('C2 "next 90 days" is exact days, not months',
  resolveForecastHorizon('over the next 90 days', AS_OF)!.toISO, '2026-11-26');
eq('C3 "through December" lands on the last day of that month',
  resolveForecastHorizon('project my cash through December', AS_OF)!.toISO, '2026-12-31');
eq('C4 "next month" is one calendar month', resolveForecastHorizon('next month', AS_OF)!.toISO, '2026-09-28');
eq('C5 a question with no period yields null — no silent default here',
  resolveForecastHorizon('forecast my cash', AS_OF), null);
eq('C6 a past phrase is not a horizon', resolveForecastHorizon('over the last 3 months', AS_OF), null);
check('C7 the horizon carries the user\'s own words',
  /next 3 months/.test(HORIZON.statedAs), HORIZON.statedAs);
check('C8 no average-month arithmetic — the calendar authority is used',
  /from '@\/lib\/perspectives\/time-range'/.test(read('lib/ai/forecast/horizon.ts'))
  && !/30\.4|365\.2425|\/ 12/.test(read('lib/ai/forecast/horizon.ts')));
check('C9 lib/forecast still parses nothing',
  !/next |through |month\b/i.test(
    read('lib/forecast/policy.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .replace(/'[^']*'/g, "''")));

// ═══════════════════════════════════════════════════════════════════════════
// D. TRACE A — facts only, and the refusal is the result
// ═══════════════════════════════════════════════════════════════════════════

const A = build(FORECAST_Q);
check('D1 a forecast was produced', !('refused' in A.forecast));
const fa = A.forecast as Exclude<typeof A.forecast, { refused: true }>;

eq('D2 opening cash is the liquid total', fa.openingCash.amount, 10228.74);
eq('D3 the full cash path is REFUSED', fa.fullCashPath.status, ConclusionStatus.REFUSED);
check('D4 for want of the spending baseline and the income basis',
  fa.fullCashPath.missing.some((m) => /discretionary spending/.test(m))
  && fa.fullCashPath.missing.some((m) => /gross or net|net \(after-tax\)/.test(m)),
  JSON.stringify(fa.fullCashPath.missing));
eq('D5 seven licensed Vectrus pay dates are still exposed',
  fa.events.map((e) => e.dateISO),
  ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20']);
eq('D6 with nominal amounts visible', fa.events[0].authoritativeAmount!.value, 5286.645);
eq('D7 and no cash contribution', fa.events[0].cashDelta, null);
check('D8 SILENT Abacus contributes ZERO events',
  fa.events.every((e) => !e.id.startsWith('abacus')), JSON.stringify(fa.events.map((e) => e.id)));
eq('D9 the observed spending baseline is UNKNOWN',
  A.state.discretionaryBaseline.state, ComponentState.UNKNOWN);
eq('D10 no facts were extracted from a question that stated none', A.appliedFacts, []);
eq('D11 the only assumption is the disclosed system default',
  A.policy.assumptions.map((x) => x.origin), ['SYSTEM_POLICY']);

const renderA = renderForecastSection(A).join('\n');
check('D12 the section renders despite the refusal', /=== FORECAST ===/.test(renderA));
check('D13 and states the refusal explicitly', /Ending cash: REFUSED — needs/.test(renderA));
check('D14 while still showing opening cash', /Opening cash: USD 10228\.74/.test(renderA));
// ⚠️ ONE anti-average instruction, from FORECAST-7's state serializer.
// `explainPolicy` carries a second ("Never substitute a historical average for
// anything still unknown") and is DELIBERATELY NOT rendered here: its other
// five sections restate the state and the result the two blocks either side
// already carry, and §15 is explicit that redundant restatements of the same
// arithmetic are what invite a model to recompute. The unique thing it holds —
// a counterfactual marked and quoted — reaches the prompt through the engine's
// own assumption line instead (G4).
check('D15 and forbidding a historical substitute',
  /Do not substitute a historical average for any of them/.test(renderA), renderA);
check('D15a the policy explainer is deliberately not duplicated into the section',
  !/Facts used:|Unlocked by assumption:/.test(renderA));
check('D16 crypto is present in the state and out of opening cash',
  /Digital assets/i.test(renderA) && !/opening cash: USD 24/i.test(renderA)
  && A.state.investments !== null);

// ═══════════════════════════════════════════════════════════════════════════
// E. TRACE B — explicit assumptions
// ═══════════════════════════════════════════════════════════════════════════

const B = build('Forecast my cash for the next 3 months. Assume I spend $4,000/month and assume my paycheck is net.');
const fb = B.forecast as Exclude<typeof B.forecast, { refused: true }>;

eq('E1 no fact was applied — both sentences hedged', B.appliedFacts, []);
check('E2 two suppositions reached the policy',
  B.policy.assumptions.filter((a) => a.origin === 'USER_REQUESTED').length === 2,
  JSON.stringify(B.policy.assumptions.map((a) => [a.id, a.dimension, a.origin])));
eq('E3 the scenario cash path computes', fb.fullCashPath.status, ConclusionStatus.ASSUMPTION_DEPENDENT);
near('E4 ending cash = opening + 7 paychecks - 92 days of accrual',
  fb.fullCashPath.closing, 10228.74 + 5286.645 * 7 - (4000 / (365.2425 / 12)) * 92);
check('E5 the dependencies name both suppositions',
  fb.fullCashPath.dependencies.length === 2, JSON.stringify(fb.fullCashPath.dependencies));
eq('E6 the AUTHORITATIVE baseline underneath is still UNKNOWN',
  B.state.discretionaryBaseline.state, ComponentState.UNKNOWN);
check('E7 the model context carries the engine\'s number, and every mention of '
  + 'computing is a PROHIBITION on it', (() => {
  const r = renderForecastSection(B).join('\n');
  const verbs = [...r.matchAll(/[^.]*\b(calculate|compute|multiply|work out)\b[^.]*/gi)]
    .map((m) => m[0]);
  return /Ending cash: USD [\d.]+ · ASSUMPTION_DEPENDENT/.test(r)
    && verbs.length > 0
    && verbs.every((v) => /\bdo not\b|\bnever\b|\bnot\b/i.test(v));
})(), renderForecastSection(B).join('\n'));

// ═══════════════════════════════════════════════════════════════════════════
// F. TRACE C — user-asserted FACTS
// ═══════════════════════════════════════════════════════════════════════════

const C = build('My paycheck is take-home and my normal spending is $4,000 a month. Forecast my cash for the next 3 months.');
const fc = C.forecast as Exclude<typeof C.forecast, { refused: true }>;

eq('F1 both statements routed as FACTS, not assumptions',
  C.statements.map((s) => s.routing.destination),
  ['UPSTREAM_AUTHORITY', 'UPSTREAM_AUTHORITY']);
eq('F2 and were applied to the authorities', C.appliedFacts.length, 2);
eq('F3 no supposition entered the policy',
  C.policy.assumptions.filter((a) => a.origin === 'USER_REQUESTED').length, 0);
eq('F4 the baseline authority is now ASSERTABLE',
  C.state.discretionaryBaseline.state, ComponentState.ASSERTABLE);
eq('F5 with USER_ASSERTED provenance',
  C.state.discretionaryBaseline.provenance, EventProvenance.USER_ASSERTED);
eq('F6 and the Vectrus basis is NET by assertion',
  C.state.incomeStreams.find((s) => s.sourceKey === 'vectrus')!.basis, AmountBasis.NET);
eq('F7 the cash path is FACTUALLY_LICENSED', fc.fullCashPath.status, ConclusionStatus.FACTUALLY_LICENSED);
eq('F8 depending on nothing supposed', fc.fullCashPath.dependencies, []);
near('F9 the arithmetic is identical to trace B',
  fc.fullCashPath.closing, fb.fullCashPath.closing as number);
check('F10 but the STATUS survives serialization as different', (() => {
  const rb = renderForecastSection(B).join('\n'), rc = renderForecastSection(C).join('\n');
  return /ASSUMPTION_DEPENDENT/.test(rb) && /FACTUALLY_LICENSED/.test(rc)
    && /STATED AS FACT BY THE USER/.test(rc) && !/STATED AS FACT/.test(rb);
})());

// ═══════════════════════════════════════════════════════════════════════════
// G. TRACE D — the explicit hypothetical
// ═══════════════════════════════════════════════════════════════════════════

const D = build('Show me a scenario where I spend $10,000 a month over the next 3 months.');
const fd = D.forecast as Exclude<typeof D.forecast, { refused: true }>;

eq('G1 an explicit scenario becomes a COUNTERFACTUAL assumption',
  D.policy.assumptions.filter((a) => a.stance === 'COUNTERFACTUAL').length, 1);
eq('G2 not a fact', D.appliedFacts, []);
eq('G3 the observed baseline remains UNKNOWN',
  D.state.discretionaryBaseline.state, ComponentState.UNKNOWN);
check('G4 the $10,000 appears only with user-requested scenario provenance', (() => {
  const r = renderForecastSection(D).join('\n');
  return /10000/.test(r) && /\(HYPOTHETICAL\)/.test(r)
    && /Show me a scenario where I spend \$10,000 a month/.test(r);
})(), renderForecastSection(D).join('\n'));
check('G5 and never as observed or current-normal spending', (() => {
  const r = renderForecastSection(D).join('\n');
  return /Current-normal discretionary spending: UNKNOWN/.test(r)
    && !/observed[^.]{0,30}10,?000/i.test(r);
})(), renderForecastSection(D).join('\n'));
check('G6 a spending-dependent result is HYPOTHETICAL where it contributes',
  fd.points.length > 0 && (fd.fullCashPath.status === ConclusionStatus.HYPOTHETICAL
    || fd.fullCashPath.status === ConclusionStatus.REFUSED),
  fd.fullCashPath.status);

// ═══════════════════════════════════════════════════════════════════════════
// H. FACT / ASSUMPTION EXTRACTION — the pairs
// ═══════════════════════════════════════════════════════════════════════════

const dest = (msg: string) =>
  extractForecastStatements(msg, AS_OF, 'vectrus').map((s) => [s.mode, s.routing.destination]);

eq('H1 "My normal spending is $4,000/month" is a FACT',
  dest('My normal spending is $4,000/month.'), [['ASSERTS_FACT', 'UPSTREAM_AUTHORITY']]);
eq('H2 "Assume I spend $4,000/month" is an ASSUMPTION',
  dest('Assume I spend $4,000/month.'), [['REQUESTS_ASSUMPTION', 'FORECAST_POLICY']]);
eq('H3 "My paycheck is $5,250 take-home" is a FACT',
  dest('My paycheck is $5,250 take-home.').map((d) => d[1]), ['UPSTREAM_AUTHORITY']);
eq('H4 "Assume my $5,250 paycheck is take-home" is an ASSUMPTION',
  dest('Assume my $5,250 paycheck is take-home.').map((d) => d[1]), ['FORECAST_POLICY']);
eq('H5 "Show me what happens if I spend $10,000/month" is a SCENARIO',
  dest('Show me what happens if I spend $10,000/month.').map((d) => d[0]), ['REQUESTS_SCENARIO']);
check('H6 one turn can carry a fact AND a supposition', (() => {
  const d = dest('My paycheck is take-home. Assume I spend $4,000 a month.');
  return d.length === 2 && d[0][1] === 'UPSTREAM_AUTHORITY' && d[1][1] === 'FORECAST_POLICY';
})(), JSON.stringify(dest('My paycheck is take-home. Assume I spend $4,000 a month.')));
eq('H7 an unrecognised sentence yields NOTHING rather than a guess',
  extractForecastStatements('I might spend a bit more soon.', AS_OF, 'vectrus'), []);
eq('H8 a yearly figure is not silently rescaled into a monthly level',
  extractForecastStatements('I spend $48,000 a year.', AS_OF, 'vectrus'), []);
eq('H9 with no unambiguous stream, a basis statement is not attached to a guess',
  extractForecastStatements('My paycheck is take-home.', AS_OF, null), []);

// §17 — the capability matrix, not a second router.
eq('H10 "what will my cash be" asks for ending cash',
  forecastAsk('What will my cash look like in 3 months?'), ForecastAsk.ENDING_CASH);
eq('H11 "how long will my cash last" asks for runway',
  forecastAsk('How long will my cash last?'), ForecastAsk.RUNWAY);
eq('H12 "when is my next paycheck" asks for pay dates',
  forecastAsk('When is my next paycheck?'), Conclusion.NEXT_PAY_DATES);

// ═══════════════════════════════════════════════════════════════════════════
// HF. FOLLOW-UPS (§23) — a refinement does not end a forecast
// ═══════════════════════════════════════════════════════════════════════════

const T1 = 'Forecast my cash for the next 3 months.';
const T2 = 'What if I spend $5,000 a month?';
const T3 = 'What about 6 months?';

check('HF1 turn 1 resolves FORECAST alone',
  JSON.stringify(plan(T1).concepts) === JSON.stringify([Concepts.FORECAST]));
check('HF2 a scenario follow-up KEEPS the forecast — it does not become a spending question',
  plan(T2, [T1]).concepts.includes(Concepts.FORECAST)
  && plan(T2, [T1]).concepts.includes(Concepts.SPENDING),
  JSON.stringify(plan(T2, [T1]).concepts));
eq('HF3 and the inheritance is disclosed as such', plan(T2, [T1]).conceptProvenance, 'INHERITED');
check('HF4 a second refinement still keeps it, two turns from the original ask',
  plan(T3, [T1, T2]).concepts.includes(Concepts.FORECAST),
  JSON.stringify(plan(T3, [T1, T2]).concepts));
eq('HF5 the new horizon comes from the refinement itself',
  resolveForecastHorizon(T3, AS_OF)!.toISO, '2027-02-28');
eq('HF6 the scenario amount routes to POLICY, never to the fact authority',
  extractForecastStatements(T2, AS_OF, 'vectrus').map((x) => x.routing.destination),
  ['FORECAST_POLICY']);
check('HF7 a genuine topic change ENDS it — no resurrection', (() => {
  const c = plan('What about crypto?', [T1, 'What are my investments?']).concepts;
  return !c.includes(Concepts.FORECAST);
})(), JSON.stringify(plan('What about crypto?', [T1, 'What are my investments?']).concepts));
// ⚠️ RESTATED BY FORECAST-13, AND NOW BEHAVIOURAL RATHER THAN STRUCTURAL. The
// check read the assembler's source for the words "previous" and "history",
// which was a reasonable proxy while nothing there could look backwards at all.
// FORECAST-13 makes FACTS look backwards on purpose, so the proxy fires on the
// feature. The claim worth keeping was never about vocabulary — it is that a
// SUPPOSITION from an earlier turn does not price this one — and that is now
// asserted directly, against the two conversations that distinguish them.
check('HF8 an assumption from an earlier turn does NOT apply to a later forecast', (() => {
  const r = assembleForecast({
    ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
    question: FORECAST_Q,
    messages: [{ role: 'user', content: 'Assume I spend $4,000 a month.' },
      { role: 'user', content: FORECAST_Q }],
  });
  return r.policy.assumptions.filter((a) => a.origin === AssumptionOrigin.USER_REQUESTED).length === 0
    && r.appliedFacts.length === 0
    && r.state.discretionaryBaseline.state === ComponentState.UNKNOWN;
})());
check('HF8a while a FACT from an earlier turn DOES', (() => {
  const r = assembleForecast({
    ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
    question: FORECAST_Q,
    messages: [{ role: 'user', content: 'My normal spending is $4,000 a month.' },
      { role: 'user', content: 'Thanks.' },
      { role: 'user', content: FORECAST_Q }],
  });
  return r.appliedFacts.length === 1
    && r.state.discretionaryBaseline.state === ComponentState.ASSERTABLE
    && r.policy.assumptions.every((a) => a.origin === AssumptionOrigin.SYSTEM_POLICY);
})());

// ═══════════════════════════════════════════════════════════════════════════
// I. NON-FORECAST REGRESSIONS AND CONFLICT ELIMINATION
// ═══════════════════════════════════════════════════════════════════════════

for (const q of ['What are my investments?', 'How much crypto do I have?',
  'What did I spend on dining?', 'What did I spend last month?',
  'What is my net worth?', "What's in my checking account?"]) {
  check(`I1 "${q}" resolves no FORECAST concept`,
    !plan(q).concepts.includes(Concepts.FORECAST), JSON.stringify(plan(q).concepts));
}
eq('I2 an investments question still requires the holdings spine',
  need('What are my investments?', FinanceDomains.HOLDINGS_SUMMARY), NeedLevel.REQUIRED);
eq('I3 a spending question still requires the transaction rollups',
  need('What did I spend last month?', FinanceDomains.TRANSACTIONS_SUMMARY), NeedLevel.REQUIRED);

// §28 — one canonical answer per forecast fact.
const serializer = read('lib/ai/prompts/assessment-serializer.ts');
check('I4 the historical assessment figures are relabelled when a forecast is present',
  /forecastPresent\?: boolean/.test(serializer)
  && /the FORECAST section is authoritative for anything forward-looking/.test(serializer));
check('I5 they are relabelled, never deleted',
  /impliedMonthlyIncome\)}\/mo\$\{qualifier\}\$\{histNote\}/.test(serializer));
check('I6 the forecast section reports exactly ONE paycheck count', (() => {
  // Both mentions are the same figure from two angles — how many landed, and
  // how many are not spendable. A second, DIFFERENT count is the failure.
  const counts = [...renderForecastSection(A).join('\n').matchAll(/(\d+) × \(/g)]
    .map((x) => x[1]);
  return new Set(counts).size === 1 && counts[0] === '7';
})(), JSON.stringify([...renderForecastSection(A).join('\n').matchAll(/(\d+) × \(/g)].map((x) => x[1])));

// ═══════════════════════════════════════════════════════════════════════════
// FD. THE RESPONSE CONTRACT (FORECAST-11)
// ═══════════════════════════════════════════════════════════════════════════

const doctrineSrc = read('lib/ai/prompts/doctrine.ts');
const promptSrc = read('lib/ai/prompts/system-prompt.ts');

check('FD1 the forecast doctrine is injected ONLY when a forecast is present',
  /\.\.\.\(forecast \? \[FORECAST_DOCTRINE, ''\] : \[\]\)/.test(promptSrc), promptSrc.slice(0, 0));
check('FD2 so a non-forecast prompt pays nothing for it', (() => {
  // The doctrine appears exactly twice: the import, and the one gated spread.
  const hits = (promptSrc.match(/FORECAST_DOCTRINE/g) ?? []).length;
  return hits <= 3 && /\.\.\.\(forecast \? \[FORECAST_DOCTRINE, ''\] : \[\]\)/.test(promptSrc);
})());
check('FD2a and a PAY_DATES answer does not carry the cash-forecast doctrine',
  /\.\.\.\(payDates \? renderPayDates\(payDates\) : \[\]\)/.test(promptSrc)
  && !/payDates \? \[FORECAST_DOCTRINE/.test(promptSrc));
check('FD3 it is under the 250-token target, or its overrun is measured',
  Math.ceil((doctrineSrc.match(/export const FORECAST_DOCTRINE = \[[\s\S]*?\]\.join/)?.[0].length ?? 0) / 4) < 500);
check('FD4 the contract names every status in FORECAST-8\'s vocabulary',
  /Factually licensed/i.test(doctrineSrc) && /Assumption-dependent/i.test(doctrineSrc)
  && /Hypothetical/i.test(doctrineSrc) && /Refused/i.test(doctrineSrc));
check('FD5 and forbids printing the enum names themselves',
  /Do not print status names or ids/.test(doctrineSrc));
check('FD6 every distinction the brief lists survives in the contract',
  /gross is not net/i.test(doctrineSrc)
  && /historical spending is not current-normal/i.test(doctrineSrc)
  && /no licensed obligations/i.test(doctrineSrc)
  && /investments and crypto are not cash/i.test(doctrineSrc)
  && /stated as fact is not an assumption|stated is not an assumption/i.test(doctrineSrc));

// ⚠️ The extractor defect FORECAST-11's trace C found: a decimal point inside
// the user's own figure blocked the match, so a truthful assertion silently
// became no assertion at all.
eq('FD7 a basis assertion survives a decimal point in the amount',
  extractForecastStatements(
    'My Vectrus paycheck is $5,286.645 take-home and my normal spending is $4,000 a month.',
    AS_OF, 'vectrus').map((x) => x.subject.kind).sort(),
  ['SPENDING_LEVEL', 'STREAM_AMOUNT_BASIS']);

// ═══════════════════════════════════════════════════════════════════════════
// OE. USER-ASSERTED ONE-OFF EVENTS (FORECAST-17)
// ═══════════════════════════════════════════════════════════════════════════

const U = (...c: string[]) => c.map((content) => ({ role: 'user', content }));
const DEC = { fromISO: AS_OF, toISO: '2026-12-31',
  origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'through December' };
const oeConv = (msgs: { role: string; content: string }[]) => assembleForecast({
  ctx, streams: STREAMS, horizon: DEC, asOfISO: AS_OF,
  question: msgs.filter((m) => m.role === 'user').at(-1)!.content, messages: msgs });
const userEvents = (msgs: { role: string; content: string }[]) => {
  const f = oeConv(msgs).forecast as CashForecast;
  return f.events.filter((e) => /^(?:user|supposed):/.test(e.id));
};
const FD = 'Forecast my cash through December.';

// A/B/C — basis survives FORECAST-3 exactly.
check('OE1 a GROSS bonus is visible and NOT counted as cash', (() => {
  const [e] = userEvents(U('I get a $15,500 gross completion bonus on October 15.', FD));
  return e?.authoritativeAmount?.value === 15500
    && e.authoritativeAmount.basis === AmountBasis.GROSS && e.cashDelta === null;
})());
check('OE2 a NET payout is counted exactly once', (() => {
  const e = userEvents(U("I'll receive a $1,500 net vacation payout on November 1.", FD));
  return e.length === 1 && e[0].cashDelta === 1500;
})());
check('OE3 an unstated basis is UNKNOWN, never silently NET', (() => {
  const [e] = userEvents(U('I get a $1,500 payout on November 1.', FD));
  return e?.authoritativeAmount?.basis === AmountBasis.UNKNOWN && e.cashDelta === null;
})());

// D/E — direction and role.
check('OE4 "I have to pay" is one outflow', (() => {
  const e = userEvents(U('I have to pay $2,000 on September 20.', FD));
  return e.length === 1 && e[0].direction === 'OUTFLOW' && e[0].dateISO === '2026-09-20';
})());
check('OE5 a refund is one inflow with its own role', (() => {
  const [e] = userEvents(U("I'm getting a $3,000 refund on October 4.", FD));
  return e?.direction === 'INFLOW' && e.role === FlowRole.REFUND;
})());

// F — vague timing fabricates nothing.
for (const vague of ['I might get a $5,000 bonus sometime in October.',
  'I get a $5,000 bonus around the holidays.', 'I get a $5,000 bonus in a few weeks.',
  'I get a $5,000 bonus probably next month.']) {
  eq(`OE6 "${vague.slice(10, 44)}" fabricates no event`,
    userEvents(U(vague, FD)).length, 0);
}
eq('OE7 nor does a recurring statement — that is FORECAST-1/2/5\'s authority',
  userEvents(U('I get $4,000 every month.', FD)).length, 0);
eq('OE8 nor an amount with no date', userEvents(U('I get a $5,000 bonus.', FD)).length, 0);
eq('OE9 nor a date with no direction', userEvents(U('$5,000 on October 15.', FD)).length, 0);

// G — fact continuity, through the FORECAST-13 mechanism.
check('OE10 an event survives an unrelated turn', (() => {
  const e = userEvents(U('I get a $1,500 net payout on November 1.', 'Thanks.', FD));
  return e.length === 1 && e[0].cashDelta === 1500;
})());

// H — correction, only with an explicit marker.
check('OE11 an explicit correction supersedes and does not duplicate', (() => {
  const r = oeConv(U('My bonus is $15,500 gross on October 15.',
    'Actually it is $17,000 gross on October 15.', FD));
  const e = (r.forecast as CashForecast).events.filter((x) => x.id.startsWith('user:'));
  return e.length === 1 && e[0].authoritativeAmount?.value === 17000
    && r.facts.superseded.length === 1;
})());

// I/J — suppositions and hypotheticals do not persist or mutate facts.
eq('OE12 a supposed event does not survive to a later turn',
  userEvents(U('Assume I get $5,000 on October 15.', FD)).length, 0);
check('OE13 a hypothetical event is HYPOTHETICAL and turn-scoped', (() => {
  const e = userEvents(U('What if I got $5,000 on October 15?'));
  return e.length === 1 && e[0].id.startsWith('supposed:')
    && e[0].authoritativeAmount?.provenance === EventProvenance.HYPOTHETICAL;
})());
check('OE14 and it does not become an asserted fact',
  oeConv(U('What if I got $5,000 on October 15?')).facts.events.length === 0);

// K — outside the horizon.
eq('OE15 an event beyond the horizon does not enter the arithmetic',
  userEvents(U('I get a $2,000 refund on March 3, 2027.', FD)).length, 0);

// L/M — identity, in both directions.
eq('OE16 two distinct movements sharing a day and an amount both survive',
  userEvents(U('I get a $1,500 refund on October 4. I have to pay $1,500 on October 4.',
    FD)).length, 2);
eq('OE17 two distinct inflows sharing a day and a role both survive',
  userEvents(U('I get a $15,500 gross bonus on October 15. I get a $1,500 payout on October 15.',
    FD)).length, 2);
check('OE18 the same statement twice is one event, not two', (() => {
  const e = userEvents(U('I get a $1,500 net payout on November 1.',
    'My $1,500 net payout is on November 1.', FD));
  return e.length === 1;
})());

// N — a NET event on the same day as a licensed paycheck.
check('OE19 a NET event and a paycheck on one day are both counted, exactly once', (() => {
  const f = oeConv(U('I receive a $1,500 net payout on November 6.',
    'Forecast my cash through December. Assume I spend $4,000/month and my paycheck is net.'))
    .forecast as CashForecast;
  const pt = f.points.find((p) => p.dateISO === '2026-11-06');
  return pt?.eventIds.length === 2 && Math.abs((pt?.inflows ?? 0) - (1500 + 5286.645)) < 0.005;
})());

// Guard coherence.
check('OE20 a caveated GROSS+UNKNOWN pair passes the numerical guard', (() => {
  const f = oeConv(U('I get a $15,500 gross bonus on October 15. I get a $1,500 payout on October 15.',
    FD)).forecast as CashForecast;
  return detectUnlicensedForecastArithmetic(
    'You have a $15,500 gross bonus and a $1,500 payout, neither counted as cash '
    + 'until the net basis is established.', f).length === 0
    && detectUnlicensedForecastArithmetic(
      'You will receive a total of $17,000 in October.', f).length === 1;
})());

check('OE21 no parallel event model was created — FORECAST-3 owns the type',
  /type FutureCashEvent/.test(read('lib/ai/forecast/assemble.ts'))
  && !/interface \w*Event\b/.test(read('lib/ai/forecast/statements.ts')));

// ═══════════════════════════════════════════════════════════════════════════
// PD. CAPABILITY-SCOPED PAY DATES (FORECAST-16)
// ═══════════════════════════════════════════════════════════════════════════

const pd = (q: string) => resolvePayDates(STREAMS, AS_OF, q);
const pdRender = (q: string) => renderPayDates(pd(q)).join('\n');
const vecDates = (q: string) => pd(q).streams.find((s) => s.sourceKey === 'vectrus')!.dates;

// A/E — singular.
eq('PD1 "when is my next paycheck" returns ONE occurrence',
  vecDates('When is my next paycheck?'), ['2026-08-28']);
eq('PD2 "when should my next check hit" is the same authority',
  vecDates('When should my next check hit?'), ['2026-08-28']);
eq('PD3 "when do I get paid next" too', vecDates('When do I get paid next?'), ['2026-08-28']);

// B/D — an explicit horizon bounds the set exactly.
eq('PD4 "over the next 3 months" returns all and only the licensed occurrences',
  vecDates('When do my paychecks land over the next 3 months?'),
  ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20']);
eq('PD5 "through December" is calendar-bounded',
  vecDates('Show my pay dates through December.').at(-1), '2026-12-18');
eq('PD6 "next 90 days" is day-bounded',
  vecDates('What are my pay dates over the next 90 days?').at(-1), '2026-11-20');

// C — the default, which is NOT the cash-forecast horizon.
eq('PD7 "upcoming pay dates" with no period returns a bounded set of 5',
  vecDates('What are my upcoming pay dates?').length, 5);
check('PD8 and that default is an OCCURRENCE cap, not the 3-month cash horizon',
  vecDates('What are my upcoming pay dates?').length
    !== vecDates('When do my paychecks land over the next 3 months?').length);

// F/G — stream safety.
eq('PD9 the SILENT Abacus stream contributes NO dates',
  pd('What are my upcoming pay dates?').streams.find((s) => s.sourceKey === 'abacus')!.dates, []);
check('PD10 and says why, without exposing a mechanical schedule', (() => {
  const t = pdRender('What are my upcoming pay dates?');
  return /Abacus: no expected dates \(SILENT/i.test(t)
    // the SILENT stream's own dates must not appear anywhere
    && !/Abacus[^\n]*(?:September|October|November)/i.test(t);
})(), pdRender('What are my upcoming pay dates?'));
check('PD11 an unknown cadence yields nothing invented', (() => {
  const noCadence = [{ ...VECTRUS, cadence: { kind: 'UNKNOWN', reason: 'x', evidence: { observations: 2 } },
    activity: { ...VECTRUS.activity, mayGenerateExpectedOccurrences: false } }] as unknown as typeof STREAMS;
  const r = resolvePayDates(noCadence, AS_OF, 'What are my upcoming pay dates?');
  return r.empty && /cannot be established/i.test(renderPayDates(r).join('\n'));
})());
check('PD12 every date comes from FORECAST-2\'s generator, none from this module',
  /expectedOccurrencesBetween\(/.test(read('lib/ai/forecast/pay-dates.ts'))
  && !/occurrencesBetween\(|addDays|\+ 14|biweekly/i.test(
    read('lib/ai/forecast/pay-dates.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .replace(/expectedOccurrencesBetween/g, 'GEN')));

// H — two eligible streams keep their identity.
check('PD13 two CURRENT streams stay distinguishable, never merged', (() => {
  const two = [VECTRUS, { ...ABACUS, projectionEligible: true,
    activity: { ...ABACUS.activity, mayGenerateExpectedOccurrences: true } }] as unknown as typeof STREAMS;
  const r = resolvePayDates(two, AS_OF, 'What are my upcoming pay dates?');
  return r.streams.length === 2 && r.streams.every((s) => s.dates.length > 0)
    && new Set(r.streams.map((s) => s.sourceKey)).size === 2;
})());

// ⚠️ A CASH-FORECAST REQUEST IS NEVER THIS CAPABILITY, whatever pay nouns it
// carries. Measured: "Assume my paycheck is net … forecast my cash for the next
// 3 months" routed here and four acceptance scenarios lost their forecast.
for (const q of ['Forecast my cash for the next 3 months. Assume my paycheck is net.',
  'That paycheck is take-home. Now forecast my cash for the next 3 months.',
  'My Vectrus paycheck is $5,286.645 take-home. Forecast my cash for the next 3 months.',
  'What will my cash look like over the next 3 months?']) {
  eq(`PD13a a cash request is not a pay-date question: "${q.slice(0, 40)}"`,
    detectPayDateAsk(q), null);
}

// I/J — questions that must NOT enter the capability.
for (const q of ['What was my last paycheck?', 'How much was my paycheck?',
  'How much do I make?', 'Show my income.', 'Why was my paycheck lower?']) {
  eq(`PD14 "${q}" is not a pay-date question`, detectPayDateAsk(q), null);
}

// Rendering — the capability and nothing else.
const pdText = pdRender('When do my paychecks land over the next 3 months?');
check('PD15 the block renders the dates', /September 11, September 25/.test(pdText), pdText);
check('PD16 and renders NO cash-forecast furniture',
  !/Ending cash|REFUSED|Opening cash|discretionary|obligation|investment/i.test(pdText), pdText);
check('PD17 and does not promise', /not guarantees/.test(pdText));
check('PD18 nor states an amount', !/\$|USD/.test(pdText), pdText);
eq('PD19 the block is a fraction of a forecast section',
  Math.ceil(pdText.length / 4) < 200, true);

// ═══════════════════════════════════════════════════════════════════════════
// NG. THE NUMERICAL RESPONSE BOUNDARY (FORECAST-14)
// ═══════════════════════════════════════════════════════════════════════════

const ngD = assembleForecast({ ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
  question: 'Show me a scenario where I spend $10,000 a month over the next 3 months.' })
  .forecast as CashForecast;
const ngB = assembleForecast({ ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
  question: 'Forecast my cash for the next 3 months. Assume I spend $4,000/month and assume my paycheck is net.' })
  .forecast as CashForecast;
const detect = (reply: string, f: CashForecast) =>
  detectUnlicensedForecastArithmetic(reply, f).map((x) => x.kind);

// ── True positives: the measured failures ─────────────────────────────────
eq('NG1 the D premise echo is caught',
  detect('Assuming you spend $10,000 a month, total spending would amount to $30,000.', ngD),
  ['UNLICENSED_PRODUCT']);
eq('NG2 including when the operand is absent and only a label carries the claim',
  detect('- **Known Outflows**: $30,000\n- **Opening Cash**: $10,228.74', ngD),
  ['UNLICENSED_CASH_CLAIM']);
eq('NG3 the I stale-assumption product is caught',
  detect('Known outflows: $12,000.00 (assuming $4,000/month for 3 months).', ngB),
  ['UNLICENSED_PRODUCT']);
eq('NG4 an ending balance over a REFUSED path is caught, even from a licensed figure',
  detect('Ending Cash: $10,228.74', ngD), ['ENDING_CASH_OVER_REFUSAL']);
eq('NG5 a GROSS amount claimed as arriving is caught', (() => {
  const grossBonus: FutureCashEvent = {
    id: 'bonus', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
    timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
    amount: { value: 15500, currency: 'USD', basis: AmountBasis.GROSS,
      provenance: EventProvenance.USER_ASSERTED },
  };
  const g = assembleForecast({ ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
    question: 'Forecast my cash.', additionalEvents: [grossBonus] }).forecast as CashForecast;
  return detect('You will receive $15,500 in October.', g);
})(), ['UNLICENSED_CASH_CLAIM']);

// ── False positives: everything that must remain expressible ──────────────
eq('NG6 a correct assumption-dependent answer is clean',
  detect('Assuming $4,000/month spending and treating your paycheck as take-home, '
    + 'your ending cash would be $35,144.66, starting from $10,228.74.', ngB), []);
eq('NG7 a hedged approximation of a licensed figure is clean',
  detect('Your ending cash would be roughly $35,000.', ngB), []);
eq('NG8 historical figures in a mixed answer are out of scope entirely',
  detect('### Spending Over the Last 3 Months\n- **Total Spending:** $25,048.98\n'
    + '- **Average Monthly Spending:** $8,349.66\n### Cash Position Over the Next 3 Months\n'
    + '- **Current Cash:** $10,228.74', ngB), []);
eq('NG9 dates, counts and percentages are never read as money claims',
  detect('You have 7 pay dates: 2026-09-11, 2026-09-25, 2026-10-09 — 92 days, 0.16% spread.', ngD),
  []);
eq('NG10 a not-cash amount stated WITH its caveat is the licence working',
  detect('Known future inflows: $37,006.51 (not counted as cash, the net basis is unknown).', ngD),
  []);
// FORECAST-15 — a measured false positive that redaction turned into a real
// cost: a clean answer naming the user's investment values had all three
// figures deleted. Investments are CF-7's authority; this boundary is about
// forecast CASH.
eq('NG11a legitimate investment values are out of scope',
  detect('Your investments are currently worth a total of $24,021.19, which includes '
    + '$5,006.56 in traditional investments and $19,014.63 in digital assets.', ngB), []);
eq('NG11b but claiming they are spendable is still a cash claim',
  detect('Your crypto gives you $19,014.63 available to spend.', ngB),
  ['UNLICENSED_CASH_CLAIM']);
eq('NG11c including when the claim follows the figure',
  detect('You have $24,021.19 in liquid investments you can spend.', ngB),
  ['UNLICENSED_CASH_CLAIM']);
// FORECAST-15 — three false-positive mechanisms found by auditing every guard
// detection against a scorer-clean reply, not by reasoning about the patterns.
eq('NG11d a rate framed BEFORE the figure is still a rate',
  detect('Assuming a monthly spending of $4,000 and that your paycheck is net.', ngB), []);
eq('NG11e a historical window written in words is still historical',
  detect('Over the last three months, your total spending was $25,048.98.', ngB), []);
eq('NG11f markdown emphasis does not sever a figure from its period marker',
  detect('You have projected income of **$11,454.40** per month.', ngB), []);
eq('NG11g while an invented sum presented as inflows is still caught',
  detect('You have known inflows totaling $54,006.52.', ngB), ['UNLICENSED_CASH_CLAIM']);
eq('NG11 a rate mention is never a balance claim',
  detect('Your ending cash reflects $4,000/month of spending.', ngB), []);

// ── Redaction ─────────────────────────────────────────────────────────────
check('NG12 redaction removes the claim and keeps the rest', (() => {
  const bad = 'Opening cash is $10,228.74.\n- **Total Spending**: $30,000\nYour situation is stable.';
  const out = redactUnlicensed(bad, detectUnlicensedForecastArithmetic(bad, ngD), ngD);
  return !/30,000/.test(out) && /10,228\.74/.test(out) && /situation is stable/.test(out)
    && detectUnlicensedForecastArithmetic(out, ngD).length === 0;
})(), redactUnlicensed('Opening cash is $10,228.74.\n- **Total Spending**: $30,000\nYour situation is stable.',
  detectUnlicensedForecastArithmetic('Opening cash is $10,228.74.\n- **Total Spending**: $30,000\nYour situation is stable.', ngD), ngD));
check('NG13 and restores the refusal if the redaction removed it', (() => {
  const bad = 'Total spending is $30,000, so ending cash cannot be stated.';
  const out = redactUnlicensed(bad, detectUnlicensedForecastArithmetic(bad, ngD), ngD);
  return /cannot be stated/.test(out) && !/30,000/.test(out);
})());
check('NG14 and restores the assumptions an assumption-dependent figure rests on', (() => {
  const bad = 'Known outflows: $12,000 for 3 months at $4,000/month. Ending cash: $35,144.66.';
  const out = redactUnlicensed(bad, detectUnlicensedForecastArithmetic(bad, ngB), ngB);
  return /rests on/.test(out) && /35,?144\.66/.test(out) && !/12,000/.test(out);
})(), redactUnlicensed('Known outflows: $12,000 for 3 months at $4,000/month. Ending cash: $35,144.66.',
  detectUnlicensedForecastArithmetic('Known outflows: $12,000 for 3 months at $4,000/month. Ending cash: $35,144.66.', ngB), ngB));

// ── Architecture ──────────────────────────────────────────────────────────
check('NG15 the licence is built from the TYPED result, never from the rendered prose',
  !/explainForecast|describeOperatingState|split\('\\n'\)/.test(
    read('lib/ai/forecast/numerical-guard.ts')
      .match(/export function licensedFigures[\s\S]*?\n\}/)?.[0] ?? ''));
check('NG16 it introduces no forecast arithmetic — every figure is a field or a sum of fields',
  !/\*|\/(?!\*|\/)/.test(
    (read('lib/ai/forecast/numerical-guard.ts')
      .match(/export function licensedFigures[\s\S]*?\n\}/)?.[0] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .replace(/dailyRate \* f\.horizonDays/, 'RATE_TIMES_DAYS')),
  'only the engine\'s own rate x horizon appears, and it is the figure the engine prints');
eq('NG17 enforcement is never silently on', resolveForecastGuardMode(undefined), 'shadow');
check('NG18 the boundary is gated on a forecast existing at all', (() => {
  // The gate moved into for-request.ts when the route hit its 700-line ceiling;
  // the claim is unchanged — a non-forecast turn returns the reply untouched.
  const src = read('lib/ai/forecast/for-request.ts');
  return /if \(!forecast \|\| 'refused' in forecast\.forecast\) return \{ reply, outcome: 'none' \};/
    .test(src);
})(), read('lib/ai/forecast/for-request.ts')
  .match(/export async function guardForecastAnswer[\s\S]{0,400}/)?.[0] ?? 'NOT FOUND');

// ═══════════════════════════════════════════════════════════════════════════
// FC. FACT CONTINUITY (FORECAST-13)
// ═══════════════════════════════════════════════════════════════════════════
//
// The FORECAST-12 blocker, and the semantics that had to stay intact around it:
// a FACT survives the turn it was stated in, a SUPPOSITION does not, and
// neither may be guessed at.

const conv = (msgs: { role: string; content: string }[]) => assembleForecast({
  ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
  question: msgs.filter((m) => m.role === 'user').at(-1)!.content, messages: msgs,
});
const FQ = 'Forecast my cash for the next 3 months.';
const st = (r: ReturnType<typeof conv>) => (r.forecast as { fullCashPath?: { status: string } })
  .fullCashPath?.status;
const userAssumptions = (r: ReturnType<typeof conv>) =>
  r.policy.assumptions.filter((a) => a.origin === AssumptionOrigin.USER_REQUESTED).length;

// A — the measured FORECAST-12 sequence, end to end.
const A13 = conv(U(FQ, 'No — $5,286.645 is take-home. And my normal spending is $4,000 a month.',
  'Forecast it again.'));
eq('FC1 the correction survives the turn and BOTH facts reach the authorities',
  A13.appliedFacts.length, 2);
eq('FC2 spending is ASSERTABLE', A13.state.discretionaryBaseline.state, ComponentState.ASSERTABLE);
eq('FC3 the Vectrus basis is NET',
  A13.state.incomeStreams.find((x) => x.sourceKey === 'vectrus')!.basis, AmountBasis.NET);
eq('FC4 and the cash path is FACTUALLY_LICENSED', st(A13), ConclusionStatus.FACTUALLY_LICENSED);
eq('FC5 with no assumption involved', userAssumptions(A13), 0);

// B — a fact stated on a turn that asked for nothing.
eq('FC6 a fact survives an unrelated turn',
  conv(U('My normal spending is $4,000/month.', 'Thanks, that helps.', FQ)).appliedFacts.length, 1);

// C — a supposition does not.
eq('FC7 a supposition from an earlier turn does NOT survive', (() => {
  const r = conv(U('Assume I spend $4,000/month.', FQ));
  return [r.appliedFacts.length, userAssumptions(r), r.state.discretionaryBaseline.state];
})(), [0, 0, ComponentState.UNKNOWN]);

// D — supersession.
check('FC8 a correction supersedes deterministically — latest wins, none averaged', (() => {
  const r = conv(U('My normal spending is $4,000/month.', 'Actually make that $5,000.', FQ));
  return r.state.discretionaryBaseline.amount === 5000
    && r.facts.superseded.length === 1
    && (r.facts.superseded[0] as { amount: number }).amount === 4000;
})(), JSON.stringify(conv(U('My normal spending is $4,000/month.', 'Actually make that $5,000.', FQ))
  .facts));

// E/F — both basis phrasings, including the one FORECAST-12 could not parse.
for (const [id, said] of [['FC9', 'My paycheck is $5,286.645 take-home.'],
  ['FC10', '$5,286.645 is take-home.'], ['FC11', 'That $5,286.645 amount is net.']] as const) {
  eq(`${id} "${said}" establishes NET on the right stream`,
    conv(U(said, FQ)).state.incomeStreams.find((x) => x.sourceKey === 'vectrus')!.basis,
    AmountBasis.NET);
}

// G — ambiguity fails closed, three ways, each with a stated reason.
const TWIN = [VECTRUS, { ...ABACUS, projectionEligible: true,
  activity: { ...ABACUS.activity, mayGenerateExpectedOccurrences: true },
  amount: { ...(ABACUS.amount as object), value: 5286.645 } }] as unknown as typeof STREAMS;
const TWO = [VECTRUS, { ...ABACUS, projectionEligible: true,
  activity: { ...ABACUS.activity, mayGenerateExpectedOccurrences: true } }] as unknown as typeof STREAMS;
for (const [id, said, streams, why] of [
  ['FC12', '$5,286.645 is take-home.', TWIN, /share an amount/],
  ['FC13', 'My paycheck is take-home.', TWO, /names no amount/],
  ['FC14', '$9,999.00 is take-home.', STREAMS, /no income stream has an established amount/],
] as const) {
  check(`${id} ambiguity attaches nothing and says why`, (() => {
    const f = resolveAssertedFacts(U(said), AS_OF, streams);
    return f.basis.length === 0 && f.ambiguous.length === 1 && why.test(f.ambiguous[0].reason);
  })());
}

// H — assistant prose is not authority.
check('FC15 nothing the ASSISTANT said can create a fact', (() => {
  const f = resolveAssertedFacts([
    { role: 'assistant', content: 'Your paycheck is take-home and you spend $4,000 a month.' },
    { role: 'user', content: FQ }], AS_OF, STREAMS);
  return f.spending === null && f.basis.length === 0;
})());
check('FC16 and that is a property of the scan, not a rule to remember',
  /messages\.filter\(\(m\) => m\.role === 'user'\)/.test(read('lib/ai/forecast/fact-continuity.ts')));

// I/J — a hypothetical does not mutate the fact, and does not outlive its turn.
check('FC17 a hypothetical over a stated fact leaves the fact intact', (() => {
  const r = conv(U('My normal spending is $4,000 a month.', 'What if it were $10,000?'));
  return r.state.discretionaryBaseline.amount === 4000 && userAssumptions(r) === 1;
})());
check('FC18 and the next forecast returns to the factual baseline', (() => {
  const r = conv(U('My normal spending is $4,000 a month.', 'What if it were $10,000?', FQ));
  return r.state.discretionaryBaseline.amount === 4000 && userAssumptions(r) === 0;
})());

check('FC19 no store was introduced — facts are re-derived, as CF-4 does with scope',
  !/db\.|prisma|localStorage|cache|Map<string, AssertedFacts>/.test(
    read('lib/ai/forecast/fact-continuity.ts')));

// ═══════════════════════════════════════════════════════════════════════════
// FS. HISTORICAL SUPPRESSION IS QUERY-SENSITIVE (FORECAST-11A)
// ═══════════════════════════════════════════════════════════════════════════

const planFor = (q: string) => plan(q);

eq('FS1 a forecast-only question withholds the historical spending mean',
  suppressHistoricalSpending(planFor(FORECAST_Q), true), true);
eq('FS2 a historical+forecast comparison keeps it — the user asked for it',
  suppressHistoricalSpending(planFor(BOTH_Q), true), false);
eq('FS3 "use my recent spending" keeps it too — the question names the history',
  suppressHistoricalSpending(
    planFor('What will my cash look like over the next 3 months? Use my recent spending if you need to.'),
    true), false);
eq('FS4 a non-forecast question is untouched',
  suppressHistoricalSpending(planFor('What did I spend last month?'), false), false);
eq('FS5 it fails OPEN with no plan', suppressHistoricalSpending(undefined, true), false);
check('FS6 the decision is the planner\'s, not a second copy of it', (() => {
  const body = read('lib/ai/prompts/system-prompt.ts')
    .match(/export function suppressHistoricalSpending\([\s\S]*?\n\}/)?.[0] ?? '';
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return /TRANSACTIONS_SUMMARY/.test(code) && /NeedLevel\.NOT_NEEDED/.test(code)
    && !/Concepts\.|RE\.test|match\(/.test(code);
})(), read('lib/ai/prompts/system-prompt.ts')
  .match(/export function suppressHistoricalSpending\([\s\S]*?\n\}/)?.[0] ?? 'NOT FOUND');
check('FS7 the withheld line explains itself rather than leaving a hole',
  /Est\. monthly spending: WITHHELD for this question/.test(
    read('lib/ai/prompts/assessment-serializer.ts')));

// ═══════════════════════════════════════════════════════════════════════════
// HF2. HARNESS FIDELITY (FORECAST-12 §7)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ A HARNESS THAT BUILDS A DIFFERENT PROMPT MEASURES A DIFFERENT PRODUCT, and
// this one has already done it twice: `plan: undefined` meant every FORECAST-11
// number was taken against a prompt production never builds, and the missing
// coverage envelope was found the same way. Both are pinned here rather than
// re-discovered.

const harness = read('scripts/check-forecast-conformance.ts');
const route = read('app/api/ai/chat/route.ts');

check('HF2a the harness passes a real retrieval plan, not undefined',
  /planRetrieval\(\{/.test(harness) && /question, plan,/.test(harness));
check('HF2b a real coverage envelope',
  /ENVELOPE, question, plan,/.test(harness));
check('HF2b1 and the capability surfaces, exclusively — a pay-date question '
  + 'builds no forecast, which is the seam under test',
  /payDates \? undefined : forecast, payDates\)/.test(harness));
check('HF2c a real assembled forecast', /assembleForecast\(\{/.test(harness));
check('HF2d and the same doctrine injection, because it builds the real prompt',
  /buildSpaceSystemPrompt\(/.test(harness) && !/FORECAST_DOCTRINE/.test(harness));
check('HF2e the model and sampling parameters mirror the provider',
  /const PRODUCTION_MODEL = 'gpt-4o-mini'/.test(harness)
  && /const TEMPERATURE = 0\.3/.test(harness)
  && /const MAX_TOKENS = 1024/.test(harness)
  && /const CHAT_MODEL = 'gpt-4o-mini'/.test(read('lib/ai/provider.ts')));
// ⚠️ The harness omits `payDates` deliberately: it measures the cash-forecast
// surface, and FORECAST-16's capability has its own acceptance path. The shape
// is pinned up to that argument so a drift in the shared arguments still fails.
check('HF2f the route and the harness call the prompt builder with the same shape',
  /buildSpaceSystemPrompt\(\s*ctx, assessment, intentRoute, debtPayments, envelopeForPrompt,\s*latestUserMessage\(messages\), shadowPlan, forecast, payDates\)/.test(
    route.replace(/\n\s+/g, ' ').replace(/ +/g, ' ').replace('systemPrompt = ', '')),
  route.match(/buildSpaceSystemPrompt\([\s\S]{0,180}/)?.[0] ?? 'NOT FOUND');

// ═══════════════════════════════════════════════════════════════════════════
// J. ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════════════

const assembleSrc = read('lib/ai/forecast/assemble.ts');
// A CALL, not a mention: the word appears in prose in two comments.
const engineCallers = execSync(
  'grep -rl "forecastCash(" lib app components jobs scripts 2>/dev/null || true',
  { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  .filter((f) => !f.startsWith('lib/forecast/') && !f.endsWith('.test.ts'));
eq('J1 exactly one production caller of forecastCash outside lib/forecast',
  engineCallers, ['lib/ai/forecast/assemble.ts']);
/** Comments, strings and import paths removed — `periodic-amount` is not division. */
const adapterCode = assembleSrc
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  .split('\n').filter((l) => !l.trimStart().startsWith('import') && !l.includes("from '"))
  .join('\n').replace(/'[^']*'/g, "''");
check('J2 the adapter performs no money arithmetic of its own',
  !/[-+*/]\s*(?:amount|value|total|balance|closing)\b|\.length\s*\*/.test(adapterCode),
  adapterCode.match(/.{0,40}[-+*/]\s*(?:amount|value|total|balance)\b/)?.[0]);
check('J3 it builds no second state object — FORECAST-7 composes it',
  /composeOperatingState\(/.test(assembleSrc)
  && !/interface \w*State\b/.test(assembleSrc));
check('J4 events come only through the licensed periodic seam',
  /periodicCashEvents\(/.test(assembleSrc)
  && !/RecurringCandidate|recurringCandidates|merchants\b|incomeSources/.test(assembleSrc));
check('J5 the DB read is confined to streams.ts',
  !/queryTransactions|db\./.test(assembleSrc)
  && /queryTransactions/.test(read('lib/ai/forecast/streams.ts')));
check('J6 lib/forecast gained no production dependency',
  execSync('grep -rl "@/lib/ai\\|@/lib/data\\|@/lib/db" lib/forecast 2>/dev/null || true',
    { encoding: 'utf8' }).trim() === '');
// ⚠️ PRODUCTION MODULES ONLY. FORECAST-10 restates nine isolation GATES in the
// forecast test files — each said "no consumer outside lib/forecast", which was
// true until this slice deliberately added one — so the tree under lib/forecast
// is not byte-identical and should not be. Not one line of forecast ARITHMETIC
// or LICENSING moved, which is the claim that matters.
// ⚠️ FORECAST-11 EDITS ONE PRODUCTION MODULE, AND ONLY ITS SERIALIZER.
// `explainForecast` gained three things the real model proved it needed: the
// accrued spending total (it was multiplying the rate itself), the stated total
// of amounts excluded from cash (it was adding them), and a refusal that says
// what a refusal forbids. Not one line of arithmetic or licensing moved — the
// engine's own 144 assertions, including all 16 mutations, are unchanged.
// ⚠️ TWO FILES, AND WHAT EACH GAINED. FORECAST-14 extended `engine.ts`'s
// SERIALIZER (three figures the model was otherwise inventing). FORECAST-17
// extended `policy.ts`'s STATEMENT VOCABULARY — one `StatementSubject` member,
// one `FactAuthority` value, one routing case — so a user-named one-off event
// has somewhere typed to go. Neither touched arithmetic or licensing, which is
// the claim this gate exists to hold and which J7a and J7b pin directly.
// ⚠️ PROJECTION-1 ADDS A SECOND PATH, so a FILE LIST stopped being the useful
// claim. `future-cash-event.ts` gained a second cash gate and `periodic-amount.ts`
// carries a marker to it; two new modules hold the projection's own arithmetic.
// What must still be true — and is now pinned directly, rather than inferred
// from which files were touched — is that the FACTUALLY_LICENSED path did not
// move: `netCashContribution` and `forecastCash` are byte-identical to baseline.
// A weaker second path is only safe while the first one is exactly as strict.
check('J7 the licensed path is untouched — netCashContribution is byte-identical',
  (() => {
    const body = (src: string) => {
      const i = src.indexOf('export function netCashContribution');
      return i < 0 ? null : src.slice(i, src.indexOf('\n}', i));
    };
    const base = execSync('git show 714d099:lib/forecast/future-cash-event.ts', { encoding: 'utf8' });
    const now  = readFileSync(join(ROOT, 'lib/forecast/future-cash-event.ts'), 'utf8');
    return body(base) !== null && body(base) === body(now);
  })());
check('J7-0 and forecastCash itself is byte-identical',
  (() => {
    const body = (src: string) => {
      const i = src.indexOf('export function forecastCash');
      return i < 0 ? null : src.slice(i, src.indexOf('\n}', i));
    };
    const base = execSync('git show 714d099:lib/forecast/engine.ts', { encoding: 'utf8' });
    const now  = readFileSync(join(ROOT, 'lib/forecast/engine.ts'), 'utf8');
    return body(base) !== null && body(base) === body(now);
  })());
check('J7b and policy.ts gained no arithmetic and no new licensing rule', (() => {
  const d = execSync('git diff -U0 714d099 -- lib/forecast/policy.ts', { encoding: 'utf8' })
    .split('\n').filter((l) => /^\+/.test(l) && !/^\+\+\+/.test(l))
    .filter((l) => !/^\+\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n');
  // No new REQUIRES entry, no new conclusion, no money arithmetic.
  return !/REQUIRES|Conclusion\.|conclusionLicence|[-+*/]\s*(?:amount|value|closing)/.test(d);
})(), execSync('git diff --stat 714d099 -- lib/forecast/policy.ts', { encoding: 'utf8' }).trim());
check('J7a and the engine change is confined to explainForecast',
  execSync('git diff -U0 714d099 -- lib/forecast/engine.ts', { encoding: 'utf8' })
    .split('\n').filter((l) => /^@@/.test(l))
    .every((h) => Number(/@@ -(\d+)/.exec(h)?.[1] ?? 0) > 420),
  execSync('git diff -U0 714d099 -- lib/forecast/engine.ts', { encoding: 'utf8' })
    .split('\n').filter((l) => /^@@/.test(l)).join(' '));
check('J8 no UI, schema or model configuration changed',
  execSync('git diff --name-only 714d099 -- components/ app/\\(dashboard\\) prisma/ 2>/dev/null || true',
    { encoding: 'utf8' }).trim() === '');

// ═══════════════════════════════════════════════════════════════════════════
// K. TOKEN MODEL
// ═══════════════════════════════════════════════════════════════════════════

const R0 = 11065;
const sizes = {
  A: tok(renderForecastSection(A).join('\n')),
  B: tok(renderForecastSection(B).join('\n')),
  C: tok(renderForecastSection(C).join('\n')),
  D: tok(renderForecastSection(D).join('\n')),
};
for (const [n, t] of Object.entries(sizes)) {
  check(`K1 trace ${n}: forecast context within the 1,300-token ceiling`, t <= 1300, `${t} tokens`);
  check(`K2 trace ${n}: and preserves refusal/provenance semantics`,
    /=== FORECAST ===/.test(renderForecastSection({ A, B, C, D }[n as 'A']).join('\n')));
}
check('K3 the forecast-only context is an order of magnitude under R0',
  Math.max(...Object.values(sizes)) < R0 / 5, JSON.stringify(sizes));

console.log(`\n  FORECAST CONTEXT TOKENS  A=${sizes.A} B=${sizes.B} C=${sizes.C} D=${sizes.D}`
  + `  (R0 baseline ${R0})`);

// ═══════════════════════════════════════════════════════════════════════════
// M. MUTATION TESTING
// ═══════════════════════════════════════════════════════════════════════════

let seq = 0;
const written: string[] = [];
const cleanup = () => { for (const f of written) if (existsSync(f)) unlinkSync(f); written.length = 0; };
process.on('exit', cleanup);

async function mutate(
  name: string, file: string, find: string, replace: string,
  assertion: (m: Record<string, unknown>) => boolean,
): Promise<void> {
  const abs = join(ROOT, file);
  const src = readFileSync(abs, 'utf8');
  if (!src.includes(find)) { check(`${name} [anchor]`, false, `anchor not found in ${file}`); return; }
  const mutantRel = file.replace(/\.ts$/, `.__mutant${++seq}__.ts`);
  const mutantAbs = join(ROOT, mutantRel);
  // Relative imports stay valid: the mutant sits beside its original.
  writeFileSync(mutantAbs, src.replace(find, replace), 'utf8');
  written.push(mutantAbs);
  try {
    const m = await import(mutantAbs) as Record<string, unknown>;
    let survived: boolean;
    try { survived = assertion(m); } catch { survived = false; }
    check(name, !survived, 'the mutant passed — the test does not actually pin this');
  } finally { cleanup(); }
}

type PlanFn = typeof planRetrieval;
type AssembleFn = typeof assembleForecast;
type RenderFn = typeof renderForecastSection;
type ExtractFn = typeof extractForecastStatements;

async function mutations(): Promise<void> {
  await mutate('M1 a forecast query resolving no concept is caught',
    'lib/ai/retrieval-plan.ts',
    '  if ((FORECAST_VERB_RE.test(question) || FORECAST_PHRASE_RE.test(question))',
    '  if (false && (FORECAST_VERB_RE.test(question) || FORECAST_PHRASE_RE.test(question))',
    (m) => (m.planRetrieval as PlanFn)({
      messages: [{ role: 'user', content: FORECAST_Q }], envelope, now: NOW,
    }).concepts.includes(Concepts.FORECAST));

  await mutate('M2 serializing snapshot history for a forecast query is caught',
    'lib/ai/retrieval-plan.ts',
    `  } else if (has(Concepts.FORECAST)) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.NOT_NEEDED,`,
    `  } else if (has(Concepts.FORECAST)) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.REQUIRED,`,
    (m) => (m.planRetrieval as PlanFn)({
      messages: [{ role: 'user', content: FORECAST_Q }], envelope, now: NOW,
    }).domains.find((d) => d.domain === FinanceDomains.SNAPSHOT_HISTORY)!.need === NeedLevel.NOT_NEEDED);

  await mutate('M3 serializing transaction analysis for a forecast query is caught',
    'lib/ai/retrieval-plan.ts',
    `  } else if (has(Concepts.FORECAST)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.NOT_NEEDED,`,
    `  } else if (has(Concepts.FORECAST)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.SUPPORTING,`,
    (m) => (m.planRetrieval as PlanFn)({
      messages: [{ role: 'user', content: FORECAST_Q }], envelope, now: NOW,
    }).domains.find((d) => d.domain === FinanceDomains.TRANSACTIONS_SUMMARY)!.need
      === NeedLevel.NOT_NEEDED);

  await mutate('M4 not calling the engine is caught',
    'lib/ai/forecast/assemble.ts',
    '  const forecast = forecastCash(state, events, policy);',
    "  const forecast = { refused: true as const, reason: 'x' } as never;",
    (m) => !('refused' in (m.assembleForecast as AssembleFn)({
      ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: FORECAST_Q }).forecast));

  await mutate('M5 omitting the forecast status from the model context is caught',
    'lib/ai/forecast/render.ts',
    "    lines.push('RESULT', ...explainForecast(a.forecast));",
    "    lines.push('RESULT', 'see above');",
    (m) => /REFUSED/.test((m.renderForecastSection as RenderFn)(A).join('\n')));

  await mutate('M6 erasing assumption provenance is caught',
    'lib/ai/forecast/assemble.ts',
    '    assumptions.push({ ...st.routing.assumption, id: `p${n++}` });',
    "    assumptions.push({ ...st.routing.assumption, id: `p${n++}`, statedAs: '', origin: 'SYSTEM_POLICY' });",
    (m) => (m.assembleForecast as AssembleFn)({
      ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
      question: 'Assume I spend $4,000/month.' })
      .policy.assumptions.some((a) => a.origin === 'USER_REQUESTED' && a.statedAs.length > 0));

  await mutate('M7 routing an asserted fact as an assumption is caught',
    'lib/ai/forecast/statements.ts',
    '  if (SCENARIO_RE.test(sentence)) return StatementMode.REQUESTS_SCENARIO;',
    '  return StatementMode.REQUESTS_ASSUMPTION;\n  if (SCENARIO_RE.test(sentence)) return StatementMode.REQUESTS_SCENARIO;',
    (m) => (m.extractForecastStatements as ExtractFn)(
      'My normal spending is $4,000/month.', AS_OF, 'vectrus')[0]
      ?.routing.destination === 'UPSTREAM_AUTHORITY');

  await mutate('M8 routing a hypothetical as a fact is caught',
    'lib/ai/forecast/statements.ts',
    '  if (ASSUME_RE.test(sentence)) return StatementMode.REQUESTS_ASSUMPTION;',
    '  if (false) return StatementMode.REQUESTS_ASSUMPTION;',
    (m) => (m.extractForecastStatements as ExtractFn)(
      'Assume I spend $4,000/month.', AS_OF, 'vectrus')[0]
      ?.routing.destination === 'FORECAST_POLICY');

  await mutate('M9 including SILENT Abacus events is caught',
    'lib/ai/forecast/assemble.ts',
    '      s.activity, s.cadence, amount, horizon.fromISO, horizon.toISO, s.role,',
    '      { ...s.activity, mayGenerateExpectedOccurrences: true },\n      s.cadence, amount, horizon.fromISO, horizon.toISO, s.role,',
    (m) => {
      const r = (m.assembleForecast as AssembleFn)({
        ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: FORECAST_Q });
      return !('refused' in r.forecast)
        && r.forecast.events.every((e) => !e.id.startsWith('abacus'));
    });

  await mutate('M10 promoting the activity licence in the state is caught',
    'lib/ai/forecast/assemble.ts',
    '      projectionEligible: s.activity.mayGenerateExpectedOccurrences,',
    '      projectionEligible: true,',
    (m) => (m.assembleForecast as AssembleFn)({
      ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: FORECAST_Q })
      .state.incomeStreams.find((s) => s.sourceKey === 'abacus')!.projectionEligible === false);

  await mutate('M11 deriving a spending baseline in the adapter is caught',
    'lib/ai/forecast/assemble.ts',
    "      : { assertable: false, reason: 'no current-normal spending level is established from available evidence' },",
    '      : { assertable: true, amount: 8349.66, periodBasis: PeriodBasis.MONTHLY, currency: \'USD\', reason: \'trailing average\' },',
    (m) => (m.assembleForecast as AssembleFn)({
      ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: FORECAST_Q })
      .state.discretionaryBaseline.state === ComponentState.UNKNOWN);

  await mutate('M12 giving a non-forecast query a forecast concept is caught',
    'lib/ai/retrieval-plan.ts',
    '    out.push(Concepts.FORECAST);',
    '  }\n  if (true) {\n    out.push(Concepts.FORECAST);',
    (m) => !(m.planRetrieval as PlanFn)({
      messages: [{ role: 'user', content: 'What did I spend last month?' }], envelope, now: NOW,
    }).concepts.includes(Concepts.FORECAST));

  await mutate('M13 a refused forecast falling back to a generic projection is caught',
    'lib/ai/forecast/render.ts',
    "      'Do not estimate a cash path from balances, averages or trends. State that it is unavailable.',",
    "      'Estimate a cash path from the balances and trend above.',",
    (m) => /Do not estimate a cash path/.test((m.renderForecastSection as RenderFn)(
      { ...A, unavailable: 'no accounts' }).join('\n')));

  await mutate('M14 dropping crypto from the operating state is caught',
    'lib/ai/forecast/assemble.ts',
    '    investments: acc ? composeInvestments(acc) : null,',
    '    investments: null,',
    (m) => (m.assembleForecast as AssembleFn)({
      ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: FORECAST_Q })
      .state.investments !== null);

  await mutate('M15 a scenario mutating the authoritative state is caught',
    'lib/ai/forecast/assemble.ts',
    '  if (facts.spending) {',
    '  if (facts.spending || true) {',
    (m) => (m.assembleForecast as AssembleFn)({
      ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
      question: 'Assume I spend $4,000/month.' })
      .state.discretionaryBaseline.state === ComponentState.UNKNOWN);

  // M16 is a SOURCE-SHAPE mutation: the pin is J2's structural check, so the
  // mutant is inspected rather than executed.
  {
    const src = read('lib/ai/forecast/assemble.ts');
    const mutated = src.replace('  return {\n    state, events, policy,',
      '  const total = events.length * 5286.645;\n  void total;\n  return {\n    state, events, policy,');
    const code = mutated.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .split('\n').filter((l) => !l.trimStart().startsWith('import') && !l.includes("from '"))
      .join('\n').replace(/'[^']*'/g, "''");
    check('M16 duplicating forecast arithmetic in the adapter is caught',
      mutated !== src && /\.length\s*\*/.test(code));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void mutations();
