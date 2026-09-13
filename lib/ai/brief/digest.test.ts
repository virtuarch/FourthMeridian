/**
 * lib/ai/brief/digest.test.ts
 *
 * THE MATERIAL DIGEST — noise stays quiet, material change is heard, and the policy is pinned.
 *
 *   npx tsx lib/ai/brief/digest.test.ts
 */

import { BRIEF_SCENARIOS, basePackage } from './fixtures';
import {
  DIGEST_VERSION, canonicalJson, changeBucket, isMaterialActivity, materialDigest,
  materialProjection, moneyBucket,
} from './digest';
import { MATERIALITY } from './policy';
import type { BriefPackage } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const base = basePackage();
const d0 = materialDigest(base);
const variant = (f: (p: BriefPackage) => void, from: BriefPackage = base) => {
  const p = structuredClone(from);
  f(p);
  return materialDigest(p);
};
const withGoal = structuredClone(base);
withGoal.plans = { goals: [{ metric: 'netWorth', targetAmount: 750000, byDate: '2027-06-30', current: 128450.22, remaining: 621549.78, progressPct: 17.1 }], planned: [] };
const dGoal = materialDigest(withGoal);
const same = (name: string, f: (p: BriefPackage) => void) => check(name, variant(f) === d0);
const differs = (name: string, f: (p: BriefPackage) => void) => check(name, variant(f) !== d0);

console.log('1. the policy, pinned');
{
  check('policy constants', MATERIALITY.ABSOLUTE_STEP === 1000 && MATERIALITY.RELATIVE_STEP === 0.02
    && MATERIALITY.LARGE_TRANSACTION_FLOOR === 250 && MATERIALITY.LARGE_TRANSACTION_SHARE === 0.25);
  check('$1,000 linear buckets below $50,000',
    moneyBucket(999.99) === '+L0' && moneyBucket(1000) === '+L1' && moneyBucket(49_999) === '+L49');
  check('2% geometric buckets from $50,000',
    moneyBucket(50_000) === '+G0' && moneyBucket(51_500) === '+G1' && moneyBucket(128_450.22) === '+G47');
  check('zero, negative and unknown are their own buckets',
    moneyBucket(0) === '0' && moneyBucket(-3210.55) === '-L3' && moneyBucket(null) === 'NA');
  check('a movement under $1,000 is no movement, whatever its sign',
    changeBucket({ abs: -999, pct: -5 }) === '0' && changeBucket({ abs: 48, pct: 0.3 }) === '0'
      && changeBucket({ abs: -1000, pct: -5 }) === '-L1' && changeBucket(undefined) === 'NA');
  const row = (amount: number, flow: string) => ({ date: '2026-09-12', amount, flow, category: 'Other' });
  check('a transaction is material at max($250, 25% of monthly expenses)',
    !isMaterialActivity(row(-1500, 'SPENDING'), 6240) && isMaterialActivity(row(-1560.1, 'SPENDING'), 6240)
      && isMaterialActivity(row(-250, 'SPENDING'), null) && !isMaterialActivity(row(-249, 'SPENDING'), null));
  check('income and debt payments are material from $250',
    isMaterialActivity(row(300, 'INCOME'), 6240) && isMaterialActivity(row(-300, 'DEBT_PAYMENT'), 6240)
      && !isMaterialActivity(row(-300, 'TRANSFER'), 6240));
  check('the digest is versioned', d0.startsWith(`${DIGEST_VERSION}:`) && /^brief-material-v1:[0-9a-f]{40}$/.test(d0));
}

