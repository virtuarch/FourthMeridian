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
import { EvidenceState } from '@/lib/ai/absence';
import { runSignalDetectors } from '@/lib/ai/signals';
import type { SpaceContext } from '@/lib/space';
import { recallMemories, MemoryKind, type MemoryClient } from './memory-store';
import { composeMemoryLine, MEMORY_LINE_RULES } from './memory-model';
import { transactionCorpusSpan } from '@/lib/data/transaction-query';
import type { ReadClient } from '@/lib/db/tenant-context';
import type { PhasedRead, MemoryPhasedRead } from '@/lib/ai/tenant-phase';
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

/**
 * The domain key the ACTIVITY frame's second TRANSACTIONS_SUMMARY run is reported
 * under when it fails.
 *
 * ⚠️ IT NEEDS ITS OWN NAME BECAUSE THE OMISSION ALREADY MEANT SOMETHING ELSE.
 * `activity` is omitted — never null — when the Space has less than
 * `2 × ASSESSMENT_WINDOW_DAYS` of corpus, and that omission is a deliberate claim:
 * "this frame must not exist". A failed second assembly used to produce the SAME
 * omission, so a broken authority silently asserted "you do not have six months of
 * history". Same class as the defect this slice exists to close, one layer down.
 */
export const ACTIVITY_FRAME_DOMAIN = 'transactions_summary_activity';

/**
 * The domain key the MEMORY LINE is reported under when its read fails.
 *
 * ⚠️ FOUND BY THE ADVERSARIAL SUITE, AND IT WAS THE WORST OF THE THREE. The
 * coverage census catches its own failures (CENSUS_FAILED) and the activity frame
 * catches its own; `memoryLine` caught NOTHING, so one failed `recall` read threw
 * out of `Promise.all`, out of `buildEvidence`, out of `openTranscript` and into
 * the route's catch — the user got "Something went wrong" and no answer AT ALL,
 * for a failure in the one arm of the prologue that holds no financial figure.
 *
 * ⚠️ AND ARMING THE FLIP MADE IT WORSE, WHICH IS WHY IT IS FIXED IN THE SAME
 * SLICE: the prologue is now one transaction, so a throw here aborts it. Before,
 * the memory read failed alone; now it takes the orientation with it.
 */
export const MEMORY_LINE_DOMAIN = 'memory';

/**
 * Assemble the four domains directly — no router, no audit row.
 *
 * ⚠️ RLS-AI-S6 — THE AUTHORITY IS THE FIRST ARGUMENT AND IT IS REQUIRED. Every
 * domain below runs under the authority this function was handed, so a turn is
 * never SPLIT-AUTHORITY: the orientation and the tool calls answer to the same
 * identity. There is no module-level client here to fall back to, so a caller
 * that forgot would not compile.
 *
 * ⚠️ IT IS A RUNNER, NOT A CLIENT, AND THAT SHAPE WAS FORCED BY A MEASUREMENT. A
 * `ReadClient` parameter means ONE transaction for the whole prologue, because a
 * client IS a transaction — and the acceptance suite measured that at 5,906 ms
 * against the 5 s default, because reads inside a phase SERIALISE. Each domain now
 * opens its own short phase and they run concurrently again, which is also exactly
 * the consistency the prologue has always had. See `PhasedRead`.
 */
