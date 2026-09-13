/**
 * lib/ai/brief/package.test.ts
 *
 * THE DAILY BRIEF PACKAGE — authorities in, compact facts out, nothing leaked.
 *
 * Pure: hand-built assembler sections in, package out. The fixtures deliberately
 * carry a hidden account name, masks, institutions, account ids, a checkpoint
 * value, a raw `statedAs` and a superseded goal, so every "never included" rule is
 * tested against a string that would otherwise leak.
 *
 *   npx tsx lib/ai/brief/package.test.ts
 */

import type {
  AccountsSectionData, HoldingsSummaryData, SnapshotDataPoint, SnapshotSectionData,
  TransactionsSummaryData,
} from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence';
import type { RecalledMemory } from '@/lib/ai/conversation/memory-store';
import { canonicalWindowChange } from '@/lib/data/snapshot-window';
import { projectBriefPackage, type BriefInputs } from './package';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TODAY = '2026-09-13';
const NOW = new Date('2026-09-13T12:00:00.000Z');
const RAW = 'RAW-WORDS actually make it 750k, also my $15k bonus';

const accounts = (over: Partial<AccountsSectionData> = {}): AccountsSectionData => ({
  totalCount: 4, redactedCount: 0,
  totalAssets: 131660.77, totalLiabilities: 3210.55, netWorth: 128450.222,
  totalLiquid: 18920.404, totalInvestments: 84300.10, totalDigitalAssets: 28440.27, totalRealAssets: 0,
  totalsEstimated: false, totalsUnconverted: false,
  counts: { liquid: 1, investments: 1, digitalAssets: 1, realAssets: 0, liabilities: 1 },
  health: { errorCount: 1, staleCount: 0, needsReauthCount: 1,
    errorAccountNames: ['Chase Checking'], staleAccountNames: [], needsReauthAccountNames: ['Chase Checking'] },
  knowledgeGaps: [{ accountId: 'fa_card_1', accountName: 'Chase Sapphire', field: 'apr', label: 'APR', debtSubtype: 'credit_card' }],
  accounts: [
    { id: 'fa_chk_1', name: 'Chase Checking', type: 'checking', institution: 'Chase Bank', balance: 18920.40,
      currency: 'USD', reportingBalance: 18920.40, lastUpdated: '2026-09-13T06:00:00.000Z',
      balanceLastUpdatedAt: null, needsReauth: true, visibilityLevel: 'FULL' },
    { id: 'fa_hidden_2', name: 'Secret Brokerage', type: 'investment', institution: 'Hidden Bank', balance: 84300.10,
      currency: 'USD', reportingBalance: 84300.10, lastUpdated: '2026-09-02T06:00:00.000Z',
      balanceLastUpdatedAt: null, needsReauth: false, visibilityLevel: 'BALANCE_ONLY' },
  ] as unknown as AccountsSectionData['accounts'],
  accountListScope: 'FULL',
  accountIds: ['fa_chk_1', 'fa_hidden_2'],
  trackedAccounts: [{ id: 'fa_chk_1', name: 'Chase Checking', type: 'checking', institution: 'Chase Bank', mask: '4321', visibility: 'FULL' }],
  ...over,
});

/** Daily points from `from` through `to`; liquid rises 10/day, debt falls 5/day. */
function history(from: string, to: string, over: (p: SnapshotDataPoint, i: number) => void = () => {}) {
  const out: SnapshotDataPoint[] = [];
  let i = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000, i++) {
    const p: SnapshotDataPoint = {
      date: new Date(t).toISOString().slice(0, 10),
      netWorth: 120000 + i * 15, totalAssets: 125000 + i * 10, liabilities: 5000 - i * 5,
      liquid: 15000 + i * 10, investments: 80000, digitalAssets: 30000, cashOnHand: 9000, netLiquid: 10000,
    };
    over(p, i);
    out.push(p);
  }
  return out;
}
const snapshot = (h: SnapshotDataPoint[]): SnapshotSectionData => ({
  snapshotCount: h.length, spanDays: h.length - 1, canonicalChange: null, liabilitiesChange: null,
  oldestDate: h[0]?.date ?? null, newestDate: h[h.length - 1]?.date ?? null,
  latest: h[h.length - 1] ?? null, history: h,
});

const transactions = { windowDays: 90, startDate: '2026-06-15', endDate: '2026-09-13' } as TransactionsSummaryData;

