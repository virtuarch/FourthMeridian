/**
 * lib/ai/prompts/authority-precedence.test.ts  (A3)
 *
 * THE MODEL-FACING AUTHORITY CONTRACT.
 *
 * A1 pinned that computeAssessment is deterministic. A2 gave it a trajectory
 * verdict. Neither is worth anything downstream if the prompt does not tell the
 * model what to DO with a deterministic verdict — and before A3 it did not.
 * The prompt said "read the assessment before drawing conclusions from raw
 * context", which is an ORDERING instruction. A model that read it first and
 * then reasoned to a different conclusion from the same numbers broke no rule.
 *
 * These tests pin the INSTRUCTIONS and the SERIALIZATION mechanically. They do
 * not attempt to prove stochastic model behaviour — there is no deterministic
 * harness for that yet, and asserting it here would be theatre. Measuring
 * whether the model actually obeys this contract is A4.
 */

import { buildSpaceSystemPrompt, buildMasterSystemPrompt } from './system-prompt';
import { AUTHORITY_PRECEDENCE, ADVISOR_PRINCIPLES, EXECUTIVE_SUMMARY_DOCTRINE } from './doctrine';
import { computeAssessment } from '@/lib/ai/intelligence';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { FinanceDomains } from '@/lib/ai/types';
import type { SpaceContext_AI } from '@/lib/ai/types';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function mkCtx(over: { accounts?: unknown[]; incomeCount?: number } = {}): SpaceContext_AI {
  const accounts = over.accounts ?? [
    { id: 'd1', name: 'Card', type: 'debt', balance: 40_000, currency: 'USD', reportingBalance: 40_000, apr: 29, visibilityLevel: 'FULL' },
    { id: 'c1', name: 'Chk', type: 'checking', balance: 20_000, currency: 'USD', reportingBalance: 20_000, visibilityLevel: 'FULL' },
  ];
  return {
    requestedAt: '2026-06-30T00:00:00.000Z',
    spaceId: 's', userId: 'u', role: 'OWNER', agentId: 'a', resolvedDomains: [],
    space: { id: 's', name: 'S', type: 'personal', category: 'personal', reportingCurrency: 'USD' },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: 'x', data: {
        windowDays: 90, startDate: '2026-04-01', endDate: '2026-06-30', transactionCount: 40,
        truncated: false, coverageStartDate: '2026-04-01', fetchLimit: 5000,
        incomeTotal: 500, expenseTotal: 6000, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0,
        netCashFlow: -5500, estimated: false,
        pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
        unclassifiedCount: 0, adjustmentCount: 0,
        needsClassification: { count: 0, unknownInflowCount: 0, unknownInflowTotal: 0, unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0, counterpartyResolution: 'PERSISTED_AND_READ_TIME' },
        byCategory: [{ category: 'Income', total: 0, count: over.incomeCount ?? 1 }],
        monthlyBreakdown: [], largestIncome: null, largestExpense: null,
      } },
      [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: 'x', data: { snapshotCount: 60, history: [] } },
      [FinanceDomains.ACCOUNTS]: { domain: FinanceDomains.ACCOUNTS, assembledAt: 'x', data: {
        totalCount: 2, totalAssets: 50_000, totalLiabilities: 40_000, netWorth: 10_000,
        totalLiquid: 20_000, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0,
        totalsEstimated: false, totalsUnconverted: false,
        counts: { liquid: 1, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 1 },
        health: { errorCount: 0, errorAccountNames: [], staleCount: 0, needsReauthCount: 0 },
        knowledgeGaps: [], accounts,
      } },
    },
    signals: [], auditLogId: 'al',
  } as unknown as SpaceContext_AI;
}

const ctx        = mkCtx();
const assessment = computeAssessment(ctx);
const route      = classifyFinancialIntent('how am I doing', new Date('2026-06-30T00:00:00.000Z'));
const prompt     = buildSpaceSystemPrompt(ctx, assessment, route);

console.log('\n[A3] authority precedence contract\n');

