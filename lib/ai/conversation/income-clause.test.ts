/**
 * lib/ai/conversation/income-clause.test.ts   (I1)
 *
 * THE SIXTH CLAUSE, FROM EXECUTION EVIDENCE TO WHAT A LATER TURN READS.
 *
 * `lib/forecast/income-change.test.ts` pins what the transformation DOES. This
 * pins what the result SAYS about it, and what survives into the envelope — the
 * two places a wrong sentence outlives a right number.
 *
 * ⚠️ THE CLAUSE IS BUILT FROM EXECUTIONS, AND EXECUTIONS ONLY. Every fixture
 * below is an `IncomeChangeExecution`, which is the spine's output; there is no
 * way to reach `incomeClause` from a tool argument, and §5 proves a caller's
 * fields cannot forge a `ran`.
 *
 * Pure: no DB, no model, no clock.
 */

import {
  clausesInForce, compactClauses, incomeClause, isClausesInForce,
} from './scenario-rules';
import { captureActiveScenario, SCENARIO_TOOL } from './active-scenario';
import type { IncomeChangeExecution } from '@/lib/forecast/income-change';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  check(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** An execution with everything a ran rule carries, overridable field by field. */
const exec = (o: Partial<IncomeChangeExecution> = {}): IncomeChangeExecution => ({
  ruleId: 'i1', op: 'SCALE', scope: 'NAMED',
  matched: [{ sourceKey: 'acme@a1', label: 'Acme payroll' }],
  occurrencesChanged: 26,
  firstChangedISO: '2027-01-01', lastChangedISO: '2027-12-17',
  requested: { fromISO: '2027-01-01', toISO: null },
  governed: { fromISO: '2027-01-01', toISO: '2027-12-31' },
  nominalBefore: 100_000, nominalAfter: 110_000,
  spendableBefore: 100_000, spendableAfter: 110_000,
  ran: true, ...o,
});

const EMPTY_LEDGER = { movements: [], checkpoints: [], allocationOrders: [] };

console.log('income-clause — what the sixth clause says, and what a later turn reads');

// ── 1. Nothing stated is silent; stated-and-inert is NOT ─────────────────────
{
  eq('no income rule at all: the clause is present and says nothing more',
    incomeClause([]), { ran: false });

  // ⚠️ THE WHOLE POINT OF THE SIXTH CLAUSE. A scenario that WAS given a rule and
  // changed no pay date has to say so, because that is the case a reader would
  // otherwise read as "the raise is in here". The other five clauses learned this
  // the hard way (G5); this one is born with it.
  const inert = incomeClause([exec({ ran: false, occurrencesChanged: 0,
    firstChangedISO: null, lastChangedISO: null, governed: null,
    requested: { fromISO: '2029-01-01', toISO: null },
    nominalBefore: 0, nominalAfter: 0, spendableBefore: 0, spendableAfter: 0,
    reason: 'it starts on 2029-01-01, after this projection ends' })]);
  check('a rule that ran NOTHING reports ran:false…', inert.ran === false);
  check('…names the rule under didNotRun', 'didNotRun' in inert && inert.didNotRun!.length === 1);
  check('…carries its reason verbatim',
    (inert as { didNotRun: { reason?: string }[] }).didNotRun[0].reason?.includes('2029-01-01') === true);
  check('…and states plainly that the figures were computed WITHOUT it',
    /NO pay date changed|computed at the CURRENT income/.test((inert as { meaning?: string }).meaning ?? ''));
  check('…and the two cases are distinguishable at a glance',
    JSON.stringify(incomeClause([])) !== JSON.stringify(inert));
}

// ── 2. A rule that ran, and a window it did not cover ────────────────────────
{
  const ran = incomeClause([exec()]);
  check('a rule that ran reports ran:true', ran.ran === true);
  eq('…as the RULE, with the pay dates counted and not listed',
    (ran as { rules: unknown[] }).rules,
    [{ id: 'i1', op: 'SCALE', of: ['Acme payroll'], from: '2027-01-01', to: '2027-12-31',
      payDatesChanged: 26, first: '2027-01-01', last: '2027-12-17',
      incomeBefore: 100000, incomeAfter: 110000 }]);

  // ⚠️ A RULE THAT COVERED NOTHING HAS NO COVERED WINDOW, so the line falls back
  // to what was ASKED FOR. Printing a covered window there would invent the
  // overlap the reason is about to say does not exist.
  const outside = incomeClause([exec({ ran: false, occurrencesChanged: 0, governed: null,
    requested: { fromISO: '2029-01-01', toISO: null }, firstChangedISO: null, lastChangedISO: null,
    reason: 'after this projection ends' })]);
  const line = (outside as { didNotRun: { from: string; to: string }[] }).didNotRun[0];
  eq('a rule outside the horizon is reported by what it ASKED for',
    [line.from, line.to], ['2029-01-01', '(the horizon)']);
}

// ── 3. The two disclosures ───────────────────────────────────────────────────
{
  // A rule whose result the projection will not count at all.
  const gross = incomeClause([exec({ spendableAfter: 0 })]);
  check('a rule that set income the projection counts as NOTHING says so',
    'notCash' in gross && (gross as { notCash: { rules: string[] } }).notCash.rules[0] === 'i1');
  check('…and the line shows what IS counted, beside what was set',
    JSON.stringify((gross as { rules: { countedAsCash?: number }[] }).rules[0].countedAsCash) === '0');

  // ⚠️ A RULE IS NOT ANSWERABLE FOR WHAT IT INHERITED. The first version of this
  // asked whether every resulting occurrence was spendable, and an ordinary +10%
  // on a real Space turned it red because two of the streams it reached were
  // already unspendable before the rule ran.
  const inherited = incomeClause([exec({ spendableBefore: 60_000, spendableAfter: 66_000 })]);
  check('a rule that merely passed on what it inherited does NOT raise the alarm',
    !('notCash' in inherited));
  check('…but the shortfall is still visible on the line',
    (inherited as { rules: { countedAsCash?: number }[] }).rules[0].countedAsCash === 66_000);

  // The aggregate disclosure.
  const agg = incomeClause([exec({ scope: 'EVERY_INCOME_STREAM',
    matched: [{ sourceKey: 'a@1', label: 'Payroll' }, { sourceKey: 'b@2', label: 'Interest' }] })]);
  check('an unqualified rule that reached several streams NAMES the choice it made',
    'everyStream' in agg
    && /named no income|EVERY income stream/.test((agg as { everyStream: { meaning: string } }).everyStream.meaning));
  check('…and lists them, so a wrong reading is correctable in one turn',
    JSON.stringify((agg as { rules: { of: string[] }[] }).rules[0].of) === '["Payroll","Interest"]');
  check('a NAMED rule raises no aggregate disclosure',
    !('everyStream' in incomeClause([exec()])));
  // ⚠️ AN AGGREGATE THAT REACHED EXACTLY ONE STREAM IS NOT A CHOICE WORTH FLAGGING:
  // with one income, "my income" and that income are the same thing.
  check('an aggregate that reached exactly one stream raises none either',
    !('everyStream' in incomeClause([exec({ scope: 'EVERY_INCOME_STREAM' })])));
}

// ── 4. The roster stays closed, and the envelope carries the rule ────────────
{
  const roster = clausesInForce(EMPTY_LEDGER, [], [exec()]);
  eq('the roster has six clauses, each with a boolean `ran`',
    Object.keys(roster).join(','),
    'cashFloor,surplusShare,balanceShare,fixedAmounts,debtPaydown,incomeChange');
  check('…and is recognised as a roster', isClausesInForce(roster));
  eq('the compact form keeps the RULE, not its pay dates',
    compactClauses(roster).incomeChange,
    [{ op: 'SCALE', of: ['Acme payroll'], from: '2027-01-01', to: '2027-12-31', changed: 26 }]);
  eq('a scenario with no income rule says NONE in a named slot',
    compactClauses(clausesInForce(EMPTY_LEDGER)).incomeChange, 'NONE');
  // ⚠️ A RULE THAT DID NOT RUN IS `'NONE'` IN THE ENVELOPE, because the envelope
  // answers "what is in force", and a rule that changed nothing is not. The full
  // result still carries `didNotRun` with the reason, in the same turn the model
  // is about to narrate it.
  eq('…and so does a rule that was stated and changed nothing',
    compactClauses(clausesInForce(EMPTY_LEDGER, [], [exec({ ran: false, occurrencesChanged: 0,
      governed: null, reason: 'x' })])).incomeChange, 'NONE');

  const result = {
    asOf: '2026-09-21',
    horizon: { to: '2027-12-31' },
    assumptions: { clauses: roster },
    checkpoints: [{ date: '2027-12-31', liquid: { amount: 1 }, investments: { amount: 2 },
      debt: { amount: 0 }, netWorth: { amount: 3 } }],
  };
  const args = { to: '2027-12-31',
    incomeChanges: [{ op: 'SCALE', from: '2027-01-01', multiplier: 1.1 }] };
  const cap = captureActiveScenario(SCENARIO_TOOL, args, result);
  check('a scenario carrying an income rule is captured', cap.action === 'REPLACE');
  if (cap.action !== 'REPLACE') process.exit(1);
  eq('the arguments survive VERBATIM, income rule included',
    cap.scenario.assumptions, args);
  check('…and the roster travels with them',
    Array.isArray((cap.scenario.ran as Record<string, unknown>).incomeChange));
}

// ── 5. THE EVIDENCE CANNOT BE FORGED ─────────────────────────────────────────
{
  // ⚠️ `clausesInForce` CANNOT SEE THE ARGUMENTS. Its ledger parameter is narrowed
  // to three ledger fields for exactly this reason, and the executions it also
  // takes are the SPINE's output. There is no third channel.
  const forged = exec({ ran: false, occurrencesChanged: 0, governed: null,
    matched: [{ sourceKey: 'acme@a1', label: 'a 10% raise, definitely applied' }],
    reason: 'no pay date falls in the window' });
  const c = incomeClause([forged]);
  check('a rule labelled as applied, that changed nothing, still reports ran:false',
    c.ran === false);
  check('…and the label cannot put it among the rules that RAN',
    !('rules' in c));
  check('…and the compact form the envelope keeps says NONE',
    compactClauses(clausesInForce(EMPTY_LEDGER, [], [forged])).incomeChange === 'NONE');

  // A mixed set: one ran, one did not. Both are reported, in their own places.
  const mixed = incomeClause([exec(), exec({ ruleId: 'i2', ran: false, occurrencesChanged: 0,
    governed: null, reason: 'outside the horizon' })]);
  check('one ran and one did not: the clause is true, and names both',
    mixed.ran === true
    && (mixed as { rules: unknown[] }).rules.length === 1
    && (mixed as { didNotRun: unknown[] }).didNotRun.length === 1);
  // ⚠️ AND THE ENVELOPE KEEPS ONLY THE ONE IN FORCE. A later turn that inherits a
  // rule which did nothing would be inheriting a sentence no execution vouches for.
  eq('…and only the rule in force reaches the envelope',
    (compactClauses(clausesInForce(EMPTY_LEDGER, [], [exec(), exec({ ruleId: 'i2', ran: false,
      occurrencesChanged: 0, governed: null, reason: 'x' })]))
      .incomeChange as unknown[]).length, 1);
}

if (failures > 0) { console.error(`\nincome-clause: ${failures} failure(s).`); process.exit(1); }
console.log('\nincome-clause: all passed.');
