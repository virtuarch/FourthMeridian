/**
 * lib/ai/output-validator.test.ts
 *
 * AI-4 / KD-2 output-validator tests — pure, no DB, no LLM.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/assemblers/transactions.privacy.test.ts and lib/data/transactions.privacy.test.ts:
 *
 *     npx tsx lib/ai/output-validator.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 */

import {
  validateOutput,
  applyEnforcement,
  UNVERIFIED_FIGURE_NOTICE,
  BLOCKED_REPLY_NOTICE,
} from './output-validator';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// A synthetic grounded system prompt with the number formats the real prompt
// emits (fmtMoney "$1,234.56", "12.3%", "3.2 months", scale figures, "$0.00").
const SYSTEM_PROMPT = [
  '=== FINANCIAL CONTEXT ===',
  'Liquid cash: $12,500.00 (2 account(s))',
  'Total liabilities: $8,432.10',
  'Implied monthly income: $5,000.00/mo',
  // KD-10 (resolved): a SINGLE authoritative monthly-expense value. The assessment
  // and context blocks now emit the same complete-month figure, so only one value
  // appears across the prompt (different labels, identical number).
  'Est. monthly expenses: $2,100.00/mo',
  'AVERAGE MONTHLY SPENDING (deterministic): $2,100.00/month',
  'Coverage: 3.2 months',
  'Investment value: $1,200,000.00',
  'Interest rate: 12.3%',
  'Balance: $0.00',
  'Analysis period: Jan 2026 – Mar 2026',
].join('\n');

/** Convenience: validate a reply against the shared prompt (+ optional user turns). */
const run = (reply: string, userMsgs: string[] = []) =>
  validateOutput(reply, SYSTEM_PROMPT, userMsgs);

// 1. Verbatim money reconciles.
check(
  'verbatim money ($12,500.00) reconciles',
  run('You have $12,500.00 in liquid cash.').unreconciled.length === 0,
);

// 2. Reformatting (dropped $, dropped cents) reconciles.
{
  const r = run('Liabilities are 8432.10, i.e. about $8,432 total.');
  check('reformatted money (8432.10 / $8,432) reconciles', r.unreconciled.length === 0,
    JSON.stringify(r.unreconciled));
}

// 3. Coarse rounding the model plausibly used reconciles (source 8432.10).
{
  const r = run('Roughly $8,400 — call it $8,000 in round numbers.');
  check('coarse rounding ($8,400 / $8,000 from 8432.10) reconciles', r.unreconciled.length === 0,
    JSON.stringify(r.unreconciled));
}

// 4. Fabricated figures are flagged (money and bare-decimal).
check(
  'fabricated $9,999.99 is flagged',
  run('You could save $9,999.99 next month.').unreconciled.some((u) => u.value === 9999.99),
);
check(
  'fabricated bare-decimal 7777.77 is flagged',
  run('The model asserts 7777.77 in fees.').unreconciled.some((u) => u.value === 7777.77),
);

// 5. Percentages: real reconciles, fabricated flagged.
check('real percentage (12.3%) reconciles', run('Your APR is 12.3%.').unreconciled.length === 0);
check('fabricated percentage (45.6%) flagged',
  run('You saved 45.6% this year.').unreconciled.some((u) => u.value === 45.6));

// 6. Coverage months reconcile.
check('coverage months (3.2 months) reconciles',
  run('That is 3.2 months of runway.').unreconciled.length === 0);

// 7. Scale abbreviations reconcile ($1.2M ← $1,200,000.00).
{
  const r = run('Your portfolio is about $1.2M.');
  check('scale abbreviation ($1.2M ↔ 1,200,000) reconciles', r.unreconciled.length === 0,
    JSON.stringify(r.unreconciled));
}

// 8. Bare integers (years, counts, ordinals) are NOT flag-eligible.
{
  const r = run('In 2026, across 2 accounts, your 1st priority is debt.');
  check('bare integers (2026 / 2 / 1st) are not flagged', r.unreconciled.length === 0,
    `checked=${r.checkedCount} unreconciled=${JSON.stringify(r.unreconciled)}`);
}

