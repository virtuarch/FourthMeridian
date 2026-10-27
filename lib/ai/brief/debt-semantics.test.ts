/**
 * lib/ai/brief/debt-semantics.test.ts   (v2.7-P0)
 *
 * The Daily Brief must NEVER describe a transfer between two owned depository
 * accounts as reducing debt. Package, prompt and acceptance guard, end to end,
 * over the anonymised Production pattern (Chase checking → Amex HYSA / Amex
 * checking / Schwab checking / Chase card / Apple Cash), with the HISTORICAL
 * UNREPAIRED rows (provider DEBT_PAYMENT) as input. No DB, no model.
 *
 *   npx tsx lib/ai/brief/debt-semantics.test.ts
 */

import type { Transaction } from '@/types';
import { projectRecentActivity, recentActivityWindow } from './recent-activity';
import { acceptNarration } from './generate';
import { associatesUnconnectedMovement, describesTransferAsDebtReduction } from './contract';
import { basePackage } from './fixtures';
import { BRIEF_SYSTEM_PROMPT, serializePackage } from './prompt';
import type { BriefObservation, BriefPackage } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TYPES: Record<string, string> = {
  chaseChk: 'checking', schwabChk: 'checking', amexChk: 'checking', amexHysa: 'savings', chaseCard: 'debt',
};
const accountTypeOf = (id: string) => TYPES[id];

let n = 0;
const tx = (accountId: string, amount: number, over: Partial<Transaction>): Transaction => ({
  id: `t${String(++n).padStart(2, '0')}`, accountId, date: '2026-10-24', amount, merchant: 'RAW',
  category: 'Transfer' as Transaction['category'], pending: false, flowAuthority: 'CLASSIFIER', ...over,
} as Transaction);
const DP = 'DEBT_PAYMENT' as Transaction['flowType'];
const TR = 'TRANSFER' as Transaction['flowType'];

// BEFORE the repair — the rows exactly as stored on Production.
const ROWS: Transaction[] = [
  tx('chaseChk', -1500, { flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'SAVINGS_TRANSFER', pending: true, merchantDisplayName: 'AMERICANEXPRESS TRANSFER' }),
  tx('chaseChk', -125.41, { flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'SAVINGS_TRANSFER', counterpartyAccountId: 'amexHysa', date: '2026-10-23' }),
  tx('chaseChk', -747.26, { flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'CASH_TRANSFER', counterpartyAccountId: 'amexChk' }),
  tx('chaseChk', -1499.99, { flowType: TR, transferMaturity: 'CASH_TRANSFER', counterpartyAccountId: 'schwabChk' }),
  tx('chaseChk', -300, { flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'DEBT_PAYMENT', counterpartyAccountId: 'chaseCard', merchantDisplayName: 'Payment to Chase card' }),
  tx('chaseCard', 300, { flowType: DP, category: 'Payment' as Transaction['category'], counterpartyAccountId: 'chaseChk', merchantDisplayName: 'Payment thank you' }),
  tx('chaseChk', -150, { flowType: TR, transferMaturity: 'EXTERNAL_PERSON_TRANSFER', transferDisposition: 'PAYMENT_APP_MOVEMENT' as Transaction['transferDisposition'] }),
];
const WINDOW = recentActivityWindow('2026-10-26');

// The top five by size: 1500, 1499.99, 747.26, 300, 300.
const activity = projectRecentActivity(ROWS, WINDOW, true, accountTypeOf);
const byAmount = (a: number) => activity.top.find((r) => r.amount === a)!;

console.log('1. the package carries the resolved nature, not the stored column');
{
  const hysa = byAmount(-1500), schwab = byAmount(-1499.99), amexChk = byAmount(-747.26);
  for (const [name, r, nature] of [['Chase → Amex HYSA (unrepaired DEBT_PAYMENT)', hysa, 'INTERNAL_SAVINGS_TRANSFER'],
    ['Chase → Schwab checking', schwab, 'INTERNAL_CHECKING_TRANSFER'],
    ['Chase → Amex checking (unrepaired DEBT_PAYMENT)', amexChk, 'INTERNAL_CHECKING_TRANSFER']] as const) {
    check(`${name}: nature ${nature}, flow TRANSFER, category not "Payment", own accounts`,
      r.nature === nature && r.flow === 'TRANSFER' && r.category !== 'Payment' && r.betweenOwnAccounts === true,
      JSON.stringify(r));
  }
  const cash = activity.top.find((r) => r.amount === -300)!, card = activity.top.find((r) => r.amount === 300)!;
  check('Chase card payment: both legs still LIABILITY_PAYMENT / DEBT_PAYMENT',
    cash.nature === 'LIABILITY_PAYMENT' && cash.flow === 'DEBT_PAYMENT' && card.nature === 'LIABILITY_PAYMENT' && card.flow === 'DEBT_PAYMENT');
  check('the savings transfer names its other side LIQUID (never LIABILITY)', hysa.otherLegAccount === 'LIQUID' && hysa.account === 'LIQUID');
  check('no internal transfer reaches the model as DEBT_PAYMENT',
    activity.top.filter((r) => r.nature?.startsWith('INTERNAL')).every((r) => r.flow !== 'DEBT_PAYMENT'));
}