export async function assembleFullContext(
  read: PhasedRead, spaceCtx: SpaceContext, agentId: string,
): Promise<SpaceContext_AI> {
  const domains: Record<string, ContextDomainSection> = {};
  // RLS-AI-S0 — WHICH AUTHORITIES BROKE, not merely that something did.
  const unreadable: string[] = [];
  await Promise.all(FOUR_DOMAINS.map(async (d) => {
    const a = getAssembler(d);
    if (!a) return;
    try {
      const section = await read(d, (c) =>
        a(c, spaceCtx, { scopeHint: 'full', positionClass: 'ALL' }));
      if (section) domains[d] = section;
    } catch (err) {
      // ⚠️ STILL NON-FATAL, AND STILL THE LESSER EVIL — a broken holdings
      // authority must not cost the user an answer about their cash. What changes
      // is that it is no longer SILENT: the domain is named, carried on the
      // context, and stated in the evidence pack. A `null` domain is honest
      // ambiguity; a null domain the reader believes is an empty one is not.
      console.error(`[evidence] assembler ${d} threw:`, err);
      unreadable.push(d);
    }
  }));
  return {
    requestedAt: new Date().toISOString(),
    ...(unreadable.length > 0 ? { unreadableDomains: unreadable.sort() } : {}),
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
  read: PhasedRead, ctx: SpaceContext_AI, spaceCtx: SpaceContext, asOf: string,
): Promise<{ frame: ActivityFrame | null; failed: boolean }> {
  const txn = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as
    TransactionsSummaryData | undefined;
  if (!txn?.windowDays) return { frame: null, failed: false };

  // 55a2c22 — the corpus bound taken UNDER the ceiling, so a retrospective
  // orientation cannot learn from the frame's existence that later history runs on.
  const { from: coverageFrom } = await read('corpus_span', (c) =>
    transactionCorpusSpan(c, { spaceId: spaceCtx.spaceId, asOf }));
  const window = resolveActivityWindow({
    asOf, coverageFrom, assessmentWindowDays: txn.windowDays,
  });
  if (!window) return { frame: null, failed: false };

  const assembler = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  if (!assembler) return { frame: null, failed: false };
  try {
    const section = await read('activity_frame', (c) => assembler(
      c,
      spaceCtx,
      { scopeHint: 'full', transactionWindow: {
        startDate: window.from, endDate: window.to, label: `activity ${window.from}..${window.to}` } },
    ));
    const data = section?.data as TransactionsSummaryData | undefined;
    return { frame: data ? projectActivityFrame(data) : null, failed: false };
  } catch (err) {
    // ⚠️ STILL NON-FATAL — a failed second frame must never cost the orientation
    // its assessment, and the single-frame body is the proven control.
    //
    // ⚠️ BUT NO LONGER INDISTINGUISHABLE FROM "THIS SPACE HAS LESS THAN SIX
    // MONTHS OF HISTORY". `failed` travels back and the caller names the domain in
    // `unreadableDomains`, which the evidence pack turns into a prohibition. The
    // corpus span above already succeeded, so the window EXISTED and the frame is
    // missing only because the read broke — exactly the sentence the contract owes.
    console.error('[evidence] activity frame threw:', err);
    return { frame: null, failed: true };
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
    // ⚠️ RLS-AI-S0 — A BROKEN AUTHORITY IS STATED, NEVER INFERRED FROM A null.
    // Omitted entirely when nothing broke, so an ordinary orientation is
    // byte-for-byte what it was. When something did, the sentence is a
    // PROHIBITION: the fields below are missing because we could not read them,
    // which licenses no claim about what the Space holds.
    ...(ctx.unreadableDomains?.length ? { evidenceUnreadable: {
      domains: ctx.unreadableDomains,
      // ⚠️ RLS-AI-S9 — THE CONTRACT'S OWN VOCABULARY, SO A FAILURE IS NOT MERELY
      // DESCRIBED BUT CLASSIFIED. `INDETERMINATE` is the one state in
      // `EvidenceState` that licenses no absence claim, and the tools in this
      // turn return the same word for a refused read. One word, one meaning,
      // across the orientation and every tool result the model will see.
      evidenceState: EvidenceState.INDETERMINATE,
      meaning: 'These authorities FAILED for this turn, so the matching fields above are absent '
        + 'because nothing was read — NOT because the Space has none. Do not state or imply that '
        + 'any of them is empty, zero or missing; say that it could not be read.',
    } } : {}),
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
async function memoryLine(
  client: MemoryClient, spaceId: string, ownerUserId: string, todayISO: string,
) {
  const scope = { spaceId, ownerUserId };
  const rows = (await Promise.all([
    recallMemories(client, scope, { kind: MemoryKind.INTENTION }),
    recallMemories(client, scope, { kind: MemoryKind.ASSUMPTION }),
    recallMemories(client, scope, { kind: MemoryKind.CHECKPOINT }),
  ])).flat();
  return composeMemoryLine(rows, todayISO, { rules: MEMORY_LINE_RULES });
}

/**
 * Build the evidence for one arm.
 *
 * ⚠️ THE AUTHORITIES ARE THE FIRST ARGUMENTS AND BOTH ARE REQUIRED. Slice A made
 * the MEMORY authority explicit; RLS-C-S3 did the same for the FINANCIAL reads this
 * orientation owns — the corpus span behind the activity frame and the coverage
 * census. There is no module-level client here to fall back to, so a call site that
 * forgot either would not compile.
 *
 * ⚠️ RLS-AI-S11 — AND `read` IS NOW THE AUTHENTICATED TENANT, WHICH IS THE WHOLE
 * PROGRAMME. The note that used to sit here said the migration principal was
 * deliberate "until the absence contract exists": both figures `read` reaches are
 * ABSENCE claims this orientation hands to a model in English, and under a tenant
 * client an empty corpus span was indistinguishable from a refusal. That contract
 * is `lib/ai/absence.ts`, the census now carries its own derived prohibition, and
 * `lib/ai/evidence-authorities.test.ts` pins the theorem the oracle rests on — so
 * the condition is met and the authority has moved.
 */
export async function buildEvidence(
  read: PhasedRead,
  /**
   * RLS-AI-S11 — the MEMORY authority, as a runner for the same reason `read` is
   * one. A memory read left on a long-lived client while every financial read ran
   * as the tenant would be a split authority inside the PROLOGUE — the exact
   * shape, one layer up, that made the previous slice refuse to arm the flip.
   */
  memoryRead: MemoryPhasedRead,
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
      read('coverage_census', (c) => loadCoverageEnvelope(c, spaceId)),
      // ⚠️ RLS-AI-S9 — GRACEFUL AND TRUTHFUL, NOT FATAL AND NOT SILENT. A failed
      // memory read used to throw the whole turn away (see MEMORY_LINE_DOMAIN).
      // It now degrades to `null`, which `thinCore` omits — and the domain is
      // NAMED in `evidenceUnreadable`, so the model is told the store could not be
      // read rather than being left to infer from a missing key that nothing was
      // ever remembered. "Nothing has been remembered for this user yet. Say so
      // plainly" is precisely the sentence that must not be reachable this way.
      memoryRead((c) => memoryLine(c, spaceId, ctx.userId, asOf)).catch((err) => {
        console.error('[evidence] memory line threw:', err);
        return null;
      }),
      buildActivityFrame(read, ctx, spaceCtx, asOf),
    ]);
    // ⚠️ RLS-AI-S9 — A FAILED SECOND FRAME JOINS THE UNREADABLE SET FOR THIS PACK
    // ONLY. `ctx` is the caller's object and is not mutated: the orientation's
    // statement about what broke is a property of the EVIDENCE, and a caller that
    // builds two packs from one context must not inherit the other's failure.
    const failedArms = [
      ...(activity.failed ? [ACTIVITY_FRAME_DOMAIN] : []),
      ...(memory === null ? [MEMORY_LINE_DOMAIN] : []),
    ];
    const unreadable = failedArms.length > 0
      ? [...(ctx.unreadableDomains ?? []), ...failedArms].sort()
      : ctx.unreadableDomains;
    const body = JSON.stringify(
      { ...thinCore({ ...ctx, ...(unreadable?.length ? { unreadableDomains: unreadable } : {}) },
          activity.frame),
        evidenceCoverage: envelope,
        // ⚠️ THE KEY IS OMITTED WHEN THE READ FAILED, NEVER SET TO null. A null
        // `memory` is what an EMPTY store produces further down this path, and the
        // two must not look alike; `evidenceUnreadable` above carries the reason.
        ...(memory === null ? {} : { memory }) }, null, 1);
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
    // RLS-AI-S0 — same statement, same reason, in the broad-context arms.
    ...(ctx.unreadableDomains?.length ? { evidenceUnreadable: {
      domains: ctx.unreadableDomains,
      evidenceState: EvidenceState.INDETERMINATE,
      meaning: 'These authorities FAILED for this turn. The matching keys above are absent because '
        + 'nothing was read, not because the Space has none. Never state that they are empty.',
    } } : {}),
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
