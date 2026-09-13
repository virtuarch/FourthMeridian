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

  console.log('\n6. PAGE COVERAGE — a page is not the population');
  // The 58b352f blocker: a correct nine-month window, a page of the newest rows,
  // the evidence just past the page edge, and an assistant that reported it did
  // not exist. Asserted as a PROPERTY, not against corpus-specific counts — the
  // first version of this check hard-coded 80 and broke the moment the ceiling
  // moved the window by four days.
  type Paged = Result & { matchedInWindow?: number; searchIsComplete?: boolean;
    searchCaveat?: string; moreAvailable?: unknown };
  const windowArgs = { from: '2026-01-01', to: '2026-09-12', flow: 'transfers' };

  const ranked = await run({ ...windowArgs, limit: 50, sort: 'largest' }) as Result & {
    rankedOver?: number; rankingIsComplete?: boolean; pagesRead?: number };
  const population = ranked.rankedOver ?? 0;
  check('the window matches more rows than one small page shows', population > 10, `${population} rows`);

  // Under the completion ceiling a search FINISHES rather than samples.
  const finished = await run({ ...windowArgs, limit: 15 }) as Paged;
  check('a small population is completed, not sampled',
    finished.searchIsComplete === true && finished.shown === finished.matchedInWindow,
    `${finished.shown} of ${finished.matchedInWindow} (asked for 15)`);
  check('…so the evidence a newest-first page would have cut off is present',
    finished.rows.some((r) => /coinbase/i.test(String((r as { description?: string }).description))));
  check('…and it carries no caveat, because nothing was unseen',
    finished.searchCaveat === undefined);
  check('`moreAvailable` is gone — subsumed, not duplicated', !('moreAvailable' in finished));

  // Above it a page stays a page, and says so. This is the branch that keeps a
  // browse a browse.
  const big = await run({ from: '2026-01-01', to: '2026-09-12', limit: 15 }) as Paged;
  check('a large population stays a page',
    big.searchIsComplete === false && (big.matchedInWindow ?? 0) > 100 && big.shown === 15,
    `${big.shown} of ${big.matchedInWindow}`);
  check('…and says what absence from those rows does not mean',
    /absence from these rows is NOT absence from the window/.test(String(big.searchCaveat)));
  check('…and is not silently inflated by the completion rule',
    big.shown === 15);

  const filtered = await run({ ...windowArgs, text: 'coinbase', limit: 50 }) as Paged;
  check('the same window, FILTERED, is complete and finds the evidence',
    filtered.searchIsComplete === true && filtered.matchedInWindow === filtered.shown
    && filtered.rows.length > 0, `${filtered.shown} of ${filtered.matchedInWindow}`);
  check('…and they are the Feb-27 rows',
    filtered.rows.every((r) => r.date.startsWith('2026-02-27')));

  const empty = await run({ from: '2026-01-01', to: '2026-09-12', text: 'kraken', limit: 50 }) as Paged;
  check('a complete empty search supports an absence claim',
    empty.shown === 0 && empty.matchedInWindow === 0 && empty.searchIsComplete === true);
  check('…and carries no caveat, because nothing was unseen', empty.searchCaveat === undefined);

  check('sort:largest is untouched — it exhausts and ranks (597745a)',
    ranked.rankingIsComplete === true && typeof ranked.pagesRead === 'number');
  check('…and carries no page-coverage block, because it read the whole set',
    !('matchedInWindow' in ranked) && !('searchIsComplete' in ranked));
  check('…and ranking surfaces the evidence a newest-first page can miss',
    ranked.rows.some((r) => /coinbase/i.test(String((r as { description?: string }).description))));

  const retroCount = await run({ asOf: '2026-02-01', ...windowArgs, limit: 50 }) as Paged;
  check('the count obeys the information ceiling — no future rows counted',
    (retroCount.matchedInWindow ?? Infinity) < population,
    `matched ${retroCount.matchedInWindow} at asOf 2026-02-01 vs ${population} at the ceiling`);
  check('…and a retrospective page that covers its population says complete',
    retroCount.shown >= (retroCount.matchedInWindow ?? 0)
      ? retroCount.searchIsComplete === true : true);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
