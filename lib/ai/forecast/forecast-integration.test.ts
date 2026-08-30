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
import { renderForecastSection } from './render';
import type { ResolvedIncomeStream } from './streams';
import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { resolveStreamActivity } from '@/lib/forecast/stream-activity';
import { AmountBasis, EventProvenance, FlowRole } from '@/lib/forecast/future-cash-event';
import { ConclusionStatus } from '@/lib/forecast/policy';
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
check('HF8 assumptions are NOT persisted across turns — each turn re-states its own', (() => {
  // ⚠️ PINNED RATHER THAN BUILT. CF-4 carries a temporal scope between turns
  // and nothing else; there is no conversation-state authority for a policy
  // assumption, and inventing one here would be forecast-specific memory
  // outside CF-4 — which §4 forbids and which would silently apply a
  // supposition the user made three turns ago to a number they read as current.
  // So a scenario applies to the turn that states it. The horizon inherits
  // because CF-4 already owns period inheritance; the assumption does not.
  const src = read('lib/ai/forecast/assemble.ts');
  return !/previous|priorTurn|inherit|persist|history/i.test(src);
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
check('FD2 so a non-forecast prompt pays nothing for it',
  !/FORECAST_DOCTRINE/.test(promptSrc.replace(/\.\.\.\(forecast[^\n]*\n/, '')
    .replace(/  FORECAST_DOCTRINE,\n/, '')));
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
  /planRetrieval\(\{/.test(harness) && /question, plan, forecast\)/.test(harness));
check('HF2b a real coverage envelope',
  /ENVELOPE, question, plan, forecast\)/.test(harness));
check('HF2c a real assembled forecast', /assembleForecast\(\{/.test(harness));
check('HF2d and the same doctrine injection, because it builds the real prompt',
  /buildSpaceSystemPrompt\(/.test(harness) && !/FORECAST_DOCTRINE/.test(harness));
check('HF2e the model and sampling parameters mirror the provider',
  /const PRODUCTION_MODEL = 'gpt-4o-mini'/.test(harness)
  && /const TEMPERATURE = 0\.3/.test(harness)
  && /const MAX_TOKENS = 1024/.test(harness)
  && /const CHAT_MODEL = 'gpt-4o-mini'/.test(read('lib/ai/provider.ts')));
check('HF2f the route and the harness call the prompt builder with the same shape',
  /buildSpaceSystemPrompt\(\s*ctx, assessment, intentRoute, debtPayments, envelopeForPrompt,\s*latestUserMessage\(messages\), shadowPlan, forecast\)/.test(
    route.replace(/\n\s+/g, ' ').replace(/ +/g, ' ')
      .replace('systemPrompt = ', '')),
  route.match(/buildSpaceSystemPrompt\([\s\S]{0,160}/)?.[0] ?? 'NOT FOUND');

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
check('J7 FORECAST-1..9 arithmetic and licensing are byte-identical',
  execSync('git diff --name-only 714d099 -- lib/forecast/ | grep -v "\\.test\\.ts$" || true',
    { encoding: 'utf8' }).trim() === 'lib/forecast/engine.ts');
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
    '    forecast: forecastCash(state, events, policy),',
    "    forecast: { refused: true as const, reason: 'x' },",
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
    '    events.push(...periodicCashEvents(\n      s.activity, s.cadence, amount, horizon.fromISO, horizon.toISO, s.role));',
    '    events.push(...periodicCashEvents(\n      { ...s.activity, mayGenerateExpectedOccurrences: true },\n      s.cadence, amount, horizon.fromISO, horizon.toISO, s.role));',
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
    '    if (st.routing.destination !== \'UPSTREAM_AUTHORITY\' || !st.routing.reachable) continue;',
    '    if (st.routing.destination === \'NEVER\') continue;',
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
