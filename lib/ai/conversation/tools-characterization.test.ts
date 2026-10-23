/**
 * lib/ai/conversation/tools-characterization.test.ts — CQ-011
 *
 * THE TOOL SURFACE, PINNED BEFORE IT WAS SPLIT. `tools.ts` was one 4,800-line
 * module; CQ-011 split it into domain modules under `tools/` behind a thin facade.
 * This suite was written and committed against the UNCHANGED module first, so
 * every later move is proven against what the model saw before it.
 *
 *   1. The public contract with the model: the ordered tool names and the exact
 *      `openAiToolSchemas()` output, byte-for-byte against a committed snapshot
 *      (`__snapshots__/tool-schemas.json`). A diff here is a change to what the
 *      model reads every turn — never a refactor.
 *   2. `findTool` resolves every registered name to the registry's own object and
 *      nothing else.
 *   3. The module's runtime export surface, and its type exports (compile-time,
 *      via the `import type` below — `npm run typecheck` enforces them).
 *   4. Behaviour of the pure helpers that moved, at their pre-split outputs.
 *
 * ⚠️ TO REGENERATE THE SNAPSHOT you must be changing the contract on purpose:
 *   FM_WRITE_TOOL_SCHEMA_SNAPSHOT=1 npx tsx --require ./scripts/lib/server-only-preload.cjs \
 *     lib/ai/conversation/tools-characterization.test.ts
 * and the resulting diff is the review.
 *
 * Standalone tsx script. No DB, no network, no model.
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CashSpineReads, ToolContext, ToolDefinition, TransactionPager,
} from './tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});

// Compile-time pin of the type exports: if any of these stops being exported
// from `./tools`, typecheck fails here.
type _TypeSurface = [CashSpineReads, ToolContext, ToolDefinition, TransactionPager];
const _typeSurface: _TypeSurface | null = null;
void _typeSurface;

const SNAPSHOT = join(process.cwd(), 'lib/ai/conversation/__snapshots__/tool-schemas.json');

/** Every runtime export of `@/lib/ai/conversation/tools`, as of the pre-split module. */
const RUNTIME_EXPORTS = [
  'TOOLS', 'clampToCeiling', 'findTool', 'interestModelledLiabilityIds', 'monthEndsBetween',
  'openAiToolSchemas', 'readWindowToExhaustion', 'rebindDerivedFloors', 'rebindDerivedFloorsByDate',
  'yearEndsBetween',
];

