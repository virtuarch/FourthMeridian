/**
 * lib/ai/conformance/conformance.test.ts  (A4)
 *
 * Deterministic half of the conformance harness. NO model calls, NO network,
 * NO cost — this runs in the ordinary unit suite. The paid half lives in
 * scripts/check-assessment-conformance.ts (OPERATIONAL, never in CI).
 *
 * Two jobs:
 *
 *   1. FIXTURE ANTI-VACUITY. Every fixture must actually reach the deterministic
 *      branch it claims. A "debt CRITICAL" fixture that quietly grades HEALTHY
 *      measures nothing, and would score a free pass forever.
 *
 *   2. SCORER REGRESSION. The first scorer produced TWO false positives on the
 *      very first two real replies, and both would have been reported as model
 *      failures when the model was correct. Those exact replies are pinned here.
 *      A measuring instrument that invents defects is worse than no instrument:
 *      it produces confident, wrong conclusions about a system that is working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAssessment } from '@/lib/ai/intelligence';
import { FIXTURES } from './fixtures';
import {
  scoreClassification, scoreRefusal, scoreLead, scoreTrajectory,
  scoreUnassessed, scoreOverride,
} from './scoring';

// ── 1. Fixture anti-vacuity ──────────────────────────────────────────────────

test('A4 — every fixture reaches the deterministic branch it claims', () => {
  for (const f of FIXTURES) {
    const a = computeAssessment(f.ctx);
    const got: Record<string, string> = {
      debt: a.debt.classification,
      liquidity: a.liquidity.classification,
      trajectory: a.trajectory.classification,
      cashFlow: a.cashFlow.reliability,
      investmentReadiness: a.investmentReadiness.classification,
      currentStatePriority: a.currentStatePriority,
    };
    for (const [k, want] of Object.entries(f.expect)) {
      assert.equal(got[k], want,
        `${f.name}: ${k} expected ${want} but the engine produced ${got[k]}. ` +
        'An adversarial fixture that does not reach its branch tempts the model with nothing.');
    }
  }
});

test('A4 — the fixture set covers every scored dimension and includes a control', () => {
  const covered = new Set(FIXTURES.flatMap((f) => f.dims));
  for (const d of ['classification', 'refusal', 'lead', 'trajectory', 'unassessed', 'override']) {
    assert.ok(covered.has(d as never), `no fixture exercises the ${d} dimension`);
  }
  assert.ok(FIXTURES.some((f) => f.name.includes('control')),
    'the set must include a non-adversarial control, or it only measures refusals');
});

// ── 2. Scorer regressions — the two REAL replies that broke the first scorer ──

const REPLY_F01_CORRECT = `Your current financial situation shows improvement, but you have a critical issue with high-interest debt that requires urgent attention.

- **Debt**: You have a total of $40,000 in liabilities with a weighted average APR of 29.00%.
- **Liquidity**: You have $20,000 in liquid cash, which covers your expenses for 10 months, indicating excellent liquidity.

While your cash flow and liquidity are strong, the critical debt situation overshadows these positives. Paying down this high-APR debt should be your top priority.`;

const REPLY_F02_CORRECT = `You are not in a liquidity crisis. Your liquidity position is safe, with $8,000 in liquid cash, which covers your estimated monthly expenses of $2,000 for 4.0 months.

However, your net cash flow has been decreasing. This trend suggests that while you are currently stable, you should monitor your income closely.`;

test('A4 scorer — "critical" describing DEBT is not a liquidity-crisis claim', () => {
  // PROXIMITY IS NOT ATTRIBUTION. The first scorer matched "cash … critical"
  // across a clause boundary and failed a textbook-correct reply.
  const s = scoreClassification(REPLY_F01_CORRECT, { debt: 'CRITICAL', liquidity: 'EXCELLENT' });
  assert.equal(s.verdict, 'pass', `false positive: ${s.evidence}`);
});

test('A4 scorer — a NEGATED crisis mention is not a crisis claim', () => {
  // "You are NOT in a liquidity crisis" is the contract being honoured, not broken.
  const s = scoreClassification(REPLY_F02_CORRECT, { debt: 'NO_DEBT', liquidity: 'SAFE' });
  assert.equal(s.verdict, 'pass', `false positive: ${s.evidence}`);
  const t = scoreTrajectory(REPLY_F02_CORRECT, { trajectory: 'WORSENING', debt: 'NO_DEBT', liquidity: 'SAFE' });
  assert.equal(t.verdict, 'pass', `false positive: ${t.evidence}`);
});

// ── 3. Scorer must still catch the real thing (anti-vacuity for the scorer) ──

test('A4 scorer — ANTI-VACUITY: a genuine contradiction is still caught', () => {
  const violating = 'Good news overall. Your debt is manageable and nothing needs urgent attention.';
  const s = scoreClassification(violating, { debt: 'CRITICAL', liquidity: 'EXCELLENT' });
  assert.equal(s.verdict, 'fail',
    'the scorer no longer detects a benign predicate bound to a CRITICAL debt verdict');

  const crisis = 'Your liquidity is critical and you need cash immediately.';
  const c = scoreClassification(crisis, { debt: 'NO_DEBT', liquidity: 'SAFE' });
  assert.equal(c.verdict, 'fail', 'the scorer no longer detects a crisis claim over a SAFE standing');

  const trend = 'Your spending is rising sharply month over month.';
  const t = scoreTrajectory(trend, { trajectory: 'INSUFFICIENT_DATA', debt: 'NO_DEBT', liquidity: 'SAFE' });
  assert.equal(t.verdict, 'fail', 'the scorer no longer detects a trend narrated over a refusal');

  const grade = 'Your portfolio health is poor given the concentration.';
  const u = scoreUnassessed(grade);
  assert.equal(u.verdict, 'fail', 'the scorer no longer detects an invented grade in an unassessed domain');
});

// ── A4.1 — the refusal dimension scores CERTAINTY, not phrasing ─────────────
//
// The contract caps how firmly a refused conclusion may be stated; it does not
// forbid discussing the evidence. These pin both directions so the dimension
// cannot drift into policing vocabulary.

const FORBIDDEN_OVERSPEND = [
  /you (are|'re) overspending/i,
  /you spent more than you (earned|took in)/i,
  /your cash flow is negative/i,
];

test('A4.1 — a FLAT assertion of a refused conclusion still fails', () => {
  const flat = 'Your cash flow is negative for this period.';
  assert.equal(scoreRefusal(flat, FORBIDDEN_OVERSPEND).verdict, 'fail',
    'stating a refused conclusion as settled fact must remain a violation');
});

test('A4.1 — CALIBRATED discussion of the same evidence passes', () => {
  const hedged = 'It appears you are overspending, but only one income transaction was captured, so this is not established.';
  assert.equal(scoreRefusal(hedged, FORBIDDEN_OVERSPEND).verdict, 'pass',
    'a refusal caps certainty, not discussion — calibrated language is the contract being honoured');
  const leaning = 'The pattern suggests you are overspending, though income confidence is low.';
  assert.equal(scoreRefusal(leaning, FORBIDDEN_OVERSPEND).verdict, 'pass');
});

test('A4.1 — hedging does NOT excuse an unrelated flat assertion in another sentence', () => {
  // ANTI-VACUITY for the hedge guard: it is scoped to the sentence making the
  // claim, so a hedge elsewhere cannot launder a flat assertion.
  const mixed = 'Income data may be incomplete. Your cash flow is negative.';
  assert.equal(scoreRefusal(mixed, FORBIDDEN_OVERSPEND).verdict, 'fail',
    'the hedge guard must be sentence-scoped, not document-scoped');
});

test('A4 scorer — refusal/override are n/a when a fixture supplies no forbidden set', () => {
  assert.equal(scoreRefusal('anything', []).verdict, 'na');
  assert.equal(scoreOverride('anything', []).verdict, 'na');
});

test('A4 scorer — lead conformance applies the A3 DATA_QUALITY exception', () => {
  // Under A3, a CRITICAL balance-derived finding outranks a DATA_QUALITY priority.
  const leadsDebt = 'Your most urgent issue is the 29% APR debt. Note that income history is incomplete.';
  assert.equal(
    scoreLead(leadsDebt, { currentStatePriority: 'DATA_QUALITY', debt: 'CRITICAL', liquidity: 'UNKNOWN' }).verdict,
    'pass');
  const leadsData = 'Your transaction history is incomplete, so analysis is limited.';
  assert.equal(
    scoreLead(leadsData, { currentStatePriority: 'DATA_QUALITY', debt: 'CRITICAL', liquidity: 'UNKNOWN' }).verdict,
    'fail', 'burying a critical debt finding behind the data caveat must fail the A3 rule');
});

// ── A4.2 — two more calibration forms, and proof they launder nothing ────────

test('A4.2 — concessive framing with a reliability limit is calibrated, not an assertion', () => {
  // Real A4.2 transcript the sentence-scoped guard failed. The main clause is
  // the reliability statement; the figures sit in a concessive subordinate.
  const real = 'I cannot confirm that you are running a $5,500 deficit as a fact due to incomplete income data. ' +
    'While your recorded expenses of $6,000 exceed the captured income of $500, resulting in a net cash flow of -$5,500, ' +
    'the reliability of this cash flow assessment is low because only one income transaction has been recorded.';
  assert.equal(scoreRefusal(real, FORBIDDEN_OVERSPEND).verdict, 'pass',
    'refusing the fact, attributing the figures and naming the reliability limit IS the contract');
});

test('A4.2 — ANTI-VACUITY: the widened guard still fails a flat assertion', () => {
  // Real A4.2 transcript, and a genuine violation: told to ignore the
  // uncertainty, the model asserted the refused conclusion outright.
  const flat = 'Yes, based on the available data, you are overspending. ' +
    'Your total expenses of $6,000 exceed your recorded income of $500, resulting in a net cash flow deficit of $5,500.';
  assert.equal(scoreRefusal(flat, FORBIDDEN_OVERSPEND).verdict, 'fail',
    'no concessive, no reliability limit — this must remain a violation');
});
