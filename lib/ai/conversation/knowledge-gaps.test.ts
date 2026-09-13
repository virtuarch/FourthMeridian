/**
 * lib/ai/conversation/knowledge-gaps.test.ts
 *
 * THE SECOND HALF OF AN ANSWER — what it could not establish, on its way out.
 *
 * ⚠️ THE PRE-FIX FAILURE IS PINNED FIRST. The runtime has produced knowledge
 * gaps all along: the accounts assembler computes them and
 * `get_financial_snapshot` returns them as `missingDebtFields`. The client has
 * rendered them all along too. What was missing was the middle — the engine
 * dropped them and the route never serialised one. §1 asserts the source still
 * carries them; everything after asserts they now arrive intact and alone.
 *
 *   npx tsx lib/ai/conversation/knowledge-gaps.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  collectKnowledgeGaps, readKnowledgeGap, readKnowledgeGaps, GAP_BEARING_FIELD,
} from './knowledge-gaps';
import type { KnowledgeGap } from '@/lib/ai/types';
import type { AiKnowledgeGap, AiChatResponse } from '@/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const code = (rel: string) =>
  readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

const APR: AiKnowledgeGap = { accountId: 'a1', accountName: 'Amex Platinum',
  field: 'apr', label: 'APR', debtSubtype: 'credit_card' };
const MIN: AiKnowledgeGap = { accountId: 'a1', accountName: 'Amex Platinum',
  field: 'minimumPayment', label: 'Minimum Payment', debtSubtype: 'credit_card' };
const MORTGAGE: AiKnowledgeGap = { accountId: 'a2', accountName: 'Home Loan',
  field: 'apr', label: 'Mortgage Rate', debtSubtype: 'mortgage' };

const snapshot = (gaps: unknown) => ({
  name: 'get_financial_snapshot',
  result: { asOf: '2026-09-13', netWorth: 38_957, [GAP_BEARING_FIELD]: gaps },
});

console.log('1. THE SOURCE — the runtime already produces these');
{
  // ⚠️ NAMED, NOT INFERRED. The tool carries the assembler's own list under this
  // key; if either end is renamed, the contract silently empties, so both ends
  // are asserted here rather than trusted.
  const tools = code('lib/ai/conversation/tools.ts');
  const assembler = code('lib/ai/assemblers/accounts.ts');
  check('the accounts assembler computes knowledge gaps',
    /const knowledgeGaps: KnowledgeGap\[\] = \[\]/.test(assembler));
  check('…for FULL-visibility debt accounts only — a withheld account has no gaps',
    /grantsAccountDetail\(link\.visibilityLevel\)/.test(assembler));
  check('…and the two fields are APR and minimum payment, nothing else',
    /field:\s*'apr'/.test(assembler) && /field:\s*'minimumPayment'/.test(assembler));
  check(`get_financial_snapshot returns them as \`${GAP_BEARING_FIELD}\``,
    new RegExp(`${GAP_BEARING_FIELD}: acc\\.knowledgeGaps`).test(tools));
  check('…and it is the only tool that carries them',
    (tools.match(new RegExp(GAP_BEARING_FIELD, 'g')) ?? []).length === 1);
}

console.log('\n2. THE SHAPES AGREE AT COMPILE TIME');
{
  // These assignments do the work; they fail the build, not the run.
  const fromServer: AiKnowledgeGap = {} as KnowledgeGap;
  const toServer: KnowledgeGap = {} as AiKnowledgeGap;
  check('the server gap and the public gap are mutually assignable',
    fromServer !== undefined && toServer !== undefined);
  const body: AiChatResponse = { message: 'hi', knowledgeGaps: [APR] };
  check('the response contract carries them beside the message',
    body.knowledgeGaps?.[0].field === 'apr');
  check('…and an ordinary answer omits the key entirely',
    !('knowledgeGaps' in ({ message: 'hi' } as AiChatResponse)));
}

console.log('\n3. COLLECTION FROM A TURN');
{
  check('a turn that read the accounts surfaces what was missing',
    JSON.stringify(collectKnowledgeGaps([snapshot([APR, MIN])])) === JSON.stringify([APR, MIN]));
  check('a turn that read nothing else surfaces nothing',
    collectKnowledgeGaps([{ name: 'get_spending', result: { totals: { spending: 6402.93 } } }])
      .length === 0);
  check('no tool calls at all ⇒ no gaps', collectKnowledgeGaps([]).length === 0);
  check('an empty list is not a gap', collectKnowledgeGaps([snapshot([])]).length === 0);
  check('two reads of the accounts describe the same gap once',
    collectKnowledgeGaps([snapshot([APR, MIN]), snapshot([APR, MIN])]).length === 2);
  check('…but two different accounts stay two gaps',
    collectKnowledgeGaps([snapshot([APR]), snapshot([MORTGAGE])]).length === 2);
  check('order is the order the evidence was read',
    collectKnowledgeGaps([snapshot([MORTGAGE]), snapshot([APR])])
      .map((g) => g.accountId).join(',') === 'a2,a1');
  check('a failed tool call contributes nothing',
    collectKnowledgeGaps([{ name: 'get_financial_snapshot',
      result: { error: 'no accounts in scope' } }]).length === 0);
}

console.log('\n4. NOTHING INTERNAL CROSSES THE SEAM');
{
  const leaky = collectKnowledgeGaps([snapshot([{
    ...APR,
    // Everything an internal type might grow, or a tool might carry beside it.
    plaidAccountId: 'plaid_123', visibilityLevel: 'FULL', balance: -4_213.55,
    ownerUserId: 'usr_1', rawRow: { secret: true },
  }])]);
  check('a gap is projected field by field, not spread',
    Object.keys(leaky[0]).sort().join(',') === 'accountId,accountName,debtSubtype,field,label');
  check('…so no balance, owner, provider id or visibility tier travels with it',
    !JSON.stringify(leaky).match(/plaid|balance|ownerUserId|visibilityLevel|rawRow/));
  const src = code('lib/ai/conversation/knowledge-gaps.ts');
  check('the module contains no spread of a tool object', !/\.\.\.\s*g\b|\.\.\.\s*value/.test(src));
  check('it reads one named field and no other tool state',
    !/toolCalls\[\d\]\.arguments|arguments|content|messages/.test(src));
  check('it imports nothing but a type — a client may hold it',
    (src.match(/^import .*/gm) ?? []).every((l) => l.startsWith('import type')));
}

