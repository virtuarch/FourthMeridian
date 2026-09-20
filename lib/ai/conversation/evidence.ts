/**
 * lib/ai/conversation/evidence.ts
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
import { composeMemoryLine, MEMORY_LINE_RULES } from './memory-model';
import { transactionCorpusSpan } from '@/lib/data/transaction-query';
import { todayUTCISO } from '@/lib/time/clock';
import {
  resolveActivityWindow, projectActivityFrame, type ActivityFrame,
} from './activity-frame';

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

/**
 * The instant this orientation describes: the end of the window `recent`'s own
 * figures were measured over. Reading it from the assessment section rather than
 * from a clock is what keeps `activity` and `recent` on the same day — and it
 * means a caller that assembles the context retrospectively gets a coherent
 * orientation without passing anything.
 */
function assessmentCeiling(ctx: SpaceContext_AI): string {
  const txn = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as
    TransactionsSummaryData | undefined;
  return txn?.endDate ?? todayUTCISO();
}

/**
 * Assemble the trailing-six-month frame, or return null when it must not exist.
 *
 * ⚠️ THE WINDOW IS RESOLVED BEFORE ANYTHING IS ASSEMBLED. A frame that will not
 * be emitted therefore costs NO extra query — the existence rule is decided from
 * `asOf` and the corpus bound alone, and the second TRANSACTIONS_SUMMARY runs
 * exactly once, only when there is a frame to measure.
 *
 * ⚠️ THE THRESHOLD IS READ FROM `recent`, NOT RE-DECLARED. `windowDays` comes
 * from the assessment section this orientation already holds, so
 * `2 × ASSESSMENT_WINDOW_DAYS` cannot drift from W4 — there is no second copy of
 * the number to go stale.
 */
async function buildActivityFrame(
  ctx: SpaceContext_AI, spaceCtx: SpaceContext, asOf: string,
): Promise<ActivityFrame | null> {
  const txn = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as
    TransactionsSummaryData | undefined;
  if (!txn?.windowDays) return null;

  // 55a2c22 — the corpus bound taken UNDER the ceiling, so a retrospective
  // orientation cannot learn from the frame's existence that later history runs on.
  const { from: coverageFrom } = await transactionCorpusSpan({ spaceId: spaceCtx.spaceId, asOf });
  const window = resolveActivityWindow({
    asOf, coverageFrom, assessmentWindowDays: txn.windowDays,
  });
  if (!window) return null;

  const assembler = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  if (!assembler) return null;
  try {
    const section = await assembler(
      spaceCtx,
      { scopeHint: 'full', transactionWindow: {
        startDate: window.from, endDate: window.to, label: `activity ${window.from}..${window.to}` } },
    );
    const data = section?.data as TransactionsSummaryData | undefined;
    return data ? projectActivityFrame(data) : null;
  } catch (err) {
    // Non-fatal by construction: a failed second frame must never cost the
    // orientation its assessment. The single-frame body is the proven control.
    console.error('[evidence] activity frame threw:', err);
    return null;
  }
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
function thinCore(
  ctx: SpaceContext_AI,
  /**
   * The trailing-six-month measured frame, or null when it must not exist.
   * Placed as a SIBLING of `recent` and only when present — the key is omitted,
   * never null. See activity-frame.ts for why both of those are load-bearing.
   */
  activity: ActivityFrame | null = null,
): Record<string, unknown> {
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
    // ⚠️ SIBLING OF `recent`, NOT A FIELD INSIDE IT, AND OMITTED WHEN ABSENT.
    // `recent` above is byte-for-byte what it was before this key existed; the
    // second frame adds a view and changes nothing about the assessment.
    ...(activity ? { activity } : {}),
    netWorthHistory: snap?.latest ? {
      latest: snap.latest.date, pointsInContext: snap.snapshotCount,
      earliest: snap.oldestDate, changeThisMonth: snap.canonicalChange,
    } : null,
    signals: ctx.signals.map((s) => `${s.severity}: ${s.title}`),
    // ⚠️ M1 — THE PROHIBITION SITS ON THE EVIDENCE THAT GETS DIVIDED. A tool
    // description cannot reach a turn in which no tool is considered, and that is
    // exactly where the defect lived: told "keep six months of expenses…", the
    // model made zero calls, divided `recent.spending` by three ("about
    // $5.4k/month") and built a $32k cushion on it — 3 of 6 runs. Both frames
    // above are byte-for-byte unchanged; only this sentence, which was already
    // the orientation's own instruction about itself, says what it must not be
    // used for and where those figures come from instead.
    note: 'This is an orientation only. Use the tools for anything specific. `recent` and '
      + '`activity` are WINDOW TOTALS that include partial months: never divide or multiply them '
      + 'into a monthly figure, a surplus, a savings rate, a runway or "N months of expenses" — '
      + 'those are computed by the tools, with their window and basis named.',
  };
}

