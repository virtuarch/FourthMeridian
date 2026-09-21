/**
 * lib/ai/conversation/history-facts.test.ts
 *
 * THE TOOL CONTRACTS THE BROWSER DOGFOOD BROKE.
 *
 * Four defects, all in what a payload SAYS rather than in what the data holds:
 *
 *   1. an exact date was read off a series the model scanned by eye — and the
 *      series it scanned had been silently downsampled, so the day the answer
 *      lived on was not in it;
 *   2. a card payment arrived as two unrelated rows, one per account;
 *   3. a monthly spending figure had to be invented by dividing a window total;
 *   4. and nothing said which of those populations a figure belonged to.
 *
 * The arithmetic is proved in lib/data/temporal-observation.test.ts and the live
 * facts in `npm run ai:temporal-check`. This pins the contracts.
 *
 *   npx tsx lib/ai/conversation/history-facts.test.ts
 */

import { readFileSync } from 'node:fs';
import { NEEDS_THRESHOLD, type TemporalOperation } from '@/lib/data/snapshot-window';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const code = (rel: string) =>
  readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

const tools = code('lib/ai/conversation/tools.ts');
const raw   = readFileSync('lib/ai/conversation/tools.ts', 'utf8');
const win   = code('lib/data/snapshot-window.ts');