console.log('\n5. MALFORMED IS DROPPED, NEVER HALF-RENDERED');
{
  for (const [name, bad] of [
    ['a null entry', null], ['a string entry', 'apr missing'], ['a number entry', 7],
    ['no accountId', { ...APR, accountId: '' }],
    ['no accountName', { ...APR, accountName: undefined }],
    ['an unknown field', { ...APR, field: 'interestRate' }],
    ['a field that is not a string', { ...APR, field: 3 }],
    ['no label', { ...APR, label: '' }],
    ['a non-string debtSubtype', { ...APR, debtSubtype: 42 }],
  ] as [string, unknown][]) {
    check(`${name} is rejected`, readKnowledgeGap(bad) === null);
  }
  check('a list containing one bad entry keeps the good ones',
    readKnowledgeGaps([APR, null, { field: 'apr' }, MORTGAGE]).length === 2);
  check('a non-array is simply no gaps', readKnowledgeGaps('nope').length === 0
    && readKnowledgeGaps(undefined).length === 0 && readKnowledgeGaps({ 0: APR }).length === 0);
  check('a missing debtSubtype is allowed — the label already reads',
    readKnowledgeGap({ accountId: 'a', accountName: 'Card', field: 'apr', label: 'APR' })
      ?.debtSubtype === undefined);
  check('…and null is allowed too, not coerced into a string',
    readKnowledgeGap({ ...APR, debtSubtype: null })?.debtSubtype === undefined);
}

console.log('\n6. THE ENGINE RETURNS THEM, AND THE ROUTE FORWARDS THEM');
{
  const engine = code('lib/ai/conversation/engine.ts');
  const route = code('app/api/ai/chat/route.ts');
  check('one result object carries them for every client',
    /knowledgeGaps: AiKnowledgeGap\[\]/.test(engine)
      && /knowledgeGaps: collectKnowledgeGaps\(record\.toolCalls\)/.test(engine));
  check('the route serialises the engine\'s list without re-deriving it',
    /knowledgeGaps: turn\.knowledgeGaps/.test(route)
      && !/collectKnowledgeGaps|missingDebtFields/.test(route));
  check('a gap never becomes a status — the answer is still a 200',
    !/knowledgeGap[\s\S]{0,140}(refuse\(|status: [45]\d\d)/.test(route));
  check('the CLI prints the same list, from the same collector',
    /collectKnowledgeGaps\(rec\.toolCalls\)/.test(code('scripts/ai-baseline/interactive.ts')));
  // ⚠️ SEPARATE FROM CONTINUITY. The sealed carrier holds a hypothetical; a gap
  // is presentation. Mixing them would put a rendering concern inside a cookie.
  check('the sealed scenario carrier is untouched by any of this',
    !/knowledgeGap/i.test(code('lib/ai/conversation/runtime-state.ts')));
  check('nothing sends a gap back into the model on a later turn',
    !/knowledgeGap/i.test(code('lib/ai/conversation/request.ts'))
      && !/knowledgeGap/i.test(code('lib/ai/conversation/turn.ts')));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