console.log('\n2. what must NOT move it');
{
  check('an identical package', materialDigest(basePackage()) === d0);
  same('the brief day and timestamps', (p) => {
    p.identity.briefDay = '2026-09-14';
    p.freshness!.oldestBalanceObservedAt = '2026-09-13T11:59:00.000Z';
    p.freshness!.oldestBalanceAgeDays = 0.9;
    p.recentChanges.w1!.from = '2026-09-07'; p.recentChanges.w1!.to = '2026-09-14';
    p.behavior!.window = { from: '2026-06-16', to: '2026-09-14', days: 90 };
    p.recentActivity!.from = '2026-09-08';
  });
  same('cent-level noise in balances', (p) => {
    p.currentState.netWorth = 128_462.56; p.currentState.liquid = 18_960.4; p.currentState.debt = 3_250;
  });
  same('an ordinary coffee and small movements', (p) => {
    p.recentActivity!.top.push({ date: '2026-09-13', amount: -4.5, flow: 'SPENDING', category: 'Dining', merchant: 'Cafe' });
    p.recentActivity!.transactionsInWindow = 24;
    p.recentChanges.d1!.liquid = { abs: -91.1, pct: -0.5 };
  });
  same('net worth up $550 (same 2% bucket)', (p) => { p.currentState.netWorth = 129_000; });
  same('liquid down $820 inside its $1,000 bucket', (p) => { p.currentState.liquid = 18_100; });
  check('the derived goal distance alone (it follows the balance buckets)',
    variant((p) => { p.plans!.goals[0].current = 129_000; p.plans!.goals[0].remaining = 621_000; p.plans!.goals[0].progressPct = 17.2; }, withGoal) === dGoal);

  const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
  check('field order does not move it', materialDigest(reverseKeys(base) as BriefPackage) === d0);
  const gaps = BRIEF_SCENARIOS.find((s) => s.id === '11-apr-gaps')!.pkg;
  check('set order does not move it (knowledge gaps, activity rows)',
    variant((p) => { p.dataQuality.knowledgeGaps.reverse(); p.recentActivity!.top.reverse(); }, gaps) === materialDigest(gaps));
  check('canonical JSON sorts keys at every depth', canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}');
}

console.log('\n3. what MUST move it');
{
  differs('a material cash move ($1,020 across a bucket)', (p) => { p.currentState.liquid = 17_900; });
  differs('a material net-worth move (+2.1%)', (p) => { p.currentState.netWorth = 131_200; });
  differs('debt paid to zero', (p) => { p.currentState.debt = 0; });
  differs('a meaningful new transaction (a paycheck)', (p) => {
    p.recentActivity!.top.unshift({ date: '2026-09-13', amount: 4812.66, flow: 'INCOME', category: 'Income', merchant: 'Acme Payroll' });
  });
  differs('a large new expense', (p) => {
    p.recentActivity!.top.unshift({ date: '2026-09-13', amount: -2480, flow: 'SPENDING', category: 'Travel', merchant: 'Delta' });
  });
  differs('a material weekly movement appearing', (p) => { p.recentChanges.w1!.liquid = { abs: -2169.56, pct: -10.3 }; });
  differs('a change window becoming measurable or refused', (p) => { delete p.recentChanges.m1; });
  differs('freshness degrading (LIVE → RECENT)', (p) => { p.freshness!.band = 'RECENT'; });
  differs('needsReauth appearing', (p) => { p.freshness!.needsReauth = true; });
  differs('the knowledge-gap set changing', (p) => { p.dataQuality.knowledgeGaps = [{ account: 'Amex Gold', missing: 'APR' }]; });
  differs('an ungraded section appearing', (p) => { p.dataQuality.ungraded = [{ section: 'debt', reason: 'APR_MISSING' }]; });
  differs('a verdict changing', (p) => { p.behavior!.liquidity = { classification: 'WARNING', coverageMonths: 1.1 }; });
  differs('an active goal appearing', (p) => {
    p.plans = { goals: [{ metric: 'netWorth', targetAmount: 750000, byDate: '2027-06-30' }], planned: [] };
  });
  check('a goal target changing', variant((p) => { p.plans!.goals[0].targetAmount = 800000; }, withGoal) !== dGoal);
  differs('a planned expense appearing', (p) => { p.plans = { goals: [], planned: [{ label: 'Kitchen', amount: 40000 }] }; });
  differs('the next checkpoint horizon changing', (p) => { p.plans = { goals: [], planned: [], nextCheckpoint: { metric: 'liquid', horizon: '2026-10-31' } }; });
  differs('concentration appearing', (p) => {
    p.currentState.concentration = { classification: 'HIGHLY_CONCENTRATED', topSymbol: 'NVDA', topWeightPct: 45.2, populationValue: 84300.1, populationIsComplete: true };
  });
}

console.log('\n4. what the projection may hold');
{
  const json = canonicalJson(materialProjection(base));
  check('no ISO timestamps', !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(json));
  check('no raw balances', !/18920|128450|3210\.55/.test(json));
  check('no merchant names or prose', !/Whole Foods|Chipotle|headline|title/.test(json));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
