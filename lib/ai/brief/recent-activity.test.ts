/**
 * lib/ai/brief/recent-activity.test.ts
 *
 * Five rows, seven days, nothing that identifies an account.
 *
 *   npx tsx lib/ai/brief/recent-activity.test.ts
 */

import type { Transaction } from '@/types';
import {
  loadRecentActivity, projectRecentActivity, recentActivityWindow, safeMerchant,
  RECENT_ACTIVITY_ROWS,
} from './recent-activity';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

let n = 0;
const tx = (date: string, amount: number, over: Partial<Transaction> = {}): Transaction => ({
  id: `tx_${String(++n).padStart(3, '0')}`, accountId: 'fa_secret_account', date, amount,
  merchant: 'RAW DESCRIPTOR', category: 'Shopping' as Transaction['category'], pending: false,
  description: 'ONLINE TRANSFER REF 99887766 ACCT 1234', merchantLogoUrl: 'https://logo', ...over,
} as Transaction);

async function main() {
  console.log('1. the window');
  {
    const w = recentActivityWindow('2026-09-13');
    check('seven UTC days ending on asOf, inclusive', w.from === '2026-09-07' && w.to === '2026-09-13');
  }

  console.log('\n2. the ranking');
  const rows = [
    tx('2026-09-06', -9000, { merchantDisplayName: 'Before the window' }),
    tx('2026-09-14', 9000, { merchantDisplayName: 'After the ceiling' }),
    tx('2026-09-08', -50, { merchantDisplayName: 'Small' }),
    tx('2026-09-10', 4812.66, { merchantDisplayName: 'Acme Payroll', flowType: 'INCOME' as Transaction['flowType'] }),
    tx('2026-09-12', -3210.55, { merchantDisplayName: undefined, merchant: 'CHASE CREDIT CRD AUTOPAY 1234567890',
      flowType: 'DEBT_PAYMENT' as Transaction['flowType'], counterpartyAccountId: 'fa_card' } as Partial<Transaction>),
    tx('2026-09-12', 3210.55, { merchantDisplayName: 'Payment Thank You',
      flowType: 'DEBT_PAYMENT' as Transaction['flowType'], counterpartyAccountId: 'fa_checking' } as Partial<Transaction>),
    tx('2026-09-11', -120, { merchantDisplayName: 'Pending Store', pending: true }),
    tx('2026-09-09', -80, { merchantDisplayName: 'Mid' }),
    tx('2026-09-13', -75.254, { merchantDisplayName: 'Rounded' }),
  ];
  const a = projectRecentActivity(rows, recentActivityWindow('2026-09-13'), true);
  check('rows outside the window are excluded, including after the ceiling',
    !JSON.stringify(a).includes('Before the window') && !JSON.stringify(a).includes('After the ceiling'));
  check('the count is of the window', a.transactionsInWindow === 7, String(a.transactionsInWindow));
  check(`at most ${RECENT_ACTIVITY_ROWS} rows`, a.top.length === RECENT_ACTIVITY_ROWS);
  check('ranked by size, legs of equal size ordered deterministically',
    a.top.map((r) => Math.abs(r.amount)).join() === '4812.66,3210.55,3210.55,120,80',
    a.top.map((r) => r.amount).join());
  const again = projectRecentActivity([...rows].reverse(), recentActivityWindow('2026-09-13'), true);
  check('input order does not change the output', JSON.stringify(again) === JSON.stringify(a));
  check('both legs are flagged, never merged',
    a.top.filter((r) => r.betweenOwnAccounts).length === 2);
  check('pending is carried as a flag', a.top.some((r) => r.pending === true));
  check('an unclassified row says so', a.top.find((r) => r.amount === -120)?.flow === 'UNCLASSIFIED');
  check('amounts are rounded to the cent', projectRecentActivity(rows, recentActivityWindow('2026-09-13'), true)
    .top.every((r) => Math.round(r.amount * 100) / 100 === r.amount));

  console.log('\n3. nothing that identifies an account');
  {
    const json = JSON.stringify(a);
    check('no transaction or account id', !/tx_\d|fa_/.test(json));
    check('no description, logo or raw reference numbers', !/REF|ACCT|99887766|logo|description/i.test(json));
    check('no run of four or more digits survives in a merchant', !a.top.some((r) => /\d{4,}/.test(r.merchant ?? '')));
    check('keys are the allowlist only', a.top.every((r) => Object.keys(r).every((k) =>
      ['date', 'amount', 'flow', 'merchant', 'category', 'pending', 'betweenOwnAccounts', 'account'].includes(k))));
    check('safeMerchant strips digit runs and symbols', safeMerchant('AMZN Mktp US*2K4 #1234567') === 'AMZN Mktp US 2K4');
    check('safeMerchant drops an all-digit name', safeMerchant('123456789') === undefined);
  }

  console.log('\n4. the read respects the ceiling');
  {
    let seen: { spaceId: string; query: Record<string, unknown> } | null = null;
    const r = await loadRecentActivity('space_S', '2026-09-01', async (spaceId, query) => {
      seen = { spaceId, query };
      return { rows: [tx('2026-08-30', -10)], complete: false };
    });
    const q = (seen as unknown as { spaceId: string; query: Record<string, unknown> });
    check('the Space is the one named', q.spaceId === 'space_S');
    check('dateTo is asOf and dateFrom six days earlier', q.query.dateTo === '2026-09-01' && q.query.dateFrom === '2026-08-26');
    check('an incomplete read is reported, not absorbed', r.complete === false);
  }

  console.log('\n5. the CLASS of account a row posted on — never the account');
  {
    const types: Record<string, string> = { fa_card: 'debt', fa_checking: 'checking', fa_savings: 'savings', fa_broker: 'investment', fa_wallet: 'crypto' };
    const lookup = (id: string) => types[id];
    const w = recentActivityWindow('2026-09-13');
    const classed = projectRecentActivity([
      tx('2026-09-12', -1275.40, { accountId: 'fa_card', merchantDisplayName: 'Hotel', category: 'Travel' as Transaction['category'] }),
      tx('2026-09-12', -900, { accountId: 'fa_checking', merchantDisplayName: 'Rent' }),
      tx('2026-09-11', 800, { accountId: 'fa_savings', merchantDisplayName: 'Interest' }),
      tx('2026-09-10', -700, { accountId: 'fa_broker', merchantDisplayName: 'Buy' }),
      tx('2026-09-09', -600, { accountId: 'fa_unknown_to_viewer', merchantDisplayName: 'Mystery' }),
    ], w, true, lookup);
    const by = (m: string) => classed.top.find((r) => r.merchant === m);
    check('a purchase on a card is on a LIABILITY account', by('Hotel')?.account === 'LIABILITY');
    check('checking and savings are LIQUID', by('Rent')?.account === 'LIQUID' && by('Interest')?.account === 'LIQUID');
    check('a brokerage row is ASSET', by('Buy')?.account === 'ASSET');
    check('an account the lookup does not know carries NO class — no connection is established, none is guessed',
      by('Mystery') !== undefined && !('account' in by('Mystery')!));
    check('the class is decided by the account, never by merchant, category or flow',
      projectRecentActivity([tx('2026-09-12', -1275.40, { accountId: 'fa_checking', merchantDisplayName: 'Hotel', category: 'Travel' as Transaction['category'] })],
        w, true, lookup).top[0].account === 'LIQUID');
    check('the id used for the lookup is still never emitted', !/fa_/.test(JSON.stringify(classed)));
    check('without a lookup no row carries a class (retrospective and legacy callers unchanged)',
      projectRecentActivity(rows, w, true).top.every((r) => !('account' in r)));
    let passed: unknown;
    await loadRecentActivity('space_S', '2026-09-13', async () => ({ rows: [tx('2026-09-12', -5, { accountId: 'fa_card' })], complete: true }), lookup)
      .then((r) => { passed = r.top[0].account; });
    check('the loader hands the lookup through to the projection', passed === 'LIABILITY');
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