console.log('1. EXACT DATES ARE CODE\'S, NOT THE MODEL\'S');
{
  check('a tool exists for them', /name: 'find_in_balance_history'/.test(tools));
  check('…and it is registered on the surface', /findInBalanceHistory,/.test(tools));
  check('the predicate itself lives in the history-math authority, not in the tool',
    /export function findObservation/.test(win)
      && /findObservation\(usable, operation, threshold\)/.test(tools));
  // ⚠️ SLICED ON A CODE ANCHOR, NOT A COMMENT. `code()` strips comments, so a
  // section marker is not in the string being searched — indexOf would return
  // -1 and the slice would quietly run to the end of the file, testing every
  // other tool instead of this one.
  const toolBody = tools.slice(tools.indexOf("name: 'find_in_balance_history'"),
    tools.indexOf("name: 'explain_net_worth_composition'"));
  check('the section really is this tool alone',
    toolBody.length > 500 && toolBody.length < 9000 && toolBody.includes('findObservation('),
    `${toolBody.length} chars`);
  check('the tool adds no arithmetic of its own',
    !/Math\.min\(|Math\.max\(|\.sort\(|\.reduce\(/.test(toolBody));
  check('it reads through the SAME snapshot authority as the series tool — one history',
    (tools.match(/projectSnapshotSection\(rows as Snapshot\[\], 'full'\)/g) ?? []).length === 3);
  check('and it respects the information ceiling',
    /const to = clampToCeiling\(\(a\.to as string\) \|\| ceiling, ceiling\)/.test(tools));
}

console.log('\n2. THE OPERATIONS, AND THE VOCABULARY THAT SURVIVED A LIVE RUN');
{
  const ops: TemporalOperation[] = ['minimum', 'maximum', 'first_below', 'first_above',
    'last_below', 'last_above'];
  for (const op of ops) check(`\`${op}\` is offered`, tools.includes(`'${op}'`));
  check('every operation declares whether it needs a threshold',
    ops.every((op) => op in NEEDS_THRESHOLD));
  // ⚠️ MEASURED, NOT TASTE. `first_at_or_below` was assembled as
  // `first_at_or_at_or_below` in 2 of 6 live calls — a repeated segment gets
  // repeated. The short names cost a wasted round trip less.
  check('no operation name repeats a segment', ops.every((op) => {
    const parts = op.split('_');
    return new Set(parts).size === parts.length;
  }));
  check('a missing threshold is refused rather than defaulted',
    /needs a numeric threshold/.test(tools));
  check('the description says the comparison INCLUDES the threshold',
    /INCLUDE the threshold itself/.test(raw));
}

console.log('\n3. THE SERIES STOPS PRETENDING TO BE THE RECORD');
{
  check('it reports how many observations the range actually holds',
    /observationsInRange: inRange\.length/.test(tools));
  check('…and says so when what came back is a sample',
    /seriesIsSample: true/.test(tools) && /picked\.length < inRange\.length/.test(tools));
  check('…naming both numbers, so the gap is a fact and not an adjective',
    /\$\{picked\.length\} of \$\{inRange\.length\} observations/.test(raw));
  check('…and sending exact questions to the tool that searches all of them',
    /never state a first, last, highest or lowest from it/.test(raw)
      && /Use find_in_balance_history for those/.test(raw));
  check('the series description points there too',
    /use `find_in_balance_history` instead/.test(raw));
}

console.log('\n4. NO MATCH AND NO COVERAGE ARE DIFFERENT ANSWERS');
{
  check('an empty range says so', /NO_OBSERVATIONS_IN_RANGE/.test(tools));
  check('a range whose values could not be established says THAT',
    /NO_ESTABLISHED_OBSERVATIONS_IN_RANGE/.test(tools));
  check('a searched range that simply never met the condition says that',
    /NO_OBSERVATION_MEETS_THE_CONDITION/.test(tools));
  check('the three are distinct strings', new Set(['NO_OBSERVATIONS_IN_RANGE',
    'NO_ESTABLISHED_OBSERVATIONS_IN_RANGE', 'NO_OBSERVATION_MEETS_THE_CONDITION']).size === 3);
  check('unestablished observations are removed from the scan and counted',
    /observationsUnassertable: unassertable/.test(tools) && /They are not zeroes/.test(raw));
  check('the answer says it is observed, not interpolated',
    /Observed daily snapshots only/.test(raw) && /nothing between two observations is modelled/.test(raw));
}

console.log('\n5. A CARD PAYMENT IS ONE EVENT SEEN FROM TWO ACCOUNTS');
{
  check('a transaction row names the account it posted to', /\{ account: accountName\(r\.accountId\) \}/.test(tools));
  check('…and the owned account on the other side',
    /counterpartyAccount: accountName\(r\.counterpartyAccountId\)/.test(tools));
  check('…with a note that says it is one leg',
    /do not add it to the other leg/.test(raw));
  // ⚠️ THE LEGS STAY. Collapsing them would delete real evidence about the
  // account each one posted to, and no persisted identity pairs them anyway.
  check('no row is dropped, merged or deduplicated',
    !/dedup|deduplicate|collapse|mergeLegs/i.test(tools));
  check('nothing is paired by matching amounts or dates',
    !/Math\.abs\(x\.amount\) === Math\.abs\(y\.amount\)|samePair|pairKey/.test(tools));
  check('the names come from the accounts assembler, which decides who may see them',
    /assemble<AccountsSectionData>\(FinanceDomains\.ACCOUNTS, ctx\)/.test(tools)
      && /names\.get\(id\)/.test(tools));
  check('…so an invisible counterparty simply has no name',
    /const accountName = \(id: string \| null \| undefined\) => \(id \? names\.get\(id\) : undefined\)/.test(tools));
}

console.log('\n6. A MONTHLY FIGURE IS MEASURED, NOT DIVIDED');
{
  // FM-AUDIT-007 — the monthly figure is THE one monthly-spending mean
  // (meanMonthlyEconomicSpend, NET of refunds), over whole months only.
  check('whole months only — a partial month is excluded',
    /monthlyBreakdown\.filter\(\(m\) => !\(m\.partial \?\? false\)\)/.test(tools));
  check('the monthly figure is the shared NET mean, not adapter arithmetic',
    /meanMonthlyEconomicSpend\(wholeMonths\.map/.test(tools) && !/whole\.reduce\(\(n, m\) => n \+ m\.spending, 0\) \/ whole\.length/.test(tools));
  check('the spread is reported beside the mean',
    /lowest:\s*\{ month: low!\.month/.test(tools) && /highest: \{ month: high!\.month/.test(tools));
  check('one month is not a spread', /wholeMonths\.length >= 2/.test(tools));
  // The basis sentence is wrapped across source lines; assert the phrases.
  check('it states that debt payments are NOT in it',
    raw.includes('card and debt ') && raw.includes('payments and movements between your own accounts are NOT in it'));
  check('…and that it is not a core or recurring commitment',
    raw.includes('not a core or ') && raw.includes('recurring commitment'));
  check('…and tells the reader not to divide a window total',
    raw.includes('rather than dividing a window total'));
  check('the tool description names the question that needs it',
    /how long would my cash last/.test(raw));
  check('no target, rule of thumb or recommendation is shipped in the payload',
    !/3-6 months|three to six|should have|recommend|emergency fund target/i.test(tools));
}

console.log('\n7. NOTHING ELSE MOVED');
{
  const finder = win.slice(win.indexOf('export function findObservation'),
    win.indexOf('export function seriesSpanDays'));
  check('the money tolerance is a comparison rule, not a rounding one',
    /export const MONEY_EPSILON/.test(win) && finder.length > 200
      && !/toFixed|Math\.round/.test(finder));
  check('the sealed scenario carrier is untouched',
    !/find_in_balance_history|MONEY_EPSILON/.test(code('lib/ai/conversation/runtime-state.ts')));
  check('the response contract is untouched',
    !/find_in_balance_history/.test(code('app/api/ai/chat/route.ts')));
  check('the instruction gained no doctrine about dates',
    !/careful|double-check|make sure|always verify/i.test(code('lib/ai/conversation/turn.ts')));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
