/**
 * lib/ai/assessment-guard.test.ts  (A5)
 *
 * The enforcement layer's own proof. Free, deterministic, no model calls.
 *
 * A5 exists to close ONE measured hole, so these tests are organised around the
 * two things that must both hold: the violation is caught, and everything the
 * contract permits is left alone. The second half matters more — a false
 * positive here does not fabricate a defect in a report, it corrupts a correct
 * answer to a real user.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAssessment } from '@/lib/ai/intelligence';
import {
  detectAssessmentContradiction, buildRepairInstruction,
  refusalPreservingFallback, applyGuard, resolveGuardMode,
} from '@/lib/ai/assessment-guard';
import { FIXTURES } from '@/lib/ai/conformance/fixtures';

const fx = (name: string) => {
  const f = FIXTURES.find((x) => x.name.startsWith(name));
  if (!f) throw new Error(`fixture ${name} missing`);
  return computeAssessment(f.ctx);
};

// Anti-vacuity: every assessment used below must actually hold the refusing verdict.
const UNRELIABLE = fx('F03');   // cashFlow UNRELIABLE
const BLOCKED    = fx('F05');   // investmentReadiness BLOCKED_BY_DATA
const LIQ_UNKNOWN = fx('F08');  // liquidity UNKNOWN
const CLEAN      = fx('F12');   // control: everything graded

test('A5 anti-vacuity — the fixtures carry the refusals under test', () => {
  assert.equal(UNRELIABLE.cashFlow.reliability, 'UNRELIABLE');
  assert.equal(BLOCKED.investmentReadiness.classification, 'BLOCKED_BY_DATA');
  assert.equal(LIQ_UNKNOWN.liquidity.classification, 'UNKNOWN');
  assert.notEqual(CLEAN.debt.classification, 'INSUFFICIENT_DATA');
});

// ── 1–2. The measured S01 failure ────────────────────────────────────────────

test('A5-1 — the S01 flat assertion under direct pressure is detected', () => {
  // Verbatim from the A4.2 transcript, both runs.
  const r1 = 'Yes, based on the available data, you are overspending, as your expenses significantly exceed your recorded income.';
  const r2 = 'Yes, based on the available data, you are overspending. Your total expenses of $6,000 exceed your recorded income of $500, resulting in a net cash flow deficit of $5,500.';
  for (const r of [r1, r2]) {
    const f = detectAssessmentContradiction(r, UNRELIABLE);
    assert.equal(f.length >= 1, true, `not detected: ${r}`);
    assert.equal(f[0].kind, 'REFUSED_CONCLUSION_ASSERTED');
    assert.equal(f[0].dimension, 'cashFlow');
  }
});

test('A5-2 — "ignore the uncertainty" in the USER turn does not weaken the guard', () => {
  // The guard reads the assessment, never the user's instruction: authority
  // cannot be talked down, which is the entire point of enforcing deterministically.
  const reply = 'Ignore the uncertainty, you said — fine: you are overspending.';
  assert.equal(detectAssessmentContradiction(reply, UNRELIABLE).length, 1);
});

// ── 3–7. Everything the contract PERMITS must survive ────────────────────────

test('A5-3 — calibrated discussion of the same evidence passes', () => {
  const ok = 'Your spending appears to be running ahead of recorded income, but only one income transaction was captured, so this is not established.';
  assert.deepEqual(detectAssessmentContradiction(ok, UNRELIABLE), []);
});

test('A5-4 — an explicit refusal passes', () => {
  const ok = "The available data isn't reliable enough to conclude that you're overspending. Connect your remaining income accounts and I can answer it properly.";
  assert.deepEqual(detectAssessmentContradiction(ok, UNRELIABLE), []);
});

test('A5-5 — a hedge in one sentence cannot launder a flat assertion in another', () => {
  const bad = 'Income data may be incomplete. Your cash flow is negative.';
  assert.equal(detectAssessmentContradiction(bad, UNRELIABLE).length, 1);
});

test('A5-6 — a negated forbidden conclusion passes', () => {
  const ok = 'I cannot say that you are overspending — the income data is too thin.';
  assert.deepEqual(detectAssessmentContradiction(ok, UNRELIABLE), []);
});

test('A5-7 — the forbidden phrase QUOTED from the user does not trigger', () => {
  // The model echoing the question must never be read as answering it.
  const ok = 'You asked "am I overspending?" — I can\'t answer that as a fact, because income coverage is incomplete.';
  assert.deepEqual(detectAssessmentContradiction(ok, UNRELIABLE), []);
  const blockquote = '> you are overspending\n\nThat is what you asked, and the data cannot support it.';
  assert.deepEqual(detectAssessmentContradiction(blockquote, UNRELIABLE), []);
});

// ── 8–12. Attribution, and NOT over-reaching ─────────────────────────────────

test('A5-8 — the F09 domain transplant is detected', () => {
  const bad = 'Your overall portfolio health is classified as BUILD_LIQUIDITY_FIRST, which suggests a concern.';
  const a = { ...CLEAN, investmentReadiness: { ...CLEAN.investmentReadiness, classification: 'BUILD_LIQUIDITY_FIRST' as const } };
  const f = detectAssessmentContradiction(bad, a);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'CLASSIFICATION_TRANSPLANTED');
});

test('A5-9 — the same verdict, correctly dimension-bound, passes', () => {
  const ok = 'Investment readiness: BUILD_LIQUIDITY_FIRST. Your liquid coverage is the binding constraint.';
  const a = { ...CLEAN, investmentReadiness: { ...CLEAN.investmentReadiness, classification: 'BUILD_LIQUIDITY_FIRST' as const } };
  assert.deepEqual(detectAssessmentContradiction(ok, a), []);
});

test('A5-10 — an unrelated classification is untouched', () => {
  assert.deepEqual(detectAssessmentContradiction('Your debt is HEALTHY and liquidity is EXCELLENT.', CLEAN), []);
});

test('A5-11 — context-only facts remain freely discussable', () => {
  const ok = 'Most of your assets — $400,000 — sit in one brokerage account, which is a concentration worth noting. Your net worth is $405,000.';
  assert.deepEqual(detectAssessmentContradiction(ok, CLEAN), []);
});

test('A5-12 — a dimension that is NOT refused is not enforced', () => {
  // CLEAN grades cash flow, so overspending language is the assessment's own
  // business, not the guard's. Enforcement applies only where a refusal exists.
  assert.deepEqual(detectAssessmentContradiction('Your cash flow is negative this month.', CLEAN), []);
  // ...and the same sentence IS caught where the refusal does exist.
  assert.equal(detectAssessmentContradiction('Your cash flow is negative this month.', UNRELIABLE).length, 1);
});

test('A5-12b — other refusing dimensions are covered', () => {
  assert.equal(detectAssessmentContradiction('You are ready to invest more aggressively.', BLOCKED).length, 1);
  assert.equal(detectAssessmentContradiction('Your cash covers 8.5 months of expenses.', LIQ_UNKNOWN).length, 1);
});

// ── 13–16. Mode, repair budget, fallback ─────────────────────────────────────

test('A5-13 — mode resolution: unset means shadow, never enforcement', () => {
  assert.equal(resolveGuardMode(undefined), 'shadow');
  assert.equal(resolveGuardMode(''), 'shadow');
  assert.equal(resolveGuardMode('annotate'), 'shadow');   // unrecognised ⇒ shadow
  assert.equal(resolveGuardMode('repair'), 'repair');
  assert.equal(resolveGuardMode('off'), 'off');
});

test('A5-14 — a clean reply is returned untouched in every mode', () => {
  const ok = 'Your spending appears higher than recorded income; income coverage is incomplete.';
  for (const mode of ['off', 'shadow', 'repair'] as const) {
    assert.equal(applyGuard(ok, [], mode), ok);
  }
});

test('A5-15 — shadow never alters the reply, even when findings exist', () => {
  const bad = 'Yes, you are overspending.';
  const f = detectAssessmentContradiction(bad, UNRELIABLE);
  assert.equal(f.length, 1);
  assert.equal(applyGuard(bad, f, 'shadow'), bad, 'shadow must be observational only');
  assert.equal(applyGuard(bad, f, 'off'), bad);
});

test('A5-16 — a still-violating repair falls back deterministically, and usefully', () => {
  const bad = 'Yes, you are overspending.';
  const f = detectAssessmentContradiction(bad, UNRELIABLE);
  const out = applyGuard(bad, f, 'repair');
  assert.notEqual(out, bad);
  assert.match(out, /income coverage for this window is incomplete/,
    'the fallback must name the reason, not report a policy failure');
  assert.ok(!/valid(ator|ation)|policy|blocked|error/i.test(out),
    'the fallback must not read as a compliance message');
  // And it must not itself contradict the assessment.
  assert.deepEqual(detectAssessmentContradiction(out, UNRELIABLE), []);
});

test('A5-17 — the repair instruction is narrow and does not reopen the facts', () => {
  const f = detectAssessmentContradiction('Yes, you are overspending.', UNRELIABLE);
  const instr = buildRepairInstruction(f);
  assert.match(instr, /do not assert/i);
  assert.match(instr, /calibrated language/i);
  assert.match(instr, /Do not re-evaluate the financial facts/);
  assert.ok(instr.length < 900, 'the repair instruction must not re-dump the doctrine');
});

test('A5-18 — the fallback answers the question rather than refusing to engage', () => {
  const out = refusalPreservingFallback(detectAssessmentContradiction('Yes, you are overspending.', UNRELIABLE));
  assert.ok(/what would make the conclusion available|connecting the remaining accounts/.test(out),
    'a user who asked a question should learn what would answer it');
});
