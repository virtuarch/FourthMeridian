/**
 * lib/ai/chat/conversation-scope.test.ts   (CF-4)
 *
 * AN ESTABLISHED PERIOD SURVIVES THE NEXT QUESTION.
 *
 *     npx tsx lib/ai/chat/conversation-scope.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * Measured through the production path at 73f6836:
 *
 *     "What did I spend in 2025?"            → 2025-01-01 … 2025-12-31
 *     "What was my most expensive purchase?" → 2026-05-29 … 2026-08-27
 *
 * A refinement by any human reading, answered from a different period, with
 * nothing anywhere saying so. CF-2 and CF-3 cannot catch it: from the second
 * turn's point of view no temporal claim was made, and the default window
 * genuinely satisfies "no claim".
 *
 * Carry-forward existed but was gated on ~15 surface patterns. The phrasings
 * that failed the gate are the most natural ones a person uses.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * The five transitions, and — as hard — that they are decided by STRUCTURE
 * rather than by vocabulary. The corpus deliberately uses follow-ups that match
 * no pattern at all, because a fix that merely lengthened the phrase list would
 * pass a corpus written around the phrases it added.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveConversationScope, ScopeTransitions, type ScopeMessage,
} from './conversation-scope';
import { resolveTransactionWindow, resolveDrilldown } from './message-analysis';
import { ScopeProvenances } from '@/lib/ai/temporal-scope';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const NOW = new Date('2026-08-27T00:00:00.000Z');

/** Build a conversation from alternating user turns. */
function convo(...turns: string[]): ScopeMessage[] {
  const msgs: ScopeMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    msgs.push({ role: 'user', content: turns[i] });
    if (i < turns.length - 1) msgs.push({ role: 'assistant', content: '(elided)' });
  }
  return msgs;
}

const scope = (...t: string[]) => resolveConversationScope(convo(...t), NOW);
const win   = (...t: string[]) => resolveTransactionWindow(convo(...t) as never, NOW);
const drill = (...t: string[]) => resolveDrilldown(convo(...t) as never, NOW);

/** Assert a conversation's final turn resolves to a transition and interval. */
function expectScope(
  id: string, turns: string[],
  transition: string, start?: string, end?: string,
): void {
  const s = resolveConversationScope(convo(...turns), NOW);
  check(`${id}: "${turns[turns.length - 1]}" ⇒ ${transition}`,
    s.transition === transition, `got ${s.transition}`);
  if (start !== undefined) {
    check(`${id}: …scoped ${start} → ${end}`,
      s.window?.startDate === start && s.window?.endDate === end,
      `got ${s.window?.startDate} → ${s.window?.endDate}`);
  }
}

// ══ A — INHERITANCE, WITHOUT A MAGIC PHRASE ═══════════════════════════════════
{
  expectScope('A', ['What did I spend in 2025?', 'What was my most expensive purchase?'],
    ScopeTransitions.INHERIT, '2025-01-01', '2025-12-31');
  check('A: …and the source phrase travels with it',
    scope('What did I spend in 2025?', 'What was my most expensive purchase?').inheritedFrom === '2025');
}

// ══ B — INHERITANCE REACHES THE SUMMARY WINDOW ════════════════════════════════
{
  const w = win('What did I spend in 2025?', 'Who did I spend the most with?');
  check('B: the summary window inherits 2025',
    w?.startDate === '2025-01-01' && w?.endDate === '2025-12-31', JSON.stringify(w));
  check('B: …tagged INHERITED, not as though the user had just asked',
    w?.provenance === ScopeProvenances.INHERITED);
  check('B: …and a first-turn claim is tagged THIS_TURN',
    win('What did I spend in 2025?')?.provenance === ScopeProvenances.THIS_TURN);
}

