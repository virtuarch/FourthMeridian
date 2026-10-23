/**
 * lib/forecast/policy.test.ts   (FORECAST-8)
 *
 * WHAT WE ARE ASSUMING, AND WHAT THAT MAY UNLOCK — PINNED.
 *
 *     npx tsx lib/forecast/policy.test.ts
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *   AN ASSUMPTION MAY LICENSE A CALCULATION.
 *   IT MUST NEVER REWRITE THE UNDERLYING FACT.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   an empty policy reproduces FORECAST-7's matrix exactly;
 *   a supposed baseline never makes the authoritative baseline ASSERTABLE;
 *   a NET supposition never becomes a NET basis on a stream or an event;
 *   "I spend $4,000" and "assume $4,000" route to different places;
 *   a scenario amount cannot exist without an origin and the user's words;
 *   a spending supposition does not contaminate the cash balance;
 *   a continuation policy cannot restart a SILENT stream, even as a scenario;
 *   and every assumption-dependent conclusion names its dependencies.
 *
 * Section M runs REAL SOURCE MUTATIONS: each writes a broken copy of policy.ts,
 * imports it, and requires the intended assertion to fail.
 */

import { execSync } from 'child_process';
import { provenanceCovers } from './slice-provenance';
import { mutantLoader } from '../test-support/mutant-module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ComponentState } from '../ai/economic-concepts';
import { composeInvestments } from '../ai/economic-concepts';
import { CadenceKind } from './cadence';
import { ActivityState } from './stream-activity';
import {
  AmountBasis, EventProvenance, FlowRole, composeFutureCash, netCashContribution,
  type FutureCashEvent,
} from './future-cash-event';
import { PeriodBasis } from './spending-baseline';
import { assertedAmountBasis, assertedPeriodicAmount } from './periodic-amount';
import {
  Conclusion, composeOperatingState, forecastCapabilities,
  type ConclusionKind, type CurrentOperatingState, type OperatingStateInput,
} from './operating-state';
import {
  AssumptionDimension, AssumptionOrigin, AssumptionStance, ConclusionStatus,
  EMPTY_POLICY, FactAuthority, HORIZON_DEPENDENCY, PolicyIssue, StatementMode,
  applyPolicy, continueLicensedCadence, routeStatement, validatePolicy,
  type ForecastPolicy, type PolicyAssumption, type PolicyResolution,
} from './policy';
import type { AccountsSectionData } from '../ai/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const SRC_PATH = join(__dirname, 'policy.ts');
const src = readFileSync(SRC_PATH, 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** Comments and string literals removed by scan, so a quoted word is never read as code. */
function stripLiterals(t: string): string {
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i += 1;
      while (i < t.length && t[i] !== q) { if (t[i] === '\\') i += 1; i += 1; }
      i += 1; out += "''";
    } else if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i += 1; }
    else if (c === '/' && t[i + 1] === '*') {
      i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1; i += 2;
    } else { out += c; i += 1; }
  }
  return out;
}
const codeOnly = stripLiterals(src);
const AS_OF = '2026-08-28';

// ── The real Space, exactly as FORECAST-7 pinned it ─────────────────────────

const realAccounts = () => ({
  totalLiquid: 10228.74, totalLiabilities: 549.75,
  totalInvestments: 5006.557852, totalDigitalAssets: 19014.62555862176,
  redactedCount: 0, totalsUnconverted: false,
  counts: { liquid: 4, liabilities: 2, investments: 3, digitalAssets: 4, realAssets: 0 },
} as unknown as AccountsSectionData);

const VECTRUS = {
  sourceKey: 'vectrus', role: FlowRole.INCOME, cadence: CadenceKind.BIWEEKLY,
  activity: ActivityState.CURRENT, projectionEligible: true,
  amount: { value: 5286.645, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null },
};
const ABACUS = {
  sourceKey: 'abacus', role: FlowRole.INCOME, cadence: CadenceKind.SEMIMONTHLY,
  activity: ActivityState.SILENT, projectionEligible: false,
  amount: { value: 5015.68, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null },
};
const INTEREST = {
  sourceKey: 'interest-10th', role: FlowRole.INTEREST, cadence: CadenceKind.MONTHLY,
  activity: ActivityState.CURRENT, projectionEligible: true, amount: null,
};

const state = (o: Partial<OperatingStateInput> = {}): CurrentOperatingState => {
  const acc = realAccounts();
  return composeOperatingState({
    asOfISO: AS_OF,
    accounts: {
      totalLiquid: acc.totalLiquid, totalLiabilities: acc.totalLiabilities,
      counts: { liquid: acc.counts.liquid, liabilities: acc.counts.liabilities },
      redactedCount: acc.redactedCount, totalsUnconverted: acc.totalsUnconverted, asOfISO: AS_OF,
    },
    investments: composeInvestments(acc),
    incomeStreams: [VECTRUS, ABACUS, INTEREST],
    obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
    baseline: { assertable: false, reason: 'recent spending does not repeat closely enough' },
    ...o,
  });
};

const REAL = state();

// ── Assumption fixtures ─────────────────────────────────────────────────────

const SPEND_4K: PolicyAssumption = {
  id: 'a1', dimension: AssumptionDimension.SPENDING_BASELINE,
  amount: 4000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY,
  origin: AssumptionOrigin.USER_REQUESTED, stance: AssumptionStance.SUPPOSED,
  statedAs: 'assume $4,000/month of normal spending',
};
const VECTRUS_NET: PolicyAssumption = {
  id: 'a2', dimension: AssumptionDimension.INCOME_BASIS,
  sourceKey: 'vectrus', basis: AmountBasis.NET,
  origin: AssumptionOrigin.USER_REQUESTED, stance: AssumptionStance.SUPPOSED,
  statedAs: 'assume that paycheck is net for this forecast',
};
const SPEND_10K: PolicyAssumption = {
  id: 'h1', dimension: AssumptionDimension.SPENDING_BASELINE,
  amount: 10000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY,
  origin: AssumptionOrigin.USER_REQUESTED, stance: AssumptionStance.COUNTERFACTUAL,
  statedAs: 'show me a scenario where I spend $10,000/month',
};
const HORIZON = { fromISO: AS_OF, toISO: '2026-11-30',
  origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'through the end of November' };

const policy = (assumptions: PolicyAssumption[], horizon = null as ForecastPolicy['horizon']):
  ForecastPolicy => ({ horizon, assumptions });

const apply = (p: ForecastPolicy, events: readonly FutureCashEvent[] = []) =>
  applyPolicy(REAL, events, p);
const statusOf = (r: PolicyResolution, c: ConclusionKind) =>
  r.conclusions.find((x) => x.conclusion === c)!.status;
