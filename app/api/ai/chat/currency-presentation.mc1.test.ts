/**
 * app/api/ai/chat/currency-presentation.mc1.test.ts
 *
 * MC1 Phase 4 Slice 7 — currency presentation, asserted at RUNTIME (pure, no DB).
 *
 *     npx tsx app/api/ai/chat/currency-presentation.mc1.test.ts
 *
 * TEST-3 PART 5 modernization: this used to `readFileSync` context-serializer.ts
 * and snapshot the exact currency wording + guard structure. serializeContextBlock
 * is now a pure exported function (AI-ARCH), so we IMPORT it and assert the actual
 * BEHAVIOR: the reporting-currency label is always present and DYNAMIC (not a
 * hardcoded USD), and the estimation disclosure is emitted once and only when a
 * section's totals are estimated. A behavior test proves the currency actually
 * flows through to the prompt, which a source snapshot never could. Only the
 * builder→context threading (context-builder.ts reads the DB, so it can't run
 * under a bare tsx script) stays a minimal source check.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { serializeContextBlock } from '@/lib/ai/prompts/context-serializer';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  SpaceContext_AI, AccountsSectionData, TransactionsSummaryData,
} from '@/lib/ai/types';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0, i = haystack.indexOf(needle);
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
function accountsData(estimated: boolean, unconverted = false): AccountsSectionData {
  return {
    totalCount: 1, totalAssets: 100, totalLiabilities: 0, netWorth: 100,
    totalLiquid: 100, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0,
    totalsEstimated: estimated,
    totalsUnconverted: unconverted,
    counts: { liquid: 1, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 0 },
    health: { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] },
    knowledgeGaps: [],
    accounts: [{
      id: 'A', name: 'Checking', type: 'checking', balance: 100, currency: 'USD',
      reportingBalance: 100, lastUpdated: '2026-07-15T00:00:00.000Z', needsReauth: false,
      visibilityLevel: 'FULL', apr: null, rateSource: null, minimumPayment: null,
    }],
  };
}
function txnData(estimated: boolean): TransactionsSummaryData {
  return {
    windowDays: 90, startDate: '2026-04-01', endDate: '2026-06-30',
    transactionCount: 30, truncated: false, coverageStartDate: '2026-04-01', fetchLimit: 5000,
    incomeTotal: 1000, expenseTotal: 500, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, netCashFlow: 500, estimated,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: 'PERSISTED_AND_READ_TIME',
    },
    byCategory: [], monthlyBreakdown: [], largestIncome: null, largestExpense: null,
  } as unknown as TransactionsSummaryData;
}
function makeCtx(opts: {
  currency?: string | undefined;
  accountsEstimated?: boolean;
  accountsUnconverted?: boolean;
  txnEstimated?: boolean;
  holdingsEstimated?: boolean;
}): SpaceContext_AI {
  const domains: SpaceContext_AI['domains'] = {
    [FinanceDomains.ACCOUNTS]: { domain: 'accounts', assembledAt: 'x', data: accountsData(opts.accountsEstimated ?? false, opts.accountsUnconverted ?? false) },
  };
  if (opts.txnEstimated !== undefined) {
    domains[FinanceDomains.TRANSACTIONS_SUMMARY] =
      { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: 'x', data: txnData(opts.txnEstimated) };
  }
  if (opts.holdingsEstimated !== undefined) {
    domains[FinanceDomains.HOLDINGS_SUMMARY] =
      { domain: FinanceDomains.HOLDINGS_SUMMARY, assembledAt: 'x', data: { totalsEstimated: opts.holdingsEstimated } as never };
  }
  return {
    requestedAt: 'x', spaceId: 's1', userId: 'u1', role: 'OWNER' as SpaceContext_AI['role'],
    agentId: 'a1', resolvedDomains: ['accounts'],
    space: { id: 's1', name: 'Test', type: 'personal', category: 'personal', reportingCurrency: opts.currency },
    domains, signals: [], auditLogId: 'log1',
  };
}

// ── the reporting-currency label: always present, dynamic, single insertion ────
{
  const usd = serializeContextBlock(makeCtx({ currency: 'USD' }));
  const eur = serializeContextBlock(makeCtx({ currency: 'EUR' }));
  const none = serializeContextBlock(makeCtx({ currency: undefined }));
  check("label present: names the reporting currency + native-currency caveat",
    usd.includes("reporting currency") && usd.includes("native currency"));
  check("label is DYNAMIC — reflects the actual reporting currency (USD)", usd.includes('in USD'));
  check("label is DYNAMIC — reflects a non-USD reporting currency (EUR), not hardcoded USD",
    eur.includes('in EUR') && !eur.includes('in USD'));
  check("label falls back to USD when the Space has no reporting currency", none.includes('in USD'));
  check("label is a single insertion (emitted exactly once)",
    countOccurrences(usd, "reporting currency") === 1);
}

// ── the estimation disclosure: emitted once and only when a section is estimated ─
{
  const TAIL = 'treat affected figures as estimates.';
  check("not estimated → NO estimation disclosure",
    !serializeContextBlock(makeCtx({ accountsEstimated: false })).includes(TAIL));
  check("accounts estimated → estimation disclosure emitted",
    serializeContextBlock(makeCtx({ accountsEstimated: true })).includes(TAIL));
  check("transactions-summary estimated → estimation disclosure emitted",
    serializeContextBlock(makeCtx({ txnEstimated: true })).includes(TAIL));
  check("holdings estimated → estimation disclosure emitted",
    serializeContextBlock(makeCtx({ holdingsEstimated: true })).includes(TAIL));
  check("disclosure is a single emission even when multiple sections are estimated",
    countOccurrences(
      serializeContextBlock(makeCtx({ accountsEstimated: true, txnEstimated: true, holdingsEstimated: true })),
      TAIL,
    ) === 1);
}

// ── V25-FINAL-1: FX-UNAVAILABLE totals disclosed as INCOMPLETE (not just fuzzy) ─
{
  const EXCLUDED = 'EXCLUDED from the account totals';
  check("not unconverted → NO exclusion disclosure",
    !serializeContextBlock(makeCtx({ accountsUnconverted: false })).includes(EXCLUDED));
  check("accounts unconverted → exclusion disclosure emitted (totals incomplete)",
    serializeContextBlock(makeCtx({ accountsUnconverted: true })).includes(EXCLUDED));
  check("exclusion disclosure names the reporting currency (EUR), telling the model not to read 0",
    serializeContextBlock(makeCtx({ currency: 'EUR', accountsUnconverted: true })).includes('to EUR') &&
    serializeContextBlock(makeCtx({ currency: 'EUR', accountsUnconverted: true })).includes('do not treat their'));
}

// ── envelope plumbing (DB-coupled builder → minimal source check) ──────────────
// context-builder.ts assembles the context from the DB, so it can't run under a
// bare tsx script; assert it threads the Space's reporting currency into the
// context the serializer above consumes.
{
  const builderSrc = readFileSync(join(process.cwd(), 'lib/ai/context-builder.ts'), 'utf8');
  check('builder threads reportingCurrency into SpaceContext_AI.space',
    builderSrc.includes('reportingCurrency: spaceCtx.space.reportingCurrency'));
}

if (failures.length > 0) {
  console.error(`\nMC1 P4 currency presentation: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`MC1 P4 currency presentation: all ${passed} checks passed.`);
process.exit(0);