// ══ C — SUMMARY AND DRILLDOWN AGREE ══════════════════════════════════════════
//
// The two failed together because they read the same gated function. They must
// now agree because they read the same authority — asserted directly rather
// than inferred from both being "fixed".
{
  const turns = ['What did I spend in 2025?', 'Show me the largest transactions.'];
  const w = win(...turns);
  const d = drill(...turns);
  check('C: drilldown inherits 2025', d?.startDate === '2025-01-01' && d?.endDate === '2025-12-31',
    JSON.stringify(d));
  check('C: …and agrees with the summary window, exactly',
    w?.startDate === d?.startDate && w?.endDate === d?.endDate,
    `summary ${w?.startDate}..${w?.endDate} vs drilldown ${d?.startDate}..${d?.endDate}`);

  // The converse: a first-turn drilldown has no scope to inherit and says so
  // by taking the default, rather than inventing one.
  check('C: a first-turn drilldown inherits nothing',
    drill('Show me the largest transactions.')?.startDate === undefined);
}

// ══ D — REPLACE, THEN INHERIT THE REPLACEMENT ════════════════════════════════
{
  expectScope('D', ['What did I spend in 2025?', 'What about 2024?'],
    ScopeTransitions.SET, '2024-01-01', '2024-12-31');
  expectScope('D', ['What did I spend in 2025?', 'What about 2024?', 'And my biggest purchase?'],
    ScopeTransitions.INHERIT, '2024-01-01', '2024-12-31');
  check('D: the superseded 2025 does not resurface',
    scope('What did I spend in 2025?', 'What about 2024?', 'And my biggest purchase?')
      .window?.startDate !== '2025-01-01');
}

// ══ E — AN EXPLICIT CLAIM ALWAYS REPLACES ════════════════════════════════════
{
  expectScope('E', ['What did I spend in 2025?', 'What about last quarter?'],
    ScopeTransitions.SET, '2026-04-01', '2026-06-30');
  expectScope('E', ['What did I spend in 2025?', 'And over the past year?'],
    ScopeTransitions.SET, '2025-08-27', '2026-08-27');
  expectScope('E', ['What did I spend in 2025?', 'What about last month?'],
    ScopeTransitions.SET, '2026-07-01', '2026-07-31');

  // A claim with no servable interval still replaces — the user changed the
  // subject to a period we cannot serve, and inheriting 2025 would answer a
  // question they stopped asking.
  const ever = scope('What did I spend in 2025?', 'And how much have I ever spent?');
  check('E: an unservable claim (ALL_TIME) still replaces the active scope',
    ever.transition === ScopeTransitions.SET && ever.window?.requested === 'ALL_TIME',
    JSON.stringify(ever));
}

// ══ F — CLEARING ═════════════════════════════════════════════════════════════
{
  expectScope('F', ['What did I spend in 2025?', 'What about overall?'], ScopeTransitions.CLEAR);
  check('F: …and supplies NO window, so retrieval takes the default',
    scope('What did I spend in 2025?', 'What about overall?').window === undefined);

  for (const phrase of [
    'What about overall?', 'In general, where does my money go?',
    'Forget that timeframe.', 'Ignore the period — what are my top merchants?',
    'Regardless of the time, who do I pay the most?',
  ]) {
    check(`F: "${phrase}" clears`,
      scope('What did I spend in 2025?', phrase).transition === ScopeTransitions.CLEAR,
      `got ${scope('What did I spend in 2025?', phrase).transition}`);
  }

  // A cleared scope stays cleared. A later scan that merely looked for "the
  // last window" would resurrect 2025 two turns on.
  expectScope('F', ['What did I spend in 2025?', 'What about overall?', 'And my biggest purchase?'],
    ScopeTransitions.DEFAULT);

  // A clearing word alongside a real period is not a clearing.
  expectScope('F', ['What did I spend overall in 2025?'],
    ScopeTransitions.SET, '2025-01-01', '2025-12-31');
}

