/**
 * lib/ai/brief/load.test.ts
 *
 * ONE SPACE, ONE OWNER, ONE CEILING — what the loader asks the authorities for.
 *
 * Every read is an injected fake, so this runs with no database and asserts the
 * ARGUMENTS each authority receives: the named Space, the resolved owner's memory
 * scope, and a ceiling applied to every dated read.
 *
 *   npx tsx lib/ai/brief/load.test.ts
 */

import type { SpaceContext } from '@/lib/space';
import type { Snapshot } from '@/types';
import type { AssemblerOptions, SnapshotSectionData } from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence';
import type { MemoryScope } from '@/lib/ai/conversation/memory-store';
import { loadBriefPackage, type BriefLoadDeps } from './load';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NOW = new Date('2026-09-13T12:00:00.000Z');
const spaceCtx = {
  userId: 'owner_A', spaceId: 'space_shared', role: 'MEMBER',
  permissions: {}, space: { id: 'space_shared', name: 'Household', type: 'SHARED', category: 'FAMILY',
    isPublic: false, reportingCurrency: 'USD' },
} as unknown as SpaceContext;

function recorder(over: Partial<BriefLoadDeps> = {}) {
  const log = {
    assembled: [] as { domain: string; spaceId: string; options: AssemblerOptions }[],
    recallScopes: [] as MemoryScope[],
    projectedRows: [] as string[],
    recentAsOf: [] as { spaceId: string; asOf: string }[],
  };
  const rows = ['2026-09-01', '2026-09-05', '2026-09-12', '2026-09-13'].map((date) => ({ date }) as Snapshot);
  const deps: BriefLoadDeps = {
    assemble: async (domain, ctx, options) => {
      log.assembled.push({ domain, spaceId: ctx.spaceId, options });
      return null;
    },
    readSnapshots: async () => rows,
    projectSnapshots: (r) => { log.projectedRows.push(...r.map((x) => x.date)); return null as SnapshotSectionData | null; },
    recall: async (scope) => { log.recallScopes.push(scope); return []; },
    recentActivity: async (spaceId, asOf) => {
      log.recentAsOf.push({ spaceId, asOf });
      return { from: asOf, to: asOf, days: 7, complete: true, transactionsInWindow: 0, top: [] };
    },
    assess: () => ({}) as FinancialAssessment,
    ...over,
  };
  return { log, deps };
}

async function main() {
  console.log('1. the named Space, and its owner\'s memory only');
  {
    const { log, deps } = recorder();
    const r = await loadBriefPackage({ spaceCtx, now: NOW, deps });
    check('every authority is asked about the named Space', log.assembled.every((a) => a.spaceId === 'space_shared')
      && log.recentAsOf.every((x) => x.spaceId === 'space_shared'));
    check('memory is scoped to (Space, resolved owner) together',
      JSON.stringify(log.recallScopes) === JSON.stringify([{ spaceId: 'space_shared', ownerUserId: 'owner_A' }]));
    check('accounts, transactions and holdings are all read for a current package',
      ['accounts', 'transactions_summary', 'holdings_summary'].every((d) => log.assembled.some((a) => a.domain === d)));
    check('the package is CURRENT at today', r.package.identity.basis === 'CURRENT' && r.package.identity.asOf === '2026-09-13');
    const other = recorder();
    await loadBriefPackage({ spaceCtx: { ...spaceCtx, userId: 'owner_B' } as SpaceContext, now: NOW, deps: other.deps });
    check('the same Space for another member reads that member\'s memory',
      other.log.recallScopes[0]?.ownerUserId === 'owner_B' && other.log.recallScopes[0]?.spaceId === 'space_shared');
  }

  console.log('\n2. the ceiling reaches every dated read');
  {
    const { log, deps } = recorder();
    const r = await loadBriefPackage({ spaceCtx, asOf: '2026-09-05', now: NOW, deps });
    check('the snapshot series is cut at asOf before projection',
      log.projectedRows.join() === '2026-09-01,2026-09-05', log.projectedRows.join());
    const txn = log.assembled.find((a) => a.domain === 'transactions_summary');
    check('the transaction window ends at asOf', txn?.options.transactionWindow?.endDate === '2026-09-05');
    check('…and spans the 90-day assessment window', txn?.options.transactionWindow?.startDate === '2026-06-07');
    check('live-only holdings are not read for a retrospective package',
      !log.assembled.some((a) => a.domain === 'holdings_summary'));
    check('recent activity is asked for the ceiling', log.recentAsOf[0]?.asOf === '2026-09-05');
    check('the package says RETROSPECTIVE', r.package.identity.basis === 'RETROSPECTIVE');

    const future = recorder();
    const f = await loadBriefPackage({ spaceCtx, asOf: '2027-01-01', now: NOW, deps: future.deps });
    check('a future ceiling is today', f.package.identity.asOf === '2026-09-13' && future.log.recentAsOf[0]?.asOf === '2026-09-13');
    const current = recorder();
    await loadBriefPackage({ spaceCtx, now: NOW, deps: current.deps });
    check('today keeps the default assessment window (no explicit bounds)',
      !current.log.assembled.find((a) => a.domain === 'transactions_summary')?.options.transactionWindow);
  }

  console.log('\n3. a failed read degrades, it does not fail');
  {
    const { deps } = recorder({
      assemble: async (domain) => { if (domain === 'holdings_summary') throw new Error('boom'); return null; },
      recall: async () => { throw new Error('memory down'); },
    });
    const origError = console.error;
    console.error = () => {};
    const r = await loadBriefPackage({ spaceCtx, now: NOW, deps });
    console.error = origError;
    check('the failures are named', r.degraded.includes('holdings') && r.degraded.includes('memory'));
    check('the package still exists', r.package.identity.asOf === '2026-09-13' && !r.package.plans);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
