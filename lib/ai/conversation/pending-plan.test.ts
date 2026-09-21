/**
 * lib/ai/conversation/pending-plan.test.ts
 *
 * The pending planning state: staged, restated, retracted, merged into a run,
 * bounded, and closed against every door a number or a sentence could come in by.
 * Pure — no DB, no model, no clock.
 */

import {
  IDENTITY, MAX_PENDING_BYTES, MAX_PENDING_CLAUSES, PENDING_MARKER,
  emptyPlan, injectPending, isPendingPlan, mergeIntoArgs, stagePlan, type PendingPlan,
} from './pending-plan';
import { SCENARIO_INPUTS, scenarioAssumptionKeys } from './scenario-inputs';
import { ACTIVE_SCENARIO_MARKER } from './active-scenario';
import { turnEvidence } from './memory-model';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** The four-turn conversation from the measured failure, as the user said it. */
const SAID = [
  'Starting January my income increases 10%.',
  'Keep nine months of expenses in cash.',
  'Pay highest APR debt first.',
  'Invest everything above the floor.',
];
const ev = (upTo: number, extra: string[] = []) => turnEvidence([...SAID.slice(0, upTo + 1), ...extra], []);

const RAISE = { op: 'SCALE', from: '2027-01-01', multiplier: 1.1 };

console.log('pending-plan — what was stated, before it ran');

// ── 1. The measured failure, assembled one bare turn at a time ───────────────
let plan: PendingPlan = emptyPlan();
{
  let r = stagePlan(plan, { stage: { incomeChanges: [RAISE] } }, { turn: 0, evidence: ev(0) });
  check('t0: the raise is staged', r.staged.length === 1 && r.refused.length === 0, JSON.stringify(r.refused));
  plan = r.plan;
  r = stagePlan(plan, { stage: { contributions: [{ liquidFloorMonthsOfExpenses: 9 }] } }, { turn: 1, evidence: ev(1) });
  check('t1: the floor is staged', r.staged.length === 1, JSON.stringify(r.refused));
  plan = r.plan;
  // "Pay highest APR debt first" says WHERE, not WHAT money: it amends the floor rule.
  r = stagePlan(plan, { stage: { contributions: [{ target: ['highest_apr'] }] } }, { turn: 2, evidence: ev(2) });
  check('t2: a target alone amends the one staged contribution', r.staged.length === 1, JSON.stringify(r.refused));
  plan = r.plan;
  r = stagePlan(plan, { stage: { contributions: [{ fractionOfExcess: 1, target: ['highest_apr', 'investments'] }] } },
    { turn: 3, evidence: ev(3) });
  plan = r.plan;
  eq('t3: three turns became ONE floor rule, not three', plan.clauses.filter((c) => c.key === 'contributions').length, 1);
  eq('…with every field the user gave it',
    plan.clauses.find((c) => c.key === 'contributions')?.value,
    { liquidFloorMonthsOfExpenses: 9, target: ['highest_apr', 'investments'], fractionOfExcess: 1 });

  const m = mergeIntoArgs(plan, { to: '2027-12-31' });
  check('t4: a bare run carries ALL of it', Array.isArray(m.args.incomeChanges)
    && (m.args.contributions as unknown[]).length === 1 && m.applied.length === 2);
  check('…each attributed to earlier in THIS conversation',
    m.applied.every((a) => a.source === 'EARLIER_IN_CONVERSATION'));
  eq('…and the horizon is the call\'s, untouched', m.args.to, '2027-12-31');
}

