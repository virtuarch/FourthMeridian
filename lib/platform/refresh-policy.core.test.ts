/**
 * lib/platform/refresh-policy.core.test.ts
 *
 * EXPECTED CADENCE AS POLICY — defaults, parsing, grace, version, scheduler honesty.
 *
 *   npx tsx lib/platform/refresh-policy.core.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_REFRESH_CADENCE, REFRESH_CADENCES, REFRESH_CADENCE_SETTING_KEY, SCHEDULER_FLOOR_HOURS,
  isDueForScheduledRefresh, isOverdue, parseRefreshCadence, resolveRefreshPolicy, schedulerCanHonour,
  type RefreshPolicyRequest,
} from './refresh-policy.core';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NOW = new Date('2026-09-13T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const row = (value: string, at = '2026-09-13T10:00:00.000Z') => ({ value, updatedAt: new Date(at) });

console.log('A/B. defaults');
{
  const bank = resolveRefreshPolicy({ sourceKind: 'BANK' }, null);
  const wallet = resolveRefreshPolicy({ sourceKind: 'WALLET' }, null);
  check('A. BANK defaults to 24h, overdue after 30h', bank.cadence === '24h' && bank.expectedEveryHours === 24
    && bank.graceHours === 6 && bank.overdueAfterHours === 30 && bank.origin === 'DEFAULT');
  check('B. WALLET defaults to 6h, overdue after 8h', wallet.cadence === '6h' && wallet.overdueAfterHours === 8 && wallet.origin === 'DEFAULT');
  check('the defaults are the product contract', DEFAULT_REFRESH_CADENCE.BANK === '24h' && DEFAULT_REFRESH_CADENCE.WALLET === '6h');
  check('setting keys are stable', REFRESH_CADENCE_SETTING_KEY.BANK === 'refresh_cadence_bank' && REFRESH_CADENCE_SETTING_KEY.WALLET === 'refresh_cadence_wallet');
}

console.log('\nC/D. parsing');
{
  check('C. every allowed value parses', REFRESH_CADENCES.every((c) => parseRefreshCadence(c) === c)
    && parseRefreshCadence(' 12H ') === '12h');
  check('C. a setting row is used', resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('12h')).cadence === '12h'
    && resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('12h')).origin === 'SETTING');
  const bad = resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('every 5 minutes'));
  check('D. an unreadable row falls back to the default and says so', bad.cadence === '6h' && bad.origin === 'INVALID_SETTING');
  check('D. no cron strings, no arbitrary hours', parseRefreshCadence('0 */6 * * *') === null && parseRefreshCadence('5h') === null
    && parseRefreshCadence(6) === null);
}

console.log('\nE. grace = max(2h, 25%)');
{
  const expect: Record<string, number> = { '4h': 6, '6h': 8, '8h': 10, '12h': 15, '24h': 30 };
  for (const [c, overdue] of Object.entries(expect)) {
    const p = resolveRefreshPolicy({ sourceKind: 'WALLET' }, row(c));
    check(`${c} → overdue after ${overdue}h`, p.overdueAfterHours === overdue, String(p.overdueAfterHours));
  }
  const wallet = resolveRefreshPolicy({ sourceKind: 'WALLET' }, null);
  check('5h old under 6h → not overdue', !isOverdue(hoursAgo(5), wallet, NOW));
  check('7h old → inside grace, not overdue', !isOverdue(hoursAgo(7), wallet, NOW));
  check('8.5h old → overdue', isOverdue(hoursAgo(8.5), wallet, NOW));
  check('no success clock is not "overdue" (NEVER_UPDATED says that)', !isOverdue(null, wallet, NOW));
}

console.log('\nF/G. version and environment');
{
  const a = resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('6h', '2026-09-13T10:00:00.000Z'));
  const b = resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('12h', '2026-09-13T11:00:00.000Z'));
  const aAgain = resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('6h', '2026-09-13T10:00:00.000Z'));
  check('F. the version moves when the setting changes', a.version !== b.version);
  check('F. …and is stable when it does not', a.version === aAgain.version);
  check('F. an explicit row equal to the default is still distinguishable from no row',
    a.version !== resolveRefreshPolicy({ sourceKind: 'WALLET' }, null).version);
  const loader = readFileSync('lib/platform/refresh-policy.ts', 'utf8');
  check('G. read from the environment\'s own database (PlatformSetting), not a process env var',
    /platformSetting\.findMany/.test(loader) && !/process\.env/.test(loader + readFileSync('lib/platform/refresh-policy.core.ts', 'utf8')));
}

console.log('\nscheduler honesty');
{
  check('wallets: 6h and slower are honoured, 4h is not', schedulerCanHonour('WALLET', '6h') && schedulerCanHonour('WALLET', '24h')
    && !schedulerCanHonour('WALLET', '4h'));
  check('banks: only 24h is attempted today', schedulerCanHonour('BANK', '24h') && !schedulerCanHonour('BANK', '12h'));
  check('floors match the registry: banks daily, wallets 6-hourly', SCHEDULER_FLOOR_HOURS.BANK === 24 && SCHEDULER_FLOOR_HOURS.WALLET === 6);
  const wallet = resolveRefreshPolicy({ sourceKind: 'WALLET' }, null);
  check('a wallet refreshed 30 min ago is not due (the :30 continuation skips it)', !isDueForScheduledRefresh(hoursAgo(0.5), wallet, NOW));
  check('…one refreshed at the previous 6-hourly slot is due', isDueForScheduledRefresh(hoursAgo(5.9), wallet, NOW));
  check('…a never-synced wallet is due', isDueForScheduledRefresh(null, wallet, NOW));
  const twelve = resolveRefreshPolicy({ sourceKind: 'WALLET' }, row('12h'));
  check('at 12h a wallet refreshed one slot ago is skipped, two slots ago attempted',
    !isDueForScheduledRefresh(hoursAgo(6), twelve, NOW) && isDueForScheduledRefresh(hoursAgo(12), twelve, NOW));
}

console.log('\nH. the tier seam is closed and typed');
{
  // @ts-expect-error — no tier value is accepted until a tier rule exists here.
  const withTier: RefreshPolicyRequest = { sourceKind: 'BANK', tier: 'PAID' };
  check('H. a tier cannot be passed today (compile-time)', !!withTier);
  const health = readFileSync('lib/connections/space-data-health.core.ts', 'utf8');
  check('H. source health receives a resolved policy, never a setting or a tier',
    /policy\?: Pick<RefreshPolicy, "overdueAfterHours">/.test(health) && !/tier|platformSetting|refresh_cadence/.test(health));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
