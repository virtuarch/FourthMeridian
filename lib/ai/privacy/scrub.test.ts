/**
 * lib/ai/privacy/scrub.test.ts  (SEC-AI-005)
 *
 * ONE SCRUB, EVERY DESCRIPTOR. The pure rule (the Brief's, unchanged); the real
 * assembler builders that feed get_spending / get_income / the orientation,
 * driven with raw bank descriptors; and source pins that every emitting site
 * in tools.ts and the transactions assembler goes through it and that the raw
 * `description` no longer leaves the server.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/privacy/scrub.test.ts
 */

import { readFileSync } from 'node:fs';
import { scrubDescriptor, scrubDescriptorText, MAX_SCRUBBED_CHARS, UNNAMED_DESCRIPTOR } from './scrub';
import {
  buildMerchantRollup, buildRecurringCandidates, buildIncomeSourceRollup, type RollupRow,
} from '@/lib/ai/assemblers/transactions';
import { identityContext } from '@/lib/money/convert';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const strip = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CARD = 'VISA DDA PUR 4111111111111111 AMZN Mktp';
const CHEQUE = 'CHECK #1052';
const REF = 'AMZN Mktp US*2K4Q1 #1234567';

console.log('1. the rule (the Brief\'s, unchanged)');
{
  check('a 16-digit card run is removed', scrubDescriptor(CARD) === 'VISA DDA PUR AMZN Mktp', scrubDescriptor(CARD));
  check('a cheque number is removed with its # marker', scrubDescriptor(CHEQUE) === 'CHECK', scrubDescriptor(CHEQUE));
  check('reference ids and * markers go; 3-digit and alphanumeric tokens stay', scrubDescriptor(REF) === 'AMZN Mktp US 2K4Q1', scrubDescriptor(REF));
  check('a 3-digit run is not a secret', scrubDescriptor('Terminal 2 Gate 123') === 'Terminal 2 Gate 123');
  check('clean names pass through unchanged (idempotent)', ['Whole Foods Market', '7-Eleven', 'Acme Corp Payroll'].every((s) => scrubDescriptor(s) === s && scrubDescriptor(scrubDescriptor(s)) === s));
  check('nothing but digits/symbols ⇒ undefined; the text form says unnamed', scrubDescriptor('#1234567 *') === undefined && scrubDescriptorText('123456789') === UNNAMED_DESCRIPTOR);
  check('null / undefined ⇒ undefined', scrubDescriptor(null) === undefined && scrubDescriptor(undefined) === undefined);
  const long = 'A'.repeat(60);
  check(`clipped to ${MAX_SCRUBBED_CHARS} with an ellipsis`, (scrubDescriptor(long) ?? '').length === MAX_SCRUBBED_CHARS && (scrubDescriptor(long) ?? '').endsWith('…'));
}

console.log('\n2. tool output — the builders behind get_spending / get_income / the orientation, fed raw descriptors');
{
  const ctx = identityContext(DEFAULT_DISPLAY_CURRENCY);
  const row = (merchant: string, amount: number, flowType: RollupRow['flowType'], category = 'Shopping', date = '2026-06-10'): RollupRow =>
    ({ merchant, category, amount, currency: 'USD', date: new Date(`${date}T00:00:00Z`), flowType });
  const spend = [row(CARD, -40, 'SPENDING'), row(CARD, -45, 'SPENDING', 'Shopping', '2026-06-12'), row(CHEQUE, -900, 'SPENDING', 'Housing'), row(CHEQUE, -900, 'SPENDING', 'Housing', '2026-07-10')];
  const merchants = buildMerchantRollup(spend, ctx, 25).items.map((m) => m.canonicalName);
  check('top merchants carry no digit run of 4+', merchants.length > 0 && merchants.every((m) => !/\d{4,}/.test(m)), merchants.join(' | '));
  const recurring = buildRecurringCandidates(spend, ctx).map((r) => r.merchant);
  check('recurring candidates (grouped on the raw key) leave scrubbed', recurring.length === 2 && recurring.every((m) => !/\d{4,}/.test(m) && !/#/.test(m)), recurring.join(' | '));
  const income = buildIncomeSourceRollup([row('ACME PAYROLL 20260610 REF 9988776655', 5000, 'INCOME', 'Income')], ctx, 10, () => null).items.map((s) => s.canonicalName);
  check('income sources too', income.length === 1 && !/\d{4,}/.test(income[0]), income.join(' | '));
}

console.log('\n3. source — every emitting site goes through the one scrub, and the raw description is gone');
{
  // CQ-011: get_transactions moved to its own module; the pin follows the scrub site.
  const tools = strip('lib/ai/conversation/tools/transactions.ts');
  check('get_transactions rows: merchant scrubbed, no `description` field', /merchant: scrubDescriptor\(r\.merchantDisplayName \?\? r\.merchant\)/.test(tools) && !/description: r\.description/.test(tools));
  check('…imported from the shared module', /from '@\/lib\/ai\/privacy\/scrub'/.test(tools));
  const asm = strip('lib/ai/assemblers/transactions.ts');
  check('largestIncome / largestExpense scrubbed', (asm.match(/merchant: scrubDescriptorText\(largest(?:Income|Expense)Row\.merchant\)/g) ?? []).length === 2);
  check('merchant and income rollups scrubbed', (asm.match(/canonicalName: scrubDescriptorText\(agg\.canonicalName\)/g) ?? []).length === 2);
  check('recurring candidates scrubbed', /merchant:\s+scrubDescriptorText\(merchant\)/.test(asm));
  check('drilldown: merchant and rawMerchant scrubbed, `description` never emitted',
    /merchant: scrubDescriptorText\(r\.resolvedMerchant\?\.displayName/.test(asm) && /rawMerchant: scrubDescriptor\(r\.merchant\)/.test(asm) && !/\{ description: r\.description \}/.test(asm));
  check('no raw `.merchant` or `.description` is assigned to an outgoing field anywhere in the assembler',
    !/(?:merchant|canonicalName|rawMerchant):\s+(?:r|txn|agg|largest\w+Row)\.(?:merchant|description)\b/.test(asm));
  const brief = strip('lib/ai/brief/recent-activity.ts');
  check('the Brief delegates to the same function', /return scrubDescriptor\(value\);/.test(brief));
  check('the scrub module is pure (no server-only, no imports)', !/import/.test(strip('lib/ai/privacy/scrub.ts')));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
