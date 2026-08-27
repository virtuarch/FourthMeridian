/**
 * lib/ai/intent/temporal-claim.test.ts   (CF-3)
 *
 * A TEMPORAL CLAIM MUST NEVER BECOME "NO PARTICULAR PERIOD".
 *
 *     npx tsx lib/ai/intent/temporal-claim.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * CF-2 gave the prompt an honest account of requested-versus-selected scope.
 * CF-R0 then measured what that contract does when its INPUT is wrong, and
 * found eight of eleven ordinary temporal phrases taking the worst possible
 * path:
 *
 *     "What did I spend last year?"
 *       → no rule matches → requested: UNSPECIFIED
 *       → "The user asked about no particular period."
 *       → "The loaded period FULLY COVERS what was asked. Answer directly,
 *          with no scope caveat."
 *
 * Ninety days, asserted as last year, with an explicit instruction not to
 * hedge. That is worse than the silence CF-2 replaced, because it is a claim.
 * The contract was right; it was told the user had asked for nothing.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * Two properties, and the second is the one that survives future phrasings.
 *
 *   1. The vocabulary resolves the phrases people actually use, with the
 *      CALENDAR-versus-TRAILING distinction intact. "last year" and "past
 *      year" name intervals that share no boundary; answering either with the
 *      other's figure is simply a wrong answer.
 *
 *   2. An UNRECOGNISED temporal phrase becomes UNRESOLVED, never UNSPECIFIED.
 *      This is what makes the contract independent of its own vocabulary: a
 *      phrasing nobody anticipated degrades to honest uncertainty instead of
 *      confident error.
 *
 * And the counterweight, which matters as much: a question with genuinely no
 * temporal language must stay UNSPECIFIED and keep answering directly. A
 * safeguard that turns "What are my top merchants?" into a refusal has traded
 * one failure for another.
 */

import { classifyFinancialIntent } from './index';
import { hasTemporalCue } from './classifier';
import { TemporalRequests } from '@/lib/ai/temporal-scope';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** Fixed clock. Chosen mid-Q3 so calendar and trailing periods cannot coincide. */
const NOW = new Date('2026-08-27T00:00:00.000Z');
const win = (msg: string) => classifyFinancialIntent(msg, NOW).transactionWindow;

/** Assert a phrase resolves to a request kind and, when servable, an interval. */
function expect(
  id: string, phrase: string, kind: string, start?: string | null, end?: string | null,
): void {
  const w = win(`What did I spend ${phrase}?`);
  const got = w?.requested ?? 'UNSPECIFIED';
  check(`${id}: "${phrase}" ⇒ ${kind}`, got === kind, `got ${got} — ${JSON.stringify(w)}`);
  if (start !== undefined) {
    check(`${id}: …bounded ${start} → ${end}`,
      w?.requestedStart === start && w?.requestedEnd === end,
      `got ${w?.requestedStart} → ${w?.requestedEnd}`);
  }
}

// ══ A–D — YEARS: CALENDAR IS NOT TRAILING ═════════════════════════════════════
//
// On 2026-08-27 the previous calendar year and the trailing twelve months
// overlap by four months and share neither boundary. The words distinguish them
// and so must the parser.
{
  expect('A', 'last year',           'CALENDAR_YEAR', '2025-01-01', '2025-12-31');
  expect('D', 'previous year',       'CALENDAR_YEAR', '2025-01-01', '2025-12-31');
  expect('D', 'prior year',          'CALENDAR_YEAR', '2025-01-01', '2025-12-31');

  expect('B', 'past year',           'LAST_N_MONTHS', '2025-08-27', '2026-08-27');
  expect('B', 'over the last year',  'LAST_N_MONTHS', '2025-08-27', '2026-08-27');
  expect('B', 'in the last year',    'LAST_N_MONTHS', '2025-08-27', '2026-08-27');
  expect('C', 'in the last 12 months', 'LAST_N_MONTHS', '2025-08-27', '2026-08-27');

  const cal = win('What did I spend last year?');
  const tra = win('What did I spend over the last year?');
  check('A/B: the two readings produce DIFFERENT intervals',
    cal!.requestedStart !== tra!.requestedStart && cal!.requestedEnd !== tra!.requestedEnd,
    'collapsing these would answer a different question from the one asked');
}

