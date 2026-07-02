/**
 * lib/ai/intent/gap-intent.characterization.test.ts
 *
 * CHARACTERIZATION tests for the chat route's knowledge-gap gating heuristics
 * (KD-11). These pin the CURRENT behaviour of detectsPayoffIntent and
 * detectsExplicitUpdateIntent exactly as it stands after the Phase A verbatim
 * relocation — they are a regression net, not an assertion that the behaviour is
 * ideal. Several cases deliberately encode the *drift* between these route lists
 * and the intent classifier's own vocabulary (see the `driftNote` on each such
 * case); Phase B must keep these goldens green, proving behaviour is preserved.
 *
 * No test runner is used in this project (see classifier.test.ts). Run with the
 * already-installed `tsx`:
 *
 *     npx tsx lib/ai/intent/gap-intent.characterization.test.ts
 *
 * Exits 0 when all cases pass, 1 on the first failure.
 */

import {
  detectsPayoffIntent,
  detectsExplicitUpdateIntent,
} from './gap-intent';
import type { ChatMessage } from '@/lib/ai/provider';

/** Convenience: wrap a single user utterance as the message array. */
function user(text: string): ChatMessage[] {
  return [{ role: 'user', content: text }];
}

interface BoolCase {
  label:      string;
  msgs:       ChatMessage[];
  expected:   boolean;
  /** Optional note recording an intentional route↔classifier divergence. */
  driftNote?: string;
}

// ── detectsPayoffIntent ───────────────────────────────────────────────────────
const PAYOFF_CASES: BoolCase[] = [
  { label: 'debt-free timeline',        msgs: user("How long until I'm debt free?"),        expected: true  },
  { label: 'payoff timeline',           msgs: user('Whats my payoff timeline?'),            expected: true  },
  { label: 'amortization schedule',     msgs: user('Show my amortization schedule.'),       expected: true  },
  { label: 'when will phrasing',        msgs: user('When will I finish paying this off?'),   expected: true  },
  {
    label: 'minimum payment mention',
    msgs: user('What is my minimum payment?'),
    expected: true,
    driftNote: "route PAYOFF list includes 'minimum payment'; classifier PAYOFF_WORDS does not — route gates min-payment gaps here, classifier would not route DEBT_PAYOFF_PLAN.",
  },
  { label: 'current debt status (not payoff)', msgs: user('How is my debt situation right now?'), expected: false },
  { label: 'plain overview',            msgs: user('Give me an overview.'),                  expected: false },
  { label: 'no user turn',              msgs: [{ role: 'assistant', content: 'pay off your debt' }], expected: false },
  {
    label: 'get out of debt phrasing',
    msgs: user('Help me get out of debt.'),
    expected: false,
    driftNote: "'get out of debt' is a classifier PAYOFF_WORD but NOT in the route list — route withholds min-payment gaps here while the classifier routes DEBT_PAYOFF_PLAN.",
  },
  {
    label: 'uses latest user turn only',
    msgs: [
      { role: 'user',      content: 'How much do I owe?' },
      { role: 'assistant', content: 'You owe $12,400.' },
      { role: 'user',      content: 'And how long to pay it down?' },
    ],
    expected: true, // 'how long' + 'pay down' in the latest user turn
  },
];

// ── detectsExplicitUpdateIntent (needs an action verb AND a field noun) ────────
const UPDATE_CASES: BoolCase[] = [
  { label: 'update APR',                msgs: user('Update my APR to 24.99%.'),             expected: true  },
  { label: 'set minimum payment',       msgs: user('Can you set my minimum payment?'),      expected: true  },
  { label: 'correct interest rate',     msgs: user('Please correct the interest rate.'),    expected: true  },
  {
    label: 'add APR (route-only action verb)',
    msgs: user('Add my APR.'),
    expected: true,
    driftNote: "'add' is in the route action list but NOT the classifier's UPDATE_ACTION_WORDS — route renders the form here while the classifier would not route UPDATE_KNOWLEDGE.",
  },
  { label: 'field without action',      msgs: user("What's my APR?"),                       expected: false },
  { label: 'action without field',      msgs: user('Update my mailing address.'),           expected: false },
  {
    label: 'adjust APR (classifier-only action verb)',
    msgs: user('Adjust my APR.'),
    expected: false,
    driftNote: "'adjust' is a classifier action word but NOT in the route list — route shows the light clarification card while the classifier routes UPDATE_KNOWLEDGE.",
  },
  {
    label: 'change balance (classifier-only field)',
    msgs: user('Change my balance.'),
    expected: false,
    driftNote: "'balance' is a classifier UPDATE_FIELD_WORD but NOT in the route field list — route does not render the form while the classifier routes UPDATE_KNOWLEDGE.",
  },
  { label: 'no user turn',              msgs: [{ role: 'assistant', content: 'update your apr' }], expected: false },
];

// ── Harness ───────────────────────────────────────────────────────────────────
let failures = 0;

function run(name: string, fn: (m: ChatMessage[]) => boolean, cases: BoolCase[]): void {
  console.log(`\n── ${name} ──`);
  for (const c of cases) {
    const actual = fn(c.msgs);
    const ok = actual === c.expected;
    console.log(
      `[${ok ? 'PASS' : 'FAIL'}] ${c.label} -> ${actual}` +
      (c.driftNote ? `   (drift: ${c.driftNote})` : ''),
    );
    if (!ok) {
      failures++;
      console.log(`        expected: ${c.expected}`);
    }
  }
}

run('detectsPayoffIntent', detectsPayoffIntent, PAYOFF_CASES);
run('detectsExplicitUpdateIntent', detectsExplicitUpdateIntent, UPDATE_CASES);

const total = PAYOFF_CASES.length + UPDATE_CASES.length;
console.log('');
if (failures === 0) {
  console.log(`All ${total} characterization cases passed.`);
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
