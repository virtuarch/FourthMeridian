/**
 * lib/ai/prompts/system-prompt.aiarch.test.ts
 *
 * AI-ARCH runtime tests for the extracted prompt layer. Because serialization
 * now lives in pure, exportable modules (it used to be trapped inside the Next
 * route, un-exportable), these assertions run the real functions rather than
 * scanning source. Pure — no DB, no LLM; the test's own success proves the
 * serializer performs no I/O.
 *
 * Covers (Part 9): deterministic serializer, prompt honesty (no figure the
 * context does not contain; no fabricated transaction window), and the grounded
 * guardrails the system prompt must always carry.
 *
 * Run from the repo root. Exits 0 on pass, 1 on failure.
 */

import { buildSpaceSystemPrompt } from './system-prompt';
import { serializeContextBlock } from './context-serializer';
import { serializeAssessmentBlock } from './assessment-serializer';
import { computeAssessment } from '@/lib/ai/intelligence';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { FinanceDomains } from '@/lib/ai/types';
import type { SpaceContext_AI, AccountsSectionData, AccountSummaryItem } from '@/lib/ai/types';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Fixture: a Space with two debt accounts and NO transactions domain ────────
function debtAcct(id: string, name: string, balance: number, apr: number): AccountSummaryItem {
  return {
    id, name, type: 'debt', balance, currency: 'USD', reportingBalance: balance,
    lastUpdated: '2026-07-15T00:00:00.000Z', needsReauth: false, visibilityLevel: 'FULL',
    apr, rateSource: 'user', minimumPayment: null,
  };
}

function makeCtx(): SpaceContext_AI {
  const accounts = [debtAcct('A', 'Card A', 10000, 10), debtAcct('B', 'Card B', 5000, 20)];
  const totalLiabilities = 15000;
  const data: AccountsSectionData = {
    totalCount: accounts.length, totalAssets: 0, totalLiabilities, netWorth: -totalLiabilities,
    totalLiquid: 0, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0, totalsEstimated: false, totalsUnconverted: false,
    counts: { liquid: 0, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: accounts.length },
    health: { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] },
    knowledgeGaps: [], accounts,
  };
  return {
    requestedAt: '2026-07-15T00:00:00.000Z', spaceId: 's1', userId: 'u1',
    role: 'OWNER' as SpaceContext_AI['role'], agentId: 'agent1', resolvedDomains: ['accounts'],
    space: { id: 's1', name: 'Test', type: 'personal', category: 'personal', reportingCurrency: 'USD' },
    domains: { [FinanceDomains.ACCOUNTS]: { domain: 'accounts', assembledAt: '2026-07-15T00:00:00.000Z', data } },
    signals: [], auditLogId: 'log1',
  };
}

const ctx = makeCtx();
const assessment = computeAssessment(ctx);
const route = classifyFinancialIntent('how is my debt looking', new Date());

// ── 1. Deterministic serializer ───────────────────────────────────────────────
{
  const a = buildSpaceSystemPrompt(ctx, assessment, route);
  const b = buildSpaceSystemPrompt(ctx, assessment, route);
  check('buildSpaceSystemPrompt is deterministic (same inputs → identical output)', a === b);
  check('serializeContextBlock is deterministic',
    serializeContextBlock(ctx) === serializeContextBlock(ctx));
  check('serializeAssessmentBlock is deterministic',
    serializeAssessmentBlock(assessment) === serializeAssessmentBlock(assessment));
}

// ── 2. Grounded guardrails always present ─────────────────────────────────────
{
  const prompt = buildSpaceSystemPrompt(ctx, assessment, route);
  check('prompt grounds the model to supplied context only',
    prompt.includes('Answer using ONLY the supplied financial context.'));
  check('prompt carries the === FINANCIAL ASSESSMENT === block', prompt.includes('=== FINANCIAL ASSESSMENT ==='));
  check('prompt carries the === SPACE CONTEXT === block', prompt.includes('=== SPACE CONTEXT ==='));
  check('prompt carries the attribution-honesty rule',
    prompt.includes('Attribution honesty — refuse only the missing dimension, never the whole question:'));
  check('prompt carries the question-routing block', prompt.includes('=== QUESTION ROUTING ==='));
}

// ── 3. Prompt honesty — figures trace to the context; no fabricated window ────
{
  const block = serializeAssessmentBlock(assessment);
  // The serialized debt figure must equal the fixture-derived total.
  check('assessment serializes the exact total liabilities from context',
    block.includes('Total liabilities: $15,000.00'),
    block.split('\n').find((l) => l.includes('Total liabilities')) ?? 'not found');
  check('serialized debt total matches computeAssessment (no drift)',
    assessment.debt.totalLiabilities === 15000);

  // No transactions domain → the serializer must NOT fabricate a transaction
  // window, average-spending line, or attribution disclosure.
  const ctxBlock = serializeContextBlock(ctx);
  check('no transaction data → no fabricated analysis window',
    !ctxBlock.includes('Transaction analysis window'));
  check('no transaction data → no fabricated average-spending figure',
    !ctxBlock.includes('AVERAGE MONTHLY SPENDING'));
  check('no transaction data → attribution disclosure is not emitted',
    !ctxBlock.includes('ATTRIBUTION LIMIT'));
}

if (failures.length > 0) {
  console.error(`\nAI-ARCH prompt runtime: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`AI-ARCH prompt runtime: all ${passed} checks passed.`);
process.exit(0);