const depsOf = (r: PolicyResolution, c: ConclusionKind) =>
  r.conclusions.find((x) => x.conclusion === c)!.dependencies;
const countBy = (r: PolicyResolution) => {
  const out: Record<string, number> = {};
  for (const c of r.conclusions) out[c.status] = (out[c.status] ?? 0) + 1;
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
// A. NO POLICY IS FORECAST-7, EXACTLY
// ═══════════════════════════════════════════════════════════════════════════

const A = apply(EMPTY_POLICY);

/** Licensed ⇒ FACTUALLY_LICENSED, refused ⇒ REFUSED. Nothing in between. */
const matchesForecastSeven = (r: PolicyResolution, mod = { ConclusionStatus }) => {
  const seven = new Map(forecastCapabilities(REAL).map((c) => [c.conclusion, c.licence.licensed]));
  return r.conclusions.every((c) => c.status === (seven.get(c.conclusion)
    ? mod.ConclusionStatus.FACTUALLY_LICENSED : mod.ConclusionStatus.REFUSED));
};
check('A1 an empty policy reproduces FORECAST-7 licence-for-licence', matchesForecastSeven(A));
eq('A2 six factual, eight refused, nothing assumed',
  countBy(A), { FACTUALLY_LICENSED: 6, REFUSED: 8 });
eq('A3 no assumption is invented to fill the gap', A.accepted.length, 0);
eq('A4 the baseline stays refused, not defaulted', A.baseline.status, ConclusionStatus.REFUSED);
eq('A5 and the authority beneath it is untouched', A.baseline.authority, REAL.discretionaryBaseline);
check('A6 every refusal still names what is missing',
  A.conclusions.filter((c) => c.status === ConclusionStatus.REFUSED).every((c) => c.missing.length > 0));
eq('A7 no conclusion carries a dependency', A.conclusions.every((c) => c.dependencies.length === 0), true);

// ═══════════════════════════════════════════════════════════════════════════
// B. THE SPENDING ASSUMPTION — an assumption licenses, it does not establish
// ═══════════════════════════════════════════════════════════════════════════

const B = apply(policy([SPEND_4K]));

eq('B1 the AUTHORITATIVE baseline is still UNKNOWN',
  B.baseline.authority.state, ComponentState.UNKNOWN);
eq('B2 and still carries no amount', B.baseline.authority.amount, null);
eq('B3 the assumption sits beside it, not inside it', B.baseline.assumption?.amount, 4000);
eq('B4 with user-requested origin', B.baseline.assumption?.origin, AssumptionOrigin.USER_REQUESTED);
check('B5 there is no merged scalar on the resolved baseline',
  !('amount' in (B.baseline as object)) && !('effective' in (B.baseline as object)),
  JSON.stringify(Object.keys(B.baseline)));

eq('B6 monthly discretionary spend becomes ASSUMPTION_DEPENDENT',
  statusOf(B, Conclusion.MONTHLY_DISCRETIONARY_SPEND), ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('B7 burn rate too', statusOf(B, Conclusion.MONTHLY_BURN_RATE), ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('B8 and cash runway', statusOf(B, Conclusion.CASH_RUNWAY), ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('B9 but SURPLUS stays refused — income basis is a different missing input',
  statusOf(B, Conclusion.MONTHLY_SURPLUS), ConclusionStatus.REFUSED);
eq('B10 as does net monthly inflow',
  statusOf(B, Conclusion.NET_MONTHLY_INFLOW), ConclusionStatus.REFUSED);
eq('B11 as does forecast ending cash',
  statusOf(B, Conclusion.FORECAST_ENDING_CASH), ConclusionStatus.REFUSED);
eq('B12 the exact transition', countBy(B),
  { FACTUALLY_LICENSED: 6, ASSUMPTION_DEPENDENT: 3, REFUSED: 5 });
eq('B13 burn rate names exactly the spending assumption',
  depsOf(B, Conclusion.MONTHLY_BURN_RATE), ['a1']);
check('B14 the surviving refusal names the basis, not the baseline', (() => {
  const m = B.conclusions.find((c) => c.conclusion === Conclusion.MONTHLY_SURPLUS)!.missing;
  return m.some((x) => /net \(after-tax\) basis/.test(x)) && !m.some((x) => /discretionary/.test(x));
})());

// §20 — minimality. A policy is not a contaminant.
eq('B15 the current cash balance stays FACTUALLY_LICENSED',
  statusOf(B, Conclusion.CURRENT_LIQUID_BALANCE), ConclusionStatus.FACTUALLY_LICENSED);
eq('B16 with NO dependency on the spending assumption',
  depsOf(B, Conclusion.CURRENT_LIQUID_BALANCE), []);
eq('B17 next pay dates likewise stay factual',
  statusOf(B, Conclusion.NEXT_PAY_DATES), ConclusionStatus.FACTUALLY_LICENSED);
eq('B18 and nominal monthly income', statusOf(B, Conclusion.NOMINAL_MONTHLY_INCOME),
  ConclusionStatus.FACTUALLY_LICENSED);

// ═══════════════════════════════════════════════════════════════════════════
// C. TWO ASSUMPTIONS — dependencies stay minimal and named
// ═══════════════════════════════════════════════════════════════════════════

const C = apply(policy([SPEND_4K, VECTRUS_NET]));
const CH = apply(policy([SPEND_4K, VECTRUS_NET], HORIZON));

eq('C1 the authoritative basis on vectrus is still UNKNOWN',
  C.incomeStreams.find((s) => s.sourceKey === 'vectrus')!.authorityBasis, AmountBasis.UNKNOWN);
eq('C2 the NET treatment is recorded as assumed, separately',
  C.incomeStreams.find((s) => s.sourceKey === 'vectrus')!.assumedBasis, AmountBasis.NET);
eq('C3 the STATE object itself never gained a NET stream',
  REAL.incomeStreams.every((s) => s.basis === AmountBasis.UNKNOWN), true);

eq('C4 surplus unlocks', statusOf(C, Conclusion.MONTHLY_SURPLUS), ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('C5 naming BOTH assumptions', depsOf(C, Conclusion.MONTHLY_SURPLUS).sort(), ['a1', 'a2']);
eq('C6 savings rate too', depsOf(C, Conclusion.SAVINGS_RATE).sort(), ['a1', 'a2']);
eq('C7 a safe monthly budget too', depsOf(C, Conclusion.SAFE_MONTHLY_BUDGET).sort(), ['a1', 'a2']);
eq('C8 net monthly inflow needs ONLY the basis assumption',
  depsOf(C, Conclusion.NET_MONTHLY_INFLOW), ['a2']);
eq('C9 burn rate still needs ONLY the spending assumption',
  depsOf(C, Conclusion.MONTHLY_BURN_RATE), ['a1']);
eq('C10 ending cash is REFUSED without a horizon',
  statusOf(C, Conclusion.FORECAST_ENDING_CASH), ConclusionStatus.REFUSED);
check('C11 and says so',
  C.conclusions.find((c) => c.conclusion === Conclusion.FORECAST_ENDING_CASH)!
    .missing.includes('a bounded forecast horizon'));
eq('C12 with a horizon it unlocks',
  statusOf(CH, Conclusion.FORECAST_ENDING_CASH), ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('C13 naming both assumptions AND the horizon',
  depsOf(CH, Conclusion.FORECAST_ENDING_CASH).sort(), ['a1', 'a2', HORIZON_DEPENDENCY]);
eq('C14 the exact matrix without a horizon', countBy(C),
  { FACTUALLY_LICENSED: 6, ASSUMPTION_DEPENDENT: 7, REFUSED: 1 });
eq('C15 and with one', countBy(CH), { FACTUALLY_LICENSED: 6, ASSUMPTION_DEPENDENT: 8 });
// V26-REASONING Slice 0 — `unlockedByPolicy` was a dead one-line export; the
// invariant it served is the assertion, so it is inlined rather than lost.
check('C16 every unlocked conclusion names at least one dependency',
  C.conclusions
    .filter((c) => c.status === ConclusionStatus.ASSUMPTION_DEPENDENT
      || c.status === ConclusionStatus.HYPOTHETICAL)
    .every((c) => c.dependencies.length > 0));
check('C17 no conclusion carries a bare assumed flag',
  !/assumed\s*:\s*(true|false)/.test(codeOnly) && !/\bisAssumed\b/.test(codeOnly));

// §20 again, with the second assumption present.
eq('C18 next pay dates do NOT become assumption-dependent from an income-basis supposition',
  depsOf(C, Conclusion.NEXT_PAY_DATES), []);
eq('C19 nor the debt balance', depsOf(C, Conclusion.CURRENT_DEBT_BALANCE), []);

// Degenerate attribution: two suppositions that each independently suffice.
const SECOND_NET: PolicyAssumption = { ...(VECTRUS_NET as never) as typeof VECTRUS_NET,
  id: 'a3', sourceKey: 'interest-10th' };
check('C20 a NET supposition over a stream with no established amount is REJECTED', (() => {
  const v = validatePolicy(REAL, [], policy([SECOND_NET]));
  return v.accepted.length === 0
    && v.rejected[0].code === PolicyIssue.STREAM_AMOUNT_NOT_ESTABLISHED;
})());

// ═══════════════════════════════════════════════════════════════════════════
// D. THE HYPOTHETICAL — live failure #7
// ═══════════════════════════════════════════════════════════════════════════

const D = apply(policy([SPEND_10K]));

eq('D1 a counterfactual scenario yields HYPOTHETICAL, not assumption-dependent',
  statusOf(D, Conclusion.MONTHLY_DISCRETIONARY_SPEND), ConclusionStatus.HYPOTHETICAL);
eq('D2 the resolved baseline is HYPOTHETICAL too', D.baseline.status, ConclusionStatus.HYPOTHETICAL);
eq('D3 the OBSERVED baseline is still UNKNOWN', D.baseline.authority.state, ComponentState.UNKNOWN);
// ⚠️ D4/D5 DELETED WITH `explainPolicy` (V26-REASONING Slice 0). Both asserted
// only on that renderer's prose. It was never production-wired — the model has
// never seen a line of it — and Slice 1 replaces prose provenance with a typed
// figure table the verifier checks by identity. The INVARIANTS they guarded
// (a hypothetical is not an assumption; a supposed figure is never called
// observed) are pinned on the resolution itself by D1, D2 and D3 above.
check('D6 there is no producer of a scenario amount without provenance', (() => {
  // The module holds no money literal of its own, the only origin it can
  // manufacture is SYSTEM_POLICY, and the single thing that manufactures one
  // carries no amount at all. Every figure therefore arrives from a caller
  // together with the words that asked for it.
  const noMoney = !/\b\d{3,}\b/.test(codeOnly);
  const systemOriginOnce =
    (codeOnly.match(/origin: AssumptionOrigin\.SYSTEM_POLICY/g) ?? []).length === 1;
  const body = src.slice(src.indexOf('export function continueLicensedCadence'),
    src.indexOf('// ── Horizon'));
  return noMoney && systemOriginOnce && !/amount/.test(body);
})());
check('D7 an assumption cannot be built without the user\'s own words',
  /statedAs: string;/.test(src) && !/statedAs\?:/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// E. FACT VS ASSUMPTION — routing, the load-bearing distinction
// ═══════════════════════════════════════════════════════════════════════════

const spendSubject = { kind: 'SPENDING_LEVEL' as const, amount: 4000, currency: 'USD',
  periodBasis: PeriodBasis.MONTHLY };
const basisSubject = { kind: 'STREAM_AMOUNT_BASIS' as const, sourceKey: 'vectrus',
  basis: AmountBasis.NET };

const factSpend = routeStatement({ mode: StatementMode.ASSERTS_FACT, subject: spendSubject,
  statedAs: 'I spend $4,000/month normally', asOfISO: AS_OF }, 'r1');
const assumeSpend = routeStatement({ mode: StatementMode.REQUESTS_ASSUMPTION, subject: spendSubject,
  statedAs: 'assume I spend $4,000/month', asOfISO: AS_OF }, 'r2');

eq('E1 "I spend $4,000/month" goes UPSTREAM', factSpend.destination, 'UPSTREAM_AUTHORITY');
eq('E2 to the spending-baseline authority',
  factSpend.destination === 'UPSTREAM_AUTHORITY' ? factSpend.authority : null,
  FactAuthority.SPENDING_BASELINE);
eq('E3 "assume I spend $4,000/month" becomes a policy assumption',
  assumeSpend.destination, 'FORECAST_POLICY');
eq('E4 with SUPPOSED stance',
  assumeSpend.destination === 'FORECAST_POLICY' ? assumeSpend.assumption.stance : null,
  AssumptionStance.SUPPOSED);
check('E5 the two are NOT the same object shape — one is a fact, one is a supposition',
  factSpend.destination !== assumeSpend.destination);

const factBasis = routeStatement({ mode: StatementMode.ASSERTS_FACT, subject: basisSubject,
  statedAs: 'my $5,286.645 paycheck is take-home', asOfISO: AS_OF }, 'r3');
const assumeBasis = routeStatement({ mode: StatementMode.REQUESTS_ASSUMPTION, subject: basisSubject,
  statedAs: 'assume that paycheck is net for this forecast', asOfISO: AS_OF }, 'r4');

eq('E6 "my paycheck IS take-home" routes to the periodic-amount authority',
  factBasis.destination === 'UPSTREAM_AUTHORITY' ? factBasis.authority : null,
  FactAuthority.PERIODIC_AMOUNT_BASIS);
// ⚠️ E7 INVERTED BY FORECAST-9A. It pinned `reachable: false` — the measured
// gap FORECAST-8 found and refused to paper over. FORECAST-9A closed it, so the
// pin now asserts the repair; the thing it was really protecting, that a stated
// fact never becomes a policy assumption, is E10 and is unchanged.
eq('E7 the periodic-amount route is now REACHABLE (FORECAST-9A)',
  factBasis.destination === 'UPSTREAM_AUTHORITY' ? factBasis.reachable : null, true);
check('E8 and it tells the caller to apply it there rather than carry it as an assumption',
  factBasis.destination === 'UPSTREAM_AUTHORITY'
  && /belongs to the periodic-amount authority and must be applied there/.test(factBasis.note),
  factBasis.destination === 'UPSTREAM_AUTHORITY' ? factBasis.note : '');
eq('E9 "assume it is net" DOES become a policy assumption', assumeBasis.destination, 'FORECAST_POLICY');

check('E10 no fact-mode statement EVER produces a policy assumption', (() => {
  const subjects = [spendSubject, basisSubject,
    { kind: 'EVENT_AMOUNT_BASIS' as const, eventId: 'e1', basis: AmountBasis.NET },
    { kind: 'STREAM_CONTINUES' as const, sourceKey: 'abacus', continues: true }];
  return subjects.every((subject) => routeStatement(
    { mode: StatementMode.ASSERTS_FACT, subject, statedAs: 'x', asOfISO: AS_OF }, 'r')
    .destination !== 'FORECAST_POLICY');
})());
check('E11 no supposition EVER produces an upstream fact routing', (() => {
  const subjects = [spendSubject, basisSubject,
    { kind: 'EVENT_AMOUNT_BASIS' as const, eventId: 'e1', basis: AmountBasis.NET }];
  return [StatementMode.REQUESTS_ASSUMPTION, StatementMode.REQUESTS_SCENARIO].every((mode) =>
    subjects.every((subject) => routeStatement({ mode, subject, statedAs: 'x', asOfISO: AS_OF }, 'r')
      .destination !== 'UPSTREAM_AUTHORITY'));
})());
eq('E12 a scenario request carries COUNTERFACTUAL stance', (() => {
  const r = routeStatement({ mode: StatementMode.REQUESTS_SCENARIO, subject:
    { kind: 'SPENDING_LEVEL', amount: 10000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY },
  statedAs: 'show me a scenario where I spend $10,000/month', asOfISO: AS_OF }, 'r5');
  return r.destination === 'FORECAST_POLICY' ? r.assumption.stance : null;
})(), AssumptionStance.COUNTERFACTUAL);
check('E13 the module parses no prose — the user\'s words are carried, never inspected',
  !/statedAs\s*\.\s*\w/.test(codeOnly) && !/statedAs\s*[=!]==?/.test(codeOnly)
  && !/\.toLowerCase\(\)\s*\.\s*(includes|indexOf|search)/.test(codeOnly));

// ═══════════════════════════════════════════════════════════════════════════
// F. CONTINUATION — a policy cannot restart a dead stream (§11)
// ═══════════════════════════════════════════════════════════════════════════

const restart = (stance: typeof AssumptionStance[keyof typeof AssumptionStance]): PolicyAssumption => ({
  id: 'f1', dimension: AssumptionDimension.STREAM_CONTINUATION, sourceKey: 'abacus', include: true,
  origin: AssumptionOrigin.USER_REQUESTED, stance, statedAs: 'carry abacus forward',
});
const F1 = validatePolicy(REAL, [], policy([restart(AssumptionStance.SUPPOSED)]));
const F2 = validatePolicy(REAL, [], policy([restart(AssumptionStance.COUNTERFACTUAL)]));

eq('F1 a continuation policy cannot include a SILENT stream',
  F1.rejected[0]?.code, PolicyIssue.REACTIVATION_NOT_PERMITTED);
eq('F2 and a COUNTERFACTUAL stance does not buy past it',
  F2.rejected[0]?.code, PolicyIssue.REACTIVATION_NOT_PERMITTED);
check('F3 the refusal points at the activity authority',
  /belongs to the activity authority as an assertion about the world/.test(F1.rejected[0].reason));
eq('F4 "assume I still work there" is UNROUTABLE, not a policy assumption',
  routeStatement({ mode: StatementMode.REQUESTS_ASSUMPTION,
    subject: { kind: 'STREAM_CONTINUES', sourceKey: 'abacus', continues: true },
    statedAs: 'assume I still work at abacus', asOfISO: AS_OF }, 'f2').destination, 'UNROUTABLE');
check('F5 excluding a CURRENT stream is permitted, and is a real dependency', (() => {
  const drop: PolicyAssumption = { id: 'f3', dimension: AssumptionDimension.STREAM_CONTINUATION,
    sourceKey: 'vectrus', include: false, origin: AssumptionOrigin.USER_REQUESTED,
    stance: AssumptionStance.SUPPOSED, statedAs: 'leave the vectrus paycheck out' };
  const r = apply(policy([drop]));
  return statusOf(r, Conclusion.NEXT_PAY_DATES) === ConclusionStatus.ASSUMPTION_DEPENDENT
    && depsOf(r, Conclusion.NEXT_PAY_DATES).includes('f3')
    && statusOf(r, Conclusion.CURRENT_LIQUID_BALANCE) === ConclusionStatus.FACTUALLY_LICENSED;
})());
check('F6 the one system default is disclosed, not implicit', (() => {
  // The rendering half of this check went with `explainPolicy`; the structural
  // half is the one that matters and is the one kept — a system default that is
  // ACCEPTED and carries SYSTEM_POLICY origin is disclosable by construction.
  const d = continueLicensedCadence();
  const r = apply(policy([d]));
  return d.origin === AssumptionOrigin.SYSTEM_POLICY
    && r.accepted.some((a) => a.id === d.id)
    && r.accepted.find((a) => a.id === d.id)!.statedAs.length > 0;
})());
check('F7 the system default reactivates nothing — abacus stays excluded', (() => {
  const r = apply(policy([continueLicensedCadence()]));
  return r.incomeStreams.find((s) => s.sourceKey === 'abacus')!.included === false;
})());
check('F8 the system-default inventory is exactly one',
  (src.match(/origin: AssumptionOrigin\.SYSTEM_POLICY/g) ?? []).length === 1);

// ═══════════════════════════════════════════════════════════════════════════
// G. GROSS / NET — live failure #8
// ═══════════════════════════════════════════════════════════════════════════

const BONUS: FutureCashEvent = {
  id: 'bonus', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 15500, currency: 'USD', basis: AmountBasis.GROSS,
    provenance: EventProvenance.USER_ASSERTED },
};
const VACATION: FutureCashEvent = {
  id: 'vacation', timing: { kind: 'EXACT', dateISO: '2026-10-15' },
  timingProvenance: EventProvenance.USER_ASSERTED, direction: 'INFLOW', role: FlowRole.INCOME,
  amount: { value: 1500, currency: 'USD', basis: AmountBasis.UNKNOWN,
    provenance: EventProvenance.USER_ASSERTED },
};
const EVENTS = [BONUS, VACATION];
const before = composeFutureCash(EVENTS);

eq('G1 with no assumptions the nominal inflow is stated', before.nominalInflow, 17000);
eq('G2 and spendable cash is REFUSED', before.assertableNet, null);

const netEvent = (id: string, eventId: string, stance: typeof AssumptionStance[keyof typeof AssumptionStance]):
  PolicyAssumption => ({ id, dimension: AssumptionDimension.EVENT_BASIS, eventId,
    basis: AmountBasis.NET, origin: AssumptionOrigin.USER_REQUESTED, stance,
    statedAs: 'assume both amounts are net for this scenario' });

const G_supposed = validatePolicy(REAL, EVENTS, policy([
  netEvent('g1', 'bonus', AssumptionStance.SUPPOSED),
  netEvent('g2', 'vacation', AssumptionStance.SUPPOSED)]));

eq('G3 supposing the UNKNOWN-basis vacation pay is net is accepted',
  G_supposed.accepted.map((a) => a.id), ['g2']);
eq('G4 supposing the GROSS bonus is net is REJECTED as a bare supposition',
  G_supposed.rejected[0]?.code, PolicyIssue.CONTRADICTS_ESTABLISHED_FACT);
check('G5 and the rejection offers the two honest routes',
  /explicitly\s+counterfactual scenario, or assert the new figure as a fact/
    .test(G_supposed.rejected[0].reason.replace(/\s+/g, ' ')), G_supposed.rejected[0].reason);

const G = applyPolicy(REAL, EVENTS, policy([
  netEvent('g1', 'bonus', AssumptionStance.COUNTERFACTUAL),
  netEvent('g2', 'vacation', AssumptionStance.SUPPOSED)], HORIZON));

eq('G6 declared counterfactual, both are accepted', G.accepted.length, 2);
eq('G7 the bonus event is STILL GROSS underneath',
  G.events.find((e) => e.id === 'bonus')!.authorityAmount!.basis, AmountBasis.GROSS);
eq('G8 the vacation event is STILL UNKNOWN underneath',
  G.events.find((e) => e.id === 'vacation')!.authorityAmount!.basis, AmountBasis.UNKNOWN);
eq('G9 the EventAmount objects themselves were never mutated',
  [BONUS.amount!.basis, VACATION.amount!.basis], [AmountBasis.GROSS, AmountBasis.UNKNOWN]);
eq('G10 FORECAST-3 still refuses spendable cash on the raw events',
  netCashContribution(BONUS).assertable, false);
eq('G11 and the composition is byte-identical to before the policy',
  JSON.stringify(composeFutureCash(EVENTS)), JSON.stringify(before));
// ⚠️ G12–G15 DELETED WITH `scenarioCash` (V26-REASONING Slice 0). It composed a
// scenario figure beside the authoritative one for a caller that never existed:
// the engine consumes `effectiveEventAmount` directly, and no production path
// ever read a ScenarioCash. G11 above still pins the composition FORECAST-3
// actually produces, which is the half that ships.
eq('G16 the scenario figure changes no conclusion licence — ending cash is still REFUSED',
  statusOf(G, Conclusion.FORECAST_ENDING_CASH), ConclusionStatus.REFUSED);
check('G17 because the spending baseline is still unknown, and it says so',
  G.conclusions.find((c) => c.conclusion === Conclusion.FORECAST_ENDING_CASH)!
    .missing.some((m) => /discretionary/.test(m)));
check('G18 a supposition supplies a basis, never a missing amount', (() => {
  const noAmount: FutureCashEvent = { ...VACATION, id: 'nil', amount: null };
  const r = applyPolicy(REAL, [noAmount], policy([netEvent('g9', 'nil', AssumptionStance.SUPPOSED)]));
  // The composition half went with `scenarioCash`; the rejection is the rule.
  return r.rejected[0].code === PolicyIssue.INVALID_AMOUNT
    && composeFutureCash([noAmount]).assertableNet === null;
})());
check('G20 no ratio transformation exists — no percentage field, no rate',
  !/percent|ratio|\brate\b|fraction/i.test(codeOnly));
check('G21 the module estimates no deduction', !/tax|withhold/i.test(codeOnly));

check('G22 a stream-level NET supposition reaches that stream\'s UNKNOWN-basis events', (() => {
  const payslip: FutureCashEvent = { id: 'vectrus@2026-09-11',
    timing: { kind: 'EXACT', dateISO: '2026-09-11' }, timingProvenance: EventProvenance.DERIVED,
    direction: 'INFLOW', role: FlowRole.INCOME, sourceKey: 'vectrus',
    amount: { value: 5286.645, currency: 'USD', basis: AmountBasis.UNKNOWN,
      provenance: EventProvenance.DERIVED } };
  const r = applyPolicy(REAL, [payslip, BONUS], policy([VECTRUS_NET]));
  const pay = r.events.find((e) => e.id === 'vectrus@2026-09-11')!;
  const bonus = r.events.find((e) => e.id === 'bonus')!;
  return pay.assumedBasis === AmountBasis.NET && pay.basisAssumptionId === 'a2'
    // ⚠️ and does NOT reach an event whose basis is already established.
    && bonus.assumedBasis === null;
})());
check('G23 nor an event belonging to a different stream', (() => {
  const other: FutureCashEvent = { id: 'abacus@2026-09-15',
    timing: { kind: 'EXACT', dateISO: '2026-09-15' }, timingProvenance: EventProvenance.DERIVED,
    direction: 'INFLOW', role: FlowRole.INCOME, sourceKey: 'abacus',
    amount: { value: 5015.68, currency: 'USD', basis: AmountBasis.UNKNOWN,
      provenance: EventProvenance.DERIVED } };
  return applyPolicy(REAL, [other], policy([VECTRUS_NET])).events[0].assumedBasis === null;
})());

// ═══════════════════════════════════════════════════════════════════════════
// H. PRECEDENCE (§13)
// ═══════════════════════════════════════════════════════════════════════════

const establishedBaseline = state({
  baseline: { assertable: true, amount: 3200, periodBasis: PeriodBasis.MONTHLY,
    provenance: EventProvenance.USER_ASSERTED, currency: 'USD',
    reason: 'the user stated ordinary spending is 3200 USD per month' },
});
const H1 = validatePolicy(establishedBaseline, [], policy([SPEND_4K]));
const H2 = validatePolicy(establishedBaseline, [], policy([SPEND_10K]));

eq('H1 a SUPPOSED assumption may not overwrite an established fact',
  H1.rejected[0]?.code, PolicyIssue.CONTRADICTS_ESTABLISHED_FACT);
eq('H2 an explicitly COUNTERFACTUAL one may', H2.accepted.map((a) => a.id), ['h1']);
check('H3 and the resulting conclusion is HYPOTHETICAL, not assumption-dependent', (() => {
  const r = applyPolicy(establishedBaseline, [], policy([SPEND_10K]));
  return r.conclusions.find((c) => c.conclusion === Conclusion.MONTHLY_BURN_RATE)!.status
    === ConclusionStatus.HYPOTHETICAL;
})());
check('H4 an assumption that restates an established fact is not a contradiction', (() => {
  const same: PolicyAssumption = { ...SPEND_4K, id: 'h4', amount: 3200 };
  return validatePolicy(establishedBaseline, [], policy([same])).accepted.length === 1;
})());
check('H5 contradiction is COMPUTED from the state, never declared by the caller',
  !/contradicts\s*:/.test(codeOnly) && /function contradicts\(/.test(code));
eq('H6 a known event outranks generic policy — policy addresses events only by id',
  /eventId: string;/.test(src) && !/dimension === AssumptionDimension\.EVENT_\w+[\s\S]{0,200}forEach/.test(code), true);
check('H7 an event assumption naming no known event is rejected', (() => {
  const v = validatePolicy(REAL, EVENTS, policy([netEvent('x', 'nope', AssumptionStance.SUPPOSED)]));
  return v.rejected[0].code === PolicyIssue.UNKNOWN_EVENT;
})());

// ═══════════════════════════════════════════════════════════════════════════
// I. FAILURE BEHAVIOUR (§23)
// ═══════════════════════════════════════════════════════════════════════════

const bad = apply(policy([{ ...SPEND_4K, id: 'b1', amount: Number.NaN }]));
eq('I1 an invalid amount is rejected', bad.rejected[0]?.code, PolicyIssue.INVALID_AMOUNT);
eq('I2 and the conclusion it would have unlocked is REFUSED, not approximated',
  statusOf(bad, Conclusion.MONTHLY_BURN_RATE), ConclusionStatus.REFUSED);
eq('I3 an invalid policy reproduces the no-policy matrix exactly', countBy(bad), countBy(A));
check('I4 a bad horizon is dropped and disclosed', (() => {
  const r = applyPolicy(REAL, [], { horizon: { fromISO: '2026-11-30', toISO: AS_OF,
    origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'backwards' }, assumptions: [] });
  return r.horizon === null && r.rejected[0].code === PolicyIssue.INVALID_HORIZON;
})());
check('I5 duplicate ids are rejected, so no dependency is ambiguous', (() => {
  const v = validatePolicy(REAL, [], policy([SPEND_4K, { ...SPEND_4K, amount: 9000 }]));
  return v.accepted.length === 1 && v.rejected[0].code === PolicyIssue.DUPLICATE_ASSUMPTION_ID;
})());
check('I6 nothing is silently dropped — every rejection carries a reason',
  bad.rejected.every((r) => r.reason.length > 0));
eq('I7 a GROSS supposition licenses nothing and is rejected', (() => {
  const v = validatePolicy(REAL, [], policy([{ ...VECTRUS_NET, id: 'i7', basis: AmountBasis.GROSS }]));
  return v.rejected[0]?.code;
})(), PolicyIssue.NOT_A_NET_ASSUMPTION);

// ═══════════════════════════════════════════════════════════════════════════
// J. NO AUTHORITY LAUNDERING (§3) AND NO HISTORY PATH (§16/§17/§18)
// ═══════════════════════════════════════════════════════════════════════════

const snapshot = JSON.stringify(REAL);
const CJ = apply(policy([SPEND_4K, VECTRUS_NET], HORIZON));
eq('J1 applying a policy leaves the state byte-identical', JSON.stringify(REAL), snapshot);
check('J2 and returns the very same object, not a copy that could drift', CJ.state === REAL);
check('J3 the shadow state used for licensing is never exported',
  /^function licensingShadow/m.test(code) && !/export function licensingShadow/.test(src));
check('J4 no resolved surface exposes an ASSERTABLE baseline the authority does not hold',
  CJ.baseline.authority.state === ComponentState.UNKNOWN
  && !JSON.stringify(CJ.baseline).includes('ASSERTABLE'));
check('J5 applyPolicy has no parameter through which history could arrive',
  /export function applyPolicy\(\s*state: CurrentOperatingState,\s*events: readonly FutureCashEvent\[\],\s*policy: ForecastPolicy,\s*\)/
    .test(src));
check('J6 no averaging vocabulary exists anywhere in the module',
  !/average|mean\b|median|trailing|history|historical/i.test(codeOnly), codeOnly.slice(0, 0));
check('J7 no cadence arithmetic — no 26/12, no day counts, no annualisation',
  !/\b26\b|\/\s*12\b|annualFactor|monthlyEquivalent|86_?400/.test(codeOnly));
check('J8 the module imports no transaction, ledger or database surface',
  !/lib\/db|prisma|transactions|queryTransactions/i.test(src.split('\n')
    .filter((l) => l.startsWith('import')).join('\n')));
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
check('J9 FORECAST-8 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/policy" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
// pair did not learn from in time. Compared against the WORKING TREE, a claim
// about what THIS slice did not touch silently becomes a claim that no LATER
// slice may touch it either — and FORECAST-9A legitimately edits
// periodic-amount.ts and operating-state.ts to close the gap this module found.
// Pinned at FORECAST-8's own commit the claim is exact and permanent.
// Now DATA, not a git call: the claim is recorded in ./slice-provenance and
// verified against the commit itself by scripts/audit-forecast-slice-provenance.ts
// (REQUIRED), so this suite no longer needs repository ancestry to run.
check('J10 FORECAST-8 did not touch FORECAST-1..7',
  provenanceCovers('FORECAST-8', ['lib/forecast/cadence.ts', 'lib/forecast/stream-activity.ts',
    'lib/forecast/future-cash-event.ts', 'lib/forecast/obligation.ts', 'lib/forecast/periodic-amount.ts',
    'lib/forecast/spending-baseline.ts', 'lib/forecast/operating-state.ts', 'lib/ai/economic-concepts.ts']));
check('J11 nor any CF-era retrieval or prompt surface',
  provenanceCovers('FORECAST-8', ['lib/ai/']));

// ═══════════════════════════════════════════════════════════════════════════
// K. EXPLANATION AND SERIALIZATION — DELETED (V26-REASONING Slice 0)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE WHOLE SECTION WENT WITH `explainPolicy`, AND THAT IS THE POINT OF THE
// SLICE THAT FOLLOWS IT. Fourteen checks measured a prose renderer's sections,
// its token budget, and the regexes it had to satisfy — for a function that was
// never production-wired and that the model has never once seen. That is the
// shape this program is removing: provenance flattened into English and then
// policed by reading the English back. Slice 1 replaces it with a typed figure
// table whose claims are checked by identity, not by pattern.
//
// Nothing here guarded a resolution invariant. Every rule these regexes were
// looking for is asserted directly on `PolicyResolution` elsewhere in this file:
// dependencies on unlocked conclusions (C16), origin on every accepted
// assumption (F6), a hypothetical kept apart from an assumption (D1–D3), and
// the untouched authority composition (G11).


// ═══════════════════════════════════════════════════════════════════════════
// R. FACT OUTRANKS SUPPOSITION (FORECAST-9A)
// ═══════════════════════════════════════════════════════════════════════════
//
// The closure test is three-way. Before FORECAST-9A only two of these existed,
// and the missing one was the fact.

const netAmount = assertedAmountBasis(
  assertedPeriodicAmount(5286.645, 'USD', AS_OF), AmountBasis.NET, AS_OF);
const FACT_VECTRUS = { ...VECTRUS, amount: {
  value: netAmount.value, currency: netAmount.currency, provenance: netAmount.provenance,
  basis: netAmount.basis, basisProvenance: netAmount.basisProvenance } };
const FACTUAL = state({ incomeStreams: [FACT_VECTRUS, ABACUS, INTEREST] });

const RA = apply(EMPTY_POLICY);
const RB = applyPolicy(FACTUAL, [], EMPTY_POLICY);
const RC = apply(policy([VECTRUS_NET]));

eq('R1 A · no assertion, no policy → net monthly inflow REFUSED',
  statusOf(RA, Conclusion.NET_MONTHLY_INFLOW), ConclusionStatus.REFUSED);
eq('R2 B · user-asserted NET fact → FACTUALLY_LICENSED, with no policy at all',
  statusOf(RB, Conclusion.NET_MONTHLY_INFLOW), ConclusionStatus.FACTUALLY_LICENSED);
eq('R3 and it depends on nothing, because nothing was supposed',
  RB.conclusions.find((c) => c.conclusion === Conclusion.NET_MONTHLY_INFLOW)!.dependencies, []);
eq('R4 C · no fact, "assume NET" → ASSUMPTION_DEPENDENT',
  statusOf(RC, Conclusion.NET_MONTHLY_INFLOW), ConclusionStatus.ASSUMPTION_DEPENDENT);
eq('R5 naming the supposition', depsOf(RC, Conclusion.NET_MONTHLY_INFLOW), ['a2']);
eq('R6 the three cases are genuinely three, not two',
  new Set([statusOf(RA, Conclusion.NET_MONTHLY_INFLOW), statusOf(RB, Conclusion.NET_MONTHLY_INFLOW),
    statusOf(RC, Conclusion.NET_MONTHLY_INFLOW)]).size, 3);
eq('R7 under the fact, the AUTHORITY basis is NET — not an assumption sitting beside UNKNOWN',
  RB.incomeStreams.find((s) => s.sourceKey === 'vectrus')!.authorityBasis, AmountBasis.NET);
eq('R8 with no assumed basis at all', RB.incomeStreams.find((s) => s.sourceKey === 'vectrus')!.assumedBasis, null);
// R9 deleted with `explainPolicy`; R7 and R8 above pin the same fact on the
// resolution — an ESTABLISHED authority basis with no assumed basis beside it.
eq('R10 policy is no longer more expressive than a fact — both reach the same conclusion',
  [statusOf(RB, Conclusion.NET_MONTHLY_INFLOW) === ConclusionStatus.FACTUALLY_LICENSED,
    statusOf(RC, Conclusion.NET_MONTHLY_INFLOW) === ConclusionStatus.ASSUMPTION_DEPENDENT], [true, true]);

// §13 — a supposition may not overwrite the established fact.
const supposeGross: PolicyAssumption = { id: 'r1', dimension: AssumptionDimension.INCOME_BASIS,
  sourceKey: 'vectrus', basis: AmountBasis.GROSS, origin: AssumptionOrigin.USER_REQUESTED,
  stance: AssumptionStance.SUPPOSED, statedAs: 'treat the paycheck as gross' };
const R11 = validatePolicy(FACTUAL, [], policy([supposeGross]));
eq('R11 supposing GROSS over an established NET is CONTRADICTS_ESTABLISHED_FACT',
  R11.rejected[0]?.code, PolicyIssue.CONTRADICTS_ESTABLISHED_FACT);
check('R12 and the rejection names the established basis',
  /already established as NET/.test(R11.rejected[0].reason), R11.rejected[0].reason);
eq('R13 over an UNESTABLISHED basis the same supposition is NOT_A_NET_ASSUMPTION instead',
  validatePolicy(REAL, [], policy([supposeGross])).rejected[0]?.code,
  PolicyIssue.NOT_A_NET_ASSUMPTION);
check('R14 declared counterfactual, it is accepted and WITHDRAWS the conclusion', (() => {
  const r = applyPolicy(FACTUAL, [],
    policy([{ ...supposeGross, id: 'r2', stance: AssumptionStance.COUNTERFACTUAL }]));
  return r.accepted.length === 1
    && r.conclusions.find((c) => c.conclusion === Conclusion.NET_MONTHLY_INFLOW)!.status
      === ConclusionStatus.REFUSED;
})());
check('R15 a NET supposition restating the established fact contradicts nothing', (() => {
  const v = validatePolicy(FACTUAL, [], policy([VECTRUS_NET]));
  return v.accepted.length === 1 && v.rejected.length === 0;
})());
eq('R16 and adds no dependency, because it changed nothing', (() => {
  const r = applyPolicy(FACTUAL, [], policy([VECTRUS_NET]));
  return depsOf(r, Conclusion.NET_MONTHLY_INFLOW);
})(), []);

// ═══════════════════════════════════════════════════════════════════════════
// M. MUTATION TESTING — break it on purpose, and require the right failure
// ═══════════════════════════════════════════════════════════════════════════

// Each mutant is its own file (lib/test-support/mutant-module): a query-string
// cache-bust on one fixed path returned the FIRST mutant on Node 22.
const mutants = mutantLoader(__dirname, 'policy');

async function mutate(
  name: string, find: string, replace: string,
  assertion: (m: typeof import('./policy')) => boolean,
): Promise<void> {
  if (!src.includes(find)) { check(`${name} [anchor present]`, false, `anchor not found: ${find}`); return; }
  const m = await mutants.load<typeof import('./policy')>(src.replace(find, replace));
  let survived: boolean;
  try { survived = assertion(m); } catch { survived = false; }
  check(name, !survived, 'the mutant passed the assertion — the test does not actually pin this');
}

async function mutations(): Promise<void> {
  // 1. An assumption rewrites the UNKNOWN factual state.
  await mutate('M1 an assumption that rewrites the authoritative baseline is caught',
    'baseline: { authority: state.discretionaryBaseline, assumption: spend, status: baselineStatus },',
    'baseline: { authority: licensingShadow(state, accepted).discretionaryBaseline, assumption: spend, status: baselineStatus },',
    (m) => m.applyPolicy(REAL, [], policy([SPEND_4K])).baseline.authority.state
      === ComponentState.UNKNOWN);

  // 2. An UNKNOWN basis is promoted to a factual NET.
  await mutate('M2 promoting an assumed basis onto the authority is caught',
    'authorityBasis: s.basis,',
    'authorityBasis: net ? net.basis : s.basis,',
    (m) => m.applyPolicy(REAL, [], policy([VECTRUS_NET]))
      .incomeStreams.find((s) => s.sourceKey === 'vectrus')!.authorityBasis === AmountBasis.UNKNOWN);

  // 3. A scenario amount acquires a default origin instead of the user's.
  await mutate('M3 a system-defaulted origin on a user scenario is caught',
    "const base = { id, origin: AssumptionOrigin.USER_REQUESTED, stance, statedAs: s.statedAs };",
    "const base = { id, origin: AssumptionOrigin.SYSTEM_POLICY, stance, statedAs: s.statedAs };",
    (m) => {
      const r = m.routeStatement({ mode: m.StatementMode.REQUESTS_SCENARIO, subject:
        { kind: 'SPENDING_LEVEL', amount: 10000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY },
      statedAs: 'x', asOfISO: AS_OF }, 'z');
      return r.destination === 'FORECAST_POLICY'
        && r.assumption.origin === m.AssumptionOrigin.USER_REQUESTED;
    });

  // 4. A spending assumption contaminates unrelated conclusions.
  await mutate('M4 dependency contamination is caught',
    'accepted.filter((a) => isDeviation(a) && AFFECTS[a.dimension].has(c)).map((a) => a.id),',
    'accepted.filter((a) => isDeviation(a)).map((a) => a.id),',
    (m) => m.applyPolicy(REAL, [], policy([SPEND_4K]))
      .conclusions.find((c) => c.conclusion === Conclusion.CURRENT_LIQUID_BALANCE)!
      .dependencies.length === 0);

  // 5. A SILENT stream is reactivated by continuation policy.
  await mutate('M5 reactivation through a continuation policy is caught',
    'if (a.include && !s.projectionEligible) {',
    'if (false) {',
    (m) => m.validatePolicy(REAL, [], policy([restart(AssumptionStance.SUPPOSED)])).accepted.length === 0);

  // 6. A trailing historical average becomes the default baseline.
  await mutate('M6 a system-defaulted spending baseline is caught',
    'export const EMPTY_POLICY: ForecastPolicy = { horizon: null, assumptions: [] };',
    'export const EMPTY_POLICY: ForecastPolicy = { horizon: null, assumptions: [{'
    + " id: 'system:trailing', dimension: AssumptionDimension.SPENDING_BASELINE,"
    + " amount: 4321, currency: 'USD', periodBasis: PeriodBasis.MONTHLY,"
    + ' origin: AssumptionOrigin.SYSTEM_POLICY, stance: AssumptionStance.SUPPOSED,'
    + " statedAs: 'trailing three-month spending' }] };",
    (m) => matchesForecastSeven(m.applyPolicy(REAL, [], m.EMPTY_POLICY), m)
      && m.applyPolicy(REAL, [], m.EMPTY_POLICY).accepted.length === 0);

  // 7. Assumption dependencies are erased from the result.
  await mutate('M7 erasing the dependency list is caught',
    'return { conclusion: c, status, dependencies: deps, missing: [] };',
    'return { conclusion: c, status, dependencies: [], missing: [] };',
    (m) => m.applyPolicy(REAL, [], policy([SPEND_4K, VECTRUS_NET]))
      .conclusions.filter((c) => c.status !== m.ConclusionStatus.FACTUALLY_LICENSED
        && c.status !== m.ConclusionStatus.REFUSED)
      .every((c) => c.dependencies.length > 0));

  // 8. A known event is overwritten by a policy that never named it.
  await mutate('M8 an event assumption escaping its id is caught',
    "reject(a.id, PolicyIssue.UNKNOWN_EVENT, `no event \"${a.eventId}\" was supplied`);\n        continue;\n      }\n      if (!e.amount) {",
    "reject(a.id, PolicyIssue.UNKNOWN_EVENT, `no event \"${a.eventId}\" was supplied`);\n      }\n      if (e && !e.amount) {",
    (m) => m.validatePolicy(REAL, EVENTS,
      policy([netEvent('x', 'nope', AssumptionStance.SUPPOSED)])).accepted.length === 0);

  // 9. No-policy behaviour drifts from FORECAST-7.
  await mutate('M9 treating an unknown baseline as zero under an empty policy is caught',
    'let baseline: BaselineState = state.discretionaryBaseline;',
    'let baseline: BaselineState = { ...state.discretionaryBaseline, '
    + 'state: ComponentState.ASSERTABLE, amount: 0 };',
    (m) => matchesForecastSeven(m.applyPolicy(REAL, [], m.EMPTY_POLICY), m));

  // 10. A contradiction is allowed through without a counterfactual stance.
  await mutate('M10 letting a supposition overwrite an established fact is caught',
    'if (clash && a.stance !== AssumptionStance.COUNTERFACTUAL) {',
    'if (false) {',
    (m) => m.validatePolicy(establishedBaseline, [], policy([SPEND_4K])).accepted.length === 0);

  // 11. A fact-mode statement is laundered into a policy assumption.
  await mutate('M11 laundering an asserted fact into a policy assumption is caught',
    "if (s.mode === StatementMode.ASSERTS_FACT) {",
    "if (false) {",
    (m) => m.routeStatement({ mode: m.StatementMode.ASSERTS_FACT, subject: spendSubject,
      statedAs: 'I spend $4,000/month normally', asOfISO: AS_OF }, 'z')
      .destination === 'UPSTREAM_AUTHORITY');

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void mutations();
