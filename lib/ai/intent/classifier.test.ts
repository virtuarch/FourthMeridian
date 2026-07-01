/**
 * lib/ai/intent/classifier.test.ts
 *
 * Manual test fixture for Layer 0 intent routing (D4).
 *
 * The project has no test runner (no jest/vitest). This file is a standalone,
 * dependency-free script runnable with the already-installed `tsx`:
 *
 *     npx tsx lib/ai/intent/classifier.test.ts
 *
 * It exits 0 when all cases pass and 1 on the first failure, so it can be
 * wired into CI later without changes. Convert to jest/vitest by replacing the
 * tiny harness at the bottom if/when a runner is adopted.
 */

import { classifyFinancialIntent } from './classifier';
import {
  FinancialIntents,
  TemporalFrames,
  TransactionWindowModes,
  type IntentRoute,
  type TransactionWindowMode,
} from './types';
import { serializeRoutingBlock } from './prompt';

interface Case {
  message: string;
  intent: IntentRoute['intent'];
  /** Accepted temporal frames (some prompts legitimately allow more than one). */
  temporal: IntentRoute['temporalFrame'][];
}

const CASES: Case[] = [
  { message: 'How is my debt situation?',                 intent: FinancialIntents.CURRENT_DEBT_STATUS,        temporal: [TemporalFrames.CURRENT] },
  { message: "How long until I'm debt free?",             intent: FinancialIntents.DEBT_PAYOFF_PLAN,           temporal: [TemporalFrames.PLANNING] },
  { message: 'Should I pay off debt or buy stock?',       intent: FinancialIntents.DEBT_VS_INVESTING,          temporal: [TemporalFrames.PLANNING] },
  { message: 'Where can I cut spending?',                 intent: FinancialIntents.SPENDING_REDUCTION,         temporal: [TemporalFrames.HISTORICAL, TemporalFrames.TREND] },
  { message: 'Why is my cash flow negative?',             intent: FinancialIntents.CASH_FLOW_EXPLANATION,      temporal: [TemporalFrames.HISTORICAL] },
  { message: "Are my goals aligned with how I'm spending?", intent: FinancialIntents.GOAL_ALIGNMENT,           temporal: [TemporalFrames.CURRENT, TemporalFrames.TREND] },
  { message: 'Am I ready to invest?',                     intent: FinancialIntents.INVESTMENT_READINESS,       temporal: [TemporalFrames.CURRENT] },
  { message: 'Can you update my Chase APR?',              intent: FinancialIntents.UPDATE_KNOWLEDGE,           temporal: [TemporalFrames.CURRENT] },
  { message: 'Give me an overview',                       intent: FinancialIntents.GENERAL_FINANCIAL_OVERVIEW, temporal: [TemporalFrames.CURRENT] },
  // Fallback behaviour.
  { message: 'What is the weather in Tokyo?',             intent: FinancialIntents.UNKNOWN,                    temporal: [TemporalFrames.GENERAL] },
  { message: '',                                          intent: FinancialIntents.UNKNOWN,                    temporal: [TemporalFrames.GENERAL] },
];

let failures = 0;

for (const c of CASES) {
  const route = classifyFinancialIntent(c.message);
  const intentOk = route.intent === c.intent;
  const temporalOk = c.temporal.includes(route.temporalFrame);
  const ok = intentOk && temporalOk;

  const label = ok ? 'PASS' : 'FAIL';
  const shown = c.message === '' ? '(empty)' : c.message;
  console.log(
    `[${label}] "${shown}" -> ${route.intent} / ${route.temporalFrame} `
    + `(conf ${route.confidence.toFixed(2)})`,
  );

  if (!ok) {
    failures++;
    if (!intentOk) console.log(`        expected intent: ${c.intent}`);
    if (!temporalOk) console.log(`        expected temporal in: [${c.temporal.join(', ')}]`);
  }

  // Invariant checks: a section key must not appear in more than one list.
  const overlap = route.primarySections.filter(
    (s) => route.supportingSections.includes(s) || route.suppressSections.includes(s),
  );
  if (overlap.length > 0) {
    failures++;
    console.log(`        FAIL invariant: overlapping sections: ${overlap.join(', ')}`);
  }
}

// ── D6 dynamic transaction windows ───────────────────────────────────────────
// Deterministic given a fixed `now`. Fixed at 2026-07-01 (UTC) so the resolved
// bounds are stable regardless of when the fixture runs.
const NOW = new Date('2026-07-01T12:00:00.000Z');

interface WindowCase {
  message: string;
  mode:    TransactionWindowMode | undefined; // undefined → no window (default)
  start?:  string;
  end?:    string;
}

const WINDOW_CASES: WindowCase[] = [
  // 1. General spending prompt → default window (none requested).
  { message: 'Where can I cut spending?',                       mode: undefined },
  // 2. Explicit year → YTD Jan 1 2026 → today.
  { message: 'Break down my average monthly spending for 2026.', mode: TransactionWindowModes.YTD,            start: '2026-01-01', end: '2026-07-01' },
  // 3. "this year" → YTD Jan 1 2026 → today.
  { message: 'How much debt have I paid this year?',            mode: TransactionWindowModes.YTD,            start: '2026-01-01', end: '2026-07-01' },
  // 4. "last 6 months" → six-month rolling window.
  { message: 'What did I spend in the last 6 months?',          mode: TransactionWindowModes.LAST_N_MONTHS,  start: '2026-01-01', end: '2026-07-01' },
  // 5. "last month" → prior full calendar month.
  { message: 'What did I spend last month?',                    mode: TransactionWindowModes.CALENDAR_MONTH, start: '2026-06-01', end: '2026-06-30' },
  // 6. "this month" → current calendar month to date.
  { message: 'What did I spend this month?',                    mode: TransactionWindowModes.CALENDAR_MONTH, start: '2026-07-01', end: '2026-07-01' },
];

for (const c of WINDOW_CASES) {
  const w = classifyFinancialIntent(c.message, NOW).transactionWindow;
  const modeOk  = (w?.mode) === c.mode;
  const startOk = c.start === undefined || w?.startDate === c.start;
  const endOk   = c.end === undefined || w?.endDate === c.end;
  const ok = modeOk && startOk && endOk;

  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] "${c.message}" -> `
    + (w ? `${w.mode} ${w.startDate}..${w.endDate} ("${w.label}")` : 'default (no window)'),
  );
  if (!ok) {
    failures++;
    console.log(`        expected: ${c.mode ?? 'default'} ${c.start ?? ''}..${c.end ?? ''}`);
  }
}

// Spot-check the prompt block renders and mentions its markers' neighbours.
const sample = serializeRoutingBlock(classifyFinancialIntent('How is my debt situation?'));
if (!sample.includes('Classified intent:') || !sample.includes('PRIMARY')) {
  failures++;
  console.log('        FAIL: routing block serialization missing expected fields');
}

// The window request must reach the serialized routing block when present.
const ytdBlock = serializeRoutingBlock(classifyFinancialIntent('What did I spend this year?', NOW));
if (!ytdBlock.includes('Requested transaction period:')) {
  failures++;
  console.log('        FAIL: routing block missing requested-period line for a YTD prompt');
}

console.log('');
if (failures === 0) {
  console.log(`All ${CASES.length} cases passed.`);
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