// 9. KD-10 (resolved): one authoritative figure reconciles; the old competing
//    window-normalized value no longer exists in the prompt, so it is flagged.
check('KD-10 authoritative figure ($2,100.00) reconciles',
  run('Monthly expenses are $2,100.00.').unreconciled.length === 0);
check('KD-10 retired competing figure ($1,850.00) is flagged',
  run('Monthly expenses are $1,850.00.').unreconciled.some((u) => u.value === 1850));

// 10. A number present only in the user's own message reconciles (echo).
{
  const r = run('As you said, your $3,333.00 in savings helps.', ['I have $3,333.00 saved.']);
  check('user-quoted number ($3,333.00) reconciles via user turn', r.unreconciled.length === 0,
    JSON.stringify(r.unreconciled));
  // ...and is fabricated if the user never said it.
  check('same number ($3,333.00) is flagged without the user turn',
    run('Your $3,333.00 in savings helps.').unreconciled.some((u) => u.value === 3333));
}

// 11. Empty / number-free replies are clean.
check('empty reply is clean', run('').unreconciled.length === 0 && run('').checkedCount === 0);
check('number-free reply is clean',
  run('You are managing your finances well.').unreconciled.length === 0);

// 12. Exit-criterion demonstration (v2.4.5 literal wording): a reply quoting a
//     number absent from context is detectably flagged.
{
  const r = run('Based on your data, you could invest $8,888.88 today.');
  check('EXIT CRITERION: number absent from context is flagged',
    r.unreconciled.length === 1 && r.unreconciled[0].value === 8888.88,
    JSON.stringify(r.unreconciled));
}

// 13. $0 reconciles when the prompt carries a zero balance.
check('$0 reconciles against $0.00 in context',
  run('That account holds $0.').unreconciled.length === 0);

// 14. Live enforcement (KD-2): applyEnforcement is pure and deterministic.
{
  const flagged = run('You could save $9,999.99 next month.'); // unreconciled.length > 0
  const clean   = run('You are managing your finances well.'); // unreconciled.length === 0

  // shadow — never changes the reply, flagged or clean.
  check('enforce/shadow leaves flagged reply unchanged',
    applyEnforcement('reply with $9,999.99', flagged, 'shadow') === 'reply with $9,999.99');

  // annotate + clean result — reply unchanged (no notice on a clean reply).
  check('enforce/annotate leaves clean reply unchanged',
    applyEnforcement('all good', clean, 'annotate') === 'all good');

  // annotate + flagged — appends the notice exactly once, append-only.
  const once = applyEnforcement('You could save $9,999.99.', flagged, 'annotate');
  check('enforce/annotate appends notice to flagged reply',
    once === `You could save $9,999.99.\n\n${UNVERIFIED_FIGURE_NOTICE}`, once);
  check('enforce/annotate preserves original model text',
    once.startsWith('You could save $9,999.99.'));
  check('enforce/annotate is idempotent (no double notice)',
    applyEnforcement(once, flagged, 'annotate') === once);

  // block + flagged — replaces the reply with the fixed blocked notice.
  check('enforce/block replaces flagged reply with blocked notice',
    applyEnforcement('You could save $9,999.99.', flagged, 'block') === BLOCKED_REPLY_NOTICE);
  // block + clean — passes the reply through untouched.
  check('enforce/block passes clean reply through',
    applyEnforcement('all good', clean, 'block') === 'all good');

  // The blocked notice must carry no flag-eligible figure of its own (so it can
  // never re-trigger the validator downstream).
  check('blocked notice contains no unreconciled figure',
    validateOutput(BLOCKED_REPLY_NOTICE, SYSTEM_PROMPT).unreconciled.length === 0);

  // determinism — identical inputs always yield identical output.
  check('enforce is deterministic across calls',
    applyEnforcement('x $9,999.99', flagged, 'annotate')
      === applyEnforcement('x $9,999.99', flagged, 'annotate'));
}

// ---------------------------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log('All AI-4 output-validator cases passed.');
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
