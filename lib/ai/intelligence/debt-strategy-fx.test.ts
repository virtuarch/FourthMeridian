/**
 * lib/ai/intelligence/debt-strategy-fx.test.ts
 *
 * P2-7D — Debt Strategy Reporting-Currency Convergence.
 *
 * Runnable with tsx:   npx tsx lib/ai/intelligence/debt-strategy-fx.test.ts
 * Auto-discovered by scripts/run-tests.ts. Pure module (no DB/React/network).
 *
 * Freezes the P2-7C reporting-currency invariant for DEBT-STRATEGY math: every
 * CROSS-ACCOUNT monetary comparison (interest burden, weighted APR, snowball
 * ranking, candidate balances) must use AccountSummaryItem.reportingBalance — the
 * Space reporting-currency value — NEVER the native `balance`. APR is dimensionless
 * and unchanged. Native balance/currency remain as account-detail facts.
 *
 * The defect this pins: a Space holding, e.g., USD 10,000 @10% and AED 20,000 @20%
 * (≈ USD 5,445) previously summed/weighted/ranked the raw 10,000 vs 20,000 — an
 * invalid mixed-currency comparison that overstated the interest burden ~2.4×,
 * over-weighted the AED APR, and picked the WRONG snowball target.
 *
 * Tests drive the public entry point computeAssessment() with deterministic,
 * hand-set reportingBalance fixtures (no FX vendor, no rate service).
 */

import { computeAssessment } from '@/lib/ai/intelligence/annotations';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  SpaceContext_AI,
  AccountsSectionData,
  AccountSummaryItem,
} from '@/lib/ai/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const approx = (a: number | null, b: number, eps = 0.01): boolean => a !== null && Math.abs(a - b) <= eps;

// ── Fixture builders ────────────────────────────────────────────────────────

/** A debt AccountSummaryItem. `reportingBalance` is set explicitly (the assembler's
 *  moneyCtx conversion is out of scope here — we pin the DOWNSTREAM math). */
function debtAcct(o: {
  id: string; name: string; currency: string;
  balance: number; reportingBalance: number;
  apr?: number | null; visibility?: 'FULL' | 'BALANCE_ONLY'; estimated?: boolean;
}): AccountSummaryItem {
  const visibility = o.visibility ?? 'FULL';
  const base: AccountSummaryItem = {
    id:              o.id,
    name:            o.name,
    type:            'debt',
    balance:         o.balance,
    currency:        o.currency,
    reportingBalance: o.reportingBalance,
    ...(o.estimated ? { reportingBalanceEstimated: true } : {}),
    lastUpdated:     '2026-07-15T00:00:00.000Z',
    needsReauth:     false,
    visibilityLevel: visibility,
  };
  if (visibility === 'FULL') {
    base.apr            = o.apr ?? null;
    base.rateSource     = o.apr != null ? 'user' : null;
    base.minimumPayment = null;
  }
  return base;
}

