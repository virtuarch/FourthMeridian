/**
 * lib/ai/conversation/scenario-rules.test.ts
 *
 * A SCENARIO CANNOT CLAIM A CLAUSE IT DID NOT RUN — the roster and the name,
 * proved against the real ledger.
 *
 * ⚠️ THE SUBSTITUTION IS REPRODUCED HERE, NOT DESCRIBED. §1 runs the exact rule
 * the live runtime ran for "keep six months of expenses, pay my highest-interest
 * cards first, then invest" — `{ surplusFraction: 1, target: [...] }` under the
 * label "after keeping 6 months of expenses" — and demands that nothing the
 * result or the envelope says can be read as a floor having been kept.
 *
 * ⚠️ NO TEST HERE RECOGNISES ENGLISH, because the mechanism does not. The label
 * is asserted ABSENT from every echo; nothing asserts that a phrase was detected.
 *
 *   npx tsx lib/ai/conversation/scenario-rules.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  expandContributions, runScenarioLedger,
  type ContributionSpec, type LedgerOpening, type LedgerResult, type SpinePoint,
} from './scenario-ledger';
import {
  clausesInForce, compactClauses, contributionBasis, contributionName, outflowName, boundedLabel,
  isClausesInForce, unknownContributionKeys, withoutUnappliedLabels,
  refuseUnknownArguments, refuseUnknownItemKeys, schemaKeys, schemaItemKeys, notAppliedEcho,
  NOT_APPLIED_SHOWN, CONTRIBUTION_KEYS, MAX_LABEL_CHARS, type FloorIdentity,
} from './scenario-rules';
import { captureActiveScenario, scenarioMessage, SCENARIO_TOOL, CROSSING_TOOL } from './active-scenario';
import { resolveMonthsOfExpensesFloor } from '@/lib/ai/measures/baseline';
import { findTool } from './tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const ASOF = '2026-09-20';
const HORIZON = '2027-06-30';
const CARD = { id: 'card-a', label: 'Card A', balance: 1_600, apr: 23.99, minimumPayment: 35 };
const OPENING: LedgerOpening = {
  asOfISO: ASOF, liquid: 13_000, investments: 24_000, debt: 1_600, otherAssets: 0, liabilities: [CARD] };
/** Cash rises $6,500 a month at a stated $5k spending level. */
const PATH: [string, number][] = [
  ['2026-09-30', 15_000], ['2026-10-31', 21_500], ['2026-11-30', 28_000], ['2026-12-31', 34_500],
  ['2027-01-31', 41_000], ['2027-02-28', 47_500], ['2027-03-31', 54_000], ['2027-04-30', 60_500],
  ['2027-05-31', 67_000], ['2027-06-30', 73_500],
];
const SPINE: SpinePoint[] = PATH.map(([date, liquid]) => ({ date, liquid, isCheckpoint: true }));

/**
 * The model's raw contribution → the ledger, by the same two steps
 * `prepareScenario` takes: the floor resolved through the M1 authority, and the
 * NAME taken from `contributionName`, never from the caller's label.
 */
function runRaw(raws: Record<string, unknown>[], statedSpending: number | null = 5_000): {
  ledger: LedgerResult; floors: FloorIdentity[];
  rejected: { input: string; reason: string }[]; result: Record<string, unknown>;
} {
  const floors: FloorIdentity[] = [];
  const rejected: { input: string; reason: string }[] = [];
  const specs: ContributionSpec[] = [];
  for (const raw of raws) {
    const name = contributionName(raw);
    const unknown = unknownContributionKeys(raw);
    if (unknown.length) { rejected.push({ input: name, reason: `unknown ${unknown.join(',')}` }); continue; }
    const { label: _label, liquidFloorMonthsOfExpenses: months, ...rest } = raw;
    void _label;
    let sized: Record<string, unknown> = rest;
    if (months !== undefined) {
      const floor = resolveMonthsOfExpensesFloor({ monthsOfExpenses: Number(months), stated: statedSpending });
      if ('unavailable' in floor) { rejected.push({ input: name, reason: floor.unavailable }); continue; }
      floors.push(floor);
      sized = { ...rest, liquidFloor: floor.liquidFloor };
    }
    const target = sized.target === undefined ? {} : { target: (sized.target as string[]).map((t) =>
      (t === 'investments' || t === 'highest_apr' ? t : { liability: t })) };
    specs.push({ ...sized, ...target, label: name } as unknown as ContributionSpec);
  }
  const expanded = expandContributions(specs, ASOF, HORIZON);
  const ledger = runScenarioLedger({ opening: OPENING, spine: SPINE, contributions: expanded.movements,
    outflows: [], returns: [] });
  rejected.push(...expanded.rejected, ...ledger.rejected);
  const clauses = clausesInForce(ledger, floors);
  // The slice of a `scenario_projection` result the envelope reads.
  const result = { asOf: ASOF, horizon: { to: HORIZON }, assumptions: { clauses },
    checkpoints: ledger.checkpoints };
  return { ledger, floors, rejected, result };
}

const TARGET = ['highest_apr', 'investments'];
const CLAIM = 'after keeping 6 months of expenses';
const SUBSTITUTED = { surplusFraction: 1, target: TARGET, label: CLAIM };
const FLOOR_6 = { liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: TARGET,
  label: 'keep 6 months of expenses, pay highest APR first, then invest' };
const FLOOR_9 = { ...FLOOR_6, liquidFloorMonthsOfExpenses: 9 };