async function main(): Promise<void> {
  const tools = await import('@/lib/ai/conversation/tools');
  const { TOOLS, openAiToolSchemas, findTool } = tools;

  // ── 1. the contract with the model ───────────────────────────────────────
  console.log('1. the tool contract');
  const names = TOOLS.map((t) => t.name);
  const current = `${JSON.stringify({ names, schemas: openAiToolSchemas() }, null, 2)}\n`;
  if (process.env.FM_WRITE_TOOL_SCHEMA_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT, current);
    console.log(`  wrote ${SNAPSHOT}`);
  }
  const pinned = readFileSync(SNAPSHOT, 'utf8');
  check('openAiToolSchemas() and the ordered tool names are byte-identical to the snapshot',
    current === pinned, 'the schema the model reads changed — this is not a refactor');
  check('the registry holds no duplicate names', new Set(names).size === names.length);
  check('openAiToolSchemas() is the registry, in order',
    JSON.stringify(openAiToolSchemas().map((s) => (s as { function: { name: string } }).function.name))
      === JSON.stringify(names));
  check('every tool has a name, description, parameters and run, and nothing else',
    TOOLS.every((t) => JSON.stringify(Object.keys(t).sort()) === '["description","name","parameters","run"]'
      && typeof t.run === 'function'));

  // ── 2. findTool ─────────────────────────────────────────────────────────────
  console.log('2. findTool');
  check('findTool resolves every registered name to the registry object',
    TOOLS.every((t) => findTool(t.name) === t));
  check('findTool returns undefined for unknown names',
    findTool('no_such_tool') === undefined && findTool('') === undefined
      && findTool('GET_SPENDING') === undefined && findTool('remember ') === undefined);

  // ── 3. the export surface ─────────────────────────────────────────────────
  console.log('3. the export surface');
  const exported = Object.keys(tools).filter((k) => k !== 'default' && k !== '__esModule').sort();
  check('the runtime export surface is unchanged', JSON.stringify(exported) === JSON.stringify(RUNTIME_EXPORTS),
    JSON.stringify(exported));

  // ── 4. pure helpers, at their pre-split outputs ───────────────────────────
  console.log('4. pure helpers');
  const { clampToCeiling, interestModelledLiabilityIds, rebindDerivedFloors, rebindDerivedFloorsByDate,
    monthEndsBetween, yearEndsBetween, readWindowToExhaustion } = tools;

  check('clampToCeiling: a later date is clamped to the ceiling',
    clampToCeiling('2026-09-30', '2026-06-30') === '2026-06-30');
  check('clampToCeiling: an earlier or equal date passes through',
    clampToCeiling('2026-01-31', '2026-06-30') === '2026-01-31'
      && clampToCeiling('2026-06-30', '2026-06-30') === '2026-06-30');

  const line = (id: string, apr: number | null) => ({ id, label: id, balance: 1_000, apr, minimumPayment: null });
  check('interestModelledLiabilityIds: every line with a known rate (0% included), in order, none without',
    JSON.stringify(interestModelledLiabilityIds([line('a', 24.99), line('b', null), line('c', 0), line('d', 5)]))
      === '["a","c","d"]');
  check('interestModelledLiabilityIds: empty in, empty out', interestModelledLiabilityIds([]).length === 0);

  check('monthEndsBetween / yearEndsBetween: re-exported grids',
    JSON.stringify(monthEndsBetween('2026-01-15', '2026-04-10')) === EXPECTED_MONTH_ENDS
      && JSON.stringify(yearEndsBetween('2026-03-01', '2028-06-30')) === EXPECTED_YEAR_ENDS,
    `${JSON.stringify(monthEndsBetween('2026-01-15', '2026-04-10'))} ${JSON.stringify(yearEndsBetween('2026-03-01', '2028-06-30'))}`);

  const { resolveMonthsOfExpensesFloor } = await import('@/lib/ai/measures/baseline');
  const baseD = resolveMonthsOfExpensesFloor({ monthsOfExpenses: 6, stated: null, observedMonthly: 4_000 });
  if ('unavailable' in baseD) throw new Error(baseD.unavailable);
  const movements = [
    { date: '2026-12-31', label: 'keep six months', floorMonthsOfExpenses: 6, liquidFloor: baseD.liquidFloor, fractionOfExcess: 1 },
    { date: '2027-01-31', label: 'fixed', amount: 500 },
    { date: '2027-02-28', label: 'keep six months', floorMonthsOfExpenses: 6, liquidFloor: baseD.liquidFloor, fractionOfExcess: 1 },
  ];
  const base = { amount: 4_000, source: 'OBSERVED' };
  const same = rebindDerivedFloors(movements, 4_000, base, [baseD]);
  check('rebindDerivedFloors: at the base level nothing changes (a copy, not the input)',
    !('unavailable' in same) && JSON.stringify(same.movements) === JSON.stringify(movements)
      && same.movements !== movements && same.derivations[0] === baseD);
  const cut = rebindDerivedFloors(movements, 3_000, base, [baseD]);
  check('rebindDerivedFloors: a lower run level re-resolves the derived floor and leaves the rest',
    JSON.stringify(cut) === EXPECTED_REBIND, JSON.stringify(cut));
  const zero = rebindDerivedFloors(movements, 0, base, [baseD]);
  check('rebindDerivedFloors: a run that spends nothing has a zero floor',
    !('unavailable' in zero) && zero.movements[0].liquidFloor === 0 && zero.derivations[0].derivedFrom.rule === '6 × 0');
  const byDate = rebindDerivedFloorsByDate(movements, (d) => (d < '2027-01-01' ? 3_500 : 3_000), base, [baseD]);
  check('rebindDerivedFloorsByDate: the floor follows the spending in force on its own date',
    JSON.stringify(byDate) === EXPECTED_REBIND_BY_DATE, JSON.stringify(byDate));

  // readWindowToExhaustion: the three ways the loop ends, on a fake pager.
  type Page = Awaited<ReturnType<TransactionPager>>;
  const pager = (pages: Page[]): TransactionPager => {
    let i = 0;
    return (async () => pages[Math.min(i++, pages.length - 1)]) as unknown as TransactionPager;
  };
  const row = (id: string) => ({ id }) as unknown as Page['rows'][number];
  const exhausted = await readWindowToExhaustion({} as never, 's1', {} as never, pager([
    { rows: [row('a')], hasMore: true, nextCursor: { lastId: 'a', lastDate: '2026-01-02' } } as unknown as Page,
    { rows: [row('b')], hasMore: false, nextCursor: null } as unknown as Page,
  ]));
  check('readWindowToExhaustion: pages until the seam says no more',
    exhausted.complete && exhausted.pages === 2 && exhausted.rows.length === 2);
  const stuck = await readWindowToExhaustion({} as never, 's1', {} as never, pager([
    { rows: [row('a')], hasMore: true, nextCursor: { lastId: 'a', lastDate: '2026-01-02' } } as unknown as Page,
  ]));
  check('readWindowToExhaustion: a non-advancing cursor stops, incomplete',
    !stuck.complete && stuck.pages === 2);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall tools characterisation checks passed');
  process.exit(0);
}