// ── 1. Ordering ──────────────────────────────────────────────────────────────
{
  const iAssess = prompt.indexOf('=== FINANCIAL ASSESSMENT ===');
  const iCtx    = prompt.indexOf('=== SPACE CONTEXT ===');
  check('1. assessment block precedes raw space context',
    iAssess > -1 && iCtx > -1 && iAssess < iCtx, `assess@${iAssess} ctx@${iCtx}`);
  check('1b. precedence doctrine precedes BOTH blocks',
    prompt.indexOf('Authority precedence') > -1 &&
    prompt.indexOf('Authority precedence') < iAssess);
}

// ── 2–5. The precedence rules are actually stated ────────────────────────────
{
  check('2. deterministic verdicts are declared AUTHORITATIVE',
    /AUTHORITATIVE/.test(prompt) && /deterministic verdicts/i.test(prompt));
  check('3. raw context may not override a verdict',
    /may NOT reverse it/.test(prompt) &&
    /do not (silently reconcile|prefer the raw figure)/i.test(prompt));
  check('4. refusals are preserved and override',
    /REFUSALS OVERRIDE ALL OF THE ABOVE/.test(prompt) &&
    /INSUFFICIENT_DATA, UNKNOWN, UNRELIABLE, or BLOCKED_BY_DATA/.test(prompt) &&
    /do not substitute an estimate/i.test(prompt));
  check('5. direction is distinguished from current standing',
    /TRAJECTORY describes DIRECTION, not standing/.test(prompt));
}

// ── 6. The lead-source contradiction is resolved, not merely duplicated ──────
{
  // PROVEN reachable: currentStatePriority is a fixed ladder returning
  // DATA_QUALITY first; risks sort by severity. Both are asserted below.
  const conflict = computeAssessment(mkCtx({ incomeCount: 1 }));
  check('6a. ANTI-VACUITY: the two lead sources genuinely disagree here',
    conflict.currentStatePriority === 'DATA_QUALITY' &&
    conflict.riskOpportunities.risks[0]?.code === 'HIGH_INTEREST_DEBT' &&
    conflict.riskOpportunities.risks[0]?.severity === 'critical',
    `priority=${conflict.currentStatePriority} topRisk=${conflict.riskOpportunities.risks[0]?.code}`);
  check('6b. currentStatePriority is scoped to TOPIC, not declared the sole lead',
    /currentStatePriority names the TOPIC/.test(prompt));
  check('6c. the DATA_QUALITY vs critical-balance-risk conflict has a stated resolution',
    /never demotes a critical balance-derived finding/.test(prompt));
  check('6d. the two doctrine blocks cross-reference instead of competing',
    /are not two competing leads/.test(prompt));
}

// ── 7. Unassessed domains are not falsely labelled assessed ──────────────────
{
  check('7a. context-only domains are named and scoped',
    /CONTEXT-ONLY/.test(prompt) &&
    /net worth and asset composition, holdings and investment detail, real assets/.test(prompt));
  check('7b. the model is told not to invent a grade where none exists',
    /never as graded findings/.test(prompt) && /do not invent a rating of your own/.test(prompt));
  // Anti-overcentralisation: the assessed list must NOT claim the unassessed ones.
  const authoritative = AUTHORITY_PRECEDENCE.slice(
    AUTHORITY_PRECEDENCE.indexOf('1. AUTHORITATIVE'),
    AUTHORITY_PRECEDENCE.indexOf('2. EVIDENCE'),
  );
  check('7c. the AUTHORITATIVE list does not claim net worth / holdings',
    !/net worth/i.test(authoritative) && !/holdings/i.test(authoritative),
    'assessment must not claim authority over dimensions it does not grade');
}

// ── 8. Contradiction handling separates data-inconsistency from disagreement ─
{
  check('8. "possible data inconsistency" is a distinct, permitted statement',
    /possible data inconsistency/.test(prompt) &&
    /only the first is yours to make/.test(prompt));
}