console.log('1. A LABEL CANNOT CLAIM A CLAUSE THAT DID NOT RUN — the live substitution');
{
  const { ledger, floors, rejected, result } = runRaw([SUBSTITUTED]);
  const clauses = clausesInForce(ledger, floors);
  check('the flow rule RAN — it is legal, and it is not refused', rejected.length === 0
    && clauses.surplusShare.ran === true && clauses.surplusShare.share === 1);
  check('the roster says NO cash floor ran', clauses.cashFloor.ran === false);
  check('…in words, where the model is about to narrate it',
    clauses.cashFloor.ran === false && /NO cash floor ran/.test(clauses.cashFloor.meaning ?? ''));
  check('…naming the structured fields that WOULD express one',
    clauses.cashFloor.ran === false && /liquidFloorMonthsOfExpenses/.test(clauses.cashFloor.meaning ?? '')
    && /fractionOfExcess/.test(clauses.cashFloor.meaning ?? ''));
  const last = ledger.checkpoints[ledger.checkpoints.length - 1];
  check('…with the lowest cash the scenario reached, from the ledger',
    clauses.cashFloor.ran === false && clauses.cashFloor.lowestLiquid !== undefined
    && clauses.cashFloor.lowestLiquid.amount === Math.min(...ledger.checkpoints.map((c) => c.liquid!.amount)));
  check('a flow rule never builds the buffer: cash ends far under six months ($30,000)',
    (last.liquid?.amount ?? Infinity) < 30_000, String(last.liquid?.amount));
  const everything = JSON.stringify({ movements: ledger.movements, clauses, rejected });
  check('the caller\'s sentence appears NOWHERE in the movements, the roster or the refusals',
    !everything.includes(CLAIM) && !/6 months/.test(everything));
  check('every settled movement is named by code, and the name says what it is',
    ledger.movements.every((m) => m.label === 'share of the month\'s surplus — keeps no cash floor'));
  check('the debt clause DID run, and the roster says so with the order it ran in',
    clauses.debtPaydown.ran === true && JSON.stringify(clauses.debtPaydown.order) === JSON.stringify(TARGET)
    && clauses.debtPaydown.paidToDebt > 0);

  const cap = captureActiveScenario(SCENARIO_TOOL, { to: HORIZON, assumedMonthlySpending: 5000,
    contributions: [SUBSTITUTED] }, result);
  check('the envelope is established', cap.action === 'REPLACE');
  if (cap.action === 'REPLACE') {
    const text = scenarioMessage(cap.scenario).content;
    check('the ENVELOPE does not carry the claim either', !text.includes(CLAIM) && !/6 months/.test(text));
    check('…and says, in a named slot, that no floor ran',
      (cap.scenario.ran as Record<string, unknown>).cashFloor === 'NONE' && /"cashFloor": "NONE"/.test(text));
    check('…while every structured field is byte-identical, so it still replays',
      JSON.stringify((cap.scenario.assumptions.contributions as unknown[])[0])
        === JSON.stringify({ surplusFraction: 1, target: TARGET }));
  }
}

console.log('\n2. A FLOOR STATED AS MONTHS SURVIVES WITH ITS DERIVATION');
{
  const { ledger, floors, rejected, result } = runRaw([FLOOR_6]);
  const clauses = clausesInForce(ledger, floors);
  check('nothing refused', rejected.length === 0, JSON.stringify(rejected));
  check('the floor ran, at six months of the stated $5k',
    clauses.cashFloor.ran === true && clauses.cashFloor.keep === 30_000 && clauses.cashFloor.fractionOfExcess === 1);
  const as = clauses.cashFloor.ran ? clauses.cashFloor.statedAs : undefined;
  check('…and keeps its identity: months, the spending it multiplied, and that basis',
    !!as && !Array.isArray(as) && as.monthsOfExpenses === 6 && as.atMonthlySpending === 5_000
    && as.spendingBasis === 'STATED', JSON.stringify(as));
  check('the flow clause did NOT run, and the roster says that too', clauses.surplusShare.ran === false);
  check('the movement is named from the fields: months, not dollars the model multiplied',
    ledger.movements.every((m) => m.label === 'cash above a floor of 6 months of expenses'));
  const last = ledger.checkpoints[ledger.checkpoints.length - 1];
  check('the floor was actually held at the horizon', last.liquid?.amount === 30_000, String(last.liquid?.amount));
  const cap = captureActiveScenario(SCENARIO_TOOL, { to: HORIZON, assumedMonthlySpending: 5000,
    contributions: [FLOOR_6] }, result);
  check('the envelope carries the floor as it ran', cap.action === 'REPLACE'
    && JSON.stringify((cap.scenario.ran as Record<string, unknown>).cashFloor)
      === JSON.stringify({ keep: 30_000, monthsOfExpenses: 6, reached: '2026-12-31' }));
  check('a literal-dollar floor has no months identity invented for it', (() => {
    const lit = runRaw([{ liquidFloor: 50_000, fractionOfExcess: 1 }]);
    const c = clausesInForce(lit.ledger, lit.floors).cashFloor;
    return c.ran === true && c.keep === 50_000 && c.statedAs === undefined
      && lit.ledger.movements.every((m) => m.label === 'cash above the floor');
  })());
}