const EXPECTED_MONTH_ENDS = '["2026-01-31","2026-02-28","2026-03-31","2026-04-10"]';
const EXPECTED_YEAR_ENDS = '["2026-12-31","2027-12-31","2028-06-30"]';
const EXPECTED_REBIND = JSON.stringify({
  "movements": [
    {
      "date": "2026-12-31",
      "label": "keep six months",
      "floorMonthsOfExpenses": 6,
      "liquidFloor": 18000,
      "fractionOfExcess": 1
    },
    {
      "date": "2027-01-31",
      "label": "fixed",
      "amount": 500
    },
    {
      "date": "2027-02-28",
      "label": "keep six months",
      "floorMonthsOfExpenses": 6,
      "liquidFloor": 18000,
      "fractionOfExcess": 1
    }
  ],
  "derivations": [
    {
      "liquidFloor": 18000,
      "derivedFrom": {
        "rule": "6 months of expenses",
        "monthsOfExpenses": 6,
        "baseline": {
          "amount": 3000,
          "basis": "MEASURED",
          "note": "the observed spending rate this scenario spends at — the mean of the most recent complete months the cash projection averages — re-resolved at the 3000/month this run spends (the scenario's observed level after its transformation)"
        }
      }
    }
  ]
});
const EXPECTED_REBIND_BY_DATE = JSON.stringify({
  "movements": [
    {
      "date": "2026-12-31",
      "label": "keep six months",
      "floorMonthsOfExpenses": 6,
      "liquidFloor": 21000,
      "fractionOfExcess": 1
    },
    {
      "date": "2027-01-31",
      "label": "fixed",
      "amount": 500
    },
    {
      "date": "2027-02-28",
      "label": "keep six months",
      "floorMonthsOfExpenses": 6,
      "liquidFloor": 18000,
      "fractionOfExcess": 1
    }
  ],
  "derivations": [
    {
      "liquidFloor": 21000,
      "derivedFrom": {
        "rule": "6 months of expenses",
        "monthsOfExpenses": 6,
        "baseline": {
          "amount": 3500,
          "basis": "MEASURED",
          "note": "the observed spending rate this scenario spends at — the mean of the most recent complete months the cash projection averages — at the 3500/month this scenario spends from 2026-12-31 (its spending changes in force)"
        },
        "inForceFrom": "2026-12-31"
      }
    },
    {
      "liquidFloor": 18000,
      "derivedFrom": {
        "rule": "6 months of expenses",
        "monthsOfExpenses": 6,
        "baseline": {
          "amount": 3000,
          "basis": "MEASURED",
          "note": "the observed spending rate this scenario spends at — the mean of the most recent complete months the cash projection averages — at the 3000/month this scenario spends from 2027-02-28 (its spending changes in force)"
        },
        "inForceFrom": "2027-02-28"
      }
    }
  ]
});

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