// ══ E–H, J — QUARTERS ════════════════════════════════════════════════════════
{
  expect('F', 'last quarter',      'CALENDAR_QUARTER', '2026-04-01', '2026-06-30');
  expect('F', 'previous quarter',  'CALENDAR_QUARTER', '2026-04-01', '2026-06-30');
  expect('E', 'this quarter',      'CALENDAR_QUARTER', '2026-07-01', '2026-08-27');
  expect('J', 'quarter to date',   'CALENDAR_QUARTER', '2026-07-01', '2026-08-27');
  expect('J', 'qtd',               'CALENDAR_QUARTER', '2026-07-01', '2026-08-27');

  expect('G', 'past quarter',      'LAST_N_MONTHS', '2026-05-27', '2026-08-27');
  expect('G', 'the last quarter',  'LAST_N_MONTHS', '2026-05-27', '2026-08-27');
  expect('H', 'in the last 3 months', 'LAST_N_MONTHS', '2026-05-27', '2026-08-27');

  const cal = win('What did I spend last quarter?');
  const tra = win('What did I spend past quarter?');
  // They overlap (May 27 – Jun 30 on this clock) but share NEITHER boundary,
  // so the totals differ. That is the whole reason they must not collapse.
  check('F/G: calendar quarter and trailing 3 months share no boundary',
    cal!.requestedStart !== tra!.requestedStart && cal!.requestedEnd !== tra!.requestedEnd,
    `${cal!.requestedStart}→${cal!.requestedEnd} vs ${tra!.requestedStart}→${tra!.requestedEnd}`);
  check('F/G: …and the trailing window extends past the calendar quarter\'s close',
    tra!.requestedEnd! > cal!.requestedEnd!);

  // A quarter crossing a year boundary — the arithmetic that a naive
  // month-subtraction gets wrong.
  const jan = classifyFinancialIntent('what did I spend last quarter',
    new Date('2026-02-10T00:00:00.000Z')).transactionWindow;
  check('F: in Q1, "last quarter" is Q4 of the PREVIOUS year',
    jan?.requestedStart === '2025-10-01' && jan?.requestedEnd === '2025-12-31',
    JSON.stringify(jan));
}

// ══ I, K–M — EXISTING READINGS ARE UNCHANGED ═════════════════════════════════
//
// CF-3 adds vocabulary. Anything CF-2 already resolved must resolve identically,
// or this slice has quietly rewritten a shipped interpretation.
{
  expect('I', 'year to date',   'YTD',            '2026-01-01', '2026-08-27');
  expect('I', 'this year',      'YTD',            '2026-01-01', '2026-08-27');
  expect('K', 'in 2024',        'CALENDAR_YEAR',  '2024-01-01', '2024-12-31');
  expect('L', 'last month',     'CALENDAR_MONTH', '2026-07-01', '2026-07-31');
  expect('L', 'this month',     'CALENDAR_MONTH', '2026-08-01', '2026-08-27');
  expect('M', 'between March 2026 and May 2026', 'EXPLICIT_RANGE', '2026-03-01', '2026-05-31');
  expect('N', 'recently',       'RECENT',  null, null);
  expect('O', 'ever',           'ALL_TIME', null, null);
  expect('P', 'before June 2024', 'BEFORE_DATE', null, '2024-05-31');
  expect('Q', 'after March 2025', 'AFTER_DATE',  '2025-03-01', '2026-08-27');

  check('K: an explicit year still beats the new year rules',
    win('What did I spend in 2024?')?.requestedStart === '2024-01-01',
    'ordering regression: a bare-year phrase must not be stolen by "last year"');
}