/** Wrap an accounts list in a minimal SpaceContext_AI (accounts domain only). */
function makeCtx(accounts: AccountSummaryItem[]): SpaceContext_AI {
  const totalLiabilities = accounts
    .filter((a) => a.type === 'debt')
    .reduce((s, a) => s + Math.max(0, a.reportingBalance ?? 0), 0);

  const data: AccountsSectionData = {
    totalCount:         accounts.length,
    totalAssets:        0,
    totalLiabilities,               // reporting-currency (assembler-converted)
    netWorth:           -totalLiabilities,
    totalLiquid:        0,
    totalInvestments:   0,
    totalDigitalAssets: 0,
    totalRealAssets:    0,
    totalsEstimated:    accounts.some((a) => a.reportingBalanceEstimated === true),
    totalsUnconverted:  accounts.some((a) => a.reportingBalanceUnavailable === true),
    counts:  { liquid: 0, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: accounts.length },
    health:  { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] },
    knowledgeGaps: [],
    accounts,
  };

  return {
    requestedAt:     '2026-07-15T00:00:00.000Z',
    spaceId:         's1',
    userId:          'u1',
    role:            'OWNER' as SpaceContext_AI['role'],
    agentId:         'agent1',
    resolvedDomains: ['accounts'],
    space:           { id: 's1', name: 'Test', type: 'personal', category: 'personal', reportingCurrency: 'USD' },
    domains:         { [FinanceDomains.ACCOUNTS]: { domain: 'accounts', assembledAt: '2026-07-15T00:00:00.000Z', data } },
    signals:         [],
    auditLogId:      'log1',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Same-currency parity — all USD (reportingBalance === balance): the migration
//    is a no-op and results match the native-balance math exactly.
// ─────────────────────────────────────────────────────────────────────────────
{
  // A: USD 10,000 @10% · B: USD 5,000 @20%. reportingBalance === balance.
  const a = computeAssessment(makeCtx([
    debtAcct({ id: 'A', name: 'Card A', currency: 'USD', balance: 10000, reportingBalance: 10000, apr: 10 }),
    debtAcct({ id: 'B', name: 'Card B', currency: 'USD', balance:  5000, reportingBalance:  5000, apr: 20 }),
  ]));

  // interest burden = 10000·.1/12 + 5000·.2/12 = 83.33 + 83.33 = 166.67
  check('parity(USD): monthlyInterestBurden = 166.67', approx(a.debt.monthlyInterestBurden, 166.67),
    String(a.debt.monthlyInterestBurden));
  // weighted APR = (10·10000 + 20·5000)/15000 = 13.33
  check('parity(USD): weightedAvgApr = 13.33', approx(a.debtStrategy.weightedAvgApr, 13.33),
    String(a.debtStrategy.weightedAvgApr));
  // snowball = lowest balance = B (5000)
  check('parity(USD): snowball = Card B (5000)',
    a.debtStrategy.snowballCandidate?.accountName === 'Card B' && approx(a.debtStrategy.snowballCandidate?.balance ?? null, 5000));
  // no FX estimation on a clean same-currency Space
  check('parity(USD): balancesEstimated omitted (all exact)', a.debtStrategy.balancesEstimated === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Mixed-currency interest burden — uses converted (reporting) balances, NOT
//    the invalid native sum.
// ─────────────────────────────────────────────────────────────────────────────
{
  // A: USD 10,000 @10% (rep 10000) · B: AED 20,000 @20% (rep 5445).
  const a = computeAssessment(makeCtx([
    debtAcct({ id: 'A', name: 'US Card',  currency: 'USD', balance: 10000, reportingBalance: 10000, apr: 10 }),
    debtAcct({ id: 'B', name: 'AED Card', currency: 'AED', balance: 20000, reportingBalance:  5445, apr: 20 }),
  ]));

  // reporting = 10000·.1/12 + 5445·.2/12 = 83.33 + 90.75 = 174.08
  check('mixed: monthlyInterestBurden = 174.08 (reporting)', approx(a.debt.monthlyInterestBurden, 174.08),
    String(a.debt.monthlyInterestBurden));
  // the native (buggy) sum would have been 83.33 + 333.33 = 416.67 — must NOT appear
  check('mixed: monthlyInterestBurden is NOT the native 416.67', !approx(a.debt.monthlyInterestBurden, 416.67, 0.5));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Weighted APR — weighting uses reporting balances.
// ─────────────────────────────────────────────────────────────────────────────
{
  const a = computeAssessment(makeCtx([
    debtAcct({ id: 'A', name: 'US Card',  currency: 'USD', balance: 10000, reportingBalance: 10000, apr: 10 }),
    debtAcct({ id: 'B', name: 'AED Card', currency: 'AED', balance: 20000, reportingBalance:  5445, apr: 20 }),
  ]));
  // reporting = (10·10000 + 20·5445)/15445 = 13.53
  check('mixed: weightedAvgApr = 13.53 (reporting-weighted)', approx(a.debtStrategy.weightedAvgApr, 13.53),
    String(a.debtStrategy.weightedAvgApr));
  // native (buggy) weighting = (10·10000 + 20·20000)/30000 = 16.67 — must NOT appear
  check('mixed: weightedAvgApr is NOT the native 16.67', !approx(a.debtStrategy.weightedAvgApr, 16.67, 0.1));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Snowball ordering — smallest REPORTING balance, not the raw native magnitude.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Native magnitudes: A 10000 < B 20000 → native would pick A.
  // Reporting: B 5445 < A 10000 → the correct snowball target is B.
  const a = computeAssessment(makeCtx([
    debtAcct({ id: 'A', name: 'US Card',  currency: 'USD', balance: 10000, reportingBalance: 10000, apr: 10 }),
    debtAcct({ id: 'B', name: 'AED Card', currency: 'AED', balance: 20000, reportingBalance:  5445, apr: 20 }),
  ]));
  check('mixed: snowball target = AED Card (smallest reporting balance)',
    a.debtStrategy.snowballCandidate?.accountName === 'AED Card', a.debtStrategy.snowballCandidate?.accountName);
  check('mixed: snowball candidate balance is reporting (5445), not native (20000)',
    approx(a.debtStrategy.snowballCandidate?.balance ?? null, 5445),
    String(a.debtStrategy.snowballCandidate?.balance));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Avalanche — APR remains the PRIMARY (and only) ordering criterion; the
//    surfaced candidate balance reads in reporting currency (comparison basis).
// ─────────────────────────────────────────────────────────────────────────────
{
  const a = computeAssessment(makeCtx([
    debtAcct({ id: 'A', name: 'US Card',  currency: 'USD', balance: 10000, reportingBalance: 10000, apr: 10 }),
    debtAcct({ id: 'B', name: 'AED Card', currency: 'AED', balance: 20000, reportingBalance:  5445, apr: 20 }),
  ]));
  // highest APR wins regardless of balance/currency → B (20%).
  check('avalanche: highest-APR target = AED Card (20%)',
    a.debtStrategy.avalancheCandidate?.accountName === 'AED Card' && a.debtStrategy.avalancheCandidate?.apr === 20);
  // candidate balance is reporting (5445), not native (20000).
  check('avalanche: candidate balance is reporting (5445), not native (20000)',
    approx(a.debtStrategy.avalancheCandidate?.balance ?? null, 5445),
    String(a.debtStrategy.avalancheCandidate?.balance));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Missing FX — pass-through native amount + estimated taint propagates to the
//    strategy so the cross-currency comparison is not claimed exact.
// ─────────────────────────────────────────────────────────────────────────────
{
  // B has no rate: reportingBalance falls back to native (per the P2-7C contract)
  // and is flagged estimated. We model that with reportingBalance === native + taint.
  const a = computeAssessment(makeCtx([
    debtAcct({ id: 'A', name: 'US Card',  currency: 'USD', balance: 10000, reportingBalance: 10000, apr: 10 }),
    debtAcct({ id: 'B', name: 'AED Card', currency: 'AED', balance: 20000, reportingBalance: 20000, apr: 20, estimated: true }),
  ]));
  check('missing-FX: debtStrategy.balancesEstimated propagates (true)', a.debtStrategy.balancesEstimated === true);
  // the pass-through native amount is still used (never dropped): burden = 83.33 + 333.33 = 416.67
  check('missing-FX: reporting balance passes through (native), row never dropped',
    approx(a.debt.monthlyInterestBurden, 416.67));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Native detail preserved — balance/currency are untouched; reportingBalance
//    is purely additive.
// ─────────────────────────────────────────────────────────────────────────────
{
  const b = debtAcct({ id: 'B', name: 'AED Card', currency: 'AED', balance: 20000, reportingBalance: 5445, apr: 20 });
  check('native detail: balance retained (20000)', b.balance === 20000);
  check('native detail: currency retained (AED)', b.currency === 'AED');
  check('native detail: reportingBalance is additive and distinct (5445)',
    b.reportingBalance === 5445 && b.reportingBalance !== b.balance);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log('Debt-strategy FX convergence tests FAILED.'); process.exit(1); }
console.log('Debt-strategy FX convergence tests passed.');
process.exit(0);
