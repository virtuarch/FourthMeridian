/**
 * lib/connections/space-data-health.core.test.ts
 *
 * THE SECOND CLOCK — when each source behind a Space last delivered, what state it
 * is in, and that no summary hides a child.
 *
 *   npx tsx lib/connections/space-data-health.core.test.ts
 */

import {
  deriveSpaceDataHealth, staleSourcesForBrief, type DataHealthAccountInput,
} from './space-data-health.core';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NOW = new Date('2026-09-13T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const VIEWER = 'user_viewer';

const bank = (over: Partial<NonNullable<DataHealthAccountInput['plaid']>> = {}, acct: Partial<DataHealthAccountInput> = {}): DataHealthAccountInput => ({
  detailVisible: true, accountName: 'Checking 1234', lastUpdated: daysAgo(0.2), syncStatus: 'synced',
  plaid: { key: 'item_SECRET_1', ownerUserId: VIEWER, institutionName: 'Chase', status: 'ACTIVE',
    lastSyncedAt: daysAgo(0.2), syncIncompleteAt: null, historyBuildStartedAt: null, ...over },
  wallet: null, ...acct,
});
const wallet = (over: Partial<NonNullable<DataHealthAccountInput['wallet']>> = {}, acct: Partial<DataHealthAccountInput> = {}): DataHealthAccountInput => ({
  detailVisible: true, accountName: 'Cold storage', lastUpdated: daysAgo(0.1), syncStatus: 'synced', plaid: null,
  wallet: { key: 'conn_SECRET_W', ownerUserId: VIEWER, status: 'ACTIVE', errorCode: null, lastSyncedAt: daysAgo(0.1), discoveryCursor: false, ...over },
  ...acct,
});
const manual = (age: number, name = 'House'): DataHealthAccountInput => ({
  detailVisible: true, accountName: name, lastUpdated: daysAgo(age), syncStatus: 'manual', plaid: null, wallet: null,
});
const derive = (rows: DataHealthAccountInput[]) => deriveSpaceDataHealth(rows, VIEWER, NOW);

console.log('A. everything current');
{
  const h = derive([bank(), bank({ key: 'item_SECRET_2', institutionName: 'Amex' }, { accountName: 'Gold' }), wallet()]);
  check('no attention, two bank sources and one wallet', h.attention === 0 && h.sources.length === 3
    && h.sources.every((s) => s.state === 'CURRENT'));
  check('groups by provider kind', JSON.stringify(h.groups.map((g) => [g.kind, g.sources, g.attention])) === '[["BANK",2,0],["WALLET",1,0]]');
}

console.log('\nB. a provider summary never hides a degraded child');
{
  const h = derive([bank(), bank({ key: 'item_SECRET_2', institutionName: 'Chase Business', lastSyncedAt: daysAgo(12) }, { lastUpdated: daysAgo(12) })]);
  const g = h.groups[0];
  check('one of two banks out of date → the BANK group reports 1 needing attention', g.attention === 1 && g.sources === 2);
  check('…and its date is the OLDEST child, not the freshest', g.oldestUpdatedAt === daysAgo(12).toISOString());
  check('the stale source is named, dated and first', h.sources[0].label === 'Chase Business' && h.sources[0].state === 'OUT_OF_DATE'
    && h.sources[0].lastUpdatedAt === daysAgo(12).toISOString());
}

console.log('\nC. one source, several accounts — the oldest account wins');
{
  const h = derive([bank({}, { lastUpdated: daysAgo(0.1) }), bank({ lastSyncedAt: daysAgo(0.1) }, { accountName: 'Savings', lastUpdated: daysAgo(9) })]);
  check('two accounts on one item are one source with accountCount 2', h.sources.length === 1 && h.sources[0].accountCount === 2);
  check('one account nine days behind makes the source out of date', h.sources[0].state === 'OUT_OF_DATE'
    && h.sources[0].lastUpdatedAt === daysAgo(9).toISOString());
  const txLag = derive([bank({ lastSyncedAt: daysAgo(8) }, { lastUpdated: daysAgo(0.1) })]);
  check('fresh balances but transactions last completed 8 days ago → out of date since then',
    txLag.sources[0].state === 'OUT_OF_DATE' && txLag.sources[0].lastUpdatedAt === daysAgo(8).toISOString());
}

console.log('\nD. needs reconnect — the provider\'s verdict, and who can act');
{
  const mine = derive([bank({ status: 'NEEDS_REAUTH', lastSyncedAt: daysAgo(26) }, { lastUpdated: daysAgo(26) })]).sources[0];
  check('NEEDS_REAUTH → NEEDS_RECONNECT, needs attention, dated', mine.state === 'NEEDS_RECONNECT' && mine.needsAttention
    && mine.lastUpdatedAt === daysAgo(26).toISOString());
  check('…actionable by the viewer who connected it', mine.actionable === true);
  const theirs = derive([bank({ status: 'NEEDS_REAUTH', ownerUserId: 'someone_else' })]).sources[0];
  check('…not actionable for a member who did not', theirs.needsAttention && theirs.actionable === false);
  const err = derive([bank({ status: 'ERROR' })]).sources[0];
  check('ERROR → CONNECTION_ERROR even with a fresh clock', err.state === 'CONNECTION_ERROR' && err.needsAttention);
  const revoked = derive([bank({ status: 'REVOKED' })]).sources[0];
  check('REVOKED → DISCONNECTED', revoked.state === 'DISCONNECTED' && revoked.needsAttention);
}

console.log('\nE. importing is not broken — until it ages');
{
  const first = derive([bank({ lastSyncedAt: null, syncIncompleteAt: daysAgo(0.01) }, { lastUpdated: daysAgo(0.01) })]).sources[0];
  check('a first import in progress → IMPORTING, no attention', first.state === 'IMPORTING' && !first.needsAttention);
  const stalled = derive([bank({ lastSyncedAt: daysAgo(15), syncIncompleteAt: daysAgo(15) }, { lastUpdated: daysAgo(15) })]).sources[0];
  check('an import stalled for 15 days → OUT_OF_DATE', stalled.state === 'OUT_OF_DATE' && stalled.needsAttention);
}

console.log('\nF. wallets');
{
  const failed = derive([wallet({ errorCode: 'BALANCE_UNAVAILABLE', lastSyncedAt: daysAgo(3) }, { lastUpdated: daysAgo(3) })]).sources[0];
  check('an errorCode without a status flip → SYNC_INCOMPLETE, still dated', failed.state === 'SYNC_INCOMPLETE'
    && failed.lastUpdatedAt === daysAgo(3).toISOString());
  check('wallet NEEDS_REAUTH is an error, never a Plaid reconnect', derive([wallet({ status: 'NEEDS_REAUTH' })]).sources[0].state === 'CONNECTION_ERROR');
  check('resumable discovery with no success yet → IMPORTING',
    derive([wallet({ lastSyncedAt: null, discoveryCursor: true })]).sources[0].state === 'IMPORTING');
  check('a wallet silent for 8 days → OUT_OF_DATE',
    derive([wallet({ lastSyncedAt: daysAgo(8) }, { lastUpdated: daysAgo(8) })]).sources[0].state === 'OUT_OF_DATE');
}

console.log('\nG. names follow the detail grant');
{
  const hidden = derive([bank({}, { detailVisible: false }), wallet({}, { detailVisible: false })]);
  check('a bank the viewer cannot see in detail is "A bank connection"', hidden.sources.some((s) => s.label === 'A bank connection'));
  check('…a wallet is "A crypto wallet"', hidden.sources.some((s) => s.label === 'A crypto wallet'));
  check('…and neither name appears anywhere', !/Chase|Cold storage/.test(JSON.stringify(hidden)));
}

console.log('\nH. manual balances');
{
  check('a manual balance 10 days old is current (entered, not synced)', derive([manual(10)]).sources[0].state === 'CURRENT');
  const old = derive([manual(45), manual(5, 'Car')]).sources[0];
  check('manual accounts form one source dated by the oldest; 45 days → OUT_OF_DATE, not actionable on Connections',
    old.label === 'Manual accounts' && old.state === 'OUT_OF_DATE' && old.actionable === false && old.accountCount === 2);
  check('an account with no connection and no manual status is not reported (no honest clock)',
    derive([{ ...manual(1), syncStatus: 'pending' }]).sources.length === 0);
}

console.log('\nI. nothing internal crosses; the model sees only what the page shows');
{
  const h = derive([bank({ status: 'NEEDS_REAUTH' }), wallet({ errorCode: 'RPC_TIMEOUT_SECRET' }), manual(40)]);
  const json = JSON.stringify(h);
  check('no connection id, owner id or provider error code', !/SECRET|user_viewer|errorCode|ownerUserId|key/.test(json), json.slice(0, 200));
  check('attention first, most severe first', h.sources.map((s) => s.state).join(',') === 'NEEDS_RECONNECT,SYNC_INCOMPLETE,OUT_OF_DATE');
  const forModel = staleSourcesForBrief(h);
  check('stale sources for the Brief: label, state, a day', forModel.length === 3
    && JSON.stringify(Object.keys(forModel[0])) === '["label","state","lastUpdated"]' && /^\d{4}-\d{2}-\d{2}$/.test(forModel[0].lastUpdated!));
  check('…and none when everything is current', staleSourcesForBrief(derive([bank()])).length === 0 && staleSourcesForBrief(null).length === 0);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