const assessment = {
  dataQuality: { transactionHistoryCompleteness: 'HIGH', snapshotSpanDays: 400, incomeConfidence: 'HIGH',
    incomeTransactionCount: 12, unidentifiedInflowShare: 0.1234 },
  cashFlow: { reliability: 'RELIABLE', confidence: 'HIGH', deficitCause: 'NOT_APPLICABLE',
    transactionCompleteness: 'HIGH', impliedMonthlyIncome: 9620.004, estimatedMonthlyExpenses: 6240.349,
    estimatedMonthlyDebtPayments: 1850.1, incomeTransactionCount: 12, incompleteIncomeWarning: false },
  liquidity: { classification: 'SAFE', coverageMonths: 3.04 },
  debt: { classification: 'INSUFFICIENT_DATA', aprCompleteness: 'NONE' },
  ungraded: [{ section: 'debt', verdict: 'INSUFFICIENT_DATA', reason: 'APR_MISSING', detail: 'Chase Sapphire has no APR ($3,210.55)' }],
} as unknown as FinancialAssessment;

const holdings = {
  valuationCompleteness: { tier: 'COMPLETE', reason: null, valuedCount: 12, unvaluedCount: 2 },
  concentration: { classification: 'HIGHLY_CONCENTRATED', topSymbol: 'NVDA', topWeight: 0.4521,
    top5Weight: 0.8, herfindahl: 0.3, effectiveHoldings: 3,
    population: { label: 'priced positions', value: 84300.10, positionCount: 12, unvaluedCount: 2,
      hiddenValue: 0, shareOfValuedTotal: 1, isComplete: false } },
} as unknown as HoldingsSummaryData;

let m = 0;
const mem = (kind: string, payload: unknown, over: Partial<RecalledMemory> = {}): RecalledMemory => ({
  id: `mem_${++m}`, kind: kind as RecalledMemory['kind'], subject: `s${m}`, status: 'ACTIVE' as RecalledMemory['status'],
  payload, statedAs: RAW, statedAt: '2026-09-01T00:00:00.000Z', appliesFrom: null, appliesTo: null, supersedesId: null,
  ...over,
});
const memories: RecalledMemory[] = [
  mem('INTENTION', { targetMetric: 'netWorth', targetAmount: 750000, byDate: '2029-12-31' }),
  mem('INTENTION', { targetMetric: 'netWorth', targetAmount: 999999, byDate: '2026-01-01' }),           // past
  mem('INTENTION', { targetMetric: 'netWorth', targetAmount: 888888, byDate: '2030-01-01' }, { status: 'SUPERSEDED' as RecalledMemory['status'] }),
  mem('INTENTION', { targetMetric: 'liquid', targetAmount: 777777, byDate: '2030-01-01' }, { status: 'RETIRED' as RecalledMemory['status'] }),
  mem('INTENTION', { intent: 'spend', amount: 40000, label: 'Kitchen remodel' }),
  mem('INTENTION', { intent: 'prefer', amount: 0, label: 'Keep it simple' }),                            // amount 0
  mem('CHECKPOINT', { metric: 'liquid', horizon: '2026-12-31', value: 51598.84, basis: { opening: 23456.78 } }),
  mem('CHECKPOINT', { metric: 'liquid', horizon: '2026-10-31', value: 43210.99, basis: { opening: 23456.78 } }),
  mem('CHECKPOINT', { metric: 'liquid', horizon: '2026-09-01', value: 11111.11 }),                       // settled
  mem('CHECKPOINT', { metric: 'netWorth', horizon: '2026-10-01', value: 22222.22 }),
  mem('ASSUMPTION', { monthlySpending: 6123.45 }),
];

const inputs = (over: Partial<BriefInputs> = {}): BriefInputs => ({
  asOf: TODAY, today: TODAY, now: NOW, currency: 'USD',
  accounts: accounts(), transactions, snapshot: snapshot(history('2026-08-01', TODAY)),
  holdings, assessment, memories, recentActivity: null, ...over,
});

