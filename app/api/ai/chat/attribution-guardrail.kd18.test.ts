/**
 * app/api/ai/chat/attribution-guardrail.kd18.test.ts
 *
 * KD-18 — attribution-honesty guardrail, asserted at RUNTIME (pure, no DB, no LLM).
 *
 *     npx tsx app/api/ai/chat/attribution-guardrail.kd18.test.ts
 *
 * TEST-3 PART 5 modernization: this used to `readFileSync` the prompt modules and
 * snapshot ~20 verbatim prompt phrases, because the guardrail lived inside the
 * un-exportable Next route. AI-ARCH extracted it into pure, exportable modules
 * (lib/ai/prompts/{doctrine,context-serializer,system-prompt}.ts), so we now
 * IMPORT the real constants/builders and assert their SEMANTIC HONESTY and their
 * BEHAVIOR — the disclosure fires only inside the transaction path; the rule is
 * embedded in the advisor principles; per-card figures render only when supplied.
 * A behavior test is strictly stronger than a wording snapshot: a paraphrase that
 * preserves the honesty still passes, while a real regression (disclosure leaking
 * into non-transaction prompts, an invented per-account split, a refusal-first
 * rule) fails. Only the deterministic-provenance seam — that per-card figures
 * come through the KD-15 visibility-guarded data layer, which reads the DB and so
 * cannot run under a bare tsx script — stays a minimal source check.
 *
 * Defect under test (docs/investigations/DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md
 * + STATUS.md KD-18): deterministic context carries exact flow TOTALS but not the
 * account/card/source/destination dimension, so a per-card question could yield an
 * invented allocation the membership validator structurally cannot catch. KD-18
 * adds honesty, not capability.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ATTRIBUTION_DISCLOSURE, ATTRIBUTION_RULE, ADVISOR_PRINCIPLES } from '@/lib/ai/prompts/doctrine';
import { serializeContextBlock, type DebtPaymentLine } from '@/lib/ai/prompts/context-serializer';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { computeAssessment } from '@/lib/ai/intelligence';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  SpaceContext_AI, AccountsSectionData, AccountSummaryItem, TransactionsSummaryData,
} from '@/lib/ai/types';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`[PASS] ${name}`); }
  else { failures += 1; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0, i = haystack.indexOf(needle);
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

// ── Fixtures (pure; accounts from the AI-ARCH runtime test, transactions from ──
// the annotations.ti2 fixture). makeCtx assembles an accounts domain always and
// a transactions-summary domain only when `withTxn`, so the `if (txn)` path in
// the serializer can be exercised from both sides.
function debtAcct(id: string, name: string, balance: number, apr: number): AccountSummaryItem {
  return {
    id, name, type: 'debt', balance, currency: 'USD', reportingBalance: balance,
    lastUpdated: '2026-07-15T00:00:00.000Z', needsReauth: false, visibilityLevel: 'FULL',
    apr, rateSource: 'user', minimumPayment: null,
  };
}
function accountsData(): AccountsSectionData {
  const accounts = [debtAcct('A', 'Card A', 10000, 10), debtAcct('B', 'Card B', 5000, 20)];
  return {
    totalCount: accounts.length, totalAssets: 0, totalLiabilities: 15000, netWorth: -15000,
    totalLiquid: 0, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0, totalsEstimated: false,
    counts: { liquid: 0, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: accounts.length },
    health: { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] },
    knowledgeGaps: [], accounts,
  };
}
function txnData(): TransactionsSummaryData {
  return {
    windowDays: 90, startDate: '2026-04-01', endDate: '2026-06-30',
    transactionCount: 30, truncated: false, coverageStartDate: '2026-04-01', fetchLimit: 5000,
    incomeTotal: 1000, expenseTotal: 500, refundTotal: 0, debtPaymentTotal: 800,
    transferTotal: 0, netCashFlow: 500, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: 'PERSISTED_AND_READ_TIME',
    },
    byCategory: [{ category: 'Income', total: 0, count: 3 }],
    monthlyBreakdown: [], largestIncome: null, largestExpense: null,
  } as unknown as TransactionsSummaryData;
}
function makeCtx(withTxn: boolean): SpaceContext_AI {
  const domains: SpaceContext_AI['domains'] = {
    [FinanceDomains.ACCOUNTS]: { domain: 'accounts', assembledAt: '2026-07-15T00:00:00.000Z', data: accountsData() },
  };
  if (withTxn) {
    domains[FinanceDomains.TRANSACTIONS_SUMMARY] =
      { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: '2026-07-15T00:00:00.000Z', data: txnData() };
  }
  return {
    requestedAt: '2026-07-15T00:00:00.000Z', spaceId: 's1', userId: 'u1',
    role: 'OWNER' as SpaceContext_AI['role'], agentId: 'agent1',
    resolvedDomains: withTxn ? ['accounts', 'transactions'] : ['accounts'],
    space: { id: 's1', name: 'Test', type: 'personal', category: 'personal', reportingCurrency: 'USD' },
    domains, signals: [], auditLogId: 'log1',
  };
}

const ctxNoTxn = makeCtx(false);
const ctxTxn = makeCtx(true);
const route = classifyFinancialIntent('how much did I pay on each card', new Date());
const DEBT_LINES: DebtPaymentLine[] = [{ name: 'Card A', total: 500, count: 2 }];

// ── 1. Disclosure states the limit honestly (semantic anchors, not a snapshot) ─
check('disclosure names the ATTRIBUTION LIMIT', ATTRIBUTION_DISCLOSURE.includes('ATTRIBUTION LIMIT'));
check('disclosure says totals are NOT attributed to specific accounts/cards',
  ATTRIBUTION_DISCLOSURE.includes('NOT attributed to specific accounts'));
check('disclosure names the ONE exception (per-card debt payments)',
  /ONE exception[\s\S]*per-card debt payments/.test(ATTRIBUTION_DISCLOSURE));
check('disclosure warns any other split would be invented',
  ATTRIBUTION_DISCLOSURE.includes('would be invented'));

// ── 2. Rule is answer-first, generalized, and never licenses fabrication ───────
check('rule is answer-honesty, not refuse-the-question',
  ATTRIBUTION_RULE.includes('refuse only the missing dimension, never the whole question'));
{
  const answerIdx = ATTRIBUTION_RULE.indexOf('FIRST, answer every deterministic portion');
  const discloseIdx = ATTRIBUTION_RULE.indexOf('attribution is not available in this data');
  const altIdx = ATTRIBUTION_RULE.indexOf('Offer the nearest truthful alternative');
  check('rule answers the deterministic portion BEFORE disclosing the gap (not refusal-first)',
    answerIdx !== -1 && discloseIdx !== -1 && answerIdx < discloseIdx, `answer@${answerIdx} disclose@${discloseIdx}`);
  check('rule offers a truthful alternative AFTER the disclosure',
    altIdx !== -1 && altIdx > discloseIdx, `alt@${altIdx}`);
}
check('rule stays generalized to every unattributed dimension',
  ATTRIBUTION_RULE.includes('spending per card') &&
  ATTRIBUTION_RULE.includes('transfers per account') &&
  ATTRIBUTION_RULE.includes('income/interest/spending'));
check('rule forbids inventing a split (no unsupported certainty)',
  ATTRIBUTION_RULE.includes('any such split would be invented'));

// ── 3. Rule is embedded in the advisor principles (runtime membership) ─────────
check('ADVISOR_PRINCIPLES embeds the attribution rule verbatim',
  ADVISOR_PRINCIPLES.includes(ATTRIBUTION_RULE));

// ── 4. BEHAVIOR: the disclosure fires only inside the transaction path ─────────
check('no transactions → disclosure is NOT emitted (ordinary prompts unchanged)',
  !serializeContextBlock(ctxNoTxn).includes('ATTRIBUTION LIMIT'));
check('with transactions → disclosure IS emitted',
  serializeContextBlock(ctxTxn).includes(ATTRIBUTION_DISCLOSURE));
check('disclosure is emitted exactly once (single insertion)',
  countOccurrences(serializeContextBlock(ctxTxn), 'ATTRIBUTION LIMIT') === 1);

// ── 5. BEHAVIOR: per-card figures render only when supplied, with the honesty ──
// caveat, and never displace the still-unattributed dimensions.
{
  const withoutLines = serializeContextBlock(ctxTxn);
  const withLines = serializeContextBlock(ctxTxn, DEBT_LINES);
  // Anchor on text unique to the rendered block — the phrase "PER-LIABILITY DEBT
  // PAYMENTS" also appears inside the disclosure ("…line when present"), so it is
  // not a reliable presence marker for the block itself.
  const BLOCK_ANCHOR = 'settled debt-payment legs';
  check('no per-liability rollup → no PER-LIABILITY block',
    !withoutLines.includes(BLOCK_ANCHOR));
  check('per-liability rollup supplied → PER-LIABILITY block with the exact figures',
    withLines.includes(BLOCK_ANCHOR) && withLines.includes('Card A: '));
  check('per-liability block keeps the source/destination non-reconciliation honesty',
    withLines.includes('do not force them to reconcile'));
  check('per-liability block re-scopes the limit to the OTHER dimensions (still unattributed)',
    /remains unattributed|attribution\s+limit above still applies/.test(withLines));
}

// ── 6. BEHAVIOR: the assembled system prompt carries the rule always and the ───
// disclosure only when a transaction context is present.
{
  const promptTxn = buildSpaceSystemPrompt(ctxTxn, computeAssessment(ctxTxn), route, DEBT_LINES);
  const promptNoTxn = buildSpaceSystemPrompt(ctxNoTxn, computeAssessment(ctxNoTxn), route);
  check('system prompt always carries the attribution rule',
    promptTxn.includes(ATTRIBUTION_RULE) && promptNoTxn.includes(ATTRIBUTION_RULE));
  check('system prompt carries the disclosure only with a transaction context',
    promptTxn.includes('ATTRIBUTION LIMIT') && !promptNoTxn.includes('ATTRIBUTION LIMIT'));
}

// ── 7. Provenance seam (DB-coupled → minimal source check) ─────────────────────
// The ONE attributed dimension must be sourced from the deterministic Slice-3
// rollup THROUGH the KD-15 visibility-guarded data layer — never computed ad hoc.
// debt-payments.ts reads the DB, so this stays a source assertion (not runtime).
{
  const debtSrc = readFileSync(join(process.cwd(), 'lib/ai/intelligence/debt-payments.ts'), 'utf8');
  check('per-card figures come from lib/debt rollupDebtPaymentsByAccount (deterministic Slice-3)',
    debtSrc.includes('rollupDebtPaymentsByAccount('));
  check('per-card rows come through the KD-15 visibility-guarded getDebtTransactions',
    debtSrc.includes("import { getDebtTransactions } from '@/lib/data/transactions'"));
}

if (failures > 0) {
  console.error(`\n${failures} KD-18 check(s) failed.`);
  process.exit(1);
}
console.log('\nAll KD-18 attribution-guardrail checks passed.');