// ── 2. Supersession by identity, never by text ──────────────────────────────
{
  const before = plan.clauses.find((c) => c.key === 'incomeChanges')!;
  const r = stagePlan(plan, { stage: { incomeChanges: [{ ...RAISE, multiplier: 1.15 }] } },
    { turn: 5, evidence: ev(3, ['Actually make the raise 15%.']) });
  const after = r.plan.clauses.filter((c) => c.key === 'incomeChanges');
  eq('"make the raise 15%" REPLACES the 10%, it does not stack', after.length, 1);
  eq('…keeping the same clause id', after[0].id, before.id);
  eq('…at the new value', (after[0].value as { multiplier: number }).multiplier, 1.15);
  // SCALE and SET_RATE answer the same question from the same date.
  const r2 = stagePlan(r.plan, { stage: { incomeChanges: [{ op: 'SET_RATE', from: '2027-01-01',
    amount: 180000, per: 'YEAR', basis: 'GROSS' }] } }, { turn: 6, evidence: ev(3, ['actually it goes to $180k']) });
  eq('a stated salary from the same date replaces a percentage raise',
    r2.plan.clauses.filter((c) => c.key === 'incomeChanges').length, 1);
  // A STOP and a SCALE are different rules; order is kept.
  const r3 = stagePlan(emptyPlan(), { stage: { incomeChanges: [
    { op: 'STOP', from: '2027-07-01', source: 'A@1' }, { op: 'SCALE', from: '2027-01-01', multiplier: 1.1, source: 'A@1' }] } },
  { turn: 0, evidence: turnEvidence(['it stops after June, and goes up 10% in January'], []) });
  eq('a STOP then a SCALE are two rules, in the order stated',
    mergeIntoArgs(r3.plan, {}).args.incomeChanges, [
      { op: 'STOP', from: '2027-07-01', source: 'A@1' }, { op: 'SCALE', from: '2027-01-01', multiplier: 1.1, source: 'A@1' }]);
  // The same clause said twice is one clause.
  const twice = stagePlan(plan, { stage: { incomeChanges: [RAISE] } }, { turn: 7, evidence: ev(0) });
  eq('the same clause stated twice stays one clause', twice.plan.clauses.length, plan.clauses.length);
  // Retract.
  const gone = stagePlan(plan, { retract: [before.id] }, { turn: 8, evidence: ev(0) });
  check('a clause can be retracted by id', !gone.plan.clauses.some((c) => c.id === before.id));
  const again = stagePlan(gone.plan, { stage: { incomeChanges: [RAISE] } }, { turn: 9, evidence: ev(0) });
  check('…and a retracted id is never reused', !again.plan.clauses.some((c) => c.id === before.id));
  check('retracting an id that does not exist is refused by name',
    stagePlan(plan, { retract: ['p99'] }, { turn: 0, evidence: ev(0) }).refused.length === 1);
}

// ── 2b. Narrowing a staged waterfall is explicit, or refused ─────────────────
{
  const e = turnEvidence(['keep 9 months, pay highest APR first, invest the rest'], []);
  const base = stagePlan(emptyPlan(), { stage: { contributions: [{ liquidFloorMonthsOfExpenses: 9,
    fractionOfExcess: 1, target: ['highest_apr', 'investments'] }] } }, { turn: 0, evidence: e }).plan;
  // Measured 2/6: "invest everything above the floor" staged 'investments' over the waterfall.
  const narrowed = stagePlan(base, { stage: { contributions: [{ liquidFloorMonthsOfExpenses: 9,
    fractionOfExcess: 1, target: 'investments' }] } }, { turn: 1, evidence: e });
  check('a merge that would DROP a staged target word is refused',
    narrowed.staged.length === 0 && narrowed.refused.length === 1);
  check('…naming what it would drop, and the ordered list that keeps both',
    /DROP `highest_apr`/.test(narrowed.refused[0]?.reason ?? '')
    && /\["highest_apr","investments"\]/.test(narrowed.refused[0]?.reason ?? ''));
  eq('…and the plan is unchanged', narrowed.plan, base);
  const withdrawn = stagePlan(base, { stage: { contributions: [{ target: 'investments' }] }, replace: true },
    { turn: 1, evidence: e });
  eq('with `replace: true` the withdrawal is honoured',
    (withdrawn.plan.clauses[0].value as { target: unknown }).target, 'investments');
  const widened = stagePlan(stagePlan(emptyPlan(), { stage: { contributions: [{ liquidFloorMonthsOfExpenses: 9,
    fractionOfExcess: 1, target: ['highest_apr'] }] } }, { turn: 0, evidence: e }).plan,
  { stage: { contributions: [{ target: ['highest_apr', 'investments'] }] } }, { turn: 1, evidence: e });
  check('widening a waterfall needs no flag', widened.staged.length === 1 && widened.refused.length === 0);
  check('…and the replaced field is still reported',
    widened.replacedFields.some((f) => f.field === 'target'));
}

