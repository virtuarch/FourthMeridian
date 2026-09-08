/**
 * scripts/ai-baseline/transaction-corpus.check.ts
 *
 * THE DB HALF, AGAINST THE REAL RECORD. `transaction-corpus-coverage.test.ts`
 * proves the semantics purely and runs in CI; this proves the bounds are the
 * ACTUAL bounds and needs a database, so it is deliberately outside the DB-free
 * suite (the memory-store.check.ts precedent).
 *
 *   npm run ai:corpus-check
 *
 * It asserts the exact facts the 2×2 causal-evidence experiment (bb2f6ec) turned
 * on: the window cells A and B chose in 20 of 20 calls is genuinely empty of the
 * Coinbase evidence, the same search unwindowed returns it, and BOTH results now
 * report the same available span.
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, type ToolContext } from '@/scripts/ai-baseline/tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

type Result = {
  window: { from: string | null; to: string };
  coverage: { transactionsAvailableFrom: string | null; transactionsAvailableTo: string | null;
    windowCoversAvailableRecord: boolean; note?: string; unavailableReason?: string };
  shown: number;
  rows: { date: string; amount: number }[];
  rankingIsComplete?: boolean;
};

async function main() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId: space.id, role: 'OWNER', status: 'ACTIVE' } });
  const ctx: ToolContext = { spaceId: space.id, asOfISO: '2026-09-08', spaceCtx: {
    userId: owner.userId, spaceId: space.id, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
  } as never };
  const gt = findTool('get_transactions')!;
  const run = (args: Record<string, unknown>) => gt.run(args, ctx) as Promise<Result>;

  console.log('1. UNWINDOWED — the full available span, and the evidence');
  const open = await run({ text: 'coinbase', flow: 'all', sort: 'largest', limit: 50 });
  const corpusFrom = open.coverage.transactionsAvailableFrom;
  const corpusTo = open.coverage.transactionsAvailableTo;
  check('both ends established from the record', corpusFrom !== null && corpusTo !== null,
    `${corpusFrom}..${corpusTo}`);
  check('no `from` supplied ⇒ window.from stays null (no default window)', open.window.from === null);
  check('an unwindowed search covers the record', open.coverage.windowCoversAvailableRecord === true);
  check('…and therefore carries no partial-window note', open.coverage.note === undefined);
  check('the Feb-27 evidence is here', open.rows.some((r) => r.date.startsWith('2026-02-27')),
    `${open.shown} rows`);

  console.log('\n2. THE WINDOW CELLS A AND B CHOSE, 20 OF 20 CALLS');
  const windowed = await run({ from: '2026-06-10', to: '2026-09-08', text: 'coinbase',
    flow: 'transfers', sort: 'largest', limit: 20 });
  check('genuinely empty — the tool answered correctly', windowed.shown === 0);
  check('the searched window is reported as searched',
    windowed.window.from === '2026-06-10' && windowed.window.to === '2026-09-08');
  check('the broader span is reported alongside it, unshrunk by the miss',
    windowed.coverage.transactionsAvailableFrom === corpusFrom
    && windowed.coverage.transactionsAvailableTo === corpusTo);
  check('the empty result is visibly PARTIAL',
    windowed.coverage.windowCoversAvailableRecord === false && typeof windowed.coverage.note === 'string');
  check('a complete ranking of the window does NOT claim the record',
    windowed.rankingIsComplete === true && windowed.coverage.windowCoversAvailableRecord === false);

  console.log('\n3. FILTERS DO NOT SHRINK THE SPAN');
  const noFilter = await run({ from: '2026-06-10', to: '2026-09-08', flow: 'all', limit: 5 });
  check('a matching search reports the same span as the missing one',
    noFilter.coverage.transactionsAvailableFrom === windowed.coverage.transactionsAvailableFrom
    && noFilter.coverage.transactionsAvailableTo === windowed.coverage.transactionsAvailableTo,
    `${noFilter.shown} rows vs ${windowed.shown}`);
  const category = await run({ from: '2026-06-10', to: '2026-09-08', category: 'Travel', limit: 5 });
  check('a category filter does not move it either',
    category.coverage.transactionsAvailableFrom === corpusFrom);

  console.log('\n4. THE INFORMATION CEILING REACHES THE SPAN');
  const retro = await run({ asOf: '2026-01-01', from: '2025-12-01', to: '2026-01-01', limit: 5 });
  check('a retrospective read cannot learn that later transactions exist',
    retro.coverage.transactionsAvailableTo !== null && retro.coverage.transactionsAvailableTo <= '2026-01-01',
    `to=${retro.coverage.transactionsAvailableTo}`);
  check('…and its earliest end is unchanged (the past did not move)',
    retro.coverage.transactionsAvailableFrom === corpusFrom);

  console.log('\n5. A WINDOW COVERING THE RECORD IS RECOGNIZABLE');
  const whole = await run({ from: corpusFrom!, to: '2026-09-08', text: 'coinbase', sort: 'largest', limit: 50 });
  check('covers the record', whole.coverage.windowCoversAvailableRecord === true);
  check('and returns the same evidence the unwindowed search did',
    whole.rows.some((r) => r.date.startsWith('2026-02-27')));

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
