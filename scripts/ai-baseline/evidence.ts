/**
 * scripts/ai-baseline/evidence.ts
 *
 * THE FOUR EVIDENCE ARMS — what each one puts in front of the model.
 *
 * The two experimental dimensions are MODEL QUALITY and EVIDENCE STRATEGY; this
 * file owns the second. Each arm answers one question and the questions are
 * deliberately different, so a result is attributable:
 *
 *   A0  full context, NO assessment    can a model judge relevance and
 *                                      materiality from clean evidence alone?
 *   A1  full context + assessment      does the deterministic verdict layer help
 *                                      the conversation, or fight it?
 *   A2  thin core + tools              is a compact orientation plus retrieval
 *                                      on demand enough?
 *   A3  orientation only + tools       can model tool selection replace
 *                                      deterministic routing entirely?
 *
 * ⚠️ A0/A1 ASSEMBLE ALL FOUR DOMAINS EXPLICITLY AND DO NOT ROUTE. `resolveDomains`
 * excludes `holdings_summary` from "how am I looking financially?" on a Space
 * that is 66% crypto by net worth (measured, investigation §5a). Running it here
 * would silently hand the "broad context" arms a third of the picture and make
 * every arm a test of the router instead of a test of the evidence. Deterministic
 * routing is what A3 is measured AGAINST; it must not run inside its rivals.
 *
 * ⚠️ NO SYSTEM PROMPT IS BUILT HERE. The behavioural instruction lives in run.ts,
 * is ~140 words, and is identical in every arm. Evidence is data, appended as its
 * own message; doctrine is not evidence.
 */

import { getAssembler } from '@/lib/ai/assembler-registry';
import {
  FinanceDomains,
  type AccountsSectionData, type TransactionsSummaryData,
  type SnapshotSectionData, type HoldingsSummaryData,
  type ContextDomainSection, type SpaceContext_AI,
} from '@/lib/ai/types';
import { computeAssessment } from '@/lib/ai/intelligence';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import { loadCoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { runSignalDetectors } from '@/lib/ai/signals';
import type { SpaceContext } from '@/lib/space';
import { recallMemories, MemoryKind } from './memory-store';

export const ARMS = ['A0', 'A1', 'A2', 'A3'] as const;
export type Arm = (typeof ARMS)[number];

export const ARM_QUESTION: Record<Arm, string> = {
  A0: 'Can a capable model infer relevance and materiality from clean financial evidence alone?',
  A1: 'Does computeAssessment improve the conversation, or pull it toward missing-APR warnings?',
  A2: 'Is a compact orientation plus tool-driven retrieval enough?',
  A3: 'Can model tool selection replace deterministic semantic routing?',
};

export const ARM_USES_TOOLS: Record<Arm, boolean> = { A0: false, A1: false, A2: true, A3: true };

const FOUR_DOMAINS = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.SNAPSHOT_HISTORY,
  FinanceDomains.HOLDINGS_SUMMARY,
];

/** Assemble the four domains directly — no router, no audit row. */
export async function assembleFullContext(
  spaceCtx: SpaceContext, agentId: string,
): Promise<SpaceContext_AI> {
  const domains: Record<string, ContextDomainSection> = {};
  await Promise.all(FOUR_DOMAINS.map(async (d) => {
    const a = getAssembler(d);
    if (!a) return;
    try {
      const section = await a(spaceCtx, { scopeHint: 'full', positionClass: 'ALL' });
      if (section) domains[d] = section;
    } catch (err) {
      console.error(`[evidence] assembler ${d} threw:`, err);
    }
  }));
  return {
    requestedAt: new Date().toISOString(),
    spaceId: spaceCtx.spaceId, userId: spaceCtx.userId, role: spaceCtx.role,
    agentId, resolvedDomains: Object.keys(domains),
    space: {
      id: spaceCtx.space.id, name: spaceCtx.space.name, type: spaceCtx.space.type,
      category: spaceCtx.space.category, reportingCurrency: spaceCtx.space.reportingCurrency,
    },
    domains,
    signals: runSignalDetectors(domains, spaceCtx.spaceId),
    auditLogId: 'baseline-experiment',
  };
}

export interface EvidencePack {
  arm: Arm;
  /** The message body handed to the model as evidence, or null for none. */
  body: string | null;
  /** For the report: what this arm was given, in one line. */
  summary: string;
  /** Whether computeAssessment was included. Asserted by test. */
  includesAssessment: boolean;
  approxTokens: number;
}

const tok = (s: string) => Math.ceil(s.length / 4);

/**
 * The THIN CORE for A2 — a compact orientation, not a context dump.
 *
 * Everything here answers "where am I, roughly, and what can I ask about?".
 * Deliberately excludes: per-account rows, the snapshot series, category and
 * merchant rollups, position detail. Those are what the tools are for.
 */