// ── 3. Merge: pending beats a stale copy, and says so ────────────────────────
{
  const p = stagePlan(emptyPlan(), { stage: { incomeChanges: [{ ...RAISE, multiplier: 1.15 }] } },
    { turn: 5, evidence: turnEvidence(['make the raise 15%'], []) }).plan;
  // The model re-runs, copying the OLD 1.1 forward from the envelope.
  const m = mergeIntoArgs(p, { to: '2027-06-30', incomeChanges: [RAISE],
    contributions: [{ liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1 }] });
  eq('a staged restatement beats a stale copy carried forward from the last run',
    (m.args.incomeChanges as { multiplier: number }[]).map((x) => x.multiplier), [1.15]);
  eq('…and the replacement is REPORTED, not silent', m.replacedCallItems.map((x) => x.key), ['incomeChanges']);
  check('…and the call\'s other clauses are kept', Array.isArray(m.args.contributions));
  eq('an empty plan changes nothing', mergeIntoArgs(emptyPlan(), { to: 'x', a: 1 }).args, { to: 'x', a: 1 });
}

// ── 4. Provenance: only the user's own figures ──────────────────────────────
{
  const e = turnEvidence(['Starting January my income increases 10%.'], []);
  const tool = stagePlan(emptyPlan(), { stage: { incomeChanges: [{ ...RAISE, multiplier: 1.0731 }] } }, { turn: 0, evidence: e });
  check('a multiplier the user did not say is REFUSED', tool.refused.length === 1 && tool.staged.length === 0);
  const derived = stagePlan(emptyPlan(), { stage: { contributions: [{ liquidFloor: 39044.88, fractionOfExcess: 1 }] } },
    { turn: 0, evidence: turnEvidence(['keep nine months of expenses'], ['{"floor": 39044.88}']) });
  check('a derived dollar floor (tool output) is REFUSED — say it in months', derived.refused.length === 1);
  const remembered = stagePlan(emptyPlan(), { stage: { assumedMonthlySpending: 5000 } },
    { turn: 0, evidence: turnEvidence(['what do I have next December?'], ['{"memory":{"baseline":5000}}']) });
  check('a remembered planning figure the user did not restate is REFUSED', remembered.refused.length === 1);
  const said = stagePlan(emptyPlan(), { stage: { assumedMonthlySpending: 5000 } },
    { turn: 0, evidence: turnEvidence(['assume I spend $5,000 a month'], []) });
  check('…while the same figure, said now, is staged', said.staged.length === 1);
  check('"the rest" (1) needs no figure', stagePlan(emptyPlan(), { stage: { contributions: [
    { liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1 }] } }, { turn: 0, evidence: turnEvidence(['keep 9 months, invest the rest'], []) }).staged.length === 1);
}

// ── 5. Closed vocabulary, closed shape, bounded text ─────────────────────────
{
  const e = turnEvidence(['anything 10%'], []);
  const r = (stage: Record<string, unknown>) => stagePlan(emptyPlan(), { stage }, { turn: 0, evidence: e });
  check('an unknown clause type is refused', r({ spendingChanges: [{ from: '2027-01-01' }] }).refused.length === 1);
  check('the horizon is not an assumption and cannot be staged', r({ to: '2027-06-30' }).refused.length === 1);
  check('granularity cannot be staged', r({ granularity: 'monthly' }).refused.length === 1);
  check('an unknown field on an entry is refused', r({ incomeChanges: [{ ...RAISE, percent: 10 }] }).refused.length === 1);
  check('a rule with no date is refused', r({ incomeChanges: [{ op: 'SCALE', multiplier: 1.1 }] }).refused.length === 1);
  check('a malformed type is refused', r({ incomeChanges: [{ ...RAISE, from: 20270101 }] }).refused.length === 1);
  check('a label on a SCALE is refused', r({ incomeChanges: [{ ...RAISE, label: 'buffer kept, cards paid first' }] }).refused.length === 1);
  const start = stagePlan(emptyPlan(), { stage: { incomeChanges: [{ op: 'START', from: '2027-02-01', amount: 3000,
    per: 'MONTH', basis: 'NET', cadence: 'MONTHLY', label: 'consulting work for a very long client name indeed' }] } },
  { turn: 0, evidence: turnEvidence(['I start consulting at $3,000 a month'], []) });
  check('a START keeps its name, bounded to 40 characters',
    start.staged.length === 1 && String((start.plan.clauses[0].value as { label: string }).label).length <= 40);
  check('an entry that is not an object is refused', r({ incomeChanges: ['raise 10%'] }).refused.length === 1);
}