console.log('\n2. ambiguous / external rows say only what is known');
{
  const smaller = projectRecentActivity([
    tx('chaseChk', -900, { flowType: DP, category: 'Payment' as Transaction['category'] }),
    ROWS[6],
  ], WINDOW, true, accountTypeOf);
  const amb = smaller.top.find((r) => r.amount === -900)!;
  const apple = smaller.top.find((r) => r.amount === -150)!;
  check('an unattested provider DEBT_PAYMENT is UNCLASSIFIED_MOVEMENT, never DEBT_PAYMENT', amb.nature === 'UNCLASSIFIED_MOVEMENT' && amb.flow === 'TRANSFER');
  check('the Apple Cash send is EXTERNAL_TRANSFER, not between own accounts', apple.nature === 'EXTERNAL_TRANSFER' && apple.betweenOwnAccounts === undefined);
}

console.log('\n3. the prompt');
{
  check('no sentence says an own-accounts row lowers what is owed',
    !/betweenOwnAccounts, belongs to both sides/.test(BRIEF_SYSTEM_PROMPT) && !/DEBT_PAYMENT is paying down debt/.test(BRIEF_SYSTEM_PROMPT));
  check('internal transfers: "moved between their accounts", never a payment or a debt reduction',
    /say it was moved between their accounts, and never call it a payment, paying down or reducing debt/.test(BRIEF_SYSTEM_PROMPT));
  check('only LIABILITY_PAYMENT lowers what is owed', /Only nature LIABILITY_PAYMENT \(flow DEBT_PAYMENT\) is a payment toward a card or loan: it lowers what is owed/.test(BRIEF_SYSTEM_PROMPT));
  check('an own-accounts transfer never changes what is owed', /A transfer between the user's own accounts never changes what is owed/.test(BRIEF_SYSTEM_PROMPT));
}

// A package holding the fixture activity.
const pkg: BriefPackage = basePackage();
pkg.identity = { ...pkg.identity, briefDay: '2026-10-26', asOf: '2026-10-26' };
pkg.recentActivity = activity;
pkg.recentChanges.w1 = { from: '2026-10-20', to: '2026-10-26',
  netWorth: { abs: -10, pct: 0 }, liquid: { abs: -2300, pct: -10 }, investments: { abs: 0, pct: 0 },
  digitalAssets: { abs: 0, pct: 0 }, debt: { abs: -300, pct: -9.3 } };
const idx = (a: number) => activity.top.findIndex((r) => r.amount === a);
const ob = (over: Partial<BriefObservation>): BriefObservation => ({
  kind: 'DEBT', title: 'Debt', body: 'x', importance: 'NOTABLE', evidence: [], ...over,
});

console.log('\n4. the package serialization the model reads');
{
  const json = serializePackage(pkg);
  check('the serialized package carries nature on every activity row', activity.top.every((r) => typeof r.nature === 'string')
    && json.includes('"nature":"INTERNAL_SAVINGS_TRANSFER"'));
  check('no internal-transfer row is serialized with flow DEBT_PAYMENT',
    !/"flow":"DEBT_PAYMENT"[^}]*"nature":"INTERNAL/.test(json));
}

console.log('\n5. the acceptance guard drops a debt claim resting on an internal transfer');
{
  const paidDown = ob({ title: 'You paid down your card', body: 'You paid $1,500 toward your card this week.',
    evidence: [`recentActivity.top.${idx(-1500)}`] });
  check('describesTransferAsDebtReduction: savings transfer narrated as paying down → true', describesTransferAsDebtReduction(paidDown, pkg));
  const accepted = acceptNarration(pkg, { headline: 'A quieter week.', quiet: false, observations: [paidDown] });
  check('…and acceptNarration drops it as MISLABELED_MOVEMENT',
    accepted.ok && accepted.narration.observations.length === 0
      && accepted.validation.droppedObservations.some((d) => d.reason === 'MISLABELED_MOVEMENT'),
    JSON.stringify(accepted).slice(0, 300));

  const debtWithTransfer = ob({ title: 'Debt fell', body: 'What you owe fell by $300 this week.',
    evidence: ['recentChanges.w1.debt', `recentActivity.top.${idx(-1500)}`] });
  check('associatesUnconnectedMovement: a debt change tied to a savings transfer → refused', associatesUnconnectedMovement(debtWithTransfer, pkg));

  const moved = ob({ kind: 'CASH', title: 'Money moved to savings', body: 'You moved $1,500 from checking into savings.',
    evidence: [`recentActivity.top.${idx(-1500)}`] });
  check('a correct description of the internal transfer is kept', !describesTransferAsDebtReduction(moved, pkg)
    && !associatesUnconnectedMovement(moved, pkg));

  const genuine = ob({ title: 'Card payment', body: 'You paid $300 toward your card and what you owe fell by $300.',
    evidence: ['recentChanges.w1.debt', `recentActivity.top.${idx(-300)}`] });
  check('a GENUINE card payment is still described as reducing debt (guard silent)',
    !describesTransferAsDebtReduction(genuine, pkg) && !associatesUnconnectedMovement(genuine, pkg));
  const acceptedGenuine = acceptNarration(pkg, { headline: 'You paid down your card.', quiet: false, observations: [genuine] });
  check('…and acceptNarration keeps it', acceptedGenuine.ok && acceptedGenuine.narration.observations.length === 1,
    JSON.stringify(acceptedGenuine).slice(0, 300));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
