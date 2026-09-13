/**
 * lib/ai/brief/watermark.test.ts
 *
 * THE SOURCE WATERMARK — stable when nothing moved, different when anything could have.
 *
 * Pure: the inputs are hand-built and the hash is recomputed. The SQL's scoping
 * (another member's memory, another Space's accounts) needs rows and is proven
 * against the database by scripts/ai-baseline/daily-brief-lifecycle.check.ts; here
 * the query text is scanned for the predicates that make that true.
 *
 *   npx tsx lib/ai/brief/watermark.test.ts
 */

import { readFileSync } from 'node:fs';
import { WATERMARK_CLOCK_BUCKET_MS } from './policy';
import { computeWatermark, WATERMARK_VERSION, type WatermarkInputs } from './watermark';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const T = (s: string) => new Date(s);
const inputs: WatermarkInputs = {
  linkCount: 13, linkUpdatedAt: T('2026-08-27T12:46:10.572Z'),
  accountCount: 13, accountUpdatedAt: T('2026-09-12T19:34:40.981Z'),
  debtProfileUpdatedAt: null,
  accountConnectionUpdatedAt: T('2026-09-07T23:46:17.221Z'),
  plaidItemUpdatedAt: T('2026-09-12T19:34:43.142Z'),
  connectionUpdatedAt: T('2026-09-07T23:46:17.217Z'),
  transactionCount: 4457, transactionUpdatedAt: T('2026-09-12T19:34:14.190Z'),
  transactionEventUpdatedAt: T('2026-09-12T19:34:14.264Z'),
  positionCount: 6529, positionCreatedAt: T('2026-09-12T19:34:41.807Z'),
  positionSupersededCount: 0, positionDeletedCount: 0,
  recentPositionHash: '0f3c1a2b9d8e7f6a5b4c3d2e1f0a9b8c',
  reconstructionHash: '4a9b77581d661d89cf9c28df55460c09',
  instrumentUpdatedAt: T('2026-08-27T12:46:11.979Z'),
  priceCreatedAt: T('2026-09-07T23:46:26.875Z'),
  fxFetchedAt: null,
  snapshotHash: 'c2a5c58ac8474d1934de1b9ef69237f3',
  spaceUpdatedAt: T('2026-07-20T16:59:23.162Z'),
  expenseSectionUpdatedAt: null,
  memoryCount: 44, memoryActiveCount: 6, memoryCreatedAt: T('2026-09-13T11:34:23.692Z'),
};
const NOW = T('2026-09-13T09:10:00.000Z');
const w0 = computeWatermark(inputs, NOW);
const withChange = (patch: Partial<WatermarkInputs>) => computeWatermark({ ...inputs, ...patch }, NOW);

console.log('1. stable when nothing moved');
{
  check('identical inputs, identical watermark', computeWatermark({ ...inputs }, NOW) === w0);
  check('key order does not matter',
    computeWatermark(Object.fromEntries(Object.entries(inputs).reverse()) as unknown as WatermarkInputs, NOW) === w0);
  check('later in the same clock bucket', computeWatermark(inputs, T('2026-09-13T09:59:59.999Z')) === w0);
  check('the clock bucket is one hour', WATERMARK_CLOCK_BUCKET_MS === 3_600_000);
}

console.log('\n2. different when anything the package reads could have moved');
{
  check('the next hour (time-only freshness bands)', computeWatermark(inputs, T('2026-09-13T10:00:00.000Z')) !== w0);
  const cases: [string, Partial<WatermarkInputs>][] = [
    ['an account balance or clock (FinancialAccount.updatedAt)', { accountUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['an account added to the transfer universe', { accountCount: 14 }],
    ['a link visibility change', { linkUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['a new transaction', { transactionCount: 4458 }],
    ['a transaction reclassified or posted', { transactionUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['an event re-pointed', { transactionEventUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['a new position observation', { positionCount: 6530 }],
    ['a position superseded', { positionSupersededCount: 1 }],
    ['a reconstruction rewritten', { reconstructionHash: 'ffff' }],
    ['a new price for a held instrument', { priceCreatedAt: T('2026-09-13T06:30:00.000Z') }],
    ['instrument metadata', { instrumentUpdatedAt: T('2026-09-13T06:30:00.000Z') }],
    ['an FX rate arriving', { fxFetchedAt: T('2026-09-13T06:30:00.000Z') }],
    ['a snapshot value rewritten in place', { snapshotHash: 'd00d' }],
    ['an APR entered', { debtProfileUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['a Plaid item needing reauth', { plaidItemUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['declared monthly expenses', { expenseSectionUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['the reporting currency', { spaceUpdatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['the owner remembering something', { memoryCount: 45, memoryCreatedAt: T('2026-09-13T08:00:00.000Z') }],
    ['the owner retiring a memory', { memoryActiveCount: 5 }],
  ];
  for (const [name, patch] of cases) check(name, withChange(patch) !== w0);
}

console.log('\n3. safe to persist');
{
  check('a versioned SHA-256 and nothing else', new RegExp(`^${WATERMARK_VERSION}:[0-9a-f]{40}$`).test(w0));
  check('no count, clock or row hash is readable in it', !/4457|6529|2026|c2a5c58a|4a9b7758/.test(w0));
}

console.log('\n4. the query is scoped the way the database check proves');
{
  const sql = readFileSync('lib/ai/brief/watermark.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const memoryPredicates = sql.match(/FROM "SpaceMemory" WHERE[^)]*/g) ?? [];
  check('every memory read is scoped to the Space AND the owner',
    memoryPredicates.length === 3 && memoryPredicates.every((p) => /"spaceId" = \$\{spaceId\}/.test(p) && /"ownerUserId" = \$\{ownerUserId\}/.test(p)));
  check('the account universe starts from this Space\'s links', /FROM "SpaceAccountLink" WHERE "spaceId" = \$\{spaceId\}/.test(sql));
  check('snapshots are this Space\'s', /FROM "SpaceSnapshot" WHERE "spaceId" = \$\{spaceId\}/.test(sql));
  check('no balance, amount, name or memory text is selected as a value',
    !/SELECT[^(]*"(balance|amount|name|merchant|mask|netWorth|payload|statedAs)"/.test(sql)
      && !/(max|min|sum|avg)\("(balance|amount|netWorth)"/.test(sql));
  check('it only reads', !/\b(INSERT|UPDATE|DELETE)\b/.test(sql));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