// ── 6. Bounded ───────────────────────────────────────────────────────────────
{
  const e = turnEvidence(['$100 $200 $300 $400 $500 $600 $700 $800 $900 $1,000'], []);
  const many = Array.from({ length: 10 }, (_, i) => ({ onDate: `2027-0${(i % 9) + 1}-1${i}`, amount: (i + 1) * 100 }));
  const r = stagePlan(emptyPlan(), { stage: { outflows: many } }, { turn: 0, evidence: e });
  check(`at most ${MAX_PENDING_CLAUSES} clauses`, r.plan.clauses.length <= MAX_PENDING_CLAUSES && r.refused.length >= 2);
  check(`at most ${MAX_PENDING_BYTES} bytes`, JSON.stringify(r.plan.clauses).length <= MAX_PENDING_BYTES);
  check('a plan over the caps is not a plan', !isPendingPlan({ v: 1, next: 20,
    clauses: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, key: 'annualReturnPct', identity: 'annualReturnPct', value: 5, stagedAt: 0 })) }));
}

// ── 7. The state holds arguments, never results, and cannot be forged ────────
{
  check('a plan this module built is recognised', isPendingPlan(plan));
  check('a clause whose identity does not match its value is not a plan', !isPendingPlan({ ...plan,
    clauses: [{ ...plan.clauses[0], identity: 'RATE|*|1999-01-01' }] }));
  check('a clause under a key that is not an assumption is not a plan', !isPendingPlan({ ...plan,
    clauses: [{ id: 'p1', key: 'to', identity: 'x', value: '2027-06-30', stagedAt: 0 }] }));
  const json = JSON.stringify(plan);
  check('no result field exists anywhere in the state',
    !/"(netWorth|liquid|investments|debt|endingCash|checkpoints|result|covers|ran)":/.test(json), json);
}

// ── 8. What the model reads, and where ───────────────────────────────────────
{
  const msgs: unknown[] = [{ role: 'system', content: 'x' }, { role: 'system', content: `${ACTIVE_SCENARIO_MARKER}\n{}` }];
  injectPending(msgs, plan);
  injectPending(msgs, plan);
  eq('one pending slot, replaced never appended',
    msgs.filter((m) => String((m as { content: string }).content).startsWith(PENDING_MARKER)).length, 1);
  injectPending(msgs, emptyPlan());
  check('an empty plan leaves no slot at all',
    !msgs.some((m) => String((m as { content: string }).content).startsWith(PENDING_MARKER)));
  check('the marker cannot be mistaken for the executed one', !PENDING_MARKER.startsWith(ACTIVE_SCENARIO_MARKER.slice(0, 6)));
}

// ── 9. EVERY SCENARIO ASSUMPTION HAS AN IDENTITY RULE — the S1 gate ──────────
{
  const keys = scenarioAssumptionKeys();
  const missing = keys.filter((k) => !IDENTITY[k]);
  check('every scenario assumption key has exactly one identity rule', missing.length === 0, missing.join(','));
  check('…and the registry names nothing the schema does not declare',
    Object.keys(IDENTITY).every((k) => keys.includes(k)));
  // ⚠️ PLANTED: S1 declares `spendingChanges`. The derived continuity policy
  // classifies it as an assumption automatically; this registry must then be
  // given one line, or the gate above goes red. Nothing else changes: no new
  // carrier, no memory class, no field.
  const planted = { ...SCENARIO_INPUTS, spendingChanges: { type: 'array', items: { properties: {} } } } as Record<string, unknown>;
  const withS1 = scenarioAssumptionKeys(planted);
  check('PLANTED S1: a new scenario argument is an assumption the moment it is declared', withS1.includes('spendingChanges'));
  check('PLANTED S1: …and the identity gate catches that it has no rule yet',
    withS1.filter((k) => !IDENTITY[k]).join(',') === 'spendingChanges');
}

if (failures > 0) { console.error(`\npending-plan: ${failures} failure(s).`); process.exit(1); }
console.log('\npending-plan: all passed.');
