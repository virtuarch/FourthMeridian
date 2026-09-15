/**
 * lib/crypto/wallet-refresh.test.ts
 *
 * ONE SCHEDULED PIPELINE FOR EVERY WALLET — selection, isolation, budget,
 * admission, and the same sync call the manual route makes.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/wallet-refresh.test.ts
 */

import { readFileSync } from 'node:fs';
import { resolveRefreshPolicy } from '@/lib/platform/refresh-policy.core';
import { refreshScheduledWallets, type ScheduledWalletCandidate, type WalletRefreshDeps } from './wallet-refresh';
import { SYNCABLE_CHAINS, type WalletSyncOutcome } from './wallet-sync-dispatch';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NOW = new Date('2026-09-13T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const wallet = (accountId: string, chain: string, lastSuccessAt: Date | null): ScheduledWalletCandidate => ({ accountId, chain, lastSuccessAt });
const ok = (accountId: string, chain: string): WalletSyncOutcome =>
  ({ accountId, chain, support: 'HISTORY_SUPPORTED', ok: true, syncStatus: 'synced', netWorthParticipation: 'NONE' });
const fail = (accountId: string, chain: string, errorCode: WalletSyncOutcome['errorCode']): WalletSyncOutcome =>
  ({ accountId, chain, support: 'HISTORY_SUPPORTED', ok: false, stage: 'balance', errorCode, netWorthParticipation: 'NONE' });

function harness(wallets: ScheduledWalletCandidate[], over: Partial<WalletRefreshDeps> & { stepMs?: number } = {}) {
  let t = NOW.getTime();
  const calls: string[] = [];
  const deps: WalletRefreshDeps = {
    listWallets: async () => wallets,
    sync: over.sync ?? (async (id, chain) => { t += over.stepMs ?? 1_000; calls.push(`${chain}:${id}`); return ok(id, chain); }),
    policy: over.policy ?? (async () => resolveRefreshPolicy({ sourceKind: 'WALLET' }, null)),
    admit: over.admit ?? (async () => ({ decision: 'ADMIT' as const })),
    clock: () => t,
  };
  const run = (budgetMs?: number) => refreshScheduledWallets({ now: NOW, budgetMs, deps });
  return { run, calls, advance: (ms: number) => { t += ms; } };
}

async function main() {
  console.log('A–D. selection: every chain, oldest first, only what is due');
  {
    const h = harness([
      wallet('btc', 'BTC', hoursAgo(7)), wallet('eth', 'ETH', hoursAgo(26)), wallet('sol', 'SOL', null),
      wallet('btc-fresh', 'BTC', hoursAgo(0.5)),
    ]);
    const r = await h.run();
    check('A. a BTC wallet is refreshed', h.calls.includes('BTC:btc'));
    check('B. an ETH wallet is refreshed', h.calls.includes('ETH:eth'));
    check('C. a SOL wallet is refreshed', h.calls.includes('SOL:sol'));
    check('D. never-synced first, then oldest success', h.calls.join() === 'SOL:sol,ETH:eth,BTC:btc', h.calls.join());
    check('D. a wallet refreshed 30 minutes ago is not due (the continuation slot skips it)',
      !h.calls.includes('BTC:btc-fresh') && r.notDue === 1 && r.total === 4);
    check('per-chain tallies and durations are reported', r.byChain.BTC?.succeeded === 1 && r.byChain.ETH?.durationMs === 1_000
      && r.byChain.SOL?.attempted === 1 && r.attempted === 3 && r.succeeded === 3);
    check('the policy that judged due-ness is in the summary', r.policy.cadence === '6h' && r.policy.overdueAfterHours === 8);
  }

  console.log('\nE–G, J. one failure never blocks another; only successes count as synced');
  {
    const h = harness([wallet('btc', 'BTC', hoursAgo(9)), wallet('eth', 'ETH', hoursAgo(8)), wallet('sol', 'SOL', hoursAgo(7))], {
      sync: async (id, chain) => chain === 'ETH' ? fail(id, chain, 'BALANCE_UNAVAILABLE') : ok(id, chain),
    });
    const r = await h.run();
    check('E. BTC and SOL still sync after ETH fails', r.succeeded === 2 && r.failed === 1 && r.byChain.SOL?.succeeded === 1);
    check('F/G. the synced set holds the successes only (the input to regeneration)',
      r.syncedAccountIds.join() === 'btc,sol');
    check('J. a rate-limit / provider failure is counted by its generic code, with no provider text',
      r.failureStages.BALANCE_UNAVAILABLE === 1 && !JSON.stringify(r).includes('429'));
    const thrower = harness([wallet('a', 'ETH', null), wallet('b', 'SOL', null)], {
      sync: async (id, chain) => { if (chain === 'ETH') throw new Error('contract violation'); return ok(id, chain); },
    });
    const t = await thrower.run();
    check('a sync that throws despite its contract is a counted failure, and the sweep continues', t.failed === 1 && t.succeeded === 1);
  }

  console.log('\nI. unsupported chains');
  {
    const src = readFileSync('lib/crypto/wallet-refresh.ts', 'utf8');
    check('I. the default selection reads the sync registry, so an unreadable chain is never scheduled',
      /walletChain: \{ in: \[\.\.\.SYNCABLE_CHAINS\] \}/.test(src));
    check('I. …and that registry holds BTC, ETH and SOL', ['BTC', 'ETH', 'SOL'].every((c) => SYNCABLE_CHAINS.includes(c)));
    const h = harness([wallet('ada', 'ADA', null)], {
      sync: async (id) => ({ accountId: id, chain: 'ADA', support: 'UNSUPPORTED', ok: false, stage: 'unsupported-chain',
        errorCode: 'CHAIN_UNSUPPORTED', netWorthParticipation: 'NONE' }),
    });
    const r = await h.run();
    check('I. an unsupported chain reaching the sync is a counted refusal, not a success', r.failed === 1 && r.failureStages.CHAIN_UNSUPPORTED === 1);
  }

  console.log('\nK/L. admission and the work budget');
  {
    let synced = 0;
    const paused = harness([wallet('btc', 'BTC', null)], {
      admit: async () => ({ decision: 'DENY', reason: 'INGESTION_PAUSED' }),
      sync: async (id, chain) => { synced++; return ok(id, chain); },
    });
    const p = await paused.run();
    check('an ingestion pause stops the sweep before any provider call', synced === 0 && p.notAdmitted === 'INGESTION_PAUSED' && p.deferred === 1);

    const nothingDue = harness([wallet('btc', 'BTC', hoursAgo(1))], { admit: async () => { throw new Error('must not be asked'); } });
    check('K. nothing due ⇒ no admission read, no sync (a cheap continuation run)', (await nothingDue.run()).attempted === 0);

    const slow = harness([wallet('a', 'ETH', null), wallet('b', 'BTC', hoursAgo(30)), wallet('c', 'SOL', hoursAgo(20))], { stepMs: 60_000 });
    const s = await slow.run(100_000);
    check('L. no wallet starts after the budget; the rest are deferred to the continuation slot',
      s.attempted === 2 && s.deferred === 1 && slow.calls.join() === 'ETH:a,BTC:b');
    check('L. the slowest wallet is measured', s.slowestWalletMs === 60_000 && s.elapsedMs === 120_000);

    const twelve = harness([wallet('a', 'BTC', hoursAgo(6)), wallet('b', 'BTC', hoursAgo(12))], {
      policy: async () => resolveRefreshPolicy({ sourceKind: 'WALLET' }, { value: '12h', updatedAt: NOW }),
    });
    const tw = await twelve.run();
    check('a 12h policy is honoured: refreshed one slot ago is skipped, two slots ago is attempted', tw.attempted === 1 && tw.notDue === 1);
  }

  console.log('\nFAIRNESS. a recently failing wallet cannot monopolise the sweep');
  {
    const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const w = (id: string, success: Date | null, failure: Date | null = null): ScheduledWalletCandidate =>
      ({ accountId: id, chain: 'ETH', lastSuccessAt: success, lastFailureAt: failure });

    const a = harness([w('A-failed', hoursAgo(30), minsAgo(10)), w('B-untried', hoursAgo(20))], { stepMs: 60_000 });
    const ra = await a.run(30_000);
    check('A. an old wallet that failed 10 minutes ago yields to an old wallet not yet attempted',
      a.calls[0] === 'ETH:B-untried' && ra.deprioritizedRecentFailures === 1, a.calls.join());

    const b = harness([w('A-deferred', hoursAgo(10)), w('B-newer', hoursAgo(7))], { stepMs: 60_000 });
    await b.run(30_000);
    check('B. a wallet deferred only by the budget (no failure) keeps its urgency', b.calls.join() === 'ETH:A-deferred');

    const c = harness([w('A-failed-earlier', hoursAgo(30), hoursAgo(4)), w('B', hoursAgo(7))], { stepMs: 60_000 });
    await c.run(30_000);
    check('C. once the failure window passes (3h at a 6h policy) the failed wallet leads again by age',
      c.calls.join() === 'ETH:A-failed-earlier');

    const failing = { accountId: 'X', chain: 'ETH', lastSuccessAt: hoursAgo(30), lastFailureAt: null as Date | null };
    const d = harness([failing], { sync: async (id, chain) => fail(id, chain, 'BALANCE_UNAVAILABLE') });
    const rd = await d.run();
    check('D. a failure never advances the success clock or counts as synced',
      failing.lastSuccessAt.getTime() === hoursAgo(30).getTime() && rd.syncedAccountIds.length === 0 && rd.failed === 1);

    const e = harness([w('c', hoursAgo(30), minsAgo(5)), w('a', hoursAgo(40), minsAgo(20)), w('b', hoursAgo(10), minsAgo(20))], { stepMs: 60_000 });
    const re = await e.run(90_000);
    check('E. an all-failing population is ordered deterministically (oldest failure, then id) and stays bounded',
      e.calls.join() === 'ETH:a,ETH:b' && re.deferred === 1, e.calls.join());

    const x = { accountId: 'X', chain: 'ETH', lastSuccessAt: hoursAgo(30), lastFailureAt: null as Date | null };
    const y = { accountId: 'Y', chain: 'ETH', lastSuccessAt: hoursAgo(20), lastFailureAt: null as Date | null };
    const f = harness([x, y], { stepMs: 60_000, sync: async (id, chain) => (id === 'X' ? fail(id, chain, 'BALANCE_UNAVAILABLE') : ok(id, chain)) });
    await f.run(30_000);                         // :00 — X (oldest) is attempted and fails; Y is deferred
    x.lastFailureAt = NOW;                       // the incident the failure recorded
    let contClock = 0;
    const cont = await refreshScheduledWallets({ now: new Date(NOW.getTime() + 30 * 60_000), budgetMs: 30_000, deps: {
      listWallets: async () => [x, y], policy: async () => resolveRefreshPolicy({ sourceKind: 'WALLET' }, null),
      admit: async () => ({ decision: 'ADMIT' as const }), clock: () => contClock,
      sync: async (id, chain) => { contClock += 40_000; return ok(id, chain); },
    } });
    check('F. at the :30 continuation the untouched wallet goes first, not the one that just failed at :00',
      cont.syncedAccountIds[0] === 'Y' && cont.deprioritizedRecentFailures === 1, JSON.stringify(cont.syncedAccountIds));
  }

  console.log('\nH. scheduled and manual take the same sync');
  {
    const refresh = readFileSync('lib/crypto/wallet-refresh.ts', 'utf8');
    const manual = readFileSync('app/api/accounts/[id]/sync/route.ts', 'utf8');
    const job = readFileSync('jobs/sync-crypto.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    check('H. the scheduled sweep calls syncWalletByChain', /sync: \(accountId, chain\) => syncWalletByChain\(accountId, chain(, \{ trigger: walletRefreshTrigger\(\) \})?\)/.test(refresh));
    check('H. …the manual route calls syncWalletByChain', /syncWalletByChain\(id, account\.walletChain(, \{ trigger: "MANUAL" \})?\)/.test(manual));
    check('H. the job runs the unified sweep and no chain-specific batch', /refreshScheduledWallets\(/.test(job)
      && !/syncAllBtcWallets|syncAllSolWallets|syncAllEthWallets|syncBtcWallet\(/.test(job));
    check('H. the job regenerates what the manual route regenerates, for synced wallets only',
      /regenerateSnapshotsForAccounts\(result\.syncedAccountIds\)/.test(job) && /chainSupportsHistory/.test(job));
    check('the sweep writes no clock or financial row of its own', !/\.(update|create|upsert|delete)\w*\(/.test(refresh));
    const registry = readFileSync('lib/jobs/registry.ts', 'utf8');
    check('the continuation slot runs the same job body', /syncCrypto\(\{ continuation: true \}\)/.test(registry));
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
