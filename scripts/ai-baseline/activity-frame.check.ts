/**
 * scripts/ai-baseline/activity-frame.check.ts
 *
 * THE DB HALF, AGAINST THE REAL RECORD. `activity-frame.test.ts` proves the
 * window and existence rules purely and runs in CI; this proves the figures are
 * the assembler's own over exactly that window, that `recent` is unchanged by
 * the frame's introduction, and that emitting it costs exactly ONE extra
 * TRANSACTIONS_SUMMARY assembly. Needs a database, so it sits outside the
 * DB-free suite (the memory-store.check.ts / transaction-corpus.check.ts
 * precedent).
 *
 *   npm run ai:activity-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { buildEvidence, assembleFullContext } from '@/lib/ai/conversation/evidence';
import { findTool, type ToolContext } from '@/lib/ai/conversation/tools';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const tok = (s: string) => Math.ceil(s.length / 4);
const HEAD = 'FINANCIAL ORIENTATION\n';
type Frame = { window: { from: string; to: string; days: number }; income: number;
  spending: number; cardAndDebtPayments: number; netCashFlow: number; transactionCount: number };
type Core = Record<string, unknown> & { recent?: Frame; activity?: Frame };
const core = (body: string | null) => JSON.parse((body ?? '').slice(HEAD.length)) as Core;

async function main() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const spaceCtx = { userId: owner.userId, spaceId, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
  } as unknown as SpaceContext;

  // Count assemblies by counting the Transaction reads each one issues.
  let txQueries = 0;
  type Params = { model?: string };
  (db as unknown as { $use: (f: (p: Params, n: (p: Params) => Promise<unknown>) => Promise<unknown>) => void })
    .$use(async (p, next) => {
      const r = await next(p); if (p.model === 'Transaction') txQueries++; return r;
    });

  const ctx = await assembleFullContext(spaceCtx, 'activity-check');

  console.log('1. MATURE SPACE — the frame exists and is measured over its own window');
  txQueries = 0;
  const withFrame = await buildEvidence('A2', ctx, spaceCtx);
  const queriesWith = txQueries;
  const a = core(withFrame.body);
  check('activity is present', a.activity != null, JSON.stringify(a.activity?.window));
  check('it is a sibling of recent, immediately after it',
    Object.keys(a).join(',').includes('recent,activity'));
  check('to equals the assessment ceiling — both frames end on the same day',
    a.activity?.window?.to === a.recent?.window?.to, `${a.activity?.window?.to} vs ${a.recent?.window?.to}`);
  const days = a.activity?.window?.days ?? 0;
  check('the window is ~6 calendar months', days >= 182 && days <= 185, `${days}d`);
  check('exactly six keys', Object.keys(a.activity ?? {}).join(',')
    === 'window,income,spending,cardAndDebtPayments,netCashFlow,transactionCount');

  console.log('\n2. THE FIGURES ARE THE ASSEMBLER\'S OWN, OVER EXACTLY THAT WINDOW');
  const toolCtx: ToolContext = { spaceId, asOfISO: a.activity!.window.to, spaceCtx } as ToolContext;
  const direct = await findTool('get_spending')!.run(
    { from: a.activity!.window.from, to: a.activity!.window.to }, toolCtx) as {
      window: { from: string; days: number; transactionCount: number };
      totals: { income: number; spending: number; netCashFlow: number; cardAndDebtPayments: number };
    };
  check('income matches an independent read of the same window',
    direct.totals.income === a.activity!.income, `${direct.totals.income}`);
  check('spending matches', direct.totals.spending === a.activity!.spending);
  check('cardAndDebtPayments matches', direct.totals.cardAndDebtPayments === a.activity!.cardAndDebtPayments);
  check('netCashFlow matches', direct.totals.netCashFlow === a.activity!.netCashFlow);
  check('transactionCount matches', direct.window.transactionCount === a.activity!.transactionCount);
  check('the served window is the requested window — no silent clamp',
    direct.window.from === a.activity!.window.from && direct.window.days === days);

  console.log('\n3. RECENT IS UNCHANGED BY THE FRAME\'S INTRODUCTION');
  txQueries = 0;
  // An asOf inside the first days of the record: coverage is far too short, so
  // the frame cannot exist and the body is the proven single-frame control.
  const early = await buildEvidence('A2', ctx, spaceCtx, '2024-08-16');
  const queriesWithout = txQueries;
  const b = core(early.body);
  check('activity is OMITTED under sparse history', !('activity' in b));
  check('…the key is absent, not null', b.activity === undefined && !JSON.stringify(b).includes('"activity"'));
  check('recent is byte-identical with and without the frame',
    JSON.stringify(a.recent) === JSON.stringify(b.recent), JSON.stringify(b.recent?.window));
  const stripped = { ...a }; delete stripped.activity;
  check('every other orientation key is byte-identical too',
    JSON.stringify(stripped) === JSON.stringify(b));

  console.log('\n4. EXACTLY ONE EXTRA ASSEMBLY, AND NONE WHEN OMITTED');
  check('emitting the frame costs 2 more Transaction reads than omitting it',
    queriesWith - queriesWithout === 2, `${queriesWith} vs ${queriesWithout}`);
  check('omission costs no assembly at all — the window is resolved first',
    queriesWithout <= 2, `${queriesWithout} (corpus span + coverage envelope)`);

  console.log('\n5. RETROSPECTIVE asOf');
  const retro = core((await buildEvidence('A2', ctx, spaceCtx, '2026-03-15')).body);
  check('to is the historical ceiling', retro.activity?.window?.to === '2026-03-15');
  check('from crosses the calendar year — no YTD reset',
    (retro.activity?.window?.from ?? '').startsWith('2025'), retro.activity?.window?.from);
  check('figures differ from the current frame (measured, not reused)',
    retro.activity?.income !== a.activity!.income);

  console.log('\n6. CONTEXT COST');
  const s1 = JSON.stringify(a, null, 1), s2 = JSON.stringify(stripped, null, 1);
  console.log(`  activity adds +${s1.length - s2.length} bytes / +${tok(s1) - tok(s2)} tokens `
    + `(+${((s1.length - s2.length) / s2.length * 100).toFixed(1)}% of the orientation)`);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