console.log('\n3. SIX → NINE, AND A MUTATION OF AN EXISTING SCENARIO');
{
  const six = runRaw([FLOOR_6]);
  const nine = runRaw([FLOOR_9]);
  const c9 = clausesInForce(nine.ledger, nine.floors).cashFloor;
  check('nine months re-runs the same sentence at the same spending: 45,000',
    c9.ran === true && c9.keep === 45_000 && !Array.isArray(c9.statedAs) && c9.statedAs?.monthsOfExpenses === 9);
  const a6 = { to: HORIZON, assumedMonthlySpending: 5000, contributions: [FLOOR_6] };
  const a9 = { ...a6, contributions: [FLOOR_9] };
  const cap6 = captureActiveScenario(SCENARIO_TOOL, a6, six.result);
  const cap9 = captureActiveScenario(SCENARIO_TOOL, a9, nine.result);
  check('the envelope is REPLACED whole: no trace of six remains',
    cap6.action === 'REPLACE' && cap9.action === 'REPLACE'
    && !JSON.stringify(cap9.scenario).includes('30000') && !/"monthsOfExpenses":6\b/.test(JSON.stringify(cap9.scenario)));
  // "Actually assume a 7% return" — every other argument identical.
  const seven = { ...a9, annualReturnPct: 7 };
  const cap7 = captureActiveScenario(SCENARIO_TOOL, seven, nine.result);
  check('a return added to an existing scenario keeps the floor in `ran`', cap7.action === 'REPLACE'
    && JSON.stringify((cap7.scenario.ran as Record<string, unknown>).cashFloor)
      === JSON.stringify({ keep: 45_000, monthsOfExpenses: 9, reached: '2027-02-28' }));
  // The same question asked of a crossing: the roster is read from `assumptionsInForce`.
  const crossing = { asOf: ASOF, assumptionsInForce: nine.result.assumptions,
    crossing: { date: '2027-03-31', composition: { liquid: 45_000, investments: 30_000, debt: 0, netWorth: 75_000 } } };
  const capX = captureActiveScenario(CROSSING_TOOL, { ...a9, metric: 'netWorth', threshold: 75_000 }, crossing);
  check('a crossing carries the same roster into the envelope', capX.action === 'REPLACE'
    && JSON.stringify(capX.scenario.ran) === JSON.stringify(cap9.action === 'REPLACE' ? cap9.scenario.ran : null));
  // The 0/6 case: an envelope that holds the substitution now SAYS it holds it.
  const sub = runRaw([SUBSTITUTED]);
  const capSub = captureActiveScenario(SCENARIO_TOOL, { to: HORIZON, contributions: [SUBSTITUTED] }, sub.result);
  check('an envelope holding the substitution states `cashFloor: NONE` on every later turn',
    capSub.action === 'REPLACE' && (capSub.scenario.ran as Record<string, unknown>).cashFloor === 'NONE');
}

console.log('\n4. FRESH ESTABLISHMENT — what the envelope keeps of the arguments');
{
  const args = { to: HORIZON, annualReturnPct: 7,
    contributions: [
      FLOOR_6,
      { amount: 500, from: '2026-10-01', cadence: 'monthly', label: 'Roth IRA' },
      { amount: 250, from: '2026-10-01', cadence: 'monthly',
        label: 'a very long sentence that describes a whole strategy and keeps a six month buffer' },
    ],
    outflows: [{ onDate: '2026-12-07', amount: -15000, label: 'bonus (net)' }] };
  const kept = withoutUnappliedLabels(args);
  const cs = kept.contributions as Record<string, unknown>[];
  check('a RULE loses its label', !('label' in cs[0]));
  check('…and nothing else', JSON.stringify(cs[0])
    === JSON.stringify({ liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: TARGET }));
  check('a fixed amount keeps its name', cs[1].label === 'Roth IRA');
  check(`…bounded to ${MAX_LABEL_CHARS} characters`, typeof cs[2].label === 'string'
    && (cs[2].label as string).length === MAX_LABEL_CHARS && (cs[2].label as string).endsWith('…'));
  check('an outflow label that is already a short name is byte-identical',
    JSON.stringify(kept.outflows) === JSON.stringify(args.outflows));
  check('the caller\'s object is not mutated', FLOOR_6.label.startsWith('keep 6 months')
    && 'label' in (args.contributions[0] as Record<string, unknown>));
  check('arguments with no contributions pass through as the same object',
    withoutUnappliedLabels({ to: HORIZON }) !== null
    && JSON.stringify(withoutUnappliedLabels({ to: HORIZON })) === JSON.stringify({ to: HORIZON }));
  check('a fixed amount is named as the caller\'s words, quoted — never as a rule',
    contributionName({ amount: 500, label: 'Roth IRA' }) === 'fixed amount, named "Roth IRA" by the caller'
    && contributionName({ amount: 500 }) === 'fixed amount');
  check('a blank label is no name', boundedLabel('   ') === null && boundedLabel(undefined) === null);
  const established = runRaw([FLOOR_6]);
  const cap = captureActiveScenario(SCENARIO_TOOL, args, established.result);
  // I1 — `covers` is the fourth member: one derived sentence naming the single
  // date the figures are for, and — only when the roster shows a clause that
  // bends the path — that another date is a different computation. Measured: the
  // horizon change "what about next June?" gave a stale prose figure 6/6 without
  // it and 0/6 with it.
  check('exactly four keys, in one order, when the result carries a roster', cap.action === 'REPLACE'
    && Object.keys(cap.scenario).join(',') === 'assumptions,ran,result,covers');
  check('a result with NO roster yields the pair plus `covers`', (() => {
    const c = captureActiveScenario(SCENARIO_TOOL, args, { ...established.result, assumptions: {} });
    return c.action === 'REPLACE' && Object.keys(c.scenario).join(',') === 'assumptions,result,covers';
  })());
  // ⚠️ 900 → 1,100 B, the measured cost of `covers` on a floor scenario (~210 B),
  // and no further. The cookie refuses above 3,000 chars.
  check('the envelope stays well inside the cookie: < 1,100 B for a three-rule scenario', cap.action === 'REPLACE'
    && JSON.stringify(cap.scenario).length < 1100, cap.action === 'REPLACE' ? `${JSON.stringify(cap.scenario).length} B` : '');
}

