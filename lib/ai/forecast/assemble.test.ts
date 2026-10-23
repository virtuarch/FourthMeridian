/**
 * lib/ai/forecast/assemble.test.ts
 *
 * THE EXTRACTION, PINNED — the AI conversation reset's one behavioural change.
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs \
 *       lib/ai/forecast/assemble.test.ts
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `assembleForecast` used to take `question: string` plus the whole message
 * history and run two regex extractors over them. The reset deleted those
 * extractors and the assembler now takes `UserStatement[]` — FORECAST-8's own
 * typed vocabulary. That is a change to a DETERMINISTIC financial module, and
 * the tests that covered it (`forecast-integration.test.ts`,
 * `lib/reasoning/measure/parity.test.ts`) were deleted with the architecture
 * they mostly measured. Shipping the change with nothing left watching it would
 * be the worse half of a purge.
 *
 * ⚠️ SO THIS PINS THE PROPERTIES THAT MUST SURVIVE ANY FUTURE CONVERSATION
 * LAYER, not the prose that used to produce them: a fact reaches the STATE, a
 * supposition reaches the POLICY, the later statement wins, two movements that
 * share a day stay two movements, and no sentence is parsed anywhere.
 *
 * The fixture is the real Space, carried over verbatim from the deleted
 * integration suite so the numbers below are the ones production produced.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { assembleForecast } from './assemble';
import { resolvePayDates, PayDateAsk } from './pay-dates';
import type { ResolvedIncomeStream } from './streams';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import { resolveStreamActivity } from '@/lib/forecast/stream-activity';
import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { AmountBasis, EventProvenance, FlowRole } from '@/lib/forecast/future-cash-event';
import { PeriodBasis } from '@/lib/forecast/spending-baseline';
import {
  AssumptionOrigin, AssumptionStance, StatementMode,
  type ForecastHorizon, type UserStatement,
} from '@/lib/forecast/policy';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const AS_OF = '2026-08-28';

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
// The dormant payroll: a clean semimonthly schedule and no recent settlement.
const abaCadence = { ...vecCadence, kind: CadenceKind.SEMIMONTHLY, sourceKey: 'abacus' } as Cadence;
const abaActivity = resolveStreamActivity({
  cadence: abaCadence, settlements: ['2025-10-24', '2025-11-10', '2025-11-25'],
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
  settledDepository: true,
  observationCount: 19, truncated: false,
} as unknown as ResolvedIncomeStream;
const ABACUS: ResolvedIncomeStream = {
  sourceKey: 'abacus', label: 'Abacus', role: FlowRole.INCOME, cadence: abaCadence,
  activity: abaActivity,
  amount: {
    assertable: true, value: 5015.68, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null, regimeStartISO: '2025-10-24',
    observationCount: 4, spread: 0.001, verdicts: [], reason: 'four observations',
  },
  projectionEligible: abaActivity.mayGenerateExpectedOccurrences,
  settledDepository: true,
  observationCount: 10, truncated: false,
} as unknown as ResolvedIncomeStream;
const STREAMS = [VECTRUS, ABACUS];

const HORIZON: ForecastHorizon = {
  fromISO: AS_OF, toISO: '2026-11-28',
  origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'over the next 3 months',
} as unknown as ForecastHorizon;

const build = (statements: UserStatement[] = []) =>
  assembleForecast({ ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, statements });

const spendingStatement = (
  amount: number, mode: UserStatement['mode'], statedAs: string,
): UserStatement => ({
  mode, statedAs, asOfISO: AS_OF,
  subject: { kind: 'SPENDING_LEVEL', amount, currency: 'USD', periodBasis: PeriodBasis.MONTHLY },
});

// ═══════════════════════════════════════════════════════════════════════════
// A. NO STATEMENTS — the facts-only path is untouched
// ═══════════════════════════════════════════════════════════════════════════

console.log('A. no statements');
{
  const a = build();
  check('A1 an assembly with no statements applies no facts', a.appliedFacts.length === 0,
    JSON.stringify(a.appliedFacts));
  check('A2 …and declares no user assumption in its policy',
    a.policy.assumptions.every((p) => p.origin !== AssumptionOrigin.USER_REQUESTED),
    JSON.stringify(a.policy.assumptions.map((p) => p.origin)));
  check('A3 the licensed cadence still generates the live stream\'s events',
    a.events.some((e) => e.id.includes('vectrus')));
  check('A4 …and generates none for the dormant one — FORECAST-2\'s licence, carried',
    !a.events.some((e) => e.id.includes('abacus')),
    a.events.map((e) => e.id).join(','));
  check('A5 the assembly is available on a Space with accounts', a.unavailable === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. FACT AND SUPPOSITION STILL ARRIVE BY DIFFERENT DOORS
// ═══════════════════════════════════════════════════════════════════════════

console.log('B. fact vs supposition');
{
  const fact = build([spendingStatement(4000, StatementMode.ASSERTS_FACT,
    'my normal spending is $4,000 a month')]);
  check('B1 an ASSERTS_FACT spending level is applied to the STATE',
    fact.appliedFacts.some((f) => f.includes('spending baseline 4000 USD')),
    JSON.stringify(fact.appliedFacts));
  check('B2 …and is NOT also carried as a user assumption',
    fact.policy.assumptions.every((p) => p.origin !== AssumptionOrigin.USER_REQUESTED),
    JSON.stringify(fact.policy.assumptions.map((p) => `${p.origin}/${p.stance}`)));

  const supposed = build([spendingStatement(10000, StatementMode.REQUESTS_ASSUMPTION,
    'assume I spend $10,000 a month')]);
  check('B3 a REQUESTS_ASSUMPTION spending level applies NO fact',
    supposed.appliedFacts.length === 0, JSON.stringify(supposed.appliedFacts));
  check('B4 …and becomes a SUPPOSED policy assumption instead',
    supposed.policy.assumptions.some(
      (p) => p.origin === AssumptionOrigin.USER_REQUESTED
        && p.stance === AssumptionStance.SUPPOSED),
    JSON.stringify(supposed.policy.assumptions.map((p) => `${p.origin}/${p.stance}`)));

  const counterfactual = build([spendingStatement(10000, StatementMode.REQUESTS_SCENARIO,
    'show me a scenario where I spend $10,000 a month')]);
  check('B5 a REQUESTS_SCENARIO is COUNTERFACTUAL, never merely supposed',
    counterfactual.policy.assumptions.some(
      (p) => p.stance === AssumptionStance.COUNTERFACTUAL),
    JSON.stringify(counterfactual.policy.assumptions.map((p) => p.stance)));

  // ⚠️ THE TWO FACTS TOGETHER ARE WHAT LICENSE A CASH FIGURE, and the split is
  // the whole of FORECAST-3. A spending level alone leaves the engine unable to
  // count a paycheck of UNKNOWN basis as cash, so the LICENSED path still
  // refuses — correctly — and the evidence-based projection answers instead.
  // Add the basis and the licensed path itself produces a closing figure.
  const netBasis: UserStatement = {
    mode: StatementMode.ASSERTS_FACT, statedAs: 'my Vectrus paycheck is take-home',
    asOfISO: AS_OF,
    subject: { kind: 'STREAM_AMOUNT_BASIS', sourceKey: 'vectrus', basis: AmountBasis.NET },
  };
  const both = build([
    spendingStatement(4000, StatementMode.ASSERTS_FACT, 'my normal spending is $4,000 a month'),
    netBasis,
  ]);
  check('B6 a spending fact alone leaves the LICENSED path refusing',
    !('refused' in fact.forecast) && fact.forecast.fullCashPath.closing === null,
    'a paycheck of UNKNOWN basis is not licensed as cash, whatever the spending level');
  check('B7 …but it reaches the engine, which prices the evidence-based projection with it',
    fact.projection != null && fact.projection.closing !== null,
    JSON.stringify(fact.projection?.closing ?? null));
  check('B8 spending AND basis together license an ending cash figure',
    !('refused' in both.forecast) && both.forecast.fullCashPath.closing !== null,
    JSON.stringify('refused' in both.forecast
      ? both.forecast : both.forecast.fullCashPath.status));
  check('B9 …and the facts-only path, stating neither, refuses',
    (() => { const b = build().forecast;
      return 'refused' in b || b.fullCashPath.closing === null; })());
}

// ═══════════════════════════════════════════════════════════════════════════
// C. THE LATER STATEMENT WINS
// ═══════════════════════════════════════════════════════════════════════════

console.log('C. corrections');
{
  const corrected = build([
    spendingStatement(4000, StatementMode.ASSERTS_FACT, 'I spend $4,000 a month'),
    spendingStatement(6000, StatementMode.ASSERTS_FACT, 'actually it is $6,000 a month'),
  ]);
  check('C1 the LAST spending fact is the one applied',
    corrected.appliedFacts.some((f) => f.includes('6000'))
      && !corrected.appliedFacts.some((f) => f.endsWith('"I spend $4,000 a month"')),
    JSON.stringify(corrected.appliedFacts));
  check('C2 …and exactly one baseline is in force, never two',
    corrected.appliedFacts.filter((f) => f.startsWith('spending baseline')).length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// D. AMOUNT BASIS — the fact reaches the periodic-amount authority
// ═══════════════════════════════════════════════════════════════════════════

console.log('D. amount basis');
{
  const net = build([{
    mode: StatementMode.ASSERTS_FACT, statedAs: 'my Vectrus paycheck is take-home',
    asOfISO: AS_OF,
    subject: { kind: 'STREAM_AMOUNT_BASIS', sourceKey: 'vectrus', basis: AmountBasis.NET },
  }]);
  check('D1 an asserted NET basis is applied to the named stream',
    net.appliedFacts.some((f) => f.startsWith('vectrus basis NET')),
    JSON.stringify(net.appliedFacts));
  check('D2 …and reaches the OPERATING STATE, not just a label',
    net.state.incomeStreams.find((s) => s.sourceKey === 'vectrus')?.basis === AmountBasis.NET,
    JSON.stringify(net.state.incomeStreams.map((s) => `${s.sourceKey}:${s.basis}`)));

  const unknown = build([{
    mode: StatementMode.ASSERTS_FACT, statedAs: 'I do not know if it is net or gross',
    asOfISO: AS_OF,
    subject: { kind: 'STREAM_AMOUNT_BASIS', sourceKey: 'vectrus', basis: AmountBasis.UNKNOWN },
  }]);
  check('D3 UNKNOWN is dropped rather than downgraded into a basis',
    unknown.appliedFacts.length === 0, JSON.stringify(unknown.appliedFacts));

  const unnamed = build([{
    mode: StatementMode.ASSERTS_FACT, statedAs: 'it is take-home', asOfISO: AS_OF,
    subject: { kind: 'STREAM_AMOUNT_BASIS', sourceKey: 'not-a-stream', basis: AmountBasis.NET },
  }]);
  check('D4 a basis claim about a stream this Space does not hold applies nothing',
    unnamed.appliedFacts.length === 0, JSON.stringify(unnamed.appliedFacts));
}

// ═══════════════════════════════════════════════════════════════════════════
// E. ONE-OFF EVENTS — provenance, and the identity that lost a movement
// ═══════════════════════════════════════════════════════════════════════════

console.log('E. one-off events');
{
  const evt = (
    amount: number, mode: UserStatement['mode'], statedAs: string,
  ): UserStatement => ({
    mode, statedAs, asOfISO: AS_OF,
    subject: {
      kind: 'ONE_OFF_EVENT', amount, currency: 'USD', basis: AmountBasis.NET,
      direction: 'INFLOW', role: FlowRole.INCOME, dateISO: '2026-10-15',
    },
  });

  const asserted = build([evt(1500, StatementMode.ASSERTS_FACT, 'a $1,500 payout on October 15')]);
  const one = asserted.events.filter((e) => e.id.startsWith('user:'));
  check('E1 an asserted event carries USER_ASSERTED provenance',
    one.length === 1 && one[0].timingProvenance === EventProvenance.USER_ASSERTED,
    JSON.stringify(one.map((e) => e.timingProvenance)));

  const supposed = build([evt(1500, StatementMode.REQUESTS_ASSUMPTION,
    'assume a $1,500 payout on October 15')]);
  const sup = supposed.events.filter((e) => e.id.startsWith('supposed:'));
  check('E2 a supposed event carries HYPOTHETICAL provenance and never USER_ASSERTED',
    sup.length === 1 && sup[0].timingProvenance === EventProvenance.HYPOTHETICAL
      && !supposed.events.some((e) => e.id.startsWith('user:')),
    JSON.stringify(supposed.events.filter((e) => !e.id.includes('vectrus'))
      .map((e) => `${e.id}/${e.timingProvenance}`)));

  // ⚠️ THE MEASURED DEFECT. Same day, same role, different amounts: two
  // movements. An identity without the amount silently merged them and lost one.
  const two = build([
    evt(15500, StatementMode.ASSERTS_FACT, 'a $15,500 gross bonus on October 15'),
    evt(1500, StatementMode.ASSERTS_FACT, 'a $1,500 payout on October 15'),
  ]);
  check('E3 two movements sharing a day and a role stay TWO events',
    two.events.filter((e) => e.id.startsWith('user:')).length === 2,
    two.events.filter((e) => e.id.startsWith('user:')).map((e) => e.id).join(' | '));
}

// ═══════════════════════════════════════════════════════════════════════════
// F. PAY DATES — the licence, over an explicit window
// ═══════════════════════════════════════════════════════════════════════════

console.log('F. pay dates');
{
  const next = resolvePayDates(STREAMS, AS_OF, { ask: PayDateAsk.NEXT_ONE });
  const vec = next.streams.find((s) => s.sourceKey === 'vectrus')!;
  check('F1 NEXT_ONE yields exactly one licensed date', vec.dates.length === 1,
    JSON.stringify(vec.dates));
  check('F2 the dormant payroll yields none however clean its cadence',
    next.streams.find((s) => s.sourceKey === 'abacus')!.dates.length === 0);

  const upcoming = resolvePayDates(STREAMS, AS_OF, { ask: PayDateAsk.UPCOMING });
  check('F3 UPCOMING caps on OCCURRENCES, not on months',
    upcoming.streams.find((s) => s.sourceKey === 'vectrus')!.dates.length === 5);

  const stated = resolvePayDates(STREAMS, AS_OF,
    { ask: PayDateAsk.UPCOMING, stated: { toISO: '2026-09-30', statedAs: 'through September' } });
  check('F4 a stated window replaces the cap rather than being capped by it',
    stated.toISO === '2026-09-30' && stated.horizonStatedAs === 'through September'
      && stated.streams.find((s) => s.sourceKey === 'vectrus')!.dates
        .every((d) => d <= '2026-09-30'));
}

// ═══════════════════════════════════════════════════════════════════════════
// G. NO SENTENCE IS PARSED — the property the reset bought
// ═══════════════════════════════════════════════════════════════════════════

console.log('G. no natural language');
{
  const ROOT = join(__dirname, '..', '..', '..');
  const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const f of ['assemble.ts', 'streams.ts']) {
    const src = codeOnly(readFileSync(join(ROOT, 'lib', 'ai', 'forecast', f), 'utf8'));
    check(`G1 ${f} declares no regular expression`, !/=\s*\/[^/\n]+\/[gimsuy]*/.test(src),
      'natural-language interpretation must not return to the deterministic layer');
  }
  for (const f of ['assemble.ts', 'pay-dates.ts', 'streams.ts']) {
    const src = codeOnly(readFileSync(join(ROOT, 'lib', 'ai', 'forecast', f), 'utf8'));
    check(`G2 ${f} takes no \`question\` input`, !/\bquestion\s*[:,)]/.test(src));
  }
  // ⚠️ pay-dates.ts KEEPS EXACTLY ONE REGEX, and it reads no user input: it
  // truncates an AUTHORITY's own reason string to its first sentence. Pinned by
  // count so a second one cannot arrive unnoticed.
  {
    const pd = codeOnly(readFileSync(join(ROOT, 'lib', 'ai', 'forecast', 'pay-dates.ts'), 'utf8'));
    check('G1b pay-dates keeps exactly one regex, over an authority\'s prose and not the user\'s',
      (pd.match(/=\s*\/[^/\n]+\/[gimsuy]*/g) ?? []).length === 1
        && /firstSentence/.test(pd),
      JSON.stringify(pd.match(/=\s*\/[^/\n]+\/[gimsuy]*/g)));
  }
  const asm = codeOnly(readFileSync(join(ROOT, 'lib', 'ai', 'forecast', 'assemble.ts'), 'utf8'));
  check('G3 the assembler still routes through FORECAST-8 rather than deciding itself',
    /routeStatement\(/.test(asm));
}

console.log(`\nassemble: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