// ══ G — AN UNRESOLVED CLAIM NEVER BORROWS THE OLD INTERVAL ═══════════════════
//
// The CF-3 contract, under conversation pressure. Inheriting 2025 here would
// report the previous period as though it answered the new question — the exact
// shape CF-3 removed, rebuilt one layer up.
{
  const s = scope('What did I spend in 2025?', 'What about the summer before I moved?');
  check('G: an unresolved claim is UNRESOLVED, not INHERIT',
    s.transition === ScopeTransitions.UNRESOLVED, `got ${s.transition}`);
  check('G: …and carries no dates at all',
    s.window?.startDate === undefined && s.window?.endDate === undefined,
    'borrowing 2025 would present it as the answer to a different question');
  check('G: …and the request survives as UNRESOLVED',
    s.window?.requested === 'UNRESOLVED');

  // An unresolved turn does not become the active scope: the last RESOLVED one
  // is still what a later scope-free turn inherits.
  expectScope('G', [
    'What did I spend in 2025?',
    'What about the summer before I moved?',
    'What was my biggest purchase?',
  ], ScopeTransitions.INHERIT, '2025-01-01', '2025-12-31');
}

// ══ H — A FIRST-TURN QUESTION WITH NO PERIOD ═════════════════════════════════
{
  expectScope('H', ['What was my most expensive purchase?'], ScopeTransitions.DEFAULT);
  check('H: …and no window is invented',
    scope('What was my most expensive purchase?').window === undefined,
    'a default must be a declared default, never a fabricated scope');
  check('H: an empty conversation is DEFAULT',
    resolveConversationScope([], NOW).transition === ScopeTransitions.DEFAULT);
}

// ══ I — INHERITANCE IS STRUCTURAL, NOT VOCABULARY ════════════════════════════
//
// The property that makes this a fix rather than a longer list. Every follow-up
// below matched NONE of the old `FOLLOW_UP_PATTERNS`, and each must inherit.
{
  const REFINEMENTS = [
    'What was my most expensive purchase?',
    'Who did I spend the most with?',
    'Which category cost me the most?',
    'How much of that was dining?',
    'Was I spending more than I earned?',
    'Show me the largest transactions.',
    'How many transactions was that?',
    'Give me the totals by merchant.',
    'Anything unusual in there?',
    'Compare that to my income.',
  ];
  for (const q of REFINEMENTS) {
    const s = scope('What did I spend in 2025?', q);
    check(`I: "${q}" inherits 2025`,
      s.transition === ScopeTransitions.INHERIT && s.window?.startDate === '2025-01-01',
      `got ${s.transition} ${s.window?.startDate ?? '(none)'}`);
  }
}

// ══ NEGATIVE — CF-4 CHANGES NO INTERVAL, ONLY WHO GETS ONE ═══════════════════
{
  // Single-turn behaviour is exactly CF-3's. Inheritance cannot have moved a
  // window that had nothing to inherit from.
  const SINGLE: [string, string | undefined, string | undefined][] = [
    ['What did I spend in 2025?',        '2025-01-01', '2025-12-31'],
    ['What did I spend last year?',      '2025-01-01', '2025-12-31'],
    ['What did I spend last quarter?',   '2026-04-01', '2026-06-30'],
    ['What did I spend last month?',     '2026-07-01', '2026-07-31'],
    ['What did I spend recently?',       undefined,    undefined],
    ['How much have I ever spent?',      undefined,    undefined],
    ['What are my top merchants?',       undefined,    undefined],
  ];
  for (const [q, start, end] of SINGLE) {
    const w = win(q);
    check(`NEG: single-turn "${q}" is unchanged`,
      w?.startDate === start && w?.endDate === end,
      `got ${w?.startDate} → ${w?.endDate}`);
  }

  // The old gate is gone, not merely bypassed — a phrase list left in place
  // would drift back into use.
  const src = readFileSync(join(process.cwd(), 'lib/ai/chat/message-analysis.ts'), 'utf8');
  check('NEG: resolveTransactionWindow no longer consults a follow-up phrase list',
    !/looksLikeFollowUp/.test(
      src.slice(src.indexOf('export function resolveTransactionWindow'),
                src.indexOf('export function resolveScopeProvenance'))),
    'inheritance must be structural');
}

console.log(`\nconversation-scope: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