console.log('\n5. A CLAUSE INTENTIONALLY REMOVED IS ALLOWED, AND ECHOED AS ABSENT');
{
  // "Forget the buffer — just put everything I save toward the cards, then invest."
  const { ledger, floors, rejected } = runRaw([{ surplusFraction: 1, target: TARGET }]);
  const clauses = clausesInForce(ledger, floors);
  check('NOT rejected: dropping a floor is the user\'s right', rejected.length === 0);
  check('the scenario ran', ledger.movements.length > 0);
  check('…and the echo says the floor is absent rather than staying silent', clauses.cashFloor.ran === false
    && typeof (clauses.cashFloor as { meaning?: string }).meaning === 'string');
  // And the other way: debt paydown removed.
  const noDebt = runRaw([{ liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1 }]);
  const c2 = clausesInForce(noDebt.ledger, noDebt.floors);
  check('a removed debt clause is allowed and echoed as absent', noDebt.rejected.length === 0
    && c2.debtPaydown.ran === false && /No rule named a liability/.test((c2.debtPaydown as { meaning?: string }).meaning ?? ''));
  check('a debt target with nothing left owed still RAN — it is the rule, not the payment, that is echoed', (() => {
    const paidOff = { ...OPENING, debt: 0, liabilities: [{ ...CARD, balance: 0 }] };
    const e = expandContributions([{ surplusFraction: 1, target: ['highest_apr', 'investments'] }], ASOF, HORIZON);
    const l = runScenarioLedger({ opening: paidOff, spine: SPINE, contributions: e.movements, outflows: [], returns: [] });
    const d = clausesInForce(l).debtPaydown;
    return d.ran === true && d.paidToDebt === 0;
  })());
}

console.log('\n6. AN UNSUPPORTED CLAUSE IS REFUSED BY NAME, NEVER RUN WITHOUT');
{
  check('the contract\'s key set is closed and is the schema\'s', CONTRIBUTION_KEYS.length === 12);
  const raw = { surplusFraction: 1, target: TARGET, keepMonthsOfExpenses: 6 };
  check('a key outside it is found', JSON.stringify(unknownContributionKeys(raw)) === '["keepMonthsOfExpenses"]');
  check('an undefined value is not a stated clause', unknownContributionKeys({ amount: 5, minCash: undefined }).length === 0);
  const { ledger, rejected } = runRaw([raw]);
  check('the rule is refused', rejected.length === 1);
  check('…and did NOT run as the weaker rule it would otherwise have been', ledger.movements.length === 0);
  const tools = readFileSync('lib/ai/conversation/tools.ts', 'utf8');
  check('prepareScenario refuses on the same check, before it sizes anything',
    /const unknown = unknownContributionKeys\(raw\);\s*if \(unknown\.length > 0\) \{\s*rejected\.push/.test(tools));
  // I1 — the shared schema literal moved to `scenario-inputs.ts` so the continuity
  // policy could be derived from it rather than typed out a second time. This scrape
  // follows the literal; the bidirectional equality at 6b reads the same object
  // through `schemaItemKeys` and does not depend on where the text lives.
  const inputs = readFileSync('lib/ai/conversation/scenario-inputs.ts', 'utf8');
  check('…and every schema property is a key the contract knows', (() => {
    const block = inputs.slice(inputs.indexOf('contributions: { type: \'array\''), inputs.indexOf('outflows: { type: \'array\''));
    const props = [...block.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]);
    return props.length === CONTRIBUTION_KEYS.length && props.every((p) => (CONTRIBUTION_KEYS as readonly string[]).includes(p));
  })());
}