console.log('1. current state — the authorities\' figures, rounded for reading');
const pkg = projectBriefPackage(inputs());
{
  check('net worth, liquid and debt come from the accounts totals',
    pkg.currentState.netWorth === 128450.22 && pkg.currentState.liquid === 18920.4 && pkg.currentState.debt === 3210.55);
  check('the investment split is composeInvestments\'',
    pkg.currentState.investments?.traditional === 84300.1 && pkg.currentState.investments?.digital === 28440.27
      && pkg.currentState.investments?.combined === 112740.37 && !pkg.currentState.investments?.withheld);
  check('concentration carries its denominator and completeness',
    pkg.currentState.concentration?.topWeightPct === 45.2 && pkg.currentState.concentration?.populationValue === 84300.1
      && pkg.currentState.concentration?.populationIsComplete === false);
  check('identity names the day and basis', pkg.identity.asOf === TODAY && pkg.identity.basis === 'CURRENT');
  const hidden = projectBriefPackage(inputs({ accounts: accounts({ redactedCount: 2 }) }));
  check('a hidden account withholds the unknown component rather than zeroing it',
    hidden.currentState.investments?.withheld === true && hidden.currentState.investments?.combined === null);
  check('…and is disclosed as a count only', hidden.currentState.hiddenAccounts === 2);
}

console.log('\n2. freshness and data quality');
{
  check('reauth reaches the package; the unwritten sync-error count does not', pkg.freshness?.needsReauth === true
    && !('accountsWithSyncErrors' in pkg.freshness) && !('connectionsNeedingAttention' in pkg.freshness));
  check('the band is the OLDEST observation\'s (11 days ⇒ STALE)', pkg.freshness?.band === 'STALE', pkg.freshness?.band);
  check('knowledge gaps are account name + missing label only',
    JSON.stringify(pkg.dataQuality.knowledgeGaps) === JSON.stringify([{ account: 'Chase Sapphire', missing: 'APR' }]));
  check('ungraded carries section and reason, not prose', JSON.stringify(pkg.dataQuality.ungraded) === '[{"section":"debt","reason":"APR_MISSING"}]');
  check('unvalued positions counted', pkg.dataQuality.unvaluedPositions === 2);
  check('unidentified income share as a rounded percent', pkg.dataQuality.unidentifiedIncomeSharePct === 12.3);
  check('behavior monthly figures rounded', pkg.behavior?.monthlyIncome === 9620 && pkg.behavior.monthlyExpenses === 6240.35
    && pkg.behavior.liquidity?.coverageMonths === 3);
}

console.log('\n3. recent change — the window authorities, over the full series');
{
  const h = history('2026-08-01', TODAY);
  const series = h.map((p) => ({ date: new Date(`${p.date}T00:00:00.000Z`), value: p.liquid }));
  const w = canonicalWindowChange(series, 'PAST_WEEK')!;
  const mo = canonicalWindowChange(series, 'PAST_MONTH')!;
  check('d1 is the previous day, measured', pkg.recentChanges.d1?.from === '2026-09-12' && pkg.recentChanges.d1.liquid?.abs === 10);
  check('w1 equals canonicalWindowChange PAST_WEEK', pkg.recentChanges.w1?.from === w.fromDate && pkg.recentChanges.w1.liquid?.abs === w.abs);
  check('m1 equals canonicalWindowChange PAST_MONTH', pkg.recentChanges.m1?.from === mo.fromDate && pkg.recentChanges.m1.liquid?.abs === mo.abs);
  check('debt keeps its own direction', (pkg.recentChanges.w1?.debt?.abs ?? 0) < 0);

  const short = projectBriefPackage(inputs({ snapshot: snapshot(history('2026-09-09', TODAY)) }));
  check('five days of history: d1 only — w1 and m1 refused, not stitched',
    !!short.recentChanges.d1 && !short.recentChanges.w1 && !short.recentChanges.m1);

  const gap = history('2026-08-01', '2026-09-09').concat(history(TODAY, TODAY));
  check('a gap before the newest point is not called "yesterday"', !projectBriefPackage(inputs({ snapshot: snapshot(gap) })).recentChanges.d1);

  const nulled = history('2026-08-01', TODAY, (p, i) => { if (i === 43) { p.netWorth = null; p.digitalAssets = null; } });
  const np = projectBriefPackage(inputs({ snapshot: snapshot(nulled) }));
  check('an unassertable newest net worth is omitted from d1, liquid kept',
    !np.recentChanges.d1?.netWorth && !np.recentChanges.d1?.digitalAssets && np.recentChanges.d1?.liquid?.abs === 10);
  check('…and from w1, whose net-worth window would end on a different day',
    !np.recentChanges.w1?.netWorth && np.recentChanges.w1?.liquid !== undefined);
}