/**
 * The memory line — what this user asked us to remember, as they stated it.
 *
 * ⚠️ IT IS HERE BECAUSE THE MEASUREMENT DEMANDED IT, and it was measured before
 * it was built. The investigation proposed it as "one concession worth testing:
 * drop it if the model finds goals without it". Run without it: the user said
 * "I want to hit $1M by 2030" and the model answered well, recorded NOTHING, and
 * a fresh session asking "how are we doing?" answered from balances alone and
 * never called `recall`. Zero rows written, zero reads. A capability nothing
 * reaches for is not a capability.
 *
 * ⚠️ IT IS NOT DOCTRINE, AND IT DELIBERATELY DID NOT GO IN THE SYSTEM PROMPT.
 * That instruction is ~140 words and the experiment's rule is that growth in it
 * is itself a finding. This is evidence — the same shape as the coverage
 * envelope beside it — and it says what exists, not how to behave.
 *
 * ⚠️ THE READS ARE HERE; EVERYTHING DECIDED IS PURE. `composeMemoryLine`
 * (`memory-model.ts`) reads every row through the one fail-closed reader and the
 * one in-force rule, so the line, `recall`, the starters and the Brief cannot
 * disagree about what a stored row means. It speaks for ALL of memory — goals,
 * rules, planning figures, plans and the projections on record — because a
 * summary covering part of a store must not narrate the whole of it. One read
 * per kind, so a long run of projection horizons cannot crowd the goals out.
 *
 * No balance can appear here: no class has a field that could hold one, and a
 * projection contributes its horizon only.
 */
async function memoryLine(spaceId: string, ownerUserId: string, todayISO: string) {
  const scope = { spaceId, ownerUserId };
  const rows = (await Promise.all([
    recallMemories(scope, { kind: MemoryKind.INTENTION }),
    recallMemories(scope, { kind: MemoryKind.ASSUMPTION }),
    recallMemories(scope, { kind: MemoryKind.CHECKPOINT }),
  ])).flat();
  return composeMemoryLine(rows, todayISO, { rules: MEMORY_LINE_RULES });
}

/** Build the evidence for one arm. */
export async function buildEvidence(
  arm: Arm, ctx: SpaceContext_AI, spaceCtx: SpaceContext,
  /**
   * The orientation's information ceiling. Defaults to the end of the assessment
   * window this orientation already carries, so the two frames ALWAYS share an
   * end date — two frames ending on different days is a confound, not a design.
   * Falls back to the one clock when the section is absent.
   */
  asOf: string = assessmentCeiling(ctx),
): Promise<EvidencePack> {
  const { spaceId } = spaceCtx;
  if (arm === 'A3') {
    return {
      arm, body: null, includesAssessment: false, approxTokens: 0,
      summary: 'no financial evidence — tools only',
    };
  }

  if (arm === 'A2') {
    const [envelope, memory, activity] = await Promise.all([
      loadCoverageEnvelope(spaceId),
      memoryLine(spaceId, ctx.userId, asOf),
      buildActivityFrame(ctx, spaceCtx, asOf),
    ]);
    const body = JSON.stringify(
      { ...thinCore(ctx, activity), evidenceCoverage: envelope, memory }, null, 1);
    return {
      arm, body: `FINANCIAL ORIENTATION\n${body}`, includesAssessment: false,
      approxTokens: tok(body),
      summary: 'thin core + coverage envelope + memory line, tools available',
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