// ══ R — GENUINELY NO TEMPORAL CLAIM ══════════════════════════════════════════
//
// The counterweight. These must stay UNSPECIFIED and keep answering directly;
// a safeguard that hedges them has replaced one failure with another.
{
  const ORDINARY = [
    'What are my top merchants?',
    'Where am I spending the most?',
    'How much am I spending?',
    'How is my debt?',
    'What are my investments?',
    'What is my net worth?',
    'Am I overspending?',
    'How much do I have in savings?',
    'Which category costs me the most?',
    'Can I afford to invest?',
  ];
  for (const q of ORDINARY) {
    check(`R: "${q}" makes NO temporal claim`, !hasTemporalCue(q.toLowerCase()),
      'a false positive here turns an ordinary question into a refusal');
    check(`R: …and stays UNSPECIFIED`, win(q) === undefined,
      JSON.stringify(win(q)));
  }
}

// ══ S — TEMPORAL LANGUAGE THE PARSER CANNOT RESOLVE ══════════════════════════
//
// The property that outlives this vocabulary.
{
  const UNRESOLVED = [
    'What did I spend during the summer before I moved?',
    'How much did I spend around the holidays?',
    'What did I spend when I was living abroad?',
    'What did I spend two summers ago?',
    'How much did I spend in the weeks after the move?',
    'What was I spending back when I had the old car?',
    'What did I spend that season?',
    'How much did I spend up to the wedding?',
  ];
  for (const q of UNRESOLVED) {
    const w = win(q);
    check(`S: "${q.slice(0, 46)}…" ⇒ UNRESOLVED`,
      w?.requested === TemporalRequests.UNRESOLVED,
      `got ${w?.requested ?? 'UNSPECIFIED'} — an unrecognised period must not become "no period"`);
    check(`S: …and supplies NO interval it cannot justify`,
      w?.startDate === undefined && w?.endDate === undefined);
  }
}

// ══ THE HARD INVARIANT ═══════════════════════════════════════════════════════
//
// Stated once, directly: a message carrying a temporal claim may never resolve
// to UNSPECIFIED. Asserted over every temporal phrase in this file at once, so
// a future rule that returns `undefined` on a cue-bearing message fails here.
{
  const TEMPORAL = [
    'last year', 'past year', 'previous year', 'prior year', 'over the last year',
    'in the last 12 months', 'last quarter', 'previous quarter', 'this quarter',
    'past quarter', 'quarter to date', 'in the last 3 months', 'year to date',
    'this year', 'in 2024', 'last month', 'this month', 'recently', 'ever',
    'before June 2024', 'after March 2025', 'between March 2026 and May 2026',
    'during the summer', 'around the holidays', 'two summers ago', 'yesterday',
    'since the move', 'in the fiscal year', 'that month', 'those years',
  ];
  const leaked = TEMPORAL.filter((p) => win(`What did I spend ${p}?`) === undefined);
  check('INVARIANT: no temporal phrase resolves to UNSPECIFIED',
    leaked.length === 0,
    `leaked to "no particular period": ${leaked.join(', ')}`);

  // …and the invariant is not satisfied by detecting everything.
  const overreach = [
    'What are my top merchants?', 'How is my debt?', 'What is my net worth?',
  ].filter((p) => win(p) !== undefined);
  check('INVARIANT: …without claiming a period where none was named',
    overreach.length === 0, `over-detected: ${overreach.join(', ')}`);
}

// ══ THE CUE DETECTOR IS SPECIFIC, NOT GREEDY ═════════════════════════════════
//
// Tense is not a temporal claim. These carry time-shaped words in
// non-temporal roles and must not trip the safeguard.
{
  const NOT_CLAIMS = [
    'How much am I spending?',
    'What are my monthly subscriptions?',      // "monthly" describes a kind, not a period
    'Which merchants do I pay quarterly?',
    'What is my annual income?',
    'Show me my yearly totals',
  ];
  for (const q of NOT_CLAIMS) {
    check(`cue: "${q}" is not a temporal claim`, !hasTemporalCue(q.toLowerCase()),
      'a cadence adjective describes the THING, not the period being asked about');
  }
}

console.log(`\ntemporal-claim: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