console.log('\n4. plans — the starter rules, the owner\'s rows, topics not values');
{
  const plans = pkg.plans!;
  check('the live goal is included with its distance from today',
    plans.goals.length === 1 && plans.goals[0].targetAmount === 750000 && plans.goals[0].current === 128450.22
      && plans.goals[0].remaining === 621549.78 && plans.goals[0].progressPct === 17.1, JSON.stringify(plans.goals));
  check('past, superseded and retired goals are excluded', !/999999|888888|777777/.test(JSON.stringify(plans)));
  check('the planned expense is included; an amount-0 preference is not',
    JSON.stringify(plans.planned) === '[{"label":"Kitchen remodel","amount":40000}]');
  check('the next checkpoint is the nearest FUTURE liquid horizon',
    plans.nextCheckpoint?.horizon === '2026-10-31' && plans.nextCheckpoint.metric === 'liquid');
  const json = JSON.stringify(pkg);
  check('no checkpoint value appears', !/51598|43210|11111|22222/.test(json));
  check('no checkpoint basis appears', !/23456|"basis":\{/.test(json));
  check('no statedAs appears', !json.includes('RAW-WORDS') && !json.includes('statedAs'));
  check('no assumption appears', !json.includes('6123'));
  check('no memory at all ⇒ no plans key', !('plans' in projectBriefPackage(inputs({ memories: [] }))));
}

console.log('\n5. nothing that identifies an account or a provider');
{
  const json = JSON.stringify(pkg);
  check('no hidden account name', !json.includes('Secret Brokerage'));
  check('no account ids', !/fa_[a-z]/.test(json));
  check('no institution or mask', !/institution|mask|Hidden Bank|4321/i.test(json));
  check('no tracked-account roster', !json.includes('trackedAccounts'));
  check('no ungraded prose (it can carry figures and names)', !json.includes('has no APR ('));
}

console.log('\n5b. sources that need attention, named for qualification');
{
  const dataHealth = {
    sources: [
      { kind: 'BANK' as const, label: 'Chase', state: 'NEEDS_RECONNECT' as const, lastUpdatedAt: '2026-08-18T09:00:00.000Z', accountCount: 2, needsAttention: true, actionable: true },
      { kind: 'BANK' as const, label: 'Amex', state: 'CURRENT' as const, lastUpdatedAt: '2026-09-13T09:00:00.000Z', accountCount: 1, needsAttention: false, actionable: true },
    ],
    groups: [], attention: 1,
  };
  const pkg = projectBriefPackage(inputs({ dataHealth }));
  check('only the source needing attention, with its state and day',
    JSON.stringify(pkg.freshness?.staleSources) === JSON.stringify([{ label: 'Chase', state: 'NEEDS_RECONNECT', lastUpdated: '2026-08-18' }]));
  check('no staleSources key when every source is current',
    !!pkg.freshness && !('staleSources' in projectBriefPackage(inputs({ dataHealth: { ...dataHealth, sources: [dataHealth.sources[1]], attention: 0 } })).freshness!));
  check('none when data health could not be read', !!pkg.freshness && !('staleSources' in projectBriefPackage(inputs()).freshness!));
  check('the attention count is data health\'s, not an unwritten sync-error flag', pkg.freshness?.connectionsNeedingAttention === 1);
}

console.log('\n6. the information ceiling');
{
  const cut = history('2026-08-01', '2026-09-01');
  const retro = projectBriefPackage(inputs({ asOf: '2026-09-01', snapshot: snapshot(cut) }));
  check('asOf before today is RETROSPECTIVE', retro.identity.basis === 'RETROSPECTIVE' && retro.identity.asOf === '2026-09-01');
  check('its position is the snapshot on the ceiling, not today\'s balances',
    retro.currentState.basis === 'HISTORICAL_SNAPSHOT' && retro.currentState.observedOn === '2026-09-01'
      && retro.currentState.liquid === 15310);
  check('no live freshness, concentration or live-graded verdicts',
    !retro.freshness && !retro.currentState.concentration && !retro.behavior?.liquidity && !retro.behavior?.debt);
  check('windows end on the ceiling', retro.recentChanges.w1?.to === '2026-09-01');
  check('memory is judged in force as of the ceiling (2026-09-01 checkpoint not yet settled)',
    retro.plans?.nextCheckpoint?.horizon === '2026-09-01');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