// ── 9. No duplicate/conflicting lead claims ──────────────────────────────────
{
  // A LEAD-SOURCE claim is a line that both talks about leading AND names a
  // conclusion-ranking concept (risk / opportunity / priority / conclusion).
  // Deliberately NOT matched: "when the user asks about their current position
  // ... lead with current values from the accounts domain" — that selects which
  // DATA answers a question class, not which conclusion source outranks another.
  // Conflating the two would either fail a compatible rule or force the filter
  // so wide it stops meaning anything.
  const all = [ADVISOR_PRINCIPLES, EXECUTIVE_SUMMARY_DOCTRINE].join('\n');
  const leadClaims = all.split('\n').filter((l) =>
    /lead/i.test(l) && /(risk|opportunit|priority|conclusion)/i.test(l));
  check('9a. ANTI-VACUITY: lead-claiming lines exist to be checked', leadClaims.length >= 2,
    `${leadClaims.length} found`);
  check('9b. every lead-claiming line either scopes itself or cross-references the other',
    leadClaims.every((l) =>
      /names the TOPIC/.test(l) || /not two competing leads/.test(l) ||
      /never demotes a critical/.test(l) || /Do not restate every assessment section/.test(l) ||
      /Answer the user's actual question in the first sentence/.test(l)),
    leadClaims.find((l) => !/names the TOPIC|not two competing leads|never demotes a critical|Do not restate every assessment section|Answer the user's actual question/.test(l)));
}

// ── 10–11. Determinism and isolation ─────────────────────────────────────────
{
  check('10. unrelated raw context cannot alter the serialized ASSESSMENT block',
    (() => {
      const slice = (p: string) => p.slice(p.indexOf('=== FINANCIAL ASSESSMENT ==='), p.indexOf('=== END ASSESSMENT ==='));
      const noisy = mkCtx({ accounts: [
        { id: 'd1', name: 'Card', type: 'debt', balance: 40_000, currency: 'USD', reportingBalance: 40_000, apr: 29, visibilityLevel: 'FULL' },
        { id: 'c1', name: 'Chk', type: 'checking', balance: 20_000, currency: 'USD', reportingBalance: 20_000, visibilityLevel: 'FULL' },
        { id: 'r1', name: 'House', type: 'other', balance: 900_000, currency: 'USD', reportingBalance: 900_000, visibilityLevel: 'FULL' },
      ] });
      return slice(buildSpaceSystemPrompt(noisy, computeAssessment(noisy), route)) === slice(prompt);
    })());
  check('11. buildSpaceSystemPrompt remains deterministic',
    buildSpaceSystemPrompt(ctx, assessment, route) === prompt);
}

// ── 12. Structural fence: no prompt builder may invert the order ─────────────
// A unit test covers the two builders that exist TODAY. This scan is the fence
// against a THIRD one appearing later without the contract — the structural
// class an ordinary fixture test cannot reach. Cheaper and tighter than a new
// REQUIRED audit, which would gate CI on a source property with one owner file.
{
  const src = readFileSync('lib/ai/prompts/system-prompt.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const builders = [...src.matchAll(/export function (build\w*SystemPrompt)/g)].map((m) => m[1]);
  check('12a. ANTI-VACUITY: prompt builders were found to scan', builders.length >= 2,
    builders.join(', '));
  // In every builder body, the assessment marker must appear before the context one.
  const iA = src.indexOf("'=== FINANCIAL ASSESSMENT ==='");
  const iC = src.indexOf("'=== SPACE CONTEXT ==='");
  check('12b. source order places assessment before context', iA > -1 && iC > -1 && iA < iC);
  check('12c. every builder emits the precedence doctrine',
    (src.match(/AUTHORITY_PRECEDENCE/g) ?? []).length >= builders.length,
    `${(src.match(/AUTHORITY_PRECEDENCE/g) ?? []).length} references for ${builders.length} builders`);
  check('12d. the master builder labels its blocks too',
    (src.match(/AUTHORITATIVE — deterministic verdicts/g) ?? []).length >= 2);
}

// ── A4.1 — the two defects A4 MEASURED, pinned as prompt-contract regressions ─
//
// These are not hypothetical. Each corresponds to an observed violation in the
// A4 corpus, so a future doctrine edit that silently removes the repair fails
// here instead of being rediscovered by paying for another 36 model calls.
{
  // DEFECT 1 — refusal is the answer, not a caveat to defer.
  check('A4.1-1. a refused conclusion is declared to BE the answer',
    /the refusal IS the answer/.test(prompt) &&
    /UNKNOWN \/ UNRELIABLE \/ INSUFFICIENT_DATA \/ BLOCKED_BY_DATA/.test(prompt));
  check('A4.1-2. "do not lead with caveats" cannot subordinate a refusal',
    /EXCEPT where the assessment refuses the very conclusion being asked for/.test(prompt));
  // The contract caps CERTAINTY, not phrasing: the model may still discuss what
  // the evidence leans toward, in calibrated language, and stays free to vary
  // tone and ordering. Only a flat assertion of the refused conclusion violates.
  check('A4.1-3. the rule is epistemic — certainty may not exceed the assessment',
    /PRESERVE THE EPISTEMIC STATUS/.test(prompt) &&
    /certainty must never exceed the assessment/.test(prompt));
  check('A4.1-3b. calibrated discussion of the evidence is explicitly permitted',
    /you may still discuss the direction the evidence suggests/.test(prompt) &&
    /"appears", "may", "leans toward"/.test(prompt));
  check('A4.1-3c. a FLAT assertion is the violation, not the sentence order',
    /The violation is a flat assertion, not the order of your sentences/.test(prompt) &&
    /free to vary tone, ordering and explanation/.test(prompt));
  check('A4.1-3d. arithmetic may not be used to assert a refused conclusion',
    /reaching it by subtraction does not make it available/.test(prompt));

  // DEFECT 2 — classifications are dimension-bound.
  check('A4.1-4. classifications belong to the dimension that produced them',
    /Every classification belongs to the ONE dimension that produced it/.test(prompt));
  check('A4.1-5. transplanting a verdict is named and forbidden',
    /Do not relabel, transplant, generalize or re-attach a verdict/.test(prompt));
  check('A4.1-5b. the exact F09 violation is spelled out',
    /portfolio health: BUILD_LIQUIDITY_FIRST/.test(prompt) &&
    /investmentReadiness verdict is about readiness to invest, not about portfolio health/.test(prompt));
  check('A4.1-6. an ungraded domain cannot borrow a grade from elsewhere',
    /does not acquire a grade by borrowing one that appears elsewhere/.test(prompt));

  // The A4.1 repair must not have disturbed what A3 established.
  check('A4.1-7. A3 authority hierarchy is unchanged',
    /1\. AUTHORITATIVE/.test(prompt) && /2\. EVIDENCE/.test(prompt) &&
    /3\. CONTEXT-ONLY/.test(prompt) && /REFUSALS OVERRIDE ALL OF THE ABOVE/.test(prompt));
  check('A4.1-8. the DATA_QUALITY vs critical-balance resolution is unchanged',
    /never demotes a critical balance-derived finding/.test(prompt) &&
    /currentStatePriority names the TOPIC/.test(prompt));
  check('A4.1-9. answer-first still holds for questions that are NOT refused',
    /Answer the user's actual question in the first sentence/.test(prompt),
    'the repair must scope the rule, not delete it');
}

// ── Master prompt carries the same contract ─────────────────────────────────
{
  const master = buildMasterSystemPrompt([ctx], [assessment], route);
  check('13. master (cross-Space) prompt carries the precedence doctrine',
    master.includes('Authority precedence'));
  check('14. master prompt orders assessment before context',
    master.indexOf('=== FINANCIAL ASSESSMENT ===') < master.indexOf('=== SPACE CONTEXT ==='));
}

if (failures > 0) { console.error(`\n[A3] ${failures} FAILED`); process.exit(1); }
console.log('\n[A3] authority precedence: all checks passed.');