console.log('\n6b. A CLOSED ARGUMENT SET — the schema the model was shown is the one literal');
{
  const SCENARIO_TOOLS = ['scenario_projection', 'scenario_crossing', 'scenario_goal_seek'] as const;
  const SHARED = ['granularity', 'annualReturnPct', 'returns', 'contributions', 'outflows',
    'assumedMonthlySpending', 'liabilityAssumptions'];
  for (const name of SCENARIO_TOOLS) {
    const schema = findTool(name)!.parameters;
    const keys = schemaKeys(schema);
    check(`${name}: the closed set is readable off its own schema`, keys !== null
      && SHARED.every((k) => keys.includes(k)), JSON.stringify(keys));
    for (const arr of ['returns', 'contributions', 'outflows', 'liabilityAssumptions']) {
      check(`${name}: \`${arr}\` entries declare their keys`, (schemaItemKeys(schema, arr) ?? []).length > 0);
    }
    check(`${name}: the contribution keys the schema declares ARE the contract's`,
      JSON.stringify([...(schemaItemKeys(schema, 'contributions') ?? [])].sort())
        === JSON.stringify([...CONTRIBUTION_KEYS].sort()));
    // The reviewer's three: a premature argument, a singular, a misplaced clause.
    // ⚠️ `incomeChanges` WAS THIS LIST'S FIRST EXAMPLE, THEN `spendingChanges`, AND
    // BOTH ARE NOW REAL ARGUMENTS (I1, S1). `taxChanges` — which does not exist —
    // replaces them as the premature one, so the case this list exists for is still
    // covered: an argument no execution honours is refused, never run as another.
    for (const bad of ['taxChanges', 'contribution', 'floor', 'liquidFloor']) {
      const refused = refuseUnknownArguments({ contributions: [], [bad]: 1 }, schema);
      check(`${name}: \`${bad}\` is refused by name`, refused.length === 1 && refused[0].argument === bad
        && refused[0].input === `argument \`${bad}\`` && /NOT applied/.test(refused[0].reason)
        && /`contributions`/.test(refused[0].reason));
    }
    check(`${name}: every argument it declares is accepted`,
      refuseUnknownArguments(Object.fromEntries((keys ?? []).map((k) => [k, 1])), schema).length === 0);
    // I1 — declared, so accepted; and its ENTRIES are closed the same way a
    // contribution's are, so an invented field on one is refused rather than run
    // without. The consumer side is pinned in `scenario-contract.test.ts`.
    check(`${name}: \`incomeChanges\` is a declared argument`, (keys ?? []).includes('incomeChanges'));
    check(`${name}: \`spendingChanges\` is a declared argument (S1)`, (keys ?? []).includes('spendingChanges'));
    check(`${name}: \`incomeChanges\` entries declare their keys`,
      JSON.stringify([...(schemaItemKeys(schema, 'incomeChanges') ?? [])].sort())
        === JSON.stringify(['amount', 'basis', 'cadence', 'from', 'label', 'multiplier',
          'op', 'per', 'source', 'to']));
    check(`${name}: an invented key on an \`incomeChanges\` entry is refused`,
      refuseUnknownItemKeys({ op: 'SCALE', from: '2027-01-01', percent: 10 },
        schema, 'incomeChanges', 'an entry') !== null);
  }
  const proj = findTool('scenario_projection')!.parameters;
  const cross = findTool('scenario_crossing')!.parameters;
  check('PER TOOL: a crossing\'s `threshold` is not a projection argument',
    refuseUnknownArguments({ to: 'x', threshold: 1 }, proj).length === 1
    && refuseUnknownArguments({ metric: 'netWorth', direction: 'at_or_above', threshold: 1 }, cross).length === 0);
  check('…and a goal seek\'s own arguments pass on the goal seek only',
    refuseUnknownArguments({ target: 1, by: 'x', solveFor: 'annualReturnPct', measure: 'debt', contributionTarget: 'highest_apr' },
      findTool('scenario_goal_seek')!.parameters).length === 0
    && refuseUnknownArguments({ to: 'x', solveFor: 'annualReturnPct' }, proj).length === 1);
  check('an undefined value is not a stated argument', refuseUnknownArguments({ to: 'x', nope: undefined }, proj).length === 0);
  check('a schema that declares nothing refuses nothing (and the checks above pin that it does declare)',
    refuseUnknownArguments({ anything: 1 }, {}).length === 0 && schemaKeys(null) === null);

  // Array entries: an undeclared key refuses the ENTRY, never runs the rest of it.
  const out = refuseUnknownItemKeys({ onDate: '2026-12-01', amount: 30000, recurring: true }, proj, 'outflows', 'car');
  check('an outflow with an undeclared key is refused by name, naming the key and the fields that exist',
    out !== null && out.input === 'car' && /`recurring`/.test(out.reason) && /`onDate`, `amount`, `label`/.test(out.reason));
  check('a well-formed outflow passes', refuseUnknownItemKeys({ onDate: 'x', amount: 1, label: 'car' }, proj, 'outflows', 'car') === null);
  check('a return period with an undeclared key is refused',
    refuseUnknownItemKeys({ from: 'a', to: 'b', annualPct: 8, compounding: 'daily' }, proj, 'returns', 'r') !== null);
  check('a liability assumption with `aprPct` (not `apr`) is refused rather than silently assuming nothing',
    refuseUnknownItemKeys({ liabilityId: 'x', aprPct: 18 }, proj, 'liabilityAssumptions', 'la', ['id']) !== null);
  check('…while the `id` alias the parser actually READS is not a silent drop and is not refused',
    refuseUnknownItemKeys({ id: 'x', apr: 18 }, proj, 'liabilityAssumptions', 'la', ['id']) === null);

  // The echo, and what the envelope remembers.
  check('nothing refused ⇒ no `notApplied` key at all', notAppliedEcho([]) === undefined);
  const many = Array.from({ length: 12 }, (_, i) => ({ input: `x${i}`, reason: 'r' }));
  const echo = notAppliedEcho(many)!;
  check('the echo is bounded and says how many there were', echo.count === 12 && echo.inputs.length === NOT_APPLIED_SHOWN);
  const floorRun = runRaw([FLOOR_6]);
  const refusedArgs = refuseUnknownArguments({ to: HORIZON, taxChanges: [{ from: '2027-01-01', monthly: 1500 }] }, proj);
  const result = { ...floorRun.result,
    assumptions: { ...(floorRun.result.assumptions as object), notApplied: notAppliedEcho(refusedArgs) } };
  const cap = captureActiveScenario(SCENARIO_TOOL,
    { to: HORIZON, taxChanges: [{ from: '2027-01-01', monthly: 1500 }], contributions: [FLOOR_6] }, result);
  check('the envelope does NOT remember an argument no execution honoured', cap.action === 'REPLACE'
    && !('taxChanges' in cap.scenario.assumptions) && !JSON.stringify(cap.scenario).includes('taxChanges'));
  check('…and keeps every argument that was', cap.action === 'REPLACE'
    && Object.keys(cap.scenario.assumptions).join(',') === 'to,contributions');
  const crossing = { asOf: ASOF, assumptionsInForce: result.assumptions,
    crossing: { date: '2027-03-31', composition: { liquid: 30_000, investments: 30_000, debt: 0, netWorth: 60_000 } } };
  const capX = captureActiveScenario(CROSSING_TOOL, { metric: 'netWorth', direction: 'at_or_above', threshold: 60_000,
    taxChanges: [1], contributions: [FLOOR_6] }, crossing);
  check('…on a crossing too, read from `assumptionsInForce`', capX.action === 'REPLACE'
    && !('taxChanges' in capX.scenario.assumptions));

  const tools = readFileSync('lib/ai/conversation/tools.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  check('prepareScenario refuses against the CALLING tool\'s schema, before anything is sized',
    /const rejected: RefusedInput\[\] = \[\.\.\.refuseUnknownArguments\(a, tool\.parameters\)\];/.test(tools));
  check('…and each scenario tool hands it its own definition — no tool calls it without one',
    /prepareScenario\(a, ctx, String\(a\.to\), scenarioProjection\)/.test(tools)
    && /prepareScenario\(a, ctx, searchThrough, scenarioCrossing, dates\)/.test(tools)
    && /prepareScenario\(a, ctx, toISO, scenarioGoalSeek\)/.test(tools)
    && (tools.match(/prepareScenario\(a, /g) ?? []).length === 3);
  check('…`returns`, `outflows` and `liabilityAssumptions` entries pass through the same refusal',
    ['returns', 'outflows', 'liabilityAssumptions'].every((k) => tools.includes(`declared('${k}',`)));
  check('the refusals ride in the echo every scenario path returns',
    /function scenarioAssumptions\([\s\S]*?notApplied: notAppliedEcho\(\[\.\.\.setup\.rejected, \.\.\.ledger\.rejected\]\)/.test(tools));
}

console.log('\n7. BOTH BASES STATED — the ledger\'s refusal stays, and the roster agrees');
{
  const raw = { surplusFraction: 1, liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: TARGET };
  check('two bases have no single name', contributionBasis(raw) === 'UNDETERMINED'
    && contributionName(raw) === 'contribution');
  const { ledger, floors, rejected } = runRaw([raw]);
  check('refused by the ledger, in its own words', rejected.length === 1 && /EXACTLY ONE/.test(rejected[0].reason));
  check('nothing ran', ledger.movements.length === 0);
  const clauses = clausesInForce(ledger, floors);
  check('the roster reports every clause as not having run',
    Object.values(clauses).every((c) => (c as { ran: boolean }).ran === false));
  check('…without the absence sentences: with nothing moving cash, a floor constrains nothing',
    !('meaning' in clauses.cashFloor) && !('meaning' in clauses.debtPaydown));
  check('half a floor pair is still a floor basis, so the ledger refuses it as an incomplete floor',
    contributionBasis({ liquidFloor: 30_000 }) === 'FLOOR' && contributionBasis({ fractionOfExcess: 1 }) === 'FLOOR');
}

console.log('\n7b. A FLOOR BESIDE A FLOW SHARE — the floor does not govern the share, and the roster says so');
{
  // Measured live: the model ran a 50% surplus share AND a nine-month floor.
  const { ledger, floors, rejected } = runRaw([{ surplusFraction: 0.5, target: TARGET }, FLOOR_9]);
  const c = clausesInForce(ledger, floors);
  check('both rules are legal and both ran', rejected.length === 0 && c.cashFloor.ran && c.surplusShare.ran);
  const last = ledger.checkpoints[ledger.checkpoints.length - 1];
  check('the arithmetic: cash ends UNDER the floor, because the share is taken regardless',
    (last.liquid?.amount ?? Infinity) < 45_000, String(last.liquid?.amount));
  check('the roster names the rule the floor does not bind', c.cashFloor.ran === true
    && JSON.stringify(c.cashFloor.notBoundByFloor?.rules) === '["surplusShare"]'
    && /BELOW the floor/.test(c.cashFloor.notBoundByFloor?.meaning ?? ''));
  check('…and so does the envelope, by name', JSON.stringify(compactClauses(c).cashFloor)
    === '{"keep":45000,"monthsOfExpenses":9,"reached":false,"notBoundByFloor":["surplusShare"]}',
    JSON.stringify(compactClauses(c).cashFloor));
  const alone = runRaw([FLOOR_9]);
  const ca = clausesInForce(alone.ledger, alone.floors).cashFloor;
  check('a floor rule alone carries no such caveat', ca.ran === true && ca.notBoundByFloor === undefined);
  const zero = runRaw([FLOOR_9, { amount: 500, onDate: '2099-01-01', label: 'never' }]);
  const cz = clausesInForce(zero.ledger, zero.floors).cashFloor;
  check('…nor does one beside a rule that settled nothing', cz.ran === true && cz.notBoundByFloor === undefined);
}

console.log('\n7c. A FLOOR RULE THAT RAN IS NOT A FLOOR THAT WAS KEPT (review NB3a)');
{
  // Nine months of a stated 20k = 180,000: the path tops out at 73,500 and never gets there.
  const never = runRaw([FLOOR_9], 20_000);
  const c = clausesInForce(never.ledger, never.floors).cashFloor;
  check('the rule ran — that is still the truth about the rule', c.ran === true && c.keep === 180_000);
  check('…and the roster says the floor was NEVER reached, from the balances the settler read',
    c.ran === true && c.firstReached === null && c.monthsBelowAfterReached === 0
    && /never reached the floor/.test(c.neverReached ?? ''));
  check('…and nothing moved', never.ledger.movements.every((m) => m.amount === 0));
  const cap = captureActiveScenario(SCENARIO_TOOL, { to: HORIZON, assumedMonthlySpending: 20_000,
    contributions: [FLOOR_9] }, never.result);
  check('the ENVELOPE says `reached: false` beside `keep`, so 180,000 next to 73,500 reads as "not there yet"',
    cap.action === 'REPLACE' && JSON.stringify((cap.scenario.ran as Record<string, unknown>).cashFloor)
      === '{"keep":180000,"monthsOfExpenses":9,"reached":false}');
  const reached = runRaw([FLOOR_6]);
  const r = clausesInForce(reached.ledger, reached.floors).cashFloor;
  check('a floor that WAS reached says when, and carries no never-reached sentence',
    r.ran === true && r.firstReached === '2026-12-31' && r.neverReached === undefined && r.monthsBelowAfterReached === 0);
  // Reached, then knocked under by a later fall: the path drops 20k in March.
  const dip = (() => {
    const path: [string, number][] = PATH.map(([d, v]) => [d, d >= '2027-03-31' ? v - 40_000 : v]);
    const e = expandContributions([{ liquidFloor: 30_000, fractionOfExcess: 1, label: 'cash above the floor' }], ASOF, HORIZON);
    const l = runScenarioLedger({ opening: { ...OPENING, debt: 0, liabilities: [] },
      spine: path.map(([date, liquid]) => ({ date, liquid, isCheckpoint: true })),
      contributions: e.movements, outflows: [], returns: [] });
    return clausesInForce(l).cashFloor;
  })();
  check('a floor reached and then broken counts the month-ends under it, and the envelope carries the count',
    dip.ran === true && dip.firstReached === '2026-12-31' && dip.monthsBelowAfterReached > 0
    && (compactClauses({ ...clausesInForce(reached.ledger, reached.floors), cashFloor: dip }).cashFloor as { monthsBelow?: number }).monthsBelow
      === dip.monthsBelowAfterReached, JSON.stringify(dip));
  // The pinned ceilings are NOT raised by any of this.
  const worst = runRaw([{ surplusFraction: 0.5, target: TARGET }, FLOOR_9,
    { amount: 500, from: '2026-10-31', cadence: 'monthly', label: 'Roth IRA' }], 20_000);
  const worstCompact = JSON.stringify(compactClauses(clausesInForce(worst.ledger, worst.floors)));
  const floorCompact = JSON.stringify(compactClauses(clausesInForce(never.ledger, never.floors)));
  const reachedCompact = JSON.stringify(compactClauses(clausesInForce(reached.ledger, reached.floors)));
  // ⚠️ 200 → 225 B, AND THE RAISE IS THE WHOLE OF I1'S ENVELOPE COST. The roster
  // gained a sixth clause, so every scenario — including one with no income rule
  // at all — now carries `"incomeChange":"NONE"`: 25 bytes, measured, on a raw
  // envelope ceiling of 900 B. That word is the point of the closed roster. A
  // missing key is not a statement, and the clause this whole module exists for
  // was invisible for exactly that reason.
  // ⚠️ 225 → 249 B, AND THE RAISE IS THE WHOLE OF S1'S ROSTER COST — exactly as I1's
  // was: a seventh clause, so every scenario now carries `"spendingChange":"NONE"`,
  // 24 bytes measured. The envelope pin (1,100 B) and the seal ceiling are unchanged.
  check('a floor scenario\'s envelope roster still fits the pinned 249 B, reached or not',
    floorCompact.length < 249 && reachedCompact.length < 249, `${floorCompact.length} B / ${reachedCompact.length} B`);
  // ⚠️ A NEW, SEPARATE BOUND — not the 200 B pin raised. Every clause kind running at once
  // (floor + months + two unbound rules + share + fixed amounts + a debt order) was already
  // 225 B before `reached` existed; the 200 B pin never covered it. It is bounded here so it
  // cannot grow unnoticed, and the raw envelope ceiling (900 B) is what protects the cookie.
  // Likewise +25 B for the sixth clause's `"NONE"`; no income rule runs in `worst`.
  // …and +24 B again for the seventh clause's `"NONE"` (S1); no spending rule runs in `worst`.
  check('every clause at once is bounded too (its own bound: 309 B)', worstCompact.length < 309, `${worstCompact.length} B`);
}

console.log('\n7d. THE ORDER IS THE SETTLER\'S RECORD, NOT A MATCH (review NB3b)');
{
  // Two fixed amounts, same date, same size. One names a liability that does not exist and is
  // REFUSED at settlement; the other goes to investments. Nothing a movement carries tells them apart.
  const specs: ContributionSpec[] = [
    { onDate: '2026-10-31', amount: 500, target: [{ liability: 'ghost-card' }, 'investments'], label: 'fixed amount' },
    { onDate: '2026-10-31', amount: 500, target: ['investments'], label: 'fixed amount' },
  ];
  const e = expandContributions(specs, ASOF, HORIZON);
  const l = runScenarioLedger({ opening: OPENING, spine: SPINE, contributions: e.movements, outflows: [], returns: [] });
  check('the fixture is what it claims: one rule refused, one settled',
    l.rejected.length === 1 && /ghost-card/.test(l.rejected[0].reason) && l.movements.length === 1);
  check('the ledger recorded only the order it PLACED', JSON.stringify(l.allocationOrders) === '[["investments"]]');
  const d = clausesInForce(l).debtPaydown;
  check('the roster does NOT report the refused rule\'s order — no debt clause ran',
    d.ran === false, JSON.stringify(d));
  // And the mirror image: the settled one pays debt, the refused one did not.
  const mirror = expandContributions([
    { onDate: '2026-10-31', amount: 500, target: [{ liability: 'ghost-card' }], label: 'fixed amount' },
    { onDate: '2026-10-31', amount: 500, target: ['highest_apr', 'investments'], label: 'fixed amount' },
  ], ASOF, HORIZON);
  const lm = runScenarioLedger({ opening: OPENING, spine: SPINE, contributions: mirror.movements, outflows: [], returns: [] });
  const dm = clausesInForce(lm).debtPaydown;
  check('…and reports exactly the settled rule\'s order when that one does',
    dm.ran === true && JSON.stringify(dm.order) === '["highest_apr","investments"]' && dm.paidToDebt === 500);
  check('an untargeted (pre-L1) rule records no order and the movement is the object it always was',
    (() => { const u = expandContributions([{ onDate: '2026-10-31', amount: 500 }], ASOF, HORIZON);
      const lu = runScenarioLedger({ opening: OPENING, spine: SPINE, contributions: u.movements, outflows: [], returns: [] });
      return lu.allocationOrders.length === 0 && !('placed' in lu.movements[0]); })());
  check('a monthly rule records its order ONCE, not once per month', (() => {
    const r = runRaw([SUBSTITUTED]); return r.ledger.allocationOrders.length === 1; })());
  const rules = readFileSync('lib/ai/conversation/scenario-rules.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  check('the roster no longer takes the plan at all — there is nothing left to mis-match',
    !/PlannedMovement|planned/.test(rules));
}

console.log('\n7e. AN OUTFLOW LABEL IS BOUNDED AND DEMOTED LIKE A CONTRIBUTION\'S (review NB4)');
{
  const LONG = 'a trip that I will definitely pay for after keeping nine months of expenses in cash';
  check('named by code first, the caller\'s words quoted after',
    outflowName({ amount: 30_000, label: 'car' }) === 'one-off outflow, named "car" by the caller');
  check('a negative amount is an INFLOW, and code says so whatever the label says',
    outflowName({ amount: -15_000, label: 'bonus (net)' }) === 'one-off inflow, named "bonus (net)" by the caller');
  check('no label ⇒ just what it is', outflowName({ amount: 100 }) === 'one-off outflow');
  check(`a sentence is cut to ${MAX_LABEL_CHARS} characters`, outflowName({ amount: 1, label: LONG }).length
    === 'one-off outflow, named "" by the caller'.length + MAX_LABEL_CHARS && !outflowName({ amount: 1, label: LONG }).includes('nine months'));
  const kept = withoutUnappliedLabels({ to: HORIZON, outflows: [{ onDate: '2027-01-01', amount: 1, label: LONG },
    { onDate: '2027-01-02', amount: 2 }] });
  const o = kept.outflows as Record<string, unknown>[];
  check('the envelope bounds it too, and leaves a label-less outflow alone',
    (o[0].label as string).length === MAX_LABEL_CHARS && !('label' in o[1]) && o[0].amount === 1 && o[0].onDate === '2027-01-01');
  const tools = readFileSync('lib/ai/conversation/tools.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const prep = tools.slice(tools.indexOf('async function prepareScenario('), tools.indexOf('function surplusRule('));
  check('prepareScenario names every outflow by code and never reads its label',
    /const label\s+= outflowName\(o\);/.test(prep) && !/o\.label/.test(prep));
}

console.log('\n8. THE ROSTER IS CLOSED — every clause kind, on every result');
{
  const KEYS = 'cashFloor,surplusShare,balanceShare,fixedAmounts,debtPaydown,incomeChange,spendingChange';
  for (const [name, raws] of [
    ['no contributions', []],
    ['floor', [FLOOR_6]],
    ['surplus', [SUBSTITUTED]],
    ['balance share', [{ fractionOfLiquid: 0.5, from: '2026-12-31', cadence: 'yearly' }]],
    ['fixed amount', [{ amount: 500, from: '2026-10-31', cadence: 'monthly', label: 'Roth IRA' }]],
  ] as [string, Record<string, unknown>[]][]) {
    const r = runRaw(raws);
    const c = clausesInForce(r.ledger, r.floors);
    check(`${name}: seven keys, each with a boolean \`ran\``, Object.keys(c).join(',') === KEYS && isClausesInForce(c));
    check(`${name}: the compact form keeps all seven`, Object.keys(compactClauses(c)).join(',') === KEYS);
  }
  const fixed = runRaw([{ amount: 500, from: '2026-10-31', cadence: 'monthly', label: 'Roth IRA' }]);
  const cf = clausesInForce(fixed.ledger, fixed.floors);
  check('fixed amounts are counted and totalled from what settled', cf.fixedAmounts.ran === true
    && cf.fixedAmounts.count === 9 && cf.fixedAmounts.total === 4_500, JSON.stringify(cf.fixedAmounts));
  check('…and a fixed amount keeps no floor either, which the roster says', cf.cashFloor.ran === false);
  const bal = runRaw([{ fractionOfLiquid: 0.5, from: '2026-12-31', cadence: 'yearly' }]);
  const cb = clausesInForce(bal.ledger, bal.floors);
  check('a balance share is its own clause, not a surplus share', cb.balanceShare.ran === true
    && cb.balanceShare.share === 0.5 && cb.surplusShare.ran === false);
  const sub = runRaw([SUBSTITUTED]);
  const full = JSON.stringify(clausesInForce(sub.ledger, sub.floors));
  const small = JSON.stringify(compactClauses(clausesInForce(sub.ledger, sub.floors)));
  check('bounded: the result roster < 1,100 B, the envelope roster < 200 B', full.length < 1_100 && small.length < 200,
    `${full.length} B / ${small.length} B`);
  check('isClausesInForce refuses anything else', !isClausesInForce(null) && !isClausesInForce({})
    && !isClausesInForce({ cashFloor: { ran: 'yes' } }));
}

console.log('\n9. STRUCTURE — where the label can and cannot go');
{
  const code = (rel: string) => readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const tools = code('lib/ai/conversation/tools.ts');
  const prep = tools.slice(tools.indexOf('async function prepareScenario('), tools.indexOf('function surplusRule('));
  check('prepareScenario names every contribution by code', /const name = contributionName\(raw\);/.test(prep)
    && /const label = name;/.test(prep));
  check('…and never reads the caller\'s contribution label', !/raw\.label|c\.label/.test(prep));
  check('the roster is part of `scenarioAssumptions`, so all three scenario tools echo it',
    // FM-AUDIT-011 — the roster echoes the floor derivations THIS run used (re-resolved
    // at a transformed spending level), not the setup's base ones.
    /function scenarioAssumptions\([\s\S]{0,400}?clauses: clausesInForce\(ledger,\s+floorDerivationsOf\(setup, ledger\)/.test(tools)
    && (tools.match(/scenarioAssumptions\(setup, /g) ?? []).length >= 3);
  const rules = code('lib/ai/conversation/scenario-rules.ts');
  check('scenario-rules is pure: type-only imports, no clock, no I/O',
    [...rules.matchAll(/^import .*$/gm)].every((m) => m[0].startsWith('import type'))
    && !/Date\.now|new Date|process\.|await |fetch\(/.test(rules));
  check('…and recognises no English: no pattern is ever applied to a label',
    !/label[^\n]{0,60}\.(test|match|includes|search)\(|RegExp/.test(rules));
  const env = code('lib/ai/conversation/active-scenario.ts');
  check('the envelope takes its roster from the SAME result, in the SAME literal',
    /scenario: \{\n\s*assumptions: stated,\n\s*\.\.\.\(ran \? \{ ran \} : \{\}\),\n\s*result: \{ asOf, to, liquid, investments, debt, netWorth \},/.test(env));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