function thinCore(ctx: SpaceContext_AI): Record<string, unknown> {
  const acc  = ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;
  const txn  = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as TransactionsSummaryData | undefined;
  const snap = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY]?.data as SnapshotSectionData | undefined;
  return {
    space: ctx.space.name, currency: ctx.space.reportingCurrency ?? 'USD',
    current: acc ? {
      // ⚠️ `liquid`, NOT `cash`. Slice 1 removed that name from every tool result
      // because the exploration tree's `cash` lens is CHECKING ALONE while this
      // is checking plus savings — on 2026-01-01, $1,255.20 against $9,517.46. The
      // orientation core was still handing the model the collided name, one file
      // outside the scan that caught it.
      netWorth: acc.netWorth, liquid: acc.totalLiquid, totalAssets: acc.totalAssets,
      liabilities: acc.totalLiabilities, accountCounts: acc.counts,
      investments: composeInvestments(acc),
    } : null,
    recent: txn ? {
      window: { from: txn.startDate, to: txn.endDate, days: txn.windowDays },
      income: txn.incomeTotal, spending: txn.expenseTotal,
      cardAndDebtPayments: txn.debtPaymentTotal, netCashFlow: txn.netCashFlow,
      transactionCount: txn.transactionCount,
    } : null,
    netWorthHistory: snap?.latest ? {
      latest: snap.latest.date, pointsInContext: snap.snapshotCount,
      earliest: snap.oldestDate, changeThisMonth: snap.canonicalChange,
    } : null,
    signals: ctx.signals.map((s) => `${s.severity}: ${s.title}`),
    note: 'This is an orientation only. Use the tools for anything specific.',
  };
}

/** How many intentions the orientation will name before it stops listing them. */
const MAX_CORE_INTENTIONS = 8;

/**
 * The active-intentions line — subjects and targets, never balances.
 *
 * ⚠️ IT IS HERE BECAUSE THE MEASUREMENT DEMANDED IT, and it was measured before
 * it was built. The investigation proposed this as "one concession worth
 * testing: drop it if the model finds goals without it". Run without it: the
 * user said "I want to hit $1M by 2030" and the model answered well, recorded
 * NOTHING, and a fresh session asked "how are we doing?" answered from balances
 * alone and never called `recall`. Zero rows written, zero reads. A capability
 * nothing reaches for is not a capability.
 *
 * ⚠️ IT IS NOT DOCTRINE, AND IT DELIBERATELY DID NOT GO IN THE SYSTEM PROMPT.
 * That instruction is ~140 words and the experiment's rule is that growth in it
 * is itself a finding. This is evidence — the same shape as the coverage
 * envelope beside it — and it says what exists, not how to behave.
 *
 * Targets, dates and subjects only. No balance can appear here, because no
 * memory payload can hold one.
 */
async function activeIntentions(spaceId: string, ownerUserId: string) {
  const rows = await recallMemories({ spaceId, ownerUserId }, { kind: MemoryKind.INTENTION });
  if (rows.length === 0) {
    return { count: 0,
      note: 'Nothing has been recorded for this user yet. When they state a goal, a plan, or '
        + 'a change of mind, record it with `remember` so a later session can pick it up.' };
  }
  return {
    count: rows.length,
    items: rows.slice(0, MAX_CORE_INTENTIONS).map((r) => {
      const p = r.payload as Record<string, unknown>;
      return { subject: r.subject, statedAt: r.statedAt.slice(0, 10),
        target: p.targetMetric
          ? `${p.targetAmount} ${p.targetMetric} by ${p.byDate}`
          : `${p.label} ~${p.amount}${p.earliest ? ` from ${p.earliest}` : ''}` };
    }),
    note: 'What this user has decided. Call `recall` for the words they used and the full '
      + 'history; call the financial tools for where they actually stand.',
  };
}

/** Build the evidence for one arm. */
export async function buildEvidence(
  arm: Arm, ctx: SpaceContext_AI, spaceId: string,
): Promise<EvidencePack> {
  if (arm === 'A3') {
    return {
      arm, body: null, includesAssessment: false, approxTokens: 0,
      summary: 'no financial evidence — tools only',
    };
  }

  if (arm === 'A2') {
    const [envelope, intentions] = await Promise.all([
      loadCoverageEnvelope(spaceId),
      activeIntentions(spaceId, ctx.userId),
    ]);
    const body = JSON.stringify(
      { ...thinCore(ctx), evidenceCoverage: envelope, activeIntentions: intentions }, null, 1);
    return {
      arm, body: `FINANCIAL ORIENTATION\n${body}`, includesAssessment: false,
      approxTokens: tok(body),
      summary: 'thin core + coverage envelope + active intentions, tools available',
    };
  }

  // A0 / A1 — the whole assembled context.
  const payload: Record<string, unknown> = {
    asOf: ctx.requestedAt,
    space: ctx.space,
    accounts:     ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined,
    transactions: ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as TransactionsSummaryData | undefined,
    netWorthHistory: ctx.domains[FinanceDomains.SNAPSHOT_HISTORY]?.data as SnapshotSectionData | undefined,
    positions:    ctx.domains[FinanceDomains.HOLDINGS_SUMMARY]?.data as HoldingsSummaryData | undefined,
    investmentComposition: (() => {
      const acc = ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;
      return acc ? composeInvestments(acc) : null;
    })(),
    signals: ctx.signals,
  };

  if (arm === 'A1') {
    // ⚠️ UNMODIFIED, ON PURPOSE. The investigation measured $25.46 of liabilities
    // producing seven assessment outputs. Softening it before the comparison
    // would destroy the only thing A1 exists to measure.
    payload.deterministicAssessment = computeAssessment(ctx);
  }

  const body = JSON.stringify(payload, null, 1);
  return {
    arm, body: `FINANCIAL EVIDENCE\n${body}`,
    includesAssessment: arm === 'A1',
    approxTokens: tok(body),
    summary: arm === 'A0'
      ? 'full assembled context, assessment WITHHELD, no tools'
      : 'full assembled context + computeAssessment, no tools',
  };
}
